// The staff rota: who works where and when, across the four sites. Served under /api/rota/ on both hostnames
// (the rota app at ROTA_HOST, and the diary's Today card). Its data lives in its own rota_* tables
// (src/schema.ts, docs/data-model.md); site opening days and planned closures come from the diary's own
// settings and day documents, and "trained to open and close" from the diary's staff training records.
import { isRotaManager, limitWrites } from "./access";
import { User, newId } from "./auth";
import { ApiError, Env, invalid, json, readJson } from "./http";

/* ---------- constants and small helpers ---------- */

export const ROTA_SITES = [
  { id: "roastery", name: "Roastery", prefix: "" },
  { id: "cafe", name: "Cafe", prefix: "sites/cafe/" },
  { id: "asg", name: "ASG", prefix: "sites/asg/" },
  { id: "factory", name: "Factory", prefix: "sites/factory/" },
] as const;
type SiteId = (typeof ROTA_SITES)[number]["id"];
const SITE_IDS = new Set<string>(ROTA_SITES.map((s) => s.id));
const siteName = (id: string) => ROTA_SITES.find((s) => s.id === id)?.name || id;
const JOBS = new Set(["", "opens", "closes"]);
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const REST_MINS = 11 * 60; // UK Working Time Regulations: 11 hours' daily rest
const BREAK_AFTER_MINS = 6 * 60; // a 20-minute rest break for shifts over 6 hours
const BREAK_MINS = 20;
const MAX_TEXT = 500;

const conflict = (message: string) => new ApiError(409, "conflict", message);
const denied = (message = "Only managers can do this.") => new ApiError(403, "permission_denied", message);
const notFound = (message: string) => new ApiError(404, "not_found", message);

