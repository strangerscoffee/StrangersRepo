// The admin section's API (src/adminView.ts, src/admin.ts) and its own address (ADMIN_HOST), against `wrangler dev`
// with a fresh local database. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF, MANAGER, ids = {};
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const postJson = (base, url, body) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function call(method, path, body, cookie = ADMIN, base = srv.base) {
  const r = await fetch(base + path, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text, headers: r.headers };
}
async function firstSignIn(username, temp, chosen) {
  await postJson(srv.base, "/api/auth/login", { username, password: temp });
  const r = await postJson(srv.base, "/api/auth/change", { username, password: temp, newPassword: chosen });
  assert.equal(r.status, 200);
  return cookieOf(r);
}
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

before(async () => {
  srv = await startServer();
  ADMIN = cookieOf(await postJson(srv.base, "/api/auth/setup", { name: "Sam Patel", username: "sam.patel", password: "admin-pass-1", code: SETUP_CODE }));
  for (const [name, username, role] of [["Alex Brown", "alex", "staff"], ["Max Moore", "max", "manager"]]) {
    ids[name] = (await call("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" })).body.user.id;
  }
  STAFF = await firstSignIn("alex", "temp-pass-1", "alex-own-pass");
  MANAGER = await firstSignIn("max", "temp-pass-1", "max-own-pass");
});
after(async () => { await srv?.stop(); });

test("admin page: at /admin for admins (no admin address here), others go back to the diary", async () => {
  const page = await fetch(srv.base + "/admin", { headers: { cookie: ADMIN } });
  assert.equal(page.status, 200);
  const htmlText = await page.text();
  assert.match(htmlText, /<script src="\/admin\/admin.js\?v=[0-9a-f]+"><\/script>/, "linked by fingerprint");
  assert.doesNotMatch(htmlText, /<script>/, "no inline scripts (the CSP allows only the site's own files)");
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  for (const cookie of [STAFF, MANAGER]) for (const p of ["/admin", "/admin/", "/admin.html", "/admin/index.html"]) {
    assert.equal((await call("GET", p, undefined, cookie)).headers.get("location"), "/", p);
  }
});

test("overview: what needs attention, today's diary and this week's rota", async () => {
  const settings = { units: [{ id: "u1", name: "Fridge", kind: "fridge" }], opening: [{ id: "o1", t: "Hands" }], closing: [{ id: "c1", t: "Bins" }], weekly: [], closedDays: [] };
  await call("POST", "/api/db/set", { path: "settings/main", data: settings });
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: settings });
  await call("POST", "/api/db/set", { path: `sites/cafe/days/${today}`, data: { date: today, temps: { u1: { am: { v: 3 } } }, opening: { items: { o1: true } } } });
  await call("POST", "/api/rota/shifts", { site: "cafe", day: today, start: "08:00", end: "16:00", breakMins: 30, userId: ids["Alex Brown"] });
  const { status, body } = await call("GET", "/api/admin/overview");
  assert.equal(status, 200);
  const cafe = body.diaryToday.find((s) => s.id === "cafe");
  assert.deepEqual([cafe.pct, cafe.status], [50, "Closing checks to do"]);
  assert.equal(body.diaryToday.find((s) => s.id === "asg").setUp, false);
  assert.ok(body.attention.some((a) => a.title === "The ASG isn't set up"));
  assert.ok(body.attention.some((a) => /rota isn't published/.test(a.title)));
  assert.equal(body.rotaWeek.find((s) => s.id === "cafe").hours, 7.5);
  assert.equal(body.stats.people.active, 3);
});

