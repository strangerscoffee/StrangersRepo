// Standing orders and dispatch days (Admin only). A customer order can be given a dispatch day and ticked as a standing
// order that repeats every 1, 2 or 4 weeks, or monthly on the same date. When a run is marked Dispatched (or Cancelled, to skip one) the next run is
// made at once as a New order with the next dispatch day, so it can be prepared and amended ahead of time. Admins can
// amend the bags on any New, Preparing or Ready customer order that has no invoice yet. Everything is stored in the order's
// own JSON (no migration); customers see the dispatch day, the schedule and that Strangers updated the order.
import { addDays, addMonths, ukDay } from "./insightsMath";
import { shippingFor } from "../public/wholesale/shipping.js";
import { validGrindId } from "../public/wholesale/grinds.js";
import { MAX_QUANTITY } from "../public/wholesale/limits.js";
import { catalogue, packsOf } from "./wholesaleCatalogue";
import { object, get, version, type Versioned } from "./wholesaleStore";
import { publicCustomer, wholesaleCustomer, paymentTermsFor } from "./wholesaleAccounts";
import { customerLocations } from "./wholesaleCustomers";
import { audit } from "./audit";
import { autoTabFor } from "./wholesaleTabs";
import { canOrder, recipeText } from "./wholesaleWhiteLabel";
import { ApiError, type Env, invalid } from "./http";
import { INVOICED_SQL } from "./wholesaleInvoices";
import { notifyNewOrder } from "./email/orders";
import { notifySlackNewOrder } from "./slackOrders";
import { isDay } from "./rota/util";

// Weeks between deliveries, or "month": the same date each calendar month (the owner's request, 26 Nov 2026).
export const STANDING_EVERY = [1, 2, 4, "month"] as const;
export type Every = typeof STANDING_EVERY[number];
export interface Standing { every: Every; seriesId: string; run: number }
const GRAMS: Record<string, number> = { quarter: 250, half: 500, kilo: 1000 };
const LABELS: Record<string, string> = { quarter: "250 g bag", half: "500 g bag", kilo: "1 kg bag" };
// Bags can be changed, and standing deliveries skipped, by anyone allowed to until the order is dispatched.
const OPEN = ["New", "Preparing", "Ready"];
type AnyOrder = Record<string, any> & Versioned;
const strip = ({ id, version, updatedAt, ...rest }: AnyOrder) => rest;
async function deferStanding(env: Env, saved: AnyOrder, actor: string, code = "catalogue_changed") {
  const now = Date.now(), data = { ...strip(saved), standingIssue: { code, at: now }, standingRetryAt: now + 15 * 60000 };
  const result = await env.DB.prepare("UPDATE wholesale_preview SET data=?,version=version+1,updated_at=? WHERE kind='order' AND id=? AND version=?")
    .bind(JSON.stringify(data), now, saved.id, saved.version).run();
  if (result.meta.changes && saved.standingIssue?.code !== code) await audit(env, "wholesale_standing_blocked", actor, `Standing order ${saved.id}: the next delivery needs review. No unavailable coffee or private price was copied.`);
}
const totals = (lines: any[], delivery: string, free = false) => {
  const pence = lines.reduce((sum, line) => sum + line.price * line.quantity, 0), deliveryPence = free && delivery === "Delivery" ? 0 : shippingFor(delivery, pence);
  return { pence, grams: lines.reduce((sum, line) => sum + line.grams * line.quantity, 0), packs: lines.reduce((sum, line) => sum + line.quantity, 0), deliveryPence, totalPence: pence + deliveryPence };
};
/** The first dispatch day `every` weeks (or a month) on from `from` that isn't before today. */
export function nextDispatchDay(from: string, every: Every, today = ukDay(Date.now())): string {
  const step = (day: string) => every === "month" ? addMonths(day, 1) : addDays(day, every * 7);
  let day = step(from);
  while (day < today) day = step(day);
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
  if (every !== 0 && !STANDING_EVERY.includes(every)) throw invalid("Choose every week, every 2 weeks, every 4 weeks or every month.");
  if (every && !dispatchDate) throw invalid("Choose the dispatch day for this standing order.");
  if (every === "month" && Number(dispatchDate.slice(8)) > 28) throw invalid("For a monthly standing order, choose a dispatch day from the 1st to the 28th, so every month has it.");
  const standing: Standing | undefined = every ? { every, seriesId: order.standing?.seriesId || order.id, run: order.standing?.run || 1 } : undefined;
  return { dispatchDate: dispatchDate || undefined, standing };
}

/** After a standing run is dispatched or cancelled, makes the next run (once): a New order for the next dispatch day,
 * with the same bags at today's prices and the customer's current details. Returns the new order's id, or null. */
