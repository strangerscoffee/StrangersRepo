// The staff orders page for staff with wholesale orders access: quick next step, status and internal note saved
// from the order, bags to process, printing (window.print stubbed: the pages are #wPrintArea) and customers, on a
// phone and an iPad. No prices anywhere. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, STAFF, BUYER;
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
  const c = (await call("POST", "/api/admin/wholesale/customers", { business: "Lune Café", contact: "Sam Buyer", email: "sam@lune.example", phone: "01603 000000", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username: "lune" })).body;
  BUYER = (await call("POST", "/api/wholesale/auth/change-password", { username: "lune", password: account.temporaryPassword, newPassword: "lune-own-password" }, null)).cookie;
  for (const lines of [[{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], [{ productId: "campo", pack: "quarter", grind: "filter", quantity: 12, price: 500 }]]) {
    const session = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body;
    const placed = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, BUYER);
    assert.equal(placed.status, 201, placed.text);
  }
  const staff = (await call("POST", "/api/admin/users", { name: "Sam Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  assert.equal((await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true })).status, 200);
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

test("granted staff move orders along, keep notes, print and look up customers", async () => {
  for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile });
    const [n, v] = STAFF.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    await ctx.addInitScript(() => { window.print = () => { window.__printed = document.getElementById("wPrintArea")?.innerText || ""; }; });
    const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/orders"); await p.locator("[data-order-id]").first().waitFor();
    const nav = p.locator("#viewTabs");
    const navPosition = () => nav.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top + window.scrollY, width: rect.width };
    });
    const ordersNav = await navPosition();
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth) <= viewport.width + 1, `${name}: the orders toolbar fits`);

    // Quick next step from the list.
    const quick = p.locator("[data-quick]").first(), id = await quick.getAttribute("data-quick");
    const before = await quick.innerText();
    await quick.click();
    await p.waitForFunction(([id, before]) => { const b = document.querySelector(`[data-quick="${id}"]`); return b && b.innerText !== before && b.innerText !== "Saving…"; }, [id, before]);
    const after = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === id);
    assert.equal(after.status, { "Mark preparing": "Preparing", "Mark ready": "Ready", "Mark dispatched": "Dispatched" }[before], `${name}: the quick step saved`);

    // Status and internal note from the order.
    await p.locator(`[data-order-id="${id}"]`).click(); await p.locator("#editNote").waitFor();
    await p.locator("#editNote").fill(`Shelf 3 (${name})`); await p.locator("#editStatus").selectOption("Ready"); await p.locator("#saveOrder").click();
    await p.waitForFunction(() => document.querySelector("#orderDetail .pill")?.textContent === "Ready");
    const saved = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === id);
    assert.deepEqual([saved.status, saved.note], ["Ready", `Shelf 3 (${name})`]);
    assert.ok(!(await p.locator("#orderDialog").innerText()).includes("£"));
    await p.locator("#doneOrder").click();

    // Bags to process and printing.
    await p.getByRole("button", { name: "Bags to process" }).click(); await p.locator("#totalsBody").waitFor();
    await p.locator("#totalsScope button", { hasText: "New & preparing" }).click();
    await p.waitForFunction(() => document.querySelector("#totalsBody .wp-tiles,#totalsBody .wp-empty"));
    await p.locator("#closeTotals").click();
    await p.getByRole("button", { name: "Select orders" }).click();
    await p.locator("[data-order-id]").first().click(); assert.equal(await p.locator(".picked-count").textContent(), "1 selected");
    await p.getByRole("button", { name: "Print selected" }).click(); await p.waitForFunction(() => window.__printed);
    const printed = await p.evaluate(() => window.__printed);
    assert.match(printed, /Bags to process/); assert.equal((printed.match(/Packed by/g) || []).length, 1); assert.doesNotMatch(printed, /£/);
    await p.getByRole("button", { name: "Done" }).click();

    // Customers, read-only.
    await nav.getByRole("button", { name: "Tabs", exact: true }).click();
    await p.locator("#tabList[aria-busy=false]").waitFor();
    assert.deepEqual(await navPosition(), ordersNav, `${name}: navigation stays in place on Tabs`);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth) <= viewport.width + 1, `${name}: the tabs fit`);
    await nav.getByRole("button", { name: "Customers" }).click();
    await p.locator("[data-customer-id]").first().waitFor();
    assert.deepEqual(await navPosition(), ordersNav, `${name}: navigation stays in place on Customers`);
    await p.locator("[data-customer-id]").first().click();
    const customer = await p.locator("#customerDetail").innerText();
    assert.match(customer, /Lune Café/); assert.match(customer, /sam@lune\.example/); assert.match(customer, /NR3 1HN/);
    assert.equal(await p.locator("#customerDialog input,#customerDialog select,#customerDialog textarea").count(), 0);
    await p.locator("#doneCustomer").click();
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth) <= viewport.width + 1, `${name}: the customer directory fits`);
    assert.deepEqual(errors, []);
    // Put the order back for the next screen size.
    const reset = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === id);
    await call("PATCH", `/api/admin/wholesale/orders/${id}`, { ifVersion: reset.version, status: "New", customerId: reset.customerId, note: "" });
    await ctx.close();
  }
  // The new-order email's button links to /orders#<id>: it opens that order, even when it's no longer open.
  const order = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.preview === false);
  await call("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, status: "Dispatched", customerId: order.customerId, note: "" });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const [n, v] = STAFF.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage();
  await p.goto(`${srv.base}/orders#${order.id}`); await p.locator("#orderDialog[open]").waitFor();
  assert.equal(await p.locator("#orderDetail .detail-id").textContent(), order.id);
  assert.equal(new URL(p.url()).hash, "", "the link is used once");
  await ctx.close();
});

