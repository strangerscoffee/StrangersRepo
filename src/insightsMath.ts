// Wholesale Insights: the sums, forecast and roast plan (Admin → Wholesale → Insights; src/insights.ts reads the data).
// No imports, so tests load it directly. Everything is worked out in UK calendar days ("YYYY-MM-DD") and weeks that
// start on Monday. Money is integer pence, weight integer grams.

export type Pack = "quarter" | "kilo" | "half" | "other";
/** One coffee line of a sale: from a site order, or a QuickBooks history row mapped to a coffee. */
export interface SaleLine {
  day: string; customer: string; coffee: string; title: string; pack: Pack; bags: number; grams: number; pence: number;
  source: "site" | "history"; order: string;
}
export interface OpenLine { coffee: string; title: string; grams: number; bags: number; customer?: string }
export interface InsightSettings { batchKg: number; yieldKg: number; historyUntil: string | null }

const DAY = 864e5;
const toTime = (day: string) => Date.parse(day + "T12:00:00Z");
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromTime(toTime(day) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);
/** The Monday of a day's week. */
export function mondayOf(day: string) { const dow = new Date(toTime(day)).getUTCDay(); return addDays(day, -((dow + 6) % 7)); }
export const ukDay = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(ms));
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
/** The key a customer is matched by across site orders and QuickBooks history (case, accents and punctuation ignored). */
export const customerKey = (value: string) => norm(value) || "unknown";
const norm = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- QuickBooks product names → coffee and bag size ---------- */
export interface Mapping { coffee: string | null; title: string; pack: Pack | "ignore"; grams: number }
/** A first guess for a QuickBooks product/service name: which coffee (by its name or title) and which bag (250 g,
 *  1 kg, 500 g). Names with no coffee in them are "ignore" (delivery, cups, equipment) until an admin says otherwise. */
export function suggestMapping(product: string, coffees: { id: string; name: string; title: string }[]): Mapping {
  const n = ` ${norm(product)} `;
  const pack: Pack | null = /\b(1 ?kg|1000 ?g|kilo)\b/.test(n) ? "kilo" : /\b250 ?g?\b/.test(n) ? "quarter" : /\b500 ?g\b/.test(n) ? "half" : null;
  let best: { id: string; title: string; score: number } | null = null;
  for (const c of coffees) {
    for (const label of [c.name, c.title]) {
      const words = norm(label).split(" ").filter((w) => w.length > 2 && !["the", "and", "natural", "washed", "blend", "coffee"].includes(w));
      if (!words.length) continue;
      const hits = words.filter((w) => n.includes(` ${w} `)).length, score = hits / words.length + (n.includes(` ${norm(label)} `) ? 1 : 0);
      if (hits && score >= 0.5 && (!best || score > best.score)) best = { id: c.id, title: c.title, score };
    }
  }
  if (!best) return { coffee: null, title: product, pack: "ignore", grams: 0 };
  const p = pack || "kilo";
  return { coffee: best.id, title: best.title, pack: p, grams: { quarter: 250, kilo: 1000, half: 500, other: 0 }[p] };
}

/* ---------- forecasting ---------- */
export interface WeekPoint { week: string; grams: number; low: number; high: number }
export interface Forecast { weeks: WeekPoint[]; basis: "seasonal" | "recent" | "none"; recentWeekly: number }
/**
 * Expected grams for each of the next `ahead` weeks from a weekly series (complete weeks only, oldest first, ending
 * the week before `nextWeek`). The level is an exponentially weighted average of the last 12 weeks; a gentle trend
 * (the last 8 weeks against the 8 before, capped at ±3% a week and fading out); and, with over a year of history,
 * last year's shape around the same weeks. The range is the typical miss of that level over recent weeks (about 80%).
 */
