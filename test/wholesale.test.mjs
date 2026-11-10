import { test } from "node:test";
import assert from "node:assert/strict";
import { addToBasket, sanitiseBasket, totals, validQuantity, money, weight, setCatalogue, products, isAvailable, orderablePacks, lineOrderable } from "../public/wholesale-preview/order.js";
import { shippingFor } from "../public/wholesale-preview/shipping.js";
import { defaultGrinds } from "../public/wholesale-preview/grinds.js";

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
  const basket = [{ ...brazil, quantity: 3 }, { productId: "colombia", pack: "quarter", grind: "espresso", quantity: 2 }];
  assert.deepEqual(totals(basket), { packs: 5, grams: 3500, pence: 6650 });
  assert.equal(money(totals(basket).pence), "£66.50");
  assert.equal(weight(totals(basket).grams), "3.5 kg");
  assert.equal(weight(750), "0.75 kg");
  assert.equal(totals([{ ...brazil, pack: "quarter", quantity: 1 }]).pence, 500, "250 g uses its own source price, not one quarter of the kilo price");
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

test("wholesale basket: added catalogue coffees use server prices, unavailable lines remain visible but cannot be added", () => {
  const original = products.map((product) => ({ ...product, prices: { ...product.prices } }));
  try {
    setCatalogue([{ id: "coffee-new", title: "New coffee", name: "New", prices: { quarter: 1100, half: 2100, kilo: 4100 }, active: true, inStock: true, imageUrls: [] }]);
    const line = { productId: "coffee-new", pack: "kilo", grind: "beans" };
    const { basket } = addToBasket([], line, 2);
    assert.equal(totals(basket).pence, 8200);
    setCatalogue([{ ...products[0], inStock: false }]);
    assert.equal(isAvailable(products[0]), false);
    assert.equal(addToBasket(basket, line, 1).added, 0);
    assert.equal(sanitiseBasket(basket).length, 1, "out-of-stock intent is kept for the customer to remove");
  } finally { setCatalogue(original); }
});

test("wholesale: 500 g bags are no longer sold, but old basket lines are kept and marked", () => {
  assert.deepEqual(orderablePacks.map(([id]) => id), ["quarter", "kilo"]);
  assert.equal(addToBasket([], { ...brazil, pack: "half" }, 1).added, 0, "a 500 g bag can't be added");
  const old = sanitiseBasket([{ ...brazil, pack: "half", quantity: 2 }]);
  assert.equal(old.length, 1, "a saved 500 g line stays, so the customer sees it and removes it");
  assert.equal(lineOrderable(old[0]), false);
  assert.equal(lineOrderable({ ...brazil, quantity: 1 }), true);
});

test("wholesale: delivery is £7.44 including VAT under £250 of coffee, free from £250, and never on collection", () => {
  assert.equal(shippingFor("Delivery", 0), 744);
  assert.equal(shippingFor("Delivery", 24999), 744);
  assert.equal(shippingFor("Delivery", 25000), 0, "£250 exactly is free");
  assert.equal(shippingFor("Delivery", 90000), 0);
  assert.equal(shippingFor("Roastery collection", 1000), 0);
  assert.equal(shippingFor("Roastery collection", 30000), 0);
});

test("wholesale: grinds are Beans (the default), Fine, Medium and Coarse, each saying what it's for", () => {
  assert.deepEqual(defaultGrinds.map((g) => g.label), ["Beans", "Fine", "Medium", "Coarse"]);
  assert.equal(defaultGrinds[0].id, "beans");
  assert.deepEqual(defaultGrinds.slice(1).map((g) => g.hint), ["Commercial espresso machine", "Filter, and a good general grind for most uses", "Cafetiere and batch brewer"]);
});
