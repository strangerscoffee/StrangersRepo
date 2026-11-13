// Rota routes for the person signed in: their shifts, who's on today, their details, and their availability.
import { policy } from "../leave/model";
import { invalid, json } from "../../http";
import { approvers, loadPeople, loadShifts, publishedWeeks, weekRow } from "../load";
import { visibleRequests } from "../requests";
import { visibleShift } from "../privacy";
import { markOvertime } from "../shift";
import { ReqRow, RotaRequest, SITE_IDS } from "../types";
import { checkPattern, checkSites } from "../validate";
import { addDays, dateOf, denied, isDay, londonToday, mondayOf, nowMs, parseJson, round2, siteName } from "../util";

import { emailReady, prefsOf, savePrefs, weeklySitesOf } from "../../email/send";

export async function meRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, user, route, m, q, mgr, admin, needAdmin, body, links } = r;
  const siteManager = user.role === "manager" || admin;

  if (route === "mine" && m === "GET") {
    const from = q("from") || londonToday();
    if (!isDay(from)) throw invalid("Choose real dates.");
    const to = q("to") || addDays(from, 27);
    if (!isDay(to) || to < from) throw invalid("Choose real dates.");
    if (dateOf(to).getTime() - dateOf(from).getTime() > 92 * 864e5) throw invalid("Ask for up to three months at a time.");
    // Whole weeks, so overtime counts from the Monday.
    const [weeks, wide, people] = await Promise.all([publishedWeeks(env, from, to), loadShifts(env, mondayOf(from), addDays(mondayOf(to), 6)), loadPeople(env)]);
    markOvertime(wide.filter((s) => s.userId === user.id && weeks.has(mondayOf(s.day))), people);
    const all = wide.filter((s) => s.day >= from && s.day <= to);
    const live = all.filter((s) => weeks.has(mondayOf(s.day)));
    const me = people.get(user.id);
    const weekTotals = [...new Set(live.filter((s) => s.userId === user.id).map((s) => mondayOf(s.day)))].sort().map((w) => {
      const mine = wide.filter((s) => s.userId === user.id && mondayOf(s.day) === w);
      const hours = round2(mine.reduce((h, s) => h + s.hours, 0));
      return { week: w, hours, overtime: round2(mine.reduce((h, s) => h + (s.overtime || 0), 0)) };
    });
    const nameOf = (id: string | null) => (id ? people.get(id)?.name || "Someone" : null);
    return json({
      from, to, today: londonToday(),
      published: [...weeks].sort(),
      contractMin: me?.contractMin ?? null, contractMax: me?.contractMax ?? null, weeks: weekTotals,
      shifts: live.filter((s) => s.userId === user.id).map((s) => ({
        ...s, siteName: siteName(s.site),
        others: (admin ? live.filter((o) => o.site === s.site && o.day === s.day && o.id !== s.id) : [])
          .map((o) => ({ name: nameOf(o.userId) || "Open shift", start: o.start, end: o.end, job: o.job, open: !o.userId, actualStart: o.actualStart, actualEnd: o.actualEnd })),
      })),
    });
  }

  if (route === "today" && m === "GET") {
    const site = q("site") || "";
    if (!SITE_IDS.has(site)) throw invalid("Choose one of the four sites.");
    const day = q("day") && isDay(q("day")) ? q("day")! : londonToday();
    const row = await weekRow(env, mondayOf(day));
    if (!row?.published_at) return json({ site, day, published: false, shifts: [], rotaUrl: links.rota });
    const [shifts, people] = await Promise.all([loadShifts(env, day, day), loadPeople(env)]);
    return json({
      site, day, published: true, rotaUrl: links.rota,
      shifts: shifts.filter((s) => s.site === site).map((s) => visibleShift(s, user)).filter((s): s is NonNullable<typeof s> => s !== null).map((s) => ({
        name: s.userId ? people.get(s.userId)?.name || "Someone" : null, me: s.userId === user.id, open: !s.userId,
        start: s.start, end: s.end, job: s.job, actualStart: s.actualStart, actualEnd: s.actualEnd,
      })),
    });
  }

  if (route === "me" && m === "GET") {
    const [p, offs, reqs, appr, mail, leavePolicy] = await Promise.all([
      env.DB.prepare("SELECT * FROM rota_people WHERE user_id = ?").bind(user.id).first<{ contract_min: number | null; contract_max: number | null; sites: string; pattern: string }>(),
      env.DB.prepare("SELECT id, user_id, from_day, to_day, reason, status, decided_at, kind, version, from_time, to_time FROM rota_time_off WHERE user_id = ? AND to_day >= ? ORDER BY from_day")
        .bind(user.id, addDays(londonToday(), -30)).all<any>(),
      env.DB.prepare("SELECT * FROM rota_requests WHERE (from_user = ? OR to_user = ? OR taker = ?) AND created_at > ? ORDER BY created_at DESC LIMIT 100")
        .bind(user.id, user.id, user.id, nowMs() - 60 * 864e5).all<ReqRow>(),
      approvers(env),
      env.DB.prepare("SELECT email, email_prefs FROM users WHERE id = ?").bind(user.id).first<{ email: string | null; email_prefs: string }>(),
      policy(env),
    ]);
    return json({
      holidayManagement: leavePolicy.settings.enabled,
      user: { id: user.id, name: user.name, role: user.role, manager: mgr, admin, siteManager }, links, today: londonToday(), approvers: appr,
      contractMin: p?.contract_min ?? null, contractMax: p?.contract_max ?? null, contractHours: p?.contract_max ?? null, sites: parseJson(p?.sites, []), pattern: parseJson(p?.pattern, {}),
      timeOff: offs.results.map((t) => ({ id: t.id, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status, decidedAt: t.decided_at, kind:t.kind, version:t.version,fromTime:t.from_time,toTime:t.to_time })),
      requests: await visibleRequests(env, reqs.results, user),
      // Rota emails: their address (set by an admin) and which emails they get, which they choose themselves.
      email: { address: mail?.email || null, prefs: prefsOf(mail?.email_prefs), ready: emailReady(env), ...(siteManager ? { weeklySites: weeklySitesOf(mail?.email_prefs) } : {}) },
    });
  }

  // {prefs?: {published?, changed?, requests?, open?, weekly?}, weeklySites?: [siteIds]}. Managers may choose
  // their own business-summary preferences; the sender separately restricts employee-private content.
  if (route === "me/emails" && m === "PUT") {
    const b = await body();
    if (!siteManager && (b.weeklySites !== undefined || (b.prefs && Object.hasOwn(b.prefs, "weekly")))) throw denied("The Monday summary is for managers and admins.");
    return json(await savePrefs(env, user.id, { prefs: b.prefs ?? {}, weeklySites: b.weeklySites }));
  }

  if (route === "me/availability" && m === "PUT") {
    needAdmin();
    const b = await body();
    const pattern = checkPattern(b.pattern), sites = checkSites(b.sites);
    await env.DB.prepare(
      `INSERT INTO rota_people (user_id, sites, pattern, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET sites = excluded.sites, pattern = excluded.pattern, updated_at = excluded.updated_at`,
    ).bind(user.id, JSON.stringify(sites), JSON.stringify(pattern), nowMs()).run();
    return json({ pattern, sites });
  }

  return null;
}
