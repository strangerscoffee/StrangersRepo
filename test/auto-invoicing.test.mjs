// Automatic invoicing (the owner's request, 23 Nov 2026): invoices issued when customer orders are dispatched (a tab's
// orders together when it's cleared; own shops left out), sent to QuickBooks with any missing customer and coffee items
// made there, and emailed by QuickBooks. Uses the loopback QuickBooks stand-in; no real QuickBooks or email.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
let srv,provider,ADMIN,STAFF;
const root='/api/admin/wholesale';
const qb='/api/admin/wholesale/quickbooks';
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN){
 const url=srv.base+path+(path.startsWith(qb)?(path.includes('?')?'&':'?')+'environment=sandbox':'');
 const res=await fetch(url,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}),text=await res.text();let data;try{data=JSON.parse(text);}catch{}
 return{status:res.status,body:data,text,cookie:cookieOf(res)};
}
async function ok(method,path,body,cookie=ADMIN){const r=await call(method,path,body,cookie);assert.ok(r.status>=200&&r.status<300,method+' '+path+': '+r.status+' '+r.text);return r;}
const cron=async()=>{const r=await fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'));assert.equal(r.status,200);await new Promise(r=>setTimeout(r,60));};
// Work starts straight away; the five-minute job is run now and then too, as it would be, for when the machine is slow.
async function until(check,what){for(let i=0;i<200;i++){const v=await check();if(v)return v;if(i%8===7)await cron();await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+what);}
const auto=async()=>(await ok('GET',root+'/auto-invoicing')).body;
async function waitForAuto(source,check,what){
 return until(async()=>{
  const item=(await auto()).items.find(row=>row.source===source);
  return item&&check(item)&&item;
 },what);
}
async function switches(issue,quickbooks,email){const now=await auto();return(await ok('PUT',root+'/auto-invoicing',{ifVersion:now.version,issue,quickbooks,email})).body;}
async function business(name,extra={}){
 const customer=(await ok('POST',root+'/customers',{business:name,contact:'Sam',email:name.toLowerCase().replace(/\W+/g,'')+'@example.test',address:'1 Test Road\nNorwich',postcode:'NR1 1AA',status:'Active',paymentTerms:'net-30',...extra})).body.customer;
 const username=name.toLowerCase().replace(/\W+/g,'').slice(0,20)+Math.floor(Math.random()*1e6);
 const account=(await ok('POST',`${root}/customers/${customer.id}/account`,{username})).body;
 const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username,password:account.temporaryPassword,newPassword:'buyer-password-123'},null)).cookie;
 return{customer,cookie};
}
async function order(buyer,{productId='brazil',pack='kilo',quantity=6,delivery='Roastery collection'}={}){
 const profile=(await ok('GET','/api/wholesale/session',undefined,buyer)).body.customer;
 return(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:profile.version,delivery,lines:[{productId,pack,grind:'beans',quantity,price:pack==='quarter'?500:1800}]},buyer)).body.order;
}
async function status(o,next){const r=await ok('PATCH',`${root}/orders/${o.id}`,{ifVersion:o.version,status:next,customerId:o.customerId,note:''});return r.body.order||r.body;}
const latest=async id=>(await ok('GET',`${root}/orders?status=all&q=${id}`)).body.orders.find(o=>o.id===id);
const invoiceOf=id=>srv.sql(`SELECT * FROM wholesale_invoices WHERE order_id='${id}'`)[0];
const autoRow=source=>srv.sql(`SELECT * FROM wholesale_auto_invoices WHERE source='${source}'`)[0];
const exportFor=source=>srv.sql(`SELECT e.* FROM quickbooks_exports e JOIN wholesale_auto_invoices a ON a.invoice_id=e.invoice_id WHERE a.source='${source}' ORDER BY e.id`)[0];
const attemptedEmails=()=>provider.state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/send'));

