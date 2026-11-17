// Holiday left to take: how everyone's doing against the leave year's deadline, and the daily reminder run (from the
// five-minute cron, once a day from 09:00 UK time). Each reminder is recorded in rota_leave_notices, one row per
// person, leave year and stage, as the record that the person was given the chance to take their holiday, encouraged
// to and told it would be lost (what lets untaken holiday lapse at the year end). Staff get their own reminders;
// admins get one email listing the people at the later stages, and the quarter's extra-hours holiday to review.
import { Env } from "../../http";
import { holidayAddedEmail, holidayAdminEmail, holidayReminderEmail } from "../../email/templates";
import { Outgoing, emailReady, linksFor, prefsOf, recipients, sendAll, sendOutcome } from "../../email/send";
import { londonToday } from "../util";
import { STAGE_TEXT, Stage, cutoffDate, dueReminder, riskOf, stageDates } from "./accrualMath";
import { AllowanceRow, LeaveDay, balance, event, policy } from "./model";
import { quarterAwaiting } from "./accrual";

type Base = { rota: string; diary: string };

/** Everyone with a leave year that includes `today`: holiday left to plan, the deadline, and reminders so far. */
export async function holidayStatus(env: Env, today = londonToday(), only?: string) {
  const [people, rows, days, notices] = await Promise.all([
    env.DB.prepare("SELECT id, name FROM users WHERE active = 1 AND (? IS NULL OR id = ?) ORDER BY name_key").bind(only ?? null, only ?? null).all<{ id: string; name: string }>(),
    env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE from_day <= ? AND to_day >= ? AND (? IS NULL OR user_id = ?)").bind(today, today, only ?? null, only ?? null).all<AllowanceRow>(),
    env.DB.prepare("SELECT d.*, t.status, t.user_id FROM rota_leave_days d JOIN rota_time_off t ON t.id = d.time_off_id WHERE t.status IN ('requested','approved') AND (? IS NULL OR t.user_id = ?)").bind(only ?? null, only ?? null).all<LeaveDay & { user_id: string }>(),
    env.DB.prepare("SELECT user_id, year_from, stage, at, data FROM rota_leave_notices WHERE user_id <> '*' AND (? IS NULL OR user_id = ?)").bind(only ?? null, only ?? null).all<{ user_id: string; year_from: string; stage: string; at: number; data: string }>(),
  ]);
  const out = [];
  for (const p of people.results) {
    const row = rows.results.find((r) => r.user_id === p.id);
    if (!row) continue;
    const b = balance(row, days.results.filter((d) => d.user_id === p.id), today);
    const left = Math.max(0, b.available), takenOrPlanned = Math.max(0, b.total - b.available);
    const sent = notices.results.filter((n) => n.user_id === p.id && n.year_from === row.from_day);
    const d = stageDates(row.to_day);
    const reminders = sent.filter((n) => { try { return !JSON.parse(n.data).passed; } catch { return true; } })
      .map((n) => ({ stage: n.stage, label: STAGE_TEXT[n.stage as Stage] ?? n.stage, at: n.at, ...(JSON.parse(n.data || "{}") as { left?: number; emailed?: string }) }))
      .sort((a, b) => a.at - b.at);
    const next = (["half", "three", "two", "final"] as const).find((s) => d[s] > today);
    out.push({
      userId: p.id, name: p.name, year: { from: row.from_day, to: row.to_day }, total: b.total, used: b.used, booked: b.booked, pending: b.pending,
      reserved: b.bankHolidayReserved, left, takenOrPlanned, deadline: row.to_day, cutoff: cutoffDate(row.to_day, left),
      risk: riskOf(today, { from: row.from_day, to: row.to_day, total: b.total, takenOrPlanned, left }), reminders,
      nextReminder: left > 0 && next ? { stage: next, label: STAGE_TEXT[next], on: d[next] } : null, sentStages: new Set(sent.map((n) => n.stage)),
    });
  }
  return out;
}

/** What a person sees about their own year on Holidays (no other person's data). */
export async function ownHolidayStatus(env: Env, userId: string) {
  const s = (await holidayStatus(env, londonToday(), userId))[0];
  if (!s) return null;
  const { sentStages, ...rest } = s;
  return rest;
}

const londonHour = (now = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }).format(now));

