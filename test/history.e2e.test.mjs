// What the diary loads (docs/runtime-api.md, "Live updates"): when it opens, only the latest days, weeks, deliveries
// and Prove it records; older ones the first time a screen needs them. And a change from another device reaches an
// open page as just that change, not the whole list again. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN;
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 864e5));
async function set(path, data) {
  const r = await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path, data }) });
  assert.ok(r.ok, await r.text());
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await set("settings/main", { units: [{ id: "u1", name: "Fridge 1", kind: "fridge" }], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true });
  // A reading every few days for most of a year.
  for (let n = 1; n <= 300; n += 2) await set(`days/${daysAgo(n)}`, { date: daysAgo(n), temps: { u1: { am: { v: 3, by: "web:Will Owner", at: Date.now() - n * 864e5 } } } });
  await set(`days/${daysAgo(298)}`, { date: daysAgo(298), temps: { u1: { am: { v: 7.5, by: "web:Will Owner", at: Date.now() - 298 * 864e5 } } } });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("the diary opens with recent history, loads the rest when needed, and gets changes as changes", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const polls = [];
  page.on("response", async (res) => {
    if (!res.url().endsWith("/api/db/poll")) return;
    try { polls.push({ req: JSON.parse(res.request().postData() || "{}"), res: await res.json() }); } catch {}
  });
  // The largest list of days a poll asked for (the menu's summaries ask for 60 of each site's).
  const daysQuery = (p) => p.req.queries.filter((q) => q.path === "days" && q.orderBy === "date").sort((a, b) => b.limit - a.limit)[0];

  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  const firstDays = polls.map(daysQuery).find(Boolean);
  assert.ok(firstDays.limit <= 90, `opens with the latest days only (limit ${firstDays.limit})`);
  assert.equal(await page.locator("#tlList .pill", { hasText: "7.5°" }).count(), 0);

  // A change from another device arrives as just that change.
  await page.waitForTimeout(6000);
  const before = polls.length;
  await set(`days/${daysAgo(1)}`, { date: daysAgo(1), temps: { u1: { am: { v: 4.5, by: "web:Will Owner", at: Date.now() } } } });
  let got;
  for (let i = 0; i < 40 && !got; i++) {
    await page.waitForTimeout(250);
    got = polls.slice(before).map((p) => Object.entries(p.res.results || {}).find(([k]) => p.req.queries.find((q) => q.key === k && q.path === "days" && q.orderBy === "date"))).find(Boolean);
  }
  assert.ok(got, "the page heard about the change");
  assert.ok(Array.isArray(got[1].delta), "as a change, not the whole list");
  assert.equal(got[1].delta.length, 1);

  // The temperature log over 12 months loads the older days, including one from ten months ago.
  await page.evaluate(() => show("templog"));
  await page.locator("#tlChips button", { hasText: "Last 12 months" }).click();
  await page.locator("#tlList .pill", { hasText: "Fridge 1: 7.5°" }).waitFor({ timeout: 15000 });
  for (let i = 0; i < 20 && !polls.map(daysQuery).some((q) => q && q.limit > 300); i++) await page.waitForTimeout(250);
  assert.ok(polls.map(daysQuery).some((q) => q && q.limit > 300), "the longer history was asked for: " + JSON.stringify(polls.map(daysQuery).filter(Boolean).map((q) => q.limit)));
  // Yesterday's change shows too (merged into the longer list).
  await page.locator("#tlList .pill", { hasText: "Fridge 1: 4.5°" }).first().waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
