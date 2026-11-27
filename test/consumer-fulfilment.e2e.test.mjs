// The Consumer fulfilment desk in the real Admin shell, using a local service stand-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startServer, SETUP_CODE } from './harness.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let srv, browser, cookie;
before(async () => {
  srv = await startServer();
  const response = await fetch(srv.base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Consumer Test Admin', username: 'consumer.owner', password: 'consumer-test-owner-password', code: SETUP_CODE }) });
  cookie = response.headers.getSetCookie().find(value => /^sfbb_session=[\w-]/.test(value)).split(';')[0];
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const [device, viewport, colorScheme] of [['desktop', { width: 1440, height: 1000 }, 'light'], ['phone', { width: 393, height: 852 }, 'dark']]) test('Consumer fulfilment ' + device + ': queued packing, dispatch, collection and support', { timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport, colorScheme });
  const [name, value] = cookie.split('='); await context.addCookies([{ name, value, url: srv.base }]);
  const page = await context.newPage(), errors = [], writes = [];
  const isPhone = device === "phone";
  async function openSection(section) {
    if (isPhone) await page.locator("#consumerSection").selectOption(section);
    else await page.locator(`#consumerTabs [data-id="${section}"]`).click();
  }
  async function openOrder(reference) {
    await page.locator('#consumerQueueRows[aria-busy="false"]').locator(`[data-id="${reference}"]`).click();
  }
  page.on('pageerror', error => errors.push(error.message));
  const make = (reference, method) => ({ reference, createdAt: '2026-11-26T10:00:00.000Z', method, contact: { name: method === 'delivery' ? 'Jamie Reed' : 'Sam Bell', email: 'buyer@example.test', phone: '01603 123456', address: '10 Coffee Street', town: 'Norwich', postcode: 'NR1 1AA' }, cafe: method === 'collection' ? { name: 'Roastery', address: '10 Dove Street' } : null, deliveryService: 'Royal Mail Tracked 48', total: 2600, paymentMode: 'test', paymentStatus: 'test', status: 'placed', version: 0, packedLines: [], tracking: null, timeline: [{ status: 'placed', at: '2026-11-26T10:00:00.000Z' }], lines: [{ product: { name: 'Brazil Fazenda Bom Jesus Natural' }, size: '250g', grind: 'Whole bean', qty: 1 }, { product: { name: 'Ethiopia Rocko Mountain Natural' }, size: '250g', grind: 'Filter', qty: 1 }] });
  const orders = [make('SC-11111111', 'delivery'), make('SC-22222222', 'collection')];
  const support = [{ reference: 'HELP-1234ABCD', subject: 'Order enquiry', name: 'Jamie Reed', email: 'buyer@example.test', message: '<img src=x onerror=alert(1)> Please check my delivery.', orderReference: 'SC-11111111', createdAt: '2026-11-26T10:00:00.000Z', resolved: false }];
  support.push({ ...support[0], reference: 'HELP-AABBCCDD', orderReference: 'SC-22222222', subject: 'Older %_ enquiry', message: 'An older message.' });
  let releaseFirst, firstArrived;
  const held = new Promise(resolve => { releaseFirst = resolve; }), arrived = new Promise(resolve => { firstArrived = resolve; });
  let holdBrowse = false, releaseBrowse, browseArrived;
  let holdReload = false, releaseReload, reloadArrived;
  const reloadHeld = new Promise(resolve => { releaseReload = resolve; });
  const reloadRequested = new Promise(resolve => { reloadArrived = resolve; });
  const browseHeld = new Promise(resolve => { releaseBrowse = resolve; });
  const browseRequested = new Promise(resolve => { browseArrived = resolve; });
  const summary = () => ({ total: orders.length, toPack: orders.filter(order => ['placed', 'preparing'].includes(order.status)).length, ready: orders.filter(order => order.status === 'ready').length, dispatched: orders.filter(order => order.status === 'dispatched').length });
  await page.route('**/api/admin/consumer**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/admin/consumer', '');
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!path) return respond({ connected: true, previewUrl: 'https://preview.example.test/', orders, orderCount: orders.length, orderSummary: summary(), orderCursor: null, customers: [{ name: 'Jamie Reed', phone: '01603 123456' }], products: [{ id: 'brazil', name: 'Brazil Bom Jesus', available: true }], readiness: [], settings: { acceptOrders: true } });
    if (path === '/orders') {
      const filter = url.searchParams.get('status'), q = (url.searchParams.get('q') || '').toLowerCase();
      if (holdBrowse) {
        holdBrowse = false;
        browseArrived();
        await browseHeld;
      }
      const rows = orders.filter(order => (!filter || filter === 'all' || (filter === 'to-pack' ? ['placed', 'preparing'].includes(order.status) : order.status === filter)) && [order.reference, order.contact.name].some(value => value.toLowerCase().includes(q)));
      if (holdReload && !filter && q === 'sc-11111111') {
        holdReload = false;
        const snapshot = structuredClone(rows);
        reloadArrived();
        await reloadHeld;
        return respond({ orders: snapshot });
      }
      return respond({ orders: rows, count: rows.length, nextCursor: null, summary: summary() });
    }
    if (path.startsWith('/orders/')) {
      const order = orders.find(order => order.reference === path.split('/').at(-1)), body = request.postDataJSON(); writes.push(body);
      if (writes.length === 1 && body.packedLines) { firstArrived(); await held; }
      if (body.ifVersion !== order.version) return respond({ message: 'Order changed. Reload latest order.', error: 'order_conflict' }, 409);
      if (body.packedLines) order.packedLines = body.packedLines;
      if (body.status) { order.status = body.status; order.timeline.push({ status: order.status, at: '2026-11-26T12:00:00.000Z' }); }
      if (body.tracking) order.tracking = { ...body.tracking, url: 'https://www.royalmail.com/track-your-item#/tracking-results/' + body.tracking.number, shippedAt: '2026-11-26T12:00:00.000Z' };
      order.version++; return respond({ order });
    }
    if (path === '/support') {
      const search = url.searchParams.get('q') || '', cursor = url.searchParams.get('cursor');
      const all = support.filter(item => [item.reference, item.subject].some(value => value.toLowerCase().includes(search.toLowerCase())));
      const after = cursor ? 1 : 0;
      return respond({ messages: all.slice(after, after + 1), count: all.length, nextCursor: all.length > after + 1 ? 'next' : null,
        query: { search, cursor }, supportGateway: 1 });
    }
    if (path.startsWith('/support/')) { support[0].resolved = request.postDataJSON().resolved; return respond({ message: support[0] }); }
    return respond({ message: 'Unexpected fixture route' }, 404);
  });
  try {
    await page.goto(srv.base + '/admin#consumer');
    await openSection("orders");
    if (isPhone) {
      assert.equal(await page.locator("#consumerOrderDetail").isVisible(), false);
      await openOrder("SC-11111111");
      assert.equal(await page.locator("#consumerDetailTitle").evaluate(title => title === document.activeElement), true);
    }
    await page.locator('#consumerPack-0').waitFor();
    assert.equal(await page.getByText('Paid', { exact: true }).count(), 0, 'test orders never masquerade as live paid orders');
    await page.locator('#consumerPack-0').check(); await arrived;
    assert.equal(await page.locator('#consumerPack-0').isChecked(), true, 'the packing tick appears before its response');
    await page.locator('#consumerPack-1').check(); releaseFirst();
    await page.waitForFunction(() => document.querySelector('#consumerPackedCount')?.textContent.includes('2 of 2') && !document.querySelector('#consumerPackedCount').textContent.includes('Saving'));
    assert.deepEqual(writes.slice(0, 2).map(body => body.packedLines), [[0], [0, 1]]);
    assert.deepEqual(writes.slice(0, 2).map(body => body.ifVersion), [0, 1]);
    orders[0].packedLines = [1];
    orders[0].version++;
    if (isPhone) await page.locator('#consumerOrderBack').click();
    await page.locator('#consumerRefresh').click();
    await page.locator('#consumerPanel[aria-busy="false"]').waitFor();
    if (isPhone) await openOrder('SC-11111111');
    await page.waitForFunction(() => !document.querySelector('#consumerPack-0')?.checked && document.querySelector('#consumerPack-1')?.checked);
    await page.locator('#consumerPack-1').uncheck();
    await page.waitForFunction(() => document.querySelector('#consumerPackedCount')?.textContent === '0 of 2 lines');
    assert.deepEqual(writes[2].packedLines, [], 'checking another line preserves the colleague’s unpacked line');
    assert.equal(writes[2].ifVersion, 3);

    orders[0].packedLines = [1];
    orders[0].version++;
    await page.locator('#consumerPack-0').click();
    const reload = page.getByRole('button', { name: 'Reload latest order' });
    if (!isPhone) {
      holdReload = true;
      await reload.click();
      await reloadRequested;
      assert.equal(await reload.isDisabled(), true);
      orders[0].version++;
      await page.locator('#consumerRefresh').click();
      await page.locator('#consumerPanel[aria-busy="false"]').waitFor();
      releaseReload();
      await page.getByText('A newer order was loaded while you waited.', { exact: false }).waitFor();
      assert.equal(await page.locator('#consumerPack-0').isDisabled(), true);
    }
    await reload.click();
    await page.waitForFunction(() => !document.querySelector('#consumerPack-0')?.checked && document.querySelector('#consumerPack-1')?.checked);
    await page.locator('#consumerPack-0').check();
    await page.waitForFunction(() => document.querySelector('#consumerPackedCount')?.textContent === '2 of 2 lines');
    assert.deepEqual(writes[4].packedLines, [0, 1], 'retry applies the tick to the newly loaded packing');

    if (!isPhone) {
      const cancel = page.locator('#consumerOrderDetail [data-act="consumer-cancel"]');
      await cancel.click();
      await page.getByRole('heading', { name: 'Cancel order SC-11111111?' }).waitFor();
      await page.locator('[data-act="consumer-order"][data-id="SC-22222222"]').evaluate(button => button.click());
      await page.locator('#scrim [data-sheet="ok"]').click();
      await page.getByText('The order view changed.', { exact: false }).waitFor();
      assert.equal(writes.length, 5, 'cancellation cannot target the newly selected order');

      await openOrder('SC-11111111');
      await cancel.click();
      orders[0].version++;
      await page.locator('#consumerRefresh').evaluate(button => button.click());
      await page.locator('#consumerPanel[aria-busy="false"]').waitFor();
      await page.locator('#scrim [data-sheet="ok"]').click();
      await page.getByText('The order view changed.', { exact: false }).waitFor();
      assert.equal(writes.length, 5, 'cancellation cannot use an order version newer than the one reviewed');
    }
    await page.getByRole('button', { name: 'Mark packed', exact: true }).click();
    await page.locator('#consumerDispatchForm').waitFor();
    assert.match(await page.locator('#consumerOrderDetail').textContent(), /10 Coffee Street.*NR1 1AA/);
    await page.locator('#consumerTrackingNumber').fill('AB123456789GB');
    await page.locator('#consumerDispatchForm button[type="submit"]').click();
    await page.getByRole('button', { name: 'Mark delivered', exact: true }).waitFor();
    assert.equal(orders[0].status, 'dispatched'); assert.ok(await page.getByRole('link', { name: 'Track parcel' }).getAttribute('href').then(href => href.startsWith('https://www.royalmail.com/')));
    assert.match(await page.locator('.consumer-timeline').textContent(), /Placed.*Ready.*Dispatched/s);
    if (process.env.CONSUMER_SCREENSHOT_DIR) { await mkdir(process.env.CONSUMER_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: process.env.CONSUMER_SCREENSHOT_DIR + '/consumer-fulfilment-' + device + '.png', fullPage: true }); }
    await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
    if (isPhone) {
      await page.locator('.consumer-detail-title .pill', { hasText: 'Completed' }).waitFor();
      await page.locator("#consumerOrderBack").click();
      assert.equal(await page.locator('[data-act="consumer-order"][data-id="SC-11111111"]').evaluate(row => row === document.activeElement), true);
      assert.equal(await page.locator("#consumerOrderFilter").inputValue(), "completed");
    }
    await page.locator('[data-act="consumer-queue"][data-id="to-pack"]').click();
    if (isPhone) await openOrder("SC-22222222");
    await page.locator('#consumerOrderDetail h3', { hasText: 'SC-22222222' }).waitFor();
    await page.locator('#consumerPack-0').check(); await page.locator('#consumerPack-1').check();
    await page.waitForFunction(() => !document.querySelector('#consumerPackedCount')?.textContent.includes('Saving') && document.querySelector('#consumerPack-1')?.checked);
    await page.getByRole('button', { name: 'Mark packed', exact: true }).click();
    await page.getByRole('button', { name: 'Mark collected', exact: true }).waitFor();
    assert.equal(await page.locator('#consumerTrackingNumber').count(), 0);
    await page.getByRole('button', { name: 'Mark collected', exact: true }).click();
    if (isPhone) {
      await page.locator('.consumer-detail-title .pill', { hasText: 'Completed' }).waitFor();
      await page.locator("#consumerOrderBack").click();
      holdBrowse = true;
      await page.locator("#consumerSearch").fill("SC-22222222");
      await browseRequested;
      await page.evaluate(() => { location.hash = "overview"; });
      await page.locator("#consumerWorkspace").waitFor({ state: "detached" });
      await page.evaluate(() => { location.hash = "consumer"; });
      await openOrder("SC-22222222");
      await page.locator("#consumerDetailTitle").waitFor();
      releaseBrowse();
      await page.locator("#consumerOrderBack").click();
      assert.equal(await page.locator("#consumerSearch").inputValue(), "SC-22222222");
    }
    await openSection("support");
    await page.locator('.consumer-support-message').waitFor();
    assert.equal(await page.locator('.consumer-support-message img').count(), 0, 'support content is escaped');
    assert.match(await page.locator('.consumer-support-message').textContent(), /<img src=x/);
    assert.match(await page.locator('#consumerResults [role="status"]').textContent(), /1 of 2 messages/);
    await page.getByRole('button', { name: 'Load more messages', exact: true }).click();
    await page.getByText('Older %_ enquiry', { exact: true }).waitFor();
    await page.locator('#consumerSearch').fill('HELP-AABBCCDD');
    await page.waitForFunction(() => document.querySelector('#consumerResults [role="status"]')?.textContent.includes('1 message'));
    assert.equal(await page.getByText('Order enquiry', { exact: true }).count(), 0);
    await page.locator('#consumerSearch').clear();
    await page.getByText('Order enquiry', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Mark resolved', exact: true }).click();
    await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
    assert.equal(support[0].resolved, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
  } finally { releaseFirst(); releaseBrowse(); releaseReload(); await context.close(); }
});

