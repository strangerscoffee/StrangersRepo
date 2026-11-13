// The diary's morning and end-of-day Slack reminders (src/slackDiary.ts, src/slackDiaryText.ts): each site's own
// times (UK, GMT and BST), what each message says is still to do, nothing on a closed day, each sent once by the
// 5-minute cron to that site's own channel, retried when Slack refuses, and the admin test button.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { dueSlots, timesText, buildReminder } from "../src/slackDiaryText.ts";

const at = (iso) => Date.parse(iso);
const due = (site, iso) => dueSlots(site, at(iso)).map((x) => x.slot).join(",");

test("each site's times: Cafe 9:00/17:00 (Sun 9:00/15:30), ASG 8:15/16:30 (Sat 9:00/17:00, Sun 10:45/16:00), Roastery 9:00/17:00 (Sun 10:45/16:00)", () => {
  // Friday 13 Nov 2026 (GMT)
  assert.equal(due("cafe", "2026-11-13T08:59:00Z"), "");
  assert.equal(due("cafe", "2026-11-13T09:00:00Z"), "morning");
  assert.equal(due("cafe", "2026-11-13T09:44:00Z"), "morning");
  assert.equal(due("cafe", "2026-11-13T09:45:00Z"), "", "never more than 45 minutes late");
  assert.equal(due("cafe", "2026-11-13T17:00:00Z"), "evening");
  assert.equal(due("asg", "2026-11-13T08:15:00Z"), "morning");
  assert.equal(due("asg", "2026-11-13T09:00:00Z"), "", "ASG's weekday morning is 8:15");
  assert.equal(due("asg", "2026-11-13T16:30:00Z"), "evening");
  assert.equal(due("roastery", "2026-11-13T09:00:00Z"), "morning");
  assert.equal(due("roastery", "2026-11-13T17:00:00Z"), "evening");
  // Saturday 14 Nov
  assert.equal(due("asg", "2026-11-14T08:15:00Z"), "");
  assert.equal(due("asg", "2026-11-14T09:00:00Z"), "morning");
  assert.equal(due("asg", "2026-11-14T17:00:00Z"), "evening");
  assert.equal(due("cafe", "2026-11-14T09:00:00Z"), "morning");
  // Sunday 15 Nov
  assert.equal(due("cafe", "2026-11-15T09:00:00Z"), "morning");
  assert.equal(due("cafe", "2026-11-15T15:30:00Z"), "evening");
  assert.equal(due("cafe", "2026-11-15T17:00:00Z"), "");
  assert.equal(due("asg", "2026-11-15T10:45:00Z"), "morning");
  assert.equal(due("asg", "2026-11-15T16:00:00Z"), "evening");
  assert.equal(due("roastery", "2026-11-15T09:00:00Z"), "");
  assert.equal(due("roastery", "2026-11-15T10:45:00Z"), "morning");
  assert.equal(due("roastery", "2026-11-15T16:00:00Z"), "evening");
  // Summer (BST): 9:00 UK is 08:00 UTC; Monday 6 July 2026
  assert.equal(due("cafe", "2026-07-06T08:00:00Z"), "morning");
  assert.equal(due("asg", "2026-07-06T07:15:00Z"), "morning");
  assert.equal(due("cafe", "2026-07-06T09:00:00Z"), "");
  // The Factory has no reminders
  assert.equal(due("factory", "2026-11-13T09:00:00Z"), "");
  assert.equal(timesText("cafe"), "Mon–Sat 9:00 and 17:00 · Sun 9:00 and 15:30");
  assert.equal(timesText("asg"), "Mon–Fri 8:15 and 16:30 · Sat 9:00 and 17:00 · Sun 10:45 and 16:00");
  assert.equal(timesText("roastery"), "Mon–Sat 9:00 and 17:00 · Sun 10:45 and 16:00");
});

