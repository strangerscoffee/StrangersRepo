// The managers' Monday summary (design "v2" on the email design canvas): sent at 07:30 UK time every Monday to each
// manager and admin who has it on (email_prefs.weekly), covering the sites they chose (email_prefs.weeklySites).
// What needs them, most urgent first (an out-of-range reading with nothing written about it, urgent maintenance; days
// not signed off, overdue cleaning, rota requests waiting, the week not published; next week to plan), last week's
// diary as a Mon–Sun grid per site with totals against the week before, and what's coming up.
import { audit } from "../audit";
import { Env } from "../http";
import { EmailKind, Outgoing, emailReady, linksFor, prefsOf, send, weeklySitesOf } from "./send";
import { Built, Links, addDays, esc } from "./templates";

const SITES = [
  { id: "roastery", name: "Roastery", prefix: "" }, { id: "cafe", name: "Cafe", prefix: "sites/cafe/" },
  { id: "asg", name: "ASG", prefix: "sites/asg/" }, { id: "factory", name: "Factory", prefix: "sites/factory/" },
];
const FREQ: Record<string, number> = { "after use": 0, daily: 1, weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, "six-monthly": 182, yearly: 365 };
const TOPICS = ["hygiene", "cross", "cleaning", "chilling", "cooking", "allergens", "diary", "l2"];
const DAY = 864e5;

export const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const londonHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
export const mondayOf = (d: string) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(new Date(d + "T12:00:00Z"));
const short = (d: string) => fmt(d, { weekday: "short", day: "numeric", month: "short" }); // Wed 4 Nov
const dayMonth = (d: string) => fmt(d, { day: "numeric", month: "long" }); // 2 November
const londonDayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const plural = (n: number, w: string, ws = w + "s") => `${n} ${n === 1 ? w : ws}`;
const listNames = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const parse = (s: string | null | undefined, f: any = null) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

type Cell = "ok" | "miss" | "warn" | "closed";
export interface Item { tag: string; title: string; detail: string; action: string; href: string }
export interface Weekly {
  name: string; week: string; sites: string[];
  employeeDetails: boolean;
  urgent: Item[]; thisWeek: Item[]; toPlan: Item[];
  grid: { name: string; inUse: boolean; cells: Cell[] }[];
  stats: { signed: number; open: number; signedPrev: number; openPrev: number; out: number; outPrev: number; deliveries: number; rejected: number; rejectedNote: string };
  also: [string, string][];
}

