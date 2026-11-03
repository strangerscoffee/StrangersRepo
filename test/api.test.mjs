// API tests against `wrangler dev` with a fresh local database. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF;
before(async () => {
  srv = await startServer({ writeLimit: 80, scheduled: true });
  ADMIN = await setupAdmin("Sam Patel", "sam.patel", "admin-pass-1");
  const r = await admin("POST", "users", { name: "Alex Brown", username: "alex", role: "staff", password: "temp-pass-1" });
  assert.equal(r.status, 200);
  STAFF = await firstSignIn("alex", "temp-pass-1", "alex-own-pass");
});
after(async () => { await srv?.stop(); });

const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
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

test("signed out: only the sign-in page is reachable", async () => {
  const home = await fetch(srv.base + "/", { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/signin");
  const adm = await fetch(srv.base + "/admin", { redirect: "manual" });
  assert.equal(adm.headers.get("location"), "/signin?next=%2Fadmin");
  assert.equal((await fetch(srv.base + "/signin")).status, 200);
  assert.equal((await fetch(srv.base + "/theme.css")).status, 200);
  assert.equal((await fetch(srv.base + "/claude-shim.js", { redirect: "manual" })).status, 302);
  const r = await db("get", { path: "days/x" }, null);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "unauthenticated");
  assert.equal((await fetch(srv.base + "/_blob/" + "0".repeat(32))).status, 401);
  const me = await (await fetch(srv.base + "/api/auth/me")).json();
  assert.deepEqual(me, { user: null, setupNeeded: false, quickSwitch: false });
});

test("page is served with the shim and noindex once signed in", async () => {
  const r = await fetch(srv.base + "/", { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<script src="\/claude-shim.js"><\/script>\n<script src="\/pinpad.js"><\/script>\n<script src="\/pdf.js"><\/script>\n<script src="\/app.js"><\/script>/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.match(await (await fetch(srv.base + "/robots.txt")).text(), /Disallow: \//);
  assert.equal((await fetch(srv.base + "/claude-shim.js", { headers: { cookie: ADMIN } })).status, 200);
});

test("setup works once, and needs the setup code", async () => {
  const again = await postJson("/api/auth/setup", { name: "Eve", username: "eve", password: "eve-pass-1", code: SETUP_CODE });
  assert.equal(again.status, 409);
  const me = await (await fetch(srv.base + "/api/auth/me", { headers: { cookie: ADMIN } })).json();
  assert.deepEqual(me.user, { id: me.user.id, name: "Sam Patel", role: "admin", recordId: "web:Sam Patel", quickPin: false });
});

test("sign-in: username + password, wrong passwords, lockout and unlock", async () => {
  assert.equal(typeof (await login("ALEX", "alex-own-pass")), "string", "usernames aren't case-sensitive");
  assert.equal((await login("alex", "temp-pass-1")).status, 401, "the temporary password stops working");
  const wrong = await login("alex", "nope-nope");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "wrong_password");
  assert.match(wrong.body.message, /tries left/);
  assert.equal((await login("nobody", "whatever1")).body.code, "wrong_password");
  assert.equal((await login("Alex Brown", "alex-own-pass")).status, 401, "the display name isn't a username");
  const { body } = await admin("POST", "users", { name: "Lock Test", username: "lock.test", role: "staff", password: "lock-pass-1" });
  for (let i = 0; i < 4; i++) assert.equal((await login("lock.test", "wrong-pass")).status, 401);
  assert.equal((await login("lock.test", "wrong-pass")).status, 423);
  assert.equal((await login("lock.test", "lock-pass-1")).status, 423, "even the right password waits out the lock");
  assert.equal((await admin("GET", "users")).body.users.find((u) => u.username === "lock.test").locked, true);
  await admin("PATCH", `users/${body.user.id}`, { unlock: true });
  assert.equal((await login("lock.test", "lock-pass-1")).body.mustChange, true);
});

test("passwords: rules, change, and new passwords end other sessions", async () => {
  assert.equal((await postJson("/api/auth/change", { username: "alex", password: "alex-own-pass", newPassword: "short" })).status, 400);
  assert.equal((await postJson("/api/auth/change", { username: "alex", password: "alex-own-pass", newPassword: "alex-own-pass" })).status, 400);
  const old = STAFF;
  const r = await postJson("/api/auth/change", { username: "alex", password: "alex-own-pass", newPassword: "alex-newer-pass" });
  assert.equal(r.status, 200);
  STAFF = cookieOf(r);
  assert.equal((await db("get", { path: "days/x" }, old)).status, 401, "other sessions end");
  assert.equal((await db("get", { path: "days/x" }, STAFF)).status, 200);
});

test("roles: staff record entries but can't change manager sections or use admin", async () => {
  assert.equal((await db("set", { path: "sites/cafe/days/2026-10-01", data: { date: "2026-10-01" } }, STAFF)).status, 200);
  assert.equal((await db("set", { path: "sites/cafe/cleaning/c1", data: { name: "Mop" } }, STAFF)).status, 200);
  assert.equal((await db("set", { path: "deliveries/d1", data: { supplier: "Dairy", outcome: "accepted" } }, STAFF)).status, 200, "staff record deliveries");
  assert.equal((await db("set", { path: "sites/factory/maintenance/m1", data: { title: "Fix door" } }, STAFF)).status, 200, "staff report maintenance");
  assert.equal((await db("set", { path: "sites/asg/reviews/2026-10-01", data: { date: "2026-10-01", answers: {}, notes: "" } }, STAFF)).status, 200, "staff sign the 4-weekly review");
  for (const path of ["sites/cafe/settings/main", "config/shared", "sites/cafe/suppliers/s1", "plans/p1", "sites/cafe/staff/t1"]) {
    const r = await db("set", { path, data: { a: 1 } }, STAFF);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, "permission_denied");
  }
  // Staff training: staff fill in and sign their own record only, and never remove one.
  assert.equal((await db("set", { path: "sites/asg/staff/own", data: { name: "alex  brown", topics: {} } }, STAFF)).status, 200, "own record");
  assert.equal((await db("update", { path: "sites/asg/staff/own", patch: { signed: { by: "web:Alex Brown" } } }, STAFF)).status, 200, "sign own record");
  for (const [op, body] of [
    ["update", { path: "sites/asg/staff/own", patch: { name: "Sam Patel" } }],
    ["delete", { path: "sites/asg/staff/own" }],
    ["set", { path: "sites/asg/staff/other", data: { name: "Sam Patel" } }],
  ]) assert.equal((await db(op, body, STAFF)).body.code, "permission_denied", op + " " + JSON.stringify(body));
  assert.equal((await db("set", { path: "sites/asg/staff/other", data: { name: "Sam Patel" } })).status, 200, "managers write anyone's");
  for (const [op, body] of [["set", { path: "sites/asg/staff/other", data: { name: "Alex Brown" } }], ["update", { path: "sites/asg/staff/other", patch: { topics: {} } }]])
    assert.equal((await db(op, body, STAFF)).body.code, "permission_denied", "can't take over someone else's record: " + op);
  assert.equal((await db("get", { path: "sites/cafe/settings/main" }, STAFF)).status, 200, "staff can still read");
  assert.equal((await admin("GET", "users", undefined, STAFF)).status, 403);
  // Everyone signed in can list the team (names and roles, never usernames); signed out can't.
  const team = await (await fetch(srv.base + "/api/auth/team", { headers: { cookie: STAFF } })).json();
  assert.ok(Array.isArray(team.team) && team.team.length >= 2);
  for (const p of team.team) { assert.deepEqual(Object.keys(p).sort(), ["id", "name", "role"]); assert.equal(p.id, "web:" + p.name); }
  assert.equal((await fetch(srv.base + "/api/auth/team")).status, 401);
  const adm = await fetch(srv.base + "/admin", { headers: { cookie: STAFF }, redirect: "manual" });
  assert.equal(adm.headers.get("location"), "/");
  const r = await db("get", { path: "sites/cafe/days/2026-10-01" }, STAFF);
  assert.equal(r.body.exists, true);
  assert.equal((await db("get", { path: "sites/cafe/days/2026-10-01" })).body.exists, true);
});

test("admin: add, rename, temporary password and switch off", async () => {
  const add = await admin("POST", "users", { name: "Jo Manager", role: "manager" });
  assert.equal(add.status, 200);
  assert.equal(add.body.user.username, "jo.manager", "username suggested from the name");
  assert.match(add.body.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/, "a temporary password is created when none is given");
  assert.equal(add.body.user.mustChange, true);
  assert.equal((await admin("POST", "users", { name: "jo manager", username: "other", role: "staff" })).body.code, "name_taken");
  assert.equal((await admin("POST", "users", { name: "Jo Two", username: "jo.manager", role: "staff" })).body.code, "username_taken");
  assert.equal((await admin("POST", "users", { name: "Bad", username: "no spaces", role: "staff" })).body.code, "invalid_argument");
  assert.equal((await admin("POST", "users", { name: "X Y", role: "boss" })).body.code, "invalid_argument");
  const id = add.body.user.id;
  const jo = await firstSignIn("jo.manager", add.body.password, "jo-own-pass");
  assert.equal((await db("set", { path: "sites/cafe/suppliers/s9", data: { name: "Ok" } }, jo)).status, 200, "managers can");

  const reset = await admin("PATCH", `users/${id}`, { password: "generate" });
  assert.equal(reset.body.user.mustChange, true);
  assert.equal((await db("get", { path: "days/x" }, jo)).status, 401, "old session ends after a reset");
  const jo2 = await firstSignIn("jo.manager", reset.body.password, "jo-second-pass");

  const ren = await admin("PATCH", `users/${id}`, { name: "Jo Smith", username: "jo.smith" });
  assert.equal(ren.status, 200);
  assert.equal((await admin("PATCH", `users/${id}`, { username: "jo" })).body.code, "invalid_argument", "usernames need 3+ characters");
  assert.equal((await db("get", { path: "days/x" }, jo2)).status, 401, "renaming signs them out so records use the new name");
  const jo3 = await login("jo.smith", "jo-second-pass");
  await db("set", { path: "sites/cafe/days/2026-10-02", data: { date: "2026-10-02" } }, jo3);
  const me = await (await fetch(srv.base + "/api/auth/me", { headers: { cookie: jo3 } })).json();
  assert.equal(me.user.recordId, "web:Jo Smith", "records show the name, not the username");

  await admin("PATCH", `users/${id}`, { active: false });
  assert.equal((await db("get", { path: "days/x" }, jo3)).status, 401);
  assert.equal((await login("jo.smith", "jo-second-pass")).status, 401, "switched-off people can't sign in");
});

test("an admin who forgot their password can set a new one with the setup code", async () => {
  assert.equal((await postJson("/api/auth/recover", { username: "sam.patel", password: "brand-new-1", code: "nope" })).status, 403);
  assert.equal((await postJson("/api/auth/recover", { username: "alex", password: "brand-new-1", code: SETUP_CODE })).status, 404, "staff can't use it");
  const r = await postJson("/api/auth/recover", { username: "sam.patel", password: "brand-new-1", code: SETUP_CODE });
  assert.equal(r.status, 200);
  assert.equal((await db("get", { path: "days/x" })).status, 401, "old admin sessions end");
  ADMIN = await login("sam.patel", "brand-new-1");
  assert.equal(typeof ADMIN, "string");
});

test("admin: the last admin can't be demoted or switched off", async () => {
  const users = (await admin("GET", "users")).body.users;
  const me = users.find((u) => u.username === "sam.patel");
  assert.equal((await admin("PATCH", `users/${me.id}`, { role: "staff" })).body.code, "last_admin");
  assert.equal((await admin("PATCH", `users/${me.id}`, { active: false })).body.code, "last_admin");
  const st = await admin("GET", "status");
  assert.equal(st.status, 200);
  assert.equal(typeof st.body.docs, "number");
});

test("set, get and deep-merging update", async () => {
  const path = "sites/cafe/days/2026-10-27";
  assert.equal((await db("set", { path, data: { date: "2026-10-27", opening: { items: { o1: true }, by: "a" } } })).status, 200);
  await db("update", { path, patch: { opening: { items: { o2: true }, by: "b" }, temps: { u1: { am: { v: 3.2 } } } } });
  await db("update", { path, patch: { temps: { u2: { am: { v: -18 } } }, problems: null } });
  const { body } = await db("get", { path });
  assert.equal(body.exists, true);
  assert.deepEqual(body.data, {
    date: "2026-10-27",
    opening: { items: { o1: true, o2: true }, by: "b" },
    temps: { u1: { am: { v: 3.2 } }, u2: { am: { v: -18 } } },
    problems: null,
  });
});

test("concurrent updates to one document all survive", async () => {
  const path = "days/2026-10-26";
  await db("set", { path, data: { date: "2026-10-26" } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => db("update", { path, patch: { opening: { items: { ["c" + i]: true } } } })));
  const { body } = await db("get", { path });
  assert.equal(Object.keys(body.data.opening.items).length, 20);
});

test("update on a missing doc is not_found; get of a missing doc doesn't exist", async () => {
  const r = await db("update", { path: "days/2020-01-01", patch: { a: 1 } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "not_found");
  assert.equal((await db("get", { path: "days/2020-01-01" })).body.exists, false);
});

test("invalid paths and data are rejected with invalid_argument", async () => {
  for (const path of ["nope/x", "days", "sites/roastery/days/x", "sites/cafe/secret/x", "config/sync", "config/people", "days//x"]) {
    const r = await db("set", { path, data: { a: 1 } });
    assert.equal(r.body.code, "invalid_argument", path);
  }
  assert.equal((await db("set", { path: "days/x", data: [1] })).body.code, "invalid_argument");
  const big = { blob: "x".repeat(257 * 1024) };
  assert.equal((await db("set", { path: "days/x", data: big })).body.code, "invalid_argument");
  assert.equal((await db("query", { path: "days", orderBy: "date; drop table docs" })).body.code, "invalid_argument");
});

test("query ordering and limit; deletes hide docs", async () => {
  for (const d of ["2026-09-01", "2026-09-03", "2026-09-02"]) await db("set", { path: `sites/asg/days/${d}`, data: { date: d } });
  const q = await db("query", { path: "sites/asg/days", orderBy: "date", dir: "desc", limit: 2 });
  assert.deepEqual(q.body.docs.map((d) => d.id), ["2026-09-03", "2026-09-02"]);
  await db("delete", { path: "sites/asg/days/2026-09-03" });
  const q2 = await db("query", { path: "sites/asg/days", orderBy: "date", dir: "desc" });
  assert.deepEqual(q2.body.docs.map((d) => d.id), ["2026-09-02", "2026-09-01"]);
});

test("poll returns only what changed", async () => {
  const queries = [
    { key: "a", kind: "col", path: "sites/factory/cleaning" },
    { key: "b", kind: "doc", path: "sites/factory/settings/main" },
  ];
  const first = (await db("poll", { since: null, queries })).body;
  assert.deepEqual(first.results.a.docs, []);
  assert.equal(first.results.b.exists, false);
  const withVers = queries.map((q) => ({ ...q, ver: first.results[q.key].ver }));
  assert.deepEqual((await db("poll", { since: first.seq, queries: withVers })).body.results, {});
  await db("set", { path: "sites/factory/cleaning/job1", data: { name: "Mop floor", freq: "daily" } });
  const third = (await db("poll", { since: first.seq, queries: withVers })).body;
  assert.deepEqual(Object.keys(third.results), ["a"]);
  assert.equal(third.results.a.docs[0].data.name, "Mop floor");
});

test("poll handles as many subscriptions as the page opens", async () => {
  const prefixes = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];
  const cols = ["days", "weeks", "extras", "cleaning", "allergens", "allergenDocs", "reviews", "staff", "proveit"];
  const queries = prefixes.flatMap((p) => [
    ...cols.map((c) => ({ key: p + c, kind: "col", path: p + c, orderBy: "date", dir: "desc", limit: 14 })),
    { key: p + "settings", kind: "doc", path: p + "settings/main" },
  ]);
  assert.equal(queries.length, 40);
  const r = await db("poll", { since: null, queries });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Object.keys(r.body.results).length, 40);
  assert.equal(r.body.results["sites/cafe/days"].docs[0].id, "2026-10-27", "newest day first");
});

test("profiles resolves names on records", async () => {
  const r = await db("profiles", { ids: ["web:Sam Patel", "u_unknown"] });
  assert.deepEqual(r.body, { "web:Sam Patel": { name: "Sam Patel" }, u_unknown: { name: "" } });
});

test("PDF upload, serve and delete", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const up = await fetch(`${srv.base}/api/assets`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: ADMIN }, body: pdf,
  });
  assert.equal(up.status, 200);
  const info = await up.json();
  assert.match(info.id, /^[0-9a-f]{32}$/);
  assert.equal(info.url, "/_blob/" + info.id);
  const get = await fetch(srv.base + info.url, { headers: { cookie: ADMIN } });
  assert.equal(get.headers.get("content-type"), "application/pdf");
  assert.equal(get.headers.get("content-disposition"), "inline");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await get.arrayBuffer()).byteLength, pdf.length);
  const bad = await fetch(`${srv.base}/api/assets`, { method: "POST", headers: { "content-type": "text/html", cookie: ADMIN }, body: "<p>" });
  assert.equal((await bad.json()).code, "unsupported_type");
  const del = await fetch(`${srv.base}/api/assets/${info.id}`, { method: "DELETE", headers: { cookie: ADMIN } });
  assert.deepEqual(await del.json(), { deleted: true });
  assert.equal((await fetch(srv.base + info.url, { headers: { cookie: ADMIN } })).status, 404);
});

