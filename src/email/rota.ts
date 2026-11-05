// Which rota emails go to whom (docs/data-model.md, "Rota emails"):
// - publishing a week: everyone with shifts gets their week; publishing it again after changes, only the people
//   whose shifts changed since they were last emailed (rota_weeks.emailed keeps what each was told), with what
//   changed; and people who turned on open-shift emails hear about new open shifts they're free for;
// - a cover or pick-up request approved or declined: the person who asked and the person taking it;
// - time off approved or declined: the person who asked.
import { Env } from "../http";
import { loadCtx } from "../rota/load";
import { Ctx, DAY_KEYS, ROTA_SITES, ReqRow, Shift } from "../rota/types";
import { londonToday } from "../rota/util";
import { EmailKind, Outgoing, Recipient, emailReady, linksFor, recipients, sendAll, wants } from "./send";
import { Change, MailShift, changedEmail, openShiftsEmail, publishedEmail, requestEmail, shiftsCalendar, shortDay, timeOffEmail } from "./templates";

type Base = { rota: string; diary: string };
type Snap = { id: string; day: string; start: string; end: string; site: string; job: string; hours: number };
interface Emailed { people: Record<string, Snap[]>; open: string[] }

const siteName = (id: string) => ROTA_SITES.find((s) => s.id === id)?.name || id;
const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) => a.start < b.end && b.start < a.end;

function mailShift(s: Shift | Snap, ctx: Ctx | null, userId: string | null): MailShift {
  const others = ctx ? ctx.shifts.filter((o) => o.id !== s.id && o.day === s.day && o.site === s.site && o.userId && o.userId !== userId && overlaps(o, s)) : [];
  const names = [...new Set(others.map((o) => ctx!.people.get(o.userId!)?.name.split(" ")[0]).filter((n): n is string => !!n))];
  return { id: s.id, day: s.day, start: s.start, end: s.end, site: s.site, siteName: siteName(s.site), job: s.job || "", hours: s.hours, with: names };
}
const snap = (s: Shift): Snap => ({ id: s.id, day: s.day, start: s.start, end: s.end, site: s.site, job: s.job || "", hours: s.hours });
const same = (a: Snap, b: Snap) => a.day === b.day && a.start === b.start && a.end === b.end && a.site === b.site && a.job === b.job;

export interface WeekPlan {
  first: boolean; // the week hasn't been emailed before
  people: { userId: string; kind: "published" | "changed"; shifts: Shift[]; changes: Change[] }[];
  open: { userId: string; shifts: Shift[] }[];
  noAddress: string[]; // people who'd get one but have no email address
  snapshot: Emailed;
  ctx: Ctx;
}

/** Who the week's emails would go to, and what each would say, compared with what was last emailed. */
export async function planWeek(env: Env, week: string): Promise<WeekPlan> {
  const ctx = await loadCtx(env, week);
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
      if (!old) changes.push({ kind: "added", shift: mailShift(s, ctx, uid) });
      else if (!same(old, snap(s))) changes.push({ kind: "moved", shift: mailShift(s, ctx, uid), was: old.day === s.day ? `${old.start}–${old.end}` : `${shortDay(old.day)} ${old.start}–${old.end}` });
    }
    for (const w of was) if (!cur.some((s) => s.id === w.id)) changes.push({ kind: "removed", shift: mailShift(w, null, uid) });
    if (changes.length) people.push({ userId: uid, kind: "changed", shifts: cur, changes: changes.sort((a, b) => (a.shift.day + a.shift.start).localeCompare(b.shift.day + b.shift.start)) });
  }
  // Open shifts still ahead that nobody has been told about, for each person free to take them.
  const today = londonToday(), told = new Set(before?.open || []);
  const openNew = inWeek.filter((s) => !s.userId && s.day >= today && !told.has(s.id));
  const open: WeekPlan["open"] = [];
  if (openNew.length) for (const p of ctx.people.values()) {
    const fits = openNew.filter((s) => {
      const dayKey = DAY_KEYS[(new Date(s.day + "T12:00:00Z").getUTCDay() + 6) % 7];
      if (p.pattern?.[dayKey] === "off") return false;
      if (p.sites?.length && !p.sites.includes(s.site)) return false;
      if (inWeek.some((o) => o.userId === p.id && o.day === s.day)) return false;
      return !ctx.timeOff.some((t) => t.userId === p.id && t.status === "approved" && t.from <= s.day && t.to >= s.day);
    });
    if (fits.length) open.push({ userId: p.id, shifts: fits });
  }
  const snapshot: Emailed = { people: Object.fromEntries(Object.entries(now).map(([u, xs]) => [u, xs.map(snap)])), open: [...told, ...openNew.map((s) => s.id)] };
  const who = await recipients(env, people.map((p) => p.userId));
  const noAddress = people.map((p) => who.get(p.userId)).filter((r) => r && r.active && !r.email).map((r) => r!.name);
  return { first: !before, people, open, noAddress, snapshot, ctx };
}

