// Hours for a calendar month, for payroll (Rota → Hours → Month; admins only, like the week's hours). Everyone who
// worked or was off in the month: paid hours on the rota (amended on-the-day hours where there are any) by site,
// basic and overtime hours, holiday, sickness, unpaid and unauthorised absence, and two CSVs: one row a person for
// payroll, and every shift for checking it.
//
// Overtime is worked out a week at a time against the person's weekly maximum, as on the week's Hours page, and
// counted in the month the week ends in (its Sunday): a week that runs from one month into the next is paid once,
// with the later month. A month's basic hours are its hours worked less that overtime.
import type { Env } from "../http";
import { invalid, json } from "../http";
import { loadPeople, loadShifts } from "./load";
import { ROTA_SITES, Shift } from "./types";
import { addDays, dateOf, isoOf, londonToday, mondayOf, round2 } from "./util";

export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** The first and last day of a month "YYYY-MM". */
export function monthRange(month: string): { from: string; to: string } {
  const d = dateOf(month + "-01");
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from: month + "-01", to: isoOf(d) };
}

/** The Mondays of the weeks whose Sunday falls in the month: their overtime belongs to it. */
export function payWeeks(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = mondayOf(from); addDays(w, 6) <= to; w = addDays(w, 7)) if (addDays(w, 6) >= from) out.push(w);
  return out;
}

// "other": older time off not yet classified in Holiday management (kind legacy), shown for payroll to check.
const DAY_KINDS = ["annual", "sick", "unpaid", "unauthorised", "other"] as const;
type Kind = (typeof DAY_KINDS)[number];

