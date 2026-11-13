// Management → Fire safety log and Accident book, on a phone and an iPad in light and dark: the usual UK fire
// checks are added and ticked off; an accident recorded by staff is seen by them and an admin, not by a manager.
// Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { ({ chromium, devices } = await import("playwright")); }

let srv, browser, ADMIN, MGR, ALEX, SAM;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
async function signUp(name, username, role) {
  await call("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" });
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  return cookieOf(c);
}
async function device(cookie, opts) {
  const ctx = await browser.newContext(opts);
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}
const settings = { units: [], opening: [], closing: [], weekly: [], closedDays: [], hide: {}, info: {}, startDate: "2020-01-01", startSet: true };

before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  SAM = await signUp("Sam Green", "sam", "staff");
  for (const p of ["settings/main", "sites/cafe/settings/main", "sites/asg/settings/main", "sites/factory/settings/main"]) await call("POST", "/api/db/set", { path: p, data: settings });
});
after(async () => { await browser?.close(); await srv?.stop(); });

const views = [["phone", devices["iPhone 15 Pro"]], ["ipad", devices["iPad Pro 11"]]];
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

test("fire safety log: add the usual checks, tick one done with a note, add your own", async () => {
  let first = true;
  for (const [view, dev] of views) for (const colorScheme of ["light", "dark"]) {
    const d = await device(ALEX, { ...dev, colorScheme });
    await d.page.goto(srv.base + "/#fire");
    await d.page.locator('[data-panel="fire"]:not([hidden])').waitFor();
    if (first) {
      await d.page.getByRole("button", { name: "Add the usual fire safety checks" }).click();
      await d.page.locator("#fList .xrow", { hasText: "Staff fire training" }).waitFor();
      assert.equal(await d.page.locator("#fList .xrow").count(), 10);
      // Never done, so all overdue; tick the alarm test done with a note.
      const row = d.page.locator("#fList .xrow", { hasText: "Fire alarm test" });
      await row.locator(".xmain").click();
      await row.locator('input[placeholder="Note (optional)"]').fill("Call point 3, back door");
      await row.getByRole("button", { name: "Done with note" }).click();
      await d.page.locator("#fList .xrow", { hasText: "Fire alarm test" }).locator(".pill.ok").waitFor();
      // Add a site's own check.
      await d.page.locator("#addBtn").click();
      await d.page.locator("#fire_f_name").fill("Kitchen fire suppression check");
      await d.page.locator("#fire_f_freq").selectOption("monthly");
      await d.page.locator("#fFormPanel").getByRole("button", { name: "Save", exact: true }).click();
      await d.page.locator("#fList .xrow", { hasText: "Kitchen fire suppression check" }).waitFor();
      first = false;
    } else await d.page.locator("#fList .xrow", { hasText: "Kitchen fire suppression check" }).waitFor();
    assert.match(await d.page.locator("#fList").innerText(), /Call point 3|last/i);
    await shot(d.page, `fire-${view}-${colorScheme}`);
    // Overdue fire checks show on Today too, straight after switching to it.
    await d.page.goto(srv.base + "/#day"); await d.page.locator('[data-panel="day"]:not([hidden])').waitFor();
    await d.page.waitForFunction(() => { document.querySelector("#dayAlerts .alertmore")?.click(); return /Fire safety · /.test(document.querySelector("#dayAlerts")?.innerText || ""); }, null, { timeout: 10000 });
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  }
});

