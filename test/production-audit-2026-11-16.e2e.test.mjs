// Production audit regressions. Every account, database and provider here is local and synthetic.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,provider,browser,ADMIN,STAFF,A,B,emailFail=false,emailAttempts=[],slackAttempts=0;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,cookie:cookieOf(r)};}
async function ok(...args){const r=await call(...args);assert.ok(r.status>=200&&r.status<300,`${args[0]} ${args[1]}: ${r.status} ${r.text}`);return r;}
async function customer(username){const c=(await ok('POST','/api/admin/wholesale/customers',{business:'Synthetic '+username,contact:'Audit Buyer',email:username+'@example.invalid',address:'1 Synthetic Street',postcode:'NR1 1AA',status:'Active'})).data.customer;const invite=(await ok('POST',`/api/admin/wholesale/customers/${c.id}/account`,{username})).data;const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username:invite.account.username,password:invite.temporaryPassword,newPassword:'audit-local-password-2468'},null)).cookie;return{id:c.id,cookie};}
const allOrders=async()=>(await ok('GET','/api/admin/wholesale')).data.orders;
const order=async id=>(await allOrders()).find(o=>o.id===id);
async function place(productId='brazil',buyer=A){const s=(await ok('GET','/api/wholesale/session',undefined,buyer.cookie)).data;return(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:s.customer.version,delivery:'Roastery collection',reference:'Synthetic audit',lines:[{productId,pack:'kilo',grind:'beans',quantity:6,price:1800}]},buyer.cookie)).data.order;}
async function editProduct(id,values){const p=(await ok('GET','/api/admin/wholesale')).data.products.find(p=>p.id===id);return(await ok('PUT','/api/admin/wholesale/catalogue/'+id,{ifVersion:p.version,prices:p.prices,active:p.active,inStock:p.inStock,...values})).data.product;}
async function emailSettings(confirmCustomers){const s=(await ok('GET','/api/admin/wholesale/order-emails')).data;await ok('PUT','/api/admin/wholesale/order-emails',{ifVersion:s.version,enabled:false,to:['audit@example.invalid'],confirmCustomers});}
async function waitFor(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Synthetic condition did not settle');}
async function contextForStaff(){const ctx=await browser.newContext({viewport:{width:393,height:852}});const[name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);return ctx;}
async function selectOnly(page,ids){await page.goto(srv.base+'/orders');await page.locator('#statusFilters button',{hasText:'All orders'}).click();for(const id of ids)await page.locator(`[data-order-id="${id}"]`).waitFor();await page.getByRole('button',{name:'Select orders',exact:true}).click();for(const id of ids)await page.locator(`[data-order-id="${id}"]`).click();}
async function setup({withBrowser=false}={}){
 provider=createServer((req,res)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{if(req.url==='/emails'){const mail=JSON.parse(raw);emailAttempts.push({subject:mail.subject,accepted:!emailFail,key:req.headers['idempotency-key'],mail});res.writeHead(emailFail?503:200,{'content-type':'application/json'}).end(emailFail?'temporary synthetic provider failure':'{"id":"synthetic"}');}else{slackAttempts++;res.writeHead(200).end('ok');}});});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 srv=await startServer({writeLimit:10000,scheduled:true,vars:{RESEND_API_KEY:'re_synthetic_audit_key',RESEND_API_URL:`http://127.0.0.1:${provider.address().port}/emails`,SLACK_TEST_HOOKS:'1',SLACK_ORDERS_WEBHOOK_URL:`http://127.0.0.1:${provider.address().port}/slack`}});
 ADMIN=(await ok('POST','/api/auth/setup',{name:'Synthetic Audit Admin',username:'audit.owner',password:'audit-local-password-1234',code:SETUP_CODE},null)).cookie;await emailSettings(false);A=await customer('audit.a');B=await customer('audit.b');
 const u=(await ok('POST','/api/admin/users',{name:'Synthetic Packer',username:'audit.packer',role:'staff',password:'audit-temp-password-5555'})).data.user;await ok('PUT',`/api/admin/users/${u.id}/orders-access`,{ifVersion:0,enabled:true});STAFF=(await ok('POST','/api/auth/change',{username:'audit.packer',password:'audit-temp-password-5555',newPassword:'audit-packer-own-password'},null)).cookie;
 if(withBrowser) browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
}
async function teardown(){await browser?.close();await srv?.stop();await new Promise(r=>provider?.close(r));}


let blockedStanding;
before(async()=>{
 await setup({withBrowser:true});
 await editProduct('campo',{active:true,inStock:true,customerOnly:true,whiteLabel:[A.id]});const placed=await place('campo'),day=new Date(Date.now()+864e5).toISOString().slice(0,10);
 const run=(await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'New',customerId:A.id,note:'',schedule:{dispatchDate:day,every:1}})).data.order;
 await editProduct('campo',{customerOnly:true,whiteLabel:[B.id]});blockedStanding=(await ok('POST',`/api/wholesale/orders/${run.id}/skip`,{ifVersion:run.version},A.cookie)).data.order;
});after(teardown);
test('staff batch retains reviewed versions when another operator dispatches a selected order',{timeout:45000},async()=>{
 const ids=[(await place()).id,(await place()).id],ctx=await contextForStaff(),page=await ctx.newPage();let release,arrive,heldId;const gate=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);let held=false;
 try{
  await selectOnly(page,ids);await page.route('**/api/staff-orders/orders/*',async route=>{if(route.request().method()==='PATCH'&&!held){held=true;heldId=new URL(route.request().url()).pathname.split('/').at(-1);const response=await route.fetch();arrive();await gate;await route.fulfill({response});}else await route.continue();});
  await page.locator('[data-batch="Preparing"]').click();await arrived;
  const second=await order(ids.find(id=>id!==heldId));await ok('PATCH',`/api/admin/wholesale/orders/${second.id}`,{ifVersion:second.version,status:'Dispatched',customerId:A.id,note:''});
  await page.locator('#refresh').click();await page.waitForFunction(id=>[...document.querySelectorAll('[data-order-id]')].find(n=>n.dataset.orderId===id)?.textContent.includes('Dispatched'),second.id);release();
  await page.getByText(/need checking/).waitFor();assert.equal((await order(second.id)).status,'Dispatched');assert.equal((await order(heldId)).status,'Preparing');assert.equal(await page.locator(`[data-order-id="${second.id}"]`).getAttribute('aria-pressed'),'true');
 }finally{release?.();await page.unrouteAll({behavior:'wait'});await ctx.close();}
});