/** Last week (Mon–Sun before `today`'s week) at these sites, and what needs a manager now. */
export async function weeklyData(env: Env, siteIds: string[], today: string, base: { rota: string; diary: string }, name: string, options: { admin?: boolean } = {}): Promise<Weekly> {
  // Managers receive business summaries, never another employee's private records or identifying aggregates.
  const admin = options.admin === true;
  const thisMon = mondayOf(today), week = addDays(thisMon, -7), prev = addDays(week, -7), nextMon = addDays(thisMon, 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const sites = SITES.filter((s) => siteIds.includes(s.id));
  const cols = (n: string) => JSON.stringify(sites.map((s) => s.prefix + n));
  type Row = { collection: string; doc_id: string; data: string };
  const [settings, dayRows, tasks, maint, deliveries, reviews, staff, weeks, shifts, reqs, offs] = await env.DB.batch([
    env.DB.prepare("SELECT collection, doc_id, data FROM docs WHERE deleted = 0 AND path IN (SELECT value FROM json_each(?))").bind(JSON.stringify(sites.map((s) => s.prefix + "settings/main"))),
    env.DB.prepare("SELECT collection, doc_id, data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) AND doc_id BETWEEN ? AND ?").bind(cols("days"), prev, addDays(week, 6)),
    env.DB.prepare("SELECT collection, doc_id, json_remove(data, '$.log') AS data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?))").bind(JSON.stringify(sites.flatMap((s) => [s.prefix + "cleaning", s.prefix + "extras"]))),
    env.DB.prepare("SELECT collection, doc_id, data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) AND json_extract(data, '$.status') IS NOT 'done'").bind(cols("maintenance")),
    env.DB.prepare("SELECT collection, doc_id, data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) AND json_extract(data, '$.date') BETWEEN ? AND ?").bind(cols("deliveries"), week, addDays(week, 6)),
    env.DB.prepare("SELECT collection, MAX(json_extract(data, '$.date')) AS data, '' AS doc_id FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) GROUP BY collection").bind(cols("reviews")),
    env.DB.prepare("SELECT collection, doc_id, data FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) AND ?").bind(cols("staff"), admin ? 1 : 0),
    env.DB.prepare("SELECT week, published_at FROM rota_weeks WHERE week IN (?, ?) AND ?").bind(thisMon, nextMon, admin ? 1 : 0),
    env.DB.prepare("SELECT site, day, start, end, break_mins, user_id FROM rota_shifts WHERE day BETWEEN ? AND ? AND site IN (SELECT value FROM json_each(?)) AND ?").bind(thisMon, addDays(nextMon, 6), JSON.stringify(siteIds), admin ? 1 : 0),
    env.DB.prepare(`SELECT r.kind, r.status, s.site, s.day, (SELECT name FROM users WHERE id = r.from_user) AS asker, (SELECT name FROM users WHERE id = r.taker) AS taker
      FROM rota_requests r JOIN rota_shifts s ON s.id = r.shift_id WHERE ((r.kind = 'cover' AND r.status = 'accepted') OR (r.kind = 'claim' AND r.status = 'open')) AND s.site IN (SELECT value FROM json_each(?)) AND ?`).bind(JSON.stringify(siteIds), admin ? 1 : 0),
    env.DB.prepare("SELECT t.from_day, t.to_day, u.name FROM rota_time_off t JOIN users u ON u.id = t.user_id WHERE t.status = 'requested' AND ? ORDER BY t.from_day").bind(admin ? 1 : 0),
  ]);
  const of = (collection: string) => sites.find((s) => collection === s.prefix + collection.slice(s.prefix.length) && collection.startsWith(s.prefix) && !collection.slice(s.prefix.length).includes("/"))!;
  const bySite = <T>(rows: Row[], f: (r: Row) => T) => { const m = new Map<string, T[]>(); for (const r of rows) { const s = of(r.collection); if (s) (m.get(s.id) || m.set(s.id, []).get(s.id)!).push(f(r)); } return m; };
  const set = new Map((settings.results as Row[]).map((r) => [of(r.collection)?.id, parse(r.data, {})]));
  const dayDocs = bySite(dayRows.results as Row[], (r) => [r.doc_id, parse(r.data, {})] as [string, any]);

  const urgent: Item[] = [], thisWeek: Item[] = [], toPlan: Item[] = [], also: [string, string][] = [];
  const diary = (h: string) => base.diary.replace(/\/$/, "/") + h, rota = (h: string) => base.rota.replace(/\/$/, "/") + h;
  const grid: Weekly["grid"] = [];
  const reviewsLate: { site: string; due: string }[] = [];
  const st = { signed: 0, open: 0, signedPrev: 0, openPrev: 0, out: 0, outPrev: 0, deliveries: 0, rejected: 0, rejectedNote: "" };

  for (const s of sites) {
    const cfg = set.get(s.id);
    if (!cfg) { grid.push({ name: s.name, inUse: false, cells: [] }); continue; }
    const docs = new Map(dayDocs.get(s.id) || []);
    const units: any[] = Array.isArray(cfg.units) ? cfg.units : [], closedDays: number[] = Array.isArray(cfg.closedDays) ? cfg.closedDays : [];
    const start = typeof cfg.startDate === "string" ? cfg.startDate : "";
    const bad = (u: any, v: unknown) => v != null && v !== "" && Number.isFinite(Number(v)) && (u.kind === "freezer" ? Number(v) > -15 : Number(v) > 8);
    const judge = (date: string) => {
      const d = docs.get(date) || {};
      const outs = units.filter((u) => bad(u, d.temps?.[u.id]?.am?.v));
      const any = !!d.signed || !!d.temps || !!d.opening || !!d.closing;
      const closed = (d.closed && d.closed.reason) || (closedDays.includes(new Date(date + "T12:00:00Z").getUTCDay()) && !any) || (start && date < start);
      return { d, outs, closed: !!closed, signed: !!d.signed };
    };
    const cells: Cell[] = [], missed: string[] = [];
    for (const date of days) {
      const j = judge(date);
      st.out += j.outs.length;
      if (j.closed) { cells.push("closed"); continue; }
      st.open++;
      if (j.signed) st.signed++; else missed.push(date);
      cells.push(j.outs.length ? "warn" : j.signed ? "ok" : "miss");
      // A reading out of range with nothing written in Problems & changes (the corrective action).
      for (const u of j.outs) if (!String(j.d.problems?.text || "").trim()) urgent.push({ tag: "Temps", title: `${u.name || "A fridge"} read ${j.d.temps[u.id].am.v}°C on ${fmt(date, { weekday: "long" })}`,
        detail: `${s.name} · ${u.kind === "freezer" ? "warmer than −15°C" : "above 8°C"}, no corrective action written`, action: "Add what was done", href: diary("#templog") });
    }
    for (let i = 0; i < 7; i++) { const j = judge(addDays(prev, i)); st.outPrev += j.outs.length; if (!j.closed) { st.openPrev++; if (j.signed) st.signedPrev++; } }
    grid.push({ name: s.name, inUse: true, cells });
    if (missed.length) thisWeek.push({ tag: "Diary", title: missed.length === 1 ? `${short(missed[0])} wasn't signed off` : `${missed.length} days weren't signed off`,
      detail: `${s.name}${missed.length > 1 ? ` · ${listNames(missed.map((d) => fmt(d, { weekday: "short" })))}` : ""}`, action: missed.length === 1 ? "Review the day" : "Review the days", href: diary("#history") });

    // Cleaning and extra checks: overdue now, and due in the week ahead.
    let dueSoon = 0;
    for (const r of (tasks.results as Row[]).filter((r) => of(r.collection)?.id === s.id)) {
      const kind = r.collection.endsWith("cleaning") ? "cleaning" : "extras";
      if (cfg.hide?.[kind]) continue;
      const t = parse(r.data, {}), every = FREQ[t.freq] || 0, basis = t.lastAt || t.importedAt;
      if (!every) continue;
      const due = basis ? addDays(londonDayOf(basis), every) : null;
      if (!due || due < today) {
        const late = due ? Math.round((Date.parse(today) - Date.parse(due)) / DAY) : null;
        thisWeek.push({ tag: kind === "cleaning" ? "Cleaning" : "Checks", title: t.name || "A task", detail: `${s.name} · ${t.freq} · ${late == null ? "never done" : `${plural(late, "day")} overdue`}`, action: kind === "cleaning" ? "Open cleaning" : "Open extra checks", href: diary("#" + kind) });
      } else if (due <= addDays(today, 6)) dueSoon++;
    }
    if (dueSoon) also.push([`Cleaning and checks due · ${s.name}`, plural(dueSoon, "job")]);

    for (const r of (maint.results as Row[]).filter((r) => of(r.collection)?.id === s.id)) {
      const m = parse(r.data, {});
      const opened = m.reportedAt || m.at || 0, age = opened ? Math.floor((Date.now() - opened) / DAY) : 0;
      if (m.priority === "urgent") urgent.push({ tag: "Urgent", title: m.title || "A maintenance job", detail: `${s.name} · open ${plural(age, "day")} · ${m.assignee ? admin ? `with ${m.assigneeName || "someone"}` : "assigned" : "nobody assigned"}`, action: m.assignee ? "See the job" : "Assign someone", href: diary("#maintenance") });
    }
    const openJobs = (maint.results as Row[]).filter((r) => of(r.collection)?.id === s.id && parse(r.data, {}).priority !== "urgent").length;
    if (openJobs) also.push([`Maintenance · ${s.name}`, `${plural(openJobs, "job")} open`]);

    for (const r of (deliveries.results as Row[]).filter((r) => of(r.collection)?.id === s.id)) {
      const d = parse(r.data, {});
      st.deliveries++;
      if (d.outcome === "rejected") { st.rejected++; if (!st.rejectedNote) st.rejectedNote = [d.supplier, d.note].filter(Boolean).join(", ").slice(0, 40); }
    }
    // The 4-weekly review: due 28 days after the last one (or after the diary started).
    const last = (reviews.results as Row[]).find((r) => of(r.collection)?.id === s.id)?.data || start || null;
    if (last) {
      const due = addDays(last, 28);
      if (due < today) reviewsLate.push({ site: s.name, due });
      else if (due <= addDays(today, 6)) also.push([`4-weekly review · ${s.name}`, `due ${short(due)}`]);
    }
    if (admin) {
      const topics = TOPICS.filter((t) => !(Array.isArray(cfg.trainingOff) && cfg.trainingOff.includes(t)));
      const untrained = (staff.results as Row[]).filter((r) => of(r.collection)?.id === s.id).map((r) => parse(r.data, {})).filter((p) => topics.some((t) => !p.topics?.[t]?.date)).length;
      if (untrained) also.push([`Training to do · ${s.name}`, plural(untrained, "person", "people")]);
    }
  }

  // Overdue 4-weekly reviews, as one item (with the date only when it's recent).
  if (reviewsLate.length) {
    const recent = reviewsLate.length === 1 && reviewsLate[0].due >= addDays(today, -60);
    thisWeek.push({ tag: "Review", title: "4-weekly review overdue", detail: `${listNames(reviewsLate.map((r) => r.site))}${recent ? ` · due ${short(reviewsLate[0].due)}` : ""}`, action: "Do the review", href: diary("#review") });
  }

  // Private employee planning and requests are for admins only.
  if (admin) {
    const rq = reqs.results as { kind: string; site: string; day: string; asker: string; taker: string | null }[];
    const to = offs.results as { from_day: string; to_day: string; name: string }[];
    if (rq.length || to.length) {
      const bits = [...to.slice(0, 2).map((t) => `${t.name.split(" ")[0]}: time off ${short(t.from_day)}`),
        ...rq.slice(0, 2).map((r) => r.kind === "cover" ? `${(r.taker || "Someone").split(" ")[0]} covering ${(r.asker || "").split(" ")[0]}, ${short(r.day)}` : `${(r.asker || "Someone").split(" ")[0]} picking up ${short(r.day)}`)];
      thisWeek.push({ tag: "Rota", title: `${plural(rq.length + to.length, "request")} to decide`, detail: bits.join(" · "), action: "Decide in the rota", href: rota("#requests") });
    }
    const pub = new Map((weeks.results as { week: string; published_at: number | null }[]).map((w) => [w.week, !!w.published_at]));
    const sh = shifts.results as { site: string; day: string; start: string; end: string; break_mins: number; user_id: string | null }[];
    const hours = (from: string) => Math.round(sh.filter((x) => x.day >= from && x.day <= addDays(from, 6) && x.user_id).reduce((h, x) => h + Math.max(0, (hm(x.end) - hm(x.start) + (hm(x.end) <= hm(x.start) ? 1440 : 0) - (x.break_mins || 0)) / 60), 0));
    const planned = (from: string) => (hours(from) ? `${hours(from)} hours planned` : "Nothing planned yet");
    const openIn = (from: string) => sh.filter((x) => x.day >= from && x.day <= addDays(from, 6) && !x.user_id && x.day >= today);
    const openText = (xs: typeof sh) => xs.length === 1 ? `1 open shift: ${SITES.find((s) => s.id === xs[0].site)?.name}, ${short(xs[0].day)} ${xs[0].start}–${xs[0].end}` : `${xs.length} open shifts`;
    if (sh.some((x) => x.day <= addDays(thisMon, 6)) && !pub.get(thisMon)) thisWeek.push({ tag: "Rota", title: "This week's rota isn't published", detail: `${planned(thisMon)}${openIn(thisMon).length ? ` · ${openText(openIn(thisMon))}` : ""}`, action: "Publish it", href: rota(`#week/${thisMon}`) });
    else if (openIn(thisMon).length) thisWeek.push({ tag: "Rota", title: plural(openIn(thisMon).length, "open shift") + " this week", detail: openText(openIn(thisMon)), action: "Fill them", href: rota(`#week/${thisMon}`) });
    if (!pub.get(nextMon)) toPlan.push({ tag: "Rota", title: "Next week's rota isn't published", detail: `${planned(nextMon)}${openIn(nextMon).length ? ` · ${openText(openIn(nextMon))}` : ""}`, action: "Finish and publish", href: rota(`#week/${nextMon}`) });
    else also.unshift(["Next week's rota", `Published · ${hours(nextMon)} hours`]);
  }

  return { name, week, sites: sites.map((s) => s.name), employeeDetails: admin, urgent, thisWeek, toPlan, grid, stats: st, also };
}

/* ---------- the email ---------- */

const MUTED = "#5d6675", LINE = "#e3e6eb", FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TONE = { urgent: ["#b42318", "#fdecea"], week: ["#8a4f00", "#fff4e0"], plan: ["#0058b8", "#eef4fc"] } as const;
const CELL: Record<Cell, [string, string, string]> = { ok: ["#1f7a45", "#ffffff", "✓"], miss: ["#c4321f", "#ffffff", "✕"], warn: ["#e8a317", "#3d2600", "!"], closed: ["#e3e7ed", "#6b7382", "–"] };
const change = (now: number, before: number, goodUp: boolean) => {
  if (now === before) return [MUTED, "Same as last week"] as const;
  const up = now > before, good = up === goodUp;
  return [good ? "#1f7a45" : "#b42318", `${up ? "Up" : "Down"} ${Math.abs(now - before)} on last week`] as const;
};

/** How last week's missed days compare with the week before. */
const missedNote = (now: number, before: number): readonly [string, string] =>
  now === before ? [MUTED, now ? "Same as last week" : "None missed"] : now < before ? ["#1f7a45", `${before - now} fewer missed than last week`] : ["#b42318", `${now - before} more missed than last week`];

/** What each item's small square says (short enough to fit). */
const TILE: Record<string, string> = { Temps: "°C", Urgent: "FIX", Diary: "DAY", Cleaning: "CLEAN", Checks: "CHECK", Review: "4 WK", Rota: "ROTA" };

function itemRows(items: Item[], tone: keyof typeof TONE, boxed: boolean) {
  const [fg, bg] = TONE[tone];
  return items.map((it) => `<tr><td style="padding:${boxed ? "0 0 8px" : "0"};">
<a href="${esc(it.href)}" style="display:block;text-decoration:none;color:#14181f;${boxed ? `background:#fff7f6;border:1px solid #f6d5d1;border-radius:12px;padding:12px;` : `border-bottom:1px solid #eceff3;padding:12px 0;`}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="52" valign="top"><div style="width:40px;height:36px;border-radius:10px;background:${bg};color:${fg};font:800 10px/36px ${FONT};text-align:center;letter-spacing:0.02em;">${esc(TILE[it.tag] || it.tag.slice(0, 4).toUpperCase())}</div></td>
<td valign="top" style="font-family:${FONT};"><div style="font-size:15px;font-weight:700;line-height:1.3;">${esc(it.title)}</div>
<div style="font-size:13px;color:${MUTED};line-height:1.4;margin-top:2px;">${esc(it.detail)}</div>
<div style="font-size:13.5px;font-weight:700;color:#0062cc;margin-top:4px;">${esc(it.action)} ›</div></td></tr></table></a></td></tr>`).join("");
}
const section = (label: string, color: string, rows: string) => rows ? `<tr><td style="padding:18px 22px 4px;font-family:${FONT};">
<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:${color};margin-bottom:8px;">${label}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` : "";

export function weeklyEmail(w: Weekly, links: Links, diaryUrl: string): Built {
  const n = w.urgent.length + w.thisWeek.length + w.toPlan.length, first = w.name.split(" ")[0];
  const end = addDays(w.week, 6);
  const range = w.week.slice(0, 7) === end.slice(0, 7) ? `${fmt(w.week, { day: "numeric" })}–${fmt(end, { day: "numeric", month: "long" })}` : `${fmt(w.week, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short" })}`;
  const where = w.sites.length === 4 ? "the four sites" : "the " + listNames(w.sites);
  const subject = n ? `${plural(n, "thing")} need${n === 1 ? "s" : ""} you · week of ${fmt(w.week, { day: "numeric", month: "short" })}` : `All clear · week of ${fmt(w.week, { day: "numeric", month: "short" })}`;
  const chips = [[w.urgent.length, "urgent", "urgent"], [w.thisWeek.length, "this week", "week"], [w.toPlan.length, "to plan", "plan"]].filter(([c]) => c)
    .map(([c, t, k]) => `<span style="display:inline-block;font-size:12.5px;font-weight:700;color:${TONE[k as keyof typeof TONE][0]};background:${TONE[k as keyof typeof TONE][1]};border-radius:99px;padding:5px 11px;margin:0 6px 6px 0;">${c} ${t}</span>`).join("");
  const hero = n
    ? `<h1 style="margin:0;font-size:28px;line-height:1.15;letter-spacing:-0.02em;">${plural(n, "thing")} need${n === 1 ? "s" : ""} you</h1>
<p style="margin:6px 0 12px;font-size:15px;line-height:1.45;color:#39404d;">Morning ${esc(first)}. Here's last week at ${esc(where)}, and what to sort first.</p>${chips}`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="64" valign="middle"><div style="width:52px;height:52px;border-radius:26px;background:#1f7a45;color:#ffffff;font:800 26px/52px ${FONT};text-align:center;">✓</div></td>
<td valign="middle"><h1 style="margin:0;font-size:28px;line-height:1.15;letter-spacing:-0.02em;">All clear</h1><p style="margin:4px 0 0;font-size:15px;color:#39404d;">Nothing needs you this week, ${esc(first)}.</p></td></tr></table>
<p style="margin:12px 0 0;font-size:14.5px;line-height:1.5;color:#39404d;">${w.employeeDetails ? "Every open day was signed off, every reading was in range, no cleaning is overdue and there are no requests waiting." : "Every open day was signed off, every reading was in range and no cleaning is overdue. This summary covers business safety; private employee records are excluded."}</p>`;
  const head = `<tr><td style="padding:6px 0;font:700 10.5px ${FONT};color:${MUTED};"></td>${Array.from({ length: 7 }, (_, i) => { const d = addDays(w.week, i); return `<td align="center" style="padding:0 2px 4px;font:10.5px/1.25 ${FONT};color:${MUTED};"><b>${fmt(d, { weekday: "narrow" })}</b><br>${fmt(d, { day: "numeric" })}</td>`; }).join("")}</tr>`;
  const rows = w.grid.map((g) => `<tr><td style="padding:2px 6px 2px 0;font:700 13px ${FONT};color:${g.inUse ? "#14181f" : MUTED};white-space:nowrap;">${esc(g.name)}</td>${g.inUse
    ? g.cells.map((c) => `<td style="padding:2px;"><div style="height:28px;border-radius:7px;background:${CELL[c][0]};color:${CELL[c][1]};font:800 13px/28px ${FONT};text-align:center;">${CELL[c][2]}</div></td>`).join("")
    : `<td colspan="7" style="font:12.5px ${FONT};color:${MUTED};">Not in use yet</td>`}</tr>`).join("");
  const used = new Set(w.grid.flatMap((g) => g.cells));
  const key = (["ok", "miss", "warn", "closed"] as Cell[]).filter((c) => used.has(c)).map((c) => `<span style="margin-right:12px;white-space:nowrap;">${CELL[c][2]} ${{ ok: "signed off", miss: "missed", warn: "a reading out of range", closed: "closed" }[c]}</span>`).join("");
  const s = w.stats;
  const tile = (big: string, small: string, note: readonly [string, string]) => `<td width="33%" valign="top" style="padding:0 4px;"><div style="background:#ffffff;border:1px solid ${LINE};border-radius:10px;padding:10px 12px;font-family:${FONT};">
<div style="font-size:19px;font-weight:800;">${esc(big)}</div><div style="font-size:12px;color:${MUTED};line-height:1.3;">${esc(small)}</div><div style="font-size:11.5px;font-weight:700;color:${note[0]};margin-top:4px;">${esc(note[1])}</div></div></td>`;
  const diaryBox = `<tr><td style="padding:18px 22px 0;"><div style="padding:16px;border-radius:14px;background:#f6f8fb;font-family:${FONT};">
<div style="font-size:12px;font-weight:800;letter-spacing:0.08em;color:${MUTED};margin-bottom:10px;">THE DIARY LAST WEEK</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><col width="74">${head}${rows}</table>
<div style="margin-top:10px;font-size:12px;color:${MUTED};">${key}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>
${tile(`${s.signed}/${s.open}`, "days signed off", missedNote(s.open - s.signed, s.openPrev - s.signedPrev))}
${tile(String(s.out), s.out === 1 ? "reading out of range" : "readings out of range", change(s.out, s.outPrev, false))}
${tile(String(s.deliveries), s.rejected ? `deliveries, ${s.rejected} rejected` : "deliveries, none rejected", [MUTED, s.rejectedNote || (s.deliveries ? "All accepted" : "None logged")])}
</tr></table></div></td></tr>`;
  const alsoRows = w.also.map(([k, v], i) => `<tr><td style="padding:10px 0;${i < w.also.length - 1 ? "border-bottom:1px solid #eceff3;" : ""}font:14.5px ${FONT};color:#39404d;">${esc(k)}</td><td align="right" style="padding:10px 0;${i < w.also.length - 1 ? "border-bottom:1px solid #eceff3;" : ""}font:700 14.5px ${FONT};">${esc(v)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(n ? [...w.urgent, ...w.thisWeek, ...w.toPlan].slice(0, 3).map((i) => i.title).join(" · ") : "Every open day signed off and nothing waiting.")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;"><tr><td align="center" style="padding:20px 12px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;font-family:${FONT};color:#14181f;">
<tr><td style="padding:20px 22px 18px;border-bottom:1px solid ${LINE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-weight:800;letter-spacing:0.32em;font-size:13px;">STRANGERS</td><td align="right" style="font-size:12px;font-weight:600;color:${MUTED};">${esc(range)}</td></tr></table>
<div style="margin-top:14px;">${hero}</div></td></tr>
${section("URGENT", TONE.urgent[0], itemRows(w.urgent, "urgent", true))}
${section("THIS WEEK", TONE.week[0], itemRows(w.thisWeek, "week", false))}
${section("TO PLAN", TONE.plan[0], itemRows(w.toPlan, "plan", false))}
${diaryBox}
${alsoRows ? `<tr><td style="padding:20px 22px 0;"><div style="font:800 12px ${FONT};letter-spacing:0.08em;color:${MUTED};margin-bottom:4px;">ALSO THIS WEEK</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${alsoRows}</table></td></tr>` : ""}
<tr><td style="padding:18px 22px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="50%" style="padding-right:4px;"><a href="${esc(diaryUrl)}" style="display:block;text-align:center;background:#0062cc;color:#ffffff;font-weight:700;text-decoration:none;border-radius:12px;padding:13px 10px;">Open the diary</a></td>
<td width="50%" style="padding-left:4px;"><a href="${esc(links.rota)}" style="display:block;text-align:center;background:#eef4fc;color:#0058b8;font-weight:700;text-decoration:none;border-radius:12px;padding:13px 10px;">Open the rota</a></td></tr></table></td></tr>
<tr><td style="border-top:1px solid ${LINE};padding:14px 22px 18px;font-size:12.5px;line-height:1.5;color:${MUTED};">Every Monday at 07:30, to managers of ${esc(where)}.<br>
<a href="${esc(links.prefs)}" style="color:${MUTED};">Choose which emails you get</a> · <a href="${esc(links.unsubscribe)}" style="color:${MUTED};">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
  const textItems = (label: string, xs: Item[]) => xs.length ? `\n${label}\n${xs.map((i) => `- ${i.title} (${i.detail})`).join("\n")}\n` : "";
  const text = `${n ? `${plural(n, "thing")} need${n === 1 ? "s" : ""} you` : "All clear"}: week of ${dayMonth(w.week)} at ${where}.\n${textItems("URGENT", w.urgent)}${textItems("THIS WEEK", w.thisWeek)}${textItems("TO PLAN", w.toPlan)}
Last week: ${s.signed} of ${s.open} days signed off, ${plural(s.out, "reading")} out of range, ${plural(s.deliveries, "delivery", "deliveries")} (${s.rejected} rejected).
${w.also.map(([k, v]) => `${k}: ${v}`).join("\n")}

Open the diary: ${diaryUrl}
Open the rota: ${links.rota}
--
Choose which emails you get: ${links.prefs}
Unsubscribe: ${links.unsubscribe}
`;
  return { subject, html, text };
}

/* ---------- sending ---------- */

interface Manager { id: string; name: string; email: string | null; email_prefs: string; active: number; role: string }

/** Sends the Monday summary to every manager and admin who has it on. Once a week, whatever retries the cron makes. */
export async function sendWeeklySummaries(env: Env, base: { rota: string; diary: string }, opts: { anyTime?: boolean } = {}): Promise<number> {
  if (!emailReady(env)) return 0;
  const today = londonToday();
  if (!opts.anyTime && (new Date(today + "T12:00:00Z").getUTCDay() !== 1 || londonHour() !== 7)) return 0; // 07:xx on a Monday, UK time
  // Claim this week (meta 'weekly_sent' = the Monday, as a number), so a second run sends nothing.
  const stamp = Number(today.replace(/-/g, ""));
  await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('weekly_sent', 0)").run();
  const claim = await env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'weekly_sent' AND v < ?").bind(stamp, stamp).run();
  if (!claim.meta.changes) return 0;
  const { results } = await env.DB.prepare("SELECT id, name, email, email_prefs, active, role FROM users WHERE active = 1 AND role IN ('manager', 'admin') AND email IS NOT NULL").all<Manager>();
  let sent = 0;
  for (const m of results) {
    if (!prefsOf(m.email_prefs).weekly) continue;
    if ((await sendSummary(env, base, m, today)) === "sent") sent++;
  }
  await audit(env, "email_weekly", null, `Sent the Monday summary to ${plural(sent, "manager")}`);
  return sent;
}

/** Builds and sends one person's summary (also the admin section's "send me this week's summary"). */
export async function sendSummary(env: Env, base: { rota: string; diary: string }, m: Manager, today = londonToday()) {
  const kind: EmailKind = "weekly";
  const links = await linksFor(env, base, m.id, kind);
  const data = await weeklyData(env, weeklySitesOf(m.email_prefs), today, base, m.name, { admin: m.role === "admin" });
  const o: Outgoing = { to: { ...m, email: m.email! }, kind, links, mail: weeklyEmail(data, links, base.diary), about: "the Monday summary" };
  return send(env, o);
}
