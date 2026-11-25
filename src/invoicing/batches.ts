import { audit } from "../audit";
import type { User } from "../auth";
import { cleanEmail } from "../email/address";
import { ApiError, type Env, invalid, json, readJson } from "../http";
import { wakeIntegration } from "../integrationSignals";
import { connection } from "../quickbooks/connection";
import { machineRequest } from "../quickbooks/jobs";
import { type Environment } from "../quickbooks/preview";
import { requireExportMode, settings as accountingSettings } from "../quickbooks/settings";
import { NumberUnavailable } from "../quickbooks/sharedNumber";
import type { Customer, CustomerRecord } from "../wholesaleAccounts";
import {
  InvoiceHold, issueReviewedBatchInvoice, prepareBatchInvoice, settings as invoiceSettings,
  type ReviewedBatchInvoice, type SourceOrder,
} from "../wholesaleInvoices";
import { decode, object, type Row } from "../wholesaleStore";
import { accountsEmail, DISPATCHED, month, OUTSIDE_TAB, periodOf, UNBILLED_ORDERS } from "./billingData";

const PAGE_SIZE = 40;
const BATCH_SIZE = 12;
const BATCH_KEY = "CASE WHEN a.cadence='monthly' THEN 'monthly:'||c.id ELSE o.id END";
const SCOPED_ORDERS = `${UNBILLED_ORDERS} AND ${OUTSIDE_TAB} AND ${DISPATCHED}>=?1 AND ${DISPATCHED}<?2`;
type Delivery = "issue" | "export" | "email";
interface BatchRow {
  id: string; period: string; by_id: string; by_name: string; delivery: Delivery;
  state: "draft" | "approved"; environment: Environment | ""; realm_id: string; generation: string;
  created_at: number; approved_at: number | null;
}
type Work = { id: number; recipient: string; data: string; customer_id: string; business: string; state: string; reason: string };
const batchMissing = () => new ApiError(404, "not_found", "Invoice batch not found.");
const batchChanged = (message: string) => new ApiError(409, "invoice_batch_changed", message);
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const validSelection = (id: unknown): id is string => typeof id === "string" && /^(?:WS-[A-F0-9]{32}|monthly:[A-Za-z0-9_-]{1,100})$/.test(id);

async function batch(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT * FROM wholesale_invoice_batches WHERE id=?").bind(id).first<BatchRow>();
  if (!row) throw batchMissing();
  return row;
}

async function batchList(req: Request, env: Env) {
  const params = new URL(req.url).searchParams;
  const period = periodOf(params.get("period") || month()), after = params.get("after") || "";
  if (after && !validSelection(after)) throw invalid("Choose a valid batch page.");
  const [candidates, recent] = await Promise.all([
    env.DB.prepare(`SELECT ${BATCH_KEY} AS id,c.id AS account,json_extract(c.data,'$.business') AS business,
      COUNT(*) AS orders,MAX(${DISPATCHED}) AS dispatchedAt,CASE WHEN a.cadence='monthly' THEN 1 ELSE 0 END AS monthly
      ${SCOPED_ORDERS} AND (${BATCH_KEY})>?3 GROUP BY ${BATCH_KEY} ORDER BY id LIMIT ?4`)
      .bind(period.from, period.until, after, PAGE_SIZE + 1).all<{ id: string; account: string; business: string; orders: number; dispatchedAt: number; monthly: number }>(),
    env.DB.prepare(`SELECT b.id,b.period,b.delivery,b.approved_at AS at,COUNT(i.id) AS entries,
      COUNT(*) FILTER(WHERE i.state='issued') AS issued,
      COUNT(*) FILTER(WHERE i.state='failed') AS attention
      FROM wholesale_invoice_batches b JOIN wholesale_invoice_batch_items i ON i.batch_id=b.id
      WHERE b.state='approved' GROUP BY b.id ORDER BY b.approved_at DESC LIMIT 8`).all(),
  ]);
  const rows = candidates.results.slice(0, PAGE_SIZE);
  return { period: period.key, closed: period.closed, candidates: rows.map(row => ({ ...row, monthly: !!row.monthly })),
    next: candidates.results.length > PAGE_SIZE ? rows.at(-1)!.id : null, recent: recent.results, maxSelection: BATCH_SIZE };
}

