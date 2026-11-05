// Rota routes for whole weeks: the week view, copying, publishing, and hours (with the CSV).
import { newId } from "../../auth";
import { invalid, json } from "../../http";
import { loadClosures, loadPeople, loadShifts, loadSites, touchWeek, weekRow } from "../load";
import { openState } from "../problems";
import { ROTA_SITES, RotaRequest } from "../types";
import { weekView } from "../views";
import { addDays, conflict, dow, isDay, londonToday, mondayOf, nowMs, round2 } from "../util";
import { actor, planWeek, sendWeek } from "../../email/rota";
import { emailReady } from "../../email/send";

export async function weekRoutes(r: RotaRequest): Promise<Response | null> {
  const { env, exec, user, route, m, q, needMgr, body, mailLinks } = r;

  if (route === "week" && m === "GET") {
    const start = q("start") || londonToday();
    if (!isDay(start)) throw invalid("Choose a real date.");
    return json(await weekView(env, mondayOf(start), user));
  }

  if (route === "week/copy" && m === "POST") {
    needMgr();
    const b = await body();
    if (!isDay(b.from) || !isDay(b.to)) throw invalid("Choose real weeks.");
    const from = mondayOf(b.from), to = mondayOf(b.to);
    if (from === to) throw invalid("Choose a different week to copy into.");
    const today = londonToday();
    if (to < mondayOf(today)) throw invalid("Weeks that have gone by can't be copied over.");
    // Days that have already happened keep their shifts (and any amended hours); only today onwards is replaced.
    const existing = (await loadShifts(env, to, addDays(to, 6))).filter((s) => s.day >= today);
    if (existing.length && b.replace !== true) throw conflict(`That week already has ${existing.length} shift${existing.length === 1 ? "" : "s"}. Replace them?`);
    const source = await loadShifts(env, from, addDays(from, 6));
    const [sites, closures, people] = await Promise.all([loadSites(env), loadClosures(env, to, addDays(to, 6)), loadPeople(env)]);
    const shift = (dowOf: string) => addDays(to, dow(dowOf));
    const skipped: { site: string; day: string; start: string; end: string; reason: string }[] = [];
    const stmts: D1PreparedStatement[] = [];
    if (existing.length) {
      const lo = today > to ? today : to;
      stmts.push(env.DB.prepare("UPDATE rota_requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE status IN ('open', 'accepted') AND shift_id IN (SELECT id FROM rota_shifts WHERE day BETWEEN ? AND ?)").bind(user.id, nowMs(), lo, addDays(to, 6)));
      stmts.push(env.DB.prepare("DELETE FROM rota_shifts WHERE day BETWEEN ? AND ?").bind(lo, addDays(to, 6)));
    }
    let copied = 0;
    for (const s of source) {
      const day = shift(s.day);
      if (day < today) continue; // already happened
      const st = openState({ sites, closures }, s.site, day);
      if (!st.open) { skipped.push({ site: s.site, day, start: s.start, end: s.end, reason: st.reason! }); continue; }
      const uid = s.userId && people.has(s.userId) ? s.userId : null; // someone switched off since: copied as open
      stmts.push(env.DB.prepare(
        "INSERT INTO rota_shifts (id, site, day, start, end, break_mins, job, user_id, note, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(newId(10), s.site, day, s.start, s.end, s.breakMins, s.job, uid, s.note, nowMs(), user.id));
      copied++;
    }
    stmts.push(touchWeek(env, to));
    await env.DB.batch(stmts);
    return json({ copied, skipped, replaced: existing.length, ...(await weekView(env, to, user)) });
  }

  if (route === "week/publish" && m === "POST") {
    needMgr();
    const b = await body();
    if (!isDay(b.week)) throw invalid("Choose a real week.");
    const week = mondayOf(b.week);
    await env.DB.prepare(
      `INSERT INTO rota_weeks (week, published_at, published_by, changed_at, changes) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (week) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by, changes = 0`,
    ).bind(week, nowMs(), user.id, nowMs()).run();
    // {email: true}: email the people on it (only those whose shifts changed, once it has been emailed before).
    let emailed = 0;
    if (b.email === true) emailed = await sendWeek(env, exec, await planWeek(env, week), week, mailLinks, await actor(env, user));
    return json({ ...(await weekView(env, week, user)), emailed });
  }

  // What publishing would email: for the publish sheet's "Email …" line.
  if (route === "week/emails" && m === "GET") {
    needMgr();
    const start = q("week") || "";
    if (!isDay(start)) throw invalid("Choose a real week.");
    const plan = await planWeek(env, mondayOf(start));
    return json({ ready: emailReady(env), first: plan.first, people: plan.people.length, noAddress: plan.noAddress, open: plan.open.length });
  }

  if (route === "hours" && m === "GET") {
    needMgr();
    const start = q("start") || londonToday();
    if (!isDay(start)) throw invalid("Choose a real date.");
    const week = mondayOf(start);
    const [people, shifts, row] = await Promise.all([loadPeople(env), loadShifts(env, week, addDays(week, 6)), weekRow(env, week)]);
    const ids = new Set([...people.keys(), ...shifts.map((s) => s.userId).filter((x): x is string => !!x)]);
    const extra = await env.DB.prepare("SELECT id, name, role FROM users").all<{ id: string; name: string; role: string }>();
    const rows = [...ids].map((id) => {
      const p = people.get(id) || { ...(extra.results.find((u) => u.id === id) || { id, name: "Someone", role: "" }), contractMin: null, contractMax: null };
      const mine = shifts.filter((s) => s.userId === id);
      const bySite = Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(mine.filter((x) => x.site === s.id).reduce((h, x) => h + x.hours, 0))]));
      const rota = round2(mine.reduce((h, s) => h + s.hours, 0));
      const planned = round2(mine.reduce((h, s) => h + s.plannedHours, 0));
      return { userId: id, name: p.name, role: p.role, contractMin: p.contractMin, contractMax: p.contractMax, contractHours: p.contractMax,
        plannedHours: planned, rotaHours: rota, amended: mine.filter((s) => s.adjusted).length,
        overtime: p.contractMax == null ? 0 : round2(Math.max(0, rota - p.contractMax)),
        shortOfMin: p.contractMin == null ? 0 : round2(Math.max(0, p.contractMin - rota)),
        sites: bySite, shifts: mine.length };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const siteTotals = Object.fromEntries(ROTA_SITES.map((s) => [s.id, round2(shifts.filter((x) => x.site === s.id && x.userId).reduce((h, x) => h + x.hours, 0))]));
    const openHours = round2(shifts.filter((s) => !s.userId).reduce((h, s) => h + s.hours, 0));
    if (q("format") === "csv") {
      const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [["name", "role", "contract_min", "contract_max", "planned_hours", "rota_hours", "overtime", "short_of_min", ...ROTA_SITES.map((s) => s.id)].join(",")];
      for (const r of rows) lines.push([r.name, r.role, r.contractMin, r.contractMax, r.plannedHours, r.rotaHours, r.overtime, r.shortOfMin, ...ROTA_SITES.map((s) => r.sites[s.id])].map(cell).join(","));
      return new Response(lines.join("\r\n") + "\r\n", {
        headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="rota-hours-${week}.csv"` },
      });
    }
    return json({ week, published: !!row?.published_at, people: rows, siteTotals, openHours, total: round2(rows.reduce((h, r) => h + r.rotaHours, 0)),
      overtime: round2(rows.reduce((h, r) => h + r.overtime, 0)) });
  }

  return null;
}
