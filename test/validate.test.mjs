// Record shapes checked on the server (src/validate.ts): writes with the wrong kind of value for a known field are
// refused with 400 invalid_data; anything else (unknown fields, nulls, old records, partial updates) still saves.
// Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, ADMIN_ID;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function db(op, body) {
  const r = await fetch(srv.base + "/api/db/" + op, { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  srv = await startServer();
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  ADMIN_ID = (await (await fetch(srv.base + "/api/auth/me", { headers: { cookie: ADMIN } })).json()).user.id;
});
after(() => srv?.stop());

test("good records save, including unknown fields, nulls and readings typed as text", async () => {
  for (const [path, data] of [
    ["settings/main", { units: [], opening: [], closing: [], weekly: [], closedDays: [0], hide: {}, info: {}, startDate: "2026-01-01", newThing: 1 }],
    ["deliveries/d1", { date: "2026-11-05", at: 1, supplier: "Easters", chilled: "4.5", frozen: null, noTemp: false, outcome: "accepted" }],
    ["sites/cafe/cleaning/c1", { name: "Floors", freq: "daily", createdAt: 1, log: [], lastAt: null }],
    ["maintenance/m1", { title: "Tap", status: "open", log: [] }],
    ["proveit/p1", { date: "2026-11-05", reading: 75, pass: true }],
    ["staff/s1", { name: "Will Owner", ownerUserId: ADMIN_ID, topics: { hygiene: { date: "2026-01-01", by: "web:Will Owner" } }, sites: ["cafe"] }],
  ]) {
    const r = await db("set", { path, data });
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
  }
});

test("the wrong kind of value is refused with invalid_data and a message", async () => {
  for (const [path, data] of [
    ["deliveries/d2", { date: "5 Nov", supplier: "Easters" }],
    ["deliveries/d3", { chilled: "warm" }],
    ["sites/cafe/cleaning/c2", { name: "Floors", log: "done" }],
    ["maintenance/m2", { title: ["Tap"] }],
    ["staff/s2", { name: "Will Owner", ownerUserId: ADMIN_ID, sites: "cafe" }],
    ["settings/main", { closedDays: "Sunday" }],
  ]) {
    const r = await db("set", { path, data });
    assert.equal(r.status, 400, path);
    assert.equal(r.body.code, "invalid_data", path);
    assert.match(r.body.message, /couldn't be saved/);
  }
  assert.equal((await db("get", { path: "deliveries/d2" })).body.exists, false, "nothing was written");
});

test("an update checks only what it sends, so an old imperfect record isn't blocked", async () => {
  // An old record from before the check, with a wrong type, can still have other fields changed.
  const path = "maintenance/old1";
  await db("set", { path, data: { title: "Door", status: "open" } });
  assert.equal((await db("update", { path, patch: { status: "done", doneAt: 5 } })).status, 200);
  assert.equal((await db("update", { path, patch: { doneAt: "yesterday" } })).body.code, "invalid_data");
  // List operations still work.
  assert.equal((await db("update", { path, patch: { log: { $op: "prepend", items: [{ at: 9, what: "Done" }], key: "at", order: "desc", max: 30 } } })).status, 200);
});

test("day and week pages (set merges) are checked like updates", async () => {
  assert.equal((await db("set", { path: "days/2026-11-05", data: { temps: { u1: { am: { v: 3 } } } } })).status, 200);
  assert.equal((await db("set", { path: "days/2026-11-05", data: { closed: { reason: "Holiday" } } })).status, 200);
  assert.equal((await db("set", { path: "days/2026-11-05", data: { temps: "3" } })).body.code, "invalid_data");
  assert.equal((await db("set", { path: "weeks/2026-11-02", data: { items: [] } })).body.code, "invalid_data");
});
