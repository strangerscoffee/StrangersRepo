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

const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
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
const addShift = async (s, cookie = MGR) => {
  const r = await rota("POST", "shifts", { breakMins: 30, job: "", ...s }, cookie);
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
  const w = await rota("GET", "week?start=" + WEEK, undefined, MGR);
  for (const p of w.body.people) ids[p.name.split(" ")[0]] = p.id;
});
after(async () => { await srv?.stop(); });

test("hostnames: the rota on ROTA_HOST, the diary everywhere else", async () => {
  const { appForHost, appLinks, isRotaSharedFile } = await import("../src/hosts.ts");
  assert.equal(appForHost("rota.staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "rota");
  assert.equal(appForHost("ROTA.staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "rota");
  assert.equal(appForHost("staffstrangerscoffee.com", "rota.staffstrangerscoffee.com"), "diary");
  assert.equal(appForHost("localhost", undefined), "diary");
  assert.deepEqual(appLinks(new URL("https://staffstrangerscoffee.com/"), "rota.staffstrangerscoffee.com"), { rota: "https://rota.staffstrangerscoffee.com/", diary: "/" });
  assert.deepEqual(appLinks(new URL("https://rota.staffstrangerscoffee.com/"), "rota.staffstrangerscoffee.com"), { rota: "/", diary: "https://staffstrangerscoffee.com/" });
  assert.deepEqual(appLinks(new URL("http://localhost:8787/"), undefined), { rota: "/rota/", diary: "/" });
  assert.ok(isRotaSharedFile("/theme.css") && isRotaSharedFile("/rota/rota.js") && isRotaSharedFile("/icon-192.png"));
  assert.ok(!isRotaSharedFile("/app.js") && !isRotaSharedFile("/admin.html") && !isRotaSharedFile("/claude-shim.js"));
});

test("the diary host: the diary as before, plus the rota app at /rota/ and its API", async () => {
  assert.equal((await req("GET", "/rota/", undefined, null)).headers.get("location"), "/signin?next=%2Frota%2F");
  const page = await req("GET", "/rota/");
  assert.equal(page.status, 200);
  assert.match(page.text, /rota\.js/);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.match((await req("GET", "/")).text, /app\.js/, "the diary still serves its page");
  assert.equal((await rota("GET", "week", undefined, null)).body.code, "unauthenticated");
});

test("only managers plan: staff can't change shifts, publish, or read hours and suggestions", async () => {
  const s = (await addShift({ site: "asg", day: MON, start: "09:00", end: "12:00" })).shift;
  const refused = [
    await rota("POST", "shifts", { site: "asg", day: MON, start: "09:00", end: "12:00" }, ALEX),
    await rota("PATCH", "shifts/" + s.id, { start: "08:00" }, ALEX),
    await rota("DELETE", "shifts/" + s.id, undefined, ALEX),
    await rota("POST", "week/publish", { week: WEEK }, ALEX),
    await rota("POST", "week/copy", { from: WEEK, to: day(7) }, ALEX),
    await rota("GET", "hours?start=" + WEEK, undefined, ALEX),
    await rota("GET", "suggest?shift=" + s.id, undefined, ALEX),
    await rota("PUT", "people/" + ids.Alex, { contractHours: 40 }, ALEX),
    await rota("PUT", "sites/cafe", { opensAt: "07:00", closesAt: "17:00", minPeople: 2 }, ALEX),
  ];
  for (const r of refused) { assert.equal(r.status, 403, r.text); assert.equal(r.body.code, "permission_denied"); }
  assert.equal((await rota("PATCH", "shifts/" + s.id, { start: "08:00" }, MGR)).status, 200, "managers can");
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
    const r = await rota("POST", "shifts", b, MGR);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.code, "invalid_argument");
  }
  assert.match((await rota("POST", "shifts", bad[4], MGR)).body.message, /closed on Sundays/);
  // A day closed in the diary (Today → closed, or a planned closure) is closed on the rota too.
  await req("POST", "/api/db/set", { path: `sites/cafe/days/${TUE}`, data: { date: TUE, closed: { reason: "Boiler repair", by: "web:Will Owner", at: 1 } } });
  const r = await rota("POST", "shifts", { site: "cafe", day: TUE, start: "09:00", end: "12:00" }, MGR);
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Boiler repair/);
  const w = await rota("GET", "week?start=" + WEEK, undefined, MGR);
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
  await rota("PUT", "people/" + ids.Sam, { contractHours: 10 }, MGR);
  await rota("POST", "time-off", { userId: ids.Priya, from: d(2), to: d(2), reason: "Holiday" }, MGR);
  await addShift({ site: "asg", day: d(0), start: "08:00", end: "12:00", job: "opens", userId: null }); // open shift
  await addShift({ site: "asg", day: d(1), start: "08:00", end: "16:00", job: "opens", userId: ids.Sam, breakMins: 0 }); // 8h, no break
  await addShift({ site: "cafe", day: d(1), start: "10:00", end: "14:00", job: "closes", userId: ids.Sam }); // clash across sites
  await addShift({ site: "asg", day: d(2), start: "08:00", end: "12:00", job: "opens", userId: ids.Priya }); // on time off
  await addShift({ site: "asg", day: d(3), start: "17:00", end: "22:00", userId: ids.Alex, job: "closes" });
  const last = await addShift({ site: "asg", day: d(4), start: "06:00", end: "10:00", userId: ids.Alex, job: "opens" }); // 8h rest
  const ks = kinds(last.problems);
  for (const k of ["open_shift", "clash", "time_off", "no_closer", "short_cover", "over_contract", "rest", "break"]) assert.ok(ks.includes(k), "has " + k + ": " + ks.join(","));
  const clash = last.problems.find((p) => p.kind === "clash");
  assert.match(clash.message, /Sam is at (ASG and Cafe|Cafe and ASG) on Tuesday/);
  assert.equal(last.problems.find((p) => p.kind === "over_contract").userId, ids.Sam);
  assert.ok(last.problems.some((p) => p.kind === "no_opener" || p.kind === "no_closer"));
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
  assert.equal(staff.body.people[0].contractHours, undefined, "staff don't see contracts");
  assert.deepEqual((await rota("GET", `mine?from=${W}&to=${W}`, undefined, ALEX)).body.shifts, []);
  assert.equal((await rota("GET", `today?site=cafe&day=${W}`, undefined, ALEX)).body.published, false);
  await rota("POST", "week/publish", { week: W }, MGR);
  staff = await rota("GET", "week?start=" + W, undefined, ALEX);
  assert.equal(staff.body.published, true);
  assert.equal(staff.body.shifts.length, 1);
  assert.equal((await rota("GET", `mine?from=${W}&to=${W}`, undefined, ALEX)).body.shifts.length, 1);
  const today = await rota("GET", `today?site=cafe&day=${W}`, undefined, ALEX);
  assert.deepEqual(today.body.shifts.map((x) => [x.name, x.me, x.job]), [["Alex Brown", true, "opens"]]);
  await rota("PATCH", "shifts/" + s.id, { end: "14:00" }, MGR);
  await addShift({ site: "cafe", day: W, start: "11:00", end: "18:00", job: "closes" });
  const mgr = await rota("GET", "week?start=" + W, undefined, MGR);
  assert.equal(mgr.body.changesSincePublish, 2);
  assert.equal((await rota("GET", "week?start=" + W, undefined, ALEX)).body.shifts.length, 2, "staff see live shifts of a published week");
  await rota("POST", "week/publish", { week: W }, MGR);
  assert.equal((await rota("GET", "week?start=" + W, undefined, MGR)).body.changesSincePublish, 0);
});

test("copy last week: closed days skipped, and it won't overwrite without replace", async () => {
  const A = "2030-04-01", B = "2030-04-08";
  await addShift({ site: "cafe", day: A, start: "07:00", end: "15:00", userId: ids.Alex });
  await addShift({ site: "asg", day: "2030-04-07", start: "08:00", end: "12:00", userId: ids.Sam }); // a Sunday
  // The Cafe's Monday the next week is a planned closure.
  await req("POST", "/api/db/set", { path: "sites/cafe/days/2030-04-08", data: { date: "2030-04-08", closed: { reason: "Easter Monday", by: "x", at: 1 } } });
  const r = await rota("POST", "week/copy", { from: A, to: B }, MGR);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.copied, 1);
  assert.equal(r.body.skipped.length, 1);
  assert.match(r.body.skipped[0].reason, /Easter Monday/);
  const again = await rota("POST", "week/copy", { from: A, to: B }, MGR);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "conflict");
  assert.equal((await rota("POST", "week/copy", { from: A, to: B, replace: true }, MGR)).body.replaced, 1);
});

