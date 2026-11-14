import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startServer, SETUP_CODE } from './harness.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let server, browser, admin, customerCookie;
const cookieOf = response => (response.headers.getSetCookie().find(value => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || '').split(';')[0];
async function api(path, body, cookie = admin) {
  const response = await fetch(server.base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.ok(response.ok, path + ': ' + JSON.stringify(value)); return { value, response };
}
before(async () => {
  server = await startServer({ writeLimit: 4000 });
  admin = cookieOf((await api('/api/auth/setup', { name: 'Catalogue Owner', username: 'owner', password: 'catalogue-owner-password', code: SETUP_CODE }, null)).response);
  const customer = (await api('/api/admin/wholesale/customers', { business: 'Catalogue Coffee Company', contact: 'Buyer', email: 'catalogue@example.test', address: '10 Coffee Street', postcode: 'NR1 1AA', status: 'Active' })).value.customer;
  const account = (await api(`/api/admin/wholesale/customers/${customer.id}/account`, { username: 'cataloguebuyer' })).value;
  customerCookie = cookieOf((await api('/api/wholesale/auth/change-password', { username: 'cataloguebuyer', password: account.temporaryPassword, newPassword: 'catalogue-buyer-password' }, null)).response);
  const catalogue = (await api('/api/wholesale/catalogue', null, customerCookie)).value;
  const coffee = catalogue.products.find(product => product.id === 'brazil');
  await api('/api/wholesale/orders', { requestId: crypto.randomUUID(), lines: [{ productId: coffee.id, pack: 'kilo', grind: 'beans', quantity: 6, price: coffee.prices.kilo }], delivery: 'Roastery collection', customerVersion: catalogue.customer.version }, customerCookie);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await server?.stop(); });
for (const width of [320, 820, 1920]) for (const colorScheme of ['light', 'dark']) {
  test(`approved catalogue ${width} ${colorScheme}: account orders, animated choices, search, repeat and basket`, { timeout: 120000 }, async () => {
    const context = await browser.newContext({ viewport: { width, height: 1080 }, colorScheme });
    const [name, value] = customerCookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
    const page = await context.newPage(), errors = [], orderWrites = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/wholesale/orders') orderWrites.push(request.url()); });
    try {
      await page.goto(server.base + '/wholesale/'); await page.locator('#products[aria-busy="false"]').waitFor();
      await page.locator('#repeat-shortcut').waitFor();
      assert.equal(await page.locator('#account-greeting').textContent(), 'Hi, Buyer');
      assert.equal(await page.locator('#account-menu-greeting').textContent(), 'Hi, Buyer');
      assert.equal(await page.locator('.brand-name').innerText(), 'Strangers Wholesale');
      assert.equal(await page.locator('.brand-name').isVisible(), true);
      assert.equal(await page.locator('.footer-brand strong').innerText(), 'Strangers Coffee Company');
      assert.equal(await page.locator('.site-header nav').count(), 0);
      assert.ok((await page.locator('.site-header').boundingBox()).height <= 120, 'header and order-history shortcut remain compact at every width');
      assert.equal(await page.locator('#basket-dialog').isVisible(), false);
      assert.equal(await page.locator('#my-orders').isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const card = page.locator('article[data-product="brazil"]');
      assert.equal(await card.locator('.product-photo img').evaluate(node => getComputedStyle(node).objectFit), 'cover');
      assert.ok((await card.locator('.product-photo').boundingBox()).width > 200);
      if (width > 700) {
        assert.equal(await page.locator('#coffee-search').isVisible(), false);
        await page.locator('#search-toggle').click(); await page.locator('#coffee-search').fill('brazil');
        assert.equal(await page.locator('#products>article:visible').count(), 1);
        await page.keyboard.press('Escape'); assert.equal(await page.locator('#coffee-search').inputValue(), '');
        assert.equal(await page.locator('#search-toggle').getAttribute('aria-expanded'), 'false');
      } else {
        assert.ok((await page.locator('.site-header').boundingBox()).height <= 120);
        await page.locator('#coffee-search').fill('brazil'); assert.equal(await page.locator('#products>article:visible').count(), 1);
        await page.locator('#coffee-search').fill('');
      }
      await page.locator('#repeat-last-order').click(); await page.locator('#reorder-dialog[open]').waitFor();
      assert.match(await page.locator('#reorder-existing').textContent(), /does not place an order/);
      assert.equal(await page.locator('#basket-count').textContent(), '0');
      await page.locator('#reorder-dialog [data-close]').first().click();
      await card.locator('[data-pack-open]').click(); await page.locator('#coffee-choice-menu:popover-open').waitFor();
      await card.locator('[data-pack-open]').click();
      assert.equal(await page.locator('#coffee-choice-menu').evaluate(node => node.matches(':popover-open')), false, 'pressing the same trigger dismisses its menu');
      await card.locator('[data-pack-open]').press('ArrowDown');
      await page.locator('#coffee-choice-menu [data-choice="quarter"]').click();
      assert.equal(await card.locator('input[name="pack"]:checked').inputValue(), 'quarter');
      assert.match(await card.locator('[data-pack-label]').textContent(), /250 g/);
      await card.locator('[data-grind-open]').focus(); await page.keyboard.press('ArrowDown');
      await page.locator('#coffee-choice-menu [data-choice="filter"]').click();
      assert.equal(await card.locator('select[name="grind"]').inputValue(), 'filter');
      assert.equal(await card.locator('[data-grind-open]').evaluate(node => node === document.activeElement), true);
      await card.locator('input[type="number"]').fill('6'); await card.locator('[type="submit"]').click();
      assert.equal(await card.locator('[data-add-label]').textContent(), 'Added');
      assert.equal(await card.locator('[data-add-check]').isVisible(), true);
      assert.equal(await card.locator('[data-add-symbol]').isVisible(), false);
      assert.equal(await page.locator('#basket-count').textContent(), '6');
      assert.deepEqual(orderWrites, [], 'Add changes the basket without submitting checkout');
      await card.locator('[type="submit"]:not([data-added])').waitFor();
      assert.equal(await card.locator('[data-add-label]').textContent(), 'Add');
      assert.equal(await card.locator('[data-add-check]').isVisible(), false);
      assert.equal(await card.locator('[data-add-symbol]').isVisible(), true);
      await page.locator('.site-header [data-basket]').click(); await page.locator('#basket-dialog[open]').waitFor();
      assert.equal(await page.locator('#order-items .order-item').count(), 1);
      await page.locator('#order-items input').fill('5'); await page.locator('#order-items input').press('Tab');
      assert.equal(await page.locator('#basket-count').textContent(), '5');
      await page.locator('#basket-dialog [data-close]').click();
      await page.locator('#account-toggle').click(); await page.locator('#wholesale-account:popover-open').waitFor();
      await page.locator('#my-orders').click(); await page.locator('#orders-dialog[open]').waitFor();
      await page.locator('[data-history-order]').first().waitFor();
      assert.equal(await page.locator('#wholesale-account').evaluate(node => node.matches(':popover-open')), false);
      await page.locator('#orders-dialog [data-close]').first().click();
      if (process.env.CATALOGUE_QA_DIR) { await mkdir(process.env.CATALOGUE_QA_DIR, { recursive: true }); await page.evaluate(() => scrollTo(0,0)); await page.screenshot({ path: `${process.env.CATALOGUE_QA_DIR}/catalogue-${width}-${colorScheme}.png`, fullPage: true }); }
      await page.emulateMedia({ reducedMotion: 'reduce' }); await card.locator('[data-grind-open]').click();
      assert.equal(await page.locator('#coffee-choice-menu').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
      await page.keyboard.press('Escape');
      await card.locator('[type="submit"]').click();
      assert.equal(await page.locator('#basket-count').evaluate(node => node.getAnimations().length), 0, 'reduced motion disables the basket pulse');
      assert.equal(await card.locator('[data-add-check]').evaluate(node => node.getAnimations().length), 0, 'reduced motion disables check movement');
      assert.deepEqual(orderWrites, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('contact greeting follows saved contact names, escapes text, handles long and blank names, and survives reload', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [name, value] = customerCookie.split('='); await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.base + '/wholesale/'); await page.locator('#products[aria-busy="false"]').waitFor();
    for (const contact of ['Will <Coffee & Co>', 'Will ' + 'Longcontactname '.repeat(6), '']) {
      await page.locator('#account-toggle').click(); await page.locator('#my-account').click();
      await page.locator('#account-dialog[open]').waitFor();
      await page.locator('#account-form [name="contact"]').fill(contact);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/wholesale/account' && response.request().method() === 'PUT');
      await page.locator('#save-account').click();
      const response = await saved; assert.equal(response.status(), 200);
      assert.equal((await response.json()).customer.contact, contact.trim());
      await page.locator('#account-dialog[open]').waitFor({ state: 'hidden' });
      const greeting = contact.trim() ? 'Hi, ' + contact.trim() : 'Hi';
      assert.equal(await page.locator('#account-greeting').textContent(), greeting);
      assert.equal(await page.locator('#account-menu-greeting').textContent(), greeting);
      assert.equal(await page.locator('#account-toggle').getAttribute('aria-label'), greeting + '. Account menu');
      assert.equal(await page.locator('#signed-in-name').textContent(), 'Catalogue Coffee Company');
      assert.equal(await page.locator('#account-menu-greeting > *').count(), 0, 'contact names render as text');
      for (const width of [701, 820, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const boxes = await page.evaluate(() => Object.fromEntries(['.site-header', '.brand-name', '.basket-link', '#account-toggle'].map(selector => [selector, document.querySelector(selector).getBoundingClientRect().toJSON()])));
        assert.ok(boxes['.brand-name'].right <= boxes['.basket-link'].left, `${width}: the brand stays clear of the basket with long contact names`);
        assert.ok(boxes['#account-toggle'].right <= boxes['.site-header'].right, `${width}: the greeting stays inside the header`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.reload(); await page.locator('#products[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#account-greeting').textContent(), 'Hi');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
