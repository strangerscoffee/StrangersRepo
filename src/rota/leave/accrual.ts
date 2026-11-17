// Holiday for extra hours (Holiday management → Extra hours; admins only). After each quarter of the leave year, the
// hours each person counted above their minimum contract earn holiday at 12.07% (the sums: accrualMath.ts). An admin
// reviews the quarter and approves it; each person's holiday is then added to the leave year that starts after the
// quarter's last day (so January–March goes into the next year), recorded on the allowance with its workings and
// emailed to them. Nothing is added without approval, each quarter is added once, and an admin can reverse one with
// a reason.
import { Env, invalid, json } from "../../http";
import { RotaRequest } from "../types";
import { loadShifts } from "../load";
import { conflict, londonToday, notFound, text } from "../util";
import { AccrualDay, accrue, addDays, endedQuarters, quarterContaining, quarterLabel, round2 } from "./accrualMath";
import { AllowanceRow, LeaveAccrual, allowanceData, balance, chargedDays, commitLeave, dates, event, policy, requireVersion, revision } from "./model";
import { holidayAddedMail } from "./notify";

const keyOf = (quarter: string) => "hours:" + quarter;

interface PersonRow { id: string; name: string; contract_min: number | null; contract_max: number | null }

/** Everyone's figures for one quarter, from the rota and Holiday management as they stand now. */
export async function quarterFigures(env: Env, quarterFrom: string) {
  const { settings } = await policy(env);
  const q = quarterContaining(quarterFrom, settings.yearStart);
  if (q.from !== quarterFrom) throw invalid("Choose one of the leave year's quarters.");
  const today = londonToday();
  if (q.to >= today) throw invalid("This quarter hasn't finished yet.");
  const creditDay = addDays(q.to, 1);
  const [people, history, shifts, published, firstWeek, firstShift, offs, charges, rows] = await Promise.all([
    env.DB.prepare("SELECT u.id, u.name, p.contract_min, p.contract_max FROM users u LEFT JOIN rota_people p ON p.user_id = u.id WHERE u.active = 1 ORDER BY u.name_key").all<PersonRow>(),
    env.DB.prepare("SELECT user_id, from_day, contract_min, contract_max FROM rota_contract_history WHERE from_day <= ? ORDER BY user_id, from_day").bind(q.to).all<{ user_id: string; from_day: string; contract_min: number | null; contract_max: number | null }>(),
    loadShifts(env, q.from, q.to).then((list) => ({ results: list.filter((s) => s.userId) })),
    env.DB.prepare("SELECT week FROM rota_weeks WHERE published_at IS NOT NULL AND week BETWEEN ? AND ?").bind(addDays(q.from, -6), q.to).all<{ week: string }>(),
    env.DB.prepare("SELECT MIN(week) AS w FROM rota_weeks WHERE published_at IS NOT NULL").first<{ w: string | null }>(),
    env.DB.prepare("SELECT user_id, MIN(day) AS d FROM rota_shifts WHERE user_id IS NOT NULL GROUP BY user_id").all<{ user_id: string; d: string }>(),
    env.DB.prepare("SELECT id, user_id, from_day, to_day, kind, from_time FROM rota_time_off WHERE status = 'approved' AND kind IN ('annual','sick') AND from_day <= ? AND to_day >= ?").bind(q.to, q.from).all<{ id: string; user_id: string; from_day: string; to_day: string; kind: string; from_time: string | null }>(),
    env.DB.prepare("SELECT d.time_off_id, d.day, d.units FROM rota_leave_days d JOIN rota_time_off t ON t.id = d.time_off_id WHERE t.status = 'approved' AND t.kind = 'annual' AND d.day BETWEEN ? AND ?").bind(q.from, q.to).all<{ time_off_id: string; day: string; units: number }>(),
    env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE from_day <= ? AND to_day >= ?").bind(creditDay, creditDay).all<AllowanceRow>(),
  ]);
  const pub = new Set(published.results.map((w) => w.week));
  const mondayOf = (d: string) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
  const unpublished = [...new Set(shifts.results.map((s) => mondayOf(s.day)))].filter((w) => !pub.has(w)).sort();
  const rotaStart = firstWeek?.w ?? null;
  const out = people.results.map((p) => {
    const contracts = history.results.filter((h) => h.user_id === p.id);
    const contractOn = (d: string) => {
      const c = [...contracts].reverse().find((h) => h.from_day <= d);
      return c ? { min: c.contract_min, max: c.contract_max } : { min: p.contract_min, max: p.contract_max };
    };
    const first = firstShift.results.find((f) => f.user_id === p.id)?.d ?? null;
    const from = [q.from, rotaStart ? rotaStart : q.to, first ?? addDays(q.to, 1)].sort().pop()!;
    const sick = offs.results.filter((t) => t.user_id === p.id && t.kind === "sick");
    const sickOn = (d: string) => sick.some((t) => t.from_day <= d && t.to_day >= d);
    const holidays = new Map<string, number>();
    const mine = new Set(offs.results.filter((t) => t.user_id === p.id && t.kind === "annual").map((t) => t.id));
    for (const c of charges.results) if (mine.has(c.time_off_id)) holidays.set(c.day, (holidays.get(c.day) || 0) + c.units / 100);
    const days: AccrualDay[] = from > q.to ? [] : dates(from, q.to).map((day) => {
      const c = contractOn(day);
      let workedHours = 0, sickHours = 0;
      for (const s of shifts.results) {
        if (s.userId !== p.id || s.day !== day || !pub.has(mondayOf(day))) continue;
        workedHours += s.hours; // amended on-the-day hours where there are any
        if (sickOn(day)) sickHours += Math.max(0, s.plannedHours - s.hours);
      }
      return { day, contractMin: c.min, contractMax: c.max, workedHours, sickHours, holidayDays: holidays.get(day) || 0 };
    });
    const result = accrue(days);
    const row = rows.results.find((r) => r.user_id === p.id) ?? null;
    const added = row ? (allowanceData(row).accruals ?? []).find((a) => a.key === keyOf(q.from) && !a.reversedAt) ?? null : null;
    const contract = contractOn(q.to);
    return {
      userId: p.id, name: p.name, contractMin: contract.min, contractMax: contract.max, countedFrom: days[0]?.day ?? null, ...result,
      year: row ? { from: row.from_day, to: row.to_day, version: row.version } : null,
      added: added ? { units: added.units, days: added.units / 100, at: added.at } : null,
    };
  });
  return { quarter: q, creditDay, rotaStart, unpublished, rateBp: 1207, people: out };
}

