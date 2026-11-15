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

test("forecast: the same target week has the same prediction and range across a skipped unfinished week", () => {
  const rows = weeksBack("2026-11-09", 24).map((week, i) => ({ week, grams: 20000 + i * 1100 }));
  const twoSteps = forecastSeries(rows, "2026-11-09", 2).weeks[1];
  assert.deepEqual(forecastSeries(rows, "2026-11-16", 1).weeks[0], twoSteps);
});

test("forecast: a regular fortnightly order is recovered from history and beats a flat average on unseen weeks", () => {
  const next = "2026-11-16", history = weeksBack(next, 44).map((week, i) => ({ week, grams: i % 2 === 0 ? 40000 : 0 }));
  const result = forecastSeries(history, next, 8), actual = Array.from({ length: 8 }, (_, i) => i % 2 === 0 ? 40000 : 0);
  assert.equal(result.model, "cycle");
  const error = result.weeks.reduce((sum, p, i) => sum + Math.abs(p.grams - actual[i]), 0) / 8;
  const baseline = actual.reduce((sum, n) => sum + Math.abs(n - 20000), 0) / 8;
  assert.equal(error, 0); assert(error < baseline);
  assert(result.validation.origins >= 6); assert(result.validation.samples > 0);
});

test("forecast: a single extreme order does not turn a steady seller into a permanently huge weekly forecast", () => {
  const next = "2026-11-16", rows = weeksBack(next, 52).map((week, i) => ({ week, grams: i === 51 ? 400000 : 40000 }));
  const copy = JSON.stringify(rows), result = forecastSeries(rows, next, 8);
  assert.equal(result.model, "robust");
  assert(result.weeks.every(p => p.grams > 30000 && p.grams < 80000));
  assert.equal(JSON.stringify(rows), copy, "real historical bulk volume is never edited away");
});

test("forecast: future outcomes cannot influence a forecast made before they happened", () => {
  const next = "2026-11-16", rows = weeksBack(next, 32).map((week, i) => ({ week, grams: 20000 + i % 3 * 4000 }));
  const result = forecastSeries(rows, next, 4);
  const later = [{ week: next, grams: 1e9 }, { week: addDays(next, 7), grams: 0 }];
  assert.deepEqual(forecastSeries([...rows, ...later], next, 4), result);
});

test("forecast: short histories are labelled limited and stopped demand can fall to zero", () => {
  const next = "2026-11-16";
  const short = forecastSeries([{ week: addDays(next, -7), grams: 30000 }], next, 8);
  assert.equal(short.rangeBasis, "limited"); assert.equal(short.validation.maeGrams, null);
  const stopped = forecastSeries(weeksBack(next, 52).map((week, i) => ({ week, grams: i < 40 ? 40000 : 0 })), next, 8);
  assert(stopped.weeks.every(p => p.grams === 0));
  for (const point of [...short.weeks, ...stopped.weeks]) {
    assert([point.grams, point.low, point.high].every(Number.isSafeInteger));
    assert(point.low >= 0 && point.low <= point.grams && point.high >= point.grams);
  }
});

test("forecast: totals equal the displayed coffee forecasts and new coffees do not inherit pre-launch zeros", () => {
  const today = "2026-11-12", weeks = weeksBack("2026-11-09", 70), lines = [];
  for (const [i, week] of weeks.entries()) for (const [coffee, grams] of [["regular", 20000], ["fortnightly", i % 2 ? 0 : 40000], ["new", i >= 62 ? 6000 : 0]]) {
    if (grams) lines.push({ day: week, customer: "Cafe", coffee, title: coffee, pack: "kilo", bags: grams / 1000, grams, pence: grams, source: "site", order: coffee + i });
  }
  const input = { today, lines, open: [], settings: { batchKg: 10, yieldKg: 8, historyUntil: null } }, result = buildInsights(input);
  for (const [i, point] of result.forecast.total.weeks.entries()) assert.equal(point.grams, result.forecast.byCoffee.reduce((sum, c) => sum + c.weeks[i].grams, 0));
  const newCoffee = result.forecast.byCoffee.find(c => c.key === "new");
  assert.equal(newCoffee.basis, "recent");
  assert.deepEqual(newCoffee.weeks, forecastSeries(weeks.slice(62).map(week => ({ week, grams: 6000 })), result.nextWeek, 8).weeks);
  const partial = { day: "2026-11-10", customer: "Cafe", coffee: "regular", title: "regular", pack: "kilo", bags: 1000, grams: 1e6, pence: 1e6, source: "site", order: "current" };
  assert.deepEqual(buildInsights({ ...input, lines: [...lines, partial] }).forecast, result.forecast, "this week's unfinished sales are displayed but never train the forecast");
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

test('roast planning separates backlog, next-week commitments and later deliveries without double-counting',()=>{
 const lines=Array.from({length:24},(_,i)=>({day:addDays('2026-05-25',i*7),customer:'Cafe',coffee:'campo',title:'Campo',pack:'kilo',bags:20,grams:20000,pence:40000,source:'site',order:'wk-'+i}));
 const result=buildInsights({today:'2026-11-15',lines,open:[
  {coffee:'campo',title:'Campo',grams:5000,bags:5},
  {coffee:'campo',title:'Campo',grams:12000,bags:12,dispatchDate:'2026-11-18'},
  {coffee:'campo',title:'Campo',grams:100000,bags:100,dispatchDate:'2026-12-01'},
 ],settings:{batchKg:10,yieldKg:8,historyUntil:null}});
 const row=result.roast.rows.find(r=>r.key==='campo');assert.equal(row.openGrams,17000);assert.equal(row.backlogGrams,5000);assert.equal(row.committedGrams,12000);assert.equal(result.roast.laterGrams,100000);
 assert.equal(row.neededGrams,5000+Math.max(12000,row.forecastGrams));assert.equal(row.additionalForecastGrams,Math.max(0,row.forecastGrams-12000));
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
