// Orders already invoiced in QuickBooks (the owner's request, 26 Nov 2026). Before automatic invoicing was switched on,
// invoices were raised by hand in QuickBooks, so those orders still showed as unbilled dispatches. This finds the
// QuickBooks invoice for each one (same customer and total, dated around the order) and, once an admin confirms,
// records the match so the order counts as invoiced. Nothing is issued, numbered, posted or emailed, and nothing is
// changed in QuickBooks: it only reads.
import { audit } from "../audit";
import type { User } from "../auth";
import { ApiError, type Env, invalid, json, readJson } from "../http";
import { connection, qbError, resourceReader } from "../quickbooks/connection";
import { digest } from "../quickbooks/crypto";
import { mapping } from "../quickbooks/mappings";
import { settings } from "../quickbooks/settings";
import { object } from "../wholesaleStore";
import { day, UNBILLED_ORDERS } from "./billingData";
import { orderWindow, pairUp, type OrderRow, type Remote, type Suggestion } from "./quickbooksMatchMath";

const INVOICE_PAGE = 250;
const MAX_INVOICE_PAGES = 40;
const ORDER_PAGE = 200;
const PEER_LIMIT = 2000;
const CREATED = "CAST(json_extract(o.data,'$.createdAt') AS INTEGER)";
const DISPATCH_DATE = "CAST(json_extract(o.data,'$.dispatchedAt') AS INTEGER)";
const ORDER_FIELDS = `o.id,o.version,c.id AS customerId,c.version AS customerVersion,
  json_extract(c.data,'$.business') AS business,json_extract(c.data,'$.quickbooksName') AS quickbooksName,
  CAST(COALESCE(json_extract(o.data,'$.totalPence'),json_extract(o.data,'$.pence') + COALESCE(json_extract(o.data,'$.deliveryPence'),0)) AS INTEGER) AS totalPence,
  ${CREATED} AS createdAt,${DISPATCH_DATE} AS dispatchedAt,
  CASE WHEN json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL THEN 0 ELSE 1 END AS onTab`;
const CUSTOMER_NAMES = `SELECT json_group_array(json_object('customerId',id,'business',json_extract(data,'$.business'),
  'quickbooksName',json_extract(data,'$.quickbooksName'))) AS names
  FROM (SELECT id,data FROM wholesale_preview WHERE kind='customer' ORDER BY id)`;
const ORDER_ID = /^WS-[A-F0-9]{32}$/;
const REMOTE_ID = /^\d{1,20}$/;
const changed = () => new ApiError(409, "quickbooks_match_changed", "An order or its QuickBooks invoice changed. Look again before marking it.");
const incomplete = () => new ApiError(409, "quickbooks_match_incomplete", "There are too many orders or QuickBooks invoices in this date range to confirm matches. Try reviewing fewer orders per page.");
const ownInvoice = /sc-qbo-invoice-v1/;

function reviewPage(after: unknown, limit: unknown) {
  const cursor = typeof after === "string" ? /^(\d{1,15})\.(WS-[A-F0-9]{32})$/.exec(after) : null;
  const size = limit == null ? ORDER_PAGE : typeof limit === "number" || typeof limit === "string" ? Number(limit) : NaN;
  if ((!cursor && after != null) || !Number.isInteger(size) || size < 1 || size > ORDER_PAGE) {
    throw invalid("Choose a valid page of orders.");
  }
  return { after: cursor?.[0] ?? null, at: Number(cursor?.[1] ?? 0), id: cursor?.[2] ?? "", size };
}

async function unbilled(env: Env, page: ReturnType<typeof reviewPage>) {
  const { results } = await env.DB.prepare(`SELECT ${ORDER_FIELDS}
    ${UNBILLED_ORDERS} AND (${CREATED},o.id) > (?,?) ORDER BY createdAt,o.id LIMIT ?`)
    .bind(page.at, page.id, page.size + 1).all<OrderRow>();
  const orders = results.slice(0, page.size);
  const last = orders.at(-1);
  return { orders, next: last && results.length > page.size ? last.createdAt + "." + last.id : null };
}

// An order on another page can still have an exact match for one of these invoices.
async function relatedOrders(env: Env, orders: OrderRow[], links: Record<string, string>) {
  const ids = new Set(orders.map(order => order.customerId));
  const remoteIds = new Set([...ids].map(id => links[id]).filter(Boolean));
  for (const [local, remote] of Object.entries(links)) if (remoteIds.has(remote)) ids.add(local);
  const scope = JSON.stringify([...ids]);
  const { results } = await env.DB.prepare(`SELECT ${ORDER_FIELDS}
    ${UNBILLED_ORDERS} AND c.id IN (SELECT value FROM json_each(?))
    ORDER BY createdAt,o.id LIMIT ?`)
    .bind(scope, PEER_LIMIT + 1).all<OrderRow>();
  return { scope, related: results };
}

