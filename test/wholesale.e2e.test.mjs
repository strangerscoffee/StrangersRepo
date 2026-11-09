// Staff ordering and native Admin → Wholesale, on phones and iPads in light and dark mode.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
let srv, browser, ADMIN, STAFF;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json() };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const setup = await api("POST", "/api/auth/setup", { name: "Wholesale Owner", username: "owner", password: "wholesale-owner-pass", code: SETUP_CODE }, null);
  ADMIN = cookieOf(setup.response);
  await api("POST", "/api/admin/users", { name: "Wholesale Staff", username: "staff", role: "staff", password: "temporary-pass" });
  const changed = await api("POST", "/api/auth/change", { username: "staff", password: "temporary-pass", newPassword: "wholesale-staff-pass" }, null);
  STAFF = cookieOf(changed.response);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function contextFor(viewport, colorScheme, cookie = ADMIN) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch: true, isMobile: viewport.width < 600 });
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: srv.base }]);
  return context;
}

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale ${device} ${color}: staff order saves to native Admin menu and can be managed`, async () => {
    const context = await contextFor(viewport, color);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(srv.base + "/wholesale-preview/");
      await page.locator("#products article").first().waitFor();
      assert.equal(await page.locator("#products article").count(), 10);
      assert.equal(await page.locator("#signed-in-name").textContent(), "Wholesale Owner");
      assert.equal(await page.locator("#admin-wholesale-link").getAttribute("href"), "/admin#wholesale");
      const card = page.locator('article[data-product="brazil"]');
      await card.locator('input[name="pack"][value="quarter"]').check();
      await card.locator('input[type="number"]').fill("2");
      await card.locator('button[type="submit"]').click();
      assert.equal(await page.locator("#subtotal").textContent(), "£21.00");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "ordering page fits viewport");
      if (process.env.WHOLESALE_SCREENSHOT_DIR) {
        await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/ordering-${device}-${color}.png` });
      }
      await page.locator("#review-order").click();
      const business = `${device} ${color} Preview Café`;
      await page.locator('input[name="business"]').fill(business);
      await page.locator('input[name="reference"]').fill(`Preview ${device} ${color}`);
      await page.locator("#submit-preview-order").click();
      await page.locator("#preview-complete").waitFor();
      assert.match(await page.locator("#complete-message").textContent(), /was saved for the admin team/);
      const order = (await api("GET", "/api/admin/wholesale")).body.orders.find((order) => order.business === business);
      assert.ok(order, "order is saved on the server"); assert.equal(order.pence, 2100);
      await page.locator("#complete-dashboard-link").click();
      await page.locator("#main h1", { hasText: "Wholesale" }).waitFor();
      if (device === "phone") {
        await page.locator('#tabBar [data-go="more"]').click();
        await page.locator('#main [data-go="wholesale"]').click();
      } else {
        await page.locator('#sideNav [data-go="overview"]').click();
        await page.locator('#sideNav [data-go="wholesale"]').click();
      }
      await page.locator("#main h1", { hasText: "Wholesale" }).waitFor();
      await page.locator('[data-act="wh-order"]', { hasText: business }).click();
      await page.locator("#wStatus").selectOption("Preparing");
      await page.locator("#wNote").fill(`Managed from ${device} ${color}`);
      await page.locator('#sheet button[type="submit"]').click();
      await page.locator("#scrim").waitFor({ state: "hidden" });
      assert.equal((await api("GET", "/api/wholesale/orders/" + order.id)).body.order.status, "Preparing");
      await page.locator('[data-act="wh-tab"][data-id="customers"]').click();
      await page.locator('[data-act="wh-customer"]').first().click();
      await page.locator("#wBusiness").fill(`${device} ${color} account`);
      await page.locator("#wEmail").fill("orders@example.test");
      await page.locator('#sheet button[type="submit"]').click();
      await page.locator("#scrim").waitFor({ state: "hidden" });
      assert.ok((await api("GET", "/api/admin/wholesale")).body.customers.some((customer) => customer.business === `${device} ${color} account`));
      await page.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
      await page.locator('[data-act="wh-coffee"][data-id="brazil"]').click();
      assert.equal(await page.locator("#wPrice-quarter").inputValue(), "10.50");
      await page.locator('[data-sheet="close"]').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Admin wholesale fits viewport");
      if (process.env.WHOLESALE_SCREENSHOT_DIR) {
        await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/admin-${device}-${color}.png`, fullPage: true });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("wholesale staff: signed-out pages require login; staff cannot open the admin dashboard", async () => {
  const signedOut = await browser.newContext();
  const context = await contextFor({ width: 393, height: 852 }, "light", STAFF);
  try {
    const anonymous = await signedOut.newPage();
    await anonymous.goto(srv.base + "/wholesale-preview/");
    await anonymous.waitForURL(/\/signin\?next=/);
    const page = await context.newPage();
    await page.goto(srv.base + "/wholesale-preview/");
    await page.locator("#products article").first().waitFor();
    assert.equal(await page.locator("#admin-wholesale-link").isHidden(), true);
    await page.goto(srv.base + "/admin#wholesale");
    await page.waitForURL((url) => url.pathname === "/");
    await page.goto(srv.base + "/wholesale-preview/");
    await page.locator("#products article").first().waitFor();
    await page.locator("#preview-sign-out").click();
    await page.waitForURL(/\/signin$/);
    assert.equal((await page.request.get(srv.base + "/api/wholesale/catalogue")).status(), 401);
  } finally { await signedOut.close(); await context.close(); }
});