const SETTINGS = {
  units: [{ id: "u1", name: "Fridge 1", kind: "fridge" }, { id: "u2", name: "Freezer 1", kind: "freezer" }],
  opening: [{ id: "o1", t: "Fridges working" }, { id: "o2", t: "No pests" }, { id: "o3", t: "Off check", off: true }],
  closing: [{ id: "c1", t: "Floors mopped" }, { id: "c2", t: "Bins out" }, { id: "c3", t: "New check", from: "2026-12-01" }],
  weekly: [{ id: "w1", t: "Deep clean <grinder>" }],
  closedDays: [], startDate: "2026-10-01", hide: {},
};
const day = (extra = {}) => ({ opening: { items: { o1: true, o2: true } }, closing: { items: { c1: true, c2: true } }, temps: { u1: { am: { v: 3 } }, u2: { am: { v: -19 } } }, signed: { by: "web:A", at: 1, name: "A" }, ...extra });
const DONE = Date.parse("2026-11-12T10:00:00Z");
const base = (over = {}) => ({
  settings: SETTINGS, firstDay: "2026-10-01",
  days: { "2026-11-12": day(), "2026-11-13": {} },
  weeks: { "2026-11-02": { signed: { by: "web:A", at: 1 } } },
  tasks: [{ kind: "cleaning", name: "Coffee machine", freq: "daily", lastAt: DONE }, { kind: "fire", name: "Fire alarm test", freq: "weekly", lastAt: DONE }],
  lastReview: "2026-11-01", ...over,
});
const cafe = { id: "cafe", name: "Cafe" };
const URL_ = "https://staffstrangerscoffee.com/";

test("the morning message: opening checks and temperatures, yesterday's sign-off, last week, overdue jobs", () => {
  const data = base({
    days: { "2026-11-12": day({ signed: null, closing: { items: { c1: true } } }), "2026-11-13": { opening: { items: { o1: true } }, temps: { u1: { am: { v: 4 } } } } },
    weeks: {},
    tasks: [{ kind: "cleaning", name: "Deep clean fridge", freq: "weekly", lastAt: Date.parse("2026-11-01T10:00:00Z") }, { kind: "fire", name: "Emergency lighting", freq: "monthly" },
      { kind: "extras", name: "Probe check", freq: "after use" }, { kind: "fire", name: "Fire alarm test", freq: "weekly", lastAt: DONE }],
  });
  const r = buildReminder(cafe, data, "morning", "2026-11-13", URL_);
  assert.equal(r.closed, false); assert.equal(r.allClear, false);
  const t = r.text;
  assert.match(t, /^:sunrise: \*Cafe: morning checks\* · Fri 13 Nov\n6 things to do:/);
  assert.match(t, /:red_circle: Opening checks: 1 of 2 done\. Still to do: No pests/);
  assert.doesNotMatch(t, /Off check/, "checks turned off don't count");
  assert.match(t, /:red_circle: Fridge and freezer temperatures: 1 of 2 recorded/);
  assert.doesNotMatch(t, /Closing checks/, "closing checks wait for the evening");
  assert.match(t, /\*Yesterday, Thu 12 Nov\*\n:red_circle: Not signed off\. Still to do: closing checks \(1 left\), then sign off/);
  assert.match(t, /:red_circle: Last week \(w\/c Mon 2 Nov\) not signed off\. End-of-week checks still to do: Deep clean &lt;grinder&gt;/);
  assert.match(t, /\*Overdue\*\n:red_circle: Fire safety: Emergency lighting \(never done\)\n:red_circle: Cleaning: Deep clean fridge \(5 days overdue\)/);
  assert.doesNotMatch(t, /Probe check|Fire alarm test/, "as-needed and up-to-date jobs aren't mentioned");
  assert.match(t, /<https:\/\/staffstrangerscoffee\.com\/\|Open the Kitchen Diary>$/);
});

