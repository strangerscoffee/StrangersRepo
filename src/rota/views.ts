// What the rota sends back for a week: the week view, its problems, and the admin section's summary.
import { User } from "../auth";
import { Env } from "../http";
import { loadCtx, weekRow } from "./load";
import { computeProblems, hoursOn, openState } from "./problems";
import { visibleProblems, visibleShift } from "./privacy";
import { markOvertime } from "./shift";
import { Problem } from "./types";
import { mondayOf } from "./util";

export async function weekView(env: Env, week: string, user: User) {
  const admin = user.role === "admin";
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const published = !!row?.published_at;
  const visible = admin || published;
  const inWeek = markOvertime(ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]), ctx.people);
  return {
    week,
    days: ctx.days,
    published,
    publishedAt: row?.published_at ?? null,
    changesSincePublish: published ? row?.changes ?? 0 : 0,
    sites: [...ctx.sites.values()].map((s) => ({
      id: s.id, name: s.name, inUse: s.inUse, opensAt: s.opensAt, closesAt: s.closesAt, minPeople: s.minPeople, dayHours: s.dayHours,
      hours: ctx.days.map((d) => hoursOn(s, d)),
      open: ctx.days.map((d) => openState(ctx, s.id, d).open),
      closedWhy: ctx.days.map((d) => { const st = openState(ctx, s.id, d); return st.open ? null : ctx.closures.get(s.id)?.[d] || null; }),
    })),
    people: [...ctx.people.values()].filter((p) => admin || p.id === user.id),
    shifts: !visible ? [] : inWeek.map((s) => visibleShift(s, user)).filter((s): s is NonNullable<typeof s> => s !== null),
    timeOff: ctx.timeOff.filter((t) => admin || t.userId === user.id),
    problems: !visible ? [] : visibleProblems(computeProblems(ctx), ctx.shifts, user),
  };
}

/** For the admin section (src/adminView.ts): a week's shifts (with overtime), its problems, sites and people. */
export async function rotaWeekSummary(env: Env, week: string) {
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const shifts = markOvertime(ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]), ctx.people);
  return { week, published: !!row?.published_at, shifts, problems: computeProblems(ctx), people: ctx.people, sites: [...ctx.sites.values()] };
}

export async function weekProblems(env: Env, day: string, user: User) {
  const week = mondayOf(day);
  const ctx = await loadCtx(env, week);
  return { week, problems: visibleProblems(computeProblems(ctx), ctx.shifts, user) };
}
/** After a shift write: the week, and its problems only when asked (?with=problems). The rota page redraws the whole
 * week afterwards, so working them out on every save would be wasted (five reads and the checks). */
export const afterWrite = (env: Env, day: string, withProblems: boolean, user: User) =>
  withProblems ? weekProblems(env, day, user) : Promise.resolve({ week: mondayOf(day) } as { week: string; problems?: Problem[] });
