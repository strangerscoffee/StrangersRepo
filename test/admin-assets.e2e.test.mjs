import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');let srv,browser,admin;
before(async()=>{
 srv=await startServer({writeLimit:5000});const r=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Asset Owner',username:'assets.owner',password:'asset-test-password',code:SETUP_CODE})});assert.equal(r.status,200);admin=r.headers.getSetCookie().find(c=>/^sfbb_session=[\w-]/.test(c)).split(';')[0];browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();});
async function context(viewport={width:393,height:852},colorScheme='light'){
 const ctx=await browser.newContext({viewport,colorScheme}),[name,value]=admin.split('=');await ctx.addCookies([{name,value,url:srv.base}]);return ctx;
}
for(const [device,viewport] of [['phone',{width:393,height:852}],['iPad',{width:1180,height:820}]])for(const colorScheme of ['light','dark']){
 test(`Admin recovers one lost core and stylesheet request on ${device} ${colorScheme}`,async()=>{
  const ctx=await context(viewport,colorScheme),page=await ctx.newPage(),errors=[],reports=[],counts=new Map();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.pathname==='/api/errors'){reports.push(route.request().postDataJSON());await route.fulfill({json:{code:'synthetic'}});return;}if(u.pathname==='/shared/core.js'||u.pathname==='/shared/focus.js'||u.pathname.endsWith('.css')){const n=counts.get(u.pathname)||0;counts.set(u.pathname,n+1);if(!n){await route.abort('failed');return;}}await route.continue();});
  try{await page.goto(srv.base+'/admin#wholesale');await page.getByRole('heading',{name:'Wholesale orders',exact:true}).waitFor();assert.equal(await page.locator('#sc-error').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(reports,[]);assert.equal(counts.get('/shared/core.js'),2);assert.equal(counts.get('/shared/focus.js'),2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(process.env.SHOT_DIR){await mkdir(process.env.SHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SHOT_DIR+`/admin-recovered-${device}-${colorScheme}.png`,fullPage:true});}}
  catch(error){console.error('Asset recovery diagnostic',JSON.stringify({url:page.url(),text:(await page.locator('body').innerText()).slice(0,1600),errors,reports,counts:[...counts]}));throw error;}
  finally{await ctx.close();}
 });
}
test('a persistent core failure stops dependants and reports the original failure once',async()=>{
 const ctx=await context(),page=await ctx.newPage(),errors=[],reports=[],calls=[];let attempts=0;page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>calls.push(new URL(r.url()).pathname));
 await page.route('**/shared/core.js*',async route=>{attempts++;await route.abort('failed');});await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({json:{code:'synthetic'}});});
 try{await page.goto(srv.base+'/admin');await page.locator('#sc-error').waitFor();await page.getByRole('button',{name:'Hide'}).click();await page.locator('#main').getByRole('button',{name:'Reload Admin'}).waitFor();assert.equal(attempts,2);assert.equal(await page.evaluate(()=>typeof SCWholesalePacking),'undefined');assert.equal(calls.includes('/shared/wholesale-packing.js'),false);assert.deepEqual(errors,[]);assert.equal(reports.length,1);assert.equal(reports[0].message,"Couldn't load /shared/core.js");assert.equal(calls.some(p=>p.startsWith('/api/admin/')),false);}
 finally{await ctx.close();}
});
test('a remembered Admin page after session loss loads its code and returns to sign-in without SC errors',async()=>{
 const ctx=await context(),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const r=await fetch(srv.base+'/admin',{headers:{cookie:admin}}),html=await r.text();await ctx.clearCookies();await page.route(srv.base+'/admin',async route=>route.fulfill({contentType:'text/html',body:html}));
 try{await page.goto(srv.base+'/admin');await page.waitForURL(/\/signin/);assert.deepEqual(errors,[]);assert.equal(await page.locator('#sc-error').count(),0);}
 finally{await ctx.close();}
});
test('a stylesheet that fails twice stays visible as one real error while core startup completes',async()=>{
 const ctx=await context(),page=await ctx.newPage(),reports=[],errors=[];let attempts=0;page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/admin/sickness.css*',async route=>{attempts++;await route.abort('failed');});await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({json:{code:'synthetic'}});});
 try{await page.goto(srv.base+'/admin#wholesale');await page.getByRole('heading',{name:'Wholesale orders',exact:true}).waitFor();await page.locator('#sc-error').waitFor();assert.equal(attempts,2);assert.deepEqual(errors,[]);assert.equal(reports.length,1);assert.equal(reports[0].message,"Couldn't load /admin/sickness.css");}
 finally{await ctx.close();}
});