export async function rollStanding(env: Env, saved: AnyOrder, actor: string, ctx?: ExecutionContext): Promise<string | null> {
  if (!saved.standing || saved.preview !== false || saved.deletedAt != null || !["Dispatched", "Cancelled"].includes(saved.status)) return null;
  if (saved.nextRunId && await get(env, "order", saved.nextRunId)) return null; // Includes intentionally deleted runs.
  const id = saved.nextRunId || "WS-" + crypto.randomUUID().replaceAll("-", "").toUpperCase();
  if (!/^WS-[A-F0-9]{32}$/.test(id)) throw invalid("This standing order's next delivery reference needs admin review.");
  const coffees = await catalogue(env, true);
  const customer = saved.customerId ? await wholesaleCustomer(env, saved.customerId) : null;
  const usual = Array.isArray(saved.repeatLines) && saved.repeatLines.length ? saved.repeatLines : saved.lines;
  // A new delivery must still be eligible for this business. Validate before reading any new private price.
  if (!customer || customer.status === "On hold" || !Array.isArray(usual) || !usual.length || usual.some((line: any) => {
    const product = coffees.find(p => p.id === line.productId);
    return !product || !product.active || !product.inStock || !canOrder(product, saved.customerId) ||
      !["quarter", "kilo"].includes(line.pack) || !packsOf(product).includes(line.pack) ||
      !product.grindOptions.some(g => g.id === line.grind && g.enabled) || !Number.isSafeInteger((product.prices as Record<string, number>)[line.pack]);
  })) { await deferStanding(env, saved, actor); return null; }
  // A change made for one delivery only leaves the usual bags in repeatLines: the next run goes back to them.
  const lines = usual.map((line: any) => {
    const product = coffees.find((p) => p.id === line.productId), price = product?.active ? (product.prices as Record<string, number>)[line.pack] : undefined;
    const { recipe, ...rest } = line, now = product?.recipe?.length ? recipeText(product) : product ? "" : recipe;
    return { ...rest, price: Number.isInteger(price) ? price : line.price, ...(now ? { recipe: now } : {}) };
  });
  const fresh: Record<string, unknown> = {};
  if (customer) {
    const location = customerLocations(customer).find((l) => l.id === (saved.locationId || "primary")) || customerLocations(customer)[0];
    const { locations, defaultLocationId, ...profile } = publicCustomer(customer);
    Object.assign(fresh, { business: customer.business, customerSnapshot: { ...profile, contact: location.contact, phone: location.phone, address: location.address, postcode: location.postcode, deliveryNotes: location.deliveryNotes }, deliveryNotes: location.deliveryNotes, paymentTerms: paymentTermsFor(customer), locationId: location.id, locationSnapshot: { ...location } });
  }
  // A new run starts clean: no emails sent yet, not on a (possibly cleared) tab, no changes, no tracking or notes.
  const now = Date.now(), { nextRunId, amendedAt, amendedBy, amendedByCustomer, originalLines, repeatLines, packedLines, skipped, trackingUrl, note, dispatchEmailedAt, dispatchedAt, standingIssue, standingRetryAt, tab, tabClearedId, freeDelivery, ...base } = strip(saved);
  const free = !!customer?.freeDelivery && saved.delivery === "Delivery";
  const next = {
    ...base, ...fresh, status: "New", note: "", trackingUrl: "", createdAt: now, date: ukDay(now), requestKey: `standing:${id}`, lines,
    ...totals(lines, saved.delivery, free), ...(free ? { freeDelivery: true } : {}),
    dispatchDate: nextDispatchDay(saved.dispatchDate || ukDay(now), saved.standing.every),
    standing: { ...saved.standing, run: (saved.standing.run || 1) + 1 }, previousRunId: saved.id,
    ...autoTabFor(customer), // on the customer's tab if they're set to use one
  };
  // D1 batches are atomic: an insertion failure rolls the claim back too. The
  // exact parent JSON and revision tie the INSERT to this update, even in a race.
  const parentData = strip(saved); delete parentData.standingIssue; delete parentData.standingRetryAt;
  const parent = JSON.stringify({ ...parentData, nextRunId: id });
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE wholesale_preview SET data=?,version=version+1,updated_at=? WHERE kind='order' AND id=? AND version=? AND NOT EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=?)")
      .bind(parent, now, saved.id, saved.version, id),
    env.DB.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) SELECT 'order',?,?,1,? WHERE EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND data=?) AND NOT EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=?)")
      .bind(id, JSON.stringify(next), now, saved.id, saved.version + 1, parent, id),
  ]);
  if (!results[1].meta.changes) return null;
  await audit(env, "wholesale_standing_run", actor, `Standing order ${saved.standing.seriesId}: ${saved.skipped?.by || actor} ${saved.status === "Cancelled" ? "skipped" : "dispatched"} ${saved.id}; next run ${id} is due for dispatch on ${next.dispatchDate}.`);
  // The Order alerts addresses and the orders Slack channel hear about the next delivery, like a new order (the
  // owner's decision, 17 Nov 2026). Never the customer: they get their own email when it's dispatched.
  const made = { ...next, id } as any, diary = `https://${env.COOKIE_DOMAIN || "staffstrangerscoffee.com"}/`;
  await notifyNewOrder(env, ctx, made, diary).catch(() => {});
  await notifySlackNewOrder(env, ctx, made, diary).catch(() => {});
  return id;
}

