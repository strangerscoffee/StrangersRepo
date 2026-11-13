// Staff receive their own balances/absence records. A separate allowlist exposes only approved holiday names/dates.
import { newId } from "../../auth";
import { ApiError, invalid, json } from "../../http";
import { activeUser, touchWeek } from "../load";
import { RotaRequest, SITE_IDS } from "../types";
import { actor, timeOffDecided } from "../../email/rota";
import { addDays, conflict, denied, isDay, isTime, londonToday, mondayOf, notFound, text } from "../util";
import { AllowanceRow, LEAVE_TYPES, LeaveDay, LeaveKind, LeaveRow, allowanceData, allowanceInput, allowances, amount, balance, chargeDays, chargedDays, commitLeave, dates, enoughBalance, event, leaveView, leaveViews, ownLeave, policy, policyInput, range, requireVersion, revision } from "./model";
import { calendarRules, checkCalendar, employeeSites } from "./rules";
const canRequest = (kind: string) => kind === "annual" || kind === "unpaid";
const writeWeeks = (r: RotaRequest, from: string, to: string) => [...new Set(dates(from, to).map(mondayOf))].map(w => touchWeek(r.env, w));
async function person(r: RotaRequest, id: unknown) {
    if (id !== undefined && id !== r.user.id)
        r.needAdmin();
    return id === undefined || id === r.user.id ? r.user.id : activeUser(r.env, id);
}
async function prepare(r: RotaRequest, b: any, uid: string, exclude?: string, allowOpeningCoverage = false) {
    const { from, to } = range(b.from, b.to), kind = b.kind ?? "annual";
    if (!Object.hasOwn(LEAVE_TYPES, kind) || kind === "legacy")
        throw invalid("Choose an absence type.");
    if (!r.admin && !canRequest(kind))
        throw denied("Only an admin can record this type of absence.");
    if (!r.admin && from < londonToday())
        throw invalid("Ask an admin to record absence that has already started.");
    const { settings } = await policy(r.env);
    if (!settings.enabled)
        throw conflict("Holiday management is awaiting admin setup.");
    const portion = b.portion ?? 1;
    if (portion !== 1 && portion !== 0.5)
        throw invalid("Choose a full or half day.");
    const fromTime = portion === 0.5 ? b.fromTime : null, toTime = portion === 0.5 ? b.toTime : null;
    if (portion === 0.5 && (from !== to || !isTime(fromTime) || !isTime(toTime) || toTime <= fromTime))
        throw invalid("A half day needs one date and the actual start and finish of the absence.");
    const overlap = await r.env.DB.prepare("SELECT id FROM rota_time_off WHERE user_id=? AND id<>? AND status IN ('requested','approved') AND from_day<=? AND to_day>=? AND (? IS NULL OR from_time IS NULL OR (from_time<? AND to_time>?)) LIMIT 1").bind(uid, exclude ?? "", to, from, fromTime, toTime, fromTime).first();
    if (overlap)
        throw conflict("There is already an absence request or booking for these dates.");
    let days: LeaveDay[] = [];
    if (kind === "annual") {
        const rows = await allowances(r.env, uid);
        days = chargeDays(rows, from, to, portion, allowOpeningCoverage);
        enoughBalance(rows, await chargedDays(r.env, uid, exclude), days);
        await checkCalendar(r.env, from, to, settings, uid, days, exclude);
    }
    const shifts = (await r.env.DB.prepare("SELECT id,day,site,start,end FROM rota_shifts WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day,start").bind(uid, from, to).all()).results;
    return { uid, from, to, fromTime, toTime, kind: kind as LeaveKind, reason: text(b.reason, "Private note", 200), days, shifts: shifts.filter((s: any) => !fromTime || (s.start < toTime && s.end > fromTime)) };
}
export async function createLeave(r: RotaRequest, b: any) {
    const uid = await person(r, b.userId), ver = await revision(r.env);
    const key = b.requestKey;
    if (typeof key !== "string" || !/^[\w-]{8,100}$/.test(key))
        throw invalid("Send a valid request key so this absence cannot be saved twice.");
    const payload = JSON.stringify({ from: b.from, to: b.to, kind: b.kind ?? "annual", portion: b.portion ?? 1, fromTime: b.fromTime ?? null, toTime: b.toTime ?? null, reason: typeof b.reason === "string" ? b.reason.trim() : "", approved: r.admin && b.approved === true, expectedCharges: b.expectedCharges ?? null });
    const previous = await r.env.DB.prepare("SELECT * FROM rota_time_off WHERE user_id=? AND request_key=?").bind(uid, key).first<LeaveRow>();
    if (previous) {
        if (previous.request_payload !== payload)
            throw conflict("This request key was already used for different dates or details.");
        return json({ absence: await leaveView(r.env, previous), replayed: true });
    }
    const p = await prepare(r, b, uid);
    if (p.kind === "annual" && JSON.stringify(b.expectedCharges) !== JSON.stringify(p.days.map(d => ({ day: d.day, amount: amount(d.units), unit: d.unit, year: d.year_start }))))
        throw conflict("The holiday charge changed or has not been reviewed. Review these dates again before submitting.");
    const id = newId(10), now = Date.now();
    const status = r.admin && b.approved === true ? "approved" : "requested";
    await commitLeave(r.env, ver, [
        r.env.DB.prepare("INSERT INTO rota_time_off(id,user_id,from_day,to_day,reason,status,decided_by,decided_at,created_at,kind,version,request_key,request_payload,from_time,to_time) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)").bind(id, uid, p.from, p.to, p.reason, status, status === "approved" ? r.user.id : null, status === "approved" ? now : null, now, p.kind, key, payload, p.fromTime, p.toTime),
        ...p.days.map(d => r.env.DB.prepare("INSERT INTO rota_leave_days(time_off_id,day,units,unit,year_start) VALUES(?,?,?,?,?)").bind(id, d.day, d.units, d.unit, d.year_start)),
        event(r.env, uid, id, "created", r.user.id, { kind: p.kind, status, from: p.from, to: p.to }),
        ...writeWeeks(r, p.from, p.to),
    ]);
    return json({ absence: await leaveView(r.env, (await ownLeave(r.env, id, r.user.id, r.admin))!), shiftConflicts: p.shifts });
}
export async function decideLeave(r: RotaRequest, id: string, b: any) {
    const ver = await revision(r.env), t = await ownLeave(r.env, id, r.user.id, r.admin);
    if (!t)
        throw notFound("That absence is not available.");
    requireVersion(t.version, b.ifVersion);
    const status = b.status;
    if (status === "cancelled") {
        if (t.covered_opening && !r.admin)
            throw denied("Ask an admin to reconcile this absence with the opening holiday balance.");
        if (!["requested", "approved"].includes(t.status))
            throw conflict("That absence is already settled.");
        if (!r.admin && t.status === "approved" && t.from_day < londonToday())
            throw denied("Ask an admin to change absence that has started.");
        if (!r.admin && t.kind !== "annual" && t.kind !== "unpaid")
            throw denied("An admin manages this absence record.");
    }
    else if (status === "approved" || status === "declined") {
        r.needAdmin();
        if (t.status !== "requested")
            throw conflict("That absence is already settled.");
    }
    else
        throw invalid("Choose approve, decline or cancel.");
    let days = (await r.env.DB.prepare("SELECT * FROM rota_leave_days WHERE time_off_id=?").bind(id).all<LeaveDay>()).results;
    let kind = t.kind;
    // Existing unclassified leave remains private and consumes no invented allowance. Admins explicitly classify it.
    if (status === "approved" && kind === "legacy") {
        const { settings } = await policy(r.env);
        if (settings.enabled) {
            if (!b.kind || b.kind === "legacy")
                throw invalid("Classify this existing time off as annual, sick, unpaid or unauthorised before approving it.");
            const p = await prepare(r, { from: t.from_day, to: t.to_day, kind: b.kind, reason: t.reason }, t.user_id, id, b.coveredByOpening === true);
            kind = p.kind;
            days = p.days;
        }
    }
    if (status === "approved" && kind === "annual") {
        const { settings } = await policy(r.env);
        enoughBalance(await allowances(r.env, t.user_id), await chargedDays(r.env, t.user_id, id), days);
        await checkCalendar(r.env, t.from_day, t.to_day, settings, t.user_id, days, id);
    }
    const stmts = [r.env.DB.prepare("UPDATE rota_time_off SET status=?,kind=?,covered_opening=?,version=version+1,decided_by=?,decided_at=? WHERE id=?").bind(status, kind, t.covered_opening || (t.kind === "legacy" && kind === "annual" && b.coveredByOpening === true ? 1 : 0), r.user.id, Date.now(), id)];
    if (t.kind === "legacy" && kind !== "legacy")
        stmts.push(...days.map(d => r.env.DB.prepare("INSERT INTO rota_leave_days(time_off_id,day,units,unit,year_start) VALUES(?,?,?,?,?)").bind(id, d.day, d.units, d.unit, d.year_start)));
    await commitLeave(r.env, ver, [...stmts, event(r.env, t.user_id, id, status, r.user.id, { from: t.from_day, to: t.to_day, kind }), ...writeWeeks(r, t.from_day, t.to_day)]);
    if (status === "approved" || status === "declined")
        await timeOffDecided(r.env, r.exec, r.mailLinks, t, status === "approved", await actor(r.env, r.user)).catch(() => { });
    return json({ absence: await leaveView(r.env, (await ownLeave(r.env, id, r.user.id, r.admin))!) });
}
export async function leaveRoutes(r: RotaRequest): Promise<Response | null> {
    const { env, route, m, q, seg, user } = r;
    if (!route.startsWith("leave/"))
        return null;
    if (route === "leave/dashboard" && m === "GET") {
        const uid = await person(r, q("userId") ?? undefined);
        const [p, rows, days, absences, legacy] = await Promise.all([
            policy(env), allowances(env, uid), chargedDays(env, uid),
            env.DB.prepare("SELECT * FROM rota_time_off WHERE user_id=? ORDER BY from_day DESC LIMIT 300").bind(uid).all<LeaveRow>(),
            env.DB.prepare("SELECT COUNT(*) AS n FROM rota_time_off WHERE user_id=? AND kind='legacy' AND status IN ('requested','approved')").bind(uid).first<{
                n: number;
            }>(),
        ]);
        return json({ today: londonToday(), userId: uid, enabled: p.settings.enabled, yearStart: p.settings.yearStart, bankHolidayPolicy: p.settings.bankHolidayPolicy, balances: rows.map(row => balance(row, days)), absences: await leaveViews(env, absences.results), legacyCount: legacy?.n ?? 0, types: Object.entries(LEAVE_TYPES).filter(([k]) => k !== "legacy" && (r.admin || canRequest(k))).map(([id, label]) => ({ id, label })) });
    }
    if (route === "leave/calendar" && m === "GET") {
        const { from, to } = range(q("from"), q("to"), 93), { settings } = await policy(env);
        const sites = await employeeSites(env, user.id);
        const rows = settings.enabled ? (await env.DB.prepare("SELECT u.name,t.user_id,t.from_day,t.to_day FROM rota_time_off t JOIN users u ON u.id=t.user_id WHERE t.kind='annual' AND t.status='approved' AND u.active=1 AND t.from_day<=? AND t.to_day>=? ORDER BY t.from_day,u.name_key").bind(to, from).all<{
            name: string;
            user_id: string;
            from_day: string;
            to_day: string;
        }>()).results : [];
        // Explicit, narrow exception to employee privacy: names/dates of approved annual leave only.
        return json({ from, to, enabled: settings.enabled, holidays: rows.flatMap(t => dates(t.from_day < from ? from : t.from_day, t.to_day > to ? to : t.to_day).map(day => ({ name: t.name, day, mine: t.user_id === user.id }))), days: settings.enabled ? await calendarRules(env, from, to, settings, sites) : [] });
    }
    if (seg[1] === "requests" && seg.length === 3 && m === "GET") {
        const t = await ownLeave(env, seg[2], user.id, r.admin);
        if (!t)
            throw notFound("That absence is not available.");
        const [rows, days, shifts] = await Promise.all([allowances(env, t.user_id), chargedDays(env, t.user_id), env.DB.prepare("SELECT id,day,site,start,end FROM rota_shifts WHERE user_id=? AND day BETWEEN ? AND ? ORDER BY day,start").bind(t.user_id, t.from_day, t.to_day).all<{
                id: string;
                day: string;
                site: string;
                start: string;
                end: string;
            }>()]);
        return json({ absence: await leaveView(env, t), balances: rows.filter(a => a.from_day <= t.to_day && a.to_day >= t.from_day).map(a => balance(a, days)), shiftConflicts: shifts.results.filter(s => !t.from_time || !t.to_time || (s.start < t.to_time && s.end > t.from_time)) });
    }
    if (route === "leave/preview" && m === "POST") {
        const b = await r.body(), uid = await person(r, b.userId), p = await prepare(r, b, uid);
        return json({ from: p.from, to: p.to, kind: p.kind, days: p.days.map(d => ({ day: d.day, amount: amount(d.units), unit: d.unit, year: d.year_start })), shiftConflicts: p.shifts });
    }
    if (route === "leave/requests" && m === "POST")
        return createLeave(r, await r.body());
    if (seg[1] === "requests" && seg.length === 3 && m === "PATCH")
        return decideLeave(r, seg[2], await r.body());
    // Every remaining route is private employee administration; check before parsing IDs or returning data.
    r.needAdmin();
    if (seg[1] === "requests" && seg[3] === "classify" && seg.length === 4 && m === "PATCH") {
        const ver = await revision(env), b = await r.body(), t = await ownLeave(env, seg[2], user.id, true);
        if (!t)
            throw notFound("That absence is not available.");
        requireVersion(t.version, b.ifVersion);
        if (t.kind !== "legacy" || t.status !== "approved")
            throw conflict("Only an existing approved, unclassified absence needs this reconciliation.");
        if (!b.kind || b.kind === "legacy" || !Object.hasOwn(LEAVE_TYPES, b.kind))
            throw invalid("Choose the original absence type explicitly.");
        const why = text(b.changeReason, "Reconciliation reason", 300);
        if (!why)
            throw invalid("Record why this historical absence is being classified.");
        let days: LeaveDay[] = [];
        if (b.kind === "annual") {
            const rows = await allowances(env, t.user_id);
            days = chargeDays(rows, t.from_day, t.to_day, 1, b.coveredByOpening === true);
            enoughBalance(rows, await chargedDays(env, t.user_id, t.id), days);
        }
        await commitLeave(env, ver, [env.DB.prepare("UPDATE rota_time_off SET kind=?,covered_opening=?,version=version+1 WHERE id=?").bind(b.kind, b.kind === "annual" && b.coveredByOpening === true ? 1 : 0, t.id), ...days.map(d => env.DB.prepare("INSERT INTO rota_leave_days(time_off_id,day,units,unit,year_start) VALUES(?,?,?,?,?)").bind(t.id, d.day, d.units, d.unit, d.year_start)), event(env, t.user_id, t.id, "legacy_classified", user.id, { kind: b.kind, reason: why, coveredByOpening: b.coveredByOpening === true })]);
        return json({ absence: await leaveView(env, (await ownLeave(env, t.id, user.id, true))!) });
    }
    if (route === "leave/bank-holidays" && m === "GET") {
        const { from, to } = range(q("from"), q("to"), 366);
        try {
            // The fixed public feed receives no employee identifiers, account data or request dates.
            const response = await fetch("https://www.gov.uk/bank-holidays.json", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), cf: { cacheTtl: 3600, cacheEverything: true } });
            if (!response.ok)
                throw new Error("feed unavailable");
            const source = await response.text();
            if (source.length > 131072)
                throw new Error("feed too large");
            const feed = JSON.parse(source), events = feed?.["england-and-wales"]?.events;
            if (!Array.isArray(events))
                throw new Error("invalid feed");
            const holidays = events.filter((e: any) => isDay(e?.date) && e.date >= from && e.date <= to && typeof e.title === "string").map((e: any) => ({ day: e.date, title: e.title.slice(0, 120) }));
            return json({ region: "England and Wales", source: "https://www.gov.uk/bank-holidays", holidays });
        }
        catch {
            throw new ApiError(503, "unavailable", "The government bank-holiday calendar is unavailable. Your form is unchanged; enter dates manually or try again later.");
        }
    }
    if (route === "leave/admin" && m === "GET") {
        const p = await policy(env), today = londonToday();
        const people = (await env.DB.prepare("SELECT id,name FROM users WHERE active=1 ORDER BY name_key").all<{
            id: string;
            name: string;
        }>()).results;
        const rows = (await env.DB.prepare("SELECT * FROM rota_time_off WHERE status='requested' ORDER BY from_day").all<LeaveRow>()).results;
        const blocks = (await env.DB.prepare("SELECT id,from_day AS 'from',to_day AS 'to',site,title,version FROM rota_leave_blocks ORDER BY from_day DESC LIMIT 300").all()).results;
        const configured = new Set((await env.DB.prepare("SELECT DISTINCT user_id FROM rota_leave_allowances WHERE from_day<=? AND to_day>=?").bind(today, today).all<{
            user_id: string;
        }>()).results.map(a => a.user_id));
        const requestViews = await leaveViews(env, rows);
        return json({ settings: p.settings, version: p.version, people, requests: requestViews.map(t => ({ ...t, name: people.find(p => p.id === t.userId)?.name ?? "Inactive employee" })), blocks, setup: people.map(p => ({ userId: p.id, name: p.name, configured: configured.has(p.id) })) });
    }
    if (route === "leave/settings" && m === "PUT") {
        const ver = await revision(env), b = await r.body(), old = await policy(env);
        requireVersion(old.version, b.ifVersion);
        const settings = policyInput(b);
        await commitLeave(env, ver, [env.DB.prepare("INSERT INTO rota_leave_settings(id,data,version,updated_at,updated_by) VALUES(1,?,1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=rota_leave_settings.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(JSON.stringify(settings), Date.now(), user.id), event(env, null, null, "policy_updated", user.id, { before: old.settings, after: settings })]);
        return json(await policy(env));
    }
    if (route === "leave/allowances" && m === "PUT") {
        const ver = await revision(env), b = await r.body(), uid = await activeUser(env, b.userId), { from, to } = range(b.from, b.to, 366);
        const rows = await allowances(env, uid), old = rows.find(a => a.from_day === from);
        requireVersion(old?.version ?? 0, b.ifVersion);
        if (rows.some(a => a.from_day !== from && a.from_day <= to && a.to_day >= from))
            throw conflict("Leave years for this employee cannot overlap.");
        const value = allowanceInput(b, from, to);
        value.credits = old ? (allowanceData(old).credits ?? []) : [];
        const reason = text(b.changeReason, "Reason for this allowance change", 300);
        if (!reason)
            throw invalid("Record why this allowance is being set or changed.");
        const allDays = (await env.DB.prepare("SELECT d.*,t.status FROM rota_leave_days d JOIN rota_time_off t ON t.id=d.time_off_id WHERE t.user_id=? AND d.year_start=?").bind(uid, from).all<LeaveDay>()).results;
        if (old && (allDays.length || (allowanceData(old).credits ?? []).length) && (allowanceData(old).unit !== value.unit || old.to_day !== to))
            throw conflict("A leave year with booking history cannot change its unit or dates. Create the next year separately.");
        if (value.credits.some(c => !value.bankHolidays.includes(c.day)))
            throw conflict("Keep bank holidays with a worked-day credit in this year\'s audit history.");
        if (allDays.some(d => value.openingAsOf && d.day <= value.openingAsOf && ["requested", "approved"].includes(d.status ?? "")))
            throw conflict("The opening used balance overlaps recorded leave. Reconcile the records first.");
        const row: AllowanceRow = { user_id: uid, from_day: from, to_day: to, data: JSON.stringify(value), version: (old?.version ?? 0) + 1, updated_at: Date.now(), updated_by: user.id };
        if (balance(row, allDays).available < 0)
            throw conflict("This allowance would be less than the holiday already used, booked or reserved by pending requests.");
        await commitLeave(env, ver, [env.DB.prepare("INSERT INTO rota_leave_allowances(user_id,from_day,to_day,data,version,updated_at,updated_by) VALUES(?,?,?,?,1,?,?) ON CONFLICT(user_id,from_day) DO UPDATE SET to_day=excluded.to_day,data=excluded.data,version=rota_leave_allowances.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(uid, from, to, row.data, Date.now(), user.id), event(env, uid, null, "allowance_updated", user.id, { from, to, reason, before: old ? allowanceData(old) : null, after: value })]);
        return json({ balance: balance(row, allDays) });
    }
    if (route === "leave/credits" && m === "POST") {
        const ver = await revision(env), b = await r.body(), uid = await activeUser(env, b.userId), rows = await allowances(env, uid), row = rows.find(a => a.from_day === b.year);
        if (!row)
            throw notFound("Set this employee's leave year first.");
        const a = allowanceData(row), { settings } = await policy(env);
        if (settings.bankHolidayPolicy !== "credit-worked")
            throw conflict("Confirm that worked bank holidays earn an extra day before adding credits. Inclusive allowances must not be credited twice.");
        if (!a.bankHolidayEligible)
            throw conflict("This employee's contract has not been marked eligible for worked-bank-holiday credits.");
        if (!isDay(b.day) || b.day < row.from_day || b.day > row.to_day || b.day > londonToday())
            throw invalid("Choose the bank holiday already worked, within this leave year.");
        const key = "bank-holiday:" + b.day, previous = (a.credits ?? []).find(c => c.key === key && !c.reversedAt);
        if (previous)
            return json({ balance: balance(row, await chargedDays(env, uid)), replayed: true });
        requireVersion(row.version, b.ifVersion);
        const reason = text(b.reason, "Confirmation that the bank holiday was worked", 300);
        if (!reason || b.confirmWorked !== true)
            throw invalid("Confirm the employee worked this bank holiday and record the reason for the credit.");
        if (a.unit !== "days")
            throw invalid("Bank-holiday day credits require an allowance tracked in days.");
        if (!(a.bankHolidays ?? []).includes(b.day))
            throw conflict("This bank holiday is not reserved in this employee\'s inclusive allowance. Review the allowance first to avoid crediting an extra day twice.");
        const booked = await env.DB.prepare("SELECT t.id FROM rota_time_off t WHERE t.user_id=? AND t.status IN (\'requested\',\'approved\') AND t.from_day<=? AND t.to_day>=? LIMIT 1").bind(uid, b.day, b.day).first();
        if (booked)
            throw conflict("An absence is still booked or requested on this date. Resolve it before confirming the bank holiday was worked.");
        a.credits = [...(a.credits ?? []), { key, day: b.day, units: 100, reason, at: Date.now() }];
        await commitLeave(env, ver, [env.DB.prepare("UPDATE rota_leave_allowances SET data=?,version=version+1,updated_at=?,updated_by=? WHERE user_id=? AND from_day=?").bind(JSON.stringify(a), Date.now(), user.id, uid, row.from_day), event(env, uid, null, "bank_holiday_credited", user.id, { year: row.from_day, day: b.day, days: 1, reason })]);
        return json({ balance: balance({ ...row, data: JSON.stringify(a), version: row.version + 1 }, await chargedDays(env, uid)) });
    }
    if (route === "leave/credits/reverse" && m === "POST") {
        const ver = await revision(env), b = await r.body(), uid = await activeUser(env, b.userId), rows = await allowances(env, uid), row = rows.find(a => a.from_day === b.year);
        if (!row)
            throw notFound("That leave year is not available.");
        requireVersion(row.version, b.ifVersion);
        const a = allowanceData(row), credit = (a.credits ?? []).find(c => c.day === b.day && !c.reversedAt), reason = text(b.reason, "Reason for the correction", 300);
        if (!credit)
            throw conflict("There is no active bank-holiday credit for that date.");
        if (!reason)
            throw invalid("Record why this worked-bank-holiday credit is being reversed.");
        credit.reversedAt = Date.now();
        credit.reversalReason = reason;
        const days = await chargedDays(env, uid), updated = { ...row, data: JSON.stringify(a), version: row.version + 1 };
        if (balance(updated, days).available < 0)
            throw conflict("Reversing this credit would use holiday already booked or pending. Reconcile those requests or the allowance first.");
        await commitLeave(env, ver, [env.DB.prepare("UPDATE rota_leave_allowances SET data=?,version=version+1,updated_at=?,updated_by=? WHERE user_id=? AND from_day=?").bind(updated.data, Date.now(), user.id, uid, row.from_day), event(env, uid, null, "bank_holiday_credit_reversed", user.id, { year: row.from_day, day: b.day, reason })]);
        return json({ balance: balance(updated, days) });
    }
    if (route === "leave/blocks" && m === "POST") {
        const ver = await revision(env), b = await r.body(), { from, to } = range(b.from, b.to, 366), site = b.site || null, title = text(b.title, "Staff-visible blackout label", 120);
        if (site && !SITE_IDS.has(site))
            throw invalid("Choose a site or all sites.");
        if (!title)
            throw invalid("Add a short label staff can see.");
        const id = newId(10);
        await commitLeave(env, ver, [env.DB.prepare("INSERT INTO rota_leave_blocks(id,from_day,to_day,site,title,version,updated_at,updated_by) VALUES(?,?,?,?,?,1,?,?)").bind(id, from, to, site, title, Date.now(), user.id), event(env, null, null, "blackout_created", user.id, { id, from, to, site, title })]);
        return json({ id, version: 1 });
    }
    if (seg[1] === "blocks" && seg.length === 3 && m === "DELETE") {
        const ver = await revision(env), b = await r.body(), old = await env.DB.prepare("SELECT * FROM rota_leave_blocks WHERE id=?").bind(seg[2]).first<{
            version: number;
        }>();
        if (!old)
            throw notFound("That blackout has already been removed.");
        requireVersion(old.version, b.ifVersion);
        await commitLeave(env, ver, [env.DB.prepare("DELETE FROM rota_leave_blocks WHERE id=?").bind(seg[2]), event(env, null, null, "blackout_removed", user.id, old)]);
        return json({ ok: true });
    }
    if (route === "leave/events" && m === "GET") {
        const uid = await activeUser(env, q("userId"));
        return json({ events: (await env.DB.prepare("SELECT action,at,by_user,data FROM rota_leave_events WHERE user_id=? ORDER BY at DESC LIMIT 200").bind(uid).all()).results });
    }
    return null;
}
