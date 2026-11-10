import {ApiError,type Env,invalid} from '../http';
import {keyBytes,seal,unseal} from './crypto';
import {appCredentials} from './appSettings';
import type {Environment} from './preview';
export const QB_ROOT='/api/admin/wholesale/quickbooks';
export interface Connection {environment:Environment;status:string;generation:string;version:number;realm_id:string;company_name:string;country:string;currency:string;vat_number:string;token_data:string|null;token_version:number;lease_owner:string|null;lease_until:number;updated_at:number}
interface Tokens {access:string;refresh:string;expiresAt:number;refreshExpiresAt:number|null}
export interface Config {appVersion:number;environment:Environment;clientId:string;clientSecret:string;key:string;redirect:string;authorize:string;token:string;revoke:string;api:string}
export function environment(value:unknown):Environment {if(value!=='sandbox'&&value!=='production')throw invalid('Choose Sandbox or Live.');return value;}
export class ProviderError extends ApiError {
  constructor(public providerStatus:number,public faultCode='',public retryAt=0,oauth=false){
    const duplicate=['600','6140'].includes(faultCode),auth=providerStatus===401||(oauth&&providerStatus===400);
    super(auth?409:duplicate?409:providerStatus===429?429:providerStatus===404?404:providerStatus>=400&&providerStatus<500?422:503,
      auth?'quickbooks_authorisation':duplicate?'quickbooks_duplicate':providerStatus===429?'quickbooks_busy':providerStatus===404?'quickbooks_missing':providerStatus>=400&&providerStatus<500?'quickbooks_validation':'quickbooks_unavailable',
      auth?'QuickBooks could not authorise this request. Reconnect the company if needed.':duplicate?'QuickBooks already has this invoice number or request. Reconcile it before sending again.':providerStatus===429?'QuickBooks is busy. This request can be retried later.':providerStatus===404?'The QuickBooks record is no longer available.':providerStatus>=400&&providerStatus<500?'QuickBooks could not accept this invoice. Review its mappings and accounting settings.':'Could not reach QuickBooks. Try again.');
  }
}
export const qbError=()=>new ProviderError(503);
export const id=(value:unknown):string=>{if(typeof value!=='string'||!/^\d{1,32}$/.test(value))throw invalid('Choose a valid QuickBooks reference.');return value;};
export async function connection(env:Env,mode:Environment='sandbox'):Promise<Connection>{return (await env.DB.prepare('SELECT * FROM quickbooks_connections WHERE environment=?').bind(mode).first<Connection>())!;}
export async function configuration(req:Request,env:Env,mode:Environment='sandbox'):Promise<{config:Config|null;missing:string[]}>{
  let saved;try{saved=await appCredentials(env,mode);}catch(error){if(error instanceof ApiError&&error.code==='quickbooks_credentials_unavailable')return{config:null,missing:['QUICKBOOKS_SAVED_CREDENTIALS']};throw error;}
  const requestLocal=['127.0.0.1','localhost'].includes(new URL(req.url).hostname);
  let harness=false;try{const uri=new URL(env.QUICKBOOKS_REDIRECT_URI||''),mock=new URL(env.QUICKBOOKS_TEST_ORIGIN||'');harness=env.ADMIN_HOST===''&&uri.protocol==='http:'&&uri.hostname==='127.0.0.1'&&mock.protocol==='http:'&&mock.hostname==='127.0.0.1';}catch{}
  const local=requestLocal||harness,missing:string[]=[],clientName=mode==='sandbox'?'QUICKBOOKS_CLIENT_ID':'QUICKBOOKS_PRODUCTION_CLIENT_ID',secretName=mode==='sandbox'?'QUICKBOOKS_CLIENT_SECRET':'QUICKBOOKS_PRODUCTION_CLIENT_SECRET';
  if(!saved.clientId?.trim())missing.push(clientName);
  if(!saved.clientSecret?.trim())missing.push(secretName);
  if(!env.QUICKBOOKS_TOKEN_KEY?.trim())missing.push('QUICKBOOKS_TOKEN_KEY');
  try{keyBytes(env.QUICKBOOKS_TOKEN_KEY||'');}catch{if(!missing.includes('QUICKBOOKS_TOKEN_KEY'))missing.push('QUICKBOOKS_TOKEN_KEY');}
  const redirect=env.QUICKBOOKS_REDIRECT_URI||(local?new URL(QB_ROOT+'/callback',req.url).href:env.ADMIN_HOST?'https://'+env.ADMIN_HOST+QB_ROOT+'/callback':'');
  try{const uri=new URL(redirect);if(uri.pathname!==QB_ROOT+'/callback'||uri.search||uri.hash||uri.username||uri.password||(!local&&(uri.protocol!=='https:'||uri.hostname!==env.ADMIN_HOST))||(local&&!harness&&uri.origin!==new URL(req.url).origin))throw 0;}catch{missing.push('QUICKBOOKS_REDIRECT_URI');}
  let fake:string|null=null;
  if(local&&env.QUICKBOOKS_TEST_ORIGIN){try{const url=new URL(env.QUICKBOOKS_TEST_ORIGIN);if(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)fake=url.origin;}catch{}}
  if(missing.length)return{config:null,missing};
  return{missing:[],config:{appVersion:saved.version,environment:mode,clientId:saved.clientId!,clientSecret:saved.clientSecret!,key:env.QUICKBOOKS_TOKEN_KEY!,redirect,authorize:fake?fake+'/authorize':'https://appcenter.intuit.com/connect/oauth2',token:fake?fake+'/token':'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',revoke:fake?fake+'/revoke':'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',api:fake?fake+'/'+mode:mode==='sandbox'?'https://sandbox-quickbooks.api.intuit.com':'https://quickbooks.api.intuit.com'}};
}
export async function configured(req:Request,env:Env,mode:Environment='sandbox'):Promise<Config> {const result=await configuration(req,env,mode);if(!result.config)throw new ApiError(409,'quickbooks_not_configured',`QuickBooks ${mode==='sandbox'?'sandbox':'production'} credentials need to be configured by the site owner.`);return result.config;}
export async function provider(url:string,init:RequestInit,oauth=false):Promise<any>{
  let res:Response;try{res=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});}catch{throw qbError();}
  let text='',size=0;const reader=res.body?.getReader(),decoder=new TextDecoder();
  if(reader)for(;;){const next=await reader.read().catch(()=>{throw qbError();});if(next.done)break;size+=next.value.byteLength;if(size>1024*1024){await reader.cancel();throw qbError();}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();
  let data:any;try{data=text?JSON.parse(text):{};}catch{if(res.ok)throw qbError();}
  if(!res.ok){const raw=data?.Fault?.Error?.[0]?.code,fault=typeof raw==='string'&&/^\d{1,6}$/.test(raw)?raw:'';let retryAt=Date.now()+60000;const retry=res.headers.get('retry-after');if(retry){const delay=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(delay))retryAt=Date.now()+Math.min(86400000,Math.max(1000,delay));}throw new ProviderError(res.status,fault,retryAt,oauth);}
  if(!data||typeof data!=='object')throw qbError();return data;
}
export async function exchange(config:Config,values:Record<string,string>):Promise<Tokens>{
  const data=await provider(config.token,{method:'POST',headers:{authorization:'Basic '+btoa(config.clientId+':'+config.clientSecret),'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams(values)},true);
  if(typeof data.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token||data.access_token.length>16000||data.refresh_token.length>16000||!Number.isSafeInteger(data.expires_in)||data.expires_in<1||data.expires_in>86400)throw qbError();
  return{access:data.access_token,refresh:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000,refreshExpiresAt:Number.isSafeInteger(data.x_refresh_token_expires_in)&&data.x_refresh_token_expires_in>0?Date.now()+data.x_refresh_token_expires_in*1000:null};
}
export async function current(env:Env,row:Connection,confirmed=true):Promise<void>{const now=await connection(env,row.environment);if(now.generation!==row.generation||now.version!==row.version||now.status!==(confirmed?'connected':'pending'))throw new ApiError(409,'quickbooks_changed','The QuickBooks connection changed. Reopen its settings.');}
async function credentials(env:Env,config:Config,row:Connection):Promise<Tokens>{
  try{if(!row.token_data)throw 0;return await unseal<Tokens>(row.token_data,config.key,row.realm_id,row.generation,row.environment);}catch{await env.DB.prepare("UPDATE quickbooks_connections SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE environment=? AND generation=? AND version=?").bind(row.environment,row.generation,row.version).run();throw new ApiError(409,'quickbooks_reconnect','Reconnect QuickBooks. Its stored credentials cannot be opened.');}
}
async function token(env:Env,config:Config,row:Connection):Promise<{access:string;version:number}>{
  let data=await credentials(env,config,row);if(data.expiresAt>Date.now()+60000)return{access:data.access,version:row.token_version};
  const owner=crypto.randomUUID(),locked=await env.DB.prepare("UPDATE quickbooks_connections SET lease_owner=?,lease_until=? WHERE environment=? AND generation=? AND version=? AND status='connected' AND (lease_owner IS NULL OR lease_until<?)").bind(owner,Date.now()+30000,row.environment,row.generation,row.version,Date.now()).run();
  if(!locked.meta.changes)throw new ApiError(409,'quickbooks_busy','QuickBooks is refreshing its connection. Try again shortly.');
  try{
    const latest=await connection(env,row.environment);await current(env,row);data=await credentials(env,config,latest);
    if(data.expiresAt>Date.now()+60000)return{access:data.access,version:latest.token_version};
    if(data.refreshExpiresAt!==null&&data.refreshExpiresAt<=Date.now())throw new ApiError(409,'quickbooks_authorisation','Reconnect the expired QuickBooks connection.');
    const fresh=await exchange(config,{grant_type:'refresh_token',refresh_token:data.refresh}),encrypted=await seal(fresh,config.key,row.realm_id,row.generation,row.environment);
    const saved=await env.DB.prepare("UPDATE quickbooks_connections SET token_data=?,token_version=token_version+1 WHERE environment=? AND generation=? AND version=? AND status='connected' AND lease_owner=? AND lease_until>? RETURNING token_version").bind(encrypted,row.environment,row.generation,row.version,owner,Date.now()).first<{token_version:number}>();
    if(!saved)throw new ApiError(409,'quickbooks_changed','The QuickBooks connection changed while refreshing.');return{access:fresh.access,version:saved.token_version};
  }catch(error){if(error instanceof ApiError&&error.code==='quickbooks_authorisation')await env.DB.prepare("UPDATE quickbooks_connections SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE environment=? AND generation=? AND version=? AND lease_owner=?").bind(row.environment,row.generation,row.version,owner).run();throw error;}
  finally{await env.DB.prepare('UPDATE quickbooks_connections SET lease_owner=NULL,lease_until=0 WHERE environment=? AND generation=? AND lease_owner=?').bind(row.environment,row.generation,owner).run();}
}
export async function readCompany(config:Config,realm:string,access:string){
  const base=config.api+'/v3/company/'+id(realm),headers={authorization:'Bearer '+access,accept:'application/json'};
  const [company,prefs]=await Promise.all([provider(base+'/companyinfo/'+realm+'?minorversion=75',{headers}),provider(base+'/preferences?minorversion=75',{headers})]);
  const c=company.CompanyInfo,name=c?.LegalName||c?.CompanyName,country=String(c?.Country||c?.CompanyAddr?.Country||'').trim().toUpperCase(),currency=prefs.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  if(typeof name!=='string'||!name.trim()||name.length>180)throw qbError();
  return{name,country:['GB','GBR','UK','UNITED KINGDOM'].includes(country)?'GB':country,currency:typeof currency==='string'?currency:'',customNumbers:prefs.Preferences?.SalesFormsPrefs?.CustomTxnNumbers===true};
}
// All reads in one logical request share a fixed connection/token and finite provider budget.
// Call check() before returning results or saving. Writes are used only by the durable export worker.
export async function resourceReader(req:Request,env:Env,expected?:Connection,mode:Environment='sandbox'){
  const row=expected||await connection(env,mode),config=await configured(req,env,row.environment);if(row.status!=='connected')throw new ApiError(409,'quickbooks_reconnect','Connect and confirm this QuickBooks company first.');
  const used=await token(env,config,row);await current(env,row);const reads=new Map<string,Promise<any>>();let calls=0;
  const request=async(path:string,init:RequestInit={})=>{if(++calls>45)throw invalid('This review needs too many distinct QuickBooks records. Review a smaller set of VAT mappings.');
    try{return await provider(config.api+'/v3/company/'+id(row.realm_id)+path,{...init,headers:{authorization:'Bearer '+used.access,accept:'application/json',...(init.headers||{})}});}
    catch(error){if(error instanceof ProviderError&&error.providerStatus===401)await env.DB.prepare("UPDATE quickbooks_connections SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE environment=? AND generation=? AND version=? AND token_version=?").bind(row.environment,row.generation,row.version,used.version).run();throw error;}
  };
  const read=(path:string)=>{const old=reads.get(path);if(old)return old;const result=request(path);reads.set(path,result);return result;};
  return{row,read,write:async(path:string,payload:unknown)=>{await current(env,row);return request(path,{method:'POST',headers:{'content-type':'application/json'},body:typeof payload==='string'?payload:JSON.stringify(payload)});},check:()=>current(env,row)};
}
export async function readResource(req:Request,env:Env,path:string,mode:Environment='sandbox'){const resources=await resourceReader(req,env,undefined,mode),data=await resources.read(path);await resources.check();return data;}
export async function revoke(config:Config,encrypted:string|null,realm:string,generation:string):Promise<boolean>{
  if(!encrypted)return true;try{const data=await unseal<Tokens>(encrypted,config.key,realm,generation,config.environment);await provider(config.revoke,{method:'POST',headers:{authorization:'Basic '+btoa(config.clientId+':'+config.clientSecret),'content-type':'application/json',accept:'application/json'},body:JSON.stringify({token:data.refresh})},true);return true;}catch{return false;}
}
