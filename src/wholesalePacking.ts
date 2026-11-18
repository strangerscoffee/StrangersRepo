import { type Env, invalid } from "./http";
import { londonToday } from "./rota/util";

export function dispatchFilter(query: URLSearchParams) {
  const scope = query.get("dispatch") || "all";
  if (scope === "all") return { sql: "", args: [] };
  if (scope !== "today" && scope !== "upcoming") throw invalid("Choose a listed dispatch date.");
  return { sql: " AND json_extract(data,'$.dispatchDate')" + (scope === "today" ? "=?" : ">?"), args: [londonToday()] };
}

// Keep the default cursor compatible. The desktop views opt into a dispatch date or bag-count key.
// "dispatched" (the owner's request, 18 Nov 2026): newest dispatched first, by when each was marked Dispatched
// (`dispatchedAt`), else when its shipped email went, else its last update (orders dispatched before it was recorded).
export const DISPATCHED_KEY = "COALESCE(CAST(json_extract(data,'$.dispatchedAt') AS INTEGER),CAST(json_extract(data,'$.dispatchEmailedAt') AS INTEGER),updated_at)";
export function orderSort(query: URLSearchParams, fallback = "updated") {
  const mode = query.get("sort") || fallback;
  if (!["updated", "dispatch", "dispatch-desc", "bags", "bags-asc", "dispatched"].includes(mode)) throw invalid("Choose a listed order sort.");
  const date = mode.startsWith("dispatch") && mode !== "dispatched";
  const ascending = mode === "dispatch" || mode === "bags-asc";
  const key = date
    ? `COALESCE(NULLIF(json_extract(data,'$.dispatchDate'),''),'${ascending ? "9999-12-31" : "0000-01-01"}')`
    : mode === "updated" ? "updated_at" : mode === "dispatched" ? DISPATCHED_KEY : "COALESCE(CAST(json_extract(data,'$.packs') AS INTEGER),0)";
  const direction = ascending ? "ASC" : "DESC";
  const cursor = query.get("cursor");
  const values: (string | number)[] = [];
  let after = "";
  if (cursor) {
    const pattern = date ? /^(\d{4}-\d{2}-\d{2}):([a-zA-Z0-9-]{1,80})$/ : /^(\d{1,16}):([a-zA-Z0-9-]{1,80})$/;
    const match = pattern.exec(cursor);
    if (!match || (!date && !Number.isSafeInteger(Number(match[1])))) throw invalid("Reload this list before loading more records.");
    const value = date ? match[1] : Number(match[1]);
    values.push(value, value, match[2]);
    after = ` AND (${key} ${ascending ? ">" : "<"} ? OR (${key} = ? AND id > ?))`;
  }
  return { key, direction, values, after };
}

type PackingTotal = {
  packed: number; productId: string; title: string; pack: string; packLabel: string; grind: string;
  grindLabel: string; grindHint: string; decaf: number; grams: number; quantity: number; recipe?: string;
};

export async function packingTotals(env: Env, query: URLSearchParams) {
  const scope = dispatchFilter(query);
  const rows = await env.DB.prepare(`WITH open_orders AS (
    SELECT data, json_extract(data,'$.status') AS status
    FROM wholesale_preview
    WHERE kind='order' AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL
      AND json_extract(data,'$.status') IN ('New','Preparing','Ready')${scope.sql}
  ), lines AS (
    SELECT line.value AS line, CASE
      WHEN status='Ready' OR EXISTS (
        SELECT 1 FROM json_each(open_orders.data,'$.packedLines') p WHERE p.type='integer' AND p.value=line.key
      ) THEN 1 ELSE 0 END AS packed
    FROM open_orders, json_each(open_orders.data,'$.lines') line
  )
  SELECT packed, json_extract(line,'$.productId') AS productId, json_extract(line,'$.title') AS title,
    json_extract(line,'$.pack') AS pack, json_extract(line,'$.packLabel') AS packLabel,
    json_extract(line,'$.grind') AS grind, json_extract(line,'$.grindLabel') AS grindLabel,
    json_extract(line,'$.grindHint') AS grindHint, json_extract(line,'$.decaf') AS decaf,
    json_extract(line,'$.recipe') AS recipe, json_extract(line,'$.grams') AS grams,
    SUM(json_extract(line,'$.quantity')) AS quantity
  FROM lines GROUP BY packed,productId,title,pack,packLabel,grind,grindLabel,grindHint,decaf,recipe,grams
  ORDER BY title COLLATE NOCASE,pack,grindLabel`).bind(...scope.args).all<PackingTotal>();
  return {
    remaining: rows.results.filter(row => !row.packed),
    packed: rows.results.filter(row => row.packed),
  };
}
