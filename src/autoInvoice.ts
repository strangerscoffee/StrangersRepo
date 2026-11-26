// Automatic invoicing (the owner's request, 23 Nov 2026; Admin → Wholesale → Invoicing → Automatic invoicing).
// Three switches, each needing the one before: issue an invoice when a customer order is marked Dispatched (a cleared tab
// gets one invoice for its orders instead; Strangers' own shops, "Hide prices" customers, are left out), send it to
// QuickBooks (making any missing customer or coffee item there), and have QuickBooks email it to the customer.
// Only orders dispatched (and tabs cleared) after issuing was switched on are invoiced. Each order or tab is one row in
// wholesale_auto_invoices, worked through by the five-minute jobs (and straight away when it's dispatched or cleared):
// pending → issued → exporting → done, or held with the reason (tried again later, or skipped by an admin).
import { audit } from "./audit";
import type { User } from "./auth";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { object, version } from "./wholesaleStore";
import { issueForOrder, issueForTab, InvoiceHold } from "./wholesaleInvoices";
import { wakeIntegration } from "./integrationSignals";
import { machineRequest } from "./quickbooks/jobs";
import { emailLinkedInvoice, ExportHold, queueAutomaticExport } from "./quickbooks/autoExport";
import type { ExportOperation } from "./quickbooks/operationTypes";
import { isBillingIssue } from "./quickbooks/billingReviews";

export interface AutoSettings { issue: boolean; quickbooks: boolean; email: boolean; since: number; enabledBy: string; enabledByName: string }
const OFF: AutoSettings = { issue: false, quickbooks: false, email: false, since: 0, enabledBy: "", enabledByName: "" };
interface AutoRow { source: string; customer_id: string; business: string; invoice_id: number | null; state: string; reason: string; attempts: number; retry_at: number; lease_owner: string | null; lease_until: number; created_at: number; updated_at: number }
const ACTOR = "Automatic invoicing";
const MINUTE = 60000;

export async function autoSettings(env: Env): Promise<{ settings: AutoSettings; version: number }> {
  const row = await env.DB.prepare("SELECT data, version FROM wholesale_auto_invoicing WHERE id=1").first<{ data: string; version: number }>();
  return { settings: row ? { ...OFF, ...JSON.parse(row.data) } : { ...OFF }, version: row?.version || 0 };
}

// A real customer order that's Dispatched, went out after issuing was switched on, isn't on a tab (open or cleared) and
// isn't for one of Strangers' own shops, with no invoice and not already handled. ?1 = since.
const ORDER_CANDIDATES = `SELECT o.id, json_extract(o.data,'$.customerId') AS customer_id, json_extract(o.data,'$.business') AS business FROM wholesale_preview o
  WHERE o.kind='order' AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.deletedAt') IS NULL AND json_extract(o.data,'$.status')='Dispatched'
  AND COALESCE(CAST(json_extract(o.data,'$.dispatchedAt') AS INTEGER),0) >= ?1 AND json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL
  AND NOT EXISTS(SELECT 1 FROM wholesale_preview c WHERE c.kind='customer' AND c.id=json_extract(o.data,'$.customerId') AND json_extract(c.data,'$.hidePrices')=1)
  AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_accounts a WHERE a.customer_id=json_extract(o.data,'$.customerId') AND a.cadence='monthly')
  AND NOT EXISTS(SELECT 1 FROM wholesale_billed_orders i WHERE i.order_id=o.id) AND NOT EXISTS(SELECT 1 FROM wholesale_auto_invoices a WHERE a.source='order:'||o.id)`;
const TAB_CANDIDATES = `SELECT t.id, t.customer_id, COALESCE(json_extract(t.data,'$.business'),'') AS business FROM wholesale_tabs t WHERE t.cleared_at >= ?1
  AND NOT EXISTS(SELECT 1 FROM wholesale_preview c WHERE c.kind='customer' AND c.id=t.customer_id AND json_extract(c.data,'$.hidePrices')=1)
  AND NOT EXISTS(SELECT 1 FROM wholesale_invoices i WHERE i.order_id='TAB-'||t.id) AND NOT EXISTS(SELECT 1 FROM wholesale_auto_invoices a WHERE a.source='tab:'||t.id)`;

