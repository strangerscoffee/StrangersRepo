// Wholesale Insights: the sums, forecast and roast plan (Admin → Wholesale → Insights; src/insights.ts reads the data).
// No imports, so tests load it directly. Everything is worked out in UK calendar days ("YYYY-MM-DD") and weeks that
// start on Monday. Money is integer pence, weight integer grams.

export type Pack = "quarter" | "kilo" | "half" | "other";
/** One coffee line of a sale: from a site order, or a QuickBooks history row mapped to a coffee. */
export interface SaleLine {
  day: string; customer: string; coffee: string; title: string; pack: Pack; bags: number; grams: number; pence: number;
  source: "site" | "history"; order: string;
}
export interface OpenLine { coffee: string; title: string; grams: number; bags: number; customer?: string; dispatchDate?: string }
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
type Model = "recent" | "average4" | "average8" | "robust" | "intermittent" | "cycle";
interface Observation { week: string; tick: number; grams: number }
interface Trial { origin: number; target: number; lead: number; actual: number; predicted: number; error: number }
export interface ForecastValidation { samples: number; origins: number; maeGrams: number | null; biasGrams: number | null }
export interface Forecast {
  weeks: WeekPoint[]; basis: "seasonal" | "recent" | "none"; recentWeekly: number;
  model: Model | "coffee-mix"; modelLabel: string; validation: ForecastValidation; rangeBasis: "backtest" | "limited";
}
const MODELS: Model[] = ["recent", "average4", "average8", "robust", "intermittent", "cycle"];
const MODEL_LABELS = { recent: "Recent level and trend", average4: "Four-week average", average8: "Eight-week average", robust: "Outlier-resistant trend", intermittent: "Occasional ordering", cycle: "Repeating order pattern", "coffee-mix": "Combined coffee forecasts" };
const ORIGINS = 16; // Bounded work per coffee; no training service or dependencies.
const weekTick = (week: string) => Math.floor(toTime(week) / (7 * DAY));
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * p;
  return sorted.length ? sorted[Math.floor(at)] + (sorted[Math.ceil(at)] - sorted[Math.floor(at)]) * (at % 1) : 0;
};
const smooth = (values: number[]) => {
  let level = mean(values.slice(0, 4));
  for (const v of values) level = 0.3 * v + 0.7 * level;
  return level;
};

