// Rota tests: the API (src/rota.ts) against `wrangler dev` with a fresh local database, the hostname
// decision (src/hosts.ts) directly, and the rota's own hostname end to end. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

// A week well in the future, so requests (which must be for shifts from today on) are allowed.
const WEEK = "2030-01-07"; // Monday
const day = (i) => { const d = new Date(WEEK + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const MON = day(0), TUE = day(1), WED = day(2), THU = day(3), FRI = day(4), SAT = day(5), SUN = day(6);

let srv, ADMIN, MGR, ALEX, SAM;
const ids = {};

// The session a response sets (its first Set-Cookie may remove an older, host-only copy: src/auth.ts).
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await fetch(srv.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
}
const rota = (method, route, body, cookie) => req(method, "/api/rota/" + route, body, cookie);
async function signUp(name, username, role) {
  const r = await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" });
  assert.equal(r.status, 200, r.text);
  await req("POST", "/api/auth/login", { username, password: "temp-pass-1" }, null);
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  assert.equal(c.status, 200);
  return cookieOf(c);
}
const settings = (site, closedDays) => req("POST", "/api/db/set", {
  path: (site === "roastery" ? "" : `sites/${site}/`) + "settings/main",
  data: { closedDays, units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} },
});
const addShift = async (s, cookie = ADMIN) => {
  const r = await rota("POST", "shifts?with=problems", { breakMins: 30, job: "", ...s }, cookie);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const kinds = (problems) => problems.map((p) => p.kind);

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  SAM = await signUp("Sam Okafor", "sam", "staff");
  await signUp("Priya Shah", "priya", "staff");
  await settings("roastery", [0, 6]); // closed weekends
  await settings("cafe", [0]); // closed Sundays
  await settings("asg", []);
  // Factory has no settings: not in use.
  const w = await rota("GET", "week?start=" + WEEK, undefined, ADMIN);
  for (const p of w.body.people) ids[p.name.split(" ")[0]] = p.id;
});
after(async () => { await srv?.stop(); });

