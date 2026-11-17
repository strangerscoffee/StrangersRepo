// Holiday for extra hours, and when to remind people about holiday left to take. Import-free sums, so the unit test
// (test/holiday-accrual-math.test.mjs) runs them directly.
//
// Extra hours: each quarter of the leave year, hours counted above the person's minimum contracted hours earn holiday at
// the GOV.UK irregular-hours rate, 12.07% (5.6 weeks' leave ÷ the 46.4 weeks worked). People on contracts of 42 hours
// or more (judged on their maximum, the owner's decision of 17 Nov 2026) don't earn it. Hours counted: paid hours on
// published rota weeks (amended on-the-day hours where there are any), the planned hours of shifts missed through
// sickness, and an average working day for each day of holiday taken. Unpaid leave isn't counted. The minimum is the
// weekly minimum spread over each day (÷ 7), using the contract in force that day.

export const ACCRUAL_RATE_BP = 1207; // 12.07%, in basis points
export const FULL_TIME_HOURS = 42;
const DAY = 864e5;
const dateOf = (d: string) => new Date(d + "T12:00:00Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(new Date(dateOf(d).getTime() + n * DAY));
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** The same day of the month, n months on (a 31st that doesn't exist becomes the month's last day). */
export function addMonths(day: string, n: number): string {
  const d = dateOf(day), want = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).getUTCDate();
  d.setUTCDate(Math.min(want, last));
  return iso(d);
}
export const daysBetween = (a: string, b: string) => Math.round((dateOf(b).getTime() - dateOf(a).getTime()) / DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1];
/** "Jul–Sep 2026"; "Jan–Mar 2027"; a quarter across a new year names both years. */
export function quarterLabel(from: string, to: string): string {
  return from.slice(0, 4) === to.slice(0, 4) ? `${MONTH(from)}–${MONTH(to)} ${to.slice(0, 4)}` : `${MONTH(from)} ${from.slice(0, 4)}–${MONTH(to)} ${to.slice(0, 4)}`;
}

/** The four quarters of a leave year begin on its start day (MM-DD) and every three months after. */
export function quarterContaining(day: string, yearStart = "04-01"): { from: string; to: string; label: string } {
  let start = (day.slice(5) < yearStart ? Number(day.slice(0, 4)) - 1 : Number(day.slice(0, 4))) + "-" + yearStart;
  while (addMonths(start, 3) <= day) start = addMonths(start, 3);
  const to = addDays(addMonths(start, 3), -1);
  return { from: start, to, label: quarterLabel(start, to) };
}
/** Quarters that have ended, newest first: the one before today's, then earlier ones. */
export function endedQuarters(today: string, yearStart = "04-01", n = 8) {
  const out: { from: string; to: string; label: string }[] = [];
  let q = quarterContaining(today, yearStart);
  for (let i = 0; i < n; i++) { q = quarterContaining(addDays(q.from, -1), yearStart); out.push(q); }
  return out;
}

export interface AccrualDay {
  day: string;
  /** The contract in force that day; null when none is set. */
  contractMin: number | null;
  contractMax: number | null;
  /** Paid hours on published shifts that day (amended hours where there are any). */
  workedHours: number;
  /** Planned hours of shifts missed through sickness (planned − worked), counted as if worked. */
  sickHours: number;
  /** Holiday taken that day, in days (1 or 0.5). */
  holidayDays: number;
}
export type AccrualStatus = "ready" | "full-time" | "no-contract" | "no-hours";
export interface AccrualResult {
  status: AccrualStatus;
  days: number; // days counted (contract under 42 hours, from when the rota starts)
  workedHours: number;
  sickHours: number;
  holidayHours: number;
  countedHours: number;
  minimumHours: number;
  extraHours: number;
  /** An average working day: hours on days worked, ÷ days worked. Holiday days count as this, and it turns hours into days. */
  dayHours: number;
  rateBp: number;
  accruedHours: number;
  accruedDays: number;
  /** Hundredths of a day, the allowance's unit. */
  units: number;
}
const eligible = (d: AccrualDay) => d.contractMin != null && (d.contractMax ?? d.contractMin) < FULL_TIME_HOURS;