/** Every fit sees only its training prefix. Dates, not array positions, determine the lead. */
function fitModels(rows: Observation[]) {
  const coveredWeeks = rows.length;
  rows = rows.slice(-104); // No candidate needs more than two years at a historical cutoff.
  const values = rows.map(r => Math.max(0, r.grams)), recent = values.slice(-12), last = rows.at(-1)!.tick;
  const level = smooth(recent), prev8 = values.length >= 16 ? mean(values.slice(-16, -8)) : 0;
  const growth = prev8 > 0 && mean(values.slice(-8)) > 0 ? clamp(Math.pow(mean(values.slice(-8)) / prev8, 1 / 8) - 1, -0.03, 0.03) : 0;
  const centre = median(recent), deviation = median(recent.map(v => Math.abs(v - centre)));
  const radius = 3 * Math.max(deviation * 1.4826, centre * 0.2, 1);
  const robust = recent.map(v => clamp(v, Math.max(0, centre - radius), centre + radius));
  const exceptional = recent.filter((v, i) => v !== robust[i]).length;
  const fallback: Model = recent.length >= 8 && recent.filter(v => v > 0).length / recent.length >= 0.75 && exceptional > 0 && exceptional <= 2 ? "robust" : "recent";
  const robustLevel = smooth(robust), before = mean(robust.slice(-8, -4)), after = mean(robust.slice(-4));
  const robustGrowth = before > 0 && after > 0 ? clamp(Math.pow(after / before, 1 / 4) - 1, -0.03, 0.03) : 0;
  const positive = rows.filter(r => r.grams > 0).slice(-12);
  const cycleSize = median(positive.map(r => r.grams));
  const gaps = positive.slice(1).map((r, i) => r.tick - positive[i].tick), period = Math.round(median(gaps));
  const cycle = positive.length >= 4 && period >= 2 && period <= 8 && gaps.every(g => g === period) && last - positive.at(-1)!.tick < 2 * period;
  let probability = values.slice(-52).filter(v => v > 0).length / Math.min(52, values.length);
  let orderSize = mean(values.slice(-52).filter(v => v > 0));
  for (const value of values.slice(-52)) { probability = 0.15 * Number(value > 0) + 0.85 * probability; if (value > 0) orderSize = 0.2 * value + 0.8 * orderSize; }
  const eligible = MODELS.filter(m => m !== "cycle" || cycle).filter(m => m !== "intermittent" || (positive.length >= 3 && values.slice(-26).filter(v => v === 0).length / Math.min(26, values.length) >= 0.35));
  const lookup = new Map(rows.map(r => [r.tick, Math.max(0, r.grams)]));
  const yearlyBase = Array.from({ length: 8 }, (_, i) => lookup.get(last - 52 - i));
  const yearLevel = yearlyBase.every(v => v !== undefined) ? mean(yearlyBase as number[]) : 0;
  const seasonal = rows.length >= 60 && yearlyBase.every(v => v !== undefined) && yearlyBase.filter(v => v! > 0).length >= 4 && yearLevel > 0;
  const seasons = new Map<number, number>();
  const season = (tick: number) => {
    if (!seasonal) return 1;
    if (seasons.has(tick)) return seasons.get(tick)!;
    const around = Array.from({ length: 5 }, (_, i) => lookup.get(tick - 52 + i - 2));
    if (around.some(v => v === undefined)) return 1;
    const ratio = clamp(mean(around as number[]) / yearLevel, 0.5, 2.5);
    // One yearly comparison is evidence, not certainty. Shrink its effect towards the recent level.
    const value = 1 + (ratio - 1) * Math.min(0.85, 0.6 + (coveredWeeks - 60) / 208);
    seasons.set(tick, value);
    return value;
  };
  const rawPrediction = (model: Model, tick: number) => {
    const lead = Math.max(1, tick - last);
    if (model === "cycle" && cycle) return (tick - positive.at(-1)!.tick) % period === 0 ? cycleSize : 0;
    let estimate = model === "average4" ? mean(values.slice(-4)) : model === "average8" ? mean(values.slice(-8)) : model === "intermittent" ? probability * orderSize : model === "robust" ? robustLevel : level;
    if (model === "recent" || model === "robust") for (let k = 1; k <= Math.min(lead, 104); k++) estimate *= 1 + (model === "robust" ? robustGrowth : growth) * Math.pow(0.9, k);
    return Math.max(0, estimate * season(tick));
  };
  const predictions: Partial<Record<Model, Map<number, number>>> = {};
  const predict = (model: Model, tick: number) => {
    const cached = predictions[model] ||= new Map();
    if (!cached.has(tick)) cached.set(tick, rawPrediction(model, tick));
    return cached.get(tick)!;
  };
  return { predict, eligible, season, fallback };
}

/** Select only on outcomes that were already observable at the historical cutoff. */
function chooseModel(scores: Record<Model, Trial[]>, cutoff: number, eligible: Model[], fallback: Model): Model {
  const scored = eligible.map(model => {
    let origins = 0, lastOrigin = -Infinity, squaredError = 0, count = 0;
    for (const trial of scores[model]) if (trial.target <= cutoff) {
      if (lastOrigin !== trial.origin) { origins++; lastOrigin = trial.origin; }
      squaredError += trial.error * trial.error; count++;
    }
    // Expected production volume needs a mean forecast. MAE-only selection can reward
    // predicting zero for occasional sellers; squared error penalises missed volume.
    return { model, origins, error: count ? Math.sqrt(squaredError / count) : 0 };
  });
  const base = scored.find(s => s.model === fallback)!;
  if (base.origins < 6) return fallback;
  const best = scored.filter(s => s.origins >= 6).sort((a, b) => a.error - b.error)[0];
  return best && best.error < base.error * 0.97 ? best.model : fallback;
}
const validationOf = (trials: Trial[]): ForecastValidation => ({ samples: trials.length, origins: new Set(trials.map(t => t.origin)).size,
  maeGrams: trials.length ? Math.round(mean(trials.map(t => Math.abs(t.error)))) : null, biasGrams: trials.length ? Math.round(mean(trials.map(t => t.error))) : null });

