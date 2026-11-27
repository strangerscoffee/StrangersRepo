import assert from 'node:assert/strict';
import { products } from '../public/consumer-preview/assets/products.js';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { startServer } from './harness.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const host = 'preview.staffstrangerscoffee.com';
const cartKey = 'strangers-coffee-proposal.cart.v1';
let server, browser;
before(async () => {
  server = await startServer({ host, vars: { LEGACY_PREVIEW_HOST: host } });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await server?.stop(); });

test('retail stock loads only when needed and cart edits preserve changes from a stale view', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    let stockRequests = 0;
    await context.route('**/api/retail/products', route => {
      stockRequests++;
      return route.fulfill(stockRequests === 1 ? { status: 503, json: {} } : { json: { products: products.map(item => ({ ...item, available: item.id !== 'christmas-blend' })) } });
    });
    const page = await context.newPage(), other = await context.newPage();
    await page.goto(server.base + '/about/');
    assert.equal(stockRequests, 0);
    await page.goto(server.base + '/coffee/');
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.equal(await page.locator('[data-product="christmas-blend"]').count(), 0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.locator('.product', { has: page.getByRole('heading', { name: 'Christmas Blend', exact: true }) })
      .getByText('Unavailable', { exact: true }).waitFor();
    assert.equal(stockRequests, 2);
    await other.goto(server.base + '/about/');

    const line = (id, qty) => ({ id, size: '250g', grind: 'Whole bean', qty });
    const house = line('house-blend', 1), roasters = line('roasters-blend', 1), rocko = line('rocko', 1);
    const write = (tab, lines) => tab.evaluate(([key, basket]) => localStorage.setItem(key, JSON.stringify(basket)), [cartKey, lines]);
    const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), cartKey);
    await write(other, [house]);
    await page.waitForFunction(() => document.querySelector('#bag-count').textContent === '1');
    await page.locator('[data-bag]').first().click();
    await write(page, [roasters, { ...house, qty: 3 }]);
    await page.getByRole('button', { name: /Increase quantity for House Blend/ }).click();
    assert.deepEqual(await read(), [roasters, { ...house, qty: 4 }]);

    await write(page, [rocko, roasters, { ...house, qty: 4 }]);
    await page.getByRole('button', { name: /Remove House Blend/ }).click();
    assert.deepEqual(await read(), [rocko, roasters]);
    await write(other, [house, roasters]);
    await page.getByRole('button', { name: /Remove House Blend/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Remove .*Rocko/ }).count(), 0);
  } finally {
    await context.close();
  }
});

test('retail account conceals private details while verifying a restored page and clears the old draft on an auth change', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  let release;
  try {
    const alice = { identity: { email: 'alice@example.test' }, profileSession: 'a'.repeat(64), profile: { name: 'Alice', address: '1 Alice Street' }, orders: [] };
    const bob = { identity: { email: 'bob@example.test' }, profileSession: 'b'.repeat(64), profile: { name: 'Bob', address: '2 Bob Street' }, orders: [] };
    let active = alice, hold, requested, profileWrite;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { requested = resolve; });
    await context.route('**/api/account', async route => {
      if (route.request().method() === 'PUT') {
        profileWrite = route.request().headers()['x-retail-profile-session'];
        return route.fulfill({ json: { profile: route.request().postDataJSON() } });
      }
      if (hold) { requested(); await held; }
      return route.fulfill({ json: active });
    });
    const page = await context.newPage(), other = await context.newPage();
    await other.goto(server.base + '/about/');
    await page.goto(server.base + '/account/#details');
    const dashboard = page.locator('#account-dashboard'), title = page.locator('#account-title');
    const address = page.locator('#account-profile input[name="address"]');
    await dashboard.waitFor();
    assert.match(await title.textContent(), /Alice/);
    await address.fill('Alice’s unsaved address');

    hold = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await arrived;
    assert.equal(await dashboard.isVisible(), false);
    assert.equal(await title.textContent(), 'My account');

    active = bob;
    await other.evaluate(() => localStorage.setItem('strangers-retail.account-changed', 'fixture'));
    hold = false;
    release();
    await page.waitForFunction(() => document.querySelector('#account-title').textContent.includes('Bob'));
    assert.equal(await address.inputValue(), bob.profile.address);
    assert.equal(await page.getByText('1 Alice Street', { exact: true }).count(), 0);
    await page.locator('#account-profile button[type="submit"]').click();
    await page.getByText('Account details saved.').waitFor();
    assert.equal(profileWrite, bob.profileSession);
  } finally {
    release?.();
    await context.close();
  }
});

