import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
import {unseal} from '../src/quickbooks/crypto.ts';
let srv,provider,ADMIN,STAFF,MANAGER,BUYER,vars;
const root='/api/admin/wholesale/quickbooks';
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN,headers={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,body:data,text,headers:r.headers,cookie:cookieOf(r)};}
const get=async(mode='sandbox')=>(await call('GET',root+'/app-settings?environment='+mode)).body;
async function save(fields={},mode='sandbox'){const state=await get(mode);return call('PUT',root+'/app-settings?environment='+mode,{ifVersion:state.version,connectionVersion:state.connectionVersion,reviewed:true,...fields});}
async function disconnect(mode='sandbox'){const state=(await call('GET',root+'/status?environment='+mode)).body;return call('POST',root+'/disconnect?environment='+mode,{ifVersion:state.connection.version});}
before(async()=>{
 provider=await startQuickBooksProvider();vars={...quickBooksVars(provider.origin),QUICKBOOKS_CLIENT_ID:'',QUICKBOOKS_CLIENT_SECRET:'',QUICKBOOKS_PRODUCTION_CLIENT_ID:'',QUICKBOOKS_PRODUCTION_CLIENT_SECRET:''};
 srv=await startServer({scheduled:true,writeLimit:5000,vars:({base})=>({...vars,QUICKBOOKS_REDIRECT_URI:base+root+'/callback'})});
 ADMIN=(await call('POST','/api/auth/setup',{name:'App settings owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 for(const role of ['staff','manager']){await call('POST','/api/admin/users',{name:role,username:role,role,password:'temporary-password'});const result=await call('POST','/api/auth/change',{username:role,password:'temporary-password',newPassword:role+'-own-password'},null);if(role==='staff')STAFF=result.cookie;else MANAGER=result.cookie;}
 const customer=(await call('POST','/api/admin/wholesale/customers',{business:'App test café',status:'Active'})).body.customer;
 const account=(await call('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'app.buyer'})).body;
 BUYER=(await call('POST','/api/wholesale/auth/change-password',{username:'app.buyer',password:account.temporaryPassword,newPassword:'buyer-password'},null)).cookie;
});
after(async()=>{await srv?.stop();await provider?.stop();});
test('QuickBooks app settings are admin-only, origin and identity guarded, with no provider or secret side effects on rejected writes',async()=>{
 const before=provider.state.calls.length;
 for(const cookie of [null,STAFF,MANAGER,BUYER])for(const method of ['GET','PUT'])assert.ok([401,403].includes((await call(method,root+'/app-settings',method==='PUT'?{}:undefined,cookie)).status));
 assert.equal((await call('PUT',root+'/app-settings',{},ADMIN,{origin:'https://evil.example'})).status,403);
 assert.equal((await call('GET',root+'/app-settings',undefined,ADMIN,{'x-expected-user-id':'someone-else'})).status,409);
 assert.equal(provider.state.calls.length,before);const initial=await get();assert.equal(initial.keyReady,true);assert.equal(initial.configured,false);assert.equal(initial.clientSecretConfigured,false);
});
test('QuickBooks app settings encrypt separate environment credentials and never echo secrets, audit them or put them in JSON backups',async()=>{
 const first=await save({clientId:'test-client',clientSecret:'test-secret',webhookToken:'saved-sandbox-verifier-secret'});assert.equal(first.status,200,first.text);
 const second=await save({clientId:'test-production-client',clientSecret:'test-production-secret',webhookToken:'saved-production-verifier-secret'},'production');assert.equal(second.status,200,second.text);
 const settings=await get();assert.equal(settings.clientId,'test-client');assert.equal(settings.clientSecretConfigured,true);assert.equal(settings.webhookConfigured,true);assert.equal(settings.configured,true);assert.equal(settings.sources.clientSecret,'admin');
 assert.equal(new URL(settings.callbackUrl).pathname,root+'/callback');assert.equal(new URL(settings.webhookUrl).pathname,'/api/quickbooks/webhook/sandbox');
 for(const secret of ['test-secret','saved-sandbox-verifier-secret'])assert.equal(JSON.stringify(settings).includes(secret),false);
 const rows=srv.sql('SELECT * FROM quickbooks_app_settings');assert.equal(rows.length,2);
 for(const row of rows){assert.equal(row.data.includes('test-secret'),false);assert.equal(row.data.includes('verifier-secret'),false);const plain=await unseal(row.data,vars.QUICKBOOKS_TOKEN_KEY,'app-settings-v1',row.generation,row.environment);assert.ok(plain.clientSecret);await assert.rejects(unseal(row.data,vars.QUICKBOOKS_TOKEN_KEY,'app-settings-v1',row.generation,row.environment==='sandbox'?'production':'sandbox'));}
 const audit=JSON.stringify(srv.sql("SELECT * FROM audit_log WHERE kind='quickbooks_app_settings'"));assert.ok(!audit.includes('test-secret'));assert.ok(!audit.includes('verifier-secret'));
 const backup=await call('POST','/api/admin/backups',{});assert.equal(backup.status,200,backup.text);
 const info=backup.body.backup||backup.body;const downloaded=await call('GET','/api/admin/backups/'+info.id);assert.equal(downloaded.status,200,downloaded.text);
 for(const secret of ['test-secret','test-production-secret','saved-sandbox-verifier-secret','quickbooks_app_settings'])assert.equal(downloaded.text.includes(secret),false);
});
test('QuickBooks app settings use atomic version checks for simultaneous admin edits',async()=>{
 const state=await get(),body={ifVersion:state.version,connectionVersion:state.connectionVersion,reviewed:true};
 const results=await Promise.all(['first-verifier-secret-value','second-verifier-secret-value'].map(webhookToken=>call('PUT',root+'/app-settings',{...body,webhookToken})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await get()).version,state.version+1);
 assert.equal((await save({webhookToken:'saved-sandbox-verifier-secret'})).status,200);
});
test('QuickBooks app settings retain blank secrets, reject stale or unreviewed edits and invalidate outstanding OAuth before credential replacement',async()=>{
 const before=await get(),started=await call('POST',root+'/connect',{});assert.equal(started.status,200,started.text);const state=new URL(started.body.authorizeUrl).searchParams.get('state');
 assert.equal((await save({clientId:'test-client-new'})).status,200);
 assert.equal((await call('GET',root+'/callback?state='+state+'&code=test-code&realmId=1234567890')).status,400);
 assert.equal((await call('PUT',root+'/app-settings',{...before,ifVersion:before.version,connectionVersion:before.connectionVersion,reviewed:true,clientId:'other'})).status,409);
 assert.equal((await save({reviewed:false})).status,400);
 assert.equal((await save({clientSecret:'secret\ninvalid'})).status,400);
 assert.equal((await save({clientId:'https://evil.example'})).status,400);
 assert.equal((await save({webhookToken:'short'})).status,400);
 assert.equal((await save({webhookToken:'valid-but-contradictory-token',clearWebhook:true})).status,400);
 assert.equal((await save({clientId:'test-client',clientSecret:'',webhookToken:''})).status,200);
 assert.equal((await get()).clientSecretConfigured,true);
});
test('Admin-stored credentials drive OAuth, refresh and webhook verification; connected app replacement is refused',async()=>{
 provider.state.expires=1;
 const started=await call('POST',root+'/connect',{});assert.equal(started.status,200,started.text);assert.equal(new URL(started.body.authorizeUrl).searchParams.get('client_id'),'test-client');
 const state=new URL(started.body.authorizeUrl).searchParams.get('state'),callback=await call('GET',root+'/callback?state='+state+'&code=test-code&realmId=1234567890');assert.equal(callback.status,303,callback.text);
 assert.equal((await save({clientSecret:'replacement-while-pending'})).status,409);
 const status=(await call('GET',root+'/status')).body;assert.equal((await call('POST',root+'/confirm',{ifVersion:status.connection.version,vatNumber:'GB123456789',confirmed:true})).status,200);
 assert.equal((await save({clientSecret:'replacement-secret'})).status,409);
 assert.equal((await save({webhookToken:'rotated-sandbox-verifier-secret'})).status,200);
 const refs=await call('GET',root+'/references?kind=customer');assert.equal(refs.status,200,refs.text);assert.ok(provider.state.refreshes>0);
 assert.ok(provider.state.calls.some(c=>c.path==='/token'&&Buffer.from(c.authorization.slice(6),'base64').toString()==='test-client:test-secret'));
 const body=JSON.stringify({eventNotifications:[]}),signature=secret=>createHmac('sha256',secret).update(body).digest('base64');
 async function webhook(secret){return fetch(srv.base+'/api/quickbooks/webhook/sandbox',{method:'POST',headers:{'content-type':'application/json','intuit-signature':signature(secret)},body});}
 assert.equal((await webhook('saved-sandbox-verifier-secret')).status,401);assert.equal((await webhook('rotated-sandbox-verifier-secret')).status,200);
 const beforeCron=provider.state.calls.length;const scheduled=await fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'));assert.equal(scheduled.status,200);
 for(let i=0;i<100&&!provider.state.calls.slice(beforeCron).some(c=>c.path.endsWith('/cdc'));i++)await new Promise(r=>setTimeout(r,20));
 assert.ok(provider.state.calls.slice(beforeCron).some(c=>c.path.endsWith('/cdc')),'scheduled reconciliation uses Admin credentials without Worker client ID vars');
 assert.equal((await save({clearWebhook:true})).status,200);assert.equal((await get()).webhookConfigured,false);assert.equal((await get()).sources.webhookToken,'admin');assert.equal((await webhook('rotated-sandbox-verifier-secret')).status,404);
 assert.equal((await get('production')).webhookConfigured,true);assert.equal((await disconnect()).status,200);
});
test('Corrupted or cross-environment saved credentials fail closed and can be replaced or removed after disconnect',async()=>{
 const live=srv.sql("SELECT * FROM quickbooks_app_settings WHERE environment='production'")[0];
 srv.sql("UPDATE quickbooks_app_settings SET data='"+live.data.replaceAll("'","''")+"',generation='"+live.generation+"' WHERE environment='sandbox'");
 const broken=await get();assert.equal(broken.readable,false);assert.equal(broken.configured,false);assert.equal((await call('POST',root+'/connect',{})).status,409);
 assert.equal((await save({webhookToken:'replacement-verifier-only'})).status,400);
 assert.equal((await save({clientId:'test-client',clientSecret:'test-secret'})).status,200);
 assert.equal((await get()).configured,true);assert.equal((await save({reset:true})).status,200);assert.equal((await get()).clientSecretConfigured,false);assert.equal((await get('production')).clientSecretConfigured,true);
});
test('No hosting encryption key means no plaintext credential save or secret echo',async()=>{
 const empty=await startServer({vars:{QUICKBOOKS_TOKEN_KEY:''}});
 try{const setup=await fetch(empty.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Owner',username:'owner',password:'owner-password',code:SETUP_CODE})}),cookie=cookieOf(setup);
 const state=await fetch(empty.base+root+'/app-settings',{headers:{cookie}});assert.equal((await state.json()).keyReady,false);
 const result=await fetch(empty.base+root+'/app-settings',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({ifVersion:0,connectionVersion:0,reviewed:true,clientId:'test-client',clientSecret:'must-never-save'})});assert.equal(result.status,409);assert.equal((await result.json()).code,'quickbooks_encryption_required');assert.equal(empty.sql('SELECT data FROM quickbooks_app_settings').every(r=>r.data===null),true);
 }finally{await empty.stop();}
});
