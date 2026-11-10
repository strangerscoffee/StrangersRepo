// A bounded D1 inbox and scheduled reconciliation recover missed/out-of-order notifications.
import {ApiError,type Env} from '../http';
import type {Environment} from './preview';
import {connection,configuration,ProviderError,resourceReader} from './connection';
import {operation,processExport} from './ledger';
import {refreshObservation} from './observations';
import {settings} from './settings';
import type {ExportOperation} from './operationTypes';
interface Event {event_key:string;environment:Environment;realm_id:string;entity:string;entity_id:string;operation:string;event_at:number;state:string;attempts:number;retry_at:number;lease_owner:string|null;lease_until:number;created_at:number}
interface ReconcileState {environment:Environment;realm_id:string;checkpoint:string;cursor:number;updated_at:number;last_error:string;retry_at:number;lease_owner:string|null;lease_until:number}
export const machineRequest=(env:Env)=>new Request(env.QUICKBOOKS_REDIRECT_URI||'https://'+(env.ADMIN_HOST||env.COOKIE_DOMAIN||'staffstrangerscoffee.com')+'/api/admin/wholesale/quickbooks/status');
async function enqueueInvoices(env:Env,mode:Environment,realm:string,prefix:string,ids?:string[]){
  const filtered=ids?.filter(id=>/^\d{1,32}$/.test(id));
  const result=await env.DB.prepare(`INSERT INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at) SELECT ?||':'||remote_id,environment,realm_id,'Invoice',remote_id,'refresh',?,? FROM quickbooks_exports WHERE environment=? AND realm_id=? AND state='linked'${filtered?' AND remote_id IN (SELECT value FROM json_each(?))':''} ON CONFLICT(event_key) DO NOTHING`).bind(prefix,Date.now(),Date.now(),mode,realm,...(filtered?[JSON.stringify(filtered)]:[])).run();return result.meta.changes||0;
}
export async function requestReconciliation(env:Env,mode:Environment){
  const company=await connection(env,mode);if(company.status!=='connected')throw new ApiError(409,'quickbooks_reconnect','Connect this company before refreshing its payments.');
  await env.DB.prepare("UPDATE quickbooks_events SET state='queued',attempts=0,retry_at=0,last_error='' WHERE environment=? AND realm_id=? AND state IN ('review','paused')").bind(mode,company.realm_id).run();
  return enqueueInvoices(env,mode,company.realm_id,'manual:'+mode+':'+company.realm_id+':'+Math.floor(Date.now()/60000));
}
async function completeEvent(env:Env,row:Event,owner:string,state='done',error='',retryAt=0){
  await env.DB.prepare('UPDATE quickbooks_events SET state=?,last_error=?,retry_at=?,lease_owner=NULL,lease_until=0 WHERE event_key=? AND lease_owner=? AND lease_until>?').bind(state,error,retryAt,row.event_key,owner,Date.now()).run();
}
export async function processEvents(req:Request,env:Env,limit=2,preferredKeys?:string[]){
  for(let count=0;count<limit;count++){
    const row=await env.DB.prepare("SELECT e.* FROM quickbooks_events e JOIN quickbooks_connections c ON c.environment=e.environment AND c.realm_id=e.realm_id AND c.status='connected' WHERE (e.state='queued' OR (e.state='processing' AND e.lease_until<=?)) AND e.retry_at<=?"+(preferredKeys?' AND e.event_key IN (SELECT value FROM json_each(?))':'')+" ORDER BY e.created_at,e.event_key LIMIT 1").bind(Date.now(),Date.now(),...(preferredKeys?[JSON.stringify(preferredKeys)]:[])).first<Event>();
    if(!row)return;const owner=crypto.randomUUID(),locked=await env.DB.prepare("UPDATE quickbooks_events SET state='processing',attempts=attempts+1,lease_owner=?,lease_until=? WHERE event_key=? AND lease_until<=? AND state IN ('queued','processing') RETURNING *").bind(owner,Date.now()+90000,row.event_key,Date.now()).first<Event>();if(!locked)continue;
    try{
      if(locked.attempts>8){await completeEvent(env,row,owner,'review','Repeated payment refresh attempts need review.');continue;}
      const company=await connection(env,row.environment);if(company.status!=='connected'||company.realm_id!==row.realm_id){await completeEvent(env,row,owner,'paused','The original company connection needs review.');continue;}
      if(row.entity==='Invoice'){
        const linked=await env.DB.prepare("SELECT * FROM quickbooks_exports WHERE environment=? AND realm_id=? AND remote_id=? AND state='linked'").bind(row.environment,row.realm_id,row.entity_id).first<ExportOperation>();if(linked)await refreshObservation(req,env,linked);
      }else if(row.entity==='Payment'){
        let ids:string[]|undefined;
        if(!['delete','void'].includes(row.operation)){
          const resources=await resourceReader(req,env,company);let payment:any=null;
          try{payment=(await resources.read('/payment/'+row.entity_id+'?minorversion=75')).Payment;}catch(error){if(!(error instanceof ProviderError&&error.providerStatus===404))throw error;}
          await resources.check();if(payment){ids=(Array.isArray(payment.Line)?payment.Line:[]).flatMap((line:any)=>(Array.isArray(line.LinkedTxn)?line.LinkedTxn:[]).filter((link:any)=>link.TxnType==='Invoice').map((link:any)=>link.TxnId));}
        }
        // Deleted payments no longer reveal their invoice links: sweep only our own saved links.
        const prefix='payment:'+row.event_key;
        const added=await enqueueInvoices(env,row.environment,row.realm_id,prefix,ids);
        if(preferredKeys&&added){
          // Spend the remaining notification budget on its authoritative invoice reads.
          const children=(await env.DB.prepare("SELECT event_key FROM quickbooks_events WHERE environment=? AND realm_id=? AND state='queued' AND substr(event_key,1,?)=? ORDER BY event_key LIMIT ?").bind(row.environment,row.realm_id,prefix.length+1,prefix+':',Math.max(1,limit-count-1)).all<{event_key:string}>()).results;
          preferredKeys=[...preferredKeys,...children.map(child=>child.event_key)];
        }
      }
      await completeEvent(env,row,owner);
    }catch(error){
      const retryable=error instanceof ProviderError&&(error.providerStatus===429||error.providerStatus>=500)||error instanceof ApiError&&error.code==='quickbooks_busy',message=error instanceof ApiError?error.message:'Payment reconciliation needs review.';
      await completeEvent(env,row,owner,retryable?'queued':'paused',message,retryable?Math.max(Date.now()+Math.min(21600000,60000*2**Math.min(locked.attempts-1,8)),error instanceof ProviderError?error.retryAt:0):0);
    }
  }
}
export async function health(env:Env,mode:Environment,realm:string){
  const [queue,events,sync]=await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN state IN ('queued','sending','uncertain') THEN 1 ELSE 0 END),0) AS pending,COALESCE(SUM(CASE WHEN state IN ('review','paused') THEN 1 ELSE 0 END),0) AS review FROM quickbooks_exports WHERE environment=? AND realm_id=?").bind(mode,realm).first(),
    env.DB.prepare("SELECT COUNT(*) AS pending FROM quickbooks_events WHERE environment=? AND realm_id=? AND state<>'done'").bind(mode,realm).first(),
    env.DB.prepare('SELECT updated_at,last_error,checkpoint FROM quickbooks_reconciliation WHERE environment=? AND realm_id=?').bind(mode,realm).first(),
  ]);return{exports:queue,events,sync};
}