before(async()=>{
 provider=await startQuickBooksProvider();
 srv=await startServer({scheduled:true,writeLimit:5000,vars:({base})=>({...quickBooksVars(provider.origin),QUICKBOOKS_REDIRECT_URI:base+qb+'/callback'})});
 ADMIN=(await ok('POST','/api/auth/setup',{name:'Integration Owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 await ok('POST','/api/admin/users',{name:'Pat',username:'pat',role:'staff',password:'temporary-password'});
 STAFF=(await ok('POST','/api/auth/change',{username:'pat',password:'temporary-password',newPassword:'pat-password-1'},null)).cookie;
 const old=(await ok('GET',root+'/invoice-settings')).body;
 await ok('PUT',root+'/invoice-settings',{ifVersion:old.version,seller:{legalName:'Example Merchant Ltd',address:'Test merchant address',vatNumber:'GB123456789',companyNumber:'',email:'accounts@merchant.example',phone:''},priceBasis:'inclusive',vatRates:[{id:'standard',label:'Standard',basisPoints:2000},{id:'zero',label:'Zero rated',basisPoints:0}],defaultCoffeeRateId:'zero',deliveryRateId:'standard',invoicePrefix:'AU-',firstInvoiceNumber:1,paymentInstructions:'Test bank instructions',confirmed:true});
});
after(async()=>{await srv?.stop();await provider?.stop();});

test('Only admins see and change automatic invoicing; the switches build on each other',async()=>{
 for(const cookie of [null,STAFF])assert.ok([401,403].includes((await call('GET',root+'/auto-invoicing',undefined,cookie)).status));
 const off=await auto();assert.deepEqual([off.settings.issue,off.settings.quickbooks,off.settings.email],[false,false,false]);
 assert.equal((await call('PUT',root+'/auto-invoicing',{ifVersion:off.version,issue:false,quickbooks:true,email:false})).status,400);
 assert.equal((await call('PUT',root+'/auto-invoicing',{ifVersion:off.version,issue:true,quickbooks:false,email:true})).status,400);
 assert.equal((await call('PUT',root+'/auto-invoicing',{ifVersion:off.version+5,issue:true,quickbooks:false,email:false})).status,409);
});

test('Dispatched orders are invoiced automatically from when it is switched on; own shops and tabs are left to their own rules',async()=>{
 const {customer,cookie}=await business('Early Cafe');
 const before=await order(cookie);await status(before,'Dispatched');
 const on=await switches(true,false,false);assert.ok(on.settings.since);
 await cron();assert.equal(invoiceOf(before.id),undefined,'dispatched before switching on: not invoiced');
 const o=await order(cookie,{delivery:'Delivery',quantity:2,pack:'quarter'});
 assert.equal(invoiceOf(o.id),undefined);await status(await status(o,'Preparing'),'Dispatched');
 const invoice=await until(()=>invoiceOf(o.id),'automatic invoice');
 assert.equal(invoice.issued_by,'Automatic invoicing');
 const data=JSON.parse(invoice.data);assert.equal(data.customerId,customer.id);assert.equal(data.lines[0].productId,'brazil');assert.equal(data.lines[0].pack,'quarter');
 assert.equal(data.lines.at(-1).kind,'delivery','its own delivery charge');assert.equal(data.lines.at(-1).grossPence,744);
 assert.equal(data.dueDate,new Date(Date.parse(data.invoiceDate+'T00:00:00Z')+30*86400000).toISOString().slice(0,10));
 await waitForAuto('order:'+o.id,row=>row.state==='done','done');
 // Own shops ("Hide prices") aren't invoiced.
 const shop=await business('Our Own Shop',{hidePrices:true});
 const shopOrder=await order(shop.cookie);await status(shopOrder,'Dispatched');await cron();
 assert.equal(invoiceOf(shopOrder.id),undefined);assert.equal(autoRow('order:'+shopOrder.id),undefined);
 // A tab: nothing per order; one invoice for the orders when it's cleared.
 const tabbed=await business('Tab Cafe');
 const ids=[];
 for(const q of [3,4]){const t=await order(tabbed.cookie,{quantity:q});const r=await ok('PUT',`${root}/orders/${t.id}/tab`,{ifVersion:t.version,onTab:true});ids.push(t.id);await status(r.body.order||await latest(t.id),'Dispatched');}
 await cron();for(const id of ids)assert.equal(invoiceOf(id),undefined,'not invoiced on its own');
 const tabs=(await ok('GET',root+'/tabs')).body;const open=tabs.open.find(t=>t.customerId===tabbed.customer.id);
 const cleared=(await ok('POST',`${root}/tabs/${tabbed.customer.id}/clear`,{orderIds:ids,seen:open.orders.map(x=>x.id)})).body.cleared;
 const tabInvoice=await until(()=>invoiceOf('TAB-'+cleared.id),'tab invoice');
 const tabData=JSON.parse(tabInvoice.data);assert.deepEqual([...tabData.orderIds].sort(),[...ids].sort());
 assert.equal(tabData.lines.length,1,'the same coffee merged');assert.equal(tabData.lines[0].quantity,7);
 // The customer opens the tab's invoice from either order, and the orders show it.
 const own=(await ok('GET',`/api/wholesale/orders/${ids[0]}/invoice`,undefined,tabbed.cookie)).body.invoice;assert.equal(own.number,tabInvoice.invoice_number);
 assert.equal((await ok('GET',`${root}/orders/${ids[0]}/invoice`)).body.invoice.number,tabInvoice.invoice_number);
 const mine=(await ok('GET','/api/wholesale/orders',undefined,tabbed.cookie)).body.orders.filter(x=>ids.includes(x.id));assert.ok(mine.every(x=>x.invoice?.number===tabInvoice.invoice_number),JSON.stringify(mine.map(x=>x.invoice)));
 // Admin can't invoice one of them again by hand.
 const one=await latest(ids[0]),config=(await ok('GET',root+'/invoice-settings')).body;
 assert.equal((await call('POST',`${root}/orders/${ids[0]}/invoice`,{orderVersion:one.version,settingsVersion:config.version,invoiceDate:'2026-11-23',supplyDate:'2026-11-23'})).status,400);
});

test('Cleared tabs with different agreed terms wait for individual invoices',async()=>{
 await switches(true,false,false);
 const {customer,cookie}=await business('Mixed Terms Cafe');
 const first=await order(cookie);
 await ok('PUT',`${root}/orders/${first.id}/tab`,{ifVersion:first.version,onTab:true});
 await ok('PUT',`${root}/customers/${customer.id}`,{...customer,ifVersion:customer.version,paymentTerms:'net-7'});
 const second=await order(cookie);
 await ok('PUT',`${root}/orders/${second.id}/tab`,{ifVersion:second.version,onTab:true});
 const ids=[first.id,second.id];
 const tabs=(await ok('GET',root+'/tabs')).body;
 const open=tabs.open.find(tab=>tab.customerId===customer.id);
 const cleared=(await ok('POST',`${root}/tabs/${customer.id}/clear`,{orderIds:ids,seen:open.orders.map(row=>row.id)})).body.cleared;
 const source='tab:'+cleared.id;
 const held=await waitForAuto(source,item=>item.state==='held','mixed payment terms hold');
 assert.match(held.reason,/different payment terms/);
 assert.equal(invoiceOf('TAB-'+cleared.id),undefined);
 await ok('POST',`${root}/auto-invoicing/${source}/skip`,{});
 const config=(await ok('GET',root+'/invoice-settings')).body;
 const invoiceDate='2026-01-07';
 for(const [id,term,dueDate] of [[first.id,'net-30','2026-02-06'],[second.id,'net-7','2026-01-14']]){
  const saved=await latest(id);
  const result=await ok('POST',`${root}/orders/${id}/invoice`,{orderVersion:saved.version,settingsVersion:config.version,invoiceDate,supplyDate:invoiceDate});
  assert.equal(result.body.invoice.paymentTerms.id,term);
  assert.equal(result.body.invoice.dueDate,dueDate);
 }
 assert.equal(invoiceOf('TAB-'+cleared.id),undefined);
});

test('With QuickBooks: missing customers and coffee items are made (or existing ones used), the invoice is exported and QuickBooks emails it',async()=>{
 // Connect the Sandbox company and choose the general coffee item, VAT codes and terms (as an admin does once).
 const started=(await ok('POST',qb+'/connect',{})).body,nonce=new URL(started.authorizeUrl).searchParams.get('state');
 assert.ok((await call('GET',qb+'/callback?code=test-code&realmId=1234567890&state='+nonce)).status<400);let s=(await ok('GET',qb+'/status')).body;
 await ok('POST',qb+'/confirm',{ifVersion:s.connection.version,vatNumber:'GB123456789',confirmed:true});s=(await ok('GET',qb+'/status')).body;
 const mappings=(await ok('GET',qb+'/mappings')).body;
 await ok('PUT',qb+'/mappings',{ifVersion:mappings.version,connectionVersion:s.connection.version,coffeeItemId:'50',deliveryItemId:'51',taxMappings:[{rateId:'standard',basisPoints:2000,taxCodeId:'3'},{rateId:'zero',basisPoints:0,taxCodeId:'4'}],term:{localId:'net-30',quickbooksId:'30'},reviewed:true});
 await switches(true,true,true);
 const fresh=await business('Brand New Roasters',{accountsEmail:'accounts@brandnew.example'});
 const o=await order(fresh.cookie,{quantity:6});await status(o,'Dispatched');
 await waitForAuto('order:'+o.id,row=>['done','held'].includes(row.state),'processed');
 let row=autoRow('order:'+o.id);assert.equal(row.state,'done',row.reason);
 const made=provider.state.created.filter(c=>c.environment==='sandbox');
 const cust=made.find(c=>c.kind==='customer'&&c.row.DisplayName==='Brand New Roasters');assert.ok(cust,'customer made');assert.equal(cust.row.PrimaryEmailAddr.Address,'accounts@brandnew.example');
 const item=made.find(c=>c.kind==='item');assert.ok(item,'coffee item made');assert.match(item.row.Sku,/^SC1\d{3}-1KG$/);assert.equal(item.row.IncomeAccountRef.value,'1');assert.match(item.row.Name,/1kg$/);
 const exported=srv.sql(`SELECT * FROM quickbooks_exports WHERE invoice_id=${row.invoice_id}`)[0];assert.equal(exported.state,'linked');assert.equal(exported.auto,1);
 const payload=JSON.parse(exported.payload);assert.equal(payload.CustomerRef.value,cust.row.Id);assert.equal(payload.Line[0].SalesItemLineDetail.ItemRef.value,item.row.Id,'the coffee\'s own item');
 // Sandbox: QuickBooks emails the supplier's own address, never the customer.
 const sent=provider.state.sent.at(-1);assert.equal(sent.to,'accounts@merchant.example');assert.equal(sent.id,exported.remote_id);assert.equal(sent.contentType,'application/octet-stream');
 assert.match(payload.CustomerMemo.value,/Test bank instructions/);
 assert.equal(srv.sql(`SELECT email_state FROM quickbooks_exports WHERE id=${exported.id}`)[0].email_state,'sent');
 // The next order reuses the customer and item; nothing new is made, nothing emailed twice.
 const createdBefore=provider.state.created.length,sentBefore=provider.state.sent.length;
 const again=await order(fresh.cookie,{quantity:7});await status(again,'Dispatched');
 await waitForAuto('order:'+again.id,row=>row.state==='done','second done');
 assert.equal(provider.state.created.length,createdBefore);assert.equal(provider.state.sent.length,sentBefore+1);
 await cron();assert.equal(provider.state.sent.length,sentBefore+1,'not emailed again');
 // A business already in QuickBooks under its QuickBooks name is linked, not duplicated.
 const known=await business('Known Cafe Ltd',{});
 srv.sql(`UPDATE wholesale_preview SET data=json_set(data,'$.quickbooksName','Example customer 5') WHERE kind='customer' AND id='${known.customer.id}'`);
 const k=await order(known.cookie);await status(k,'Dispatched');await waitForAuto('order:'+k.id,row=>row.state==='done','known done');
 assert.equal(provider.state.created.length,createdBefore);
 assert.equal(JSON.parse(srv.sql(`SELECT payload FROM quickbooks_exports WHERE invoice_id=${autoRow('order:'+k.id).invoice_id}`)[0].payload).CustomerRef.value,'5');
 // Product numbers are kept per coffee.
 const number=srv.sql("SELECT number FROM wholesale_product_numbers WHERE product_id='brazil'")[0].number;assert.ok(number>1000);
 // A coffee numbered before (in Sandbox) going to a company with no item linked for it yet (Live, 24 Nov 2026): it keeps
 // its number and the invoice goes through, instead of failing on the number already in use.
 srv.sql("DELETE FROM quickbooks_product_items WHERE product_key='brazil:kilo'");
 srv.sql("INSERT INTO wholesale_product_numbers(product_id,number,created_at) VALUES('other-coffee',"+(number+1)+",0)");
 const later=await order(fresh.cookie,{quantity:8});await status(later,'Dispatched');
 await waitForAuto('order:'+later.id,row=>['done','held'].includes(row.state),'numbered coffee processed');
 row=autoRow('order:'+later.id);assert.equal(row.state,'done',row.reason);
 assert.equal(srv.sql("SELECT number FROM wholesale_product_numbers WHERE product_id='brazil'")[0].number,number);
 assert.equal(srv.sql("SELECT COUNT(*) AS n FROM quickbooks_product_items WHERE product_key='brazil:kilo'")[0].n,1,'linked again');
});

test('Anything QuickBooks can\'t take yet is held with the reason, can be tried again or left to do by hand',async()=>{
 const before=provider.state.calls.filter(c=>c.method==='POST').length;
 const agree=await business('Terms Later Cafe',{paymentTerms:'to-agree'});
 const o=await order(agree.cookie);await status(o,'Dispatched');
 await waitForAuto('order:'+o.id,row=>['held','done'].includes(row.state),'held');
 const row=autoRow('order:'+o.id);assert.equal(row.state,'held');assert.ok(row.invoice_id,'the invoice is still issued');assert.match(row.reason,/due date/i);
 assert.equal(provider.state.calls.filter(c=>c.method==='POST').length,before,'blocked invoices do not create customers or items');
 const listed=(await auto()).items.find(x=>x.source==='order:'+o.id);assert.equal(listed.state,'held');assert.equal(listed.invoiceNumber,invoiceOf(o.id).invoice_number);
 assert.ok([401,403].includes((await call('POST',`${root}/auto-invoicing/order:${o.id}/skip`,{},STAFF)).status));
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/retry`,{});await waitForAuto('order:'+o.id,row=>row.state==='held'&&row.retryAt,'held again');
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/skip`,{});assert.equal(autoRow('order:'+o.id).state,'skipped');
 await cron();assert.equal(autoRow('order:'+o.id).state,'skipped');
 // Switching sending off stops further QuickBooks work; invoices are still issued.
 await switches(true,false,false);
 const later=await order(agree.cookie);await status(later,'Dispatched');
 await waitForAuto('order:'+later.id,row=>row.state==='done','issued only');
 assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM quickbooks_exports WHERE invoice_id=${autoRow('order:'+later.id).invoice_id}`)[0].n,0);
});

test('A queued automatic export stops when left to do by hand, and a reviewed retry does not email it',async()=>{
 await switches(true,true,true);
 const cafe=await business('Manual Retry Cafe'),o=await order(cafe.cookie),source='order:'+o.id;
 provider.state.rateLimitNext=true;await status(o,'Dispatched');
 await waitForAuto(source,row=>row.quickbooks?.state==='uncertain','retryable export saved');
 const saved=exportFor(source),posts=provider.state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/invoice')).length,emails=attemptedEmails().length;
 assert.equal(saved.state,'uncertain');
 await ok('POST',`${root}/auto-invoicing/${source}/skip`,{});
 srv.sql(`UPDATE quickbooks_exports SET retry_at=0 WHERE id=${saved.id}`);
 await ok('POST',qb+'/exports/'+saved.id+'/process',{});
 await waitForAuto(source,row=>row.quickbooks?.state==='paused','automatic export paused');
 assert.equal(provider.state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/invoice')).length,posts);
 const current=exportFor(source),settings=(await ok('GET',qb+'/status')).body;
 await ok('POST',qb+'/exports/'+saved.id+'/retry',{ifVersion:current.version,modeVersion:settings.modeVersion,reviewed:true});
 await ok('POST',qb+'/exports/'+saved.id+'/process',{});
 await waitForAuto(source,row=>row.quickbooks?.state==='linked','manually linked');
 const linked=exportFor(source);
 assert.equal(linked.request_id,saved.request_id);assert.equal(linked.payload,saved.payload);
 assert.equal(attemptedEmails().length,emails);
});

test('Sandbox resolves the current test mailbox immediately before emailing',async()=>{
 await switches(true,true,true);
 const cafe=await business('Current Mailbox Cafe'),o=await order(cafe.cookie),source='order:'+o.id;
 const before=(await ok('GET',root+'/invoice-settings')).body;
 let release;
 provider.state.readGate={path:'/invoice/',wait:new Promise(resolve=>{release=resolve;}),once:true};
 try{
  await status(o,'Dispatched');
  await until(()=>!provider.state.readGate,'invoice read before emailing');
  await ok('PUT',root+'/invoice-settings',{...before.settings,ifVersion:before.version,seller:{...before.settings.seller,email:'new-test@merchant.example'}});
  release();
  await waitForAuto(source,row=>row.state==='done','email confirmed');
  assert.equal(provider.state.sent.at(-1).to,'new-test@merchant.example');
  assert.equal(exportFor(source).email_to,'new-test@merchant.example');
 }finally{
  release();provider.state.readGate=null;
  const current=(await ok('GET',root+'/invoice-settings')).body;
  await ok('PUT',root+'/invoice-settings',{...before.settings,ifVersion:current.version});
 }
});

test('Ambiguous sends keep the original company and never repeat an email POST',async()=>{
 await switches(true,true,true);
 const cafe=await business('Review Email Cafe');
 for(const accepted of [true,false]){
  const o=await order(cafe.cookie),source='order:'+o.id,before=attemptedEmails().length;
  provider.state.dropSendResponse=accepted;provider.state.failSend=!accepted;
  try{
   await status(o,'Dispatched');
   await waitForAuto(source,row=>row.state==='held','unconfirmed email held');
   const persisted=exportFor(source);
   assert.equal(persisted.email_state,'unknown');
   assert.equal(attemptedEmails().length,before+1);
   if(accepted){
    // Neither an active-environment change nor a retry can generate a replacement export for this job.
    srv.sql("UPDATE quickbooks_settings SET active_environment='production',version=version+1 WHERE id=1");
    await ok('POST',`${root}/auto-invoicing/${source}/retry`,{});
    await waitForAuto(source,row=>/another company or environment/.test(row.reason)&&row.retryAt,'original scope held');
    assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM quickbooks_exports WHERE invoice_id=${persisted.invoice_id}`)[0].n,1);
    srv.sql("UPDATE quickbooks_settings SET active_environment='sandbox',version=version+1 WHERE id=1");
   }
   provider.state.dropSendResponse=false;provider.state.failSend=false;
   await ok('POST',`${root}/auto-invoicing/${source}/retry`,{});
   await waitForAuto(source,row=>(row.retryAt&&row.state==='held')||row.state==='done','checked the previous attempt');
   assert.equal(exportFor(source).email_state,accepted?'sent':'unknown');
   assert.equal(attemptedEmails().length,before+1,'no duplicate delivery');
   if(!accepted)await ok('POST',`${root}/auto-invoicing/${source}/skip`,{});
  }finally{
   provider.state.dropSendResponse=false;provider.state.failSend=false;
   srv.sql("UPDATE quickbooks_settings SET active_environment='sandbox' WHERE id=1 AND active_environment<>'sandbox'");
  }
 }
});

