// Safari can show a page from memory (going back to a tab) after the session has ended. The page's scripts and
// styles must still load, so it moves on to sign-in instead of showing unstyled and stuck (the bug seen on an
// iPhone in November 2026). Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { ({ chromium, devices } = await import("playwright")); }

let srv, browser, ADMIN;
before(async () => {
  srv = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", data: { units: [], opening: [], closing: [], weekly: [], closedDays: [], info: {} } }) });
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [label, path] of [["the diary", "/"], ["the rota", "/rota/"]]) {
  test(`${label}, shown from memory after the session ended, goes to sign-in (styled), not a stuck page`, async () => {
    const html = await (await fetch(srv.base + path, { headers: { cookie: ADMIN } })).text(); // the page as it was
    const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] }); // no session any more
    const page = await ctx.newPage();
    const refused = [];
    page.on("response", (r) => { if (/\.(css|js)$/.test(new URL(r.url()).pathname) && r.status() >= 300 && r.status() !== 304) refused.push(r.url()); });
    await page.route(srv.base + path, (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }), { times: 1 }); // Safari's copy
    await page.goto(srv.base + path);
    await page.waitForURL(/\/signin/, { timeout: 10000 });
    await page.locator("#signin").waitFor();
    assert.deepEqual(refused, [], "every script and style loaded");
    await ctx.close();
  });
}
