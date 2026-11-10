// Native Admin QuickBooks sandbox screens. Only the loopback provider receives requests.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
import {startQuickBooksProvider,quickBooksVars} from './quickbooks-provider.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,provider,browser,ADMIN,BUYER,customer,invoice;
const root='/api/admin/wholesale/quickbooks';
async function api(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,path+': '+JSON.stringify(data));return{data,cookie:(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0]};}
before(async()=>{
 provider=await startQuickBooksProvider();srv=await startServer({writeLimit:5000,vars:({base})=>({...quickBooksVars(provider.origin),QUICKBOOKS_REDIRECT_URI:base+root+'/callback'})});
 ADMIN=(await api('POST','/api/auth/setup',{name:'QB UI Owner',username:'owner',password:'owner-password',code:SETUP_CODE},null)).cookie;
 customer=(await api('POST','/api/admin/wholesale/customers',{business:'Example QB Cafe',address:'Test address',postcode:'NR1 1AA',status:'Active',paymentTerms:'net-30'})).data.customer;
 const account=(await api('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'ui.buyer'})).data;
 BUYER=(await api('POST','/api/wholesale/auth/change-password',{username:'ui.buyer',password:account.temporaryPassword,newPassword:'buyer-password'},null)).cookie;
 const settings=(await api('PUT','/api/admin/wholesale/invoice-settings',{ifVersion:0,seller:{legalName:'Example UK Sandbox Ltd',address:'Test business address',vatNumber:'GB123456789',companyNumber:'',email:'',phone:''},priceBasis:'inclusive',vatRates:[{id:'standard',label:'Standard sales VAT',basisPoints:2000}],defaultCoffeeRateId:'standard',deliveryRateId:'standard',invoicePrefix:'SC-',firstInvoiceNumber:1,paymentInstructions:'Test instructions',confirmed:true})).data;
 const profile=(await api('GET','/api/wholesale/session',undefined,BUYER)).data.customer;
 const order=(await api('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:profile.version,delivery:'Roastery collection',lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:2,price:1800}]},BUYER)).data.order;
 invoice=(await api('POST',`/api/admin/wholesale/orders/${order.id}/invoice`,{orderVersion:order.version,settingsVersion:settings.version,invoiceDate:'2026-11-10',supplyDate:'2026-11-10'})).data.invoice;
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();await provider?.stop();});
for(const [device,viewport]of [['phone',{width:393,height:852}],['ipad',{width:820,height:1180}],['desktop',{width:1440,height:1000}]])for(const colorScheme of ['light','dark']){
 test(`QuickBooks admin ${device} ${colorScheme}: OAuth, company confirmation, references, mappings and non-transmitting preview`,{timeout:180000},async()=>{
  const context=await browser.newContext({viewport,colorScheme});const [name,value]=ADMIN.split('=');await context.addCookies([{name,value,url:srv.base}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shot=async suffix=>{if(process.env.WHOLESALE_SCREENSHOT_DIR){await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/quickbooks-${device}-${colorScheme}-${suffix}.png`});}};
  try{
   await page.goto(srv.base+'/admin#wholesale');await page.locator('[data-act="wh-tab"][data-id="invoices"]').click();await page.locator('[data-act="wh-invoice-quickbooks"]').click();await page.locator('#qbConnectionForm').waitFor();
   // Each viewport starts from a locally disconnected state.
   if(await page.locator('[data-sheet="qb-disconnect"]').count()){await page.locator('[data-sheet="qb-disconnect"]').click();await page.locator('#qbDisconnectForm button[type="submit"]').click();await page.locator('[data-sheet="qb-connect"]').waitFor();}
   await page.locator('[data-sheet="qb-connect"]').click();await page.locator('#qbConfirmCompany').waitFor();assert.match(await page.locator('#qbConnectionForm').textContent(),/Example UK Sandbox Ltd/);
   await page.locator('#qbVatNumber').fill('GB123456789');await page.locator('#qbConfirmCompany').check();await page.locator('#qbConnectionForm button[type="submit"]').click();await page.locator('[data-sheet="qb-browse"]').first().waitFor();
   await shot('connected');await page.locator('[data-sheet="qb-browse"][data-kind="customer"]').click();await page.locator('#qbReferenceList').waitFor();assert.equal(await page.locator('#qbReferenceList .qb-reference-row').count(),100);
   await page.locator('[data-sheet="qb-next"]').click();await page.waitForFunction(()=>document.querySelectorAll('#qbReferenceList .qb-reference-row').length===1);assert.equal(await page.locator('#qbReferenceList .qb-reference-row').count(),1);await page.locator('#qbReferenceList [data-sheet="wi-back"]').first().click();
   await page.locator('#qbConnectionForm [data-sheet="wi-back"]').first().click();await page.locator('[data-act="wh-invoice-open"]').first().click();await page.locator('[data-sheet="wi-quickbooks"]').click();await page.locator('#qbMappingForm').waitFor();
   async function choose(key,id){await page.locator(`[data-sheet="qb-choice"][data-key="${key}"]`).click();await page.locator(`#qbReferenceList [data-id="${id}"]`).click();await page.locator('#qbMappingForm').waitFor();}
   await choose('customerId','3');await choose('coffeeItemId','50');await choose('deliveryItemId','51');await page.locator('[data-sheet="qb-tax"]').click();await page.locator('#qbReferenceList [data-id="3"]').click();
   assert.match(await page.locator('[data-key="customerId"]').textContent(),/Example customer 3/,'VAT and customer references with the same numeric ID retain their own names');await page.locator('#qbMappingReview').check();await shot('mappings');await page.locator('#qbMappingForm button[type="submit"]').click();await page.locator('#qbInvoicePreview').waitFor();assert.match(await page.locator('#qbInvoicePreview').textContent(),/No invoice has been sent/);assert.match(await page.locator('#qbInvoicePreview').textContent(),/£36.00/);
   assert.equal(await page.locator('#qbInvoicePreview button[type="submit"]').count(),0);await shot('preview');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.deepEqual(errors,[]);const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!storage.includes('fake-access'));assert.ok(!storage.includes('fake-refresh'));
  }finally{await context.close();}
 });
}
