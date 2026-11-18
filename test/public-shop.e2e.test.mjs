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
      await context.route('**/shop/instagram.json', route => route.fulfill({ json: { posts: [] } }));
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
      const shelf = page.getByRole('region', { name: 'On the coffee shelf' });
      const more = shelf.getByText('More from the coffee shelf', { exact: true });
      await more.click();
      assert.equal(await shelf.locator('.product-card:visible').count(), 10);
      await more.click();
      const best = page.getByRole('region', { name: 'Best selling coffees' });
      const brazil = best.getByRole('form', { name: 'Buy Brazil Fazenda Bom Jesus Natural' });
      await brazil.getByLabel('Bag weight').selectOption('250 g');
      await brazil.getByLabel('Grind').selectOption('Whole bean');
      assert.ok(await layoutFits());
      if (process.env.SHOT_DIR) {
        await best.evaluate(node => window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 156));
        await best.locator('img').first().evaluate(image => image.decode());
      }
      await shot('best-sellers');
      await brazil.getByRole('button', { name: 'Add to basket' }).click();
      await page.getByRole('link', { name: 'Basket, 1 item' }).click();
      await page.getByText('250 g · Whole bean').waitFor();
      await page.getByRole('button', { name: 'Remove Brazil Fazenda Bom Jesus Natural' }).click();
      await page.getByRole('heading', { name: 'Your basket is empty' }).waitFor();
      await page.goto(`${server.base}/shop/`);
      const photo = page.locator('.social-grid img').first();
      await photo.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('.social-grid img')?.naturalWidth > 0);
      assert.match(await page.locator('footer').innerText(), /122 Ber Street, Norwich NR1 3ES/);

      if (name === 'mobile') await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Shop coffee').click();
      await page.getByRole('searchbox', { name: 'Search coffee' }).fill('cherry bomb');
      assert.equal(await page.locator('#products .product-card').count(), 1);
      await page.getByRole('link', { name: /Ethiopia Cherry Bomb/ }).click();
      await page.getByRole('heading', { name: 'Ethiopia Cherry Bomb' }).waitFor();
      await page.getByText('Provenance', { exact: true }).click();
      await page.getByText(/Altitude: 1900 - 2200 MASL/).waitFor();
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
      for (const [path, title] of [['privacy-policy', 'Privacy policy'], ['terms-conditions', 'Terms & conditions'], ['wholesale', 'Wholesale coffee'], ['norwich-racing-team', 'Norwich Racing Team'], ['coffee/washed', 'Washed'], ['blog/tag/EK43', 'Blog · EK43']]) {
        await page.goto(`${server.base}/shop/${path}/`);
        await page.getByRole('heading', { level: 1, name: title }).waitFor();
        assert.ok(await layoutFits(), `${path} fits the viewport`);
      }
      assert.equal(await page.locator('.archive-card').count(), 1);
      await page.locator('.archive-card').click();
      await page.locator('.article-content').waitFor();
      assert.deepEqual(api, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('the mobile shop menu opens and closes without moving the page and keeps keyboard focus visible', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  try {
    await page.route('**/shop/instagram.json', route => route.fulfill({ json: { posts: [] } }));
    await page.goto(`${server.base}/shop/`);
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    const basket = page.getByRole('link', { name: 'Basket, 0 items' });
    const nav = page.locator('#shop-nav');
    const firstLink = nav.getByRole('link', { name: 'Shop coffee' });
    const hero = page.getByRole('heading', { name: 'Coffee from the heart of Norwich.' });
    await hero.waitFor();
    await page.waitForFunction(() => {
      const logo = document.querySelector('.shop-header .wordmark img');
      return logo.currentSrc.endsWith('/shop/logo.svg') && logo.naturalWidth > 0;
    });
    assert.equal(await nav.evaluate(node => node.inert), true);
    assert.equal(await basket.locator('#basket-count').innerText(), '0');
    assert.equal(await basket.locator('#basket-count').isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const heroTop = (await hero.boundingBox()).y;
    const menuBox = await toggle.boundingBox();
    const basketBox = await basket.boundingBox();
    assert.ok(menuBox.height >= 44 && basketBox.height >= 44);
    assert.ok(basketBox.x + basketBox.width <= menuBox.x);

    await basket.focus();
    await page.keyboard.press('Tab');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    await nav.waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await nav.evaluate(node => node.inert), false);
    assert.equal((await hero.boundingBox()).y, heroTop);
    await page.keyboard.press('Tab');
    assert.equal(await firstLink.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await nav.evaluate(node => node.inert), true);
    await nav.waitFor({ state: 'hidden' });

    const transitions = await nav.evaluate(async panel => {
      const button = panel.previousElementSibling;
      const animatedProperties = () => panel.getAnimations().map(animation => animation.transitionProperty);
      button.click();
      const opening = animatedProperties();
      await Promise.all(panel.getAnimations().map(animation => animation.finished));
      button.click();
      return { opening, closing: animatedProperties() };
    });
    for (const direction of [transitions.opening, transitions.closing]) {
      assert.ok(direction.includes('opacity') && direction.includes('transform'));
    }
    await nav.waitFor({ state: 'hidden' });

    await toggle.click();
    await page.locator('.hero-visual').click();
    await nav.waitFor({ state: 'hidden' });
    await toggle.click();
    await page.setViewportSize({ width: 900, height: 640 });
    await toggle.waitFor({ state: 'hidden' });
    await firstLink.waitFor();
    assert.equal(await nav.evaluate(node => node.inert), false);
    await page.setViewportSize({ width: 320, height: 640 });
    await nav.waitFor({ state: 'hidden' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggle.click();
    await nav.waitFor({ state: 'visible' });
    assert.equal(await nav.evaluate(node => getComputedStyle(node).transitionProperty), 'none');
    await firstLink.click();
    await page.getByRole('heading', { name: 'Shop coffee' }).waitFor();
    assert.equal(await nav.isVisible(), false);
    await toggle.click();
    assert.equal(await firstLink.getAttribute('aria-current'), 'page');
  } finally { await page.close(); }
});

test('public shop keyboard focus stays below the sticky header', async () => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 1024 }]) {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(`${server.base}/shop/coffee/`);
      await page.getByRole('heading', { name: 'Shop coffee' }).waitFor();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      const focusIsClear = () => page.waitForFunction(() => {
        const header = document.querySelector('.shop-header').getBoundingClientRect();
        return document.activeElement.getBoundingClientRect().top >= header.bottom;
      });
      assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
      await focusIsClear();

      await page.getByRole('searchbox', { name: 'Search coffee' }).focus();
      const previous = page.getByRole('button', { name: 'Gift cards' });
      await previous.evaluate(async button => {
        await new Promise(requestAnimationFrame);
        const header = document.querySelector('.shop-header').getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        window.scrollBy({ top: bounds.bottom - header.bottom + 2, behavior: 'instant' });
      });
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator(':focus').textContent(), 'Gift cards');
      await focusIsClear();
    } finally { await page.close(); }
  }
});

