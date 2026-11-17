// Admin search and keyset pages use the existing (kind, updated_at DESC, id) index.
import { type Env, invalid } from "./http";
import { londonToday } from "./rota/util";
import { decode, type Row, type Versioned } from "./wholesaleStore";
import { dispatchFilter, orderSort } from "./wholesalePacking";

type ListKind = "order" | "customer";
const PAGE_SIZE = 200;
const ORDER_STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];

function filters(kind: ListKind, query: URLSearchParams) {
  const where = ["kind = ?"];
  const values: (string | number)[] = [kind];
  if (kind === "order") {
    const scope = dispatchFilter(query);
    where.push("json_extract(data, '$.deletedAt') IS NULL" + scope.sql);
    values.push(...scope.args);
  }
  const queue = query.get("queue");
  if (queue) {
    if (kind !== "order" || !["prepare", "ready", "due-prepare", "due-ready"].includes(queue)) throw invalid("Choose a listed order queue.");
    where.push("json_extract(data, '$.preview') = 0");
    where.push(queue.endsWith("prepare") ? "json_extract(data, '$.status') IN ('New','Preparing')" : "json_extract(data, '$.status') = 'Ready'");
    if (queue.startsWith("due-")) {
      where.push("json_extract(data, '$.dispatchDate') = ?");
      values.push(londonToday());
    }
  }
  const q = (query.get("q") || "").trim();
  if (q.length > 120) throw invalid("Search can be up to 120 characters.");
  if (q) {
    const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    const fields = kind === "order" ? ["business", "reference", "createdName"] : ["business", "contact", "email", "phone"];
    where.push("(id LIKE ? ESCAPE '\\' OR " + fields.map((field) => `COALESCE(json_extract(data, '$.${field}'), '') LIKE ? ESCAPE '\\'`).join(" OR ") + ")");
    values.push(...Array(fields.length + 1).fill(pattern));
  }
  const status = query.get("status") || "all";
  if (status !== "all") {
    const choices = kind === "order" ? [...ORDER_STATUSES, "open"] : ["Active", "On hold"];
    if (!choices.includes(status)) throw invalid("Choose a listed status.");
    if (status === "open") where.push("json_extract(data, '$.preview') = 0", "json_extract(data, '$.status') IN ('New','Preparing','Ready')");
    else { where.push("json_extract(data, '$.status') = ?"); values.push(status); }
  }
  const approval = query.get("approval") || "all";
  if (approval !== "all") {
    if (kind !== "customer" || !["pending", "approved", "rejected"].includes(approval)) throw invalid("Choose a listed account approval state.");
    where.push("EXISTS (SELECT 1 FROM wholesale_accounts a WHERE a.customer_id = wholesale_preview.id AND a.approval_status = ?)");
    values.push(approval);
  }
  return { where: where.join(" AND "), values };
}

export async function adminWholesalePage<T>(env: Env, kind: ListKind, query = new URLSearchParams()): Promise<{ records: (T & Versioned)[]; nextCursor: string | null; count: number }> {
  const filter = filters(kind, query);
  const { key, direction, values, after } = orderSort(kind === "order" ? query : new URLSearchParams(query.has("cursor") ? { cursor: query.get("cursor")! } : {}));
  const [result, total] = await Promise.all([
    env.DB.prepare(`SELECT id, data, version, updated_at, ${key} AS sort_key FROM wholesale_preview WHERE ${filter.where}${after} ORDER BY sort_key ${direction}, id LIMIT ?`).bind(...filter.values, ...values, PAGE_SIZE + 1).all<Row & { sort_key: string | number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE ${filter.where}`).bind(...filter.values).first<{ n: number }>(),
  ]);
  const records = result.results.slice(0, PAGE_SIZE).map((row) => decode<T>(row));
  const last = result.results[PAGE_SIZE-1];
  return { records, nextCursor: result.results.length > PAGE_SIZE && last ? `${last.sort_key}:${last.id}` : null, count: total?.n || 0 };
}

export async function adminWholesaleStats(env: Env) {
  const [orders, pending, statuses] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN json_extract(data, '$.status') IN ('New', 'Preparing', 'Ready') THEN 1 ELSE 0 END), 0) AS openOrders, COALESCE(SUM(CASE WHEN json_extract(data, '$.status') IN ('New', 'Preparing') THEN 1 ELSE 0 END), 0) AS toPrepare, COALESCE(SUM(CASE WHEN json_extract(data, '$.status') = 'Ready' THEN 1 ELSE 0 END), 0) AS ready, COALESCE(SUM(CASE WHEN json_extract(data, '$.status') IN ('New', 'Preparing') THEN json_extract(data, '$.grams') ELSE 0 END), 0) AS gramsToPrepare FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.preview') = 0 AND json_extract(data, '$.deletedAt') IS NULL").first<{ openOrders: number; gramsToPrepare: number; toPrepare: number; ready: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_accounts WHERE approval_status = 'pending'").first<{ n: number }>(),
    env.DB.prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS n FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.deletedAt') IS NULL GROUP BY json_extract(data, '$.status')").all<{ status: string; n: number }>(),
  ]);
  return { statusCounts: Object.fromEntries(statuses.results.map(row => [row.status, row.n])), openOrders: orders?.openOrders || 0, toPrepare: orders?.toPrepare || 0, ready: orders?.ready || 0, gramsToPrepare: orders?.gramsToPrepare || 0, pendingAccounts: pending?.n || 0 };
}
