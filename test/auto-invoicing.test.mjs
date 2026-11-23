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
async function until(check,what){for(let i=0;i<300;i++){const v=await check();if(v)return v;if(i%40===39)await cron();await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+what);}
const auto=async()=>(await ok('GET',root+'/auto-invoicing')).body;
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
 await until(()=>autoRow('order:'+o.id)?.state==='done','done');
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
 const mine=(await ok('GET','/api/wholesale/orders',undefined,tabbed.cookie)).body.orders.filter(x=>ids.includes(x.id));assert.ok(mine.every(x=>x.invoice?.number===tabInvoice.invoice_number),JSON.stringify(mine.map(x=>x.invoice)));
 // Admin can't invoice one of them again by hand.
 const one=await latest(ids[0]),config=(await ok('GET',root+'/invoice-settings')).body;
 assert.equal((await call('POST',`${root}/orders/${ids[0]}/invoice`,{orderVersion:one.version,settingsVersion:config.version,invoiceDate:'2026-11-23',supplyDate:'2026-11-23'})).status,400);
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
 await until(()=>autoRow('order:'+o.id)?.state==='done'||autoRow('order:'+o.id)?.state==='held','processed');
 let row=autoRow('order:'+o.id);assert.equal(row.state,'done',row.reason);
 const made=provider.state.created.filter(c=>c.environment==='sandbox');
 const cust=made.find(c=>c.kind==='customer'&&c.row.DisplayName==='Brand New Roasters');assert.ok(cust,'customer made');assert.equal(cust.row.PrimaryEmailAddr.Address,'accounts@brandnew.example');
 const item=made.find(c=>c.kind==='item');assert.ok(item,'coffee item made');assert.match(item.row.Sku,/^SC1\d{3}-1KG$/);assert.equal(item.row.IncomeAccountRef.value,'1');assert.match(item.row.Name,/1kg$/);
 const exported=srv.sql(`SELECT * FROM quickbooks_exports WHERE invoice_id=${row.invoice_id}`)[0];assert.equal(exported.state,'linked');assert.equal(exported.auto,1);
 const payload=JSON.parse(exported.payload);assert.equal(payload.CustomerRef.value,cust.row.Id);assert.equal(payload.Line[0].SalesItemLineDetail.ItemRef.value,item.row.Id,'the coffee\'s own item');
 // Sandbox: QuickBooks emails the supplier's own address, never the customer.
 const sent=provider.state.sent.at(-1);assert.equal(sent.to,'accounts@merchant.example');assert.equal(sent.id,exported.remote_id);assert.equal(sent.contentType,'application/octet-stream');
 assert.equal(srv.sql(`SELECT email_state FROM quickbooks_exports WHERE id=${exported.id}`)[0].email_state,'sent');
 // The next order reuses the customer and item; nothing new is made, nothing emailed twice.
 const createdBefore=provider.state.created.length,sentBefore=provider.state.sent.length;
 const again=await order(fresh.cookie,{quantity:7});await status(again,'Dispatched');
 await until(()=>autoRow('order:'+again.id)?.state==='done','second done');
 assert.equal(provider.state.created.length,createdBefore);assert.equal(provider.state.sent.length,sentBefore+1);
 await cron();assert.equal(provider.state.sent.length,sentBefore+1,'not emailed again');
 // A business already in QuickBooks under its QuickBooks name is linked, not duplicated.
 const known=await business('Known Cafe Ltd',{});
 srv.sql(`UPDATE wholesale_preview SET data=json_set(data,'$.quickbooksName','Example customer 5') WHERE kind='customer' AND id='${known.customer.id}'`);
 const k=await order(known.cookie);await status(k,'Dispatched');await until(()=>autoRow('order:'+k.id)?.state==='done','known done');
 assert.equal(provider.state.created.length,createdBefore);
 assert.equal(JSON.parse(srv.sql(`SELECT payload FROM quickbooks_exports WHERE invoice_id=${autoRow('order:'+k.id).invoice_id}`)[0].payload).CustomerRef.value,'5');
 // Product numbers are kept per coffee.
 assert.ok(srv.sql("SELECT number FROM wholesale_product_numbers WHERE product_id='brazil'")[0].number>1000);
});

test('Anything QuickBooks can\'t take yet is held with the reason, can be tried again or left to do by hand',async()=>{
 const agree=await business('Terms Later Cafe',{paymentTerms:'to-agree'});
 const o=await order(agree.cookie);await status(o,'Dispatched');
 await until(()=>['held','done'].includes(autoRow('order:'+o.id)?.state),'held');
 const row=autoRow('order:'+o.id);assert.equal(row.state,'held');assert.ok(row.invoice_id,'the invoice is still issued');assert.match(row.reason,/due date/i);
 const listed=(await auto()).items.find(x=>x.source==='order:'+o.id);assert.equal(listed.state,'held');assert.equal(listed.invoiceNumber,invoiceOf(o.id).invoice_number);
 assert.ok([401,403].includes((await call('POST',`${root}/auto-invoicing/order:${o.id}/skip`,{},STAFF)).status));
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/retry`,{});await until(()=>autoRow('order:'+o.id).lease_until===0&&autoRow('order:'+o.id).state==='held','held again');
 await ok('POST',`${root}/auto-invoicing/order:${o.id}/skip`,{});assert.equal(autoRow('order:'+o.id).state,'skipped');
 await cron();assert.equal(autoRow('order:'+o.id).state,'skipped');
 // Switching sending off stops further QuickBooks work; invoices are still issued.
 await switches(true,false,false);
 const later=await order(agree.cookie);await status(later,'Dispatched');
 await until(()=>autoRow('order:'+later.id)?.state==='done','issued only');
 assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM quickbooks_exports WHERE invoice_id=${autoRow('order:'+later.id).invoice_id}`)[0].n,0);
});

test('An order placed before the business had an address is invoiced with the address it has now',async()=>{
 await switches(true,false,false);
 const {customer,cookie}=await business('Address Later Cafe',{address:'',postcode:''});
 const o=await order(cookie);await status(o,'Dispatched');
 await until(()=>autoRow('order:'+o.id)?.state==='held','held for an address');
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
