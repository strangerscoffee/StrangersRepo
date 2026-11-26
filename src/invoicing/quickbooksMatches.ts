// Orders already invoiced in QuickBooks (the owner's request, 26 Nov 2026). Before automatic invoicing was switched on,
// invoices were raised by hand in QuickBooks, so those orders still showed as unbilled dispatches. This finds the
// QuickBooks invoice for each one (same customer and total, dated around the order) and, once an admin confirms,
// records the match so the order counts as invoiced. Nothing is issued, numbered, posted or emailed, and nothing is
// changed in QuickBooks: it only reads.
import { audit } from "../audit";
import type { User } from "../auth";
import { ApiError, type Env, invalid, json, readJson } from "../http";
import { connection, resourceReader } from "../quickbooks/connection";
import { mapping } from "../quickbooks/mappings";
import { settings } from "../quickbooks/settings";
import { object } from "../wholesaleStore";
import { day, UNBILLED_ORDERS } from "./billingData";
import { pairUp, shift, ukDay, type OrderRow, type Remote, type Suggestion } from "./quickbooksMatchMath";

const PAGE = 1000;
const ownInvoice = /sc-qbo-invoice-v1/;

async function unbilled(env: Env) {
  const { results } = await env.DB.prepare(`SELECT o.id,o.version,c.id AS customerId,json_extract(c.data,'$.business') AS business,
      json_extract(c.data,'$.quickbooksName') AS quickbooksName,CAST(json_extract(o.data,'$.totalPence') AS INTEGER) AS totalPence,
      CAST(json_extract(o.data,'$.createdAt') AS INTEGER) AS createdAt,CAST(json_extract(o.data,'$.dispatchedAt') AS INTEGER) AS dispatchedAt,
      CASE WHEN json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL THEN 0 ELSE 1 END AS onTab
    ${UNBILLED_ORDERS} ORDER BY createdAt,o.id LIMIT 500`).all<OrderRow>();
  return results;
}

/** The live QuickBooks company, read-only. Matching against Sandbox would record invoices that don't exist. */
async function liveCompany(req: Request, env: Env) {
  const state = await settings(env);
  if (state.active_environment !== "production") throw new ApiError(409, "quickbooks_live_required", "Switch QuickBooks to Live before matching orders with its invoices.");
  const company = await connection(env, "production");
  if (company?.status !== "connected") throw new ApiError(409, "quickbooks_reconnect", "Connect QuickBooks Live before matching orders with its invoices.");
  return company;
}

async function remoteInvoices(req: Request, env: Env, company: Awaited<ReturnType<typeof liveCompany>>, from: string) {
  const { read } = await resourceReader(req, env, company, "production");
  const found: Remote[] = [];
  for (let start = 1; start < 10 * PAGE; start += PAGE) {
    const data = await read("/query?minorversion=75&query=" + encodeURIComponent(`SELECT * FROM Invoice WHERE TxnDate >= '${from}' STARTPOSITION ${start} MAXRESULTS ${PAGE}`));
    const rows = data?.QueryResponse?.Invoice;
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      if (!row?.Id || ownInvoice.test(String(row.PrivateNote || ""))) continue;
      found.push({
        id: String(row.Id), number: String(row.DocNumber || ""), date: String(row.TxnDate || ""),
        totalPence: Math.round(Number(row.TotalAmt || 0) * 100), balancePence: Math.round(Number(row.Balance || 0) * 100),
        customerId: String(row.CustomerRef?.value || ""), customerName: String(row.CustomerRef?.name || ""),
      });
    }
    if (list.length < PAGE) break;
  }
  return found;
}

async function suggestions(req: Request, env: Env) {
  const company = await liveCompany(req, env);
  const orders = await unbilled(env);
  if (!orders.length) return { company, suggestions: [] as Suggestion[] };
  const earliest = shift(ukDay(Math.min(...orders.map(order => order.createdAt))), -1);
  const [invoices, links, used] = await Promise.all([
    remoteInvoices(req, env, company, earliest),
    mapping(env, "production", company.realm_id).then(saved => saved.data.customerLinks),
    env.DB.prepare(`SELECT remote_id FROM quickbooks_exports WHERE environment='production' AND realm_id=? AND remote_id IS NOT NULL
        UNION SELECT remote_id FROM wholesale_invoiced_elsewhere WHERE environment='production' AND realm_id=?`)
      .bind(company.realm_id, company.realm_id).all<{ remote_id: string }>().then(rows => new Set(rows.results.map(row => row.remote_id))),
  ]);
  return { company, suggestions: pairUp(orders, invoices, links, used, day()) };
}

