import { selectWholesaleSection } from './admin-workspace-helpers.mjs';
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
 const {ctx,page,errors}=await open(320,"dark");
 try {
  const dockOverruns = () => page.locator("#tabBar button").evaluateAll(buttons => buttons.flatMap(button => {
    const bounds = button.getBoundingClientRect();
    const label = button.querySelector(".tab-label");
    const range = document.createRange();
    range.selectNodeContents(label);
    const content = [...range.getClientRects(), ...Array.from(button.querySelectorAll(".badge"), badge => badge.getBoundingClientRect())];
    const outside = content.filter(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
    if (!outside.length && button.scrollWidth <= button.clientWidth + 1) return [];
    return [{
      label: label.textContent, width: bounds.width, scrollWidth: button.scrollWidth,
      font: getComputedStyle(label).font,
      outside: outside.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
    }];
  }));
  assert.deepEqual(await dockOverruns(), [], "each dock label stays within its button");
  const widerFont = await page.addStyleTag({ content: "#tabBar .tab-label { font: 700 12px/1.2 monospace; letter-spacing: .04em }" });
  assert.deepEqual(await dockOverruns(), [], "wider fallback text stays inside each dock button and can wrap");
  await widerFont.evaluate(style => style.remove());
  await page.locator('.ov-work [data-id="prepare"]').click();
  await page.locator("#wSection").waitFor();
  assert.equal(await page.locator("#wSection .w-section-value").innerText(), "Orders");
  assert.equal(new URL(page.url()).hash, "#wholesale/orders");
  await page.getByRole("searchbox", {name:"Search wholesale orders"}).fill("Overview test");
  await page.locator(".w-active-filters", {hasText:"Overview test"}).waitFor();
  await page.locator("#wSection").press("Enter");
  const sections = page.getByRole("dialog", { name: "Wholesale sections" });
  await sections.waitFor();
  assert.deepEqual(await sections.locator("h3").allTextContents(), ["Order management", "Catalogue and reporting"]);
  assert.equal(await sections.getByRole("button", { name: "Orders", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await page.locator(".app").evaluate(element => element.inert), true);
  await page.keyboard.press("Escape");
  assert.equal(await sections.isHidden(), true);
  assert.equal(await page.locator("#wSection").evaluate(element => element === document.activeElement), true);
  await page.locator("#wSection").press("Enter");
  await sections.waitFor();
  await page.setViewportSize({ width: 1180, height: 1000 });
  await sections.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement.matches('#sideNav [data-id="orders"]'));
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.waitForFunction(() => document.activeElement.id === "wSection");
  await selectWholesaleSection(page, "invoices");
  assert.equal(await page.locator("#wSection").evaluate(element => element === document.activeElement), true);
  await page.getByRole("searchbox", {name:"Search invoices"}).waitFor();
  assert.equal(new URL(page.url()).hash, "#wholesale/invoices");
  await page.getByRole("button",{name:"Overdue",exact:true}).click();
  await page.locator('[data-act="wh-invoice-queue"][data-id="overdue"][aria-pressed="true"]').waitFor();
  await page.getByRole("searchbox",{name:"Search invoices"}).fill("OV-1");
  await page.locator('.wi-invoice-row', {hasText:"OV-1"}).waitFor();
  await page.goBack();
  await page.locator(".w-active-filters",{hasText:"Overview test"}).waitFor();
  assert.equal(await page.locator("#wSection .w-section-value").innerText(), "Orders");
  assert.equal(await page.locator('#wq').inputValue(), "Overview test");
  assert.equal(await page.locator('.w-order').count(), 2);
  await page.locator('#tabBar [data-go="overview"]').click();
  await page.locator(".admin-overview").waitFor();
  await page.locator('#tabBar [data-go="wholesale"]').click();
  await page.locator(".w-active-filters", {hasText:"Overview test"}).waitFor();
  assert.equal(await page.locator('#wq').inputValue(), "Overview test");
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

test("People beside an open profile: names keep their width, badges sit under them", async () => {
 for (const name of ["Alex Sargeant", "Bea Long-Surname-Holloway"]) {
  const r=await fetch(srv.base+"/api/admin/users",{method:"POST",headers:{cookie:admin,"content-type":"application/json"},body:JSON.stringify({name,username:name.toLowerCase().replace(/[^a-z]/g,""),role:"staff",password:"temporary-password"})});
  assert.ok(r.ok);
 }
 for (const [width,scheme] of [[1180,"dark"],[1440,"light"]]) {
  const {ctx,page,errors}=await open(width,scheme);
  try {
   await page.goto(srv.base+"/admin#people");
   await page.locator('[data-person]',{hasText:"Alex Sargeant"}).click();
   await page.locator(".person-workspace").waitFor();
   const names=await page.locator(".people-directory>.item .tx b").evaluateAll(ns=>ns.map(n=>({t:n.textContent,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})));
   // Every name gets most of the column (before the fix the badges left it a letter or two wide).
   for (const n of names) assert.ok(n.w >= 150, `${n.t} is squeezed to ${n.w}px wide`);
   for (const n of names.filter((x)=>x.t.length<40)) assert.ok(n.h < 60, `${n.t} wraps onto too many lines (${n.h}px high)`);
   const row=page.locator('.people-directory>.item',{hasText:"Alex Sargeant"});
   assert.match(await row.innerText(),/Not signed in yet/);
   if (process.env.SHOT_DIR) await page.screenshot({path:`${process.env.SHOT_DIR}/people-split-${width}-${scheme}.png`});
   assert.deepEqual(errors,[]);
  } finally { await ctx.close(); }
 }
});

test("People opens a focused profile at intermediate desktop widths", async () => {
 const {ctx,page,errors}=await open(1100,"light");
 try {
  await page.locator('#sideNav [data-go="people"]').click();
  const row=page.locator(".people-directory [data-person]").first();
  const id=await row.getAttribute("data-person");
  await row.press("Enter");
  await page.waitForFunction(() => document.activeElement.matches('[data-act="person-back"]'));
  assert.equal(await page.locator(".people-directory").isHidden(),true);
  assert.equal(await page.getByRole("searchbox",{name:"Search people"}).isHidden(),true);
  await page.getByRole("button",{name:"Back to people"}).click();
  await page.waitForFunction(id=>document.activeElement.dataset.person===id,id);
  assert.equal(await page.getByRole("searchbox",{name:"Search people"}).isVisible(),true);
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});

test("Compact Admin filters remain visible and an open site leaves its neighbour compact", async () => {
 const {ctx,page,errors}=await open(320,"dark");
 try {
  await page.locator('#tabBar [data-go="activity"]').click();
  await page.getByRole("button",{name:"Errors",exact:true}).click();
  await page.locator('[data-feed="errors"][aria-pressed="true"]').waitFor();
  const hiddenFilters=await page.getByRole("group",{name:"Activity type"}).locator("button").evaluateAll(buttons=>
   buttons.filter(button=>{const rect=button.getBoundingClientRect();return rect.left<0||rect.right>document.documentElement.clientWidth;}).map(button=>button.textContent));
  assert.deepEqual(hiddenFilters,[]);
  await page.setViewportSize({width:820,height:1000});
  await page.goto(srv.base+"/admin#sites");
  const openSite=page.locator(".site").first(), otherSite=page.locator(".site").nth(1);
  await openSite.locator("summary").click();
  assert.equal(await openSite.getAttribute("open"),"");
  assert.equal(await otherSite.getAttribute("open"),null);
  assert.ok((await openSite.boundingBox()).height>(await otherSite.boundingBox()).height*2);
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});

test("Activity search keeps the selected text and an open report through a redraw", async () => {
 const message="Activity search fixture";
 const response=await fetch(srv.base+"/api/errors",{
  method:"POST",headers:{cookie:admin,"content-type":"application/json"},
  body:JSON.stringify({app:"Admin",page:"/admin",message,detail:"Synthetic report for the Activity layout test"}),
 });
 assert.ok(response.ok);
 const {ctx,page,errors}=await open(393,"light");
 try {
  await page.locator('#tabBar [data-go="activity"]').click();
  await page.getByRole("button",{name:"Errors",exact:true}).click();
  const report=page.locator(".haserr").filter({hasText:message}).locator(".errdetail");
  await report.locator("summary").click();
  const search=page.getByRole("searchbox",{name:"Search activity"});
  const original=await search.elementHandle();
  await search.evaluate((input,value)=>{
   input.focus();
   input.value=value;
   input.setSelectionRange(1,4);
   input.dispatchEvent(new Event("input",{bubbles:true}));
  },message);
  await page.waitForFunction(input=>!input.isConnected,original);
  await original.dispose();
  assert.equal(await report.getAttribute("open"),"");
  assert.deepEqual(await search.evaluate(input=>[input===document.activeElement,input.selectionStart,input.selectionEnd]),[true,1,4]);
  assert.deepEqual(errors,[]);
 } finally { await ctx.close(); }
});