async function batchView(env: Env, saved: BatchRow) {
  const { results } = await env.DB.prepare(`SELECT j.*,i.invoice_number,a.state AS job_state,a.reason AS job_reason,
      e.state AS export_state,e.email_state,e.id AS export_id,e.last_error AS export_error,e.email_error
    FROM wholesale_invoice_batch_items j
    LEFT JOIN wholesale_invoices i ON i.seq=j.invoice_id
    LEFT JOIN wholesale_auto_invoices a ON a.source='batch:'||j.id
    LEFT JOIN quickbooks_exports e ON e.invoice_id=i.seq AND e.environment=? AND e.realm_id=?
    WHERE j.batch_id=? ORDER BY j.position`).bind(saved.environment, saved.realm_id, saved.id)
    .all<Work & { invoice_id: number | null; invoice_number: string | null; job_state: string | null; job_reason: string | null;
      export_state: string | null; email_state: string | null; export_id: number | null; export_error: string | null; email_error: string | null }>();
  return { id: saved.id, period: saved.period, state: saved.state, delivery: saved.delivery, environment: saved.environment,
    by: saved.by_name, at: saved.approved_at || saved.created_at,
    items: results.map(row => {
      const review = JSON.parse(row.data) as ReviewedBatchInvoice | null;
      return {
        id: row.id, customerId: row.customer_id, business: row.business, email: row.recipient,
        orders: review ? Object.keys(review.orders) : [], terms: review?.invoice.paymentTerms.label || "", due: review?.invoice.dueDate || null,
        grossPence: review?.invoice.totals.grossPence ?? null, state: row.state, invoiceId: row.invoice_id, number: row.invoice_number,
        posted: row.export_state === "linked", emailed: row.email_state === "sent",
        jobState: row.job_state || "", exportState: row.export_state || "", emailState: row.email_state || "", exportId: row.export_id,
        reason: row.reason || row.job_reason || row.export_error || row.email_error || "",
      };
    }),
  };
}