/** Days are YYYY-MM-DD strings; date arithmetic is done in UTC so it never shifts with daylight saving. */
const dateOf = (s: string) => new Date(s + "T00:00:00Z");
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
export function isDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dateOf(s).getTime()) && isoOf(dateOf(s)) === s;
}
export const addDays = (s: string, n: number) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
/** 0 = Monday … 6 = Sunday. */
const dow = (s: string) => (dateOf(s).getUTCDay() + 6) % 7;
export const mondayOf = (s: string) => addDays(s, -dow(s));
const dayName = (s: string) => dateOf(s).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const shortDay = (s: string) => dateOf(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** Today in the UK, whatever the server's clock zone. */
export function londonToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** "7.5h", "8h". */
export const fmtH = (h: number) => `${round2(h)}h`;

function text(v: unknown, label: string, max = MAX_TEXT): string {
  if (v == null) return "";
  if (typeof v !== "string") throw invalid(`${label} must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > max) throw invalid(`${label} can be up to ${max} characters.`);
  return t;
}

/* ---------- types ---------- */

interface ShiftRow {
  id: string; site: string; day: string; start: string; end: string; break_mins: number; job: string;
  user_id: string | null; note: string; updated_at: number; updated_by: string;
  actual_start: string | null; actual_end: string | null; actual_break: number | null; adjust_note: string | null;
  adjusted_by: string | null; adjusted_at: number | null;
}
/** A shift as planned (start, end, breakMins) and, once amended on the day, as worked (actual*). `hours` are the
 *  paid hours that count (as worked when amended); `plannedHours` as planned; `overtime` the part of `hours` over
 *  the person's maximum contracted hours that week (set by the week and My shifts views). */
export interface Shift {
  id: string; site: string; day: string; start: string; end: string; breakMins: number; job: string;
  userId: string | null; note: string; hours: number; plannedHours: number;
  adjusted: boolean; actualStart: string | null; actualEnd: string | null; actualBreakMins: number | null; adjustNote: string;
  adjustedBy: string | null; adjustedAt: number | null; overtime?: number;
  updatedAt?: number; // the shift's version: a change sent with ifUpdatedAt is refused if someone changed it since
}
type Pattern = Record<string, "any" | "off" | { from?: string; to?: string }>;
/** `contractHours` is kept for older pages: it's the maximum. */
export interface Person {
  id: string; name: string; role: string; contractMin: number | null; contractMax: number | null; contractHours: number | null;
  sites: string[]; pattern: Pattern;
}
type Hours = { opensAt: string | null; closesAt: string | null };
interface SiteInfo {
  id: string; name: string; inUse: boolean; closedDays: number[]; trainingOff: string[];
  opensAt: string | null; closesAt: string | null; minPeople: number;
  /** Days of the week with other opening hours than the usual ones, by mon…sun. */
  dayHours: Record<string, { opensAt: string; closesAt: string }>;
}
/** A site's opening hours on a day: that weekday's own hours if it has them, otherwise the usual ones. */
function hoursOn(site: SiteInfo, day: string): Hours {
  return site.dayHours[DAY_KEYS[dow(day)]] || { opensAt: site.opensAt, closesAt: site.closesAt };
}
interface TimeOff { id: string; userId: string; from: string; to: string; reason: string; status: string }
export interface Problem {
  kind: string; severity: "error" | "warn" | "info"; day?: string; site?: string; userId?: string; shiftIds: string[]; message: string;
}

const paidHours = (s: { start: string; end: string; breakMins: number }) => round2(Math.max(0, mins(s.end) - mins(s.start) - s.breakMins) / 60);
const toShift = (r: ShiftRow): Shift => {
  const adjusted = r.actual_start != null && r.actual_end != null;
  const s: Shift = {
    id: r.id, site: r.site, day: r.day, start: r.start, end: r.end, breakMins: r.break_mins, job: r.job, userId: r.user_id, note: r.note,
    hours: 0, plannedHours: 0, adjusted,
    actualStart: adjusted ? r.actual_start : null, actualEnd: adjusted ? r.actual_end : null,
    actualBreakMins: adjusted ? r.actual_break ?? r.break_mins : null, adjustNote: adjusted ? r.adjust_note || "" : "",
    adjustedBy: adjusted ? r.adjusted_by : null, adjustedAt: adjusted ? r.adjusted_at : null, updatedAt: r.updated_at,
  };
  s.plannedHours = paidHours(s);
  s.hours = adjusted ? paidHours({ start: s.actualStart!, end: s.actualEnd!, breakMins: s.actualBreakMins! }) : s.plannedHours;
  return s;
};
/** When someone is actually there: as amended on the day, otherwise as planned. */
const effStart = (s: Shift) => s.actualStart ?? s.start;
const effEnd = (s: Shift) => s.actualEnd ?? s.end;

/** Marks the hours over each person's maximum as overtime, shift by shift in time order, a week at a time. */
function markOvertime(shifts: Shift[], people: Map<string, Person>): Shift[] {
  const total = new Map<string, number>();
  for (const s of [...shifts].sort((a, b) => (a.day + effStart(a)).localeCompare(b.day + effStart(b)))) {
    s.overtime = 0;
    const max = s.userId ? people.get(s.userId)?.contractMax : null;
    if (!s.userId || max == null) continue;
    const key = s.userId + "|" + mondayOf(s.day);
    const before = total.get(key) || 0, after = round2(before + s.hours);
    total.set(key, after);
    s.overtime = round2(Math.max(0, Math.min(s.hours, after - max)));
  }
  return shifts;
}

/* ---------- loading what the checks need ---------- */

async function loadSites(env: Env): Promise<Map<string, SiteInfo>> {
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
async function loadClosures(env: Env, from: string, to: string): Promise<Map<string, Record<string, string>>> {
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

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { const v = s ? JSON.parse(s) : fallback; return v ?? fallback; } catch { return fallback; }
}
/** Stored day hours, keeping only well-formed days. */
function cleanDayHours(v: unknown): Record<string, { opensAt: string; closesAt: string }> {
  const out: Record<string, { opensAt: string; closesAt: string }> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of DAY_KEYS) {
    const d = (v as any)[k];
    if (d && isTime(d.opensAt) && isTime(d.closesAt) && mins(d.closesAt) > mins(d.opensAt)) out[k] = { opensAt: d.opensAt, closesAt: d.closesAt };
  }
  return out;
}

async function loadPeople(env: Env): Promise<Map<string, Person>> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, p.contract_min, p.contract_max, p.sites, p.pattern FROM users u
     LEFT JOIN rota_people p ON p.user_id = u.id WHERE u.active = 1 ORDER BY u.name_key`,
  ).all<{ id: string; name: string; role: string; contract_min: number | null; contract_max: number | null; sites: string | null; pattern: string | null }>();
  const out = new Map<string, Person>();
  for (const u of r.results) {
    out.set(u.id, {
      id: u.id, name: u.name, role: u.role, contractMin: u.contract_min ?? null, contractMax: u.contract_max ?? null, contractHours: u.contract_max ?? null,
      sites: parseJson(u.sites, []), pattern: parseJson(u.pattern, {}),
    });
  }
  return out;
}

async function loadShifts(env: Env, from: string, to: string): Promise<Shift[]> {
  const r = await env.DB.prepare("SELECT * FROM rota_shifts WHERE day BETWEEN ? AND ? ORDER BY day, start, site").bind(from, to).all<ShiftRow>();
  return r.results.map(toShift);
}

async function loadTimeOff(env: Env, from: string, to: string, status = "approved"): Promise<TimeOff[]> {
  const r = await env.DB.prepare(
    "SELECT id, user_id, from_day, to_day, reason, status FROM rota_time_off WHERE status = ? AND from_day <= ? AND to_day >= ? ORDER BY from_day",
  ).bind(status, to, from).all<{ id: string; user_id: string; from_day: string; to_day: string; reason: string; status: string }>();
  return r.results.map((t) => ({ id: t.id, userId: t.user_id, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status }));
}

interface WeekRow { week: string; published_at: number | null; published_by: string | null; changed_at: number | null; changes: number }
async function weekRow(env: Env, week: string): Promise<WeekRow | null> {
  return env.DB.prepare("SELECT * FROM rota_weeks WHERE week = ?").bind(week).first<WeekRow>();
}
async function publishedWeeks(env: Env, from: string, to: string): Promise<Set<string>> {
  const r = await env.DB.prepare("SELECT week FROM rota_weeks WHERE published_at IS NOT NULL AND week BETWEEN ? AND ?")
    .bind(mondayOf(from), to).all<{ week: string }>();
  return new Set(r.results.map((w) => w.week));
}

/** Everything the checks need for one week (plus the days either side, for rest between shifts). */
interface Ctx {
  week: string; days: string[]; sites: Map<string, SiteInfo>; closures: Map<string, Record<string, string>>;
  people: Map<string, Person>; shifts: Shift[]; timeOff: TimeOff[];
}
async function loadCtx(env: Env, week: string): Promise<Ctx> {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const [sites, closures, people, shifts, timeOff] = await Promise.all([
    loadSites(env), loadClosures(env, days[0], days[6]), loadPeople(env),
    loadShifts(env, addDays(week, -1), addDays(week, 7)), loadTimeOff(env, days[0], days[6]),
  ]);
  return { week, days, sites, closures, people, shifts, timeOff };
}

/** Whether a site is open on a day: in use (has a Setup), not a usual closed day, not a planned closure. */
function openState(ctx: Pick<Ctx, "sites" | "closures">, site: string, day: string): { open: boolean; reason?: string } {
  const s = ctx.sites.get(site)!;
  if (!s.inUse) return { open: false, reason: `${s.name} isn't set up in the diary yet` };
  if (s.closedDays.includes(dateOf(day).getUTCDay())) return { open: false, reason: `${s.name} is closed on ${dayName(day)}s` };
  const reason = ctx.closures.get(site)?.[day];
  if (reason) return { open: false, reason: `${s.name} is closed on ${shortDay(day)} (${reason})` };
  return { open: true };
}

/* ---------- checks ("problems") ---------- */

/** Short names in messages: first names, unless two people share one. */
function namer(people: Map<string, Person>) {
  const firsts = new Map<string, number>();
  for (const p of people.values()) { const f = p.name.split(" ")[0]; firsts.set(f, (firsts.get(f) || 0) + 1); }
  return (id: string | null | undefined) => {
    const p = id ? people.get(id) : null;
    if (!p) return "Someone";
    const f = p.name.split(" ")[0];
    return (firsts.get(f) || 0) > 1 ? p.name : f;
  };
}
const overlaps = (a: Shift, b: Shift) => a.day === b.day && mins(a.start) < mins(b.end) && mins(b.start) < mins(a.end);
const onTimeOff = (t: TimeOff[], uid: string, day: string) => t.find((x) => x.userId === uid && x.from <= day && x.to >= day);

function availabilityIssue(p: Person, s: Shift): string | null {
  const pat = p.pattern?.[DAY_KEYS[dow(s.day)]];
  if (pat === "off") return `can't usually work on ${dayName(s.day)}s`;
  if (pat && typeof pat === "object") {
    if ((pat.from && mins(s.start) < mins(pat.from)) || (pat.to && mins(s.end) > mins(pat.to))) {
      return `usually works ${dayName(s.day)}s ${pat.from || "any time"}–${pat.to || "late"}`;
    }
  }
  return null;
}
const siteIssue = (p: Person, s: Shift) => (p.sites?.length && !p.sites.includes(s.site) ? `doesn't usually work at ${siteName(s.site)}` : null);

/** The week's problems, in order of severity. `shifts` may include the days either side of the week. */
export function computeProblems(ctx: Ctx): Problem[] {
  const out: Problem[] = [];
  const nm = namer(ctx.people);
  const inWeek = ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]);
  const day = (d: string) => dayName(d);

  for (const s of inWeek) {
    if (!openState(ctx, s.site, s.day).open) {
      out.push({ kind: "closed", severity: "error", day: s.day, site: s.site, shiftIds: [s.id],
        message: `${openState(ctx, s.site, s.day).reason}, but has a shift ${s.start}–${s.end}` });
    }
    if (!s.userId) {
      out.push({ kind: "open_shift", severity: "error", day: s.day, site: s.site, shiftIds: [s.id],
        message: `Open shift at ${siteName(s.site)} on ${day(s.day)}, ${s.start}–${s.end}` });
      continue;
    }
    if (!ctx.people.has(s.userId)) {
      out.push({ kind: "inactive", severity: "error", day: s.day, site: s.site, userId: s.userId, shiftIds: [s.id],
        message: `A shift at ${siteName(s.site)} on ${day(s.day)}, ${s.start}–${s.end}, is with an account that's switched off` });
      continue;
    }
    const off = onTimeOff(ctx.timeOff, s.userId, s.day);
    if (off) {
      out.push({ kind: "time_off", severity: "error", day: s.day, site: s.site, userId: s.userId, shiftIds: [s.id],
        message: `${nm(s.userId)} has time off on ${day(s.day)} but is on at ${siteName(s.site)}` });
    }
    if (mins(s.end) - mins(s.start) > BREAK_AFTER_MINS && s.breakMins < BREAK_MINS) {
      out.push({ kind: "break", severity: "info", day: s.day, site: s.site, userId: s.userId, shiftIds: [s.id],
        message: `${nm(s.userId)}'s shift at ${siteName(s.site)} on ${day(s.day)} is over 6 hours with less than a 20-minute break` });
    }
    const p = ctx.people.get(s.userId);
    if (p) {
      const why = availabilityIssue(p, s) || siteIssue(p, s);
      if (why) out.push({ kind: "availability", severity: "info", day: s.day, site: s.site, userId: s.userId, shiftIds: [s.id],
        message: `${nm(s.userId)} ${why} (${siteName(s.site)}, ${day(s.day)} ${s.start}–${s.end})` });
    }
  }

  // Clashes: one person on two overlapping shifts on the same day.
  const byUser = new Map<string, Shift[]>();
  for (const s of ctx.shifts) if (s.userId) { if (!byUser.has(s.userId)) byUser.set(s.userId, []); byUser.get(s.userId)!.push(s); }
  for (const [uid, list] of byUser) {
    const mine = list.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      const a = mine[i], b = mine[j];
      if (!overlaps(a, b)) continue;
      out.push({ kind: "clash", severity: "error", day: a.day, site: a.site, userId: uid, shiftIds: [a.id, b.id],
        message: a.site === b.site
          ? `${nm(uid)} has two overlapping shifts at ${siteName(a.site)} on ${day(a.day)}`
          : `${nm(uid)} is at ${siteName(a.site)} and ${siteName(b.site)} on ${day(a.day)}` });
    }
    // Rest between the last shift of one day and the first of the next.
    const sorted = [...list].sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (a.day === b.day || addDays(a.day, 1) !== b.day) continue;
      if (b.day < ctx.days[0] || b.day > ctx.days[6]) continue; // counted in the week the second shift is in
      const lastToday = sorted.filter((x) => x.day === a.day).reduce((m, x) => Math.max(m, mins(effEnd(x))), 0);
      // The clocks go forward (an hour less) on the last Sunday of March and back on the last Sunday of October.
      const clockChange = dow(b.day) === 6 && addDays(b.day, 7).slice(5, 7) !== b.day.slice(5, 7) ? (b.day.slice(5, 7) === "03" ? -60 : b.day.slice(5, 7) === "10" ? 60 : 0) : 0;
      const gap = 24 * 60 - lastToday + mins(effStart(b)) + clockChange;
      if (gap < REST_MINS) {
        const ends = sorted.find((x) => x.day === a.day && mins(x.end) === lastToday)!;
        out.push({ kind: "rest", severity: "warn", day: b.day, site: b.site, userId: uid, shiftIds: [ends.id, b.id],
          message: `${nm(uid)} has ${fmtH(gap / 60)} between shifts (${shortDay(a.day)} ${hhmm(lastToday)} to ${shortDay(b.day)} ${b.start})` });
      }
    }
    // Hours against contract (overtime over the maximum), and all seven days.
    const p = ctx.people.get(uid);
    const hours = round2(mine.reduce((h, s) => h + s.hours, 0));
    if (p?.contractMax != null && hours > p.contractMax + 0.001) {
      out.push({ kind: "overtime", severity: "warn", userId: uid, shiftIds: mine.map((s) => s.id),
        message: `${nm(uid)} has ${fmtH(hours - p.contractMax)} overtime (${fmtH(hours)}, contract ${contractText(p)})` });
    }
    if (new Set(mine.map((s) => s.day)).size === 7) {
      out.push({ kind: "seven_days", severity: "info", userId: uid, shiftIds: mine.map((s) => s.id),
        message: `${nm(uid)} works all seven days this week` });
    }
  }

  // Short of contracted hours: anyone with a minimum, including people with no shifts this week.
  for (const p of ctx.people.values()) {
    if (p.contractMin == null || p.contractMin <= 0) continue;
    const mine = inWeek.filter((s) => s.userId === p.id);
    const hours = round2(mine.reduce((h, s) => h + s.hours, 0));
    if (hours < p.contractMin - 0.001) {
      out.push({ kind: "under_contract", severity: "info", userId: p.id, shiftIds: mine.map((s) => s.id),
        message: `${nm(p.id)} has ${fmtH(hours)}, ${fmtH(p.contractMin - hours)} short of their ${fmtH(p.contractMin)} minimum` });
    }
  }

  // Openers, closers and cover, per open site and day that has shifts (or cover settings).
  for (const site of ctx.sites.values()) {
    for (const d of ctx.days) {
      if (!openState(ctx, site.id, d).open) continue;
      const here = inWeek.filter((s) => s.site === site.id && s.day === d);
      if (here.length) {
        if (!here.some((s) => s.job === "opens")) out.push({ kind: "no_opener", severity: "warn", day: d, site: site.id, shiftIds: here.map((s) => s.id),
          message: `No one opens ${site.name} on ${day(d)}` });
        if (!here.some((s) => s.job === "closes")) out.push({ kind: "no_closer", severity: "warn", day: d, site: site.id, shiftIds: here.map((s) => s.id),
          message: `No one closes ${site.name} on ${day(d)}` });
      }
      const { opensAt, closesAt } = hoursOn(site, d);
      if (opensAt && closesAt && mins(closesAt) > mins(opensAt) && site.minPeople > 0) {
        // Who's actually there: a shift cut short on the day stops counting when they left.
        const staffed = here.filter((s) => s.userId);
        const short: [number, number][] = [];
        // Check between every change: opening, closing, and each start and finish in between, so a handover at
        // 12:30 isn't a gap.
        const o = mins(opensAt), c = mins(closesAt);
        const cuts = [...new Set([o, c, ...staffed.flatMap((s) => [mins(effStart(s)), mins(effEnd(s))]).filter((t) => t > o && t < c)])].sort((a, b) => a - b);
        for (let i = 0; i + 1 < cuts.length; i++) {
          const t = cuts[i], e = cuts[i + 1];
          const n = staffed.filter((s) => mins(effStart(s)) <= t && mins(effEnd(s)) >= e).length;
          if (n < site.minPeople) {
            const last = short[short.length - 1];
            if (last && last[1] === t) last[1] = e; else short.push([t, e]);
          }
        }
        for (const [a, b] of short) {
          out.push({ kind: "short_cover", severity: "warn", day: d, site: site.id, shiftIds: [],
            message: `${site.name} has fewer than ${site.minPeople} ${site.minPeople === 1 ? "person" : "people"} on ${day(d)} ${hhmm(a)}–${hhmm(b)}` });
        }
      }
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.day || "").localeCompare(b.day || ""));
}

