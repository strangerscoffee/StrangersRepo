// Wholesale "Forgotten your password or username?" (src/wholesaleReset.ts): a one-time link, by username or the
// business's order or accounts email, emailed (to a stand-in for Resend) only to the address on file; the same answer
// whether or not anything matched; the link shows the username, works once, for an hour, and ending it signs the
// customer in and every other session out; rate limits; and the contact address for the sign-in page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN, headers = {}) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (sent.length < n && Date.now() < end) await wait(100); await wait(300); return sent.length; }
const take = () => sent.splice(0, sent.length);
const tokenOf = (mail) => /reset=([a-f0-9]+)/.exec(mail.text)[1];
const forgot = (identifier, ip = "10.0.0.1") => call("POST", "/api/wholesale/auth/forgot", { identifier }, null, { "cf-connecting-ip": ip });
const login = (username, password) => call("POST", "/api/wholesale/auth/login", { username, password }, null);

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 3000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  for (const [username, business, email, accountsEmail] of [["lune.cafe", "Café Lune", "orders@lune.example", "accounts@lune.example"], ["pending.shop", "Pending Shop", "hi@pending.example", ""]]) {
    assert.equal((await call("POST", "/api/wholesale/auth/register", { username, password: "first-password", business, contact: "Mia Lune", email, accountsEmail }, null)).status, 201);
  }
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((a) => a.username === "lune.cafe");
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: "lune.cafe", ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
});
after(async () => { await srv?.stop(); mock?.close(); });

test("the same answer whether or not anything matches; links go only to the business's address on file", async () => {
  const answers = [];
  for (const id of ["lune.cafe", "nobody.here", "someone@else.example", "pending.shop", "hi@pending.example", "Orders@Lune.example "]) {
    const r = await forgot(id, "10.0.0." + answers.length);
    assert.equal(r.status, 200, r.text);
    answers.push(r.body.message);
  }
  assert.equal(new Set(answers).size, 1, "no way to tell which matched");
  assert.match(answers[0], /If that matches a wholesale account, we've emailed a link/);
  assert.equal(await settle(2), 2, "username and order email; not unknown or unapproved sign-ins");
  const mails = take();
  for (const m of mails) {
    assert.deepEqual(m.to, ["orders@lune.example"]);
    assert.equal(m.subject, "Reset your Strangers Coffee wholesale password");
    assert.match(m.text, /Your username: lune\.cafe/);
    assert.match(m.text, /\/wholesale-preview\/signin\?reset=[a-f0-9]{64}/);
    assert.match(m.text, /lasts an hour/);
  }
  // The accounts email gets its own link, at that address.
  await forgot("accounts@lune.example", "10.0.1.1");
  assert.equal(await settle(1), 1);
  assert.deepEqual(take()[0].to, ["accounts@lune.example"]);
  // Only the hash is kept.
  const rows = srv.sql("SELECT hash FROM wholesale_resets");
  assert.ok(rows.length >= 3 && rows.every((r) => /^[a-f0-9]{64}$/.test(r.hash)));
});

test("the link shows who it's for, sets the password once, signs in and ends other sessions; older links stop working", async () => {
  srv.sql("DELETE FROM wholesale_resets"); // the first test used up this hour's three emails
  const before = await login("lune.cafe", "first-password");
  assert.equal(before.status, 200);
  await forgot("lune.cafe", "10.0.2.1"); await settle(1);
  const older = tokenOf(take()[0]);
  await wait(50);
  await forgot("lune.cafe", "10.0.2.2"); await settle(1);
  const token = tokenOf(take()[0]);
  assert.equal((await call("GET", `/api/wholesale/auth/reset?token=${older}`, undefined, null)).body.code, "reset_used", "a newer link replaces it");
  const info = await call("GET", `/api/wholesale/auth/reset?token=${token}`, undefined, null);
  assert.deepEqual(info.body, { username: "lune.cafe", business: "Café Lune" });
  assert.equal((await call("POST", "/api/wholesale/auth/reset", { token, password: "short" }, null)).status, 400);
  const done = await call("POST", "/api/wholesale/auth/reset", { token, password: "brand-new-password" }, null);
  assert.equal(done.status, 200, done.text);
  assert.ok(done.cookie, "signed in");
  assert.equal((await call("GET", "/api/wholesale/session", undefined, done.cookie)).status, 200);
  assert.equal((await call("GET", "/api/wholesale/session", undefined, before.cookie)).status, 401, "other sessions end");
  assert.equal((await login("lune.cafe", "first-password")).status, 401);
  assert.equal((await login("lune.cafe", "brand-new-password")).status, 200);
  assert.equal((await call("POST", "/api/wholesale/auth/reset", { token, password: "another-password-1" }, null)).body.code, "reset_used", "works once");
  assert.equal((await call("GET", "/api/wholesale/auth/reset?token=" + "ab".repeat(32), undefined, null)).body.code, "reset_invalid");
  assert.equal((await call("GET", "/api/wholesale/auth/reset?token=nonsense", undefined, null)).status, 404);
  // An hour later it has run out.
  await forgot("lune.cafe", "10.0.2.3"); await settle(1);
  const late = tokenOf(take()[0]);
  srv.sql("UPDATE wholesale_resets SET expires_at = 1 WHERE used_at IS NULL");
  assert.equal((await call("GET", `/api/wholesale/auth/reset?token=${late}`, undefined, null)).body.code, "reset_expired");
  // A locked account is unlocked by a reset.
  for (let i = 0; i < 5; i++) await login("lune.cafe", "wrong-password-x");
  assert.equal((await login("lune.cafe", "brand-new-password")).status, 423);
  srv.sql("DELETE FROM wholesale_resets");
  await forgot("lune.cafe", "10.0.2.4"); await settle(1);
  assert.equal((await call("POST", "/api/wholesale/auth/reset", { token: tokenOf(take()[0]), password: "after-the-lock-1" }, null)).status, 200);
  assert.equal((await login("lune.cafe", "after-the-lock-1")).status, 200);
});

test("rate limits: 5 requests an hour from one address, 3 emails an hour for one sign-in; the contact address", async () => {
  srv.sql("DELETE FROM wholesale_resets"); take();
  for (let i = 0; i < 5; i++) assert.equal((await forgot("lune.cafe", "10.0.3." + i)).status, 200);
  assert.equal(await settle(3, 3000), 3, "three emails an hour for one sign-in");
  for (let i = 0; i < 5; i++) await forgot("nobody-" + i, "10.0.4.1");
  assert.equal((await forgot("nobody-x", "10.0.4.1")).status, 429);
  assert.deepEqual((await call("GET", "/api/wholesale/auth/contact", undefined, null)).body, { email: "sales@strangerscoffee.com" });
  assert.equal((await call("POST", "/api/wholesale/auth/forgot", { identifier: "" }, null, { "cf-connecting-ip": "10.0.5.1" })).status, 400);
});
