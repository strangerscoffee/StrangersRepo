import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const photos = await Promise.all([
  ["coffee.webp", "image/webp", "../public/wholesale-preview/images/colombia.webp"],
  ["square.png", "image/png", "../public/icon-192.png"],
  ["coffee.jpg", "image/jpeg", "../public/wholesale-preview/images/house.jpg"],
].map(async ([name, mimeType, path]) => ({ name, mimeType, buffer: await readFile(new URL(path, import.meta.url)) })));
let srv, browser, ADMIN;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json() };
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  const setup = await api("POST", "/api/auth/setup", { name: "Catalogue Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null);
  ADMIN = cookieOf(setup.response);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`catalogue ${device} ${color}: add/edit coffee, upload/remove photos, stock enforcement and customer payment terms`, { timeout: 120000 }, async () => {
    const contextOptions = { viewport, colorScheme: color, hasTouch: true, isMobile: viewport.width < 600 };
    const adminContext = await browser.newContext(contextOptions), customerContext = await browser.newContext(contextOptions);
    const [name, value] = ADMIN.split("=");
    await adminContext.addCookies([{ name, value, url: srv.base }]);
    const username = `catalogue.${device.toLowerCase()}.${color}`;
    const business = `${device} ${color} buyer`;
    const title = `${device} ${color} Coffee`;
    const customer = (await api("POST", "/api/admin/wholesale/customers", { business, contact: "Coffee Buyer", email: "buyer@example.com", status: "Active", note: "Internal account note" })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
    await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-password" }, null);
    try {
      const admin = await adminContext.newPage(), buyer = await customerContext.newPage();
      const errors = [];
      for (const page of [admin, buyer]) page.on("pageerror", (error) => errors.push(error.message));
      await admin.goto(srv.base + "/admin#wholesale");
      await admin.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
      await admin.locator('[data-act="wh-coffee"]:not([data-id])').click();
      await admin.locator('#wCoffeeTitle').fill(title);
      await admin.locator('#wCoffeeName').fill(title);
      await admin.locator('#wCoffeeOrigin').fill('Colombia');
      await admin.locator('#wCoffeeProcess').fill('Washed');
      await admin.locator('#wCoffeeNotes').fill('Peach and cocoa');
      for (const [pack, price] of [['quarter','12.00'],['kilo','42.00']]) await admin.locator('#wPrice-' + pack).fill(price);
      await admin.locator('#wCoffeeForm button[type="submit"]').click();
      await admin.locator('#wPhotoFiles').waitFor();
      let product = (await api('GET', '/api/admin/wholesale')).body.products.find((row) => row.title === title);
      assert.ok(product);
      await admin.locator('#wPrice-kilo').fill('45.00');
      await admin.locator('#wPhotoFiles').setInputFiles(photos);
      await admin.locator('[data-sheet="photo-upload"]').click();
      await admin.waitForFunction(() => document.querySelectorAll('#wPhotos .w-photo').length === 3 || document.querySelector('#wErr')?.textContent);
      assert.equal(await admin.locator('#wErr').textContent(), '', 'photo upload succeeds');
      assert.equal(await admin.locator('#wPhotos .w-photo').count(), 3);
      assert.equal(await admin.locator('#wPrice-kilo').inputValue(), '45.00', 'uploads preserve unsaved coffee edits');
      assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await screenshot(admin, `catalogue-editor-${device}-${color}`);
      await admin.locator('#wCoffeeForm button[type="submit"]').click();
      await admin.locator('#scrim').waitFor({ state: 'hidden' });
      product = (await api('GET', '/api/admin/wholesale')).body.products.find((row) => row.id === product.id);
      assert.equal(product.prices.kilo, 4500); assert.equal(product.images.length, 3);

      async function editTerms(term, note) {
        await admin.locator('[data-act="wh-tab"][data-id="customers"]').click();
        await admin.locator('[data-act="wh-customer"]', { hasText: business }).click();
        await admin.locator('[data-sheet="customer-choice"][data-choice="wPaymentTerms"]').click();
        await admin.locator(`#wCustomerChoice [data-sheet="customer-choice-apply"][data-value="${term}"]`).click();
        await admin.locator('#wCustomerForm').waitFor();
        await admin.locator('#wPaymentNote').fill(note);
        await screenshot(admin, `payment-settings-${device}-${color}`);
        await admin.locator('#sheet button[type="submit"]').click();
        await admin.locator('#scrim').waitFor({ state: 'hidden' });
      }
      async function stock(inStock) {
        await admin.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
        await admin.locator(`[data-act="wh-coffee"][data-id="${product.id}"]`).click();
        await admin.locator('#wInStock').setChecked(inStock);
        await admin.locator('#wCoffeeForm button[type="submit"]').click();
        await admin.locator('#scrim').waitFor({ state: 'hidden' });
      }
      await editTerms('net-30', 'Please quote the invoice number.');
      await buyer.goto(srv.base + '/wholesale-preview/signin');
      await buyer.locator('#username').fill(username); await buyer.locator('#password').fill(username + '-password');
      await buyer.locator('#login-submit').click();
      await buyer.waitForURL(/\/wholesale-preview\/$/);
      const card = buyer.locator(`article[data-product="${product.id}"]`);
      await card.waitFor();
      async function photoReady() {
        await card.locator('[data-product-photo]').scrollIntoViewIfNeeded();
        await buyer.waitForFunction((id) => {
          const image = document.querySelector(`article[data-product="${id}"] [data-product-photo]`);
          return image?.complete && image.naturalWidth > 0;
        }, product.id, { timeout: 10000 });
      }
      assert.equal(await buyer.locator('#products article').count(), (await api('GET', '/api/admin/wholesale')).body.products.length);
      assert.match(await card.locator('[data-price]').textContent(), /45.00/);
      await photoReady();
      await card.locator('[data-photo-step="1"]').click();
      await photoReady();
      assert.equal(await card.locator('[data-photo-count]').textContent(), '2 / 3');
      assert.equal(await card.locator('[data-product-photo]').evaluate(image => getComputedStyle(image).objectFit), 'contain');
      await card.locator('[data-photo-step="-1"]').click();
      await buyer.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await buyer.waitForFunction(() => {
        const header = document.querySelector('.site-header'), row = document.querySelector('.header-account');
        return window.scrollY <= 8 && !row.inert && !header.classList.contains('is-account-collapsed')
          && getComputedStyle(row).visibility === 'visible' && getComputedStyle(row).opacity === '1'
          && !row.getAnimations().some(animation => animation.playState === 'running');
      });
      await buyer.locator('#my-account').click();
      await buyer.locator('#account-dialog').waitFor();
      assert.equal(await buyer.locator('#account-payment-terms').textContent(), '30 days from invoice');
      assert.equal(await buyer.locator('#account-payment-note').textContent(), 'Please quote the invoice number.');
      assert.equal(await buyer.locator('#account-form [name="paymentTerms"]').count(), 0);
      await buyer.locator('#account-dialog [data-close]').click();
      await card.locator('button[type="submit"]').click();
      await stock(false);
      await buyer.locator('#review-order').click();
      await card.locator('.product-stock.out').waitFor();
      assert.equal(await card.locator('button[type="submit"]').isDisabled(), true);
      assert.equal(await buyer.locator('#review-dialog').isVisible(), false);
      assert.equal(await buyer.locator('#review-order').isDisabled(), true);
      await screenshot(buyer, `stock-${device}-${color}`);
      await stock(true);
      await buyer.reload();
      await card.locator('.product-stock:not(.out)').waitFor();

      await admin.locator('[data-act="wh-coffee"][data-id="' + product.id + '"]').click();
      await admin.locator('#wPhotos [aria-label="Remove photo 2"]').click();
      await admin.locator('#wPhotos [data-sheet="photo-confirm"]').click();
      await admin.waitForFunction(() => document.querySelectorAll('#wPhotos .w-photo').length === 2);
      await admin.locator('#sheet [data-sheet="close"]').click();
      await buyer.reload();
      await buyer.waitForFunction((id) => document.querySelector(`article[data-product="${id}"] [data-photo-count]`)?.textContent === '1 / 2', product.id);
      await card.locator('[data-photo-step="1"]').click();
      await photoReady();
      assert.equal(await card.locator('[data-photo-count]').textContent(), '2 / 2');
      await buyer.locator('#review-order').click();
      await buyer.locator('#review-dialog').waitFor();
      assert.match(await buyer.locator('#review-payment-terms').textContent(), /30 days from invoice/);
      await buyer.locator('#review-form [name="delivery"][value="collection"]').check();
      await editTerms('net-7', 'Payment within seven days of invoice.');
      await buyer.locator('#submit-preview-order').click();
      await buyer.locator('#preview-submit-error', { hasText: 'terms changed' }).waitFor();
      assert.equal(await buyer.locator("#submit-preview-order").isDisabled(), true, "changed agreement requires a new review before submitting again");
      await buyer.locator('#review-dialog .close-button').click();
      await buyer.locator('#review-order').click();
      await buyer.locator('#review-dialog').waitFor();
      assert.match(await buyer.locator('#review-payment-terms').textContent(), /7 days from invoice/);
      await buyer.locator('#review-form [name="delivery"][value="collection"]').check();
      await screenshot(buyer, `checkout-terms-${device}-${color}`);
      await buyer.locator('#submit-preview-order').click();
      await buyer.locator('#preview-complete').waitFor();
      assert.match(await buyer.locator('#complete-payment-terms').textContent(), /7 days from invoice/);
      const orders = (await api('GET', '/api/admin/wholesale')).body.orders.filter((row) => row.customerId === customer.id);
      assert.equal(orders.length, 1); assert.equal(orders[0].paymentTerms.id, 'net-7'); assert.equal(orders[0].pence, 4500);
      await buyer.locator('#preview-complete [data-close]').click();
      await editTerms('net-30', 'Future invoices only.');
      await buyer.locator('#my-orders').click();
      const savedOrder = buyer.locator(`[data-history-order="${orders[0].id}"]`);
      await savedOrder.locator('.history-details summary').click();
      await savedOrder.locator('.payment-terms', { hasText: '7 days from invoice' }).waitFor();
      assert.ok(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
    } finally { await adminContext.close(); await customerContext.close(); }
  });
}
