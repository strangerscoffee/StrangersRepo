// A durable frozen operation is recorded before any Accounting API create.
import type {User} from '../auth';
import {audit} from '../audit';
import {ApiError,type Env,invalid} from '../http';
import {version} from '../wholesaleStore';
import {issuedInvoice} from '../wholesaleInvoices';
import {connection,ProviderError,resourceReader} from './connection';
import {mapping,mappingStillMatches,verifiedMapping,verifyFrozenReferences,changed} from './mappings';
import {buildPayload,matchesInvoice} from './payload';
import {previewInvoice,type Environment,type ExportPreview} from './preview';
import {requireExportMode,settings} from './settings';
import {digest} from './crypto';
import {observe,refreshObservation,observation} from './observations';
import {operationDTO,sourceHash,type ExportOperation,type Observation} from './operationTypes';
export async function operation(env:Env,id:number){const row=await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE id=?').bind(id).first<ExportOperation>();if(!row)throw new ApiError(404,'not_found','QuickBooks export not found.');return row;}
export async function operationResult(env:Env,row:ExportOperation){return{...operationDTO(row),observation:await observation(env,row.id)};}
export async function queueInvoice(req:Request,env:Env,mode:Environment,invoiceId:number,body:Record<string,any>,user:User){
  const invoice=await issuedInvoice(env,invoiceId),row=await connection(env,mode);
  const existing=await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE environment=? AND realm_id=? AND invoice_id=?').bind(mode,row.realm_id,invoiceId).first<ExportOperation>();
  if(existing){if(existing.fingerprint!==body.fingerprint)throw new ApiError(409,'quickbooks_saved_export','This invoice already has a saved export. Open its original export before continuing.');return existing;}
  const state=await settings(env);if(state.active_environment!==mode||state.version!==version(body.modeVersion))throw new ApiError(409,'quickbooks_mode_changed','The active accounting environment changed. Review the invoice again.');
  if(body.reviewed!==true)throw invalid('Review the company, invoice and export amounts before sending.');
  if(invoice.payment.paid&&body.paidInvoiceConfirmed!==true)throw new ApiError(409,'quickbooks_paid_invoice','This invoice is already recorded paid locally. Confirm how its payment will be reconciled in QuickBooks before exporting.');
  if(mode==='production'&&await env.DB.prepare("SELECT id FROM quickbooks_exports WHERE environment='production' AND invoice_id=?").bind(invoiceId).first())throw new ApiError(409,'quickbooks_company_conflict','This invoice already has a Live export in another company. Review the original link.');
  const verified=await verifiedMapping(req,env,mode,invoice,row),preview=await previewInvoice(invoice,verified.mappings),built=buildPayload(preview);
  if(body.fingerprint!==preview.fingerprint||version(body.connectionVersion)!==row.version||version(body.mappingVersion)!==verified.mappingVersion)throw changed();
  await requireExportMode(req,env,row,built.profiles,state.version);await verified.resources.check();
  const payload=JSON.stringify(built.payload),at=Date.now();
  const saved=await env.DB.prepare(`INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND generation=? AND version=? AND status='connected') AND EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment=? AND version=?) AND EXISTS(SELECT 1 FROM quickbooks_environment_mappings WHERE environment=? AND realm_id=? AND version=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1) ON CONFLICT DO NOTHING RETURNING *`)
    .bind(mode,row.realm_id,row.company_name,row.vat_number,invoiceId,preview.requestId,preview.fingerprint,payload,await digest(payload),await sourceHash(invoice),user.id,JSON.stringify(preview),JSON.stringify(built.profiles),row.generation,verified.mappingVersion,at,at,mode,row.generation,row.version,mode,state.version,mode,row.realm_id,verified.mappingVersion,user.id).first<ExportOperation>();
  if(!saved){const raced=await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE environment=? AND realm_id=? AND invoice_id=?').bind(mode,row.realm_id,invoiceId).first<ExportOperation>();if(raced?.fingerprint===preview.fingerprint)return raced;throw changed();}
  await audit(env,'quickbooks_export_queued',user.name,`${user.name} queued invoice ${invoice.number} for QuickBooks ${mode==='production'?'Live':'Sandbox'}.`);return saved;
}
async function finish(env:Env,id:number,owner:string,state:string,error='',retryAt=0){
  await env.DB.prepare('UPDATE quickbooks_exports SET state=?,last_error=?,retry_at=?,lease_owner=NULL,lease_until=0,updated_at=?,version=version+1 WHERE id=? AND lease_owner=? AND lease_until>?').bind(state,error,retryAt,Date.now(),id,owner,Date.now()).run();return operation(env,id);
}
async function saveRemote(env:Env,id:number,owner:string,remoteId:string){
  const other=await env.DB.prepare('SELECT id FROM quickbooks_exports WHERE environment=(SELECT environment FROM quickbooks_exports WHERE id=?) AND realm_id=(SELECT realm_id FROM quickbooks_exports WHERE id=?) AND remote_id=? AND id<>?').bind(id,id,remoteId,id).first();
  if(other)throw new ApiError(409,'quickbooks_remote_conflict','This QuickBooks invoice is already linked to another website invoice.');
  await env.DB.prepare('UPDATE quickbooks_exports SET remote_id=?,updated_at=? WHERE id=? AND lease_owner=? AND lease_until>?').bind(remoteId,Date.now(),id,owner,Date.now()).run();
}
async function link(env:Env,row:ExportOperation,owner:string,remote:any,created:boolean,startedAt:number){
  const saved=await env.DB.prepare("UPDATE quickbooks_exports SET state='linked',remote_id=?,sync_token=?,created_remote=?,last_error='',lease_owner=NULL,lease_until=0,updated_at=?,version=version+1 WHERE id=? AND lease_owner=? AND lease_until>? RETURNING *").bind(remote.Id,remote.SyncToken,created?1:0,Date.now(),row.id,owner,Date.now()).first<ExportOperation>();
  if(saved){await observe(env,saved,remote,startedAt);await audit(env,'quickbooks_invoice_linked','QuickBooks',`Invoice ${JSON.parse(saved.preview).candidate.number} linked to QuickBooks ${saved.environment==='production'?'Live':'Sandbox'}.`);return saved;}return operation(env,row.id);
}
export async function retryExport(req:Request,env:Env,id:number,body:Record<string,any>,user:User){
  const old=await operation(env,id);if(old.version!==version(body.ifVersion))throw changed();if(body.reviewed!==true)throw invalid('Review the original saved export before retrying.');
  if(old.state==='linked')return old;if(old.lease_until>Date.now())throw new ApiError(409,'quickbooks_busy','This export is already being processed.');
  const row=await connection(env,old.environment);if(row.status!=='connected'||row.realm_id!==old.realm_id)throw new ApiError(409,'quickbooks_company_changed','Connect the original company before retrying this export.');
  await requireExportMode(req,env,row,JSON.parse(old.profiles),version(body.modeVersion));
  const saved=await env.DB.prepare("UPDATE quickbooks_exports SET state='queued',retry_at=0,attempts=0,created_by=?,connection_generation=?,mapping_version=?,last_error='',lease_owner=NULL,lease_until=0,updated_at=?,version=version+1 WHERE id=? AND version=? AND lease_until<=? RETURNING *").bind(user.id,row.generation,(await mapping(env,row.environment,row.realm_id)).version,Date.now(),old.id,old.version,Date.now()).first<ExportOperation>();if(!saved)throw changed();return saved;
}

export async function processExport(req:Request,env:Env,id:number){
  let row=await operation(env,id);if(!['queued','uncertain','sending'].includes(row.state)||row.lease_until>Date.now()||row.retry_at>Date.now())return row;
  const modeState=await settings(env);if(modeState.active_environment!==row.environment)return row;
  const ownerRecord=await env.DB.prepare('SELECT role,active FROM users WHERE id=?').bind(row.created_by).first<{role:string;active:number}>();
  if(ownerRecord?.role!=='admin'||!ownerRecord.active){await env.DB.prepare("UPDATE quickbooks_exports SET state='review',last_error='A current admin must review this export.',version=version+1 WHERE id=? AND version=? AND lease_until<=?").bind(id,row.version,Date.now()).run();return operation(env,id);}
  const owner=crypto.randomUUID(),locked=await env.DB.prepare("UPDATE quickbooks_exports SET state='sending',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND state IN ('queued','uncertain','sending') AND lease_until<=? AND EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment=? AND version=?) RETURNING *").bind(owner,Date.now()+90000,Date.now(),id,row.version,Date.now(),row.environment,modeState.version).first<ExportOperation>();
  if(!locked)return operation(env,id);row=locked;let writeStarted=false;
  try{
    if(row.attempts>8)return finish(env,id,owner,'review','Repeated attempts need an admin review before retrying.');
    const invoice=await issuedInvoice(env,row.invoice_id),preview=JSON.parse(row.preview) as ExportPreview;
    if(!preview.candidate||await sourceHash(invoice)!==row.source_hash||await digest(row.payload)!==row.payload_hash||preview.fingerprint!==row.fingerprint||await digest(JSON.stringify(preview.candidate))!==row.fingerprint||JSON.stringify(buildPayload(preview).payload)!==row.payload)throw new ApiError(409,'quickbooks_integrity','The invoice or saved export changed. Review it before sending.');
    const company=await connection(env,row.environment);if(company.status!=='connected'||company.realm_id!==row.realm_id||company.generation!==row.connection_generation)throw new ApiError(409,'quickbooks_connection_changed','The company connection changed. Review the original export before retrying.');
    const currentMap=await mapping(env,row.environment,row.realm_id);if(currentMap.version!==row.mapping_version&&!mappingStillMatches(currentMap.data,preview.candidate))throw new ApiError(409,'quickbooks_mapping_changed','Mappings changed after this export was queued. Review the original export.');
    await requireExportMode(req,env,company,JSON.parse(row.profiles),modeState.version);
    const resources=await resourceReader(req,env,company),startedAt=Date.now();let remote:any=null;
    if(row.remote_id){
      try{remote=(await resources.read('/invoice/'+row.remote_id+'?minorversion=75')).Invoice;}catch(error){if(error instanceof ProviderError&&error.providerStatus===404)return finish(env,id,owner,'review','The linked QuickBooks invoice was removed. It will not be recreated automatically.');throw error;}
    }else{
      const number=preview.candidate.number.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const data=await resources.read('/query?minorversion=75&query='+encodeURIComponent(`SELECT * FROM Invoice WHERE DocNumber = '${number}' MAXRESULTS 10`)),rows=data.QueryResponse?.Invoice||[];
      if(!Array.isArray(rows)||rows.length>1)return finish(env,id,owner,'review','More than one QuickBooks invoice has this number. Reconcile the duplicates before continuing.');remote=rows[0]||null;
    }
    if(remote){
      const match=matchesInvoice(preview,JSON.parse(row.payload),remote,!!row.created_remote||!!row.write_started_at);
      if(!match.matches){if(row.write_started_at)await env.DB.prepare('UPDATE quickbooks_exports SET sandbox_eligible=0 WHERE id=? AND lease_owner=?').bind(id,owner).run();if(/^\d{1,32}$/.test(remote.Id||''))await saveRemote(env,id,owner,remote.Id);return finish(env,id,owner,'review',match.reason);}
      // A matching record found before any create is adopted only after explicit review.
      if(!row.write_started_at&&!row.created_remote){await saveRemote(env,id,owner,remote.Id);return finish(env,id,owner,'review','A matching QuickBooks invoice exists. Review it and choose Link existing invoice.');}
      await resources.check();return link(env,row,owner,remote,true,startedAt);
    }
    const prefs=(await resources.read('/preferences?minorversion=75')).Preferences;
    if(prefs?.SalesFormsPrefs?.CustomTxnNumbers!==true||prefs?.SalesFormsPrefs?.AllowServiceDate!==true)throw new ApiError(409,'quickbooks_preferences','Enable custom invoice numbers and service dates in QuickBooks before exporting.');
    await verifyFrozenReferences(resources.read,preview.candidate);await resources.check();await requireExportMode(req,env,company,JSON.parse(row.profiles),modeState.version);
    const noted=await env.DB.prepare("UPDATE quickbooks_exports SET write_started_at=CASE WHEN write_started_at=0 THEN ? ELSE write_started_at END WHERE id=? AND lease_owner=? AND lease_until>? AND state='sending' AND EXISTS(SELECT 1 FROM users WHERE id=quickbooks_exports.created_by AND role='admin' AND active=1) RETURNING write_started_at").bind(Date.now(),id,owner,Date.now()).first<{write_started_at:number}>();
    if(!noted)return finish(env,id,owner,'review','Administrator access changed before this invoice was sent.');writeStarted=true;row.write_started_at=noted.write_started_at;
    remote=(await resources.write('/invoice?minorversion=75&requestid='+encodeURIComponent(row.request_id),row.payload)).Invoice;
    if(/^\d{1,32}$/.test(remote?.Id||''))await saveRemote(env,id,owner,remote.Id);
    const match=matchesInvoice(preview,JSON.parse(row.payload),remote,true);if(!match.matches){await env.DB.prepare('UPDATE quickbooks_exports SET sandbox_eligible=0 WHERE id=? AND lease_owner=?').bind(id,owner).run();return finish(env,id,owner,'review',match.reason);}
    return link(env,row,owner,remote,true,startedAt);
  }catch(error){
    const known=error instanceof ApiError,message=known?error.message:'The saved export needs review. Try refreshing its status.';
    if(error instanceof ProviderError&&(error.providerStatus===429||error.providerStatus>=500||error.code==='quickbooks_duplicate')){
      const delay=Math.min(21600000,60000*2**Math.min(row.attempts-1,8));return finish(env,id,owner,writeStarted||row.write_started_at?'uncertain':'queued',message,Math.max(Date.now()+delay,error.retryAt||0));
    }
    if(known&&error.code==='quickbooks_busy')return finish(env,id,owner,'queued',message,Date.now()+5000);
    return finish(env,id,owner,known&&['quickbooks_authorisation','quickbooks_reconnect','quickbooks_connection_changed','quickbooks_mode_changed','quickbooks_not_ready'].includes(error.code)?'paused':'review',message);
  }
}

export async function adoptExisting(req:Request,env:Env,id:number,body:Record<string,any>,user:User){
  const old=await operation(env,id);if(old.version!==version(body.ifVersion))throw changed();if(body.reviewed!==true)throw invalid('Review the existing invoice and its financial details before linking.');
  if(old.state==='linked')return old;if(old.lease_until>Date.now())throw new ApiError(409,'quickbooks_busy','This export is already being processed.');
  const preview=JSON.parse(old.preview) as ExportPreview,remoteId=String(body.remoteId||'');if(!/^\d{1,32}$/.test(remoteId))throw invalid('Choose the existing QuickBooks invoice ID.');
  const company=await connection(env,old.environment);if(company.realm_id!==old.realm_id)throw new ApiError(409,'quickbooks_company_changed','Connect the original company before linking.');
  await requireExportMode(req,env,company,JSON.parse(old.profiles),version(body.modeVersion));
  const resources=await resourceReader(req,env,company),startedAt=Date.now(),remote=(await resources.read('/invoice/'+remoteId+'?minorversion=75')).Invoice;
  const match=matchesInvoice(preview,JSON.parse(old.payload),remote,false);if(!match.matches)throw new ApiError(409,'quickbooks_invoice_mismatch',match.reason);
  if(await sourceHash(await issuedInvoice(env,old.invoice_id))!==old.source_hash)throw new ApiError(409,'quickbooks_integrity','The website invoice differs from the saved review.');await resources.check();
  const other=await env.DB.prepare('SELECT id FROM quickbooks_exports WHERE environment=? AND realm_id=? AND remote_id=? AND id<>?').bind(old.environment,old.realm_id,remoteId,id).first();if(other)throw new ApiError(409,'quickbooks_remote_conflict','This QuickBooks invoice is already linked to another website invoice.');
  const saved=await env.DB.prepare("UPDATE quickbooks_exports SET state='linked',remote_id=?,sync_token=?,created_remote=0,lease_owner=NULL,lease_until=0,last_error='',updated_at=?,version=version+1 WHERE id=? AND version=? AND lease_until<=? RETURNING *").bind(remoteId,remote.SyncToken,Date.now(),id,old.version,Date.now()).first<ExportOperation>();if(!saved)throw changed();
  await observe(env,saved,remote,startedAt);await audit(env,'quickbooks_invoice_adopted',user.name,`${user.name} linked an existing QuickBooks invoice to ${preview.candidate!.number}.`);return saved;
}
export async function exportList(env:Env,mode:Environment,invoiceId?:number,cursor?:number){
  // History survives reconnecting a different company; every row retains its original scope.
  const rows=(await env.DB.prepare(`SELECT * FROM quickbooks_exports WHERE environment=?${invoiceId?' AND invoice_id=?':''}${cursor?' AND id<?':''} ORDER BY id DESC LIMIT 51`).bind(mode,...(invoiceId?[invoiceId]:[]),...(cursor?[cursor]:[])).all<ExportOperation>()).results;
  const page=rows.slice(0,50);
  const balances=page.length?(await env.DB.prepare('SELECT * FROM quickbooks_observations WHERE export_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(page.map(row=>row.id))).all<Observation>()).results:[];
  const lookup=new Map(balances.map(row=>[row.export_id,row]));
  return{exports:page.map(row=>({...operationDTO(row),observation:lookup.get(row.id)||null})),nextCursor:rows.length>50?String(page[page.length-1].id):null};
}
export async function processPendingExports(req:Request,env:Env,limit=1){
  const state=await settings(env),rows=(await env.DB.prepare("SELECT id FROM quickbooks_exports WHERE environment=? AND (state IN ('queued','uncertain') OR (state='sending' AND lease_until<=?)) AND retry_at<=? ORDER BY created_at,id LIMIT ?").bind(state.active_environment,Date.now(),Date.now(),limit).all<{id:number}>()).results;
  for(const row of rows)await processExport(req,env,row.id);
}