/** What giving `shift` to `uid` would cause: their own problems that involve this shift, plus contract hours. */
function effectsFor(ctx: Ctx, shift: Shift, uid: string): { problems: Problem[]; hours: number } {
  const moved = { ...shift, userId: uid };
  const shifts = ctx.shifts.map((s) => (s.id === shift.id ? moved : s));
  if (!shifts.some((s) => s.id === shift.id)) shifts.push(moved);
  const all = computeProblems({ ...ctx, shifts });
  // Being short of their minimum isn't a reason not to give someone a shift.
  const problems = all.filter((p) => p.userId === uid && p.kind !== "under_contract" && (p.kind === "overtime" || p.shiftIds.includes(shift.id)));
  const hours = round2(shifts.filter((s) => s.userId === uid && s.day >= ctx.days[0] && s.day <= ctx.days[6]).reduce((h, s) => h + s.hours, 0));
  return { problems, hours };
}
const blocking = (ps: Problem[]) => ps.find((p) => p.kind === "clash" || p.kind === "time_off");

/* ---------- validation ---------- */

async function activeUser(env: Env, id: unknown): Promise<string> {
  if (typeof id !== "string" || !id) throw invalid("Choose a person from the list.");
  const u = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1").bind(id).first();
  if (!u) throw invalid("That person isn't an active account.");
  return id;
}

interface ShiftInput { site: string; day: string; start: string; end: string; breakMins: number; job: string; userId: string | null; note: string }
async function checkShift(env: Env, v: ShiftInput): Promise<ShiftInput> {
  if (!SITE_IDS.has(v.site)) throw invalid("Choose one of the four sites.");
  if (!isDay(v.day)) throw invalid("Choose a real date.");
  if (!isTime(v.start) || !isTime(v.end)) throw invalid("Times are HH:MM, for example 07:30.");
  if (mins(v.end) <= mins(v.start)) throw invalid("A shift has to end after it starts (overnight shifts aren't supported).");
  if (!Number.isInteger(v.breakMins) || v.breakMins < 0 || v.breakMins > 180) throw invalid("The unpaid break is 0 to 180 minutes.");
  if (v.breakMins >= mins(v.end) - mins(v.start)) throw invalid("The break has to be shorter than the shift.");
  if (!JOBS.has(v.job)) throw invalid("The job is opens, closes or nothing.");
  if (v.userId !== null) await activeUser(env, v.userId);
  v.note = text(v.note, "The note");
  const [sites, closures] = await Promise.all([loadSites(env), loadClosures(env, v.day, v.day)]);
  const st = openState({ sites, closures }, v.site, v.day);
  if (!st.open) throw invalid(`${st.reason}, so no shifts can go there.`);
  return v;
}

