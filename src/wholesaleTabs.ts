// Customer tabs: a running tally of a customer's orders, cleared (settled) once it reaches 6 kg of coffee, or earlier.
// An order goes on its customer's open tab by hand (staff with wholesale orders access, or Admin), or automatically
// when the customer is set to "Put orders on a tab" in Admin. Orders on a tab are still packed and dispatched as
// normal: the tab only adds them up. Clearing records who cleared it, when, and the orders, kg, bags (and £, shown to
// admins only), then the customer starts a fresh tab. Stored in the order JSON (`tab`, `tabClearedId`) and as
// rows in migration 22's `wholesale_tabs`. Cancelled and removed orders don't count.
import { ApiError, type Env, invalid } from "./http";
import { object, version, get, save, decode, type Row, type Versioned } from "./wholesaleStore";
import { MINIMUM_ORDER_GRAMS } from "../public/wholesale/limits.js";
import { audit } from "./audit";

/** The usual point to clear a tab: the wholesale minimum, 6 kg. */
export const TAB_GRAMS = MINIMUM_ORDER_GRAMS;
type AnyOrder = Record<string, any> & Versioned;
export interface TabClear { customerId: string; business: string; clearedAt: number; clearedBy: string; orderIds: string[]; grams: number; packs: number; pence: number; early: boolean }

const OPEN_TAB = "kind='order' AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.tab') IS NOT NULL AND json_extract(data,'$.tabClearedId') IS NULL";
const counts = (o: AnyOrder) => o.status !== "Cancelled";

function tabOrder(o: AnyOrder, admin: boolean) {
  return { id: o.id, version: o.version, date: o.date, createdAt: o.createdAt, status: o.status, reference: o.reference || "", packs: o.packs, grams: o.grams, ...(admin ? { pence: o.pence } : {}), addedAt: o.tab?.at, addedBy: o.tab?.auto ? "Automatically" : o.tab?.by || "", counts: counts(o) };
}
function summarise(orders: AnyOrder[], admin: boolean) {
  const counted = orders.filter(counts);
  const grams = counted.reduce((t, o) => t + (o.grams || 0), 0), packs = counted.reduce((t, o) => t + (o.packs || 0), 0), pence = counted.reduce((t, o) => t + (o.pence || 0), 0);
  return { grams, packs, ...(admin ? { pence } : {}), ready: grams >= TAB_GRAMS, toGo: Math.max(0, TAB_GRAMS - grams), orders: orders.sort((a, b) => a.createdAt - b.createdAt).map((o) => tabOrder(o, admin)) };
}

/** Every customer's open tab (oldest order first), biggest first, plus recently cleared tabs. */
export async function listTabs(env: Env, { admin = false } = {}) {
  const rows = await env.DB.prepare(`SELECT id,data,version,updated_at FROM wholesale_preview WHERE ${OPEN_TAB} LIMIT 2000`).all<Row>();
  const by = new Map<string, AnyOrder[]>();
  for (const row of rows.results) { const o = decode<Record<string, any>>(row) as AnyOrder; if (!o.customerId) continue; (by.get(o.customerId) || by.set(o.customerId, []).get(o.customerId)!).push(o); }
  const customers = await env.DB.prepare("SELECT id,data FROM wholesale_preview WHERE kind='customer'").all<{ id: string; data: string }>();
  const names = new Map<string, { business: string; autoTab: boolean }>();
  for (const c of customers.results) { try { const d = JSON.parse(c.data); names.set(c.id, { business: d.business, autoTab: !!d.autoTab }); } catch {} }
  const open = [...by.entries()].map(([customerId, orders]) => ({ customerId, business: names.get(customerId)?.business || orders[0].business, autoTab: !!names.get(customerId)?.autoTab, ...summarise(orders, admin) }))
    .sort((a, b) => Number(b.ready) - Number(a.ready) || b.grams - a.grams || a.business.localeCompare(b.business));
  const autoOnly = [...names.entries()].filter(([id, c]) => c.autoTab && !by.has(id)).map(([customerId, c]) => ({ customerId, business: c.business, autoTab: true, ...summarise([], admin) }));
  const cleared = await env.DB.prepare("SELECT id,data FROM wholesale_tabs ORDER BY cleared_at DESC LIMIT 50").all<{ id: string; data: string }>();
  return {
    threshold: TAB_GRAMS, open: [...open, ...autoOnly.sort((a, b) => a.business.localeCompare(b.business))],
    cleared: cleared.results.map((row) => { const { pence, ...rest } = JSON.parse(row.data) as TabClear; return { id: row.id, ...rest, ...(admin ? { pence } : {}) }; }),
  };
}

