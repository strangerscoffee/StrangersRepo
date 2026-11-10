// Shift requests (pickups and covers): names and details for the lists.
import { Env } from "../http";
import { User } from "../auth";
import { publishedWeeks } from "./load";
import { visibleShift } from "./privacy";
import { toShift } from "./shift";
import { ReqRow, ShiftRow } from "./types";
import { mondayOf, siteName } from "./util";

/* ---------- requests: names and details for the lists ---------- */

/** An employee can follow their own request without receiving somebody else's shift or identity. */
export async function visibleRequests(env: Env, rows: ReqRow[], viewer: User) {
  return describeRequests(env, rows, viewer);
}
export async function describeRequests(env: Env, rows: ReqRow[], viewer: User) {
  const admin = viewer.role === "admin";
  rows = rows.filter((r) => admin || r.from_user === viewer.id || r.to_user === viewer.id || r.taker === viewer.id);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.shift_id))];
  // D1 allows at most 100 bound values a query.
  const shifts = { results: [] as ShiftRow[] };
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    shifts.results.push(...(await env.DB.prepare(`SELECT * FROM rota_shifts WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<ShiftRow>()).results);
  }
  const names = await (admin
    ? env.DB.prepare("SELECT id, name FROM users")
    : env.DB.prepare("SELECT id, name FROM users WHERE id = ?").bind(viewer.id))
    .all<{ id: string; name: string }>();
  const visibleId = (id: string | null) => admin || id === viewer.id ? id : null;
  const nameOf = (id: string | null) => (id ? names.results.find((n) => n.id === id)?.name || "Someone" : null);
  const days = shifts.results.map((s) => s.day).sort();
  const published = !admin && days.length ? await publishedWeeks(env, days[0], days[days.length - 1]) : null;
  return rows.map((r) => {
    const s = shifts.results.find((x) => x.id === r.shift_id);
    // Request state remains the employee's own information after reassignment, deletion or unpublishing;
    // its current shift snapshot is separate and may no longer be visible to them.
    const shift = s && (admin || published?.has(mondayOf(s.day))) ? visibleShift(toShift(s), viewer) : null;
    return {
      id: r.id, kind: r.kind, status: r.status, message: admin || r.from_user === viewer.id ? r.message : "", createdAt: r.created_at, decidedAt: r.decided_at,
      fromUser: visibleId(r.from_user), fromName: nameOf(visibleId(r.from_user)), toUser: visibleId(r.to_user), toName: nameOf(visibleId(r.to_user)),
      taker: visibleId(r.taker), takerName: nameOf(visibleId(r.taker)), decidedByName: nameOf(visibleId(r.decided_by)),
      shift: shift ? { ...shift, siteName: siteName(shift.site) } : null,
    };
  });
}
