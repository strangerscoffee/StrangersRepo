// Browser test of the rota app (public/rota/) against `wrangler dev`, on a phone and an iPad in landscape:
// a manager adds a shift, fills it from the suggestions and publishes; staff see it in My shifts; the diary's
// Today shows who's on; a pickup goes through to approval. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN, ALEX_COOKIES, ALEX_ID;
// The session a response sets (its first Set-Cookie may remove an older, host-only copy: src/auth.ts).
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const settings = { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [{ id: "c1", t: "Bins emptied" }], weekly: [], closedDays: [], hide: {}, info: {}, startDate: "2020-01-01", startSet: true };

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  await call("POST", "/api/admin/users", { name: "Alex Brown", username: "alex", role: "staff", password: "temp-pass-1" });
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alex", password: "temp-pass-1", newPassword: "alex-own-pass" }) });
  const [name, value] = cookieOf(c).split("=");
  ALEX_COOKIES = [{ name, value, url: srv.base }];
  await call("POST", "/api/db/set", { path: "settings/main", data: settings });
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: settings });
  ALEX_ID = (await call("GET", "/api/rota/week")).people.find((p) => p.name === "Alex Brown").id;
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function pageFor(viewport, cookies) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 1024 });
  const [name, value] = (cookies ? null : ADMIN.split("=")) || [];
  await ctx.addCookies(cookies || [{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { ctx, page, errors };
}

for (const [label, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) {
  test(`rota on a ${label}: plan, fill, publish; staff see it; Today shows who's on; a pickup is approved`, async () => {
    const today = londonToday();
    const week = addDays(today, -((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7));
    // Start from a clean week.
    for (const s of (await call("GET", "/api/rota/week?start=" + week)).shifts) await call("DELETE", "/api/rota/shifts/" + s.id);

    // The manager adds an open shift at the Roastery today...
    const m = await pageFor(viewport);
    await m.page.goto(srv.base + "/rota/");
    await m.page.locator("#pageTitle", { hasText: /^Week of / }).waitFor();
    if (viewport.width < 1024) {
      await m.page.locator(".sitecard", { hasText: "Roastery" }).locator(".addshift").click();
    } else {
      const col = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
      await m.page.locator(".gadd").nth(col).click();
    }
    await m.page.locator("#sheet h2", { hasText: "New shift" }).waitFor();
    await m.page.fill("#f_start", "00:30");
    await m.page.fill("#f_end", "23:30");
    await m.page.locator("#sheet .rseg button", { hasText: "Opens" }).click();
    await m.page.locator("#sheet .btn", { hasText: "Add open shift" }).click();
    await m.page.locator("#toast", { hasText: "Shift added" }).waitFor();

    // ...fills it from "Before you publish" (folded on phones)...
    // A draft on the first run; "Published · 2 changes not sent" when the phone run already published it.
    await m.page.locator("#pageTitle .wstatus", { hasText: /^(Draft|Published · \d+ changes? not sent)$/ }).waitFor();
    if (!(await m.page.locator("details.probs").evaluate((d) => d.open))) await m.page.locator("details.probs summary").click();
    await m.page.locator(".prob.bad", { hasText: "open shift" }).locator(".btn", { hasText: "Fill" }).click();
    await m.page.locator("#sheet h2", { hasText: "Open shift" }).waitFor();
    const alexRow = m.page.locator("#sheet .cand", { hasText: "Alex Brown" });
    await alexRow.waitFor();
    await alexRow.click();
    await m.page.locator("#sheet .btn", { hasText: "Give to Alex" }).click();
    await m.page.locator("#toast", { hasText: "Given to Alex" }).waitFor();
    let w = await call("GET", "/api/rota/week?start=" + week);
    assert.equal(w.shifts.length, 1);
    assert.equal(w.shifts[0].userId, ALEX_ID);
    assert.equal(w.shifts[0].job, "opens");

    // ...and publishes.
    if (viewport.width >= 1024) assert.match(await m.page.locator(".cover").nth((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7).innerText(), /^1/, "the cover row counts Alex");
    await m.page.locator(".rtool .pubbtn", { hasText: /^Publish (week|\d+ changes?)$/ }).click();
    await m.page.locator("#sheet h2", { hasText: /^Publish (the week of|\d+ changes?)/ }).waitFor();
    assert.match(await m.page.locator("#sheet .kvs").innerText(), /Shifts\s+1 · 22\.5 hours/);
    await m.page.locator("#sheet .btn", { hasText: /^Publish( changes)?$/ }).click();
    await m.page.locator("#toast", { hasText: "Published" }).waitFor();
    await m.page.locator("#pageTitle .wstatus", { hasText: /^Published$/ }).waitFor();
    assert.equal(await m.page.locator(".rtool .pubbtn").innerText(), "Up to date");
    assert.equal((await call("GET", "/api/rota/week?start=" + week)).published, true);

    // Alex sees it as the next shift.
    const a = await pageFor(viewport, ALEX_COOKIES);
    await a.page.goto(srv.base + "/rota/");
    await a.page.locator(".nextshift", { hasText: "00:30–23:30" }).waitFor();
    assert.match(await a.page.locator(".nextshift .kick").innerText(), /today/i);
    // ...and in their week strip, on today.
    assert.match(await a.page.locator(".mweek .mday.today .blk.shift").innerText(), /00:30\s+23:30/);
    assert.equal(await a.page.locator("#tabbar .tab, #snav a").filter({ hasText: "Requests" }).count(), 0, "staff have no Requests tab");

    // The diary's Today shows who's on and who opens.
    await a.page.goto(srv.base + "/");
    await a.page.locator("#onShift", { hasText: "On shift today" }).waitFor();
    assert.match(await a.page.locator("#onShift").innerText(), /You[\s\S]*Opens/);
    await a.page.locator("#openCard .sec", { hasText: "You're opening" }).waitFor();

    // On the day, the manager amends Alex's finish with the slider (went home sick); the diary shows it.
    await m.page.goto(srv.base + `/rota/#day/roastery/${today}`);
    const row = m.page.locator(".amrow", { hasText: "Alex Brown" });
    await row.waitFor();
    await row.locator('input[type=range]').nth(1).evaluate((r) => { r.value = "720"; r.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await row.locator("output").nth(1).innerText(), "12:00");
    await row.locator(".fchip", { hasText: "Went home sick" }).click();
    await row.locator(".btn", { hasText: "Save" }).click();
    await m.page.locator("#toast", { hasText: "Alex: 00:30–12:00 saved" }).waitFor();
    w = await call("GET", "/api/rota/week?start=" + week);
    assert.deepEqual([w.shifts[0].actualEnd, w.shifts[0].adjustNote, w.shifts[0].end], ["12:00", "Went home sick", "23:30"]);
    await m.page.locator(".tl-bar.amended", { hasText: "00:30–12:00" }).waitFor();
    await a.page.reload();
    await a.page.locator("#onShift", { hasText: "00:30–12:00 (was 00:30–23:30)" }).waitFor();

    // A pickup: an open shift at the Cafe tomorrow, claimed by Alex, approved by the manager.
    const open = (await call("POST", "/api/rota/shifts", { site: "cafe", day: addDays(today, 1), start: "08:00", end: "12:00", breakMins: 0 })).shift;
    await call("POST", "/api/rota/week/publish", { week: addDays(today, 1) });
    await a.page.goto(srv.base + "/rota/#swaps");
    await a.page.locator(".ocard", { hasText: "08:00–12:00" }).locator(".btn", { hasText: "I'll take it" }).click();
    await a.page.locator("#toast", { hasText: "approves it before it's yours" }).waitFor();
    await m.page.goto(srv.base + "/rota/#requests");
    await m.page.locator(".lrow", { hasText: "Alex Brown wants to pick up" }).locator(".btn", { hasText: "Approve" }).click();
    await m.page.locator("#toast", { hasText: "Approved" }).waitFor();
    w = await call("GET", "/api/rota/week?start=" + addDays(today, 1));
    assert.equal(w.shifts.find((s) => s.id === open.id).userId, ALEX_ID);
    await call("DELETE", "/api/rota/shifts/" + open.id);

    // Which days and sites people work: read-only for staff; an admin changes it in the admin section.
    await a.page.goto(srv.base + "/rota/#avail");
    await a.page.locator(".note", { hasText: "Only an admin can change which days and sites you work" }).waitFor();
    assert.equal(await a.page.locator("#page input[type=checkbox], #page .fchip").count(), 0, "no switches for staff");
    await a.page.locator(".btn", { hasText: "Ask for time off" }).waitFor();
    await call("PUT", "/api/rota/people/" + ALEX_ID, { pattern: {}, sites: [] });
    await m.page.goto(srv.base + "/rota/#settings");
    await m.page.locator(".lrow", { hasText: "Change in Admin" }).click();
    await m.page.waitForURL(/\/admin#people$/);
    await m.page.locator("[data-person]", { hasText: "Alex Brown" }).click();
    await m.page.locator("[data-act=avail]").click();
    await m.page.locator('.arow[data-day="mon"] [data-mode="off"]').click();
    await m.page.locator("#sheet button[type=submit]").click();
    await m.page.locator("#toast", { hasText: "Saved" }).waitFor();
    assert.equal((await call("GET", "/api/rota/week?start=" + week)).people.find((p) => p.id === ALEX_ID).pattern.mon, "off");
    await call("PUT", "/api/rota/people/" + ALEX_ID, { pattern: {}, sites: [] });

    assert.deepEqual([...m.errors, ...a.errors], []);
    await m.ctx.close(); await a.ctx.close();
  });
}
