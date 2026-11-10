// Browser test of the rota app (public/rota/) against `wrangler dev`, on a phone and an iPad in landscape:
// a manager adds a shift, fills it from the suggestions and publishes; staff see it in My shifts; the diary's
// Today shows who's on; a pickup goes through to approval. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE, serverTimeIs } from "./harness.mjs";

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
    // Midday on Alex's device, so today's 00:30–23:30 shift is still to come whenever the tests run (they once ran
    // after 23:30 and found no next shift).
    await a.page.clock.setFixedTime(new Date(today + "T12:00:00Z"));
    await serverTimeIs(a.page, Date.parse(today + "T12:00:00Z"));
    await a.page.goto(srv.base + "/rota/");
    await a.page.locator(".nextshift", { hasText: "00:30–23:30" }).waitFor();
    assert.match(await a.page.locator(".nextshift .kick").innerText(), /today/i);
    // ...and in their week strip, on today.
    assert.match(await a.page.locator(".mweek .mday.today .blk.shift").innerText(), /00:30\s+23:30/);
    assert.equal(await a.page.locator("#tabbar .tab, #snav a").filter({ hasText: "Requests" }).count(), 0, "staff have no Requests tab");

    // The diary's Today shows who's on and who opens.
    await a.page.goto(srv.base + "/");
    await a.page.locator("#onShift", { hasText: "Your rota today" }).waitFor();
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
    assert.equal(await a.page.locator("#page input[type=checkbox]:not([id^=em_]), #page .fchip").count(), 0, "no availability switches for staff (their email switches are theirs)");
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

