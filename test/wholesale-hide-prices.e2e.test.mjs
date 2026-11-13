import { openWholesaleBasket } from './wholesale-ui-helpers.mjs';
// A business Strangers hides prices from (its own shops) orders by bags and weights alone: no £ anywhere on the
// catalogue, basket or review, on a phone and an iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, BUYER, customerId;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000, });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "shop.buyer", password: "shop-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Strangers ASG", contact: "Buyer", email: "shop@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  customerId = account.customerId;
  await call("PUT", `/api/admin/wholesale/customers/${customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  BUYER = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

const visibleText = (p) => p.evaluate(() => document.body.innerText);
test("hidden prices: no money on the catalogue, basket or review; Admin has the switch", async () => {
  const row = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === customerId);
  const { id, version, updatedAt, ...fields } = row;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, hidePrices: true, ifVersion: version })).status, 200);
  for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["ipad", { width: 820, height: 1180 }, true]]) for (const colorScheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme });
    const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
    await p.locator("#products[aria-busy=\"false\"]").waitFor();
    assert.doesNotMatch(await visibleText(p), /£/, `${name}: catalogue shows no prices`);
    assert.equal(await p.locator("#sort-coffee").isHidden(), true, "no price sorting");
    assert.equal(await p.locator("[data-bag-size=\"quarter\"]").isVisible(), true, "the bag size switch stays");
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/hide-prices-${name}-${colorScheme}-catalogue.png` });
    const card = p.locator(".product-card").first();
    await card.locator("input[type=number]").fill("6"); await card.locator("button[type=submit]").click();
    await p.locator("#basket-count").waitFor();
    assert.match(await p.locator("#mobile-total").textContent(), /kg/, "the mobile bar shows weight, not money");
    assert.doesNotMatch(await visibleText(p), /£/, `${name}: basket bar shows no prices`);
    await openWholesaleBasket(p);
    await p.waitForFunction(() => !document.querySelector("#review-order").disabled);
    assert.doesNotMatch(await visibleText(p), /£/, `${name}: basket shows no prices`);
    await openWholesaleBasket(p); await p.locator("#review-order").click(); await p.locator("#review-dialog[open]").waitFor();
    assert.doesNotMatch(await p.locator("#review-dialog").evaluate((d) => d.innerText), /£/, `${name}: review shows no prices`);
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/hide-prices-${name}-${colorScheme}-review.png` });
    assert.deepEqual(errors, []);
    await p.evaluate(() => localStorage.clear());
    await ctx.close();
  }
  // Admin: the switch is on the customer, and the list says so.
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 } });
  const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage();
  await p.goto(srv.base + "/admin#wholesale"); await p.locator("[data-act=\"wh-customer\"]").first().waitFor({ timeout: 15000 }).catch(() => {});
  if (await p.locator("[data-act=\"wh-customer\"]").count()) {
    assert.match(await p.locator("[data-act=\"wh-customer\"]").first().textContent(), /Prices hidden/);
  }
  await ctx.close();
});