function overlappingOrders(related: OrderRow[], visible: Set<string>, links: Record<string, string>, today: string) {
  type Group = { orders: OrderRow[]; from: string; to: string; visible: boolean };
  const open = new Map<string, Group>(), groups: Group[] = [];
  // Visit orders by date and keep whole chains of overlapping windows for each customer.
  for (const order of related) {
    const { from, to } = orderWindow(order, today);
    const id = links[order.customerId] ? "quickbooks:" + links[order.customerId] : order.customerId;
    const group = open.get(id);
    if (!group || from > group.to) {
      const next = { orders: [order], from, to, visible: visible.has(order.id) };
      open.set(id, next);
      groups.push(next);
    } else {
      group.orders.push(order);
      if (to > group.to) group.to = to;
      if (visible.has(order.id)) group.visible = true;
    }
  }
  const retained = groups.filter(group => group.visible);
  const included = new Set(retained.flatMap(group => group.orders));
  return {
    peers: related.filter(order => included.has(order)),
    from: retained.reduce((date, group) => group.from < date ? group.from : date, "9999-12-31"),
    to: retained.reduce((date, group) => group.to > date ? group.to : date, "0000-01-01"),
  };
}

/** The live QuickBooks company, read-only. Matching against Sandbox would record invoices that don't exist. */
async function liveCompany(env: Env) {
  const state = await settings(env);
  if (state.active_environment !== "production") throw new ApiError(409, "quickbooks_live_required", "Switch QuickBooks to Live before matching orders with its invoices.");
  const company = await connection(env, "production");
  if (company?.status !== "connected") throw new ApiError(409, "quickbooks_reconnect", "Connect QuickBooks Live before matching orders with its invoices.");
  if (company.currency !== "GBP") throw new ApiError(409, "quickbooks_currency", "Matching orders requires a QuickBooks Live company using GBP.");
  return { company, settingsVersion: state.version };
}

async function remoteInvoices(req: Request, env: Env, company: Awaited<ReturnType<typeof liveCompany>>["company"], from: string, to: string) {
  const { read, check } = await resourceReader(req, env, company, "production");
  const found: Remote[] = [], excluded = new Set<string>(), seen = new Set<string>();
  for (let page = 0; page <= MAX_INVOICE_PAGES; page++) {
    const start = page * INVOICE_PAGE + 1;
    const size = page < MAX_INVOICE_PAGES ? INVOICE_PAGE : 1;
    const data = await read("/query?minorversion=75&query=" + encodeURIComponent(`SELECT * FROM Invoice WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ORDERBY Id STARTPOSITION ${start} MAXRESULTS ${size}`));
    const response = data?.QueryResponse;
    if (!response || typeof response !== "object" || Array.isArray(response)) throw qbError();
    const list = response.Invoice ?? [];
    if (!Array.isArray(list) || list.length > size) throw qbError();
    if (page === MAX_INVOICE_PAGES && list.length) {
      await check();
      return { invoices: [], excluded, complete: false };
    }
    for (const row of list) {
      const id = String(row?.Id ?? ""), date = String(row?.TxnDate ?? "");
      if (!REMOTE_ID.test(id) || seen.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) throw qbError();
      seen.add(id);
      if (ownInvoice.test(String(row.PrivateNote || ""))) excluded.add(id);
      const currency = row.CurrencyRef == null ? company.currency : String(row.CurrencyRef.value ?? "unknown");
      const balance = Math.round(Number(row.Balance) * 100);
      found.push({
        id, date, currency, number: String(row.DocNumber || ""),
        totalPence: Math.round(Number(row.TotalAmt ?? 0) * 100), balancePence: row.Balance != null && Number.isSafeInteger(balance) ? balance : null,
        customerId: String(row.CustomerRef?.value || ""), customerName: String(row.CustomerRef?.name || ""),
      });
    }
    if (list.length < size) {
      await check();
      return { invoices: found, excluded, complete: true };
    }
  }
  throw qbError();
}

