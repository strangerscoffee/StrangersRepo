// Public retail catalogue used for the wholesale design demo. No order or API connection.
import { products } from "./catalogue.js";
export { products };

export const packs = {
  quarter: { label: "250 g bag", short: "250 g", grams: 250 },
  half: { label: "500 g bag", short: "500 g", grams: 500 },
  kilo: { label: "1 kg bag", short: "1 kg", grams: 1000 },
};
export const grinds = {
  beans: "Beans", espresso: "Espresso / Fine", moka: "Moka Pot / Fine",
  filter: "Filter / Medium", cafetiere: "Cafetiere / Coarse",
};
export const MAX_QUANTITY = 99;
export const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
export const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
export const productFor = (id) => products.find((product) => product.id === id);
export const lineKey = (line) => `${line.productId}:${line.pack}:${line.grind}`;
export const unitPrice = (product, pack) => product.prices[pack];

export function validQuantity(value) {
  const number = Number(value);
  return String(value).trim() !== "" && Number.isInteger(number) && number >= 1 && number <= MAX_QUANTITY;
}

// Basket storage is untrusted. Retain recognised variants and bounded integer quantities only.
export function sanitiseBasket(value) {
  if (!Array.isArray(value)) return [];
  const clean = [];
  for (const line of value.slice(0, 200)) {
    if (!line || !productFor(line.productId) || typeof line.pack !== "string" || typeof line.grind !== "string" || !Object.hasOwn(packs, line.pack) || !Object.hasOwn(grinds, line.grind) || !validQuantity(line.quantity)) continue;
    const existing = clean.find((item) => lineKey(item) === lineKey(line));
    if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + Number(line.quantity));
    else clean.push({ productId: line.productId, pack: line.pack, grind: line.grind, quantity: Number(line.quantity) });
  }
  return clean;
}

export function addToBasket(basket, variant, quantity) {
  if (!validQuantity(quantity) || !sanitiseBasket([{ ...variant, quantity }]).length) return { basket, added: 0 };
  const next = sanitiseBasket(basket);
  const existing = next.find((line) => lineKey(line) === lineKey(variant));
  const added = Math.min(Number(quantity), MAX_QUANTITY - (existing?.quantity || 0));
  if (existing) existing.quantity += added;
  else next.push({ productId: variant.productId, pack: variant.pack, grind: variant.grind, quantity: added });
  return { basket: next, added };
}

export function totals(basket) {
  return sanitiseBasket(basket).reduce((sum, line) => ({
    packs: sum.packs + line.quantity,
    grams: sum.grams + packs[line.pack].grams * line.quantity,
    pence: sum.pence + unitPrice(productFor(line.productId), line.pack) * line.quantity,
  }), { packs: 0, grams: 0, pence: 0 });
}