test("overview: notices that happened (errors, failed emails, clocks) can be dismissed, and come back when there's a new one", async () => {
  const report = (message) => call("POST", "/api/errors", { app: "diary", page: "/#day", message });
  const errorsNotice = async () => (await call("GET", "/api/admin/overview")).body.attention.find((a) => /errors? on the site/.test(a.title));
  await report("TypeError: one");
  const n = await errorsNotice();
  assert.equal(n?.dismiss, "errors", "it can be dismissed");
  assert.ok(!(await call("GET", "/api/admin/overview")).body.attention.find((a) => /rota isn't published/.test(a.title))?.dismiss, "things still to do can't");
  assert.equal((await call("POST", "/api/admin/overview/dismiss", { key: "errors" })).status, 200);
  assert.equal(await errorsNotice(), undefined, "gone once dismissed");
  await new Promise((r) => setTimeout(r, 5));
  await report("TypeError: two");
  assert.match((await errorsNotice())?.title || "", /^1 error on the site/, "back for a new error, counting only what's new");
  for (const key of ["", "users", "clock:abc", "errors; DROP TABLE users"]) assert.equal((await call("POST", "/api/admin/overview/dismiss", { key })).status, 400, key);
  assert.equal((await call("POST", "/api/admin/overview/dismiss", { key: "errors" }, MANAGER)).status, 403, "admins only");
});

test("people: account, rota and training together; availability is admin-only", async () => {
  await call("POST", "/api/db/set", { path: "sites/cafe/staff/t1", data: { name: "alex brown", topics: { hygiene: { date: "2026-01-01" }, diary: { date: "2026-01-01" } }, signed: { by: "web:Alex Brown", at: 5 } } });
  await call("POST", "/api/db/set", { path: "staff/t2", data: { name: "Alex Brown", topics: { allergens: { date: "2026-01-01" } } } });
  assert.equal((await call("PUT", `/api/rota/people/${ids["Alex Brown"]}`, { sites: ["cafe"] }, MANAGER)).status, 403, "managers can't set availability");
  assert.equal((await call("PUT", `/api/rota/people/${ids["Alex Brown"]}`, { contractMin: 8, contractMax: 10, sites: ["cafe"], pattern: { sun: "off" } })).status, 200);
  const alex = (await call("GET", "/api/admin/people")).body.people.find((p) => p.name === "Alex Brown");
  assert.deepEqual(alex.training.topics, ["hygiene", "allergens", "diary"], "every site's record, matched by name");
  assert.equal(alex.training.signedAt, 5);
  assert.deepEqual([alex.rota.contractMax, alex.rota.sites, alex.rota.pattern.sun, alex.rota.weekHours], [10, ["cafe"], "off", 7.5]);
  assert.equal(alex.username, "alex");
  assert.ok(!("pin_hash" in alex) && !JSON.stringify(alex).includes("hash"), "never password or PIN hashes");
});

test("sites, and copying a Setup to a site that has none", async () => {
  const before = (await call("GET", "/api/admin/sites")).body.sites;
  assert.deepEqual(before.map((s) => s.setUp), [true, true, false, false]);
  assert.equal((await call("POST", "/api/admin/sites/cafe/copy-setup", { from: "roastery" })).body.code, "conflict", "only to a site with no Setup");
  assert.equal((await call("POST", "/api/admin/sites/factory/copy-setup", { from: "asg" })).body.code, "conflict", "only from a site with one");
  assert.equal((await call("POST", "/api/admin/sites/factory/copy-setup", { from: "roastery" })).status, 200);
  const copied = (await call("POST", "/api/db/get", { path: "sites/factory/settings/main" })).body.data;
  assert.equal(copied.units[0].name, "Fridge");
  assert.equal(copied.opening[0].from, today, "checks count from today at the new site");
  assert.equal(copied.info.address, "122 Ber Street, Norwich, NR1 3ES");
});

test("account changes, lockouts and failed sign-ins are logged; activity and security show them", async () => {
  await call("PATCH", `/api/admin/users/${ids["Max Moore"]}`, { role: "staff" });
  await call("PATCH", `/api/admin/users/${ids["Max Moore"]}`, { role: "manager" });
  for (let i = 0; i < 5; i++) await postJson(srv.base, "/api/auth/login", { username: "alex", password: "wrong-pass-1" });
  await postJson(srv.base, "/api/auth/login", { username: "my-secret-password", password: "x" });
  const act = (await call("GET", "/api/admin/activity?kind=account")).body.items.map((i) => i.text);
  assert.ok(act.includes("Sam Patel made Max Moore staff"), act.join(" | "));
  assert.ok(act.includes("Alex Brown was locked out after 5 wrong passwords"));
  assert.ok(act.includes("Sam Patel copied the Roastery's diary Setup to the Factory"));
  assert.ok(!act.some((t) => /Wrong password/.test(t)), "failed sign-ins are on Security, not Activity");
  const all = (await call("GET", "/api/admin/activity")).body.items;
  assert.ok(all.some((i) => i.kind === "diary" && /Sam Patel updated the diary for/.test(i.text)));
  const sec = (await call("GET", "/api/admin/security")).body;
  assert.deepEqual(sec.locked.map((l) => l.name), ["Alex Brown"]);
  assert.ok(sec.failed24h >= 6);
  assert.ok(!JSON.stringify(sec).includes("my-secret-password"), "a typed username is never logged");
  await call("PATCH", `/api/admin/users/${ids["Alex Brown"]}`, { unlock: true });
  assert.equal((await call("GET", "/api/admin/security")).body.locked.length, 0);
});

test("exports: people and shifts as CSV, safe to open in a spreadsheet", async () => {
  await call("PATCH", `/api/admin/users/${ids["Alex Brown"]}`, { name: "=Alex Brown" });
  const people = await call("GET", "/api/admin/export/people.csv");
  assert.match(people.headers.get("content-type"), /text\/csv/);
  assert.match(people.text, /^"name","username","role"/);
  assert.match(people.text, /"'=Alex Brown"/, "a leading = can't run as a formula");
  assert.doesNotMatch(people.text, /hash|pin_/);
  await call("PATCH", `/api/admin/users/${ids["Alex Brown"]}`, { name: "Alex Brown" });
  const shifts = await call("GET", `/api/admin/export/shifts.csv?from=${today}&to=${today}`);
  assert.match(shifts.text, /"Cafe","Alex Brown","","08:00","16:00","30","","","","7.5",""/);
  assert.equal((await call("GET", "/api/admin/export/shifts.csv?from=2026-12-01&to=2026-01-01")).status, 400);
});

test("everyone: reset quick PINs and sign everyone out", async () => {
  assert.equal((await call("POST", "/api/auth/pin", { pin: "4826" }, MANAGER)).status, 200);
  assert.equal((await call("POST", "/api/admin/security/reset-pins")).body.reset, 1);
  assert.equal((await call("GET", "/api/admin/security")).body.quickPins, 0);
  assert.equal((await call("POST", "/api/admin/security/sign-out-all")).status, 200);
  assert.equal((await call("GET", "/api/admin/overview")).status, 401, "including the admin who did it");
  assert.equal((await call("GET", "/api/rota/me", undefined, STAFF)).status, 401);
  ADMIN = cookieOf(await postJson(srv.base, "/api/auth/login", { username: "sam.patel", password: "admin-pass-1" }));
  assert.ok((await call("GET", "/api/admin/activity?kind=account")).body.items.some((i) => i.text === "Sam Patel signed everyone out"));
});

// The admin section's own address, end to end: a second server whose ADMIN_HOST is the hostname the Worker sees
// under `wrangler dev`.
test("the admin host: admins only, its page at /, nothing of the diary's", async () => {
  const host = await startServer({ vars: { ADMIN_HOST: "staffstrangerscoffee.com" } });
  try {
    const setup = cookieOf(await postJson(host.base, "/api/auth/setup", { name: "Host Admin", username: "host", password: "admin-pass-1", code: SETUP_CODE }));
    const get = (p, cookie) => call("GET", p, undefined, cookie, host.base);
    assert.equal((await get("/")).headers.get("location"), "/signin", "signed out: sign in first");
    const home = await get("/", setup);
    assert.equal(home.status, 200);
    assert.match(home.text, /admin\.js/);
    for (const p of ["/admin/admin.js", "/admin/wholesale-invoices.js", "/admin/wholesale.js", "/admin/admin.css", "/admin/wholesale-invoices.css", "/theme.css", "/icon-192.png", "/shared/core.js", "/wholesale-preview/images/brazil.webp"]) assert.equal((await get(p, setup)).status, 200, p);
    assert.match(home.text, /<script src="\/shared\/core.js\?v=\w+"><\/script>\n<script src="\/admin\/wholesale-invoices.js\?v=\w+"><\/script>\n<script src="\/admin\/wholesale.js\?v=\w+"><\/script>\n<script src="\/admin\/admin.js\?v=\w+"><\/script>/, "shared helpers, invoicing and wholesale view load before the admin shell");
    for (const p of ["/diary/core.js", "/index.html", "/rota/", "/admin/"]) assert.equal((await get(p, setup)).headers.get("location"), "/", p + " goes to /");
    assert.equal((await call("POST", "/api/db/get", { path: "days/x" }, setup, host.base)).status, 404, "the diary's data API isn't here");
    assert.equal((await get("/api/admin/overview", setup)).status, 200);
    assert.equal((await get("/api/rota/links", setup)).body.admin, "/");
    // A member of staff who opens the admin address goes back to the diary; its API refuses them.
    await call("POST", "/api/admin/users", { name: "Kim Lee", username: "kim", role: "manager", password: "temp-pass-1" }, setup, host.base);
    await postJson(host.base, "/api/auth/login", { username: "kim", password: "temp-pass-1" });
    const kim = cookieOf(await postJson(host.base, "/api/auth/change", { username: "kim", password: "temp-pass-1", newPassword: "kim-own-pass" }));
    // To the diary's address (which `wrangler dev` rewrites to its own, local one).
    const diary = [host.base + "/", "https://staffstrangerscoffee.com/"];
    assert.ok(diary.includes((await get("/", kim)).headers.get("location")), "managers go to the diary");
    assert.equal((await get("/api/admin/people", kim)).status, 403);
    assert.ok(diary.includes((await get("/admin/admin.js", kim)).headers.get("location")), "not even its files");
    assert.ok(diary.includes((await get("/shared/core.js", kim)).headers.get("location")), "nor the shared helpers, on the admin address");
  } finally { await host.stop(); }
});

test("with an admin address, /admin on the diary goes there", async () => {
  const host = await startServer({ vars: { ADMIN_HOST: "admin.example.test" } });
  try {
    const setup = cookieOf(await postJson(host.base, "/api/auth/setup", { name: "Host Admin", username: "host", password: "admin-pass-1", code: SETUP_CODE }));
    assert.equal((await call("GET", "/admin", undefined, setup, host.base)).headers.get("location"), "https://admin.example.test/");
    assert.equal((await call("GET", "/api/rota/links", undefined, setup, host.base)).body.admin, "https://admin.example.test/");
  } finally { await host.stop(); }
});