/** Sends the week's emails (in the background) and records what was sent. Returns how many go out. */
export async function sendWeek(env: Env, exec: ExecutionContext | undefined, plan: WeekPlan, week: string, base: Base, by: { name: string; email?: string | null }): Promise<number> {
  const who = await recipients(env, [...plan.people.map((p) => p.userId), ...plan.open.map((o) => o.userId)]);
  const out: Outgoing[] = [];
  for (const p of plan.people) {
    const r = who.get(p.userId), kind: EmailKind = p.kind;
    if (!wants(r, kind)) continue;
    const person = plan.ctx.people.get(p.userId);
    const shifts = p.shifts.map((s) => mailShift(s, plan.ctx, p.userId));
    const links = await linksFor(env, base, p.userId, kind);
    const common = { name: r.name, week, shifts, contractMin: person?.contractMin ?? null, contractMax: person?.contractMax ?? null, links };
    const mail = p.kind === "published" ? publishedEmail(common) : changedEmail({ ...common, changes: p.changes, by: by.name });
    out.push({ to: r, kind, mail, links, replyTo: by.email, about: p.kind === "published" ? `the week of ${week} published` : `changes to the week of ${week}`,
      calendar: shifts.length ? shiftsCalendar(shifts, base.rota) : undefined });
  }
  for (const o of plan.open) {
    const r = who.get(o.userId);
    if (!wants(r, "open")) continue;
    const links = await linksFor(env, base, o.userId, "open");
    out.push({ to: r, kind: "open", mail: openShiftsEmail({ name: r.name, shifts: o.shifts.map((s) => mailShift(s, plan.ctx, null)), links }), links, replyTo: by.email, about: `open shifts in the week of ${week}` });
  }
  await env.DB.prepare("UPDATE rota_weeks SET emailed = ? WHERE week = ?").bind(JSON.stringify(plan.snapshot), week).run();
  sendAll(env, exec, out);
  return emailReady(env) ? out.length : 0;
}

/** A cover or pick-up request approved or declined: emails the person who asked and the person taking it. */
export async function requestDecided(env: Env, exec: ExecutionContext | undefined, base: Base, r: ReqRow, approved: boolean, shift: Shift, by: { name: string; email?: string | null }) {
  if (!emailReady(env)) return;
  const kind = r.kind === "claim" ? "claim" : "cover";
  const ids = [r.from_user, ...(r.taker && r.taker !== r.from_user ? [r.taker] : [])];
  const who = await recipients(env, ids);
  const ctx = await loadCtx(env, mondayOf(shift.day)).catch(() => null);
  const asker = who.get(r.from_user), taker = r.taker ? who.get(r.taker) : undefined;
  const ms = mailShift(shift, ctx, null);
  const out: Outgoing[] = [];
  const add = async (to: Recipient | undefined, role: "asker" | "taker", other: string) => {
    if (!wants(to, "requests")) return;
    const links = await linksFor(env, base, to.id, "requests");
    out.push({ to, kind: "requests", links, replyTo: by.email, about: `${kind === "claim" ? "pick-up" : "cover"} on ${shift.day} ${approved ? "approved" : "declined"}`,
      mail: requestEmail({ name: to.name, role, kind, approved, shift: ms, other, by: by.name, links }) });
  };
  await add(asker, "asker", taker?.name || "Someone");
  if (kind === "cover" && taker) await add(taker, "taker", asker?.name || "a colleague");
  sendAll(env, exec, out);
}

/** Time off approved or declined: emails the person who asked. */
export async function timeOffDecided(env: Env, exec: ExecutionContext | undefined, base: Base, t: { user_id: string; from_day: string; to_day: string }, approved: boolean, by: { name: string; email?: string | null }) {
  if (!emailReady(env)) return;
  const r = (await recipients(env, [t.user_id])).get(t.user_id);
  if (!wants(r, "requests")) return;
  const links = await linksFor(env, base, r.id, "requests");
  sendAll(env, exec, [{ to: r, kind: "requests", links, replyTo: by.email, about: `time off from ${t.from_day} ${approved ? "approved" : "declined"}`,
    mail: timeOffEmail({ name: r.name, from: t.from_day, to: t.to_day, approved, by: by.name, links }) }]);
}

const mondayOf = (d: string) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };

/** The person acting, as a sender: their name, and their address for replies. */
export async function actor(env: Env, user: { id: string; name: string }) {
  const r = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(user.id).first<{ email: string | null }>();
  return { name: user.name, email: r?.email || null };
}