/** "3 Nov", "3–5 Nov", "28 Nov (half)": a run of days for the CSV. */
function runsText(days: Map<string, number>): string {
  const sorted = [...days.keys()].sort();
  const out: string[] = [];
  const label = (d: string) => `${Number(d.slice(8, 10))} ${dateOf(d).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && addDays(sorted[j], 1) === sorted[j + 1] && days.get(sorted[j + 1]) === 1 && days.get(sorted[i]) === 1) j++;
    const half = days.get(sorted[i])! < 1 ? " (half)" : "";
    out.push(i === j ? label(sorted[i]) + half : `${Number(sorted[i].slice(8, 10))}–${label(sorted[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}

export async function monthHours(env: Env, month: string, format: string | null): Promise<Response> {
  if (!isMonth(month)) throw invalid("Choose a real month.");
  const { from, to } = monthRange(month);
  const weeks = payWeeks(from, to);
  const loadFrom = weeks[0] && weeks[0] < from ? weeks[0] : from;
  const [people, shifts, users, offs, charges, published] = await Promise.all([
    loadPeople(env),
    loadShifts(env, loadFrom, to),
    env.DB.prepare("SELECT id, name, role FROM users").all<{ id: string; name: string; role: string }>(),
    env.DB.prepare("SELECT id, user_id, from_day, to_day, kind, from_time FROM rota_time_off WHERE status = 'approved' AND from_day <= ? AND to_day >= ?")
      .bind(to, from).all<{ id: string; user_id: string; from_day: string; to_day: string; kind: string; from_time: string | null }>(),
    env.DB.prepare("SELECT time_off_id, day, units, unit FROM rota_leave_days WHERE day BETWEEN ? AND ?")
      .bind(from, to).all<{ time_off_id: string; day: string; units: number; unit: string }>().catch(() => ({ results: [] as { time_off_id: string; day: string; units: number; unit: string }[] })),
    env.DB.prepare("SELECT week FROM rota_weeks WHERE published_at IS NOT NULL AND week BETWEEN ? AND ?").bind(mondayOf(from), to).all<{ week: string }>(),
  ]);
  const inMonth = (s: Shift) => s.day >= from && s.day <= to;
  const worked = shifts.filter((s) => s.userId && inMonth(s));

  // Absence by person and kind: the days (1, or ½ for part of a day) and, for holiday, the charge taken.
  type Absence = { days: Map<string, number>; charge: { days: number; hours: number } };
  const absence = new Map<string, Record<Kind, Absence>>();
  const chargesOf = new Map<string, typeof charges.results>();
  for (const c of charges.results) (chargesOf.get(c.time_off_id) || chargesOf.set(c.time_off_id, []).get(c.time_off_id)!).push(c);
  for (const t of offs.results) {
    const kind: Kind | null = t.kind === "legacy" ? "other" : (DAY_KINDS as readonly string[]).includes(t.kind) ? (t.kind as Kind) : null;
    if (!kind) continue;
    const mine = absence.get(t.user_id) || absence.set(t.user_id, Object.fromEntries(DAY_KINDS.map((k) => [k, { days: new Map(), charge: { days: 0, hours: 0 } }])) as Record<Kind, Absence>).get(t.user_id)!;
    const a = mine[kind];
    const saved = chargesOf.get(t.id);
    if (saved?.length) {
      // Saved charges (Holiday management) say which days counted and how much each took.
      for (const c of saved) {
        a.days.set(c.day, Math.max(a.days.get(c.day) || 0, t.from_time ? 0.5 : 1));
        if (c.unit === "hours") a.charge.hours += c.units / 100; else a.charge.days += c.units / 100;
      }
    } else {
      for (let d = t.from_day < from ? from : t.from_day; d <= (t.to_day > to ? to : t.to_day); d = addDays(d, 1)) {
        const was = a.days.get(d) || 0, now = Math.max(was, t.from_time ? 0.5 : 1);
        a.days.set(d, now);
        a.charge.days += now - was; // no saved charge (older records): a calendar day each, half for part of a day
      }
    }
  }

  const ids = new Set<string>([...worked.map((s) => s.userId!), ...absence.keys()]);
  const rows = [...ids].map((id) => {
    const p = people.get(id);
    const u = users.results.find((x) => x.id === id);
    const contractMax = p?.contractMax ?? null;
    const mine = worked.filter((s) => s.userId === id);
    const hours = round2(mine.reduce((h, s) => h + s.hours, 0));
    const overtime = contractMax == null ? 0 : round2(weeks.reduce((o, w) => {
      const h = shifts.filter((s) => s.userId === id && s.day >= w && s.day <= addDays(w, 6)).reduce((t, s) => t + s.hours, 0);
      return o + Math.max(0, h - contractMax);
    }, 0));
    const a = absence.get(id);
    const days = (k: Kind) => round2(a ? [...a[k].days.values()].reduce((t, n) => t + n, 0) : 0);
    const dates = (k: Kind) => (a ? runsText(a[k].days) : "");
    return {
      userId: id, name: p?.name || u?.name || "Someone", role: p?.role || u?.role || "", active: !!p,
      contractMin: p?.contractMin ?? null, contractMax,
      hours, basicHours: round2(Math.max(0, hours - overtime)), overtime,
      plannedHours: round2(mine.reduce((h, s) => h + s.plannedHours, 0)), shifts: mine.length, amended: mine.filter((s) => s.adjusted).length,
      sites: Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(mine.filter((x) => x.site === s.id).reduce((h, x) => h + x.hours, 0))])),
      holidayDays: round2(a?.annual.charge.days || 0),
      holidayHours: round2(a?.annual.charge.hours || 0), holidayDates: dates("annual"),
      sickDays: days("sick"), sickDates: dates("sick"),
      unpaidDays: days("unpaid"), unpaidDates: dates("unpaid"),
      unauthorisedDays: days("unauthorised"), unauthorisedDates: dates("unauthorised"),
      otherDays: days("other"), otherDates: dates("other"),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const today = londonToday();
  const weeksInMonth: string[] = [];
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeksInMonth.push(w);
  const pub = new Set(published.results.map((r) => r.week));
  const draftWeeks = weeksInMonth.filter((w) => !pub.has(w) && shifts.some((s) => s.day >= w && s.day <= addDays(w, 6) && inMonth(s)));

  if (format === "csv" || format === "shifts") {
    const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines: string[] = [];
    if (format === "csv") {
      lines.push(["Name", "Hours worked", "Basic hours", "Overtime hours", "Holiday days", "Holiday hours", "Holiday dates", "Sick days", "Sick dates",
        "Unpaid days", "Unpaid dates", "Unauthorised days", "Unauthorised dates", "Other time off days", "Other time off dates", "Shifts", "Shifts amended", ...ROTA_SITES.map((s) => s.name + " hours"),
        "Contract hours a week", "Still employed"].join(","));
      for (const r of rows) {
        lines.push([r.name, r.hours, r.basicHours, r.overtime, r.holidayDays, r.holidayHours, r.holidayDates, r.sickDays, r.sickDates,
          r.unpaidDays, r.unpaidDates, r.unauthorisedDays, r.unauthorisedDates, r.otherDays, r.otherDates, r.shifts, r.amended, ...ROTA_SITES.map((s) => r.sites[s.id]),
          r.contractMax == null ? "" : r.contractMin != null && r.contractMin !== r.contractMax ? `${r.contractMin}–${r.contractMax}` : r.contractMax,
          r.active ? "Yes" : "No"].map(cell).join(","));
      }
    } else {
      const names = new Map(rows.map((r) => [r.userId, r.name]));
      lines.push(["Date", "Name", "Site", "Planned start", "Planned finish", "Planned break (min)", "Actual start", "Actual finish", "Actual break (min)", "Paid hours", "Amended because"].join(","));
      for (const s of worked) {
        lines.push([s.day, names.get(s.userId!) || "", ROTA_SITES.find((x) => x.id === s.site)?.name || s.site, s.start, s.end, s.breakMins,
          s.adjusted ? s.actualStart : s.start, s.adjusted ? s.actualEnd : s.end, s.adjusted ? s.actualBreakMins ?? s.breakMins : s.breakMins, s.hours,
          s.adjusted ? s.adjustNote : ""].map(cell).join(","));
      }
    }
    const name = format === "csv" ? `payroll-hours-${month}.csv` : `shifts-${month}.csv`;
    return new Response(lines.join("\r\n") + "\r\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` },
    });
  }

  const siteTotals = Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(worked.filter((x) => x.site === s.id).reduce((h, x) => h + x.hours, 0))]));
  const sum = (k: "hours" | "overtime" | "basicHours" | "holidayDays" | "sickDays" | "unpaidDays" | "unauthorisedDays" | "otherDays") => round2(rows.reduce((t, r) => t + r[k], 0));
  return json({
    month, from, to, people: rows, siteTotals,
    total: sum("hours"), basic: sum("basicHours"), overtime: sum("overtime"),
    holidayDays: sum("holidayDays"), sickDays: sum("sickDays"), unpaidDays: sum("unpaidDays"), unauthorisedDays: sum("unauthorisedDays"), otherDays: sum("otherDays"),
    openHours: round2(shifts.filter((s) => !s.userId && inMonth(s)).reduce((h, s) => h + s.hours, 0)),
    draftWeeks, toCome: to >= today ? (from > today ? from : today) : null,
    overtimeWeeks: weeks,
  });
}
