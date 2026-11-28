import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,ADMIN,STAFF,staffId,sourceOrder;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,`${path}: ${JSON.stringify(data)}`);return{data,cookie:cookieOf(r)}}
async function setAccess(enabled){const current=(await call('GET',`/api/admin/users/${staffId}/orders-access`)).data;await call('PUT',`/api/admin/users/${staffId}/orders-access`,{ifVersion:current.version,enabled})}
before(async()=>{
 srv=await startServer({writeLimit:4000,vars:{ROTA_HOST:'',COOKIE_DOMAIN:''}});ADMIN=(await call('POST','/api/auth/setup',{name:'Staff Orders Owner',username:'owner',password:'staff-orders-owner',code:SETUP_CODE},null)).cookie;
 staffId=(await call('POST','/api/admin/users',{name:'Orders Team Member',username:'orders.staff',role:'staff',password:'temporary-password'})).data.user.id;
 STAFF=(await call('POST','/api/auth/change',{username:'orders.staff',password:'temporary-password',newPassword:'orders-staff-own'},null)).cookie;
 const customer=(await call('POST','/api/admin/wholesale/customers',{business:'River & Roast <Cafe>',contact:'Hidden contact',email:'hidden@example.test',address:'10 Example Street',postcode:'NR1 1AA',status:'Active',note:'PRIVATE_CUSTOMER_NOTE'})).data.customer;
 const account=(await call('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:'staff.orders.buyer'})).data;
 const buyer=(await call('POST','/api/wholesale/auth/change-password',{username:'staff.orders.buyer',password:account.temporaryPassword,newPassword:'buyer-own-password'},null)).cookie;
 sourceOrder=(await call('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),delivery:'Delivery',reference:'STAFF-ORDER-TEST',customerVersion:customer.version,customerNote:'Use the side entrance.',lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:50,price:1800},{productId:'decaf',pack:'kilo',grind:'cafetiere',quantity:2,price:2000}]},buyer)).data.order;
 await call('PATCH','/api/admin/wholesale/orders/'+sourceOrder.id,{ifVersion:sourceOrder.version,customerId:customer.id,status:'New',note:'PRIVATE_ORDER_NOTE'});
 const data=JSON.stringify({dueDate:'2020-01-01',totals:{grossPence:94000}});
 srv.sql(`INSERT INTO wholesale_invoices(invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by) VALUES('STAFF-TEST','${sourceOrder.id}','${customer.id}','staff-test','${data}',1,'PRIVATE_INVOICE_ACTOR')`);
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop()});
async function contextFor(cookie,viewport,colorScheme){const context=await browser.newContext({viewport,colorScheme});const[name,value]=cookie.split('=');await context.addCookies([{name,value,url:srv.base}]);return context}
for(const[screen,viewport]of[['phone',{width:393,height:852}],['iPad',{width:1180,height:820}],['desktop',{width:1440,height:900}]])for(const colour of['light','dark']){
 test(`staff orders ${screen} ${colour}: read-only preparation, overdue warning, escaped details and revocation`,{timeout:60000},async()=>{
  await setAccess(true);const context=await contextFor(STAFF,viewport,colour),page=await context.newPage(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/staff-orders/')&&r.method()!=='GET')writes.push(r.method())});
  try{
   await page.goto(srv.base+'/orders');await page.locator('[data-order-id]').first().waitFor();assert.equal(await page.locator('.account-warning').filter({hasText:'Account overdue'}).count(),1);
   assert.equal(await page.locator('.order-row b').first().innerText(),'River & Roast <Cafe>');assert.equal(await page.locator('cafe').count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.locator('[data-order-id]').first().click();if(screen==='desktop')await page.locator('#packingDesk').getByRole('button',{name:'Open order'}).click();await page.locator('#orderDialog[open]').waitFor();
   assert.match(await page.locator('#orderDetail').innerText(),/Account|overdue invoices/);assert.equal(await page.locator('.w-grind-badge').filter({hasText:'Whole bean'}).count(),1);assert.equal(await page.locator('#orderDetail .w-decaf-label').count(),1);
   const details=await page.locator('#orderDetail').innerText();for(const hidden of ['PRIVATE_CUSTOMER_NOTE','PRIVATE_INVOICE_ACTOR','hidden@example.test','£'])assert.ok(!details.includes(hidden),hidden);
   assert.equal(await page.locator('#editNote').inputValue(),'PRIVATE_ORDER_NOTE','granted staff read and edit the internal note');assert.ok(await page.locator('#editStatus').isVisible());
   assert.ok(!(await page.locator('#orderDialog').innerText()).includes('£'),'no prices anywhere in the order');
   const close=await page.locator('#closeOrder').boundingBox(),footer=await page.locator('#doneOrder').boundingBox();assert.ok(close.y>=0&&footer.y+footer.height<=viewport.height,'close and Done remain reachable');
   if(process.env.STAFF_ORDERS_SCREENSHOT_DIR){await mkdir(process.env.STAFF_ORDERS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.STAFF_ORDERS_SCREENSHOT_DIR}/staff-order-${screen}-${colour}.png`,animations:'disabled'});}
   await page.locator('#doneOrder').click();await page.locator('#search').fill('no-match');await page.waitForFunction(()=>document.getElementById('orderCount').textContent==='0 orders');
   await page.locator('#search').fill('');await page.locator('[data-order-id]').first().waitFor();
   await setAccess(false);await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'))});
   await page.waitForFunction(()=>document.getElementById('accessStatus').textContent.includes('do not have access'));
   assert.equal(await page.locator('[data-order-id]').count(),0);assert.equal(await page.locator('#orderDetail').innerText(),'');assert.equal(await page.locator('#ordersContent').isVisible(),false);
   assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  }finally{await context.close()}
 });
}
const workspaces=page=>page.getByRole('navigation',{name:'Staff workspaces',exact:true});
const workspace=(page,name)=>workspaces(page).getByRole('link',{name,exact:true});

test('Staff workspace navigation keeps keyboard focus when it moves between the dock and header',{timeout:60000},async()=>{
 await setAccess(true);
 const context=await contextFor(STAFF,{width:1023,height:680},'dark');
 try{
  const page=await context.newPage();
  for(const path of ['/#day','/rota/#mine','/orders']){
   await page.goto(srv.base+path);
   await workspace(page,'Rota').focus();
   await page.setViewportSize({width:1024,height:680});
   await page.waitForFunction(()=>document.activeElement.matches('.staff-workspaces-wide [data-workspace="rota"]'));
   await page.setViewportSize({width:1023,height:680});
   await page.waitForFunction(()=>document.activeElement.matches('.staff-workspaces-dock [data-workspace="rota"]'));
  }
 }finally{await context.close()}
});

test('Admin People controls access to Wholesale in Staff navigation',{timeout:60000},async()=>{
 await setAccess(false);const ac=await contextFor(ADMIN,{width:1180,height:820},'light'),sc=await contextFor(STAFF,{width:393,height:852},'light');
 try{
  const admin=await ac.newPage(),staff=await sc.newPage();
  await staff.goto(srv.base+'/#more');await workspace(staff,'Kitchen Diary').waitFor();assert.equal(await workspace(staff,'Wholesale').count(),0);
  await workspace(staff,'Rota').click();await workspace(staff,'Rota').and(staff.locator('[aria-current="page"]')).waitFor();assert.equal(await workspace(staff,'Wholesale').count(),0);
  await admin.goto(srv.base+'/admin#people');await admin.locator(`[data-person="${staffId}"]`).click();await admin.locator(`[data-act="order-access"][data-id="${staffId}"]`).click();await admin.locator('#orderAccessEnabled').waitFor();assert.equal(await admin.locator('#orderAccessEnabled').isChecked(),false);await admin.locator('#orderAccessEnabled').check();await admin.getByRole('button',{name:'Save access',exact:true}).click();await admin.locator('#scrim').waitFor({state:'hidden'});
  await staff.reload();await workspace(staff,'Wholesale').click();await staff.locator('[data-order-id]').waitFor();
 }finally{await ac.close();await sc.close()}
});

test('Diary and Rota reflect the first live change to Wholesale access',{timeout:60000},async()=>{
 for(const [path,name] of [['/','Kitchen Diary'],['/rota/','Rota']]){
  await setAccess(false);
  const context=await contextFor(STAFF,{width:393,height:852},'light');
  try{
   const page=await context.newPage();
   await page.goto(srv.base+path);
   await workspace(page,name).and(page.locator('[aria-current="page"]')).waitFor();
   await page.waitForFunction(()=>!document.hidden&&window.SC?.live().open());
   assert.equal(await workspace(page,'Wholesale').count(),0);
   await setAccess(true);
   await workspace(page,'Wholesale').waitFor({timeout:10000});
   await setAccess(false);
   await workspace(page,'Wholesale').waitFor({state:'detached',timeout:10000});
  }finally{await context.close()}
 }
});

for(const viewport of [{width:320,height:650},{width:1512,height:900}]){
 test(`Staff workspace navigation keeps local sections and filters at ${viewport.width}px`,{timeout:60000},async()=>{
  await setAccess(true);
  const context=await contextFor(STAFF,viewport,'dark'),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  async function current(name){
   const active=workspace(page,name).and(page.locator('[aria-current="page"]'));
   await active.waitFor();
   assert.equal(await workspaces(page).locator('[aria-current="page"]').count(),1);
   const overflow=await page.evaluate(()=>{
    const width=document.documentElement.scrollWidth;
    if(width<=innerWidth)return null;
    const elements=Array.from(document.body.querySelectorAll('*')).filter(el=>
     el.getBoundingClientRect().right>innerWidth||(el.matches('button')&&el.scrollWidth>el.clientWidth+1));
    return {viewport:innerWidth,width,elements:elements.slice(0,12).map(el=>el.id||el.tagName+'.'+el.classList.value)};
   });
   assert.equal(overflow,null,`${name} overflows the viewport: ${JSON.stringify(overflow)}`);
  }
  try{
   await page.goto(srv.base+'/#week');await current('Kitchen Diary');
   await workspace(page,'Rota').click();await current('Rota');
   await page.getByRole('link',{name:'Holidays',exact:true}).or(page.getByRole('button',{name:'Holidays',exact:true})).filter({visible:true}).click();
   await page.locator('body[data-page="leave"] #page[aria-busy=false]').waitFor();
   await workspace(page,'Wholesale').click();await current('Wholesale');
   if(viewport.width===320){
    await page.locator('#viewTabs').waitFor();
    await page.addStyleTag({content:'#viewTabs button { font-family: "DejaVu Sans", sans-serif; }'});
    const clipped=await page.locator('#viewTabs button').evaluateAll(buttons=>buttons.filter(button=>{
     const range=document.createRange();range.selectNodeContents(button);
     const label=range.getBoundingClientRect(),box=button.getBoundingClientRect();
     return label.left<box.left-1||label.right>box.right+1||box.height<44;
    }).map(button=>button.textContent));
    assert.deepEqual(clipped,[],'Every wholesale tab label fits inside its touch target');
   }
   await page.locator('#orderDispatchScope').selectOption('upcoming');
   await page.getByRole('button',{name:'Tabs',exact:true}).click();
   await page.locator('#tabsView').waitFor();
   await workspace(page,'Kitchen Diary').click();await current('Kitchen Diary');
   await page.locator('[data-panel="week"]').waitFor();
   await workspace(page,'Rota').click();await current('Rota');
   await page.locator('body[data-page="leave"] #page[aria-busy=false]').waitFor();
   await workspace(page,'Wholesale').click();await current('Wholesale');
   await page.locator('#tabsView').waitFor();
   await page.getByRole('button',{name:'Orders',exact:true}).click();
   assert.equal(await page.locator('#orderDispatchScope').inputValue(),'upcoming');
   await page.goto(srv.base+'/orders#customers');
   await page.locator('#customersView').waitFor();
   await page.goto(srv.base+'/orders#'+sourceOrder.id);
   await page.locator('#orderDialog[open] #orderDetail').filter({hasText:'STAFF-ORDER-TEST'}).waitFor();
   await page.locator('#doneOrder').click();
   assert.equal(await page.locator('#orderDispatchScope').inputValue(),'upcoming');
   assert.deepEqual(errors,[]);
  }finally{await context.close()}
 });
}
test('an older authorized response cannot restore orders after access is revoked during a new check',{timeout:60000},async()=>{
 await setAccess(true);const context=await contextFor(STAFF,{width:1180,height:820},'dark'),page=await context.newPage();let release,arrive,held=false;const ready=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);
 try{
  await page.goto(srv.base+'/orders');await page.locator('[data-order-id]').waitFor();
  await page.route('**/api/staff-orders/orders?**',async route=>{const response=await route.fetch();if(!held&&response.status()===200){held=true;arrive();await gate}await route.fulfill({response})});
  await page.locator('#refresh').click();await ready;await setAccess(false);
  await page.evaluate(()=>{dispatchEvent(new Event('blur'));dispatchEvent(new Event('focus'))});
  await page.waitForFunction(()=>document.getElementById('accessStatus').textContent.includes('do not have access'));release();
  await page.waitForTimeout(100);assert.equal(await page.locator('[data-order-id]').count(),0);assert.equal(await page.locator('#ordersContent').isVisible(),false);
 }finally{release?.();await context.close()}
});