export async function accrualRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, route, m, q } = r;
  if (!route.startsWith("leave/accrual")) return null;
  r.needAdmin();
  if (route === "leave/accrual" && m === "GET") {
    const { settings } = await policy(env);
    const quarters = endedQuarters(londonToday(), settings.yearStart, 8);
    const pick = q("quarter") || quarters[0].from;
    const figures = await quarterFigures(env, pick);
    return json({ ...figures, quarters, version: await revision(env) });
  }
  if (route === "leave/accrual" && m === "POST") {
    const b = await r.body(), ver = await revision(env);
    requireVersion(ver, b.ifVersion);
    if (!Array.isArray(b.people) || !b.people.length || b.people.length > 200) throw invalid("Choose who to add holiday for.");
    const figures = await quarterFigures(env, b.quarter);
    const stmts: D1PreparedStatement[] = [], added: typeof figures.people = [];
    const now = Date.now();
    for (const want of b.people) {
      const p = figures.people.find((x) => x.userId === want?.userId);
      if (!p) throw notFound("Someone in this list is no longer active. Review the quarter again.");
      if (p.added) continue; // already added: approving again changes nothing
      if (p.status !== "ready" || !p.units) throw conflict(`${p.name} has no holiday to add for this quarter. Review it again.`);
      if (want.units !== p.units) throw conflict(`${p.name}'s hours changed since you reviewed this quarter. Review it again before adding.`);
      if (!p.year) throw conflict(`Set up ${p.name}'s leave year starting by ${figures.creditDay} first: this quarter's holiday goes into it.`);
      const row = (await env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE user_id = ? AND from_day = ?").bind(p.userId, p.year.from).first<AllowanceRow>())!;
      const a = allowanceData(row);
      const accrual: LeaveAccrual = {
        key: keyOf(figures.quarter.from), quarter: figures.quarter.from, quarterTo: figures.quarter.to, label: figures.quarter.label, units: p.units,
        workedHours: p.workedHours, sickHours: p.sickHours, holidayHours: p.holidayHours, countedHours: p.countedHours, minimumHours: p.minimumHours,
        extraHours: p.extraHours, dayHours: p.dayHours, rateBp: p.rateBp, accruedHours: p.accruedHours, at: now, by: r.user.id,
      };
      a.accruals = [...(a.accruals ?? []), accrual];
      stmts.push(
        env.DB.prepare("UPDATE rota_leave_allowances SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE user_id = ? AND from_day = ? AND version = ?").bind(JSON.stringify(a), now, r.user.id, p.userId, row.from_day, row.version),
        event(env, p.userId, null, "hours_accrued", r.user.id, { quarter: figures.quarter.from, label: figures.quarter.label, year: row.from_day, days: p.units / 100, extraHours: p.extraHours, countedHours: p.countedHours, minimumHours: p.minimumHours, dayHours: p.dayHours, rate: "12.07%" }),
      );
      added.push(p);
    }
    if (stmts.length) await commitLeave(env, ver, stmts);
    if (added.length) await holidayAddedMail(env, r.exec, r.mailLinks, figures.quarter.label, added.map((p) => ({ userId: p.userId, days: p.units / 100, extraHours: p.extraHours, countedHours: p.countedHours, minimumHours: p.minimumHours, accruedHours: p.accruedHours, dayHours: p.dayHours }))).catch(() => {});
    return json({ added: added.length, quarter: figures.quarter });
  }
  if (route === "leave/accrual/reverse" && m === "POST") {
    const b = await r.body(), ver = await revision(env);
    const row = await env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE user_id = ? AND from_day = ?").bind(String(b.userId ?? ""), String(b.year ?? "")).first<AllowanceRow>();
    if (!row) throw notFound("That leave year is not available.");
    requireVersion(row.version, b.ifVersion);
    const a = allowanceData(row), item = (a.accruals ?? []).find((c) => c.key === b.key && !c.reversedAt);
    if (!item) throw conflict("That holiday for extra hours has already been taken off.");
    const reason = text(b.reason, "Reason for the correction", 300);
    if (!reason) throw invalid("Say why this holiday is being taken off.");
    item.reversedAt = Date.now();
    item.reversalReason = reason;
    const updated = { ...row, data: JSON.stringify(a), version: row.version + 1 };
    if (balance(updated, await chargedDays(env, row.user_id)).available < 0) throw conflict("Taking this off would leave less holiday than is already booked or requested. Sort those out first.");
    await commitLeave(env, ver, [
      env.DB.prepare("UPDATE rota_leave_allowances SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE user_id = ? AND from_day = ? AND version = ?").bind(updated.data, Date.now(), r.user.id, row.user_id, row.from_day, row.version),
      event(env, row.user_id, null, "hours_accrual_reversed", r.user.id, { year: row.from_day, quarter: item.quarter, days: item.units / 100, reason }),
    ]);
    return json({ ok: true });
  }
  return null;
}

/** For the Overview and the daily reminder run: the last quarter, once it's had a week to settle, while nobody has
 *  approved it (up to three months on). */
export async function quarterAwaiting(env: Env): Promise<{ from: string; to: string; label: string } | null> {
  const { settings } = await policy(env);
  const today = londonToday(), last = endedQuarters(today, settings.yearStart, 1)[0];
  if (today < addDays(last.to, 7) || today > addDays(last.to, 90)) return null;
  // Nothing to review for a quarter before the rota was in use.
  const first = await env.DB.prepare("SELECT MIN(week) AS w FROM rota_weeks WHERE published_at IS NOT NULL").first<{ w: string | null }>();
  if (!first?.w || first.w > last.to) return null;
  const done = await env.DB.prepare("SELECT 1 FROM rota_leave_events WHERE action = 'hours_accrued' AND json_extract(data, '$.quarter') = ? LIMIT 1").bind(last.from).first();
  return done ? null : last;
}
export { quarterLabel, round2 };
