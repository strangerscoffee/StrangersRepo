// Browser-only preview data. There is deliberately no server or staff-data connection here.
import { products, packs, productFor, lineKey, sanitiseBasket, unitPrice } from "../order.js";

export const DASHBOARD_KEY = "strangers.wholesale-dashboard-preview.v2";
export const CATALOGUE_KEY = "strangers.wholesale-catalogue-preview.v2";
export const BASKET_KEY = "strangers.wholesale-preview.v1";
export const statuses = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];
const defaultCatalogue = products.map(({ id, prices }) => ({ id, prices: { ...prices }, active: true }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const boundedText = (value, length = 120) => typeof value === "string" ? value.trim().slice(0, length) : "";
const validPrice = (value) => Number.isInteger(value) && value >= 1 && value <= 1000000;

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value && value.length < 1000000 ? JSON.parse(value) : clone(fallback);
  } catch { return clone(fallback); }
}
export function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function sanitiseCatalogue(value) {
  return defaultCatalogue.map((base) => {
    const entry = Array.isArray(value) ? value.find((item) => item?.id === base.id) : null;
    return entry ? {
      id: base.id,
      prices: Object.fromEntries(Object.entries(base.prices).map(([pack, price]) => [pack, validPrice(entry.prices?.[pack]) ? entry.prices[pack] : price])),
      active: typeof entry.active === "boolean" ? entry.active : true,
    } : { ...base };
  });
}
export const readCatalogue = () => sanitiseCatalogue(read(CATALOGUE_KEY, defaultCatalogue));
export function applyCatalogue(catalogue) {
  for (const entry of sanitiseCatalogue(catalogue)) Object.assign(productFor(entry.id), { ...entry, price: entry.prices.kilo });
}
export const saveCatalogue = (value) => write(CATALOGUE_KEY, sanitiseCatalogue(value));
export const catalogueIsEdited = (value) => JSON.stringify(sanitiseCatalogue(value)) !== JSON.stringify(defaultCatalogue);

const sampleCustomers = [
  { id: "demo-cafe", business: "The Example Café", contact: "Alex Example", email: "alex@example.test", status: "Active", note: "Fictional account for trying the dashboard." },
  { id: "demo-studio", business: "Sample Studio", contact: "Sam Sample", email: "sam@example.test", status: "Active", note: "Sample wholesale customer." },
  { id: "demo-kitchen", business: "Demo Kitchen", contact: "Robin Demo", email: "robin@example.test", status: "On hold", note: "Example of an account on hold. No real account is affected." },
];
const sampleLine = (productId, quantity, pack = "kilo", grind = "beans") => ({ productId, pack, grind, quantity, price: unitPrice(productFor(productId), pack) });
const sampleOrders = [
  { id: "DEMO-1006", customerId: "demo-cafe", date: "2026-11-09", status: "New", delivery: "Delivery", note: "Sample order. Please do not fulfil.", lines: [sampleLine("brazil", 6), sampleLine("colombia", 2, "half")] },
  { id: "DEMO-1005", customerId: "demo-studio", date: "2026-11-09", status: "New", delivery: "Roastery collection", note: "Fictional collection order.", lines: [sampleLine("ethiopia", 3), sampleLine("decaf", 2)] },
  { id: "DEMO-1004", customerId: "demo-cafe", date: "2026-11-08", status: "Preparing", delivery: "Delivery", note: "Example of an order being prepared.", lines: [sampleLine("brazil", 10)] },
  { id: "DEMO-1003", customerId: "demo-studio", date: "2026-11-08", status: "Ready", delivery: "Roastery collection", note: "Sample ready-for-collection order.", lines: [sampleLine("rocko", 2), sampleLine("colombia", 2)] },
  { id: "DEMO-1002", customerId: "demo-cafe", date: "2026-11-07", status: "Dispatched", delivery: "Delivery", note: "Fictional completed order. No shipment exists.", lines: [sampleLine("christmas", 2, "half"), sampleLine("brazil", 4)] },
  { id: "DEMO-1001", customerId: "demo-kitchen", date: "2026-11-06", status: "Dispatched", delivery: "Delivery", note: "A sample historical order.", lines: [sampleLine("brazil", 5), sampleLine("decaf", 2)] },
];

