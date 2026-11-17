// The Bradford Factor (src/rota/bradford.ts): spells², whole days only (part days don't count), touching days are one
// spell, an admin can join an absence to the spell before or leave it out, and each day stops counting 52 weeks on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bradford } from "../src/rota/bradford.ts";

const a = (from, to = from, extra = {}) => ({ from_day: from, to_day: to, ...extra });
const today = "2026-11-17";

test("spells squared × whole days; touching days are one spell", () => {
  const r = bradford([a("2026-05-26"), a("2026-05-29"), a("2026-07-11"), a("2026-09-19")], today);
  assert.deepEqual([r.spells, r.days, r.score, r.band.key], [4, 4, 64, "monitor"]);
  assert.deepEqual([bradford([a("2026-06-22", "2026-06-23")], today).score, bradford([a("2026-06-22"), a("2026-06-23")], today).score], [2, 2]);
  assert.equal(bradford([a("2026-06-22"), a("2026-06-22")], today).days, 1, "a day recorded twice counts once");
});

test("part days don't count at all: not as a spell and not as days", () => {
  const r = bradford([a("2026-10-24", "2026-10-24", { partial: true }), a("2026-10-25"), a("2026-10-27")], today);
  assert.deepEqual([r.spells, r.days, r.score, r.partDays], [2, 2, 8, 1]);
  assert.deepEqual([bradford([a("2026-11-13", "2026-11-13", { partial: true })], today).score], [0]);
});

test("an admin can join an absence to the spell before, or leave it out", () => {
  const joined = bradford([a("2026-10-25"), a("2026-10-27", "2026-10-27", { continues: true })], today);
  assert.deepEqual([joined.spells, joined.days, joined.score], [1, 2, 2]);
  // Joining only reaches back a week.
  assert.equal(bradford([a("2026-10-01"), a("2026-10-27", "2026-10-27", { continues: true })], today).spells, 2);
  const out = bradford([a("2026-10-25"), a("2026-10-27", "2026-10-27", { excluded: "Pregnancy-related" })], today);
  assert.deepEqual([out.score, out.leftOut], [1, 1]);
});

test("each day stops counting 52 weeks after it: when it next goes down and when it clears", () => {
  const r = bradford([a("2026-05-26"), a("2026-09-19")], today);
  assert.equal(r.score, 8);
  assert.deepEqual(r.nextDrop, { on: "2027-05-26", score: 1 });
  assert.equal(r.clearsOn, "2027-09-19");
  // The day before it falls off it still counts; on the day it doesn't.
  assert.equal(bradford([a("2026-05-26")], "2027-05-24").score, 1);
  assert.equal(bradford([a("2026-05-26")], "2027-05-25").score, 1);
  assert.equal(bradford([a("2026-05-26")], "2027-05-26").score, 0);
  assert.equal(bradford([], today).clearsOn, null);
});
