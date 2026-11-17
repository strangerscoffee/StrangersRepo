// Holiday for extra hours (src/rota/leave/accrual.ts) and reminders about holiday left to take (notify.ts): an admin
// reviews a quarter and approves it; it's added once, emailed with the workings and can be taken off with a reason;
// full-time and no-contract people are left out; staff can't see or approve anyone's. The daily run reminds staff and
// lists people for admins, once per stage, and records it. Year-end carry-over is admin-only with a reason.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, ALICE, BETH;
const ids = {}, sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}
const leave = (method, path, body, cookie) => req(method, "/api/rota/leave/" + path, body, cookie);
async function ok(method, path, body, cookie) { const r = await leave(method, path, body, cookie); assert.equal(r.status, 200, r.text); return r.body; }
async function person(name, username, role, email) {
  const r = await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1", ...(email ? { email } : {}) });
  assert.equal(r.status, 200, r.text);
  ids[username] = r.body.user.id;
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  assert.equal(c.status, 200);
  return cookieOf(c);
}
const day = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (d) => day(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
const yearOf = (d) => (d.slice(5) < "04-01" ? Number(d.slice(0, 4)) - 1 : Number(d.slice(0, 4))) + "-04-01";
const yearEnd = (from) => day(`${Number(from.slice(0, 4)) + 1}-04-01`, -1);
async function allowance(user, from, to, extra = {}) {
  return ok("PUT", "allowances", { userId: ids[user], from, to, unit: "days", entitlement: 20, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 0, 0], excludedDates: [], bankHolidays: [], changeReason: "Agreed entitlement", ifVersion: 0, ...extra });
}
const cron = () => fetch(srv.base + "/__scheduled?cron=" + encodeURIComponent("*/5 * * * *")).then((r) => r.text());