async function enqueue(env: Env, kind: "order" | "tab", since: number, only?: string) {
  const sql = (kind === "order" ? ORDER_CANDIDATES : TAB_CANDIDATES) + (only ? ` AND ${kind === "order" ? "o" : "t"}.id=?2` : "") + " LIMIT 25";
  const rows = (await env.DB.prepare(sql).bind(since, ...(only ? [only] : [])).all<{ id: string; customer_id: string; business: string }>()).results;
  const at = Date.now();
  if (rows.length) await env.DB.batch(rows.map((r) => env.DB.prepare("INSERT OR IGNORE INTO wholesale_auto_invoices(source,customer_id,business,created_at,updated_at) VALUES(?,?,?,?,?)").bind(`${kind}:${r.id}`, r.customer_id || "", r.business || "", at, at)));
  return rows.map((r) => `${kind}:${r.id}`);
}

/** When an order is marked Dispatched or a tab is cleared: queue it (if automatic invoicing is on) and start on it. */
export async function startAutoInvoice(env: Env, source: string, ctx?: ExecutionContext) {
  // Never fails the dispatch or tab clear that called it: the five-minute job picks up anything missed.
  try { await start(env, source, ctx); } catch (error) { console.error("Automatic invoicing could not start", error); }
}
async function start(env: Env, source: string, ctx?: ExecutionContext) {
  const { settings } = await autoSettings(env);
  if (!settings.issue) return;
  const [kind, id] = source.split(/:(.*)/s) as ["order" | "tab", string];
  if (!(await enqueue(env, kind, settings.since, id)).length) return;
  const work = wakeIntegration(env.QUICKBOOKS_QUEUE, { key: "auto:" + source }, () => processAutoInvoice(env, source)).catch((error) => console.error("Automatic invoicing failed", error));
  if (ctx) ctx.waitUntil(work); else await work;
}

async function finish(env: Env, source: string, owner: string, state: string, reason = "", retryIn = 0, invoiceId?: number) {
  const result = await env.DB.prepare(`UPDATE wholesale_auto_invoices SET state=?,reason=?,retry_at=?,attempts=CASE WHEN ?>0 THEN attempts+1 ELSE attempts END,${invoiceId ? "invoice_id=?," : ""}lease_owner=NULL,lease_until=0,updated_at=? WHERE source=? AND lease_owner=?`)
    .bind(state, reason.slice(0, 500), retryIn ? Date.now() + retryIn : 0, retryIn, ...(invoiceId ? [invoiceId] : []), Date.now(), source, owner).run();
  return !!result.meta.changes;
}
/** Held work is tried again every half hour for a day, then every six hours, until it goes or an admin skips it. */
const holdDelay = (attempts: number) => attempts < 48 ? 30 * MINUTE : 360 * MINUTE;

