import { revealAdminOptions } from "./admin-workspace-helpers.mjs";
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');let srv,browser,admin,staff;
const cookieOf=r=>(r.headers.getSetCookie().find(c=>/^sfbb_session=[\w-]/.test(c))||'').split(';')[0];
async function api(method,path,body,cookie=admin){const r=await fetch(srv.base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();assert.ok(r.ok,text);return{data:JSON.parse(text),cookie:cookieOf(r)};}
before(async()=>{
 srv=await startServer({writeLimit:5000});admin=(await api('POST','/api/auth/setup',{name:'Delivery Owner',username:'email.ui.owner',password:'email-owner-password',code:SETUP_CODE},null)).cookie;
 await api('POST','/api/admin/users',{name:'Synthetic Staff',username:'email.ui.staff',role:'staff',password:'temporary-email-password'});staff=(await api('POST','/api/auth/change',{username:'email.ui.staff',password:'temporary-email-password',newPassword:'chosen-email-password'},null)).cookie;
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();});
async function asAdmin(viewport={width:393,height:852},colorScheme='light'){
 const ctx=await browser.newContext({viewport,colorScheme}),[name,value]=admin.split('=');await ctx.addCookies([{name,value,url:srv.base}]);return ctx;
}
async function openAlerts(page){await page.goto(srv.base+'/admin#wholesale');await revealAdminOptions(page, ".w-order-settings"); await page.locator('[data-act="wh-order-emails"]').click();await page.locator('#wOrderEmailsTo').waitFor();}
const longAddress='very.long.customer.contact.'.repeat(5)+'@example.invalid';
function fixture(data){return{...data,webhookConfigured:true,lastWebhookAt:Date.now(),messages:[{id:'synthetic',recipient:longAddress,name:'Synthetic business',subject:'<img id="email-injected" src="x">',stream:'wholesale',acceptedAt:Date.now(),status:'bounced',detail:'Mailbox unavailable'}],suppressed:[{email:longAddress,source:'email.bounced',at:Date.now()}]};}
for(const [device,viewport]of[['phone',{width:393,height:852}],['iPad',{width:1180,height:820}]])for(const colorScheme of ['light','dark']){
 test(`Email health ${device} ${colorScheme}: feedback, setup, DNS check, copy and preserved order-alert draft`,async()=>{
  const ctx=await asAdmin(viewport,colorScheme),page=await ctx.newPage(),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copiedEmailSetup=text;}}}));
  await page.route('**/api/admin/wholesale/order-emails/delivery',async route=>{const r=await route.fetch();await route.fulfill({response:r,json:fixture(await r.json())});});
  await page.route('**/api/admin/wholesale/order-emails/delivery/dns',async route=>route.fulfill({json:{checkedAt:Date.now(),domains:[{domain:'staffstrangerscoffee.com',dmarc:'missing',dkim:'published',bounceSpf:'published'}]}}));
  try{
   await openAlerts(page);await page.locator('#wOrderEmailsTo').fill('draft@example.invalid\n');await page.locator('#wOrderEmailsOn').uncheck();await page.locator('#wConfirmCustomers').uncheck();await page.locator('[data-sheet="email-health"]').click();await page.getByRole('heading',{name:'Email health',exact:true}).waitFor();
   assert.equal(await page.locator('#email-injected').count(),0);assert.match(await page.locator('#sheet').innerText(),/Mailbox unavailable/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok(await page.locator('#sheet').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   await page.locator('[data-sheet="email-dns"]').click();await page.locator('#wEmailDns').getByText(/DMARC missing/).waitFor();
   await page.locator('[data-sheet="email-copy-record"]').first().click();assert.match(await page.evaluate(()=>window.__copiedEmailSetup),/rua=mailto:sales@strangerscoffee.com/);await page.locator('[data-sheet="email-copy-url"]').click();assert.equal(await page.evaluate(()=>window.__copiedEmailSetup),(await api('GET','/api/admin/wholesale/order-emails/delivery')).data.setup.webhookUrl);
   if(process.env.SHOT_DIR){await mkdir(process.env.SHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SHOT_DIR+`/email-health-${device}-${colorScheme}.png`,fullPage:true});}
   await page.locator('[data-sheet="email-refresh"]').click();await page.getByRole('heading',{name:'Email health',exact:true}).waitFor();await page.locator('[data-sheet="email-back"]').click();assert.equal(await page.locator('#wOrderEmailsTo').inputValue(),'draft@example.invalid\n');assert.equal(await page.locator('#wOrderEmailsOn').isChecked(),false);assert.equal(await page.locator('#wConfirmCustomers').isChecked(),false);assert.deepEqual(errors,[]);assert.deepEqual(posts,[],'viewing health never sends a test email');
  }finally{await ctx.close();}
 });
}
test('unconfigured feedback is shown honestly without exposing a secret',async()=>{
 const ctx=await asAdmin(),page=await ctx.newPage();try{await openAlerts(page);await page.locator('[data-sheet="email-health"]').click();await page.getByRole('heading',{name:'Email health',exact:true}).waitFor();assert.match(await page.locator('#wEmailWebhook').innerText(),/Not connected/);assert.doesNotMatch(await page.locator('#sheet').innerText(),/whsec_/);}finally{await ctx.close();}
});
test('a delayed health response cannot restore another account’s email addresses after permission loss',async()=>{
 const ctx=await asAdmin(),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let release,captured;const gate=new Promise(r=>release=r),ready=new Promise(r=>captured=r);
 await page.route('**/api/admin/wholesale/order-emails/delivery',async route=>{const r=await route.fetch(),data=fixture(await r.json());captured();await gate;await route.fulfill({response:r,json:data});});
 try{await openAlerts(page);await page.locator('[data-sheet="email-health"]').click({noWaitAfter:true});await ready;const[name,value]=staff.split('=');await ctx.addCookies([{name,value,url:srv.base}]);await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'));});release();await page.waitForFunction(()=>!document.querySelector('#sheet')?.textContent.includes('Synthetic business'));await page.waitForTimeout(200);assert.equal((await page.locator('body').innerText()).includes(longAddress),false);assert.deepEqual(errors,[]);}finally{release?.();await page.unrouteAll({behavior:'wait'});await ctx.close();}
});
