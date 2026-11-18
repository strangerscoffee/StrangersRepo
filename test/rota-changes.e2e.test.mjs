// Browser test: "Published · n changes not sent" opens the publish sheet with the list of what's changed
// (src/rota/changes.ts), on a phone and an iPad in light and dark. Run with `npm run test:e2e`; SHOT_DIR saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

let srv, browser, ADMIN;
const ids = {};
const WEEK = "2030-03-04"; // a Monday
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie: ADMIN }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const settings = { units: [], opening: [], closing: [], weekly: [], closedDays: [], hide: {}, info: {} };

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  for (const [name, u] of [["Alex Brown", "alex"], ["Sam Okafor", "sam"]]) ids[u] = (await call("POST", "/api/admin/users", { name, username: u, role: "staff", password: "temp-pass-1" })).user.id;
  await call("POST", "/api/db/set", { path: "settings/main", data: settings });
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: settings });
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [label, viewport, scheme] of [["phone", { width: 393, height: 852 }, "light"], ["iPad", { width: 1180, height: 820 }, "dark"]]) test(`what's changed before publishing on a ${label} (${scheme})`, { timeout: 90000 }, async () => {
  // A fresh published week, then two changes.
  for (const s of (await call("GET", "/api/rota/week?start=" + WEEK)).shifts) await call("DELETE", "/api/rota/shifts/" + s.id);
  const a = (await call("POST", "/api/rota/shifts", { site: "cafe", day: WEEK, start: "09:00", end: "17:00", breakMins: 30, job: "", userId: ids.alex })).shift;
  await call("POST", "/api/rota/week/publish", { week: WEEK });
  await call("PATCH", "/api/rota/shifts/" + a.id, { start: "10:00", end: "18:00" });
  await call("POST", "/api/rota/shifts", { site: "cafe", day: "2030-03-06", start: "08:00", end: "12:00", breakMins: 0, job: "", userId: ids.sam });

  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: true, isMobile: viewport.width < 1024 });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(srv.base + "/rota/#week/" + WEEK);
    const pill = page.locator("#pageTitle button.wstatus", { hasText: "Published · 2 changes not sent" });
    await pill.click();
    const list = page.locator("#sheet section[aria-label=\"What's changed\"]");
    await list.waitFor();
    const text = await list.innerText();
    assert.match(text, /What's changed · 2/i);
    assert.match(text, /Changed[\s\S]*Alex Brown[\s\S]*Mon 4 Mar · Cafe 10:00–18:00 · was 09:00–17:00/);
    assert.match(text, /Added[\s\S]*Sam Okafor[\s\S]*Wed 6 Mar · Cafe 08:00–12:00/);
    await page.locator("#sheet").evaluate((s) => Promise.all(s.getAnimations().map((x) => x.finished.catch(() => {}))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `changes-${label}-${scheme}.png`) });
    await page.locator("#sheet").getByRole("button", { name: "Publish changes", exact: true }).click();
    await page.locator("#pageTitle .wstatus", { hasText: /^Published$/ }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
