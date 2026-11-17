import { openWholesaleBasket, openWholesaleOrders } from './wholesale-ui-helpers.mjs';
// Order again starts on the site the original order went to, and "Send to more sites" places the same bags as one
// order per ticked location. Phone and iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN, index = 0;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { body: data, cookie: cookieOf(r) };
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function buyer() {
  const username = "sites.buyer" + (++index), credentials = { username, password: username + "-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Three Sites Café " + index, contact: "Sam", email: username + "@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  const cookie = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  const session = (await call("GET", "/api/wholesale/session", undefined, cookie)).body;
  const site = (name, address, postcode) => ({ name, contact: "Manager", phone: "01603 000000", address, postcode, deliveryNotes: "" });
  const saved = (await call("PUT", "/api/wholesale/account", { ifVersion: session.customer.version, orderingIdentity: session.me.id, address: "1 Main Street", postcode: "NR1 1AA",
    locations: [{ ...session.customer.locations[0], address: "1 Main Street", postcode: "NR1 1AA" }, site("Riverside", "2 River Street", "NR2 2AA"), site("Market", "3 Market Place", "NR3 3AA")] }, cookie)).body.customer;
  return { cookie, session, customer: saved };
}
for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`order again follows the original site and sends to more sites (${device}, ${color})`, { timeout: 120000 }, async () => {
    const { cookie, session, customer } = await buyer();
    const riverside = customer.locations.find((l) => l.name === "Riverside"), market = customer.locations.find((l) => l.name === "Market");
    const price = (await call("GET", "/api/wholesale/catalogue", undefined, cookie)).body.products.find((p) => p.prices?.kilo).prices.kilo;
    const productId = (await call("GET", "/api/wholesale/catalogue", undefined, cookie)).body.products.find((p) => p.prices?.kilo).id;
    // A past order to Riverside.
    const first = (await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId, pack: "kilo", grind: "beans", quantity: 3, price }], delivery: "Delivery", customerVersion: customer.version, locationId: riverside.id }, cookie)).body.order;
    const ctx = await browser.newContext({ viewport, colorScheme: color, isMobile: device === "phone", hasTouch: true });
    const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const page = await ctx.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(srv.base + "/wholesale/"); await page.locator(".product-card").first().waitFor(); await page.locator('#products[aria-busy="false"]').waitFor();
      await openWholesaleOrders(page);
      await page.locator(`[data-reorder="${first.id}"]`).click();
      await page.locator("#reorder-dialog[open]").waitFor();
      await page.locator("#confirm-reorder").click();
      await page.locator("#reorder-dialog").waitFor({ state: "hidden" });
      await openWholesaleBasket(page);
      await page.locator("#review-order").click(); await page.locator("#review-dialog[open]").waitFor();
      // Starts on the site the original order went to.
      assert.equal(await page.locator("#review-location-name").innerText(), "Riverside");
      // The other two sites are offered; tick Market.
      const choices = page.locator("#more-site-choices .more-site");
      assert.equal(await choices.count(), 2);
      assert.equal(await page.locator("#submit-preview-order").innerText(), "Place order");
      await choices.filter({ hasText: "Market" }).click();
      assert.equal(await page.locator("#submit-preview-order").innerText(), "Place 2 orders");
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/multi-site-review-${device}-${color}.png`, fullPage: false });
      await page.locator("#submit-preview-order").click();
      await page.locator("#preview-complete:not([hidden])").waitFor();
      await page.locator("#complete-orders:not([hidden])").waitFor();
      const receipt = await page.locator("#preview-complete").innerText();
      assert.match(receipt, /2 orders have been received/);
      assert.match(receipt, /Riverside[\s\S]*Market/);
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/multi-site-receipt-${device}-${color}.png` });
      const mine = (await call("GET", "/api/wholesale/orders", undefined, cookie)).body.orders.filter((o) => o.id !== first.id);
      assert.deepEqual(mine.map((o) => o.locationSnapshot?.name).sort(), ["Market", "Riverside"]);
      assert.ok(mine.every((o) => o.lines[0].quantity === 3), "the same bags for each site");
      assert.equal(new Set(mine.map((o) => o.id)).size, 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, true);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}