async function suggestions(req: Request, env: Env, page: ReturnType<typeof reviewPage>) {
  const { company, settingsVersion } = await liveCompany(env);
  const { orders, next } = await unbilled(env, page);
  const base = { company, settingsVersion, orders, next, suggestions: [] as Suggestion[], review: null, complete: true,
    scope: "[]", related: [] as OrderRow[], customerNames: "[]" };
  if (!orders.length) return { ...base, mappingVersion: 0 };
  const today = day();
  const saved = await mapping(env, "production", company.realm_id);
  const links = saved.data.customerLinks;
  const visible = new Set(orders.map(order => order.id));
  const { scope, related } = await relatedOrders(env, orders, links);
  if (related.length > PEER_LIMIT) return { ...base, mappingVersion: saved.version, complete: false };
  const { peers, from, to } = overlappingOrders(related, visible, links, today);
  if (!peers.length) return { ...base, mappingVersion: saved.version };
  const remoteRead = remoteInvoices(req, env, company, from, to);
  const [remote, used, customers] = await Promise.all([
    remoteRead,
    remoteRead.then(async ({ invoices }) => {
      if (!invoices.length) return [];
      const { results } = await env.DB.prepare(`WITH ids AS (SELECT value FROM json_each(?1))
        SELECT remote_id FROM quickbooks_exports WHERE environment='production' AND realm_id=?2 AND remote_id<>'' AND remote_id IN ids
        UNION SELECT remote_id FROM wholesale_invoiced_elsewhere WHERE environment='production' AND realm_id=?2 AND remote_id IN ids`)
        .bind(JSON.stringify(invoices.map(invoice => invoice.id)), company.realm_id).all<{ remote_id: string }>();
      return results.map(row => row.remote_id);
    }),
    env.DB.prepare(CUSTOMER_NAMES).first<string>("names"),
  ]);
  if (!remote.complete) return { ...base, mappingVersion: saved.version, complete: false };
  const customerNames = customers ?? "[]";
  const identities = JSON.parse(customerNames) as Pick<OrderRow, "customerId" | "business" | "quickbooksName">[];
  const list = pairUp(peers, remote.invoices, links, new Set([...used, ...remote.excluded]), today, identities)
    .filter(suggestion => visible.has(suggestion.orderId));
  const review = await digest(JSON.stringify([company.realm_id, company.generation, company.version, settingsVersion, saved.version, page.after, page.size, list]));
  return { ...base, mappingVersion: saved.version, suggestions: list, review, scope, related, customerNames };
}