export function readDashboard() {
  const initial = { customers: sampleCustomers, orders: sampleOrders };
  const value = read(DASHBOARD_KEY, initial);
  if (!value || !Array.isArray(value.customers) || !Array.isArray(value.orders)) return clone(initial);
  const customers = value.customers.slice(0, 200).filter((customer) => customer && typeof customer.id === "string" && boundedText(customer.business)).map((customer) => ({
    id: boundedText(customer.id, 80), business: boundedText(customer.business), contact: boundedText(customer.contact), email: boundedText(customer.email, 150),
    status: customer.status === "On hold" ? "On hold" : "Active", note: boundedText(customer.note, 1000),
  }));
  const orders = value.orders.slice(0, 200).filter((order) => order && /^DEMO-\d{1,9}$/.test(order.id) && customers.some((customer) => customer.id === order.customerId)).map((order) => {
    const rawLines = Array.isArray(order.lines) ? order.lines : [];
    return {
      id: order.id, customerId: order.customerId, date: /^\d{4}-\d{2}-\d{2}$/.test(order.date) && Number.isFinite(Date.parse(`${order.date}T12:00:00Z`)) ? order.date : "2026-11-09",
      status: statuses.includes(order.status) ? order.status : "New", delivery: order.delivery === "Roastery collection" ? order.delivery : "Delivery", note: boundedText(order.note, 1000),
      lines: sanitiseBasket(rawLines).map((line) => {
        const raw = rawLines.find((item) => item && lineKey(item) === lineKey(line));
        return { ...line, price: validPrice(raw?.price) ? raw.price : unitPrice(productFor(line.productId), line.pack) };
      }),
    };
  }).filter((order) => order.lines.length);
  return { customers, orders };
}
export const saveDashboard = (state) => write(DASHBOARD_KEY, state);
export const readBasket = () => sanitiseBasket(read(BASKET_KEY, []));
export function orderTotals(order) {
  return order.lines.reduce((sum, line) => ({
    pence: sum.pence + line.price * line.quantity,
    grams: sum.grams + packs[line.pack].grams * line.quantity,
    packs: sum.packs + line.quantity,
  }), { pence: 0, grams: 0, packs: 0 });
}
export function freshDashboard() { return clone({ customers: sampleCustomers, orders: sampleOrders }); }
export function freshCatalogue() { return clone(defaultCatalogue); }

export function createDemoOrder(basket, { delivery = "Delivery", reference = "" } = {}) {
  const lines = sanitiseBasket(basket).filter((line) => productFor(line.productId).active !== false).map((line) => ({ ...line, price: unitPrice(productFor(line.productId), line.pack) }));
  if (!lines.length) return { saved: false, reason: "The demo basket is empty." };
  const state = readDashboard();
  if (state.orders.length >= 200) return { saved: false, reason: "The demo has reached 200 orders. Reset demo data to start over." };
  if (!state.customers.some((customer) => customer.id === "ordering-demo")) {
    if (state.customers.length >= 200) return { saved: false, reason: "The demo has reached 200 customers. Reset demo data to start over." };
    state.customers.push({ id: "ordering-demo", business: "Ordering preview account", contact: "Demo visitor", email: "", status: "Active", note: "Fictional customer used by the public ordering demo." });
  }
  const number = Math.max(1000, ...state.orders.map((order) => Number(order.id.slice(5)))) + 1;
  const id = `DEMO-${number}`;
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date());
  state.orders.unshift({ id, customerId: "ordering-demo", date, status: "New", delivery: delivery === "Roastery collection" ? delivery : "Delivery", note: boundedText(reference, 80) ? `Demo reference: ${boundedText(reference, 80)}` : "Sample from the public ordering preview. Please do not fulfil.", lines });
  return saveDashboard(state) ? { saved: true, id } : { saved: false, reason: "Browser storage is unavailable, so no demo record was saved." };
}
