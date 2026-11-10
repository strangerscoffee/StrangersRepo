import {ApiError, type Env, invalid} from "../http";
import {keyBytes,seal,unseal} from "./crypto";
export const QB_ROOT="/api/admin/wholesale/quickbooks";
export interface Connection {status:string;generation:string;version:number;realm_id:string;company_name:string;country:string;currency:string;vat_number:string;token_data:string|null;token_version:number;lease_owner:string|null;lease_until:number;updated_at:number}
interface Tokens {access:string;refresh:string;expiresAt:number;refreshExpiresAt:number|null}
export interface Config {clientId:string;clientSecret:string;key:string;redirect:string;authorize:string;token:string;revoke:string;api:string}
class ProviderAuthorisation extends ApiError { constructor(public providerStatus:number){super(409,"quickbooks_authorisation","QuickBooks could not authorise this request. Reconnect the sandbox company if needed.");} }
export const qbError=(status=503,message="Could not reach QuickBooks. Try again.")=>new ApiError(status,"quickbooks_unavailable",message);
export const id=(value:unknown):string=>{if(typeof value!=="string"||!/^\d{1,32}$/.test(value))throw invalid("Choose a valid QuickBooks reference.");return value;};
export async function connection(env:Env):Promise<Connection>{return (await env.DB.prepare("SELECT * FROM quickbooks_connection WHERE id=1").first<Connection>())!;}
export function configuration(req:Request,env:Env):{config:Config|null;missing:string[]} {
  const requestLocal=["127.0.0.1","localhost"].includes(new URL(req.url).hostname);
  let harness=false;try{const uri=new URL(env.QUICKBOOKS_REDIRECT_URI||""),mock=new URL(env.QUICKBOOKS_TEST_ORIGIN||"");harness=env.ADMIN_HOST===""&&uri.protocol==="http:"&&uri.hostname==="127.0.0.1"&&mock.protocol==="http:"&&mock.hostname==="127.0.0.1";}catch{}
  const local=requestLocal||harness,missing:string[]=[];
  for(const key of ["QUICKBOOKS_CLIENT_ID","QUICKBOOKS_CLIENT_SECRET","QUICKBOOKS_TOKEN_KEY"] as const) if(!env[key]?.trim())missing.push(key);
  try{keyBytes(env.QUICKBOOKS_TOKEN_KEY||"");}catch{if(!missing.includes("QUICKBOOKS_TOKEN_KEY"))missing.push("QUICKBOOKS_TOKEN_KEY");}
  let redirect=env.QUICKBOOKS_REDIRECT_URI||(local?new URL(QB_ROOT+"/callback",req.url).href:"");
  try{const uri=new URL(redirect);if(uri.pathname!==QB_ROOT+"/callback"||uri.search||uri.hash||uri.username||uri.password||(!local&&(uri.protocol!=="https:"||uri.hostname!==env.ADMIN_HOST))||(local&&!harness&&uri.origin!==new URL(req.url).origin))throw 0;}catch{missing.push("QUICKBOOKS_REDIRECT_URI");}
  let fake:string|null=null;
  if(local&&env.QUICKBOOKS_TEST_ORIGIN){try{const url=new URL(env.QUICKBOOKS_TEST_ORIGIN);if(url.protocol==="http:"&&url.hostname==="127.0.0.1"&&!url.username&&!url.password&&url.pathname==="/"&&!url.search&&!url.hash)fake=url.origin;}catch{}}
  if(missing.length)return{config:null,missing};
  return{missing:[],config:{clientId:env.QUICKBOOKS_CLIENT_ID!,clientSecret:env.QUICKBOOKS_CLIENT_SECRET!,key:env.QUICKBOOKS_TOKEN_KEY!,redirect,authorize:fake?fake+"/authorize":"https://appcenter.intuit.com/connect/oauth2",token:fake?fake+"/token":"https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",revoke:fake?fake+"/revoke":"https://developer.api.intuit.com/v2/oauth2/tokens/revoke",api:fake||"https://sandbox-quickbooks.api.intuit.com"}};
}
export function configured(req:Request,env:Env):Config{const result=configuration(req,env);if(!result.config)throw new ApiError(409,"quickbooks_not_configured","QuickBooks sandbox credentials still need to be configured by the site owner.");return result.config;}
export async function provider(url:string,init:RequestInit):Promise<any>{
  let res:Response;try{res=await fetch(url,{...init,redirect:"manual",signal:AbortSignal.timeout(10000)});}catch{throw qbError();}
  if(!res.ok){await res.body?.cancel();if(res.status===401||res.status===400)throw new ProviderAuthorisation(res.status);if(res.status===429)throw qbError(429,"QuickBooks is busy. Wait a little before trying again.");throw qbError();}
  // Provider bodies never go into error messages or logs. Bound parsing before releasing data.
  let text="";const reader=res.body?.getReader();if(!reader)throw qbError();let size=0;
  const decoder=new TextDecoder();for(;;){const next=await reader.read().catch(()=>{throw qbError();});if(next.done)break;size+=next.value.byteLength;if(size>1024*1024){await reader.cancel();throw qbError();}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();
  try{return JSON.parse(text);}catch{throw qbError();}
}
export async function exchange(config:Config,values:Record<string,string>):Promise<Tokens>{
  const data=await provider(config.token,{method:"POST",headers:{authorization:"Basic "+btoa(config.clientId+":"+config.clientSecret),"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:new URLSearchParams(values)});
  if(typeof data.access_token!=="string"||!data.access_token||typeof data.refresh_token!=="string"||!data.refresh_token||data.access_token.length>16000||data.refresh_token.length>16000||!Number.isSafeInteger(data.expires_in)||data.expires_in<1||data.expires_in>86400)throw qbError();
  return{access:data.access_token,refresh:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000,refreshExpiresAt:Number.isSafeInteger(data.x_refresh_token_expires_in)&&data.x_refresh_token_expires_in>0?Date.now()+data.x_refresh_token_expires_in*1000:null};
}
export async function current(env:Env,row:Connection,confirmed=true):Promise<void>{const now=await connection(env);if(now.generation!==row.generation||now.version!==row.version||now.status!==(confirmed?"connected":"pending"))throw new ApiError(409,"quickbooks_changed","The QuickBooks connection changed. Reopen its settings.");}
async function credentials(env:Env,config:Config,row:Connection):Promise<Tokens>{
  try{if(!row.token_data)throw 0;return await unseal<Tokens>(row.token_data,config.key,row.realm_id,row.generation);}catch{await env.DB.prepare("UPDATE quickbooks_connection SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE id=1 AND generation=? AND version=?").bind(row.generation,row.version).run();throw new ApiError(409,"quickbooks_reconnect","Reconnect QuickBooks. Its stored credentials cannot be opened.");}
}
async function token(env:Env,config:Config,row:Connection):Promise<{access:string;version:number}>{
  let data=await credentials(env,config,row);if(data.expiresAt>Date.now()+60000)return {access:data.access,version:row.token_version};
  const owner=crypto.randomUUID(),until=Date.now()+30000;
  const locked=await env.DB.prepare("UPDATE quickbooks_connection SET lease_owner=?,lease_until=? WHERE id=1 AND generation=? AND version=? AND status='connected' AND (lease_owner IS NULL OR lease_until<?)").bind(owner,until,row.generation,row.version,Date.now()).run();
  if(!locked.meta.changes)throw new ApiError(409,"quickbooks_busy","QuickBooks is refreshing its connection. Try again shortly.");
  try{
    const latest=await connection(env);if(latest.generation!==row.generation||latest.version!==row.version||latest.status!=="connected")throw new ApiError(409,"quickbooks_changed","The QuickBooks connection changed while refreshing.");data=await credentials(env,config,latest);
    if(data.expiresAt>Date.now()+60000)return {access:data.access,version:latest.token_version};
    if(data.refreshExpiresAt!==null&&data.refreshExpiresAt<=Date.now())throw new ApiError(409,"quickbooks_authorisation","Reconnect the expired QuickBooks sandbox connection.");
    const fresh=await exchange(config,{grant_type:"refresh_token",refresh_token:data.refresh}),encrypted=await seal(fresh,config.key,row.realm_id,row.generation);
    const saved=await env.DB.prepare("UPDATE quickbooks_connection SET token_data=?,token_version=token_version+1 WHERE id=1 AND generation=? AND version=? AND status='connected' AND lease_owner=? AND lease_until>? RETURNING token_version").bind(encrypted,row.generation,row.version,owner,Date.now()).first<{token_version:number}>();
    if(!saved)throw new ApiError(409,"quickbooks_changed","The QuickBooks connection changed while refreshing.");return {access:fresh.access,version:saved.token_version};
  }catch(error){if(error instanceof ApiError&&error.code==="quickbooks_authorisation")await env.DB.prepare("UPDATE quickbooks_connection SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE id=1 AND generation=? AND version=? AND lease_owner=?").bind(row.generation,row.version,owner).run();throw error;}
  finally{await env.DB.prepare("UPDATE quickbooks_connection SET lease_owner=NULL,lease_until=0 WHERE id=1 AND generation=? AND lease_owner=?").bind(row.generation,owner).run();}
}
export async function readCompany(config:Config,realm:string,access:string):Promise<{name:string;country:string;currency:string}>{
  const base=config.api+"/v3/company/"+id(realm);
  const [company,prefs]=await Promise.all([provider(base+"/companyinfo/"+realm+"?minorversion=75",{headers:{authorization:"Bearer "+access,accept:"application/json"}}),provider(base+"/preferences?minorversion=75",{headers:{authorization:"Bearer "+access,accept:"application/json"}})]);
  const c=company.CompanyInfo,name=c?.LegalName||c?.CompanyName,country=String(c?.Country||c?.CompanyAddr?.Country||"").toUpperCase(),currency=prefs.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  if(typeof name!=="string"||!name.trim()||name.length>180)throw qbError();
  return{name,country:["GB","GBR","UK","UNITED KINGDOM"].includes(country)?"GB":country,currency:typeof currency==="string"?currency:""};
}
// One verified connection and bounded, deduplicated provider reads per logical request.
// Callers must check() before returning data or atomically saving mappings.
export async function resourceReader(req:Request,env:Env,expected?:Connection){
  const config=configured(req,env),row=expected||await connection(env);if(row.status!=="connected")throw new ApiError(409,"quickbooks_reconnect","Connect and confirm a QuickBooks sandbox company first.");
  const used=await token(env,config,row);await current(env,row);
  const reads=new Map<string,Promise<any>>();
  const read=(path:string):Promise<any>=>{
    const existing=reads.get(path);if(existing)return existing;
    if(reads.size>=45)throw invalid("This review needs too many distinct QuickBooks records. Review a smaller set of VAT mappings.");
    const pending=provider(config.api+"/v3/company/"+id(row.realm_id)+path,{headers:{authorization:"Bearer "+used.access,accept:"application/json"}}).catch(async error=>{
      if(error instanceof ProviderAuthorisation&&error.providerStatus===401)await env.DB.prepare("UPDATE quickbooks_connection SET status='needs-reconnect',token_data=NULL,version=version+1 WHERE id=1 AND generation=? AND version=? AND token_version=?").bind(row.generation,row.version,used.version).run();throw error;
    });
    reads.set(path,pending);return pending;
  };
  return{read,check:()=>current(env,row)};
}
export async function readResource(req:Request,env:Env,path:string):Promise<any>{
  const resources=await resourceReader(req,env),data=await resources.read(path);await resources.check();return data;
}
export async function revoke(config:Config,encrypted:string|null,realm:string,generation:string):Promise<boolean>{
  if(!encrypted)return true;
  try{const data=await unseal<Tokens>(encrypted,config.key,realm,generation);await provider(config.revoke,{method:"POST",headers:{authorization:"Basic "+btoa(config.clientId+":"+config.clientSecret),"content-type":"application/json",accept:"application/json"},body:JSON.stringify({token:data.refresh})});return true;}catch{return false;}
}
