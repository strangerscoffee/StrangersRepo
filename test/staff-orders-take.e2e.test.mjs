// Taking an order for a customer on the staff orders page (it came by email, phone or at the door): find the
// customer, choose coffees, bag sizes, grinds and how many, how it came in, and place it; on a phone and an iPad,
// light and dark. No prices on the page. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, STAFF;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await call("POST", "/api/admin/wholesale/customers", { business: "Lune Café", contact: "Sam Buyer", email: "sam@lune.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" });
  const staff = (await call("POST", "/api/admin/users", { name: "Sam Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [name, viewport, isMobile] of [["small phone", { width: 360, height: 740 }, true], ["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`staff take an order for a customer on a ${name} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = STAFF.split("=");
    await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(srv.base + "/orders");
    await page.locator("#newOrder").click();
    const dialog = page.locator("#newOrderDialog");
    await dialog.locator("#noSearch").fill("Lune");
    await dialog.locator(".order-row", { hasText: "Lune Café" }).click();
    await dialog.locator(".no-line select").first().waitFor();
    // The "How it came in" choices sit inside their track, don't overlap, and show their whole word.
    const boxes = await dialog.locator(".no-seg").first().evaluate((f) => { const t = f.querySelector(".seg").getBoundingClientRect(); return [...f.querySelectorAll(".seg button")].map((b) => { const r = b.getBoundingClientRect(); return { r: [r.left, r.top, r.right, r.bottom], whole: b.scrollWidth <= b.clientWidth, inside: r.left >= t.left - 0.5 && r.right <= t.right + 0.5 && r.top >= t.top - 0.5 && r.bottom <= t.bottom + 0.5 }; }); });
    const overlap = (a, b) => a.r[0] < b.r[2] - 0.5 && b.r[0] < a.r[2] - 0.5 && a.r[1] < b.r[3] - 0.5 && b.r[1] < a.r[3] - 0.5;
    assert.ok(boxes.every((b, i) => b.inside && b.whole && boxes.every((c, j) => i === j || !overlap(b, c))), JSON.stringify(boxes));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/take-top-${name}-${scheme}.png` });
    await dialog.getByRole("button", { name: "In person" }).click();
    await dialog.locator('.no-line input[type="number"]').first().fill("3");
    await dialog.getByRole("button", { name: "Add another coffee" }).click();
    assert.equal(await dialog.locator(".no-line").count(), 2);
    await dialog.locator('.no-line input[type="number"]').nth(1).fill("2");
    assert.match(await dialog.locator("#noTotals").innerText(), /^5 bags · 5 kg/);
    await dialog.locator("#noTab").check();
    assert.ok(!/£/.test(await dialog.innerText()), "no prices");
    assert.equal(await page.evaluate(() => { const d = document.querySelector("#newOrderDialog"); return d.scrollWidth <= d.clientWidth + 1; }), true, "no sideways scrolling");
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/take-${name}-${scheme}.png` });
    await dialog.locator("#placeOrder").click();
    await page.locator("#orderDialog[open]").waitFor();
    assert.match(await page.locator("#orderDetail").innerText(), /Lune Café[\s\S]*Came in\s*In person/);
    assert.match(await page.locator("#tabToggle").innerText(), /Take off tab/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

for(const [mode,viewport,colorScheme] of [['lost',{width:390,height:844},'light'],['unsent',{width:820,height:1180},'dark'],['malformed',{width:1180,height:820},'light'],['lost',{width:390,height:844},'dark'],['unsent',{width:820,height:1180},'light']])test(`staff order recovery ${mode} ${colorScheme}: frozen identity-bound attempt survives reload without duplicates`,async()=>{
 const ctx=await b.newContext({viewport,colorScheme,isMobile:viewport.width<600,hasTouch:true});const [name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);
 const page=await ctx.newPage(),reference='recovery-'+mode+'-'+crypto.randomUUID();let intercepted=false;const requests=[];
 try{
  await page.route('**/api/staff-orders/orders*',async route=>{
   if(route.request().method()!=='POST'){await route.continue();return;}
   requests.push(route.request().postDataJSON());
   if(!intercepted){intercepted=true;if(mode==='unsent'){await route.abort('failed');return;}const response=await route.fetch();assert.equal(response.status(),201);if(mode==='malformed')await route.fulfill({status:201,contentType:'application/json',body:'{}'});else await route.abort('failed');}
   else await route.continue();
  });
  await page.goto(srv.base+'/orders');await page.locator('#newOrder').click();const dialog=page.locator('#newOrderDialog');
  await dialog.locator('#noSearch').fill('Lune');await dialog.locator('.order-row',{hasText:'Lune Café'}).click();
  await dialog.locator('.no-line input[type="number"]').first().fill('3');await dialog.locator('#noRef').fill(reference);await dialog.locator('#placeOrder').click();
  await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('input,select,textarea').count(),0,'uncertain payload cannot be edited');
  assert.doesNotMatch(await dialog.innerText(),/\bnull\b/,'optional recovery controls render no placeholder text');
  if(process.env.SHOT_DIR)await page.screenshot({path:`${process.env.SHOT_DIR}/pending-${mode}-${colorScheme}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('sc.staffOrders.pending.')).length),1);
  await page.reload();await page.locator('#newOrderDialog[open]').waitFor();await dialog.getByRole('heading',{name:'Check submitted order'}).waitFor();
  await dialog.getByRole('button',{name:'Check submitted order',exact:true}).click();await page.locator('#orderDialog[open]').waitFor();
  const matching=(await call('GET','/api/admin/wholesale')).body.orders.filter(o=>o.reference===reference);assert.equal(matching.length,1);assert.equal(matching[0].lines[0].quantity,3);
  if(mode==='unsent'){assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);}else assert.equal(requests.length,1,'owned receipt recovers without a second POST');
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('sc.staffOrders.pending.')).length),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.SHOT_DIR)await page.screenshot({path:`${process.env.SHOT_DIR}/recovery-${mode}-${colorScheme}.png`,fullPage:true});
 }finally{await ctx.close();}
});

