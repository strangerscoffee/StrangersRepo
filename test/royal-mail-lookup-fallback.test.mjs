import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { build } = createRequire(import.meta.url)('esbuild');
const { outputFiles } = await build({
  entryPoints: [new URL('../src/royalMail.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const { findRoyalMailOrder } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

const key = 'fixture-private-key';
const reference = 'WS-' + 'ABC12345'.repeat(4);
const createdOn = '2026-11-27T21:59:00Z';
const row = (id, ref) => ({ orderIdentifier: id, orderReference: ref, createdOn });
const order = { ...row(7, reference), printedOn: createdOn, trackingNumber: 'AB123456789GB' };
const anotherOrder = row(8, 'unrelated-private-reference');
const invalidSelector = [{code: 'InvalidOrderIdentifier', message: 'Order identifiers are invalid'}];

function carrier(pages, { denial = invalidSelector, status = 400 } = {}) {
  const urls = [], signals = [];
  const fetcher = async (raw, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    const url = new URL(raw);
    assert.equal(url.origin, 'https://api.parcel.royalmail.com');
    urls.push(url);
    signals.push(init.signal);
    if (urls.length === 1) {
      assert.equal(url.pathname, '/api/v1/orders/%22' + reference + '%22');
      return Response.json(denial, { status });
    }
    assert.equal(url.pathname, '/api/v1/orders');
    assert.equal(url.searchParams.get('pageSize'), '100');
    assert.ok([...url.searchParams.keys()].every(name => ['pageSize', 'continuationToken'].includes(name)));
    assert.ok(pages.length >= urls.length - 1, 'unexpected carrier GET');
    const page = pages[urls.length - 2];
    return page instanceof Response ? page : Response.json(page);
  };
  return { urls, signals, run: () => findRoyalMailOrder(key, reference, fetcher) };
}

test('a format refusal can recover one exact reference after exhausting the order list', async () => {
  const token = 'next+page/=value&only';
  const lookup = carrier([{orders: [anotherOrder], continuationToken: token}, {orders: [order]}], {status: 422});
  assert.deepEqual(await lookup.run(), {orderId: 7, reference, trackingNumber: 'AB123456789GB', providerState: 'labelled'});
  assert.equal(lookup.urls.length, 3);
  assert.equal(lookup.urls[1].search, '?pageSize=100');
  assert.equal(lookup.urls[2].searchParams.get('continuationToken'), token);
  assert.ok(lookup.signals[1] instanceof AbortSignal);
  assert.equal(lookup.signals[1], lookup.signals[2], 'all list pages share one timeout budget');
});

test('a complete unfiltered listing can establish absence, including a valid empty account', async () => {
  for (const pages of [[{orders: []}], [{orders: [anotherOrder], continuationToken: 'last'}, {orders: [], continuationToken: null}]]) {
    const lookup = carrier(pages);
    assert.equal(await lookup.run(), null);
    assert.equal(lookup.urls.length, 1 + pages.length);
  }
});

test('a bare not-found refusal requires an independent complete check of the original reference', async () => {
  for (const primary of [{denial: {code: 'NotFound'}, status: 400}, {denial: {message: 'Not found'}, status: 422}]) {
    const found = carrier([{orders: [order]}], primary);
    assert.equal((await found.run()).orderId, order.orderIdentifier);
    const absent = carrier([{orders: []}], primary);
    assert.equal(await absent.run(), null);
    for (const page of [{orders: [], continuationToken: 'more'}, new Response(null, {status: 503})]) {
      const unavailable = carrier([page], primary);
      await assert.rejects(unavailable.run(), /Royal Mail rejected the order-reference lookup/);
      assert.equal(unavailable.urls.length, 2);
    }
  }
});

test('incomplete, ambiguous and malformed listings cannot confirm either absence or a match', async () => {
  const pages = [
    [{orders: [order], continuationToken: '2'}, {orders: [row(10, reference)]}],
    [{orders: [anotherOrder], continuationToken: '2'}, {orders: [anotherOrder]}],
    [{orders: [row(9, reference.toLowerCase())]}],
    [{orders: [row(9, ' ' + reference)]}],
    [{orders: [{...order, createdOn: 'invalid'}]}], [{orders: [{...order, orderIdentifier: -2}]}],
    [{orders: Array(101).fill(order)}], [{orders: null}],
    [{orders: [order], continuationToken: false}], [{orders: [order], continuationToken: ' '.repeat(2)}],
    [{orders: [], continuationToken: '1'}],
    [{orders: [order], continuationToken: '2'}, {orders: [anotherOrder], continuationToken: '2'}],
    [{orders: [order], continuationToken: '2'}, new Response('private carrier failure', {status: 500})],
    [new Response(null, {status: 404})], [new Response(null, {status: 429})],
    [new Response('x'.repeat(131073), {headers: {'content-type': 'application/json'}})],
  ];
  for (const listing of pages) {
    const lookup = carrier(listing);
    await assert.rejects(lookup.run(), e => {
      assert.match(e.message, /^Royal Mail rejected the order-reference lookup\./);
      assert.doesNotMatch(e.message, /unrelated-private-reference|fixture-private-key|private carrier failure|WS-/);
      return true;
    });
    assert.ok(lookup.urls.length <= 4);
  }
});

test('orders without a reference, other orders\' odd fields and extra page fields are not ours and are skipped (28 Nov 2026)', async () => {
  const noise = [row(9, null), {orderIdentifier: 10}, {...anotherOrder, createdOn: 'invalid'}, {...row(11, ''), orderIdentifier: -2}, null];
  assert.equal(await carrier([{orders: noise, totalCount: 5}]).run(), null);
  assert.equal((await carrier([{orders: [...noise, order], somethingNew: true}]).run()).orderId, order.orderIdentifier);
  // A long account is read in full, up to 2,000 orders.
  const pages = Array.from({length: 12}, (_, i) => ({orders: [row(100 + i, 'other-' + i)], continuationToken: 't' + i}));
  pages.push({orders: [order]});
  const long = carrier(pages);
  assert.equal((await long.run()).orderId, order.orderIdentifier);
  assert.equal(long.urls.length, 14);
  const endless = carrier(Array.from({length: 21}, (_, i) => ({orders: [row(200 + i, 'x' + i)], continuationToken: 'n' + i})));
  await assert.rejects(endless.run(), /longer than 2000 orders/);
});

test('a refusal that echoes our own reference in quotes or percent-encoded is about this order, not another', async () => {
  for (const echoed of ['"' + reference + '"', '%22' + reference + '%22', "'" + reference + "'", ' "' + reference + '" ']) {
    // Recognised not-found wording: no order yet, no scan needed.
    for (const field of ['channelOrderReference', 'orderReference']) {
      const missing = carrier([], {denial: [{accountOrderNumber: 0, [field]: echoed, code: 'OrderNotFound', message: 'Order not found'}]});
      assert.equal(await missing.run(), null);
      assert.equal(missing.urls.length, 1);
    }
    // Anything else about our own reference is settled by the order list.
    const other = carrier([{orders: [anotherOrder]}], {denial: [{accountOrderNumber: null, channelOrderReference: echoed, code: 'SomethingElse', message: 'Unexpected'}]});
    assert.equal(await other.run(), null);
    assert.equal(other.urls.length, 2);
  }
  // A different reference, however it's quoted, still points at another order.
  const elsewhere = carrier([], {denial: [{channelOrderReference: '"' + reference + 'X"', code: 'OrderNotFound'}]});
  await assert.rejects(elsewhere.run());
  assert.equal(elsewhere.urls.length, 1);
});

test('a refusal pointing at another order never scans the account', async () => {
  for (const denial of [
    [{...invalidSelector[0], channelOrderReference: 'unrelated-private-reference'}],
    [{code: 'NotFound', accountOrderNumber: 44}],
  ]) {
    const lookup = carrier([], {denial});
    await assert.rejects(lookup.run());
    assert.equal(lookup.urls.length, 1);
  }
});

test('any other refusal is settled by the complete order list, and stays blocked when the list is unreadable', async () => {
  for (const denial of [
    [{code: 'AccountUnavailable', message: 'account unavailable'}],
    [invalidSelector[0], {code: 'PermissionDenied', message: 'cannot access account'}],
    {message: 'Something unexpected'}, [],
  ]) {
    assert.equal(await carrier([{orders: [anotherOrder]}], {denial}).run(), null);
    assert.equal((await carrier([{orders: [order]}], {denial}).run()).orderId, order.orderIdentifier);
    const unreadable = carrier([new Response(null, {status: 503})], {denial});
    await assert.rejects(unreadable.run(), e => {
      assert.match(e.message, /^Royal Mail rejected the order-reference lookup\. The order list could not confirm/);
      assert.doesNotMatch(e.message, /account unavailable|cannot access|Something unexpected/);
      return true;
    });
    assert.equal(unreadable.urls.length, 2);
  }
});