async function previewBatch(req: Request, env: Env, user: User, body: Record<string, any>) {
  const period = periodOf(body.period);
  if (!Array.isArray(body.selected) || !body.selected.length || body.selected.length > BATCH_SIZE || !body.selected.every(validSelection)) {
    throw invalid("Choose between 1 and " + BATCH_SIZE + " invoice entries.");
  }
  const selected = [...new Set<string>(body.selected)], delivery = body.delivery as Delivery;
  if (!["issue", "export", "email"].includes(delivery)) throw invalid("Choose how to handle the issued invoices.");
  const config = await invoiceSettings(env);
  if (!config.ready) throw batchChanged(config.reasons.join(" "));
  let scope = { environment: "" as Environment | "", realm: "", generation: "" };
  if (delivery !== "issue") {
    const state = await accountingSettings(env);
    const company = await connection(env, state.active_environment);
    await requireExportMode(req, env, company, [], state.version);
    scope = { environment: state.active_environment, realm: company.realm_id, generation: company.generation };
  }
  const { results } = await env.DB.prepare(`SELECT o.id,o.data,o.version,o.updated_at, c.id AS customer_id,c.data AS company,c.version AS customer_version,
      COALESCE(a.version,0) AS account_version,${BATCH_KEY} AS entry,
      r.id AS profile_id,r.address AS profile_address,r.postcode AS profile_postcode
      ${SCOPED_ORDERS} AND (${BATCH_KEY}) IN (SELECT value FROM json_each(?3)) ORDER BY ${DISPATCHED},o.id LIMIT 181`
    // A correlated lookup supplies the last Live billing decision for each selected account.
    .replace("WHERE o.kind=", `LEFT JOIN wholesale_invoice_billing_reviews r ON r.id=(
      SELECT id FROM wholesale_invoice_billing_reviews WHERE customer_id=c.id AND environment='production' ORDER BY id DESC LIMIT 1)
      WHERE o.kind=`))
    .bind(period.from, period.until, JSON.stringify(selected)).all<Row & { customer_id: string; company: string; customer_version: number;
      entry: string; account_version: number; profile_id: number | null; profile_address: string | null; profile_postcode: string | null }>();
  if (results.length > 180) throw invalid("Review a smaller selection of dispatched orders.");
  const grouped = new Map<string, typeof results>(), id = crypto.randomUUID();
  for (const row of results) {
    if (!grouped.has(row.entry)) grouped.set(row.entry, []);
    grouped.get(row.entry)!.push(row);
  }
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO wholesale_invoice_batches
      (id,period,state,by_id,by_name,delivery,environment,realm_id,generation,created_at)
      VALUES (?,?,'draft',?,?,?,?,?,?,?)`)
      .bind(id, period.key, user.id, user.name, delivery, scope.environment, scope.realm, scope.generation, Date.now()),
  ];
  for (const [position, entry] of selected.entries()) {
    const rows = grouped.get(entry), first = rows?.[0];
    const customer = first ? { ...(JSON.parse(first.company) as Customer), id: first.customer_id, version: first.customer_version, updatedAt: 0 } as CustomerRecord : null;
    const recipient = !customer ? "" : scope.environment === "sandbox" ? cleanEmail(config.settings.seller.email) || "" : accountsEmail(customer);
    let reviewed: ReviewedBatchInvoice | null = null, reason = "";
    try {
      const monthly = entry.startsWith("monthly:");
      if (!first || !rows || !customer) throw new InvoiceHold("These dispatched orders changed or were already invoiced.");
      if (monthly && !period.closed) throw new InvoiceHold("This account bills after the month has closed.");
      if (delivery === "email" && !recipient) throw new InvoiceHold(scope.environment === "sandbox"
        ? "Set the supplier’s test email in Invoice settings." : "Add a valid accounts email before emailing the invoice.");
      const profile = first.profile_id === null ? null : { id: first.profile_id, address: first.profile_address!, postcode: first.profile_postcode || "" };
      reviewed = prepareBatchInvoice(rows.map(decode<SourceOrder>), customer, config, first.account_version, profile, period.key, monthly);
      if (delivery !== "issue" && !reviewed.invoice.dueDate) throw new InvoiceHold("Review the agreed payment terms and enter a due date on this invoice.");
    } catch (error) {
      if (!(error instanceof InvoiceHold || (error instanceof ApiError && error.status < 500))) throw error;
      reason = error.message;
    }
    writes.push(env.DB.prepare(`INSERT INTO wholesale_invoice_batch_items(batch_id,position,customer_id,business,recipient,data,state,reason)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, position, customer?.id || "", customer?.business || "Order changed",
        recipient, JSON.stringify(reviewed), reason ? "failed" : "waiting", reason));
  }
  await env.DB.batch(writes);
  return batchView(env, await batch(env, id));
}

/** Explicit approval survives a reload. A leased item either recovers its own invoice or passes the current issue guards. */
export async function advanceBatchItem(req: Request, env: Env, saved: BatchRow, itemId: number) {
  if (saved.state !== "approved") return;
  const owner = crypto.randomUUID(), at = Date.now();
  const item = await env.DB.prepare(`UPDATE wholesale_invoice_batch_items SET state='working',lease_owner=?,lease_until=?
    WHERE id=? AND batch_id=? AND state IN ('waiting','working') AND lease_until<=? RETURNING *`)
    .bind(owner, at + 120000, itemId, saved.id, at).first<Work>();
  if (!item) return;
  try {
    const review = JSON.parse(item.data) as ReviewedBatchInvoice;
    const company = saved.environment ? { environment: saved.environment, realm: saved.realm_id, generation: saved.generation } : undefined;
    const invoice = await issueReviewedBatchInvoice(req, env, review, item.id, owner, { id: saved.by_id, name: saved.by_name }, company);
    const source = "batch:" + item.id, now = Date.now();
    const writes = [env.DB.prepare(`UPDATE wholesale_invoice_batch_items SET state='issued',invoice_id=?,reason='',lease_owner=NULL,lease_until=0
      WHERE id=? AND lease_owner=?`).bind(invoice.id, item.id, owner)];
    if (saved.delivery !== "issue") writes.push(env.DB.prepare(`INSERT OR IGNORE INTO wholesale_auto_invoices
      (source,customer_id,business,invoice_id,state,created_at,updated_at)
      SELECT ?,customer_id,business,invoice_id,'issued',?,?
      FROM wholesale_invoice_batch_items WHERE id=? AND state='issued' AND invoice_id=?`).bind(source, now, now, item.id, invoice.id));
    const result = await env.DB.batch(writes);
    if (result[1]?.meta.changes && env.QUICKBOOKS_QUEUE) await wakeIntegration(env.QUICKBOOKS_QUEUE, { key: "auto:" + source }, async () => {});
  } catch (error) {
    const permanent = error instanceof ApiError && error.status < 500;
    const waitingForNumber = error instanceof NumberUnavailable;
    await env.DB.prepare(`UPDATE wholesale_invoice_batch_items SET state=?,reason=?,lease_owner=NULL,lease_until=0
      WHERE id=? AND lease_owner=?`).bind(permanent ? "failed" : "waiting", permanent || waitingForNumber ? error.message : "Waiting to retry issuance.", item.id, owner).run();
    if (!permanent && !waitingForNumber) throw error;
  }
}

