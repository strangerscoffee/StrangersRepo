// Shift requests (pickups and covers): names and details for the lists.
import { Env } from "../http";
import { publishedWeeks } from "./load";
import { toShift } from "./shift";
import { ReqRow, ShiftRow } from "./types";
import { mondayOf, siteName } from "./util";

/* ---------- requests: names and details for the lists ---------- */

/** Requests with their shifts; staff only see shifts from published weeks (a manager may have moved one). */
export async function visibleRequests(env: Env, rows: ReqRow[], mgr: boolean) {
  const out = (await describeRequests(env, rows)).filter((r) => r.shift);
  if (mgr || !out.length) return out;
  const days = out.map((r) => r.shift!.day).sort();
  const pub = await publishedWeeks(env, days[0], days[days.length - 1]);
  return out.filter((r) => pub.has(mondayOf(r.shift!.day)));
}
export async function describeRequests(env: Env, rows: ReqRow[]) {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.shift_id))];
  // D1 allows at most 100 bound values a query.
  const shifts = { results: [] as ShiftRow[] };
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    shifts.results.push(...(await env.DB.prepare(`SELECT * FROM rota_shifts WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<ShiftRow>()).results);
  }
  const names = await env.DB.prepare("SELECT id, name FROM users").all<{ id: string; name: string }>();
  const nameOf = (id: string | null) => (id ? names.results.find((n) => n.id === id)?.name || "Someone" : null);
  return rows.map((r) => {
    const s = shifts.results.find((x) => x.id === r.shift_id);
    return {
      id: r.id, kind: r.kind, status: r.status, message: r.message, createdAt: r.created_at, decidedAt: r.decided_at,
      fromUser: r.from_user, fromName: nameOf(r.from_user), toUser: r.to_user, toName: nameOf(r.to_user),
      taker: r.taker, takerName: nameOf(r.taker), decidedByName: nameOf(r.decided_by),
      shift: s ? { ...toShift(s), siteName: siteName(s.site) } : null,
    };
  });
}