function predictionBand(grams: number, lead: number, trials: Trial[], typical: number) {
  const atLead = trials.filter(t => t.lead === lead).map(t => t.error);
  const floor = Math.max(100, Math.max(0, typical) * 0.05 * Math.sqrt(lead));
  if (atLead.length >= 6) return { low: Math.round(Math.max(0, Math.min(grams, grams + quantile(atLead, 0.1)) - floor)), high: Math.round(Math.max(grams, grams + quantile(atLead, 0.9)) + floor), measured: true };
  const near = trials.filter(t => t.lead === 1).map(t => t.error);
  const width = Math.max(floor, (near.length ? Math.sqrt(mean(near.map(e => e * e))) * 1.28 : Math.max(grams, typical) * 0.4) * Math.sqrt(lead));
  return { low: Math.round(Math.max(0, grams - width)), high: Math.round(grams + width), measured: false };
}

function forecastRun(series: { week: string; grams: number }[], nextWeek: string, ahead: number): { forecast: Forecast; trials: Trial[] } {
  const rows = series.filter(r => r.week < nextWeek && Number.isFinite(r.grams)).map(r => ({ ...r, tick: weekTick(r.week) })).sort((a, b) => a.tick - b.tick);
  const weeks = Array.from({ length: ahead }, (_, i) => addDays(nextWeek, i * 7));
  const recentWeekly = Math.round(mean(rows.slice(-4).map(r => r.grams)));
  if (!rows.some(r => r.grams > 0)) return { forecast: { weeks: weeks.map(week => ({ week, grams: 0, low: 0, high: 0 })), basis: "none", recentWeekly, model: "recent", modelLabel: MODEL_LABELS.recent, validation: validationOf([]), rangeBasis: "limited" }, trials: [] };
  const lead = Math.max(1, weekTick(nextWeek) - rows.at(-1)!.tick), maxLead = Math.min(26, lead + ahead - 1);
  const scores = Object.fromEntries(MODELS.map(m => [m, []])) as unknown as Record<Model, Trial[]>;
  const trials: Trial[] = [];
  for (let cut = Math.max(1, rows.length - ORIGINS); cut < rows.length; cut++) {
    const fit = fitModels(rows.slice(0, cut)), origin = rows[cut - 1].tick;
    const selected = chooseModel(scores, origin, fit.eligible, fit.fallback);
    for (let target = cut; target < rows.length && rows[target].tick - origin <= maxLead; target++) {
      const row = rows[target], horizon = row.tick - origin;
      if (horizon <= 0) continue;
      for (const model of MODELS) {
        const predicted = Math.round(fit.predict(fit.eligible.includes(model) ? model : "recent", row.tick));
        const trial = { origin, target: row.tick, lead: horizon, actual: Math.max(0, row.grams), predicted, error: Math.max(0, row.grams) - predicted };
        scores[model].push(trial);
        if (model === selected) trials.push(trial);
      }
    }
  }
  const fit = fitModels(rows), model = chooseModel(scores, rows.at(-1)!.tick, fit.eligible, fit.fallback), typical = Math.max(0, mean(rows.slice(-12).map(r => r.grams)));
  let measured = true;
  const points = weeks.map(week => {
    const tick = weekTick(week), grams = Math.round(fit.predict(model, tick)), band = predictionBand(grams, tick - rows.at(-1)!.tick, trials, typical);
    measured &&= band.measured;
    return { week, grams, low: band.low, high: band.high };
  });
  return { forecast: { weeks: points, basis: weeks.some(w => model !== "cycle" && fit.season(weekTick(w)) !== 1) ? "seasonal" : "recent", recentWeekly, model, modelLabel: MODEL_LABELS[model], validation: validationOf(trials.filter(t => t.lead >= lead && t.lead < lead + ahead)), rangeBasis: measured ? "backtest" : "limited" }, trials };
}