for (const [name, afterCheck] of [['sign-out', null], ['account switch', {
  identity: { email: 'bob@example.test' }, profileSession: 'b'.repeat(64),
  profile: { name: 'Bob', address: '2 Bob Street', town: 'Norwich', postcode: 'NR1 1AA' },
}]]) test(`checkout requires a new review after ${name}`, { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  let release;
  try {
    await context.route('**/checkout/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-retail-signed-in') });
    });
    await context.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify([{ id: 'house-blend', size: '250g', grind: 'Whole bean', qty: 1 }]));
    }, { key: cartKey });
    let account = {
      identity: { email: 'alice@example.test' }, profileSession: 'a'.repeat(64),
      profile: { name: 'Alice', address: '1 Alice Street', town: 'Norwich', postcode: 'NR1 1AA' },
    };
    let hold = false, started;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    const requests = [];
    await context.route('**/api/account', async route => {
      if (hold) { started(); await held; }
      return route.fulfill(account ? { json: account } : { status: 401, json: {} });
    });
    await context.route('**/api/retail/products', route => route.fulfill({ json: { products } }));
    await context.route('**/api/retail/orders', route => {
      requests.push({ binding: route.request().headers()['x-retail-profile-session'], body: route.request().postDataJSON() });
      return route.fulfill({ status: 409, json: { error: 'checkout_session_changed' } });
    });

    const page = await context.newPage();
    await page.goto(server.base + '/checkout/');
    await page.getByRole('button', { name: 'Review order' }).click();
    await page.getByText('alice@example.test', { exact: false }).waitFor();
    account = afterCheck;
    hold = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await arrived;
    assert.equal(await page.getByText('alice@example.test', { exact: false }).isVisible(), false);
    hold = false;
    release();
    await page.getByRole('button', { name: 'Place test order' }).waitFor({ state: 'hidden' });

    if (afterCheck) {
      await page.waitForFunction(() => document.querySelector('#retail-checkout-form input[name="email"]')?.value === 'bob@example.test');
    } else {
      await page.getByRole('button', { name: 'Continue as a guest' }).click();
      assert.equal(await page.locator('#retail-checkout-form input[name="address"]').inputValue(), '');
      await page.getByRole('button', { name: 'Fill sample details' }).click();
    }
    assert.equal(requests.length, 0, 'changing the session never starts an order');
    await page.getByRole('button', { name: 'Review order' }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/retail/orders')),
      page.getByRole('button', { name: 'Place test order' }).click(),
    ]);
    assert.equal(requests[0].binding, afterCheck?.profileSession ?? 'guest');
    assert.equal(requests[0].body.contact.email, afterCheck?.identity.email ?? 'jamie@example.com');
  } finally {
    release?.();
    await context.close();
  }
});

const aliceCheckout = {
  identity: { email: 'alice@example.test' }, profileSession: 'a'.repeat(64),
  profile: { name: 'Alice', address: '1 Alice Street', town: 'Norwich', postcode: 'NR1 1AA' },
};
const checkoutOrder = {
  reference: 'SC-0123ABCD', method: 'delivery', status: 'placed',
  contact: { ...aliceCheckout.profile, email: aliceCheckout.identity.email },
  lines: [],
  pricing: { subtotal: 1050, shipping: 300, total: 1350 },
};

