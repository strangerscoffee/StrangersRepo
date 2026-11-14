// Admin search and keyset pages use the existing (kind, updated_at DESC, id) index.
import { type Env, invalid } from "./http";
import { decode, type Row, type Versioned } from "./wholesaleStore";

type ListKind = "order" | "customer";
const PAGE_SIZE = 200;
const ORDER_STATUSES = ["New", "Preparing", "Ready", "Dispatched", "Cancelled"];

function filters(kind: ListKind, query: URLSearchParams) {
  const where = ["kind = ?"];
  const values: (string | number)[] = [kind];
  if (kind === "order") where.push("json_extract(data, '$.deletedAt') IS NULL");
  const queue = query.get("queue");
  if (queue) {
    if (kind !== "order" || !["prepare", "ready"].includes(queue)) throw invalid("Choose a listed order queue.");
    where.push("json_extract(data, '$.preview') = 0");
    where.push(queue === "prepare" ? "json_extract(data, '$.status') IN ('New','Preparing')" : "json_extract(data, '$.status') = 'Ready'");
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
    const choices = kind === "order" ? ORDER_STATUSES : ["Active", "On hold"];
    if (!choices.includes(status)) throw invalid("Choose a listed status.");
    where.push("json_extract(data, '$.status') = ?"); values.push(status);
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
  const cursor = query.get("cursor");
  let after = "";
  const values = [...filter.values];
  if (cursor) {
    const match = /^(\d{1,16}):([a-zA-Z0-9-]{1,80})$/.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw invalid("Reload this list before loading more records.");
    after = " AND (updated_at < ? OR (updated_at = ? AND id > ?))";
    values.push(Number(match[1]), Number(match[1]), match[2]);
  }
  const [result, total] = await Promise.all([
    env.DB.prepare(`SELECT id, data, version, updated_at FROM wholesale_preview WHERE ${filter.where}${after} ORDER BY updated_at DESC, id LIMIT ?`).bind(...values, PAGE_SIZE + 1).all<Row>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE ${filter.where}`).bind(...filter.values).first<{ n: number }>(),
  ]);
  const records = result.results.slice(0, PAGE_SIZE).map((row) => decode<T>(row));
  const last = records.at(-1);
  return { records, nextCursor: result.results.length > PAGE_SIZE && last ? `${last.updatedAt}:${last.id}` : null, count: total?.n || 0 };
}

export async function adminWholesaleStats(env: Env) {
  const [orders, pending, statuses] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN json_extract(data, '$.status') IN ('New', 'Preparing', 'Ready') THEN 1 ELSE 0 END), 0) AS openOrders, COALESCE(SUM(CASE WHEN json_extract(data, '$.status') IN ('New', 'Preparing') THEN json_extract(data, '$.grams') ELSE 0 END), 0) AS gramsToPrepare FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.preview') = 0 AND json_extract(data, '$.deletedAt') IS NULL").first<{ openOrders: number; gramsToPrepare: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_accounts WHERE approval_status = 'pending'").first<{ n: number }>(),
    env.DB.prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS n FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.deletedAt') IS NULL GROUP BY json_extract(data, '$.status')").all<{ status: string; n: number }>(),
  ]);
  return { statusCounts: Object.fromEntries(statuses.results.map(row => [row.status, row.n])), openOrders: orders?.openOrders || 0, gramsToPrepare: orders?.gramsToPrepare || 0, pendingAccounts: pending?.n || 0 };
}