export function forecastSeries(series: { week: string; grams: number }[], nextWeek: string, ahead: number): Forecast {
  const weeks = Array.from({ length: ahead }, (_, i) => addDays(nextWeek, i * 7));
  const values = series.map((s) => s.grams);
  if (!values.some((v) => v > 0)) return { weeks: weeks.map((week) => ({ week, grams: 0, low: 0, high: 0 })), basis: "none", recentWeekly: 0 };
  const recent = values.slice(-12), alpha = 0.3;
  let level = mean(recent.slice(0, Math.min(4, recent.length))); const misses: number[] = [];
  for (const v of recent) { misses.push(v - level); level = alpha * v + (1 - alpha) * level; }
  const last8 = mean(values.slice(-8)), prev8 = values.length >= 16 ? mean(values.slice(-16, -8)) : 0;
  const growth = prev8 > 0 && last8 > 0 ? Math.max(-0.03, Math.min(0.03, Math.pow(last8 / prev8, 1 / 8) - 1)) : 0;
  const spread = Math.sqrt(mean(misses.map((m) => m * m))) * 1.28;
  const byWeek = new Map(series.map((s) => [s.week, s.grams]));
  const seasonal = series.length >= 60;
  const avgAround = (centre: string, from: number, to: number) => { const xs: number[] = []; for (let i = from; i <= to; i++) xs.push(byWeek.get(addDays(centre, i * 7)) ?? 0); return mean(xs); };
  const baseLastYear = seasonal ? avgAround(addDays(nextWeek, -364), -8, -1) : 0;
  let basis: Forecast["basis"] = "recent";
  const points = weeks.map((week, i) => {
    let factor = 1;
    for (let k = 1; k <= i + 1; k++) factor *= 1 + growth * Math.pow(0.9, k);
    let season = 1;
    if (seasonal && baseLastYear > 0) {
      const then = avgAround(addDays(week, -364), -2, 2);
      if (then > 0) { season = Math.max(0.5, Math.min(2.5, then / baseLastYear)); basis = "seasonal"; }
    }
    const grams = Math.max(0, level * factor * season), width = spread * Math.sqrt(1 + i * 0.25) * season;
    return { week, grams: Math.round(grams), low: Math.round(Math.max(0, grams - width)), high: Math.round(grams + width) };
  });
  return { weeks: points, basis, recentWeekly: Math.round(mean(values.slice(-4))) };
}