export async function runInvoiceBatches(env: Env) {
  const row = await env.DB.prepare(`SELECT j.id,j.batch_id FROM wholesale_invoice_batch_items j
    JOIN wholesale_invoice_batches b ON b.id=j.batch_id AND b.state='approved'
    WHERE j.state IN ('waiting','working') AND j.lease_until<=? ORDER BY j.id LIMIT 1`)
    .bind(Date.now()).first<{ id: number; batch_id: string }>();
  if (row) await advanceBatchItem(machineRequest(env), env, await batch(env, row.batch_id), row.id);
}

export async function handleBatches(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  if (route === "batches" && req.method === "GET") return json(await batchList(req, env));
  if (route === "batches/preview" && req.method === "POST") return json(await previewBatch(req, env, user, object(await readJson(req, 4096))), 201);
  const match = /^batches\/([^/]+)(?:\/(approve)|\/items\/(\d+)\/run)?$/.exec(route);
  if (!match) return null;
  const [, id, approve, itemId] = match;
  if (!validId(id)) throw batchMissing();
  let saved = await batch(env, id);
  if (!approve && !itemId && req.method === "GET") return json(await batchView(env, saved));
  if (approve && req.method === "POST") {
    const body = object(await readJson(req, 1024));
    if (body.reviewed !== true || saved.by_id !== user.id) throw invalid("Confirm the reviewed invoices and their delivery before starting this batch.");
    if (saved.state === "draft") {
      if (!await env.DB.prepare("SELECT 1 FROM wholesale_invoice_batch_items WHERE batch_id=? AND state='waiting' LIMIT 1").bind(id).first()) {
        throw batchChanged("There are no ready invoices in this review.");
      }
      if (saved.environment) {
        const state = await accountingSettings(env), company = await connection(env, saved.environment);
        if (state.active_environment !== saved.environment || company.realm_id !== saved.realm_id || company.generation !== saved.generation) {
          throw batchChanged("The QuickBooks company changed. Prepare a new review.");
        }
        await requireExportMode(req, env, company, [], state.version);
      }
      const changed = await env.DB.prepare(`UPDATE wholesale_invoice_batches SET state='approved',approved_at=?
        WHERE id=? AND state='draft' AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1)`)
        .bind(Date.now(), id, user.id).run();
      if (changed.meta.changes) await audit(env, "wholesale_invoice_batch", user.name, "Approved wholesale invoice batch for " + saved.period + ".");
      saved = await batch(env, id);
    }
    return json(await batchView(env, saved));
  }
  if (itemId && req.method === "POST") {
    await readJson(req, 1024);
    if (!Number.isSafeInteger(Number(itemId)) || Number(itemId) < 1) throw invalid("Choose a batch item.");
    await advanceBatchItem(req, env, saved, Number(itemId));
    return json(await batchView(env, saved));
  }
  return null;
}