test("bag totals keep the current selection while an earlier request finishes", async () => {
  const ctx = await b.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const [name, value] = STAFF.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  let releaseOld, markOld;
  const oldRequest = new Promise(resolve => { markOld = resolve; });
  const holdOld = new Promise(resolve => { releaseOld = resolve; });
  const scope = response => new URL(response.url()).searchParams.get("status");
  await page.route("**/api/staff-orders/print?*", async route => {
    if (scope(route.request()) !== "New") { await route.continue(); return; }
    markOld();
    await holdOld;
    await route.fulfill({ status: 200, json: { orders: [] } });
  });
  try {
    await page.goto(srv.base + "/orders");
    await page.getByRole("button", { name: "Bags to process" }).click();
    await oldRequest;
    assert.equal(await page.locator("#printTotals").isDisabled(), true);
    const newScope = page.getByRole("button", { name: "New & preparing" });
    await newScope.focus();
    await newScope.press("Space");
    await page.locator("#totalsBody .wp-meta").filter({ hasText: "new and preparing orders" }).waitFor();
    assert.equal(await newScope.evaluate(node => document.activeElement === node), true);
    const response = page.waitForResponse(item => new URL(item.url()).pathname === "/api/staff-orders/print" && scope(item) === "New");
    releaseOld();
    await (await response).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.match(await page.locator("#totalsBody").innerText(), /new and preparing orders/);
    assert.equal(await page.locator("#printTotals").isEnabled(), true);
  } finally {
    releaseOld();
    await page.unrouteAll({ behavior: "wait" });
    await ctx.close();
  }
});