/** Give issuing, export preparation, accounting writes and email separate turns and request budgets. */
export async function processAutoInvoice(env: Env, source: string, req: Request = machineRequest(env)) {
  const owner = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare("UPDATE wholesale_auto_invoices SET lease_owner=?,lease_until=? WHERE source=? AND state IN ('pending','issued','exporting','held') AND retry_at<=? AND lease_until<=? RETURNING *").bind(owner, now + 3 * MINUTE, source, now, now).first<AutoRow>();
  if (!row) return;
  const { settings } = await autoSettings(env);
  try {
    const invoiceId = row.invoice_id;
    if (!invoiceId) {
      if (!settings.issue) return await finish(env, source, owner, "skipped", "Automatic invoicing was switched off before this was invoiced.");
      const [kind, id] = source.split(/:(.*)/s);
      let invoice;
      const issuance = { since: settings.since, leaseOwner: owner };
      try { invoice = kind === "order" ? await issueForOrder(req, env, id, ACTOR, issuance) : await issueForTab(req, env, id, ACTOR, issuance); }
      catch (error) {
        if (error instanceof InvoiceHold) return await finish(env, source, owner, "held", error.message, holdDelay(row.attempts));
        throw error;
      }
      if (!invoice) return await finish(env, source, owner, "skipped", kind === "tab" ? "No eligible orders on this tab needed an invoice." : "This order is no longer eligible for automatic invoicing.");
      const saved = await finish(env, source, owner, settings.quickbooks ? "issued" : "done", "", 0, invoice.id!);
      if (saved && settings.quickbooks) await wakeIntegration(env.QUICKBOOKS_QUEUE, { key: "auto:" + source }, async () => {});
      return;
    }
    const approved = source.startsWith("batch:") ? await env.DB.prepare(`SELECT b.by_id,b.delivery FROM wholesale_invoice_batches b
      JOIN wholesale_invoice_batch_items j ON j.batch_id=b.id WHERE b.state='approved' AND j.state='issued' AND j.id=? AND j.invoice_id=?`)
      .bind(Number(source.slice(6)), invoiceId).first<{ by_id: string; delivery: string }>() : null;
    if (source.startsWith("batch:") && !approved) return await finish(env, source, owner, "held", "Review this approved invoice batch.", holdDelay(row.attempts), invoiceId);
    if (!approved && !settings.quickbooks) return await finish(env, source, owner, "done", "", 0, invoiceId);
    let exported: ExportOperation | null;
    try { exported = await queueAutomaticExport(req, env, invoiceId, approved?.by_id || settings.enabledBy, source, owner); }
    catch (error) {
      if (error instanceof ExportHold || (error instanceof ApiError && error.status < 500 && error.code !== "quickbooks_busy")) return await finish(env, source, owner, "held", "QuickBooks: " + error.message, holdDelay(row.attempts), invoiceId);
      throw error;
    }
    if (!exported) return await finish(env, source, owner, "held", "QuickBooks isn't connected, so this invoice hasn't been sent there yet.", holdDelay(row.attempts), invoiceId);
    if (["queued", "uncertain", "sending"].includes(exported.state)) {
      const saved = await finish(env, source, owner, "exporting", exported.last_error ? "QuickBooks: " + exported.last_error : "", 0, invoiceId);
      if (saved && exported.retry_at <= Date.now() && exported.lease_until <= Date.now()) {
        await wakeIntegration(env.QUICKBOOKS_QUEUE, { exportId: exported.id }, async () => {});
      }
      return;
    }
    if (exported.state !== "linked") return await finish(env, source, owner, "held", "QuickBooks: " + (exported.last_error || "the export needs review in QuickBooks → Export history."), holdDelay(row.attempts), invoiceId);
    if (!(approved ? approved.delivery === "email" : settings.email) || !exported.auto || exported.manual_retry || !exported.created_remote) return await finish(env, source, owner, "done", "", 0, invoiceId);
    const emailed = await emailLinkedInvoice(req, env, exported, source, owner);
    if (emailed === "sent") return await finish(env, source, owner, "done", "", 0, invoiceId);
    const latest = await env.DB.prepare("SELECT email_error FROM quickbooks_exports WHERE id=?").bind(exported.id).first<{ email_error: string }>();
    return await finish(env, source, owner, "held", "QuickBooks email: " + (latest?.email_error || "not sent yet."), emailed === "sending" ? 2 * MINUTE : holdDelay(row.attempts), invoiceId);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Something went wrong. It will be tried again.";
    await finish(env, source, owner, row.invoice_id ? "issued" : "pending", message, Math.min(60, 5 * 2 ** Math.min(row.attempts, 4)) * MINUTE);
    if (!(error instanceof ApiError)) throw error;
  }
}

