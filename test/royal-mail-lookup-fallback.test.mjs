import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { build } = createRequire(import.meta.url)('esbuild');
const { outputFiles } = await build({
  entryPoints: [new URL('../src/royalMail.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const { findRoyalMailOrder, RoyalMailManualLookupError } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

const key = 'fixture-private-key';
const reference = 'WS-' + 'ABC12345'.repeat(4);
const createdOn = '2026-11-27T21:59:00Z';
const row = (id, ref) => ({ orderIdentifier: id, orderReference: ref, createdOn });
const order = { ...row(7, reference), printedOn: createdOn, trackingNumber: 'AB123456789GB' };
const anotherOrder = row(8, 'unrelated-private-reference');
const invalidSelector = [{code: 'InvalidOrderIdentifier', message: 'Order identifiers are invalid'}];

function carrier(pages, { denial = invalidSelector, status = 400, context, byIds } = {}) {
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
    if (url.pathname !== '/api/v1/orders') {
      assert.match(url.pathname, /^\/api\/v1\/orders\/[1-9]\d*(?:;[1-9]\d*)*$/);
      assert.equal(url.search, '');
      const ids = url.pathname.split('/').at(-1).split(';').map(Number);
      assert.equal(typeof byIds, 'function');
      const reply = byIds(ids);
      return reply instanceof Response ? reply : Response.json(reply);
    }
    assert.equal(url.searchParams.get('pageSize'), '50');
    assert.ok([...url.searchParams.keys()].every(name => ['pageSize', 'continuationToken'].includes(name)));
    assert.ok(pages.length >= urls.length - 1, 'unexpected carrier GET');
    const page = pages[urls.length - 2];
    return page instanceof Response ? page : Response.json(page);
  };
  return { urls, signals, run: () => findRoyalMailOrder(key, reference, fetcher, context) };
}

test('a format refusal can recover one exact reference after exhausting the order list', async () => {
  const token = 'next+page/=value&only';
  const lookup = carrier([{orders: [anotherOrder], continuationToken: token}, {orders: [order]}], {status: 422});
  assert.deepEqual(await lookup.run(), {orderId: 7, reference, trackingNumber: 'AB123456789GB', providerState: 'labelled'});
  assert.equal(lookup.urls.length, 3);
  assert.equal(lookup.urls[1].search, '?pageSize=50');
  assert.equal(lookup.urls[2].searchParams.get('continuationToken'), token);
  assert.ok(lookup.signals[1] instanceof AbortSignal);
  assert.equal(lookup.signals[1], lookup.signals[2], 'all list pages share one timeout budget');
});

test('optional references on unrelated imports allow a unique positive match but never prove absence', async () => {
  for (const optional of [{}, {orderReference:null}, {orderReference:''}, {orderReference:'   '}]) {
    const imported = {orderIdentifier:15,createdOn,...optional};
    const page = {orders:[imported],continuationToken:'next'};
    assert.equal((await carrier([page,{orders:[order]}]).run()).orderId,order.orderIdentifier);
    await assert.rejects(carrier([page,{orders:[anotherOrder]}]).run(), RoyalMailManualLookupError);
    await assert.rejects(carrier([page,{orders:[order,{...order,orderIdentifier:16}]}]).run(), /could not confirm this reference/);
    await assert.rejects(carrier([{orders:[imported,order],continuationToken:'next'},new Response(null,{status:503})]).run());
  }
  for (const invalid of [false, 0, {}]) await assert.rejects(carrier([{orders:[order,row(11,invalid)]}]).run());
});

test('a complete unfiltered listing can establish absence, including a valid empty account', async () => {
  for (const pages of [[{orders: []}], [{orders: [anotherOrder], continuationToken: 'last'}, {orders: [], continuationToken: null}]]) {
    const lookup = carrier(pages);
    assert.equal(await lookup.run(), null);
    assert.equal(lookup.urls.length, 1 + pages.length);
  }
});

test('a first native order can dismiss older anonymous imports after reading the entire list', async () => {
  const context = {firstOrderCreatedAt:Date.parse('2024-03-21T14:00:00Z')};
  const manual = {orderIdentifier:510, createdOn:'2024-03-21T13:44:59Z', orderDate:'2024-03-22T11:00:00Z'};
  const first = {orders:[manual], continuationToken:'older'};
  const clear = carrier([first,{orders:[anotherOrder]}], {context});
  assert.equal(await clear.run(), null);
  assert.equal(clear.urls.length, 3);
  const exact = carrier([first,{orders:[{...order, createdOn:'2024-02-01T10:00:00Z'}]}], {context});
  assert.equal((await exact.run()).orderId, order.orderIdentifier);
  const invalid = carrier([{orders:[{...manual, createdOn:'not a date'}]}], {context});
  await assert.rejects(invalid.run(), e => !(e instanceof RoyalMailManualLookupError));
  for (const nested of [{details:{orderIdentifier:125,orderReference:reference}}, {order:{orderReference:reference}},
    {packages:[{orderReference:reference,orderIdentifier:125}]}, {orderId:125}]) {
    const ambiguous = carrier([{orders:[{...manual, ...nested}]}], {context});
    await assert.rejects(ambiguous.run(), e => !(e instanceof RoyalMailManualLookupError));
  }
});

test('recent anonymous orders require exact numeric identities and stable carrier creation dates', async () => {
  const context = {firstOrderCreatedAt:Date.parse('2024-03-21T14:00:00Z')};
  const first = {orderIdentifier:512, createdOn:'2024-03-21T13:45:00Z'};
  const second = {orderIdentifier:513, createdOn:'2024-03-21T14:03:12.3590Z'};
  const page = {orders:[first,second]};
  function check(reply) {
    return carrier([page], {context, byIds:ids => {
      assert.deepEqual(ids, [512,513]);
      return reply;
    }});
  }
  const other = {...second, orderReference:'COFFEE-512'};
  assert.equal(await check([other,{...first, orderReference:'COFFEE-513'}]).run(), null);
  assert.equal((await check([other,{...first, orderReference:reference}]).run()).orderId,512);
  await assert.rejects(check([other,first]).run(), RoyalMailManualLookupError);
  for (const invalid of [
    [], [other], [other,other], [other,{...first,orderIdentifier:999}],
    [other,{...first,createdOn:'2024-03-21T13:44:59Z'}], [other,{...first,orderIdentifier:'512'}],
    [other,{...first,orderReference:reference,channelOrderReference:'OTHER'}], [other,{...first,packages:{}}],
    [other,{...first,orderReference:'OTHER',details:[{orderReference:reference}]}],
    [other,{...first,orderReference:reference.toLowerCase()}], {orders:[first,second]},
    [{...first,orderReference:reference},{...second,orderReference:reference}],
    [first,{...second,orderReference:reference}],
    Response.json([first,second],{status:206}), Response.json([first,second],{headers:{'Content-Range':'items 1-2/3'}}),
  ]) await assert.rejects(check(invalid).run(), e => !(e instanceof RoyalMailManualLookupError));
});

test('manual, unknown and future local order times cannot discard an older hand booking', async () => {
  const manual = {orderIdentifier:515,createdOn:'2024-01-04T11:00:00Z'};
  for (const created of [null, 0, Date.now() + 86400000]) {
    const context = {firstOrderCreatedAt:created};
    const carrierOrder = carrier([{orders:[manual]}], {context,byIds:() => [{...manual,orderReference:reference}]});
    assert.equal((await carrierOrder.run()).orderId,515);
    assert.equal(carrierOrder.urls.length,3);
    await assert.rejects(carrier([{orders:[],hasMore:true}], {context}).run(), e => !(e instanceof RoyalMailManualLookupError));
  }
  const confirmed = carrier([{orders:[manual]}], {context:{firstOrderCreatedAt:null}, byIds:() => [manual]});
  await assert.rejects(confirmed.run(), RoyalMailManualLookupError);
});

test('anonymous ID rechecks are paced in bounded batches within the original scan budget', async () => {
  const imports = Array.from({length:51}, (_, i) => ({orderIdentifier:i + 601, createdOn}));
  const context = {firstOrderCreatedAt:null};
  const batches = [];
  const byIds = ids => {
    batches.push(ids.length);
    return ids.map(id => ({orderIdentifier:id, createdOn, orderReference:'OTHER-' + id}));
  };
  const complete = carrier([{orders:imports.slice(0,26)}], {context,byIds});
  assert.equal(await complete.run(), null);
  assert.deepEqual(batches, [25,1]);
  assert.ok(complete.signals.slice(1).every(signal => signal === complete.signals[1]));
  batches.length = 0;
  const capped = carrier([{orders:imports.slice(0,50),continuationToken:'last'}, {orders:imports.slice(50)}], {context,byIds});
  await assert.rejects(capped.run(), e => !(e instanceof RoyalMailManualLookupError));
  assert.deepEqual(batches, [25,25]);
});

test('larger parcel histories and harmless envelope metadata can be checked through to the final page', async () => {
  const pages = Array.from({length:8}, (_, page) => ({
    orders:Array.from({length:50}, (_, i) => {
      const id = 1000 + 50 * page + i;
      return {...row(id, 'previous-' + id), packages:[{packageNumber:1, extra:'x'.repeat(3000)}]};
    }),
    count:50, totalCount:400, pageSize:50, hasMore:page < 7,
    requestId:'private-carrier-request', metadata:{apiVersion:'1'},
    continuationToken:page < 7 ? 'next+' + page : null,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(pages[0])) > 128 * 1024);
  pages.at(-1).orders[49] = order;
  const lookup = carrier(pages);
  assert.equal((await lookup.run()).orderId, order.orderIdentifier);
  assert.equal(lookup.urls.length, 9);
  assert.equal((await carrier([{orders:[], continuationToken:'more'}, {orders:[order]}]).run()).orderId, order.orderIdentifier);
});

test('manual first-booking review has explicit limited causes and never implies an empty account', async () => {
  const overflow = () => new Response('x'.repeat(512 * 1024 + 1), {headers:{'Content-Type':'application/json'}});
  for (const [page, cause] of [
    [{orders:[{orderIdentifier:32, createdOn}]}, /no order reference/],
    [{metadata:{requestId:'private-request'}}, /without its order list/],
    [{orders:[], hasMore:true}, /did not supply a usable next page/],
    [overflow(), /safe size limit/],
  ]) {
    await assert.rejects(carrier([page]).run(), e => e instanceof RoyalMailManualLookupError && cause.test(e.message));
  }
  const pages = Array.from({length:20}, (_, i) => ({orders:[row(i + 100, 'other-' + i)], continuationToken:'more' + i}));
  await assert.rejects(carrier(pages).run(), e => e instanceof RoyalMailManualLookupError && /more order history/.test(e.message));
  for (const bad of [
    [{orders:[order],continuationToken:'next'},overflow()],
    [{orders:[order], hasMore:true}],
    [{orders:[order, {...order,orderIdentifier:800}]}],
    [{orders:[{...row(23, 'previous'),channelOrderReference:reference}]}],
    [{orders:[{...row(23, reference),accountOrderNumber:43}]}],
    [{orders:[], metadata:{orders:[order]}}],
    [{orders:[row(52, '%22' + reference + '%22')]}],
  ]) await assert.rejects(carrier(bad).run(), e => !(e instanceof RoyalMailManualLookupError));
});

test('only a recognised neutral selector refusal can enter manual verification', async () => {
  const anonymous = {orders:[{orderIdentifier:32, createdOn}]};
  for (const denial of [{}, [], {message:'unrecognised carrier text'}, {message:'Access denied'},
    {errors:[{code:'InvalidOrderIdentifier'}, {code:'UnknownReason'}]}]) {
    await assert.rejects(carrier([anonymous], {denial}).run(), e => !(e instanceof RoyalMailManualLookupError));
  }
  for (const denial of [
    {code:'DuplicateOrderReference'}, {code:'OrderAlreadyExists',message:'An order with this reference already exists'},
    {code:'InvalidOrderIdentifier',details:{message:'Several orders match'}}, {errors:[{details:{code:'OrderSuccessfullyCreated'}}]},
    {errors:[{details:{success:true}}]}, {errors:[{details:{successCount:1}}]}, {errors:[{message:'Created'}]},
  ]) {
    for (const listing of [{orders:[]}, anonymous]) {
      const lookup = carrier([listing], {denial});
      await assert.rejects(lookup.run(), e => !(e instanceof RoyalMailManualLookupError) && /existing or ambiguous/.test(e.message));
      assert.equal(lookup.urls.length, 1);
    }
  }
  await assert.rejects(carrier([{orders:[]}], {denial:{details:{httpStatus:403}}}).run(),
    e => !(e instanceof RoyalMailManualLookupError) && /account or service problem/.test(e.message));
  for (const message of ['Order with reference "' + reference + '" was not found', "Order reference '" + reference + "' not found"]) {
    const lookup = carrier([], {denial:{orderReference:reference, code:'order_not_found', message}});
    assert.equal(await lookup.run(), null);
    assert.equal(lookup.urls.length, 1);
  }
});

test('list authentication, access, throttling, missing list and outages stay blocked with safe status-specific guidance', async () => {
  for (const [status, wording] of [[400,/rejected the read-only/], [401,/did not authenticate/], [403,/denied access/],
    [404,/did not return its order list/], [422,/rejected the read-only/], [429,/rate limiting/], [503,/unavailable/]]) {
    const failure = new Response('private account at private address', {status});
    await assert.rejects(carrier([failure]).run(), e => {
      assert.ok(!(e instanceof RoyalMailManualLookupError));
      assert.match(e.message, wording);
      assert.ok(e.message.includes('HTTP ' + status));
      assert.doesNotMatch(e.message, /private/);
      return true;
    });
  }
});

test('a bare not-found refusal requires an independent complete check of the original reference', async () => {
  for (const primary of [{denial: {code: 'NotFound'}, status: 400}, {denial: {message: 'Not found'}, status: 422}]) {
    const found = carrier([{orders: [order]}], primary);
    assert.equal((await found.run()).orderId, order.orderIdentifier);
    const absent = carrier([{orders: []}], primary);
    assert.equal(await absent.run(), null);
    for (const page of [{orders:[], hasMore:true}, new Response(null, {status:503})]) {
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

test('nested carrier identities block even if the account list would be empty', async () => {
  const conflict = {orderIdentifier:91, orderReference:'WS-OTHER'};
  for (const denial of [
    {errors:[{message:'Cannot resolve', details:conflict}]},
    {errors:[{code:'OrderNotFound', orderReference:reference, details:[{privateCustomer:conflict}]}]},
    {errors:[{code:'OrderNotFound'}], privateCustomer:{nested:[{accountOrderNumber:91}]}},
  ]) {
    const lookup = carrier([{orders:[]}], {denial});
    await assert.rejects(lookup.run(), e => {
      assert.match(e.message, /another order in (orderReference|accountOrderNumber)\./);
      assert.doesNotMatch(e.message, /WS-OTHER|privateCustomer|91/);
      return true;
    });
    assert.equal(lookup.urls.length, 1);
  }
});

test('nested echoes of our own selector permit a complete account list check', async () => {
  for (const echo of [reference, '"' + reference + '"', '%2522' + reference + '%2522']) {
    const denial = {errors:[{message:'Cannot resolve', details:[{orderReference:echo, accountOrderNumber:0}]}]};
    const lookup = carrier([{orders:[]}], {denial});
    assert.equal(await lookup.run(), null);
    assert.equal(lookup.urls.length, 2);
  }
});

test('excessive depth, fields and byte length block a lookup refusal without a list fallback', async () => {
  let deep = {orderReference:'WS-OTHER'};
  for (let i = 0; i < 15; i++) deep = {details:deep};
  for (const denial of [deep, {errors:Array(300).fill('')}, {details:'x'.repeat(16385)}]) {
    const lookup = carrier([{orders:[]}], {denial});
    await assert.rejects(lookup.run(), /reply could not be checked safely/);
    assert.equal(lookup.urls.length, 1);
  }
});

test('any other refusal is settled by the complete order list, and stays blocked when the list is unreadable', async () => {
  for (const denial of [
    [{code: 'AccountUnavailable', message: 'account unavailable'}],
    [invalidSelector[0], {code: 'PermissionDenied', message: 'cannot access account'}],
    {message: 'Something unexpected'}, [],
  ]) {
    const absent = carrier([{orders:[anotherOrder]}], {denial});
    if (Array.isArray(denial) && denial.length) await assert.rejects(absent.run(), /account or service problem/);
    else assert.equal(await absent.run(), null);
    assert.equal((await carrier([{orders: [order]}], {denial}).run()).orderId, order.orderIdentifier);
    const unreadable = carrier([new Response(null, {status: 503})], {denial});
    await assert.rejects(unreadable.run(), e => {
      assert.match(e.message, /order list is unavailable \(HTTP 503\)/);
      assert.doesNotMatch(e.message, /account unavailable|cannot access|Something unexpected/);
      return true;
    });
    assert.equal(unreadable.urls.length, 2);
  }
});