test('Long coffee names preserve bag sizes and a duplicate-name fallback has its own request ID',async()=>{
 await switches(true,true,false);
 const cafe=await business('Long Coffee Cafe'),title='Long seasonal lot name '.repeat(6).trim();
 const baseName=title.slice(0,100-' 1kg'.length).trimEnd()+' 1kg';
 provider.state.takenItemNames=[baseName];
 try{
  for(const pack of ['kilo','quarter']){
   const o=await order(cafe.cookie,{pack,quantity:8}),source='order:'+o.id;
   srv.sql(`UPDATE wholesale_preview SET data=json_set(data,'$.lines[0].title','${title}','$.lines[0].productId','audit-long-lot') WHERE id='${o.id}'`);
   await status(o,'Dispatched');
   const row=await waitForAuto(source,row=>['done','held'].includes(row.state),'long-name item prepared');
   assert.equal(row.state,'done',row.reason);
  }
  const items=srv.sql("SELECT item_id,name,sku FROM quickbooks_product_items WHERE product_key LIKE 'audit-long-lot:%' ORDER BY product_key");
  assert.equal(items.length,2);assert.notEqual(items[0].item_id,items[1].item_id);
  assert.match(items[0].name,/1kg \(SC\d+-1KG\)$/);assert.match(items[1].name,/250g$/);
  const writes=provider.state.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/item')&&c.body.includes('Long seasonal lot'));
  assert.equal(writes.length,3);assert.notEqual(writes[0].query,writes[1].query);
 }finally{provider.state.takenItemNames=[];}
});

