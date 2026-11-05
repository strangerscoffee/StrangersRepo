// Rota emails (src/email/), sent to a stand-in for Resend: who gets what when a week is published and published
// again after changes, the calendar file, unsubscribing, decisions, each person's settings, admin-only addresses and
// the admin's test email. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, MGR, ALEX, SAM, PAT, ids = {};
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
const london = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const monday = (d) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
const WEEK = addDays(monday(london()), 7);
async function waitFor(n, ms = 8000) {
  const end = Date.now() + ms;
  while (sent.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return sent.length;
}
const take = () => sent.splice(0, sent.length);

before(async () => {
  mock = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (d) => (b += d));
    rq.on("end", () => {
      try { sent.push({ auth: rq.headers.authorization, ...JSON.parse(b) }); } catch {}
      rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "test-" + sent.length }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await person("Giles Armstrong", "giles", "manager", "giles@example.com");
  ALEX = await person("Alex Brown", "alex", "staff", "Alex@Example.com");
  SAM = await person("Sam Okafor", "sam", "staff");
  PAT = await person("Pat Lee", "pat", "staff");
  assert.equal((await req("POST", "/api/db/set", { path: "settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } })).status, 200);
});
after(async () => { await srv?.stop(); mock?.close(); });

test("admins set email addresses; nobody else can, and bad ones are refused", async () => {
  assert.equal((await req("PATCH", `/api/admin/users/${ids.sam}`, { email: "sam@example.com" })).status, 200);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.pat}`, { email: "not an email" })).status, 400);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.sam}`, { email: "x@example.com" }, MGR)).status, 403, "managers can't");
  const people = (await req("GET", "/api/admin/people")).body.people;
  assert.equal(people.find((p) => p.id === ids.alex).email, "alex@example.com", "kept lower-case");
  assert.equal(people.find((p) => p.id === ids.pat).email, null);
  // Each person sees their own address read-only, and chooses which emails they get.
  const me = (await req("GET", "/api/rota/me", undefined, ALEX)).body.email;
  assert.equal(me.address, "alex@example.com");
  assert.deepEqual(me.prefs, { published: true, changed: true, requests: true, open: false });
  assert.equal(me.ready, true);
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { nonsense: true } }, ALEX)).status, 400);
});

test("publishing a week emails everyone on it: their own shifts, a calendar file and an unsubscribe link", async () => {
  const shift = (day, start, end, userId, job = "") => req("POST", "/api/rota/shifts", { site: "roastery", day, start, end, breakMins: 30, job, userId }, MGR);
  const a1 = await shift(WEEK, "07:30", "15:30", ids.alex, "opens");
  assert.equal(a1.status, 200, a1.text);
  ids.a1 = a1.body.shift.id;
  await shift(addDays(WEEK, 2), "09:00", "17:00", ids.alex, "closes");
  await shift(WEEK, "09:00", "13:00", ids.sam);
  await shift(addDays(WEEK, 3), "10:00", "14:00", ids.pat);
  await shift(addDays(WEEK, 4), "10:00", "14:00", null);
  const preview = (await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, MGR)).body;
  assert.deepEqual([preview.ready, preview.first, preview.people], [true, true, 3]);
  assert.deepEqual(preview.noAddress, ["Pat Lee"], "who has no address");
  assert.equal((await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, ALEX)).status, 403, "managers only");

  const pub = await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.body.emailed, 2);
  await waitFor(2);
  const mails = take();
  assert.equal(mails.length, 2);
  const alex = mails.find((m) => m.to[0] === "alex@example.com");
  assert.ok(alex, JSON.stringify(mails.map((m) => m.to)));
  assert.equal(alex.auth, "Bearer re_test_key");
  assert.equal(alex.from, "Strangers Rota <rota@staffstrangerscoffee.com>");
  assert.equal(alex.reply_to, "giles@example.com", "replies go to the manager who published");
  assert.match(alex.subject, /^Your shifts for the week of \d+ \w+$/);
  assert.match(alex.html, /Hi Alex, you(&#39;|')re on 2 days next week/);
  assert.match(alex.html, />07:30–15:30</);
  assert.match(alex.html, /Opens · with Sam/, "who they're working with");
  assert.doesNotMatch(alex.html, /Pat|Sam Okafor/, "nobody else's shifts or full names");
  assert.match(alex.text, /07:30–15:30 at the Roastery/);
  const ics = Buffer.from(alex.attachments[0].content, "base64").toString();
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*UID:shift-[\s\S]*SUMMARY:Strangers: Roastery \(opening\)/);
  // (Under wrangler dev the Worker sees the live address, so links name it; the tests swap in their own.)
  assert.match(alex.headers["List-Unsubscribe"], /^<https:\/\/staffstrangerscoffee\.com\/email\/unsubscribe\?t=[\w-]+\.[\w-]+>$/);
  assert.equal(alex.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.ok(mails.some((m) => m.to[0] === "sam@example.com"));
  // Logged in the admin section's activity.
  const items = (await req("GET", "/api/admin/activity?kind=account")).body.items;
  assert.ok(items.some((i) => /^Emailed Alex Brown: the week of/.test(i.text) && i.where === "Rota emails"), JSON.stringify(items.slice(0, 5)));
});

