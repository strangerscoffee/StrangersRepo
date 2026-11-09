// Demo catalogue and prices only. This module never sends an order or contacts an API.
export const products = [
  { id: "brazil", origin: "Brazil", name: "Fazenda Bom Jesus", process: "Natural", notes: "Hazelnut, milk chocolate, praline", badge: "The everyday favourite", categories: ["espresso"], price: 1800, casePrice: 3300 },
  { id: "colombia", origin: "Colombia", name: "Anserma", process: "Natural", notes: "Black forest gateau, liqueur chocolate, cherry", badge: "Rich & rounded", categories: ["espresso", "filter"], price: 2200, casePrice: 3900 },
  { id: "ethiopia", origin: "Ethiopia", name: "Idido", process: "Anaerobic natural", notes: "Mango, papaya, honeydew melon", badge: "Something a little different", categories: ["filter"], price: 2600, casePrice: 4500 },
  { id: "christmas", origin: "Seasonal blend", name: "Christmas Blend", process: "A festive favourite", notes: "Gingerbread, marmalade, liqueur chocolate", badge: "A little festive spirit", categories: ["espresso", "filter"], price: 2200, casePrice: 3900 },
  { id: "decaf", origin: "Colombia", name: "San Lorenzo Decaf", process: "Decaffeinated coffee", notes: "All the coffee. A little less caffeine.", badge: "Any time of day", categories: ["decaf"], price: 2000, casePrice: 3600 },
  { id: "rocko", origin: "Ethiopia", name: "Rocko Mountain", process: "Natural", notes: "An Ethiopian favourite for your filter line-up.", badge: "For the filter lovers", categories: ["filter"], price: 2400, casePrice: 4200 },
];

export const packs = {
  kilo: { label: "1 kg bag", short: "1 kg", grams: 1000 },
  case: { label: "6 × 250 g case", short: "6 × 250 g", grams: 1500 },
};
export const grinds = {
  beans: "Whole beans", espresso: "Espresso / fine", moka: "Moka pot / fine",
  filter: "Filter / medium", cafetiere: "Cafetière / coarse",
};
export const MAX_QUANTITY = 99;
export const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
export const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
export const productFor = (id) => products.find((product) => product.id === id);
export const lineKey = (line) => `${line.productId}:${line.pack}:${line.grind}`;
export const unitPrice = (product, pack) => pack === "case" ? product.casePrice : product.price;

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
