// "Start next year for everyone" (Holiday management; the owner's request, 18 Nov 2026). Admins only.
//
// GET  /api/rota/leave/next-year  proposes the next leave year for every active person from this year's allowance:
//      the same entitlement, weekday charges and bank-holiday eligibility, with no carry-over, opening balance or
//      bank-holiday dates (the admin checks those in the review). Anyone who started part way through this leave
//      year (users.start_date after this year began) is flagged: this year's entitlement was probably pro-rated, so
//      next year is proposed at the full-year equivalent instead (`fullYearOf`), and the admin must tick it as checked.
// POST /api/rota/leave/next-year  {from, version, people:[{userId, entitlement, weekly, bankHolidayEligible,
//      bankHolidays, partYearChecked}]} creates every listed year at once (one commitLeave batch, so nothing is
//      applied unless all are), refusing anyone who already has that year or whose part-year flag isn't ticked.
import { Env, invalid, json } from "../../http";
import { RotaRequest } from "../types";
import { conflict, isDay, londonToday, text } from "../util";
import { fullYearOf, nextLeaveYear } from "./nextYearMath";
import { AllowanceRow, allowanceData, allowanceInput, amount, commitLeave, event, policy, revision } from "./model";

export async function nextYearRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, route, m } = r;
  if (route !== "leave/next-year") return null;
  r.needAdmin();
  const { settings } = await policy(env);
  const year = nextLeaveYear(londonToday(), settings.yearStart);

  if (m === "GET") return json({ ...year, version: await revision(env), people: await proposals(env, year) });

  if (m === "POST") {
    const b = await r.body(), ver = await revision(env);
    if (b.version !== ver) throw conflict("Holiday information changed while you were reviewing it. Refresh and try again.");
    if (b.from !== year.from) throw conflict("The next leave year has changed. Refresh and try again.");
    if (!Array.isArray(b.people) || !b.people.length || b.people.length > 300) throw invalid("Choose who to start next year for.");
    const current = new Map((await proposals(env, year)).map((p) => [p.userId, p]));
    const seen = new Set<string>();
    const statements: D1PreparedStatement[] = [];
    const reason = text(b.reason, "Reason", 300) || "Started next leave year from this year's allowance";
    for (const item of b.people) {
      const p = current.get(item?.userId);
      if (!p || seen.has(p.userId)) throw invalid("Someone in the list isn't an active employee.");
      seen.add(p.userId);
      if (p.status === "exists") throw conflict(`${p.name} already has a leave year starting ${year.from}. Refresh and try again.`);
      if (p.status !== "ready") throw conflict(`${p.name} has no allowance this year to start from. Set up their leave year by hand.`);
      if (p.partYear && item.partYearChecked !== true) throw conflict(`Check ${p.name}'s full-year allowance first: they started part way through this leave year.`);
      if (!Array.isArray(item.bankHolidays) || item.bankHolidays.some((d: unknown) => !isDay(d))) throw invalid("Choose valid bank-holiday dates.");
      const value = allowanceInput({ unit: "days", entitlement: item.entitlement, weekly: item.weekly, carry: 0, openingUsed: 0, excludedDates: [],
        bankHolidays: item.bankHolidays, bankHolidayEligible: item.bankHolidayEligible === true, note: p.note }, year.from, year.to);
      value.accruals = [];
      statements.push(
        env.DB.prepare("INSERT INTO rota_leave_allowances(user_id,from_day,to_day,data,version,updated_at,updated_by) VALUES(?,?,?,?,1,?,?)").bind(p.userId, year.from, year.to, JSON.stringify(value), Date.now(), r.user.id),
        event(env, p.userId, null, "allowance_updated", r.user.id, { from: year.from, to: year.to, reason, before: null, after: value, startedFrom: p.source?.from ?? null, partYear: p.partYear ?? null }),
      );
    }
    try { await commitLeave(env, ver, statements); }
    catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(e))) throw conflict("Someone's next leave year was set up while you were reviewing. Refresh and try again.");
      throw e;
    }
    return json({ created: seen.size, from: year.from, to: year.to });
  }
  return null;
}

async function proposals(env: Env, year: ReturnType<typeof nextLeaveYear>) {
  const people = (await env.DB.prepare("SELECT id,name,start_date FROM users WHERE active=1 ORDER BY name_key").all<{ id: string; name: string; start_date: string | null }>()).results;
  const rows = (await env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE to_day>=? AND from_day<=? ORDER BY from_day DESC").bind(year.thisFrom, year.to).all<AllowanceRow>()).results;
  return people.map((u) => {
    const mine = rows.filter((a) => a.user_id === u.id);
    const exists = mine.some((a) => a.from_day <= year.to && a.to_day >= year.from);
    // This year's allowance: the one covering the day before next year starts.
    const src = mine.find((a) => a.from_day <= year.thisTo && a.to_day >= year.thisTo);
    if (exists) return { userId: u.id, name: u.name, startDate: u.start_date, status: "exists" as const };
    if (!src) return { userId: u.id, name: u.name, startDate: u.start_date, status: "no-source" as const, startsLater: !!u.start_date && u.start_date >= year.from };
    const a = allowanceData(src), weekly = a.weekly.map(amount);
    const entitlement = amount(a.entitlement);
    const partYear = fullYearOf(entitlement, src.from_day, src.to_day, u.start_date);
    return {
      userId: u.id, name: u.name, startDate: u.start_date, status: "ready" as const, note: a.note,
      source: { from: src.from_day, to: src.to_day, entitlement, weekly, bankHolidayEligible: !!a.bankHolidayEligible, bankHolidays: (a.bankHolidays ?? []).length, carry: amount(a.carry) },
      proposed: { entitlement: partYear ? partYear.fullYear : entitlement, weekly, bankHolidayEligible: !!a.bankHolidayEligible, reserveBankHolidays: (a.bankHolidays ?? []).length > 0 },
      ...(partYear ? { partYear } : {}),
    };
  });
}
