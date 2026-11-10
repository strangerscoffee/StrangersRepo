// App secrets are write-only in Admin and encrypted under a hosting key kept outside D1/backups.
import {ApiError,type Env,invalid} from '../http';
import {seal,unseal,keyBytes} from './crypto';
import type {Environment} from './preview';
interface AppValues {clientId?:string;clientSecret?:string;webhookToken?:string}
interface AppRow {environment:Environment;data:string|null;generation:string;version:number;updated_at:number}
export async function migrateQuickBooksAppSettings(env:Env){
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS quickbooks_app_settings(environment TEXT PRIMARY KEY CHECK(environment IN ('sandbox','production')),data TEXT,generation TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("INSERT OR IGNORE INTO quickbooks_app_settings(environment,generation) VALUES('sandbox',lower(hex(randomblob(16))))"),
    env.DB.prepare("INSERT OR IGNORE INTO quickbooks_app_settings(environment,generation) VALUES('production',lower(hex(randomblob(16))))"),
  ]);
}
export function encryptionReady(env:Env){try{keyBytes(env.QUICKBOOKS_TOKEN_KEY||'');return true;}catch{return false;}}
const rowFor=(env:Env,mode:Environment)=>env.DB.prepare('SELECT * FROM quickbooks_app_settings WHERE environment=?').bind(mode).first<AppRow>();
const hosting=(env:Env,mode:Environment):AppValues=>({clientId:mode==='sandbox'?env.QUICKBOOKS_CLIENT_ID:env.QUICKBOOKS_PRODUCTION_CLIENT_ID,clientSecret:mode==='sandbox'?env.QUICKBOOKS_CLIENT_SECRET:env.QUICKBOOKS_PRODUCTION_CLIENT_SECRET,webhookToken:mode==='sandbox'?env.QUICKBOOKS_SANDBOX_WEBHOOK_TOKEN:env.QUICKBOOKS_PRODUCTION_WEBHOOK_TOKEN});
async function decode(env:Env,row:AppRow):Promise<AppValues>{
  if(!row.data)return {};
  try{
    const value=await unseal<AppValues>(row.data,env.QUICKBOOKS_TOKEN_KEY||'','app-settings-v1',row.generation,row.environment);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([k,v])=>!['clientId','clientSecret','webhookToken'].includes(k)||typeof v!=='string'||(!v&&k!=='webhookToken')||v.length>2048||/[^\x21-\x7e]/.test(v)))throw 0;
    return value;
  }catch{throw new ApiError(409,'quickbooks_credentials_unavailable','Saved QuickBooks app settings cannot be opened. Check the hosting encryption key or replace the saved settings.');}
}
export async function appCredentials(env:Env,mode:Environment){
  const row=await rowFor(env,mode);if(!row)throw new ApiError(503,'quickbooks_settings_unavailable','QuickBooks settings are not ready. Try again.');
  return{...hosting(env,mode),...await decode(env,row),version:row.version};
}
export async function publicAppSettings(env:Env,mode:Environment){
  const row=(await rowFor(env,mode))!,keyReady=encryptionReady(env);let stored:AppValues={},readable=true;
  try{stored=await decode(env,row);}catch{readable=false;}
  const effective=readable?{...hosting(env,mode),...stored}:{};
  return{environment:mode,version:row.version,updatedAt:row.updated_at,keyReady,readable,hasOverrides:!!row.data,clientId:effective.clientId||'',clientSecretConfigured:!!effective.clientSecret,webhookConfigured:!!effective.webhookToken,sources:{clientId:stored.clientId?'admin':hosting(env,mode).clientId?'hosting':'none',clientSecret:stored.clientSecret?'admin':hosting(env,mode).clientSecret?'hosting':'none',webhookToken:stored.webhookToken!==undefined?'admin':hosting(env,mode).webhookToken?'hosting':'none'}};
}
function supplied(value:unknown,label:string,max=2048){
  if(typeof value!=='string'||!value.trim()||value.length>max||/[^\x21-\x7e]/.test(value.trim()))throw invalid(`Enter a valid ${label}.`);
  return value.trim();
}
export async function saveAppSettings(env:Env,mode:Environment,body:Record<string,any>){
  const row=(await rowFor(env,mode))!,company=await env.DB.prepare('SELECT version,status FROM quickbooks_connections WHERE environment=?').bind(mode).first<{version:number;status:string}>();
  if(!Number.isSafeInteger(body.ifVersion)||body.ifVersion!==row.version||!Number.isSafeInteger(body.connectionVersion)||body.connectionVersion!==company!.version)throw new ApiError(409,'conflict','QuickBooks settings changed. Reopen them before saving.');
  if(body.reviewed!==true)throw invalid('Review the app and environment before saving.');
  if(body.reset!==undefined&&typeof body.reset!=='boolean')throw invalid('Choose whether to use hosting settings.');
  let old:AppValues={},readable=true;try{old=await decode(env,row);}catch{readable=false;}
  let values:AppValues={...old};
  if(body.reset===true)values={};
  else{
    if(!encryptionReady(env))throw new ApiError(409,'quickbooks_encryption_required','Set QUICKBOOKS_TOKEN_KEY in Cloudflare before saving app credentials.');
    if(body.clientId!==undefined){values.clientId=supplied(body.clientId,'client ID',256);if(!/^[A-Za-z0-9._-]+$/.test(values.clientId))throw invalid('Enter a valid client ID.');}
    if(body.clientSecret!==undefined&&body.clientSecret!=='')values.clientSecret=supplied(body.clientSecret,'client secret');
    if(body.webhookToken!==undefined&&body.webhookToken!=='')values.webhookToken=supplied(body.webhookToken,'webhook verifier token');
    if(body.clearWebhook===true&&typeof body.webhookToken==='string'&&body.webhookToken.trim())throw invalid('Choose a verifier token or disable notifications, not both.');
    if(body.clearWebhook===true)values.webhookToken=''; // An explicit blank disables even a hosting fallback.
    if(body.clearWebhook!==undefined&&typeof body.clearWebhook!=='boolean')throw invalid('Choose whether to disable notifications.');
    const effective={...hosting(env,mode),...values};
    if(!effective.clientId||!effective.clientSecret||(!readable&&(!body.clientId||!body.clientSecret)))throw invalid('Enter both the client ID and client secret.');
    if(effective.webhookToken&&effective.webhookToken.length<16)throw invalid('The webhook verifier token must have at least 16 characters.');
  }
  const previous={...hosting(env,mode),...old},next={...hosting(env,mode),...values};
  const authChanged=!readable||previous.clientId!==next.clientId||previous.clientSecret!==next.clientSecret;
  if(authChanged&&company!.status!=='disconnected')throw new ApiError(409,'quickbooks_disconnect_required','Disconnect this environment before replacing its app credentials.');
  const generation=crypto.randomUUID(),data=Object.keys(values).length?await seal(values,env.QUICKBOOKS_TOKEN_KEY!,'app-settings-v1',generation,mode):null,now=Date.now();
  const result=await env.DB.batch([
    env.DB.prepare("UPDATE quickbooks_app_settings SET data=?,generation=?,version=version+1,updated_at=? WHERE environment=? AND version=? AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND version=? AND (?=0 OR status='disconnected'))").bind(data,generation,now,mode,row.version,mode,company!.version,authChanged?1:0),
    env.DB.prepare("UPDATE quickbooks_connections SET version=version+1,updated_at=? WHERE environment=? AND ?=1 AND EXISTS(SELECT 1 FROM quickbooks_app_settings WHERE environment=? AND generation=?)").bind(now,mode,authChanged?1:0,mode,generation),
    env.DB.prepare("DELETE FROM quickbooks_auth_states WHERE environment=? AND ?=1 AND EXISTS(SELECT 1 FROM quickbooks_app_settings WHERE environment=? AND generation=?)").bind(mode,authChanged?1:0,mode,generation),
    env.DB.prepare("UPDATE quickbooks_settings SET live_approval=NULL,version=version+1,updated_at=? WHERE id=1 AND ?=1 AND EXISTS(SELECT 1 FROM quickbooks_app_settings WHERE environment=? AND generation=?)").bind(now,authChanged?1:0,mode,generation),
  ]);
  if(!result[0].meta.changes)throw new ApiError(409,'conflict','QuickBooks settings changed. Reopen them before saving.');
  return publicAppSettings(env,mode);
}