function checkPattern(v: unknown): Pattern {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("The weekly pattern isn't valid.");
  const out: Pattern = {};
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (!(DAY_KEYS as readonly string[]).includes(k)) throw invalid("The weekly pattern uses mon to sun.");
    if (d === "any" || d === "off") { out[k] = d; continue; }
    if (!d || typeof d !== "object") throw invalid("Each day is any, off, or a from/until time.");
    const { from, to } = d as { from?: unknown; to?: unknown };
    if ((from != null && from !== "" && !isTime(from)) || (to != null && to !== "" && !isTime(to))) throw invalid("Times are HH:MM, for example 07:30.");
    if (isTime(from) && isTime(to) && mins(to) <= mins(from)) throw invalid("Until has to be after from.");
    out[k] = { ...(isTime(from) ? { from } : {}), ...(isTime(to) ? { to } : {}) };
    if (!Object.keys(out[k] as object).length) out[k] = "any";
  }
  return out;
}
function checkSites(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !SITE_IDS.has(s))) throw invalid("Choose sites from the list.");
  return [...new Set(v as string[])];
}
function checkContract(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 80) throw invalid("Contract hours are 0 to 80 a week.");
  return round2(n);
}
/** "16–24h", "20h", "up to 24h", "at least 16h". */
function contractText(p: { contractMin: number | null; contractMax: number | null }): string {
  const { contractMin: a, contractMax: b } = p;
  if (a != null && b != null) return a === b ? fmtH(b) : `${round2(a)}–${fmtH(b)}`;
  if (b != null) return `up to ${fmtH(b)}`;
  if (a != null) return `at least ${fmtH(a)}`;
  return "none";
}

/* ---------- writes ---------- */

const nowMs = () => Date.now();
/** Marks a week changed; once published, each change counts towards "N changes since publishing". */
function touchWeek(env: Env, week: string) {
  return env.DB.prepare(
    `INSERT INTO rota_weeks (week, changed_at, changes) VALUES (?, ?, 0)
     ON CONFLICT (week) DO UPDATE SET changed_at = excluded.changed_at,
       changes = rota_weeks.changes + CASE WHEN rota_weeks.published_at IS NULL THEN 0 ELSE 1 END`,
  ).bind(week, nowMs());
}

async function getShift(env: Env, id: string): Promise<Shift> {
  const r = await env.DB.prepare("SELECT * FROM rota_shifts WHERE id = ?").bind(id).first<ShiftRow>();
  if (!r) throw notFound("That shift has gone. Refresh and try again.");
  return toShift(r);
}

async function weekView(env: Env, week: string, user: User) {
  const mgr = isRotaManager(user);
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const published = !!row?.published_at;
  const visible = mgr || published;
  const inWeek = markOvertime(ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]), ctx.people);
  return {
    week,
    days: ctx.days,
    published,
    publishedAt: row?.published_at ?? null,
    changesSincePublish: published ? row?.changes ?? 0 : 0,
    sites: [...ctx.sites.values()].map((s) => ({
      id: s.id, name: s.name, inUse: s.inUse, opensAt: s.opensAt, closesAt: s.closesAt, minPeople: s.minPeople, dayHours: s.dayHours,
      hours: ctx.days.map((d) => hoursOn(s, d)),
      open: ctx.days.map((d) => openState(ctx, s.id, d).open),
      closedWhy: ctx.days.map((d) => { const st = openState(ctx, s.id, d); return st.open ? null : ctx.closures.get(s.id)?.[d] || null; }),
    })),
    // Staff see names only: contracts and availability are for managers.
    people: [...ctx.people.values()].map((p) => (mgr ? p : { id: p.id, name: p.name, role: p.role })),
    // Staff see who's on, not other people's overtime or why their hours changed.
    shifts: !visible ? [] : mgr ? inWeek : inWeek.map((s) => (s.userId === user.id ? s : { ...s, overtime: 0, adjustNote: "" })),
    timeOff: mgr ? ctx.timeOff : [],
    problems: mgr ? computeProblems(ctx) : [],
  };
}

/** For the admin section (src/adminView.ts): a week's shifts (with overtime), its problems, sites and people. */
export async function rotaWeekSummary(env: Env, week: string) {
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const shifts = markOvertime(ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]), ctx.people);
  return { week, published: !!row?.published_at, shifts, problems: computeProblems(ctx), people: ctx.people, sites: [...ctx.sites.values()] };
}

async function weekProblems(env: Env, day: string) {
  const week = mondayOf(day);
  return { week, problems: computeProblems(await loadCtx(env, week)) };
}
/** After a shift write: the week, and its problems only when asked (?with=problems). The rota page redraws the whole
 * week afterwards, so working them out on every save would be wasted (five reads and the checks). */
const afterWrite = (env: Env, day: string, withProblems: boolean) =>
  withProblems ? weekProblems(env, day) : Promise.resolve({ week: mondayOf(day) } as { week: string; problems?: Problem[] });

/* ---------- requests: names and details for the lists ---------- */