export function accrue(days: AccrualDay[]): AccrualResult {
  const counted = days.filter(eligible);
  const empty = (status: AccrualStatus): AccrualResult => ({ status, days: counted.length, workedHours: 0, sickHours: 0, holidayHours: 0, countedHours: 0, minimumHours: 0, extraHours: 0, dayHours: 0, rateBp: ACCRUAL_RATE_BP, accruedHours: 0, accruedDays: 0, units: 0 });
  if (!days.some((d) => d.contractMin != null)) return empty("no-contract");
  if (!counted.length) return empty("full-time");
  const workedDays = counted.filter((d) => d.workedHours > 0);
  const workedHours = round2(counted.reduce((n, d) => n + d.workedHours, 0));
  const dayHours = workedDays.length ? round2(workedHours / workedDays.length) : 0;
  const sickHours = round2(counted.reduce((n, d) => n + d.sickHours, 0));
  const holidayHours = round2(counted.reduce((n, d) => n + d.holidayDays, 0) * dayHours);
  const countedHours = round2(workedHours + sickHours + holidayHours);
  const minimumHours = round2(counted.reduce((n, d) => n + d.contractMin! / 7, 0));
  const extraHours = round2(Math.max(0, countedHours - minimumHours));
  const accruedHours = round2((extraHours * ACCRUAL_RATE_BP) / 10000);
  const accruedDays = dayHours ? round2(accruedHours / dayHours) : 0;
  return { status: workedHours ? "ready" : "no-hours", days: counted.length, workedHours, sickHours, holidayHours, countedHours, minimumHours, extraHours, dayHours, rateBp: ACCRUAL_RATE_BP, accruedHours, accruedDays, units: Math.round(accruedDays * 100) };
}

// --- Holiday left to take: when people are reminded ---
//
// The law lets untaken statutory holiday lapse at the end of the leave year only if the employer gave a reasonable
// opportunity to take it, encouraged the person to, and told them it would be lost. A worker gives notice of twice the
// leave plus a day; an employer can require leave to be taken with notice of twice the leave. So reminders run
// against the leave year's last day: six months before (only if under 40% used or booked), three months, two months,
// one month (the formal notice), and each person's own last date for an admin to require it.

export type Stage = "half" | "three" | "two" | "final" | "cutoff";
export const STAGES: Stage[] = ["half", "three", "two", "final"];
export const STAGE_TEXT: Record<Stage, string> = {
  half: "Halfway through the leave year",
  three: "Three months left",
  two: "Two months left",
  final: "Formal notice: one month left",
  cutoff: "Last date to require holiday",
};
/** The day each reminder is due, for a leave year ending `to`. */
export function stageDates(to: string): Record<Exclude<Stage, "cutoff">, string> {
  const next = addDays(to, 1);
  return { half: addMonths(next, -6), three: addMonths(next, -3), two: addMonths(next, -2), final: addMonths(next, -1) };
}
/** The last day an admin can still require the days left to be taken: notice of twice the leave, the leave itself
 *  (spread over working days), and two weeks to spare for blackouts and full days. */
export function cutoffDate(to: string, leftDays: number): string {
  return addDays(to, -(3 * Math.ceil(Math.max(0, leftDays)) + 14));
}
/** How someone's doing: on track, behind (under the pace of the year so far), or at risk (reminders under way). */
export function riskOf(today: string, b: { from: string; to: string; total: number; takenOrPlanned: number; left: number }): "done" | "on-track" | "behind" | "at-risk" | "act-now" | "ended" {
  if (today > b.to) return "ended";
  if (b.left <= 0) return "done";
  const d = stageDates(b.to);
  if (today >= cutoffDate(b.to, b.left) || today >= d.final) return "act-now";
  if (today >= d.three) return "at-risk";
  const passed = (daysBetween(b.from, today) + 1) / (daysBetween(b.from, b.to) + 1);
  return b.total > 0 && b.takenOrPlanned / b.total < passed * 0.8 ? "behind" : "on-track";
}
/** The reminder to send today, if any: the latest stage that's due and not yet recorded. Earlier ones it skips are
 *  recorded as passed, so starting part-way through a year sends one reminder, not several. */
export function dueReminder(today: string, b: { to: string; total: number; takenOrPlanned: number; left: number }, sent: Set<string>): { send: Stage | null; pass: Stage[] } {
  if (today > b.to || b.left <= 0) return { send: null, pass: [] };
  const d = stageDates(b.to);
  const due = STAGES.filter((s) => d[s as keyof typeof d] <= today && !sent.has(s));
  if (!due.length) return { send: null, pass: [] };
  const latest = due[due.length - 1];
  const pass = due.slice(0, -1);
  // The halfway nudge only goes to people under 40% of their holiday used or booked.
  if (latest === "half" && b.total > 0 && b.takenOrPlanned / b.total >= 0.4) return { send: null, pass: [...pass, "half"] };
  return { send: latest, pass };
}
