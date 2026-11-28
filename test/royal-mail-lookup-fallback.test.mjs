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
    [{orders: [row(9, null)]}], [{orders: [{...anotherOrder, createdOn: 'invalid'}]}],
    [{orders: [{...anotherOrder, orderIdentifier: -2}]}],
    [{orders: Array(101).fill(order)}], [{orders: null}], [{orders: [], hasMore: true}],
    [{orders: [order], continuationToken: false}], [{orders: [order], continuationToken: ' '.repeat(2)}],
    [{orders: [], continuationToken: '1'}],
    [{orders: [order], continuationToken: '2'}, {orders: [anotherOrder], continuationToken: '2'}],
    [{orders: [order], continuationToken: '2'}, {orders: [anotherOrder], continuationToken: '3'}, {orders: [row(9, 'next')], continuationToken: '4'}],
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

test('unrelated carrier refusals never scan the account', async () => {
  for (const denial of [
    [{code: 'AccountUnavailable', message: 'account unavailable'}],
    [{...invalidSelector[0], channelOrderReference: 'unrelated-private-reference'}],
    [invalidSelector[0], {code: 'PermissionDenied', message: 'cannot access account'}],
  ]) {
    const lookup = carrier([], {denial});
    await assert.rejects(lookup.run());
    assert.equal(lookup.urls.length, 1);
  }
});
