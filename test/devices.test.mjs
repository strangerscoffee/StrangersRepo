// Several devices at once (docs/runtime-api.md, "Changes from several devices"): versioned writes, list
// operations, live change counters for the rota and admin pages, and per-person write limits. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, MGR, ALEX, SAM;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN) {
  const h = {};
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const r = await fetch(srv.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}
const db = (op, body, cookie = MGR) => req("POST", "/api/db/" + op, body, cookie);
async function signUp(name, username, role) {
  assert.equal((await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" })).status, 200);
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  return cookieOf(c);
}

before(async () => {
  srv = await startServer({ writeLimit: 40 });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  SAM = await signUp("Sam Okafor", "sam", "staff");
  // The Cafe is set up in the diary, so it can have shifts.
  await db("set", { path: "sites/cafe/settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } }, ADMIN);
});
after(() => srv?.stop());

test("a save based on an older version is refused, not applied over the newer one", async () => {
  const path = "sites/cafe/suppliers/s1";
  const first = await db("set", { path, data: { name: "Easters", phone: "1" } });
  assert.equal(first.status, 200);
  const v1 = first.body.ver;
  assert.ok(v1 > 0, "a write returns the new version");
  // Device A saves from v1.
  const a = await db("set", { path, data: { name: "Easters", phone: "2" }, ifVersion: v1 });
  assert.equal(a.status, 200);
  // Device B, still on v1, saves too: refused, with what's there now.
  const b = await db("set", { path, data: { name: "Easters", phone: "3" }, ifVersion: v1 });
  assert.equal(b.status, 409);
  assert.equal(b.body.code, "conflict");
  assert.equal(b.body.current.data.phone, "2");
  assert.equal(b.body.current.ver, a.body.ver);
  // Having seen it, B saves from the new version.
  assert.equal((await db("set", { path, data: { name: "Easters", phone: "3" }, ifVersion: b.body.current.ver })).status, 200);
  // The same for update and delete.
  assert.equal((await db("update", { path, patch: { phone: "4" }, ifVersion: v1 })).status, 409);
  assert.equal((await db("delete", { path, ifVersion: v1 })).status, 409);
  assert.equal((await db("get", { path })).body.data.phone, "3");
  // ifVersion 0: only if it doesn't exist yet.
  assert.equal((await db("set", { path, data: { name: "x" }, ifVersion: 0 })).status, 409);
  assert.equal((await db("set", { path: "sites/cafe/suppliers/new1", data: { name: "New" }, ifVersion: 0 })).status, 200);
  // Writes without a version still work as before (last write wins for a whole document).
  assert.equal((await db("set", { path, data: { name: "Easters", phone: "5" } })).status, 200);
});

test("collections and polls report each document's version", async () => {
  const q = await db("query", { path: "sites/cafe/suppliers" });
  assert.ok(q.body.docs.every((d) => typeof d.ver === "number" && d.ver > 0));
  const p = await db("poll", { queries: [{ key: "a", kind: "doc", path: "sites/cafe/suppliers/s1" }, { key: "b", kind: "col", path: "sites/cafe/suppliers" }] });
  assert.ok(p.body.results.a.docVer > 0);
  assert.ok(p.body.results.b.docs.every((d) => d.ver > 0));
});

test("two devices adding to the same log at once both keep their entry", async () => {
  const path = "sites/cafe/cleaning/k1";
  await db("set", { path, data: { name: "Floors", log: [{ at: 1, by: "web:George Farrow" }] } });
  const add = (at, by, cookie) => db("update", { path, patch: { lastAt: { $op: "max", value: at }, log: { $op: "prepend", items: [{ at, by }], key: "at", order: "desc", max: 30 } } }, cookie);
  const results = await Promise.all([add(300, "web:Alex Brown", ALEX), add(200, "web:Sam Okafor", SAM), add(250, "web:George Farrow", MGR)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  const doc = (await db("get", { path })).body.data;
  assert.deepEqual(doc.log.map((e) => e.at), [300, 250, 200, 1], "every entry, newest first");
  assert.equal(doc.lastAt, 300, "the last-done time never goes backwards");
  // The same entry sent twice (an offline replay) is added once; removing takes out just that one.
  await add(300, "web:Alex Brown", ALEX);
  assert.equal((await db("get", { path })).body.data.log.length, 4);
  await db("update", { path, patch: { log: { $op: "remove", key: "at", values: [250] } } });
  assert.deepEqual((await db("get", { path })).body.data.log.map((e) => e.at), [300, 200, 1]);
});

test("list operations can't replace something that isn't a list", async () => {
  const day = "sites/cafe/days/2026-10-05";
  await db("set", { path: day, data: { temps: { u1: { am: { v: 3 } } } } });
  const r = await db("update", { path: day, patch: { temps: { $op: "remove", key: "at", values: [] } } }, ALEX);
  assert.equal(r.status, 400);
  assert.equal((await db("get", { path: day })).body.data.temps.u1.am.v, 3);
  assert.equal((await db("update", { path: day, patch: { temps: { $op: "explode" } } })).status, 400);
});

test("a change on one device moves the change counters other devices watch", async () => {
  const c0 = (await req("GET", "/api/changes", undefined, ALEX)).body;
  assert.equal(typeof c0.rota, "number");
  const shift = await req("POST", "/api/rota/shifts", { site: "cafe", day: "2030-01-08", start: "09:00", end: "13:00", breakMins: 0, job: "", userId: null }, MGR);
  assert.equal(shift.status, 200, shift.text);
  const c1 = (await req("GET", "/api/changes", undefined, ALEX)).body;
  assert.ok(c1.rota > c0.rota, "a rota write");
  await db("set", { path: "sites/cafe/suppliers/s9", data: { name: "x" } });
  assert.ok((await req("GET", "/api/changes", undefined, ALEX)).body.docs > c1.docs, "a diary write");
  const pat = await req("POST", "/api/admin/users", { name: "Pat Rename", username: "pat.rename", role: "staff", password: "temp-pass-1" });
  const c15 = (await req("GET", "/api/changes", undefined, ALEX)).body;
  await req("PATCH", `/api/admin/users/${pat.body.user.id}`, { name: "Pat Renamed" });
  const c2 = (await req("GET", "/api/changes", undefined, ALEX)).body;
  assert.ok(c2.accounts > c15.accounts && c2.rota > c15.rota, "an account change");
  assert.equal((await req("GET", "/api/changes", undefined, null)).status, 401, "signed in only");
});

test("two managers changing the same shift: the second, from an older copy, is refused", async () => {
  const s = (await req("POST", "/api/rota/shifts", { site: "cafe", day: "2030-01-09", start: "09:00", end: "13:00", breakMins: 0, job: "", userId: null }, MGR)).body.shift;
  assert.ok(s.updatedAt);
  const a = await req("PATCH", "/api/rota/shifts/" + s.id, { start: "08:00", ifUpdatedAt: s.updatedAt }, MGR);
  assert.equal(a.status, 200, a.text);
  await new Promise((r) => setTimeout(r, 5));
  const b = await req("PATCH", "/api/rota/shifts/" + s.id, { end: "17:00", ifUpdatedAt: s.updatedAt }, ADMIN);
  assert.equal(b.status, 409);
  assert.equal(b.body.code, "conflict");
  assert.equal(b.body.shift.start, "08:00", "with the shift as it is now");
});

test("write limits are per person, so a shop's devices on one Wi-Fi don't share one allowance", async () => {
  // writeLimit is 40 for this server: Alex uses up theirs; Sam, on the same address, still saves.
  let last;
  for (let i = 0; i < 45; i++) last = await db("update", { path: "sites/cafe/days/2026-10-06", patch: { notes: { text: String(i) } } }, ALEX);
  assert.equal(last.status, 429);
  assert.equal((await db("set", { path: "sites/cafe/days/2026-10-07", data: { notes: { text: "ok" } } }, SAM)).status, 200);
});
