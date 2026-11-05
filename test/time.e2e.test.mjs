// The site runs on the server's clock in UK time, not the device's (public/shared/core.js, "the time"): a device with
// its clock a day out and set to another time zone still opens the diary on today's UK date, saves entries with the
// right time on the right day, and is flagged in the admin section; a time from the future sent to the server is set
// to now. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN;
const london = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function call(method, path, body) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie: ADMIN }, body: body && JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await call("POST", "/api/db/set", { path: "settings/main", data: { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true } });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("every response says the server's time; a time from the future is set to now", async () => {
  const r = await call("GET", "/api/changes");
  assert.ok(Math.abs(Number(r.headers.get("x-now")) - Date.now()) < 5000, "x-now is the server's time");
  const ahead = Date.now() + 3 * 3600e3;
  await call("POST", "/api/db/set", { path: "suppliers/s1", data: { name: "Easters", at: ahead } });
  const saved = (await call("POST", "/api/db/get", { path: "suppliers/s1" })).body.data.at;
  assert.ok(saved < ahead - 3600e3 && Math.abs(saved - Date.now()) < 10000, "set to now");
  // Inside a list operation, times are left alone (later operations find entries by them).
  await call("POST", "/api/db/set", { path: "cleaning/c1", data: { name: "Floors", freq: "daily", createdAt: 1, log: [] } });
  await call("POST", "/api/db/update", { path: "cleaning/c1", patch: { log: { $op: "prepend", items: [{ at: ahead, by: "web:Will Owner" }], key: "at", order: "desc", max: 30 } } });
  assert.equal((await call("POST", "/api/db/get", { path: "cleaning/c1" })).body.data.log[0].at, ahead);
});

test("a device a day fast in another time zone: the diary still runs on today's UK date and time", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, timezoneId: "Pacific/Auckland" });
  await ctx.clock.install({ time: new Date(Date.now() + 26 * 3600e3) });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  // The page has learned the server's time.
  await page.waitForFunction(() => Math.abs(Date.now() - (performance.timeOrigin + performance.now()) + 26 * 3600e3) > 0 && window.SC && Math.abs(SC.clockOffset()) > 3600e3, null, { timeout: 10000 });
  const pageNow = await page.evaluate(() => Date.now());
  assert.ok(Math.abs(pageNow - Date.now()) < 15000, `the page's "now" is the server's (off by ${pageNow - Date.now()} ms)`);
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  assert.equal(await page.evaluate(() => S.date), london(), "today is the UK date");
  // A tick goes on today's UK page with the right time.
  await page.locator("#openList label", { hasText: "Hands washed" }).click();
  let day = null;
  for (let i = 0; i < 40 && !day?.opening; i++) { await page.waitForTimeout(250); day = (await call("POST", "/api/db/get", { path: `days/${london()}` })).body.data; }
  assert.ok(day?.opening, "saved on today's UK page");
  const at = JSON.stringify(day).match(/"at":(\d{13})/);
  assert.ok(at && Math.abs(Number(at[1]) - Date.now()) < 60000, "with the server's time");
  // Times are shown in UK time.
  const shown = await page.evaluate((ms) => time(ms), Number(at[1]));
  assert.equal(shown, new Date(Number(at[1])).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }));
  assert.deepEqual(errors, []);
  await ctx.close();

  // The admin section says which device is out, and how far.
  const o = (await call("GET", "/api/admin/overview")).body;
  assert.ok(o.attention.some((a) => /Will Owner's \w+ clock is 2[56] h( \d+ min)? fast/.test(a.title)), JSON.stringify(o.attention.map((a) => a.title)));
});