/** The five-minute job recovers missed starts and advances ready work independently of the export queue. */
export async function runAutoInvoicing(env: Env) {
  const { settings } = await autoSettings(env);
  if (settings.issue) { await enqueue(env, "order", settings.since); await enqueue(env, "tab", settings.since); }
  const due = (await env.DB.prepare(`SELECT a.source FROM wholesale_auto_invoices a
    WHERE a.state IN ('pending','issued','exporting','held') AND a.retry_at<=? AND a.lease_until<=?
      AND NOT (a.state='exporting' AND EXISTS(SELECT 1 FROM quickbooks_exports e JOIN quickbooks_settings s ON s.id=1
        WHERE e.invoice_id=a.invoice_id AND e.auto=1 AND e.environment=s.active_environment AND e.state IN ('queued','sending','uncertain')))
    ORDER BY a.retry_at,a.created_at LIMIT ?`).bind(Date.now(), Date.now(), env.QUICKBOOKS_QUEUE ? 3 : 1).all<{ source: string }>()).results;
  const req = machineRequest(env);
  for (const row of due) await wakeIntegration(env.QUICKBOOKS_QUEUE, { key: "auto:" + row.source }, () => processAutoInvoice(env, row.source, req));
}

async function overview(env: Env) {
  const [{ settings, version: v }, rows, waiting] = await Promise.all([
    autoSettings(env),
    env.DB.prepare(`SELECT a.*, i.invoice_number, e.id AS export_id, e.state AS export_state, e.last_error AS export_error, e.environment, e.email_state FROM wholesale_auto_invoices a
      LEFT JOIN wholesale_invoices i ON i.seq=a.invoice_id
      LEFT JOIN quickbooks_exports e ON e.id=(SELECT id FROM quickbooks_exports WHERE invoice_id=a.invoice_id ORDER BY auto DESC,id DESC LIMIT 1)
      ORDER BY CASE WHEN a.state='held' THEN 0 ELSE 1 END, a.updated_at DESC LIMIT 60`).all<AutoRow & { invoice_number: string | null; export_id: number | null; export_state: string | null; export_error: string | null; environment: string | null; email_state: string | null }>(),
    env.DB.prepare("SELECT state, COUNT(*) AS n FROM wholesale_auto_invoices WHERE state IN ('pending','issued','exporting','held') GROUP BY state").all<{ state: string; n: number }>(),
  ]);
  return {
    settings: { issue: settings.issue, quickbooks: settings.quickbooks, email: settings.email, since: settings.since || null, enabledByName: settings.enabledByName },
    version: v, counts: Object.fromEntries(waiting.results.map((r) => [r.state, r.n])),
    items: rows.results.map((r) => ({ source: r.source, kind: r.source.startsWith("tab:") ? "tab" : r.source.startsWith("batch:") ? "batch" : "order", orderId: r.source.startsWith("order:") ? r.source.slice(6) : null, business: r.business, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, state: r.state, reason: r.reason, retryAt: r.retry_at || null, updatedAt: r.updated_at, quickbooks: r.export_state ? { id: r.export_id, state: r.export_state, environment: r.environment, email: r.email_state || "", billingReview: r.export_state === "review" && isBillingIssue(r.export_error || "") } : null })),
  };
}

