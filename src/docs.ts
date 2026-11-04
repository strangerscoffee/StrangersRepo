// The db API behind claude-shim.js (docs/runtime-api.md).
import { ApiError, Env, SQL_NOW_MS, invalid, readJson, json } from "./http";
import { parseCollectionPath, parseWebDocPath, encodeDoc, deepMerge, canonical } from "./paths";
import { User } from "./auth";
import { isStaffRecordPath, recordId, requireDelete, requireOwnSignature, requireOwnStaffRecord, requireStaffDayRules, requireWrite } from "./access";

const BUMP_SEQ = "UPDATE meta SET v = v + 1 WHERE k = 'seq'";
const CUR_SEQ = "(SELECT v FROM meta WHERE k = 'seq')";

interface Row {
  data: string | null;
  deleted: number;
  seq: number;
}

export async function getDoc(env: Env, path: string) {
  const row = await env.DB.prepare("SELECT data, deleted, seq FROM docs WHERE path = ?").bind(path).first<Row>();
  const live = row && !row.deleted && row.data != null;
  return { exists: !!live, data: live ? JSON.parse(row!.data!) : undefined, ver: row ? row.seq : 0 };
}

export async function setDoc(env: Env, path: string, data: unknown, by: string) {
  const p = parseWebDocPath(path, "write");
  const text = encodeDoc(data);
  await env.DB.batch([
    env.DB.prepare(BUMP_SEQ),
    env.DB.prepare(
      `INSERT INTO docs (path, collection, doc_id, data, updated_at, source, deleted, seq, updated_by)
       VALUES (?, ?, ?, ?, ${SQL_NOW_MS}, 'web', 0, ${CUR_SEQ}, ?)
       ON CONFLICT (path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, source = 'web',
         deleted = 0, seq = excluded.seq, updated_by = excluded.updated_by`,
    ).bind(p.path, p.collection, p.id, text, by),
  ]);
}

/** set() for day and week pages: creates the page, or, when it already exists (another device made it first, or
 * someone sends a whole page), merges into it like update(), so nobody's checks are overwritten. */
export async function setOrMergeDoc(env: Env, path: string, data: unknown, by: string) {
  const p = parseWebDocPath(path, "write");
  const text = encodeDoc(data);
  const [, res] = await env.DB.batch([
    env.DB.prepare(BUMP_SEQ),
    env.DB.prepare(
      `INSERT INTO docs (path, collection, doc_id, data, updated_at, source, deleted, seq, updated_by)
       VALUES (?, ?, ?, ?, ${SQL_NOW_MS}, 'web', 0, ${CUR_SEQ}, ?)
       ON CONFLICT (path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, source = 'web',
         deleted = 0, seq = excluded.seq, updated_by = excluded.updated_by
       WHERE docs.deleted = 1 OR docs.data IS NULL`,
    ).bind(p.path, p.collection, p.id, text, by),
  ]);
  if (!res.meta.changes) await updateDoc(env, p.path, data, by);
}

/** Deep-merges `patch` into an existing doc. Read-merge-write guarded by seq, retried on a concurrent change,
 * so two people ticking boxes on the same day at once both keep their ticks. */
export async function updateDoc(env: Env, path: string, patch: unknown, by: string) {
  const p = parseWebDocPath(path, "write");
  encodeDoc(patch);
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
    const row = await env.DB.prepare("SELECT data, deleted, seq FROM docs WHERE path = ?").bind(p.path).first<Row>();
    if (!row || row.deleted || row.data == null) throw new ApiError(404, "not_found", `No document at ${p.path}`);
    const text = encodeDoc(deepMerge(JSON.parse(row.data), patch as Record<string, unknown>));
    const [, res] = await env.DB.batch([
      env.DB.prepare(BUMP_SEQ),
      env.DB.prepare(
        `UPDATE docs SET data = ?, updated_at = ${SQL_NOW_MS}, source = 'web', seq = ${CUR_SEQ}, updated_by = ?
         WHERE path = ? AND seq = ? AND deleted = 0`,
      ).bind(text, by, p.path, row.seq),
    ]);
    if (res.meta.changes > 0) return;
  }
  throw new ApiError(409, "aborted", "The document is being changed by someone else. Try again.");
}

export async function deleteDoc(env: Env, path: string, by: string) {
  const p = parseWebDocPath(path, "write");
  await env.DB.batch([
    env.DB.prepare(BUMP_SEQ),
    env.DB.prepare(
      `UPDATE docs SET data = NULL, deleted = 1, updated_at = ${SQL_NOW_MS}, source = 'web', seq = ${CUR_SEQ}, updated_by = ?
       WHERE path = ? AND deleted = 0`,
    ).bind(by, p.path),
  ]);
}