/** Puts an order on (or takes it off) its customer's open tab. Version-checked; a cleared tab's orders stay put. */
export async function setOnTab(env: Env, id: string, value: unknown, actor: string): Promise<AnyOrder> {
  const body = object(value);
  if (typeof body.onTab !== "boolean") throw invalid("Choose whether the order is on the tab.");
  const order = await get<Record<string, any>>(env, "order", id);
  if (!order || order.deletedAt != null || order.preview !== false) throw new ApiError(404, "not_found", "Order not found.");
  if (!order.customerId) throw invalid("Only orders linked to a customer can go on a tab.");
  if (order.tabClearedId) throw new ApiError(409, "tab_cleared", "This order's tab has already been cleared.");
  if (!!order.tab === body.onTab) return order as AnyOrder;
  const { id: _id, version: _v, updatedAt: _u, tab, ...rest } = order;
  const data = body.onTab ? { ...rest, tab: { at: Date.now(), by: actor } } : rest;
  const saved = await save(env, "order", id, data, version(body.ifVersion));
  await audit(env, "wholesale_tab", actor, `${actor} ${body.onTab ? "put" : "took"} wholesale order ${id} ${body.onTab ? "on" : "off"} ${order.business || "the customer"}'s tab.`);
  return saved as AnyOrder;
}

/** Clears a customer's open tab: exactly the orders the person saw (`orderIds`), so one added meanwhile isn't swept in
 *  unseen. Each order is version-checked in one batch; the clear is recorded and the next order starts a new tab. */
export async function clearTab(env: Env, customerId: string, value: unknown, actor: string, { admin = false } = {}) {
  const body = object(value);
  if (!Array.isArray(body.orderIds) || !body.orderIds.length || body.orderIds.length > 500 || body.orderIds.some((x: unknown) => typeof x !== "string")) throw invalid("Send the orders on the tab.");
  const rows = await env.DB.prepare(`SELECT id,data,version,updated_at FROM wholesale_preview WHERE ${OPEN_TAB} AND json_extract(data,'$.customerId')=?`).bind(customerId).all<Row>();
  const orders = rows.results.map((row) => decode<Record<string, any>>(row) as AnyOrder);
  const seen = new Set(body.orderIds as string[]);
  if (!orders.length) throw new ApiError(404, "not_found", "This customer has nothing on their tab.");
  if (orders.length !== seen.size || orders.some((o) => !seen.has(o.id))) throw new ApiError(409, "conflict", "The tab changed on another device. Reload it before clearing.");
  const counted = orders.filter(counts);
  const customer = await get<Record<string, any>>(env, "customer", customerId);
  const tabId = crypto.randomUUID(), at = Date.now();
  const record: TabClear = { customerId, business: customer?.business || orders[0].business || "Customer", clearedAt: at, clearedBy: actor, orderIds: orders.map((o) => o.id), grams: counted.reduce((t, o) => t + (o.grams || 0), 0), packs: counted.reduce((t, o) => t + (o.packs || 0), 0), pence: counted.reduce((t, o) => t + (o.pence || 0), 0), early: false };
  record.early = record.grams < TAB_GRAMS;
  const statements = [
    env.DB.prepare("INSERT INTO wholesale_tabs (id,customer_id,cleared_at,data) VALUES (?,?,?,?)").bind(tabId, customerId, at, JSON.stringify(record)),
    ...orders.map((o) => { const { id, version: v, updatedAt, ...rest } = o; return env.DB.prepare("UPDATE wholesale_preview SET data=?,version=version+1,updated_at=? WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.tabClearedId') IS NULL").bind(JSON.stringify({ ...rest, tabClearedId: tabId }), at, id, v); }),
  ];
  // All or nothing: an order that changed since it was read matches no row, so the clear is undone (the cleared orders
  // put back and the record removed) and refused.
  const results = await env.DB.batch(statements);
  if (results.slice(1).some((r) => !r.meta.changes)) {
    const done = orders.filter((_, i) => results[i + 1].meta.changes);
    const undo = done.map((o) => { const { id, version: v, updatedAt, ...rest } = o; return env.DB.prepare("UPDATE wholesale_preview SET data=?,version=version+1,updated_at=? WHERE kind='order' AND id=? AND json_extract(data,'$.tabClearedId')=?").bind(JSON.stringify(rest), Date.now(), id, tabId); });
    await env.DB.batch([...undo, env.DB.prepare("DELETE FROM wholesale_tabs WHERE id=?").bind(tabId)]);
    throw new ApiError(409, "conflict", "An order on the tab changed on another device. Reload it before clearing.");
  }
  await audit(env, "wholesale_tab_cleared", actor, `${actor} cleared ${record.business}'s tab: ${orders.length} ${orders.length === 1 ? "order" : "orders"}, ${(record.grams / 1000).toFixed(2)} kg${record.early ? " (before 6 kg)" : ""}.`);
  const { pence, ...visible } = record;
  return { id: tabId, ...visible, ...(admin ? { pence } : {}) };
}

/** A new customer order goes on the tab straight away when the customer is set to use one. */
export const autoTabFor = (customer: { autoTab?: boolean } | null | undefined) => customer?.autoTab ? { tab: { at: Date.now(), by: "Automatically", auto: true } } : {};
