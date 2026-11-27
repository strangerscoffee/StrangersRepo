import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_CODE } from "./harness.mjs";
import { startPasskeyServer } from "./passkeys-fixture.mjs";

const PASSKEYS = "/api/auth/passkeys";
const OWNER_PASSWORD = "owner-password-1";
const STAFF_PASSWORD = "staff-password-1";
const TEMP_PASSWORD = "staff-temporary-1";
let srv, origin, owner, staff, staffId;

async function request(path, { method = "GET", body, cookie, from = origin, host = origin } = {}) {
  const response = await fetch(host + path, {
    method,
    headers: {
      ...(from ? { origin: from } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

function session(response) {
  const cookie = response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value))?.split(";")[0];
  assert.ok(cookie, "login issues a staff session");
  return cookie;
}

function assertStatus(result, status) {
  assert.equal(result.response.status, status, JSON.stringify(result.data));
}

before(async () => {
  srv = await startPasskeyServer();
  origin = srv.origin;
  const setup = await request("/api/auth/setup", {
    method: "POST", body: { name: "Owner Example", username: "owner", password: OWNER_PASSWORD, code: SETUP_CODE },
  });
  assertStatus(setup, 200);
  owner = session(setup.response);

  const add = await request("/api/admin/users", {
    method: "POST", cookie: owner, body: { name: "Staff Example", username: "staffer", role: "staff", password: TEMP_PASSWORD },
  });
  assertStatus(add, 200);
  staffId = add.data.user.id;

  const change = await request("/api/auth/change", {
    method: "POST", body: { username: "staffer", password: TEMP_PASSWORD, newPassword: STAFF_PASSWORD },
  });
  assertStatus(change, 200);
  staff = session(change.response);
});

after(async () => { await srv?.stop(); });

test("only an eligible session can open its passkey settings or begin enrollment", async () => {
  const anonymous = await request(PASSKEYS);
  assertStatus(anonymous, 401);
  const listed = await request(PASSKEYS, { cookie: staff });
  assertStatus(listed, 200);
  assert.deepEqual(listed.data, { passkeys: [] });

  const enrollment = PASSKEYS + "/register/options";
  const body = { password: STAFF_PASSWORD, name: "Personal device" };
  assertStatus(await request(enrollment, { method: "POST", body }), 401);
  assertStatus(await request(enrollment, { method: "POST", cookie: staff, body, from: "https://other.example.test" }), 403);
  assertStatus(await request(enrollment, { method: "POST", cookie: staff, body: { ...body, password: "wrong-password" } }), 401);

  const valid = await request(enrollment, { method: "POST", cookie: staff, body });
  assertStatus(valid, 200);
  assert.ok(valid.data.challengeId);
  assert.equal(valid.data.options.rp.id, "localhost");
  assert.equal(valid.data.options.authenticatorSelection.residentKey, "required");
  assert.equal(valid.data.options.authenticatorSelection.userVerification, "required");
  assert.notEqual(valid.data.options.user.id, "staffer");
  assert.equal(valid.response.headers.getSetCookie().some((value) => value.startsWith("sfbb_session=")), false);

  const ownerList = await request(PASSKEYS, { cookie: owner });
  assert.deepEqual(ownerList.data, { passkeys: [] });
});

test("staff passkey sign-in offers discoverable credentials only on an allowed origin", async () => {
  const path = PASSKEYS + "/login/options";
  const begin = () => request(path, { method: "POST", body: {} });
  const first = await begin();
  const second = await begin();
  assertStatus(first, 200);
  assertStatus(second, 200);
  assert.notEqual(first.data.challengeId, second.data.challengeId);
  assert.notEqual(first.data.options.challenge, second.data.options.challenge);
  assert.equal(first.data.options.rpId, "localhost");
  assert.equal(first.data.options.userVerification, "required");
  assert.deepEqual(first.data.options.allowCredentials ?? [], []);
  const flowCookie = first.response.headers.getSetCookie().find((value) => value.includes("passkey"));
  assert.ok(flowCookie, "the challenge is bound to a browser flow");
  assert.match(flowCookie, new RegExp("^__Host-staff-passkey-" + first.data.challengeId + "="));
  const secondFlow = second.response.headers.getSetCookie().find((value) => value.includes("passkey"));
  assert.match(secondFlow, new RegExp("^__Host-staff-passkey-" + second.data.challengeId + "="));
  assert.match(flowCookie, /HttpOnly/i);
  assert.match(flowCookie, /Secure/i);
  assert.match(flowCookie, /SameSite=Strict/i);
  assert.doesNotMatch(flowCookie, /Domain=/i);
  assertStatus(await request(path, { method: "POST", body: {}, from: "https://other.example.test" }), 403);
  assertStatus(await request(path, { method: "POST", body: {}, from: srv.base, host: srv.base }), 404);
});

test("a registration challenge is bound to the original account and role", async () => {
  const options = await request(PASSKEYS + "/register/options", {
    method: "POST", cookie: staff, body: { password: STAFF_PASSWORD },
  });
  assertStatus(options, 200);
  const verify = (cookie) => request(PASSKEYS + "/register/verify", {
    method: "POST", cookie, body: { challengeId: options.data.challengeId, credential: {} },
  });
  const foreign = await verify(owner);
  assertStatus(foreign, 400);
  assert.equal(foreign.data.code, "passkey_expired");

  assertStatus(await request("/api/admin/users/" + staffId, { method: "PATCH", cookie: owner, body: { role: "manager" } }), 200);
  const afterRoleChange = await verify(staff);
  assertStatus(afterRoleChange, 400);
  assert.equal(afterRoleChange.data.code, "passkey_expired");
});
