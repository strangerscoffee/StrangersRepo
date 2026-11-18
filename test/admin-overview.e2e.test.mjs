import{test,before,after}from'node:test';import assert from'node:assert/strict';import{createRequire}from'node:module';import{mkdir}from'node:fs/promises';
import{startServer,SETUP_CODE}from'./harness.mjs';import{seedOverview}from'./admin-overview-fixture.mjs';
const{chromium}=createRequire(import.meta.url)('playwright');let srv,browser,admin;
before(async()=>{srv=await startServer();const r=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Overview Admin',username:'overview.admin',password:'admin-pass-123',code:SETUP_CODE})});assert.equal(r.status,200);admin=r.headers.getSetCookie().find(s=>/^sfbb_session=[\w-]/.test(s)).split(';')[0];await seedOverview(srv,admin,{history:210});browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});});
after(async()=>{await browser?.close();await srv?.stop();});
async function open(width,scheme){const ctx=await browser.newContext({viewport:{width,height:1000},colorScheme:scheme});const[name,value]=admin.split('=');await ctx.addCookies([{name,value,url:srv.base}]);const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(srv.base+'/admin#overview');await page.locator('#main[aria-busy="false"] .admin-overview').waitFor();return{ctx,page,errors};}
for(const width of[320,393,820,1440])for(const scheme of['light','dark'])test(`daily overview: ${width}px ${scheme}, priorities, site detail and background checks`,async()=>{
 const{ctx,page,errors}=await open(width,scheme);try{
  assert.equal(await page.locator('.ov-work [data-id="prepare"] .ov-count').innerText(),'2');assert.equal(await page.locator('.ov-today [data-id="due-prepare"] .ov-count').innerText(),'1');assert.match(await page.locator('.ov-work').innerText(),/3 kg/);const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());if(clock<'23:59')assert.match(await page.locator('.ov-alerts').innerText(),/Cover needed at Cafe/);assert.equal(await page.locator('#overview-system').getAttribute('open'),null);assert.equal(await page.locator('.ov-sites .ov-site-row').count(),3);assert(!await page.locator('.ov-sites').innerText().then(t=>t.includes('Factory')));assert.match(await page.locator('.ov-work').innerText(),/£1,240.00/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const row=page.locator('.ov-sites [data-act="overview-site"][data-id="cafe"]');await row.click();await page.locator('#scrim:not([hidden])').waitFor();assert.match(await page.locator('#sheet').innerText(),/Cafe diary/);assert.match(await page.locator('#sheet').innerText(),/23:59/);await page.keyboard.press('Escape');assert.equal(await page.locator('#scrim').isHidden(),true);assert.equal(await row.evaluate(el=>el===document.activeElement),true);
  await page.locator('#overview-system > summary').click();assert.equal(await page.locator('#rem').isVisible(),true);await page.locator('#overview-system > summary').click();assert.equal(await page.locator('#rem').isVisible(),false);assert.deepEqual(errors,[]);
  if(process.env.SHOTS){await mkdir(process.env.SHOTS,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(300);await page.screenshot({path:`${process.env.SHOTS}/admin-overview-built-${width}-${scheme}.png`,fullPage:true});}
 }finally{await ctx.close();}
});
test('overview order queues open full real-customer results, support clearing, and Ready is independent',async()=>{
 const{ctx,page,errors}=await open(1180,'light');try{
  await page.locator('[data-act="overview-wholesale"][data-id="prepare"]').click();await page.locator('.w-active-filters').waitFor();assert.match(await page.locator('.w-active-filters').innerText(),/Customer orders: to prepare/);assert.equal(await page.locator('.w-order').count(),2);
  await page.locator('.w-active-filters [data-act="wh-clear"]').click();await page.locator('.w-active-filters').waitFor({state:'detached'});assert.equal(await page.locator('.w-order').count(),200,'full list retains paging');
  await page.locator('[data-go="overview"]:visible').first().click();await page.locator('.admin-overview').waitFor();await page.locator('[data-act="overview-wholesale"][data-id="ready"]').click();await page.locator('.w-active-filters').waitFor();assert.match(await page.locator('.w-active-filters').innerText(),/ready to dispatch/);assert.equal(await page.locator('.w-order').count(),1);
  await page.locator('[data-go="overview"]:visible').first().click();await page.locator('.admin-overview').waitFor();await page.locator('.admin-overview [data-act="wh-pending"]').click();await page.locator('#wq').waitFor();assert.equal(await page.locator('.w-customer').count(),1);assert.match(await page.locator('.w-active-filters').innerText(),/Filtered results/);assert.deepEqual(errors,[]);
 }finally{await ctx.close();}
});

test("Admin mobile section links restore the active order search when going back", async () => {
 const {ctx,page,errors}=await open(393,"dark");
 try {
  await page.locator('.ov-work [data-id="prepare"]').click();
  await page.locator("#wSection").waitFor();
  assert.equal(await page.locator("#wSection").inputValue(), "orders");
  assert.equal(new URL(page.url()).hash, "#wholesale/orders");
  await page.getByRole("searchbox", {name:"Search wholesale orders"}).fill("Overview test");
  await page.locator(".w-active-filters", {hasText:"Overview test"}).waitFor();
  await page.locator("#wSection").selectOption("invoices");
  await page.getByRole("searchbox", {name:"Search invoices"}).waitFor();
  assert.equal(new URL(page.url()).hash, "#wholesale/invoices");
  await page.getByRole("button",{name:"Overdue",exact:true}).click();
  await page.locator('[data-act="wh-invoice-queue"][data-id="overdue"][aria-pressed="true"]').waitFor();
  await page.getByRole("searchbox",{name:"Search invoices"}).fill("OV-1");
  await page.locator('.wi-invoice-row', {hasText:"OV-1"}).waitFor();
  await page.goBack();
  await page.locator(".w-active-filters",{hasText:"Overview test"}).waitFor();
  assert.equal(await page.locator("#wSection").inputValue(), "orders");
  assert.equal(await page.locator('#wq').inputValue(), "Overview test");
  assert.equal(await page.locator('.w-order').count(), 2);
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});

test("Admin desktop shows a live order alongside the queue and can open its existing editor", async () => {
 const {ctx,page,errors}=await open(1440,"light");
 try {
  await page.locator('.ov-work [data-id="prepare"]').click();
  await page.locator('[data-act="wh-order"]').first().waitFor();
  const second=page.locator('[data-act="wh-order"]').nth(1);
  const id=await second.getAttribute("data-id");
  await second.click();
  const pane=page.getByRole("region",{name:"Order preview"});
  assert.match(await pane.innerText(),new RegExp(id));
  assert.equal(await page.locator('.w-order').count(),2);
  await pane.getByRole("button",{name:"Open order"}).click();
  await page.getByRole("heading",{name:"Order details",exact:true}).waitFor();
  assert.match(await page.locator('#sheet').innerText(),new RegExp(id));
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});

test("Admin profile and sheets contain long names, email addresses and keyboard focus on a small phone", async () => {
 const name="A".repeat(60);
 const email="m".repeat(64)+"@"+"x".repeat(63)+".example.invalid";
 const response=await fetch(srv.base+"/api/admin/users",{
  method:"POST",headers:{cookie:admin,"content-type":"application/json"},
  body:JSON.stringify({name,email,username:"long.profile",role:"manager",password:"temporary-password"}),
 });
 assert.ok(response.ok);
 const {user}=await response.json();
 const {ctx,page,errors}=await open(320,"dark");
 try {
  await page.locator('#tabBar [data-go="people"]').click();
  const person=page.locator(`[data-person="${user.id}"]`);
  await person.press("Enter");
  await page.locator(".person-workspace").waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const edit=page.locator('.person-workspace [data-act="edit"]');
  await edit.click();
  const sheet=page.locator("#sheet");
  await sheet.waitFor();
  assert.equal(await sheet.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  assert.equal(await page.locator(".app").evaluate(element=>element.inert),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),"sheetTitle");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(()=>document.activeElement.type),"submit");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(()=>document.activeElement.id),"fName");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#scrim").isHidden(),true);
  assert.equal(await page.locator(".app").evaluate(element=>element.inert),false);
  assert.equal(await edit.evaluate(element=>element===document.activeElement),true);
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});