test('public preview only serves read-only shop routes and keeps wholesale sign-in available', async () => {
  const request = (path, options) => fetch(server.base + path, { redirect: 'manual', ...options });
  const shortcut = await request('/shop?category=decaf');
  assert.equal(shortcut.headers.get('location'), '/shop/?category=decaf');
  assert.equal((await request('/shop/checkout/', { method: 'POST' })).status, 405);
  assert.equal((await request('/shop/instagram.json', { method: 'POST' })).status, 405);
  const logo = await request('/shop/logo.svg');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal((await request('/shop/photos/unknown.webp')).status, 404);
  const entry = await request('/');
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/signin');
  assert.match(await (await request('/signin')).text(), /Wholesale sign-in/);
  assert.equal((await request('/api/wholesale/catalogue')).status, 401);
});

test('the homepage replaces its Instagram gallery when the feed returns newer posts', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/shop/instagram.json', route => route.fulfill({ json: { posts: [{
      code: 'a-NewPost', href: 'https://www.instagram.com/p/a-NewPost/', label: 'A newer roasting photo',
    }] } }));
    await page.route('**/shop/instagram-photo/a-NewPost', route => route.fulfill({
      path: join(import.meta.dirname, '../public/shop/photos/roastery.webp'), contentType: 'image/webp',
    }));
    await page.goto(`${server.base}/shop/`);
    const photo = page.getByRole('link', { name: 'A newer roasting photo · Instagram' });
    await photo.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#instagram-posts img')?.naturalWidth > 0);
    assert.equal(await photo.getAttribute('href'), 'https://www.instagram.com/p/a-NewPost/');
    assert.equal(await page.locator('#instagram-posts a').count(), 1);
  } finally { await page.close(); }
});
