// Which rota emails go to whom (docs/data-model.md, "Rota emails"):
// - publishing a week: everyone with shifts gets their week; publishing it again after changes, only the people
//   whose shifts changed since the last email batch (rota_weeks.emailed keeps its snapshot), with what
//   changed; and people who turned on open-shift emails hear about new open shifts they're free for;
// - a cover or pick-up request approved or declined: the person who asked and the person taking it;
// - time off approved or declined: the person who asked.
import { Env } from "../http";
import { loadCtx } from "../rota/load";
import { canOfferOpenShift } from "../rota/problems";
import { Ctx, ROTA_SITES, ReqRow, Shift } from "../rota/types";
import { londonToday } from "../rota/util";
import { EmailKind, Outgoing, Recipient, emailReady, linksFor, prefsOf, recipients, sendAll, wants } from "./send";
import { deliverStaffEmails, enqueueStaffEmails, type StaffEmail } from "./staffOutbox";
import { Change, MailShift, changedEmail, openShiftsEmail, publishedEmail, requestEmail, shiftsCalendar, shortDay, timeOffEmail, leaveDatesEmail } from "./templates";

type Base = { rota: string; diary: string };
type Snap = { id: string; day: string; start: string; end: string; site: string; job: string; hours: number };
interface Emailed { people: Record<string, Snap[]>; open: string[] }

const siteName = (id: string) => ROTA_SITES.find((s) => s.id === id)?.name || id;
function mailShift(s: Shift | Snap): MailShift {
  // The addressee sees their own assignment only. Co-worker names also expose another employee's rota through
  // HTML, plain text and calendar attachments, even when the interactive app hides that person's shift.
  return { id: s.id, day: s.day, start: s.start, end: s.end, site: s.site, siteName: siteName(s.site), job: s.job || "", hours: s.hours, with: [] };
}
const snap = (s: Shift): Snap => ({ id: s.id, day: s.day, start: s.start, end: s.end, site: s.site, job: s.job || "", hours: s.hours });
const same = (a: Snap, b: Snap) => a.day === b.day && a.start === b.start && a.end === b.end && a.site === b.site && a.job === b.job;

export interface WeekPlan {
  first: boolean;
  previous: string | null;
  people: { userId: string; kind: "published" | "changed"; shifts: Shift[]; changes: Change[] }[];
  open: { userId: string; shifts: Shift[] }[];
  noAddress: string[]; // people who'd get one but have no email address
  snapshot: Emailed;
  ctx: Ctx;
}