before(async () => {
  mock = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (d) => (b += d));
    rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "test-" + sent.length })); });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 4000, scheduled: true, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails`, SLACK_TEST_HOOKS: "1", HOLIDAY_NOW: "2031-01-02T10:00:00Z" } });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  ids.will = (await req("GET", "/api/auth/me")).body.user.id;
  assert.equal((await req("PATCH", `/api/admin/users/${ids.will}`, { email: "owner@example.test" })).status, 200);
  await req("POST", "/api/db/set", { path: "settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
  ALICE = await person("Alice Part", "alice", "staff", "alice@example.test");
  BETH = await person("Beth Full", "beth", "staff", "beth@example.test");
  await person("Cara None", "cara", "staff");
  assert.equal((await req("PUT", `/api/rota/people/${ids.alice}`, { contractMin: 20, contractMax: 30 })).status, 200);
  assert.equal((await req("PUT", `/api/rota/people/${ids.beth}`, { contractMin: 31.5, contractMax: 42.5 })).status, 200);
  const p = await ok("GET", "admin");
  await ok("PUT", "settings", { enabled: true, yearStart: "04-01", bankHolidayPolicy: "included", limits: {}, ifVersion: p.version });
});
after(async () => { await srv?.stop(); mock?.close(); });

let Q, W, CUR;
test("a quarter's extra hours: 12.07% above the minimum, full time and no contract left out, admins only", async () => {
  const first = await ok("GET", "accrual");
  Q = first.quarter;
  // A whole week inside the last quarter: five 8-hour days each for Alice, Beth and Cara.
  W = day(mondayOf(Q.to), -7);
  for (const who of ["alice", "beth", "cara"]) for (let i = 0; i < 5; i++) {
    const d = day(W, i);
    if (d > Q.to) continue;
    const r = await req("POST", "/api/rota/shifts", { site: "roastery", day: d, start: "07:00", end: "15:30", breakMins: 30, job: "", userId: ids[who] });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal((await req("POST", "/api/rota/week/publish", { week: W })).status, 200);
  for (const s of [ALICE, BETH]) assert.equal((await leave("GET", "accrual", undefined, s)).status, 403, "staff can't see anyone's hours");
  assert.equal((await leave("POST", "accrual", { quarter: Q.from, people: [], ifVersion: 1 }, ALICE)).status, 403);

  const fig = await ok("GET", "accrual?quarter=" + Q.from);
  const alice = fig.people.find((p) => p.userId === ids.alice), beth = fig.people.find((p) => p.userId === ids.beth), cara = fig.people.find((p) => p.userId === ids.cara);
  const worked = [0, 1, 2, 3, 4].filter((i) => day(W, i) <= Q.to).length * 8, counted = Math.round((Date.parse(Q.to) - Date.parse(W)) / 864e5) + 1;
  const minimum = Math.round((20 / 7) * counted * 100) / 100, extra = Math.round((worked - minimum) * 100) / 100;
  assert.equal(alice.status, "ready");
  assert.equal(alice.countedFrom, W, "counted from when the rota and her shifts start");
  assert.deepEqual([alice.workedHours, alice.minimumHours, alice.extraHours, alice.dayHours, alice.rateBp], [worked, minimum, extra, 8, 1207]);
  assert.equal(alice.accruedHours, Math.round(extra * 12.07) / 100);
  assert.equal(alice.units, Math.round((alice.accruedHours / 8) * 100));
  assert.equal(beth.status, "full-time");
  assert.equal(cara.status, "no-contract");
  assert.equal(alice.year, null, "no leave year yet: it can't be added");
  assert.equal((await leave("POST", "accrual", { quarter: Q.from, people: [{ userId: ids.alice, units: alice.units }], ifVersion: fig.version })).status, 409);

  const from = yearOf(fig.creditDay);
  CUR = from;
  await allowance("alice", from, yearEnd(from));
  const again = await ok("GET", "accrual?quarter=" + Q.from);
  assert.equal((await leave("POST", "accrual", { quarter: Q.from, people: [{ userId: ids.alice, units: alice.units + 1 }], ifVersion: again.version })).status, 409, "changed since reviewed");
  assert.equal((await leave("POST", "accrual", { quarter: Q.from, people: [{ userId: ids.beth, units: 10 }], ifVersion: again.version })).status, 409, "full time earns none");
  const mails = sent.length;
  const added = await ok("POST", "accrual", { quarter: Q.from, people: [{ userId: ids.alice, units: alice.units }], ifVersion: again.version });
  assert.equal(added.added, 1);
  const dash = await ok("GET", "dashboard", undefined, ALICE);
  const b = dash.balances.find((x) => x.from === from);
  assert.equal(b.accrued, alice.units / 100);
  assert.equal(b.total, 20 + alice.units / 100);
  assert.equal(b.accruals[0].label, Q.label);
  assert.equal(b.accruals[0].by, undefined, "the approving admin isn't shown to staff");
  // Approving the same quarter again adds nothing.
  const fig2 = await ok("GET", "accrual?quarter=" + Q.from);
  assert.equal(fig2.people.find((p) => p.userId === ids.alice).added.units, alice.units);
  assert.equal((await ok("POST", "accrual", { quarter: Q.from, people: [{ userId: ids.alice, units: alice.units }], ifVersion: fig2.version })).added, 0);
  for (let i = 0; i < 20 && sent.length === mails; i++) await new Promise((r) => setTimeout(r, 100));
  const mail = sent.slice(mails).find((m) => m.to[0] === "alice@example.test");
  assert.ok(mail, "Alice is emailed");
  assert.match(mail.subject, /holiday added for your extra hours/);
  assert.match(mail.text, /12\.07%/);
  assert.doesNotMatch(JSON.stringify(sent.slice(mails)), /Beth|Cara/);

  // Taking it off needs a reason and keeps the record.
  const year = dash.balances.find((x) => x.from === from);
  assert.equal((await leave("POST", "accrual/reverse", { userId: ids.alice, year: from, key: year.accruals[0].key, reason: "", ifVersion: year.version })).status, 400);
  await ok("POST", "accrual/reverse", { userId: ids.alice, year: from, key: year.accruals[0].key, reason: "Hours corrected", ifVersion: year.version });
  const after1 = (await ok("GET", "dashboard", undefined, ALICE)).balances.find((x) => x.from === from);
  assert.equal(after1.accrued, 0);
  assert.ok(after1.accruals[0].reversedAt);
  // A later allowance edit keeps the history.
  const kept = await allowance("alice", from, yearEnd(from), { entitlement: 21, ifVersion: after1.version });
  assert.equal(kept.balance.accruals.length, 1);
});

test("holiday left to take: each person sees their own; admins see everyone", async () => {
  const own = (await ok("GET", "dashboard", undefined, ALICE)).takeBy;
  assert.ok(own);
  assert.equal(own.userId, ids.alice);
  assert.ok(own.left > 0);
  assert.ok(["on-track", "behind", "at-risk", "act-now"].includes(own.risk));
  assert.equal((await ok("GET", "dashboard", undefined, BETH)).takeBy, null, "no leave year: nothing to show");
  assert.equal((await leave("GET", "take-by", undefined, ALICE)).status, 403);
  assert.equal((await leave("GET", "year-end", undefined, ALICE)).status, 403);
  assert.equal((await leave("POST", "carry", { userId: ids.alice }, ALICE)).status, 403);
  const all = await ok("GET", "take-by");
  assert.deepEqual(all.people.map((p) => p.name), ["Alice Part"]);
});

test("the daily run reminds staff once per stage, lists them for admins and records it", async () => {
  // HOLIDAY_NOW is 2 January 2031: three months before the 2030–31 year ends. Six months has passed already.
  await allowance("alice", "2030-04-01", "2031-03-31");
  await allowance("beth", "2030-04-01", "2031-03-31", { entitlement: 2 });
  const p = await ok("GET", "admin");
  // Beth has booked everything, so she's not reminded.
  const pv = await ok("POST", "preview", { kind: "annual", from: "2030-06-03", to: "2030-06-04", userId: ids.beth });
  await ok("POST", "requests", { kind: "annual", from: "2030-06-03", to: "2030-06-04", userId: ids.beth, approved: true, requestKey: crypto.randomUUID(), expectedCharges: pv.days });
  assert.ok(p.settings.reminders !== false, "on by default");
  const before = sent.length;
  await cron();
  for (let i = 0; i < 50 && sent.length < before + 2; i++) await new Promise((r) => setTimeout(r, 100));
  const mine = sent.slice(before);
  const toAlice = mine.filter((m) => m.to[0] === "alice@example.test"), toOwner = mine.filter((m) => m.to[0] === "owner@example.test");
  assert.equal(toAlice.length, 1);
  assert.match(toAlice[0].subject, /20 days of holiday left to book before Monday 31 March/);
  assert.match(toAlice[0].text, /twice as long as the holiday/);
  assert.equal(mine.filter((m) => m.to[0] === "beth@example.test").length, 0);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0].text, /Alice Part: 20 days \(Three months left/);
  assert.doesNotMatch(toAlice[0].text, /Beth/);
  await cron(); await cron();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(sent.length, before + 2, "once a day, once per stage");
  const events = await ok("GET", "events?userId=" + ids.alice);
  assert.ok(events.events.some((e) => e.action === "holiday_reminder" && JSON.parse(e.data).stage === "three"));
  // Switching reminders off stops them (a new day would otherwise run again).
  const pol = await ok("GET", "admin");
  await ok("PUT", "settings", { ...pol.settings, reminders: false, ifVersion: pol.version });
  assert.equal((await ok("GET", "admin")).settings.reminders, false);
});

test("year end: nothing carries over unless an admin agrees it, with a reason", async () => {
  // The year before this one, ended with holiday not taken, and this year to carry into.
  const prev = `${Number(CUR.slice(0, 4)) - 1}-04-01`;
  await allowance("alice", prev, day(CUR, -1));
  const y = await ok("GET", "year-end");
  // Listed only within four months of its end.
  const listed = y.people.find((p) => p.year.from === prev);
  const next = (await ok("GET", "dashboard?userId=" + ids.alice)).balances.find((b) => b.from === CUR);
  if (listed) assert.deepEqual(listed.missing, ["three", "two", "final"], "no reminders were sent that year");
  assert.equal((await leave("POST", "carry", { userId: ids.alice, year: prev, days: 5, reason: "", ifVersion: next.version })).status, 400, "a reason is needed");
  assert.equal((await leave("POST", "carry", { userId: ids.alice, year: prev, days: 50, reason: "Agreed", ifVersion: next.version })).status, 400, "at most what wasn't taken");
  await ok("POST", "carry", { userId: ids.alice, year: prev, days: 5, reason: "Off sick in March", ifVersion: next.version });
  const after1 = (await ok("GET", "dashboard?userId=" + ids.alice)).balances.find((b) => b.from === CUR);
  assert.equal(after1.carry, 5);
  assert.ok((await ok("GET", "events?userId=" + ids.alice)).events.some((e) => e.action === "carry_over_agreed"));
});