async function apply(req: Request, env: Env, user: User) {
  const body = object(await readJson(req, 32768));
  const picked = Array.isArray(body.matches) ? body.matches : null;
  if (!picked || !picked.length || picked.length > 200) throw invalid("Choose between 1 and 200 orders to mark as already invoiced.");
  const wanted = new Map<string, { version: number; remoteId: string }>();
  for (const entry of picked) {
    const item = object(entry);
    if (typeof item.orderId !== "string" || !/^WS-[A-F0-9]{32}$/.test(item.orderId) || !Number.isSafeInteger(item.version) || typeof item.remoteId !== "string" || !/^\d{1,20}$/.test(item.remoteId) || wanted.has(item.orderId)) {
      throw invalid("Choose orders and QuickBooks invoices from the list.");
    }
    wanted.set(item.orderId, { version: item.version as number, remoteId: item.remoteId });
  }
  // Worked out again from QuickBooks now, so only a pairing that still stands is recorded.
  const { company, suggestions: fresh } = await suggestions(req, env);
  const now = Date.now(), statements = [], recorded: Suggestion[] = [];
  for (const suggestion of fresh) {
    const want = wanted.get(suggestion.orderId);
    if (!want) continue;
    if (!suggestion.invoice || suggestion.invoice.id !== want.remoteId || suggestion.version !== want.version) {
      throw new ApiError(409, "quickbooks_match_changed", `${suggestion.business}'s order or its QuickBooks invoice changed. Look again before marking it.`);
    }
    recorded.push(suggestion);
    statements.push(env.DB.prepare(`INSERT INTO wholesale_invoiced_elsewhere(order_id,customer_id,environment,realm_id,remote_id,doc_number,txn_date,total_pence,order_total_pence,actor,created_at)
      SELECT ?,?,'production',?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)
        AND NOT EXISTS(SELECT 1 FROM wholesale_billed_orders WHERE order_id=?)
        AND NOT EXISTS(SELECT 1 FROM wholesale_invoiced_elsewhere WHERE environment='production' AND realm_id=? AND remote_id=?)`)
      .bind(suggestion.orderId, suggestion.customerId, company.realm_id, suggestion.invoice.id, suggestion.invoice.number, suggestion.invoice.date,
        suggestion.invoice.totalPence, suggestion.totalPence, user.name, now, suggestion.orderId, suggestion.version, suggestion.orderId, company.realm_id, suggestion.invoice.id));
  }
  if (recorded.length !== wanted.size) throw new ApiError(409, "quickbooks_match_changed", "Some of those orders are no longer waiting for an invoice. Look again.");
  const results = await env.DB.batch(statements);
  const saved = results.reduce((sum, result) => sum + (result.meta.changes || 0), 0);
  if (saved !== statements.length) {
    // One changed in the meantime: take back what was recorded in this run so it can be looked at again.
    await env.DB.prepare(`DELETE FROM wholesale_invoiced_elsewhere WHERE created_at=? AND actor=? AND order_id IN (${recorded.map(() => "?").join(",")})`)
      .bind(now, user.name, ...recorded.map(entry => entry.orderId)).run();
    throw new ApiError(409, "quickbooks_match_changed", "An order changed while marking. Nothing was recorded; look again.");
  }
  await audit(env, "wholesale_invoiced_elsewhere", user.name, "Marked " + recorded.length + " order" + (recorded.length === 1 ? "" : "s")
    + " as already invoiced in QuickBooks: " + recorded.map(entry => entry.business + " " + entry.orderId + " = QuickBooks " + (entry.invoice!.number || "#" + entry.invoice!.id)
      + (entry.match === "amount" ? " (different total)" : "")).join("; ") + ". Nothing was emailed or posted.");
  return { recorded: recorded.length };
}

async function undo(req: Request, env: Env, user: User, orderId: string) {
  const row = await env.DB.prepare("SELECT * FROM wholesale_invoiced_elsewhere WHERE order_id=?").bind(orderId).first<{ doc_number: string }>();
  if (!row) throw new ApiError(404, "not_found", "That order isn't marked as invoiced in QuickBooks.");
  await env.DB.prepare("DELETE FROM wholesale_invoiced_elsewhere WHERE order_id=?").bind(orderId).run();
  await audit(env, "wholesale_invoiced_elsewhere", user.name, "Took back the QuickBooks invoice " + row.doc_number + " match for " + orderId + "; it shows as unbilled again.");
  return { removed: true };
}

export async function handleQuickBooksMatches(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  if (route === "quickbooks-matches" && req.method === "GET") {
    const { company, suggestions: list } = await suggestions(req, env);
    return json({ company: company.company_name, suggestions: list });
  }
  if (route === "quickbooks-matches" && req.method === "POST") return json(await apply(req, env, user));
  const one = /^quickbooks-matches\/(WS-[A-F0-9]{32})$/.exec(route);
  if (one && req.method === "DELETE") return json(await undo(req, env, user, one[1]));
  return null;
}