/** The daily run: reminders due today, the admins' list, and the quarter to review. Sent once a day (claimed first). */
export async function runHolidayReminders(env: Env, base: Base, now = new Date()) {
  const { settings } = await policy(env);
  if (settings.reminders === false) return { sent: 0 };
  const today = londonToday(now);
  if (londonHour(now) < 9) return { sent: 0 };
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO rota_leave_notices(user_id, year_from, stage, at, data) VALUES('*', ?, 'run', ?, '{}')").bind(today, Date.now()).run();
  if (!claim.meta.changes) return { sent: 0 };
  const status = await holidayStatus(env, today);
  const ids = status.map((s) => s.userId);
  const people = await recipients(env, ids);
  const staffMail: Outgoing[] = [], forAdmins: { name: string; left: number; stage: string; deadline: string; cutoff: string }[] = [];
  const record: D1PreparedStatement[] = [];
  for (const s of status) {
    const due = dueReminder(today, { to: s.deadline, total: s.total, takenOrPlanned: s.takenOrPlanned, left: s.left }, s.sentStages);
    for (const stage of due.pass) record.push(env.DB.prepare("INSERT OR IGNORE INTO rota_leave_notices(user_id, year_from, stage, at, data) VALUES(?, ?, ?, ?, ?)").bind(s.userId, s.year.from, stage, Date.now(), JSON.stringify({ passed: true, left: s.left })));
    if (due.send) {
      const r = people.get(s.userId);
      // The formal one-month notice goes whatever the person's email choices; the others follow them.
      const emailTo = r && r.active && r.email && (due.send === "final" || prefsOf(r.email_prefs).holiday) ? r : null;
      const claimed = await env.DB.prepare("INSERT OR IGNORE INTO rota_leave_notices(user_id, year_from, stage, at, data) VALUES(?, ?, ?, ?, ?)").bind(s.userId, s.year.from, due.send, Date.now(), JSON.stringify({ left: s.left, deadline: s.deadline, emailed: emailTo && emailReady(env) ? "yes" : emailTo ? "email off" : "no address" })).run();
      if (!claimed.meta.changes) continue;
      record.push(event(env, s.userId, null, "holiday_reminder", "system", { stage: due.send, label: STAGE_TEXT[due.send], left: s.left, deadline: s.deadline }));
      if (emailTo) {
        const links = await linksFor(env, base, s.userId, "holiday");
        staffMail.push({ to: emailTo as typeof emailTo & { email: string }, kind: "holiday", links, about: `holiday reminder (${STAGE_TEXT[due.send].toLowerCase()})`, mail: holidayReminderEmail({ name: s.name, stage: due.send as Exclude<Stage, "cutoff">, left: s.left, deadline: s.deadline, canRequest: settings.enabled, links }) });
      }
      if (due.send !== "half") forAdmins.push({ name: s.name, left: s.left, stage: STAGE_TEXT[due.send], deadline: s.deadline, cutoff: s.cutoff });
    }
    // An admin's last comfortable day to require the holiday to be taken (notice of twice its length).
    if (s.left > 0 && today >= s.cutoff && today <= s.deadline && !s.sentStages.has("cutoff")) {
      const claimed = await env.DB.prepare("INSERT OR IGNORE INTO rota_leave_notices(user_id, year_from, stage, at, data) VALUES(?, ?, 'cutoff', ?, ?)").bind(s.userId, s.year.from, Date.now(), JSON.stringify({ left: s.left, deadline: s.deadline, admins: true })).run();
      if (claimed.meta.changes && !forAdmins.some((a) => a.name === s.name)) forAdmins.push({ name: s.name, left: s.left, stage: STAGE_TEXT.cutoff, deadline: s.deadline, cutoff: s.cutoff });
    }
  }
  if (record.length) await env.DB.batch(record);
  // The quarter's extra-hours holiday, once, when it's ready to review.
  const q = await quarterAwaiting(env);
  let quarter: string | null = null;
  if (q) {
    const told = await env.DB.prepare("INSERT OR IGNORE INTO rota_leave_notices(user_id, year_from, stage, at, data) VALUES('*', ?, 'accrual-ready', ?, '{}')").bind(q.from, Date.now()).run();
    if (told.meta.changes) quarter = q.label;
  }
  const adminMail: Outgoing[] = [];
  if (forAdmins.length || quarter) {
    const admins = (await env.DB.prepare("SELECT id FROM users WHERE active = 1 AND role = 'admin'").all<{ id: string }>()).results.map((a) => a.id);
    const list = await recipients(env, admins);
    for (const id of admins) {
      const r = list.get(id);
      if (!r || !r.active || !r.email || !prefsOf(r.email_prefs).holiday) continue;
      const links = await linksFor(env, base, id, "holiday");
      adminMail.push({ to: r as typeof r & { email: string }, kind: "holiday", links, about: "holiday left to take", mail: holidayAdminEmail({ name: r.name, people: forAdmins, quarter, links }) });
    }
  }
  for (const o of [...staffMail, ...adminMail]) await sendOutcome(env, o);
  return { sent: staffMail.length + adminMail.length, reminders: staffMail.length, admins: forAdmins.length, quarter };
}

/** Emails each person whose extra-hours holiday was just added, with the workings. */
export async function holidayAddedMail(env: Env, exec: ExecutionContext | undefined, base: Base, quarter: string, added: { userId: string; days: number; extraHours: number; countedHours: number; minimumHours: number; accruedHours: number; dayHours: number }[]) {
  if (!emailReady(env)) return;
  const people = await recipients(env, added.map((a) => a.userId));
  const out: Outgoing[] = [];
  for (const a of added) {
    const r = people.get(a.userId);
    if (!r || !r.active || !r.email || !prefsOf(r.email_prefs).holiday) continue;
    const links = await linksFor(env, base, r.id, "holiday");
    out.push({ to: r as typeof r & { email: string }, kind: "holiday", links, about: `holiday added for extra hours (${quarter})`, mail: holidayAddedEmail({ name: r.name, quarter, ...a, links }) });
  }
  sendAll(env, exec, out);
}