async function apply(req: Request, env: Env, user: User) {
  const body = object(await readJson(req, 32768));
  const picked = Array.isArray(body.matches) ? body.matches : null;
  if (!picked || !picked.length || picked.length > ORDER_PAGE) throw invalid(`Choose between 1 and ${ORDER_PAGE} orders to mark as already invoiced.`);
  const page = reviewPage(body.after, body.limit);
  const wanted = new Map<string, { version: number; remoteId: string }>();
  const remoteIds = new Set<string>();
  for (const entry of picked) {
    const item = object(entry);
    if (typeof item.orderId !== "string" || !ORDER_ID.test(item.orderId) || !Number.isSafeInteger(item.version) || typeof item.remoteId !== "string" || !REMOTE_ID.test(item.remoteId) || wanted.has(item.orderId) || remoteIds.has(item.remoteId)) {
      throw invalid("Choose distinct orders and QuickBooks invoices from the list.");
    }
    wanted.set(item.orderId, { version: item.version as number, remoteId: item.remoteId });
    remoteIds.add(item.remoteId);
  }
  if (typeof body.review !== "string") throw changed();
  // Recalculate the reviewed page to check both the pairing and the company displayed to the admin.
  const { company, settingsVersion, mappingVersion, orders, suggestions: fresh, complete, review, scope, related, customerNames } = await suggestions(req, env, page);
  if (!complete) throw incomplete();
  if (review !== body.review) throw changed();
  const recorded = fresh.filter(suggestion => wanted.has(suggestion.orderId));
  if (recorded.length !== wanted.size || recorded.some(suggestion => {
    const want = wanted.get(suggestion.orderId)!;
    return suggestion.invoice?.id !== want.remoteId || suggestion.version !== want.version;
  })) throw changed();
  const customerVersions = new Map(orders.map(order => [order.id, order.customerVersion]));
  const rows = recorded.map(entry => ({
    order: entry.orderId, orderVersion: entry.version, customer: entry.customerId, customerVersion: customerVersions.get(entry.orderId),
    remote: entry.invoice!.id, number: entry.invoice!.number, date: entry.invoice!.date, total: entry.invoice!.totalPence, orderTotal: entry.totalPence,
  }));
  // Recheck the eligible peer set and selected invoices before recording any of the matches.
  const result = await env.DB.prepare(`
    WITH picked AS MATERIALIZED (
      SELECT json_extract(value,'$.order') AS order_id,json_extract(value,'$.orderVersion') AS order_version,
        json_extract(value,'$.customer') AS customer_id,json_extract(value,'$.customerVersion') AS customer_version,
        json_extract(value,'$.remote') AS remote_id,json_extract(value,'$.number') AS doc_number,
        json_extract(value,'$.date') AS txn_date,json_extract(value,'$.total') AS total_pence,
        json_extract(value,'$.orderTotal') AS order_total_pence FROM json_each(?1)
    ), current_context AS MATERIALIZED (
      SELECT o.id,o.version,c.id AS customer_id,c.version AS customer_version ${UNBILLED_ORDERS}
        AND c.id IN (SELECT value FROM json_each(?11))
    ), eligible AS MATERIALIZED (
      SELECT p.order_id FROM picked p JOIN current_context o ON p.order_id=o.id AND p.order_version=o.version
        AND p.customer_id=o.customer_id AND p.customer_version=o.customer_version
      WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoiced_elsewhere m WHERE m.environment='production' AND m.realm_id=?2 AND m.remote_id=p.remote_id)
        AND NOT EXISTS(SELECT 1 FROM quickbooks_exports x WHERE x.environment='production' AND x.realm_id=?2 AND x.remote_id<>'' AND x.remote_id=p.remote_id)
    )
    INSERT INTO wholesale_invoiced_elsewhere(order_id,customer_id,environment,realm_id,remote_id,doc_number,txn_date,total_pence,order_total_pence,actor,created_at)
    SELECT order_id,customer_id,'production',?2,remote_id,doc_number,txn_date,total_pence,order_total_pence,?3,?4
    FROM picked
    WHERE (SELECT count(*) FROM eligible) = ?5
      AND (SELECT count(*) FROM current_context) = ?12
      AND NOT EXISTS (
        SELECT id,version,customer_id,customer_version FROM current_context
        EXCEPT SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?13)
      )
      AND (${CUSTOMER_NAMES})=?14
      AND EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment='production' AND version=?6)
      AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment='production' AND status='connected' AND realm_id=?2 AND generation=?7 AND version=?8)
      AND COALESCE((SELECT version FROM quickbooks_environment_mappings WHERE environment='production' AND realm_id=?2),0)=?9
      AND EXISTS(SELECT 1 FROM users WHERE id=?10 AND role='admin' AND active=1)`)
    .bind(JSON.stringify(rows), company.realm_id, user.name, Date.now(), rows.length, settingsVersion,
      company.generation, company.version, mappingVersion, user.id, scope, related.length,
      JSON.stringify(related.map(order => [order.id, order.version, order.customerId, order.customerVersion])), customerNames).run();
  if (result.meta.changes !== rows.length) throw changed();
  await audit(env, "wholesale_invoiced_elsewhere", user.name, "Marked " + recorded.length + " order" + (recorded.length === 1 ? "" : "s")
    + " as already invoiced in QuickBooks: " + recorded.map(entry => entry.business + " " + entry.orderId + " = QuickBooks " + (entry.invoice!.number || "#" + entry.invoice!.id)
      + (entry.match === "amount" ? " (different total)" : "")).join("; ") + ". Nothing was emailed or posted.");
  return { recorded: recorded.length };
}

async function undo(env: Env, user: User, orderId: string) {
  const row = await env.DB.prepare("DELETE FROM wholesale_invoiced_elsewhere WHERE order_id=? RETURNING doc_number").bind(orderId).first<{ doc_number: string }>();
  if (!row) throw new ApiError(404, "not_found", "That order isn't marked as invoiced in QuickBooks.");
  await audit(env, "wholesale_invoiced_elsewhere", user.name, "Took back the QuickBooks invoice " + row.doc_number + " match for " + orderId + "; it shows as unbilled again.");
  return { removed: true };
}

export async function handleQuickBooksMatches(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  if (route === "quickbooks-matches" && req.method === "GET") {
    const query = new URL(req.url).searchParams;
    const page = reviewPage(query.get("after"), query.get("limit"));
    const { company, suggestions: list, next, complete, review } = await suggestions(req, env, page);
    return json({ company: company.company_name, suggestions: list, next, complete, review, limit: page.size });
  }
  if (route === "quickbooks-matches" && req.method === "POST") return json(await apply(req, env, user));
  const one = /^quickbooks-matches\/(WS-[A-F0-9]{32})$/.exec(route);
  if (one && req.method === "DELETE") return json(await undo(env, user, one[1]));
  return null;
}