test('An order placed before the business had an address is invoiced with the address it has now',async()=>{
 await switches(true,false,false);
 const {customer,cookie}=await business('Address Later Cafe',{address:'',postcode:''});
 const o=await order(cookie);await status(o,'Dispatched');
 await waitForAuto('order:'+o.id,row=>row.state==='held','held for an address');
 assert.match(autoRow('order:'+o.id).reason,/Add an address for this business/);
 assert.equal(invoiceOf(o.id),undefined,'no invoice number used');
 const saved=(await ok('GET',`${root}/customers?q=Address%20Later`)).body.customers.find(c=>c.id===customer.id);
 await ok('PUT',`${root}/customers/${customer.id}`,{ifVersion:saved.version,business:saved.business,contact:saved.contact,email:saved.email,status:'Active',paymentTerms:'net-30',address:'9 Late Lane\nNorwich',postcode:'NR3 3AA'});
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/retry`,{});
 const invoice=await until(()=>invoiceOf(o.id),'invoice with the new address');
 const data=JSON.parse(invoice.data);assert.equal(data.billTo.address,'9 Late Lane\nNorwich');assert.equal(data.billTo.postcode,'NR3 3AA');
 // The order itself keeps what it was placed with.
 assert.equal((await latest(o.id)).customerSnapshot?.address||'','');
});

test('A number already taken by an invoice typed into QuickBooks says whose it is, shows on the Overview, and Try again sends ours once renumbered',async()=>{
 await switches(true,true,true);
 // QuickBooks suggests the number after ours for invoices typed in by hand, so one may already hold the next number (25 Nov 2026).
 const lastNumber=srv.sql("SELECT invoice_number FROM wholesale_invoices ORDER BY seq DESC LIMIT 1")[0].invoice_number,digits=/(\d+)$/.exec(lastNumber)[1];
 const next=lastNumber.slice(0,-digits.length)+String(Number(digits)+1).padStart(digits.length,'0');
 const template=[...provider.state.invoices.sandbox.values()].at(-1),typed={...structuredClone(template),Id:'7100',DocNumber:next,CustomerRef:{value:'99',name:'Strangers Roastery'},TotalAmt:3914.06,TxnDate:'2026-11-24',SyncToken:'0'};
 provider.state.invoices.sandbox.set(typed.Id,typed);
 const {cookie}=await business('Clash Cafe');const o=await order(cookie);await status(o,'Dispatched');
 await waitForAuto('order:'+o.id,row=>row.state==='held','held on the taken number');
 const held=autoRow('order:'+o.id);assert.match(held.reason,new RegExp(`Number taken: QuickBooks already has an invoice ${next} \\(Strangers Roastery, £3914\\.06, 24 Nov\\)`));
 assert.equal(exportFor('order:'+o.id).state,'review');const sentBefore=attemptedEmails().length;
 const overview=(await ok('GET','/api/admin/overview')).body;
 const notice=overview.attention.find(a=>/Clash Cafe's invoice needs attention/.test(a.title));assert.ok(notice,JSON.stringify(overview.attention.map(a=>a.title)));assert.match(notice.detail,/Strangers Roastery/);assert.equal(notice.action.href,'#wholesale/invoices');
 // Renumbered in QuickBooks: Try again under Automatic invoicing sends ours and emails it as usual.
 typed.DocNumber='10239';typed.SyncToken='1';
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/retry`,{});
 await waitForAuto('order:'+o.id,row=>row.state==='done','sent after renumbering');
 const exported=exportFor('order:'+o.id);assert.equal(exported.state,'linked');assert.notEqual(exported.remote_id,'7100');assert.equal(exported.created_remote,1);
 assert.equal(attemptedEmails().length,sentBefore+1,'emailed automatically, nothing having gone before');
 assert.equal(provider.state.invoices.sandbox.get('7100').DocNumber,'10239','the typed-in invoice is left alone');
 assert.ok(!(await ok('GET','/api/admin/overview')).body.attention.some(a=>/Clash Cafe/.test(a.title)),'notice gone once sent');
});

