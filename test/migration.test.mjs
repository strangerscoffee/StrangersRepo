// Upgrading a database from name + PIN accounts to username + password. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { startServer } from "./harness.mjs";

// The users table as it was when people signed in with name + PIN.
const salt = "0123456789abcdef0123456789abcdef";
const pinHash = "p3000:" + pbkdf2Sync("1234", salt, 3000, 32, "sha256").toString("hex");
const OLD = `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, session_ver INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_by TEXT,
  updated_at INTEGER NOT NULL, last_login_at INTEGER);
INSERT INTO users (id, name, name_key, role, pin_hash, pin_salt, created_at, updated_at)
  VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 'Sam Patel', 'sam patel', 'admin', '${pinHash}', '${salt}', 1, 1);
CREATE TABLE rota_shifts (id TEXT PRIMARY KEY, site TEXT NOT NULL, day TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  break_mins INTEGER NOT NULL DEFAULT 0, job TEXT NOT NULL DEFAULT '', user_id TEXT, note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE rota_sites (site TEXT PRIMARY KEY, opens_at TEXT, closes_at TEXT, min_people INTEGER NOT NULL DEFAULT 1);
CREATE TABLE rota_people (user_id TEXT PRIMARY KEY, contract_hours REAL, sites TEXT NOT NULL DEFAULT '[]', pattern TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
INSERT INTO rota_shifts VALUES ('s1', 'cafe', '2030-01-07', '07:00', '15:00', 30, 'opens', 'aaaaaaaaaaaaaaaaaaaaaaaa', '', 1, 'aaaaaaaaaaaaaaaaaaaaaaaa');
INSERT INTO rota_sites VALUES ('cafe', '07:00', '17:00', 2);
INSERT INTO rota_people VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 20, '[]', '{}', 1);`;

let srv;
before(async () => { srv = await startServer({ preSql: OLD }); });
after(async () => { await srv?.stop(); });

const post = (url, body) => fetch(srv.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PIN accounts get a username from their name and choose a password at next sign-in", async () => {
  const first = await post("/api/auth/login", { username: "sam.patel", password: "1234" });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { mustChange: true, name: "Sam Patel" });
  assert.equal(first.headers.get("set-cookie"), null, "not signed in until a password is chosen");

  const change = await post("/api/auth/change", { username: "sam.patel", password: "1234", newPassword: "a-real-password" });
  assert.equal(change.status, 200);
  const cookie = change.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  const me = await (await fetch(srv.base + "/api/auth/me", { headers: { cookie } })).json();
  assert.equal(me.user.name, "Sam Patel");
  assert.equal(me.user.role, "admin");

  assert.equal((await post("/api/auth/login", { username: "sam.patel", password: "1234" })).status, 401, "the old PIN stops working");
  const again = await post("/api/auth/login", { username: "sam.patel", password: "a-real-password" });
  assert.ok(again.headers.get("set-cookie"));
});

test("rota tables from before day-by-day hours, amended shifts and contract ranges are upgraded in place", async () => {
  const login = await post("/api/auth/login", { username: "sam.patel", password: "a-real-password" });
  const cookie = login.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  const w = await (await fetch(srv.base + "/api/rota/week?start=2030-01-07", { headers: { cookie } })).json();
  const me = w.people.find((p) => p.name === "Sam Patel");
  assert.deepEqual([me.contractMin, me.contractMax, me.contractHours], [20, 20, 20], "the old contract becomes both ends");
  assert.deepEqual([w.shifts[0].hours, w.shifts[0].adjusted, w.shifts[0].actualStart], [7.5, false, null]);
  const cafe = w.sites.find((s) => s.id === "cafe");
  assert.deepEqual([cafe.opensAt, cafe.minPeople, cafe.dayHours], ["07:00", 2, {}]);
});