test("accident book: staff record an entry; they and the admin see it, a manager and other staff don't", async () => {
  let first = true;
  for (const [view, dev] of views) for (const colorScheme of ["light", "dark"]) {
    const d = await device(ALEX, { ...dev, colorScheme });
    await d.page.goto(srv.base + "/#accidents");
    await d.page.locator('[data-panel="accidents"]:not([hidden])').waitFor();
    if (first) {
      await d.page.locator("#addBtn").click();
      assert.equal(await d.page.locator("#aRiddorRefF").isHidden(), true, "HSE reference only once reported");
      await d.page.locator("#aPlace").fill("Basement kitchen stairs");
      await d.page.locator("#aPerson").fill("Jo Customer");
      await d.page.locator("#aType").selectOption("Customer");
      await d.page.locator("#aWhat").fill("Missed the bottom step carrying a tray");
      await d.page.locator("#aInjury").fill("Sprained right ankle");
      await d.page.locator("#aFirstAid").fill("Ice pack (Alex)");
      await d.page.locator("#aRiddor").selectOption("Reported to the HSE");
      assert.equal(await d.page.locator("#aRiddorRefF").isVisible(), true);
      await d.page.locator("#aRiddorRef").fill("RID-12345");
      await shot(d.page, `accident-form-${view}-${colorScheme}`);
      await d.page.locator("#aSave").click();
      first = false;
    }
    const row = d.page.locator("#aList .xrow", { hasText: "Jo Customer" });
    await row.waitFor();
    await row.locator(".xmain").click();
    assert.match(await row.innerText(), /Sprained right ankle[\s\S]*Reported[\s\S]*RID-12345[\s\S]*Recorded by/);
    assert.equal(await d.page.getByRole("button", { name: "Remove entry" }).isVisible(), false, "staff can't remove an entry");
    await shot(d.page, `accident-${view}-${colorScheme}`);
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  }
  for (const [who, cookie, sees] of [["manager", MGR, false], ["other staff", SAM, false], ["admin", ADMIN, true]]) {
    const d = await device(cookie, { ...devices["iPad Pro 11"] });
    await d.page.goto(srv.base + "/#accidents");
    await d.page.locator('[data-panel="accidents"]:not([hidden])').waitFor();
    if (sees) await d.page.locator("#aList .xrow", { hasText: "Jo Customer" }).waitFor();
    else { await d.page.locator("#aList .empty").waitFor(); await d.page.waitForTimeout(1500); }
    assert.equal(await d.page.locator("#aList .xrow", { hasText: "Jo Customer" }).count(), sees ? 1 : 0, who);
    if (!sees) assert.equal((await d.page.locator("body").innerText()).includes("Sprained right ankle"), false, `${who}: no details on screen`);
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  }
});

test("fire safety records: admins see every site's fire checks in one log; staff and managers don't", async () => {
  const at = Date.now() - 3600e3;
  await call("POST", "/api/db/set", { path: "sites/cafe/fire/cafealarm", data: { name: "Cafe alarm panel check", how: "", freq: "weekly", who: "", createdAt: at, lastAt: at, lastBy: "web:Will Owner", lastSet: false, log: [{ at, by: "web:Will Owner", note: "Zone 2 sounder replaced" }] } });
  await call("POST", "/api/db/set", { path: "sites/asg/fire/asgdrill", data: { name: "ASG fire drill", how: "", freq: "six-monthly", who: "", createdAt: at } });
  for (const [view, dev] of views) for (const colorScheme of ["light", "dark"]) {
    const d = await device(ADMIN, { ...dev, colorScheme });
    await d.page.goto(srv.base + "/#firelog");
    await d.page.locator('[data-panel="firelog"]:not([hidden])').waitFor();
    await d.page.locator("#flList .xrow", { hasText: "Cafe alarm panel check" }).waitFor();
    const text = await d.page.locator("#flList").innerText();
    // Done at the Roastery (ticked by Alex above) and at the Cafe, with the site and the note.
    assert.match(text, /Fire alarm test\s+Roastery · Alex Brown · Call point 3, back door/);
    assert.match(text, /Cafe alarm panel check\s+Cafe · Will Owner · Zone 2 sounder replaced/);
    assert.match(text, /Overdue now · \d+/i);
    assert.match(text, /ASG fire drill\s+ASG · Six-monthly · never done/);
    assert.equal(await d.page.locator("#flStats .stat").first().locator("b").innerText(), "2");
    await shot(d.page, `firelog-${view}-${colorScheme}`);
    // One site at a time.
    await d.page.locator("#flSites button", { hasText: "Cafe" }).click();
    await d.page.waitForFunction(() => !/Roastery/.test(document.querySelector("#flList").innerText));
    assert.match(await d.page.locator("#flList").innerText(), /Cafe alarm panel check/);
    await d.page.locator("#flSites button", { hasText: "All sites" }).click();
    assert.deepEqual(d.errors, []);
    await d.ctx.close();
  }
  // Admins find it under More; staff and managers don't, and the address takes them to Today.
  const a = await device(ADMIN, devices["iPhone 15 Pro"]);
  await a.page.goto(srv.base + "/#more"); await a.page.locator("#moreHub .lrow", { hasText: "Fire safety records" }).waitFor();
  await a.ctx.close();
  for (const cookie of [ALEX, MGR]) {
    const d = await device(cookie, devices["iPhone 15 Pro"]);
    await d.page.goto(srv.base + "/#firelog");
    await d.page.locator('[data-panel="day"]:not([hidden])').waitFor();
    await d.page.goto(srv.base + "/#more"); await d.page.locator("#moreHub .lrow", { hasText: "Fire safety log" }).waitFor();
    assert.equal(await d.page.locator("#moreHub .lrow", { hasText: "Fire safety records" }).count(), 0);
    await d.ctx.close();
  }
});
