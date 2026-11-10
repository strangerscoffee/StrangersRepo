import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
import {seal,unseal} from '../src/quickbooks/crypto.ts';
let srv,provider,ADMIN,OTHER,STAFF,MANAGER,BUYER,customer,invoice,vars;
const root='/api/admin/wholesale/quickbooks';
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN,extra={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,body:data,text,headers:r.headers,cookie:cookieOf(r)};}
const status=async()=>(await call('GET',root+'/status')).body;
async function start(cookie=ADMIN){const r=await call('POST',root+'/connect',{},cookie);assert.equal(r.status,200,r.text);assert.equal(new URL(r.body.authorizeUrl).origin,provider.origin,"local harness must use its loopback provider");return new URL(r.body.authorizeUrl).searchParams.get('state');}
async function callback(state,cookie=ADMIN){return call('GET',root+'/callback?code=test-code&realmId=1234567890&state='+state,undefined,cookie);}
async function connect(){const old=await status();if(['connected','pending'].includes(old.connection.status))await call('POST',root+'/disconnect',{ifVersion:old.connection.version});const r=await callback(await start());assert.equal(r.status,303,r.text);return status();}
async function confirm(){const s=await status(),r=await call('POST',root+'/confirm',{ifVersion:s.connection.version,vatNumber:'GB123456789',confirmed:true});assert.equal(r.status,200,r.text);return status();}
async function issued(lines=[{productId:'brazil',pack:'kilo',grind:'beans',quantity:2,price:1800}]){
 const config=(await call('GET','/api/admin/wholesale/invoice-settings')).body;
 const value={seller:{legalName:'Example UK Sandbox Ltd',address:'Test business address',vatNumber:'GB123456789',companyNumber:'',email:'',phone:''},priceBasis:'inclusive',vatRates:[{id:'standard',label:'Standard',basisPoints:2000}],defaultCoffeeRateId:'standard',deliveryRateId:'standard',invoicePrefix:'SC-',firstInvoiceNumber:1,paymentInstructions:'Test instructions',confirmed:true,ifVersion:config.version};
 const settings=await call('PUT','/api/admin/wholesale/invoice-settings',value);assert.equal(settings.status,200,settings.text);
 const profile=(await call('GET','/api/wholesale/session',undefined,BUYER)).body.customer;
 const order=(await call('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:profile.version,delivery:'Roastery collection',lines},BUYER)).body.order;
 const request={orderVersion:order.version,settingsVersion:settings.body.version,invoiceDate:'2026-11-10',supplyDate:'2026-11-10'};
 const result=await call('POST',`/api/admin/wholesale/orders/${order.id}/invoice`,request);assert.equal(result.status,201,result.text);return result.body.invoice;
}
before(async()=>{
 provider=await startQuickBooksProvider();vars=quickBooksVars(provider.origin);srv=await startServer({writeLimit:5000,vars:({base})=>({...vars,QUICKBOOKS_REDIRECT_URI:base+root+"/callback"})});
 ADMIN=(await call('POST','/api/auth/setup',{name:'QB Owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 for(const [role,username]of [['admin','other'],['staff','staff'],['manager','manager']]){await call('POST','/api/admin/users',{name:username,username,role,password:'temporary-password'});const r=await call('POST','/api/auth/change',{username,password:'temporary-password',newPassword:username+'-password'},null);if(role==='admin')OTHER=r.cookie;else if(role==='staff')STAFF=r.cookie;else MANAGER=r.cookie;}
 customer=(await call('POST','/api/admin/wholesale/customers',{business:'QB Cafe',address:'Test address',postcode:'NR1 1AA',status:'Active',paymentTerms:'net-30'})).body.customer;
 const account=(await call('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'qb.buyer'})).body;
 BUYER=(await call('POST','/api/wholesale/auth/change-password',{username:'qb.buyer',password:account.temporaryPassword,newPassword:'buyer-password'},null)).cookie;
});
after(async()=>{await srv?.stop();await provider?.stop();});
test('QuickBooks routes deny guests, employees, managers, customer accounts, foreign writes and stale identities before provider calls',async()=>{
 const before=provider.state.calls.length;
 for(const cookie of [null,STAFF,MANAGER,BUYER])for(const [method,path,body]of [['GET','/status'],['POST','/connect',{}],['GET','/callback?state=invalid'],['GET','/references?kind=customer'],['PUT','/mappings',{}],['GET','/invoices/1/preview'],['POST','/disconnect',{}]])assert.ok([401,403].includes((await call(method,root+path,body,cookie)).status));
 assert.equal((await call('POST',root+'/connect',{},ADMIN,{Origin:'https://evil.example'})).status,403);
 assert.equal((await call('GET',root+'/status',undefined,ADMIN,{'x-expected-user-id':'different'})).status,409);assert.equal(provider.state.calls.length,before);
 const s=await status();assert.equal(s.configured,true,JSON.stringify(s));assert.equal(s.environment,'sandbox');assert.equal(s.capabilities.invoiceExport,false);assert.ok(!JSON.stringify(s).includes('test-secret'));
});
test('QuickBooks OAuth states are hashed, session-bound, expiring and consumed once',async()=>{
 const state=await start(),rows=srv.sql('SELECT * FROM quickbooks_auth_states');assert.ok(!JSON.stringify(rows).includes(state));assert.equal((await callback(state,OTHER)).status,400);assert.equal((await callback(state)).status,400);
 const expired=await start();srv.sql('UPDATE quickbooks_auth_states SET expires_at=0');assert.equal((await callback(expired)).status,400);
 const fresh=await start(),connected=await callback(fresh);assert.equal(connected.status,303,JSON.stringify({response:connected.body,calls:provider.state.calls.map(c=>({method:c.method,path:c.path}))}));assert.match(connected.headers.get('location'),/quickbooks=review/);assert.ok(!connected.headers.get('location').includes('code='));assert.equal((await callback(fresh)).status,400);
});
test('QuickBooks credentials are authenticated ciphertext and company confirmation is version-checked',async()=>{
 const row=srv.sql("SELECT * FROM quickbooks_connections WHERE environment='sandbox'")[0];assert.equal(row.status,'pending');assert.ok(!row.token_data.includes('fake-access'));assert.ok(!row.token_data.includes('fake-refresh'));
 const tokens=await unseal(row.token_data,vars.QUICKBOOKS_TOKEN_KEY,row.realm_id,row.generation);assert.match(tokens.access,/^fake-access-/);
 await assert.rejects(unseal(row.token_data,vars.QUICKBOOKS_TOKEN_KEY,'999',row.generation));await assert.rejects(unseal(row.token_data,vars.QUICKBOOKS_TOKEN_KEY,row.realm_id,'another-generation'));
 assert.equal((await call('POST',root+'/confirm',{ifVersion:row.version-1,vatNumber:'GB123456789',confirmed:true})).status,409);
 const s=await confirm();assert.equal(s.connection.status,'connected');assert.equal(s.capabilities.invoicePreview,true);assert.ok(!JSON.stringify(s).includes(tokens.access));
});
test('QuickBooks reference pages are bounded and return a minimal DTO without private provider fields',async()=>{
 const first=await call('GET',root+'/references?kind=customer');assert.equal(first.status,200,first.text);assert.equal(first.body.items.length,100);assert.equal(first.body.nextCursor,'101');
 const next=await call('GET',root+'/references?kind=customer&cursor=101');assert.equal(next.body.items.length,1);assert.equal(next.body.nextCursor,null);assert.ok(!first.text.includes('DO-NOT-RETURN'));assert.ok(!first.text.includes('private@example'));
 for(const query of ['kind=Employee','kind=customer&cursor=1%20OR%201=1','kind=item&cursor=-1'])assert.equal((await call('GET',root+'/references?'+query)).status,400);
});
test('QuickBooks mappings validate scope, active sales items and VAT rates before saving, then preview a real local invoice',async()=>{
 invoice=await issued();const s=await status(),body={ifVersion:0,connectionVersion:s.connection.version,customer:{localId:customer.id,quickbooksId:'99'},coffeeItemId:'50',deliveryItemId:'51',taxMappings:[{rateId:'standard',basisPoints:2000,taxCodeId:'3'}],reviewed:true};
 for(const patch of [{connectionVersion:0},{reviewed:false},{coffeeItemId:'52'},{customer:{localId:customer.id,quickbooksId:'100'}},{taxMappings:[{rateId:'standard',basisPoints:2000,taxCodeId:'4'}]}])assert.ok([400,409].includes((await call('PUT',root+'/mappings',{...body,...patch})).status));
 const saved=await call('PUT',root+'/mappings',body);assert.equal(saved.status,200,saved.text);assert.equal((await call('PUT',root+'/mappings',body)).status,409);
 const result=await call('GET',root+`/invoices/${invoice.id}/preview`);assert.equal(result.status,200,result.text);assert.equal(result.body.preview.state,'ready-for-sandbox-review');assert.equal(result.body.preview.canTransmit,false);assert.deepEqual(result.body.preview.candidate.totals,invoice.totals);assert.ok(!result.text.includes('issuedBy'));
});
test('A large issued invoice verifies each distinct VAT treatment once before sandbox preview',async()=>{
 const catalogue=(await call('GET','/api/wholesale/catalogue',undefined,BUYER)).body.products;
 const lines=catalogue.filter(p=>p.active&&p.inStock).flatMap(p=>Object.keys(p.prices).filter(pack=>pack!=='half').flatMap(pack=>p.grindOptions.filter(g=>g.enabled).map(g=>({productId:p.id,pack,grind:g.id,quantity:1,price:p.prices[pack]})))).slice(0,150);
 assert.ok(lines.length>=80,'exercise a supported invoice with many coffee variants (every coffee in 250 g and 1 kg, in every grind)');
 const large=await issued(lines);assert.equal(large.lines.length,lines.length);
 const before=provider.state.calls.length,result=await call('GET',root+`/invoices/${large.id}/preview`);assert.equal(result.status,200,result.text);assert.equal(result.body.preview.state,'ready-for-sandbox-review');assert.deepEqual(result.body.preview.candidate.totals,large.totals);
 const reads=provider.state.calls.slice(before);assert.equal(reads.filter(c=>c.path.endsWith('/taxcode/3')).length,1);assert.equal(reads.filter(c=>c.path.endsWith('/taxrate/7')).length,1);assert.ok(reads.length<=7,'provider work follows distinct mappings rather than invoice line count');
});
test('Historic VAT labels sharing a sales code do not multiply provider reads when mappings are reviewed',async()=>{
 const saved=(await call('GET',root+'/mappings')).body,before=provider.state.calls.length;
 const taxMappings=[{rateId:'standard',basisPoints:2000,taxCodeId:'3'},...Array.from({length:99},(_,i)=>({rateId:'historic-'+i,basisPoints:2000,taxCodeId:'3'}))];
 const response=await call('PUT',root+'/mappings',{ifVersion:saved.version,connectionVersion:saved.connectionVersion,coffeeItemId:'50',deliveryItemId:'51',taxMappings,reviewed:true});assert.equal(response.status,200,response.text);assert.equal(response.body.data.taxMappings.length,100);
 const reads=provider.state.calls.slice(before);assert.equal(reads.filter(c=>c.path.endsWith('/taxcode/3')).length,1);assert.equal(reads.filter(c=>c.path.endsWith('/taxrate/7')).length,1);assert.ok(reads.length<=5);
});
test('A disconnect during reference reads prevents an in-flight invoice preview returning old company data',async()=>{
 let release;provider.state.readGate={path:'/taxrate/7',wait:new Promise(resolve=>release=resolve)};const before=provider.state.calls.length,pending=call('GET',root+`/invoices/${invoice.id}/preview`);
 for(let i=0;i<500&&!provider.state.calls.slice(before).some(c=>c.path.endsWith('/taxrate/7'));i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(provider.state.calls.slice(before).some(c=>c.path.endsWith('/taxrate/7')));
 const s=await status(),removed=await call('POST',root+'/disconnect',{ifVersion:s.connection.version});assert.equal(removed.status,200,removed.text);release();provider.state.readGate=null;
 const response=await pending;assert.equal(response.status,409,response.text);assert.ok(!response.text.includes('candidate'));assert.equal((await status()).connection.status,'disconnected');await connect();await confirm();
});
test('QuickBooks JSON backups retain mappings and installation identity but exclude credentials and active state',async()=>{
 const created=await call('POST','/api/admin/backups',{}),data=(await call('GET','/api/admin/backups/'+created.body.backup.id)).body;
 assert.equal(data.quickbooks.mode,'disconnected-on-restore');assert.equal(data.quickbooks.mappings.length,1);assert.equal(data.quickbooks.installation.length,1);
 const raw=JSON.stringify(data.quickbooks);for(const value of ['fake-access','fake-refresh','token_data','state_hash','lease_owner'])assert.ok(!raw.includes(value));
});
test('QuickBooks refresh is serialized and stores the latest rotating refresh token',async()=>{
 provider.state.expires=1;await connect();await confirm();let release;provider.state.refreshGate=new Promise(resolve=>release=resolve);
 const before=provider.state.refreshes,first=call('GET',root+'/references?kind=item');for(let i=0;i<500&&provider.state.refreshes===before;i++)await new Promise(r=>setTimeout(r,10));assert.ok(provider.state.refreshes>before);
 const second=await call('GET',root+'/references?kind=customer');assert.equal(second.status,409,second.text);release();provider.state.refreshGate=null;assert.equal((await first).status,200);
 const row=srv.sql("SELECT * FROM quickbooks_connections WHERE environment='sandbox'")[0],tokens=await unseal(row.token_data,vars.QUICKBOOKS_TOKEN_KEY,row.realm_id,row.generation);assert.equal(row.token_version,2);assert.equal(tokens.refresh,'fake-refresh-'+provider.state.sequence);assert.equal(row.lease_owner,null);
});
test('Disconnect during refresh removes credentials and prevents a late response resurrecting the connection',async()=>{
 await connect();await confirm();let release;provider.state.refreshGate=new Promise(resolve=>release=resolve);const before=provider.state.refreshes,pending=call('GET',root+'/references?kind=item');
 for(let i=0;i<500&&provider.state.refreshes===before;i++)await new Promise(r=>setTimeout(r,10));assert.ok(provider.state.refreshes>before);
 const s=await status(),removed=await call('POST',root+'/disconnect',{ifVersion:s.connection.version});assert.equal(removed.status,200,removed.text);release();provider.state.refreshGate=null;assert.equal((await pending).status,409);
 const row=srv.sql("SELECT * FROM quickbooks_connections WHERE environment='sandbox'")[0];assert.equal(row.status,'disconnected');assert.equal(row.token_data,null);assert.equal(row.lease_owner,null);
});
test('Expired QuickBooks refresh credentials require reconnection without ending the admin session',async()=>{
 provider.state.expires=3600;await connect();await confirm();
 const row=srv.sql("SELECT * FROM quickbooks_connections WHERE environment='sandbox'")[0],tokens=await unseal(row.token_data,vars.QUICKBOOKS_TOKEN_KEY,row.realm_id,row.generation);
 tokens.expiresAt=0;tokens.refreshExpiresAt=Date.now()-1000;
 const encrypted=await seal(tokens,vars.QUICKBOOKS_TOKEN_KEY,row.realm_id,row.generation);
 srv.sql("UPDATE quickbooks_connections SET token_data='"+encrypted.replaceAll("'","''")+"' WHERE environment='sandbox'");
 const before=provider.state.refreshes,response=await call('GET',root+'/references?kind=item');assert.equal(response.status,409,response.text);assert.equal(provider.state.refreshes,before);
 const state=await status();assert.equal(state.connection.status,'needs-reconnect');assert.equal(srv.sql("SELECT token_data FROM quickbooks_connections WHERE environment='sandbox'")[0].token_data,null);
 assert.equal((await call('GET','/api/auth/me')).status,200);
});
test('QuickBooks rejects the wrong country/currency and redacts provider failures without accounting writes',async()=>{
 provider.state.country='US';assert.equal((await callback(await start())).status,400);provider.state.country='GB';provider.state.currency='USD';assert.equal((await callback(await start())).status,400);provider.state.currency='GBP';provider.state.expires=3600;await connect();await confirm();
 provider.state.fail={path:'/query',status:502};const error=await call('GET',root+'/references?kind=item');assert.equal(error.status,503);assert.ok(!error.text.includes('FAKE-PROVIDER-SECRET'));provider.state.fail=null;
 provider.state.fail={path:'/query',status:302,location:provider.origin+'/collector'};assert.equal((await call('GET',root+'/references?kind=item')).status,503);assert.ok(!provider.state.calls.some(call=>call.path==='/collector'));provider.state.fail=null;
 provider.state.fail={path:'/query',status:401};assert.equal((await call('GET',root+'/references?kind=item')).status,409);assert.equal((await status()).connection.status,'needs-reconnect');provider.state.fail=null;
 assert.ok(provider.state.calls.filter(call=>call.method!=='GET').every(call=>['/token','/revoke'].includes(call.path)),'no accounting writes, emails or payment calls are possible');
});

test('QuickBooks missing credentials and an untrusted callback address keep connection disabled',async()=>{
 for(const vars of [{},{...quickBooksVars(provider.origin),QUICKBOOKS_REDIRECT_URI:'https://evil.example/api/admin/wholesale/quickbooks/callback'}]) {
  const isolated=await startServer({vars});
  try {
   const setup=await fetch(isolated.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Config Owner',username:'owner',password:'owner-password',code:SETUP_CODE})}),cookie=cookieOf(setup);
   const result=await fetch(isolated.base+root+'/status',{headers:{cookie}}),body=await result.json();assert.equal(body.configured,false);assert.equal(body.capabilities.invoicePreview,false);
   const connect=await fetch(isolated.base+root+'/connect',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});assert.equal(connect.status,409);
  } finally {await isolated.stop();}
 }
});