test("hostnames: the rota on ROTA_HOST, the diary everywhere else", async () => {
  const { appForHost, appLinks, isRotaSharedFile } = await import("../src/hosts.ts");
  assert.equal(appForHost("rota.staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "rota");
  assert.equal(appForHost("ROTA.staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "rota");
  assert.equal(appForHost("staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "diary");
  assert.equal(appForHost("localhost", undefined), "diary");
  const R = "rota.staffstrangerscoffee.com", A = "admin.staffstrangerscoffee.com";
  assert.equal(appForHost(A, R, A), "admin");
  assert.equal(appForHost("staffstrangerscoffee.com", R, A), "diary");
  assert.deepEqual(appLinks(new URL("https://staffstrangerscoffee.com/"), R), { rota: "https://rota.staffstrangerscoffee.com/", diary: "/", admin: "/admin" });
  assert.deepEqual(appLinks(new URL("https://rota.staffstrangerscoffee.com/"), R), { rota: "/", diary: "https://staffstrangerscoffee.com/", admin: "/admin" });
  assert.deepEqual(appLinks(new URL("http://localhost:8787/"), undefined), { rota: "/rota/", diary: "/", admin: "/admin" });
  assert.deepEqual(appLinks(new URL("https://staffstrangerscoffee.com/"), R, A), { rota: `https://${R}/`, diary: "/", admin: `https://${A}/` });
  assert.deepEqual(appLinks(new URL(`https://${A}/`), R, A), { rota: `https://${R}/`, diary: "https://staffstrangerscoffee.com/", admin: "/" });
  assert.ok(isRotaSharedFile("/theme.css") && isRotaSharedFile("/rota/rota.js") && isRotaSharedFile("/icon-192.png") && isRotaSharedFile("/shared/core.js"));
  assert.ok(!isRotaSharedFile("/diary/core.js") && !isRotaSharedFile("/admin.html") && !isRotaSharedFile("/claude-shim.js"));
  assert.ok(!isRotaSharedFile("/shared/../diary/core.js") && !isRotaSharedFile("/shared/x.css"), "only the shared scripts");
});

test("one Staff Login: the rota's sign-in page is the diary's, and comes back after", async () => {
  const { unifiedSignin } = await import("../src/hosts.ts");
  const D = "staffstrangerscoffee.com";
  const at = (u) => unifiedSignin(new URL(u), D);
  assert.equal(at("https://rota.staffstrangerscoffee.com/signin"), "https://staffstrangerscoffee.com/signin?next=https%3A%2F%2Frota.staffstrangerscoffee.com%2F");
  assert.equal(at("https://rota.staffstrangerscoffee.com/signin?next=%2F%3Fweek%3D2026-11-09"),
    "https://staffstrangerscoffee.com/signin?next=https%3A%2F%2Frota.staffstrangerscoffee.com%2F%3Fweek%3D2026-11-09");
  assert.equal(at("https://rota.staffstrangerscoffee.com/signin?next=%2F%2Fevil.example"), "https://staffstrangerscoffee.com/signin?next=https%3A%2F%2Frota.staffstrangerscoffee.com%2F", "next stays on the rota");
  assert.equal(at("https://staffstrangerscoffee.com/signin"), null, "the diary shows the sign-in page itself");
  assert.equal(at("https://evilstaffstrangerscoffee.com/signin"), null);
  assert.equal(unifiedSignin(new URL("http://localhost:8787/signin"), D), null, "local dev");
  assert.equal(unifiedSignin(new URL("https://rota.staffstrangerscoffee.com/signin"), ""), null, "no shared domain");

  // End to end: under `wrangler dev` the Worker sees staffstrangerscoffee.com, a subdomain of "com".
  const host = await startServer({ vars: { COOKIE_DOMAIN: "com" } });
  try {
    const r = await fetch(host.base + "/signin?next=%2Frota%2F", { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://com/signin?next=https%3A%2F%2Fstaffstrangerscoffee.com%2Frota%2F");
  } finally { await host.stop(); }
  // And on the real config the diary's own sign-in page, now called Staff Login.
  const page = await fetch(srv.base + "/signin");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Staff Login<\/h1>/);
});

test("the diary host: the diary as before, plus the rota app at /rota/ and its API", async () => {
  assert.equal((await req("GET", "/rota/", undefined, null)).headers.get("location"), "/signin?next=%2Frota%2F");
  const page = await req("GET", "/rota/");
  assert.equal(page.status, 200);
  assert.match(page.text, /rota\.js/);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match((await req("GET", "/")).text, /diary\/start\.js/, "the diary still serves its page");
  assert.equal((await rota("GET", "week", undefined, null)).body.code, "unauthenticated");
});

test("only admins plan: staff and managers cannot change assigned shifts, publish, or read private hours and suggestions", async () => {
  const s = (await addShift({ site: "asg", day: MON, start: "09:00", end: "12:00" })).shift;
  for (const cookie of [ALEX, MGR]) {
    const refused = [
      await rota("POST", "shifts", { site: "asg", day: MON, start: "09:00", end: "12:00" }, cookie),
      await rota("PATCH", "shifts/" + s.id, { start: "08:00" }, cookie),
      await rota("DELETE", "shifts/" + s.id, undefined, cookie),
      await rota("POST", "week/publish", { week: WEEK }, cookie),
      await rota("POST", "week/copy", { from: WEEK, to: day(7) }, cookie),
      await rota("GET", "hours?start=" + WEEK, undefined, cookie),
      await rota("GET", `hours?start=${WEEK}&format=csv`, undefined, cookie),
      await rota("GET", "suggest?shift=" + s.id, undefined, cookie),
      await rota("PUT", "people/" + ids.Alex, { contractHours: 40 }, cookie),
    ];
    for (const r of refused) { assert.equal(r.status, 403, r.text); assert.equal(r.body.code, "permission_denied"); }
  }
  assert.equal((await rota("PUT", "sites/cafe", { opensAt: "07:00", closesAt: "17:00", minPeople: 2 }, ALEX)).status, 403);
  assert.equal((await rota("PATCH", "shifts/" + s.id, { start: "08:00" }, ADMIN)).status, 200, "admins can");
  assert.equal((await rota("DELETE", "shifts/" + s.id, undefined, ADMIN)).status, 200, "admins can");
});

test("validation: bad site, date, times, closed day, unknown person", async () => {
  const bad = [
    { site: "moon", day: MON, start: "09:00", end: "12:00" },
    { site: "cafe", day: "2030-02-30", start: "09:00", end: "12:00" },
    { site: "cafe", day: MON, start: "12:00", end: "09:00" },
    { site: "cafe", day: MON, start: "9am", end: "12:00" },
    { site: "cafe", day: SUN, start: "09:00", end: "12:00" }, // the Cafe is closed on Sundays
    { site: "factory", day: MON, start: "09:00", end: "12:00" }, // not in use
    { site: "cafe", day: MON, start: "09:00", end: "12:00", userId: "nobody" },
    { site: "cafe", day: MON, start: "09:00", end: "12:00", breakMins: 400 },
    { site: "cafe", day: MON, start: "09:00", end: "12:00", job: "sweeps" },
  ];
  for (const b of bad) {
    const r = await rota("POST", "shifts", b, ADMIN);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.code, "invalid_argument");
  }
  assert.match((await rota("POST", "shifts", bad[4], ADMIN)).body.message, /closed on Sundays/);
  // A save doesn't work out the week's problems unless asked (?with=problems): the page redraws the week anyway.
  const plain = await rota("POST", "shifts", { site: "cafe", day: MON, start: "09:00", end: "12:00" }, ADMIN);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.body.problems, undefined);
  assert.equal(plain.body.week, WEEK);
  await rota("DELETE", "shifts/" + plain.body.shift.id, undefined, ADMIN);
  // A day closed in the diary (Today → closed, or a planned closure) is closed on the rota too.
  await req("POST", "/api/db/set", { path: `sites/cafe/days/${TUE}`, data: { date: TUE, closed: { reason: "Boiler repair", by: "web:Will Owner", at: 1 } } });
  const r = await rota("POST", "shifts", { site: "cafe", day: TUE, start: "09:00", end: "12:00" }, ADMIN);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Boiler repair/);
  const w = await rota("GET", "week?start=" + WEEK, undefined, ADMIN);
  const cafe = w.body.sites.find((x) => x.id === "cafe");
  assert.equal(cafe.open[1], false);
  assert.equal(cafe.closedWhy[1], "Boiler repair");
  assert.equal(w.body.sites.find((x) => x.id === "factory").inUse, false);
  await req("POST", "/api/db/set", { path: `sites/cafe/days/${TUE}`, data: { date: TUE, closed: null } });
});

test("checks: every kind of problem", async () => {
  const W = "2030-02-04"; // a clean week
  const d = (i) => { const x = new Date(W + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + i); return x.toISOString().slice(0, 10); };
  await rota("PUT", "sites/asg", { opensAt: "08:00", closesAt: "12:00", minPeople: 2 }, MGR);
  await rota("PUT", "people/" + ids.Sam, { contractHours: 10 }, ADMIN);
  await rota("PUT", "people/" + ids.Priya, { contractMin: 16, contractMax: 30 }, ADMIN);
  await rota("POST", "time-off", { userId: ids.Priya, from: d(2), to: d(2), reason: "Holiday" }, ADMIN);
  await addShift({ site: "asg", day: d(0), start: "08:00", end: "12:00", job: "opens", userId: null }); // open shift
  await addShift({ site: "asg", day: d(1), start: "08:00", end: "16:00", job: "opens", userId: ids.Sam, breakMins: 0 }); // 8h, no break
  await addShift({ site: "cafe", day: d(1), start: "10:00", end: "14:00", job: "closes", userId: ids.Sam }); // clash across sites
  await addShift({ site: "asg", day: d(2), start: "08:00", end: "12:00", job: "opens", userId: ids.Priya }); // on time off
  await addShift({ site: "asg", day: d(3), start: "17:00", end: "22:00", userId: ids.Alex, job: "closes" });
  const last = await addShift({ site: "asg", day: d(4), start: "06:00", end: "10:00", userId: ids.Alex, job: "opens" }); // 8h rest
  const ks = kinds(last.problems);
  for (const k of ["open_shift", "clash", "time_off", "short_cover", "overtime", "rest", "break", "under_contract"]) assert.ok(ks.includes(k), "has " + k + ": " + ks.join(","));
  const clash = last.problems.find((p) => p.kind === "clash");
  assert.match(clash.message, /Sam is at (ASG and Cafe|Cafe and ASG) on Tuesday/);
  assert.equal(last.problems.find((p) => p.kind === "overtime").userId, ids.Sam);
  assert.match(last.problems.find((p) => p.kind === "overtime").message, /Sam has 1.5h overtime \(11.5h, contract 10h\)/);
  assert.match(last.problems.find((p) => p.kind === "under_contract" && p.userId === ids.Priya).message, /Priya has 3.5h, 12.5h short of their 16h minimum/);
  assert.ok(!last.problems.some((p) => p.kind === "no_opener" || p.kind === "no_closer"), "no checks for who opens or closes");
  // Errors come first.
  const sev = last.problems.map((p) => p.severity);
  assert.deepEqual(sev, [...sev].sort((a, b) => ["error", "warn", "info"].indexOf(a) - ["error", "warn", "info"].indexOf(b)));
});

test("publishing: staff see a week only once it's published; later changes are counted", async () => {
  const W = "2030-03-04";
  const s = (await addShift({ site: "cafe", day: W, start: "07:00", end: "15:00", userId: ids.Alex, job: "opens" })).shift;
  let staff = await rota("GET", "week?start=" + W, undefined, ALEX);
  assert.equal(staff.body.published, false);
  assert.deepEqual(staff.body.shifts, []);
  assert.deepEqual(staff.body.problems, []);
  assert.deepEqual(staff.body.people.map((p) => p.id), [ids.Alex], "the people list contains only the signed-in employee");
  assert.deepEqual((await rota("GET", `mine?from=${W}&to=${W}`, undefined, ALEX)).body.shifts, []);
  assert.equal((await rota("GET", `today?site=cafe&day=${W}`, undefined, ALEX)).body.published, false);
  await rota("POST", "week/publish", { week: W }, ADMIN);
  staff = await rota("GET", "week?start=" + W, undefined, ALEX);
  assert.equal(staff.body.published, true);
  assert.equal(staff.body.shifts.length, 1);
  assert.equal((await rota("GET", `mine?from=${W}&to=${W}`, undefined, ALEX)).body.shifts.length, 1);
  const today = await rota("GET", `today?site=cafe&day=${W}`, undefined, ALEX);
  assert.deepEqual(today.body.shifts.map((x) => [x.name, x.me, x.job]), [["Alex Brown", true, "opens"]]);
  await rota("PATCH", "shifts/" + s.id, { end: "14:00" }, ADMIN);
  await addShift({ site: "cafe", day: W, start: "11:00", end: "18:00", job: "closes" });
  const mgr = await rota("GET", "week?start=" + W, undefined, ADMIN);
  assert.equal(mgr.body.changesSincePublish, 2);
  assert.equal((await rota("GET", "week?start=" + W, undefined, ALEX)).body.shifts.length, 2, "staff see live shifts of a published week");
  await rota("POST", "week/publish", { week: W }, ADMIN);
  assert.equal((await rota("GET", "week?start=" + W, undefined, ADMIN)).body.changesSincePublish, 0);
});

test("copy last week: closed days skipped, and it won't overwrite without replace", async () => {
  const A = "2030-04-01", B = "2030-04-08";
  await addShift({ site: "cafe", day: A, start: "07:00", end: "15:00", userId: ids.Alex });
  await addShift({ site: "asg", day: "2030-04-07", start: "08:00", end: "12:00", userId: ids.Sam }); // a Sunday
  // The Cafe's Monday the next week is a planned closure.
  await req("POST", "/api/db/set", { path: "sites/cafe/days/2030-04-08", data: { date: "2030-04-08", closed: { reason: "Easter Monday", by: "x", at: 1 } } });
  const r = await rota("POST", "week/copy", { from: A, to: B }, ADMIN);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.copied, 1);
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /Easter Monday/);
  const again = await rota("POST", "week/copy", { from: A, to: B }, ADMIN);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "conflict");
  assert.equal((await rota("POST", "week/copy", { from: A, to: B, replace: true }, ADMIN)).body.replaced, 1);
});

test("claims and covers: employees request for themselves; admins handle cross-person decisions", async () => {
  // Two weeks from now: open shifts are listed for the next six weeks.
  const t = new Date(); t.setUTCDate(t.getUTCDate() + 14 - ((t.getUTCDay() + 6) % 7));
  const W = t.toISOString().slice(0, 10);
  const open = (await addShift({ site: "cafe", day: W, start: "11:00", end: "18:00", job: "closes" })).shift;
  const unpublished = await rota("POST", "requests", { kind: "claim", shiftId: open.id }, ALEX);
  assert.equal(unpublished.status, 400, "cannot claim from an unpublished week");
  await rota("POST", "week/publish", { week: W }, ADMIN);
  const offered = (await rota("GET", "open", undefined, ALEX)).body.shifts.map((s) => s.id);
  assert.ok(offered.includes(open.id), "Alex sees the unassigned opportunity");
  const claim = await rota("POST", "requests", { kind: "claim", shiftId: open.id }, ALEX);
  assert.equal(claim.status, 200, claim.text);
  assert.equal((await rota("POST", "requests", { kind: "claim", shiftId: open.id }, SAM)).body.code, "conflict", "a second claim is refused");
  for (const cookie of [ALEX, MGR]) assert.equal((await rota("PATCH", "requests/" + claim.body.request.id, { action: "approve" }, cookie)).status, 403);
  const ok = await rota("PATCH", "requests/" + claim.body.request.id, { action: "approve" }, ADMIN);
  assert.equal(ok.body.request.status, "approved");
  assert.equal((await rota("GET", "week?start=" + W, undefined, ADMIN)).body.shifts.find((s) => s.id === open.id).userId, ids.Alex);
  assert.equal((await rota("POST", "requests", { kind: "claim", shiftId: open.id }, SAM)).status, 403, "an assigned colleague shift is private before conflict checks");

  assert.equal((await rota("POST", "requests", { kind: "cover", shiftId: open.id, toUserId: ids.Priya, message: "Wedding" }, ALEX)).status, 403, "employees cannot target another employee");
  const cancelled = await rota("POST", "requests", { kind: "cover", shiftId: open.id, message: "Own cover request" }, ALEX);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal((await rota("PATCH", "requests/" + cancelled.body.request.id, { action: "cancel" }, ALEX)).body.request.status, "cancelled");
  const cover = await rota("POST", "requests", { kind: "cover", shiftId: open.id }, ALEX);
  assert.equal(cover.status, 200, cover.text);
  assert.equal(cover.body.request.toUser, null);
  for (const cookie of [SAM, MGR]) {
    assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "accept" }, cookie)).status, 403, "cross-person acceptance requires an admin");
    assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "decline" }, cookie)).status, 403);
  }
  assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "approve" }, ADMIN)).body.code, "conflict", "not accepted yet");
  assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "accept" }, ADMIN)).body.request.status, "accepted");
  assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "approve" }, ADMIN)).body.request.status, "approved");
  assert.equal((await rota("GET", "week?start=" + W, undefined, ADMIN)).body.shifts.find((s) => s.id === open.id).userId, ids.Will);

  // An employee can claim an unassigned shift; approval still checks their own clashes.
  const second = (await addShift({ site: "cafe", day: W, start: "09:00", end: "13:00" })).shift;
  const samClaim = await rota("POST", "requests", { kind: "claim", shiftId: second.id }, SAM);
  assert.equal(samClaim.status, 200, samClaim.text);
  await addShift({ site: "asg", day: W, start: "12:00", end: "16:00", userId: ids.Sam });
  const refused = await rota("PATCH", "requests/" + samClaim.body.request.id, { action: "approve" }, ADMIN);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "conflict");
  assert.equal((await rota("PATCH", "requests/" + samClaim.body.request.id, { action: "cancel" }, SAM)).body.request.status, "cancelled");
  assert.equal((await rota("POST", "requests", { kind: "cover", shiftId: open.id }, SAM)).status, 403, "only your own shifts");
});
async function signInAgain(username) {
  const r = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: username + "-own-pass" }) });
  assert.equal(r.status, 200);
  return cookieOf(r);
}

