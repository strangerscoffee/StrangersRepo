// Self-certified sickness (the rota's "Report sickness" form; Admin → Sickness). Any employee reports their own sickness:
// a day or days off, or going home early. Saving records a private, approved sick absence in rota_time_off (so the rota
// and Holiday management see it), sets the hours on that person's shifts in the period (0 hours for a day off; up to the
// time they left for going home early) the same way an admin amends actual hours, and keeps the form's answers in
// rota_sickness (migration 26). Only admins read the answers, the records and the Bradford Factor; the employee gets
// "saved" and nothing else back. An admin can remove a record: the absence is cancelled and any shift still showing the
// hours the form set goes back to how it was.
import { newId } from "../auth";
import { audit } from "../audit";
import { ApiError, type Env, invalid, json } from "../http";
import { commitLeave, event, revision } from "./leave/model";
import { activeUser, touchWeek } from "./load";
import { paidHours } from "./shift";
import type { RotaRequest } from "./types";
import { addDays, conflict, denied, isDay, isTime, londonToday, mins, mondayOf, notFound, text } from "./util";

export const SICK_CATEGORIES = ["Cold or flu", "Stomach upset", "Headache or migraine", "Back or muscle pain", "Injury", "Covid", "Mental health or stress", "Other"] as const;
const BACK_DAYS = 28, AHEAD_DAYS = 14, MAX_SPAN = 28;
type ShiftRow = { id: string; day: string; site: string; start: string; end: string; break_mins: number; actual_start: string | null; actual_end: string | null; actual_break: number | null; adjust_note: string | null; adjusted_by: string | null; adjusted_at: number | null };
type Change = { shiftId: string; day: string; site: string; start: string; end: string; hoursBefore: number; hoursAfter: number; set: { start: string; end: string; breakMins: number }; before: { actual_start: string | null; actual_end: string | null; actual_break: number | null; adjust_note: string | null; adjusted_by: string | null; adjusted_at: number | null } };

/* ---------- the Bradford Factor: S² × D over the last 52 weeks ---------- */
// S is the number of separate spells (records on touching or overlapping days count as one), D the days lost (a day off
// counts 1 a day, going home early half a day). The trigger points are the ones most UK employers use; the action is the
// usual next step, to be applied with judgement and the company's own absence policy.
export const BRADFORD_BANDS = [
  { min: 0, max: 49, key: "none", label: "No concern", action: "No action. Hold a return-to-work chat after each absence." },
  { min: 50, max: 124, key: "monitor", label: "Monitor", action: "Informal review: talk through the pattern and note any support needed." },
  { min: 125, max: 399, key: "stage1", label: "Stage 1", action: "First formal absence meeting; a first written warning may be given." },
  { min: 400, max: 649, key: "stage2", label: "Stage 2", action: "Second formal meeting; a final written warning may be given." },
  { min: 650, max: Infinity, key: "stage3", label: "Stage 3", action: "Final review meeting; dismissal may be considered, after checking for health or disability reasons." },
] as const;
export const bandOf = (score: number) => BRADFORD_BANDS.find((b) => score <= b.max) || BRADFORD_BANDS[BRADFORD_BANDS.length - 1];
export function bradford(records: { kind: string; from_day: string; to_day: string }[], today: string) {
  const start = addDays(today, -364);
  const inWindow = records.filter((r) => r.to_day >= start && r.from_day <= today).map((r) => ({ ...r, from: r.from_day < start ? start : r.from_day, to: r.to_day > today ? today : r.to_day })).sort((a, b) => a.from.localeCompare(b.from));
  let spells = 0, lastTo = "", days = 0;
  for (const r of inWindow) {
    if (!lastTo || r.from > addDays(lastTo, 1)) spells++;
    if (!lastTo || r.to > lastTo) lastTo = r.to;
    days += r.kind === "early" ? 0.5 : Math.round((Date.parse(r.to) - Date.parse(r.from)) / 864e5) + 1;
  }
  const score = Math.round(spells * spells * days);
  const band = bandOf(score);
  return { spells, days, score, band: { key: band.key, label: band.label, action: band.action } };
}