/** Complete weeks only. A bounded rolling-origin evaluation chooses between six small models. */
export function forecastSeries(series: { week: string; grams: number }[], nextWeek: string, ahead: number): Forecast {
  return forecastRun(series, nextWeek, ahead).forecast;
}

/** Sum the coffee predictions, and measure the same bottom-up procedure at past cutoffs. */
function combinedForecast(series: { week: string; grams: number }[], nextWeek: string, ahead: number, runs: { forecast: Forecast; trials: Trial[] }[]): Forecast {
  const rows = series.map(r => ({ ...r, tick: weekTick(r.week) }));
  const recentWeekly = Math.round(mean(rows.slice(-4).map(r => r.grams))), weeks = Array.from({ length: ahead }, (_, i) => addDays(nextWeek, i * 7));
  if (!rows.length || (!rows.some(r => r.grams > 0) && !runs.some(r => r.forecast.weeks.some(p => p.grams > 0)))) return { weeks: weeks.map(week => ({ week, grams: 0, low: 0, high: 0 })), basis: "none", recentWeekly, model: "coffee-mix", modelLabel: MODEL_LABELS["coffee-mix"], validation: validationOf([]), rangeBasis: "limited" };
  const firstLead = Math.max(1, weekTick(nextWeek) - rows.at(-1)!.tick), maxLead = Math.min(26, firstLead + ahead - 1);
  const predicted = new Map<string, number>();
  for (const run of runs) for (const trial of run.trials) {
    const key = `${trial.origin}:${trial.target}`;
    predicted.set(key, (predicted.get(key) || 0) + trial.predicted);
  }
  const trials: Trial[] = [];
  for (let cut = Math.max(1, rows.length - ORIGINS); cut < rows.length; cut++) {
    const origin = rows[cut - 1].tick;
    for (let target = cut; target < rows.length && rows[target].tick - origin <= maxLead; target++) {
      const row = rows[target], estimate = predicted.get(`${origin}:${row.tick}`) || 0;
      // A coffee not yet launched at this cutoff contributes no invented historical prediction.
      trials.push({ origin, target: row.tick, lead: row.tick - origin, actual: Math.max(0, row.grams), predicted: estimate, error: Math.max(0, row.grams) - estimate });
    }
  }
  let measured = true;
  const typical = Math.max(0, mean(rows.slice(-12).map(r => r.grams)));
  const points = weeks.map((week, i) => {
    const grams = runs.reduce((sum, r) => sum + (r.forecast.weeks[i]?.grams || 0), 0);
    const band = predictionBand(grams, weekTick(week) - rows.at(-1)!.tick, trials, typical);
    measured &&= band.measured;
    return { week, grams, low: band.low, high: band.high };
  });
  return { weeks: points, basis: runs.some(r => r.forecast.basis === "seasonal") ? "seasonal" : "recent", recentWeekly, model: "coffee-mix", modelLabel: MODEL_LABELS["coffee-mix"], validation: validationOf(trials.filter(t => t.lead >= firstLead && t.lead < firstLead + ahead)), rangeBasis: measured ? "backtest" : "limited" };
}