// A tracking link can be added while the order is still being prepared (delivery orders only), and it's saved with
// the next step, so the customer's shipped email can include it.
test("staff add a tracking link while preparing a delivery order", async () => {
  const session = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body;
  const sent = (await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Delivery", reference: "", customerVersion: session.customer.version }, BUYER)).body.order;
  const collected = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.preview === false && o.delivery === "Roastery collection" && o.id !== sent.id);
  for (const [name, viewport, isMobile, colorScheme] of [["phone", { width: 390, height: 844 }, true, "dark"], ["iPad", { width: 1180, height: 820 }, false, "light"]]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme });
    const [n, v] = STAFF.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/orders"); await p.locator(`[data-order-id="${sent.id}"]`).waitFor();
    // A collection doesn't ask for one.
    if (isMobile) await p.getByRole("combobox", { name: "Order status" }).selectOption("all");
    else await p.locator("#statusFilters button", { hasText: "All orders" }).click();
    await p.locator(`[data-order-id="${collected.id}"]`).click(); await p.locator("#editNote").waitFor();
    assert.equal(await p.locator("#trackingField").isHidden(), true, `${name}: no tracking box for a collection`);
    await p.locator("#doneOrder").click();
    // A delivery does, from the start.
    await p.locator(`[data-order-id="${sent.id}"]`).click(); await p.locator("#editNote").waitFor();
    assert.equal(await p.locator("#trackingField").isVisible(), true, `${name}: tracking box while ${(await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === sent.id).status}`);
    assert.match(await p.locator("#trackingField").innerText(), /goes in the customer's shipped email/);
    const link = `https://track.example/${name}`;
    await p.locator("#editTracking").fill(link);
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/staff-tracking-${name}.png` });
    await p.locator("#saveOrder").click();
    await p.waitForFunction((l) => document.querySelector("#orderDetail a.tracking")?.href === l, link);
    assert.equal((await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === sent.id).trackingUrl, link);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("wide Staff and Admin desks share packing and only dispatch after confirmation",{timeout:90000},async()=>{
  const session=(await call("GET","/api/wholesale/session",undefined,BUYER)).body;
  const {order}= (await call("POST","/api/wholesale/orders",{
    requestId:crypto.randomUUID(),delivery:"Delivery",reference:"PACK-DESK",customerVersion:session.customer.version,
    lines:[{productId:"brazil",pack:"kilo",grind:"beans",quantity:6,price:1800},{productId:"campo",pack:"quarter",grind:"filter",quantity:4,price:500}],
    customerNote:"Leave at the side door."
  },BUYER)).body;
  async function browserPage(cookie,path,scheme,width=1920){
    const context=await b.newContext({viewport:{width,height:1080},colorScheme:scheme});
    const [name,value]=cookie.split("=");await context.addCookies([{name,value,url:srv.base}]);
    const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(srv.base+path);return {context,page,errors};
  }
  const read=async()=> (await call("GET","/api/admin/wholesale/orders?q="+order.id)).body.orders[0];
  const phone=await browserPage(STAFF,"/orders","dark",390);
  try{
    const {page}=phone;
    await page.locator(`[data-order-id="${order.id}"]`).click();
    await page.locator("#editNote").fill("Keep this draft while packing");
    await page.getByRole("button",{name:"Pack order",exact:true}).click();
    await page.locator("#mobilePacking").getByRole("heading",{name:"Pack by coffee"}).waitFor();
    assert.equal(await page.locator("#orderEdit").isHidden(),true);
    await page.getByRole("button",{name:"Back to details",exact:true}).click();
    assert.equal(await page.locator("#editNote").inputValue(),"Keep this draft while packing");
    assert.deepEqual(phone.errors,[]);
  }finally{await phone.context.close();}
  const staff=await browserPage(STAFF,"/orders","dark");
  try{
    const {page}=staff,desk=page.locator("#packingDesk"),totals=page.locator("#deskBagTotals");
    await page.locator(`[data-order-id="${order.id}"]`).click();
    await desk.getByRole("button",{name:"Start preparing"}).click();
    await desk.getByRole("checkbox").first().waitFor();
    assert.equal(await desk.getByRole("button",{name:"Mark ready"}).isDisabled(),true);
    await desk.getByRole("checkbox").first().check();
    await page.waitForFunction(()=>document.querySelector("#packingDesk [data-pack-line='0']:enabled")?.checked);
    assert.equal(await desk.getByRole("button",{name:"Mark ready"}).isDisabled(),true);
    assert.deepEqual((await read()).packedLines,[0]);
    await totals.getByRole("button",{name:"Packed",exact:true}).click();
    assert.match(await totals.innerText(),new RegExp(`${order.lines[0].quantity} bags`));
    assert.doesNotMatch(await page.locator("#orderWorkspace").innerText(),/£/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.SHOT_DIR)await page.screenshot({path:`${process.env.SHOT_DIR}/staff-packing-desktop.png`,animations:"disabled"});
    assert.deepEqual(staff.errors,[]);
  }finally{await staff.context.close();}
  const admin=await browserPage(ADMIN,"/admin#wholesale/orders","light");
  try{
    const {page}=admin;
    await page.getByRole("button",{name:/^To pack/}).click();
    await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).click();
    const preview=page.getByRole("region",{name:"Order preview"});
    if(process.env.SHOT_DIR)await page.screenshot({path:`${process.env.SHOT_DIR}/admin-order-queue-desktop.png`,animations:"disabled"});
    await preview.getByRole("button",{name:"Pack order",exact:true}).click();
    const desk=page.getByRole("region",{name:"Order processing"});
    assert.equal(await desk.getByRole("checkbox").first().isChecked(),true);
    await desk.getByRole("checkbox").nth(1).check();
    await page.waitForFunction(()=>document.querySelector("#wPackChecklist [data-pack-next]:enabled"));
    if(process.env.SHOT_DIR)await page.screenshot({path:`${process.env.SHOT_DIR}/admin-packing-desktop.png`,animations:"disabled"});
    await desk.getByRole("button",{name:"Mark ready"}).click();
    await desk.getByRole("button",{name:"Review dispatch"}).waitFor();
    assert.equal((await read()).status,"Ready");
    assert.equal(await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).count(),0,"the ready order leaves the To pack queue but stays in the inspector");
    await desk.getByRole("button",{name:"Review dispatch"}).click();
    await page.locator("#wDispatchOrderForm").waitFor();
    await page.locator("#wDispatchOrderForm").getByRole("button",{name:"Cancel",exact:true}).click();
    assert.equal((await read()).status,"Ready");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(admin.errors,[]);
  }finally{await admin.context.close();}
  const dispatch=await browserPage(STAFF,"/orders","light",1440);
  try{
    const {page}=dispatch,desk=page.locator("#packingDesk");
    await page.locator(`[data-order-id="${order.id}"]`).click();
    await desk.getByRole("button",{name:"Review dispatch"}).click();
    await page.locator("#dispatchDialog[open]").waitFor();
    assert.equal((await read()).status,"Ready");
    await page.locator("#deskTracking").fill("https://track.example/pack-desk");
    await page.getByRole("button",{name:"Mark dispatched",exact:true}).click();
    await page.locator("#dispatchDialog").waitFor({state:"hidden"});
    const latest=await read();
    assert.deepEqual([latest.status,latest.trackingUrl],["Dispatched","https://track.example/pack-desk"]);
    assert.deepEqual(dispatch.errors,[]);
  }finally{await dispatch.context.close();}
});

test("Staff Wholesale dialogs keep their controls and keyboard focus on a small screen", async () => {
  const business = "LongWholesaleBusiness".repeat(5);
  await call("POST", "/api/admin/wholesale/customers", {
    business, contact: "Tab holder", status: "Active", autoTab: true,
  });
  const context = await b.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const [name, value] = STAFF.split("=");
  await context.addCookies([{ name, value, url: srv.base }]);
  await context.addInitScript(() => {
    const repeat = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay !== 15000) return repeat(callback, delay, ...args);
      window.refreshOrders = callback;
      return repeat(callback, 60000, ...args);
    };
  });
  let finishRefresh;
  try {
    const page = await context.newPage();
    await page.goto(srv.base + "/orders");
    const row = page.locator("#orderList [data-order-id]").first();
    await row.press("Enter");
    const details = page.locator("#orderDialog .dialog-body");
    await details.waitFor();
    assert.ok(await details.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    }) > 0, "order details can be scrolled");
    await page.keyboard.press("Escape");
    assert.equal(await row.evaluate(element => element === document.activeElement), true);
    await row.press("Enter");
    await details.waitFor();
    assert.equal(await details.evaluate(element => element.scrollTop), 0, "reopened details start at the summary");
    assert.equal(await page.evaluate(() => document.activeElement.id), "orderTitle");
    let startedRefresh;
    const waitingForRefresh = new Promise(resolve => { startedRefresh = resolve; });
    const refreshCanFinish = new Promise(resolve => { finishRefresh = resolve; });
    const ordersRequest = "**/api/staff-orders/orders?**";
    await page.route(ordersRequest, async route => {
      startedRefresh();
      await refreshCanFinish;
      await route.continue();
    });
    await page.evaluate(() => { window.refreshOrders(); });
    await waitingForRefresh;
    await page.keyboard.press("Escape");
    finishRefresh();
    await page.locator('#orderList[aria-busy="false"]').waitFor();
    assert.equal(await page.locator("#orderDialog[open]").count(), 0, "background refresh does not reopen dismissed details");
    await page.unroute(ordersRequest);

    const newOrder = page.locator("#newOrder");
    await newOrder.press("Enter");
    const cancel = page.locator("#newOrderFoot").getByRole("button", { name: "Cancel", exact: true });
    await page.locator("#newOrderForm .no-found button").first().waitFor();
    await cancel.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "closeNewOrder");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await newOrder.evaluate(element => element === document.activeElement), true);

    await page.locator('#viewTabs [data-view="tabs"]').click();
    await page.locator(".tab-card", { hasText: business }).press("Enter");
    const tab = page.locator("#tabDialog[open]");
    assert.equal(await tab.locator("#tabTitle").textContent(), business);
    assert.equal(await tab.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const close = element.querySelector("#closeTab").getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth + 1 && close.right <= bounds.right;
    }), true, "a long tab title leaves the close button inside the dialog");
    const tabWidth = (await tab.boundingBox()).width;
    await page.keyboard.press("Escape");
    await page.locator("#sectionNewOrder").press("Enter");
    assert.equal((await page.locator("#newOrderDialog[open]").boundingBox()).width, tabWidth, "phone dialogs use the same side gutters");
  } finally {
    finishRefresh?.();
    await context.close();
  }
});
