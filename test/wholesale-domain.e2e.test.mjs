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
      await page.goto(srv.base + "/"); await page.waitForURL("**/signin");
      assert.equal(await page.title(), "Wholesale sign-in · Strangers Coffee");
      await page.locator("#username").fill("trade.browser"); await page.locator("#password").fill("trade-browser-password");
      await page.locator("#login-submit").click();
      await page.locator("#products article").first().waitFor();
      assert.equal(await page.locator("main h1").textContent(), "Wholesale");
      assert.equal(await page.locator("#products article").count(), 10);
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
