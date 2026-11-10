import {ApiError,type Env,invalid} from '../http';
import {object,version} from '../wholesaleStore';
import {connection,configuration,type Connection} from './connection';
import {mapping,changed} from './mappings';
import {ADAPTER_VERSION,vatKey} from './payload';
import {digest} from './crypto';
import {appCredentials} from './appSettings';
import type {Environment} from './preview';
export interface Settings {active_environment:Environment;version:number;live_approval:string|null;updated_at:number}
export async function settings(env:Env):Promise<Settings>{return (await env.DB.prepare('SELECT * FROM quickbooks_settings WHERE id=1').first<Settings>())!;}
export async function readiness(req:Request,env:Env){
  const state=await settings(env),company=await connection(env,'production'),saved=await mapping(env,'production',company.realm_id),row=await env.DB.prepare('SELECT data FROM wholesale_invoice_settings WHERE id=1').first<{data:string}>(),supplier=row?JSON.parse(row.data):null;
  const financial={coffeeItemId:saved.data.coffeeItemId,deliveryItemId:saved.data.deliveryItemId,taxMappings:[...saved.data.taxMappings].sort((a,b)=>(a.rateId+':'+a.basisPoints).localeCompare(b.rateId+':'+b.basisPoints)),termLinks:Object.fromEntries(Object.entries(saved.data.termLinks).sort())};
  const fingerprint=await digest(JSON.stringify([ADAPTER_VERSION,company.realm_id,company.generation,vatKey(company.vat_number),financial,supplier?.seller?.vatNumber||'',supplier?.priceBasis,supplier?.vatRates]));
  const evidence=(await env.DB.prepare('SELECT kind,profile FROM quickbooks_verifications WHERE vat_number=?').bind(vatKey(company.vat_number)).all<{kind:string;profile:string}>()).results;
  const profiles=evidence.filter(e=>e.kind==='profile'&&e.profile.includes(ADAPTER_VERSION)).map(e=>e.profile);
  const checks=[
    {id:'credentials',label:'Production app credentials configured',ok:!!(await configuration(req,env,'production')).config},
    {id:'company',label:'Live UK company confirmed in GBP',ok:company.status==='connected'&&company.country==='GB'&&company.currency==='GBP'},
    {id:'supplier',label:'Supplier VAT matches your confirmed invoice settings',ok:!!supplier?.confirmed&&!!supplier.seller?.vatNumber&&vatKey(supplier.seller.vatNumber)===vatKey(company.vat_number)},
    {id:'mappings',label:'Live sales items and VAT mappings reviewed',ok:!!saved.data.coffeeItemId&&saved.data.taxMappings.length>0},
    {id:'export',label:'Sandbox invoice exported and reconciled',ok:profiles.length>0},
    {id:'partial',label:'Sandbox partial payment verified',ok:evidence.some(e=>e.kind===ADAPTER_VERSION+':part-paid')},
    {id:'paid',label:'Sandbox paid invoice verified',ok:evidence.some(e=>e.kind===ADAPTER_VERSION+':paid')},
  ];
  let approval:any=null;try{approval=state.live_approval?JSON.parse(state.live_approval):null;}catch{}
  const reviewer=typeof approval?.by==='string'?await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND active=1").bind(approval.by).first():null;
  const approved=!!reviewer&&approval?.fingerprint===fingerprint&&checks.every(c=>c.ok);
  return{settings:state,connection:company,mappingVersion:saved.version,fingerprint,checks,approved,ready:approved,profiles,webhookConfigured:!!(await appCredentials(env,'production').catch(()=>null))?.webhookToken,approvedAt:approved?approval.at:null};
}
export async function approveLive(req:Request,env:Env,body:Record<string,any>,actor:string){
  const ready=await readiness(req,env),attestations=object(body.attestations),keys=['company','vat','rounding','payments','fees'];
  if(body.reviewed!==true||keys.some(key=>attestations[key]!==true))throw invalid('Review the company, VAT, rounding, payment tests and app requirements before enabling Live.');
  if(ready.settings.version!==version(body.ifVersion)||ready.connection.version!==version(body.connectionVersion)||body.fingerprint!==ready.fingerprint)throw changed();
  if(ready.checks.some(c=>!c.ok))throw new ApiError(409,'quickbooks_not_ready','Complete each live-readiness check before approving.');
  const approval=JSON.stringify({fingerprint:ready.fingerprint,at:Date.now(),by:actor,attestations:Object.fromEntries(keys.map(key=>[key,true]))});
  const updated=await env.DB.prepare("UPDATE quickbooks_settings SET live_approval=?,version=version+1,updated_at=? WHERE id=1 AND version=? AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment='production' AND status='connected' AND generation=? AND version=?) AND EXISTS(SELECT 1 FROM quickbooks_environment_mappings WHERE environment='production' AND realm_id=? AND version=?) RETURNING version").bind(approval,Date.now(),ready.settings.version,ready.connection.generation,ready.connection.version,ready.connection.realm_id,ready.mappingVersion).first();
  if(!updated)throw changed();return readiness(req,env);
}
export async function switchEnvironment(req:Request,env:Env,mode:Environment,body:Record<string,any>){
  const expected=version(body.ifVersion);if(body.reviewed!==true)throw invalid('Review the environment before switching.');
  if(mode==='production'&&!(await readiness(req,env)).ready)throw new ApiError(409,'quickbooks_not_ready','Complete the Live connection and readiness review before switching.');
  const updated=await env.DB.prepare("UPDATE quickbooks_settings SET active_environment=?,version=version+1,updated_at=? WHERE id=1 AND version=? AND NOT EXISTS(SELECT 1 FROM quickbooks_exports WHERE state='sending' AND lease_until>?) RETURNING version").bind(mode,Date.now(),expected,Date.now()).first();
  if(!updated){const state=await settings(env);if(state.version!==expected)throw changed();throw new ApiError(409,'quickbooks_busy','An invoice is being sent. Wait for it to finish before switching environments.');}
  return settings(env);
}
export async function requireExportMode(req:Request,env:Env,row:Connection,profiles:string[],modeVersion?:number){
  const state=await settings(env);if(state.active_environment!==row.environment||(modeVersion!==undefined&&state.version!==modeVersion))throw new ApiError(409,'quickbooks_mode_changed','The active accounting environment changed. Review this export again.');
  if(row.environment==='production'){
    const ready=await readiness(req,env);if(!ready.ready)throw new ApiError(409,'quickbooks_not_ready','Live settings need review before this invoice can be sent.');
    if(profiles.some(profile=>!ready.profiles.includes(profile)))throw new ApiError(409,'quickbooks_untested_vat','Test this invoice price basis, delivery and VAT treatment in Sandbox before exporting it live.');
  }
  return state;
}
