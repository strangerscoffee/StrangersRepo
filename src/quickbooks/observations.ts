import {ApiError,type Env,json} from '../http';
import type {InvoiceDocument} from '../wholesaleInvoices';
import {connection,resourceReader,ProviderError} from './connection';
import {ADAPTER_VERSION,matchesInvoice,vatKey} from './payload';
import {reconcileInvoice,type ExportPreview,type Reconciliation} from './preview';
import {digest} from './crypto';
import {sourceHash,type ExportOperation,type Observation} from './operationTypes';
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
const today=()=>dayFormat.format(new Date());
export async function observation(env:Env,id:number){return env.DB.prepare('SELECT * FROM quickbooks_observations WHERE export_id=?').bind(id).first<Observation>();}
async function recordEvidence(env:Env,operation:ExportOperation,preview:ExportPreview,status:string){
  if(operation.environment!=='sandbox'||!operation.created_remote||!operation.sandbox_eligible||operation.state!=='linked'||!preview.candidate)return;
  const vat=vatKey(preview.candidate.supplierVat),rows=JSON.parse(operation.profiles).map((profile:string)=>({kind:'profile',profile}));
  if(['part-paid','paid'].includes(status))rows.push({kind:ADAPTER_VERSION+':'+status,profile:''});
  const statements=[];for(const row of rows)statements.push(env.DB.prepare('INSERT OR IGNORE INTO quickbooks_verifications(key,vat_number,kind,profile,export_id,observed_at) VALUES(?,?,?,?,?,?)').bind(await digest(JSON.stringify([vat,row.kind,row.profile])),vat,row.kind,row.profile,operation.id,Date.now()));
  if(statements.length)await env.DB.batch(statements);
}
export async function observe(env:Env,operation:ExportOperation,remote:any,startedAt:number){
  const preview=JSON.parse(operation.preview) as ExportPreview,payload=JSON.parse(operation.payload),scope={environment:operation.environment,realmId:operation.realm_id};
  const source=await env.DB.prepare('SELECT seq,invoice_number,data,paid FROM wholesale_invoices WHERE seq=?').bind(operation.invoice_id).first<{seq:number;invoice_number:string;data:string;paid:number}>();
  let result:Reconciliation={status:'review',reason:'The website invoice needs review.'};
  if(source){
    const value={...JSON.parse(source.data),id:source.seq,number:source.invoice_number} as InvoiceDocument;
    const match=matchesInvoice(preview,payload,remote,!!operation.created_remote);
    if(await sourceHash(value)!==operation.source_hash)result={status:'review',reason:'The restored website invoice differs from the saved export.'};
    else if(!match.matches)result={status:'review',reason:match.reason};
    else{
      const normal=remote.TxnTaxDetail?.TotalTax===undefined&&preview.candidate?.totals.vatPence===0?{...remote,TxnTaxDetail:{...remote.TxnTaxDetail,TotalTax:0}}:remote;
      result=reconcileInvoice(preview,{...scope,localInvoiceId:operation.invoice_id,remoteInvoiceId:operation.remote_id,customerRef:preview.candidate!.customerRef!,number:preview.candidate!.number,requestId:operation.request_id,fingerprint:operation.fingerprint},scope,normal);
      if(operation.environment==='production'&&source.paid&&result.status!=='paid'&&result.status!=='review')result={status:'review',reason:'The website records payment, but QuickBooks still shows a balance. Reconcile the payment in QuickBooks.'};
    }
  }
  const token=typeof remote?.SyncToken==='string'&&/^\d{1,32}$/.test(remote.SyncToken)?remote.SyncToken:'';
  for(let attempt=0;attempt<3;attempt++){
    const old=await observation(env,operation.id);
    if(old&&((token&&old.sync_token&&BigInt(token)<BigInt(old.sync_token))||((!token||token===old.sync_token)&&startedAt<old.read_started_at)))return old;
    const values=[result.status,result.status==='review'?null:result.outstandingPence,result.status==='review'?null:result.paidPence,token||old?.sync_token||'',result.status==='review'?result.reason:'',startedAt,Date.now()];
    const saved=old?await env.DB.prepare('UPDATE quickbooks_observations SET status=?,outstanding_pence=?,paid_pence=?,sync_token=?,reason=?,read_started_at=?,observed_at=?,version=version+1 WHERE export_id=? AND version=? RETURNING *').bind(...values,operation.id,old.version).first<Observation>():await env.DB.prepare('INSERT INTO quickbooks_observations(export_id,status,outstanding_pence,paid_pence,sync_token,reason,read_started_at,observed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(export_id) DO NOTHING RETURNING *').bind(operation.id,...values).first<Observation>();
    if(saved){if(result.status!=='review')await recordEvidence(env,operation,preview,result.status);return saved;}
  }
  return observation(env,operation.id);
}
export async function refreshObservation(req:Request,env:Env,operation:ExportOperation){
  if(operation.state!=='linked'||!operation.remote_id)throw new ApiError(409,'quickbooks_unlinked','Link this invoice before refreshing its payment status.');
  const row=await connection(env,operation.environment);if(row.realm_id!==operation.realm_id)throw new ApiError(409,'quickbooks_company_changed','Reconnect the original company before refreshing this invoice.');
  const resources=await resourceReader(req,env,row),startedAt=Date.now();let remote:any=null;
  try{remote=(await resources.read('/invoice/'+operation.remote_id+'?minorversion=75')).Invoice;}catch(error){if(!(error instanceof ProviderError&&error.providerStatus===404))throw error;}
  await resources.check();return observe(env,operation,remote,startedAt);
}
export async function withAccounting(env:Env,invoices:InvoiceDocument[],admin=false):Promise<InvoiceDocument[]>{
  if(!admin)invoices=invoices.map(invoice=>({...invoice,issuedBy:null,payment:{...invoice.payment,reference:''}}));
  const ids=invoices.filter(i=>i.id).map(i=>i.id!),rows:any[]=[];
  for(let start=0;start<ids.length;start+=80){const batch=ids.slice(start,start+80);rows.push(...(await env.DB.prepare(`SELECT e.invoice_id,e.id AS export_id,o.status,o.outstanding_pence,o.paid_pence,o.reason,o.observed_at FROM quickbooks_exports e LEFT JOIN quickbooks_observations o ON o.export_id=e.id WHERE e.environment='production' AND e.state='linked' AND e.invoice_id IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all()).results);}
  const lookup=new Map(rows.map(row=>[row.invoice_id,row]));
  return invoices.map(invoice=>{
    const row=lookup.get(invoice.id);if(!row)return invoice;
    const review=!row.status||row.status==='review',manualPaid=invoice.payment.paid;
    const status=review?manualPaid?'paid':'review':row.status==='unpaid'&&invoice.dueDate&&invoice.dueDate<today()?'overdue':row.status;
    return{...invoice,payment:{...invoice.payment,status,paid:status==='paid',outstandingPence:review?invoice.payment.outstandingPence:row.outstanding_pence,paidPence:review?manualPaid?invoice.totals.grossPence:0:row.paid_pence,source:'quickbooks',checkedAt:row.observed_at||null},accounting:{status:review?'review':row.status,checkedAt:row.observed_at||null,...(admin?{exportId:row.export_id,reason:row.reason||''}:{})}} as InvoiceDocument;
  });
}
export async function accountingSummary(env:Env,customerId?:string){
  const result=await env.DB.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN o.status IN ('unpaid','part-paid','paid') THEN o.outstanding_pence WHEN i.paid=0 THEN json_extract(i.data,'$.totals.grossPence') ELSE 0 END),0) AS outstandingPence,COALESCE(SUM(CASE WHEN json_extract(i.data,'$.dueDate')<? THEN CASE WHEN o.status IN ('unpaid','part-paid','paid') THEN o.outstanding_pence WHEN i.paid=0 THEN json_extract(i.data,'$.totals.grossPence') ELSE 0 END ELSE 0 END),0) AS overduePence,COALESCE(SUM(CASE WHEN json_extract(i.data,'$.dueDate')<? AND COALESCE(o.outstanding_pence,CASE WHEN i.paid=0 THEN json_extract(i.data,'$.totals.grossPence') ELSE 0 END)>0 THEN 1 ELSE 0 END),0) AS overdueCount,COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND (o.status IS NULL OR o.status='review') THEN 1 ELSE 0 END),0) AS reviewCount FROM wholesale_invoices i LEFT JOIN quickbooks_exports e ON e.invoice_id=i.seq AND e.environment='production' AND e.state='linked' LEFT JOIN quickbooks_observations o ON o.export_id=e.id WHERE ${customerId?'i.customer_id=?':'1=1'}`)
    .bind(...[today(),today(),...(customerId?[customerId]:[])]).first<any>();
  if(result&&!result.reviewCount)delete result.reviewCount;return result;
}
