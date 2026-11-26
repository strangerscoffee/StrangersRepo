import { openWholesaleBasket } from './wholesale-ui-helpers.mjs';
// The basket asks how the customer will get their order: Delivery (with its charge) or Collect from the Roastery
// (free, and the total says so). The choice carries into the review, is remembered on the device, and the order is
// placed with it. Phone and iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, BUYER;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "collector", password: "collector-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Collect Café", contact: "Cal", email: "cal@collect.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  BUYER = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

const screens = [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]];
for (const [name, viewport] of screens) for (const colorScheme of ["light", "dark"]) {
  test(`basket: delivery or collect from the Roastery on a ${name} (${colorScheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile: true, hasTouch: true, colorScheme });
    const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.goto(srv.base + "/wholesale/"); await p.locator(".product-card").first().waitFor();
      await p.locator('#products[aria-busy="false"]').waitFor();
      const card = p.locator(".product-card").first();
      await card.locator("input[type=number]").fill("1"); await card.locator("button[type=submit]").click();
      await p.locator("#basket-count").waitFor();
      await openWholesaleBasket(p);
      // Delivery first: its charge is shown and explained, and collection is offered.
      assert.equal(await p.locator('input[name="basket-method"][value="dispatch"]').isChecked(), true);
      assert.equal(await p.locator("#basket-delivery-label").innerText(), "Delivery");
      assert.match(await p.locator("#basket-delivery").innerText(), /£7\.44/);
      assert.match(await p.locator("#delivery-note").innerText(), /Collecting from the Roastery is free/);
      // Collect: no charge, and the total is just the coffee.
      await p.locator("#basket-method label", { hasText: "Collect from the Roastery" }).click();
      assert.equal(await p.locator("#basket-delivery-label").innerText(), "Roastery collection");
      assert.equal(await p.locator("#basket-delivery").innerText(), "Free");
      assert.equal(await p.locator("#basket-estimate").innerText(), await p.locator("#subtotal").innerText());
      assert.match(await p.locator("#delivery-note").innerText(), /No delivery charge when you collect from the Roastery/);
      if (process.env.SHOT_DIR) await p.screenshot({ path: `${process.env.SHOT_DIR}/basket-collect-${name}-${colorScheme}.png` });
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, "no sideways scroll");
      // Remembered on this device after a reload.
      await p.reload(); await p.locator(".product-card").first().waitFor(); await p.locator('#products[aria-busy="false"]').waitFor();
      await openWholesaleBasket(p);
      assert.equal(await p.locator('input[name="basket-method"][value="collection"]').isChecked(), true);
      // The review starts on Roastery collection, with no delivery charge, and the order is placed that way.
      await p.locator("#review-order").click(); await p.locator("#review-dialog[open]").waitFor();
      assert.equal(await p.locator('#review-form input[name="delivery"][value="collection"]').isChecked(), true);
      assert.equal(await p.locator("#review-delivery").innerText(), "Free");
      await p.locator("#submit-preview-order").click();
      await p.locator("#preview-complete:not([hidden])").waitFor();
      const orders = (await call("GET", "/api/admin/wholesale")).body.orders.filter((o) => o.business === "Collect Café");
      assert.equal(orders[0].delivery, "Roastery collection");
      assert.equal(orders[0].deliveryPence, 0);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}

// Delivery to a location with no address (the owner's report, 26 Nov 2026): the review says so before Place order and
// offers collection, and switching to collection there lets the order go without reopening the basket.
for (const [name, viewport, colorScheme] of [["phone", { width: 390, height: 844 }, "dark"], ["ipad", { width: 820, height: 1180 }, "light"]]) {
  test(`review: no delivery address, switch to collection and order on a ${name} (${colorScheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile: true, hasTouch: true, colorScheme });
    const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    let posted = 0; p.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/wholesale/orders")) posted++; });
    try {
      await p.goto(srv.base + "/wholesale/"); await p.locator('#products[aria-busy="false"]').waitFor();
      const card = p.locator(".product-card").first();
      await card.locator("input[type=number]").fill("1"); await card.locator("button[type=submit]").click();
      await openWholesaleBasket(p);
      await p.locator("#basket-method label", { hasText: "Delivery" }).first().click();
      await p.locator("#review-order").click();
      await p.locator("#review-dialog[open]").waitFor();
      const note = p.locator("#review-address-note");
      await note.waitFor();
      assert.match(await note.innerText(), /no delivery address/);
      assert.equal(await p.locator("#submit-preview-order").isDisabled(), true, "no doomed submission");
      if (process.env.SHOT_DIR) { await note.scrollIntoViewIfNeeded(); await p.waitForTimeout(400); await p.screenshot({ path: `${process.env.SHOT_DIR}/review-no-address-${name}-${colorScheme}.png` }); }
      // Switching to collection in the review itself is enough.
      await p.locator("#review-form .delivery-options label", { hasText: "Roastery collection" }).click();
      assert.equal(await note.isHidden(), true);
      assert.equal(await p.locator("#submit-preview-order").isDisabled(), false);
      // And the note's own button does the same after going back to delivery.
      await p.locator("#review-form .delivery-options label", { hasText: "Send it to me" }).click();
      assert.equal(await p.locator("#submit-preview-order").isDisabled(), true);
      await p.locator("#review-collect-instead").click();
      assert.equal(await p.locator('#review-form input[name="delivery"][value="collection"]').isChecked(), true);
      assert.equal(posted, 0);
      await p.locator("#submit-preview-order").click();
      await p.locator("#preview-complete").waitFor({ state: "visible" });
      assert.equal(posted, 1);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}
