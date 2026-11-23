import { selectWholesaleSection } from "./admin-workspace-helpers.mjs";
// Admin → Wholesale → Insights and Invoicing: "Hide figures" blurs sales, money, customer names and charts on screen
// with one tap (or H), remembered on the device, for when someone's looking at the display (the owner's request,
// 23 Nov 2026). Phone, iPad and desktop, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN;
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
  const c = (await call("POST", "/api/admin/wholesale/customers", { business: "Secret Sales Café", contact: "Dee", email: "dee@secret.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username: "secret" })).body;
  const buyer = (await call("POST", "/api/wholesale/auth/change-password", { username: "secret", password: account.temporaryPassword, newPassword: "secret-own-password" }, null)).cookie;
  const orders = [];
  for (let i = 0; i < 2; i++) {
    const session = (await call("GET", "/api/wholesale/session", undefined, buyer)).body;
    orders.push((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6 + i, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, buyer)).body.order);
  }
  const current = (await call("GET", "/api/admin/wholesale/invoice-settings")).body;
  const config = (await call("PUT", "/api/admin/wholesale/invoice-settings", { ...current.settings, ifVersion: current.version, seller: { legalName: "TEST Supplier Limited", address: "1 Test Street\nNorwich NR1 1AA", vatNumber: "TEST-GB123456789", companyNumber: "TEST0001", email: "test@example.com", phone: "01603 000000" }, priceBasis: "exclusive", vatRates: [{ id: "zero", label: "Zero", basisPoints: 0 }, { id: "standard", label: "Standard", basisPoints: 2000 }], defaultCoffeeRateId: "zero", deliveryRateId: "standard", invoicePrefix: "TEST-", firstInvoiceNumber: 1000, paymentInstructions: "TEST instructions only.", confirmed: true })).body;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  await call("POST", `/api/admin/wholesale/orders/${orders[0].id}/invoice`, { orderVersion: orders[0].version, settingsVersion: config.version, invoiceDate: today, supplyDate: today });
});
after(async () => { await b?.close(); await srv?.stop(); });

// Is this text on screen readable? Blurred if it or an ancestor has a blur filter.
const where = (p, text) => p.evaluate((t) => { const w = document.createTreeWalker(document.querySelector(".w-content"), NodeFilter.SHOW_TEXT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (new RegExp(t).test(n.textContent)) { let e = n.parentElement, blurred = false, path = []; while (e) { if (/blur/.test(getComputedStyle(e).filter)) blurred = true; if (!e.classList.contains("w-content") && path.length < 4) path.push(e.tagName + "." + [...e.classList].join(".")); e = e.parentElement; } if (!blurred && n.parentElement.getClientRects().length) out.push(JSON.stringify(n.textContent.trim().slice(0, 40)) + " " + path.join("<")); } return out.join(" | "); }, text);
const readable = (p, text) => p.evaluate((text) => {
  const walker = document.createTreeWalker(document.querySelector(".w-content"), NodeFilter.SHOW_TEXT);
  const found = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (new RegExp(text).test(n.textContent)) {
    let el = n.parentElement, blurred = false;
    while (el) { if (/blur/.test(getComputedStyle(el).filter)) { blurred = true; break; } el = el.parentElement; }
    if (n.parentElement.getClientRects().length) found.push(!blurred);
  }
  return found;
}, text);

for (const [screen, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false], ["desktop", { width: 1440, height: 900 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`Hide figures on Insights and Invoicing on a ${screen} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/admin#wholesale");
    await selectWholesaleSection(p, "insights");
    const toggle = p.locator('[data-act="wh-privacy"]');
    await toggle.waitFor();
    await p.locator(".w-content").getByRole("button", { name: "Sales", exact: true }).click();
    await p.locator(".w-content #insCust").waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.ok((await readable(p, "Secret Sales Café")).some(Boolean), "names readable before");
    const box = await toggle.boundingBox();
    assert.ok(box.y < viewport.height && box.x + box.width <= viewport.width + 1, "the switch is on screen without scrolling");
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/hide-insights-${screen}-${scheme}-off.png` });
    await toggle.click();
    await p.waitForFunction(() => document.documentElement.hasAttribute("data-hide-figures"));
    assert.equal(await p.locator('[data-act="wh-privacy"]').getAttribute("aria-pressed"), "true");
    assert.match(await p.locator('[data-act="wh-privacy"]').textContent(), /Figures hidden/);
    await p.waitForTimeout(300);
    const names = await readable(p, "Secret Sales Café"), money = await readable(p, "£\\d");
    assert.ok(names.length && names.every((r) => !r), "customer names blurred " + await p.evaluate((t) => { const w = document.createTreeWalker(document.querySelector(".w-content"), NodeFilter.SHOW_TEXT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (new RegExp(t).test(n.textContent)) { let e = n.parentElement, path = []; while (e && !e.classList.contains("w-content")) { path.push(e.tagName + "." + [...e.classList].join(".")); e = e.parentElement; } out.push(path.join(" < ")); } return out.join(" | "); }, "Secret Sales Café"));
    assert.ok(money.length && money.every((r) => !r), "money blurred " + await where(p, "£\\d"));
    assert.ok((await readable(p, "Customers")).some(Boolean), "section headings stay readable");
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/hide-insights-${screen}-${scheme}-on.png`, fullPage: true });

    // Invoicing: still hidden (remembered), and after a reload.
    await selectWholesaleSection(p, "invoices");
    await p.locator('[data-act="wh-privacy"][aria-pressed="true"]').waitFor();
    await p.waitForFunction(() => /TEST-/.test(document.querySelector(".w-content")?.innerText || "")); await p.waitForTimeout(300);
    for (const text of ["Secret Sales Café", "£\\d"]) { const r = await readable(p, text); assert.ok(r.length && r.every((x) => !x), `${text} blurred on Invoicing ` + await where(p, text)); }
    if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/hide-invoices-${screen}-${scheme}-on.png`, fullPage: true });
    await p.reload(); await p.locator('[data-act="wh-privacy"][aria-pressed="true"]').waitFor();
    // H switches it back (not while typing).
    await p.locator("body").click({ position: { x: 2, y: 2 } }).catch(() => {});
    await p.keyboard.press("h");
    await p.locator('[data-act="wh-privacy"][aria-pressed="false"]').waitFor();
    await p.waitForFunction(() => /TEST-/.test(document.querySelector(".w-content")?.innerText || ""));
    await p.waitForTimeout(400);
    assert.ok((await readable(p, "£\\d")).some(Boolean), "shown again");
    // Other pages never get the switch.
    await selectWholesaleSection(p, "orders");
    await p.locator('[data-act="wh-order"]').first().waitFor();
    assert.equal(await p.locator('[data-act="wh-privacy"]').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
