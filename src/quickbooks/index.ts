// Admin-only QuickBooks connection, reviewed mappings and environment controls.
import type {User} from '../auth';
import {audit} from '../audit';
import {ApiError,type Env,invalid,json,readJson} from '../http';
import {object,text,version} from '../wholesaleStore';
import {issuedInvoice} from '../wholesaleInvoices';
import {previewInvoice} from './preview';
import {connection,configuration,configured,environment,exchange,id,QB_ROOT,readCompany,revoke} from './connection';
import {digest,seal} from './crypto';
import {browse,changed,mapping,saveMapping,verifiedMapping} from './mappings';
import {approveLive,readiness,requireExportMode,settings,switchEnvironment} from './settings';
import {handleExportRoutes} from './exportRoutes';
import {health,processEvents,requestReconciliation} from './jobs';
import {buildPayload} from './payload';
import {publicAppSettings,saveAppSettings} from './appSettings';
const sessionHash=(req:Request)=>digest((/(?:^|;\s*)sfbb_session=([^;]+)/.exec(req.headers.get('cookie')||'')||[])[1]||'');
const publicConnection=(row:Awaited<ReturnType<typeof connection>>)=>({status:row.status,version:row.version,realmId:row.realm_id,name:row.company_name,country:row.country,currency:row.currency,vatNumber:row.vat_number,updatedAt:row.updated_at});
const publicReadiness=(value:Awaited<ReturnType<typeof readiness>>)=>({ready:value.ready,checks:value.checks,fingerprint:value.fingerprint,approvedAt:value.approvedAt,connectionVersion:value.connection.version,webhookConfigured:value.webhookConfigured});
export async function handleQuickBooks(req:Request,env:Env,route:string,user:User,ctx?:ExecutionContext):Promise<Response|null>{
  if(route!=='quickbooks'&&!route.startsWith('quickbooks/'))return null;
  if(user.role!=='admin')throw new ApiError(403,'permission_denied','Only admins can manage QuickBooks.');
  const action=route.slice('quickbooks'.length),url=new URL(req.url),mode=environment(url.searchParams.get('environment')||'sandbox');
  if(action==='/app-settings'&&req.method==='GET'){
    const saved=await publicAppSettings(env,mode),company=await connection(env,mode),setup=await configuration(req,env,mode);
    const fallback=env.ADMIN_HOST?'https://'+env.ADMIN_HOST+QB_ROOT+'/callback':new URL(QB_ROOT+'/callback',req.url).href;
    let callback=env.QUICKBOOKS_REDIRECT_URI||fallback;try{new URL(callback);}catch{callback=fallback;}
    const webhook=new URL('/api/quickbooks/webhook/'+mode,callback).href;
    return json({...saved,connectionVersion:company.version,connectionStatus:company.status,callbackUrl:callback,webhookUrl:webhook,configured:!!setup.config,missing:setup.missing});
  }
  if(action==='/app-settings'&&req.method==='PUT'){
    const result=await saveAppSettings(env,mode,object(await readJson(req,8192)));
    await audit(env,'quickbooks_app_settings',user.name,`${user.name} updated QuickBooks ${mode==='production'?'Live':'Sandbox'} app settings.`);return json(result);
  }
  if((!action||action==='/status')&&req.method==='GET'){
    const setup=await configuration(req,env,mode),row=await connection(env,mode),state=await settings(env),live=await readiness(req,env);
    return json({environment:mode,mode:'manual-export',configured:!!setup.config,missing:setup.missing,connection:publicConnection(row),activeEnvironment:state.active_environment,modeVersion:state.version,live:publicReadiness(live),health:await health(env,mode,row.realm_id),capabilities:{references:!!setup.config&&row.status==='connected',invoicePreview:!!setup.config&&row.status==='connected',invoiceExport:!!setup.config&&row.status==='connected'&&state.active_environment===mode&&(mode==='sandbox'||live.ready),paymentWrites:false}});
  }
  if(action==='/refresh-payments'&&req.method==='POST'){await readJson(req,4096);const queued=await requestReconciliation(env,mode);if(ctx)ctx.waitUntil(processEvents(req,env,3));else await processEvents(req,env,3);return json({queued},202);}
  if(action==='/readiness'&&req.method==='GET'){const ready=await readiness(req,env);return json({...publicReadiness(ready),activeEnvironment:ready.settings.active_environment,modeVersion:ready.settings.version});}
  if(action==='/approve-live'&&req.method==='POST'){
    const ready=await approveLive(req,env,object(await readJson(req,8192)),user.id);await audit(env,'quickbooks_live_review',user.name,`${user.name} reviewed the QuickBooks Live configuration.`);return json({...publicReadiness(ready),modeVersion:ready.settings.version});
  }
  if(action==='/mode'&&req.method==='PUT'){
    const body=object(await readJson(req,4096)),selected=environment(body.environment),state=await switchEnvironment(req,env,selected,body);await audit(env,'quickbooks_environment',user.name,`${user.name} selected QuickBooks ${selected==='production'?'Live':'Sandbox'}.`);return json({activeEnvironment:state.active_environment,modeVersion:state.version});
  }
  if(action==='/connect'&&req.method==='POST'){
    const config=await configured(req,env,mode),row=await connection(env,mode);if(row.status==='connected')throw new ApiError(409,'quickbooks_connected','Disconnect this company before choosing another company.');
    const state=crypto.randomUUID().replace(/-/g,'')+crypto.randomUUID().replace(/-/g,'');
    const stored=await env.DB.batch([env.DB.prepare('DELETE FROM quickbooks_auth_states WHERE expires_at<?').bind(Date.now()),env.DB.prepare('INSERT INTO quickbooks_auth_states SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM quickbooks_app_settings WHERE environment=? AND version=?) AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND version=?)').bind(await digest(state),mode,user.id,await sessionHash(req),row.version,Date.now()+600000,mode,config.appVersion,mode,row.version)]);
    if(!stored[1].meta.changes)throw changed();
    const target=new URL(config.authorize);for(const [key,value]of Object.entries({client_id:config.clientId,redirect_uri:config.redirect,response_type:'code',scope:'com.intuit.quickbooks.accounting',state}))target.searchParams.set(key,value);
    return json({authorizeUrl:target.href,environment:mode});
  }
  if(action==='/callback'&&req.method==='GET'){
    const state=url.searchParams.get('state')||'';if(!/^[a-f0-9]{64}$/.test(state))throw invalid('The QuickBooks sign-in state is invalid. Start again.');
    const pending=await env.DB.prepare('DELETE FROM quickbooks_auth_states WHERE state_hash=? RETURNING *').bind(await digest(state)).first<{environment:'sandbox'|'production';admin_id:string;session_hash:string;connection_version:number;expires_at:number}>();
    if(!pending||pending.expires_at<Date.now()||pending.admin_id!==user.id||pending.session_hash!==await sessionHash(req))throw invalid('This QuickBooks sign-in expired or belongs to another session. Start again.');
    const selected=environment(pending.environment),config=await configured(req,env,selected),target=new URL(config.redirect);target.pathname=env.ADMIN_HOST?'/':'/admin';target.search='?quickbooks=review&qbEnvironment='+selected;target.hash='wholesale';
    if(url.searchParams.has('error')){target.searchParams.set('quickbooksError','cancelled');return new Response(null,{status:303,headers:{location:target.href,'cache-control':'no-store','referrer-policy':'no-referrer'}});}
    const realm=id(url.searchParams.get('realmId')),code=url.searchParams.get('code')||'';if(!code||code.length>2048||/[\u0000-\u001f\u007f]/.test(code))throw invalid('QuickBooks did not return a valid sign-in code.');
    const old=await connection(env,selected);if(old.version!==pending.connection_version)throw changed();
    const tokens=await exchange(config,{grant_type:'authorization_code',code,redirect_uri:config.redirect}),company=await readCompany(config,realm,tokens.access);
    if(company.country!=='GB'||company.currency!=='GBP')throw invalid('Connect a UK QuickBooks company with GBP as its home currency.');
    const generation=crypto.randomUUID(),encrypted=await seal(tokens,config.key,realm,generation,selected);
    const saved=await env.DB.prepare("UPDATE quickbooks_connections SET status='pending',generation=?,version=version+1,realm_id=?,company_name=?,country=?,currency=?,vat_number='',token_data=?,token_version=1,lease_owner=NULL,lease_until=0,connected_by=?,updated_at=? WHERE environment=? AND version=?").bind(generation,realm,company.name,company.country,company.currency,encrypted,user.id,Date.now(),selected,pending.connection_version).run();
    if(!saved.meta.changes)throw changed();await audit(env,'quickbooks_connect',user.name,`${user.name} connected a QuickBooks ${selected==='production'?'Live':'Sandbox'} company for review.`);
    return new Response(null,{status:303,headers:{location:target.href,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  }
  if(action==='/confirm'&&req.method==='POST'){
    await configured(req,env,mode);const body=object(await readJson(req,4096)),row=await connection(env,mode),expected=version(body.ifVersion),vat=text(body.vatNumber,'VAT registration',40,true);
    if(body.confirmed!==true||row.status!=='pending'||row.country!=='GB'||row.currency!=='GBP')throw invalid('Review and confirm this UK company first.');
    const saved=await env.DB.prepare("UPDATE quickbooks_connections SET status='connected',vat_number=?,version=version+1,updated_at=? WHERE environment=? AND version=? AND generation=? AND status='pending'").bind(vat,Date.now(),mode,expected,row.generation).run();if(!saved.meta.changes)throw changed();
    await audit(env,'quickbooks_confirm',user.name,`${user.name} confirmed the QuickBooks ${mode==='production'?'Live':'Sandbox'} company.`);return json({confirmed:true});
  }
  if(action==='/disconnect'&&req.method==='POST'){
    const body=object(await readJson(req,4096)),row=await connection(env,mode),setup=await configuration(req,env,mode);
    const saved=await env.DB.prepare("UPDATE quickbooks_connections SET status='disconnected',generation=?,version=version+1,token_data=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE environment=? AND version=?").bind(crypto.randomUUID(),Date.now(),mode,version(body.ifVersion)).run();if(!saved.meta.changes)throw changed();
    await env.DB.prepare('DELETE FROM quickbooks_auth_states WHERE environment=?').bind(mode).run();
    const revoked=setup.config?await revoke(setup.config,row.token_data,row.realm_id,row.generation):false;await audit(env,'quickbooks_disconnect',user.name,`${user.name} disconnected QuickBooks ${mode==='production'?'Live':'Sandbox'}.`);return json({disconnected:true,revoked});
  }
  if(action==='/references'&&req.method==='GET')return json(await browse(req,env,mode,url));
  if(action==='/mappings'&&req.method==='GET'){const row=await connection(env,mode);if(row.status!=='connected')throw changed();return json({...await mapping(env,mode,row.realm_id),connectionVersion:row.version,realmId:row.realm_id,environment:mode});}
  if(action==='/mappings'&&req.method==='PUT'){const saved=await saveMapping(req,env,mode,object(await readJson(req,32768)));await audit(env,'quickbooks_mapping',user.name,`${user.name} reviewed QuickBooks ${mode==='production'?'Live':'Sandbox'} mappings.`);return json(saved);}
  const preview=/^\/invoices\/(\d+)\/preview$/.exec(action);
  if(preview&&req.method==='GET'){
    const invoice=await issuedInvoice(env,Number(preview[1])),verified=await verifiedMapping(req,env,mode,invoice),review=await previewInvoice(invoice,verified.mappings),state=await settings(env);let exportReady=false;const exportReasons:string[]=[];
    if(review.state==='blocked')exportReasons.push(...review.blockers.map(issue=>issue.message));else try{const built=buildPayload(review);await requireExportMode(req,env,verified.connection,built.profiles,state.version);exportReady=true;}catch(error){if(error instanceof ApiError)exportReasons.push(error.message);else throw error;}
    return json({preview:review,exportReady,exportReasons,connectionVersion:verified.connection.version,mappingVersion:verified.mappingVersion,modeVersion:state.version});
  }
  const exported=await handleExportRoutes(req,env,action,mode,user,ctx);if(exported)return exported;
  throw new ApiError(404,'not_found','Unknown QuickBooks operation.');
}
