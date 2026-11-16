// Batch actions on wholesale orders: on the staff orders page and in Admin → Wholesale → Orders, select several
// orders and mark them preparing, ready or dispatched at once (dispatching asks once more). Orders only move
// forward; any that couldn't be saved stay selected. Phone and iPad, light and dark. Needs Playwright with Chromium.
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
const orders = async () => (await call("GET", "/api/admin/wholesale")).body.orders;
async function place(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const session = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body;
    ids.push((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, BUYER)).body.order.id);
  }
  return ids;
}
// Leave only the given orders open, so the list holds exactly what the test is about.
async function only(ids) {
  for (const o of await orders()) if (!ids.includes(o.id) && !["Dispatched", "Cancelled"].includes(o.status))
    await call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: "Cancelled", customerId: o.customerId, note: o.note || "" });
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const c = (await call("POST", "/api/admin/wholesale/customers", { business: "Batch Café", contact: "Bea", email: "bea@batch.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username: "batch" })).body;
  BUYER = (await call("POST", "/api/wholesale/auth/change-password", { username: "batch", password: account.temporaryPassword, newPassword: "batch-own-password" }, null)).cookie;
  const staff = (await call("POST", "/api/admin/users", { name: "Pat Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

const screens = [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]];
async function pageFor(cookie, viewport, isMobile, colorScheme) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme });
  const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
const statusOf = async (ids) => { const all = await orders(); return ids.map((id) => all.find((o) => o.id === id).status); };
async function until(check, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; }

for (const [screen, viewport, isMobile] of screens) for (const scheme of ["light", "dark"]) {
  test(`staff orders page: select orders and mark them along together on a ${screen} (${scheme})`, async () => {
    const ids = await place(3); await only(ids);
    const { ctx, p, errors } = await pageFor(STAFF, viewport, isMobile, scheme);
    try {
      await p.goto(srv.base + "/orders"); await p.locator(`[data-order-id="${ids[0]}"]`).waitFor();
      await p.getByRole("button", { name: "Select orders" }).click();
      assert.equal(await p.locator("#batchBar [data-batch]").count(), 3);
      assert.equal(await p.locator('#batchBar [data-batch="Preparing"]').isDisabled(), true, "nothing selected yet");
      for (const id of ids) await p.locator(`[data-order-id="${id}"]`).click();
      assert.equal(await p.locator('#batchBar [data-batch="Preparing"]').innerText(), "Mark preparing (3)");
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/batch-staff-${screen}-${scheme}.png`, fullPage: true });
      await p.locator('#batchBar [data-batch="Preparing"]').click();
      assert.ok(await until(async () => (await statusOf(ids)).every((s) => s === "Preparing")), "all three preparing");
      await p.waitForFunction(() => !document.querySelector("#batchBar")?.textContent.includes("Saving"));
      assert.equal(await p.locator(".picked-count").textContent(), "Tap orders to select them", "saved orders are unselected");
      // Two of them dispatched, after a second tap; the third stays as it is.
      for (const id of ids.slice(0, 2)) await p.locator(`[data-order-id="${id}"]`).click();
      await p.locator('#batchBar [data-batch="Dispatched"]').click();
      assert.match(await p.locator("#batchBar").innerText(), /Mark 2 orders dispatched\? Customers are emailed/);
      await p.locator("#batchConfirm").click();
      assert.ok(await until(async () => JSON.stringify(await statusOf(ids)) === JSON.stringify(["Dispatched", "Dispatched", "Preparing"])));
      // Orders never move backwards: a dispatched one can't be marked preparing.
      await p.locator("#statusFilters button", { hasText: "All orders" }).click();
      await p.locator(`[data-order-id="${ids[0]}"]`).waitFor();
      await p.locator(`[data-order-id="${ids[0]}"]`).click();
      assert.equal(await p.locator('#batchBar [data-batch="Preparing"]').isDisabled(), true);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scrolling");
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test(`Admin: select orders and mark them along together on a ${screen} (${scheme})`, async () => {
    const ids = await place(3); await only(ids);
    const { ctx, p, errors } = await pageFor(ADMIN, viewport, isMobile, scheme);
    try {
      await p.goto(srv.base + "/admin#wholesale");
      await p.locator('[data-act="wh-tab"][data-id="orders"]').click(); await p.locator(`[data-act="wh-order"][data-id="${ids[0]}"]`).waitFor();
      await p.locator('.w-print-bar > [data-act="wh-pick-start"]').click();
      for (const id of ids) await p.locator(`[data-act="wh-pick"][data-id="${id}"]`).click();
      assert.equal(await p.locator('[data-act="wh-batch"][data-id="Ready"]').innerText(), "Mark ready (3)");
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/batch-admin-${screen}-${scheme}.png`, fullPage: true });
      await p.locator('[data-act="wh-batch"][data-id="Ready"]').click();
      assert.ok(await until(async () => (await statusOf(ids)).every((s) => s === "Ready")), "all three ready");
      await p.waitForFunction(() => document.querySelector(".w-picked-count")?.textContent === "Tap orders to select them");
      // Dispatch asks once more; Cancel changes nothing.
      for (const id of ids.slice(0, 2)) await p.locator(`[data-act="wh-pick"][data-id="${id}"]`).click();
      await p.locator('[data-act="wh-batch"][data-id="Dispatched"]').click();
      assert.match(await p.locator("#wBatch").innerText(), /Mark 2 orders dispatched\?/);
      await p.locator('[data-act="wh-batch-cancel"]').click();
      assert.deepEqual(await statusOf(ids), ["Ready", "Ready", "Ready"], "cancel changes nothing");
      await p.locator('[data-act="wh-batch"][data-id="Dispatched"]').click(); await p.locator('[data-act="wh-batch-confirm"]').click();
      assert.ok(await until(async () => JSON.stringify(await statusOf(ids)) === JSON.stringify(["Dispatched", "Dispatched", "Ready"])));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}
