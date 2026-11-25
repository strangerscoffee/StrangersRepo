import {ApiError,type Env,json} from '../http';
import type {InvoiceDocument} from '../wholesaleInvoices';
import {connection,resourceReader,ProviderError} from './connection';
import {ADAPTER_VERSION,matchesInvoice,vatKey} from './payload';
import {reconcileInvoice,type ExportPreview,type Reconciliation} from './preview';
import {digest} from './crypto';
import {sourceHash,type ExportOperation,type Observation} from './operationTypes';
import {checkMissingPayments,hasVoidedPayment,invoicePaymentIds,rememberInvoicePayments} from './paymentLinks';
import {BILLING_ISSUES,billingMatchApproved,isBillingIssue} from './billingReviews';
const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
const today=()=>dayFormat.format(new Date());
// Shared by invoice lists and staff account flags. These queries use i for the invoice, e for its Live link and o for its observation.
export const LIVE_ACCOUNTING_JOIN = `LEFT JOIN quickbooks_exports e ON e.invoice_id=i.seq AND e.environment='production' AND e.state='linked'
  LEFT JOIN quickbooks_observations o ON o.export_id=e.id`;
export const UNCONFIRMED_BALANCE_SQL = "(e.id IS NOT NULL AND (o.status IS NULL OR o.status='review' OR o.outstanding_pence IS NULL))";
export const INVOICE_REVIEW_SQL = `(${UNCONFIRMED_BALANCE_SQL} OR (e.id IS NOT NULL AND (o.invoice_issue<>'' OR o.reason<>''))
  OR EXISTS(SELECT 1 FROM quickbooks_exports pending WHERE pending.invoice_id=i.seq AND pending.state='review' AND
    pending.last_error IN (${BILLING_ISSUES.map(issue=>"'"+issue+"'").join(',')})))`;