test('optional assets download together and failure leaves independent Admin sections working',async()=>{
 const ctx=await context({width:1440,height:900}),page=await ctx.newPage(),errors=[],reports=[];
 let markOverview, releaseInvoices;
 const overviewRequested = new Promise(resolve=>{markOverview=resolve;});
 const invoicesMayFinish = new Promise(resolve=>{releaseInvoices=resolve;});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/admin/wholesale-invoice-workflows.js*', async route=>{
  await invoicesMayFinish;
  await route.abort('failed');
 });
 await page.route('**/admin/overview.js*', async route=>{markOverview();await route.continue();});
 await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({json:{code:'synthetic'}});});
 try{
  await page.goto(srv.base+'/admin#wholesale/orders',{waitUntil:'domcontentloaded'});
  await Promise.race([overviewRequested, page.waitForTimeout(5000).then(()=>{throw new Error('Overview was blocked behind a pending invoicing download');})]);
  releaseInvoices();
  await page.getByRole('heading',{name:'Wholesale orders',exact:true}).waitFor();
  await page.locator('#sideNav').getByRole('button',{name:'Invoicing',exact:true}).click();
  await page.locator('#main').getByText('Invoicing couldn’t start.').waitFor();
  await page.locator('#main').getByRole('button',{name:'Reload Admin'}).waitFor();
  await page.locator('#sideNav').getByRole('button',{name:'People',exact:true}).click();
  await page.getByRole('heading',{name:'People',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>typeof WholesaleInvoices),'undefined');
  assert.deepEqual(errors,[]);
  assert.deepEqual(reports.map(report=>report.message),["Couldn't load /admin/wholesale-invoice-workflows.js"]);
 } finally {releaseInvoices();await ctx.close();}
});

test('hiding a report allows the next error to display',async()=>{
 const ctx=await context(),page=await ctx.newPage();
 await page.route('**/api/errors',route=>route.fulfill({json:{code:'synthetic'}}));
 try{
  await page.goto(srv.base+'/admin#people');
  await page.getByRole('heading',{name:'People',exact:true}).waitFor();
  await page.evaluate(()=>SCReportError("First test error",""));
  await page.locator('#sc-error').getByText('First test error').waitFor();
  await page.locator('#sc-error').getByRole('button',{name:'Hide'}).click();
  await page.evaluate(()=>SCReportError("Second test error",""));
  await page.locator('#sc-error').getByText('Second test error').waitFor();
  assert.equal(await page.locator('#sc-error [data-more]').textContent(),'');
 } finally {await ctx.close();}
});

test('an optional script exception is reported once and has inline recovery',async()=>{
 const ctx=await context(),page=await ctx.newPage(),reports=[];
 await page.route('**/admin/sickness.js*',route=>route.fulfill({
  contentType:'text/javascript',body:'throw new Error("Simulated sickness initialization failure");'
 }));
 await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({json:{code:'synthetic'}});});
 try {
  await page.goto(srv.base+'/admin#sickness');
  await page.locator('#main').getByText(/Sickness couldn’t start/).waitFor();
  await page.locator('#main').getByRole('button',{name:'Reload Admin'}).waitFor();
  assert.equal(await page.locator('#sc-error').count(),0);
  assert.deepEqual(reports.map(report=>report.message), ['Simulated sickness initialization failure']);
  await page.locator('#tabBar').getByRole('button',{name:'People',exact:true}).click();
  await page.getByRole('heading',{name:'People',exact:true}).waitFor();
 } finally {await ctx.close();}
});

test('a stalled optional download releases the shell without running the late script',async()=>{
 const ctx=await context(),page=await ctx.newPage();
 let resume, settle;
 const held = new Promise(resolve=>{resume=resolve;});
 const lateResponse = new Promise(resolve=>{settle=resolve;});
 await page.route('**/admin/sickness.js*',async route=>{
  await held;
  await route.fulfill({contentType:'text/javascript',body:'window.AdminSickness = () => { throw new Error("late optional module executed"); };'}).catch(()=>{}).finally(settle);
 });
 await page.route('**/api/errors',route=>route.fulfill({json:{code:'synthetic'}}));
 try {
  await page.goto(srv.base+'/admin#people',{waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'People',exact:true}).waitFor();
  resume();
  await lateResponse;
  await page.evaluate(()=>{location.hash='sickness';});
  await page.locator('#main').getByText(/Sickness couldn’t start/).waitFor();
  assert.equal(await page.evaluate(()=>typeof AdminSickness),'undefined');
 } finally {resume();await ctx.close();}
});
