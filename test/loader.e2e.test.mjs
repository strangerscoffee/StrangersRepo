import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,ADMIN;
before(async()=>{
 srv=await startServer({writeLimit:3000});
 const response=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Loader Owner',username:'loader.owner',password:'loader-password',code:SETUP_CODE})});
 assert.equal(response.status,200);ADMIN=response.headers.getSetCookie().find(v=>/^sfbb_session=[\w-]/.test(v)).split(';')[0];
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();});
async function contextFor(viewport={width:1180,height:820},colorScheme='light'){
 const context=await browser.newContext({viewport,colorScheme});const[name,value]=ADMIN.split('=');await context.addCookies([{name,value,url:srv.base}]);return context;
}
const loaded=page=>page.getByRole('heading',{name:'Wholesale',exact:true}).waitFor();
for(const[device,viewport]of[['phone',{width:393,height:852}],['iPad',{width:1180,height:820}],['desktop',{width:1440,height:1000}]])for(const colorScheme of['light','dark']){
 test(`loader ${device} ${colorScheme}: branded private shield, reduced motion and lean Admin bootstrap`,{timeout:45000},async()=>{
  const context=await contextFor(viewport,colorScheme),page=await context.newPage(),errors=[],calls=[];let release,captured;
  const held=new Promise(r=>release=r),ready=new Promise(r=>captured=r);let first=true;
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>calls.push(new URL(r.url()).pathname));
  await page.route('**/api/auth/me',async route=>{
   if(first&&route.request().headers()['x-sc-session-check']==='1'){
    first=false;const response=await route.fetch();captured();await held;await route.fulfill({response});
   }else await route.continue();
  });
  try{
   await page.goto(srv.base+'/admin#wholesale');await ready;
   await page.locator('#sc-session-shield').waitFor();
   assert.equal(await page.locator('#sc-session-shield [role="img"][aria-label="Strangers Coffee"]').count(),1);
   assert.equal(await page.locator('#sc-session-shield button').isVisible(),false,'retry is reserved for an actual failure');
   assert.equal(await page.locator('#sc-session-shield').getAttribute('aria-busy'),'true');
   const geometry=await page.locator('.sc-loading-logo').evaluate(node=>{const b=node.getBoundingClientRect();return{width:b.width,height:b.height,mask:getComputedStyle(node).maskImage,inside:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight};});
   assert.equal(geometry.width,144);assert.ok(geometry.height>=80);assert.ok(geometry.inside);assert.match(geometry.mask,/logo.svg/);
   assert.equal(await page.locator('#main').isVisible(),false,'no private UI is visible before fresh asynchronous proof');
   assert.equal(calls.filter(p=>p.startsWith('/api/admin/')).length,0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.emulateMedia({reducedMotion:'reduce'});
   assert.equal(await page.locator('.sc-loading-track').evaluate(n=>getComputedStyle(n,'::before').animationName),'none');
   if(process.env.LOADER_SCREENSHOT_DIR){await mkdir(process.env.LOADER_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.LOADER_SCREENSHOT_DIR}/loader-${device}-${colorScheme}.png`});}
   assert.equal(calls.filter(p=>p==='/logo.svg').length,1,'the preloaded logo is reused by the mask');
   release();await loaded(page);
   assert.equal(calls.includes('/api/rota/links'),false,'bootstrap app links remove a whole request from Admin startup');
   assert.deepEqual(errors,[]);
  }finally{release?.();await context.close();}
 });
}
for(const[path,label,phase]of[['/admin#wholesale','Admin','bootstrap'],['/rota/','Rota','proof'],['/','Diary','proof']]){
 test(`loader ${label}: retry resumes the original startup after a ${phase} connection failure`,{timeout:45000},async()=>{
  const context=await contextFor(),page=await context.newPage();let fail=true,failed=0;
  await page.route('**/api/auth/me',async route=>{
   const proof=route.request().headers()['x-sc-session-check']==='1';
   if(fail&&proof===(phase==='proof')){failed++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'unavailable'})});}
   else await route.continue();
  });
  try{
   await page.goto(srv.base+path);await page.locator('#sc-session-shield[data-phase="error"] button').waitFor();
   assert.ok(failed>0);assert.equal(await page.locator('#sc-session-shield').getAttribute('aria-busy'),'false');
   fail=false;await page.evaluate(()=>document.querySelector('#sc-session-shield button').click());
   await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-sc-session-locked'));
   if(label==='Admin')await loaded(page);
   else if(label==='Diary')await page.waitForFunction(()=>typeof S!=='undefined'&&S.myUserId);
   else await page.locator('#avatarBtn').getAttribute('aria-label');
   assert.equal(await page.locator('#sc-session-shield').isVisible(),false);
  }finally{await context.close();}
 });
}
test('loader batches one activation burst but a later focus invalidates an in-flight proof',{timeout:45000},async()=>{
 const context=await contextFor(),page=await context.newPage();let release,captured,count=0;
 try{
  await page.goto(srv.base+'/admin#wholesale');await loaded(page);
  const held=new Promise(r=>release=r),ready=new Promise(r=>captured=r);
  await page.route('**/api/auth/me',async route=>{count++;const response=await route.fetch();if(count===1){captured();await held;}await route.fulfill({response});});
  await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await ready;assert.equal(count,1,'same-turn events start one proof after the burst');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));release();
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-sc-session-locked'));
  assert.equal(count,2,'a later activation cannot accept the older response');
 }finally{release?.();await context.close();}
});
test('a delayed private body reuses the successful current proof after a same-user activation',{timeout:45000},async()=>{
 const context=await contextFor(),page=await context.newPage();let count=0;
 await page.addInitScript(()=>{
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   const response=await nativeFetch(input,init);
   if(window.holdLoaderBody&&input==='/api/admin/people'){
    window.holdLoaderBody=false;const body=new Uint8Array(await response.arrayBuffer());
    return new Response(new ReadableStream({start(controller){window.loaderBodyHeld=true;window.releaseLoaderBody=()=>{controller.enqueue(body);controller.close();};}}),{status:response.status,headers:response.headers});
   }
   return response;
  };
 });
 try{
  await page.goto(srv.base+'/admin#wholesale');await loaded(page);
  await page.route('**/api/auth/me',async route=>{count++;await route.continue();});
  await page.evaluate(()=>{window.holdLoaderBody=true;fetch('/api/admin/people').then(r=>r.json()).then(()=>window.loaderBodyDone=true);});
  await page.waitForFunction(()=>window.loaderBodyHeld);
  await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-sc-session-locked'));
  assert.equal(count,1);await page.evaluate(()=>window.releaseLoaderBody());await page.waitForFunction(()=>window.loaderBodyDone);
  assert.equal(count,1,'body readers share the proof just completed instead of issuing another request');
 }finally{await page.evaluate(()=>window.releaseLoaderBody?.()).catch(()=>{});await context.close();}
});
