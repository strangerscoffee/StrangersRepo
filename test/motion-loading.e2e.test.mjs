import { openWholesaleOrders } from './wholesale-ui-helpers.mjs';
// Slow data, navigation races and runtime accessibility preferences across all five apps.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,admin,buyer;
async function api(path,body,cookie=admin){const r=await fetch(srv.base+path,{method:'POST',headers:{'content-type':'application/json',cookie:cookie||''},body:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,path+': '+JSON.stringify(data));return{data,cookie:(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0]};}
before(async()=>{
 srv=await startServer({writeLimit:4000});admin=(await api('/api/auth/setup',{name:'Motion Owner',username:'motionowner',password:'motion-owner-password',code:SETUP_CODE},'')).cookie;
 const {customer}=(await api('/api/admin/wholesale/customers',{business:'Motion Test Coffee',contact:'Test Buyer',email:'motion@example.test',address:'10 Test Street',postcode:'NR1 1AA',status:'Active'})).data;
 const a=(await api(`/api/admin/wholesale/customers/${customer.id}/account`,{username:'motionbuyer'})).data;
 buyer=(await api('/api/wholesale/auth/change-password',{username:'motionbuyer',password:a.temporaryPassword,newPassword:'motion-buyer-password'},'')).cookie;
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();});
async function screen(viewport,colorScheme,cookie=admin){const context=await browser.newContext({viewport,colorScheme});const [name,value]=cookie.split('=');await context.addCookies([{name,value,url:srv.base}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));return{context,page,errors};}
async function held(page,path){let release,entered;const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);let active=true;await page.route(url=>url.pathname===path,async route=>{if(active){entered();await gate;}await route.continue();});return{arrived,release:()=>{active=false;release();}};}
async function scaffold(page,selector,label){const node=page.locator(selector+' .sc-skeleton').first();await node.waitFor();assert.ok(await node.getAttribute('aria-label'));assert.equal(await node.locator('button,input,a').count(),0,'loading shapes are not interactive');assert.equal(await node.locator('.sc-sk-shapes').getAttribute('aria-hidden'),'true');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'skeleton fits screen');if(process.env.MOTION_SCREENSHOT_DIR){await mkdir(process.env.MOTION_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.MOTION_SCREENSHOT_DIR}/${label}.png`});}}
for(const [device,viewport] of [['phone',{width:393,height:852}],['ipad',{width:820,height:1180}]])for(const color of ['light','dark']){
 test(`motion loading Admin ${device} ${color}: first data, stale navigation and runtime reduced motion`,{timeout:60000},async()=>{
  const {context,page,errors}=await screen(viewport,color);let first,old;
  try{first=await held(page,'/api/admin/overview');await page.goto(srv.base+'/admin/');await first.arrived;await scaffold(page,'#main',`admin-${device}-${color}`);assert.equal(await page.locator('#main').getAttribute('aria-busy'),'true');first.release();await page.locator('#main[aria-busy="false"]').waitFor();
   old=await held(page,'/api/admin/people');await page.locator('button[data-go="people"]:visible').first().click();await old.arrived;await scaffold(page,'#main',`people-${device}-${color}`);await page.locator('button[data-go="activity"]:visible').first().click();await page.locator('#main[aria-busy="false"]').waitFor();assert.match(await page.locator('#main h1').textContent(),/Activity/);const oldResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/people');old.release();await oldResponse;
   assert.match(await page.locator('#main h1').textContent(),/Activity/,'late previous page cannot replace current view');
   await page.evaluate(()=>SC.reveal(document.querySelector('#main')));await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('#main').getAnimations().some(a=>a.id==='sc-reveal'));
   assert.deepEqual(errors,[]);
  }finally{first?.release();old?.release();await context.close();}
 });
 test(`motion loading rota ${device} ${color}: calendar scaffold and page failure recovery`,{timeout:60000},async()=>{
  const {context,page,errors}=await screen(viewport,color);let gate;
  try{gate=await held(page,'/api/rota/week');await page.goto(srv.base+'/rota/#week');await gate.arrived;await scaffold(page,'#page',`rota-${device}-${color}`);assert.equal(await page.locator('#page').getAttribute('aria-busy'),'true');gate.release();await page.locator('#page[aria-busy="false"]').waitFor();assert.equal(await page.locator('#page .sc-skeleton').count(),0);
   await page.route('**/api/rota/leave/dashboard',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Test service unavailable'})}));await page.evaluate(()=>location.hash='#leave');await page.locator('#page[aria-busy="false"]').waitFor();await page.waitForFunction(()=>document.body.dataset.page==='leave');await page.locator('#page .sc-skeleton').waitFor({state:'hidden'});assert.ok((await page.locator('#page').textContent()).trim());await page.unroute('**/api/rota/leave/dashboard');await page.evaluate(()=>location.hash='#mine');await page.waitForFunction(()=>document.body.dataset.page==='mine');await page.locator('#page[aria-busy="false"]').waitFor();assert.equal(await page.locator('#page .sc-skeleton').count(),0);assert.deepEqual(errors,[]);
  }finally{gate?.release();await context.close();}
 });
 test(`motion loading diary ${device} ${color}: first snapshots gate controls and empty results finish loading`,{timeout:60000},async()=>{
  const {context,page,errors}=await screen(viewport,color);let gate;
  try{gate=await held(page,'/api/db/poll');await page.goto(srv.base+'/');await gate.arrived;await scaffold(page,'#diaryLoading',`diary-${device}-${color}`);assert.equal(await page.locator('[data-panel="day"]').evaluate(n=>n.inert),true);assert.equal(await page.locator('[data-panel="day"]').isVisible(),false);gate.release();await page.waitForFunction(()=>document.querySelector('#diaryLoading')?.hidden&&!document.documentElement.hasAttribute('data-sc-session-locked'));assert.equal(await page.locator('[data-panel="day"]').evaluate(n=>n.inert),false);assert.equal(await page.locator('[data-panel="day"]').getAttribute('aria-busy'),'false');assert.deepEqual(errors,[]);
  }finally{gate?.release();await context.close();}
 });
 test(`motion loading wholesale ${device} ${color}: products, history, invoices and static reduced-motion shapes`,{timeout:60000},async()=>{
  const {context,page,errors}=await screen(viewport,color,buyer);let catalogue,orders,invoices;
  try{catalogue=await held(page,'/api/wholesale/catalogue');await page.goto(srv.base+'/wholesale-preview/');await catalogue.arrived;await scaffold(page,'#catalogue-status',`catalogue-${device}-${color}`);assert.equal(await page.locator('#toast').isVisible(),false,'loading does not show an empty notification');assert.equal(await page.locator('#products > article').count(),0);await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.sc-sk-bar').first().evaluate(n=>getComputedStyle(n,'::after').animationName),'none');catalogue.release();await page.locator('#products[aria-busy="false"]').waitFor();await page.locator('#catalogue-status').waitFor({state:'hidden'});assert.ok(await page.locator('#products > article').count());
   orders=await held(page,'/api/wholesale/orders');invoices=await held(page,'/api/wholesale/invoices');await openWholesaleOrders(page);await orders.arrived;await scaffold(page,'#order-history',`history-${device}-${color}`);orders.release();await page.locator('#order-history[aria-busy="false"]').waitFor();assert.match(await page.locator('#order-history').textContent(),/Your orders will appear/);
   await page.locator('#history-invoices').click();await invoices.arrived;await scaffold(page,'#customer-invoices-list',`invoices-${device}-${color}`);invoices.release();await page.locator('#customer-invoices-list[aria-busy="false"]').waitFor();assert.equal(await page.locator('#orders-dialog').evaluate(n=>getComputedStyle(n).scale),'none');await page.keyboard.press('Escape');await page.locator('#orders-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.activeElement.id),'account-toggle');assert.deepEqual(errors,[]);
  }finally{catalogue?.release();orders?.release();invoices?.release();await context.close();}
 });
 test(`motion loading staff orders ${device} ${color}: access proof precedes orders and customer scaffolds`,{timeout:60000},async()=>{
  const {context,page,errors}=await screen(viewport,color);let orders,customers;
  try{orders=await held(page,'/api/staff-orders/orders');await page.goto(srv.base+'/orders');await orders.arrived;await scaffold(page,'#accessStatus',`staff-orders-${device}-${color}`);assert.equal(await page.locator('#ordersContent').isVisible(),false,'pending permissions never reveal old orders');orders.release();await page.locator('#ordersContent').waitFor();await page.locator('#orderList[aria-busy="false"]').waitFor();customers=await held(page,'/api/staff-orders/customers');await page.locator('[data-view="customers"]').click();await customers.arrived;await scaffold(page,'#customerList',`staff-customers-${device}-${color}`);customers.release();await page.locator('#customerList[aria-busy="false"]').waitFor();assert.equal(await page.locator('#customerList .sc-skeleton').count(),0);assert.deepEqual(errors,[]);
  }finally{orders?.release();customers?.release();await context.close();}
 });
}

test('diary first-load outage ends the shimmer and reconnect recovers without unlocking empty controls',{timeout:60000},async()=>{
 const {context,page,errors}=await screen({width:393,height:852},'light');let unavailable=true;
 try{
  await page.route('**/api/db/poll',route=>unavailable?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable',message:'Synthetic offline data'})}):route.continue());
  await page.goto(srv.base+'/');await page.locator('#diaryLoading .banner').waitFor();assert.equal(await page.locator('#diaryLoading .sc-skeleton').count(),0);assert.equal(await page.locator('[data-panel="day"]').evaluate(n=>n.inert),true);
  unavailable=false;await page.evaluate(()=>dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.querySelector('#diaryLoading')?.hidden&&!document.documentElement.hasAttribute('data-sc-session-locked'));assert.equal(await page.locator('[data-panel="day"]').evaluate(n=>n.inert),false);assert.deepEqual(errors,[]);
 }finally{unavailable=false;await context.close();}
});
