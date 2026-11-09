import { test } from "node:test";
import assert from "node:assert/strict";
import { addToBasket, sanitiseBasket, totals, validQuantity, money, weight } from "../public/wholesale-preview/order.js";

const brazil = { productId: "brazil", pack: "kilo", grind: "beans" };

test("wholesale preview: matching variants merge, different packs and grinds stay separate", () => {
  let { basket } = addToBasket([], brazil, 2);
  ({ basket } = addToBasket(basket, brazil, 3));
  ({ basket } = addToBasket(basket, { ...brazil, pack: "case" }, 1));
  ({ basket } = addToBasket(basket, { ...brazil, grind: "filter" }, 4));
  assert.equal(basket.length, 3);
  assert.deepEqual(basket.map((line) => line.quantity), [5, 1, 4]);
});

test("wholesale preview: a case is one pack and six 250 g bags in the weight and price", () => {
  const basket = [{ ...brazil, quantity: 3 }, { productId: "colombia", pack: "case", grind: "espresso", quantity: 2 }];
  assert.deepEqual(totals(basket), { packs: 5, grams: 6000, pence: 13200 });
  assert.equal(money(totals(basket).pence), "£132.00");
  assert.equal(weight(totals(basket).grams), "6 kg");
  assert.equal(weight(1500), "1.5 kg");
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
