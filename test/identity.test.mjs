// Shared-device requests must stay bound to the immutable identity that reviewed the data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, admin, alice, bob;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function request(path, { method = "GET", body, cookie = admin, expected } = {}) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...expected }, body: body && JSON.stringify(body) });
  return { status: response.status, body: await response.json(), response };
}
async function employee(name, username, role) {
  const created = await request("/api/admin/users", { method: "POST", body: { name, username, role, password: "temporary-pass" } });
  assert.equal(created.status, 200);
  const login = await request("/api/auth/change", { method: "POST", cookie: "", body: { username, password: "temporary-pass", newPassword: username + "-own-password" } });
  assert.equal(login.status, 200);
  return { ...created.body.user, cookie: cookieOf(login.response) };
}
before(async () => {
  srv = await startServer();
  const setup = await request("/api/auth/setup", { method: "POST", cookie: "", body: { name: "Identity Owner", username: "identity.owner", password: "owner-password", code: SETUP_CODE } });
  admin = cookieOf(setup.response);
  alice = await employee("Identity Alice", "identity.alice", "staff");
  bob = await employee("Identity Bob", "identity.bob", "manager");
  assert.equal((await request("/api/db/set", { method: "POST", body: { path: "staff/alice-private", data: { name: alice.name, ownerUserId: alice.id, notes: "Alice private training note", topics: {} } } })).status, 200);
});
after(async () => { await srv?.stop(); });

test("GET identity reads never set or restore session/device cookies", async () => {
  for (const cookie of [admin, alice.cookie, bob.cookie, ""]) {
    const result = await request("/api/auth/me", { cookie });
    assert.equal(result.status, 200);
    assert.deepEqual(result.response.headers.getSetCookie(), [], "only explicit sign-in/change/switch/logout may change cookies");
  }
});

test("expected immutable identity and role reject stale reads and writes before private/conflict data", async () => {
  const expected = { "x-expected-user-id": alice.id, "x-expected-user-role": "staff" };
  for (const [path, body] of [
    ["/api/db/get", { path: "staff/alice-private" }],
    ["/api/db/update", { path: "staff/alice-private", patch: { notes: "stale edit" }, ifVersion: -1 }],
    ["/api/admin/people", undefined],
    ["/api/rota/me", undefined],
  ]) {
    const result = await request(path, { method: body ? "POST" : "GET", body, cookie: bob.cookie, expected });
    assert.equal(result.status, 409, path);
    assert.equal(result.body.code, "session_changed");
    assert.deepEqual(Object.keys(result.body).sort(), ["code", "message"]);
    assert.ok(!JSON.stringify(result.body).includes("Alice private training note"));
  }
  const own = await request("/api/db/get", { method: "POST", cookie: alice.cookie, expected, body: { path: "staff/alice-private" } });
  assert.equal(own.status, 200);
  assert.equal(own.body.data.notes, "Alice private training note");
  assert.equal((await request("/api/admin/users/" + alice.id, { method: "PATCH", body: { role: "manager" } })).status, 200);
  assert.equal((await request("/api/db/get", { method: "POST", cookie: alice.cookie, expected, body: { path: "staff/alice-private" } })).body.code, "session_changed", "same account, changed role is stale too");
  assert.equal((await request("/api/rota/me", { cookie: "", expected })).status, 409);
  assert.equal((await request("/api/rota/me", { cookie: "" })).status, 401, "legacy clients retain normal authentication/ACL");
});

test("only admins get stable employee owner choices, including inactive accounts", async () => {
  const inactive = await employee("Former Employee", "identity.former", "staff");
  await request("/api/admin/users/" + inactive.id, { method: "PATCH", body: { active: false } });
  const choices = await request("/api/auth/team");
  assert.equal(choices.body.team.find((person) => person.userId === inactive.id).active, false);
  assert.equal(choices.body.team.find((person) => person.userId === alice.id).id, "web:" + alice.name);
  const directory = await request("/api/auth/team", { cookie: bob.cookie });
  assert.ok(!directory.body.team.some((person) => person.name === inactive.name));
  assert.ok(directory.body.team.every((person) => Object.keys(person).sort().join(",") === "id,name,role"));
});
