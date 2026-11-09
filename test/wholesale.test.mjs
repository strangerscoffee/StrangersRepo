import { test } from "node:test";
import assert from "node:assert/strict";
import { addToBasket, sanitiseBasket, totals, validQuantity, money, weight } from "../public/wholesale-preview/order.js";
import { sanitiseCatalogue, applyCatalogue, freshCatalogue, readDashboard, createDemoOrder, orderTotals } from "../public/wholesale-preview/dashboard/store.js";

const brazil = { productId: "brazil", pack: "kilo", grind: "beans" };

test("wholesale preview: matching variants merge, different packs and grinds stay separate", () => {
  let { basket } = addToBasket([], brazil, 2);
  ({ basket } = addToBasket(basket, brazil, 3));
  ({ basket } = addToBasket(basket, { ...brazil, pack: "quarter" }, 1));
  ({ basket } = addToBasket(basket, { ...brazil, grind: "filter" }, 4));
  assert.equal(basket.length, 3);
  assert.deepEqual(basket.map((line) => line.quantity), [5, 1, 4]);
});

test("wholesale preview: bag weights and independently published retail prices total correctly", () => {
  const basket = [{ ...brazil, quantity: 3 }, { productId: "colombia", pack: "half", grind: "espresso", quantity: 2 }];
  assert.deepEqual(totals(basket), { packs: 5, grams: 4000, pence: 16700 });
  assert.equal(money(totals(basket).pence), "£167.00");
  assert.equal(weight(totals(basket).grams), "4 kg");
  assert.equal(weight(750), "0.75 kg");
  assert.equal(totals([{ ...brazil, pack: "quarter", quantity: 1 }]).pence, 1050, "250 g uses its own source price, not one quarter of the kilo price");
});

test("wholesale demo dashboard: malformed catalogue edits cannot replace valid source prices", () => {
  const original = freshCatalogue();
  const edited = sanitiseCatalogue([{ id: "brazil", prices: { kilo: -50, half: 0, quarter: 1250 }, active: false }, { id: "unknown-coffee", prices: { kilo: 1 } }]);
  assert.equal(edited.length, 10);
  assert.deepEqual(edited.find((entry) => entry.id === "brazil"), { id: "brazil", prices: { quarter: 1250, half: original[0].prices.half, kilo: original[0].prices.kilo }, active: false });
});

test("wholesale demo dashboard: checkout creates a local order with price snapshots and delivery preference", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  try {
    const result = createDemoOrder([{ ...brazil, quantity: 2 }, { productId: "colombia", pack: "quarter", grind: "filter", quantity: 1 }], { delivery: "Roastery collection", reference: "Demo PO 123" });
    assert.equal(result.saved, true);
    const dashboard = readDashboard();
    assert.equal(dashboard.orders.length, 7);
    const order = dashboard.orders[0];
    assert.equal(order.id, result.id);
    assert.equal(order.delivery, "Roastery collection");
    assert.equal(order.note, "Demo reference: Demo PO 123");
    assert.equal(order.customerId, "ordering-demo");
    assert.deepEqual(orderTotals(order), { pence: 8800, grams: 2250, packs: 3 });
    const revised = freshCatalogue();
    revised[0].prices.kilo = 9900;
    applyCatalogue(revised);
    assert.equal(readDashboard().orders[0].lines[0].price, 3700, "catalogue edits never rewrite prices on an existing order");
  } finally {
    applyCatalogue(freshCatalogue());
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  }
});

test("wholesale demo dashboard: blocked browser storage reports that no sample order was saved", () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error("Storage blocked"); }, setItem() { throw new Error("Storage blocked"); } };
  try {
    const result = createDemoOrder([{ ...brazil, quantity: 1 }]);
    assert.equal(result.saved, false);
    assert.match(result.reason, /storage is unavailable/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  }
});

test("wholesale preview: repeated adds stop at 99 and report how many were actually added", () => {
  const original = [{ ...brazil, quantity: 98 }];
  const result = addToBasket(original, brazil, 4);
  assert.equal(result.added, 1);
  assert.equal(result.basket[0].quantity, 99);
  assert.equal(original[0].quantity, 98, "the previous basket is not mutated");
  assert.equal(addToBasket(result.basket, brazil, 1).added, 0);
});

test("wholesale preview: invalid quantities cannot enter an order", () => {
  for (const value of ["", " ", 0, -1, 1.5, "2.2", "nope", 100, Infinity, null, undefined]) {
    assert.equal(validQuantity(value), false, String(value));
    assert.deepEqual(addToBasket([], brazil, value), { basket: [], added: 0 });
  }
  for (const value of [1, "1", 99, "99"]) assert.equal(validQuantity(value), true);
});

test("wholesale preview: stale or malformed storage cannot add unknown products or variants", () => {
  assert.deepEqual(sanitiseBasket({ items: [] }), []);
  assert.deepEqual(sanitiseBasket([
    null, {}, { ...brazil, productId: "old-coffee", quantity: 1 },
    { ...brazil, pack: "pallet", quantity: 1 }, { ...brazil, grind: "__proto__", quantity: 1 },
    { ...brazil, quantity: -10 }, { ...brazil, quantity: 1.5 },
    { ...brazil, quantity: 2, extra: "discard me" }, { ...brazil, quantity: 3 },
  ]), [{ ...brazil, quantity: 5 }]);
  assert.deepEqual(totals([{ ...brazil, quantity: -10 }]), { packs: 0, grams: 0, pence: 0 });
});