/* ---------- everything for the page ---------- */
export interface WeekRow { week: string; pence: number; grams: number; bags: number; quarter: number; kilo: number; other: number; orders: number; byCoffee: Record<string, [number, number, number, number]> }
export function buildInsights(input: { today: string; lines: SaleLine[]; open: OpenLine[]; settings: InsightSettings; ahead?: number }) {
  const { today, lines, open, settings } = input, ahead = input.ahead ?? 8;
  const thisWeek = mondayOf(today), nextWeek = addDays(thisWeek, 7);
  const titles = new Map<string, string>();
  const coffeeStarts = new Map<string, string>();
  const weeks = new Map<string, WeekRow & { orderSet: Set<string> }>();
  const customers = new Map<string, { name: string; days: Set<string>; orders: Set<string>; pence: number; grams: number; recentPence: number; recentGrams: number; coffees: Map<string, number> }>();
  let first: string | null = null;
  for (const l of lines) {
    if (l.day > today) continue;
    titles.set(l.coffee, l.title);
    if (l.grams > 0 && (!coffeeStarts.has(l.coffee) || l.day < coffeeStarts.get(l.coffee)!)) coffeeStarts.set(l.coffee, l.day);
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
  const coffeeKeys = [...titles.keys()];
  const coffeeRuns = coffeeKeys.map(key => {
    const start = coffeeStarts.has(key) ? mondayOf(coffeeStarts.get(key)!) : thisWeek;
    return { key, ...forecastRun(complete.filter(w => w.week >= start).map(w => ({ week: w.week, grams: w.byCoffee[key]?.[0] || 0 })), nextWeek, ahead) };
  });
  const total = combinedForecast(complete.map(w => ({ week: w.week, grams: w.grams })), nextWeek, ahead, coffeeRuns);
  const byCoffee = coffeeRuns.map(({ key, forecast }) => ({ key, title: titles.get(key)!, ...forecast }))
    .filter((f) => f.recentWeekly > 0 || f.weeks.some((p) => p.grams > 0)).sort((a, b) => b.weeks[0].grams - a.weeks[0].grams);
  // Roast plan for next week: what's ordered but not yet packed, plus what's expected next week, in whole batches.
  const openBy = new Map<string, { backlog: number; committed: number }>();
  let laterGrams = 0;
  for (const o of open) {
    if (o.dispatchDate && o.dispatchDate > addDays(nextWeek, 6)) { laterGrams += o.grams; continue; }
    const e = openBy.get(o.coffee) || { backlog: 0, committed: 0 };
    if (o.dispatchDate && o.dispatchDate >= nextWeek) e.committed += o.grams; else e.backlog += o.grams;
    openBy.set(o.coffee, e); titles.set(o.coffee, o.title);
  }
  const yieldG = Math.max(1, settings.yieldKg * 1000);
  const roastKeys = new Set([...openBy.keys(), ...byCoffee.map((f) => f.key)]);
  const roast = [...roastKeys].map((key) => {
    const booked = openBy.get(key) || { backlog: 0, committed: 0 };
    const openGrams = booked.backlog + booked.committed, forecastGrams = byCoffee.find((f) => f.key === key)?.weeks[0]?.grams || 0;
    const additionalForecastGrams = Math.max(0, forecastGrams - booked.committed);
    const needed = openGrams + additionalForecastGrams, batches = Math.ceil(needed / yieldG - 1e-9);
    return { key, title: titles.get(key) || key, openGrams, forecastGrams, additionalForecastGrams, backlogGrams: booked.backlog, committedGrams: booked.committed, neededGrams: needed, batches, greenKg: batches * settings.batchKg, roastedKg: batches * settings.yieldKg };
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
    roast: { week: nextWeek, laterGrams, batchKg: settings.batchKg, yieldKg: settings.yieldKg, rows: roast, batches: roast.reduce((t, r) => t + r.batches, 0), greenKg: roast.reduce((t, r) => t + r.greenKg, 0) },
  };
}

/** The same date `months` calendar months on (monthly standing orders use the 1st to the 28th, so every month has it). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number), index = y * 12 + (m - 1) + months;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
