// What an open page costs: files linked by fingerprint (kept by the browser for a year, so opening the page again
// fetches none of them), and an idle diary asking only the one-number change check, not the full poll or names.
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
  // Idle for a while: only GET /api/changes, no full polls, no name lookups.
  seen.length = 0;
  await page.waitForTimeout(12000);
  const api = seen.filter((p) => p.startsWith("/api/"));
  assert.ok(api.includes("/api/changes"), api.join(", "));
  assert.equal(api.filter((p) => p === "/api/db/poll").length, 0, "no full poll while nothing changes: " + api.join(", "));
  assert.equal(api.filter((p) => p === "/api/db/profiles").length, 0, "names aren't asked for again");
  // A change from another device still arrives.
  await fetch(srv.base + "/api/db/update", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", patch: { opening: [{ id: "o1", t: "Hands washed" }, { id: "o2", t: "Fridges checked" }] } }) });
  await page.locator("#openList label", { hasText: "Fridges checked" }).waitFor({ timeout: 15000 });
  await ctx.close();
});
