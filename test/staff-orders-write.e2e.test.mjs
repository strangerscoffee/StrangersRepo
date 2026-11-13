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
  const c = (await call("POST", "/api/admin/wholesale/customers", { business: "Lune Café", contact: "Sam Buyer", email: "sam@lune.example", phone: "01603 000000", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username: "lune" })).body;
  const BUYER = (await call("POST", "/api/wholesale/auth/change-password", { username: "lune", password: account.temporaryPassword, newPassword: "lune-own-password" }, null)).cookie;
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
    await p.getByRole("button", { name: "Select to print" }).click();
    await p.locator("[data-order-id]").first().click(); assert.equal(await p.locator(".picked-count").textContent(), "1 selected");
    await p.getByRole("button", { name: "Print selected" }).click(); await p.waitForFunction(() => window.__printed);
    const printed = await p.evaluate(() => window.__printed);
    assert.match(printed, /Bags to process/); assert.equal((printed.match(/Packed by/g) || []).length, 1); assert.doesNotMatch(printed, /£/);
    await p.getByRole("button", { name: "Done" }).click();

    // Customers, read-only.
    await p.locator('#viewTabs [data-view="customers"]').click(); await p.locator("[data-customer-id]").first().click();
    const customer = await p.locator("#customerDetail").innerText();
    assert.match(customer, /Lune Café/); assert.match(customer, /sam@lune\.example/); assert.match(customer, /NR3 1HN/);
    assert.equal(await p.locator("#customerDialog input,#customerDialog select,#customerDialog textarea").count(), 0);
    await p.locator("#doneCustomer").click();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${name}: no sideways scroll`);
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
