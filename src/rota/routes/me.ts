// Rota routes for the person signed in: their shifts, who's on today, their details, and their availability.
import { invalid, json } from "../../http";
import { approvers, loadPeople, loadShifts, publishedWeeks, weekRow } from "../load";
import { visibleRequests } from "../requests";
import { markOvertime } from "../shift";
import { ReqRow, RotaRequest, SITE_IDS } from "../types";
import { checkPattern, checkSites } from "../validate";
import { addDays, dateOf, isDay, londonToday, mondayOf, nowMs, parseJson, round2, siteName } from "../util";

export async function meRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, user, route, m, q, mgr, needAdmin, body, links } = r;

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
        others: live.filter((o) => o.site === s.site && o.day === s.day && o.id !== s.id)
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
      shifts: shifts.filter((s) => s.site === site).map((s) => ({
        name: s.userId ? people.get(s.userId)?.name || "Someone" : null, me: s.userId === user.id, open: !s.userId,
        start: s.start, end: s.end, job: s.job, actualStart: s.actualStart, actualEnd: s.actualEnd,
      })),
    });
  }

  if (route === "me" && m === "GET") {
    const [p, offs, reqs, appr] = await Promise.all([
      env.DB.prepare("SELECT * FROM rota_people WHERE user_id = ?").bind(user.id).first<{ contract_min: number | null; contract_max: number | null; sites: string; pattern: string }>(),
      env.DB.prepare("SELECT id, user_id, from_day, to_day, reason, status, decided_at FROM rota_time_off WHERE user_id = ? AND to_day >= ? ORDER BY from_day")
        .bind(user.id, addDays(londonToday(), -30)).all<any>(),
      env.DB.prepare("SELECT * FROM rota_requests WHERE (from_user = ? OR to_user = ? OR taker = ? OR (to_user IS NULL AND kind = 'cover' AND status = 'open')) AND created_at > ? ORDER BY created_at DESC LIMIT 100")
        .bind(user.id, user.id, user.id, nowMs() - 60 * 864e5).all<ReqRow>(),
      approvers(env),
    ]);
    return json({
      user: { id: user.id, name: user.name, role: user.role, manager: mgr, admin: user.role === "admin" }, links, today: londonToday(), approvers: appr,
      contractMin: p?.contract_min ?? null, contractMax: p?.contract_max ?? null, contractHours: p?.contract_max ?? null, sites: parseJson(p?.sites, []), pattern: parseJson(p?.pattern, {}),
      timeOff: offs.results.map((t) => ({ id: t.id, from: t.from_day, to: t.to_day, reason: t.reason, status: t.status, decidedAt: t.decided_at })),
      requests: await visibleRequests(env, reqs.results, mgr),
    });
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
