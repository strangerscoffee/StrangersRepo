import { validGrindId, isGrindAvailable } from "./grinds.js";
// The source snapshot is a fallback; the signed-in API supplies the editable catalogue.
import { products as sourceProducts } from "./catalogue.js";
export let products = sourceProducts.map((product) => ({ ...product, prices: { ...product.prices } }));
export function setCatalogue(value) {
  if (!Array.isArray(value)) throw new Error("Could not load the coffee catalogue.");
  products = value.map((product) => ({ ...product, prices: { ...product.prices }, inStock: product.inStock !== false, active: product.active !== false, imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls.filter((url) => typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) : product.image ? ["/wholesale-preview/images/" + product.image] : [] }));
}
export const isAvailable = (product) => !!product && product.active !== false && product.inStock !== false;

export const packs = {
  quarter: { label: "250 g bag", short: "250 g", grams: 250 },
  kilo: { label: "1 kg bag", short: "1 kg", grams: 1000 },
};
export const grinds = {
  beans: "Beans", espresso: "Espresso / Fine", moka: "Moka Pot / Fine",
  filter: "Filter / Medium", cafetiere: "Cafetiere / Coarse",
};
export const orderablePacks = Object.entries(packs);
// The sizes a coffee is sold in: both, unless Admin has turned one off (a white-label blend only in 1 kg bags, say).
export const packsFor = (product) => product?.packs?.length === 1 && Object.hasOwn(packs, product.packs[0]) ? orderablePacks.filter(([id]) => id === product.packs[0]) : orderablePacks;
export const sells = (product, pack) => packsFor(product).some(([id]) => id === pack);
/** The size to show for a coffee: the one chosen for the whole page if it's sold, else the one it is sold in. */
export const sizeFor = (product, wanted) => sells(product, wanted) ? wanted : packsFor(product)[0][0];
// Can this line still be ordered as it is (size still sold, grind still offered)? Past orders can hold 500 g bags.
export const lineOrderable = (line) => Object.hasOwn(packs, line.pack) && sells(productFor(line.productId), line.pack) && isGrindAvailable(productFor(line.productId), line.grind);
import { MAX_QUANTITY } from "./limits.js";
export { MAX_QUANTITY };
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
    if (!line || !productFor(line.productId) || typeof line.pack !== "string" || typeof line.grind !== "string" || !Object.hasOwn(packs, line.pack) || !validGrindId(line.grind) || !validQuantity(line.quantity)) continue;
    const existing = clean.find((item) => lineKey(item) === lineKey(line));
    if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + Number(line.quantity));
    else clean.push({ productId: line.productId, pack: line.pack, grind: line.grind, quantity: Number(line.quantity) });
  }
  return clean;
}

export function addToBasket(basket, variant, quantity) {
  if (!isAvailable(productFor(variant.productId)) || !lineOrderable(variant) || !validQuantity(quantity) || !sanitiseBasket([{ ...variant, quantity }]).length) return { basket, added: 0 };
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
