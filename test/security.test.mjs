// Security tests: every manager and admin action, tried as staff (and admin actions as a manager), is refused.
// Against `wrangler dev` with a fresh local database. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF;
before(async () => {
  srv = await startServer();
  ADMIN = await setupAdmin("Sam Patel", "sam.patel", "admin-pass-1");
  assert.equal((await admin("POST", "users", { name: "Alex Brown", username: "alex", role: "staff", password: "temp-pass-1" })).status, 200);
  STAFF = await firstSignIn("alex", "temp-pass-1", "alex-own-pass");
});
after(async () => { await srv?.stop(); });

// The session a response sets (its first Set-Cookie may remove an older, host-only copy: src/auth.ts).
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const postJson = (url, body) => fetch(`${srv.base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function setupAdmin(name, username, password) {
  const r = await postJson("/api/auth/setup", { name, username, password, code: SETUP_CODE });
  assert.equal(r.status, 200, await r.clone().text());
  return cookieOf(r);
}
async function login(username, password) {
  const r = await postJson("/api/auth/login", { username, password });
  const body = await r.json();
  return r.status === 200 && !body.mustChange ? cookieOf(r) : { status: r.status, body };
}
/** Signs in with a temporary password and chooses a new one, as the sign-in page does. */
async function firstSignIn(username, temp, chosen) {
  const first = await login(username, temp);
  assert.equal(first.body?.mustChange, true, "a temporary password asks for a new one");
  const r = await postJson("/api/auth/change", { username, password: temp, newPassword: chosen });
  assert.equal(r.status, 200, await r.clone().text());
  return cookieOf(r);
}
async function db(op, body, cookie = ADMIN) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${srv.base}/api/db/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function admin(method, route, body, cookie = ADMIN) {
  const r = await fetch(`${srv.base}/api/admin/${route}`, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test("security: staff can't use manager or admin features, managers can't use admin ones", async () => {
  assert.equal((await admin("POST", "users", { name: "Max Manager", username: "max", role: "manager", password: "temp-pass-1" })).status, 200);
  const MANAGER = await firstSignIn("max", "temp-pass-1", "max-own-pass");
  const send = (method, url, cookie, body) => fetch(srv.base + url, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const denied = async (res, what) => {
    assert.equal(res.status, 403, what);
    assert.equal((await res.json()).code, "permission_denied", what);
  };

  // Diary: manager-only collections at every site, and the shared setup, for every kind of write.
  const prefixes = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];
  for (const pre of prefixes) for (const col of ["settings", "plans", "inspections", "suppliers", "contacts", "onboarding"]) {
    const path = `${pre}${col}/sec1`;
    assert.equal((await db("set", { path, data: { name: "seed" } })).status, 200, "admin seeds " + path);
    for (const [op, body] of [["set", { path, data: { a: 1 } }], ["update", { path, patch: { a: 1 } }], ["delete", { path }]]) {
      const r = await db(op, body, STAFF);
      assert.equal(r.status, 403, `staff ${op} ${path}`);
      assert.equal(r.body.code, "permission_denied");
      assert.equal((await db(op, body, MANAGER)).status, 200, `manager ${op} ${path}`);
    }
  }
  for (const [op, body] of [["set", { path: "config/shared", data: { a: 1 } }], ["update", { path: "config/shared", patch: { a: 1 } }], ["delete", { path: "config/shared" }]])
    assert.equal((await db(op, body, STAFF)).body.code, "permission_denied", "staff " + op + " config/shared");

  // Diary records: staff can't delete day pages, week pages or signed reviews; managers can.
  for (const path of ["sites/cafe/days/2026-09-10", "weeks/2026-09-07", "sites/asg/reviews/2026-09-10"]) {
    assert.equal((await db("set", { path, data: { date: "x" } })).status, 200);
    assert.equal((await db("delete", { path }, STAFF)).body.code, "permission_denied", "staff delete " + path);
    assert.equal((await db("get", { path })).body.exists, true, "still there");
    assert.equal((await db("delete", { path }, MANAGER)).status, 200, "manager delete " + path);
  }

  // A whole-page set on an existing day merges, so nobody's checks or sign-off are overwritten.
  const day = "sites/cafe/days/2026-09-11";
  await db("set", { path: day, data: { date: "2026-09-11", opening: { items: { o1: true } }, signed: { by: "web:Sam Patel", name: "Sam Patel", at: 1 } } });
  assert.equal((await db("set", { path: day, data: { date: "2026-09-11", closing: { items: { c1: true } } } }, STAFF)).status, 200);
  const merged = (await db("get", { path: day })).body.data;
  assert.deepEqual([merged.opening.items, merged.closing.items, merged.signed.name], [{ o1: true }, { c1: true }, "Sam Patel"]);

  // Signatures: staff sign in their own name only.
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Max Manager", name: "Max Manager", at: 2 } } }, STAFF)).body.code, "permission_denied", "staff can't sign as a manager");
  assert.equal((await db("set", { path: "weeks/2026-09-14", data: { week: "2026-09-14", signed: { by: "web:Sam Patel", at: 2 } } }, STAFF)).body.code, "permission_denied");
  assert.equal((await db("set", { path: "reviews/2026-09-11", data: { date: "2026-09-11", answers: {}, by: "web:Max Manager", at: 2 } }, STAFF)).body.code, "permission_denied");
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 3 } } }, STAFF)).status, 200, "own signature");
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 3 }, problems: null } }, STAFF)).status, 200, "an unchanged signature can be sent back");
  assert.equal((await db("set", { path: "reviews/2026-09-11", data: { date: "2026-09-11", answers: {}, by: "web:Alex Brown", at: 2 } }, STAFF)).status, 200);
  assert.equal((await db("update", { path: day, patch: { signed: { by: "web:Alex Brown", name: "Alex Brown", at: 4 } } }, MANAGER)).status, 200, "managers aren't limited");

  // Admin: the API, backups and the page, for staff and managers.
  const users = (await admin("GET", "users")).body.users;
  const someone = users.find((u) => u.username === "alex"), other = users.find((u) => u.username === "sam.patel");
  for (const cookie of [STAFF, MANAGER]) {
    const who = cookie === STAFF ? "staff" : "manager";
    for (const [method, route, body] of [
      ["GET", "users"], ["POST", "users", { name: "Eve Sneaky", role: "admin", password: "eve-pass-123" }],
      ["PATCH", `users/${someone.id}`, { role: "admin" }], ["GET", "status"], ["GET", "backups"], ["POST", "backups"],
      ["GET", "overview"], ["GET", "people"], ["GET", "sites"], ["POST", "sites/factory/copy-setup", { from: "roastery" }], ["GET", "activity"],
      ["GET", "security"], ["POST", "security/reset-pins"], ["POST", "security/sign-out-all"], ["GET", "export/people.csv"], ["GET", "export/shifts.csv"],
    ]) await denied(await send(method, "/api/admin/" + route, cookie, body), `${who} ${method} /api/admin/${route}`);
    for (const page of ["/admin", "/admin/", "/admin.html", "/admin/index.html"]) assert.equal((await send("GET", page, cookie)).headers.get("location"), "/", `${who} ${page}`);
  }
  assert.equal((await admin("GET", "users")).body.users.find((u) => u.username === "alex").role, "staff", "still staff");

  // Rota: planning, publishing, settings, hours and suggestions are for managers.
  for (const [method, route, body] of [
    ["POST", "shifts", { site: "cafe", day: "2026-12-01", start: "09:00", end: "17:00" }], ["PATCH", "shifts/x", { start: "08:00" }],
    ["DELETE", "shifts/x"], ["PUT", "shifts/x/actual", { start: "09:00", end: "12:00" }], ["POST", "week/copy", { from: "2026-11-23", to: "2026-11-30" }],
    ["POST", "week/publish", { week: "2026-11-30" }], ["GET", "suggest?shift=x"], ["GET", "hours?start=2026-11-30"],
    ["PUT", `people/${someone.id}`, { contractMax: 60 }], ["PUT", "sites/cafe", { minPeople: 0 }], ["PUT", "me/availability", { sites: ["cafe"] }],
    ["POST", "time-off", { userId: other.id, from: "2026-12-01", to: "2026-12-02", reason: "x" }],
  ]) await denied(await send(method, "/api/rota/" + route, STAFF, body), `staff ${method} /api/rota/${route}`);

  // Every response says: only this site's scripts, and no framing.
  const csp = (await send("GET", "/", STAFF)).headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

