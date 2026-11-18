// The private staff profile (src/profile.ts), primary sites and asking for cover being switched off (the owner's
// updates, 18 Nov 2026). Staff see and change only their own contact number, email and address; only admins set the
// start date and see everyone's; admins are told who changed which fields (never the new values) by email and on the
// Admin Overview. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, MGR, ALEX, SAM;
const ids = {};
const sent = [];
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}
async function person(name, username, role, email) {
  const r = await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1", ...(email ? { email } : {}) });
  assert.equal(r.status, 200, r.text);
  ids[username] = r.body.user.id;
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  return cookieOf(c);
}
async function waitFor(n, ms = 8000) {
  const end = Date.now() + ms;
  while (sent.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return sent.length;
}
const WEEK = "2030-01-07"; // a Monday well ahead

before(async () => {
  mock = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (d) => (b += d));
    rq.on("end", () => {
      try { sent.push(JSON.parse(b)); } catch {}
      rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "test-" + sent.length }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  ids.will = (await req("GET", "/api/auth/me")).body.user.id;
  assert.equal((await req("PATCH", `/api/admin/users/${ids.will}`, { email: "owner-admin@example.test" })).status, 200);
  MGR = await person("Giles Armstrong", "giles", "manager", "giles@example.test");
  ALEX = await person("Alex Brown", "alex", "staff", "alex@example.test");
  SAM = await person("Sam Okafor", "sam", "staff");
  for (const site of ["", "sites/cafe/", "sites/asg/"]) {
    assert.equal((await req("POST", "/api/db/set", { path: site + "settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } })).status, 200);
  }
});
after(async () => { await srv?.stop(); mock?.close(); });

test("staff see and change only their own contact details; the start date is the admin's", async () => {
  const mine = await req("GET", "/api/rota/me/profile", undefined, ALEX);
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.body.profile, { name: "Alex Brown", startDate: null, phone: "", email: "alex@example.test", address: "", version: 0 });

  // Only an admin sets the start date.
  assert.equal((await req("PATCH", `/api/admin/users/${ids.alex}`, { startDate: "2024-03-04" })).status, 200);
  const stale = await req("PUT", "/api/rota/me/profile", { ifVersion: 0, phone: "07700 900123" }, ALEX);
  assert.equal(stale.status, 409, "the admin's change moved the version on");
  let v = (await req("GET", "/api/rota/me/profile", undefined, ALEX)).body.profile;
  assert.equal(v.startDate, "2024-03-04");
  const denied = await req("PUT", "/api/rota/me/profile", { ifVersion: v.version, startDate: "2020-01-01" }, ALEX);
  assert.equal(denied.status, 403, denied.text);
  assert.equal(denied.body.code, "permission_denied");
  assert.equal((await req("PATCH", `/api/admin/users/${ids.alex}`, { startDate: "2020-01-01" }, ALEX)).status, 403, "staff can't use the admin route");
  assert.equal((await req("PATCH", `/api/admin/users/${ids.alex}`, { startDate: "2020-01-01" }, MGR)).status, 403, "nor can managers");

  // Bad values are refused.
  assert.equal((await req("PUT", "/api/rota/me/profile", { ifVersion: v.version, phone: "call me" }, ALEX)).status, 400);
  assert.equal((await req("PUT", "/api/rota/me/profile", { ifVersion: v.version, email: "not an email" }, ALEX)).status, 400);
  assert.equal((await req("PUT", "/api/rota/me/profile", { ifVersion: v.version, address: "x\n".repeat(8) }, ALEX)).status, 400);

  sent.length = 0;
  const saved = await req("PUT", "/api/rota/me/profile", { ifVersion: v.version, phone: "07700 900123", address: "1 Elm Hill\nNorwich\nNR3 1HN", email: "Alex.Brown@Example.test" }, ALEX);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body.changed, ["phone", "email", "address"]);
  assert.equal(saved.body.profile.email, "alex.brown@example.test", "kept lower-case");
  assert.equal(saved.body.profile.startDate, "2024-03-04", "unchanged");
  // Rota emails now go to the new address: it's the same one.
  assert.equal((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.address, "alex.brown@example.test");

  // The admin hears who changed which fields, never the new values; the manager and Alex don't.
  await waitFor(1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.length, 1, JSON.stringify(sent.map((m) => m.to)));
  assert.deepEqual(sent[0].to, ["owner-admin@example.test"]);
  const mail = JSON.stringify(sent[0]);
  assert.match(mail, /Alex Brown/);
  assert.match(mail, /contact number, contact email and home address/);
  assert.doesNotMatch(mail, /07700|Elm Hill|NR3|alex\.brown@/i, "the email names the fields, not the details");

  // …and on Admin → Activity and the Overview, until dismissed.
  const overview = (await req("GET", "/api/admin/overview")).body;
  const notice = overview.attention.find((a) => /Alex Brown updated their/.test(a.title));
  assert.ok(notice, JSON.stringify(overview.attention));
  assert.match(notice.dismiss, /^profile:\d+$/);
  assert.doesNotMatch(JSON.stringify(notice), /07700|Elm Hill/);
  assert.equal((await req("POST", "/api/admin/overview/dismiss", { key: notice.dismiss })).status, 200);
  assert.ok(!(await req("GET", "/api/admin/overview")).body.attention.some((a) => a.dismiss === notice.dismiss));
  const activity = (await req("GET", "/api/admin/activity?kind=all")).body;
  assert.match(JSON.stringify(activity), /Alex Brown updated their contact number, contact email and home address/);

  // Saving the same details again changes nothing and tells nobody.
  sent.length = 0;
  const again = await req("PUT", "/api/rota/me/profile", { ifVersion: saved.body.profile.version, phone: "07700 900123" }, ALEX);
  assert.deepEqual(again.body.changed, []);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 0);
});

test("nobody but the person and admins can read a profile", async () => {
  // Sam's own profile is Sam's, whatever is asked for.
  const sam = await req("GET", `/api/rota/me/profile?userId=${ids.alex}`, undefined, SAM);
  assert.equal(sam.status, 200);
  assert.equal(sam.body.profile.name, "Sam Okafor");
  assert.doesNotMatch(sam.text, /07700|Elm Hill|alex/i);
  // A PUT can only ever change your own.
  const v = sam.body.profile.version;
  assert.equal((await req("PUT", "/api/rota/me/profile", { ifVersion: v, userId: ids.alex, phone: "01603 000000" }, SAM)).status, 200);
  assert.equal((await req("GET", "/api/rota/me/profile", undefined, ALEX)).body.profile.phone, "07700 900123", "Alex's is untouched");
  // Admin-only lists and other routes never show it to staff or managers.
  for (const cookie of [SAM, MGR]) {
    assert.equal((await req("GET", "/api/admin/people", undefined, cookie)).status, 403);
    assert.equal((await req("GET", "/api/admin/export/people.csv", undefined, cookie)).status, 403);
    for (const path of ["/api/rota/me", `/api/rota/week?start=${WEEK}`, "/api/rota/team", "/api/auth/me", "/api/db/profiles"]) {
      const r = await req("GET", path, undefined, cookie);
      assert.doesNotMatch(r.text, /07700 900123|Elm Hill|NR3 1HN|2024-03-04/, `${path} keeps Alex's profile private`);
    }
  }
  // Admins see everyone's on People.
  const people = (await req("GET", "/api/admin/people")).body.people;
  assert.deepEqual(people.find((p) => p.id === ids.alex).profile, { startDate: "2024-03-04", phone: "07700 900123", address: "1 Elm Hill\nNorwich\nNR3 1HN" });
  // An admin's own edits are logged as theirs, and don't notify anyone.
  sent.length = 0;
  assert.equal((await req("PATCH", `/api/admin/users/${ids.sam}`, { phone: "01603 111222", address: "2 Ber Street" })).status, 200);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.sam}`, { phone: "nope" })).status, 400);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 0);
  assert.match(JSON.stringify((await req("GET", "/api/admin/activity?kind=all")).body), /Will Owner updated Sam Okafor's/);
});

test("a primary site plus other sites they can work at", async () => {
  const set = await req("PUT", `/api/rota/people/${ids.sam}`, { primarySite: "cafe", sites: ["cafe", "asg"] });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.body.primarySite, "cafe");
  assert.deepEqual(set.body.sites, ["asg"], "the primary site isn't kept twice");
  assert.equal((await req("PUT", `/api/rota/people/${ids.sam}`, { primarySite: "moon" })).status, 400);
  assert.equal((await req("PUT", `/api/rota/people/${ids.sam}`, { primarySite: "roastery" }, MGR)).status, 403, "admins only");
  assert.equal((await req("GET", "/api/rota/me", undefined, SAM)).body.primarySite, "cafe");
  const p = (await req("GET", "/api/admin/people")).body.people.find((x) => x.id === ids.sam);
  assert.equal(p.rota.primarySite, "cafe");
  assert.deepEqual(p.rota.sites, ["asg"]);
  // Shifts at the primary or other sites are fine; anywhere else is flagged.
  const at = async (site) => (await req("POST", "/api/rota/shifts?with=problems", { site, day: WEEK, start: "09:00", end: "13:00", breakMins: 0, job: "", userId: ids.sam })).body;
  for (const site of ["cafe", "asg"]) {
    const r = await at(site);
    assert.ok(!r.problems.some((x) => x.kind === "availability" && x.shiftIds.includes(r.shift.id)), site);
    await req("DELETE", "/api/rota/shifts/" + r.shift.id);
  }
  const off = await at("roastery");
  assert.ok(off.problems.some((x) => x.kind === "availability" && x.shiftIds.includes(off.shift.id) && /doesn't usually work at/.test(x.message)));
  await req("DELETE", "/api/rota/shifts/" + off.shift.id);
  // Clearing the primary site leaves the others.
  const cleared = await req("PUT", `/api/rota/people/${ids.sam}`, { primarySite: null });
  assert.equal(cleared.body.primarySite, null);
  assert.deepEqual(cleared.body.sites, ["asg"]);
});

test("staff and managers can't ask for cover any more; admins still can for their own shifts", async () => {
  const shift = (await req("POST", "/api/rota/shifts", { site: "cafe", day: "2030-01-08", start: "09:00", end: "13:00", breakMins: 0, job: "", userId: ids.alex })).body.shift;
  const pub = await req("POST", "/api/rota/week/publish", { week: WEEK });
  assert.equal(pub.status, 200, pub.text);
  for (const cookie of [ALEX, MGR]) {
    const r = await req("POST", "/api/rota/requests", { kind: "cover", shiftId: shift.id, message: "Can someone swap?" }, cookie);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.code, "permission_denied");
  }
  const own = (await req("POST", "/api/rota/shifts", { site: "cafe", day: "2030-01-09", start: "09:00", end: "13:00", breakMins: 0, job: "", userId: ids.will })).body.shift;
  const admin = await req("POST", "/api/rota/requests", { kind: "cover", shiftId: own.id, toUserId: ids.sam });
  assert.equal(admin.status, 200, admin.text);
});
