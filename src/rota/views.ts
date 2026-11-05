// What the rota sends back for a week: the week view, its problems, and the admin section's summary.
import { isRotaManager } from "../access";
import { User } from "../auth";
import { Env } from "../http";
import { loadCtx, weekRow } from "./load";
import { computeProblems, hoursOn, openState } from "./problems";
import { markOvertime } from "./shift";
import { Problem } from "./types";
import { mondayOf } from "./util";

export async function weekView(env: Env, week: string, user: User) {
  const mgr = isRotaManager(user);
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const published = !!row?.published_at;
  const visible = mgr || published;
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
    // Staff see names only: contracts and availability are for managers.
    people: [...ctx.people.values()].map((p) => (mgr ? p : { id: p.id, name: p.name, role: p.role })),
    // Staff see who's on, not other people's overtime or why their hours changed.
    shifts: !visible ? [] : mgr ? inWeek : inWeek.map((s) => (s.userId === user.id ? s : { ...s, overtime: 0, adjustNote: "" })),
    timeOff: mgr ? ctx.timeOff : [],
    problems: mgr ? computeProblems(ctx) : [],
  };
}

/** For the admin section (src/adminView.ts): a week's shifts (with overtime), its problems, sites and people. */
export async function rotaWeekSummary(env: Env, week: string) {
  const [ctx, row] = await Promise.all([loadCtx(env, week), weekRow(env, week)]);
  const shifts = markOvertime(ctx.shifts.filter((s) => s.day >= ctx.days[0] && s.day <= ctx.days[6]), ctx.people);
  return { week, published: !!row?.published_at, shifts, problems: computeProblems(ctx), people: ctx.people, sites: [...ctx.sites.values()] };
}

export async function weekProblems(env: Env, day: string) {
  const week = mondayOf(day);
  return { week, problems: computeProblems(await loadCtx(env, week)) };
}
/** After a shift write: the week, and its problems only when asked (?with=problems). The rota page redraws the whole
 * week afterwards, so working them out on every save would be wasted (five reads and the checks). */
export const afterWrite = (env: Env, day: string, withProblems: boolean) =>
  withProblems ? weekProblems(env, day) : Promise.resolve({ week: mondayOf(day) } as { week: string; problems?: Problem[] });