interface ReqRow {
  id: string; kind: string; shift_id: string; from_user: string; to_user: string | null; taker: string | null; message: string;
  status: string; decided_by: string | null; decided_at: number | null; created_at: number;
}
/** Requests with their shifts; staff only see shifts from published weeks (a manager may have moved one). */
async function visibleRequests(env: Env, rows: ReqRow[], mgr: boolean) {
  const out = (await describeRequests(env, rows)).filter((r) => r.shift);
  if (mgr || !out.length) return out;
  const days = out.map((r) => r.shift!.day).sort();
  const pub = await publishedWeeks(env, days[0], days[days.length - 1]);
  return out.filter((r) => pub.has(mondayOf(r.shift!.day)));
}
async function describeRequests(env: Env, rows: ReqRow[]) {
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
async function approvers(env: Env): Promise<string[]> {
  const r = await env.DB.prepare("SELECT name FROM users WHERE active = 1 AND role IN ('manager', 'admin') ORDER BY name_key").all<{ name: string }>();
  return r.results.map((x) => x.name);
}

/* ---------- the router ---------- */

export async function handleRota(req: Request, env: Env, ctx: ExecutionContext, route: string, user: User, links: { rota: string; diary: string; admin?: string }): Promise<Response> {
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k);
  const m = req.method;
  const mgr = isRotaManager(user);
  const needMgr = () => { if (!mgr) throw denied(); };
  // Which days and sites people can work: admins only, for everyone including themselves.
  const admin = user.role === "admin";
  const needAdmin = () => { if (!admin) throw denied("Only an admin can change which days and sites people can work."); };
  if (m !== "GET" && m !== "HEAD") await limitWrites(req, env, ctx, user.id);
  const body = async () => {
    if (m === "GET") return {} as any;
    const b = await readJson<any>(req, 32 * 1024);
    if (b == null) return {} as any;
    if (typeof b !== "object" || Array.isArray(b)) throw invalid("Send a JSON object.");
    return b;
  };
  const seg = route.split("/");
  const withProblems = q("with") === "problems";

  // Where the rota and the diary live, for links between them.
  if (route === "links" && m === "GET") return json(links);

  if (route === "week" && m === "GET") {
    const start = q("start") || londonToday();
    if (!isDay(start)) throw invalid("Choose a real date.");
    return json(await weekView(env, mondayOf(start), user));
  }

  if (route === "shifts" && m === "POST") {
    needMgr();
    const b = await body();
    const v = await checkShift(env, {
      site: b.site, day: b.day, start: b.start, end: b.end, breakMins: b.breakMins ?? 0, job: b.job ?? "",
      userId: b.userId ?? null, note: b.note ?? "",
    });
    const id = newId(10);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rota_shifts (id, site, day, start, end, break_mins, job, user_id, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, v.site, v.day, v.start, v.end, v.breakMins, v.job, v.userId, v.note, nowMs(), user.id),
      touchWeek(env, mondayOf(v.day)),
    ]);
    return json({ shift: await getShift(env, id), ...(await afterWrite(env, v.day, withProblems)) });
  }

  // Amending a shift on the day: when someone actually started and finished (going home sick, staying late).
  // {start, end, breakMins?, note?}, or {clear: true} to put it back as planned. The plan itself is kept.
  if (seg[0] === "shifts" && seg[2] === "actual" && seg.length === 3 && m === "PUT") {
    needMgr();
    const cur = await getShift(env, seg[1]);
    if (!cur.userId) throw invalid("Give the shift to someone before amending their hours.");
    if (cur.day > londonToday()) throw invalid("Shifts can be amended from the day they're on.");
    const b = await body();
    if (b.clear === true) {
      await env.DB.prepare("UPDATE rota_shifts SET actual_start = NULL, actual_end = NULL, actual_break = NULL, adjust_note = '', adjusted_by = ?, adjusted_at = ? WHERE id = ?")
        .bind(user.id, nowMs(), cur.id).run();
    } else {
      if (!isTime(b.start) || !isTime(b.end)) throw invalid("Times are HH:MM, for example 07:30.");
      if (mins(b.end) < mins(b.start)) throw invalid("They can't finish before they start.");
      const brk = b.breakMins == null ? Math.min(cur.breakMins, mins(b.end) - mins(b.start)) : Number(b.breakMins);
      if (!Number.isInteger(brk) || brk < 0 || brk > 180) throw invalid("The unpaid break is 0 to 180 minutes.");
      if (brk > mins(b.end) - mins(b.start)) throw invalid("The break can't be longer than the time they were there.");
      const note = text(b.note, "The reason", 200);
      await env.DB.prepare("UPDATE rota_shifts SET actual_start = ?, actual_end = ?, actual_break = ?, adjust_note = ?, adjusted_by = ?, adjusted_at = ? WHERE id = ?")
        .bind(b.start, b.end, brk, note, user.id, nowMs(), cur.id).run();
    }
    return json({ shift: await getShift(env, cur.id), ...(await afterWrite(env, cur.day, withProblems)) });
  }

  if (seg[0] === "shifts" && seg.length === 2 && (m === "PATCH" || m === "DELETE")) {
    needMgr();
    const cur = await getShift(env, seg[1]);
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM rota_shifts WHERE id = ?").bind(cur.id),
        env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), cur.id),
        touchWeek(env, mondayOf(cur.day)),
      ]);
      return json({ ok: true, ...(await afterWrite(env, cur.day, withProblems)) });
    }
    const b = await body();
    // Several managers can plan at once: a change made from an older copy of the shift is refused, not applied.
    if (b.ifUpdatedAt != null && b.ifUpdatedAt !== cur.updatedAt) {
      throw new ApiError(409, "conflict", "Someone else changed this shift just now. Check how it is now and try again.", { shift: cur });
    }
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    const v = await checkShift(env, {
      site: has("site") ? b.site : cur.site, day: has("day") ? b.day : cur.day, start: has("start") ? b.start : cur.start,
      end: has("end") ? b.end : cur.end, breakMins: has("breakMins") ? b.breakMins : cur.breakMins, job: has("job") ? b.job : cur.job,
      userId: has("userId") ? b.userId : cur.userId, note: has("note") ? b.note : cur.note,
    });
    const stmts = [
      env.DB.prepare("UPDATE rota_shifts SET site = ?, day = ?, start = ?, end = ?, break_mins = ?, job = ?, user_id = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?")
        .bind(v.site, v.day, v.start, v.end, v.breakMins, v.job, v.userId, v.note, nowMs(), user.id, cur.id),
      touchWeek(env, mondayOf(cur.day)),
    ];
    if (mondayOf(v.day) !== mondayOf(cur.day)) stmts.push(touchWeek(env, mondayOf(v.day)));
    // A manager giving the shift to someone settles any pickups or covers still waiting on it.
    // Amended hours belong to the person who worked them.
    if (v.userId !== cur.userId && cur.adjusted) stmts.push(env.DB.prepare("UPDATE rota_shifts SET actual_start = NULL, actual_end = NULL, actual_break = NULL, adjust_note = '' WHERE id = ?").bind(cur.id));
    // So does changing when or where it is: a pickup or cover was agreed for the shift as it was.
    if (v.userId !== cur.userId || v.site !== cur.site || v.day !== cur.day || v.start !== cur.start || v.end !== cur.end) {
      stmts.push(env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), cur.id));
    }
    await env.DB.batch(stmts);
    const out = await afterWrite(env, v.day, withProblems);
    if (withProblems && out.week !== mondayOf(cur.day)) (out as any).fromWeek = await weekProblems(env, cur.day);
    return json({ shift: await getShift(env, cur.id), ...out });
  }

  if (route === "week/copy" && m === "POST") {
    needMgr();
    const b = await body();
    if (!isDay(b.from) || !isDay(b.to)) throw invalid("Choose real weeks.");
    const from = mondayOf(b.from), to = mondayOf(b.to);
    if (from === to) throw invalid("Choose a different week to copy into.");
    const today = londonToday();
    if (to < mondayOf(today)) throw invalid("Weeks that have gone by can't be copied over.");
    // Days that have already happened keep their shifts (and any amended hours); only today onwards is replaced.
    const existing = (await loadShifts(env, to, addDays(to, 6))).filter((s) => s.day >= today);
    if (existing.length && b.replace !== true) throw conflict(`That week already has ${existing.length} shift${existing.length === 1 ? "" : "s"}. Replace them?`);
    const source = await loadShifts(env, from, addDays(from, 6));
    const [sites, closures, people] = await Promise.all([loadSites(env), loadClosures(env, to, addDays(to, 6)), loadPeople(env)]);
    const shift = (dowOf: string) => addDays(to, dow(dowOf));
    const skipped: { site: string; day: string; start: string; end: string; reason: string }[] = [];
    const stmts: D1PreparedStatement[] = [];
    if (existing.length) {
      const lo = today > to ? today : to;
      stmts.push(env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE status IN ('open', 'accepted') AND shift_id IN (SELECT id FROM rota_shifts WHERE day BETWEEN ? AND ?)").bind(user.id, nowMs(), lo, addDays(to, 6)));
      stmts.push(env.DB.prepare("DELETE FROM rota_shifts WHERE day BETWEEN ? AND ?").bind(lo, addDays(to, 6)));
    }
    let copied = 0;
    for (const s of source) {
      const day = shift(s.day);
      if (day < today) continue; // already happened
      const st = openState({ sites, closures }, s.site, day);
      if (!st.open) { skipped.push({ site: s.site, day, start: s.start, end: s.end, reason: st.reason! }); continue; }
      const uid = s.userId && people.has(s.userId) ? s.userId : null; // someone switched off since: copied as open
      stmts.push(env.DB.prepare(
        "INSERT INTO rota_shifts (id, site, day, start, end, break_mins, job, user_id, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(newId(10), s.site, day, s.start, s.end, s.breakMins, s.job, uid, s.note, nowMs(), user.id));
      copied++;
    }
    stmts.push(touchWeek(env, to));
    await env.DB.batch(stmts);
    return json({ copied, skipped, replaced: existing.length, ...(await weekView(env, to, user)) });
  }

  if (route === "week/publish" && m === "POST") {
    needMgr();
    const b = await body();
    if (!isDay(b.week)) throw invalid("Choose a real week.");
    const week = mondayOf(b.week);
    await env.DB.prepare(
      `INSERT INTO rota_weeks (week, published_at, published_by, changed_at, changes) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (week) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by, changes = 0`,
    ).bind(week, nowMs(), user.id, nowMs()).run();
    return json(await weekView(env, week, user));
  }

  if (route === "mine" && m === "GET") {
    const from = q("from") || londonToday();
    if (!isDay(from)) throw invalid("Choose real dates.");
    const to = q("to") || addDays(from, 27);
    if (!isDay(to) || to < from) throw invalid("Choose real dates.");
    if (dateOf(to).getTime() - dateOf(from).getTime() > 92 * 864e5) throw invalid("Ask for up to three months at a time.");
    // Whole weeks, so overtime counts from the Monday.
    const [weeks, wide, people] = await Promise.all([publishedWeeks(env, from, to), loadShifts(env, mondayOf(from), addDays(mondayOf(to), 6)), loadPeople(env)]);
    markOvertime(wide.filter((s) => s.userId === user.id && weeks.has(mondayOf(s.day))), people);
    const all = wide.filter((s) => s.day >= from && s.day <= to);
    const live = all.filter((s) => weeks.has(mondayOf(s.day)));
    const me = people.get(user.id);
    const weekTotals = [...new Set(live.filter((s) => s.userId === user.id).map((s) => mondayOf(s.day)))].sort().map((w) => {
      const mine = wide.filter((s) => s.userId === user.id && mondayOf(s.day) === w);
      const hours = round2(mine.reduce((h, s) => h + s.hours, 0));
      return { week: w, hours, overtime: round2(mine.reduce((h, s) => h + (s.overtime || 0), 0)) };
    });
    const nameOf = (id: string | null) => (id ? people.get(id)?.name || "Someone" : null);
    return json({
      from, to, today: londonToday(),
      published: [...weeks].sort(),
      contractMin: me?.contractMin ?? null, contractMax: me?.contractMax ?? null, weeks: weekTotals,
      shifts: live.filter((s) => s.userId === user.id).map((s) => ({
        ...s, siteName: siteName(s.site),
        others: live.filter((o) => o.site === s.site && o.day === s.day && o.id !== s.id)
          .map((o) => ({ name: nameOf(o.userId) || "Open shift", start: o.start, end: o.end, job: o.job, open: !o.userId, actualStart: o.actualStart, actualEnd: o.actualEnd })),
      })),
    });
  }

  if (route === "today" && m === "GET") {
    const site = q("site") || "";
    if (!SITE_IDS.has(site)) throw invalid("Choose one of the four sites.");
    const day = q("day") && isDay(q("day")) ? q("day")! : londonToday();
    const row = await weekRow(env, mondayOf(day));
    if (!row?.published_at) return json({ site, day, published: false, shifts: [], rotaUrl: links.rota });
    const [shifts, people] = await Promise.all([loadShifts(env, day, day), loadPeople(env)]);
    return json({
      site, day, published: true, rotaUrl: links.rota,
      shifts: shifts.filter((s) => s.site === site).map((s) => ({
        name: s.userId ? people.get(s.userId)?.name || "Someone" : null, me: s.userId === user.id, open: !s.userId,
        start: s.start, end: s.end, job: s.job, actualStart: s.actualStart, actualEnd: s.actualEnd,
      })),
    });
  }

  if (route === "suggest" && m === "GET") {
    needMgr();
    const shift = await getShift(env, q("shift") || "");
    const week = mondayOf(shift.day);
    const ctxW = await loadCtx(env, week);
    const site = ctxW.sites.get(shift.site)!;
    // Trained on opening and closing checks: the diary's staff training record at this site, matched by name.
    let trained: Set<string> | null = null;
    if (shift.job && !site.trainingOff.includes("diary")) {
      const pre = ROTA_SITES.find((s) => s.id === shift.site)!.prefix;
      const r = await env.DB.prepare(
        `SELECT json_extract(data, '$.name') AS name FROM docs WHERE collection = ? AND deleted = 0 AND json_extract(data, '$.topics.diary.date') IS NOT NULL`,
      ).bind(pre + "staff").all<{ name: string | null }>();
      trained = new Set(r.results.map((x) => String(x.name || "").trim().toLowerCase().replace(/\s+/g, " ")));
    }
    const list = [...ctxW.people.values()].filter((p) => p.id !== shift.userId).map((p) => {
      const { problems, hours } = effectsFor(ctxW, shift, p.id);
      const flags = problems.map((x) => ({ kind: x.kind, severity: x.severity, message: x.message }));
      if (trained && !trained.has(p.name.trim().toLowerCase().replace(/\s+/g, " "))) {
        flags.push({ kind: "untrained", severity: "warn", message: `Not trained on ${site.name} opening and closing checks` });
      }
      const error = flags.find((f) => f.severity === "error");
      const tier = error ? 2 : flags.length ? 1 : 0;
      // Fairest first: whoever is furthest below their minimum (or maximum) gets offered it first.
      const ratio = p.contractMin ? hours / p.contractMin : p.contractMax ? hours / p.contractMax : hours / 40;
      const overtime = p.contractMax != null ? round2(Math.max(0, hours - p.contractMax)) : 0;
      return { userId: p.id, name: p.name, role: p.role, hoursIfGiven: hours, contractMin: p.contractMin, contractMax: p.contractMax,
        contractHours: p.contractMax, overtimeIfGiven: overtime, flags, selectable: !error, tier, ratio };
    });
    list.sort((a, b) => a.tier - b.tier || a.ratio - b.ratio || a.name.localeCompare(b.name));
    const best = list.find((c) => c.selectable)?.userId;
    return json({
      shift: { ...shift, siteName: site.name },
      candidates: list.map(({ tier, ratio, ...c }) => ({ ...c, best: c.userId === best })),
    });
  }

  if (route === "hours" && m === "GET") {
    needMgr();
    const start = q("start") || londonToday();
    if (!isDay(start)) throw invalid("Choose a real date.");
    const week = mondayOf(start);
    const [people, shifts, row] = await Promise.all([loadPeople(env), loadShifts(env, week, addDays(week, 6)), weekRow(env, week)]);
    const ids = new Set([...people.keys(), ...shifts.map((s) => s.userId).filter((x): x is string => !!x)]);
    const extra = await env.DB.prepare("SELECT id, name, role FROM users").all<{ id: string; name: string; role: string }>();
    const rows = [...ids].map((id) => {
      const p = people.get(id) || { ...(extra.results.find((u) => u.id === id) || { id, name: "Someone", role: "" }), contractMin: null, contractMax: null };
      const mine = shifts.filter((s) => s.userId === id);
      const bySite = Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(mine.filter((x) => x.site === s.id).reduce((h, x) => h + x.hours, 0))]));
      const rota = round2(mine.reduce((h, s) => h + s.hours, 0));
      const planned = round2(mine.reduce((h, s) => h + s.plannedHours, 0));
      return { userId: id, name: p.name, role: p.role, contractMin: p.contractMin, contractMax: p.contractMax, contractHours: p.contractMax,
        plannedHours: planned, rotaHours: rota, amended: mine.filter((s) => s.adjusted).length,
        overtime: p.contractMax == null ? 0 : round2(Math.max(0, rota - p.contractMax)),
        shortOfMin: p.contractMin == null ? 0 : round2(Math.max(0, p.contractMin - rota)),
        sites: bySite, shifts: mine.length };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const siteTotals = Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(shifts.filter((x) => x.site === s.id && x.userId).reduce((h, x) => h + x.hours, 0))]));
    const openHours = round2(shifts.filter((s) => !s.userId).reduce((h, s) => h + s.hours, 0));
    if (q("format") === "csv") {
      const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [["name", "role", "contract_min", "contract_max", "planned_hours", "rota_hours", "overtime", "short_of_min", ...ROTA_SITES.map((s) => s.id)].join(",")];
      for (const r of rows) lines.push([r.name, r.role, r.contractMin, r.contractMax, r.plannedHours, r.rotaHours, r.overtime, r.shortOfMin, ...ROTA_SITES.map((s) => r.sites[s.id])].map(cell).join(","));
      return new Response(lines.join("\r\n") + "\r\n", {
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="rota-hours-${week}.csv"` },
      });
    }
    return json({ week, published: !!row?.published_at, people: rows, siteTotals, openHours, total: round2(rows.reduce((h, r) => h + r.rotaHours, 0)),
      overtime: round2(rows.reduce((h, r) => h + r.overtime, 0)) });
  }

  if (route === "me" && m === "GET") {
    const [p, offs, reqs, appr] = await Promise.all([
      env.DB.prepare("SELECT * FROM rota_people WHERE user_id = ?").bind(user.id).first<{ contract_min: number | null; contract_max: number | null; sites: string; pattern: string }>(),
      env.DB.prepare("SELECT id, user_id, from_day, to_day, reason, status, decided_at FROM rota_time_off WHERE user_id = ? AND to_day >= ? ORDER BY from_day")
        .bind(user.id, addDays(londonToday(), -30)).all<any>(),
      env.DB.prepare("SELECT * FROM rota_requests WHERE (from_user = ? OR to_user = ? OR taker = ? OR (to_user IS NULL AND kind = 'cover' AND status = 'open')) AND created_at > ? ORDER BY created_at DESC LIMIT 100")
        .bind(user.id, user.id, user.id, nowMs() - 60 * 864e5).all<ReqRow>(),
      approvers(env),
    ]);
    return json({
      user: { id: user.id, name: user.name, role: user.role, manager: mgr, admin: user.role === "admin" }, links, today: londonToday(), approvers: appr,
      contractMin: p?.contract_min ?? null, contractMax: p?.contract_max ?? null, contractHours: p?.contract_max ?? null, sites: parseJson(p?.sites, []), pattern: parseJson(p?.pattern, {}),
      timeOff: offs.results.map((t) => ({ id: t.id, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status, decidedAt: t.decided_at })),
      requests: await visibleRequests(env, reqs.results, mgr),
    });
  }

  if (route === "me/availability" && m === "PUT") {
    needAdmin();
    const b = await body();
    const pattern = checkPattern(b.pattern), sites = checkSites(b.sites);
    await env.DB.prepare(
      `INSERT INTO rota_people (user_id, sites, pattern, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET sites = excluded.sites, pattern = excluded.pattern, updated_at = excluded.updated_at`,
    ).bind(user.id, JSON.stringify(sites), JSON.stringify(pattern), nowMs()).run();
    return json({ pattern, sites });
  }

  if (seg[0] === "people" && seg.length === 2 && m === "PUT") {
    needMgr();
    const uid = await activeUser(env, seg[1]);
    const b = await body();
    if ("sites" in b || "pattern" in b) needAdmin();
    const cur = await env.DB.prepare("SELECT * FROM rota_people WHERE user_id = ?").bind(uid)
      .first<{ sites: string; pattern: string; contract_min: number | null; contract_max: number | null }>();
    // {contractMin, contractMax}; or the older single {contractHours}, which sets both. Leaving them out keeps them.
    let min = cur?.contract_min ?? null, max = cur?.contract_max ?? null;
    if ("contractHours" in b && !("contractMin" in b) && !("contractMax" in b)) min = max = checkContract(b.contractHours);
    if ("contractMin" in b) min = checkContract(b.contractMin);
    if ("contractMax" in b) max = checkContract(b.contractMax);
    if (min != null && max != null && min > max) throw invalid("The minimum contracted hours can't be more than the maximum.");
    const sites = "sites" in b ? checkSites(b.sites) : parseJson(cur?.sites, []);
    const pattern = "pattern" in b ? checkPattern(b.pattern) : parseJson(cur?.pattern, {});
    await env.DB.prepare(
      `INSERT INTO rota_people (user_id, contract_hours, contract_min, contract_max, sites, pattern, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET contract_hours = excluded.contract_hours, contract_min = excluded.contract_min, contract_max = excluded.contract_max,
         sites = excluded.sites, pattern = excluded.pattern, updated_at = excluded.updated_at`,
    ).bind(uid, max, min, max, JSON.stringify(sites), JSON.stringify(pattern), nowMs()).run();
    return json({ userId: uid, contractMin: min, contractMax: max, contractHours: max, sites, pattern });
  }

  if (route === "time-off" && m === "POST") {
    const b = await body();
    if (!isDay(b.from) || !isDay(b.to)) throw invalid("Choose real dates.");
    if (b.to < b.from) throw invalid("The last day has to be on or after the first.");
    if (dateOf(b.to).getTime() - dateOf(b.from).getTime() > 92 * 864e5) throw invalid("Ask for up to three months at a time.");
    const reason = text(b.reason, "The reason", 200);
    const forOther = b.userId != null && b.userId !== user.id;
    if (forOther) needMgr();
    const uid = forOther ? await activeUser(env, b.userId) : user.id;
    const clash = await env.DB.prepare("SELECT from_day, to_day FROM rota_time_off WHERE user_id = ? AND status IN ('requested', 'approved') AND from_day <= ? AND to_day >= ? LIMIT 1")
      .bind(uid, b.to, b.from).first<{ from_day: string; to_day: string }>();
    if (clash) throw conflict(`${forOther ? "They" : "You"} already have time off asked for or booked from ${clash.from_day} to ${clash.to_day}.`);
    const approved = mgr && b.userId != null; // managers adding it for someone (or themselves, explicitly) approve it straight away
    const id = newId(10);
    await env.DB.prepare(
      "INSERT INTO rota_time_off (id, user_id, from_day, to_day, reason, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, uid, b.from, b.to, reason, approved ? "approved" : "requested", approved ? user.id : null, approved ? nowMs() : null, nowMs()).run();
    return json({ id, userId: uid, from: b.from, to: b.to, reason, status: approved ? "approved" : "requested" });
  }

  if (seg[0] === "time-off" && seg.length === 2 && m === "PATCH") {
    const t = await env.DB.prepare("SELECT * FROM rota_time_off WHERE id = ?").bind(seg[1]).first<{ user_id: string; status: string; from_day: string }>();
    if (!t) throw notFound("That request has gone. Refresh and try again.");
    const b = await body();
    if (b.status === "cancelled") {
      if (t.user_id !== user.id && !mgr) throw denied("Only the person who asked can cancel it.");
      if (!["requested", "approved"].includes(t.status)) throw conflict("That request is already settled.");
      // Time off that has started is a record of what happened; only a manager changes it.
      if (!mgr && t.status === "approved" && t.from_day < londonToday()) throw denied("That time off has started. Ask a manager to change it.");
    } else if (b.status === "approved" || b.status === "declined") {
      needMgr();
      if (t.status !== "requested") throw conflict("That request is already settled.");
      if (t.user_id === user.id && !admin) throw denied("Another manager or an admin decides your own time off.");
    } else throw invalid("Choose approve, decline or cancel.");
    await env.DB.prepare("UPDATE rota_time_off SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").bind(b.status, user.id, nowMs(), seg[1]).run();
    return json({ id: seg[1], status: b.status });
  }

  if (route === "requests" && m === "GET") {
    // Managers: everything waiting for a decision; everyone: what involves them.
    const pending = mgr
      ? await env.DB.prepare("SELECT r.* FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id WHERE r.status IN ('open', 'accepted') AND s.day >= ? ORDER BY r.created_at LIMIT 300").bind(londonToday()).all<ReqRow>()
      : await env.DB.prepare(`SELECT r.* FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id
          WHERE r.status IN ('open', 'accepted') AND s.day >= ? AND (r.from_user = ? OR r.to_user = ? OR r.taker = ? OR (r.to_user IS NULL AND r.kind = 'cover')) ORDER BY r.created_at LIMIT 300`)
        .bind(londonToday(), user.id, user.id, user.id).all<ReqRow>();
    const offs = mgr
      ? await env.DB.prepare("SELECT t.*, u.name FROM rota_time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'requested' ORDER BY t.from_day").all<any>()
      : { results: [] as any[] };
    return json({
      requests: await visibleRequests(env, pending.results, mgr),
      timeOff: offs.results.map((t) => ({ id: t.id, userId: t.user_id, name: t.name, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status, createdAt: t.created_at })),
    });
  }

  if (route === "open" && m === "GET") {
    // Open shifts in published weeks, from today, that this person could take.
    const from = londonToday(), to = addDays(from, 41);
    const [weeks, all, offs, mine] = await Promise.all([
      publishedWeeks(env, from, to), loadShifts(env, from, to), loadTimeOff(env, from, to),
      env.DB.prepare("SELECT shift_id, status FROM rota_requests WHERE from_user = ? AND kind = 'claim' AND status IN ('open', 'accepted')").bind(user.id).all<{ shift_id: string; status: string }>(),
    ]);
    const pendingAny = await env.DB.prepare("SELECT DISTINCT shift_id FROM rota_requests WHERE kind = 'claim' AND status IN ('open', 'accepted')").all<{ shift_id: string }>();
    const myShifts = all.filter((s) => s.userId === user.id);
    const list = all.filter((s) => !s.userId && weeks.has(mondayOf(s.day)))
      .filter((s) => !myShifts.some((x) => overlaps(x, s)) && !onTimeOff(offs, user.id, s.day))
      .map((s) => ({
        ...s, siteName: siteName(s.site),
        asked: mine.results.some((r) => r.shift_id === s.id),
        takenBySomeone: !mine.results.some((r) => r.shift_id === s.id) && pendingAny.results.some((r) => r.shift_id === s.id),
      }));
    return json({ shifts: list });
  }

  if (route === "requests" && m === "POST") {
    const b = await body();
    const shift = await getShift(env, typeof b.shiftId === "string" ? b.shiftId : "");
    const today = londonToday();
    if (shift.day < today) throw invalid("That shift has already happened.");
    const row = await weekRow(env, mondayOf(shift.day));
    if (!row?.published_at) throw invalid("That week hasn't been published yet.");
    const message = text(b.message, "The message", 300);
    const pending = await env.DB.prepare("SELECT kind, from_user FROM rota_requests WHERE shift_id = ? AND status IN ('open', 'accepted')").bind(shift.id).all<{ kind: string; from_user: string }>();
    const id = newId(10);
    if (b.kind === "claim") {
      if (shift.userId) throw conflict("Someone already has that shift.");
      if (pending.results.length) throw conflict(pending.results.some((p) => p.from_user === user.id) ? "You've already asked for this shift." : "Someone has already asked for this shift.");
      const ctxW = await loadCtx(env, mondayOf(shift.day));
      const stop = blocking(effectsFor(ctxW, shift, user.id).problems);
      if (stop) throw conflict(stop.message);
      // Only if no one else asked in the meantime.
      const ins = await env.DB.prepare(`INSERT INTO rota_requests (id, kind, shift_id, from_user, to_user, taker, message, status, created_at)
          SELECT ?, 'claim', ?, ?, NULL, ?, ?, 'open', ? WHERE NOT EXISTS (SELECT 1 FROM rota_requests WHERE shift_id = ? AND status IN ('open', 'accepted'))`)
        .bind(id, shift.id, user.id, user.id, message, nowMs(), shift.id).run();
      if (!ins.meta.changes) throw conflict("Someone has already asked for this shift.");
    } else if (b.kind === "cover") {
      if (shift.userId !== user.id) throw denied("You can only ask for cover for your own shifts.");
      if (pending.results.some((p) => p.kind === "cover")) throw conflict("You've already asked for cover for this shift.");
      const to = b.toUserId == null || b.toUserId === "" ? null : await activeUser(env, b.toUserId);
      if (to === user.id) throw invalid("Choose someone else to cover it.");
      const ins = await env.DB.prepare(`INSERT INTO rota_requests (id, kind, shift_id, from_user, to_user, taker, message, status, created_at)
          SELECT ?, 'cover', ?, ?, ?, NULL, ?, 'open', ? WHERE NOT EXISTS (SELECT 1 FROM rota_requests WHERE shift_id = ? AND kind = 'cover' AND status IN ('open', 'accepted'))`)
        .bind(id, shift.id, user.id, to, message, nowMs(), shift.id).run();
      if (!ins.meta.changes) throw conflict("You've already asked for cover for this shift.");
    } else throw invalid("Choose claim or cover.");
    const out = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(id).all<ReqRow>();
    return json({ request: (await describeRequests(env, out.results))[0] });
  }

  if (seg[0] === "requests" && seg.length === 2 && m === "PATCH") {
    const r = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(seg[1]).first<ReqRow>();
    if (!r) throw notFound("That request has gone. Refresh and try again.");
    const b = await body();
    const settled = () => { if (!["open", "accepted"].includes(r.status)) throw conflict("That request is already settled."); };
    // A shift only changes hands while it's still ahead, in a published week.
    const stillTakeable = async (shift: Shift) => {
      if (shift.day < londonToday()) throw conflict("That shift has already happened.");
      if (!(await weekRow(env, mondayOf(shift.day)))?.published_at) throw conflict("That week isn't published any more. Check the rota.");
    };
    const set = (status: string, extra: { taker?: string | null; decided?: boolean } = {}) =>
      env.DB.prepare("UPDATE rota_requests SET status = ?, taker = ?, decided_by = ?, decided_at = ? WHERE id = ?")
        .bind(status, extra.taker !== undefined ? extra.taker : r.taker, extra.decided ? user.id : r.decided_by, extra.decided ? nowMs() : r.decided_at, r.id);
    switch (b.action) {
      case "accept": {
        settled();
        if (r.kind !== "cover" || r.status !== "open") throw conflict("Only an open cover request can be accepted.");
        if (r.from_user === user.id) throw invalid("You can't cover your own shift.");
        if (r.to_user && r.to_user !== user.id) throw denied("That request was for someone else.");
        const shift = await getShift(env, r.shift_id);
        await stillTakeable(shift);
        const stop = blocking(effectsFor(await loadCtx(env, mondayOf(shift.day)), shift, user.id).problems);
        if (stop) throw conflict(stop.message);
        await set("accepted", { taker: user.id }).run();
        break;
      }
      case "decline":
        settled();
        if (!(mgr || (r.kind === "cover" && r.to_user === user.id))) throw denied("Only the person asked, or a manager, can decline it.");
        await set("declined", { decided: true }).run();
        break;
      case "cancel":
        settled();
        if (r.from_user !== user.id && !mgr) throw denied("Only the person who asked can cancel it.");
        await set("cancelled", { decided: true }).run();
        break;
      case "approve": {
        needMgr();
        settled();
        if (r.kind === "cover" && r.status !== "accepted") throw conflict("No one has agreed to cover it yet.");
        if (!r.taker) throw conflict("No one has agreed to take it yet.");
        const shift = await getShift(env, r.shift_id);
        if (r.kind === "claim" && shift.userId) throw conflict("Someone already has that shift.");
        if (r.kind === "cover" && shift.userId !== r.from_user) throw conflict("That shift has changed since the request. Check the rota.");
        await stillTakeable(shift);
        const taker = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND active = 1").bind(r.taker).first();
        if (!taker) throw conflict(`${(await describeRequests(env, [r]))[0]?.takerName || "That person"}'s account is switched off, so they can't take it.`);
        const stop = blocking(effectsFor(await loadCtx(env, mondayOf(shift.day)), shift, r.taker).problems);
        if (stop) throw conflict(stop.message);
        await env.DB.batch([
          env.DB.prepare("UPDATE rota_shifts SET user_id = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(r.taker, nowMs(), user.id, shift.id),
          set("approved", { decided: true }),
          env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE shift_id = ? AND id <> ? AND status IN ('open', 'accepted')").bind(user.id, nowMs(), shift.id, r.id),
          touchWeek(env, mondayOf(shift.day)),
        ]);
        break;
      }
      default:
        throw invalid("Choose accept, decline, cancel or approve.");
    }
    const out = await env.DB.prepare("SELECT * FROM rota_requests WHERE id = ?").bind(r.id).all<ReqRow>();
    return json({ request: (await describeRequests(env, out.results))[0] });
  }

  if (route === "sites" && m === "GET") {
    const sites = await loadSites(env);
    return json({ sites: [...sites.values()].map((s) => ({ id: s.id, name: s.name, inUse: s.inUse, closedDays: s.closedDays, opensAt: s.opensAt, closesAt: s.closesAt, minPeople: s.minPeople, dayHours: s.dayHours })) });
  }

  if (seg[0] === "sites" && seg.length === 2 && m === "PUT") {
    needMgr();
    if (!SITE_IDS.has(seg[1])) throw invalid("Choose one of the four sites.");
    const b = await body();
    const t = (v: unknown, label: string) => { if (v == null || v === "") return null; if (!isTime(v)) throw invalid(`${label} is HH:MM, for example 07:00.`); return v; };
    const opensAt = t(b.opensAt, "Opening time"), closesAt = t(b.closesAt, "Closing time");
    if (opensAt && closesAt && mins(closesAt) <= mins(opensAt)) throw invalid("Closing time has to be after opening time.");
    const minPeople = b.minPeople == null ? 1 : Number(b.minPeople);
    if (!Number.isInteger(minPeople) || minPeople < 0 || minPeople > 20) throw invalid("Minimum people is 0 to 20.");
    // Days with other hours, {sat: {opensAt, closesAt}, …}; a day left out (or null) uses the usual hours. Left out
    // altogether, the saved days are kept.
    let dayHours: Record<string, { opensAt: string; closesAt: string }>;
    if (b.dayHours === undefined) {
      dayHours = (await loadSites(env)).get(seg[1])!.dayHours;
    } else {
      if (b.dayHours !== null && (typeof b.dayHours !== "object" || Array.isArray(b.dayHours))) throw invalid("Day hours aren't valid.");
      dayHours = {};
      for (const [k, d] of Object.entries((b.dayHours || {}) as Record<string, any>)) {
        if (!(DAY_KEYS as readonly string[]).includes(k)) throw invalid("Day hours use mon to sun.");
        if (d == null) continue;
        const o = t(d.opensAt, `Opening time on ${k}`), c = t(d.closesAt, `Closing time on ${k}`);
        if (!o || !c) throw invalid("Give an opening and a closing time for each day with its own hours.");
        if (mins(c) <= mins(o)) throw invalid("Closing time has to be after opening time.");
        dayHours[k] = { opensAt: o, closesAt: c };
      }
    }
    await env.DB.prepare(
      `INSERT INTO rota_sites (site, opens_at, closes_at, min_people, day_hours) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (site) DO UPDATE SET opens_at = excluded.opens_at, closes_at = excluded.closes_at, min_people = excluded.min_people, day_hours = excluded.day_hours`,
    ).bind(seg[1], opensAt, closesAt, minPeople, JSON.stringify(dayHours)).run();
    return json({ id: seg[1], opensAt, closesAt, minPeople, dayHours });
  }

  throw new ApiError(404, "not_found", "Unknown rota route.");
}

// Exported for tests of the pure parts.
export const _test = { computeProblems, paidHours, mondayOf, londonToday };
export type { SiteId };
