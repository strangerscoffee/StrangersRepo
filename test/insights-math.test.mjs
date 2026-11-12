// Wholesale Insights sums (src/insightsMath.ts): weeks, forecast, roast batches, customer rhythm and the first guess
// at which coffee and bag a QuickBooks product name means.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, mondayOf, forecastSeries, buildInsights, suggestMapping } from "../src/insightsMath.ts";

const weeksBack = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, -7 * (n - i)));

test("weeks start on Monday, in UK calendar days", () => {
  assert.equal(mondayOf("2026-11-12"), "2026-11-09");
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-15"), "2026-11-09");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
});

test("forecast: a steady seller stays steady, with a range; nothing sold forecasts nothing", () => {
  const next = "2026-11-16", series = weeksBack(next, 20).map((week, i) => ({ week, grams: 40000 + (i % 2 ? 2000 : -2000) }));
  const f = forecastSeries(series, next, 4);
  assert.equal(f.basis, "recent");
  for (const p of f.weeks) { assert.ok(Math.abs(p.grams - 40000) < 2500, String(p.grams)); assert.ok(p.low < p.grams && p.high > p.grams); }
  assert.deepEqual(f.weeks.map((p) => p.week), ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  assert.equal(forecastSeries(series.map((s) => ({ ...s, grams: 0 })), next, 2).basis, "none");
});

test("forecast: growth lifts it gently; a year of history brings in last year's December rise", () => {
  const next = "2026-11-16";
  const growing = weeksBack(next, 16).map((week, i) => ({ week, grams: 20000 + i * 1500 }));
  const g = forecastSeries(growing, next, 3);
  assert.ok(g.weeks[2].grams > g.weeks[0].grams, "rising");
  assert.ok(g.weeks[0].grams < 50000, "but not wildly");
  // 70 weeks: flat 30 kg, except the four weeks around Christmas last year at 60 kg.
  const seasonal = weeksBack(next, 70).map((week) => ({ week, grams: week >= "2025-12-08" && week <= "2025-12-29" ? 60000 : 30000 }));
  const s = forecastSeries(seasonal, next, 8);
  assert.equal(s.basis, "seasonal");
  const dec = s.weeks.find((p) => p.week === "2026-12-14"), nov = s.weeks.find((p) => p.week === "2026-11-16");
  assert.ok(dec.grams > nov.grams * 1.4, `${dec.grams} vs ${nov.grams}`);
});

test("roast plan: open orders plus next week's forecast, in whole 10 kg batches of 8 kg roasted", () => {
  const today = "2026-11-12", lines = [];
  for (const week of weeksBack("2026-11-09", 10)) lines.push({ day: addDays(week, 1), customer: "Café A", coffee: "brazil", title: "Brazil", pack: "kilo", bags: 12, grams: 12000, pence: 21600, source: "site", order: "o" + week });
  const r = buildInsights({ today, lines, open: [{ coffee: "brazil", title: "Brazil", grams: 5000, bags: 5 }, { coffee: "campo", title: "Campo Santo", grams: 1500, bags: 6 }], settings: { batchKg: 10, yieldKg: 8, historyUntil: null } });
  const brazil = r.roast.rows.find((x) => x.key === "brazil"), campo = r.roast.rows.find((x) => x.key === "campo");
  assert.equal(r.roast.week, "2026-11-16");
  assert.equal(brazil.openGrams, 5000); assert.ok(Math.abs(brazil.forecastGrams - 12000) < 200);
  assert.equal(brazil.batches, Math.ceil(brazil.neededGrams / 8000)); assert.equal(brazil.greenKg, brazil.batches * 10);
  assert.deepEqual([campo.batches, campo.greenKg, campo.roastedKg], [1, 10, 8], "no half batches");
  assert.equal(r.roast.batches, brazil.batches + 1);
  assert.equal(r.weekly.length, 11, "every week from the first sale to this one");
});

test("customers: their usual gap between orders, and whether they're due, overdue or quiet", () => {
  const today = "2026-11-12";
  const at = (customer, days) => days.map((d, i) => ({ day: d, customer, coffee: "brazil", title: "Brazil", pack: "kilo", bags: 6, grams: 6000, pence: 10800, source: "site", order: customer + i }));
  const r = buildInsights({ today, open: [], settings: { batchKg: 10, yieldKg: 8, historyUntil: null }, lines: [
    ...at("Weekly Café", ["2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12"]),
    ...at("Late Café", ["2026-09-10", "2026-09-24", "2026-10-08", "2026-10-22"]),
    ...at("Gone Café", ["2026-06-01", "2026-06-15", "2026-06-29"]),
    ...at("New Café", ["2026-11-10"]),
  ] });
  const status = Object.fromEntries(r.customers.map((c) => [c.name, [c.status, c.usualDays]]));
  assert.deepEqual(status["Weekly Café"], ["ok", 7]);
  assert.deepEqual(status["Late Café"], ["overdue", 14]);
  assert.deepEqual(status["Gone Café"], ["quiet", 14]);
  assert.deepEqual(status["New Café"], ["new", null]);
});

test("QuickBooks product names: coffee and bag size guessed; anything else is Not coffee", () => {
  const coffees = [{ id: "brazil", name: "Fazenda Bom Jesus", title: "Brazil Fazenda Bom Jesus Natural" }, { id: "campo", name: "Campo Santo", title: "Colombia Campo Santo" }, { id: "house", name: "House Blend", title: "House Blend" }];
  assert.deepEqual(suggestMapping("Campo Santo 1kg", coffees), { coffee: "campo", title: "Colombia Campo Santo", pack: "kilo", grams: 1000 });
  assert.deepEqual(suggestMapping("Colombia Campo Santo - 250g", coffees).pack, "quarter");
  assert.equal(suggestMapping("Brazil Bom Jesus 1 kg", coffees).coffee, "brazil");
  assert.equal(suggestMapping("House Blend 250", coffees).pack, "quarter");
  assert.deepEqual(suggestMapping("Delivery charge", coffees), { coffee: null, title: "Delivery charge", pack: "ignore", grams: 0 });
});