test("suggestions: clashing and on-leave people can't be picked; best fit first; overtime flagged; no training check", async () => {
  const W = "2030-06-03";
  await rota("PUT", "people/" + ids.Alex, { contractHours: 40 }, ADMIN);
  await rota("PUT", "people/" + ids.Sam, { contractHours: 4 }, ADMIN);
  await rota("PUT", "people/" + ids.Priya, { contractHours: 30 }, ADMIN);
  await addShift({ site: "asg", day: W, start: "08:00", end: "12:00", userId: ids.Alex });
  await rota("POST", "time-off", { userId: ids.George, from: W, to: W, reason: "Holiday" }, ADMIN);
  const s = (await addShift({ site: "cafe", day: W, start: "09:00", end: "15:00", job: "closes" })).shift;
  const r = await rota("GET", "suggest?shift=" + s.id, undefined, ADMIN);
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.body.candidates.map((c) => [c.name.split(" ")[0], c]));
  assert.equal(by.Alex.selectable, false, "Alex clashes");
  assert.ok(by.Alex.flags.some((f) => f.kind === "clash"));
  assert.equal(by.George.selectable, false, "George is on time off");
  assert.ok(by.Sam.flags.some((f) => f.kind === "overtime"));
  assert.equal(by.Sam.overtimeIfGiven, 1.5);
  assert.ok(r.body.candidates.every((c) => c.flags.every((f) => f.kind !== "untrained")), "everyone is trained on opening and closing");
  assert.equal(r.body.candidates[0].best, true);
  assert.equal(r.body.candidates[0].selectable, true);
  assert.equal(r.body.candidates.filter((c) => c.best).length, 1);
  const lastSelectable = r.body.candidates.map((c) => c.selectable).lastIndexOf(true);
  assert.ok(r.body.candidates.slice(lastSelectable + 1).every((c) => !c.selectable), "people who can't take it come last");
});