test('Using QuickBooks invoice numbers: the next after the highest there, waiting (not guessing) when QuickBooks can\'t be reached',async()=>{
 // The owner's request, 25 Nov 2026: one number series with QuickBooks, so invoices typed in there get the right suggestion.
 await switches(true,true,true);
 let config=(await ok('GET',root+'/invoice-settings')).body;
 config=(await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:true})).body;
 assert.equal(config.settings.sharedNumbering,true);assert.equal(config.ready,true);
 // QuickBooks's own series: invoices typed in by hand up to 10238, and a sales receipt (same number list) 10239.
 const template=[...provider.state.invoices.sandbox.values()].at(-1);
 provider.state.invoices.sandbox.set('7200',{...structuredClone(template),Id:'7200',DocNumber:'10238',CustomerRef:{value:'98',name:'Strangers Roastery'}});
 provider.state.otherForms={sandbox:{SalesReceipt:[{Id:'800',DocNumber:'10239'}],CreditMemo:[{Id:'801',DocNumber:'CN-7'}]}};
 const {cookie}=await business('Shared Number Cafe');
 const first=await order(cookie);await status(first,'Dispatched');
 await waitForAuto('order:'+first.id,row=>['done','held'].includes(row.state),'numbered from QuickBooks');
 assert.equal(autoRow('order:'+first.id).state,'done',autoRow('order:'+first.id).reason);
 assert.equal(invoiceOf(first.id).invoice_number,'10240','the next after the highest plain number on any sales form');
 assert.equal(JSON.parse(exportFor('order:'+first.id).payload).DocNumber,'10240');
 // QuickBooks down: no number is guessed; the invoice waits and goes once it's back.
 provider.state.unreachable=true;
 const second=await order(cookie);await status(second,'Dispatched');
 await waitForAuto('order:'+second.id,row=>row.state==='held','waiting for QuickBooks');
 assert.match(autoRow('order:'+second.id).reason,/QuickBooks couldn't be reached to choose the next invoice number\. It will be tried again\./);
 assert.equal(invoiceOf(second.id),undefined,'no number used');
 provider.state.unreachable=false;
 await ok('POST',`${root}/auto-invoicing/order:${second.id}/retry`,{});
 await waitForAuto('order:'+second.id,row=>row.state==='done','sent once QuickBooks is back');
 assert.equal(invoiceOf(second.id).invoice_number,'10241','follows its own last number, the highest now');
 // Switching it on needs QuickBooks reachable; switching off goes back to the website's own series.
 config=(await ok('GET',root+'/invoice-settings')).body;
 config=(await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:false})).body;
 assert.equal(config.settings.sharedNumbering,false);
 provider.state.unreachable=true;
 const refused=await call('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:true});
 assert.equal(refused.status,503,refused.text);provider.state.unreachable=false;
 const third=await order(cookie);await status(third,'Dispatched');
 await waitForAuto('order:'+third.id,row=>['done','held'].includes(row.state),'own series again');
 assert.match(invoiceOf(third.id).invoice_number,/^[A-Za-z]/,'prefix and counter');
 // A supplier settings save keeps the switch.
 config=(await ok('GET',root+'/invoice-settings')).body;
 config=(await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:true})).body;
 assert.equal(config.nextNumber,'10242','says which number comes next');
 // Numbers already used under the prefix count by their digits: after AU-010300 comes 10301, never a lookalike.
 srv.sql(`UPDATE wholesale_invoices SET invoice_number='AU-010300' WHERE order_id='${third.id}'`);
 config=(await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:false})).body;
 config=(await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:config.version,shared:true})).body;
 assert.equal(config.nextNumber,'10301','follows the digits of the website\'s own prefixed numbers');
 const {settings:s}=config;
 const saved=(await ok('PUT',root+'/invoice-settings',{...s,ifVersion:config.version})).body;
 assert.equal(saved.settings.sharedNumbering,true);
 await switches(false,false,false);
 const batched=await order(cookie);
 await status(batched,'Dispatched');
 const period=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date()).slice(0,7);
 const review=(await ok('POST',root+'/invoicing/batches/preview',{period,selected:[batched.id],delivery:'export'})).body;
 const batchUrl=root+'/invoicing/batches/'+review.id;
 await ok('POST',batchUrl+'/approve',{reviewed:true});
 const run=batchUrl+'/items/'+review.items[0].id+'/run';
 srv.sql("UPDATE quickbooks_settings SET active_environment='production' WHERE id=1");
 try {
   const pending=(await ok('POST',run,{})).body.items[0];
   assert.equal(pending.state,'waiting');
   assert.match(pending.reason,/approved QuickBooks company/);
   assert.equal(invoiceOf(batched.id),undefined);
 } finally {
   srv.sql("UPDATE quickbooks_settings SET active_environment='sandbox' WHERE id=1");
 }
 provider.state.unreachable=true;
 try {
   const pending=(await ok('POST',run,{})).body.items[0];
   assert.equal(pending.state,'waiting');
   assert.match(pending.reason,/QuickBooks couldn't be reached/);
   assert.equal(invoiceOf(batched.id),undefined);
 } finally {
   provider.state.unreachable=false;
 }
 await cron();
 await until(async()=>{
   const item=(await ok('GET',batchUrl)).body.items[0];
   return item.state==='issued'&&item;
 },'batch invoice recovered when QuickBooks returned');
 assert.equal(invoiceOf(batched.id).invoice_number,'10301','approved batch uses the shared sequence');
 await ok('PUT',root+'/invoice-settings/numbering',{ifVersion:saved.version,shared:false});
});

