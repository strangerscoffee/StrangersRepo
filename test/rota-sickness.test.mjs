// Self-certified sickness forms: staff report their own sickness (a day off, or going home early); the rota gets a
// private approved sick absence and the shift's hours change; only admins read the answers, the records and the
// Bradford Factor; removing a record puts the hours back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, ALEX, BETH, MGR;
const ids = {};
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sfbb_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const london = (offset = 0) => new Date(Date.now() + offset * 864e5).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
async function person(name, role = "staff") {
  const u = (await call("POST", "/api/admin/users", { name, username: name.toLowerCase(), role, password: "temporary-password" })).body.user;
  ids[name] = u.id;
  return (await call("POST", "/api/auth/change", { username: name.toLowerCase(), password: "temporary-password", newPassword: name.toLowerCase() + "-own-password" }, null)).cookie;
}
async function shift(userId, day, start, end, breakMins = 30) {
  const r = await call("POST", "/api/rota/shifts", { site: "cafe", day, start, end, breakMins, job: "", userId });
  assert.equal(r.status, 200, r.text); return r.body.shift;
}
const shiftNow = async (id, day) => (await call("GET", `/api/rota/week?start=${day}`)).body;
const form = (extra = {}) => ({ requestKey: crypto.randomUUID(), kind: "off", from: london(), to: london(), category: "Cold or flu", details: "Temperature and a cough", vomiting: false, doctor: false, workAccident: false, declared: true, ...extra });

before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  // Cafe open every day, so shifts can go on any date.
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
  ALEX = await person("Alex"); BETH = await person("Beth"); MGR = await person("Mona", "manager");
});
after(async () => { await srv?.stop(); });

test("a day off sick: the shift goes to 0 hours and the rota gets a private sick absence", async () => {
  const s = await shift(ids.Alex, london(), "08:00", "16:00");
  const preview = await call("GET", `/api/rota/sickness/preview?kind=off&from=${london()}&to=${london()}`, undefined, ALEX);
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body.changes.map((c) => [c.shiftId, c.hoursBefore, c.hoursAfter]), [[s.id, 7.5, 0]]);
  for (const bad of [{ declared: false }, { category: "Hangover" }, { details: "" }, { vomiting: "no" }, { to: london(-1) }, { from: london(-40), to: london(-40) }, { to: london(20) }])
    assert.equal((await call("POST", "/api/rota/sickness", form(bad), ALEX)).status, 400, JSON.stringify(bad));
  const body = form();
  const saved = await call("POST", "/api/rota/sickness", body, ALEX);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(Object.keys(saved.body).sort(), ["changes", "id", "saved"], "the employee gets nothing else back");
  assert.equal((await call("POST", "/api/rota/sickness", body, ALEX)).body.replayed, true, "a retry is the same form");
  assert.equal((await call("POST", "/api/rota/sickness", form(), ALEX)).status, 409, "no second form for the same day");
  const week = await call("GET", `/api/rota/week?start=${london()}`);
  const after = week.body.shifts.find((x) => x.id === s.id);
  assert.equal(after.hours, 0);
  assert.match(after.adjustNote, /Off sick \(self-certified\)/);
  const absence = srv.sql(`SELECT kind,status FROM rota_time_off WHERE user_id='${ids.Alex}'`);
  assert.match(JSON.stringify(absence), /"kind":"sick","status":"approved"/);
  // Colleagues never see sickness on the shared holiday calendar.
  const cal = await call("GET", `/api/rota/leave/calendar?from=${london(-1)}&to=${london(1)}`, undefined, BETH);
  assert.doesNotMatch(cal.text, /Alex|sick/i);
});

test("going home early: hours up to the time they left; later shifts that day go to 0", async () => {
  const day = london(-1);
  const a = await shift(ids.Beth, day, "08:00", "16:00", 30), b = await shift(ids.Beth, day, "17:00", "19:00", 0);
  const saved = await call("POST", "/api/rota/sickness", form({ kind: "early", from: day, leftAt: "11:00", category: "Stomach upset", vomiting: true }), BETH);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body.changes.map((c) => [c.shiftId, c.hoursAfter]), [[a.id, 3], [b.id, 0]], "under 6 hours: no unpaid break");
  assert.equal((await call("POST", "/api/rota/sickness", form({ kind: "early", from: london(1), leftAt: "11:00" }), BETH)).status, 400, "not for a day still to come");
});

test("only admins read the forms and the Bradford Factor", async () => {
  for (const who of [ALEX, BETH, MGR]) assert.equal((await call("GET", "/api/rota/sickness", undefined, who)).status, 403);
  assert.equal((await call("GET", "/api/rota/sickness", undefined, null)).status, 401);
  assert.equal((await call("POST", "/api/rota/sickness", form({ userId: ids.Beth, from: london(-3), to: london(-3) }), ALEX)).status, 403, "staff report only their own sickness");
  const r = await call("GET", "/api/rota/sickness");
  assert.equal(r.status, 200, r.text);
  const alex = r.body.employees.find((e) => e.name === "Alex"), beth = r.body.employees.find((e) => e.name === "Beth");
  assert.deepEqual([alex.spells, alex.days, alex.score, alex.band.key], [1, 1, 1, "none"]);
  assert.deepEqual([beth.spells, beth.days, beth.score], [1, 0.5, 1]);
  const rec = r.body.records.find((x) => x.name === "Beth");
  assert.equal(rec.answers.vomiting, true);
  assert.equal(rec.answers.declaredBy, "Beth");
  assert.equal(r.body.bands.length, 5);
});

test("Bradford: spells are squared, so many short absences score high", async () => {
  // An admin records four more separate one-day spells for Alex over the year: 5 spells, 5 days → 125 (Stage 1).
  for (const d of [-60, -120, -180, -240]) {
    const saved = await call("POST", "/api/rota/sickness", form({ userId: ids.Alex, from: london(d), to: london(d) }));
    assert.equal(saved.status, 200, saved.text);
  }
  // A second day right after an existing one is the same spell.
  assert.equal((await call("POST", "/api/rota/sickness", form({ userId: ids.Alex, from: london(-59), to: london(-59) }))).status, 200);
  const alex = (await call("GET", "/api/rota/sickness")).body.employees.find((e) => e.name === "Alex");
  assert.deepEqual([alex.spells, alex.days, alex.score, alex.band.key, alex.band.label], [5, 6, 150, "stage1", "Stage 1"]);
  assert.match(alex.band.action, /written warning/);
});

test("removing a record cancels the absence and puts the hours back", async () => {
  const r = await call("GET", "/api/rota/sickness");
  const rec = r.body.records.find((x) => x.name === "Alex" && x.from === london());
  assert.equal((await call("DELETE", `/api/rota/sickness/${rec.id}`, undefined, ALEX)).status, 403);
  assert.equal((await call("DELETE", `/api/rota/sickness/${rec.id}`)).status, 200);
  const week = await call("GET", `/api/rota/week?start=${london()}`);
  const s = week.body.shifts.find((x) => x.userId === ids.Alex && x.day === london());
  assert.equal(s.hours, 7.5);
  assert.equal(s.adjusted, false);
  assert.equal((await call("GET", "/api/rota/sickness")).body.records.some((x) => x.id === rec.id), false);
  assert.equal((await call("DELETE", `/api/rota/sickness/${rec.id}`)).status, 404);
});