interface QuerySpec {
  path: string;
  orderBy?: string;
  dir?: "asc" | "desc";
  limit?: number;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_LIMIT = 2000;

function checkQuery(q: QuerySpec): QuerySpec {
  const path = parseCollectionPath(q.path);
  if (q.orderBy != null && (typeof q.orderBy !== "string" || !FIELD_RE.test(q.orderBy))) throw invalid("Bad orderBy field.");
  if (q.limit != null && (!Number.isInteger(q.limit) || q.limit < 0)) throw invalid("Bad limit.");
  return { path, orderBy: q.orderBy ?? undefined, dir: q.dir === "desc" ? "desc" : "asc", limit: q.limit ?? undefined };
}

// Ordering matches SQLite's: missing/null first, then numbers, then strings.
function rank(v: unknown): [number, number | string] {
  if (v == null) return [0, 0];
  if (typeof v === "boolean") return [1, v ? 1 : 0];
  if (typeof v === "number") return [1, v];
  if (typeof v === "string") return [2, v];
  return [3, JSON.stringify(v)];
}

function compare(a: unknown, b: unknown): number {
  const [ra, va] = rank(a), [rb, vb] = rank(b);
  if (ra !== rb) return ra - rb;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

type Doc = { id: string; data: Record<string, unknown> };

/** Applies orderBy/limit to a collection's live docs. */
function runQuery(docs: Doc[], q: QuerySpec): Doc[] {
  let out = docs;
  if (q.orderBy) {
    const f = q.orderBy, sign = q.dir === "desc" ? -1 : 1;
    out = [...docs].sort((a, b) => sign * (compare(a.data[f], b.data[f]) || compare(a.id, b.id)));
  }
  return out.slice(0, Math.min(q.limit ?? MAX_LIMIT, MAX_LIMIT));
}

async function liveDocs(env: Env, collection: string): Promise<Doc[]> {
  const { results } = await env.DB.prepare("SELECT doc_id, data FROM docs WHERE collection = ? AND deleted = 0")
    .bind(collection).all<{ doc_id: string; data: string }>();
  return results.map((r) => ({ id: r.doc_id, data: JSON.parse(r.data) }));
}

export async function queryCollection(env: Env, q: QuerySpec) {
  const spec = checkQuery(q);
  return { docs: runQuery(await liveDocs(env, spec.path), spec) };
}

interface PollQuery extends QuerySpec {
  key: string;
  kind: "doc" | "col";
  ver?: number;
}

const MAX_POLL_QUERIES = 200;

/**
 * One request for all of the page's live subscriptions, in at most three D1 queries however many there are.
 * The client sends the global seq it last saw and each query's version (the highest seq among its rows,
 * tombstones included, so deletes count as changes); only results that changed are sent back.
 */
export async function poll(env: Env, body: { since?: number; queries?: PollQuery[] }) {
  const raw = Array.isArray(body.queries) ? body.queries : [];
  if (raw.length > MAX_POLL_QUERIES) throw invalid("Too many queries in one poll.");
  const seqRow = await env.DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first<{ v: number }>();
  const seq = seqRow?.v ?? 0;
  const results: Record<string, unknown> = {};
  if (!raw.length || (body.since === seq && raw.every((q) => typeof q.ver === "number"))) return { seq, results };

  const queries = raw.map((q) => ({
    key: String(q.key),
    kind: q.kind === "doc" ? ("doc" as const) : ("col" as const),
    ver: q.ver,
    spec: q.kind === "doc" ? null : checkQuery(q),
    path: q.kind === "doc" ? parseWebDocPath(q.path, "read").path : parseCollectionPath(q.path),
  }));

  // One statement; each subquery is a single lookup on the (collection, seq) index or the primary key.
  const verRows = await env.DB.prepare(
    `SELECT CAST(j.key AS INTEGER) AS i,
       CASE json_extract(j.value, '$.k')
         WHEN 'doc' THEN (SELECT COALESCE(MAX(seq), 0) FROM docs WHERE path = json_extract(j.value, '$.p'))
         ELSE (SELECT COALESCE(MAX(seq), 0) FROM docs WHERE collection = json_extract(j.value, '$.p'))
       END AS v
     FROM json_each(?) j`,
  ).bind(JSON.stringify(queries.map((q) => ({ k: q.kind, p: q.path })))).all<{ i: number; v: number }>();
  const vers = new Map(verRows.results.map((r) => [r.i, r.v]));
  const changed = queries.map((q, i) => ({ q, v: vers.get(i) ?? 0 })).filter(({ q, v }) => q.ver !== v);
  if (!changed.length) return { seq, results };

  const cols = [...new Set(changed.filter(({ q }) => q.kind === "col").map(({ q }) => q.path))];
  const paths = [...new Set(changed.filter(({ q }) => q.kind === "doc").map(({ q }) => q.path))];
  const { results: rows } = await env.DB.prepare(
    `SELECT path, collection, doc_id, data FROM docs WHERE deleted = 0
     AND (collection IN (SELECT value FROM json_each(?)) OR path IN (SELECT value FROM json_each(?)))`,
  ).bind(JSON.stringify(cols), JSON.stringify(paths)).all<{ path: string; collection: string; doc_id: string; data: string }>();

  const byCol = new Map<string, Doc[]>();
  const byPath = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const data = JSON.parse(r.data);
    if (paths.includes(r.path)) byPath.set(r.path, data);
    if (cols.includes(r.collection)) {
      if (!byCol.has(r.collection)) byCol.set(r.collection, []);
      byCol.get(r.collection)!.push({ id: r.doc_id, data });
    }
  }
  for (const { q, v } of changed) {
    results[q.key] =
      q.kind === "doc"
        ? { ver: v, exists: byPath.has(q.path), data: byPath.get(q.path) }
        : { ver: v, docs: runQuery(byCol.get(q.path) ?? [], q.spec!) };
  }
  return { seq, results };
}

/** Names for the "by" ids on records: web:<name> → name; u_… (people from the old Claude diary) → config/people. */
export async function profiles(env: Env, ids: unknown) {
  if (!Array.isArray(ids)) throw invalid("ids must be an array.");
  const out: Record<string, { name: string }> = {};
  let people: Record<string, unknown> | null = null;
  for (const id of ids.slice(0, 500)) {
    if (typeof id !== "string") continue;
    if (id.startsWith("web:")) {
      out[id] = { name: id.slice(4) };
      continue;
    }
    if (people == null) people = (await getDoc(env, "config/people")).data ?? {};
    const n = people![id];
    out[id] = { name: typeof n === "string" ? n : "" };
  }
  return out;
}

const MAX_BODY = 300 * 1024;

/** Routes /api/db/<op> for a signed-in person. Writes are checked against their role. */
/** Write check: the role rules in access.ts, plus staff writing their own Staff training record. */
async function requireWriteDoc(env: Env, user: User, op: "set" | "update" | "delete", path: unknown, data: any) {
  if (op === "delete") requireDelete(user, path);
  const cur = user.role === "staff" ? await getDoc(env, parseWebDocPath(path, "write").path) : null;
  if (cur && isStaffRecordPath(path)) requireOwnStaffRecord(user, op, cur.data?.name, cur.exists, data?.name);
  else requireWrite(user, path);
  if (cur && op !== "delete") {
    const p = parseWebDocPath(path, "write");
    requireOwnSignature(user, p.collection, data, cur.data, canonical);
    requireStaffDayRules(user, p.collection, p.id, data, cur.data, canonical);
  }
}

// Day and week pages are only ever added to: a set on one that already exists merges (setOrMergeDoc).
const isPagePath = (path: unknown) => typeof path === "string" && ["days", "weeks"].includes(path.split("/").slice(-2, -1)[0]);

export async function handleDb(req: Request, env: Env, op: string, user: User): Promise<Response> {
  if (req.method !== "POST") throw new ApiError(405, "invalid_argument", "Use POST.");
  const body = await readJson<any>(req, op === "poll" ? 64 * 1024 : MAX_BODY);
  switch (op) {
    case "get":
      return json(await getDoc(env, parseWebDocPath(body.path, "read").path));
    case "query":
      return json(await queryCollection(env, body));
    case "poll":
      return json(await poll(env, body));
    case "profiles":
      return json(await profiles(env, body.ids));
    case "set":
      await requireWriteDoc(env, user, "set", body.path, body.data);
      await (isPagePath(body.path) ? setOrMergeDoc : setDoc)(env, body.path, body.data, recordId(user));
      return json({ ok: true });
    case "update":
      await requireWriteDoc(env, user, "update", body.path, body.patch);
      await updateDoc(env, body.path, body.patch, recordId(user));
      return json({ ok: true });
    case "delete":
      await requireWriteDoc(env, user, "delete", body.path, undefined);
      await deleteDoc(env, body.path, recordId(user));
      return json({ ok: true });
  }
  throw new ApiError(404, "not_found", "Unknown API route.");
}

export const WRITE_OPS = new Set(["set", "update", "delete"]);