test("claims and covers: asked, accepted and approved; clashes refused", async () => {
  // Two weeks from now: open shifts are listed for the next six weeks.
  const t = new Date(); t.setUTCDate(t.getUTCDate() + 14 - ((t.getUTCDay() + 6) % 7));
  const W = t.toISOString().slice(0, 10);
  const open = (await addShift({ site: "cafe", day: W, start: "11:00", end: "18:00", job: "closes" })).shift;
  const unpublished = await rota("POST", "requests", { kind: "claim", shiftId: open.id }, ALEX);
  assert.equal(unpublished.status, 400, "can't claim from an unpublished week");
  await rota("POST", "week/publish", { week: W }, MGR);
  const offered = (await rota("GET", "open", undefined, ALEX)).body.shifts.map((s) => s.id);
  assert.ok(offered.includes(open.id), "Alex sees the open shift");
  const claim = await rota("POST", "requests", { kind: "claim", shiftId: open.id }, ALEX);
  assert.equal(claim.status, 200, claim.text);
  assert.equal((await rota("POST", "requests", { kind: "claim", shiftId: open.id }, SAM)).body.code, "conflict", "a second claim is refused");
  assert.equal((await rota("PATCH", "requests/" + claim.body.request.id, { action: "approve" }, ALEX)).status, 403, "staff can't approve");
  const ok = await rota("PATCH", "requests/" + claim.body.request.id, { action: "approve" }, MGR);
  assert.equal(ok.body.request.status, "approved");
  let w = await rota("GET", "week?start=" + W, undefined, MGR);
  assert.equal(w.body.shifts.find((s) => s.id === open.id).userId, ids.Alex);
  assert.equal((await rota("POST", "requests", { kind: "claim", shiftId: open.id }, SAM)).body.code, "conflict", "no longer open");

  // Cover to a named person.
  const c1 = await rota("POST", "requests", { kind: "cover", shiftId: open.id, toUserId: ids.Priya, message: "Wedding" }, ALEX);
  assert.equal(c1.status, 200, c1.text);
  assert.equal((await rota("PATCH", "requests/" + c1.body.request.id, { action: "accept" }, SAM)).status, 403, "only the person asked");
  assert.equal((await rota("PATCH", "requests/" + c1.body.request.id, { action: "approve" }, MGR)).body.code, "conflict", "not accepted yet");
  const priya = await signInAgain("priya");
  assert.equal((await rota("PATCH", "requests/" + c1.body.request.id, { action: "accept" }, priya)).body.request.status, "accepted");
  assert.equal((await rota("PATCH", "requests/" + c1.body.request.id, { action: "approve" }, MGR)).body.request.status, "approved");
  w = await rota("GET", "week?start=" + W, undefined, MGR);
  assert.equal(w.body.shifts.find((s) => s.id === open.id).userId, ids.Priya);

  // Cover to anyone; approval refused when it would clash.
  const c2 = await rota("POST", "requests", { kind: "cover", shiftId: open.id }, priya);
  assert.equal(c2.body.request.toUser, null);
  assert.equal((await rota("PATCH", "requests/" + c2.body.request.id, { action: "accept" }, SAM)).body.request.taker, ids.Sam);
  await addShift({ site: "asg", day: W, start: "12:00", end: "16:00", userId: ids.Sam }); // Sam is now busy then
  const refused = await rota("PATCH", "requests/" + c2.body.request.id, { action: "approve" }, MGR);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "conflict");
  assert.equal((await rota("PATCH", "requests/" + c2.body.request.id, { action: "cancel" }, priya)).body.request.status, "cancelled");
  assert.equal((await rota("POST", "requests", { kind: "cover", shiftId: open.id }, SAM)).status, 403, "only your own shifts");
});
async function signInAgain(username) {
  const r = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: username + "-own-pass" }) });
  assert.equal(r.status, 200);
  return cookieOf(r);
}

