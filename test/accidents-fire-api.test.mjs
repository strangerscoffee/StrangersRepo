// The accident book (private: admins and whoever recorded an entry) and the fire safety log (a shared business
// record staff keep). Local fixtures only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, MANAGER;
const PREFIXES = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function request(method, path, body, cookie = ADMIN) {
  const headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) };
  const response = await fetch(srv.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
const db = (op, body, cookie = ADMIN) => request("POST", "/api/db/" + op, body, cookie);
async function account(name, username, role = "staff") {
  const created = await request("POST", "/api/admin/users", { name, username, role, password: "temporary-private-password" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const password = username + "-private-password";
  const login = await request("POST", "/api/auth/change", { username, password: "temporary-private-password", newPassword: password }, null);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.cookie);
  return { id: created.body.user.id, name, username, password, cookie: login.cookie };
}
async function put(path, data, cookie = ADMIN, ifVersion) {
  const result = await db("set", { path, data, ...(ifVersion === undefined ? {} : { ifVersion }) }, cookie);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body.ver;
}
async function get(path, cookie = ADMIN) {
  const result = await db("get", { path }, cookie);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}
function hidden(document, label) {
  assert.equal(document.exists, false, label);
  assert.equal(document.data, undefined, label + ": no private data");
  assert.equal(document.ver, 0, label + ": no private record version");
  if ("docVer" in document) assert.equal(document.docVer, 0, label + ": no private poll version");
}
function denied(result, label) {
  assert.equal(result.status, 403, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.code, "permission_denied", label);
  assert.equal(result.body.current, undefined, label + ": permission refusal cannot include the current private document");
}

const accident = (extra = {}) => ({ date: "2026-11-10", time: "10:15", place: "Basement stairs", person: "Injured Person", personType: "Customer", what: "ACCIDENT_SECRET slipped on the stairs", injury: "Bruised knee", hospital: "No", timeOff: "None", riddor: "Not reportable", at: 1, ...extra });

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  const setup = await request("POST", "/api/auth/setup", { name: "Privacy Admin", username: "privacy.admin", password: "privacy-admin-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie;
  A = await account("Accident Alice", "accident.alice");
  B = await account("Accident Bob", "accident.bob");
  MANAGER = await account("Accident Manager", "accident.manager", "manager");
});
after(async () => { await srv?.stop(); });

test("an accident entry is seen only by whoever recorded it and admins, on every site", async () => {
  for (const prefix of PREFIXES) {
    const col = prefix + "accidents";
    // Staff record an entry, owned by their own account: naming someone else as its owner is refused.
    denied(await db("set", { path: col + "/forged", data: accident({ ownerUserId: B.id }) }, A.cookie), `${prefix}: a forged owner`);
    await put(col + "/alice", accident({ by: "web:Accident Alice" }), A.cookie);
    const own = await get(col + "/alice", A.cookie);
    assert.equal(own.exists, true); assert.equal(own.data.ownerUserId, A.id, "owned by the recorder");
    for (const [who, person] of [["another member of staff", B], ["a manager", MANAGER]]) {
      hidden(await get(col + "/alice", person.cookie), `${prefix}: ${who} can't read it`);
      const listed = await db("query", { path: col }, person.cookie);
      assert.equal(listed.status, 200); assert.equal(listed.body.docs.length, 0, `${prefix}: ${who} lists nothing`);
      assert.ok(!JSON.stringify(listed.body).includes("ACCIDENT_SECRET"));
      const polled = await db("poll", { queries: [{ key: "list", kind: "col", path: col }, { key: "doc", kind: "doc", path: col + "/alice" }] }, person.cookie);
      assert.equal(polled.status, 200); assert.ok(!JSON.stringify(polled.body).includes("ACCIDENT_SECRET"), `${prefix}: ${who} polls nothing`);
      denied(await db("update", { path: col + "/alice", patch: { injury: "changed" } }, person.cookie), `${prefix}: ${who} can't change it`);
    }
    const adminList = await db("query", { path: col }, ADMIN);
    assert.deepEqual(adminList.body.docs.map((d) => d.id), ["alice"], "admins see every entry");
    // The recorder can correct their entry but not remove it (kept for 3 years); an admin can.
    assert.equal((await db("update", { path: col + "/alice", patch: { action: "Anti-slip strip fitted" } }, A.cookie)).status, 200);
    denied(await db("delete", { path: col + "/alice" }, A.cookie), `${prefix}: the recorder can't delete`);
    denied(await db("delete", { path: col + "/alice" }, MANAGER.cookie), `${prefix}: a manager can't delete`);
    assert.equal((await db("delete", { path: col + "/alice" }, ADMIN)).status, 200);
  }
});

test("accident entries are checked like other records", async () => {
  const bad = await db("set", { path: "accidents/bad", data: accident({ date: "10/11/2026" }) }, A.cookie);
  assert.equal(bad.status, 400); assert.equal(bad.body.code, "invalid_data");
});

test("the fire safety log: staff add checks and tick them done; every site's checks are in the summary", async () => {
  for (const prefix of PREFIXES) {
    await put(prefix + "fire/alarm", { name: "Fire alarm test", how: "Different call point", freq: "weekly", who: "Duty manager", createdAt: 1, log: [] }, A.cookie);
    const done = await db("update", { path: prefix + "fire/alarm", patch: { lastAt: { $op: "max", value: Date.now() }, lastBy: "web:Accident Alice", log: { $op: "prepend", items: [{ at: Date.now(), by: "web:Accident Alice", note: "Call point 2" }], key: "at", order: "desc", max: 30 } } }, A.cookie);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const seen = await get(prefix + "fire/alarm", B.cookie);
    assert.equal(seen.data.log[0].note, "Call point 2", "a shared business record");
  }
  const today = new Date().toISOString().slice(0, 10);
  const summary = await db("poll", { queries: [{ key: "sum", kind: "summary", from: today, to: today }] }, B.cookie);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  for (const site of ["roastery", "cafe", "asg", "factory"]) assert.equal(summary.body.results.sum.summary[site].fire[0].name, "Fire alarm test", site);
  assert.equal(summary.body.results.sum.summary.cafe.fire[0].log, undefined, "without its log");
});
