import { Env } from "../../http";
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
export async function calendarRules(env: Env, from: string, to: string, settings: Policy, sites: string[], exclude?: string) {
    const [blocks, approved] = await Promise.all([
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
    ]);
    return dates(from, to).map(day => {
        const reasons = blocks.results.filter(b => b.from_day <= day && b.to_day >= day && relevant(b.site, sites)).map(b => b.title);
        for (const [scope, limit] of Object.entries(settings.limits)) {
            if (limit === null || (scope !== "all" && !relevant(scope, sites)))
                continue;
            const off = new Set(approved.results.filter(r => r.day === day && (scope === "all" || relevant(scope, r.sites ? JSON.parse(r.sites) : []))).map(r => r.user_id));
            if (off.size >= limit)
                reasons.push("Holiday capacity reached");
        }
        return { day, blocked: reasons.length > 0, reasons: [...new Set(reasons)] };
    });
}
export async function checkCalendar(env: Env, from: string, to: string, settings: Policy, uid: string, days: LeaveDay[], exclude?: string) {
    const calendar = await calendarRules(env, from, to, settings, await employeeSites(env, uid), exclude);
    // Non-working dates do not consume a holiday place; a seven-day trip can include a non-working weekend.
    const blocked = calendar.find(d => d.blocked && days.some(x => x.day === d.day));
    if (blocked)
        throw conflict(`Holiday requests are blocked on ${blocked.day}: ${blocked.reasons.join("; ")}.`);
}
