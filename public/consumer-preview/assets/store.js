export const SHIPPING = 350;
export const FREE_SHIPPING = 4500;

export const CART_KEY = 'strangers-coffee-proposal.cart.v1';
const MAX_QUANTITY = 99;
const LIGHT_SHIPPING = 300;
const BAG_GRAMS = { '250g': 250, '300g': 300, '500g': 500, '1kg': 1000 };
const currency = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
});

export function money(amountInPence) {
  return currency.format(amountInPence / 100);
}

export function createStore(products, storage = browserStorage()) {
  const lines = new Map();
  let removalNotice = '';

  function variant(id, size, grind) {
    const product = products.find(item => item.id === id);
    if (!product || !Object.hasOwn(product.prices, size) || !product.grinds.includes(grind)) {
      return null;
    }
    const unitPrice = product.prices[size];
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return null;

    return { id, size, grind, unitPrice, product, key: JSON.stringify([id, size, grind]) };
  }

  function cart() {
    return [...lines.values()].map(line => ({ ...line }));
  }

  function persist() {
    const selectedVariants = cart().map(({ id, size, grind, qty }) => ({ id, size, grind, qty }));
    try {
      storage?.setItem(CART_KEY, JSON.stringify(selectedVariants));
    } catch {
      // Keep the current page's cart if browser storage becomes unavailable.
      storage = null;
    }
  }

  function refresh(prune = false) {
    let saved;
    try {
      saved = storage ? JSON.parse(storage.getItem(CART_KEY) ?? '[]') : cart();
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;

    let removed = false;
    lines.clear();
    for (const selection of saved) {
      if (!selection || !validQuantity(selection.qty)) continue;
      const line = variant(selection.id, selection.size, selection.grind);
      if (!line) {
        removed = true;
        continue;
      }
      const existing = lines.get(line.key)?.qty ?? 0;
      lines.set(line.key, { ...line, qty: Math.min(existing + selection.qty, MAX_QUANTITY) });
    }
    if (prune && removed) {
      removalNotice = 'An item or option in your cart is no longer sold and has been removed.';
      persist();
    }
  }

  function add(id, size, grind, qty = 1) {
    const line = variant(id, size, grind);
    if (!line || line.product.available === false || !validQuantity(qty)) return false;
    refresh();
    const nextQuantity = (lines.get(line.key)?.qty ?? 0) + qty;
    if (!validQuantity(nextQuantity)) return false;

    lines.set(line.key, { ...line, qty: nextQuantity });
    persist();
    return true;
  }

  function remove(key) {
    refresh();
    if (!lines.delete(key)) return false;
    persist();
    return true;
  }

  function adjustQty(key, delta) {
    refresh();
    const line = lines.get(key);
    if (!line || !Number.isInteger(delta) || !validQuantity(line.qty + delta)) return false;

    line.qty += delta;
    persist();
    return true;
  }

  function clear() {
    lines.clear();
    persist();
  }

  function consume(purchased) {
    refresh();
    for (const { id, size, grind, qty } of purchased) {
      if (!validQuantity(qty)) continue;
      const line = lines.get(JSON.stringify([id, size, grind]));
      if (!line) {
        removed = true;
        continue;
      }
      if (line.qty > qty) line.qty -= qty;
      else lines.delete(line.key);
    }
    persist();
  }

  function totals(method = 'delivery') {
    let subtotal = 0;
    let count = 0;
    let grams = 0;
    for (const { qty, unitPrice, size, product } of lines.values()) {
      subtotal += qty * unitPrice;
      count += qty;
      const customWeight = product.shippingWeightGrams;
      const defaultWeight = BAG_GRAMS[size] ?? (product.category === 'accessory' ? 150 : 500);
      const weight = Number.isSafeInteger(customWeight) && customWeight > 0 ? customWeight : defaultWeight;
      grams += qty * weight;
    }

    let shipping = 0;
    if (count && method !== 'collection' && subtotal <= FREE_SHIPPING) {
      shipping = grams < 500 ? LIGHT_SHIPPING : SHIPPING;
    }
    return { subtotal, shipping, total: subtotal + shipping, count };
  }

  refresh();
  return { cart, add, adjustQty, remove, clear, totals, refresh, consume, get notice() { return removalNotice; } };
}

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function validQuantity(qty) {
  return Number.isInteger(qty) && qty >= 1 && qty <= MAX_QUANTITY;
}