/* ---------- what the form changes on the person's shifts ---------- */
const hoursOf = (s: { start: string; end: string; breakMins: number }) => paidHours(s);
function plan(shifts: ShiftRow[], kind: "off" | "early", leftAt: string | null): Change[] {
  const out: Change[] = [];
  for (const s of shifts) {
    const adjusted = s.actual_start != null && s.actual_end != null;
    const start = adjusted ? s.actual_start! : s.start, end = adjusted ? s.actual_end! : s.end, brk = adjusted ? s.actual_break ?? s.break_mins : s.break_mins;
    const before = { actual_start: s.actual_start, actual_end: s.actual_end, actual_break: s.actual_break, adjust_note: s.adjust_note, adjusted_by: s.adjusted_by, adjusted_at: s.adjusted_at };
    const hoursBefore = hoursOf({ start, end, breakMins: brk });
    let set: Change["set"] | null = null;
    if (kind === "off" || mins(leftAt!) <= mins(start)) set = { start, end: start, breakMins: 0 };
    else if (mins(leftAt!) < mins(end)) {
      const there = mins(leftAt!) - mins(start);
      set = { start, end: leftAt!, breakMins: there > 6 * 60 ? Math.min(brk, there) : 0 }; // the break only if they stayed over 6 hours
    }
    if (!set) continue; // left after the shift ended: nothing to change
    out.push({ shiftId: s.id, day: s.day, site: s.site, start: s.start, end: s.end, hoursBefore, hoursAfter: hoursOf(set), set, before });
  }
  return out;
}

async function details(r: RotaRequest, b: any, forPreview = false) {
  const uid = b.userId === undefined || b.userId === r.user.id ? r.user.id : (r.needAdmin(), await activeUser(r.env, b.userId));
  const kind = b.kind;
  if (kind !== "off" && kind !== "early") throw invalid("Choose whether you were off sick or went home early.");
  const today = londonToday();
  const from = b.from, to = kind === "early" ? b.from : b.to;
  if (!isDay(from) || !isDay(to)) throw invalid(kind === "early" ? "Choose the day you went home." : "Choose your first and last day off sick.");
  if (to < from) throw invalid("Your last day off can't be before your first.");
  if (Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 > MAX_SPAN) throw invalid(`One form covers up to ${MAX_SPAN} days. For longer, ask an admin.`);
  if (!r.admin && from < addDays(today, -BACK_DAYS)) throw invalid(`Sickness more than ${BACK_DAYS} days ago is recorded by an admin.`);
  if (to > addDays(today, AHEAD_DAYS)) throw invalid(`Choose a last day within the next ${AHEAD_DAYS} days. You can send another form if you're off longer.`);
  if (kind === "early" && from > today) throw invalid("Going home early can only be for today or an earlier day.");
  const leftAt = kind === "early" ? b.leftAt : null;
  if (kind === "early" && !isTime(leftAt)) throw invalid("Enter the time you left, for example 13:30.");
  const shifts = (await r.env.DB.prepare("SELECT id,day,site,start,end,break_mins,actual_start,actual_end,actual_break,adjust_note,adjusted_by,adjusted_at FROM rota_shifts WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day,start").bind(uid, from, to).all<ShiftRow>()).results;
  const changes = plan(shifts, kind, leftAt);
  if (forPreview) return { uid, kind, from, to, leftAt, changes, answers: null };
  const category = b.category;
  if (!SICK_CATEGORIES.includes(category)) throw invalid("Choose what was wrong.");
  const yesNo = (v: unknown, what: string) => { if (typeof v !== "boolean") throw invalid(`Answer: ${what}`); return v; };
  const answers = {
    category,
    details: text(b.details, "What was wrong", 1000),
    vomiting: yesNo(b.vomiting, "did you have sickness (vomiting) or diarrhoea?"),
    doctor: yesNo(b.doctor, "did you see a doctor, nurse or pharmacist?"),
    workAccident: yesNo(b.workAccident, "was it caused by an accident or injury at work?"),
    fitNote: (Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1) > 7,
  };
  if (!answers.details) throw invalid("Tell us briefly what was wrong.");
  if (b.declared !== true) throw invalid("Tick the declaration to send the form.");
  return { uid, kind, from, to, leftAt, changes, answers };
}

