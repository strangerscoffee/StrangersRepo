import { newId } from "../../auth";
import { Env, invalid } from "../../http";
import { addDays, conflict, dateOf, isDay, londonToday, parseJson, text } from "../util";
import { SITE_IDS } from "../types";
export const LEAVE_TYPES = { annual: "Annual leave", sick: "Sick leave", unpaid: "Unpaid leave", unauthorised: "Unauthorised absence", legacy: "Time off (not classified)" } as const;
export type LeaveKind = keyof typeof LEAVE_TYPES;
export type Unit = "days" | "hours";
export interface Policy {
    enabled: boolean;
    limits: Record<string, number | null>;
    yearStart: string;
    bankHolidayPolicy: "unconfirmed" | "included" | "credit-worked";
}
export const DEFAULT_POLICY: Policy = { enabled: false, limits: {}, yearStart: "04-01", bankHolidayPolicy: "unconfirmed" };
export interface LeaveCredit {
    key: string;
    day: string;
    units: number;
    reason: string;
    at: number;
    reversedAt?: number;
    reversalReason?: string;
}
export interface Allowance {
    credits: LeaveCredit[];
    bankHolidayEligible: boolean;
    bankHolidays: string[];
    unit: Unit;
    entitlement: number;
    carry: number;
    openingUsed: number;
    openingAsOf: string | null;
    weekly: number[];
    excludedDates: string[];
    note: string;
}
export interface AllowanceRow {
    user_id: string;
    from_day: string;
    to_day: string;
    data: string;
    version: number;
    updated_at: number;
    updated_by: string;
}
export interface LeaveRow {
    id: string;
    user_id: string;
    from_day: string;
    to_day: string;
    reason: string;
    status: string;
    kind: LeaveKind;
    version: number;
    created_at: number;
    decided_at: number | null;
    decided_by: string | null;
    request_key: string | null;
    request_payload: string | null;
    from_time: string | null;
    to_time: string | null;
    covered_opening: number;
}
export interface LeaveDay {
    day: string;
    units: number;
    unit: Unit;
    year_start: string;
    time_off_id?: string;
    status?: string;
}
export const amount = (n: number) => n / 100;
/** Store hundredths as integers. Never sum floating-point day/hour balances. */
export function units(value: unknown, label: string, max = 100000, negative = false) {
    if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value)))
        throw invalid(`${label} must be a number with at most two decimal places.`);
    const s = String(value), [whole, fraction = ""] = s.replace(/^-/, "").split(".");
    const n = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * (s.startsWith("-") ? -1 : 1);
    if (!Number.isSafeInteger(n) || n > max || n < (negative ? -max : 0))
        throw invalid(`${label} is outside its allowed range.`);
    return n;
}
export function range(from: unknown, to: unknown, max = 93) {
    if (!isDay(from) || !isDay(to) || to < from)
        throw invalid("Choose a valid first and last day.");
    if ((dateOf(to).getTime() - dateOf(from).getTime()) / 864e5 >= max)
        throw invalid(`Choose up to ${max} days at a time.`);
    return { from: from as string, to: to as string };
}
export function dates(from: string, to: string) {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1))
        out.push(d);
    return out;
}
export const weekday = (day: string) => (dateOf(day).getUTCDay() + 6) % 7;
export function policyInput(b: any): Policy {
    if (typeof b.enabled !== "boolean")
        throw invalid("Choose whether holiday management is enabled.");
    const limits: Record<string, number | null> = {};
    for (const key of ["all", ...SITE_IDS]) {
        const n = b.limits?.[key] ?? null;
        if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999))
            throw invalid("The maximum off must be a whole number from 0 to 999, or no limit.");
        limits[key] = n;
    }
    const yearStart = b.yearStart ?? "04-01";
    if (typeof yearStart !== "string" || !/^\d{2}-\d{2}$/.test(yearStart) || !isDay("2025-" + yearStart))
        throw invalid("Choose a valid leave-year start (not 29 February).");
    const bankHolidayPolicy = b.bankHolidayPolicy ?? "unconfirmed";
    if (!["unconfirmed", "included", "credit-worked"].includes(bankHolidayPolicy))
        throw invalid("Choose the contracted bank-holiday policy.");
    return { enabled: b.enabled, limits, yearStart, bankHolidayPolicy };
}
export async function policy(env: Env) {
    const r = await env.DB.prepare("SELECT data,version FROM rota_leave_settings WHERE id=1").first<{
        data: string;
        version: number;
    }>();
    return { settings: r ? { ...DEFAULT_POLICY, ...parseJson<Policy>(r.data, DEFAULT_POLICY) } : { ...DEFAULT_POLICY }, version: r?.version ?? 0 };
}
export function allowanceInput(b: any, from: string, to: string): Allowance {
    if (b.unit !== "days")
        throw invalid("Holiday allowances are tracked in days.");
    if (!Array.isArray(b.weekly) || b.weekly.length !== 7)
        throw invalid("Set the holiday charge for all seven weekdays.");
    const weekly = b.weekly.map((v: unknown) => units(v, "Daily holiday charge", b.unit === "days" ? 100 : 2400));
    if (!weekly.some((n: number) => n > 0))
        throw invalid("Set at least one working day. Use hours for variable or unequal days.");
    const openingUsed = units(b.openingUsed ?? 0, "Previously used holiday");
    const openingAsOf = openingUsed ? b.openingAsOf : null;
    if (openingUsed && (!isDay(openingAsOf) || openingAsOf < from || openingAsOf > to || openingAsOf > londonToday()))
        throw invalid("Choose the date covered by the opening used balance, within this leave year and no later than today.");
    if (!Array.isArray(b.excludedDates ?? []) || (b.excludedDates ?? []).length > 366)
        throw invalid("Choose valid non-working dates.");
    const excludedDates = [...new Set<string>(b.excludedDates ?? [])].sort();
    if (excludedDates.some(d => !isDay(d) || d < from || d > to))
        throw invalid("Non-working dates must fall within the leave year.");
    if (!Array.isArray(b.bankHolidays ?? []) || (b.bankHolidays ?? []).length > 30)
        throw invalid("Choose up to 30 bank-holiday dates for this leave year.");
    const bankHolidays = [...new Set<string>(b.bankHolidays ?? [])].sort();
    if (bankHolidays.some(d => !isDay(d) || d < from || d > to || (openingAsOf && d <= openingAsOf)))
        throw invalid("Reserved bank holidays must be within this leave year and after the opening used balance date.");
    return { bankHolidays, credits: [], bankHolidayEligible: b.bankHolidayEligible === true, unit: b.unit, entitlement: units(b.entitlement, "Annual entitlement"), carry: units(b.carry ?? 0, "Carry-over"), openingUsed, openingAsOf, weekly, excludedDates, note: text(b.note, "Policy note", 500) };
}
export const allowanceData = (r: AllowanceRow) => JSON.parse(r.data) as Allowance;
export function balance(row: AllowanceRow, days: LeaveDay[], today = londonToday()) {
    const a = allowanceData(row), own = days.filter(d => d.year_start === row.from_day);
    const used = a.openingUsed + own.filter(d => d.status === "approved" && d.day <= today).reduce((n, d) => n + d.units, 0);
    const booked = own.filter(d => d.status === "approved" && d.day > today).reduce((n, d) => n + d.units, 0);
    const pending = own.filter(d => d.status === "requested").reduce((n, d) => n + d.units, 0);
    const credits = (a.credits ?? []).filter(c => !c.reversedAt).reduce((n, c) => n + c.units, 0);
    const total = a.entitlement + a.carry;
    const bankHolidayDates = a.bankHolidayEligible ? (a.bankHolidays ?? []) : [];
    const reservedDates = bankHolidayDates.filter(day => !(a.credits ?? []).some(c => c.day === day && !c.reversedAt) && !own.some(d => d.day === day && ["requested", "approved"].includes(d.status ?? "")));
    const bankHolidayReserved = reservedDates.length * 100;
    return { from: row.from_day, to: row.to_day, unit: a.unit, entitlement: amount(a.entitlement), carry: amount(a.carry), credits: amount(credits), creditHistory: (a.credits ?? []).map(c => ({ ...c, amount: amount(c.units) })), bankHolidayEligible: a.bankHolidayEligible ?? false, total: amount(total), bankHolidays: a.bankHolidays ?? [], bankHolidayReserved: amount(bankHolidayReserved), reservedDates, used: amount(used), booked: amount(booked), pending: amount(pending), remaining: amount(total - used - booked), available: amount(total - used - booked - pending - bankHolidayReserved), openingUsed: amount(a.openingUsed), openingAsOf: a.openingAsOf, weekly: a.weekly.map(amount), excludedDates: a.excludedDates, note: a.note, version: row.version };
}
export async function allowances(env: Env, uid: string) {
    return (await env.DB.prepare("SELECT * FROM rota_leave_allowances WHERE user_id=? ORDER BY from_day DESC").bind(uid).all<AllowanceRow>()).results;
}
export async function chargedDays(env: Env, uid: string, exclude?: string) {
    return (await env.DB.prepare("SELECT d.*,t.status FROM rota_leave_days d JOIN rota_time_off t ON t.id=d.time_off_id WHERE t.user_id=? AND t.status IN ('requested','approved') AND t.id<>?").bind(uid, exclude ?? "").all<LeaveDay>()).results;
}
export function chargeDays(rows: AllowanceRow[], from: string, to: string, portion: number, allowOpeningCoverage = false): LeaveDay[] {
    if (portion !== 1 && portion !== 0.5)
        throw invalid("Choose full days or half days.");
    const out: LeaveDay[] = [];
    let covered = 0;
    for (const day of dates(from, to)) {
        const row = rows.find(r => r.from_day <= day && r.to_day >= day);
        if (!row)
            throw conflict("An admin needs to set your holiday allowance and working pattern for all of these dates first.");
        const a = allowanceData(row);
        if (a.openingAsOf && day <= a.openingAsOf && allowOpeningCoverage) {
            covered++;
            continue;
        }
        if (a.openingAsOf && day <= a.openingAsOf)
            throw conflict("These dates are covered by the previously used holiday balance. An admin must reconcile that balance before recording them separately.");
        const n = a.excludedDates.includes(day) ? 0 : Math.round(a.weekly[weekday(day)] * portion);
        if (n)
            out.push({ day, units: n, unit: a.unit, year_start: row.from_day });
    }
    if (!out.length && !covered)
        throw invalid("These dates contain no chargeable working days in your holiday pattern.");
    return out;
}
export function enoughBalance(rows: AllowanceRow[], existing: LeaveDay[], proposed: LeaveDay[]) {
    for (const start of new Set(proposed.map(d => d.year_start))) {
        const row = rows.find(r => r.from_day === start);
        if (!row)
            throw conflict("This leave year's allowance is no longer available. Ask an admin to review it.");
        const b = balance(row, existing), required = proposed.filter(d => d.year_start === start).reduce((n, d) => n + d.units, 0);
        const releasedReservation = proposed.filter(d => d.year_start === start && b.reservedDates.includes(d.day)).length * 100;
        if (Math.round(b.available * 100) + releasedReservation < required)
            throw conflict(`Not enough holiday available in the leave year starting ${start}. Pending requests also reserve allowance.`);
        if (proposed.some(d => d.year_start === start && d.unit !== b.unit))
            throw conflict("The allowance unit changed. Ask an admin to review this request.");
    }
}
export async function revision(env: Env) {
    return (await env.DB.prepare("SELECT version FROM rota_leave_state WHERE id=1").first<{
        version: number;
    }>())!.version;
}
export function event(env: Env, uid: string | null, id: string | null, action: string, actor: string, data: unknown) {
    return env.DB.prepare("INSERT INTO rota_leave_events(id,user_id,time_off_id,action,at,by_user,data) VALUES(?,?,?,?,?,?,?)").bind(newId(12), uid, id, action, Date.now(), actor, JSON.stringify(data));
}
/** A stale guard fails the whole D1 batch. All leave writers use it, so approvals cannot spend the same allowance/capacity twice. */
export async function commitLeave(env: Env, version: number, statements: D1PreparedStatement[]) {
    try {
        await env.DB.batch([env.DB.prepare("UPDATE rota_leave_state SET version=CASE WHEN version=? THEN version+1 ELSE NULL END WHERE id=1").bind(version), ...statements]);
    }
    catch (error) {
        if (String(error).includes("NOT NULL constraint failed: rota_leave_state.version"))
            throw conflict("Holiday information changed while you were reviewing it. Refresh and try again.");
        throw error;
    }
}
export function requireVersion(actual: number, expected: unknown) {
    if (!Number.isInteger(expected) || actual !== expected)
        throw conflict("This record has changed. Refresh and review it before saving.");
}
export async function ownLeave(env: Env, id: string, uid: string, admin: boolean) {
    // Filter ownership in SQL before even checking existence; never return another person's conflict data.
    return env.DB.prepare("SELECT * FROM rota_time_off WHERE id=? AND (?=1 OR user_id=?)").bind(id, admin ? 1 : 0, uid).first<LeaveRow>();
}
export async function leaveView(env: Env, row: LeaveRow, suppliedDays?: LeaveDay[]) {
    const days = suppliedDays ?? (await env.DB.prepare("SELECT day,units,unit,year_start FROM rota_leave_days WHERE time_off_id=? ORDER BY day").bind(row.id).all<LeaveDay>()).results;
    return { id: row.id, userId: row.user_id, from: row.from_day, to: row.to_day, fromTime: row.from_time, toTime: row.to_time, reason: row.reason, kind: row.kind, label: LEAVE_TYPES[row.kind] ?? "Time off", status: row.status, version: row.version, createdAt: row.created_at, decidedAt: row.decided_at, coveredByOpening: !!row.covered_opening, days: days.map(d => ({ day: d.day, amount: amount(d.units), unit: d.unit, year: d.year_start })) };
}
/** Read list charges once, avoiding one database round trip per absence or an API query-limit failure. */
export async function leaveViews(env: Env, rows: LeaveRow[]) {
    if (!rows.length)
        return [];
    const days = (await env.DB.prepare("SELECT * FROM rota_leave_days WHERE time_off_id IN (SELECT value FROM json_each(?)) ORDER BY day").bind(JSON.stringify(rows.map(r => r.id))).all<LeaveDay>()).results;
    const grouped = new Map<string, LeaveDay[]>();
    for (const day of days) {
        const list = grouped.get(day.time_off_id!) ?? [];
        list.push(day);
        grouped.set(day.time_off_id!, list);
    }
    return Promise.all(rows.map(row => leaveView(env, row, grouped.get(row.id) ?? [])));
}
