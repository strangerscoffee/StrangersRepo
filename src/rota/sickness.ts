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

import { BRADFORD_BANDS, EXCLUDE_REASONS, bradford, type SickAbsence } from "./bradford";
export { BRADFORD_BANDS, bandOf, bradford } from "./bradford";

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
      ...p.changes.map((c) => env.DB.prepare("UPDATE rota_shifts SET actual_start=?, actual_end=?, actual_break=?, adjust_note=?, adjusted_by=?, adjusted_at=?,updated_at=MAX(updated_at+1,?),updated_by=? WHERE id=? AND user_id=?")
        .bind(c.set.start, c.set.end, c.set.breakMins, p.kind === "early" ? `Went home sick at ${p.leftAt} (self-certified)` : "Off sick (self-certified)", user.id, now, now, user.id, c.shiftId, p.uid)),
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
    const view = (row: any) => ({ id: row.id, userId: row.user_id, name: row.name, kind: row.kind, from: row.from_day, to: row.to_day, leftAt: row.left_at, createdAt: row.created_at, createdBy: row.created_name || "", timeOffId: row.time_off_id, answers: JSON.parse(row.data), changes: preview(JSON.parse(row.amended || "[]")) });
    const { absences, review } = await sickAbsences(env, today);
    const byUser = new Map<string, typeof absences>();
    for (const a of absences) byUser.set(a.userId, [...(byUser.get(a.userId) || []), a]);
    const employees = people.map((p) => {
      const mine = byUser.get(p.id) || [];
      const counted = mine.filter((a) => a.counted);
      return { userId: p.id, name: p.name, ...bradford(mine.map(asRecord), today), lastSick: counted[0]?.to || mine[0]?.to || null, recordsThisYear: mine.filter((x) => x.to >= since).length, toReview: review.filter((f) => f.userId === p.id).length };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return json({ today, since, bands: BRADFORD_BANDS.map((b) => ({ ...b, max: Number.isFinite(b.max) ? b.max : null })), excludeReasons: EXCLUDE_REASONS, employees, absences: absences.filter((a) => a.to >= addDays(since, -365)), review, records: rows.slice(0, 500).map(view) });
  }

  // An admin leaves one absence out of the Bradford Factor (with a reason), counts it again, or marks it as the same
  // spell as the one before. Version-checked; each change is logged with what it was before.
  if (seg.length === 3 && seg[1] === "absence" && m === "PUT") {
    const t = await env.DB.prepare("SELECT id,user_id,from_day,to_day FROM rota_time_off WHERE id=? AND kind='sick' AND status='approved'").bind(seg[2]).first<{ id: string; user_id: string; from_day: string; to_day: string }>();
    if (!t) throw notFound("That sickness absence isn't there any more.");
    const b = await r.body();
    const cur = await env.DB.prepare("SELECT * FROM rota_bradford_review WHERE time_off_id=?").bind(t.id).first<{ excluded_reason: string | null; continues: number; version: number }>();
    if (Number(b.ifVersion ?? -1) !== (cur?.version ?? 0)) throw conflict("This absence was changed on another device. Reload and try again.");
    const reason = b.excluded == null || b.excluded === "" ? null : text(b.excluded, "Reason for leaving it out", 200);
    if (b.excluded != null && b.excluded !== "" && !reason) throw invalid("Say why this absence is left out.");
    if (typeof b.continues !== "boolean") throw invalid("Choose whether it continues the spell before.");
    const now = Date.now(), version = (cur?.version ?? 0) + 1;
    await env.DB.batch([
      cur ? env.DB.prepare("UPDATE rota_bradford_review SET excluded_reason=?, continues=?, version=?, updated_at=?, updated_by=? WHERE time_off_id=? AND version=?").bind(reason, b.continues ? 1 : 0, version, now, user.id, t.id, cur.version)
        : env.DB.prepare("INSERT INTO rota_bradford_review(time_off_id, excluded_reason, continues, version, updated_at, updated_by) VALUES(?,?,?,?,?,?)").bind(t.id, reason, b.continues ? 1 : 0, version, now, user.id),
      event(env, t.user_id, t.id, "bradford_review", user.id, { before: { excluded: cur?.excluded_reason ?? null, continues: !!cur?.continues }, after: { excluded: reason, continues: !!b.continues }, from: t.from_day, to: t.to_day }),
    ]);
    await audit(env, "sickness_bradford_review", user.name, `${user.name} ${reason ? `left a sickness absence (${t.from_day}) out of the Bradford Factor: ${reason}` : `counted a sickness absence (${t.from_day}) in the Bradford Factor`}${b.continues ? ", as part of the spell before" : ""}.`);
    return json({ ok: true, version });
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
      ...changes.map((c) => env.DB.prepare("UPDATE rota_shifts SET actual_start=?, actual_end=?, actual_break=?, adjust_note=?, adjusted_by=?, adjusted_at=?,updated_at=MAX(updated_at+1,?),updated_by=? WHERE id=? AND actual_start IS ? AND actual_end IS ? AND actual_break IS ?")
        .bind(c.before.actual_start, c.before.actual_end, c.before.actual_break, c.before.adjust_note ?? "", c.before.adjusted_by, c.before.adjusted_at, now, user.id, c.shiftId, c.set.start, c.set.end, c.set.breakMins)),
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

/* ---------- every sickness absence, where it came from, and what needs a look ---------- */
type Absence = { id: string; userId: string; name: string; from: string; to: string; partial: boolean; source: string; formId: string | null; excluded: string | null; continues: boolean; reviewVersion: number; counted: boolean; fromTime: string | null; toTime: string | null };
const asRecord = (a: Absence): SickAbsence => ({ id: a.id, from_day: a.from, to_day: a.to, partial: a.partial, excluded: a.excluded, continues: a.continues });
export async function sickAbsences(env: Env, today: string) {
  const rows = (await env.DB.prepare(`SELECT t.id, t.user_id, u.name, t.from_day, t.to_day, t.from_time, t.to_time, t.reason, s.id AS form_id, s.kind AS form_kind, r.excluded_reason, r.continues, r.version AS review_version
    FROM rota_time_off t JOIN users u ON u.id = t.user_id LEFT JOIN rota_sickness s ON s.time_off_id = t.id AND s.status = 'active' LEFT JOIN rota_bradford_review r ON r.time_off_id = t.id
    WHERE t.kind = 'sick' AND t.status = 'approved' AND u.active = 1 ORDER BY t.from_day DESC`).all<any>()).results;
  const absences: Absence[] = rows.map((r) => {
    const partial = r.from_time != null || r.form_kind === "early";
    return { id: r.id, userId: r.user_id, name: r.name, from: r.from_day, to: r.to_day, partial, source: r.form_id ? "Sickness form" : String(r.reason || "").startsWith("Imported from WhosOff") ? "Imported from WhosOff" : "Recorded in the rota",
      formId: r.form_id || null, excluded: r.excluded_reason || null, continues: !!r.continues, reviewVersion: r.review_version || 0, counted: !partial && !r.excluded_reason, fromTime: r.from_time, toTime: r.to_time };
  });
  // Flags for an admin to check, never changed automatically.
  const review: { userId: string; name: string; ids: string[]; kind: "gap" | "clash" | "twice"; text: string }[] = [];
  const others = (await env.DB.prepare("SELECT id, user_id, from_day, to_day, kind FROM rota_time_off WHERE status = 'approved' AND kind <> 'sick'").all<{ id: string; user_id: string; from_day: string; to_day: string; kind: string }>()).results;
  const KIND: Record<string, string> = { annual: "holiday", unpaid: "unpaid leave", unauthorised: "an unauthorised absence" };
  const since = addDays(today, -364 - 365);
  const byUser = new Map<string, Absence[]>();
  for (const a of absences) if (a.to >= since) byUser.set(a.userId, [...(byUser.get(a.userId) || []), a]);
  for (const [userId, list] of byUser) {
    const asc = [...list].sort((a, b) => a.from.localeCompare(b.from));
    const counted = asc.filter((a) => a.counted);
    for (let i = 1; i < counted.length; i++) {
      const prev = counted[i - 1], a = counted[i], gap = Math.round((Date.parse(a.from) - Date.parse(prev.to)) / 864e5) - 1;
      if (gap >= 1 && gap <= 3 && !a.continues) review.push({ userId, name: a.name, ids: [prev.id, a.id], kind: "gap", text: `${gap === 1 ? "One day" : `${gap} days`} between absences ending ${prev.to} and starting ${a.from}: if ${gap === 1 ? "it wasn't a working day" : "those weren't working days"}, mark them as one spell. They count as two now.` });
    }
    for (let i = 0; i < asc.length; i++) for (let k = i + 1; k < asc.length; k++) if (asc[k].from <= asc[i].to && !asc[i].partial && !asc[k].partial)
      review.push({ userId, name: asc[i].name, ids: [asc[i].id, asc[k].id], kind: "twice", text: `Sickness recorded twice on ${asc[k].from}: check one isn't a duplicate (it's counted once).` });
    for (const a of asc) for (const o of others) if (o.user_id === userId && o.from_day <= a.to && o.to_day >= a.from)
      review.push({ userId, name: a.name, ids: [a.id], kind: "clash", text: `Off sick ${a.from === a.to ? `on ${a.from}` : `${a.from} to ${a.to}`} but also booked as ${KIND[o.kind] || o.kind} then: check which is right.` });
  }
  return { absences, review };
}
