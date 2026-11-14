// Read-only operational summary for Admin. Never used by staff/customer endpoints.
import type { Env } from "./http";
import { accountingSummary } from "./quickbooks/observations";
import { hoursOn } from "./rota/problems";
import type { rotaWeekSummary } from "./rota/views";

type Week = Awaited<ReturnType<typeof rotaWeekSummary>>;
export interface DiaryStatus { id: string; name: string; setUp: boolean; closed: boolean; pct: number; status: string }
export const londonMinutes = (now: number) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now)).split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
};
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** Uses saved weekday hours only. An unknown deadline is never guessed or called overdue. */
export function dailySiteStatus(today: string, now: number, sites: Week["sites"], diaries: DiaryStatus[]) {
  return diaries.filter(s => s.setUp).map(s => {
    const site = sites.find(r => r.id === s.id), hours = site ? hoursOn(site, today) : null;
    const done = s.status === "Signed off";
    const opening = /Temperatures|Opening checks/.test(s.status);
    const dueAt = s.closed || done ? null : (opening ? hours?.opensAt : hours?.closesAt) || null;
    const overdue = !!dueAt && londonMinutes(now) >= minutes(dueAt);
    return { ...s, dueAt, overdue, done, label: s.closed || done ? s.status : dueAt ? `${overdue ? "Overdue since" : "Due"} ${dueAt}` : s.status };
  });
}

export async function dailyBusiness(env: Env, today: string, nextWeek: string) {
  const [orders, pending, leave, annualLeave, invoices] = await Promise.all([
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN json_extract(data,'$.status') IN ('New','Preparing') THEN 1 ELSE 0 END),0) AS toPrepare,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.status') IN ('New','Preparing') THEN json_extract(data,'$.grams') ELSE 0 END),0) AS grams,
      COALESCE(SUM(CASE WHEN json_extract(data,'$.status')='Ready' THEN 1 ELSE 0 END),0) AS ready,
      MIN(CASE WHEN json_extract(data,'$.status') IN ('New','Preparing') THEN json_extract(data,'$.createdAt') END) AS oldestAt
      FROM wholesale_preview WHERE kind='order' AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL`).first<{ toPrepare: number; grams: number; ready: number; oldestAt: number | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_accounts WHERE approval_status='pending'").first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN kind='annual' THEN 1 ELSE 0 END),0) AS annual, COALESCE(SUM(CASE WHEN kind<>'annual' OR kind IS NULL THEN 1 ELSE 0 END),0) AS other FROM rota_time_off WHERE status='requested'").first<{ annual: number; other: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT t.user_id) AS n FROM rota_time_off t JOIN users u ON u.id=t.user_id WHERE t.kind='annual' AND t.status='approved' AND u.active=1 AND t.from_day<=? AND t.to_day>=?").bind(nextWeek, nextWeek).first<{ n: number }>(),
    accountingSummary(env),
  ]);
  return { orders: orders || { toPrepare: 0, grams: 0, ready: 0, oldestAt: null }, pendingAccounts: pending?.n || 0, leave: leave || { annual: 0, other: 0 }, annualLeaveMonday: annualLeave?.n || 0,
    invoices: { overdueCount: invoices?.overdueCount || 0, overduePence: invoices?.overduePence || 0, reviewCount: invoices?.reviewCount || 0 } };
}

export function dailyOperations(today: string, now: number, week: Week, diaries: DiaryStatus[], rotaLink: string) {
  const sites = dailySiteStatus(today, now, week.sites, diaries);
  const activeSites = new Set(sites.filter(s => !s.closed).map(s => s.id));
  // Only an unassigned shift in a published rota is live operational cover. Drafts stay in planning.
  const cover = week.published ? week.shifts.filter(s => s.day === today && !s.userId && activeSites.has(s.site) && minutes(s.end) > londonMinutes(now)).sort((a, b) => a.start.localeCompare(b.start)) : [];
  const alerts: { tone: string; icon: string; title: string; detail: string; eyebrow?: string; action: { label: string; href?: string; act?: string; id?: string } }[] = [];
  if (cover.length) {
    const shift = cover[0], delta = minutes(shift.start) - londonMinutes(now);
    alerts.push({ tone: "warn", icon: "clock", title: `Cover needed at ${week.sites.find(s => s.id === shift.site)?.name || shift.site}`,
      eyebrow: delta > 0 ? `Starts in ${delta < 60 ? `${delta} minutes` : `${Math.floor(delta / 60)} h ${delta % 60} min`}` : "Shift in progress",
      detail: `Today, ${shift.start}–${shift.end} · ${cover.length === 1 ? "One unassigned shift" : `${cover.length} unassigned shifts today`}`,
      action: { label: "Review shift", href: `${rotaLink}#day/${shift.site}/${today}` } });
  }
  for (const site of sites.filter(s => s.overdue)) alerts.push({ tone: "warn", icon: "cal", title: `${site.name}: ${site.status.toLowerCase()}`, detail: `Overdue since ${site.dueAt} · Today`, action: { label: "View checks", act: "overview-site", id: site.id } });
  return { sites, alerts };
}