/* ---------- everything for the page ---------- */
export interface WeekRow { week: string; pence: number; grams: number; bags: number; quarter: number; kilo: number; other: number; orders: number; byCoffee: Record<string, [number, number, number, number]> }
export function buildInsights(input: { today: string; lines: SaleLine[]; open: OpenLine[]; settings: InsightSettings; ahead?: number }) {
  const { today, lines, open, settings } = input, ahead = input.ahead ?? 8;
  const thisWeek = mondayOf(today), nextWeek = addDays(thisWeek, 7);
  const titles = new Map<string, string>();
  const weeks = new Map<string, WeekRow & { orderSet: Set<string> }>();
  const customers = new Map<string, { name: string; days: Set<string>; orders: Set<string>; pence: number; grams: number; recentPence: number; recentGrams: number; coffees: Map<string, number> }>();
  let first: string | null = null;
  for (const l of lines) {
    if (l.day > today) continue;
    titles.set(l.coffee, l.title);
    if (!first || l.day < first) first = l.day;
    const w = mondayOf(l.day);
    const row = weeks.get(w) || { week: w, pence: 0, grams: 0, bags: 0, quarter: 0, kilo: 0, other: 0, orders: 0, byCoffee: {}, orderSet: new Set<string>() };
    row.pence += l.pence; row.grams += l.grams; row.bags += l.bags; row.orderSet.add(l.order);
    if (l.pack === "quarter") row.quarter += l.bags; else if (l.pack === "kilo") row.kilo += l.bags; else row.other += l.bags;
    const c = row.byCoffee[l.coffee] || (row.byCoffee[l.coffee] = [0, 0, 0, 0]);
    c[0] += l.grams; c[1] += l.pence; if (l.pack === "quarter") c[2] += l.bags; else if (l.pack === "kilo") c[3] += l.bags;
    weeks.set(w, row);
    const key = norm(l.customer) || "unknown";
    const cu = customers.get(key) || { name: l.customer || "Unknown", days: new Set<string>(), orders: new Set<string>(), pence: 0, grams: 0, recentPence: 0, recentGrams: 0, coffees: new Map<string, number>() };
    cu.days.add(l.day); cu.orders.add(l.order); cu.pence += l.pence; cu.grams += l.grams;
    if (daysBetween(l.day, today) < 91) { cu.recentPence += l.pence; cu.recentGrams += l.grams; }
    cu.coffees.set(l.coffee, (cu.coffees.get(l.coffee) || 0) + l.grams);
    if (l.source === "site") cu.name = l.customer || cu.name;
    customers.set(key, cu);
  }
  // A continuous run of weeks from the first sale to this week (empty weeks count as nothing sold).
  const weekly: WeekRow[] = [];
  if (first) for (let w = mondayOf(first); w <= thisWeek; w = addDays(w, 7)) {
    const row = weeks.get(w);
    weekly.push(row ? { week: w, pence: row.pence, grams: row.grams, bags: row.bags, quarter: row.quarter, kilo: row.kilo, other: row.other, orders: row.orderSet.size, byCoffee: row.byCoffee } : { week: w, pence: 0, grams: 0, bags: 0, quarter: 0, kilo: 0, other: 0, orders: 0, byCoffee: {} });
  }
  const complete = weekly.filter((w) => w.week < thisWeek);
  const total = forecastSeries(complete.map((w) => ({ week: w.week, grams: w.grams })), nextWeek, ahead);
  const coffeeKeys = [...titles.keys()];
  const byCoffee = coffeeKeys.map((key) => ({ key, title: titles.get(key)!, ...forecastSeries(complete.map((w) => ({ week: w.week, grams: w.byCoffee[key]?.[0] || 0 })), nextWeek, ahead) }))
    .filter((f) => f.recentWeekly > 0 || f.weeks.some((p) => p.grams > 0)).sort((a, b) => b.weeks[0].grams - a.weeks[0].grams);
  // Roast plan for next week: what's ordered but not yet packed, plus what's expected next week, in whole batches.
  const openBy = new Map<string, OpenLine>();
  for (const o of open) { const e = openBy.get(o.coffee) || { coffee: o.coffee, title: o.title, grams: 0, bags: 0 }; e.grams += o.grams; e.bags += o.bags; openBy.set(o.coffee, e); titles.set(o.coffee, o.title); }
  const yieldG = Math.max(1, settings.yieldKg * 1000);
  const roastKeys = new Set([...openBy.keys(), ...byCoffee.map((f) => f.key)]);
  const roast = [...roastKeys].map((key) => {
    const openGrams = openBy.get(key)?.grams || 0, forecastGrams = byCoffee.find((f) => f.key === key)?.weeks[0]?.grams || 0;
    const needed = openGrams + forecastGrams, batches = Math.ceil(needed / yieldG - 1e-9);
    return { key, title: titles.get(key) || key, openGrams, forecastGrams, neededGrams: needed, batches, greenKg: batches * settings.batchKg, roastedKg: batches * settings.yieldKg };
  }).filter((r) => r.neededGrams > 0).sort((a, b) => b.neededGrams - a.neededGrams || a.title.localeCompare(b.title));
  // Each customer's usual rhythm: the median gap between order days, and whether they're due or overdue.
  const customerRows = [...customers.values()].map((c) => {
    const days = [...c.days].sort(), last = days[days.length - 1];
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).filter((g) => g > 0);
    const usual = gaps.length >= 2 ? Math.round(median(gaps)) : null;
    const due = usual ? addDays(last, usual) : null, late = usual && due ? daysBetween(due, today) : null;
    const status = !usual ? "new" : late! > Math.max(14, usual) ? "quiet" : late! > Math.max(3, Math.round(usual * 0.25)) ? "overdue" : late! >= -3 ? "due" : "ok";
    const top = [...c.coffees.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => titles.get(k) || k);
    return { key: customerKey(c.name), name: c.name, orders: c.orders.size, pence: c.pence, grams: c.grams, recentPence: c.recentPence, recentGrams: c.recentGrams, first: days[0], last, usualDays: usual, nextDue: due, status, top };
  }).sort((a, b) => b.recentGrams - a.recentGrams || b.grams - a.grams);
  return {
    today, thisWeek, nextWeek, firstSale: first,
    coffees: coffeeKeys.map((key) => ({ key, title: titles.get(key)! })).sort((a, b) => a.title.localeCompare(b.title)),
    weekly, customers: customerRows,
    forecast: { total, byCoffee },
    roast: { week: nextWeek, batchKg: settings.batchKg, yieldKg: settings.yieldKg, rows: roast, batches: roast.reduce((t, r) => t + r.batches, 0), greenKg: roast.reduce((t, r) => t + r.greenKg, 0) },
  };
}