export async function handleAutoInvoiceAdmin(req: Request, env: Env, route: string, user: User, ctx?: ExecutionContext): Promise<Response | null> {
  if (route === "auto-invoicing" && req.method === "GET") return json(await overview(env));
  if (route === "auto-invoicing" && req.method === "PUT") {
    const body = object(await readJson(req, 2048)), expected = version(body.ifVersion);
    for (const key of ["issue", "quickbooks", "email"]) if (typeof body[key] !== "boolean") throw invalid("Choose each automatic invoicing switch.");
    if (body.email && !body.quickbooks) throw invalid("Emailing invoices from QuickBooks needs sending to QuickBooks switched on.");
    if (body.quickbooks && !body.issue) throw invalid("Sending invoices to QuickBooks automatically needs automatic invoices switched on.");
    const old = await autoSettings(env);
    if (old.version !== expected) throw new ApiError(409, "conflict", "Automatic invoicing changed on another device. Reload and try again.");
    const at = Date.now();
    const value: AutoSettings = {
      issue: body.issue, quickbooks: body.quickbooks, email: body.email,
      // Only orders dispatched after issuing is switched on are invoiced; switching it off and on starts again from then.
      since: body.issue ? (old.settings.issue ? old.settings.since : at) : 0,
      // QuickBooks exports go in the name of the admin who switched sending on (they must stay an admin).
      enabledBy: body.quickbooks ? (old.settings.quickbooks && old.settings.enabledBy ? old.settings.enabledBy : user.id) : "",
      enabledByName: body.quickbooks ? (old.settings.quickbooks && old.settings.enabledBy ? old.settings.enabledByName : user.name) : "",
    };
    const saved = expected === 0
      ? await env.DB.prepare("INSERT INTO wholesale_auto_invoicing(id,data,version,updated_at) SELECT 1,?,1,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_auto_invoicing WHERE id=1)").bind(JSON.stringify(value), at).run()
      : await env.DB.prepare("UPDATE wholesale_auto_invoicing SET data=?,version=version+1,updated_at=? WHERE id=1 AND version=?").bind(JSON.stringify(value), at, expected).run();
    if (!saved.meta.changes) throw new ApiError(409, "conflict", "Automatic invoicing changed on another device. Reload and try again.");
    const said = (on: boolean) => on ? "on" : "off";
    await audit(env, "wholesale_auto_invoicing", user.name, `${user.name} set automatic invoicing: invoices ${said(value.issue)}, send to QuickBooks ${said(value.quickbooks)}, QuickBooks emails ${said(value.email)}.`);
    return json(await overview(env));
  }
  const item = /^auto-invoicing\/((?:order|tab):[A-Za-z0-9-]{1,80}|batch:\d{1,15})\/(retry|skip)$/.exec(route);
  if (item && req.method === "POST") {
    await readJson(req, 1024);
    const [, source, action] = item;
    // Try again also restarts this invoice's QuickBooks send when it stopped for review before anything was written there (25 Nov 2026):
    // usually a number already taken by an invoice typed into QuickBooks. Every check runs again before anything is sent, and the
    // invoice is still emailed automatically, as nothing went out before.
    if (action === "retry") {
      const restarted = await env.DB.prepare(`UPDATE quickbooks_exports SET state='queued',retry_at=0,attempts=0,last_error='',lease_owner=NULL,lease_until=0,updated_at=?,version=version+1
        WHERE auto=1 AND manual_retry=0 AND state='review' AND created_remote=0 AND write_started_at=0 AND lease_until<=?
          AND invoice_id=(SELECT invoice_id FROM wholesale_auto_invoices WHERE source=? AND state='held')`).bind(Date.now(), Date.now(), source).run();
      if (restarted.meta.changes) await audit(env, "wholesale_auto_invoicing", user.name, `${user.name} tried ${source} again in QuickBooks.`);
    }
    const result = action === "retry"
      ? await env.DB.prepare("UPDATE wholesale_auto_invoices SET retry_at=0,attempts=0,updated_at=? WHERE source=? AND state IN ('pending','issued','exporting','held') AND lease_until<=?").bind(Date.now(), source, Date.now()).run()
      : await env.DB.prepare(`UPDATE wholesale_auto_invoices SET state='skipped',reason=?,retry_at=0,updated_at=?
        WHERE source=? AND state IN ('pending','issued','exporting','held') AND lease_until<=?
          AND NOT EXISTS(SELECT 1 FROM quickbooks_exports WHERE invoice_id=wholesale_auto_invoices.invoice_id
            AND auto=1 AND manual_retry=0 AND state='sending' AND lease_until>?)`)
        .bind(`Left to do by hand (${user.name}).`, Date.now(), source, Date.now(), Date.now()).run();
    if (!result.meta.changes) throw new ApiError(409, "conflict", "This changed or is being worked on. Reload and try again.");
    if (action === "skip") await audit(env, "wholesale_auto_invoicing", user.name, `${user.name} left ${source} to invoice by hand.`);
    else {
      const work = processAutoInvoice(env, source, req).catch((error) => console.error("Automatic invoicing failed", error));
      if (ctx) ctx.waitUntil(work); else await work;
    }
    return json(await overview(env));
  }
  return null;
}