test("hours and the CSV", async () => {
  const W = "2030-07-01";
  await rota("PUT", "people/" + ids.Alex, { contractHours: 10 }, ADMIN);
  await addShift({ site: "cafe", day: W, start: "07:00", end: "15:00", userId: ids.Alex, breakMins: 30 }); // 7.5h
  await addShift({ site: "asg", day: "2030-07-02", start: "09:00", end: "13:00", userId: ids.Alex, breakMins: 0 }); // 4h
  await addShift({ site: "asg", day: "2030-07-02", start: "13:00", end: "17:00", breakMins: 0 }); // open: not counted
  const r = await rota("GET", "hours?start=" + W, undefined, ADMIN);
  const alex = r.body.people.find((p) => p.name === "Alex Brown");
  assert.equal(alex.rotaHours, 11.5);
  assert.equal(alex.overtime, 1.5);
  assert.equal(alex.contractMin, 10);
  assert.equal(alex.contractMax, 10);
  assert.deepEqual(alex.sites, { roastery: 0, cafe: 7.5, asg: 4, factory: 0 });
  assert.equal(r.body.siteTotals.asg, 4);
  assert.equal(r.body.openHours, 4);
  const csv = await rota("GET", `hours?start=${W}&format=csv`, undefined, ADMIN);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split(/\r\n/);
  assert.equal(lines[0], "name,role,contract_min,contract_max,planned_hours,rota_hours,overtime,short_of_min,roastery,cafe,asg,factory");
  assert.ok(lines.includes("Alex Brown,staff,10,10,11.5,11.5,1.5,0,0,7.5,4,0"), csv.text);
});

test("opening hours by day: Sundays and Saturdays can differ, and cover is checked against them", async () => {
  const W = "2030-09-02"; // Monday
  const d = (i) => { const x = new Date(W + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + i); return x.toISOString().slice(0, 10); };
  const put = await rota("PUT", "sites/asg", { opensAt: "07:00", closesAt: "18:00", minPeople: 1, dayHours: { sat: { opensAt: "08:00", closesAt: "16:00" }, sun: { opensAt: "09:00", closesAt: "15:00" } } }, MGR);
  assert.equal(put.status, 200, put.text);
  assert.equal((await rota("PUT", "sites/asg", { opensAt: "07:00", closesAt: "18:00", dayHours: { sun: { opensAt: "15:00", closesAt: "09:00" } } }, MGR)).status, 400);
  assert.equal((await rota("PUT", "sites/asg", { opensAt: "07:00", closesAt: "18:00", dayHours: { someday: { opensAt: "09:00", closesAt: "15:00" } } }, MGR)).status, 400);
  assert.equal((await rota("PUT", "sites/asg", { opensAt: "07:00", closesAt: "18:00", minPeople: 1 }, ALEX)).status, 403);
  // Saving without dayHours keeps them.
  await rota("PUT", "sites/asg", { opensAt: "07:00", closesAt: "18:00", minPeople: 1 }, MGR);
  const sites = (await rota("GET", "sites", undefined, MGR)).body.sites;
  assert.deepEqual(sites.find((x) => x.id === "asg").dayHours, { sat: { opensAt: "08:00", closesAt: "16:00" }, sun: { opensAt: "09:00", closesAt: "15:00" } });
  await addShift({ site: "asg", day: d(5), start: "09:00", end: "16:00", userId: ids.Sam, job: "opens" }); // Saturday, an hour late
  const r = await addShift({ site: "asg", day: d(6), start: "09:00", end: "15:00", userId: ids.Sam, job: "opens" }); // Sunday, covered
  const short = r.problems.filter((p) => p.kind === "short_cover" && p.site === "asg").map((p) => p.message);
  assert.ok(short.includes("ASG has fewer than 1 person on Saturday 08:00–09:00"), short.join(" | "));
  assert.ok(!short.some((m) => /Sunday/.test(m)), "Sunday is covered for its own hours: " + short.join(" | "));
  const w = await rota("GET", "week?start=" + W, undefined, ADMIN);
  const asg = w.body.sites.find((x) => x.id === "asg");
  assert.deepEqual(asg.hours[0], { opensAt: "07:00", closesAt: "18:00" });
  assert.deepEqual(asg.hours[5], { opensAt: "08:00", closesAt: "16:00" });
  assert.deepEqual(asg.hours[6], { opensAt: "09:00", closesAt: "15:00" });
  // Back to the same hours every day for the other tests.
  await rota("PUT", "sites/asg", { opensAt: "08:00", closesAt: "12:00", minPeople: 2, dayHours: null }, MGR);
  assert.deepEqual((await rota("GET", "sites", undefined, MGR)).body.sites.find((x) => x.id === "asg").dayHours, {});
});