for (const [label, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) {
  test(`employee privacy on ${label}: manager sees own records, an admin reviews ownership and business visibility`, { timeout: 120000 }, async () => {
    const suffix = label.toLowerCase(), name = `Private ${label} Manager`, username = `private.${suffix}`;
    const created = await call("POST", "/api/admin/users", { name, username, role: "manager", password: "privacy-temp-pass" });
    const id = created.user.id;
    const changed = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "privacy-temp-pass", newPassword: "privacy-manager-pass" }) });
    assert.equal(changed.status, 200);
    const [cookieName, cookieValue] = cookieOf(changed).split("=");
    const ownCookies = [{ name: cookieName, value: cookieValue, url: srv.base }];
    const today = londonToday(), week = addDays(today, -((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7));
    await call("PUT", `/api/rota/people/${id}`, { contractMin: 14, contractMax: 19, pattern: { mon: "off" }, sites: ["roastery"] });
    const ownShift = (await call("POST", "/api/rota/shifts", { userId: id, site: "roastery", day: today, start: "08:15", end: "13:15", breakMins: 0, note: "Your private planned shift note" })).shift;
    await call("PUT", `/api/rota/shifts/${ownShift.id}/actual`, { start: "08:15", end: "12:45", breakMins: 0, note: "Your private actual-hours note" });
    const otherShift = (await call("POST", "/api/rota/shifts", { userId: ALEX_ID, site: "roastery", day: today, start: "17:05", end: "19:55", breakMins: 0, note: "COLLEAGUE_PRIVATE_SHIFT" })).shift;
    await call("PUT", `/api/rota/shifts/${otherShift.id}/actual`, { start: "17:05", end: "18:35", breakMins: 0, note: "COLLEAGUE_PRIVATE_ACTUAL" });
    await call("POST", "/api/rota/week/publish", { week });
    await call("POST", "/api/db/set", { path: `staff/legacy-${suffix}`, data: { name, start: "2024-01-03", topics: { hygiene: { date: "2026-10-01", by: "web:Will Owner" } }, notes: "Your legacy training note", at: Date.now() } });
    await call("POST", "/api/db/set", { path: `staff/other-${suffix}`, data: { name: "Alex Brown", ownerUserId: ALEX_ID, topics: {}, notes: "COLLEAGUE_PRIVATE_TRAINING", at: Date.now() } });
    await call("POST", "/api/db/set", { path: `contacts/other-${suffix}`, data: { name: "COLLEAGUE_PRIVATE_CONTACT", phone: "01603 999999", visibility: "employee", ownerUserId: ALEX_ID } });

    const m = await pageFor(viewport, ownCookies), a = await pageFor(viewport);
    try {
      await serverTimeIs(m.page, Date.parse(today + "T12:00:00Z"));
      await m.page.goto(srv.base + "/rota/#mine");
      await m.page.locator(".mhours", { hasText: "14–19h contract" }).waitFor();
      assert.match(await m.page.locator("#page").innerText(), /4\.5h/);
      await m.page.locator(".nextshift", { hasText: "08:15–12:45" }).waitFor();
      assert.match(await m.page.locator(".nextshift").innerText(), /Your private actual-hours note/);
      assert.equal(await m.page.locator('[aria-label="Whose shifts"]').count(), 0, "manager has no colleague roster toggle");
      assert.equal(await m.page.locator('#snav a[href="#hours"],#snav a[href="#week"],#snav a[href="#requests"]').count(), 0, "manager has no employee administration or payroll navigation");
      assert.doesNotMatch(await m.page.locator("#page").innerText(), /Alex Brown|COLLEAGUE_PRIVATE|17:05|18:35/);
      await m.page.goto(srv.base + "/rota/#hours");
      await m.page.locator(".mhours").waitFor();
      assert.equal(await m.page.locator('a[download],a[href*="format=csv"]').count(), 0);
      await m.page.goto(srv.base + "/rota/#settings");
      await m.page.locator("#pageTitle", { hasText: "Site rota settings" }).waitFor();
      await m.page.getByLabel("Roastery opens at", { exact: true }).waitFor();
      assert.equal(await m.page.locator('[aria-label*="contracted hours"],.crange').count(), 0, "business settings do not render blank private contract inputs");

      await m.page.goto(srv.base + "/#staff");
      await m.page.locator("#tMine").waitFor();
      assert.equal(await m.page.locator("#tList .xrow").count(), 0, "a matching name does not adopt an unlinked legacy record");
      assert.match(await m.page.locator("#tList").innerText(), /ask an admin to link/i);
      await a.page.goto(srv.base + "/#staff");
      const legacy = a.page.locator("#tList .xrow", { hasText: name });
      await legacy.locator(".xmain").click();
      await legacy.getByRole("button", { name: "Edit record", exact: true }).click();
      assert.equal(await a.page.locator("#tOwnerUserId").inputValue(), "");
      await a.page.locator(`#tOwnerUserId option[value="${id}"]`).waitFor({ state: "attached" });
      await a.page.locator("#tOwnerUserId").selectOption(id);
      await a.page.locator("#tSave").click();
      await a.page.locator("#toast", { hasText: `Saved ${name}` }).waitFor();
      const linked = (await call("POST", "/api/db/get", { path: `staff/legacy-${suffix}` })).data;
      assert.equal(linked.ownerUserId, id); assert.equal(linked.notes, "Your legacy training note");
      const historicalName = `Historical ${name}`;
      await call("POST", "/api/db/update", { path: `staff/legacy-${suffix}`, patch: { name: historicalName } });
      await m.page.reload();
      const mine = m.page.locator("#tList .xrow", { hasText: name });
      await mine.locator(".xmain").click();
      assert.match(await mine.innerText(), /Your legacy training note/);
      assert.equal(await m.page.locator("#tList .xrow", { hasText: "Alex Brown" }).count(), 0);
      await mine.getByRole("button", { name: "Fill in and sign", exact: true }).click();
      assert.equal(await m.page.locator("#tName").getAttribute("readonly"), "");
      assert.equal(await m.page.locator("#tName").inputValue(), historicalName, "stable ownership supports a historical recorded name");
      assert.equal(await m.page.locator("#tOwnerField").isHidden(), true);
      assert.equal(await m.page.locator("#tImport").isHidden(), true);
      assert.equal(await m.page.locator("#tDelete").isHidden(), true);
      await m.page.locator("#tNotes").fill("Your updated manager training note");
      await m.page.locator("#tSignBox label").click();
      await m.page.locator("#tSave").click();
      await m.page.locator("#toast", { hasText: `Saved ${historicalName}` }).waitFor();
      const updated = (await call("POST", "/api/db/get", { path: `staff/legacy-${suffix}` })).data;
      assert.equal(updated.ownerUserId, id); assert.equal(updated.notes, "Your updated manager training note");
      assert.equal(updated.name, historicalName, "editing own training does not rewrite a historical name");
      assert.equal(updated.signed.by, "web:" + name);

      await a.page.goto(srv.base + "/#contacts");
      await a.page.locator("#addBtn").click();
      await a.page.locator("#c_name").fill(`Your ${label} emergency contact`);
      await a.page.locator("#c_phone").fill("01603 123456");
      await a.page.locator("#cForm").getByRole("button", { name: "Save contact", exact: true }).click();
      assert.match(await a.page.locator("#cForm").innerText(), /Choose shared business information or a private employee record/);
      assert.equal((await call("POST", "/api/db/query", { path: "contacts" })).docs.some((d) => d.data.name === `Your ${label} emergency contact`), false, "unreviewed contact is not created by a failed save");
      await a.page.locator("#c_visibility").selectOption("employee");
      await a.page.locator("#c_ownerUserId").selectOption(id);
      await a.page.locator("#cForm").getByRole("button", { name: "Save contact", exact: true }).click();
      await a.page.locator("#cList .xrow", { hasText: `Your ${label} emergency contact` }).waitFor();
      await m.page.goto(srv.base + "/#contacts");
      const contact = m.page.locator("#cList .xrow", { hasText: `Your ${label} emergency contact` });
      await contact.locator(".xmain").click();
      assert.equal(await m.page.locator("#addBtn").isHidden(), true);
      assert.doesNotMatch(await m.page.locator("#cList").innerText(), /COLLEAGUE_PRIVATE_CONTACT/);
      await contact.getByRole("button", { name: "Edit contact", exact: true }).click();
      assert.equal(await m.page.locator("#c_visibility").count(), 0, "manager cannot reclassify or reassign ownership");
      await m.page.locator("#c_phone").fill("01603 654321");
      await m.page.locator("#cForm").getByRole("button", { name: "Save contact", exact: true }).click();
      await m.page.locator("#toast", { hasText: `Saved Your ${label} emergency contact` }).waitFor();
      const contactRecord = (await call("POST", "/api/db/query", { path: "contacts" })).docs.find((d) => d.data.name === `Your ${label} emergency contact`);
      const contactSaved = contactRecord.data;
      assert.equal(contactSaved.ownerUserId, id); assert.equal(contactSaved.visibility, "employee"); assert.equal(contactSaved.phone, "01603 654321");
      await m.page.reload();
      await contact.locator(".xmain").click();
      await contact.getByRole("button", { name: "Edit contact", exact: true }).click();
      await m.page.locator("#c_phone").fill("01603 777777");
      await call("POST", "/api/db/update", { path: "contacts/" + contactRecord.id, ifVersion: contactRecord.ver, patch: { ownerUserId: ALEX_ID } });
      await m.page.locator("#cFormPanel").waitFor({ state: "hidden", timeout: 15000 });
      assert.equal(await m.page.locator("#c_phone").inputValue(), "", "a dirty private editor is cleared when ownership is removed");
      assert.equal(await contact.count(), 0);

      await a.page.goto(srv.base + "/#onboarding");
      await a.page.locator("#addBtn").click();
      await a.page.locator("#acctMenu").getByRole("menuitem", { name: "New blank document", exact: true }).click();
      await a.page.locator("#ob_title").fill(`Your ${label} induction`);
      await a.page.locator("#ob_visibility").selectOption("employee");
      await a.page.locator("#ob_ownerUserId").selectOption(id);
      await a.page.locator("#ob_summary").fill("Your private induction summary");
      await a.page.locator("#obSaveBtn").click();
      await a.page.locator("#obList .lrow", { hasText: `Your ${label} induction` }).waitFor();
      await m.page.goto(srv.base + "/#onboarding");
      assert.equal(await m.page.locator("#addBtn").isHidden(), true);
      await m.page.locator("#obList .lrow", { hasText: `Your ${label} induction` }).click();
      assert.match(await m.page.locator("#obEditView").innerText(), /Your private induction summary/);
      assert.equal(await m.page.locator("#ob_visibility").count(), 0);
      assert.deepEqual([...m.errors, ...a.errors], []);
    } finally { await m.ctx.close(); await a.ctx.close(); }
  });
}
