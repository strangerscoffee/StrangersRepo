// Maintenance notifications in the diary: the bell (with a count), Maintenance in the menu, and Today.
// A job assigned to someone, a new (urgent) job for managers, a job done for whoever reported it, and a job left open
// too long; "seen" follows the person to their other devices. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { ({ chromium, devices } = await import("playwright")); }

let srv, browser, ADMIN, MGR, ALEX;
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
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  for (const p of ["settings/main", "sites/cafe/settings/main"]) await call("POST", "/api/db/set", { path: p, data: settings });
  const now = Date.now();
  // Assigned to Alex by George, at the Cafe; an urgent job Alex reported two days ago at the Roastery; one done.
  await call("POST", "/api/db/set", { path: "sites/cafe/maintenance/m1", data: { title: "Dishwasher leaking", area: "Kitchen", status: "open", priority: "soon",
    reportedBy: "web:George Farrow", reportedAt: now - 3600e3, assignee: "web:Alex Brown", assigneeName: "Alex Brown", at: now - 1800e3,
    log: [{ at: now - 1800e3, by: "web:George Farrow", what: "Assigned to Alex Brown", note: "" }] } }, MGR);
  await call("POST", "/api/db/set", { path: "maintenance/m2", data: { title: "Grinder jammed", area: "Bar", status: "open", priority: "urgent",
    reportedBy: "web:Alex Brown", reportedAt: now - 2 * 864e5, at: now - 2 * 864e5, log: [] } }, ALEX);
  await call("POST", "/api/db/set", { path: "maintenance/m3", data: { title: "Back door lock", status: "done", priority: "soon",
    reportedBy: "web:Alex Brown", reportedAt: now - 5 * 864e5, doneBy: "web:George Farrow", doneAt: now - 600e3, fixNote: "New barrel fitted", at: now - 600e3, log: [] } }, MGR);
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("staff: a job assigned to them and their reported job done show by the bell and on Today; seen on one device, cleared on the next", async () => {
  const a = await device(ALEX, { ...devices["iPhone 15 Pro"] });
  await a.page.goto(srv.base + "/");
  await a.page.locator("#bellBtn .n", { hasText: "2" }).waitFor();
  await a.page.locator("#dayAlerts .alert", { hasText: "Dishwasher leaking" }).waitFor();
  assert.match(await a.page.locator("#dayAlerts").innerText(), /Assigned to you by George Farrow · Cafe/);
  assert.match(await a.page.locator("#dayAlerts").innerText(), /Back door lock[\s\S]*Done by George Farrow: New barrel fitted/);
  // Staff don't hear about every job, only theirs: the urgent one Alex reported isn't "new" for Alex.
  if (process.env.SHOTS) await a.page.screenshot({ path: process.env.SHOTS + "/staff-today.png" });
  await a.page.locator("#bellBtn").click();
  await a.page.locator("#notifSheet .lrow", { hasText: "Dishwasher leaking" }).waitFor();
  assert.equal(await a.page.locator("#notifSheet .unread").count(), 2);
  if (process.env.SHOTS) await a.page.screenshot({ path: process.env.SHOTS + "/staff-bell.png" });
  // Opening one goes to Maintenance → All sites with the job opened.
  await a.page.locator("#notifSheet .lrow", { hasText: "Dishwasher leaking" }).click();
  await a.page.locator("#pageTitle", { hasText: "Maintenance" }).waitFor();
  await a.page.locator("#mList .xrow.open", { hasText: "Dishwasher leaking" }).waitFor();
  await a.page.locator("#bellBtn .n").waitFor({ state: "detached" });
  // Another of Alex's devices: already seen.
  const b = await device(ALEX, { viewport: { width: 1180, height: 820 } });
  await b.page.goto(srv.base + "/");
  await b.page.locator("#sideBell").waitFor();
  await b.page.waitForTimeout(1500);
  assert.equal(await b.page.locator("#sideBell .n").count(), 0, "seen on the other device");
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.ctx.close(); await b.ctx.close();
});

test("managers: new and long-open urgent jobs, with a count on Maintenance in the menu", async () => {
  const m = await device(MGR, { viewport: { width: 1180, height: 820 } });
  await m.page.goto(srv.base + "/");
  await m.page.locator("#sideBell .n", { hasText: "2" }).waitFor();
  assert.match(await m.page.locator("#snav").innerText(), /Maintenance\s*2\b/);
  await m.page.locator("#sideBell").click();
  const txt = await m.page.locator("#notifList").innerText();
  assert.match(txt, /Grinder jammed[\s\S]*Urgent and still open after a day · Roastery/);
  assert.match(txt, /Grinder jammed[\s\S]*Urgent · Reported by Alex Brown · Roastery/);
  if (process.env.SHOTS) await m.page.screenshot({ path: process.env.SHOTS + "/manager-bell.png" });
  assert.deepEqual(m.errors, []);
  await m.ctx.close();
});

test("the seen time is per person and never moves backwards or into the future", async () => {
  const far = Date.now() + 365 * 864e5;
  const r = await call("POST", "/api/auth/notifications/seen", { at: far }, MGR);
  assert.ok(r.seen <= Date.now(), "not later than now");
  const back = await call("POST", "/api/auth/notifications/seen", { at: 5 }, MGR);
  assert.equal(back.seen, r.seen, "never backwards");
  assert.equal((await call("GET", "/api/auth/me", undefined, MGR)).user.notifSeen, r.seen);
});
