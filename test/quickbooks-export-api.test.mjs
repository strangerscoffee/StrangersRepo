import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
let srv,provider,ADMIN,OTHER,STAFF,BUYER,customer,first,template;
const root='/api/admin/wholesale/quickbooks';
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN,environment='sandbox'){
 const url=srv.base+path+(path.startsWith(root)?(path.includes('?')?'&':'?')+'environment='+environment:'');
 const res=await fetch(url,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}),text=await res.text();let data;try{data=JSON.parse(text);}catch{}
 return{status:res.status,body:data,text,cookie:cookieOf(res)};
}
async function ok(method,path,body,cookie=ADMIN,environment='sandbox'){const r=await call(method,path,body,cookie,environment);assert.ok(r.status>=200&&r.status<400,path+': '+r.text);return r;}
async function state(environment='sandbox'){return(await ok('GET',root+'/status',undefined,ADMIN,environment)).body;}
async function connect(environment='sandbox'){
 const old=await state(environment);if(['connected','pending'].includes(old.connection.status))await ok('POST',root+'/disconnect',{ifVersion:old.connection.version},ADMIN,environment);
 const started=(await ok('POST',root+'/connect',{},ADMIN,environment)).body,nonce=new URL(started.authorizeUrl).searchParams.get('state');
 await ok('GET',root+'/callback?code=test-code&realmId=1234567890&state='+nonce,undefined,ADMIN,environment);const pending=await state(environment);
 await ok('POST',root+'/confirm',{ifVersion:pending.connection.version,vatNumber:'GB123456789',confirmed:true},ADMIN,environment);
 const mappings=(await ok('GET',root+'/mappings',undefined,ADMIN,environment)).body;
 await ok('PUT',root+'/mappings',{ifVersion:mappings.version,connectionVersion:(await state(environment)).connection.version,customer:{localId:customer.id,quickbooksId:'3'},coffeeItemId:'50',deliveryItemId:'51',taxMappings:[{rateId:'standard',basisPoints:2000,taxCodeId:'3'},{rateId:'zero',basisPoints:0,taxCodeId:'4'},{rateId:'exempt',basisPoints:0,taxCodeId:'5'}],term:{localId:'net-30',quickbooksId:'30'},reviewed:true},ADMIN,environment);
}
async function issued({basis='inclusive',quantity=2,rate='standard',delivery=0,pack='kilo',fulfilment='Roastery collection'}={}){
 const old=(await ok('GET','/api/admin/wholesale/invoice-settings')).body;
 const saved=(await ok('PUT','/api/admin/wholesale/invoice-settings',{ifVersion:old.version,seller:{legalName:'Example Merchant Ltd',address:'Test merchant address',vatNumber:'GB123456789',companyNumber:'',email:'',phone:''},priceBasis:basis,vatRates:[{id:'standard',label:'Standard',basisPoints:2000},{id:'zero',label:'Zero rated',basisPoints:0},{id:'exempt',label:'Exempt',basisPoints:0}],defaultCoffeeRateId:rate,deliveryRateId:'standard',invoicePrefix:'QB-',firstInvoiceNumber:1,paymentInstructions:'Test bank instructions',confirmed:true})).body;
 const profile=(await ok('GET','/api/wholesale/session',undefined,BUYER)).body.customer;
 const order=(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:profile.version,delivery:fulfilment,lines:[{productId:'brazil',pack,grind:'beans',quantity,price:pack==='quarter'?500:1800}]},BUYER)).body.order;
 return(await ok('POST',`/api/admin/wholesale/orders/${order.id}/invoice`,{orderVersion:order.version,settingsVersion:saved.version,invoiceDate:'2026-11-10',supplyDate:'2026-11-09',deliveryCharge:{pence:delivery,description:'Delivery',vatRateId:'standard'}})).body.invoice;
}
async function review(invoice,environment='sandbox'){return(await ok('GET',root+`/invoices/${invoice.id}/preview`,undefined,ADMIN,environment)).body;}
async function send(invoice,environment='sandbox',extra={}){const reviewed=await review(invoice,environment);assert.notEqual(reviewed.preview.state,'blocked',JSON.stringify(reviewed.preview));const sent=await call('POST',root+`/invoices/${invoice.id}/export`,{fingerprint:reviewed.preview.fingerprint,connectionVersion:reviewed.connectionVersion,mappingVersion:reviewed.mappingVersion,modeVersion:reviewed.modeVersion,reviewed:true,...extra},ADMIN,environment);if(sent.status===200||sent.status===202)await ok('POST',root+'/exports/'+sent.body.export.id+'/process',{},ADMIN,environment);return sent;}
async function settled(id,environment='sandbox',states=['linked','review','paused','uncertain']){
 let last;for(let attempt=0;attempt<200;attempt++){last=(await ok('GET',root+'/exports/'+id,undefined,ADMIN,environment)).body.export;if(states.includes(last.state))return last;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Export did not settle: '+JSON.stringify(last));
}
async function retry(saved,environment='sandbox'){await ok('POST',root+`/exports/${saved.id}/retry`,{ifVersion:saved.version,modeVersion:(await state(environment)).modeVersion,reviewed:true},ADMIN,environment);await ok('POST',root+'/exports/'+saved.id+'/process',{},ADMIN,environment);return settled(saved.id,environment);}
const posts=(environment='sandbox')=>provider.state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/invoice')&&c.path.startsWith('/'+environment+'/'));
before(async()=>{
 provider=await startQuickBooksProvider();srv=await startServer({scheduled:true,writeLimit:5000,vars:({base})=>({...quickBooksVars(provider.origin),QUICKBOOKS_SANDBOX_WEBHOOK_TOKEN:'sandbox-verifier-secret-for-tests',QUICKBOOKS_PRODUCTION_WEBHOOK_TOKEN:'production-verifier-secret-for-tests',QUICKBOOKS_REDIRECT_URI:base+root+'/callback'})});
 ADMIN=(await ok('POST','/api/auth/setup',{name:'Integration Owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 for(const [role,username]of [['admin','other'],['staff','staff']]){await ok('POST','/api/admin/users',{name:username,username,role,password:'temporary-password'});const r=await ok('POST','/api/auth/change',{username,password:'temporary-password',newPassword:username+'-password'},null);if(role==='admin')OTHER=r.cookie;else STAFF=r.cookie;}
 customer=(await ok('POST','/api/admin/wholesale/customers',{business:'Export Cafe',address:'1 Test Road',postcode:'NR1 1AA',status:'Active',paymentTerms:'net-30'})).body.customer;
 const account=(await ok('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'export.buyer'})).body;
 BUYER=(await ok('POST','/api/wholesale/auth/change-password',{username:'export.buyer',password:account.temporaryPassword,newPassword:'buyer-password'},null)).cookie;await connect();
});
after(async()=>{await srv?.stop();await provider?.stop();});
test('Exports and environment controls require a current admin; production stays gated until testing is complete',async()=>{
 const before=provider.state.calls.length;
 for(const cookie of [null,STAFF,BUYER])for(const [method,path,body]of [['PUT','/mode',{}],['POST','/approve-live',{}],['POST','/invoices/1/export',{}],['POST','/exports/1/retry',{}],['POST','/exports/1/process',{}],['POST','/exports/1/link-existing',{}],['POST','/exports/1/refresh',{}],['GET','/exports']])assert.ok([401,403].includes((await call(method,root+path,body,cookie)).status));
 assert.equal(provider.state.calls.length,before);const s=await state();assert.equal(s.activeEnvironment,'sandbox');assert.equal((await call('PUT',root+'/mode',{ifVersion:s.modeVersion,environment:'production',reviewed:true})).status,409);
});
test('Sandbox export preserves prices, VAT, terms, supply dates, addresses and source identity without customer payment changes',async()=>{
 first=await issued();const sent=await send(first);assert.equal(sent.status,202,sent.text);const saved=await settled(sent.body.export.id);assert.equal(saved.state,'linked',JSON.stringify(saved));assert.equal(saved.observation.status,'unpaid');
 const posted=posts().at(-1),payload=JSON.parse(posted.body);template=structuredClone(provider.state.invoices.sandbox.get(saved.remoteId));
 assert.equal(payload.DocNumber,first.number);assert.equal(payload.GlobalTaxCalculation,'TaxInclusive');assert.equal(payload.Line[0].Amount,30);assert.equal(payload.Line[0].SalesItemLineDetail.TaxInclusiveAmt,36);assert.equal(payload.TxnTaxDetail.TotalTax,6);assert.equal(payload.DueDate,'2026-12-10');assert.equal(payload.Line[0].SalesItemLineDetail.ServiceDate,'2026-11-09');assert.equal(payload.SalesTermRef.value,'30');assert.match(payload.PrivateNote,/Test bank instructions/);assert.ok(!posted.body.includes('Integration Owner'));assert.ok(!posted.body.includes('issuedBy'));
 const customerInvoice=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;assert.equal(customerInvoice.payment.paid,false);assert.equal(customerInvoice.accounting,undefined);
});
test('The current quarter-bag price and saved delivery charge retain exact VAT pence on export',async()=>{
 const invoice=await issued({pack:'quarter',quantity:1,delivery:744,fulfilment:'Delivery'}),sent=await send(invoice),saved=await settled(sent.body.export.id);assert.equal(saved.state,'linked',JSON.stringify(saved));
 const payload=JSON.parse(posts().at(-1).body);assert.equal(payload.Line.length,2);assert.equal(payload.Line[0].Amount,4.17);assert.equal(payload.Line[0].SalesItemLineDetail.TaxInclusiveAmt,5);assert.equal(payload.Line[1].Amount,6.2);assert.equal(payload.Line[1].SalesItemLineDetail.TaxInclusiveAmt,7.44);assert.equal(payload.Line[1].SalesItemLineDetail.ItemRef.value,'51');assert.equal(payload.TxnTaxDetail.TotalTax,2.07);assert.equal(invoice.totals.grossPence,1244);
});
test('Concurrent sends and exact retries recover one durable operation and one remote invoice',async()=>{
 const invoice=await issued(),r=await review(invoice),body={fingerprint:r.preview.fingerprint,connectionVersion:r.connectionVersion,mappingVersion:r.mappingVersion,modeVersion:r.modeVersion,reviewed:true},before=posts().length;
 const responses=await Promise.all(Array.from({length:6},()=>call('POST',root+`/invoices/${invoice.id}/export`,body)));assert.ok(responses.every(r=>[200,202].includes(r.status)),responses.map(r=>r.text).join('\n'));assert.equal(new Set(responses.map(r=>r.body.export.id)).size,1);
 await Promise.all(responses.map(response=>ok('POST',root+'/exports/'+response.body.export.id+'/process',{})));const saved=await settled(responses[0].body.export.id);assert.equal(saved.state,'linked',JSON.stringify(saved));assert.equal(posts().length-before,1);const again=await call('POST',root+`/invoices/${invoice.id}/export`,body);assert.equal(again.body.export.id,saved.id);assert.equal(posts().length-before,1);
});
test('An accepted invoice with a lost response is recovered by its original number and request marker',async()=>{
 const invoice=await issued();provider.state.dropCreateResponse=true;const before=provider.state.invoices.sandbox.size,sent=await send(invoice),uncertain=await settled(sent.body.export.id);provider.state.dropCreateResponse=false;
 assert.equal(uncertain.state,'uncertain',JSON.stringify(uncertain));assert.equal(provider.state.invoices.sandbox.size,before+1);const callsBefore=posts().length,saved=await retry(uncertain);assert.equal(saved.state,'linked',JSON.stringify(saved));assert.equal(posts().length,callsBefore);assert.equal(provider.state.invoices.sandbox.size,before+1);
});
test('Rate-limit retries preserve the exact frozen body and request ID across local paid metadata changes',async()=>{
 const invoice=await issued();provider.state.rateLimitNext=true;const sent=await send(invoice),pending=await settled(sent.body.export.id);assert.equal(pending.state,'uncertain');const original=posts().at(-1);
 await ok('PATCH',`/api/admin/wholesale/invoices/${invoice.id}/payment`,{ifVersion:invoice.payment.version,paid:true,reference:'Test paid locally'});const saved=await retry(pending);assert.equal(saved.state,'linked',JSON.stringify(saved));const retried=posts().at(-1);assert.equal(retried.body,original.body);assert.equal(new URLSearchParams(retried.query).get('requestid'),new URLSearchParams(original.query).get('requestid'));
});
test('Remote financial differences enter review without another create or false sandbox evidence',async()=>{
 const invoice=await issued({basis:'exclusive'});provider.state.createTransform=remote=>{remote.TotalAmt+=0.01;remote.Balance=remote.TotalAmt;};const sent=await send(invoice),saved=await settled(sent.body.export.id);provider.state.createTransform=null;
 assert.equal(saved.state,'review');assert.match(saved.lastError,/amounts differ/);assert.ok(saved.remoteId);const before=posts().length,retried=await retry(saved);assert.equal(retried.state,'review');assert.equal(posts().length,before);assert.equal(srv.sql('SELECT sandbox_eligible FROM quickbooks_exports WHERE id='+saved.id)[0].sandbox_eligible,0);
});
test('An existing manual invoice requires explicit matching adoption and is never recreated',async()=>{
 const invoice=await issued(),manual=structuredClone(template);manual.Id='5000';manual.DocNumber=invoice.number;manual.PrivateNote='Existing bookkeeping entry';provider.state.invoices.sandbox.set(manual.Id,manual);
 const before=posts().length,sent=await send(invoice),saved=await settled(sent.body.export.id);assert.equal(saved.state,'review',JSON.stringify(saved));assert.equal(saved.remoteId,'5000');assert.equal(posts().length,before);
 const linked=await ok('POST',root+`/exports/${saved.id}/link-existing`,{ifVersion:saved.version,remoteId:'5000',modeVersion:(await state()).modeVersion,reviewed:true});assert.equal(linked.body.export.state,'linked');assert.equal(linked.body.export.createdRemote,false);assert.equal(posts().length,before);
});

test('Sandbox payment evidence and explicit company review are required before Live can be activated',async()=>{
 const sandboxBefore=await state();await connect('production');assert.equal((await state()).connection.version,sandboxBefore.connection.version,'Live OAuth must not replace Sandbox credentials');
 const firstExport=(await ok('GET',root+'/exports?invoiceId='+first.id)).body.exports[0];
 provider.state.pay('sandbox',firstExport.remoteId,18);let refreshed=await ok('POST',root+`/exports/${firstExport.id}/refresh`,{});assert.equal(refreshed.body.export.observation.status,'part-paid');assert.equal(refreshed.body.export.observation.outstanding_pence,1800);
 provider.state.pay('sandbox',firstExport.remoteId,0);refreshed=await ok('POST',root+`/exports/${firstExport.id}/refresh`,{});assert.equal(refreshed.body.export.observation.status,'paid');
 const local=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;assert.equal(local.payment.paid,false);assert.equal(local.accounting,undefined,'Sandbox payment data never changes customer invoices');
 const ready=(await ok('GET',root+'/readiness')).body;assert.ok(ready.checks.every(c=>c.ok),JSON.stringify(ready));assert.equal(ready.ready,false);
 const body={ifVersion:ready.modeVersion,connectionVersion:ready.connectionVersion,fingerprint:ready.fingerprint,reviewed:true,attestations:{company:true,vat:true,rounding:true,payments:true,fees:true}};
 assert.equal((await call('POST',root+'/approve-live',{...body,attestations:{}})).status,400);assert.equal((await call('POST',root+'/approve-live',{...body,fingerprint:'stale'})).status,409);
 const approved=(await ok('POST',root+'/approve-live',body)).body;assert.equal(approved.ready,true);assert.equal((await state()).activeEnvironment,'sandbox');
 await ok('PUT',root+'/mode',{ifVersion:approved.modeVersion,environment:'production',reviewed:true});assert.equal((await state('production')).activeEnvironment,'production');assert.equal((await state('production')).capabilities.invoiceExport,true);assert.equal((await state()).capabilities.invoiceExport,false);
});
test('Live exports and payment balances are environment scoped, customer owned and financially immutable',async()=>{
 const before=srv.sql('SELECT data,paid FROM wholesale_invoices WHERE seq='+first.id)[0],sent=await send(first,'production');assert.equal(sent.status,202,sent.text);const saved=await settled(sent.body.export.id,'production');assert.equal(saved.state,'linked',JSON.stringify(saved));assert.equal(saved.remoteId,'1000','same remote IDs may exist in different environments');
 const sandbox=(await ok('GET',root+'/exports?invoiceId='+first.id)).body.exports[0];assert.notEqual(sandbox.id,saved.id);assert.notEqual(srv.sql('SELECT request_id FROM quickbooks_exports WHERE id='+sandbox.id)[0].request_id,srv.sql('SELECT request_id FROM quickbooks_exports WHERE id='+saved.id)[0].request_id);
 const pdfBefore=Buffer.from(await(await fetch(srv.base+`/api/wholesale/invoices/${first.id}/pdf`,{headers:{cookie:BUYER}})).arrayBuffer());
 provider.state.pay('production',saved.remoteId,18);await ok('POST',root+`/exports/${saved.id}/refresh`,{},ADMIN,'production');let own=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;
 assert.equal(own.payment.status,'part-paid');assert.equal(own.payment.outstandingPence,1800);assert.equal(own.payment.paidPence,1800);assert.equal(own.payment.source,'quickbooks');for(const key of ['exportId','reason'])assert.equal(own.accounting[key],undefined);
 const second=(await ok('POST','/api/admin/wholesale/customers',{business:'Other Export Cafe',address:'Another test address',postcode:'NR2 1AA',status:'Active'})).body.customer,account=(await ok('POST',`/api/admin/wholesale/customers/${second.id}/account`,{username:'other.buyer'})).body;
 const buyer=(await ok('POST','/api/wholesale/auth/change-password',{username:'other.buyer',password:account.temporaryPassword,newPassword:'other-buyer-password'},null)).cookie;
 assert.equal((await call('GET','/api/wholesale/invoices/'+first.id,undefined,buyer)).status,404);const others=(await ok('GET','/api/wholesale/invoices',undefined,buyer)).body;assert.equal(others.count,0);assert.equal(others.summary.outstandingPence,0);
 provider.state.pay('production',saved.remoteId,0);await ok('POST',root+`/exports/${saved.id}/refresh`,{},ADMIN,'production');own=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;assert.equal(own.payment.paid,true);assert.equal(own.payment.outstandingPence,0);
 assert.equal((await call('PATCH',`/api/admin/wholesale/invoices/${first.id}/payment`,{ifVersion:own.payment.version,paid:false})).status,409,'managed payment metadata cannot be changed through the local paid toggle');
 assert.deepEqual(srv.sql('SELECT data,paid FROM wholesale_invoices WHERE seq='+first.id)[0],before);const pdfAfter=Buffer.from(await(await fetch(srv.base+`/api/wholesale/invoices/${first.id}/pdf`,{headers:{cookie:BUYER}})).arrayBuffer());assert.deepEqual(pdfAfter,pdfBefore);
});
test('An older in-flight QuickBooks response cannot roll back a newer payment revision',async()=>{
 const invoice=await issued(),sent=await send(invoice,'production'),saved=await settled(sent.body.export.id,'production');assert.equal(saved.state,'linked',JSON.stringify(saved));
 const partial=structuredClone(provider.state.pay('production',saved.remoteId,18));let release;const before=provider.state.calls.length;
 provider.state.readGate={path:'/production/v3/company/1234567890/invoice/'+saved.remoteId,once:true,wait:new Promise(resolve=>release=resolve),response:{Invoice:partial}};
 const old=call('POST',root+`/exports/${saved.id}/refresh`,{},ADMIN,'production');for(let i=0;i<500&&!provider.state.calls.slice(before).some(c=>c.path.endsWith('/invoice/'+saved.remoteId));i++)await new Promise(r=>setTimeout(r,10));
 provider.state.pay('production',saved.remoteId,0);const fresh=await ok('POST',root+`/exports/${saved.id}/refresh`,{},ADMIN,'production');assert.equal(fresh.body.export.observation.status,'paid');release();assert.equal((await old).status,200);
 const final=(await ok('GET',root+'/exports/'+saved.id,undefined,ADMIN,'production')).body.export;assert.equal(final.observation.status,'paid');assert.equal(final.observation.sync_token,'2');
});
test('Live activation never authorises an untested price basis or VAT treatment',async()=>{
 const invoice=await issued({basis:'exclusive'}),config=(await ok('GET','/api/admin/wholesale/invoice-settings')).body;
 await ok('PUT','/api/admin/wholesale/invoice-settings',{...config.settings,priceBasis:'inclusive',ifVersion:config.version});
 const before=posts('production').length,sent=await send(invoice,'production');assert.equal(sent.status,409,sent.text);assert.equal(sent.body.code,'quickbooks_untested_vat');assert.equal(posts('production').length,before);
});
test('Environment switching waits for an active send, while existing Live balances remain readable in Sandbox',async()=>{
 const invoice=await issued();let release;const before=provider.state.calls.length;provider.state.readGate={path:'/production/v3/company/1234567890/query',once:true,wait:new Promise(resolve=>release=resolve)};
 const sent=await send(invoice,'production');for(let i=0;i<500&&!provider.state.calls.slice(before).some(c=>c.path.endsWith('/query'));i++)await new Promise(r=>setTimeout(r,10));
 const current=await state();const blocked=await call('PUT',root+'/mode',{ifVersion:current.modeVersion,environment:'sandbox',reviewed:true});assert.equal(blocked.status,409,blocked.text);assert.equal(blocked.body.code,'quickbooks_busy');
 release();const saved=await settled(sent.body.export.id,'production');assert.equal(saved.state,'linked',JSON.stringify(saved));await ok('PUT',root+'/mode',{ifVersion:(await state()).modeVersion,environment:'sandbox',reviewed:true});
 provider.state.pay('production',saved.remoteId,0);await ok('POST',root+`/exports/${saved.id}/refresh`,{},ADMIN,'production');assert.equal((await ok('GET','/api/wholesale/invoices/'+invoice.id,undefined,BUYER)).body.invoice.payment.paid,true);
});

function event(id,entityId,entity='invoice',operation='updated',realm='1234567890'){return[{specversion:'1.0',id,source:'intuit.test',type:`qbo.${entity}.${operation}.v1`,datacontenttype:'application/json',time:new Date().toISOString(),intuitaccountid:realm,intuitentityid:entityId,data:{}}];}
async function webhook(environment,data,secret){const body=JSON.stringify(data),signature=createHmac('sha256',secret||(environment==='sandbox'?'sandbox-verifier-secret-for-tests':'production-verifier-secret-for-tests')).update(body).digest('base64');const response=await fetch(srv.base+'/api/quickbooks/webhook/'+environment,{method:'POST',headers:{'content-type':'application/json','intuit-signature':signature},body});return{status:response.status,text:await response.text()};}
async function waitBalance(invoiceId,expected){for(let i=0;i<200;i++){const invoice=(await ok('GET','/api/wholesale/invoices/'+invoiceId,undefined,BUYER)).body.invoice;if(invoice.payment.outstandingPence===expected&&invoice.payment.status!=='review')return invoice;await new Promise(r=>setTimeout(r,25));}throw new Error('Payment balance did not reach '+expected);}
async function cron(){const response=await fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'));assert.equal(response.status,200,await response.text());await new Promise(r=>setTimeout(r,50));}
test('Webhook signatures, environment isolation, unknown companies and unsupported employee data fail closed',async()=>{
 const before=provider.state.calls.length;
 const bad=await fetch(srv.base+'/api/quickbooks/webhook/production',{method:'POST',headers:{'content-type':'application/json','intuit-signature':'invalid'},body:'{}'});assert.equal(bad.status,401);
 assert.equal((await webhook('production',event('wrong-key','1000'),'sandbox-verifier-secret-for-tests')).status,401);
 assert.equal((await webhook('production',event('unknown-realm','1000','invoice','updated','999999'))).status,200);
 assert.equal((await webhook('production',event('employee-event','1000','employee'))).status,200);
 assert.equal(provider.state.calls.length,before);assert.equal(srv.sql('SELECT COUNT(*) AS n FROM quickbooks_events')[0].n,0);
});
test('Signed invoice events update only Live balances and exact webhook replays remain idempotent',async()=>{
 const live=(await ok('GET',root+'/exports?invoiceId='+first.id,undefined,ADMIN,'production')).body.exports[0];provider.state.pay('production',live.remoteId,18);
 const payload=event('live-invoice-event',live.remoteId),before=provider.state.calls.filter(c=>c.path==='/production/v3/company/1234567890/invoice/'+live.remoteId).length;
 assert.equal((await webhook('production',payload)).status,200);await waitBalance(first.id,1800);assert.equal((await webhook('production',payload)).status,200);
 await new Promise(r=>setTimeout(r,50));assert.equal(srv.sql("SELECT COUNT(*) AS n FROM quickbooks_events WHERE event_key LIKE 'production:%:live-invoice-event'")[0].n,1);
 assert.equal(provider.state.calls.filter(c=>c.path==='/production/v3/company/1234567890/invoice/'+live.remoteId).length-before,1);
 const sandbox=(await ok('GET',root+'/exports?invoiceId='+first.id)).body.exports[0];provider.state.pay('sandbox',sandbox.remoteId,10);assert.equal((await webhook('sandbox',event('sandbox-invoice-event',sandbox.remoteId))).status,200);await new Promise(r=>setTimeout(r,75));assert.equal((await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice.payment.outstandingPence,1800);
});
test('Legacy and CloudEvents test wrappers are accepted without persisting provider addresses or private fields',async()=>{
 const live=(await ok('GET',root+'/exports?invoiceId='+first.id,undefined,ADMIN,'production')).body.exports[0];provider.state.pay('production',live.remoteId,0);
 const legacy={eventNotifications:[{realmId:'1234567890',dataChangeEvent:{entities:[{name:'Invoice',id:live.remoteId,operation:'Update',lastUpdated:new Date().toISOString(),private:'NEVER-PERSIST-WEBHOOK-PRIVATE'}]}}]};
 assert.equal((await webhook('production',[{specversion:'1.0',type:'qbo.invoice.updated.v1',data:legacy}])).status,200);await waitBalance(first.id,0);assert.ok(!JSON.stringify(srv.sql('SELECT * FROM quickbooks_events')).includes('NEVER-PERSIST-WEBHOOK-PRIVATE'));
});
test('Payment creates and deletions reconcile linked invoices without creating money transactions',async()=>{
 const live=(await ok('GET',root+'/exports?invoiceId='+first.id,undefined,ADMIN,'production')).body.exports[0],before=posts('production').length;
 provider.state.pay('production',live.remoteId,20);provider.state.payments.production.set('900',{Id:'900',Line:[{LinkedTxn:[{TxnType:'Invoice',TxnId:live.remoteId}]}]});
 assert.equal((await webhook('production',event('payment-created','900','payment','created'))).status,200);await waitBalance(first.id,2000);
 provider.state.pay('production',live.remoteId,36);provider.state.payments.production.delete('900');assert.equal((await webhook('production',event('payment-deleted','900','payment','deleted'))).status,200);await waitBalance(first.id,3600);
 assert.equal(posts('production').length,before);assert.ok(!provider.state.calls.some(c=>c.method==='POST'&&c.path.endsWith('/payment')));
});
test('Scheduled change capture recovers missed notifications using only saved invoice links',async()=>{
 const live=(await ok('GET',root+'/exports?invoiceId='+first.id,undefined,ADMIN,'production')).body.exports[0];provider.state.pay('production',live.remoteId,12.34);
 for(let count=0;count<12;count++){await cron();const own=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;if(own.payment.outstandingPence===1234)break;}
 assert.equal((await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice.payment.outstandingPence,1234);assert.ok(provider.state.calls.some(c=>c.path.endsWith('/cdc')));
});
test('Voided or edited invoices are reviewed instead of falsely marked paid',async()=>{
 const live=(await ok('GET',root+'/exports?invoiceId='+first.id,undefined,ADMIN,'production')).body.exports[0],remote=provider.state.invoices.production.get(live.remoteId);remote.TotalAmt=0;remote.Balance=0;remote.SyncToken=String(Number(remote.SyncToken)+1);
 assert.equal((await webhook('production',event('invoice-voided',live.remoteId,'invoice','voided'))).status,200);
 for(let i=0;i<200;i++){const own=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;if(own.payment.status==='review')break;await new Promise(r=>setTimeout(r,25));}
 const own=(await ok('GET','/api/wholesale/invoices/'+first.id,undefined,BUYER)).body.invoice;assert.equal(own.payment.status,'review');assert.equal(own.payment.paid,false);assert.equal(own.accounting.reason,undefined);const listed=(await ok('GET','/api/wholesale/invoices',undefined,BUYER)).body;assert.ok(listed.summary.reviewCount>=1);
});
test('Missed-event reconciliation receives a scheduled turn even with an older notification backlog',async()=>{
 srv.sql("UPDATE quickbooks_reconciliation SET updated_at=0,retry_at=0,lease_owner=NULL,lease_until=0;WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10) INSERT INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at) SELECT 'fairness-fixture:'||x,'production','1234567890','Invoice','999999','refresh',1,1 FROM n");
 const before=provider.state.calls.filter(call=>call.path.endsWith('/cdc')).length;await cron();
 assert.ok(provider.state.calls.filter(call=>call.path.endsWith('/cdc')).length>before);assert.equal(srv.sql("SELECT COUNT(*) AS n FROM quickbooks_events WHERE event_key LIKE 'fairness-fixture:%' AND state='queued'")[0].n,10,'catch-up was not starved by the old queue');
 srv.sql("DELETE FROM quickbooks_events WHERE event_key LIKE 'fairness-fixture:%'");
});
test('An admin losing access while a queued export is checked cannot create its remote invoice',async()=>{
 const invoice=await issued(),reviewed=await review(invoice),owner=(await ok('GET','/api/auth/me',undefined,OTHER)).body.user;
 let release;const wait=new Promise(resolve=>{release=resolve;});provider.state.readGate={path:'/query',wait,once:true};const before=posts().length;
 try{
  const sent=await ok('POST',root+`/invoices/${invoice.id}/export`,{fingerprint:reviewed.preview.fingerprint,connectionVersion:reviewed.connectionVersion,mappingVersion:reviewed.mappingVersion,modeVersion:reviewed.modeVersion,reviewed:true},OTHER);
  await ok('POST',root+'/exports/'+sent.body.export.id+'/process',{},OTHER);
  for(let i=0;i<200&&provider.state.readGate;i++)await new Promise(r=>setTimeout(r,10));assert.equal(provider.state.readGate,null,'worker reached provider identity check');
  await ok('PATCH','/api/admin/users/'+owner.id,{role:'staff'});release();
  const saved=await settled(sent.body.export.id);assert.equal(saved.state,'review',JSON.stringify(saved));assert.equal(posts().length,before);assert.match(saved.lastError,/Administrator access changed/);
 }finally{release();provider.state.readGate=null;await ok('PATCH','/api/admin/users/'+owner.id,{role:'admin'});}
});
test('A changed frozen request cannot be sent on retry, and customer invoice DTOs omit employee/payment notes',async()=>{
 const invoice=await issued();provider.state.rateLimitNext=true;const sent=await send(invoice),saved=await settled(sent.body.export.id);assert.equal(saved.state,'uncertain');const before=posts().length;
 srv.sql("UPDATE quickbooks_exports SET payload='{}' WHERE id="+saved.id);const checked=await retry(saved);assert.equal(checked.state,'review');assert.match(checked.lastError,/saved export changed/);assert.equal(posts().length,before);
 await ok('PATCH',`/api/admin/wholesale/invoices/${invoice.id}/payment`,{ifVersion:invoice.payment.version,paid:true,reference:'INTERNAL-PAYMENT-REFERENCE'});
 for(const url of ['/api/wholesale/invoices/'+invoice.id,'/api/wholesale/orders/'+invoice.orderId+'/invoice']){const own=(await ok('GET',url,undefined,BUYER)).body.invoice;assert.equal(own.issuedBy,null);assert.equal(own.payment.reference,'');}
 const listed=(await ok('GET','/api/wholesale/invoices',undefined,BUYER)).body.invoices.find(value=>value.id===invoice.id);assert.equal(listed.issuedBy,null);assert.equal(listed.payment.reference,'');
});
test('Runtime backups preserve original operations and links while excluding credentials, leases and active Live state',async()=>{
 const created=(await ok('POST','/api/admin/backups',{})).body,data=(await ok('GET','/api/admin/backups/'+created.backup.id)).body,qb=data.quickbooks;
 assert.equal(qb.mode,'disconnected-on-restore');assert.equal(qb.settings.active_environment,'sandbox');assert.equal(qb.settings.live_approval,null);assert.ok(qb.exports.length>=10);
 for(const row of qb.exports){assert.ok(row.request_id&&row.payload&&row.source_hash);assert.ok(!('lease_owner'in row));assert.ok(!('lease_until'in row));assert.ok(['linked','review'].includes(row.state));}
 for(const row of [...qb.events,...qb.reconciliation]){assert.ok(!('lease_owner'in row));assert.ok(!('lease_until'in row));}
 const serialized=JSON.stringify(qb);for(const secret of ['fake-access','fake-refresh','token_data','state_hash','client_secret'])assert.ok(!serialized.includes(secret),secret+' must be absent');
 const linked=qb.exports.find(row=>row.environment==='production'&&row.invoice_id===first.id);assert.ok(linked.remote_id);assert.ok(linked.company_name);assert.ok(qb.observations.some(row=>row.export_id===linked.id));
});
test('Export history pages original companies without mixing Sandbox and Live or losing invoice lookup after reconnect',async()=>{
 const initial=(await ok('GET',root+'/exports')).body.exports.length;
 srv.sql(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<55) INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,state,created_at,updated_at) SELECT 'sandbox','previous-test-company','Previous sandbox',e.company_vat,10000+n.x,'history-test-'||n.x,e.fingerprint,e.payload,e.payload_hash,e.source_hash,e.created_by,e.preview,e.profiles,e.connection_generation,e.mapping_version,'review',e.created_at,e.updated_at FROM n CROSS JOIN quickbooks_exports e WHERE e.id=(SELECT MIN(id) FROM quickbooks_exports)`);
 let cursor=null;const found=[];do{const page=(await ok('GET',root+'/exports'+(cursor?'?cursor='+cursor:''))).body;assert.ok(page.exports.length<=50);found.push(...page.exports);cursor=page.nextCursor;}while(cursor);
 assert.equal(found.length,initial+55);assert.equal(new Set(found.map(row=>row.id)).size,found.length);assert.ok(found.every(row=>row.environment==='sandbox'));assert.equal(found.filter(row=>row.realmId==='previous-test-company').length,55);
 const old=(await ok('GET',root+'/exports?invoiceId=10001')).body.exports;assert.equal(old.length,1);assert.equal(old[0].realmId,'previous-test-company');assert.equal((await call('GET',root+'/exports?cursor=invalid')).status,400);
});
