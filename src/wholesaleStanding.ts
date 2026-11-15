// Standing orders and dispatch days (Admin only). A customer order can be given a dispatch day and ticked as a standing
// order that repeats every 1, 2 or 4 weeks. When a run is marked Dispatched (or Cancelled, to skip one) the next run is
// made at once as a New order with the next dispatch day, so it can be prepared and amended ahead of time. Admins can
// amend the bags on any New or Preparing customer order that has no invoice yet. Everything is stored in the order's
// own JSON (no migration); customers see the dispatch day, the schedule and that Strangers updated the order.
import { addDays, ukDay } from "./insightsMath";
import { shippingFor } from "../public/wholesale/shipping.js";
import { validGrindId } from "../public/wholesale/grinds.js";
import { MAX_QUANTITY } from "../public/wholesale/limits.js";
import { catalogue, packsOf } from "./wholesaleCatalogue";
import { object, get, save, version, type Versioned } from "./wholesaleStore";
import { publicCustomer, wholesaleCustomer, paymentTermsFor } from "./wholesaleAccounts";
import { customerLocations } from "./wholesaleCustomers";
import { audit } from "./audit";
import { autoTabFor } from "./wholesaleTabs";
import { canOrder, recipeText } from "./wholesaleWhiteLabel";
import { ApiError, type Env, invalid } from "./http";

export const STANDING_EVERY = [1, 2, 4] as const;
export interface Standing { every: 1 | 2 | 4; seriesId: string; run: number }
const GRAMS: Record<string, number> = { quarter: 250, half: 500, kilo: 1000 };
const LABELS: Record<string, string> = { quarter: "250 g bag", half: "500 g bag", kilo: "1 kg bag" };
const OPEN = ["New", "Preparing"];
type AnyOrder = Record<string, any> & Versioned;
const strip = ({ id, version, updatedAt, ...rest }: AnyOrder) => rest;
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
const totals = (lines: any[], delivery: string) => {
  const pence = lines.reduce((sum, line) => sum + line.price * line.quantity, 0), deliveryPence = shippingFor(delivery, pence);
  return { pence, grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0), deliveryPence, totalPence: pence + deliveryPence };
};
/** The first dispatch day `every` weeks on from `from` that isn't before today. */
export function nextDispatchDay(from: string, every: number, today = ukDay(Date.now())): string {
  let day = addDays(from, every * 7);
  while (day < today) day = addDays(day, every * 7);
  return day;
}

/** Reads `schedule: { dispatchDate, every }` from an Admin order save and returns the fields to merge into the order.
 * `every` 0 (or absent) is not a standing order. Undefined schedule leaves both alone. */
export function scheduleFields(order: AnyOrder, value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  const body = object(value);
  if (order.preview !== false) throw invalid("Dispatch days and standing orders are for customer orders.");
  const dispatchDate = body.dispatchDate === null || body.dispatchDate === "" ? null : body.dispatchDate;
  if (dispatchDate !== null && !isDay(dispatchDate)) throw invalid("Choose a dispatch day.");
  if (dispatchDate && dispatchDate !== order.dispatchDate && dispatchDate < ukDay(Date.now())) throw invalid("Choose a dispatch day from today onwards.");
  const every = body.every ?? 0;
  if (every !== 0 && !STANDING_EVERY.includes(every)) throw invalid("Choose every week, every 2 weeks or every 4 weeks.");
  if (every && !dispatchDate) throw invalid("Choose the dispatch day for this standing order.");
  const standing: Standing | undefined = every ? { every, seriesId: order.standing?.seriesId || order.id, run: order.standing?.run || 1 } : undefined;
  return { dispatchDate: dispatchDate || undefined, standing };
}

/** After a standing run is dispatched or cancelled, makes the next run (once): a New order for the next dispatch day,
 * with the same bags at today's prices and the customer's current details. Returns the new order's id, or null. */
