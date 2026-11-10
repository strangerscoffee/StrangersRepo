// Customer sorting retains configured coffee and refresh controls recover after failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startServer, SETUP_CODE } from './harness.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let srv, browser, cookie;
async function api(path, body, auth = cookie) {
  const r = await fetch(srv.base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json(); assert.ok(r.ok, path + ': ' + JSON.stringify(data));
  return { data, cookie: (r.headers.getSetCookie().find(v => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || '').split(';')[0] };
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  cookie = (await api('/api/auth/setup', { name: 'UI Owner', username: 'uiowner', password: 'ui-owner-password', code: SETUP_CODE })).cookie;
  const customer = (await api('/api/admin/wholesale/customers', { business: 'UI Coffee', contact: 'Buyer', email: 'buyer@example.test', address: '10 Coffee Street', postcode: 'NR1 1AA', status: 'Active' })).data.customer;
  const account = (await api(`/api/admin/wholesale/customers/${customer.id}/account`, { username: 'uicoffee' })).data;
  cookie = (await api('/api/wholesale/auth/change-password', { username: 'uicoffee', password: account.temporaryPassword, newPassword: 'ui-buyer-password' }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const [device, viewport] of [['phone', {width:393,height:852}], ['ipad', {width:820,height:1180}], ['desktop', {width:1440,height:1000}]]) for (const colorScheme of ['light','dark']) {
  test(`customer UI ${device} ${colorScheme}: price sorting, retained choices, refresh busy and failure recovery`, {timeout:120000}, async () => {
    const context = await browser.newContext({ viewport, colorScheme });
    const [name,value] = cookie.split('='); await context.addCookies([{name,value,url:srv.base}]);
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    let release = () => {};
    try {
      await page.goto(srv.base + '/wholesale-preview/');
      await page.locator('.product-config').first().waitFor();
      await page.locator('#products[aria-busy="false"]').waitFor();
      await page.locator('#sort-coffee').click();
      await page.locator('#sort-menu:popover-open').waitFor();
      await page.waitForFunction(() => document.activeElement?.matches('#sort-menu [aria-checked="true"]'));
      await page.keyboard.press('End'); assert.equal(await page.evaluate(()=>document.activeElement.dataset.sort), 'price-desc');
      await page.keyboard.press('Home'); assert.equal(await page.evaluate(()=>document.activeElement.dataset.sort), 'catalogue');
      const bounds = await page.locator('#sort-menu').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'dropdown fits the viewport');
      await page.locator('#coffee-title').click(); await page.locator('#sort-menu:popover-open').waitFor({state:'hidden'});
      assert.equal(await page.locator('#sort-coffee').getAttribute('aria-expanded'),'false');
      const original = await page.locator('#products > article').evaluateAll(nodes => nodes.map(n => n.dataset.product));
      const card = page.locator('#products > article').first(), product = await card.getAttribute('data-product');
      await card.locator('input[name="pack"][value="quarter"]').check();
      await card.locator('input[type="number"]').fill('3');
      await card.locator('[data-grind-open]').click(); await page.locator('#grind-choice-form input[value="filter"]').check(); await page.locator('#confirm-grind').click();
      const prices = () => page.locator('#products > article').evaluateAll(nodes => nodes.map(n => Number(n.querySelector('[data-price]').textContent.replace(/[^0-9.]/g,''))));
      async function choose(value, apply=true) {
        await page.locator('#sort-coffee').click(); await page.locator('#sort-menu:popover-open').waitFor();
        if (apply) await page.locator(`#sort-menu [data-sort="${value}"]`).click();
        else { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); }
        await page.locator('#sort-menu:popover-open').waitFor({state:'hidden'});
      }
      await choose('price-asc'); let values = await prices(); assert.deepEqual(values, [...values].sort((a,b)=>a-b));
      await choose('price-desc', false); assert.deepEqual(await prices(), values, 'cancel does not change sorting');
      await choose('price-desc'); values = await prices(); assert.deepEqual(values, [...values].sort((a,b)=>b-a));
      const retained = page.locator(`.product-config[data-product="${product}"]`);
      assert.equal(await retained.locator('input[name="pack"]:checked').inputValue(), 'quarter');
      assert.equal(await retained.locator('select[name="grind"]').inputValue(), 'filter');
      assert.equal(await retained.locator('input[type="number"]').inputValue(), '3');
      await retained.locator('input[name="pack"][value="kilo"]').check(); values = await prices(); assert.deepEqual(values, [...values].sort((a,b)=>b-a), 'pack price changes update ordering');
      await page.locator('#coffee-search').fill('brazil'); assert.ok(await page.locator('#products > article:visible').count());
      await page.locator('#coffee-search').fill(''); await choose('catalogue');
      assert.deepEqual(await page.locator('#products > article').evaluateAll(nodes => nodes.map(n=>n.dataset.product)), original);
      async function refresh(id, path, fail) {
        let entered; const started = new Promise(r => entered=r), gate = new Promise(r=>release=r);
        await page.route('**'+path, async route => { entered(); await gate; if (fail) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Temporary test outage'})}); else await route.continue(); });
        const button = page.locator(id); await button.click(); await started;
        assert.equal(await button.getAttribute('aria-busy'), 'true'); assert.equal(await button.isDisabled(), true);
        assert.equal((await button.textContent()).trim(), ''); assert.ok(await button.getAttribute('aria-label'));
        assert.equal(await button.locator('svg').evaluate(n => getComputedStyle(n).animationName), 'refresh-spin');
        await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await button.locator('svg').evaluate(n=>getComputedStyle(n).animationName), 'none'); await page.emulateMedia({reducedMotion:'no-preference'});
        release(); await page.locator(id+'[aria-busy="false"]').waitFor(); assert.equal(await button.isEnabled(),true); await page.unroute('**'+path);
      }
      assert.equal(await page.locator('#refresh-catalogue').count(),0);
      assert.ok(await page.locator('#sort-coffee').getAttribute('aria-label'));
      const iconButton = await page.locator('#sort-coffee').boundingBox(); assert.ok(iconButton.width >= 44 && iconButton.width <= 48, 'compact accessible icon button');
      await page.locator('#my-orders').click(); await page.locator('#refresh-orders[aria-busy="false"]').waitFor();
      await refresh('#refresh-orders','/api/wholesale/orders',false);
      await page.locator('#history-invoices').click(); await page.locator('#refresh-invoices[aria-busy="false"]').waitFor();
      await refresh('#refresh-invoices','/api/wholesale/invoices',true);
      await refresh('#refresh-invoices','/api/wholesale/invoices',false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      if (process.env.WHOLESALE_SCREENSHOT_DIR) { await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR,{recursive:true}); await page.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/customer-sort-${device}-${colorScheme}-invoices.png`}); await page.locator('#orders-dialog [data-close]').click(); await page.evaluate(() => scrollTo(0,0)); await page.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/customer-sort-${device}-${colorScheme}-catalogue.png`}); await page.locator('#sort-coffee').click(); await page.locator('#sort-menu:popover-open').waitFor(); await page.waitForTimeout(180); await page.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/customer-sort-${device}-${colorScheme}-choices.png`}); }
      assert.deepEqual(errors,[]);
    } finally { release(); await context.close(); }
  });
}