test("contracted hours as a range: overtime over the maximum, marked shift by shift", async () => {
  const W = "2030-10-07"; // Monday
  const d = (i) => { const x = new Date(W + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + i); return x.toISOString().slice(0, 10); };
  assert.equal((await rota("PUT", "people/" + ids.Priya, { contractMin: 30, contractMax: 20 }, ADMIN)).body.code, "invalid_argument");
  let p = await rota("PUT", "people/" + ids.Priya, { contractMin: 8, contractMax: 12 }, ADMIN);
  assert.deepEqual([p.body.contractMin, p.body.contractMax, p.body.contractHours], [8, 12, 12]);
  p = await rota("PUT", "people/" + ids.Priya, { sites: [] }, ADMIN);
  assert.deepEqual([p.body.contractMin, p.body.contractMax], [8, 12], "left out, the contract is kept");
  await addShift({ site: "asg", day: d(0), start: "08:00", end: "16:00", userId: ids.Priya, job: "opens", breakMins: 30 }); // 7.5h
  await addShift({ site: "asg", day: d(1), start: "08:00", end: "16:00", userId: ids.Priya, job: "opens", breakMins: 30 }); // 7.5h: 3h over 12
  await addShift({ site: "asg", day: d(2), start: "08:00", end: "12:00", userId: ids.Priya, job: "opens", breakMins: 0 }); // 4h: all overtime
  const w = await rota("GET", "week?start=" + W, undefined, ADMIN);
  const mine = w.body.shifts.filter((s) => s.userId === ids.Priya).sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual(mine.map((s) => s.overtime), [0, 3, 4]);
  const ot = w.body.problems.find((x) => x.kind === "overtime" && x.userId === ids.Priya);
  assert.match(ot.message, /Priya has 7h overtime \(19h, contract 8–12h\)/);
  const person = w.body.people.find((x) => x.id === ids.Priya);
  assert.deepEqual([person.contractMin, person.contractMax], [8, 12]);
  const h = (await rota("GET", "hours?start=" + W, undefined, ADMIN)).body.people.find((x) => x.userId === ids.Priya);
  assert.deepEqual([h.rotaHours, h.overtime, h.shortOfMin], [19, 7, 0]);
  // Priya sees her own overtime once the week is published, in the week and in My shifts.
  await rota("POST", "week/publish", { week: W }, ADMIN);
  const priya = await signInAgain("priya");
  const m = (await rota("GET", `mine?from=${d(1)}&to=${d(6)}`, undefined, priya)).body;
  assert.deepEqual(m.shifts.map((s) => s.overtime), [3, 4], "counted from the Monday, though the list starts Tuesday");
  assert.deepEqual(m.weeks, [{ week: W, hours: 19, overtime: 7 }]);
  assert.deepEqual([m.contractMin, m.contractMax], [8, 12]);
  // Other employees cannot see her assigned shifts or hours.
  const sam = await signInAgain("sam");
  assert.ok(!(await rota("GET", "week?start=" + W, undefined, sam)).body.shifts.some((s) => s.userId === ids.Priya));
  // The older single figure still sets both ends.
  p = await rota("PUT", "people/" + ids.Priya, { contractHours: 30 }, ADMIN);
  assert.deepEqual([p.body.contractMin, p.body.contractMax], [30, 30]);
});

test("amending a shift on the day: start and finish as worked, with a reason; the plan is kept", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const tomorrow = (() => { const x = new Date(today + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
  await rota("PUT", "sites/asg", { opensAt: "08:00", closesAt: "16:00", minPeople: 1, dayHours: null }, MGR);
  await rota("PUT", "people/" + ids.Alex, { contractMin: 0, contractMax: 40 }, ADMIN);
  for (const s of (await rota("GET", "week?start=" + today, undefined, ADMIN)).body.shifts.filter((s) => s.site === "asg" && s.day === today)) await rota("DELETE", "shifts/" + s.id, undefined, ADMIN);
  const s = (await addShift({ site: "asg", day: today, start: "08:00", end: "16:00", userId: ids.Alex, job: "opens", breakMins: 30 })).shift;
  assert.equal(s.hours, 7.5);
  assert.equal(s.adjusted, false);

  assert.equal((await rota("PUT", `shifts/${s.id}/actual`, { start: "08:00", end: "11:00" }, ALEX)).status, 403, "staff can't amend hours");
  assert.equal((await rota("PUT", `shifts/${s.id}/actual`, { start: "11:00", end: "08:00" }, ADMIN)).status, 400);
  const later = (await addShift({ site: "asg", day: tomorrow, start: "08:00", end: "16:00", userId: ids.Alex })).shift;
  assert.equal((await rota("PUT", `shifts/${later.id}/actual`, { start: "08:00", end: "11:00" }, ADMIN)).status, 400, "not before the day");
  await rota("DELETE", "shifts/" + later.id, undefined, ADMIN);

  const r = await rota("PUT", `shifts/${s.id}/actual?with=problems`, { start: "08:00", end: "11:00", breakMins: 0, note: "Went home sick" }, ADMIN);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.shift.start, r.body.shift.end, r.body.shift.actualStart, r.body.shift.actualEnd], ["08:00", "16:00", "08:00", "11:00"]);
  assert.deepEqual([r.body.shift.hours, r.body.shift.plannedHours, r.body.shift.adjustNote], [3, 7.5, "Went home sick"]);
  assert.ok(r.body.problems.some((p) => p.kind === "short_cover" && p.site === "asg" && p.day === today && /11:00–16:00/.test(p.message)), "cover counts who's actually there");
  // The break defaults to the planned one, cut to fit.
  const r2 = await rota("PUT", `shifts/${s.id}/actual`, { start: "08:00", end: "17:30" }, ADMIN);
  assert.deepEqual([r2.body.shift.actualBreakMins, r2.body.shift.hours], [30, 9]);
  const h = (await rota("GET", "hours?start=" + today, undefined, ADMIN)).body.people.find((x) => x.userId === ids.Alex);
  assert.ok(h.amended >= 1);
  assert.equal(r2 && h.rotaHours - h.plannedHours, 1.5);
  // Other employees cannot see either the shift or its actual hours/reason.
  await rota("PUT", `shifts/${s.id}/actual`, { start: "08:00", end: "11:00", breakMins: 0, note: "Went home sick" }, ADMIN);
  await rota("POST", "week/publish", { week: today }, ADMIN);
  const sam = await signInAgain("sam");
  const seen = (await rota("GET", "week?start=" + today, undefined, sam)).body.shifts.find((x) => x.id === s.id);
  assert.equal(seen, undefined);
  assert.equal((await rota("GET", "week?start=" + today, undefined, ALEX)).body.shifts.find((x) => x.id === s.id).adjustNote, "Went home sick");
  const td = (await rota("GET", `today?site=asg&day=${today}`, undefined, sam)).body.shifts.find((x) => x.name === "Alex Brown");
  assert.equal(td, undefined);
  // Back to the plan.
  const back = await rota("PUT", `shifts/${s.id}/actual`, { clear: true }, ADMIN);
  assert.deepEqual([back.body.shift.adjusted, back.body.shift.hours, back.body.shift.actualEnd], [false, 7.5, null]);
  await rota("DELETE", "shifts/" + s.id, undefined, ADMIN);
});