/** Bounded repair for interrupted older rollovers, and closed runs that need a retry.
 * Existing next orders, including tombstones, are never replaced or recreated. */
export async function repairStandingRuns(env: Env, limit = 3) {
  const rows = await env.DB.prepare("SELECT id,data,version,updated_at FROM wholesale_preview p WHERE kind='order' AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.standing.every') IN (1,2,4,'month') AND json_extract(data,'$.status') IN ('Dispatched','Cancelled') AND COALESCE(json_extract(data,'$.standingRetryAt'),0)<=? AND (json_extract(data,'$.nextRunId') IS NULL OR NOT EXISTS(SELECT 1 FROM wholesale_preview n WHERE n.kind='order' AND n.id=json_extract(p.data,'$.nextRunId'))) ORDER BY updated_at,id LIMIT ?")
    .bind(Date.now(), Math.max(1, Math.min(10, limit))).all<{id:string;data:string;version:number;updated_at:number}>();
  let repaired = 0;
  for (const row of rows.results) try {
    if (await rollStanding(env, { ...JSON.parse(row.data), id:row.id, version:row.version, updatedAt:row.updated_at }, "System recovery")) repaired++;
  } catch {
    await deferStanding(env, { ...JSON.parse(row.data), id: row.id, version: row.version, updatedAt: row.updated_at }, "System recovery", "retry_needed").catch(() => {});
    await audit(env, "wholesale_standing_failed", null, `Standing order ${row.id} needs next-delivery recovery.`).catch(() => {});
  }
  return repaired;
}

/** Who is changing an order: Strangers (admins, staff with wholesale orders access) or the customer themselves, who
 *  may change and skip only their own standing deliveries, and until it's dispatched (New, Preparing or Ready). */
export interface Changer { customerId?: string; minimumGrams?: number }
async function saveChange(env: Env, order: AnyOrder, data: Record<string, any>, expected: number, by: Changer) {
  if (expected !== order.version) throw new ApiError(409, "conflict", "This order changed. Reload it before saving.");
  const at = Date.now();
  const result = await env.DB.prepare("UPDATE wholesale_preview SET data=?,version=version+1,updated_at=? WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.status') IN ('New','Preparing','Ready') AND (? IS NULL OR json_extract(data,'$.customerId')=?) AND NOT EXISTS(SELECT 1 FROM wholesale_billed_orders WHERE order_id=?)")
    .bind(JSON.stringify(data), at, order.id, expected, by.customerId || null, by.customerId || null, order.id).run();
  if (!result.meta.changes) throw new ApiError(409, "conflict", "The order changed or was invoiced. Reload it before saving.");
  return { ...data, id: order.id, version: expected + 1, updatedAt: at } as AnyOrder;
}
async function changeable(env: Env, id: string, by: Changer) {
  const order = await get<Record<string, any>>(env, "order", id);
  if (!order || order.deletedAt != null || (by.customerId && order.customerId !== by.customerId)) throw new ApiError(404, "not_found", "Order not found.");
  if (order.preview !== false) throw invalid("Only customer orders can be amended.");
  if (by.customerId && !order.standing) throw new ApiError(409, "not_standing", "Only standing orders can be changed here. Contact Strangers about this order.");
  if (!OPEN.includes(order.status)) throw new ApiError(409, "order_closed", order.status === "Dispatched" ? "This delivery has been dispatched, so it can't be changed now." : "This delivery has been cancelled, so it can't be changed now.");
  if (await env.DB.prepare(`SELECT ${INVOICED_SQL} AS yes`).bind(id).first<{ yes: number }>().then((r) => r?.yes)) throw new ApiError(409, "invoiced", by.customerId ? "This delivery has been invoiced, so it can't be changed here. Contact Strangers." : "This order has an invoice, so its bags can't be changed.");
  return order;
}