test('staff order storage failure blocks POST and retains the editable draft',async()=>{
 const ctx=await b.newContext({viewport:{width:390,height:844}});const [name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);
 await ctx.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('sc.staffOrders.pending.'))throw new DOMException('Storage blocked','QuotaExceededError');return original.call(this,k,v);};});
 const page=await ctx.newPage();let posts=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/staff-orders/orders')posts++;});
 try{await page.goto(srv.base+'/orders');await page.locator('#newOrder').click();const d=page.locator('#newOrderDialog');await d.locator('#noSearch').fill('Lune');await d.locator('.order-row',{hasText:'Lune Café'}).click();await d.locator('.no-line input[type="number"]').first().fill('2');await d.locator('#placeOrder').click();await d.getByRole('alert').filter({hasText:'could not save order recovery'}).waitFor();assert.equal(posts,0);assert.equal(await d.locator('.no-line input[type="number"]').first().inputValue(),'2');}finally{await ctx.close();}
});

test('pending staff recovery stays with its original account across a shared-browser account switch',async()=>{
 const ctx=await b.newContext({viewport:{width:820,height:1180},colorScheme:'dark'}),[name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);
 const page=await ctx.newPage(),reference='owner-recovery-'+crypto.randomUUID();let posts=0;
 try{
  await page.route('**/api/staff-orders/orders',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}posts++;await route.fetch();await route.abort('failed');});
  await page.goto(srv.base+'/orders');await page.locator('#newOrder').click();const d=page.locator('#newOrderDialog');await d.locator('#noSearch').fill('Lune');await d.locator('.order-row',{hasText:'Lune Café'}).click();await d.locator('#noRef').fill(reference);await d.locator('#placeOrder').click();await d.getByRole('alert').waitFor();
  const saved=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('sc.staffOrders.pending.')));assert.equal(saved.length,1);
  const [an,av]=ADMIN.split('=');await ctx.addCookies([{name:an,value:av,url:srv.base}]);await page.goto(srv.base+'/orders');await page.locator('#newOrder').waitFor();assert.equal(await d.isVisible(),false,'another account cannot see the pending summary');assert.equal(posts,1);
  assert.equal(await page.evaluate(k=>localStorage.getItem(k)!==null,saved[0]),true,'original work is retained');
  await ctx.addCookies([{name,value,url:srv.base}]);await page.goto(srv.base+'/orders');await page.locator('#newOrderDialog[open]').waitFor();await d.getByRole('button',{name:'Check submitted order',exact:true}).click();await page.locator('#orderDialog[open]').waitFor();assert.equal(posts,1,'recovered receipt sends no second POST');
 }finally{await ctx.close();}
});

