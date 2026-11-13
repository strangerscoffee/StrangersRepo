import { openWholesaleOrders, openWholesaleAccount, openWholesaleAccountMenu } from './wholesale-ui-helpers.mjs';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,ADMIN,A,B;
async function api(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,`${path} ${r.status} ${JSON.stringify(data)}`);return{r,data}}
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function account(name){const customer=(await api('POST','/api/admin/wholesale/customers',{business:name,contact:'Private contact '+name,email:name+'@example.test',address:'Private street '+name,postcode:'NR1 1AA',status:'Active'})).data.customer;const invitation=(await api('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:name})).data;const cookie=cookieOf((await api('POST','/api/wholesale/auth/change-password',{username:name,password:invitation.temporaryPassword,newPassword:name+'-own-password'},null)).r);await api('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:customer.version,delivery:'Delivery',reference:'PRIVATE-REFERENCE-'+name,lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:1,price:1800}]},cookie);return{cookie,customer}}
async function useCookie(context,cookie){const[name,value]=cookie.split('=');await context.addCookies([{name,value,url:srv.base}])}
before(async()=>{srv=await startServer({writeLimit:4000});ADMIN=cookieOf((await api('POST','/api/auth/setup',{name:'Privacy Owner',username:'owner',password:'privacy-owner-password',code:SETUP_CODE},null)).r);A=await account('privacy.alpha');B=await account('privacy.beta');browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
after(async()=>{await browser?.close();await srv?.stop()});
test('mobile account popover stays hidden during verification and clears the previous business', {timeout:60000}, async()=>{
 const context=await browser.newContext({viewport:{width:393,height:852}});await useCookie(context,A.cookie);const page=await context.newPage();let release,arrive,holding=false;const ready=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
 try{
  await page.goto(srv.base+'/wholesale-preview/');await page.locator('[data-product]').first().waitFor();await openWholesaleAccountMenu(page);assert.equal(await page.locator('#signed-in-name').isVisible(),true);
  await page.route('**/api/wholesale/session',async route=>{const response=await route.fetch();if(holding&&route.request().headers()['x-sc-session-check']==='1'){arrive();await gate}await route.fulfill({response})});
  await useCookie(context,B.cookie);holding=true;await page.evaluate(()=>dispatchEvent(new Event('focus')));await ready;
  assert.equal(await page.locator('#signed-in-name').isVisible(),false);assert.equal(await page.locator('#sc-session-shield').isVisible(),true);
  const opened=await page.evaluate(()=>{const menu=document.getElementById('wholesale-account');if(menu.matches(':popover-open'))menu.hidePopover();menu.showPopover();return menu.matches(':popover-open')});assert.equal(opened,false,'a locked page cannot open its private account popover');
  holding=false;release();await page.waitForFunction(()=>document.getElementById('signed-in-name')?.textContent==='privacy.beta');await openWholesaleAccountMenu(page);assert.equal(await page.locator('#signed-in-name').innerText(),'privacy.beta');assert.ok(!(await page.locator('#wholesale-account').innerText()).includes('privacy.alpha'));
 }finally{release?.();await context.close()}
});
for(const[device,viewport]of[['phone',{width:393,height:852}],['iPad',{width:1180,height:820}]])for(const colorScheme of['light','dark'])test(`customer privacy ${device} ${colorScheme}: focus shields private forms until the current business is verified`,{timeout:60000},async()=>{
 const context=await browser.newContext({viewport,colorScheme});await useCookie(context,A.cookie);const page=await context.newPage();let release,arrive,holding=false;const ready=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
 try{
  await page.goto(srv.base+'/wholesale-preview/');await page.locator('[data-product]').first().waitFor();await openWholesaleAccount(page);await page.locator('#account-dialog[open]').waitFor();assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Private contact privacy.alpha');
  await page.route('**/api/wholesale/session',async route=>{const response=await route.fetch();if(holding&&route.request().headers()['x-sc-session-check']==='1'){arrive();await gate}await route.fulfill({response})});
  await useCookie(context,B.cookie);holding=true;await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'))});await ready;
  assert.equal(await page.locator('html').getAttribute('data-sc-session-locked'),'');assert.equal(await page.locator('#account-form [name="contact"]').isVisible(),false);assert.equal(await page.locator('#sc-session-shield').isVisible(),true);
  if(process.env.SECURITY_QA_DIR){await mkdir(process.env.SECURITY_QA_DIR,{recursive:true});await page.screenshot({path:`${process.env.SECURITY_QA_DIR}/${device}-${colorScheme}.png`})}
  holding=false;release();await page.waitForFunction(()=>document.getElementById('signed-in-name')?.textContent==='privacy.beta');assert.equal(await page.locator('#account-dialog').isVisible(),false);assert.ok(!(await page.locator('body').innerText()).includes('Private contact privacy.alpha'));
  await openWholesaleAccount(page);await page.locator('#account-dialog[open]').waitFor();assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Private contact privacy.beta');
 }finally{release?.();await context.close()}
});
test('a held order-history response cannot restore a previous business after identity loss',{timeout:60000},async()=>{
 const context=await browser.newContext({viewport:{width:1180,height:820}});await useCookie(context,A.cookie);const page=await context.newPage();let release,arrive,capture;const ready=new Promise(r=>arrive=r),gate=new Promise(r=>release=r),cleared=new Promise(r=>capture=r);
 try{
  await page.exposeFunction('capturePrivacyState',capture);
  await page.goto(srv.base+'/wholesale-preview/');await page.locator('[data-product]').first().waitFor();
  await page.evaluate(()=>addEventListener('sc:session-invalid',()=>window.capturePrivacyState({locked:document.documentElement.hasAttribute('data-sc-session-locked'),history:document.getElementById('order-history').textContent,products:document.querySelectorAll('#products [data-product]').length,name:document.getElementById('signed-in-name').textContent})));
  await page.route('**/api/wholesale/orders',async route=>{const response=await route.fetch();arrive();await gate;try{await route.fulfill({response})}catch{}});
  await openWholesaleOrders(page);await ready;await useCookie(context,B.cookie);await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'))});
  const state=await cleared;assert.equal(state.locked,true);assert.equal(state.products,0);assert.equal(state.name,'');assert.ok(!state.history.includes('PRIVATE-REFERENCE-privacy.alpha'));
  release();await page.waitForFunction(()=>document.getElementById('signed-in-name')?.textContent==='privacy.beta');assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE-REFERENCE-privacy.alpha'));
 }finally{release?.();await context.close()}
});
test('offline identity verification keeps customer details hidden until Retry succeeds',{timeout:60000},async()=>{
 const context=await browser.newContext({viewport:{width:393,height:852}});await useCookie(context,A.cookie);const page=await context.newPage();let offline=false;
 try{
  await page.goto(srv.base+'/wholesale-preview/');await page.locator('[data-product]').first().waitFor();await openWholesaleAccount(page);await page.locator('#account-dialog[open]').waitFor();
  await page.route('**/api/wholesale/session',route=>offline?route.abort('failed'):route.continue());offline=true;await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'))});await page.locator('#sc-session-shield button:not([hidden])').waitFor();assert.equal(await page.locator('#account-form [name="email"]').isVisible(),false);
  offline=false;await page.locator('#sc-session-shield button').click();await page.locator('html:not([data-sc-session-locked])').waitFor();assert.equal(await page.locator('#account-form [name="email"]').inputValue(),'privacy.alpha@example.test');
 }finally{await context.close()}
});