/** Skip one delivery of a standing order: the run is Cancelled (marked who skipped it) and the next run is made. */
export async function skipRun(env: Env, id: string, value: unknown, actor: string, by: Changer, ctx?: ExecutionContext): Promise<AnyOrder> {
  const body = object(value);
  const order = await changeable(env, id, by);
  if (!order.standing) throw invalid("Only a standing order's delivery can be skipped. To stop a one-off order, cancel it.");
  const marked = await saveChange(env, order, { ...strip(order), status: "Cancelled", skipped: { by: by.customerId ? order.business || "The customer" : actor, customer: !!by.customerId, at: Date.now() } }, version(body.ifVersion), by);
  await audit(env, "wholesale_preview_status", actor, `${actor} skipped wholesale standing delivery ${id}.`);
  await rollStanding(env, marked, actor, ctx);
  return (await get(env, "order", id)) || marked;
}

/** Amends the bags on a New, Preparing or Ready customer order with no invoice: kept lines keep their saved price; added
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
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock.`);
    const price = (product.prices as Record<string, number>)[line.pack];
    if (!Number.isInteger(price)) throw invalid("Choose a 250 g or 1 kg bag.");
    if (!packsOf(product).includes(line.pack as "quarter" | "kilo")) throw invalid(`${product.name} is sold in ${LABELS[packsOf(product)[0]]}s only.`);
    const grind = product.grindOptions.find((option) => option.id === line.grind && option.enabled);
    if (!grind) throw invalid(`${product.name} doesn't offer that grind.`);
    lines.push({ productId: product.id, pack: line.pack, grind: grind.id, quantity: line.quantity, title: product.title, packLabel: LABELS[line.pack], grindLabel: grind.label, grindHint: grind.hint || "", decaf: product.categories.includes("decaf"), price, grams: GRAMS[line.pack], ...(product.recipe?.length ? { recipe: recipeText(product) } : {}) });
  }
  // Validate after merging duplicate variants, so split rows cannot bypass the
  // increase check. Unchanged/reduced historical lines retain their snapshots.
  for (const line of lines) {
    const kept = order.lines.find((l: any) => l.productId === line.productId && l.pack === line.pack && l.grind === line.grind);
    if (!kept || line.quantity <= kept.quantity) continue;
    const product = coffees.find(p => p.id === line.productId);
    if (!product || !product.active || !canOrder(product, order.customerId || null)) throw invalid("This coffee is no longer available to this business. Reduce or remove it.");
    if (!product.inStock) throw new ApiError(409, "out_of_stock", `${product.name} is out of stock. Reduce or remove it.`);
    if (!packsOf(product).includes(line.pack) || !["quarter", "kilo"].includes(line.pack)) throw invalid("This bag size is no longer available. Reduce or remove it.");
    if (!product.grindOptions.some(g => g.id === line.grind && g.enabled)) throw invalid("This grind is no longer available. Reduce or remove it.");
  }
  lines.sort((a, b) => `${a.productId}:${a.pack}:${a.grind}`.localeCompare(`${b.productId}:${b.pack}:${b.grind}`));
  const sum = totals(lines, order.delivery, !!order.freeDelivery);
  if (by.minimumGrams && sum.grams < by.minimumGrams) throw new ApiError(409, "below_minimum", `The minimum order is ${by.minimumGrams / 1000} kg of coffee. Add ${(by.minimumGrams - sum.grams) / 1000} kg more.`);
  const { repeatLines, packedLines, ...current } = strip(order as AnyOrder);
  const packingChanged = lines.length !== order.lines.length || lines.some((line, i) => {
    const before = order.lines[i];
    return line.productId !== before.productId || line.pack !== before.pack || line.grind !== before.grind || line.quantity !== before.quantity;
  });
  const updated = await saveChange(env, order, {
    ...current, lines, ...sum, originalLines: order.originalLines || order.lines, amendedAt: Date.now(),
    ...(packingChanged && order.status === "Ready" ? { status: "Preparing" } : {}),
    ...(!packingChanged && packedLines ? { packedLines } : {}),
    amendedBy: by.customerId ? order.business || "The customer" : actor, ...(by.customerId ? { amendedByCustomer: true } : { amendedByCustomer: false }),
    ...(once ? { repeatLines: repeatLines || order.lines } : {}),
  }, version(body.ifVersion), by);
  await audit(env, "wholesale_order_amended", actor, `${actor} amended the bags on wholesale order ${id}${order.standing ? (once ? " (this delivery only)" : " (every delivery from now on)") : ""}.`);
  return updated as AnyOrder;
}
