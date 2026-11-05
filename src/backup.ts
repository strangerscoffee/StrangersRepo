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
  const docs = await env.DB.prepare("SELECT path, data, updated_at, updated_by FROM docs WHERE deleted = 0 ORDER BY path")
    .all<{ path: string; data: string; updated_at: number; updated_by: string | null }>();
  const users = await env.DB.prepare("SELECT id, name, username, role, active, created_at, last_login_at, email, email_prefs FROM users ORDER BY name_key").all();
  // The rota's tables (src/rota.ts). People are users.id, listed (without any password or PIN) under users.
  const rota: Record<string, unknown[]> = {};
  for (const t of ["rota_shifts", "rota_weeks", "rota_sites", "rota_people", "rota_time_off", "rota_requests"]) {
    rota[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  }
  const body = JSON.stringify({
    kind: "strangers-kitchen-diary-backup",
    version: 1,
    at,
    by,
    docs: docs.results.map((d) => ({ path: d.path, data: JSON.parse(d.data), updatedAt: d.updated_at, updatedBy: d.updated_by })),
    users: users.results,
    rota,
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