export async function rollStanding(env: Env, saved: AnyOrder, actor: string): Promise<string | null> {
  if (!saved.standing || saved.nextRunId || saved.preview !== false || saved.deletedAt != null || !["Dispatched", "Cancelled"].includes(saved.status)) return null;
  const id = "WS-" + crypto.randomUUID().replaceAll("-", "").toUpperCase();
  // Claim first, on the version just saved, so two saves can never make two next runs.
  try { await save(env, "order", saved.id, { ...strip(saved), nextRunId: id }, saved.version); }
  catch (error) { if (error instanceof ApiError && error.code === "conflict") return null; throw error; }
  const coffees = await catalogue(env, true);
  // A change made for one delivery only leaves the usual bags in repeatLines: the next run goes back to them.
  const lines = (Array.isArray(saved.repeatLines) && saved.repeatLines.length ? saved.repeatLines : saved.lines).map((line: any) => {
    const product = coffees.find((p) => p.id === line.productId), price = product?.active ? (product.prices as Record<string, number>)[line.pack] : undefined;
    const { recipe, ...rest } = line, now = product?.recipe?.length ? recipeText(product) : product ? "" : recipe;
    return { ...rest, price: Number.isInteger(price) ? price : line.price, ...(now ? { recipe: now } : {}) };
  });
  const customer = saved.customerId ? await wholesaleCustomer(env, saved.customerId) : null;
  const fresh: Record<string, unknown> = {};
  if (customer) {
    const location = customerLocations(customer).find((l) => l.id === (saved.locationId || "primary")) || customerLocations(customer)[0];
    const { locations, defaultLocationId, ...profile } = publicCustomer(customer);
    Object.assign(fresh, { business: customer.business, customerSnapshot: { ...profile, contact: location.contact, phone: location.phone, address: location.address, postcode: location.postcode, deliveryNotes: location.deliveryNotes }, deliveryNotes: location.deliveryNotes, paymentTerms: paymentTermsFor(customer), locationId: location.id, locationSnapshot: { ...location } });
  }
  // A new run starts clean: no emails sent yet, not on a (possibly cleared) tab, no changes, no tracking or notes.
  const now = Date.now(), { nextRunId, amendedAt, amendedBy, amendedByCustomer, originalLines, repeatLines, skipped, trackingUrl, note, dispatchEmailedAt, tab, tabClearedId, ...base } = strip(saved);
  const next = {
    ...base, ...fresh, status: "New", note: "", trackingUrl: "", createdAt: now, date: ukDay(now), requestKey: `standing:${id}`, lines,
    ...totals(lines, saved.delivery),
    dispatchDate: nextDispatchDay(saved.dispatchDate || ukDay(now), saved.standing.every),
    standing: { ...saved.standing, run: (saved.standing.run || 1) + 1 }, previousRunId: saved.id,
    ...autoTabFor(customer), // on the customer's tab if they're set to use one
  };
  await save(env, "order", id, next, 0);
  await audit(env, "wholesale_standing_run", actor, `Standing order ${saved.standing.seriesId}: ${saved.skipped?.by || actor} ${saved.status === "Cancelled" ? "skipped" : "dispatched"} ${saved.id}; next run ${id} is due for dispatch on ${next.dispatchDate}.`);
  return id;
}

/** Who is changing an order: Strangers (admins, staff with wholesale orders access) or the customer themselves, who
 *  may change and skip only their own standing deliveries, and only while New (before Strangers starts preparing). */
export interface Changer { customerId?: string; minimumGrams?: number }
async function changeable(env: Env, id: string, by: Changer) {
  const order = await get<Record<string, any>>(env, "order", id);
  if (!order || order.deletedAt != null || (by.customerId && order.customerId !== by.customerId)) throw new ApiError(404, "not_found", "Order not found.");
  if (order.preview !== false) throw invalid("Only customer orders can be amended.");
  if (by.customerId && !order.standing) throw new ApiError(409, "not_standing", "Only standing orders can be changed here. Contact Strangers about this order.");
  if (by.customerId ? order.status !== "New" : !OPEN.includes(order.status)) throw new ApiError(409, "order_closed", by.customerId ? "Strangers has started preparing this delivery, so it can't be changed here now. Contact Strangers." : "Only New or Preparing orders can be amended.");
  if (await env.DB.prepare("SELECT 1 FROM wholesale_invoices WHERE order_id = ?").bind(id).first()) throw new ApiError(409, "invoiced", by.customerId ? "This delivery has been invoiced, so it can't be changed here. Contact Strangers." : "This order has an invoice, so its bags can't be changed.");
  return order;
}

/** Skip one delivery of a standing order: the run is Cancelled (marked who skipped it) and the next run is made. */
export async function skipRun(env: Env, id: string, value: unknown, actor: string, by: Changer, cancel: (body: Record<string, any>) => Promise<AnyOrder>): Promise<AnyOrder> {
  const body = object(value);
  const order = await changeable(env, id, by);
  if (!order.standing) throw invalid("Only a standing order's delivery can be skipped. To stop a one-off order, cancel it.");
  const { id: _id, version: _v, updatedAt, ...current } = order;
  const marked = await save(env, "order", id, { ...current, skipped: { by: by.customerId ? order.business || "The customer" : actor, customer: !!by.customerId, at: Date.now() } }, version(body.ifVersion));
  return cancel({ status: "Cancelled", ifVersion: marked.version, note: order.note || "" });
}