test("backups: admins make, list and download them; the daily job keeps 30", async () => {
  await db("set", { path: "sites/cafe/days/2026-10-02", data: { date: "2026-10-02", problems: { text: "Backed up" } } });
  assert.equal((await admin("POST", "backups", undefined, STAFF)).status, 403, "staff can't make backups");
  const made = await admin("POST", "backups");
  assert.equal(made.status, 200);
  assert.ok(made.body.backup.docs >= 1 && made.body.backup.bytes > 0);
  const list = await admin("GET", "backups");
  assert.equal(list.body.backups[0].id, made.body.backup.id);
  assert.equal(list.body.keep, 30);
  const dl = await fetch(`${srv.base}/api/admin/backups/${made.body.backup.id}`, { headers: { cookie: ADMIN } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition"), /attachment; filename="kitchen-diary-backup-/);
  const backup = await dl.json();
  assert.equal(backup.kind, "strangers-kitchen-diary-backup");
  assert.deepEqual(backup.docs.find((d) => d.path === "sites/cafe/days/2026-10-02").data.problems, { text: "Backed up" });
  assert.ok(backup.users.some((u) => u.username === "alex"));
  assert.ok(!JSON.stringify(backup).includes("pin_hash") && !JSON.stringify(backup.users).includes("hash"), "no password hashes");
  assert.equal((await fetch(`${srv.base}/api/admin/backups/2000-01-01T00-00-00Z`, { headers: { cookie: ADMIN } })).status, 404);

  // The nightly run (the cron in wrangler.jsonc) makes one too.
  await new Promise((r) => setTimeout(r, 1100)); // backups are named to the second
  assert.equal((await fetch(`${srv.base}/__scheduled?cron=17+3+*+*+*`)).status, 200);
  let nightly;
  for (let i = 0; i < 20 && !nightly; i++) {
    nightly = (await admin("GET", "backups")).body.backups.find((b) => b.by === "daily");
    if (!nightly) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(nightly, "the scheduled run made a backup");
});

test("quick switching: a 4-digit PIN works only on a device signed in with a password", async () => {
  // Jo (staff) signs in with a password: that marks this "device" as trusted.
  assert.equal((await admin("POST", "users", { name: "Jo Quick", username: "jo.quick", role: "staff", password: "temp-pass-1" })).status, 200);
  await firstSignIn("jo.quick", "temp-pass-1", "jo-own-pass");
  const r = await postJson("/api/auth/login", { username: "jo.quick", password: "jo-own-pass" });
  const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const device = cookies.find((c) => c.startsWith("sfbb_device="));
  assert.ok(device, "a password sign-in marks the device");
  const session = cookies.find((c) => c.startsWith("sfbb_session="));
  const auth = (route, body, cookie) => fetch(`${srv.base}/api/auth/${route}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  assert.equal((await auth("pin", { pin: "12a4" }, session)).status, 400);
  assert.equal((await auth("pin", { pin: "1111" }, session)).status, 400, "repeated digits refused");
  assert.equal((await auth("pin", { pin: "4826" }, session)).status, 200);
  assert.equal((await auth("pin", { pin: "4826" }, ADMIN)).status, 403, "admins don't get a quick PIN");
  const me = await (await auth("me", undefined, `${session}; ${device}`)).json();
  assert.equal(me.user.quickPin, true);
  assert.equal(me.quickSwitch, true);

  // Signed out, on the trusted device: the list shows Alex; elsewhere it's empty.
  assert.deepEqual((await (await auth("people", undefined, device)).json()).people.map((p) => p.name), ["Jo Quick"]);
  assert.deepEqual((await (await auth("people")).json()).people, []);
  const joId = (await (await auth("people", undefined, device)).json()).people[0].id;
  assert.equal((await auth("switch", { id: joId, pin: "4826" })).status, 403, "no switching from an unknown device");

  const wrong = await auth("switch", { id: joId, pin: "0000" }, device);
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).message, /4 tries left/);
  const ok = await auth("switch", { id: joId, pin: "4826" }, device);
  assert.equal(ok.status, 200);
  const switched = ok.headers.get("set-cookie").split(";")[0];
  assert.equal((await (await auth("me", undefined, switched)).json()).user.name, "Jo Quick");

  // Five wrong PINs lock the account; an admin password reset clears the PIN.
  for (let i = 0; i < 4; i++) await auth("switch", { id: joId, pin: "0000" }, device);
  assert.equal((await auth("switch", { id: joId, pin: "0000" }, device)).status, 423);
  assert.equal((await auth("switch", { id: joId, pin: "4826" }, device)).status, 423, "locked even with the right PIN");
  const people = (await admin("GET", "users")).body.users;
  const jo = people.find((u) => u.username === "jo.quick");
  assert.equal(jo.quickPin, true);
  await admin("PATCH", `users/${jo.id}`, { unlock: true });
  assert.equal((await auth("switch", { id: joId, pin: "4826" }, device)).status, 200, "unlock works for PINs too");
  await admin("PATCH", `users/${jo.id}`, { password: "generate" });
  assert.equal((await admin("GET", "users")).body.users.find((u) => u.username === "jo.quick").quickPin, false, "a password reset clears the PIN");
  assert.equal((await auth("switch", { id: joId, pin: "4826" }, device)).status, 404);
});

test("writes are rate limited per IP", async () => {
  let last;
  for (let i = 0; i < 90; i++) {
    last = await db("set", { path: `sites/asg/extras/r${i}`, data: { name: "x" } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "rate_limited");
  assert.equal((await db("get", { path: "sites/asg/extras/r0" })).status, 200, "reads still work");
});
