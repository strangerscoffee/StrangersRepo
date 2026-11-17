import { ApiError, Env } from "../../http";
import { conflict } from "../util";
import { LeaveDay, Policy, dates } from "./model";
export async function employeeSites(env: Env, uid: string): Promise<string[]> {
    const row = await env.DB.prepare("SELECT sites FROM rota_people WHERE user_id=?").bind(uid).first<{
        sites: string;
    }>();
    try {
        return row ? JSON.parse(row.sites) : [];
    }
    catch {
        return [];
    }
}
const relevant = (site: string | null, sites: string[]) => !site || !sites.length || sites.includes(site);
export interface DayRule {
    day: string;
    blocked: boolean;
    reasons: string[];
    /** Blackout labels admins set (the reason shown on the day). */
    blackouts: string[];
    /** The daily limit reached: how many are off against which limit (null = not full). */
    full: { off: number; limit: number; site: string | null } | null;
}
export async function calendarRules(env: Env, from: string, to: string, settings: Policy, sites: string[], exclude?: string): Promise<DayRule[]> {
    const [blocks, approved, unpaid] = await Promise.all([
        env.DB.prepare("SELECT id,from_day,to_day,site,title,version FROM rota_leave_blocks WHERE from_day<=? AND to_day>=? ORDER BY from_day").bind(to, from).all<{
            id: string;
            from_day: string;
            to_day: string;
            site: string | null;
            title: string;
            version: number;
        }>(),
        env.DB.prepare("SELECT d.day,t.user_id,p.sites FROM rota_leave_days d JOIN rota_time_off t ON t.id=d.time_off_id JOIN users u ON u.id=t.user_id LEFT JOIN rota_people p ON p.user_id=t.user_id WHERE d.day BETWEEN ? AND ? AND t.status='approved' AND t.kind='annual' AND u.active=1 AND t.id<>?").bind(from, to, exclude ?? "").all<{
            day: string;
            user_id: string;
            sites: string | null;
        }>(),
        // Unpaid leave has no day charges: each calendar day of an approved booking takes a place when the policy says so.
        settings.countUnpaid ? env.DB.prepare("SELECT t.from_day,t.to_day,t.user_id,p.sites FROM rota_time_off t JOIN users u ON u.id=t.user_id LEFT JOIN rota_people p ON p.user_id=t.user_id WHERE t.kind='unpaid' AND t.status='approved' AND u.active=1 AND t.from_day<=? AND t.to_day>=? AND t.id<>?").bind(to, from, exclude ?? "").all<{
            from_day: string;
            to_day: string;
            user_id: string;
            sites: string | null;
        }>() : Promise.resolve({ results: [] as { from_day: string; to_day: string; user_id: string; sites: string | null }[] }),
    ]);
    const off = [...approved.results, ...unpaid.results.flatMap(t => dates(t.from_day < from ? from : t.from_day, t.to_day > to ? to : t.to_day).map(day => ({ day, user_id: t.user_id, sites: t.sites })))];
    const sitesOf = (raw: string | null) => { try { return raw ? JSON.parse(raw) : []; } catch { return []; } };
    return dates(from, to).map(day => {
        const blackouts = [...new Set(blocks.results.filter(b => b.from_day <= day && b.to_day >= day && relevant(b.site, sites)).map(b => b.title))];
        let full: DayRule["full"] = null;
        for (const [scope, limit] of Object.entries(settings.limits)) {
            if (limit === null || (scope !== "all" && !relevant(scope, sites)))
                continue;
            const people = new Set(off.filter(r => r.day === day && (scope === "all" || relevant(scope, sitesOf(r.sites)))).map(r => r.user_id));
            if (people.size >= limit && (!full || people.size > full.off))
                full = { off: people.size, limit, site: scope === "all" ? null : scope };
        }
        const reasons = [...blackouts, ...(full ? [fullText(full)] : [])];
        return { day, blocked: reasons.length > 0, reasons, blackouts, full };
    });
}
export const fullText = (f: { off: number; limit: number }) => f.limit === 0 ? "No holiday on this day" : `Full (${f.off} off)`;
/** Holiday on a blackout or full day is refused (409 leave_blocked, with each blocked day and why). An admin making an
 * exception passes `override`: the blocked days are then returned for the audit record instead of refusing. */
export async function checkCalendar(env: Env, from: string, to: string, settings: Policy, uid: string, days: LeaveDay[], exclude?: string, override = false) {
    const calendar = await calendarRules(env, from, to, settings, await employeeSites(env, uid), exclude);
    // Non-working dates do not consume a holiday place; a seven-day trip can include a non-working weekend.
    const blocked = calendar.filter(d => d.blocked && days.some(x => x.day === d.day)).map(d => ({ day: d.day, reasons: d.reasons }));
    if (blocked.length && !override)
        throw new ApiError(409, "leave_blocked", `Holiday requests are blocked on ${blocked[0].day}: ${blocked[0].reasons.join("; ")}.`, { blocked });
    return blocked;
}