/** Amends the bags on a New or Preparing customer order with no invoice: kept lines keep their saved price; added
 * ones take today's catalogue price. Totals and the delivery charge are worked out again. On a standing order the
 * change is for every delivery from now on (`scope: "ongoing"`, the default) or just this one (`"once"`: the usual
 * bags are kept in repeatLines for the next run). */
export async function amendLines(env: Env, id: string, value: unknown, actor: string, by: Changer = {}): Promise<AnyOrder> {
  const body = object(value);
  const order = await changeable(env, id, by);
  if (body.scope !== undefined && body.scope !== "once" && body.scope !== "ongoing") throw invalid("Choose this delivery only, or every delivery from now on.");
  const once = body.scope === "once" && !!order.standing;
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 150) throw invalid("Keep from 1 to 150 coffee lines on the order.");
  const coffees = await catalogue(env, true), lines: any[] = [];
  for (const raw of body.lines) {
    const line = object(raw);
    if (typeof line.productId !== "string" || typeof line.pack !== "string" || !Object.hasOwn(GRAMS, line.pack) || typeof line.grind !== "string" || !validGrindId(line.grind)) throw invalid("Choose a listed coffee, bag size and grind.");
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) throw invalid(`Choose a whole number of bags from 1 to ${MAX_QUANTITY}.`);
    const same = (l: any) => l.productId === line.productId && l.pack === line.pack && l.grind === line.grind;
    const merged = lines.find(same);
    if (merged) { if (merged.quantity + line.quantity > MAX_QUANTITY) throw invalid(`Each coffee, weight and grind can have at most ${MAX_QUANTITY} bags.`); merged.quantity += line.quantity; continue; }
    const kept = order.lines.find(same);
    if (kept) { lines.push({ ...kept, quantity: line.quantity }); continue; }
    const product = coffees.find((p) => p.id === line.productId);
    if (!product || !product.active || !canOrder(product, order.customerId || null)) throw invalid("Choose a coffee from the catalogue that this business can order.");
    const price = (product.prices as Record<string, number>)[line.pack];
    if (!Number.isInteger(price)) throw invalid("Choose a 250 g or 1 kg bag.");
    if (!packsOf(product).includes(line.pack as "quarter" | "kilo")) throw invalid(`${product.name} is sold in ${LABELS[packsOf(product)[0]]}s only.`);
    const grind = product.grindOptions.find((option) => option.id === line.grind);
    if (!grind) throw invalid(`${product.name} doesn't offer that grind.`);
    lines.push({ productId: product.id, pack: line.pack, grind: grind.id, quantity: line.quantity, title: product.title, packLabel: LABELS[line.pack], grindLabel: grind.label, grindHint: grind.hint || "", decaf: product.categories.includes("decaf"), price, grams: GRAMS[line.pack], ...(product.recipe?.length ? { recipe: recipeText(product) } : {}) });
  }
  lines.sort((a, b) => `${a.productId}:${a.pack}:${a.grind}`.localeCompare(`${b.productId}:${b.pack}:${b.grind}`));
  const sum = totals(lines, order.delivery);
  if (by.minimumGrams && sum.grams < by.minimumGrams) throw new ApiError(409, "below_minimum", `The minimum order is ${by.minimumGrams / 1000} kg of coffee. Add ${(by.minimumGrams - sum.grams) / 1000} kg more.`);
  const { repeatLines, ...current } = strip(order as AnyOrder);
  const updated = await save(env, "order", id, {
    ...current, lines, ...sum, originalLines: order.originalLines || order.lines, amendedAt: Date.now(),
    amendedBy: by.customerId ? order.business || "The customer" : actor, ...(by.customerId ? { amendedByCustomer: true } : { amendedByCustomer: false }),
    ...(once ? { repeatLines: repeatLines || order.lines } : {}),
  }, version(body.ifVersion));
  await audit(env, "wholesale_order_amended", actor, `${actor} amended the bags on wholesale order ${id}${order.standing ? (once ? " (this delivery only)" : " (every delivery from now on)") : ""}.`);
  return updated as AnyOrder;
}
