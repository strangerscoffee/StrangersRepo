// What an open page costs: files linked by fingerprint (kept by the browser for a year, so opening the page again
// fetches none of them), and an idle diary asking nothing while its live line is open (it's told of changes), or
// only the one-number change check when it isn't. Periodic identity verification protects private data in both modes.
// Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN;
before(async () => {
  srv = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", data: { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true } }) });
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "maintenance/m1", data: { title: "Door", status: "open", priority: "soon", reportedBy: "web:Will Owner", reportedAt: 1, at: 1, log: [] } }) });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("opening the diary again fetches no scripts or styles; an idle diary only asks the change check", async () => {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const seen = [];
  page.on("request", (r) => seen.push(new URL(r.url()).pathname));
  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  // A second visit: the page itself and data, but no .js or .css from the network (transferSize 0: the browser's cache).
  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  const fromNet = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => /\.(js|css)(\?|$)/.test(e.name) && e.transferSize > 0).map((e) => e.name + " " + e.transferSize));
  assert.deepEqual(fromNet, [], "scripts and styles come from the browser's cache");
  // An idle live diary needs no operational polls or lookups. The privacy guard still verifies identity every
  // 15 seconds; whether that tick falls in this 12-second observation depends on page-startup time.
  await page.waitForFunction(() => window.SC && SC.live().open(), null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  seen.length = 0;
  await page.waitForTimeout(12000);
  const api = seen.filter((p) => p.startsWith("/api/"));
  assert.deepEqual(api.filter(path => path !== "/api/auth/me"), [], "an idle live diary makes no operational requests");
  assert.ok(api.length <= 1, "at most one scheduled identity verification in twelve idle seconds: " + api.join(", "));
  // A change from another device arrives straight away, pushed (well inside the 5 s a poll would have taken).
  const t0 = Date.now();
  await fetch(srv.base + "/api/db/update", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", patch: { opening: [{ id: "o1", t: "Hands washed" }, { id: "o2", t: "Fridges checked" }] } }) });
  await page.locator("#openList label", { hasText: "Fridges checked" }).waitFor({ timeout: 15000 });
  assert.ok(Date.now() - t0 < 4000, `arrived in ${Date.now() - t0} ms`);
  // Without the live line (say it's blocked, or the server is restarting), a page asks every few seconds as before,
  // and still gets changes.
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx2.addCookies([{ name, value, url: srv.base }]);
  await ctx2.routeWebSocket(/\/api\/live$/, (ws) => ws.close());
  const p2 = await ctx2.newPage();
  const seen2 = [];
  p2.on("request", (r) => seen2.push(new URL(r.url()).pathname));
  await p2.goto(srv.base + "/");
  await p2.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  seen2.length = 0;
  await p2.waitForTimeout(7000);
  assert.ok(seen2.some((x) => x === "/api/changes" || x === "/api/db/poll"), "polling: " + seen2.join(", "));
  await fetch(srv.base + "/api/db/update", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", patch: { opening: [{ id: "o1", t: "Hands washed" }, { id: "o3", t: "Floors swept" }] } }) });
  await p2.locator("#openList label", { hasText: "Floors swept" }).waitFor({ timeout: 15000 });
  await ctx2.close();
  await ctx.close();
});
