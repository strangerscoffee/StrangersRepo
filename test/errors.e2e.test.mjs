// Errors on staff devices reach the admin section: a page that throws reports it (public/errors.js → POST
// /api/errors), it shows under Admin → Activity → Errors with where it happened, and an ordinary visit reports
// nothing. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { ({ chromium, devices } = await import("playwright")); }

let srv, browser, ADMIN;
const errors = async () => (await (await fetch(srv.base + "/api/admin/activity?kind=errors", { headers: { cookie: ADMIN } })).json()).items;
before(async () => {
  srv = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", data: { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true } }) });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("an ordinary visit reports nothing; a page that throws reports it, and admins see where", async () => {
  const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  for (const path of ["/", "/rota/#mine", "/admin"]) {
    await page.goto(srv.base + path); await page.waitForTimeout(1500);
    assert.equal(await page.locator("#sc-error").count(), 0, "no error card on " + path);
  }
  assert.deepEqual(await errors(), [], "no false alarms from normal pages");

  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  await page.evaluate(() => setTimeout(() => { throw new Error("Test: something broke on Today"); }, 0));
  await page.evaluate(() => { Promise.reject(new Error("Test: a save that nobody caught")); });
  // The person sees a card with the error's code, what and where, to screenshot.
  const card = page.locator("#sc-error");
  await card.waitFor();
  const shown = (await card.textContent()) || "";
  const code = (shown.match(/E-[0-9A-Z]{6}/) || [])[0];
  assert.ok(code, shown);
  assert.match(shown, /Something went wrong/);
  assert.match(shown, /Test: something broke on Today/);
  assert.match(shown, /Take a screenshot of this/);
  assert.match(shown, /and 1 more error on this page/, "the second error adds to the same card");
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/error-card-phone.png" });
  let list = [];
  for (let i = 0; i < 20 && list.length < 2; i++) { await page.waitForTimeout(250); list = await errors(); }
  const thrown = list.find((e) => /Test: something broke on Today/.test(e.text));
  assert.ok(thrown, JSON.stringify(list));
  assert.match(thrown.where, /Kitchen Diary · \/ · Will Owner · iPhone · Safari/);
  assert.equal(thrown.code, code, "the code on the screen is the one the admin section lists");
  await card.locator("button", { hasText: "Hide" }).click();
  assert.equal(await card.count(), 0);
  assert.ok(list.some((e) => e.text === "Unhandled: Test: a save that nobody caught"));

  // The admin section's Errors tab lists it, with its details folded.
  const a = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await a.addCookies([{ name, value, url: srv.base }]);
  const ap = await a.newPage();
  await ap.goto(srv.base + "/admin#overview");
  await ap.locator(".item, .row", { hasText: /errors? on the site in the last day/ }).first().waitFor();
  await ap.locator("button", { hasText: "See errors" }).click();
  await ap.locator(".item", { hasText: "Test: something broke on Today" }).waitFor();
  const item = ap.locator(".item", { hasText: "Test: something broke on Today" });
  await item.locator("summary", { hasText: "Report" }).click();
  const rep = (await item.locator("pre").textContent()) || "";
  assert.match(rep, new RegExp(`^Strangers Coffee error ${code}\nWhat: {3}Error: Test: something broke on Today|^Strangers Coffee error ${code}\nWhat: {3}Uncaught Error: Test`));
  assert.match(rep, /Who: {4}Will Owner · iPhone · Safari/);
  await item.locator("button", { hasText: "Copy report" }).waitFor();
  // Searching for the code finds it.
  await ap.fill("#fq", code);
  await ap.locator(".item", { hasText: "Test: something broke on Today" }).waitFor();
  if (process.env.SHOTS) await ap.screenshot({ path: process.env.SHOTS + "/error-report-ipad.png", fullPage: true });
  await ctx.close(); await a.close();
});