test("suggestions: clashing and on-leave people can't be picked; best fit first; over contract and untrained flagged", async () => {
  const W = "2030-06-03";
  await rota("PUT", "people/" + ids.Alex, { contractHours: 40 }, MGR);
  await rota("PUT", "people/" + ids.Sam, { contractHours: 4 }, MGR);
  await rota("PUT", "people/" + ids.Priya, { contractHours: 30 }, MGR);
  await addShift({ site: "asg", day: W, start: "08:00", end: "12:00", userId: ids.Alex });
  await rota("POST", "time-off", { userId: ids.George, from: W, to: W, reason: "Holiday" }, MGR);
  // Priya is trained on the Cafe's opening and closing checks; no one else is.
  await req("POST", "/api/db/set", { path: "sites/cafe/staff/p1", data: { name: "Priya Shah", topics: { diary: { date: "2029-01-01", by: "x" } } } });
  const s = (await addShift({ site: "cafe", day: W, start: "09:00", end: "15:00", job: "closes" })).shift;
  const r = await rota("GET", "suggest?shift=" + s.id, undefined, MGR);
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.body.candidates.map((c) => [c.name.split(" ")[0], c]));
  assert.equal(by.Alex.selectable, false, "Alex clashes");
  assert.ok(by.Alex.flags.some((f) => f.kind === "clash"));
  assert.equal(by.George.selectable, false, "George is on time off");
  assert.ok(by.Sam.flags.some((f) => f.kind === "over_contract"));
  assert.ok(by.Sam.flags.some((f) => f.kind === "untrained"));
  assert.equal(r.body.candidates[0].name, "Priya Shah");
  assert.equal(r.body.candidates[0].best, true);
  assert.equal(r.body.candidates.filter((c) => c.best).length, 1);
  const lastSelectable = r.body.candidates.map((c) => c.selectable).lastIndexOf(true);
  assert.ok(r.body.candidates.slice(lastSelectable + 1).every((c) => !c.selectable), "people who can't take it come last");
});