test("rest after amended hours uses the actual finishing shift and keeps the employee's week readable", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const yesterday = (() => { const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const employee = await signUp("Rest Worker", "rest.worker", "staff");
  const identity = await (await fetch(srv.base + "/api/auth/me", { headers: { cookie: employee } })).json();
  const uid = identity.user.id;
  const late = (await addShift({ site: "asg", day: yesterday, start: "08:00", end: "16:00", userId: uid, breakMins: 0 })).shift;
  const early = (await addShift({ site: "asg", day: today, start: "03:00", end: "07:00", userId: uid, breakMins: 0 })).shift;
  const amended = await rota("PUT", "shifts/" + late.id + "/actual", { start: "08:00", end: "18:00", breakMins: 0, note: "Late finish" }, ADMIN);
  assert.equal(amended.status, 200, amended.text);
  const adminWeek = await rota("GET", "week?start=" + today, undefined, ADMIN);
  assert.equal(adminWeek.status, 200, adminWeek.text);
  const warning = adminWeek.body.problems.find((p) => p.kind === "rest" && p.userId === uid);
  assert.ok(warning, "actual 18:00 finish to 03:00 start produces a rest warning");
  assert.deepEqual(warning.shiftIds, [late.id, early.id]);
  assert.match(warning.message, /9h between shifts .*18:00/);
  assert.equal((await rota("POST", "week/publish", { week: today }, ADMIN)).status, 200);
  const ownWeek = await rota("GET", "week?start=" + today, undefined, employee);
  assert.equal(ownWeek.status, 200, ownWeek.text);
  assert.ok(ownWeek.body.problems.some((p) => p.kind === "rest" && p.userId === uid));
  assert.ok(ownWeek.body.shifts.some((s) => s.id === early.id));
  for (const s of [late, early]) assert.equal((await rota("DELETE", "shifts/" + s.id, undefined, ADMIN)).status, 200);
});

test("availability and contracts are administered only by admins; employees retain their own details", async () => {
  const pat = { pattern: { mon: "off", wed: { to: "15:00" } }, sites: ["cafe", "asg"] };
  const staff = await rota("PUT", "me/availability", pat, ALEX);
  assert.equal(staff.status, 403, "staff can't change their own days or sites");
  assert.equal(staff.body.code, "permission_denied");
  assert.equal((await rota("PUT", "me/availability", pat, MGR)).status, 403, "nor can managers");
  assert.equal((await rota("PUT", "people/" + ids.Alex, pat, MGR)).status, 403, "managers can't set anyone's days or sites");
  assert.equal((await rota("PUT", "people/" + ids.Alex, { sites: [] }, MGR)).status, 403);
  assert.equal((await rota("PUT", "people/" + ids.Alex, { contractMin: 10, contractMax: 20 }, MGR)).status, 403, "managers cannot set another employee's contract");
  assert.equal((await rota("PUT", "people/" + ids.Alex, { contractMin: 10, contractMax: 20 }, ADMIN)).status, 200);
  assert.equal((await rota("PUT", "people/" + ids.Sam, { contractHours: 20, pattern: {} }, ALEX)).status, 403);
  const r = await rota("PUT", "people/" + ids.Alex, pat, ADMIN);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.contractMin, r.body.contractMax], [10, 20], "the contract is kept");
  const me = await rota("GET", "me", undefined, ALEX);
  assert.deepEqual(me.body.pattern, { mon: "off", wed: { to: "15:00" } });
  assert.deepEqual(me.body.sites, ["cafe", "asg"]);
  assert.equal(me.body.user.admin, false);
  assert.equal((await rota("PUT", "me/availability", { pattern: { tue: "off" }, sites: [] }, ADMIN)).status, 200, "admins set their own");
  assert.equal((await rota("PUT", "people/" + ids.Alex, { pattern: { mon: { from: "15:00", to: "09:00" } } }, ADMIN)).body.code, "invalid_argument");
  // Time off: asked for yourself, approved by an admin, cancelled by you.
  const t = await rota("POST", "time-off", { from: "2030-08-01", to: "2030-08-03", reason: "Holiday" }, ALEX);
  assert.equal(t.body.status, "requested");
  assert.equal((await rota("POST", "time-off", { userId: ids.Sam, from: "2030-08-01", to: "2030-08-01" }, ALEX)).status, 403);
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "approved" }, ALEX)).status, 403);
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "approved" }, ADMIN)).body.status, "approved");
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "cancelled" }, ALEX)).body.status, "cancelled");
  // Shifts outside someone's pattern are noted.
  const s = await addShift({ site: "cafe", day: "2030-09-02", start: "09:00", end: "12:00", userId: ids.Alex }); // a Monday
  assert.ok(s.problems.some((p) => p.kind === "availability" && p.userId === ids.Alex));
});

test("privacy: staff and managers receive only their own personal rota data across week, mine, today and me", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const own = new Map();
  const cases = [
    { cookie: ALEX, id: ids.Alex, label: "ALEX", contract: [17, 19], start: "08:00", end: "11:00" },
    { cookie: MGR, id: ids.George, label: "GEORGE", contract: [23, 27], start: "12:00", end: "15:00" },
    { cookie: SAM, id: ids.Sam, label: "SAM", contract: [31, 37], start: "16:00", end: "19:00" },
  ];
  for (const p of cases) {
    assert.equal((await rota("PUT", "people/" + p.id, { contractMin: p.contract[0], contractMax: p.contract[1], sites: ["asg"], pattern: {} }, ADMIN)).status, 200);
    const s = (await addShift({ site: "asg", day: today, start: p.start, end: p.end, breakMins: 0, userId: p.id, note: p.label + "_PRIVATE_SHIFT" })).shift;
    assert.equal((await rota("PUT", "shifts/" + s.id + "/actual", { start: p.start, end: p.end, breakMins: 0, note: p.label + "_PRIVATE_ACTUAL" }, ADMIN)).status, 200);
    const off = await rota("POST", "time-off", { userId: p.id, from: today, to: today, reason: p.label + "_PRIVATE_LEAVE" }, ADMIN);
    assert.equal(off.status, 200, off.text);
    own.set(p.id, s.id);
  }
  const open = (await addShift({ site: "asg", day: today, start: "20:00", end: "21:00", breakMins: 0, note: "FORMER_PRIVATE_OPEN_NOTE" })).shift;
  await rota("POST", "week/publish", { week: today }, ADMIN);
  const adminWeek = await rota("GET", "week?start=" + today, undefined, ADMIN);
  for (const p of cases) assert.match(adminWeek.text, new RegExp(p.label + "_PRIVATE_ACTUAL"), "admin retains all private records");

  for (const p of cases.slice(0, 2)) {
    const week = await rota("GET", "week?start=" + today + "&userId=" + ids.Sam, undefined, p.cookie);
    assert.equal(week.status, 200, week.text);
    assert.deepEqual(week.body.people.map((x) => x.id), [p.id]);
    assert.deepEqual([week.body.people[0].contractMin, week.body.people[0].contractMax], p.contract);
    assert.ok(week.body.shifts.every((x) => x.userId === p.id || x.userId === null));
    assert.equal(week.body.shifts.find((x) => x.id === own.get(p.id)).adjustNote, p.label + "_PRIVATE_ACTUAL");
    assert.equal(week.body.shifts.find((x) => x.id === open.id).note, "", "unassigned opportunities never publish former private notes");
    assert.ok(week.body.timeOff.every((x) => x.userId === p.id));
    assert.ok(week.body.timeOff.some((x) => x.reason === p.label + "_PRIVATE_LEAVE"));
    assert.ok(week.body.problems.every((x) => x.userId === p.id && x.shiftIds.every((id) => week.body.shifts.some((s) => s.id === id && s.userId === p.id))));
    const mine = await rota("GET", "mine?from=" + today + "&to=" + today + "&userId=" + ids.Sam, undefined, p.cookie);
    assert.ok(mine.body.shifts.every((x) => x.userId === p.id && x.others.length === 0));
    assert.ok(mine.body.shifts.some((x) => x.id === own.get(p.id) && x.adjustNote === p.label + "_PRIVATE_ACTUAL"));
    const current = await rota("GET", "today?site=asg&day=" + today, undefined, p.cookie);
    assert.ok(current.body.shifts.every((x) => x.me || x.open));
    assert.ok(current.body.shifts.some((x) => x.me && x.actualStart === p.start));
    const me = await rota("GET", "me", undefined, p.cookie);
    assert.deepEqual([me.body.contractMin, me.body.contractMax], p.contract);
    assert.ok(me.body.timeOff.some((x) => x.reason === p.label + "_PRIVATE_LEAVE"));
    assert.equal(me.body.user.manager, false);
    assert.equal(me.body.user.admin, false);
    assert.equal(me.body.user.siteManager, p.cookie === MGR);
    const received = JSON.stringify([week.body, mine.body, current.body, me.body]);
    for (const other of cases.filter((x) => x.id !== p.id)) {
      assert.ok(!received.includes(other.id), "another employee ID is not returned alongside private rota data");
      for (const suffix of ["_PRIVATE_SHIFT", "_PRIVATE_ACTUAL", "_PRIVATE_LEAVE"]) assert.ok(!received.includes(other.label + suffix));
    }
    assert.ok(!received.includes("FORMER_PRIVATE_OPEN_NOTE"));
  }
});

