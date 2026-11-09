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
      const photo = await card.locator('img').evaluate((img) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, fit: getComputedStyle(img).objectFit }));
      assert.ok(Math.abs(photo.width / photo.height - photo.naturalWidth / photo.naturalHeight) < 0.02, "photo keeps the full source image proportions");
      assert.equal(photo.fit, "contain");
      assert.equal(await page.locator('.intro').count(), 0, "requested marketing introduction is removed");
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
      await page.locator('#review-form input[name="business"]').fill(business);
      await page.locator('input[name="reference"]').fill(`Preview ${device} ${color}`);
      await page.locator("#submit-preview-order").click();
      await page.locator("#preview-complete").waitFor();
      assert.match(await page.locator("#complete-message").textContent(), /was saved as a staff preview order/);
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
    await anonymous.waitForURL(/\/wholesale-preview\/signin$/);
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

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale customer ${device} ${color}: registration, admin approval, delivery, ordering, history and reorder`, async () => {
    const context = await browser.newContext({ viewport, colorScheme: color, hasTouch: true, isMobile: viewport.width < 600 });
    const adminContext = await contextFor(viewport, color);
    const username = `shop.${device.toLowerCase()}.${color}`;
    const business = `${device} ${color} Wholesale Cafe`;
    const password = username + "-password";
    try {
      const page = await context.newPage(), admin = await adminContext.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      admin.on("pageerror", (error) => errors.push(error.message));
      await page.goto(srv.base + "/wholesale-preview/signin");
      await page.locator('#registration-toggle').click();
      for (const [name, value] of Object.entries({ business, contact: "Coffee Buyer", email: username + "@example.com", username, password })) await page.locator(`#wholesale-login [name="${name}"]`).fill(value);
      await page.locator('#login-submit').click();
      await page.locator('#registration-complete').waitFor();
      assert.equal((await page.request.get(srv.base + '/api/wholesale/catalogue')).status(), 401);
      await page.locator('#registration-toggle').click();
      await page.locator('#username').fill(username); await page.locator('#password').fill(password);
      await page.locator('#login-submit').click();
      await page.locator('#login-error', { hasText: 'awaiting review' }).waitFor();

      await admin.goto(srv.base + '/admin#wholesale');
      await admin.locator('[data-act="wh-tab"][data-id="customers"]').click();
      await admin.locator('[data-act="wh-customer"]', { hasText: business }).click();
      await admin.locator('[data-sheet="account"]').click();
      await admin.locator('#wApproval').selectOption('approved');
      await admin.locator('#sheet button[type="submit"]').click();
      await admin.locator('#scrim').waitFor({ state: 'hidden' });
      await page.locator('#login-submit').click();
      await page.waitForURL(/\/wholesale-preview\/$/);
      await page.locator('#products article').first().waitFor();
      const photos = await page.locator('#products img').evaluateAll(async (images) => {
        for (const image of images) image.loading = 'eager';
        return Promise.all(images.map(async (image) => { try { await image.decode(); return { loaded: image.naturalWidth > 0, src: image.getAttribute('src') }; } catch { return { loaded: false, src: image.getAttribute('src') }; } }));
      });
      assert.equal(photos.length, 10); assert.ok(photos.every((photo) => photo.loaded), JSON.stringify(photos));
      assert.equal(await page.locator('#signed-in-name').textContent(), business);
      assert.equal(await page.locator('#admin-wholesale-link').isHidden(), true);
      assert.equal(await page.locator('#staff-preview-notice').isHidden(), true);
      await page.locator('#my-account').click();
      await page.locator('#account-dialog').waitFor();
      await page.locator('#account-form [name="address"]').fill('10 Coffee Street\nNorwich');
      await page.locator('#account-form [name="postcode"]').fill('NR1 1AA');
      await page.locator('#account-form [name="deliveryNotes"]').fill('Ring the bell');
      await page.locator('#account-form button[type="submit"]').click();
      await page.locator('#account-dialog').waitFor({ state: 'hidden' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (process.env.WHOLESALE_SCREENSHOT_DIR) {
        await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/customer-${device}-${color}.png` });
      }
      const card = page.locator('article[data-product="brazil"]');
      await card.locator('input[type="number"]').fill('2');
      await card.locator('button[type="submit"]').click();
      await page.locator('#review-order').click();
      assert.equal(await page.locator('#review-form [name="business"]').inputValue(), business);
      assert.match(await page.locator('#delivery-summary').textContent(), /10 Coffee Street/);
      await page.locator('#review-form [name="reference"]').fill(username);
      await page.locator('#submit-preview-order').click();
      await page.locator('#preview-complete').waitFor();
      assert.match(await page.locator('#complete-message').textContent(), /has been received by Strangers/);
      const order = (await api('GET', '/api/admin/wholesale')).body.orders.find((row) => row.reference === username);
      assert.ok(order); assert.equal(order.preview, false); assert.equal(order.pence, 7400);
      assert.equal(order.customerSnapshot.postcode, 'NR1 1AA');
      assert.equal(await page.locator('#basket-count').textContent(), '0');
      await page.locator('#preview-complete [data-close]').click();
      await admin.locator('[data-act="wh-tab"][data-id="orders"]').click();
      await admin.locator('[data-act="wh-order"]', { hasText: business }).click();
      assert.match(await admin.locator('#sheet').textContent(), /10 Coffee Street/);
      await admin.locator('#wStatus').selectOption('Ready');
      await admin.locator('#wNote').fill('Private admin note');
      await admin.locator('#sheet button[type="submit"]').click();
      await admin.locator('#scrim').waitFor({ state: 'hidden' });
      await page.locator('#my-orders').click();
      await page.locator('#order-history .order-state', { hasText: 'Ready' }).waitFor();
      assert.doesNotMatch(await page.locator('#order-history').textContent(), /Private admin note/);
      await page.locator('[data-reorder]').click();
      assert.equal(await page.locator('#basket-count').textContent(), '2');
      const ownOrders = await page.evaluate(() => fetch('/api/wholesale/orders').then(r => r.json()));
      assert.equal(ownOrders.orders.length, 1, 'reorder builds a basket and waits for confirmation');
      await page.evaluate(() => fetch('/api/wholesale/auth/logout', { method: 'POST' }));
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.waitForURL(/\/wholesale-preview\/signin$/);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await adminContext.close(); }
  });
}
