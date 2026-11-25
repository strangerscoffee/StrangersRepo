// Daily backups of the diary, kept in the KV namespace (FILES) next to the allergen PDFs.
// A scheduled run (wrangler.jsonc "triggers") makes one a day; admins can also make one from the Admin page
// and download any of them. Each backup is every diary document plus the list of accounts (names, usernames
// and roles; never password hashes), as gzipped JSON.
import { audit } from "./audit";
import { ApiError, Env, json } from "./http";

const PREFIX = "backup:";
const KEEP = 30;

export interface BackupInfo {
  id: string; // Timestamp and unique suffix. Older copies have only the timestamp.
  at: number;
  by: string;
  docs: number;
  bytes: number;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function makeBackup(env: Env, by: string): Promise<BackupInfo> {
  const at = Date.now();
  // D1 batches run in one transaction: every table and sequence belongs to the same snapshot.
  const reads = [
    { key: "docs", sql: "SELECT path, data, seq, employee_privacy_version, updated_at, updated_by FROM docs WHERE deleted = 0 ORDER BY path" },
    { key: "users", sql: "SELECT id, name, username, role, active, created_at, last_login_at, email, email_prefs, start_date, phone, home_address FROM users ORDER BY name_key" },
    { key: "documentSequence", sql: "SELECT v FROM meta WHERE k = 'seq'" },
    { key: "wholesalePreview", sql: "SELECT kind, id, data, version, updated_at FROM wholesale_preview ORDER BY kind, id" },
    { key: "wholesaleAccounts", sql: "SELECT id, customer_id, username, active, approval_status, created_at, last_login_at FROM wholesale_accounts ORDER BY username" },
    { key: "staffOrderAccess", sql: "SELECT user_id,enabled,version,updated_at,updated_by FROM staff_order_access ORDER BY user_id" },
    { key: "qb.installation", sql: "SELECT id,namespace FROM quickbooks_installation" },
    { key: "qb.mappings", sql: "SELECT environment,realm_id,data,version,updated_at FROM quickbooks_environment_mappings" },
    { key: "qb.companies", sql: "SELECT environment,realm_id,company_name,country,currency,vat_number FROM quickbooks_connections" },
    { key: "qb.exports", sql: "SELECT id,environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,CASE WHEN state='linked' THEN 'linked' ELSE 'review' END AS state,remote_id,sync_token,created_remote,sandbox_eligible,write_started_at,attempts,retry_at,last_error,version,created_at,updated_at,auto,manual_retry,email_to,CASE WHEN email_state='sending' THEN 'unknown' ELSE email_state END AS email_state,email_at FROM quickbooks_exports" },
    { key: "qb.observations", sql: "SELECT * FROM quickbooks_observations" },
    { key: "qb.paymentLinks", sql: "SELECT export_id,payment_id FROM quickbooks_payment_links" },
    { key: "qb.paymentVoids", sql: "SELECT environment,realm_id,payment_id,confirmed_at FROM quickbooks_payment_voids" },
    { key: "qb.verifications", sql: "SELECT * FROM quickbooks_verifications" },
    { key: "qb.events", sql: "SELECT event_key,environment,realm_id,entity,entity_id,operation,event_at,'queued' AS state,created_at FROM quickbooks_events" },
    { key: "qb.reconciliation", sql: "SELECT environment,realm_id,checkpoint,cursor,updated_at,last_full_at,last_error,retry_at FROM quickbooks_reconciliation" },
    { key: "invoice.settings", sql: "SELECT * FROM wholesale_invoice_settings ORDER BY id" },
    { key: "invoice.sequence", sql: "SELECT seq FROM sqlite_sequence WHERE name = 'wholesale_invoices'" },
    { key: "invoice.invoices", sql: "SELECT * FROM wholesale_invoices ORDER BY seq" },
    { key: "invoice.billingReviews", sql: "SELECT * FROM wholesale_invoice_billing_reviews ORDER BY id" },
    { key: "invoice.reminderHolds", sql: "SELECT * FROM wholesale_invoice_reminder_holds ORDER BY invoice_id" },
    { key: "invoice.reminders", sql: "SELECT id,review_key,invoice_id,recipient,amount_pence,due_date,actor,CASE WHEN status='sending' THEN 'unknown' ELSE status END AS status,created_at,updated_at FROM wholesale_invoice_reminders ORDER BY id" },
    { key: "invoice.accounts", sql: "SELECT * FROM wholesale_invoice_accounts ORDER BY customer_id" },
    { key: "invoice.batches", sql: "SELECT * FROM wholesale_invoice_batches WHERE state='approved' ORDER BY approved_at,id" },
    { key: "invoice.batchItems", sql: "SELECT j.id,j.batch_id,j.position,j.customer_id,j.business,j.recipient,j.data,CASE WHEN j.state='working' THEN 'waiting' ELSE j.state END AS state,j.reason,j.invoice_id FROM wholesale_invoice_batch_items j JOIN wholesale_invoice_batches b ON b.id=j.batch_id WHERE b.state='approved' ORDER BY j.id" },
    { key: "invoice.closes", sql: "SELECT * FROM wholesale_invoice_closes ORDER BY id" },
    { key: "invoice.auto.settings", sql: "SELECT * FROM wholesale_auto_invoicing" },
    { key: "invoice.auto.items", sql: "SELECT source,customer_id,business,invoice_id,state,reason,attempts,retry_at,created_at,updated_at FROM wholesale_auto_invoices ORDER BY created_at" },
    { key: "invoice.productNumbers", sql: "SELECT * FROM wholesale_product_numbers ORDER BY number" },
    { key: "qb.productItems", sql: "SELECT * FROM quickbooks_product_items" },
    { key: "orderEmails", sql: "SELECT * FROM wholesale_order_emails" },
    { key: "announcement", sql: "SELECT * FROM wholesale_announcement" },
    { key: "tabs", sql: "SELECT * FROM wholesale_tabs ORDER BY cleared_at" },
    { key: "history.settings", sql: "SELECT * FROM insights_settings" },
    { key: "history.imports", sql: "SELECT * FROM sales_history_imports" },
    { key: "history.products", sql: "SELECT * FROM sales_history_products" },
    { key: "history.rows", sql: "SELECT * FROM sales_history ORDER BY date, id" },
    { key: "email.messages", sql: "SELECT * FROM email_delivery_messages ORDER BY accepted_at,id" },
    { key: "email.events", sql: "SELECT id,provider_id,type,event_at,received_at,recipients,reason,ingest_id FROM email_delivery_events ORDER BY event_at,id" },
    { key: "email.suppressions", sql: "SELECT * FROM email_suppressions ORDER BY email" },
    { key: "dispatchOutbox", sql: "SELECT event_key,order_id,payload,CASE WHEN state IN ('sent','skipped') THEN state ELSE 'unknown' END AS state,attempts,created_at,next_attempt_at,attempted_at,first_attempt_at,NULL AS lease_until,NULL AS claim_token,CASE WHEN state IN ('sent','skipped') THEN uncertain ELSE 1 END AS uncertain,sent_at,last_error FROM wholesale_email_outbox ORDER BY created_at,event_key" },
    { key: "staffOutbox", sql: "SELECT event_key,batch_key,scope,user_id,kind,CASE WHEN state IN ('sent','skipped','failed') THEN state ELSE 'unknown' END AS state,attempts,created_at,sent_at,last_error FROM staff_email_outbox ORDER BY created_at,event_key" },
    { key: "weeklyEmailRun", sql: "SELECT v FROM meta WHERE k='weekly_sent'" },
    ...["rota_shifts", "rota_weeks", "rota_sites", "rota_people", "rota_time_off", "rota_requests", "rota_leave_state", "rota_leave_settings", "rota_leave_allowances", "rota_leave_days", "rota_leave_blocks", "rota_leave_events", "rota_sickness", "rota_leave_notices", "rota_contract_history", "rota_bradford_review"].map(t => ({ key: "rota:" + t, sql: `SELECT * FROM ${t}` })),
  ];
  const captured = await env.DB.batch(reads.map(read => env.DB.prepare(read.sql)));
  if (captured.length !== reads.length || captured.some(result => (result as { success?: boolean }).success === false)) throw new Error("The complete backup snapshot could not be read.");
  const snapshot = new Map(reads.map((read, i) => [read.key, captured[i].results || []]));
  const rows = (key: string): Record<string, any>[] => snapshot.get(key) as Record<string, any>[];
  const docs = rows("docs");
  const users = rows("users");
  // The rota's tables (src/rota.ts). People are users.id, listed (without any password or PIN) under users.
  const rota: Record<string, unknown[]> = {};
  for (const t of ["rota_shifts", "rota_weeks", "rota_sites", "rota_people", "rota_time_off", "rota_requests", "rota_leave_state", "rota_leave_settings", "rota_leave_allowances", "rota_leave_days", "rota_leave_blocks", "rota_leave_events", "rota_sickness", "rota_leave_notices", "rota_contract_history", "rota_bradford_review"]) {
    rota[t] = rows("rota:" + t);
  }
  // quickbooks_app_settings is intentionally excluded: even encrypted app secrets are not JSON backup data.
  const body = JSON.stringify({
    kind: "strangers-kitchen-diary-backup",
    version: 1,
    at,
    by,
    documentSequence: ((rows("documentSequence")[0] || null))?.v || 0,
    docs: docs.map((d) => ({ path: d.path, data: JSON.parse(d.data), seq: d.seq, employee_privacy_version: d.employee_privacy_version, updatedAt: d.updated_at, updatedBy: d.updated_by })),
    users,
    rota,
    wholesalePreview: rows("wholesalePreview"),
    wholesaleAccounts: rows("wholesaleAccounts"),
    staffOrderAccess: rows("staffOrderAccess"),
    quickbooks: {
      mode: "disconnected-on-restore",
      installation: rows("qb.installation"),
      mappings: rows("qb.mappings"),
      companies: rows("qb.companies"),
      // Credentials, OAuth nonces, leases and Live approval are intentionally excluded.
      settings: { active_environment: "sandbox", live_approval: null },
      exports: rows("qb.exports"),
      observations: rows("qb.observations"),
      paymentLinks: rows("qb.paymentLinks"),
      paymentVoids: rows("qb.paymentVoids"),
      verifications: rows("qb.verifications"),
      events: rows("qb.events"),
      reconciliation: rows("qb.reconciliation"),
      productItems: rows("qb.productItems"),
    },
    wholesaleInvoices: {
      settings: rows("invoice.settings"),
      sequence: ((rows("invoice.sequence")[0] || null))?.seq || 0,
      invoices: rows("invoice.invoices"),
      billingReviews: rows("invoice.billingReviews"),
      reminderHolds: rows("invoice.reminderHolds"),
      reminders: rows("invoice.reminders"),
      billingAccounts: rows("invoice.accounts"),
      batches: rows("invoice.batches"),
      batchItems: rows("invoice.batchItems"),
      reconciliationSnapshots: rows("invoice.closes"),
      automatic: { settings: rows("invoice.auto.settings"), items: rows("invoice.auto.items") },
      productNumbers: rows("invoice.productNumbers"),
    },
    wholesaleOrderEmails: rows("orderEmails"),
    wholesaleAnnouncement: rows("announcement"),
    wholesaleTabs: rows("tabs"),
    wholesaleEmailOutbox: rows("dispatchOutbox"),
    emailDelivery: { messages: rows("email.messages"), events: rows("email.events"), suppressions: rows("email.suppressions"),
      staffJobs: rows("staffOutbox"), weeklyRun: rows("weeklyEmailRun")[0]?.v ?? null },
    notificationRestorePolicy: "Review unsent dispatch and staff email records after restore. Staff job history excludes email content and active leases.",
    salesHistory: {
      settings: rows("history.settings"),
      imports: rows("history.imports"),
      products: rows("history.products"),
      rows: rows("history.rows"),
    },
  });
  const gz = await gzip(body);
  const id = new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-") + "-" + crypto.randomUUID();
  const info: BackupInfo = { id, at, by, docs: docs.length, bytes: gz.byteLength };
  await env.FILES.put(PREFIX + id, gz, { metadata: info });
  await prune(env);
  return info;
}

export async function listBackups(env: Env): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list<BackupInfo>({ prefix: PREFIX, cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.at - a.at);
}

async function prune(env: Env): Promise<void> {
  const all = await listBackups(env);
  await Promise.all(all.slice(KEEP).map((b) => env.FILES.delete(PREFIX + b.id)));
}

/** Admin routes: GET backups, POST backups (make one now), GET backups/<id> (download as JSON). */
export async function handleBackups(req: Request, env: Env, rest: string, by: string): Promise<Response> {
  if (!rest && req.method === "GET") return json({ backups: await listBackups(env), keep: KEEP });
  if (!rest && req.method === "POST") {
    const backup = await makeBackup(env, by);
    await audit(env, "backup", by, `${by} made a backup`);
    return json({ backup });
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?$/.test(rest) && req.method === "GET") {
    const gz = await env.FILES.get(PREFIX + rest, "stream");
    if (!gz) throw new ApiError(404, "not_found", "No such backup.");
    return new Response(gz.pipeThrough(new DecompressionStream("gzip")), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="kitchen-diary-backup-${rest}.json"`,
        "cache-control": "private, no-store",
      },
    });
  }
  throw new ApiError(404, "not_found", "Unknown backup route.");
}
