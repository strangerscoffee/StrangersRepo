import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './harness.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const legacy = 'preview.staffstrangerscoffee.com';
let server, browser;
before(async () => {
  server = await startServer({ host: legacy, vars: { PREVIEW_HOST: 'strangerscoffee.trade', LEGACY_PREVIEW_HOST: legacy } });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  if (process.env.SHOT_DIR) await mkdir(process.env.SHOT_DIR, { recursive: true });
});
after(async () => { await browser?.close(); await server?.stop(); });

const layouts = [
  ['desktop', { width: 1440, height: 1024 }, 'light'],
  ['mobile', { width: 393, height: 852 }, 'dark'],
];
for (const [name, viewport, colorScheme] of layouts) {
  test(`public shop preview on ${name}: browse, choose retail options and complete a demo checkout`, async () => {
    const context = await browser.newContext({ viewport, colorScheme, hasTouch: name === 'mobile', isMobile: name === 'mobile' });
    try {
      const page = await context.newPage();
      const errors = [];
      const api = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      const layoutFits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      const shot = async part => {
        if (process.env.SHOT_DIR) {
          await page.evaluate(() => Promise.all([...document.images].filter(image => image.loading !== 'lazy').map(image => image.decode().catch(() => {}))));
          await page.screenshot({ path: join(process.env.SHOT_DIR, `retail-${name}-${part}.png`), animations: 'disabled' });
        }
      };
      const response = await page.goto(`${server.base}/shop/`);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['x-robots-tag'], /noindex/);
      await page.getByRole('heading', { name: 'Coffee from the heart of Norwich.' }).waitFor();
      await page.waitForFunction(() => document.querySelector('.hero-visual img')?.naturalWidth > 0);
      assert.ok(await layoutFits());
      await shot('home');

      await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Shop coffee').click();
      await page.getByRole('searchbox', { name: 'Search coffee' }).fill('cherry bomb');
      assert.equal(await page.locator('#products .product-card').count(), 1);
      await page.getByRole('link', { name: /Ethiopia Cherry Bomb/ }).click();
      await page.getByRole('heading', { name: 'Ethiopia Cherry Bomb' }).waitFor();
      await page.getByRole('button', { name: 'Photo 2' }).click();
      assert.match(await page.locator('.detail-photo').getAttribute('src'), /ethiopia-cherry-bomb-detail\.webp$/);
      await page.getByRole('button', { name: 'Photo 1' }).click();
      await page.getByLabel('Bag weight').selectOption('500 g');
      await page.getByLabel('Grind').selectOption('Espresso / Fine');
      await page.getByRole('button', { name: 'Increase quantity' }).click();
      assert.ok(await layoutFits());
      await shot('product');
      await page.getByRole('button', { name: 'Add to basket' }).click();
      await page.getByRole('link', { name: 'Basket, 2 items' }).click();
      await page.getByText('500 g · Espresso / Fine').waitFor();
      assert.match(await page.locator('#totals').innerText(), /Free/, 'retail orders over £45 get free standard delivery');
      await page.reload();
      await page.getByText('500 g · Espresso / Fine').waitFor();
      await page.getByRole('button', { name: 'Decrease quantity' }).click();
      assert.match(await page.locator('#totals').innerText(), /£3\.50/);
      assert.ok(await layoutFits());
      await shot('basket');
      await page.getByRole('link', { name: 'Preview checkout' }).click();
      await page.getByRole('heading', { name: 'Preview checkout' }).waitFor();
      await page.getByRole('button', { name: 'Complete preview checkout' }).click();
      await page.getByRole('heading', { name: 'Preview checkout complete' }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Visit the live shop' }).getAttribute('href'), 'https://strangerscoffee.com/coffee');
      assert.deepEqual(api, []);

      await page.goto(`${server.base}/shop/coffee/?category=gifts`);
      await page.getByRole('link', { name: /Online Gift Card/ }).click();
      await page.getByLabel('Value').selectOption('£20.00');
      await page.getByRole('button', { name: 'Add to basket' }).click();
      await page.getByRole('link', { name: 'Basket, 1 item' }).click();
      await page.getByRole('heading', { name: 'Online Gift Card' }).waitFor();
      assert.match(await page.locator('#totals').innerText(), /Free/);
      await page.getByRole('button', { name: 'Remove Online Gift Card' }).click();
      await page.getByRole('heading', { name: 'Your basket is empty' }).waitFor();

      for (const [path, title] of [['locations', 'Visit us in Norwich'], ['brew-guides', 'Brew guides'], ['about', 'About Strangers'], ['contact', 'Contact us'], ['shipping', 'Delivery & returns']]) {
        await page.goto(`${server.base}/shop/${path}/`);
        await page.getByRole('heading', { level: 1, name: title }).waitFor();
        assert.ok(await layoutFits(), `${path} fits the viewport`);
      }
      assert.deepEqual(api, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('public preview only serves read-only shop routes and keeps wholesale sign-in available', async () => {
  const request = (path, options) => fetch(server.base + path, { redirect: 'manual', ...options });
  const shortcut = await request('/shop?category=decaf');
  assert.equal(shortcut.headers.get('location'), '/shop/?category=decaf');
  assert.equal((await request('/shop/checkout/', { method: 'POST' })).status, 405);
  assert.equal((await request('/shop/photos/unknown.webp')).status, 404);
  const entry = await request('/');
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/signin');
  assert.match(await (await request('/signin')).text(), /Wholesale sign-in/);
  assert.equal((await request('/api/wholesale/catalogue')).status, 401);
});
