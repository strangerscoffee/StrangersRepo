// Saved order preparation remains readable, filterable and draft-safe on the real Admin page.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,ADMIN,order;
async function api(method,path,body){
 const r=await fetch(srv.base+path,{method,headers:{'content-type':'application/json',...(ADMIN?{cookie:ADMIN}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();assert.ok(r.ok,`${path}: ${JSON.stringify(data)}`);
 return {data,response:r};
}
before(async()=>{
 srv=await startServer({writeLimit:3000});
 const setup=await api('POST','/api/auth/setup',{name:'Grind Admin',username:'grind.owner',password:'grind-owner-password',code:SETUP_CODE});
 ADMIN=setup.response.headers.getSetCookie().find(v=>/^sfbb_session=[\w-]/.test(v)).split(';')[0];
 const custom=(await api('POST','/api/admin/wholesale/catalogue',{title:'Custom Coffee '+ 'Norwich Hospitality '.repeat(4),name:'Custom Coffee',origin:'Colombia',process:'Washed',notes:'Chocolate',badge:'',categories:['decaf'],prices:{quarter:1000,kilo:3000},active:true,inStock:true,grindOptions:[{id:'grind-'+crypto.randomUUID(),label:'V60 <custom>',hint:'Paper & filter',enabled:true}]})).data.product;
 const products=(await api('GET','/api/admin/wholesale')).data.products;
 const lines=[['brazil','beans',50],['house','espresso',10],['colombia','filter',6],['decaf','cafetiere',4]].map(([productId,grind,quantity])=>({productId,grind,quantity,pack:'kilo',price:products.find(p=>p.id===productId).prices.kilo}));
 lines.push({productId:custom.id,grind:custom.grindOptions[0].id,quantity:1,pack:'kilo',price:custom.prices.kilo});
 order=(await api('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),business:'Colour test café',delivery:'Roastery collection',reference:'GRIND-COLOUR',lines})).data.order;
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop()});
for(const [device,viewport]of[['phone',{width:393,height:852}],['iPad',{width:1180,height:820}],['desktop',{width:1440,height:900}]])for(const colour of['light','dark']){
 test(`grind colours ${device} ${colour}: saved labels, custom/decaf badges, safe filters and intact order drafts`,{timeout:60000},async()=>{
  const context=await browser.newContext({viewport,colorScheme:colour}),page=await context.newPage(),errors=[];let patches=0;
  const [name,value]=ADMIN.split('=');await context.addCookies([{name,value,url:srv.base}]);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/admin/wholesale/orders/**',async route=>{if(route.request().method()==='PATCH')patches++;await route.continue()});
  try{
   await page.goto(srv.base+'/admin#wholesale');await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).click();
   await page.locator('#wPackingTitle').waitFor();
   const rows=page.locator('.w-packing-line');assert.equal(await rows.count(),5);
   assert.equal(await page.locator('.w-grind-badge').filter({hasText:'Whole bean'}).count(),1);
   for(const label of ['Fine','Medium','Coarse','V60 <custom>'])assert.equal(await page.locator('.w-grind-badge').filter({hasText:label}).count(),1);
   assert.equal(await page.locator('.w-decaf-label').count(),2,'Decaf is independent of the grind, including a custom category-only coffee');
   assert.equal(await page.locator('.w-grind-hint').filter({hasText:'Paper & filter'}).count(),1);
   assert.equal(await page.locator('custom').count(),0,'custom names are escaped');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const hues=await page.locator('.w-grind-badge').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.textContent.trim(),getComputedStyle(n.closest('.w-packing-line')).getPropertyValue('--w-grind-h').trim()])));
   for(const[label,hue]of Object.entries({'Whole bean':'212',Fine:'276',Medium:'170',Coarse:'32'}))assert.equal(hues[label],hue);
   for(const box of await page.locator('.w-grind-badge').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,parent:n.closest('.w-packing-line').getBoundingClientRect().right}})))assert.ok(box.width>30&&box.left>=0&&box.right<=box.parent+1,'badges remain within each packing line');
   if(process.env.GRIND_SCREENSHOT_DIR){await mkdir(process.env.GRIND_SCREENSHOT_DIR,{recursive:true});await page.locator('#wPackingTitle').scrollIntoViewIfNeeded();await page.screenshot({path:`${process.env.GRIND_SCREENSHOT_DIR}/grinds-${device}-${colour}.png`,animations:'disabled'});}
   await page.locator('#wNote').fill('Unsaved internal draft, retained while filtering.');
   const totalText=await page.locator('.w-order-section').filter({has:page.locator('#wPackingTitle')}).locator('.kv').first().innerText();
   const filter=page.getByRole('button',{name:'Medium',exact:true});await filter.click();
   assert.equal(await filter.getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('.w-packing-line:not([hidden])').count(),1);
   assert.equal(await page.locator('.w-packing-line:not([hidden]) .w-grind-badge').innerText(),'Medium');
   assert.equal(await page.locator('#wNote').inputValue(),'Unsaved internal draft, retained while filtering.');
   assert.equal(await page.locator('.w-order-section').filter({has:page.locator('#wPackingTitle')}).locator('.kv').first().innerText(),totalText,'filtering does not change totals');
   assert.equal(patches,0,'filtering never saves an order');
   await page.getByRole('button',{name:'All grinds',exact:true}).click();assert.equal(await page.locator('.w-packing-line:not([hidden])').count(),5);
   const latest=(await api('GET','/api/admin/wholesale')).data.orders.find(o=>o.id===order.id);assert.deepEqual(latest.lines,order.lines);assert.equal(latest.note,'');
   assert.deepEqual(errors,[]);
  }finally{await context.close()}
 });
}
test('legacy saved labels and retired/custom grinds remain visible without current catalogue metadata',{timeout:45000},async()=>{
 const context=await browser.newContext(),page=await context.newPage();const[name,value]=ADMIN.split('=');await context.addCookies([{name,value,url:srv.base}]);
 await page.route('**/api/admin/wholesale',async route=>{const r=await route.fetch(),body=await r.json();const saved=body.orders.find(o=>o.id===order.id);if(saved){saved.lines=saved.lines.map(l=>{const {grindHint,decaf,...legacy}=l;return legacy});saved.lines[0].grind='moka';saved.lines[0].grindLabel='Moka Pot / Fine';}await route.fulfill({response:r,json:body})});
 try{await page.goto(srv.base+'/admin#wholesale');await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).click();await page.locator('#wPackingTitle').waitFor();assert.equal(await page.locator('.w-grind-badge').filter({hasText:'Moka Pot / Fine'}).count(),1);assert.equal(await page.locator('.w-grind-badge').filter({hasText:'V60 <custom>'}).count(),1);assert.equal(await page.locator('.w-decaf-label').count(),1,'legacy Decaf uses only its saved title/id, not current catalogue classification')}finally{await context.close()}
});