test("the end-of-day message: closing checks, sign-off; this week on its last open day; all clear; closed days send nothing", () => {
  const evening = buildReminder(cafe, base(), "evening", "2026-11-13", URL_).text;
  assert.match(evening, /^:city_sunset: \*Cafe: end of the day\* · Fri 13 Nov/);
  assert.match(evening, /:red_circle: Opening checks: 0 of 2 done/);
  assert.match(evening, /:red_circle: Closing checks: 0 of 2 done\. Still to do: Floors mopped; Bins out/);
  assert.doesNotMatch(evening, /New check/, "a check counts from its from date");
  assert.match(evening, /:red_circle: Day not signed off yet/);
  assert.doesNotMatch(evening, /Yesterday|Last week|Overdue/);
  // Sunday 15 Nov is the week's last open day: the end-of-week checks and sign-off.
  const sunday = buildReminder(cafe, base({ days: { "2026-11-14": day(), "2026-11-15": day() }, weeks: { "2026-11-02": { signed: {} }, "2026-11-09": { items: {} } } }), "evening", "2026-11-15", URL_).text;
  assert.match(sunday, /This week ends today: end-of-week checks still to do: Deep clean &lt;grinder&gt;, then sign off the week/);
  // Closed on Sundays: Saturday is the week's last open day.
  const shutSun = { ...SETTINGS, closedDays: [0] };
  assert.match(buildReminder(cafe, base({ settings: shutSun, days: { "2026-11-13": day(), "2026-11-14": day() } }), "morning", "2026-11-14", URL_).text, /This week ends today/);
  assert.equal(buildReminder(cafe, base({ settings: shutSun }), "morning", "2026-11-15", URL_).closed, true, "nothing on a usual closed day");
  assert.equal(buildReminder(cafe, base({ days: { "2026-11-13": { closed: { reason: "Bank holiday" } } } }), "evening", "2026-11-13", URL_).closed, true, "nothing on a closure");
  assert.equal(buildReminder(cafe, base({ settings: null }), "evening", "2026-11-13", URL_).closed, true, "nothing for a site not set up");
  // Everything done
  const done = buildReminder(cafe, base({ days: { "2026-11-12": day(), "2026-11-13": day() } }), "evening", "2026-11-13", URL_);
  assert.equal(done.allClear, true);
  assert.equal(done.text, ":city_sunset: *Cafe: end of the day* · Fri 13 Nov\nAll done for today: checks complete, day signed off and nothing overdue.\n<https://staffstrangerscoffee.com/|Open the Kitchen Diary>");
  // The 4-weekly review, and sections hidden at the site.
  const late = buildReminder(cafe, base({ days: { "2026-11-12": day(), "2026-11-13": day() }, lastReview: "2026-10-01" }), "evening", "2026-11-13", URL_).text;
  assert.match(late, /:red_circle: 4-weekly review \(due Thu 29 Oct\)/);
  const hidden = buildReminder(cafe, base({ settings: { ...SETTINGS, hide: { review: true, fire: true } }, days: { "2026-11-12": day(), "2026-11-13": day() }, lastReview: "2026-10-01",
    tasks: [{ kind: "fire", name: "Fire alarm test", freq: "weekly" }] }), "evening", "2026-11-13", URL_);
  assert.equal(hidden.allClear, true);
});

/* ---------- sent by the cron, once, to each site's own channel ---------- */