test('malformed staff success retains the selected unsaved order for verification',{timeout:45000},async()=>{
 const id=(await place()).id,ctx=await contextForStaff(),page=await ctx.newPage();
 try{await selectOnly(page,[id]);await page.route('**/api/staff-orders/orders/*',async route=>{if(route.request().method()==='PATCH')await route.fulfill({status:200,contentType:'application/json',body:'{}'});else await route.continue();});
  await page.locator('[data-batch="Preparing"]').click();await page.getByText(/need checking/).waitFor();assert.equal((await order(id)).status,'New');
  const text=await page.locator('body').innerText();assert.doesNotMatch(text,/1 order marked preparing/);assert.equal(await page.locator(`[data-order-id="${id}"]`).getAttribute('aria-pressed'),'true');
 }finally{await page.unrouteAll({behavior:'wait'});await ctx.close();}
});

test('permission loss during a batch clears private data and stops without an unhandled exception',{timeout:45000},async()=>{
 const id=(await place()).id,ctx=await contextForStaff(),page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{globalThis.__auditUnhandled=[];addEventListener('unhandledrejection',e=>globalThis.__auditUnhandled.push(String(e.reason?.message||e.reason)));});
 try{await selectOnly(page,[id]);await page.route('**/api/staff-orders/orders/*',async route=>{if(route.request().method()==='PATCH')await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'permission_denied',message:'Synthetic access revoked'})});else await route.continue();});
  await page.locator('[data-batch="Preparing"]').click();await page.waitForFunction(()=>!document.querySelector('[data-order-id]'));await page.waitForTimeout(100);assert.equal((await order(id)).status,'New');assert.deepEqual([...errors,...await page.evaluate(()=>globalThis.__auditUnhandled||[])],[]);
 }finally{await page.unrouteAll({behavior:'wait'});await ctx.close();}
});


for(const [screen,viewport,isMobile] of [['phone',{width:393,height:852},true],['iPad',{width:1180,height:820},false]])for(const colorScheme of ['light','dark']){
 test(`admin notification recovery preserves drafts on ${screen} (${colorScheme})`,async()=>{
  const ctx=await browser.newContext({viewport,isMobile,hasTouch:isMobile,colorScheme}),[name,value]=ADMIN.split('=');await ctx.addCookies([{name,value,url:srv.base}]);const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let retried=false;
  await page.route('**/api/admin/wholesale/order-emails',async route=>{const response=await route.fetch(),data=await response.json();await route.fulfill({response,json:{...data,delivery:{email:{pending:0,failed:0,unknown:1},slack:{pending:0,failed:1,unknown:0},legacyDispatch:[]}}});});
  await page.route('**/api/admin/wholesale/order-emails/email-retry',async route=>{assert.equal(route.request().postDataJSON().acknowledgeUnknown,true);retried=true;await route.fulfill({json:{queued:1,delivery:{email:{pending:1,failed:0,unknown:0},slack:{pending:0,failed:1,unknown:0},legacyDispatch:[]}}});});
  try{
   await page.goto(srv.base+'/admin#wholesale');await page.locator('[data-act="wh-tab"][data-id="orders"]').click();
   await page.getByText('1 standing delivery needs review',{exact:true}).waitFor();
   if(process.env.SHOT_DIR)await page.screenshot({path:process.env.SHOT_DIR+`/standing-review-${screen}-${colorScheme}.png`,fullPage:true});
   await page.locator(`[data-act="wh-standing-review"][data-id="${blockedStanding.id}"]`).click();await page.locator('#sheet').getByText(blockedStanding.id,{exact:true}).waitFor();await page.locator('#sheet [data-sheet="close"]').click();
   await page.locator('[data-act="wh-order-emails"]').click();
   await page.locator('#wOrderEmailsTo').fill('unsaved-draft@example.invalid');await page.locator('[data-sheet="review-email"]').click();await page.locator('#wRetryConfirm').waitFor();
   assert.match(await page.locator('#wRetryConfirm').innerText(),/may send a duplicate/);assert.ok(await page.locator('#wRetryConfirm').evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight+1),'review confirmation is visible without an extra scroll');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0);
   assert.ok(await page.locator('#sheet').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'notification sheet fits');
   if(process.env.SHOT_DIR)await page.screenshot({path:process.env.SHOT_DIR+`/notification-recovery-${screen}-${colorScheme}.png`,fullPage:true});
   await page.locator('[data-sheet="retry-reviewed"]').click();await page.getByText('1 notifications queued for retry').waitFor();assert.equal(retried,true);assert.equal(await page.locator('#wOrderEmailsTo').inputValue(),'unsaved-draft@example.invalid');assert.deepEqual(errors,[]);
  }finally{await page.unrouteAll({behavior:'wait'});await ctx.close();}
 });
}
