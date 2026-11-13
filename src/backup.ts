// Daily backups of the diary, kept in the KV namespace (FILES) next to the allergen PDFs.
// A scheduled run (wrangler.jsonc "triggers") makes one a day; admins can also make one from the Admin page
// and download any of them. Each backup is every diary document plus the list of accounts (names, usernames
// and roles; never password hashes), as gzipped JSON.
import { audit } from "./audit";
import { ApiError, Env, json } from "./http";

const PREFIX = "backup:";
const KEEP = 30;

export interface BackupInfo {
  id: string; // e.g. "2026-10-27T03-17-00Z"
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
  const docs = await env.DB.prepare("SELECT path, data, seq, employee_privacy_version, updated_at, updated_by FROM docs WHERE deleted = 0 ORDER BY path")
    .all<{ path: string; data: string; seq: number; employee_privacy_version: number | null; updated_at: number; updated_by: string | null }>();
  const users = await env.DB.prepare("SELECT id, name, username, role, active, created_at, last_login_at, email, email_prefs FROM users ORDER BY name_key").all();
  // The rota's tables (src/rota.ts). People are users.id, listed (without any password or PIN) under users.
  const rota: Record<string, unknown[]> = {};
  for (const t of ["rota_shifts", "rota_weeks", "rota_sites", "rota_people", "rota_time_off", "rota_requests", "rota_leave_state", "rota_leave_settings", "rota_leave_allowances", "rota_leave_days", "rota_leave_blocks", "rota_leave_events"]) {
    rota[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  }
  // quickbooks_app_settings is intentionally excluded: even encrypted app secrets are not JSON backup data.
  const body = JSON.stringify({
    kind: "strangers-kitchen-diary-backup",
    version: 1,
    at,
    by,
    documentSequence: (await env.DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first<{ v: number }>())?.v || 0,
    docs: docs.results.map((d) => ({ path: d.path, data: JSON.parse(d.data), seq: d.seq, employee_privacy_version: d.employee_privacy_version, updatedAt: d.updated_at, updatedBy: d.updated_by })),
    users: users.results,
    rota,
    wholesalePreview: (await env.DB.prepare("SELECT kind, id, data, version, updated_at FROM wholesale_preview ORDER BY kind, id").all()).results,
    wholesaleAccounts: await env.DB.prepare("SELECT id, customer_id, username, active, approval_status, created_at, last_login_at FROM wholesale_accounts ORDER BY username").all().then((rows) => rows.results),
    staffOrderAccess: (await env.DB.prepare("SELECT user_id,enabled,version,updated_at,updated_by FROM staff_order_access ORDER BY user_id").all()).results,
    quickbooks: {
      mode: "disconnected-on-restore",
      installation: (await env.DB.prepare("SELECT id,namespace FROM quickbooks_installation").all()).results,
      mappings: (await env.DB.prepare("SELECT environment,realm_id,data,version,updated_at FROM quickbooks_environment_mappings").all()).results,
      companies: (await env.DB.prepare("SELECT environment,realm_id,company_name,country,currency,vat_number FROM quickbooks_connections").all()).results,
      // Credentials, OAuth nonces, leases and Live approval are intentionally excluded.
      settings: { active_environment: "sandbox", live_approval: null },
      exports: (await env.DB.prepare("SELECT id,environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,CASE WHEN state='linked' THEN 'linked' ELSE 'review' END AS state,remote_id,sync_token,created_remote,sandbox_eligible,write_started_at,attempts,retry_at,last_error,version,created_at,updated_at FROM quickbooks_exports").all()).results,
      observations: (await env.DB.prepare("SELECT * FROM quickbooks_observations").all()).results,
      verifications: (await env.DB.prepare("SELECT * FROM quickbooks_verifications").all()).results,
      events: (await env.DB.prepare("SELECT event_key,environment,realm_id,entity,entity_id,operation,event_at,'queued' AS state,created_at FROM quickbooks_events").all()).results,
      reconciliation: (await env.DB.prepare("SELECT environment,realm_id,checkpoint,cursor,updated_at,last_full_at,last_error,retry_at FROM quickbooks_reconciliation").all()).results,
    },
    wholesaleInvoices: {
      settings: (await env.DB.prepare("SELECT * FROM wholesale_invoice_settings ORDER BY id").all()).results,
      sequence: (await env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'wholesale_invoices'").first<{ seq: number }>())?.seq || 0,
      invoices: (await env.DB.prepare("SELECT * FROM wholesale_invoices ORDER BY seq").all()).results,
    },
    wholesaleOrderEmails: (await env.DB.prepare("SELECT * FROM wholesale_order_emails").all()).results,
    wholesaleTabs: (await env.DB.prepare("SELECT * FROM wholesale_tabs ORDER BY cleared_at").all()).results,
    salesHistory: {
      settings: (await env.DB.prepare("SELECT * FROM insights_settings").all()).results,
      imports: (await env.DB.prepare("SELECT * FROM sales_history_imports").all()).results,
      products: (await env.DB.prepare("SELECT * FROM sales_history_products").all()).results,
      rows: (await env.DB.prepare("SELECT * FROM sales_history ORDER BY date, id").all()).results,
    },
  });
  const gz = await gzip(body);
  const id = new Date(at).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const info: BackupInfo = { id, at, by, docs: docs.results.length, bytes: gz.byteLength };
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
  if (/^[0-9TZ-]{20}$/.test(rest) && req.method === "GET") {
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