test('signed receipt conceals private information on lifecycle restore and removes it when access is lost', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  let release;
  try {
    let authorized = true, hold = false, started;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    const claim = 'c'.repeat(43), tracking = [];
    await context.route('**/api/account', async route => {
      if (hold) { started(); await held; }
      return route.fulfill({ json: aliceCheckout });
    });
    await context.route('**/api/retail/products', route => route.fulfill({ json: { products } }));
    await context.route('**/api/retail/orders/*', route => {
      const binding = route.request().headers()['x-retail-profile-session'];
      const { token } = route.request().postDataJSON();
      tracking.push({ binding, token });
      if (binding === 'guest' && token === claim) return route.fulfill({ json: { order: { ...checkoutOrder, contact: null } } });
      if (binding === aliceCheckout.profileSession && authorized) return route.fulfill({ json: { order: checkoutOrder } });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    const url = server.base + '/checkout/?order=' + checkoutOrder.reference;
    await page.goto(url);
    await page.getByText('1 Alice Street').waitFor();
    hold = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await arrived;
    assert.equal(await page.getByText('1 Alice Street').isVisible(), false);
    hold = false;
    release();
    await page.getByText('1 Alice Street').waitFor();
    authorized = false;
    await page.getByRole('button', { name: 'Refresh order status' }).click();
    await page.getByRole('heading', { name: 'Order unavailable' }).waitFor();
    assert.equal(await page.getByText('1 Alice Street').count(), 0);

    const guestPage = await context.newPage();
    await guestPage.goto(url + '#' + claim);
    await guestPage.getByRole('heading', { name: 'Order ' + checkoutOrder.reference }).waitFor();
    assert.deepEqual(tracking.at(-1), { binding: 'guest', token: claim });
    assert.equal(await guestPage.getByText('1 Alice Street').count(), 0);
    const invalidPage = await context.newPage();
    await invalidPage.goto(url + '#' + 'd'.repeat(43));
    await invalidPage.getByRole('heading', { name: 'Order unavailable' }).waitFor();
  } finally {
    release?.();
    await context.close();
  }
});

test('a placement response from the former account cannot fill the current checkout', { timeout: 60000 }, async () => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  let release;
  try {
    await context.route('**/checkout/', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-retail-signed-in') });
    });
    const house = { id: 'house-blend', size: '250g', grind: 'Whole bean', qty: 1 };
    await context.addInitScript(({ key, house }) => localStorage.setItem(key, JSON.stringify([house])), { key: cartKey, house });
    let account = aliceCheckout;
    const bob = { identity: { email: 'bob@example.test' }, profileSession: 'b'.repeat(64), profile: { name: 'Bob' } };
    await context.route('**/api/account', route => route.fulfill({ json: account }));
    await context.route('**/api/retail/products', route => route.fulfill({ json: { products } }));
    let started;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { started = resolve; });
    await context.route('**/api/retail/orders', async route => {
      assert.equal(route.request().headers()['x-retail-profile-session'], aliceCheckout.profileSession);
      started();
      await held;
      return route.fulfill({ json: { order: checkoutOrder } });
    });
    const page = await context.newPage();
    await page.goto(server.base + '/checkout/');
    await page.getByRole('button', { name: 'Review order' }).click();
    await page.getByRole('button', { name: 'Place test order' }).click();
    await arrived;
    account = bob;
    await page.evaluate(({ key, house }) => localStorage.setItem(key, JSON.stringify([{ ...house, qty: 2 }])), { key: cartKey, house });
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/account')),
      page.evaluate(() => window.dispatchEvent(new Event('focus'))),
    ]);
    await page.locator('#retail-checkout').waitFor();
    release();
    await page.getByText('Your account changed.', { exact: false }).waitFor();
    assert.equal(await page.getByText('1 Alice Street').count(), 0);
    assert.equal(await page.locator('#retail-checkout-form input[name="address"]').inputValue(), '');
    assert.equal(await page.locator('#retail-checkout-form input[name="email"]').inputValue(), '');
    assert.equal(new URL(page.url()).searchParams.has('order'), false);
  } finally {
    release?.();
    await context.close();
  }
});