test("publishing changes emails only the people whose shifts changed, with what changed", async () => {
  assert.equal((await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:00" }, MGR)).status, 200);
  const preview = (await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, MGR)).body;
  assert.deepEqual([preview.first, preview.people], [false, 1]);
  const pub = await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR);
  assert.equal(pub.body.emailed, 1);
  await waitFor(1);
  const [m] = take();
  assert.equal(m.to[0], "alex@example.com");
  assert.match(m.subject, /^Your shift on \w+ \d+ \w+ has changed$/);
  assert.match(m.html, /Giles Armstrong changed your shifts/);
  assert.match(m.html, /was 07:30–15:30/);
  // Nothing changed since: nobody to email.
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR)).body.emailed, 0);
  // Publishing without emailing sends nothing.
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:15" }, MGR);
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK }, MGR)).body.emailed, 0);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 0);
});

test("the unsubscribe link asks first, then turns that email off; without signing in", async () => {
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:30" }, MGR);
  await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR);
  await waitFor(1);
  const [m] = take();
  const link = m.headers["List-Unsubscribe"].slice(1, -1).replace("https://staffstrangerscoffee.com", srv.base);
  const page = await fetch(link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stop these emails\?[\s\S]*changes to your shifts/);
  assert.equal((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.prefs.changed, true, "opening the link changes nothing");
  // A mail app's one-tap unsubscribe.
  const t = new URL(link).searchParams.get("t");
  const one = await fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(one.status, 200);
  assert.deepEqual((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.prefs, { published: true, changed: false, requests: true, open: false });
  // No more change emails for Alex.
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:45" }, MGR);
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR)).body.emailed, 0);
  // A made-up or altered link does nothing.
  assert.equal((await fetch(srv.base + "/email/unsubscribe?t=" + t.slice(0, -2) + "xx")).status, 400);
  // Turning it back on in the rota.
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { changed: true } }, ALEX)).status, 200);
  assert.equal((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.prefs.changed, true);
});

test("time off and cover decisions are emailed to the people they're about", async () => {
  const off = await req("POST", "/api/rota/time-off", { from: addDays(WEEK, 14), to: addDays(WEEK, 15), reason: "Wedding" }, SAM);
  assert.equal(off.status, 200, off.text);
  assert.equal((await req("PATCH", `/api/rota/time-off/${off.body.id}`, { status: "approved" }, MGR)).status, 200);
  await waitFor(1);
  const [m] = take();
  assert.equal(m.to[0], "sam@example.com");
  assert.match(m.subject, /^Time off from .* approved$/);
  assert.match(m.html, /your time off was approved/);
  // Open shifts: only for those who turned them on, and are free.
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { open: true } }, SAM)).status, 200);
  await req("POST", "/api/rota/shifts", { site: "roastery", day: addDays(WEEK, 5), start: "10:00", end: "14:00", breakMins: 0, job: "", userId: null }, MGR);
  await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, MGR);
  await waitFor(1);
  const open = take().find((x) => /open shift/i.test(x.subject));
  assert.ok(open && open.to[0] === "sam@example.com", "Sam hears about the open shifts");
});

test("an admin can send themselves a test; it needs their own address", async () => {
  assert.equal((await req("POST", "/api/admin/email/test", {})).body.code, "no_email");
  await req("PATCH", `/api/admin/users/${(await req("GET", "/api/auth/me")).body.user.id}`, { email: "will@example.com" });
  const r = await req("POST", "/api/admin/email/test", {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.to, "will@example.com");
  const [m] = take();
  assert.match(m.subject, /Test email/);
  assert.equal((await req("POST", "/api/admin/email/test", {}, MGR)).status, 403);
  const o = (await req("GET", "/api/admin/overview")).body.emails;
  assert.equal(o.ready, true);
  assert.ok(o.sentToday >= 6);
});