async function pollChanges(req:Request,env:Env){
  const companies=(await env.DB.prepare("SELECT environment,realm_id FROM quickbooks_connections WHERE status='connected' ORDER BY environment").all<{environment:Environment;realm_id:string}>()).results;
  const candidates:ReconcileState[]=[];
  for(const company of companies){
    if(!configuration(req,env,company.environment).config)continue;
    await env.DB.prepare('INSERT OR IGNORE INTO quickbooks_reconciliation(environment,realm_id) VALUES(?,?)').bind(company.environment,company.realm_id).run();
    const row=await env.DB.prepare('SELECT * FROM quickbooks_reconciliation WHERE environment=? AND realm_id=?').bind(company.environment,company.realm_id).first<ReconcileState>();
    if(row&&row.lease_until<=Date.now()&&row.retry_at<=Date.now()&&row.updated_at<Date.now()-240000)candidates.push(row);
  }
  const row=candidates.sort((a,b)=>a.updated_at-b.updated_at)[0];if(!row)return false;
  const owner=crypto.randomUUID(),locked=await env.DB.prepare('UPDATE quickbooks_reconciliation SET lease_owner=?,lease_until=? WHERE environment=? AND realm_id=? AND lease_until<=? RETURNING *').bind(owner,Date.now()+90000,row.environment,row.realm_id,Date.now()).first<ReconcileState>();if(!locked)return false;
  let checkpoint=row.checkpoint,lastError='',retryAt=0,fullAt=(locked as any).last_full_at||0;
  try{
    const company=await connection(env,row.environment),resources=await resourceReader(req,env,company),since=Date.parse(row.checkpoint);
    const start=new Date(Number.isFinite(since)?Math.max(Date.now()-29*86400000,since-120000):Date.now()-3600000).toISOString();
    const changed=await resources.read('/cdc?entities=Invoice&changedSince='+encodeURIComponent(start)+'&minorversion=75');await resources.check();
    if(!Array.isArray(changed.CDCResponse))throw new ApiError(503,'quickbooks_unavailable','QuickBooks change reconciliation returned an unexpected response.');
    const invoices=changed.CDCResponse.flatMap((response:any)=>Array.isArray(response.QueryResponse)?response.QueryResponse:[response.QueryResponse]).flatMap((query:any)=>Array.isArray(query?.Invoice)?query.Invoice:[]);
    const ids=invoices.map((invoice:any)=>invoice.Id).filter((id:any)=>typeof id==='string'&&/^\d{1,32}$/.test(id));
    const remoteTime=Date.parse(changed.time),through=Number.isFinite(remoteTime)&&remoteTime<=Date.now()+60000?new Date(remoteTime).toISOString():new Date().toISOString();
    await enqueueInvoices(env,row.environment,row.realm_id,'cdc:'+row.environment+':'+row.realm_id+':'+through,ids);
    // CDC is capped by Intuit. A full owned-invoice sweep recovers truncation and long gaps.
    if(invoices.length>=1000||!Number.isFinite(since)||since<Date.now()-29*86400000)fullAt=0;
    checkpoint=through;
  }catch(error){lastError=error instanceof ApiError?error.message:'QuickBooks change reconciliation needs review.';retryAt=error instanceof ProviderError?Math.max(Date.now()+60000,error.retryAt):Date.now()+300000;}
  try{
    if(fullAt<Date.now()-86400000){await enqueueInvoices(env,row.environment,row.realm_id,'sweep:'+row.environment+':'+row.realm_id+':'+Math.floor(Date.now()/86400000));fullAt=Date.now();}
    await env.DB.prepare('UPDATE quickbooks_reconciliation SET checkpoint=?,updated_at=?,last_full_at=?,last_error=?,retry_at=?,lease_owner=NULL,lease_until=0 WHERE environment=? AND realm_id=? AND lease_owner=?').bind(checkpoint,Date.now(),fullAt,lastError,retryAt,row.environment,row.realm_id,owner).run();
  }catch(error){await env.DB.prepare('UPDATE quickbooks_reconciliation SET lease_owner=NULL,lease_until=0 WHERE environment=? AND realm_id=? AND lease_owner=?').bind(row.environment,row.realm_id,owner).run();throw error;}
  return true;
}
export async function runQuickBooksJobs(env:Env){
  const req=machineRequest(env),state=await settings(env);
  // Incoming notifications must not starve missed-event recovery indefinitely.
  const overdue=await env.DB.prepare("SELECT c.environment FROM quickbooks_connections c LEFT JOIN quickbooks_reconciliation r ON r.environment=c.environment AND r.realm_id=c.realm_id WHERE c.status='connected' AND COALESCE(r.updated_at,0)<? AND COALESCE(r.retry_at,0)<=? AND COALESCE(r.lease_until,0)<=? LIMIT 1").bind(Date.now()-900000,Date.now(),Date.now()).first();
  if(overdue&&await pollChanges(req,env))return;
  const queued=await env.DB.prepare("SELECT id FROM quickbooks_exports WHERE environment=? AND (state IN ('queued','uncertain') OR (state='sending' AND lease_until<=?)) AND retry_at<=? ORDER BY created_at,id LIMIT 1").bind(state.active_environment,Date.now(),Date.now()).first<{id:number}>();
  if(queued){await processExport(req,env,queued.id);return;}
  const event=await env.DB.prepare("SELECT e.event_key FROM quickbooks_events e JOIN quickbooks_connections c ON c.environment=e.environment AND c.realm_id=e.realm_id AND c.status='connected' WHERE (e.state='queued' OR (e.state='processing' AND e.lease_until<=?)) AND e.retry_at<=? LIMIT 1").bind(Date.now(),Date.now()).first();
  if(event){await processEvents(req,env,3);return;}
  await pollChanges(req,env);
  await env.DB.prepare("DELETE FROM quickbooks_events WHERE state='done' AND created_at<?").bind(Date.now()-30*86400000).run();
}