let srv, mock, ADMIN, STAFF, failNext = 0;
const posts = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sfbb_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const cron = () => fetch(srv.base + "/__scheduled?cron=" + encodeURIComponent("*/5 * * * *")).then((r) => r.text());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (posts.length < n && Date.now() < end) await wait(100); await wait(300); return posts.length; }

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => {
    if (failNext > 0) { failNext--; rs.writeHead(500).end("no_service"); return; }
    try { posts.push({ channel: rq.url, ...JSON.parse(b) }); } catch {} rs.writeHead(200).end("ok"); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const hook = (name) => `http://127.0.0.1:${mock.address().port}/services/T000/B000/${name}`;
  // Friday 13 Nov 2026, 09:02 UK time: the Cafe's and the Roastery's morning messages are due (ASG's was at 8:15).
  srv = await startServer({ writeLimit: 2000, scheduled: true, vars: { SLACK_TEST_HOOKS: "1", SLACK_DIARY_NOW: "2026-11-13T09:02:00Z",
    SLACK_CAFE_WEBHOOK_URL: hook("cafe"), SLACK_ROASTERY_WEBHOOK_URL: hook("roastery") } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  assert.equal((await call("POST", "/api/admin/users", { name: "Sam Staff", username: "sam", role: "staff", password: "temporary-private-password" })).status, 200);
  STAFF = (await call("POST", "/api/auth/change", { username: "sam", password: "temporary-private-password", newPassword: "sam-private-password" }, null)).cookie;
  assert.ok(STAFF);
  const set = (path, data) => call("POST", "/api/db/set", { path, data });
  for (const p of ["", "sites/cafe/", "sites/asg/"]) assert.equal((await set(`${p}settings/main`, SETTINGS)).status, 200);
  await set("sites/cafe/days/2026-11-12", day());
  await set("sites/cafe/days/2026-11-13", { opening: { items: { o1: true } } });
  await set("sites/cafe/weeks/2026-11-02", { signed: { by: "web:Admin", at: 1, name: "Admin" } });
  await set("sites/cafe/cleaning/k1", { name: "Deep clean fridge", freq: "weekly", lastAt: Date.parse("2026-11-01T10:00:00Z") });
  await set("sites/cafe/reviews/r1", { date: "2026-11-01" });
  // The Roastery is closed today.
  await set("days/2026-11-13", { closed: { reason: "Maintenance or repairs", by: "web:Admin", at: 1 } });
});
after(async () => { await srv?.stop(); mock?.close(); });

test("the cron sends each due site's message once, to its own channel; closed sites and sites without a channel get nothing", async () => {
  await cron();
  assert.equal(await settle(1), 1, "only the Cafe: the Roastery is closed and ASG has no channel");
  const [p] = posts;
  assert.equal(p.channel, "/services/T000/B000/cafe");
  assert.match(p.text, /^:sunrise: \*Cafe: morning checks\* · Fri 13 Nov/);
  assert.match(p.text, /Opening checks: 1 of 2 done\. Still to do: No pests/);
  assert.match(p.text, /Cleaning: Deep clean fridge \(5 days overdue\)/);
  assert.equal(p.unfurl_links, false);
  await cron(); await cron();
  assert.equal(await settle(2, 1500), 1, "sent once");
  const rows = srv.sql("SELECT site, day, slot, sent_at IS NOT NULL AS sent, last_error FROM slack_diary_posts ORDER BY site");
  assert.deepEqual(rows.map((r) => [r.site, r.day, r.slot, r.sent, r.last_error]), [["cafe", "2026-11-13", "morning", 1, null], ["roastery", "2026-11-13", "morning", 1, "closed"]]);
});

test("a message Slack refuses is tried again on the next runs, then logged for Admin", async () => {
  srv.sql("DELETE FROM slack_diary_posts");
  posts.length = 0; failNext = 1;
  await cron();
  await wait(500);
  assert.equal(posts.length, 0);
  assert.match(srv.sql("SELECT last_error FROM slack_diary_posts WHERE site = 'cafe'")[0].last_error, /500/);
  await cron();
  assert.equal(await settle(1), 1, "sent on the next run");
  srv.sql("DELETE FROM slack_diary_posts"); posts.length = 0; failNext = 3;
  for (let i = 0; i < 4; i++) await cron();
  await wait(500);
  assert.equal(posts.length, 0, "three tries at most");
  assert.equal(srv.sql("SELECT attempts FROM slack_diary_posts WHERE site = 'cafe'")[0].attempts, 3);
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'slack_failed' AND text LIKE '%Cafe%morning diary reminder%'")[0].n, 1);
});

test("Admin → Sites shows each channel and sends a test; admins only", async () => {
  const sites = (await call("GET", "/api/admin/sites")).body.sites;
  const by = Object.fromEntries(sites.map((s) => [s.id, s.slack]));
  assert.deepEqual(by.cafe, { channel: "cafe-internal", secret: "SLACK_CAFE_WEBHOOK_URL", connected: true, times: "Mon–Sat 9:00 and 17:00 · Sun 9:00 and 15:30" });
  assert.equal(by.asg.connected, false);
  assert.equal(by.factory, null);
  posts.length = 0;
  const r = await call("POST", "/api/admin/sites/cafe/slack-test", { slot: "evening" });
  assert.equal(r.status, 200, r.text);
  assert.equal(await settle(1), 1);
  assert.match(posts[0].text, /^:test_tube: _Test of the end-of-day reminder_\n:city_sunset: \*Cafe: end of the day\*/);
  assert.match(posts[0].text, /Closing checks: 0 of 2 done/);
  assert.equal((await call("POST", "/api/admin/sites/asg/slack-test", { slot: "morning" })).body.code, "slack_not_configured");
  assert.equal((await call("POST", "/api/admin/sites/cafe/slack-test", { slot: "noon" })).status, 400);
  assert.equal((await call("POST", "/api/admin/sites/cafe/slack-test", { slot: "morning" }, STAFF)).status, 403);
  assert.equal((await call("GET", "/api/admin/sites", undefined, STAFF)).status, 403);
});
