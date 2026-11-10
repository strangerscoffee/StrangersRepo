// Reading the rota (and what it needs from the diary) from D1, and the shared writes and lookups.
import { invalid, Env } from "../http";
import { toShift } from "./shift";
import { Ctx, Person, ROTA_SITES, Shift, ShiftRow, SiteInfo, TimeOff, WeekRow } from "./types";
import { addDays, cleanDayHours, mondayOf, notFound, nowMs, parseJson } from "./util";

/* ---------- loading what the checks need ---------- */

export async function loadSites(env: Env): Promise<Map<string, SiteInfo>> {
  const paths = ROTA_SITES.map((s) => s.prefix + "settings/main");
  const docs = await env.DB.prepare(`SELECT path, data FROM docs WHERE deleted = 0 AND path IN (${paths.map(() => "?").join(",")})`)
    .bind(...paths).all<{ path: string; data: string }>();
  const rows = await env.DB.prepare("SELECT site, opens_at, closes_at, min_people, day_hours FROM rota_sites")
    .all<{ site: string; opens_at: string | null; closes_at: string | null; min_people: number; day_hours: string | null }>();
  const out = new Map<string, SiteInfo>();
  for (const s of ROTA_SITES) {
    const doc = docs.results.find((d) => d.path === s.prefix + "settings/main");
    let data: any = null;
    try { data = doc ? JSON.parse(doc.data) : null; } catch { data = null; }
    const r = rows.results.find((x) => x.site === s.id);
    out.set(s.id, {
      id: s.id, name: s.name, inUse: !!data,
      closedDays: Array.isArray(data?.closedDays) ? data.closedDays.filter((n: unknown) => Number.isInteger(n)) : [],
      trainingOff: Array.isArray(data?.trainingOff) ? data.trainingOff : [],
      opensAt: r?.opens_at ?? null, closesAt: r?.closes_at ?? null, minPeople: r?.min_people ?? 1,
      dayHours: cleanDayHours(parseJson(r?.day_hours, {})),
    });
  }
  return out;
}

/** Days marked closed in the diary (Today → closed, or Setup → Closures & holidays), by site: {day: reason}. */
export async function loadClosures(env: Env, from: string, to: string): Promise<Map<string, Record<string, string>>> {
  const cols = ROTA_SITES.map((s) => s.prefix + "days");
  const r = await env.DB.prepare(
    `SELECT collection, doc_id, json_extract(data, '$.closed.reason') AS reason FROM docs
     WHERE deleted = 0 AND collection IN (${cols.map(() => "?").join(",")}) AND doc_id BETWEEN ? AND ?
       AND json_type(data, '$.closed') = 'object'`,
  ).bind(...cols, from, to).all<{ collection: string; doc_id: string; reason: string | null }>();
  const out = new Map<string, Record<string, string>>();
  for (const s of ROTA_SITES) out.set(s.id, {});
  for (const row of r.results) {
    const site = ROTA_SITES.find((s) => s.prefix + "days" === row.collection);
    if (site) out.get(site.id)![row.doc_id] = row.reason || "Closed";
  }
  return out;
}

/** Each person's colour: the nth account made gets the hue n golden angles round the wheel (starting at blue),
 *  so people next to each other in that order are far apart in colour, and a new person never changes anyone's. */
export const personHue = (seq: number) => Math.round(210 + seq * 137.508) % 360;

export async function loadPeople(env: Env): Promise<Map<string, Person>> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, p.contract_min, p.contract_max, p.sites, p.pattern,
       (SELECT COUNT(*) FROM users o WHERE o.created_at < u.created_at OR (o.created_at = u.created_at AND o.id < u.id)) AS seq
     FROM users u LEFT JOIN rota_people p ON p.user_id = u.id WHERE u.active = 1 ORDER BY u.name_key`,
  ).all<{ id: string; name: string; role: string; contract_min: number | null; contract_max: number | null; sites: string | null; pattern: string | null; seq: number }>();
  const out = new Map<string, Person>();
  for (const u of r.results) {
    out.set(u.id, {
      id: u.id, name: u.name, role: u.role, contractMin: u.contract_min ?? null, contractMax: u.contract_max ?? null, contractHours: u.contract_max ?? null,
      sites: parseJson(u.sites, []), pattern: parseJson(u.pattern, {}), hue: personHue(u.seq),
    });
  }
  return out;
}

export async function loadShifts(env: Env, from: string, to: string): Promise<Shift[]> {
  const r = await env.DB.prepare("SELECT * FROM rota_shifts WHERE day BETWEEN ? AND ? ORDER BY day, start, site").bind(from, to).all<ShiftRow>();
  return r.results.map(toShift);
}

export async function loadTimeOff(env: Env, from: string, to: string, status = "approved"): Promise<TimeOff[]> {
  const r = await env.DB.prepare(
    "SELECT id, user_id, from_day, to_day, reason, status FROM rota_time_off WHERE status = ? AND from_day <= ? AND to_day >= ? ORDER BY from_day",
  ).bind(status, to, from).all<{ id: string; user_id: string; from_day: string; to_day: string; reason: string; status: string }>();
  return r.results.map((t) => ({ id: t.id, userId: t.user_id, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status }));
}

export async function weekRow(env: Env, week: string): Promise<WeekRow | null> {
  return env.DB.prepare("SELECT * FROM rota_weeks WHERE week = ?").bind(week).first<WeekRow>();
}
export async function publishedWeeks(env: Env, from: string, to: string): Promise<Set<string>> {
  const r = await env.DB.prepare("SELECT week FROM rota_weeks WHERE published_at IS NOT NULL AND week BETWEEN ? AND ?")
    .bind(mondayOf(from), to).all<{ week: string }>();
  return new Set(r.results.map((w) => w.week));
}

export async function loadCtx(env: Env, week: string): Promise<Ctx> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const [sites, closures, people, shifts, timeOff] = await Promise.all([
    loadSites(env), loadClosures(env, days[0], days[6]), loadPeople(env),
    loadShifts(env, addDays(week, -1), addDays(week, 7)), loadTimeOff(env, days[0], days[6]),
  ]);
  return { week, days, sites, closures, people, shifts, timeOff };
}

export async function activeUser(env: Env, id: unknown): Promise<string> {
  if (typeof id !== "string" || !id) throw invalid("Choose a person from the list.");
  const u = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1").bind(id).first();
  if (!u) throw invalid("That person isn't an active account.");
  return id;
}

/** Marks a week changed; once published, each change counts towards "N changes since publishing". */
export function touchWeek(env: Env, week: string) {
  return env.DB.prepare(
    `INSERT INTO rota_weeks (week, changed_at, changes) VALUES (?, ?, 0)
     ON CONFLICT (week) DO UPDATE SET changed_at = excluded.changed_at,
       changes = rota_weeks.changes + CASE WHEN rota_weeks.published_at IS NULL THEN 0 ELSE 1 END`,
  ).bind(week, nowMs());
}

export async function getShift(env: Env, id: string): Promise<Shift> {
  const r = await env.DB.prepare("SELECT * FROM rota_shifts WHERE id = ?").bind(id).first<ShiftRow>();
  if (!r) throw notFound("That shift has gone. Refresh and try again.");
  return toShift(r);
}

export async function approvers(env: Env): Promise<string[]> {
  const r = await env.DB.prepare("SELECT name FROM users WHERE active = 1 AND role = 'admin' ORDER BY name_key").all<{ name: string }>();
  return r.results.map((x) => x.name);
}