test("hours and the CSV", async () => {
  const W = "2030-07-01";
  await rota("PUT", "people/" + ids.Alex, { contractHours: 10 }, MGR);
  await addShift({ site: "cafe", day: W, start: "07:00", end: "15:00", userId: ids.Alex, breakMins: 30 }); // 7.5h
  await addShift({ site: "asg", day: "2030-07-02", start: "09:00", end: "13:00", userId: ids.Alex, breakMins: 0 }); // 4h
  await addShift({ site: "asg", day: "2030-07-02", start: "13:00", end: "17:00", breakMins: 0 }); // open: not counted
  const r = await rota("GET", "hours?start=" + W, undefined, MGR);
  const alex = r.body.people.find((p) => p.name === "Alex Brown");
  assert.equal(alex.rotaHours, 11.5);
  assert.equal(alex.difference, 1.5);
  assert.deepEqual(alex.sites, { roastery: 0, cafe: 7.5, asg: 4, factory: 0 });
  assert.equal(r.body.siteTotals.asg, 4);
  assert.equal(r.body.openHours, 4);
  const csv = await rota("GET", `hours?start=${W}&format=csv`, undefined, MGR);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split(/\r\n/);
  assert.equal(lines[0], "name,role,contract_hours,rota_hours,difference,roastery,cafe,asg,factory");
  assert.ok(lines.includes("Alex Brown,staff,10,11.5,1.5,0,7.5,4,0"), csv.text);
});

test("availability: your own, not anyone else's; managers set contracts", async () => {
  const r = await rota("PUT", "me/availability", { pattern: { mon: "off", wed: { to: "15:00" } }, sites: ["cafe", "asg"] }, ALEX);
  assert.equal(r.status, 200, r.text);
  const me = await rota("GET", "me", undefined, ALEX);
  assert.deepEqual(me.body.pattern, { mon: "off", wed: { to: "15:00" } });
  assert.deepEqual(me.body.sites, ["cafe", "asg"]);
  assert.equal((await rota("PUT", "people/" + ids.Sam, { contractHours: 20, pattern: {} }, ALEX)).status, 403);
  assert.equal((await rota("PUT", "me/availability", { pattern: { mon: { from: "15:00", to: "09:00" } } }, ALEX)).body.code, "invalid_argument");
  // Time off: asked for yourself, approved by a manager, cancelled by you.
  const t = await rota("POST", "time-off", { from: "2030-08-01", to: "2030-08-03", reason: "Holiday" }, ALEX);
  assert.equal(t.body.status, "requested");
  assert.equal((await rota("POST", "time-off", { userId: ids.Sam, from: "2030-08-01", to: "2030-08-01" }, ALEX)).status, 403);
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "approved" }, ALEX)).status, 403);
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "approved" }, MGR)).body.status, "approved");
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "cancelled" }, ALEX)).body.status, "cancelled");
  // Shifts outside someone's pattern are noted.
  const s = await addShift({ site: "cafe", day: "2030-09-02", start: "09:00", end: "12:00", userId: ids.Alex }); // a Monday
  assert.ok(s.problems.some((p) => p.kind === "availability" && p.userId === ids.Alex));
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
    assert.equal((await get("/rota/rota.js")).headers.get("location"), "/signin?next=%2Frota%2Frota.js");
    assert.equal((await get("/signin")).status, 200);
    const r = await fetch(host.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Host Admin", username: "host", password: "admin-pass-1", code: SETUP_CODE }) });
    const c = cookieOf(r);
    const home = await get("/", c);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /rota\.js/, "/ serves the rota app");
    assert.equal((await get("/rota/", c)).headers.get("location"), "/");
    for (const p of ["/admin", "/index.html", "/app.js", "/claude-shim.js"]) assert.equal((await get(p, c)).headers.get("location"), "/", p + " goes to the rota");
    for (const p of ["/theme.css", "/ui.css", "/rota/rota.js", "/rota/rota.css", "/pinpad.js"]) assert.equal((await get(p, c)).status, 200, p);
    const db = await fetch(host.base + "/api/db/get", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify({ path: "days/x" }) });
    assert.equal(db.status, 404, "the diary's data API isn't on the rota host");
    assert.equal((await get("/api/rota/links", c).then((x) => x.json())).rota, "/");
    assert.equal((await get("/api/rota/week", c)).status, 200);
    assert.equal((await get("/robots.txt")).status, 200);
    assert.equal((await get("/", c)).headers.get("x-robots-tag"), "noindex, nofollow");
  } finally { await host.stop(); }
});
