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
async function assertDialogCloseClear(page, selector) {
  const geometry = await page.locator(selector).evaluate((dialog) => {
    const close = dialog.querySelector('.close-button').getBoundingClientRect();
    const heading = [...dialog.querySelectorAll('h1,h2')].map((node) => node.getBoundingClientRect()).find((box) => box.width && box.height);
    return { overlap: heading && Math.min(close.right, heading.right) > Math.max(close.left, heading.left) && Math.min(close.bottom, heading.bottom) > Math.max(close.top, heading.top), inViewport: close.left >= 0 && close.top >= 0 && close.right <= innerWidth + 1 && close.bottom <= innerHeight + 1 };
  });
  assert.equal(geometry.overlap, false, 'the modal close control has its own space above the heading');
  assert.equal(geometry.inViewport, true, 'the modal close control remains visible on the screen');
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
      assert.equal(await page.locator('link[rel="stylesheet"][href^="/theme.css"]').count(), 1, 'ordering uses the shared staff/Admin theme');
      assert.equal(await page.locator('main h1').textContent(), 'Wholesale');
      assert.equal(await page.locator('.beta-badge, .help-note, #help-dialog').count(), 0);
      const design = await page.evaluate(() => {
        const card = document.querySelector('#products article');
        const controls = [...card.querySelectorAll('button, .pack-choice'), ...document.querySelectorAll('.filter, .basket-link, #my-orders, #preview-sign-out')];
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--accent)'; document.body.append(probe);
        const accent = getComputedStyle(probe).backgroundColor; probe.remove();
        return { font: getComputedStyle(document.body).fontFamily, headingFont: getComputedStyle(card.querySelector('h3')).fontFamily, actionColour: getComputedStyle(card.querySelector('[type="submit"]')).backgroundColor, accent, smallTargets: controls.filter((control) => { const box = control.getBoundingClientRect(); return box.width < 43.5 || box.height < 43.5; }).map((control) => control.getAttribute('aria-label') || control.textContent) };
      });
      assert.match(design.font, /system-ui/, 'customer text uses the shared system font');
      assert.match(design.headingFont, /system-ui/, 'customer headings use the same system type as Admin');
      assert.equal(design.actionColour, design.accent, 'ordering actions follow the shared light/dark accent');
      assert.deepEqual(design.smallTargets, [], 'primary touch controls are at least 44 by 44 pixels');
      assert.equal(await page.locator("#products article").count(), 10);
      assert.equal(await page.locator("#signed-in-name").textContent(), "Wholesale Owner");
      assert.equal(await page.locator("#admin-wholesale-link").getAttribute("href"), "/admin#wholesale");
      const card = page.locator('article[data-product="brazil"]');
      const photo = await card.locator('img').evaluate((img) => ({ width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, fit: getComputedStyle(img).objectFit }));
      assert.ok(Math.abs(photo.width / photo.height - photo.naturalWidth / photo.naturalHeight) < 0.02, "photo keeps the full source image proportions");
      assert.equal(photo.fit, "contain");
      assert.equal(await page.locator('.intro').count(), 0, "requested marketing introduction is removed");
      assert.equal(await page.locator('#basket-count').isHidden(), true, 'an empty order has no zero badge');
      assert.match(await page.locator('#order-items').textContent(), /Your order is empty/);
      assert.equal(await page.locator('.site-header #signed-in-name').count(), 1, 'the signed-in identity belongs in the glass header');
      assert.equal(await page.locator('.session-strip').count(), 0, 'there is no separate account strip below the header');
      const otherCard = page.locator('article[data-product="colombia"]');
      await card.locator('[data-grind-open]').click();
      await page.locator('#grind-dialog').waitFor();
      await assertDialogCloseClear(page, '#grind-dialog');
      await page.locator('#grind-choice-form [value="filter"]').check();
      await page.locator('#grind-dialog [data-close]').last().click();
      assert.equal(await card.locator('select[name="grind"]').inputValue(), 'beans', 'cancelling a grind choice preserves the card selection');
      assert.equal(await card.locator('[data-grind-open]').evaluate((button) => document.activeElement === button), true, 'cancel returns focus to the grind picker');
      await card.locator('[data-grind-open]').click();
      await page.locator('#grind-choice-form [value="espresso"]').check();
      await page.locator('#confirm-grind').click();
      assert.equal(await card.locator('select[name="grind"]').inputValue(), 'espresso');
      assert.equal(await card.locator('[data-grind-label]').textContent(), 'Fine');
      assert.equal(await card.locator('[data-grind-hint]').textContent(), 'Commercial espresso machine', 'the card says what the grind is for');
      assert.equal(await otherCard.locator('select[name="grind"]').inputValue(), 'beans', 'confirming grind changes only the chosen coffee card');
      assert.equal(await card.locator('[data-grind-open]').evaluate((button) => document.activeElement === button), true, 'confirmation returns focus to the updated card');
      await card.locator('input[name="pack"][value="quarter"]').check();
      await card.locator('input[type="number"]').fill("2");
      await card.locator('button[type="submit"]').click();
      assert.equal(await page.locator("#subtotal").textContent(), "£10.00");
      assert.equal(await card.locator('input[name="pack"][value="half"]').count(), 0, "500 g bags are no longer offered");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "ordering page fits viewport");
      if (process.env.WHOLESALE_SCREENSHOT_DIR) {
        await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/ordering-${device}-${color}.png` });
      }
      await page.locator("#review-order").click();
      await page.locator("#review-dialog").waitFor();
      await assertDialogCloseClear(page, '#review-dialog');
      const business = `${device} ${color} Preview Café`;
      await page.locator('#review-form input[name="business"]').fill(business);
      await page.locator('input[name="reference"]').fill(`Preview ${device} ${color}`);
      await page.locator("#submit-preview-order").click();
      await page.locator("#preview-complete").waitFor();
      assert.match(await page.locator("#complete-message").textContent(), /was saved as a staff preview order/);
      const order = (await api("GET", "/api/admin/wholesale")).body.orders.find((order) => order.business === business);
      assert.ok(order, "order is saved on the server"); assert.equal(order.pence, 1000);
      assert.equal(order.lines[0].grind, 'espresso', 'the saved order receives the confirmed picker value');
      await assertDialogCloseClear(page, '#review-dialog');
      await page.locator('#preview-complete [data-close]').click();
      await page.locator('footer [data-order-history]').click();
      await page.locator('#orders-dialog').waitFor();
      await page.locator(`[data-history-order="${order.id}"]`).waitFor();
      await assertDialogCloseClear(page, '#orders-dialog');
      await page.locator('#orders-dialog .close-button').click();
      await page.locator('#admin-wholesale-link').click();
      await page.locator("#main h1", { hasText: "Wholesale" }).waitFor();
      if (device === "phone") {
        await page.locator('#tabBar [data-go="more"]').click();
        await page.locator('#main [data-go="sites"]').click();
        await page.locator('#main h1', { hasText: "Sites" }).waitFor();
        await page.locator('#tabBar [data-go="wholesale"]').click();
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
      assert.equal(await page.locator("#wPrice-quarter").inputValue(), "5.00");
      assert.equal(await page.locator("#wPrice-half").count(), 0, "no 500 g price: they are no longer sold");
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
      await admin.locator('[data-sheet="customer-choice"][data-choice="wPaymentTerms"]').click();
      await admin.locator('#wCustomerChoice [data-sheet="customer-choice-apply"][data-value="net-30"]').click();
      await admin.locator('#wCustomerForm').waitFor();
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
      assert.equal(await page.locator('#account-business').textContent(), business, 'the approved business name is shown without an editable customer field');
      assert.equal(await page.locator('#account-form input[name="business"]:not([readonly]):not([hidden])').count(), 0);
      await page.locator('#account-form [name="address"]').fill('10 Coffee Street\nNorwich');
      await page.locator('#account-form [name="postcode"]').fill('NR1 1AA');
      await page.locator('#account-form [name="deliveryNotes"]').fill('Ring the bell');
      await page.locator('#save-account').click();
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
      await page.locator('#review-dialog').waitFor();
      assert.equal(await page.locator('#review-business').textContent(), business);
      assert.match(await page.locator('#delivery-summary').textContent(), /10 Coffee Street/);
      await page.locator('#review-form [name="reference"]').fill(username);
      await page.locator('#review-form [name="customerNote"]').fill('Use our own custom labels');
      await page.locator('#submit-preview-order').click();
      await page.locator('#preview-complete').waitFor();
      assert.match(await page.locator('#complete-message').textContent(), /has been received by Strangers/);
      assert.equal(await page.locator('#complete-note').textContent(), 'Your comments: Use our own custom labels');
      const order = (await api('GET', '/api/admin/wholesale')).body.orders.find((row) => row.reference === username);
      assert.ok(order); assert.equal(order.preview, false); assert.equal(order.pence, 3600);
      assert.equal(order.paymentTerms.id, 'net-30', 'reviewing the sign-in preserves the edited customer terms');
      assert.equal(order.customerSnapshot.postcode, 'NR1 1AA');
      assert.equal(await page.locator('#basket-count').textContent(), '0');
      await page.locator('#preview-complete [data-close]').click();
      await admin.locator('[data-act="wh-tab"][data-id="orders"]').click();
      await admin.locator('[data-act="wh-order"]', { hasText: business }).click();
      assert.match(await admin.locator('#sheet').textContent(), /10 Coffee Street/);
      assert.match(await admin.locator('#sheet .w-customer-note').textContent(), /Customer comments\s*Use our own custom labels/);
      assert.match(await admin.locator('#sheet .w-packing-line').first().getAttribute('style'), /--w-coffee:\s*(?:repeating-)?linear-gradient\(/, 'each packing line shows its coffee colour');
      await admin.locator('#wStatus').selectOption('Ready');
      await admin.locator('#wNote').fill('Private admin note');
      await admin.locator('#sheet button[type="submit"]').click();
      await admin.locator('#scrim').waitFor({ state: 'hidden' });
      await page.locator('#my-orders').click();
      await page.locator('#order-history .order-state', { hasText: 'Ready' }).waitFor();
      assert.equal(await page.locator('#history-count').textContent(), 'Showing 1 of 1 order');
      assert.equal(await page.locator('.history-progress [aria-current="step"]').textContent().then(value => value.includes('Ready')), true);
      assert.equal(await page.locator('.history-details').getAttribute('open'), null, 'order details start folded');
      await page.locator('.history-details summary').click();
      assert.match(await page.locator('.history-details').textContent(), /10 Coffee Street/);
      if (process.env.WHOLESALE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/history-${device}-${color}.png` });
      assert.doesNotMatch(await page.locator('#order-history').textContent(), /Private admin note/);
      await page.locator('[data-reorder]').click();
      await page.locator('#reorder-dialog').waitFor();
      assert.equal(await page.locator('#basket-count').textContent(), '0', 'repeat confirmation preserves the basket until accepted');
      assert.match(await page.locator('#reorder-summary').textContent(), /2 bags available to add · £36.00/);
      if (process.env.WHOLESALE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/repeat-${device}-${color}.png` });
      await page.locator('#confirm-reorder').click();
      await page.locator('#reorder-dialog').waitFor({ state: 'hidden' });
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

// A repeat is a reviewed basket merge, including current availability, price changes and unresolved submissions.
test('repeat order: current availability and prices, basket merge, cancellation and pending-submit guard', { timeout: 90000 }, async () => {
  const created = [];
  for (const [title, price] of [['Repeat Espresso', 3000], ['Repeat Filter', 2400]]) {
    const result = await api('POST', '/api/admin/wholesale/catalogue', { title, name: title, origin: 'Colombia', process: 'Washed', notes: 'Cocoa', badge: '', categories: ['single-origin'], prices: { quarter: 1000, half: 2000, kilo: price }, active: true, inStock: true });
    assert.equal(result.response.status, 201); created.push(result.body.product);
  }
  let [espresso, filter] = created;
  const { customer } = (await api('POST', '/api/admin/wholesale/customers', { business: 'Repeat Coffee Buyer', contact: 'Buyer', email: 'repeat@example.com', status: 'Active', note: '' })).body;
  const { temporaryPassword } = (await api('POST', `/api/admin/wholesale/customers/${customer.id}/account`, { username: 'repeat.buyer' })).body;
  const changed = await api('POST', '/api/wholesale/auth/change-password', { username: 'repeat.buyer', password: temporaryPassword, newPassword: 'repeat-buyer-password' }, null);
  const buyerCookie = changed.response.headers.getSetCookie().find(value => /^sf_wholesale_session=[\w-]/.test(value)).split(';')[0];
  const identity = (await api('GET', '/api/wholesale/catalogue', undefined, buyerCookie)).body;
  let order = (await api('POST', '/api/wholesale/orders', { requestId: crypto.randomUUID(), orderingIdentity: identity.me.id, customerVersion: identity.customer.version, lines: [{ productId: espresso.id, pack: 'kilo', grind: 'beans', quantity: 2, price: 3000 }, { productId: filter.id, pack: 'quarter', grind: 'filter', quantity: 1, price: 1000 }], delivery: 'Roastery collection' }, buyerCookie)).body.order;
  order = (await api('PATCH', `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, status: 'Cancelled', customerId: customer.id, note: 'Internal only' })).body.order;
  const context = await contextFor({ width: 393, height: 852 }, 'light', buyerCookie);
  try {
    const page = await context.newPage(); await page.goto(srv.base + '/wholesale-preview/');
    const card = page.locator(`article[data-product="${filter.id}"]`); await card.waitFor();
    await card.locator('[name="pack"][value="quarter"]').check(); await card.locator('button[type="submit"]').click();
    assert.equal(await page.locator('#basket-count').textContent(), '1');
    espresso = (await api('PUT', `/api/admin/wholesale/catalogue/${espresso.id}`, { ifVersion: espresso.version, prices: espresso.prices, active: true, inStock: false })).body.product;
    await page.locator('#my-orders').click(); await page.locator('.order-state', { hasText: 'Cancelled' }).waitFor();
    assert.equal(await page.locator('.history-progress').count(), 0, 'cancelled orders never imply completed preparation stages');
    assert.match(await page.locator('.history-cancelled').textContent(), /cancelled/);
    if (process.env.WHOLESALE_SCREENSHOT_DIR) { await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/history-cancelled-phone-light.png` }); }
    // Page-shaped UI fixtures exercise count, append deduplication and refresh independently of the API's paging tests.
    const earlier = { ...order, id: 'WS-' + crypto.randomUUID().replaceAll('-', '').toUpperCase(), createdAt: order.createdAt - 86400000 };
    let earlierReads = 0;
    await page.route('**/api/wholesale/orders*', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const more = new URL(route.request().url()).searchParams.has('cursor');
      if (more) { earlierReads++; await new Promise(resolve => setTimeout(resolve, 250)); }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: more ? [order, earlier] : [order], count: 2, nextCursor: more ? null : 'earlier-page' }) });
    });
    await page.locator('#refresh-orders').click(); await page.locator('#history-count', { hasText: 'Showing 1 of 2 orders' }).waitFor();
    await page.locator('.history-details summary').click();
    await page.locator('#history-more').click(); assert.equal(await page.locator('#history-more').isDisabled(), true);
    await page.locator('#history-count', { hasText: 'Showing 2 of 2 orders' }).waitFor();
    assert.equal(await page.locator('[data-history-order]').count(), 2, 'appended pages merge duplicate IDs');
    assert.equal(await page.locator('.history-details').first().getAttribute('open'), '', 'loading earlier orders preserves expanded details');
    assert.equal(earlierReads, 1); assert.equal(await page.locator('#history-more').isHidden(), true);
    await page.locator('#refresh-orders').click(); await page.locator('#history-count', { hasText: 'Showing 1 of 2 orders' }).waitFor();
    await page.unroute('**/api/wholesale/orders*');
    await page.locator('#refresh-orders').click(); await page.locator('#history-count', { hasText: 'Showing 1 of 1 order' }).waitFor();
    await page.locator('[data-reorder]').click(); await page.locator('#reorder-dialog').waitFor();
    assert.match(await page.locator('#reorder-summary').textContent(), /1 bag available to add · £10.00/);
    assert.match(await page.locator('#reorder-skipped').textContent(), /2 bags of Repeat Espresso — out of stock/);
    assert.match(await page.locator('#reorder-existing').textContent(), /current 1 bag will stay/);
    assert.equal(await page.locator('#basket-count').textContent(), '1');
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/repeat-unavailable-phone-light.png` });
    await page.locator('#reorder-dialog [data-close]').last().click();
    espresso = (await api('PUT', `/api/admin/wholesale/catalogue/${espresso.id}`, { ifVersion: espresso.version, prices: { ...espresso.prices, kilo: 3300 }, active: true, inStock: true })).body.product;
    await page.locator('#my-orders').click(); await page.locator('[data-reorder]').click(); await page.locator('#reorder-dialog').waitFor();
    assert.match(await page.locator('#reorder-summary').textContent(), /3 bags available to add · £76.00/);
    espresso = (await api('PUT', `/api/admin/wholesale/catalogue/${espresso.id}`, { ifVersion: espresso.version, prices: { ...espresso.prices, kilo: 3400 }, active: true, inStock: true })).body.product;
    await page.locator('#confirm-reorder').click(); await page.locator('#reorder-error', { hasText: 'changed' }).waitFor();
    assert.match(await page.locator('#reorder-summary').textContent(), /3 bags available to add · £78.00/);
    assert.equal(await page.locator('#basket-count').textContent(), '1', 'a price change requires reviewing again before merge');
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/repeat-updated-phone-light.png` });
    await page.locator('#confirm-reorder').click(); await page.locator('#reorder-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#basket-count').textContent(), '4'); assert.equal(await page.locator('#subtotal').textContent(), '£88.00');
    assert.equal((await api('GET', '/api/wholesale/orders', undefined, buyerCookie)).body.orders.length, 1, 'confirming a repeat only builds the merged basket');
    await page.route('**/api/wholesale/orders', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await page.locator('#review-order').click(); await page.locator('#review-dialog').waitFor();
    await page.locator('#review-form [name="delivery"][value="collection"]').check();
    await page.locator('#submit-preview-order').click(); await page.locator('#preview-submit-error', { hasText: 'couldn’t confirm' }).waitFor();
    await page.locator('#review-dialog .close-button').click();
    await page.locator('#my-orders').click(); await page.locator('[data-reorder]').waitFor();
    assert.equal(await page.locator('[data-reorder]').isDisabled(), true, 'an unresolved submission blocks repeat baskets');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  } finally { await context.close(); }
});