const preview = (c: Change[]) => c.map(({ before, set, ...rest }) => rest);

export async function sicknessRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, route, m, seg, user } = r;
  if (seg[0] !== "sickness") return null;

  // What the form would change on the person's own shifts (their own data only; admins for anyone).
  if (route === "sickness/preview" && m === "GET") {
    const q = (k: string) => r.q(k) ?? undefined;
    const p = await details(r, { userId: q("userId"), kind: q("kind"), from: q("from"), to: q("to"), leftAt: q("leftAt") }, true);
    return json({ changes: preview(p.changes), categories: SICK_CATEGORIES });
  }

  if (route === "sickness" && m === "POST") {
    const b = await r.body();
    const key = b.requestKey;
    if (typeof key !== "string" || !/^[\w-]{8,100}$/.test(key)) throw invalid("Send a valid request key so this form can't be saved twice.");
    const p = await details(r, b);
    const replay = await env.DB.prepare("SELECT id FROM rota_sickness WHERE user_id=? AND request_key=?").bind(p.uid, key).first<{ id: string }>();
    if (replay) return json({ saved: true, id: replay.id, replayed: true });
    const clash = await env.DB.prepare("SELECT from_day,to_day FROM rota_sickness WHERE user_id=? AND status='active' AND from_day<=? AND to_day>=? LIMIT 1").bind(p.uid, p.to, p.from).first<{ from_day: string; to_day: string }>();
    if (clash) throw conflict("Sickness is already recorded for some of these days. Ask an admin to change it.");
    const id = newId(12), toId = newId(10), now = Date.now(), ver = await revision(env);
    // Going home early: the absence runs from the time they left to the end of that day's last shift (or the day).
    const lastEnd = p.changes.reduce((e, c) => (c.end > e ? c.end : e), "");
    const untilTime = p.kind === "early" ? (lastEnd > p.leftAt! ? lastEnd : "23:59") : null;
    const name = (await env.DB.prepare("SELECT name FROM users WHERE id=?").bind(p.uid).first<{ name: string }>())?.name || "Someone";
    const data = { ...p.answers, leftAt: p.leftAt, declaredBy: user.name, declaredAt: now, onBehalf: p.uid !== user.id };
    const weeks = [...new Set([p.from, p.to, ...p.changes.map((c) => c.day)].map(mondayOf))];
    await commitLeave(env, ver, [
      env.DB.prepare("INSERT INTO rota_time_off(id,user_id,from_day,to_day,reason,status,decided_by,decided_at,created_at,kind,version,from_time,to_time) VALUES(?,?,?,?,?,'approved',?,?,?,'sick',1,?,?)")
        .bind(toId, p.uid, p.from, p.to, "", user.id, now, now, p.kind === "early" ? p.leftAt : null, untilTime),
      env.DB.prepare("INSERT INTO rota_sickness(id,user_id,time_off_id,kind,from_day,to_day,left_at,data,amended,status,created_at,created_by,request_key) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)")
        .bind(id, p.uid, toId, p.kind, p.from, p.to, p.leftAt, JSON.stringify(data), JSON.stringify(p.changes), now, user.id, key),
      ...p.changes.map((c) => env.DB.prepare("UPDATE rota_shifts SET actual_start=?, actual_end=?, actual_break=?, adjust_note=?, adjusted_by=?, adjusted_at=? WHERE id=? AND user_id=?")
        .bind(c.set.start, c.set.end, c.set.breakMins, p.kind === "early" ? `Went home sick at ${p.leftAt} (self-certified)` : "Off sick (self-certified)", user.id, now, c.shiftId, p.uid)),
      event(env, p.uid, toId, "sickness_reported", user.id, { from: p.from, to: p.to, kind: p.kind }),
      ...weeks.map((w) => touchWeek(env, w)),
    ]);
    await audit(env, "sickness_reported", user.name, p.uid === user.id ? `${name} sent a self-certified sickness form.` : `${user.name} recorded a sickness form for ${name}.`);
    return json({ saved: true, id, changes: preview(p.changes) });
  }

  // Admins only from here: the records, their answers and the Bradford Factor.
  if (!r.admin) throw denied("Only an admin can see sickness records.");

  if (route === "sickness" && m === "GET") {
    const today = londonToday(), since = addDays(today, -364);
    const people = (await env.DB.prepare("SELECT id,name FROM users WHERE active=1 ORDER BY name_key").all<{ id: string; name: string }>()).results;
    const rows = (await env.DB.prepare("SELECT s.*, u.name AS name, c.name AS created_name FROM rota_sickness s JOIN users u ON u.id=s.user_id LEFT JOIN users c ON c.id=s.created_by WHERE s.status='active' ORDER BY s.from_day DESC, s.created_at DESC").all<any>()).results;
    const view = (row: any) => ({ id: row.id, userId: row.user_id, name: row.name, kind: row.kind, from: row.from_day, to: row.to_day, leftAt: row.left_at, createdAt: row.created_at, createdBy: row.created_name || "", answers: JSON.parse(row.data), changes: preview(JSON.parse(row.amended || "[]")) });
    const byUser = new Map<string, any[]>();
    for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) || []), row]);
    const employees = people.map((p) => {
      const mine = byUser.get(p.id) || [];
      return { userId: p.id, name: p.name, ...bradford(mine, today), lastSick: mine[0]?.to_day || null, recordsThisYear: mine.filter((x) => x.to_day >= since).length };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return json({ today, since, bands: BRADFORD_BANDS.map((b) => ({ ...b, max: Number.isFinite(b.max) ? b.max : null })), employees, records: rows.slice(0, 500).map(view) });
  }

  if (seg.length === 2 && m === "DELETE") {
    const row = await env.DB.prepare("SELECT * FROM rota_sickness WHERE id=? AND status='active'").bind(seg[1]).first<any>();
    if (!row) throw notFound("That sickness record isn't there any more.");
    const changes: Change[] = JSON.parse(row.amended || "[]"), now = Date.now(), ver = await revision(env);
    const weeks = [...new Set([row.from_day, row.to_day, ...changes.map((c) => c.day)].map(mondayOf))];
    await commitLeave(env, ver, [
      env.DB.prepare("UPDATE rota_sickness SET status='removed', removed_at=?, removed_by=? WHERE id=? AND status='active'").bind(now, user.id, row.id),
      env.DB.prepare("UPDATE rota_time_off SET status='cancelled', decided_by=?, decided_at=?, version=version+1 WHERE id=?").bind(user.id, now, row.time_off_id),
      // Only shifts still showing exactly what the form set go back; anything changed since is left as it is.
      ...changes.map((c) => env.DB.prepare("UPDATE rota_shifts SET actual_start=?, actual_end=?, actual_break=?, adjust_note=?, adjusted_by=?, adjusted_at=? WHERE id=? AND actual_start IS ? AND actual_end IS ? AND actual_break IS ?")
        .bind(c.before.actual_start, c.before.actual_end, c.before.actual_break, c.before.adjust_note ?? "", c.before.adjusted_by, c.before.adjusted_at, c.shiftId, c.set.start, c.set.end, c.set.breakMins)),
      event(env, row.user_id, row.time_off_id, "sickness_removed", user.id, {}),
      ...weeks.map((w) => touchWeek(env, w)),
    ]);
    await audit(env, "sickness_removed", user.name, `${user.name} removed a sickness record.`);
    return json({ removed: true });
  }
  throw new ApiError(404, "not_found", "Unknown sickness route.");
}

export async function migrateSickness(env: Env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_sickness (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, time_off_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('off','early')), from_day TEXT NOT NULL, to_day TEXT NOT NULL, left_at TEXT, data TEXT NOT NULL, amended TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')), created_at INTEGER NOT NULL, created_by TEXT NOT NULL, request_key TEXT NOT NULL, removed_at INTEGER, removed_by TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS rota_sickness_user ON rota_sickness(user_id, status, from_day)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS rota_sickness_key ON rota_sickness(user_id, request_key)"),
  ]);
}