test('Consumer support labels an older or stalled inbox and filters only its loaded messages', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: srv.base }]);
  const page = await context.newPage();
  let mode = 'old-sites';
  const row = { reference: 'HELP-1234ABCD', subject: 'Loaded enquiry', name: 'Reader', email: 'reader@example.test',
    message: 'Available message', createdAt: '2026-11-26T10:00:00.000Z', resolved: false };
  await page.route('**/api/admin/consumer**', async route => {
    const url = new URL(route.request().url());
    let response = { connected: true };
    if (url.pathname.endsWith('/support')) {
      if (mode === 'old-sites') response = { messages: [row], supportGateway: 1 };
      if (mode === 'old-gateway') response = { messages: [row], count: 52, nextCursor: 'cursor', query: { search: '', cursor: null } };
      if (mode === 'repeat') response = { messages: [row], count: 52, nextCursor: 'cursor',
        query: { search: url.searchParams.get('q') || '', cursor: url.searchParams.get('cursor') }, supportGateway: 1 };
    }
    return route.fulfill({ json: response });
  });
  const count = page.locator('#consumerResults [role="status"]'), more = page.getByRole('button', { name: 'Load more messages' });
  const search = page.locator('#consumerSearch');
  try {
    await page.goto(srv.base + '/admin#consumer');
    await page.locator('#consumerTabs [data-id="support"]').click();
    await page.getByText('Loaded enquiry', { exact: true }).waitFor();
    assert.match(await count.textContent(), /1 loaded message.*temporarily unavailable/);
    assert.equal(await more.count(), 0);
    await search.fill('unmatched');
    await page.getByText('No support messages match this view.').waitFor();
    assert.match(await count.textContent(), /0 loaded messages/);

    mode = 'old-gateway';
    await search.fill('HELP-1234ABCD');
    await page.getByText('Loaded enquiry', { exact: true }).waitFor();
    assert.match(await count.textContent(), /1 loaded message.*temporarily unavailable/);
    assert.equal(await more.count(), 0);

    mode = 'repeat';
    await search.clear();
    await more.click();
    await more.waitFor({ state: 'detached' });
    assert.match(await count.textContent(), /1 loaded message.*temporarily unavailable/);
    assert.equal(await page.getByText('Loaded enquiry', { exact: true }).count(), 1);
  } finally { await context.close(); }
});
