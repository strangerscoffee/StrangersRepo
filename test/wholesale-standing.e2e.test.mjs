// Standing orders in a browser: Admin sets a dispatch day and a repeat on a customer order, edits its bags, marks it
// dispatched and finds the next run; the customer sees the day, the schedule and the change on My orders. On a desktop,
// and on a phone and an iPad in light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, A, orderId;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const ukDay = (ms) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(ms));
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/standing-${name}.png` });
async function page(cookie, viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, ...extra });
  const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
async function placeOrder() {
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  const r = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Delivery", reference: "Weekly", customerVersion: session.customer.version }, A);
  assert.equal(r.status, 201, r.text); return r.body.order.id;
}
async function openOrder(p, id) {
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator(`[data-act="wh-order"][data-id="${id}"]`).click();
  await p.locator("#sheet .w-order-sheet").waitFor();
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "standing.buyer", password: "standing-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Standing", contact: "Sam", email: "standing@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  await call("PUT", "/api/wholesale/account", { ifVersion: session.customer.version, address: "1 Market Place, Norwich", postcode: "NR2 1AA" }, A);
  orderId = await placeOrder();
});
after(async () => { await b?.close(); await srv?.stop(); });

test("Admin: dispatch day, standing order, edit bags, dispatch makes the next run; the customer sees it", async () => {
  const { ctx, p, errors } = await page(ADMIN, { width: 1280, height: 900 });
  await openOrder(p, orderId);
  const day = ukDay(Date.now() + 3 * 864e5);
  await p.locator("#wDispatchDate").fill(day);
  await p.locator("#wStanding").check();
  await p.locator("#wEvery").selectOption("2");
  // Edit bags keeps what was typed on the order.
  await p.locator('#sheet [data-sheet="edit-lines"]').click();
  await p.locator(".w-lines-sheet").waitFor();
  await p.locator("[data-line-qty='0']").fill("4");
  await p.locator("#wAddCoffee").selectOption({ label: await p.locator("#wAddCoffee option").nth(1).textContent() });
  await p.locator("#wAddQty").fill("3");
  await p.locator('#sheet [data-sheet="add-line"]').click();
  assert.equal(await p.locator(".w-edit-line").count(), 2);
  assert.match(await p.locator("#wLinesTotal").innerText(), /7 bags/);
  await p.locator('.w-lines-sheet button[type="submit"]').click();
  await p.locator("#sheet .w-order-sheet").waitFor();
  assert.equal(await p.locator("#wDispatchDate").inputValue(), day, "the typed dispatch day came back");
  assert.equal(await p.locator("#wStanding").isChecked(), true);
  assert.match(await p.locator(".w-amended").innerText(), /Bags changed by Admin/);
  assert.equal(await p.locator(".w-packing-line").count(), 2);
  await p.locator('#sheet button[type="submit"]').click();
  await p.locator("#sheet .w-order-sheet").waitFor({ state: "detached" });
  const row = p.locator(`[data-act="wh-order"][data-id="${orderId}"]`);
  await row.locator(".w-dispatch").waitFor(); // the list reloads after saving
  assert.match(await row.innerText(), /Dispatch .* · Standing order, every 2 weeks/);
  // Mark it dispatched from the order: the next run is made for two weeks on.
  await row.click(); await p.locator("#wStatus").selectOption("Dispatched");
  await p.locator('#sheet button[type="submit"]').click();
  await p.locator(".toast, #toast", { hasText: "next standing order run is ready" }).first().waitFor();
  const orders = (await call("GET", "/api/admin/wholesale")).body.orders;
  const next = orders.find((o) => o.previousRunId === orderId);
  assert.ok(next); assert.equal(next.status, "New"); assert.equal(next.dispatchDate, ukDay(Date.parse(day + "T12:00:00Z") + 14 * 864e5));
  assert.equal(next.packs, 7);
  await p.locator(`[data-act="wh-order"][data-id="${next.id}"]`).click();
  assert.match(await p.locator(".w-schedule").innerText(), /run 2/);
  assert.deepEqual(errors, []);
  await ctx.close();

  // The customer's My orders.
  const c = await page(A, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await c.p.goto(srv.base + "/wholesale-preview/"); await c.p.locator(".product-card").first().waitFor();
  await c.p.locator("#my-orders").click();
  const card = c.p.locator(`[data-history-order="${orderId}"]`); await card.waitFor();
  assert.match(await card.innerText(), /Dispatch day: .*Standing order, every 2 weeks/);
  assert.match(await card.innerText(), /Updated by Strangers on/);
  assert.doesNotMatch(await card.innerText(), /Admin/);
  await c.p.locator(`[data-history-order="${next.id}"]`).waitFor();
  await shot(c.p, "customer-phone");
  assert.deepEqual(c.errors, []);
  await c.ctx.close();
});

test("on a phone and an iPad, light and dark", async () => {
  const id = await placeOrder();
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(ADMIN, viewport, { isMobile: true, hasTouch: true, colorScheme });
    await openOrder(p, id);
    await p.locator(".w-schedule").scrollIntoViewIfNeeded();
    await shot(p, `order-${name}-${colorScheme}`);
    await p.locator('#sheet [data-sheet="edit-lines"]').click(); await p.locator(".w-lines-sheet").waitFor();
    await shot(p, `lines-${name}-${colorScheme}`);
    const overflow = await p.evaluate(() => { const s = document.querySelector("#sheet"); return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, s.scrollWidth - s.clientWidth); });
    assert.ok(overflow <= 1, `${name} ${colorScheme}: nothing scrolls sideways (${overflow}px)`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
