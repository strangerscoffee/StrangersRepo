// A shift as stored and as the API sends it: paid hours, when someone is actually there, and overtime.
import { Person, Shift, ShiftRow } from "./types";
import { mins, mondayOf, round2 } from "./util";

export const paidHours = (s: { start: string; end: string; breakMins: number }) => round2(Math.max(0, mins(s.end) - mins(s.start) - s.breakMins) / 60);
export const toShift = (r: ShiftRow): Shift => {
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
export const effStart = (s: Shift) => s.actualStart ?? s.start;
export const effEnd = (s: Shift) => s.actualEnd ?? s.end;

/** Marks the hours over each person's maximum as overtime, shift by shift in time order, a week at a time. */
export function markOvertime(shifts: Shift[], people: Map<string, Person>): Shift[] {
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