test('A held automatic export rechecks the chosen billing address and retries the same invoice',async()=>{
 await switches(true,true,false);
 const remote=provider.state.customers.find(c=>c.Id==='37');
 remote.BillAddr={Line1:'12 Westgate Lane',City:'Norwich',PostalCode:'NR2 2AB'};
 const {cookie}=await business(remote.DisplayName,{address:'12 Westgate Lane\nNorwich',postcode:'NR2 1AB'});
 const placed=await order(cookie),source='order:'+placed.id;
 await status(placed,'Dispatched');
 const held=await waitForAuto(source,item=>item.quickbooks?.billingReview,'QuickBooks billing address review');
 const original=exportFor(source),path=qb+'/exports/'+original.id+'/billing-review';
 assert.equal(held.quickbooks.id,original.id);
 assert.equal(original.write_started_at,0);
 assert.equal((await call('GET',path,undefined,STAFF)).status,403);
 assert.ok((await ok('GET',root+'/invoices?queue=review')).body.invoices.some(invoice=>invoice.id===original.invoice_id));
 const review=(await ok('GET',path)).body;
 assert.equal(review.strangers.postcode,'NR2 1AB');
 assert.equal(review.quickbooks.postcode,'NR2 2AB');
 assert.equal(review.retry,true);
 remote.BillAddr.PostalCode='NR2 3AB';
 assert.equal((await call('POST',path,{token:review.token,choice:'quickbooks'})).status,409);
 const latestReview=(await ok('GET',path)).body;
 const sent=(await ok('POST',path,{token:latestReview.token,choice:'quickbooks'})).body;
 assert.equal(sent.retryQueued,true,sent.followUp);
 const linked=await until(async()=>{
  const {export:row}=(await ok('GET',qb+'/exports/'+original.id)).body;
  return row.state==='linked'&&row;
 },'same export linked');
 assert.equal(linked.number,held.invoiceNumber);
 assert.equal(exportFor(source).request_id,original.request_id);
 const posted=provider.state.invoices.sandbox.get(linked.remoteId);
 assert.equal(posted.BillAddr.PostalCode,'NR2 3AB');
 assert.equal(posted.ShipAddr.PostalCode,'NR2 1AB');
 assert.equal([...provider.state.invoices.sandbox.values()].filter(invoice=>invoice.DocNumber===linked.number).length,1);
 assert.equal(JSON.parse(invoiceOf(placed.id).data).billTo.postcode,'NR2 1AB');
 const receipt=(await ok('GET',root+'/invoices/'+original.invoice_id)).body.invoice;
 assert.equal(receipt.billingHistory[0].postcode,'NR2 3AB');
 const next=await order(cookie);
 assert.equal((await ok('GET',root+'/orders/'+next.id+'/invoice')).body.billing.billTo.postcode,'NR2 1AB','Sandbox review is isolated from future live billing');
});
