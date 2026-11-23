import { selectWholesaleSection } from "./admin-workspace-helpers.mjs";
// Admin → Wholesale → Orders on a wide screen: the Ordered column shows when each order was placed, and tapping its
// heading sorts the queue newest first, then oldest first (the owner's request, 23 Nov 2026). Two desktop widths, light
// and dark (the queue's columns only show on wide screens). Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, BUYER, STAFF, ids = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { body: data, cookie: cookieOf(r) };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const c = (await call("POST", "/api/admin/wholesale/customers", { business: "Dated Café", contact: "Dee", email: "dee@dated.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username: "dated" })).body;
  BUYER = (await call("POST", "/api/wholesale/auth/change-password", { username: "dated", password: account.temporaryPassword, newPassword: "dated-own-password" }, null)).cookie;
  for (let i = 0; i < 3; i++) {
    const session = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body;
    ids.push((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, BUYER)).body.order.id);
    await new Promise((r) => setTimeout(r, 20));
  }
  const staff = (await call("POST", "/api/admin/users", { name: "Pat Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
  // Placed a week apart, so the dates differ on screen.
  srv.sql(`UPDATE wholesale_preview SET data = json_set(data, '$.createdAt', CASE id WHEN '${ids[0]}' THEN ${Date.parse("2026-11-02T10:00:00Z")} WHEN '${ids[1]}' THEN ${Date.parse("2026-11-09T10:00:00Z")} ELSE ${Date.parse("2026-11-16T10:00:00Z")} END) WHERE id IN ('${ids.join("','")}')`);
});
after(async () => { await b?.close(); await srv?.stop(); });

const shown = (p) => p.locator('[data-act="wh-order"]').evaluateAll((els, want) => els.map((e) => e.dataset.id).filter((id) => want.includes(id)), ids);
for (const [screen, viewport] of [["desktop", { width: 1440, height: 900 }], ["wide desktop", { width: 1680, height: 1000 }]]) for (const scheme of ["light", "dark"]) {
  test(`Admin orders: sort by Ordered on a ${screen} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, colorScheme: scheme });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/admin#wholesale");
    await selectWholesaleSection(p, "orders"); await p.locator(`[data-act="wh-order"][data-id="${ids[0]}"]`).waitFor();
    const head = p.locator('.w-order-columns [data-act="wh-sort"][data-id="ordered"]');
    // Newest first to start with (the owner's request, 23 Nov 2026).
    await p.waitForFunction(() => /↓/.test(document.querySelector('[data-act="wh-sort"][data-id="ordered"]')?.textContent || ""));
    assert.equal((await head.textContent()).trim(), "Ordered ↓");
    assert.deepEqual(await shown(p), [ids[2], ids[1], ids[0]], "newest first by default");
    assert.match(await head.getAttribute("aria-label"), /newest first/);
    assert.match(await p.locator(`[data-act="wh-order"][data-id="${ids[0]}"] .w-order-placed`).textContent(), /Mon,? 2 Nov/);
    await head.click();
    await p.waitForFunction(() => /↑/.test(document.querySelector('[data-act="wh-sort"][data-id="ordered"]').textContent));
    assert.deepEqual(await shown(p), [ids[0], ids[1], ids[2]], "oldest first");
    await p.locator('.w-order-columns [data-act="wh-sort"][data-id="ordered"]').click();
    await p.waitForFunction(() => /↓/.test(document.querySelector('[data-act="wh-sort"][data-id="ordered"]').textContent));
    assert.deepEqual(await shown(p), [ids[2], ids[1], ids[0]], "newest first again");
    // The heading and the date sit in the same column.
    const [h, d] = [await head.boundingBox(), await p.locator(`[data-act="wh-order"][data-id="${ids[0]}"] .w-order-placed`).boundingBox()];
    assert.ok(Math.abs(h.x - d.x) < 4, `column lines up (${h.x} vs ${d.x})`);
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/ordered-${screen.replace(" ", "-")}-${scheme}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

// Phones and iPads (no columns): the orders list is newest first too.
for (const [screen, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`Admin orders are newest first on a ${screen} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/admin#wholesale");
    await selectWholesaleSection(p, "orders"); await p.locator(`[data-act="wh-order"][data-id="${ids[0]}"]`).first().waitFor();
    await p.waitForFunction((want) => { const got = [...document.querySelectorAll('[data-act="wh-order"]')].map((e) => e.dataset.id).filter((id) => want.includes(id)); return got.join() === [want[2], want[1], want[0]].join(); }, ids);
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/admin-newest-${screen}-${scheme}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

// The staff orders page: a Sort choice on every screen (Usual order, Newest orders first, Oldest orders first), whatever
// the status, remembered on the device. The middle order is moved on to Ready so statuses are mixed.
let readied = false;
for (const [screen, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false], ["desktop", { width: 1440, height: 900 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`staff orders page: sort by order date on a ${screen} (${scheme})`, async () => {
    if (!readied) { readied = true; const o = (await call("GET", "/api/admin/wholesale")).body.orders.find((x) => x.id === ids[1]); await call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: "Ready", customerId: o.customerId, note: "" }); }
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = STAFF.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/orders");
    await p.locator(`[data-order-id="${ids[0]}"]`).first().waitFor();
    const list = () => p.locator("#orderList [data-order-id]").evaluateAll((els, want) => els.map((e) => e.dataset.orderId).filter((id) => want.includes(id)), ids);
    await p.selectOption("#orderSort", "ordered");
    await p.waitForFunction((first) => document.querySelector("#orderList [data-order-id]")?.dataset.orderId === first, ids[2]);
    assert.deepEqual(await list(), [ids[2], ids[1], ids[0]], "newest first, statuses mixed");
    assert.match(await p.locator(`#orderList [data-order-id="${ids[2]}"]`).textContent(), /16 Nov/, "each order shows when it was placed");
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/staff-ordered-${screen}-${scheme}.png` });
    await p.selectOption("#orderSort", "ordered-asc");
    await p.waitForFunction((first) => document.querySelector("#orderList [data-order-id]")?.dataset.orderId === first, ids[0]);
    assert.deepEqual(await list(), [ids[0], ids[1], ids[2]], "oldest first");
    await p.reload(); await p.locator(`[data-order-id="${ids[0]}"]`).first().waitFor();
    assert.equal(await p.inputValue("#orderSort"), "ordered-asc", "remembered on the device");
    const box = await p.locator("#orderSort").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, "the sort fits on screen");
    await p.selectOption("#orderSort", "");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
