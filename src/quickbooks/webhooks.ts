// Public machine endpoint: authenticated by Intuit's signature, never a staff/customer session.
import {ApiError,type Env,invalid,json} from '../http';
import {ensureSchema} from '../schema';
import {connection,environment} from './connection';
import {digest} from './crypto';
import {appCredentials} from './appSettings';
import type {Environment} from './preview';
export interface Notification {key:string;environment:Environment;realmId:string;entity:'Invoice'|'Payment';entityId:string;operation:string;at:number}
const numeric=(value:unknown)=>typeof value==='string'&&/^\d{1,32}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):null;
const operations:Record<string,string>={create:'create',created:'create',update:'update',updated:'update',delete:'delete',deleted:'delete',void:'void',voided:'void',email:'email',emailed:'email'};
export function notifications(input:unknown,mode:Environment,batchHash:string):Notification[]{
  const rows:Notification[]=[];
  function add(realm:unknown,entity:unknown,entityId:unknown,operation:unknown,time:unknown,eventId?:unknown){
    if(entity!=='Invoice'&&entity!=='Payment')return;
    const realmId=numeric(realm),id=numeric(entityId),op=operations[String(operation).toLowerCase()];if(!realmId||!id||!op)throw invalid('A webhook invoice/payment identifier is invalid.');
    const parsed=typeof time==='string'?Date.parse(time):NaN,at=Number.isFinite(parsed)?parsed:Date.now();
    const identity=typeof eventId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)?eventId:Number.isFinite(parsed)?`${entity}:${id}:${op}:${parsed}`:batchHash+':'+rows.length;
    rows.push({key:mode+':'+realmId+':'+identity,environment:mode,realmId,entity,entityId:id,operation:op,at});
  }
  function legacy(value:any){
    if(!Array.isArray(value?.eventNotifications))return false;
    for(const notification of value.eventNotifications){const entities=notification?.dataChangeEvent?.entities;if(!Array.isArray(entities))continue;for(const item of entities)add(notification.realmId,item?.name,item?.id,item?.operation,item?.lastUpdated);}
    return true;
  }
  const list=Array.isArray(input)?input:[input];let recognised=false;
  for(const item of list){
    if(!item||typeof item!=='object')throw invalid('The webhook body must contain event notifications.');
    if(legacy(item)||legacy((item as any).data)){recognised=true;continue;}
    const event=item as any;if(['1.0','1',1].includes(event.specversion)&&typeof event.type==='string'){
      recognised=true;const match=/^qbo\.(invoice|payment)\.([a-z]+)\.v1$/i.exec(event.type);
      if(match)add(event.intuitaccountid,match[1].toLowerCase()==='invoice'?'Invoice':'Payment',event.intuitentityid,match[2],event.time,event.id);
    }
  }
  if(!recognised&&list.length)throw invalid('The webhook notification format is not recognised.');return rows;
}
async function rawBody(req:Request){
  if(Number(req.headers.get('content-length')||0)>1048576)throw new ApiError(413,'invalid_argument','Webhook body is too large.');
  const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let size=0;if(reader)for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1048576){await reader.cancel();throw new ApiError(413,'invalid_argument','Webhook body is too large.');}chunks.push(next.value);}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}return body;
}
export async function handleWebhook(req:Request,env:Env,ctx:ExecutionContext,process:(req:Request,env:Env,limit:number,preferredKeys?:string[])=>Promise<unknown>){
  const url=new URL(req.url),match=/^\/api\/quickbooks\/webhook\/(sandbox|production)$/.exec(url.pathname);
  if(!match||(env.ADMIN_HOST&&url.hostname!==env.ADMIN_HOST))throw new ApiError(404,'not_found','Not found.');
  if(req.method!=='POST')return new Response('Method not allowed',{status:405,headers:{allow:'POST','cache-control':'no-store'}});
  await ensureSchema(env);
  const mode=environment(match[1]);let secret:string|undefined;
  try{secret=(await appCredentials(env,mode)).webhookToken;}catch(error){if(!(error instanceof ApiError)||error.code!=='quickbooks_credentials_unavailable')throw error;}
  if(!secret||secret.length<16)throw new ApiError(404,'not_found','Not found.');
  const signature=req.headers.get('intuit-signature')||'';if(!/^[A-Za-z0-9+/]{43}=$/.test(signature))throw new ApiError(401,'invalid_signature','Webhook signature is invalid.');
  const bytes=await rawBody(req),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  let valid=false;try{valid=await crypto.subtle.verify('HMAC',key,Uint8Array.from(atob(signature),c=>c.charCodeAt(0)),bytes);}catch{}
  if(!valid)throw new ApiError(401,'invalid_signature','Webhook signature is invalid.');
  let raw:string,input:unknown;try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);input=JSON.parse(raw);}catch{throw invalid('Webhook body is not valid JSON.');}
  const parsed=notifications(input,mode,await digest(raw));await ensureSchema(env);const company=await connection(env,mode),owned=parsed.filter(row=>row.realmId===company.realm_id);
  if(owned.length){
    // One durable insert handles a batch without one database request per event.
    await env.DB.prepare(`INSERT INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at) SELECT json_extract(value,'$.key'),json_extract(value,'$.environment'),json_extract(value,'$.realmId'),json_extract(value,'$.entity'),json_extract(value,'$.entityId'),json_extract(value,'$.operation'),json_extract(value,'$.at'),? FROM json_each(?) WHERE 1=1 ON CONFLICT(event_key) DO NOTHING`).bind(Date.now(),JSON.stringify(owned)).run();
    ctx.waitUntil(process(req,env,2,owned.map(row=>row.key)));
  }
  return json({accepted:true});
}
