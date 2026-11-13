// The diary's daily Slack reminders (src/slackDiary.ts sends them): when each site's morning and end-of-day message
// goes out, and what it says. No imports, so tests load it directly.
//
// Each message says what's still to do at that site, worked out the same way as the diary's Today page
// (public/diary/today.js, siteAttention): today's opening and closing checks, fridge temperatures and the day's
// sign-off; the last trading day if it wasn't signed off; the end-of-week checks and sign-off (last week if it wasn't
// signed off, and this week on its last open day); and cleaning, extra checks, fire safety checks and the 4-weekly
// review that are overdue. Nothing is sent on a day the site is closed. No names: it's for the site's own channel.

export type Slot = "morning" | "evening";
export const SLACK_DIARY_SITES = [
  { id: "cafe", name: "Cafe", channel: "cafe-internal", secret: "SLACK_CAFE_WEBHOOK_URL" },
  { id: "asg", name: "ASG", channel: "asg-internal", secret: "SLACK_ASG_WEBHOOK_URL" },
  { id: "roastery", name: "Roastery", channel: "roastery-internal", secret: "SLACK_ROASTERY_WEBHOOK_URL" },
] as const;

// [morning, evening] in UK time, by weekday (0 = Sunday … 6 = Saturday). The owner's times (13 Nov 2026).
const MON_SAT = (m: string, e: string) => [m, e] as const;
export const SLACK_DIARY_TIMES: Record<string, readonly (readonly [string, string])[]> = {
  cafe: [["09:00", "15:30"], ...Array(6).fill(MON_SAT("09:00", "17:00"))],
  asg: [["10:45", "16:00"], ...Array(5).fill(MON_SAT("08:15", "16:30")), ["09:00", "17:00"]],
  roastery: [["10:45", "16:00"], ...Array(6).fill(MON_SAT("09:00", "17:00"))],
};
/** A message is still sent if the 5-minute cron runs late, but never more than this long after its time. */
export const SEND_WINDOW_MIN = 45;

const DAY = 864e5;
const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const weekdayOf = (date: string) => new Date(date + "T12:00:00Z").getUTCDay();
export const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
export const mondayOf = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7));

/** UK date and minutes past midnight of a moment. */
export function london(at: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const dayOf = (at: number) => london(at).date;

/** The messages due at `now` for a site: its slot time has passed today, by no more than SEND_WINDOW_MIN. */
export function dueSlots(site: string, now: number): { date: string; slot: Slot; time: string }[] {
  const times = SLACK_DIARY_TIMES[site];
  if (!times) return [];
  const { date, minutes } = london(now), [m, e] = times[weekdayOf(date)];
  return ([["morning", m], ["evening", e]] as const).filter(([, t]) => minutes >= hm(t) && minutes < hm(t) + SEND_WINDOW_MIN).map(([slot, time]) => ({ date, slot, time }));
}

/** "Mon–Sat 9:00 and 17:00 · Sun 10:45 and 16:00", for Admin → Sites. */
export function timesText(site: string) {
  const times = SLACK_DIARY_TIMES[site];
  if (!times) return "";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], t = (x: string) => x.replace(/^0/, "");
  const order = [1, 2, 3, 4, 5, 6, 0], groups: { from: number; to: number; key: string }[] = [];
  for (const d of order) {
    const key = times[d].join("|"), last = groups[groups.length - 1];
    if (last && last.key === key && order.indexOf(d) === order.indexOf(last.to) + 1) last.to = d; else groups.push({ from: d, to: d, key });
  }
  return groups.map((g) => `${g.from === g.to ? names[g.from] : `${names[g.from]}–${names[g.to]}`} ${t(times[g.from][0])} and ${t(times[g.from][1])}`).join(" · ");
}

/* ---------- what's still to do ---------- */

type Check = { id: string; t: string; off?: boolean; from?: string };
type Doc = Record<string, any>;
export interface SiteData {
  settings: Doc | null;
  days: Record<string, Doc>;            // day pages from at least 8 days ago to today
  firstDay: string | null;              // the site's earliest day page
  weeks: Record<string, Doc>;           // this week's and last week's pages, by Monday
  tasks: { kind: "cleaning" | "extras" | "fire"; name: string; freq: string; lastAt?: number; importedAt?: number }[];
  lastReview: string | null;            // the latest 4-weekly review's date
}
const FREQ: Record<string, number> = { "after use": 0, daily: 1, weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, "six-monthly": 182, yearly: 365 };
const list = (x: unknown): Check[] => (Array.isArray(x) ? x.filter((c) => c && typeof c.id === "string" && typeof c.t === "string" && !c.off) : []);
const checksOn = (xs: Check[], date: string) => xs.filter((c) => !c.from || c.from <= date);
const closure = (d: Doc | undefined) => !!(d && d.closed && d.closed.reason);