test("privacy: requests retain own state without colleague identities, messages or reassigned snapshots", async () => {
  const W = "2031-02-03";
  const adminShift = (await addShift({ site: "asg", day: W, start: "08:00", end: "10:00", userId: ids.Will, note: "ADMIN_PRIVATE_SHIFT_SNAPSHOT" })).shift;
  const alexShift = (await addShift({ site: "asg", day: W, start: "11:00", end: "13:00", userId: ids.Alex, note: "ALEX_PRIVATE_COVER_SHIFT" })).shift;
  await rota("POST", "week/publish", { week: W }, ADMIN);
  const targeted = await rota("POST", "requests", { kind: "cover", shiftId: adminShift.id, toUserId: ids.Alex, message: "ADMIN_PRIVATE_REQUEST_MESSAGE" }, ADMIN);
  assert.equal(targeted.status, 200, targeted.text);
  assert.equal(targeted.body.request.shift.note, "ADMIN_PRIVATE_SHIFT_SNAPSHOT");
  const targetId = targeted.body.request.id;
  for (const route of ["requests", "me"]) {
    const r = await rota("GET", route, undefined, ALEX);
    const recipient = r.body.requests.find((x) => x.id === targetId);
    assert.ok(recipient, "the recipient can follow their own request state");
    assert.equal(recipient.shift, null);
    assert.equal(recipient.message, "");
    assert.deepEqual([recipient.fromUser, recipient.fromName, recipient.toUser, recipient.toName, recipient.taker, recipient.takerName, recipient.decidedByName], [null, null, ids.Alex, "Alex Brown", null, null, null]);
    assert.ok(!r.text.includes("ADMIN_PRIVATE_"));
    for (const cookie of [SAM, MGR]) assert.ok(!(await rota("GET", route, undefined, cookie)).body.requests.some((x) => x.id === targetId));
  }
  for (const action of ["accept", "decline", "cancel", "approve"]) assert.equal((await rota("PATCH", "requests/" + targetId, { action }, ALEX)).status, 403);
  const ownCover = await rota("POST", "requests", { kind: "cover", shiftId: alexShift.id, message: "ALEX_OWN_REQUEST_MESSAGE" }, ALEX);
  assert.equal(ownCover.status, 200, ownCover.text);
  assert.equal(ownCover.body.request.shift.note, "ALEX_PRIVATE_COVER_SHIFT");
  assert.equal(ownCover.body.request.message, "ALEX_OWN_REQUEST_MESSAGE");
  for (const cookie of [SAM, MGR]) {
    assert.ok(!(await rota("GET", "requests", undefined, cookie)).body.requests.some((x) => x.id === ownCover.body.request.id), "general cover requests do not expose assigned colleague shifts");
    assert.equal((await rota("PATCH", "requests/" + ownCover.body.request.id, { action: "cancel" }, cookie)).status, 403);
  }
  assert.equal((await rota("PATCH", "requests/" + ownCover.body.request.id, { action: "accept" }, ADMIN)).status, 200);
  const approved = await rota("PATCH", "requests/" + ownCover.body.request.id, { action: "approve" }, ADMIN);
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.request.shift.note, "", "private notes do not transfer to a new assignee");
  const history = (await rota("GET", "me", undefined, ALEX)).body.requests.find((x) => x.id === ownCover.body.request.id);
  assert.equal(history.status, "approved");
  assert.equal(history.message, "ALEX_OWN_REQUEST_MESSAGE");
  assert.equal(history.shift, null);
  assert.deepEqual([history.taker, history.takerName, history.decidedByName], [null, null, null]);
  // Permission precedes the settled-state error for a guessed unrelated request ID.
  assert.equal((await rota("PATCH", "requests/" + ownCover.body.request.id, { action: "cancel" }, SAM)).status, 403);
});

test("privacy: direct IDs and stale writes cannot reveal private records; reassignment clears predecessor details", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const s = (await addShift({ site: "asg", day: today, start: "22:00", end: "23:00", breakMins: 0, userId: ids.Sam, note: "SAM_TRANSFER_PRIVATE_NOTE" })).shift;
  const amended = await rota("PUT", "shifts/" + s.id + "/actual", { start: "22:00", end: "22:30", breakMins: 0, note: "SAM_TRANSFER_PRIVATE_ACTUAL" }, ADMIN);
  assert.equal(amended.status, 200, amended.text);
  const ownOff = await rota("POST", "time-off", { from: "2032-03-01", to: "2032-03-02", reason: "SAM_DIRECT_PRIVATE_LEAVE" }, SAM);
  assert.equal(ownOff.status, 200, ownOff.text);
  for (const cookie of [ALEX, MGR]) {
    const denied = [
      await rota("PUT", "people/" + ids.Sam, {}, cookie),
      await rota("PATCH", "shifts/" + s.id + "?with=problems", { ifUpdatedAt: -1, day: "2032-03-01" }, cookie),
      await rota("DELETE", "shifts/" + s.id + "?with=problems", undefined, cookie),
      await rota("PUT", "shifts/" + s.id + "/actual?with=problems", { clear: true }, cookie),
      await rota("POST", "time-off", { userId: ids.Sam, from: "invalid", to: "invalid" }, cookie),
      await rota("PATCH", "time-off/" + ownOff.body.id, { status: "approved" }, cookie),
      await rota("PATCH", "time-off/" + ownOff.body.id, { status: "cancelled" }, cookie),
      await rota("POST", "requests", { kind: "claim", shiftId: s.id }, cookie),
    ];
    for (const r of denied) {
      assert.equal(r.status, 403, r.text);
      assert.ok(!/SAM_TRANSFER_PRIVATE|SAM_DIRECT_PRIVATE|contractMin|actualStart|shiftIds|fromWeek/.test(r.text));
      assert.equal(r.body.details?.shift, undefined);
    }
  }
  const adminConflict = await rota("PATCH", "shifts/" + s.id, { ifUpdatedAt: -1 }, ADMIN);
  assert.equal(adminConflict.status, 409);
  assert.match(adminConflict.text, /SAM_TRANSFER_PRIVATE_ACTUAL/, "admin conflict details remain usable");
  const reassigned = await rota("PATCH", "shifts/" + s.id + "?with=problems", { userId: ids.George }, ADMIN);
  assert.equal(reassigned.status, 200, reassigned.text);
  assert.deepEqual([reassigned.body.shift.note, reassigned.body.shift.actualStart, reassigned.body.shift.actualEnd, reassigned.body.shift.actualBreakMins, reassigned.body.shift.adjustNote, reassigned.body.shift.adjustedBy, reassigned.body.shift.adjustedAt], ["", null, null, null, "", null, null]);
  await rota("POST", "week/publish", { week: today }, ADMIN);
  const newOwner = await rota("GET", "week?start=" + today, undefined, MGR);
  assert.ok(newOwner.body.shifts.some((x) => x.id === s.id));
  assert.ok(!newOwner.text.includes("SAM_TRANSFER_PRIVATE"));
  assert.ok(newOwner.body.problems.every((x) => x.userId === ids.George));
});

