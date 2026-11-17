// Holiday for extra hours and holiday reminders: the sums (src/rota/leave/accrualMath.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { accrue, addMonths, cutoffDate, dueReminder, endedQuarters, quarterContaining, riskOf, stageDates } from "../src/rota/leave/accrualMath.ts";

const week = (from, perDay, contract = [20, 30], extra = {}) => Array.from({ length: 7 }, (_, i) => {
  const d = new Date(Date.parse(from + "T12:00:00Z") + i * 864e5).toISOString().slice(0, 10);
  return { day: d, contractMin: contract[0], contractMax: contract[1], workedHours: i < 5 ? perDay : 0, sickHours: 0, holidayDays: 0, ...(extra[i] || {}) };
});

test("quarters follow the leave year: April–June, July–September, October–December, January–March", () => {
  assert.deepEqual(quarterContaining("2026-11-17"), { from: "2026-10-01", to: "2026-12-31", label: "Oct–Dec 2026" });
  assert.deepEqual(quarterContaining("2027-02-01"), { from: "2027-01-01", to: "2027-03-31", label: "Jan–Mar 2027" });
  assert.deepEqual(quarterContaining("2026-04-01"), { from: "2026-04-01", to: "2026-06-30", label: "Apr–Jun 2026" });
  assert.deepEqual(endedQuarters("2026-11-17", "04-01", 2).map((q) => q.label), ["Jul–Sep 2026", "Apr–Jun 2026"]);
  assert.equal(quarterContaining("2026-05-01", "04-06").from, "2026-04-06");
  assert.equal(addMonths("2027-03-31", -1), "2027-02-28");
});

test("12.07% of the hours above the minimum, turned into days with the average working day", () => {
  // 5 × 8 hours = 40 against a 20-hour minimum: 20 extra × 12.07% = 2.41 hours ÷ 8 = 0.3 days.
  const r = accrue(week("2026-09-07", 8));
  assert.equal(r.status, "ready");
  assert.deepEqual([r.workedHours, r.minimumHours, r.extraHours, r.dayHours, r.accruedHours, r.accruedDays, r.units], [40, 20, 20, 8, 2.41, 0.3, 30]);
  // Under the minimum earns nothing (never negative).
  assert.equal(accrue(week("2026-09-07", 3)).units, 0);
  // Holiday counts as an average day, sickness as the hours planned: neither eats into the extra.
  const off = accrue(week("2026-09-07", 8, [20, 30], { 3: { workedHours: 0, holidayDays: 1 }, 4: { workedHours: 2, sickHours: 6 } }));
  assert.deepEqual([off.workedHours, off.holidayHours, off.sickHours, off.countedHours, off.extraHours], [26, 6.5, 6, 38.5, 18.5]);
});

test("contracts of 42 hours or more, and people with no contract, don't earn it; contracts change by the day", () => {
  assert.equal(accrue(week("2026-09-07", 10, [31.5, 42.5])).status, "full-time");
  assert.equal(accrue(week("2026-09-07", 10, [31.5, 42])).status, "full-time");
  assert.equal(accrue(week("2026-09-07", 10, [null, null])).status, "no-contract");
  // Full time for the first three days, then a 20–30 contract: only the last four days count.
  const mixed = week("2026-09-07", 8).map((d, i) => (i < 3 ? { ...d, contractMin: 35, contractMax: 45 } : d));
  const r = accrue(mixed);
  assert.equal(r.days, 4);
  assert.deepEqual([r.workedHours, r.minimumHours], [16, 11.43]);
});

test("reminders: 6 months (only if behind), 3, 2 and 1 month before the year ends, once each", () => {
  const year = { to: "2027-03-31", total: 28, takenOrPlanned: 5, left: 23 };
  assert.deepEqual(stageDates("2027-03-31"), { half: "2026-10-01", three: "2027-01-01", two: "2027-02-01", final: "2027-03-01" });
  assert.deepEqual(dueReminder("2026-09-30", year, new Set()), { send: null, pass: [] });
  assert.deepEqual(dueReminder("2026-10-01", year, new Set()), { send: "half", pass: [] });
  assert.deepEqual(dueReminder("2026-10-01", { ...year, takenOrPlanned: 12, left: 16 }, new Set()), { send: null, pass: ["half"] }, "40% used or booked: no nudge");
  // Starting part-way through the year sends the latest one only.
  assert.deepEqual(dueReminder("2027-02-03", year, new Set()), { send: "two", pass: ["half", "three"] });
  assert.deepEqual(dueReminder("2027-02-03", year, new Set(["half", "three", "two"])), { send: null, pass: [] });
  assert.deepEqual(dueReminder("2027-03-02", year, new Set(["half", "three", "two"])), { send: "final", pass: [] });
  assert.deepEqual(dueReminder("2027-03-02", { ...year, left: 0 }, new Set()), { send: null, pass: [] }, "all booked: nothing");
  assert.deepEqual(dueReminder("2027-04-01", year, new Set()), { send: null, pass: [] }, "year over");
});

test("the last day to require holiday leaves notice of twice its length, the holiday itself and two weeks", () => {
  assert.equal(cutoffDate("2027-03-31", 5), "2027-03-02"); // 15 + 14 days before
  assert.equal(cutoffDate("2027-03-31", 10), "2027-02-15");
  assert.equal(riskOf("2026-11-17", { from: "2026-04-01", to: "2027-03-31", total: 28, takenOrPlanned: 20, left: 8 }), "on-track");
  assert.equal(riskOf("2026-11-17", { from: "2026-04-01", to: "2027-03-31", total: 28, takenOrPlanned: 2, left: 26 }), "behind");
  assert.equal(riskOf("2027-01-05", { from: "2026-04-01", to: "2027-03-31", total: 28, takenOrPlanned: 22, left: 6 }), "at-risk");
  assert.equal(riskOf("2027-02-20", { from: "2026-04-01", to: "2027-03-31", total: 28, takenOrPlanned: 18, left: 10 }), "act-now");
  assert.equal(riskOf("2027-02-20", { from: "2026-04-01", to: "2027-03-31", total: 28, takenOrPlanned: 28, left: 0 }), "done");
});
