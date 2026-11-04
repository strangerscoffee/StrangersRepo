// Regression tests for the November 2026 audit: each test is a hole that was found and closed.
// Runs against `wrangler dev` with a fresh local database, like the other API tests. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

const WEEK = "2030-01-07"; // a Monday well ahead, so requests are allowed
const day = (i, w = WEEK) => { const d = new Date(w + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const mondayOf = (s) => day(-((new Date(s + "T12:00:00Z").getUTCDay() + 6) % 7), s);

let srv, ADMIN, MGR, ALEX, SAM;
const ids = {};
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN, headers = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const r = await fetch(srv.base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers, res: r };
}
const rota = (m, route, body, cookie = MGR) => req(m, "/api/rota/" + route, body, cookie);
const db = (op, body, cookie) => req("POST", "/api/db/" + op, body, cookie);
async function signUp(name, username, role) {
  const r = await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" });
  assert.equal(r.status, 200, r.text);
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  assert.equal(c.status, 200);
  return cookieOf(c);
}
const shift = async (s) => {
  const r = await rota("POST", "shifts", { site: "cafe", breakMins: 0, job: "", start: "09:00", end: "13:00", ...s });
  assert.equal(r.status, 200, r.text);
  return r.body.shift;
};

before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  SAM = await signUp("Sam Okafor", "sam", "staff");
  await db("set", { path: "sites/cafe/settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } }, ADMIN);
  const w = await rota("GET", "week?start=" + WEEK);
  for (const p of w.body.people) ids[p.name.split(" ")[0]] = p.id;
  await rota("POST", "week/publish", { week: WEEK });
});
after(() => srv?.stop());

test("sign-in: wrong passwords sent at once still lock the account after five", async () => {
  await signUp("Pat Race", "pat", "staff");
  const tries = await Promise.all(Array.from({ length: 12 }, () => req("POST", "/api/auth/login", { username: "pat", password: "wrong-password-1" }, null)));
  const wrong = tries.filter((t) => t.status === 401).length;
  assert.ok(wrong <= 4, `at most four plain wrong answers, got ${wrong}`);
  assert.ok(tries.every((t) => [401, 423].includes(t.status)), tries.map((t) => t.status).join(","));
  assert.equal((await req("POST", "/api/auth/login", { username: "pat", password: "pat-own-pass" }, null)).status, 423, "locked, even with the right password");
});

test("diary: staff can't empty or rewrite signed records", async () => {
  const review = "sites/cafe/reviews/2026-10-01";
  assert.equal((await db("set", { path: review, data: { date: "2026-10-01", answers: { a: "yes" }, notes: "", by: "web:George Farrow" } }, MGR)).status, 200);
  assert.equal((await db("set", { path: review, data: {} }, ALEX)).status, 403, "a review signed by someone else");
  assert.equal((await db("get", { path: review }, MGR)).body.data.answers.a, "yes");

  const dayPath = "sites/cafe/days/2026-10-02";
  assert.equal((await db("set", { path: dayPath, data: { temps: { u1: { am: { v: 4 } } }, signed: { by: "web:George Farrow", name: "George Farrow", at: 1 } } }, MGR)).status, 200);
  assert.equal((await db("update", { path: dayPath, patch: { temps: null } }, ALEX)).status, 403, "clearing a section");
  assert.equal((await db("update", { path: dayPath, patch: { signed: { by: "web:Alex Brown" } } }, ALEX)).status, 403, "half a signature");
  assert.equal((await db("update", { path: dayPath, patch: { temps: { u1: { am: null } } } }, ALEX)).status, 200, "clearing one reading is still fine");
});

test("training: staff record their own training dates in their own name only", async () => {
  const path = "sites/cafe/staff/alex";
  assert.equal((await db("set", { path, data: { name: "Alex Brown", topics: { hygiene: { date: "2026-10-01", by: "web:George Farrow" } } } }, MGR)).status, 200);
  // Re-saving with the manager's entry unchanged is fine; a new entry in the manager's name isn't.
  assert.equal((await db("update", { path, patch: { topics: { hygiene: { date: "2026-10-01", by: "web:George Farrow" }, diary: { date: "2026-10-02", by: "web:Alex Brown" } } } }, ALEX)).status, 200);
  assert.equal((await db("update", { path, patch: { topics: { allergens: { date: "2026-10-03", by: "web:George Farrow" } } } }, ALEX)).status, 403);
});

test("stored files: staff can't delete or add them; cross-site writes are refused", async () => {
  assert.equal((await req("DELETE", "/api/assets/0123456789abcdef0123456789abcdef", undefined, ALEX)).status, 403);
  assert.equal((await req("POST", "/api/assets", "%PDF-1.4", ALEX, { "content-type": "application/pdf" })).status, 403);
  const evil = await req("POST", "/api/db/set", { path: "sites/cafe/maintenance/x", data: { title: "x" } }, ALEX, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.code, "bad_origin");
});

test("admin: the last admin can't be switched off with active: 0", async () => {
  const users = (await req("GET", "/api/admin/users")).body.users;
  const will = users.find((u) => u.username === "will");
  assert.equal((await req("PATCH", `/api/admin/users/${will.id}`, { active: 0 })).status, 409);
});

test("rota: bad input gets a clear error, not a 500", async () => {
  assert.equal((await rota("GET", "mine?from=abc", undefined, ALEX)).status, 400);
  assert.equal((await rota("GET", "mine?from=2030-13-01", undefined, ALEX)).status, 400);
  assert.equal((await rota("PUT", `people/${ids.Alex}`, 5)).status, 400);
});

test("rota: a pickup or cover is cancelled when the shift moves, changes or its taker is switched off", async () => {
  // Moved to a draft week: the claim ends, and the draft shift never reaches staff.
  const a = await shift({ day: day(1), userId: null });
  const claim = await rota("POST", "requests", { kind: "claim", shiftId: a.id }, ALEX);
  assert.equal(claim.status, 200, claim.text);
  assert.equal((await rota("PATCH", "shifts/" + a.id, { day: "2030-05-15" })).status, 200);
  assert.equal((await rota("PATCH", "requests/" + claim.body.request.id, { action: "approve" })).status, 409);
  assert.ok(!(await rota("GET", "me", undefined, ALEX)).body.requests.some((r) => r.shift?.day === "2030-05-15"), "no draft-week shift in Alex's requests");

  // Times changed after someone agreed to cover: approval is refused.
  const b = await shift({ day: day(2), userId: ids.Alex });
  const cover = await rota("POST", "requests", { kind: "cover", shiftId: b.id }, ALEX);
  assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "accept" }, SAM)).status, 200);
  assert.equal((await rota("PATCH", "shifts/" + b.id, { start: "06:00", end: "18:00" })).status, 200);
  assert.equal((await rota("PATCH", "requests/" + cover.body.request.id, { action: "approve" })).status, 409);

  // The taker switched off: their claim ends with the account.
  const c = await shift({ day: day(3), userId: null });
  const samClaim = await rota("POST", "requests", { kind: "claim", shiftId: c.id }, SAM);
  assert.equal(samClaim.status, 200, samClaim.text);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.Sam}`, { active: false })).status, 200);
  assert.equal((await rota("PATCH", "requests/" + samClaim.body.request.id, { action: "approve" })).status, 409);
  await req("PATCH", `/api/admin/users/${ids.Sam}`, { active: true });
  SAM = cookieOf(await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "sam", password: "sam-own-pass" }) }));
});

test("rota: two people claiming the same shift at once get one request between them", async () => {
  const s = await shift({ day: day(4), userId: null });
  const [x, y] = await Promise.all([rota("POST", "requests", { kind: "claim", shiftId: s.id }, ALEX), rota("POST", "requests", { kind: "claim", shiftId: s.id }, SAM)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test("rota: time off is decided once, can't overlap, and started leave is a manager's to change", async () => {
  const t = await rota("POST", "time-off", { from: "2030-02-10", to: "2030-02-12" }, ALEX);
  assert.equal(t.status, 200);
  assert.equal((await rota("POST", "time-off", { from: "2030-02-11", to: "2030-02-11" }, ALEX)).status, 409, "overlap");
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "cancelled" }, ALEX)).status, 200);
  assert.equal((await rota("PATCH", "time-off/" + t.body.id, { status: "approved" })).status, 409, "a cancelled request can't be approved");
  const own = await rota("POST", "time-off", { from: "2030-03-01", to: "2030-03-01" }, MGR);
  assert.equal((await rota("PATCH", "time-off/" + own.body.id, { status: "approved" })).status, 403, "managers don't approve their own");
  const past = await rota("POST", "time-off", { from: "2025-06-01", to: "2025-06-03", userId: ids.Alex });
  assert.equal(past.body.status, "approved");
  assert.equal((await rota("PATCH", "time-off/" + past.body.id, { status: "cancelled" }, ALEX)).status, 403);
});

test("rota: copying over a week never touches days that have gone by", async () => {
  const thisWeek = mondayOf(londonToday());
  assert.equal((await rota("POST", "week/copy", { from: WEEK, to: day(-7, thisWeek), replace: true })).status, 400);
});

test("rota: a handover at half past isn't a gap in cover", async () => {
  const w = "2030-04-01";
  await rota("PUT", "sites/cafe", { opensAt: "07:00", closesAt: "17:00", minPeople: 1 });
  await shift({ day: w, start: "07:00", end: "12:30", userId: ids.Alex });
  await shift({ day: w, start: "12:30", end: "17:00", userId: ids.George });
  const v = await rota("GET", "week?start=" + w);
  assert.ok(!v.body.problems.some((p) => p.kind === "short_cover" && p.day === w), JSON.stringify(v.body.problems.filter((p) => p.kind === "short_cover")));
});

test("rota: rest between shifts counts the clocks going forward", async () => {
  // Sunday 31 March 2030 the clocks go forward: Saturday 21:00 to Sunday 08:00 is only 10 hours.
  await shift({ day: "2030-03-30", start: "13:00", end: "21:00", userId: ids.Sam });
  await shift({ day: "2030-03-31", start: "08:00", end: "12:00", userId: ids.Sam });
  const v = await rota("GET", "week?start=2030-03-25");
  assert.ok(v.body.problems.some((p) => p.kind === "rest" && p.day === "2030-03-31"));
});

// Last: it signs everyone out.
test("quick PINs: a trusted device stops being trusted after 'sign everyone out'", async () => {
  await signUp("Jo Device", "jodevice", "staff");
  const r = await fetch(srv.base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "jodevice", password: "jodevice-own-pass" }) });
  const device = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => /^sfbb_device=[\w-]/.test(c));
  assert.equal((await req("GET", "/api/auth/me", undefined, device)).body.quickSwitch, true);
  assert.equal((await req("POST", "/api/admin/security/sign-out-all", {})).status, 200);
  assert.equal((await req("GET", "/api/auth/me", undefined, device)).body.quickSwitch, false);
});