test('an owned deleted pending order is acknowledged without recreating it',async()=>{
 const ctx=await b.newContext({viewport:{width:390,height:844}}),[name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);const page=await ctx.newPage(),reference='removed-recovery-'+crypto.randomUUID();let posts=0;
 try{
  await page.route('**/api/staff-orders/orders',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}posts++;await route.fetch();await route.abort('failed');});
  await page.goto(srv.base+'/orders');await page.locator('#newOrder').click();const d=page.locator('#newOrderDialog');await d.locator('#noSearch').fill('Lune');await d.locator('.order-row',{hasText:'Lune Café'}).click();await d.locator('#noRef').fill(reference);await d.locator('#placeOrder').click();await d.getByRole('alert').waitFor();
  const order=(await call('GET','/api/admin/wholesale')).body.orders.find(o=>o.reference===reference);await call('DELETE','/api/admin/wholesale/orders/'+order.id,{ifVersion:order.version});
  await page.reload();await page.locator('#newOrderDialog[open]').waitFor();await d.getByRole('button',{name:'Check submitted order',exact:true}).click();await d.getByRole('button',{name:'Acknowledge removal'}).click();assert.equal(posts,1);assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('sc.staffOrders.pending.')).length),0);
 }finally{await ctx.close();}
});

test('an unsent request rejected after stock changes can be closed without a late duplicate',async()=>{
 const ctx=await b.newContext({viewport:{width:390,height:844}}),[name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);const page=await ctx.newPage();let submitted,drop=true,changed;
 try{
  await page.route('**/api/staff-orders/orders',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}submitted=route.request().postDataJSON();if(drop){drop=false;await route.abort('failed');}else await route.continue();});
  await page.goto(srv.base+'/orders');await page.locator('#newOrder').click();const d=page.locator('#newOrderDialog');await d.locator('#noSearch').fill('Lune');await d.locator('.order-row',{hasText:'Lune Café'}).click();await d.locator('#placeOrder').click();await d.getByRole('alert').waitFor();
  const product=(await call('GET','/api/admin/wholesale')).body.products.find(p=>p.id===submitted.lines[0].productId);changed=(await call('PUT','/api/admin/wholesale/catalogue/'+product.id,{ifVersion:product.version,prices:product.prices,active:true,inStock:false})).body.product;
  await d.getByRole('button',{name:'Check submitted order',exact:true}).click();await d.getByRole('alert').filter({hasText:'out of stock'}).waitFor();
  await d.getByRole('button',{name:'Close if unplaced',exact:true}).click();await d.getByRole('button',{name:'Confirm close if unplaced',exact:true}).click();await page.locator('#newOrderDialog').waitFor({state:'hidden'});
  await call('PUT','/api/admin/wholesale/catalogue/'+changed.id,{ifVersion:changed.version,prices:changed.prices,active:true,inStock:true});changed=null;
  const late=await fetch(srv.base+'/api/staff-orders/orders',{method:'POST',headers:{'content-type':'application/json',cookie:STAFF},body:JSON.stringify(submitted)});assert.equal(late.status,409);
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('sc.staffOrders.pending.')).length),0);
  await page.locator('#newOrder').click();await d.locator('#noSearch').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{if(changed)await call('PUT','/api/admin/wholesale/catalogue/'+changed.id,{ifVersion:changed.version,prices:changed.prices,active:true,inStock:true});await ctx.close();}
});