/** Recipients and changes since the rota was last queued for email. */
export async function planWeek(env: Env, week: string, context?: Ctx): Promise<WeekPlan> {
  const ctx = context || await loadCtx(env, week);
  const row = await env.DB.prepare("SELECT emailed FROM rota_weeks WHERE week = ?").bind(week).first<{ emailed: string | null }>();
  let before: Emailed | null = null;
  try { before = row?.emailed ? JSON.parse(row.emailed) : null; } catch {}
  const inWeek = ctx.shifts.filter((s) => ctx.days.includes(s.day));
  const now: Record<string, Shift[]> = {};
  for (const s of inWeek) if (s.userId) (now[s.userId] ||= []).push(s);
  const ids = new Set([...Object.keys(now), ...Object.keys(before?.people || {})]);
  const people: WeekPlan["people"] = [];
  for (const uid of ids) {
    const cur = now[uid] || [];
    if (!before) { if (cur.length) people.push({ userId: uid, kind: "published", shifts: cur, changes: [] }); continue; }
    const was = before.people[uid] || [];
    const changes: Change[] = [];
    for (const s of cur) {
      const old = was.find((w) => w.id === s.id);
      if (!old) changes.push({ kind: "added", shift: mailShift(s) });
      else if (!same(old, snap(s))) changes.push({ kind: "moved", shift: mailShift(s), was: old.day === s.day ? `${old.start}–${old.end}` : `${shortDay(old.day)} ${old.start}–${old.end}` });
    }
    for (const w of was) if (!cur.some((s) => s.id === w.id)) changes.push({ kind: "removed", shift: mailShift(w) });
    if (changes.length) people.push({ userId: uid, kind: "changed", shifts: cur, changes: changes.sort((a, b) => (a.shift.day + a.shift.start).localeCompare(b.shift.day + b.shift.start)) });
  }
  // Open shifts still ahead that nobody has been told about, for each person free to take them.
  const today = londonToday(), told = new Set(before?.open || []);
  const openNew = inWeek.filter((s) => !s.userId && s.day >= today && !told.has(s.id));
  const open: WeekPlan["open"] = [];
  if (openNew.length) for (const p of ctx.people.values()) {
    const fits = openNew.filter(s => canOfferOpenShift(ctx, p, s));
    if (fits.length) open.push({ userId: p.id, shifts: fits });
  }
  const snapshot: Emailed = { people: Object.fromEntries(Object.entries(now).map(([u, xs]) => [u, xs.map(snap)])), open: [...told, ...openNew.map((s) => s.id)] };
  const who = await recipients(env, [...people.map(p => p.userId), ...open.map(p => p.userId)]);
  const noAddress = new Set<string>();
  for (const p of [...people, ...open.map(p => ({ ...p, kind: "open" as const }))]) {
    const r = who.get(p.userId);
    if (r?.active && !r.email && prefsOf(r.email_prefs)[p.kind]) noAddress.add(r.name);
  }
  return { first: !before, previous: row?.emailed ?? null, people: people.filter(p => wants(who.get(p.userId), p.kind)),
    open: open.filter(p => wants(who.get(p.userId), "open")), noAddress: [...noAddress], snapshot, ctx };
}

/** Records the snapshot and each recipient's mail together, then delivers the queued messages. */
export async function sendWeek(env: Env, exec: ExecutionContext | undefined, plan: WeekPlan, week: string, base: Base, by: { name: string }, publication: { at: number; snapshot: string }): Promise<number> {
  if (!emailReady(env)) return 0;
  const who = await recipients(env, [...plan.people.map((p) => p.userId), ...plan.open.map((o) => o.userId)]);
  const jobs: StaffEmail[] = [];
  for (const p of plan.people) {
    const r = who.get(p.userId), kind: EmailKind = p.kind;
    if (!wants(r, kind)) continue;
    const person = plan.ctx.people.get(p.userId);
    const shifts = p.shifts.filter((s) => s.userId === p.userId).map(mailShift);
    const links = await linksFor(env, base, p.userId, kind);
    const common = { name: r.name, week, shifts, contractMin: person?.contractMin ?? null, contractMax: person?.contractMax ?? null, links };
    const mail = p.kind === "published" ? publishedEmail(common) : changedEmail({ ...common, changes: p.changes, by: by.name });
    jobs.push({ outgoing: { to: r, kind, mail, links, about: p.kind === "published" ? `the week of ${week} published` : `changes to the week of ${week}`,
      calendar: shifts.length ? shiftsCalendar(shifts, base.rota) : undefined } });
  }
  for (const o of plan.open) {
    const r = who.get(o.userId);
    if (!wants(r, "open")) continue;
    const links = await linksFor(env, base, o.userId, "open");
    jobs.push({ outgoing: { to: r, kind: "open", mail: openShiftsEmail({ name: r.name, shifts: o.shifts.map(mailShift), links }), links, about: `open shifts in the week of ${week}` },
      open: { week, shiftIds: o.shifts.map(s => s.id) } });
  }
  const scope = `rota:${week}`, batchKey = `${scope}:${crypto.randomUUID()}`;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE rota_weeks SET emailed=? WHERE week=? AND emailed IS ? AND published_at=? AND published_shifts=?")
      .bind(JSON.stringify(plan.snapshot), week, plan.previous, publication.at, publication.snapshot),
    enqueueStaffEmails(env, batchKey, jobs, scope),
    env.DB.prepare(`UPDATE staff_email_outbox SET state=CASE WHEN uncertain=1 THEN 'unknown' ELSE 'skipped' END,
      payload='{}',last_error='A newer rota email superseded this one.'
      WHERE scope=? AND batch_key<>? AND state IN ('queued','retry') AND kind IN ('published','changed')
      AND user_id IN (SELECT user_id FROM staff_email_outbox WHERE batch_key=? AND kind IN ('published','changed'))`)
      .bind(scope, batchKey, batchKey),
  ]);
  const queued = results[1].meta.changes || 0;
  if (queued) {
    const delivery = deliverStaffEmails(env, batchKey).catch(error => console.error("Rota email delivery will retry", error));
    if (exec) exec.waitUntil(delivery); else await delivery;
  }
  return queued;
}