export const PAYMENT_DUE_SQL = "COALESCE(o.due_date,json_extract(i.data,'$.dueDate'))";
export const OUTSTANDING_BALANCE_SQL = `CASE WHEN ${UNCONFIRMED_BALANCE_SQL} OR o.status='voided' THEN 0
  WHEN e.id IS NOT NULL THEN COALESCE(o.outstanding_pence,0)
  WHEN i.paid=0 THEN json_extract(i.data,'$.totals.grossPence') ELSE 0 END`;
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
  let invoiceIssue = '', paymentIssue = '';
  let paymentVoided=false, currentPayments: string[] = [], openBalance: number | null = null;
  if(source){
    const value={...JSON.parse(source.data),id:source.seq,number:source.invoice_number} as InvoiceDocument;
    if(!preview.candidate||await sourceHash(value)!==operation.source_hash)result={status:'review',reason:'The restored website invoice differs from the saved export.'};
    else{
      const normal=remote&&remote.TxnTaxDetail?.TotalTax===undefined&&preview.candidate.totals.vatPence===0?{...remote,TxnTaxDetail:{...remote.TxnTaxDetail,TotalTax:0}}:remote;
      result=reconcileInvoice(preview,{...scope,localInvoiceId:operation.invoice_id,remoteInvoiceId:operation.remote_id,customerRef:preview.candidate.customerRef!,number:preview.candidate.number,requestId:operation.request_id,fingerprint:operation.fingerprint},scope,normal);
      if(result.status!=='review'&&result.status!=='voided'){
        let match=matchesInvoice(preview,payload,remote,!!operation.created_remote);
        if(isBillingIssue(match.reason)&&await billingMatchApproved(env,operation,remote,preview.candidate.billTo.name)){
          match=matchesInvoice(preview,payload,remote,!!operation.created_remote,true);
        }
        if(!match.matches){
          if(operation.environment==='sandbox')result={status:'review',reason:match.reason};
          else invoiceIssue=match.reason;
        }
        if(result.status!=='review'){
          currentPayments=invoicePaymentIds(remote);
          openBalance=result.outstandingPence;
          await rememberInvoicePayments(env,operation,currentPayments);
          paymentVoided=await hasVoidedPayment(env,operation,startedAt);
        }
      }
      if(operation.environment==='production'&&source.paid&&!paymentVoided&&openBalance){
        paymentIssue='A website payment record differs from QuickBooks. Reconcile the payment in QuickBooks.';
      }
    }
  }
  const token=typeof remote?.SyncToken==='string'&&/^\d{1,32}$/.test(remote.SyncToken)?remote.SyncToken:'';
  for(let attempt=0;attempt<3;attempt++){
    const old=await observation(env,operation.id);
    if(old&&((token&&old.sync_token&&BigInt(token)<BigInt(old.sync_token))||((!token||token===old.sync_token)&&startedAt<old.read_started_at)))return old;
    if(!remote&&old?.status==='voided')return old;
    if(old && openBalance !== null && old.outstanding_pence !== null && openBalance > old.outstanding_pence){
      await checkMissingPayments(env,operation,currentPayments,startedAt);
    }
    const values=[result.status,result.status==='review'?null:result.outstandingPence,result.status==='review'?null:result.paidPence,
      token||old?.sync_token||'',result.status==='review'?result.reason:paymentIssue,startedAt,Date.now(),paymentVoided?1:0,
      result.status==='review'?null:result.dueDate,invoiceIssue];
    const saved=old
      ? await env.DB.prepare(`UPDATE quickbooks_observations SET status=?,outstanding_pence=?,paid_pence=?,sync_token=?,reason=?,read_started_at=?,observed_at=?,
        payment_voided=MAX(payment_voided,?),due_date=?,invoice_issue=?,version=version+1 WHERE export_id=? AND version=? RETURNING *`)
        .bind(...values,operation.id,old.version).first<Observation>()
      : await env.DB.prepare(`INSERT INTO quickbooks_observations(export_id,status,outstanding_pence,paid_pence,sync_token,reason,read_started_at,observed_at,payment_voided,due_date,invoice_issue)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(export_id) DO NOTHING RETURNING *`).bind(operation.id,...values).first<Observation>();
    if(saved){if(result.status!=='review'&&result.status!=='voided')await recordEvidence(env,operation,preview,result.status);return saved;}
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
  for(let start=0;start<ids.length;start+=80){const batch=ids.slice(start,start+80);rows.push(...(await env.DB.prepare(`SELECT e.invoice_id,e.id AS export_id,o.status,o.outstanding_pence,o.paid_pence,o.reason,o.observed_at,o.payment_voided,o.due_date,o.invoice_issue FROM quickbooks_exports e LEFT JOIN quickbooks_observations o ON o.export_id=e.id WHERE e.environment='production' AND e.state='linked' AND e.invoice_id IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all()).results);}
  const lookup=new Map(rows.map(row=>[row.invoice_id,row]));
  return invoices.map(invoice=>{
    const row=lookup.get(invoice.id);if(!row)return invoice;
    const review=!row.status||row.status==='review'||row.outstanding_pence===null;
    const dueDate=row.due_date||invoice.dueDate;
    const status=review?'review':row.status==='unpaid'&&dueDate&&dueDate<today()?'overdue':row.status;
    return{...invoice,payment:{...invoice.payment,status,paid:status==='paid',paidDate:null,
      outstandingPence:review?null:row.outstanding_pence,
      paidPence:review?undefined:row.paid_pence??undefined,
      ...(!review&&status!=='voided'&&row.paid_pence!==null?{totalPence:row.outstanding_pence+row.paid_pence}:{}),
      ...(!review&&row.due_date?{dueDate:row.due_date}:{}),
      source:'quickbooks',checkedAt:row.observed_at||null,...(row.payment_voided?{hasVoidedPayment:true}:{})},
      accounting:{status:review?'review':row.status,checkedAt:row.observed_at||null,...(row.invoice_issue?{invoiceChanged:true}:{}),
        ...(admin?{exportId:row.export_id,reason:row.reason||'',invoiceIssue:row.invoice_issue||''}:{})}} as InvoiceDocument;
  });
}
export async function accountingSummary(env:Env,customerId?:string){
  const result=await env.DB.prepare(`WITH balances AS (
    SELECT ${PAYMENT_DUE_SQL} AS due_date, ${OUTSTANDING_BALANCE_SQL} AS outstanding,
      ${customerId?UNCONFIRMED_BALANCE_SQL:INVOICE_REVIEW_SQL} AS review
    FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN}
    WHERE ${customerId?'i.customer_id=?2':'1=1'}
  )
  SELECT COUNT(*) AS count,COALESCE(SUM(outstanding),0) AS outstandingPence,
    COALESCE(SUM(outstanding) FILTER (WHERE due_date<?1),0) AS overduePence,
    COUNT(*) FILTER (WHERE due_date<?1 AND outstanding>0) AS overdueCount,
    COUNT(*) FILTER (WHERE review) AS reviewCount FROM balances`)
    .bind(today(),...(customerId?[customerId]:[])).first<{count:number;outstandingPence:number;overduePence:number;overdueCount:number;reviewCount?:number}>();
  if(result&&!result.reviewCount)delete result.reviewCount;return result;
}
