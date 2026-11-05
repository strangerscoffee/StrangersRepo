// The rota's checks ("problems"): what's wrong with a week, and what giving someone a shift would cause.
import { effEnd, effStart } from "./shift";
import { BREAK_AFTER_MINS, BREAK_MINS, Ctx, DAY_KEYS, Hours, Person, Problem, REST_MINS, Shift, SiteInfo, TimeOff } from "./types";
import { addDays, contractText, dateOf, dayName, dow, fmtH, hhmm, mins, round2, shortDay, siteName } from "./util";

/** A site's opening hours on a day: that weekday's own hours if it has them, otherwise the usual ones. */
export function hoursOn(site: SiteInfo, day: string): Hours {
  return site.dayHours[DAY_KEYS[dow(day)]] || { opensAt: site.opensAt, closesAt: site.closesAt };
}

/** Whether a site is open on a day: in use (has a Setup), not a usual closed day, not a planned closure. */
export function openState(ctx: Pick<Ctx, "sites" | "closures">, site: string, day: string): { open: boolean; reason?: string } {
  const s = ctx.sites.get(site)!;
  if (!s.inUse) return { open: false, reason: `${s.name} isn't set up in the diary yet` };
  if (s.closedDays.includes(dateOf(day).getUTCDay())) return { open: false, reason: `${s.name} is closed on ${dayName(day)}s` };
  const reason = ctx.closures.get(site)?.[day];
  if (reason) return { open: false, reason: `${s.name} is closed on ${shortDay(day)} (${reason})` };
  return { open: true };
}

/* ---------- checks ("problems") ---------- */

/** Short names in messages: first names, unless two people share one. */
export function namer(people: Map<string, Person>) {
  const firsts = new Map<string, number>();
  for (const p of people.values()) { const f = p.name.split(" ")[0]; firsts.set(f, (firsts.get(f) || 0) + 1); }
  return (id: string | null | undefined) => {
    const p = id ? people.get(id) : null;
    if (!p) return "Someone";
    const f = p.name.split(" ")[0];
    return (firsts.get(f) || 0) > 1 ? p.name : f;
  };
}
export const overlaps = (a: Shift, b: Shift) => a.day === b.day && mins(a.start) < mins(b.end) && mins(b.start) < mins(a.end);
export const onTimeOff = (t: TimeOff[], uid: string, day: string) => t.find((x) => x.userId === uid && x.from <= day && x.to >= day);

export function availabilityIssue(p: Person, s: Shift): string | null {
  const pat = p.pattern?.[DAY_KEYS[dow(s.day)]];
  if (pat === "off") return `can't usually work on ${dayName(s.day)}s`;
  if (pat && typeof pat === "object") {
    if ((pat.from && mins(s.start) < mins(pat.from)) || (pat.to && mins(s.end) > mins(pat.to))) {
      return `usually works ${dayName(s.day)}s ${pat.from || "any time"}–${pat.to || "late"}`;
    }
  }
  return null;
}
export const siteIssue = (p: Person, s: Shift) => (p.sites?.length && !p.sites.includes(s.site) ? `doesn't usually work at ${siteName(s.site)}` : null);

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
export function effectsFor(ctx: Ctx, shift: Shift, uid: string): { problems: Problem[]; hours: number } {
  const moved = { ...shift, userId: uid };
  const shifts = ctx.shifts.map((s) => (s.id === shift.id ? moved : s));
  if (!shifts.some((s) => s.id === shift.id)) shifts.push(moved);
  const all = computeProblems({ ...ctx, shifts });
  // Being short of their minimum isn't a reason not to give someone a shift.
  const problems = all.filter((p) => p.userId === uid && p.kind !== "under_contract" && (p.kind === "overtime" || p.shiftIds.includes(shift.id)));
  const hours = round2(shifts.filter((s) => s.userId === uid && s.day >= ctx.days[0] && s.day <= ctx.days[6]).reduce((h, s) => h + s.hours, 0));
  return { problems, hours };
}
export const blocking = (ps: Problem[]) => ps.find((p) => p.kind === "clash" || p.kind === "time_off");
