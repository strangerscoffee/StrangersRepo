import { openWholesaleOrders } from './wholesale-ui-helpers.mjs';
// Changing and skipping standing order deliveries in a browser: the customer on My orders (change the bags for this
// delivery only, or skip it), and wholesale staff on the staff orders page (change bags, skip). On a phone and an
// iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, A, STAFF;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const ukDay = (ms) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(ms));
async function page(cookie, viewport, isMobile, scheme) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
  const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
async function standing() {
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  const price = (await call("GET", "/api/wholesale/catalogue", undefined, A)).body.products.find((p) => p.id === "campo").prices.kilo;
  const id = (await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price }], delivery: "Roastery collection", customerVersion: session.customer.version }, A)).body.order.id;
  const o = (await call("GET", "/api/admin/wholesale")).body.orders.find((r) => r.id === id);
  await call("PATCH", `/api/admin/wholesale/orders/${id}`, { ifVersion: o.version, status: "New", customerId: o.customerId, note: "", trackingUrl: "", schedule: { dispatchDate: ukDay(Date.now() + 3 * 864e5), every: 1 } });
  return id;
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "weekly.buyer", password: "weekly-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Weekly", contact: "Sam", email: "weekly@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  const staff = (await call("POST", "/api/admin/users", { name: "Pat Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`customers change and skip standing deliveries on a ${name} (${scheme})`, async () => {
    const changeId = await standing(), skipId = await standing();
    const { ctx, p, errors } = await page(A, viewport, isMobile, scheme);
    await p.goto(srv.base + "/wholesale/"); await p.locator(".product-card").first().waitFor();
    await openWholesaleOrders(p);
    await p.locator(`[data-standing-change="${changeId}"]`).click();
    await p.locator("#standing-dialog[open]").waitFor();
    await p.locator('[data-standing-line="0"]').fill("4");
    await p.locator("#standing-add").click(); // one more coffee
    await p.locator('[data-standing-line="1"]').fill("2");
    assert.match(await p.locator("#standing-total").innerText(), /bags/);
    assert.equal(await p.locator('#standing-form input[name="scope"][value="once"]').isChecked(), true, "this delivery only by default");
    assert.equal(await p.evaluate(() => { const d = document.querySelector("#standing-dialog"); return d.scrollWidth <= d.clientWidth + 1; }), true, "no sideways scrolling");
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/standing-change-${name}-${scheme}.png` });
    await p.locator("#standing-save").click();
    await p.locator("#standing-dialog").waitFor({ state: "hidden" });
    await p.locator(`[data-history-order="${changeId}"] .history-amended`).waitFor();
    assert.match(await p.locator(`[data-history-order="${changeId}"] .history-amended`).innerText(), /You changed the bags.*This delivery only/s);
    const saved = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === changeId);
    assert.equal(saved.lines.length, 2); assert.equal(saved.repeatLines[0].quantity, 6);
    // Skip another delivery.
    await p.locator(`[data-standing-skip="${skipId}"]`).click();
    await p.locator("#standing-skip-confirm").click();
    await p.locator(`[data-history-order="${skipId}"] .history-cancelled`).waitFor();
    assert.match(await p.locator(`[data-history-order="${skipId}"]`).innerText(), /Skipped[\s\S]*You skipped this delivery/i);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`wholesale staff change bags and skip a delivery on a ${name} (${scheme})`, async () => {
    const id = await standing();
    const { ctx, p, errors } = await page(STAFF, viewport, isMobile, scheme);
    await p.goto(srv.base + "/orders#" + id);
    await p.locator("#orderDialog[open]").waitFor();
    await p.locator("#changeBags").click();
    await p.locator("#orderEdit .no-line select").first().waitFor();
    await p.locator('#orderEdit .no-line input[type="number"]').first().fill("3");
    await p.locator("#orderEdit").getByRole("button", { name: "Every delivery from now on" }).click();
    assert.ok(!/£/.test(await p.locator("#orderDialog").innerText()), "no prices");
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/standing-staff-${name}-${scheme}.png` });
    await p.locator("#saveAmend").click();
    await p.locator("#changeBags").waitFor();
    const detail = await p.locator("#orderDetail").innerText();
    assert.match(detail, /Bags changed\s*By Strangers/); assert.match(detail, /3 bags · 3 kg total/);
    await p.locator("#skipDelivery").click();
    await p.locator("#confirmSkip").click();
    await p.locator("#orderDialog").waitFor({ state: "hidden" });
    const saved = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === id);
    assert.equal(saved.status, "Cancelled"); assert.equal(saved.skipped.by, "Pat Packer");
    const next = (await call("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === saved.nextRunId);
    assert.equal(next.lines[0].quantity, 3, "every delivery from now on");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