test("backups include the rota's tables", async () => {
  const made = await req("POST", "/api/admin/backups");
  assert.equal(made.status, 200, made.text);
  const dl = await fetch(`${srv.base}/api/admin/backups/${made.body.backup.id}`, { headers: { cookie: ADMIN } });
  const buf = Buffer.from(await dl.arrayBuffer());
  const zlib = await import("node:zlib");
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString();
  const b = JSON.parse(text);
  assert.ok(b.rota.rota_shifts.length > 0);
  assert.ok(Array.isArray(b.rota.rota_requests));
  assert.ok(!/pin_hash|pin_salt|quick_hash/.test(text), "no password or PIN hashes");
});

// The rota's own hostname, end to end: a second server whose ROTA_HOST is the hostname the Worker sees under
// `wrangler dev` (it rewrites requests to the first route's hostname, see wrangler.jsonc).
test("the rota host: / is the rota, diary pages go there, diary APIs are refused", async () => {
  const host = await startServer({ vars: { ROTA_HOST: "staffstrangerscoffee.com" } });
  try {
    const get = (p, cookie) => fetch(host.base + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
    assert.equal((await get("/")).headers.get("location"), "/signin", "signed out: sign in on the rota host");
    assert.equal((await get("/rota/rota.js")).status, 200, "the rota's code loads signed out (no data in it)");
    assert.equal((await get("/shared/core.js")).status, 200, "and the helpers it shares with the diary");
    assert.equal((await get("/diary/core.js")).status, 302, "but not the diary's, on the rota's address");
    assert.equal((await get("/signin")).status, 200);
    const r = await fetch(host.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Host Admin", username: "host", password: "admin-pass-1", code: SETUP_CODE }) });
    const c = cookieOf(r);
    const home = await get("/", c);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /rota\.js/, "/ serves the rota app");
    assert.equal((await get("/rota/", c)).headers.get("location"), "/");
    for (const p of ["/admin", "/index.html", "/diary/core.js", "/diary/start.js", "/claude-shim.js"]) assert.equal((await get(p, c)).headers.get("location"), "/", p + " goes to the rota");
    for (const p of ["/theme.css", "/ui.css", "/rota/rota.js", "/rota/rota.css", "/pinpad.js", "/shared/core.js"]) assert.equal((await get(p, c)).status, 200, p);
    assert.match(await (await get("/", c)).text(), /<script src="\/shared\/core.js\?v=\w+"><\/script>\n<script src="\/pinpad.js\?v=\w+"><\/script>\n<script src="\/rota\/rota.js\?v=\w+"><\/script>/, "the shared helpers load before the rota's script");
    const db = await fetch(host.base + "/api/db/get", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify({ path: "days/x" }) });
    assert.equal(db.status, 404, "the diary's data API isn't on the rota host");
    assert.equal((await get("/api/rota/links", c).then((x) => x.json())).rota, "/");
    assert.equal((await get("/api/rota/week", c)).status, 200);
    assert.equal((await get("/robots.txt")).status, 200);
    assert.equal((await get("/", c)).headers.get("x-robots-tag"), "noindex, nofollow");
  } finally { await host.stop(); }
});

// One sign-in for the diary and the rota: with COOKIE_DOMAIN (wrangler.jsonc), sign-in cookies are
// shared across the domain. Identity reads never issue cookies. Under `wrangler dev` the Worker sees the
// diary's hostname, which is on that domain, and rewrites the Domain in Set-Cookie to the address the client used.
test("shared sign-in: login sets COOKIE_DOMAIN, identity reads are side-effect-free, sign out clears both", async () => {
  const host = await startServer();
  const D = "Domain=(?:staffstrangerscoffee\\.com|127\\.0\\.0\\.1)";
  try {
    const setCookies = (res) => res.headers.getSetCookie();
    const post = (p, body, cookie) => fetch(host.base + p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const r = await post("/api/auth/setup", { name: "Shared Admin", username: "shared", password: "admin-pass-1", code: SETUP_CODE });
    assert.equal(r.status, 200);
    const sc = setCookies(r);
    // For each cookie: first the host-only copy is removed, then the shared one is set (the order matters).
    for (const name of ["sfbb_session", "sfbb_device"]) {
      const mine = sc.filter((c) => c.startsWith(name + "="));
      assert.equal(mine.length, 2, name);
      assert.match(mine[0], /^[a-z_]+=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/, name + ": host-only copy removed first");
      assert.match(mine[1], new RegExp(`^[a-z_]+=[\\w-]+\\.[\\w-]+; Path=/; ${D}; HttpOnly; Secure; SameSite=Lax; Max-Age=\\d+$`), name + ": then shared");
    }
    const session = sc.find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
    const device = sc.find((c) => /^sfbb_device=[\w-]/.test(c)).split(";")[0];

    // A delayed identity read must not restore an old cookie after another person signs in.
    const me = await fetch(host.base + "/api/auth/me", { headers: { cookie: `${session}; ${device}` } });
    assert.equal((await me.json()).user.name, "Shared Admin");
    assert.deepEqual(setCookies(me), [], "GET /me never mutates session or trusted-device cookies");

    // Signed out reads are side-effect-free too.
    assert.deepEqual(setCookies(await fetch(host.base + "/api/auth/me")), []);
    // A stale cookie sent alongside the live one doesn't get in the way.
    const both = await fetch(host.base + "/api/auth/me", { headers: { cookie: `sfbb_session=eyJ1IjoieCJ9.bad; ${session}` } });
    assert.equal((await both.json()).user.name, "Shared Admin");

    // Duplicate cookies: the newer shared one, listed last by browsers, wins without reissuing either.
    const b = await post("/api/auth/login", { username: "shared", password: "admin-pass-1" });
    const later = b.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
    const two = await fetch(host.base + "/api/auth/me", { headers: { cookie: `${session}; ${later}` } });
    assert.equal(two.status, 200);
    assert.deepEqual(setCookies(two), []);
    await post("/api/auth/logout", {}, `${session}; ${later}`);
    assert.equal((await (await fetch(host.base + "/api/auth/me", { headers: { cookie: later } })).json()).user, null, "the newer session was selected for sign-out");
    assert.equal((await (await fetch(host.base + "/api/auth/me", { headers: { cookie: session } })).json()).user.name, "Shared Admin", "the older independent session is unchanged");

    // Signing out removes both copies, so it signs out of the diary and the rota.
    const out = setCookies(await post("/api/auth/logout", {}, session)).filter((c) => c.startsWith("sfbb_session="));
    assert.equal(out.length, 2);
    assert.ok(out.every((c) => /^sfbb_session=;.*Max-Age=0$/.test(c)));
    assert.ok(out.some((c) => c.includes("Domain=")) && out.some((c) => !c.includes("Domain=")));
  } finally { await host.stop(); }
});
