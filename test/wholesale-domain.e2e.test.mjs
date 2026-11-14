import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser;
before(async () => {
  srv = await startServer({ host: "strangerscoffee.trade", vars: { PREVIEW_HOST: "strangerscoffee.trade", ADMIN_HOST: "admin.staffstrangerscoffee.com" } });
  const response = await fetch(srv.base + "/api/wholesale/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "trade.browser", password: "trade-browser-password", business: "Trade café", contact: "Buyer", email: "buyer@example.com" }) });
  assert.equal(response.status, 201);
  srv.sql("UPDATE wholesale_accounts SET approval_status = 'approved', active = 1; UPDATE wholesale_preview SET data = json_set(data, '$.status', 'Active') WHERE kind = 'customer';");
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  await mkdir("test/artifacts", { recursive: true });
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const colorScheme of ["light", "dark"]) {
  test(`wholesale customer domain ${device} ${colorScheme}: sign-in, protected ordering and reload use the customer session`, async () => {
    const context = await browser.newContext({ viewport, colorScheme, hasTouch: true, isMobile: viewport.width < 600 });
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const failed = []; page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(srv.base + "/"); await page.waitForURL("**/signin");
      assert.equal(await page.title(), "Wholesale sign-in · Strangers Coffee");
      // Signed out, every file the sign-in page needs loads: the logo shows and the terms open.
      await page.waitForFunction(() => document.querySelector(".login-logo img")?.complete);
      assert.ok(await page.evaluate(() => document.querySelector(".login-logo img").naturalWidth > 0), "the logo loads signed out");
      await page.locator(".login-footer [data-terms]").click(); await page.locator("#terms-dialog[open]").waitFor();
      await page.locator("#terms-dialog .close-button").click();
      assert.deepEqual(failed, [], "no file on the sign-in page fails to load");
      assert.equal(await page.locator("#sc-error").count(), 0, "no error card");
      await page.locator("#username").fill("trade.browser"); await page.locator("#password").fill("trade-browser-password");
      await page.locator("#login-submit").click();
      await page.locator("#products article").first().waitFor();
      assert.equal(await page.locator("main h1").textContent(), "Wholesale");
      assert.equal(await page.locator("#products article").count(), 14);
      // Old cached models can still import their source snapshot, with authentication. The new app never
      // imports it (covered by the session-expiry cases below).
      assert.equal(await page.evaluate(async () => (await import('/wholesale-preview/catalogue.js')).products[0].id), "brazil");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.reload(); await page.locator("#products article").first().waitFor();
      const profile = await page.evaluate(async () => (await fetch("/api/wholesale/session")).json());
      assert.equal(profile.me.role, "wholesale"); assert.equal(profile.customer.business, "Trade café");
      assert.equal(await page.evaluate(async () => (await fetch("/api/admin/wholesale")).status), 404);
      assert.equal((await context.cookies()).some((cookie) => cookie.name === "sfbb_session"), false);
      await page.screenshot({ path: `test/artifacts/wholesale-trade-${device}-${colorScheme}.png`, fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
for (const legacyAssets of [false, true]) {
  test(`wholesale module loading: session ends after HTML, ${legacyAssets ? "cached legacy" : "canonical"} modules still redirect cleanly`, async () => {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage(), errors = [], badScripts = [], snapshots = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        const path = new URL(response.url()).pathname;
        if (/\/wholesale(?:-preview)?\/.*\.js$/.test(path) && (response.status() !== 200 || !/javascript/.test(response.headers()["content-type"] || ""))) badScripts.push(path);
      });
      page.on("request", request => { if (/\/catalogue\.js$/.test(new URL(request.url()).pathname)) snapshots.push(request.url()); });
      await page.goto(srv.base + "/signin");
      await page.locator("#username").fill("trade.browser"); await page.locator("#password").fill("trade-browser-password");
      await page.locator("#login-submit").click(); await page.locator("#products article").first().waitFor();
      let htmlLoaded = false, expired = false;
      await page.route(srv.base + "/", async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        const body = await response.text(); htmlLoaded = true;
        await route.fulfill({ response, body: legacyAssets ? body.replaceAll("/wholesale/", "/wholesale-preview/") : body });
      });
      await page.route(/\/wholesale(?:-preview)?\/wholesale\.js(?:\?|$)/, async route => {
        assert.equal(htmlLoaded, true, "protected HTML was received with a valid session");
        await context.clearCookies(); expired = true;
        await route.continue();
      });
      await page.reload(); await page.waitForURL("**/signin");
      await page.locator("#login-submit:enabled").waitFor();
      assert.equal(expired, true);
      assert.equal(await page.locator("#sc-error").count(), 0, "session expiry produces sign-in rather than a failed-script card");
      assert.deepEqual(badScripts, []); assert.deepEqual(errors, []); assert.deepEqual(snapshots, [], "no source-price snapshot enters the module graph");
    } finally { await context.close(); }
  });
}
