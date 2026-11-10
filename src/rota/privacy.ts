// Employee-private rota data is readable by that employee or an admin. Planning permissions must not
// accidentally grant access to another person's hours, availability, leave or private shift notes.
import { User } from "../auth";
import { Problem, Shift } from "./types";

export const canReadEmployee = (user: User, employeeId: string | null) =>
  user.role === "admin" || employeeId === user.id;

/** Unassigned opportunities carry business times, never a former employee's notes or actual hours. */
export function visibleShift(shift: Shift, user: User): Shift | null {
  if (canReadEmployee(user, shift.userId)) return shift;
  if (shift.userId) return null;
  return {
    id: shift.id, site: shift.site, day: shift.day, start: shift.start, end: shift.end,
    breakMins: shift.breakMins, job: shift.job, userId: null, note: "",
    hours: shift.plannedHours, plannedHours: shift.plannedHours, overtime: 0,
    adjusted: false, actualStart: null, actualEnd: null, actualBreakMins: null,
    adjustNote: "", adjustedBy: null, adjustedAt: null,
    updatedAt: shift.updatedAt,
  };
}

/** General coverage problems can reveal somebody else's attendance through their timings. */
export function visibleProblems(problems: Problem[], shifts: Shift[], user: User): Problem[] {
  if (user.role === "admin") return problems;
  const ownIds = new Set(shifts.filter((s) => s.userId === user.id).map((s) => s.id));
  return problems.filter((p) => p.userId === user.id && p.shiftIds.every((id) => ownIds.has(id)));
}
