import { selectWholesaleSection } from "./admin-workspace-helpers.mjs";
import { openWholesaleOrders } from './wholesale-ui-helpers.mjs';
// End-to-end accounting controls. Only the loopback simulator receives financial requests.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,provider,browser,ADMIN,BUYER,customer,settings;
const root='/api/admin/wholesale/quickbooks';
const webhookToken='live-webhook-token-for-browser-tests';
async function api(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,path+': '+JSON.stringify(data));return{data,cookie:(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0]};}
async function issued(){
 const profile=(await api('GET','/api/wholesale/session',undefined,BUYER)).data.customer;
 const order=(await api('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:profile.version,delivery:'Roastery collection',lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:2,price:1800}]},BUYER)).data.order;
 return(await api('POST',`/api/admin/wholesale/orders/${order.id}/invoice`,{orderVersion:order.version,settingsVersion:settings.version,invoiceDate:'2026-11-10',supplyDate:'2026-11-09'})).data.invoice;
}
before(async()=>{
 provider=await startQuickBooksProvider();srv=await startServer({writeLimit:5000,vars:({base})=>({...quickBooksVars(provider.origin),QUICKBOOKS_REDIRECT_URI:base+root+'/callback',QUICKBOOKS_PRODUCTION_WEBHOOK_TOKEN:webhookToken})});
 ADMIN=(await api('POST','/api/auth/setup',{name:'QB UI Owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 customer=(await api('POST','/api/admin/wholesale/customers',{business:'Example QB Cafe',address:'Test address',postcode:'NR1 1AA',status:'Active',paymentTerms:'net-30'})).data.customer;
 const account=(await api('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'ui.buyer'})).data;
 BUYER=(await api('POST','/api/wholesale/auth/change-password',{username:'ui.buyer',password:account.temporaryPassword,newPassword:'buyer-password'},null)).cookie;
 settings=(await api('PUT','/api/admin/wholesale/invoice-settings',{ifVersion:0,seller:{legalName:'Example UK Sandbox Ltd',address:'Test business address',vatNumber:'GB123456789',companyNumber:'',email:'',phone:''},priceBasis:'inclusive',vatRates:[{id:'standard',label:'Standard sales VAT',basisPoints:2000}],defaultCoffeeRateId:'standard',deliveryRateId:'standard',invoicePrefix:'SC-',firstInvoiceNumber:1,paymentInstructions:'Test instructions',confirmed:true})).data;
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();await provider?.stop();});
async function context(cookie,viewport,colorScheme){const context=await browser.newContext({viewport,colorScheme});const [name,value]=cookie.split('=');await context.addCookies([{name,value,url:srv.base}]);return context;}
for(const [device,viewport]of [['phone',{width:393,height:852}],['ipad',{width:820,height:1180}],['desktop',{width:1440,height:1000}]])for(const colorScheme of ['light','dark']){
 test(`QuickBooks ${device} ${colorScheme}: tested Sandbox export, Live readiness, switching and customer balances`,{timeout:180000},async()=>{
  const invoice=await issued(),adminContext=await context(ADMIN,viewport,colorScheme),customerContext=await context(BUYER,viewport,colorScheme);
  const page=await adminContext.newPage(),buyer=await customerContext.newPage(),errors=[];for(const p of [page,buyer])p.on('pageerror',e=>errors.push(e.message));
  const shot=async(suffix,p=page)=>{assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow');if(process.env.WHOLESALE_SCREENSHOT_DIR){await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/quickbooks-${device}-${colorScheme}-${suffix}.png`});}};
  const openMain=async()=>{await page.goto(srv.base+'/admin?test='+crypto.randomUUID()+'#wholesale');await selectWholesaleSection(page, "invoices");await page.locator('[data-act="wh-invoice-quickbooks"]').click();await page.locator('#qbConnectionForm').waitFor();};
  async function connect(scope='Sandbox'){
   await page.locator('#qbConnectionForm h3',{hasText:scope+' connection'}).waitFor();
   if(await page.locator('[data-sheet="qb-disconnect"]').count()){await page.locator('[data-sheet="qb-disconnect"]').click();await page.locator('#qbDisconnectForm button[type="submit"]').click();await page.locator('[data-sheet="qb-connect"]').waitFor();}
   await page.locator('[data-sheet="qb-connect"]').click();await page.locator('#qbConfirmCompany').waitFor();assert.match(await page.locator('#qbConnectionForm').textContent(),new RegExp('Example UK '+scope+' Ltd'));
   await page.locator('#qbVatNumber').fill('GB123456789');await page.locator('#qbConfirmCompany').check();await page.locator('#qbConnectionForm button[type="submit"]').click();await page.locator('[data-sheet="qb-browse"]').first().waitFor();
   assert.equal(new URL(page.url()).search,'','OAuth parameters are removed after being captured');
  }
  async function map(){
   await page.locator('#qbMappingForm').waitFor();
   async function choose(key,id){await page.locator(`[data-sheet="qb-choice"][data-key="${key}"]`).click();await page.locator(`#qbReferenceList [data-id="${id}"]`).click();await page.locator('#qbMappingForm').waitFor();}
   const unlinked=await page.locator('[data-key="customerId"]').textContent();if(!/Example customer|Reference #/.test(unlinked))assert.match(unlinked,/Add or match automatically/,'the customer can be left for automatic invoicing to find or add');
   await choose('customerId','3');await choose('coffeeItemId','50');await choose('deliveryItemId','51');await choose('termId','30');await page.locator('[data-sheet="qb-tax"]').click();await page.locator('#qbReferenceList [data-id="3"]').click();
   assert.match(await page.locator('[data-key="customerId"]').textContent(),/Example customer 3/,'same numeric customer and VAT IDs retain separate names');
   await page.locator('#qbMappingReview').check();await shot('mappings');await page.locator('#qbMappingForm button[type="submit"]').click();await page.locator('#qbInvoicePreview').waitFor();
  }
  async function send(){
   assert.match(await page.locator('#qbInvoicePreview').textContent(),/No invoice has been sent/);assert.match(await page.locator('#qbInvoicePreview').textContent(),/£36.00/);
   const posts=provider.state.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/invoice')).length;
   await page.locator('#qbInvoicePreview button[type="submit"]').click();assert.equal(provider.state.calls.filter(call=>call.method==='POST'&&call.path.endsWith('/invoice')).length,posts,'native review checkbox gates sending');
   await page.locator('#qbExportReview').check();await shot('review');await page.locator('#qbInvoicePreview button[type="submit"]').click();await page.locator('#qbExportState',{hasText:'Linked'}).waitFor();await shot('linked');
  }
  try{
   await openMain();await connect();await shot('connection');
   await page.locator('[data-sheet="qb-readiness"]').click();await page.locator('#qbLiveReview').waitFor();assert.equal((await api('GET',root+'/status')).data.activeEnvironment,'sandbox','opening Live readiness does not activate Live');await shot('readiness');await page.locator('#qbLiveReview [data-sheet="wi-back"]').first().click();
   await page.locator('[data-sheet="qb-browse"][data-kind="customer"]').click();await page.locator('#qbReferenceList .qb-reference-row').first().waitFor();assert.equal(await page.locator('#qbReferenceList .qb-reference-row').count(),100);await page.locator('[data-sheet="qb-next"]').click();await page.waitForFunction(()=>document.querySelectorAll('#qbReferenceList .qb-reference-row').length===1);await page.locator('#qbReferenceList [data-sheet="wi-back"]').first().click();
   await page.locator('#qbConnectionForm [data-sheet="wi-back"]').first().click();await page.locator(`[data-act="wh-invoice-open"][data-id="${invoice.id}"]`).click();await page.locator('[data-sheet="wi-quickbooks"]').click();await map();await send();
   const sandbox=(await api('GET',root+'/exports?environment=sandbox&invoiceId='+invoice.id)).data.exports[0];
   provider.state.pay('sandbox',sandbox.remoteId,18);await page.locator('[data-sheet="qb-balance"]').click();await page.locator('#qbExportDetail strong',{hasText:'Part paid'}).waitFor();
   provider.state.pay('sandbox',sandbox.remoteId,0);await page.locator('[data-sheet="qb-balance"]').click();await page.locator('#qbExportDetail strong',{hasText:/^Paid$/}).waitFor();
   assert.equal((await api('GET','/api/wholesale/invoices/'+invoice.id,undefined,BUYER)).data.invoice.payment.paid,false,'Sandbox testing never alters customer payment status');
   await openMain();await page.locator('[data-sheet="qb-scope"]').click();await connect('Live');await page.locator('[data-sheet="qb-map-invoice"]').click();await page.locator(`[data-sheet="qb-pick-invoice"][data-id="${invoice.id}"]`).click();await map();
   assert.equal(await page.locator('#qbInvoicePreview button[type="submit"]').count(),0,'Live setup remains a review while Sandbox is active');
   await page.locator('[data-sheet="qb-setup"]').click();await page.locator('[data-sheet="qb-readiness"]').click();await page.locator('#qbLiveReview button[type="submit"]').waitFor();
   for(const checkbox of await page.locator('[data-attestation]').all())await checkbox.check();await shot('live-review');await page.locator('#qbLiveReview button[type="submit"]').click();await page.locator('[data-sheet="qb-activate-live"]').click();await page.locator('#qbSwitchReview').check();await page.locator('#qbModeForm button[type="submit"]').click();await page.locator('[data-sheet="qb-mode"][data-mode="production"][aria-pressed="true"]').waitFor();
   await shot('live');await page.locator('#qbConnectionForm [data-sheet="wi-back"]').first().click();
   // Returning from setup can reopen the invoice picker; a fresh page makes this a new invoice action.
   await page.goto(srv.base+'/admin?test='+crypto.randomUUID()+'#wholesale');await selectWholesaleSection(page, "invoices");await page.locator(`[data-act="wh-invoice-open"][data-id="${invoice.id}"]`).click();await page.locator('[data-sheet="wi-quickbooks"]').click();await page.locator('#qbMappingReview').check();await page.locator('#qbMappingForm button[type="submit"]').click();await send();
   const live=(await api('GET',root+'/exports?environment=production&invoiceId='+invoice.id)).data.exports[0];provider.state.pay('production',live.remoteId,20);
   await page.locator('[data-sheet="qb-balance"]').click();await page.locator('#qbExportDetail strong',{hasText:'Part paid'}).waitFor();await page.locator('#qbExportDetail [data-sheet="wi-back"]').first().click();await page.locator('#wiIssuedInvoice').waitFor();assert.equal(await page.locator('[data-sheet="wi-payment"]').count(),0,'QuickBooks owns payment recording after a Live link');assert.match(await page.locator('#wiIssuedInvoice').textContent(),/£20.00/);
   await openMain();await page.locator('[data-sheet="qb-mode"][data-mode="sandbox"]').click();await page.locator('#qbSwitchReview').check();await page.locator('#qbModeForm button[type="submit"]').click();await page.locator('[data-sheet="qb-mode"][data-mode="sandbox"][aria-pressed="true"]').waitFor();
   await page.locator('[data-sheet="qb-history"]').click();await page.locator('#qbExportHistory').waitFor();await shot('history');
   await buyer.goto(srv.base+'/wholesale/');await buyer.locator('#products article').first().waitFor();await openWholesaleOrders(buyer);await buyer.locator('#history-invoices').click();const card=buyer.locator(`[data-customer-invoice="${invoice.id}"]`);await card.waitFor();assert.match(await card.textContent(),/Part paid/);assert.match(await card.textContent(),/Remaining balance\s+£20.00/);assert.match(await card.textContent(),/Payment status checked/);await shot('customer-partial',buyer);
   // Live refresh stays available while Sandbox is active and targets the existing Live link.
   await page.goto(srv.base+'/admin?test='+crypto.randomUUID()+'#wholesale');await selectWholesaleSection(page, "invoices");await page.locator(`[data-act="wh-invoice-open"][data-id="${invoice.id}"]`).click();await page.locator('[data-sheet="wi-quickbooks"]').click();await page.locator('#sheetTitle',{hasText:'QuickBooks Live'}).waitFor();provider.state.pay('production',live.remoteId,0);await page.locator('[data-sheet="qb-balance"]').click();await page.locator('#qbExportDetail strong',{hasText:/^Paid$/}).waitFor();await buyer.locator('#refresh-invoices').click();await card.locator('.invoice-state.paid').waitFor();assert.equal(await card.locator('.invoice-balance').count(),0);assert.ok(!(await card.textContent()).includes('Not set'));
   const paymentId='950'+invoice.id;
   const remote=provider.state.invoices.production.get(live.remoteId);
   if(device==='phone'&&colorScheme==='light'){
    remote.BillAddr.Line2='Updated billing address';
    srv.sql(`UPDATE quickbooks_observations SET status='review',outstanding_pence=NULL,paid_pence=NULL,reason='Previous verification failed' WHERE export_id=${live.id}`);
    await page.goto(srv.base+'/admin?test='+crypto.randomUUID()+'#wholesale');
    await selectWholesaleSection(page,'invoices');
    await page.locator(`[data-act="wh-invoice-open"][data-id="${invoice.id}"]`).click();
    await page.locator('#wiIssuedInvoice .wi-issued-status').getByText('Paid',{exact:true}).waitFor();
    await page.getByRole('region',{name:'QuickBooks balance'}).getByText('The QuickBooks billing address differs from the issued invoice.').waitFor();
    await page.locator('[data-sheet="wi-quickbooks"]').click();
    await page.locator('#qbExportDetail strong',{hasText:/^Paid$/}).waitFor();
   }
   remote.LinkedTxn=[{TxnType:'Payment',TxnId:paymentId}];
   await api('POST',root+'/exports/'+live.id+'/refresh?environment=production',{});
   provider.state.pay('production',live.remoteId,36);
   remote.LinkedTxn=[];
   provider.state.payments.production.set(paymentId,{Id:paymentId,TotalAmt:0,PrivateNote:'Voided',Line:[]});
   const notification=JSON.stringify([{specversion:'1.0',id:'void-'+paymentId,type:'qbo.payment.voided.v1',intuitaccountid:'1234567890',intuitentityid:paymentId}]);
   const signature=createHmac('sha256',webhookToken).update(notification).digest('base64');
   const received=await fetch(srv.base+'/api/quickbooks/webhook/production',{method:'POST',headers:{'content-type':'application/json','intuit-signature':signature},body:notification});
   assert.equal(received.status,200);
   await page.waitForFunction(async({url,id})=>{
    const response=await fetch(url);
    const result=await response.json();
    return result.export?.invoiceId===id&&result.export.observation?.payment_voided===1;
   },{url:root+'/exports/'+live.id+'?environment=production',id:invoice.id});
   await page.locator('[data-sheet="qb-balance"]').click();
   await page.locator('#qbExportDetail').getByText('Payment voided in QuickBooks.',{exact:true}).waitFor();
   await buyer.locator('#refresh-invoices').click();
   await card.getByText('Payment voided',{exact:true}).waitFor();
   assert.match(await card.locator('.invoice-balance').textContent(),/£36\.00/);

   provider.state.pay('production',live.remoteId,0);
   remote.TotalAmt=0;
   remote.PrivateNote='Voided\n'+remote.PrivateNote;
   remote.Line=[];
   await page.locator('[data-sheet="qb-balance"]').click();
   await page.locator('#qbExportDetail strong',{hasText:/^Voided$/}).waitFor();
   await page.locator('#qbExportDetail [data-sheet="wi-back"]').first().click();
   await page.locator('#wiIssuedInvoice .wi-issued-status').getByText('Voided',{exact:true}).waitFor();
   assert.match(await page.locator('#wiIssuedInvoice').textContent(),/£0\.00 due/);
   assert.equal(await page.locator('#wiIssuedInvoice').getByRole('heading',{name:'How to pay'}).count(),0);
   await buyer.locator('#refresh-invoices').click();
   await card.getByText('Voided',{exact:true}).waitFor();
   await card.getByText('Original invoice details',{exact:true}).click();
   assert.match(await card.textContent(),/£0\.00 due/);
   assert.equal(await card.getByText('How to pay',{exact:true}).count(),0);
   assert.deepEqual(errors,[]);const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!storage.includes('fake-access'));assert.ok(!storage.includes('fake-refresh'));
  }finally{await adminContext.close();await customerContext.close();}
 });
}
