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
// Include decoded calendar attachments: checking HTML alone misses a separate outbound dataflow.
const delivered = (mail) => JSON.stringify(mail) + "\n" + (mail.attachments || []).map((a) => Buffer.from(a.content, "base64").toString()).join("\n");
const sqlValue = (value) => "'" + String(value).replace(/'/g, "''") + "'";
function privateRecipient(mail, address, hidden) {
  assert.deepEqual(mail.to, [address], "one employee per envelope");
  assert.equal(mail.reply_to, undefined, "personal account addresses never become Reply-To");
  assert.doesNotMatch(delivered(mail), hidden, "provider payload, HTML, text and calendar exclude other employees' private data");
}

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
  srv = await startServer({ writeLimit: 2000, scheduled: true, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails`, WEEKLY_ANY_TIME: "1" } });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  ids.will = (await req("GET", "/api/auth/me")).body.user.id;
  assert.equal((await req("PATCH", `/api/admin/users/${ids.will}`, { email: "publisher-private@example.test" })).status, 200);
  MGR = await person("Giles Armstrong", "giles", "manager", "giles@example.com");
  ALEX = await person("Alex Brown", "alex", "staff", "Alex@Example.com");
  SAM = await person("Sam Okafor", "sam", "staff");
  PAT = await person("Pat Lee", "pat", "staff");
  assert.equal((await req("PUT", `/api/rota/people/${ids.alex}`, { contractMin: 32, contractMax: 36 })).status, 200);
  assert.equal((await req("PUT", `/api/rota/people/${ids.sam}`, { contractMin: 4.25, contractMax: 5.75 })).status, 200);
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
  assert.deepEqual(me.prefs, { published: true, changed: true, requests: true, open: false, weekly: true });
  assert.equal(me.weeklySites, undefined, "the Monday summary is for managers");
  assert.equal(me.ready, true);
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { nonsense: true } }, ALEX)).status, 400);
});

test("publishing a week emails everyone on it: their own shifts, a calendar file and an unsubscribe link", async () => {
  const shift = (day, start, end, userId, job = "") => req("POST", "/api/rota/shifts", { site: "roastery", day, start, end, breakMins: 30, job, userId }, ADMIN);
  const a1 = await shift(WEEK, "07:30", "15:30", ids.alex, "opens");
  assert.equal(a1.status, 200, a1.text);
  ids.a1 = a1.body.shift.id;
  await shift(addDays(WEEK, 2), "09:00", "17:00", ids.alex, "closes");
  const samShift = await shift(WEEK, "09:00", "13:00", ids.sam);
  assert.equal(samShift.status, 200, samShift.text);
  // A colleague's actual times/reason must not escape through the publishing email or its attachment.
  srv.sql(`UPDATE rota_shifts SET actual_start = '09:35', actual_end = '12:40', actual_break = 0, adjust_note = 'PRIVATE_SAM_ACTUAL_REASON', adjusted_at = 1 WHERE id = ${sqlValue(samShift.body.shift.id)}`);
  await shift(addDays(WEEK, 3), "10:00", "14:00", ids.pat);
  await shift(addDays(WEEK, 4), "10:00", "14:00", null);
  const preview = (await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, ADMIN)).body;
  assert.deepEqual([preview.ready, preview.first, preview.people], [true, true, 3]);
  assert.deepEqual(preview.noAddress, ["Pat Lee"], "who has no address");
  assert.equal((await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, ALEX)).status, 403, "admins only");
  assert.equal((await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, MGR)).status, 403, "manager accounts cannot inspect other employees' mail plan");

  const pub = await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.body.emailed, 2);
  await waitFor(2);
  const mails = take();
  assert.equal(mails.length, 2);
  const alex = mails.find((m) => m.to[0] === "alex@example.com");
  assert.ok(alex, JSON.stringify(mails.map((m) => m.to)));
  assert.equal(alex.auth, "Bearer re_test_key");
  assert.equal(alex.from, "Strangers Rota <rota@staffstrangerscoffee.com>");
  privateRecipient(alex, "alex@example.com", /Sam|Pat|sam@example\.com|giles@example\.com|publisher-private@example\.test|PRIVATE_SAM_ACTUAL_REASON|09:35|12:40|4\.25|5\.75/);
  assert.match(alex.subject, /^Your shifts for the week of \d+ \w+$/);
  assert.match(alex.html, /Hi Alex, you(&#39;|')re on 2 days next week/);
  assert.match(alex.html, />07:30–15:30</);
  assert.match(alex.html, /Opens/, "the employee's own job remains visible");
  assert.doesNotMatch(alex.html + alex.text, /with Sam|With Sam/, "coworker assignment information is private");
  assert.match(alex.text, /your contract is 32–36h/, "own contract remains available");
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
  assert.equal((await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:00" }, ADMIN)).status, 200);
  const preview = (await req("GET", `/api/rota/week/emails?week=${WEEK}`, undefined, ADMIN)).body;
  assert.deepEqual([preview.first, preview.people], [false, 1]);
  const pub = await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN);
  assert.equal(pub.body.emailed, 1);
  await waitFor(1);
  const [m] = take();
  assert.equal(m.to[0], "alex@example.com");
  assert.match(m.subject, /^Your shift on \w+ \d+ \w+ has changed$/);
  assert.match(m.html, /Will Owner changed your shifts/);
  privateRecipient(m, "alex@example.com", /publisher-private@example\.test|giles@example\.com|Sam Okafor|Pat Lee/);
  assert.match(m.html, /was 07:30–15:30/);
  // Nothing changed since: nobody to email.
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN)).body.emailed, 0);
  // Publishing without emailing sends nothing.
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:15" }, ADMIN);
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK }, ADMIN)).body.emailed, 0);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 0);
});

test("the unsubscribe link asks first, then turns that email off; without signing in", async () => {
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:30" }, ADMIN);
  await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN);
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
  assert.deepEqual((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.prefs, { published: true, changed: false, requests: true, open: false, weekly: true });
  // No more change emails for Alex.
  await req("PATCH", `/api/rota/shifts/${ids.a1}`, { start: "08:45" }, ADMIN);
  assert.equal((await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN)).body.emailed, 0);
  // A made-up or altered link does nothing.
  assert.equal((await fetch(srv.base + "/email/unsubscribe?t=" + t.slice(0, -2) + "xx")).status, 400);
  // Turning it back on in the rota.
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { changed: true } }, ALEX)).status, 200);
  assert.equal((await req("GET", "/api/rota/me", undefined, ALEX)).body.email.prefs.changed, true);
});

test("time off and cover decisions are emailed to the people they're about", async () => {
  const off = await req("POST", "/api/rota/time-off", { from: addDays(WEEK, 14), to: addDays(WEEK, 15), reason: "Wedding" }, SAM);
  assert.equal(off.status, 200, off.text);
  assert.equal((await req("PATCH", `/api/rota/time-off/${off.body.id}`, { status: "approved" }, ADMIN)).status, 200);
  await waitFor(1);
  const [m] = take();
  assert.equal(m.to[0], "sam@example.com");
  assert.match(m.subject, /^Time off from .* approved$/);
  assert.match(m.html, /your time off was approved/);
  privateRecipient(m, "sam@example.com", /Alex Brown|Pat Lee|giles@example\.com|publisher-private@example\.test/);
  // Open shifts: only for those who turned them on, and are free.
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { open: true } }, SAM)).status, 200);
  await req("POST", "/api/rota/shifts", { site: "roastery", day: addDays(WEEK, 5), start: "10:00", end: "14:00", breakMins: 0, job: "", userId: null }, ADMIN);
  await req("POST", "/api/rota/week/publish", { week: WEEK, email: true }, ADMIN);
  await waitFor(1);
  const open = take().find((x) => /open shift/i.test(x.subject));
  assert.ok(open && open.to[0] === "sam@example.com", "Sam hears about the open shifts");
  privateRecipient(open, "sam@example.com", /Alex|Pat|giles@example\.com|publisher-private@example\.test|PRIVATE_SAM_ACTUAL_REASON/);
});

// Accepted requests can predate the stricter policy. Seed that state locally to exercise both outbound
// recipients without reintroducing a non-admin cross-person acceptance capability.
async function acceptedCover(day, message) {
  const shift = await req("POST", "/api/rota/shifts", { site: "roastery", day, start: "05:20", end: "06:25", breakMins: 0, userId: ids.sam, note: "PRIVATE_PREDECESSOR_SHIFT_NOTE" });
  assert.equal(shift.status, 200, shift.text);
  assert.equal((await req("POST", "/api/rota/week/publish", { week: monday(day) })).status, 200);
  const cover = await req("POST", "/api/rota/requests", { kind: "cover", shiftId: shift.body.shift.id, message }, SAM);
  assert.equal(cover.status, 200, cover.text);
  srv.sql(`UPDATE rota_requests SET taker = ${sqlValue(ids.alex)}, status = 'accepted' WHERE id = ${sqlValue(cover.body.request.id)}`);
  return { id: cover.body.request.id, shiftId: shift.body.shift.id };
}

test("declined cover notices disclose only the recipient's own request, with no predecessor shift for a taker", async () => {
  take();
  const cover = await acceptedCover(addDays(WEEK, 35), "PRIVATE_COVER_REQUEST_MESSAGE");
  assert.equal((await req("PATCH", `/api/rota/requests/${cover.id}`, { action: "decline" })).status, 200);
  await waitFor(2);
  const mails = take();
  assert.deepEqual(mails.map((m) => m.to[0]).sort(), ["alex@example.com", "sam@example.com"]);
  const sam = mails.find((m) => m.to[0] === "sam@example.com"), alex = mails.find((m) => m.to[0] === "alex@example.com");
  privateRecipient(sam, "sam@example.com", /Alex|alex@example\.com|publisher-private@example\.test|PRIVATE_COVER_REQUEST_MESSAGE|PRIVATE_PREDECESSOR_SHIFT_NOTE/);
  assert.match(sam.text, /05:20–06:25/, "the original employee still sees their own retained shift");
  privateRecipient(alex, "alex@example.com", /Sam|sam@example\.com|publisher-private@example\.test|PRIVATE_COVER_REQUEST_MESSAGE|PRIVATE_PREDECESSOR_SHIFT_NOTE|05:20|06:25/);
  assert.equal(alex.subject, "Your cover request was not approved");
  const privateDate = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(addDays(WEEK, 35) + "T12:00:00Z"));
  assert.ok(!(alex.html + alex.text).includes(privateDate), "a declined taker gets no assigned employee's date");
});

test("approved cover emails each employee only their own released or newly assigned shift", async () => {
  take();
  const cover = await acceptedCover(addDays(WEEK, 36), "PRIVATE_SECOND_COVER_MESSAGE");
  // Actual-work history belongs to the predecessor; approving cover must not carry it to the new recipient.
  srv.sql(`UPDATE rota_shifts SET actual_start = '05:37', actual_end = '06:04', actual_break = 0, adjust_note = 'PRIVATE_PREDECESSOR_ACTUAL_REASON', adjusted_at = 1 WHERE id = ${sqlValue(cover.shiftId)}`);
  assert.equal((await req("PATCH", `/api/rota/requests/${cover.id}`, { action: "approve" })).status, 200);
  await waitFor(2);
  const mails = take();
  assert.deepEqual(mails.map((m) => m.to[0]).sort(), ["alex@example.com", "sam@example.com"]);
  for (const mail of mails) {
    const alex = mail.to[0] === "alex@example.com";
    privateRecipient(mail, mail.to[0], alex ? /Sam|sam@example\.com|publisher-private@example\.test|PRIVATE_|05:37|06:04/ : /Alex|alex@example\.com|publisher-private@example\.test|PRIVATE_/);
    assert.match(mail.text, /05:20–06:25/, "the permitted recipient keeps the planned details of their own change");
  }
  const assigned = (await req("GET", `/api/rota/mine?from=${addDays(WEEK, 36)}&to=${addDays(WEEK, 36)}`, undefined, ALEX)).body.shifts;
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].actualStart, null, "predecessor work history is cleared before the new owner reads it");
});

test("an admin can send themselves a test; it needs their own address", async () => {
  await req("PATCH", `/api/admin/users/${ids.will}`, { email: "" });
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

test("the managers' Monday summary: each manager's own sites, what needs them, last week's diary; once a week", async () => {
  const WEEK_AGO = addDays(monday(london()), -7);
  // The Roastery last week: Monday's fridge too warm with nothing written; Wednesday not signed off; the rest fine.
  const set = (path, data) => req("POST", "/api/db/set", { path, data });
  await set("settings/main", { closedDays: [], units: [{ id: "f1", name: "Fridge 2", kind: "fridge" }], opening: [], closing: [], weekly: [], hide: {}, info: {}, startDate: "2020-01-01", startSet: true });
  for (let i = 0; i < 7; i++) {
    if (i === 2) continue;
    const date = addDays(WEEK_AGO, i);
    await set(`days/${date}`, { date, signed: { by: "web:Giles Armstrong", at: 1, name: "Giles Armstrong" }, temps: { f1: { am: { v: i === 0 ? 9 : 3, by: "web:Giles Armstrong", at: 1 } } } });
  }
  await set("cleaning/c1", { name: "Descale the coffee machine", freq: "weekly", createdAt: 1, lastAt: Date.now() - 20 * 864e5, log: [] });
  await set("maintenance/m1", { title: "Dishwasher leaking", status: "open", priority: "urgent", reportedAt: Date.now() - 3 * 864e5 });
  await set("sites/cafe/settings/main", { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} });
  await set("sites/cafe/maintenance/m2", { title: "Cafe door sticking", status: "open", priority: "urgent", reportedAt: Date.now() });

  // Private HR sentinel data exists alongside ordinary food-safety records.
  const leaveDay = addDays(WEEK, 63);
  const leave = await req("POST", "/api/rota/time-off", { from: leaveDay, to: addDays(leaveDay, 1), reason: "PRIVATE_MEDICAL_LEAVE_REASON" }, SAM);
  assert.equal(leave.status, 200, leave.text);
  await set("staff/private-training-sam", { name: "Sam Okafor", ownerUserId: ids.sam, role: "PRIVATE_EMPLOYEE_ROLE", start: "2001-02-03", topics: {}, notes: "PRIVATE_TRAINING_NOTE" });

  // Managers keep their own business-summary preferences; employee administration remains admin-only.
  assert.equal((await req("PUT", "/api/rota/me/emails", { prefs: { weekly: true } }, ALEX)).status, 403);
  assert.equal((await req("PUT", "/api/rota/me/emails", { weeklySites: [] }, MGR)).status, 400, "at least one site");
  assert.equal((await req("PUT", "/api/rota/me/emails", { weeklySites: ["roastery"] }, MGR)).status, 200);
  assert.deepEqual((await req("GET", "/api/rota/me", undefined, MGR)).body.email.weeklySites, ["roastery"]);
  // Admins switch it on or off for anyone who isn't staff.
  assert.equal((await req("PATCH", `/api/admin/users/${ids.alex}`, { emailPrefs: { weekly: true } })).status, 400);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.giles}`, { emailPrefs: { weekly: false } })).status, 200);
  assert.equal((await req("GET", "/api/admin/people")).body.people.find((p) => p.id === ids.giles).emailPrefs.weekly, false);
  assert.equal((await req("PATCH", `/api/admin/users/${ids.giles}`, { emailPrefs: { weekly: true } })).status, 200);
  const g = (await req("GET", "/api/admin/people")).body.people.find((p) => p.id === ids.giles);
  assert.deepEqual([g.emailPrefs.weekly, g.weeklySites], [true, ["roastery"]], "the sites Giles chose are kept");

  // Monday's run: Giles (Roastery) and Will (an admin with an address: all sites).
  take();
  const cron = () => fetch(srv.base + "/__scheduled?cron=" + encodeURIComponent("30 6,7 * * 1"));
  await cron();
  await waitFor(2, 15000);
  const mails = take();
  const giles = mails.find((m) => m.to[0] === "giles@example.com"), will = mails.find((m) => m.to[0] === "will@example.com");
  assert.ok(giles && will, JSON.stringify(mails.map((m) => [m.to, m.subject])));
  assert.match(giles.subject, /^\d+ things? needs? you · week of/);
  assert.match(giles.html, /URGENT/);
  assert.match(giles.html, /Fridge 2 read 9°C on Monday/);
  assert.match(giles.html, /no corrective action written/);
  assert.match(giles.html, /Dishwasher leaking/);
  assert.match(giles.html, /wasn(&#39;|')t signed off/);
  assert.match(giles.html, /Descale the coffee machine/);
  const managerMail = delivered(giles);
  assert.doesNotMatch(managerMail, /\b(?:Sam|Alex|Pat)\b|time off|requests? to decide|covering|picking up|Training to do|staff fully trained|hours planned|Published · \d+ hours|PRIVATE_|2001-02-03|4\.25|5\.75|09:35|12:40/i, "business summaries contain no other employee's requests, training or rota information");
  assert.match(will.html + will.text, /Sam: time off/, "admin summary retains named pending HR requests");
  assert.match(will.html + will.text, /Training to do/, "admin summary retains workforce training status");
  privateRecipient(giles, "giles@example.com", /sam@example\.com|alex@example\.com|will@example\.com/);
  assert.match(giles.html, /6\/7/, "days signed off");
  assert.doesNotMatch(giles.html, /Cafe door sticking/, "only Giles's sites");
  assert.match(will.html, /Cafe door sticking/, "an admin with all four sites");
  assert.match(giles.headers["List-Unsubscribe"], /unsubscribe\?t=/);
  assert.match(giles.text, /Fridge 2 read 9°C/);
  // A second run the same week sends nothing more.
  await cron();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent.length, 0);
  // Turning it off by its unsubscribe link stops just this email.
  const t = new URL(giles.headers["List-Unsubscribe"].slice(1, -1)).searchParams.get("t");
  await fetch(srv.base + "/email/unsubscribe?t=" + t, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  const prefs = (await req("GET", "/api/rota/me", undefined, MGR)).body.email.prefs;
  assert.deepEqual([prefs.weekly, prefs.published], [false, true]);
  // An admin can send themselves this week's summary any time.
  const r = await req("POST", "/api/admin/email/weekly-test", {});
  assert.equal(r.status, 200, r.text);
  await waitFor(1);
  assert.match(take()[0].subject, /week of/);
});