test('an older saved attempt can be checked in history or explicitly dismissed without submitting it', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify([{ id: 'house-blend', size: '250g', grind: 'Whole bean', qty: 1 }]));
      sessionStorage.setItem('strangers-coffee-retail.order-attempt.v2', JSON.stringify({
        createdAt: Date.now(), key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', identity: 'account',
        payload: { contact: { name: 'Previous shopper' }, lines: [{ id: 'house-blend', size: '250g', grind: 'Whole bean', qty: 1 }] },
      }));
    }, cartKey);
    await context.route('**/api/account', route => route.fulfill({ json: aliceCheckout }));
    await context.route('**/api/retail/products', route => route.fulfill({ json: { products } }));
    let placements = 0;
    await context.route('**/api/retail/orders', route => { placements++; return route.abort(); });
    const page = await context.newPage();
    await page.goto(server.base + '/checkout/');
    await page.locator('#retail-checkout a[href="/account/#orders"]').getByText('My account').waitFor();
    await page.getByRole('button', { name: 'Start a new checkout' }).click();
    await page.waitForFunction(() => document.querySelector('#retail-checkout-form input[name="email"]')?.value === 'alice@example.test');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('strangers-coffee-retail.order-attempt.v2')), null);
    assert.equal(placements, 0);
  } finally {
    await context.close();
  }
});

test('a renewed session for the same checkout account retries the same order key and payload', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const payload = { contact: checkoutOrder.contact, lines: [{ id: 'house-blend', size: '250g', grind: 'Whole bean', qty: 1 }] };
    const key = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await context.addInitScript(({ key, payload, email }) => {
      sessionStorage.setItem('strangers-coffee-retail.order-attempt.v2', JSON.stringify({
        createdAt: Date.now(), key, identity: { email, session: 'd'.repeat(64) }, payload,
      }));
    }, { key, payload, email: aliceCheckout.identity.email });
    await context.route('**/api/account', route => route.fulfill({ json: aliceCheckout }));
    await context.route('**/api/retail/products', route => route.fulfill({ json: { products } }));
    let placement;
    await context.route('**/api/retail/orders', route => {
      placement = { binding: route.request().headers()['x-retail-profile-session'], body: route.request().postDataJSON() };
      return route.fulfill({ status: 503, json: {} });
    });
    const page = await context.newPage();
    await page.goto(server.base + '/checkout/');
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/retail/orders')),
      page.getByRole('button', { name: 'Confirm order' }).click(),
    ]);
    assert.deepEqual(placement, { binding: aliceCheckout.profileSession, body: { ...payload, idempotencyKey: key } });
  } finally {
    await context.close();
  }
});

test('edited copy, accessory sizes and coffees without a 250 g bag use the current catalogue', async () => {
  const { productPageView } = await import('../public/consumer-preview/assets/product-page.js');
  const { finderVariant } = await import('../public/consumer-preview/assets/finder.js');
  const { shelfProducts } = await import('../public/consumer-preview/assets/storefront-views.js');
  const old = [...products];
  try {
    const original = old.find(item => item.id === 'bom-jesus');
    const edited = { ...original, shortCopy: 'Fresh crop <new>', story: 'An amended producer story.',
      prices: { '500g': 1795 }, region: 'New Region', available: true };
    const accessory = { id: 'coffee-caddy', category: 'accessory', name: 'Coffee caddy', notes: [],
      image: original.image, shortCopy: 'For beans', grinds: ['N/A'], prices: { '250g': 900, '500g': 1100 } };
    products.splice(0, products.length, edited, accessory);
    const {markup} = productPageView('bom-jesus', '', true);
    assert.match(markup, /Fresh crop &lt;new&gt;/);
    assert.match(markup, /An amended producer story/);
    assert.match(markup, /New Region/);
    assert.deepEqual(finderVariant(edited, 'Whole bean'), {size:'500g', grind:'Whole bean', price:1795});
    assert.match(shelfProducts([edited], true), /From £17\.95/);
    const choices = productPageView(accessory.id, '', true).markup;
    assert.match(choices, /type="radio" name="size" value="250g"/);
    assert.match(choices, /type="radio" name="size" value="500g"/);
  } finally {
    products.splice(0, products.length, ...old);
  }
});
