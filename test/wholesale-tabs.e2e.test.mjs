// Customer tabs on the staff Wholesale orders page: put an order on a customer's tab from the order, watch the tab
// fill towards 6 kg (ready to clear at 6 kg), clear it (or early), and see it in Recently cleared; Admin's automatic
// tab switch and the order sheet's Put on tab. Phone and iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, STAFF, lune, shop;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function customer(business, username, extra = {}) {
  const c = (await call("POST", "/api/admin/wholesale/customers", { business, contact: "Sam", email: username + "@x.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active", ...extra })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username })).body;
  const cookie = (await call("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-own-password" }, null)).cookie;
  return { c, cookie };
}
async function order(who, kilos) {
  const session = (await call("GET", "/api/wholesale/session", undefined, who.cookie)).body;
  const r = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: kilos, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, who.cookie);
  assert.equal(r.status, 201, r.text); return r.body.order;
}
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/tabs-${name}.png` });
async function staffPage(viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, ...extra });
  const [n, v] = STAFF.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(srv.base + "/orders"); await p.locator("#orderList .order-row").first().waitFor();
  return { ctx, p, errors };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  lune = await customer("Lune Café", "lune");
  shop = await customer("Strangers ASG", "asg", { autoTab: true });
  const staff = (await call("POST", "/api/admin/users", { name: "Sam Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
  await order(shop, 2); await order(shop, 3);
  await order(lune, 4);
});
after(async () => { await b?.close(); await srv?.stop(); });

test("put an order on a tab, fill it to 6 kg, clear it", async () => {
  const { ctx, p, errors } = await staffPage({ width: 1180, height: 820 });
  // Lune's order isn't on a tab: put it on from the order.
  await p.locator("#orderList .order-row", { hasText: "Lune Café" }).click();
  await p.locator("#tabToggle", { hasText: "Put on tab" }).click();
  await p.locator("#tabToggle", { hasText: "Take off tab" }).waitFor();
  await p.locator("#doneOrder").click();
  assert.match(await p.locator("#orderList .order-row", { hasText: "Lune Café" }).innerText(), /On tab/);
  // Tabs: ASG (automatic) at 5 kg, Lune at 4 kg; neither ready.
  await p.locator('#viewTabs [data-view="tabs"]').click();
  const asg = p.locator(".tab-card", { hasText: "Strangers ASG" });
  await asg.waitFor();
  assert.match(await asg.innerText(), /5 kg\s*of 6 kg/); assert.match(await asg.innerText(), /1 kg to go/);
  assert.equal(await p.locator(".tab-card.ready").count(), 0);
  // Another ASG order takes it past 6 kg: ready, first, highlighted.
  await order(shop, 1);
  await p.locator("#refreshTabs").click();
  await p.locator(".tab-card.ready", { hasText: "Strangers ASG" }).waitFor();
  assert.match(await p.locator(".tab-card").first().innerText(), /Strangers ASG[\s\S]*Ready to clear[\s\S]*6 kg/);
  assert.doesNotMatch(await p.locator("#tabsView").innerText(), /£/, "no money on the staff page");
  await shot(p, "list-ipad");
  // Clear it (two steps), then it's in Recently cleared and the tab starts again.
  await p.locator(".tab-card", { hasText: "Strangers ASG" }).click();
  await p.locator("#tabDialog[open]").waitFor();
  assert.match(await p.locator("#tabDetail").innerText(), /ready to clear/);
  await shot(p, "detail-ipad");
  await p.locator("#clearTab").click(); await p.locator("#confirmClear").click();
  await p.locator("#tabDialog[open]").waitFor({ state: "detached" });
  await p.locator("#clearedList", { hasText: "Strangers ASG" }).waitFor();
  assert.match(await p.locator("#clearedList").innerText(), /Cleared .* by Sam Packer[\s\S]*6 kg/);
  assert.match(await p.locator(".tab-card", { hasText: "Strangers ASG" }).innerText(), /Nothing on the tab yet/);
  // Lune's tab, cleared early.
  await p.locator(".tab-card", { hasText: "Lune Café" }).click();
  await p.locator("#clearTab", { hasText: "Clear tab early" }).click(); await p.locator("#confirmClear").click();
  await p.locator("#clearedList .cleared-row", { hasText: "Lune Café" }).waitFor();
  assert.match(await p.locator("#clearedList .cleared-row", { hasText: "Lune Café" }).innerText(), /Early/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Admin: automatic tabs on the customer and Put on tab in the order", async () => {
  const lo = await order(lune, 2);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator(`[data-act="wh-order"][data-id="${lo.id}"]`).click();
  await p.locator('#sheet [data-sheet="tab-toggle"]', { hasText: "Put on tab" }).click();
  await p.locator('#sheet [data-sheet="tab-toggle"]', { hasText: "Take off tab" }).waitFor();
  assert.match(await p.locator("#wTabTitle").locator("xpath=../..").innerText(), /added by Admin/);
  await p.locator('#sheet [data-sheet="close"]').first().click();
  await p.locator('[data-act="wh-tab"][data-id="customers"]').first().click();
  await p.locator('[data-act="wh-customer"]', { hasText: "Lune Café" }).click();
  await p.locator("#wAutoTab").check();
  await p.locator('#wCustomerForm button[type="submit"]').click();
  await p.locator('[data-act="wh-customer"]', { hasText: "Lune Café" }).filter({ hasText: "On a tab" }).waitFor();
  assert.equal((await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.business === "Lune Café").autoTab, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("on a phone and an iPad, light and dark", async () => {
  await order(shop, 4);
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await staffPage(viewport, { isMobile: true, hasTouch: true, colorScheme });
    await p.locator('#viewTabs [data-view="tabs"]').click(); await p.locator(".tab-card").first().waitFor();
    await shot(p, `${name}-${colorScheme}`);
    await p.locator(".tab-card").first().click(); await p.locator("#tabDialog[open]").waitFor();
    await shot(p, `${name}-${colorScheme}-detail`);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
