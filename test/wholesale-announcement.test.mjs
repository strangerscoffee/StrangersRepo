// The wholesale ordering page's announcement bar (src/wholesaleAnnouncement.ts): admins set a heading, message,
// style and optional dates; customers get it in their session only while it's on and today is within its dates;
// every save gives it a new key (so a closed bar comes back with a new message); checked and version-guarded.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, STAFF;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const ukDay = (ms) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date(ms));
const today = ukDay(Date.now()), tomorrow = ukDay(Date.now() + 864e5), yesterday = ukDay(Date.now() - 864e5);
const shown = async () => (await call("GET", "/api/wholesale/session", undefined, A)).body.announcement;

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "lune.cafe", password: "lune-cafe-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Lune", contact: "Mia", email: "mia@lune.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  await call("POST", "/api/admin/users", { name: "Pat", username: "pat", role: "staff", password: "temporary-password" });
  STAFF = (await call("POST", "/api/auth/change", { username: "pat", password: "temporary-password", newPassword: "pat-own-password" }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("off until an admin switches it on; then customers see it, with a key that changes on every save", async () => {
  const start = (await call("GET", "/api/admin/wholesale/announcement")).body;
  assert.deepEqual([start.enabled, start.message, start.version, start.showing], [false, "", 0, false]);
  assert.equal(await shown(), null);
  const message = "Last dispatch before Christmas: Friday 19 December.\nWe reopen on Monday 5 January.";
  const saved = await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: 0, enabled: true, title: "Christmas dispatch dates", message, tone: "important" });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.showing, true);
  const a = await shown();
  assert.deepEqual({ ...a, key: undefined }, { title: "Christmas dispatch dates", message, tone: "important", until: "", key: undefined });
  const again = await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: saved.body.version, enabled: true, title: "", message: "Closed Boxing Day.", tone: "info" });
  assert.notEqual((await shown()).key, a.key, "a new message shows again to anyone who closed the old one");
  assert.equal((await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: saved.body.version, enabled: false })).status, 409, "an older copy can't overwrite it");
  await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: again.body.version, enabled: false, message: "Closed Boxing Day." });
  assert.equal(await shown(), null, "switched off");
  // The catalogue carries it too (the ordering page's first load).
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, A)).body.announcement, null);
});

test("dates: shown only from the start day to the end of the end day (UK)", async () => {
  let v = (await call("GET", "/api/admin/wholesale/announcement")).body.version;
  const put = async (fields) => { const r = await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: v, enabled: true, message: "Dates test", ...fields }); assert.equal(r.status, 200, r.text); v = r.body.version; return r.body; };
  assert.equal((await put({ from: tomorrow })).showing, false); assert.equal(await shown(), null, "not yet");
  assert.equal((await put({ until: yesterday })).showing, false); assert.equal(await shown(), null, "over");
  assert.equal((await put({ from: today, until: today })).showing, true); assert.equal((await shown()).until, today, "today only");
});

test("checks: a message when on, sensible dates and lengths, Information or Important; admins only", async () => {
  const v = (await call("GET", "/api/admin/wholesale/announcement")).body.version;
  for (const bad of [{ enabled: true, message: "" }, { enabled: true, message: "x", from: "2026-12-20", until: "2026-12-01" }, { enabled: true, message: "x", from: "20 Dec" }, { enabled: true, message: "x".repeat(501) }, { enabled: true, message: "x", title: "y".repeat(81) }, { enabled: true, message: "x", tone: "red" }, { enabled: "yes", message: "x" }, { message: "x" }]) {
    assert.equal((await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: v, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("PUT", "/api/admin/wholesale/announcement", { enabled: false })).status, 400, "needs ifVersion");
  for (const cookie of [STAFF, A, null]) {
    assert.ok([401, 403].includes((await call("GET", "/api/admin/wholesale/announcement", undefined, cookie)).status));
    assert.ok([401, 403].includes((await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: v, enabled: false }, cookie)).status));
  }
  // The message is plain text: anything that looks like HTML is kept as text for the page to show safely.
  const r = await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: v, enabled: true, message: "<b>Hi</b> & welcome" });
  assert.equal(r.status, 200); assert.equal((await shown()).message, "<b>Hi</b> & welcome");
});