function dayStatus(s: Doc, d: Doc | undefined, date: string) {
  d = d || {};
  const opening = checksOn(list(s.opening), date), closing = checksOn(list(s.closing), date);
  const oi = d.opening?.items || {}, ci = d.closing?.items || {}, units: Doc[] = Array.isArray(s.units) ? s.units : [];
  const tN = units.filter((u) => d!.temps?.[u.id]?.am?.v != null).length;
  const openLeft = opening.filter((c) => !oi[c.id]), closeLeft = closing.filter((c) => !ci[c.id]);
  return { openLeft, closeLeft, oT: opening.length, cT: closing.length, tN, tTot: units.length, signed: !!d.signed,
    any: opening.length - openLeft.length + closing.length - closeLeft.length + tN > 0 || !!d.signed };
}
const closedDay = (s: Doc, date: string) => Array.isArray(s.closedDays) && s.closedDays.includes(weekdayOf(date));
/** Closed with a reason, or a usual closed day with nothing recorded. */
const isShut = (s: Doc, d: Doc | undefined, date: string) => closure(d) || (closedDay(s, date) && !dayStatus(s, d, date).any);

export interface Reminder { site: string; date: string; slot: Slot; closed: boolean; allClear: boolean; text: string }

const fmt = (date: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(new Date(date + "T12:00:00Z"));
const short = (date: string) => fmt(date, { weekday: "short", day: "numeric", month: "short" });
const plural = (n: number, w: string, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
// Slack's own escaping for message text: everything else is shown as typed.
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const names = (xs: Check[], max = 5) => xs.slice(0, max).map((c) => esc(c.t)).join("; ") + (xs.length > max ? `; and ${xs.length - max} more` : "");
const KIND = { cleaning: "Cleaning", extras: "Extra check", fire: "Fire safety" } as const;
const MAX_OVERDUE = 10;

/** The message for one site, at one slot, on `today` (UK date). */
export function buildReminder(site: { id: string; name: string }, data: SiteData, slot: Slot, today: string, diaryUrl: string): Reminder {
  const base = { site: site.id, date: today, slot };
  const s = data.settings;
  if (!s) return { ...base, closed: true, allClear: true, text: "" };
  const t = dayStatus(s, data.days[today], today);
  if (isShut(s, data.days[today], today)) return { ...base, closed: true, allClear: true, text: "" };
  const start: string = (typeof s.startDate === "string" && s.startDate) || data.firstDay || "";
  const hide = s.hide && typeof s.hide === "object" ? s.hide : {};

  const todo: string[] = [], lines: string[] = [];
  const bullet = (done: boolean, text: string) => { lines.push(`${done ? ":white_check_mark:" : ":red_circle:"} ${text}`); if (!done) todo.push(text); };

  // Today
  lines.push(`*Today*`);
  if (t.oT) bullet(!t.openLeft.length, t.openLeft.length ? `Opening checks: ${t.oT - t.openLeft.length} of ${t.oT} done. Still to do: ${names(t.openLeft)}` : "Opening checks done");
  if (t.tTot) bullet(t.tN >= t.tTot, t.tN >= t.tTot ? "Fridge and freezer temperatures recorded" : `Fridge and freezer temperatures: ${t.tN} of ${t.tTot} recorded`);
  if (slot === "evening") {
    if (t.cT) bullet(!t.closeLeft.length, t.closeLeft.length ? `Closing checks: ${t.cT - t.closeLeft.length} of ${t.cT} done. Still to do: ${names(t.closeLeft)}` : "Closing checks done");
    bullet(t.signed, t.signed ? "Day signed off" : "Day not signed off yet");
  }

  // The last trading day before today, if it wasn't signed off (as on Today in the diary).
  let prev: string | null = null;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i), doc = data.days[d];
    if (closure(doc)) continue;
    if (!closedDay(s, d) || dayStatus(s, doc, d).any) { prev = d; break; }
  }
  if (prev && start && prev >= start && !data.days[prev]?.signed) {
    const p = dayStatus(s, data.days[prev], prev), gaps: string[] = [];
    if (p.openLeft.length) gaps.push(`opening checks (${p.openLeft.length} left)`);
    if (p.tN < p.tTot) gaps.push("temperatures");
    if (p.closeLeft.length) gaps.push(`closing checks (${p.closeLeft.length} left)`);
    lines.push(`*${prev === addDays(today, -1) ? "Yesterday" : "Last open day"}, ${short(prev)}*`);
    bullet(false, `Not signed off. ${gaps.length ? `Still to do: ${gaps.join(", ")}, then sign off` : "Everything was ticked; it just needs signing off"}`);
  }

  // End of week: last week if it wasn't signed off; this week on its last open day.
  if (!hide.week) {
    const thisMon = mondayOf(today), lastMon = addDays(thisMon, -7), weekly = list(s.weekly);
    const weekLeft = (mon: string) => { const items = data.weeks[mon]?.items || {}; return checksOn(weekly, addDays(mon, 6)).filter((c) => !items[c.id]); };
    const opened = (mon: string) => Array.from({ length: 7 }, (_, i) => addDays(mon, i)).some((d) => (!start || d >= start) && d < today && !isShut(s, data.days[d], d));
    const week: string[] = [];
    if (start && addDays(lastMon, 6) >= start && opened(lastMon) && !data.weeks[lastMon]?.signed) {
      const left = weekLeft(lastMon);
      week.push(`Last week (w/c ${short(lastMon)}) not signed off.${left.length ? ` End-of-week checks still to do: ${names(left)}` : ""}`);
    }
    const lastOpen = Array.from({ length: 7 }, (_, i) => addDays(thisMon, i)).filter((d) => d >= today && !(closure(data.days[d]) || (d > today && closedDay(s, d)))).pop();
    if (lastOpen === today && !data.weeks[thisMon]?.signed) {
      const left = weekLeft(thisMon);
      week.push(`This week ends today: ${left.length ? `end-of-week checks still to do: ${names(left)}, then sign off the week` : "sign off the week"} (This week in the diary)`);
    }
    if (week.length) { lines.push("*This week*"); for (const w of week) bullet(false, w); }
  }

  // Overdue cleaning, extra checks and fire safety checks, then the 4-weekly review.
  const overdue: { text: string; late: number }[] = [];
  for (const x of data.tasks) {
    if (hide[x.kind]) continue;
    const every = FREQ[x.freq] || 0, basis = x.lastAt || x.importedAt;
    if (!every) continue;
    if (!basis) { overdue.push({ text: `${KIND[x.kind]}: ${esc(x.name || "A task")} (never done)`, late: Infinity }); continue; }
    const due = addDays(dayOf(basis), every);
    if (due >= today) continue;
    const late = Math.round((Date.parse(today) - Date.parse(due)) / DAY);
    overdue.push({ text: `${KIND[x.kind]}: ${esc(x.name || "A task")} (${plural(late, "day")} overdue)`, late });
  }
  overdue.sort((a, b) => b.late - a.late);
  if (!hide.review) {
    const from = data.lastReview || start;
    if (from && addDays(from, 28) < today) overdue.unshift({ text: `4-weekly review (due ${short(addDays(from, 28))})`, late: Infinity });
  }
  if (overdue.length) {
    lines.push(`*Overdue*`);
    for (const o of overdue.slice(0, MAX_OVERDUE)) bullet(false, o.text);
    if (overdue.length > MAX_OVERDUE) lines.push(`…and ${overdue.length - MAX_OVERDUE} more overdue`);
  }

  const allClear = !todo.length;
  const title = slot === "morning" ? `:sunrise: *${esc(site.name)}: morning checks* · ${short(today)}` : `:city_sunset: *${esc(site.name)}: end of the day* · ${short(today)}`;
  const summary = allClear ? (slot === "morning" ? "All on track: nothing outstanding." : "All done for today: checks complete, day signed off and nothing overdue.")
    : `${plural(todo.length, "thing")} to do:`;
  const text = [title, summary, ...(allClear ? [] : lines), `<${diaryUrl}|Open the Kitchen Diary>`].join("\n");
  return { ...base, closed: false, allClear, text };
}
