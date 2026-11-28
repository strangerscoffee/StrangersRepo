import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { build } = createRequire(import.meta.url)('esbuild');
const { outputFiles } = await build({
  entryPoints: [new URL('../src/royalMail.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const { findSubmittedRoyalMailOrder } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
const ref = 'WS-' + 'ABC12345'.repeat(4);
const key = 'fixture-private-key';
const sent = Date.UTC(2026, 10, 22, 12, 7), placed = Date.UTC(2026, 10, 22, 10, 0);
const item = (id, reference, fields = {}) => ({ orderIdentifier: id, orderReference: reference, ...fields });
const label = item(103, ref, { createdOn: '2026-11-22T12:07:00', printedOn: '2026-11-22T12:08:00Z', trackingNumber: 'AB123456789GB' });
const refusal = () => Response.json([{ code: 'InvalidOrderIdentifier' }], { status: 400 });
function fixture(direct, list, numeric, orderDate = placed) {
  const calls = [];
  async function fetcher(raw, init) {
    const url = new URL(raw);
    assert.equal(url.origin, 'https://api.parcel.royalmail.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + key);
    calls.push(url);
    if (calls.length === 1) {
      assert.equal(url.pathname, '/api/v1/orders/%22' + ref + '%22');
      return direct();
    }
    if (url.pathname === '/api/v1/orders') {
      assert.equal(url.searchParams.get('pageSize'), '50');
      const from = Date.parse(url.searchParams.get('startDateTime'));
      const to = Date.parse(url.searchParams.get('endDateTime'));
      assert.ok(Number.isFinite(from) && Number.isFinite(to) && to >= from);
      assert.ok(to - from <= 8 * 3600000, 'never enumerate unbounded history');
      return list(url.searchParams);
    }
    assert.match(url.pathname, /^\/api\/v1\/orders\/[1-9]\d*(?:;[1-9]\d*)*$/);
    assert.equal(url.search, '');
    return numeric(url.pathname.split('/').at(-1).split(';').map(Number));
  }
  return { calls, run: () => findSubmittedRoyalMailOrder(key, ref, sent, orderDate, fetcher) };
}

test('an exact direct result is reused; access errors or a contradictory direct reply cannot broaden the search', async () => {
  const never = () => { throw Error('unexpected request'); };
  const direct = fixture(() => Response.json([label]), never, never);
  assert.equal((await direct.run()).orderId, label.orderIdentifier);
  assert.equal(direct.calls.length, 1);
  for (const response of [
    () => Response.json({}, { status: 403 }), () => Response.json([], {status: 503}),
    () => Response.json([item(81, 'a-different-order')]), () => Response.json([label, item(105, ref)]),
    () => Response.json([{ message:'The order reference already exists' }], {status:400}),
  ]) {
    const blocked = fixture(response, never, never);
    await assert.rejects(blocked.run());
    assert.equal(blocked.calls.length, 1);
  }
});

test('recover a submitted booking by exact numeric and wholesale identity from the submitted dates', async () => {
  for (const direct of [refusal, () => new Response(null, {status:404}), () => Response.json([])]) {
    const result = fixture(direct, query => {
      const from = Date.parse(query.get('startDateTime')), to = Date.parse(query.get('endDateTime'));
      assert.ok(from <= placed && to >= sent);
      return Response.json({orders: [item(101, 'other', {createdOn:'cosmetic-date'}), label, item(104, null)], meta: {traceId:'redacted-fixture-only'}, serverTime:'2026-11-22T12:09:00'});
    }, ids => {
      assert.deepEqual(ids, [103, 104]);
      return Response.json([item(104, 'manual-other'), label]);
    });
    const order = await result.run();
    assert.equal(order.orderId, 103);
    assert.equal(order.providerState, 'labelled');
    assert.equal(result.calls.length, 3);
  }
  const projected = fixture(refusal, () => Response.json({orders: [item(103, null, {createdOn:'2026-11-22T12:07:00'})]}),
    () => Response.json([label]));
  assert.equal((await projected.run()).orderId, 103);
});

test('incomplete or conflicting scoped results never establish a booking', async () => {
  for (const [list,numeric] of [
    [() => ({orders:[label, item(104, ref)]}), () => [label]],
    [() => ({orders:[label]}), () => [item(103, 'other')]],
    [() => ({orders:[label]}), () => [item(104, ref)]],
    [() => ({orders:[label], hasMore:true}), () => [label]],
    [() => ({orders:[label]}), () => [item(103, ref, {trackingNumber:'CD987654321GB'})]],
    [() => ({orders:[item(105,null),item(103,null)]}), () => [item(105,ref),label]],
    [() => ({orders:[item(103,null)]}), () => [item(103,null)]],
    [() => ({orders:[label]}), () => []],
    [() => ({orders:[{...label, channelOrderReference:'different'}]}), () => [label]],
  ]) {
    const held = fixture(refusal, () => Response.json(list()), () => Response.json(numeric()));
    await assert.rejects(held.run());
  }
  const missing = fixture(refusal, () => Response.json({orders: []}), () => Response.json([]));
  assert.equal(await missing.run(), null);
});

test('use bounded separate date ranges for an old order, compare all matching identities and retain an incomplete hold', async () => {
  const old = placed - 30 * 86400000;
  let n = 0;
  const result = fixture(refusal, query => {
    const midpoint = Date.parse(query.get('startDateTime')) + 2 * 3600000;
    assert.equal(midpoint, n++ === 0 ? sent : old);
    return Response.json({orders: midpoint === old ? [label] : []});
  }, () => Response.json([label]), old);
  assert.equal((await result.run()).orderId, 103);
  const conflict = fixture(refusal, query => Response.json({orders:[
    Date.parse(query.get('startDateTime')) <= old ? item(105,ref) : label]}),
    ids => Response.json([item(ids[0],ref)]), old);
  await assert.rejects(conflict.run());
});

test('a box recovery reads only its original booking and cannot take its sibling’s label', async () => {
  const box = ref + '-B2';
  const get = (reference, events) => async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(new URL(url).pathname, '/api/v1/orders/%22' + box + '%22');
    events.push(url);
    return Response.json([{ ...label, orderReference: reference }]);
  };
  const calls = [];
  const found = await findSubmittedRoyalMailOrder(key, box, sent, placed, get(box, calls));
  assert.equal(found.reference, box);
  assert.equal(found.orderId, label.orderIdentifier);
  await assert.rejects(findSubmittedRoyalMailOrder(key, box, sent, placed, get(ref+'-B1', calls)));
  assert.equal(calls.length, 2);
});