/** A cover or pick-up request approved or declined: emails the person who asked and the person taking it. */
export async function requestDecided(env: Env, exec: ExecutionContext | undefined, base: Base, r: ReqRow, approved: boolean, shift: Shift, by: { name: string }) {
  if (!emailReady(env) || !shift) return;
  const kind = r.kind === "claim" ? "claim" : "cover";
  const ids = [r.from_user, ...(r.taker && r.taker !== r.from_user ? [r.taker] : [])];
  const who = await recipients(env, ids);
  const asker = who.get(r.from_user), taker = r.taker ? who.get(r.taker) : undefined;
  // A taker must never inherit the previous employee's amended hours or notes. Decision mail uses only the
  // planned assignment; the template omits assignment details altogether when a cover taker is declined.
  const ms = mailShift({ ...shift, hours: shift.plannedHours });
  const out: Outgoing[] = [];
  const add = async (to: Recipient | undefined, role: "asker" | "taker") => {
    if (!wants(to, "requests")) return;
    const links = await linksFor(env, base, to.id, "requests");
    out.push({ to, kind: "requests", links, about: `${kind === "claim" ? "pick-up" : "cover"} ${approved ? "approved" : "declined"}`,
      mail: requestEmail({ name: to.name, role, kind, approved, shift: ms, by: by.name, links }) });
  };
  await add(asker, "asker");
  if (kind === "cover" && taker) await add(taker, "taker");
  sendAll(env, exec, out);
}

/** Time off approved or declined: emails the person who asked. */
export async function timeOffDecided(env: Env, exec: ExecutionContext | undefined, base: Base, t: { user_id: string; from_day: string; to_day: string }, approved: boolean, by: { name: string }) {
  if (!emailReady(env)) return;
  const r = (await recipients(env, [t.user_id])).get(t.user_id);
  if (!wants(r, "requests")) return;
  const links = await linksFor(env, base, r.id, "requests");
  sendAll(env, exec, [{ to: r, kind: "requests", links, about: `time off from ${t.from_day} ${approved ? "approved" : "declined"}`,
    mail: timeOffEmail({ name: r.name, from: t.from_day, to: t.to_day, approved, by: by.name, links }) }]);
}

/** An admin changed the dates of someone's holiday or other absence: tell them the new dates (and the old). */
export async function leaveDatesChanged(env: Env, exec: ExecutionContext | undefined, base: Base, t: { user_id: string; kind: string; status: string },
  before: { from: string; to: string; fromTime: string | null; toTime: string | null }, after: { from: string; to: string; fromTime: string | null; toTime: string | null }, by: { name: string }) {
  if (!emailReady(env)) return;
  const r = (await recipients(env, [t.user_id])).get(t.user_id);
  if (!wants(r, "requests")) return;
  const links = await linksFor(env, base, r.id, "requests");
  sendAll(env, exec, [{ to: r, kind: "requests", links, about: `absence dates changed to ${after.from}`,
    mail: leaveDatesEmail({ name: r.name, kind: t.kind, pending: t.status === "requested", before, after, by: by.name, links }) }]);
}

/** The person acting, for attribution only. A private account email is never a shared reply address. */
export async function actor(_env: Env, user: { id: string; name: string }) {
  return { name: user.name };
}
