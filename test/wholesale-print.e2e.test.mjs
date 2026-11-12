// Admin → Wholesale → Orders: Print new orders, Select to print and Bags to process, on a phone and an iPad.
// window.print is stubbed; the printed pages are what's in #wPrintArea. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, A;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "print.buyer", password: "print-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Print Café", contact: "Buyer", email: "print@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  for (const lines of [[{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }, { productId: "campo", pack: "quarter", grind: "filter", quantity: 12, price: 500 }], [{ productId: "house", pack: "quarter", grind: "espresso", quantity: 8, price: 500 }]]) {
    const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
    assert.equal((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", customerNote: "Own labels" , customerVersion: session.customer.version }, A)).status, 201);
  }
});
after(async () => { await b?.close(); await srv?.stop(); });

test("print new orders, pick orders to print, and see the bags to process", async () => {
  for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile });
    const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    await ctx.addInitScript(() => { window.print = () => { window.__printed = document.getElementById("wPrintArea")?.innerText || ""; }; });
    const p = await ctx.newPage(); const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(srv.base + "/admin#wholesale");
    await p.locator('[data-act="wh-tab"][data-id="orders"]').click(); await p.locator('[data-act="wh-order"]').first().waitFor();

    // Order alerts: the customer confirmation switch saves and comes back as saved.
    await p.locator('[data-act="wh-order-emails"]').click(); await p.locator("#wConfirmCustomers").waitFor();
    assert.equal(await p.locator("#wConfirmCustomers").isChecked(), true, "customer confirmations are on by default");
    await p.locator("#wConfirmCustomers").uncheck(); await p.locator('#sheet [data-sheet="save"]').click(); await p.locator("#wConfirmCustomers").waitFor({ state: "detached" });
    await p.locator('[data-act="wh-order-emails"]').click(); await p.locator("#wConfirmCustomers").waitFor();
    assert.equal(await p.locator("#wConfirmCustomers").isChecked(), false);
    await p.locator("#wConfirmCustomers").check();
    if (process.env.WHOLESALE_SCREENSHOT_DIR) { await p.locator("#wConfirmCustomers").scrollIntoViewIfNeeded(); await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/order-alerts-${name}.png` }); }
    await p.locator('#sheet [data-sheet="save"]').click(); await p.locator("#wConfirmCustomers").waitFor({ state: "detached" });

    await p.locator('[data-act="wh-totals"]').click(); await p.locator(".wp-tiles").waitFor();
    assert.match((await p.locator(".wp-tiles").innerText()).replace(/\s+/g, " "), /250 g bags 20 1 kg bags 6 All bags 26 11 kg of coffee/, name);
    assert.match(await p.locator(".wp-body").innerText(), /To pack: by coffee, size and grind/);
    await p.locator('[data-sheet="close"]').first().click();

    await p.locator('[data-act="wh-print-new"]').click(); await p.waitForFunction(() => window.__printed);
    const printed = await p.evaluate(() => window.__printed);
    assert.match(printed, /Bags to process/); assert.match(printed, /Own labels/); assert.equal((printed.match(/Packed by/g) || []).length, 2, `${name}: a packing sheet per new order`);
    assert.doesNotMatch(printed, /£/, "packing sheets carry no prices");

    await p.evaluate(() => { window.__printed = ""; });
    await p.locator('[data-act="wh-pick-start"]').click(); await p.locator('[data-act="wh-pick"]').first().click();
    assert.equal(await p.locator(".w-picked-count").textContent(), "1 selected");
    assert.equal(await p.locator('[data-act="wh-pick"]').first().getAttribute("aria-pressed"), "true");
    await p.locator('[data-act="wh-print-picked"]').click(); await p.waitForFunction(() => window.__printed);
    assert.equal(((await p.evaluate(() => window.__printed)).match(/Packed by/g) || []).length, 1, `${name}: only the picked order`);
    await p.locator('[data-act="wh-pick-done"]').click(); await p.locator('[data-act="wh-order"]').first().waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
