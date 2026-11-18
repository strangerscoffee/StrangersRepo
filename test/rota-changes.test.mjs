// What's changed on a published week (src/rota/changes.ts): the publish sheet's list and the week's count. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

// A week well in the future, so requests (which must be for shifts from today on) are allowed.
const WEEK = "2030-01-07"; // Monday
const day = (i) => { const d = new Date(WEEK + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const MON = day(0), TUE = day(1), WED = day(2), THU = day(3), FRI = day(4), SAT = day(5), SUN = day(6);

let srv, ADMIN, MGR, ALEX, SAM;
const ids = {};

// The session a response sets (its first Set-Cookie may remove an older, host-only copy: src/auth.ts).
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function req(method, path, body, cookie = ADMIN) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const r = await fetch(srv.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
}
const rota = (method, route, body, cookie) => req(method, "/api/rota/" + route, body, cookie);
async function signUp(name, username, role) {
  const r = await req("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" });
  assert.equal(r.status, 200, r.text);
  await req("POST", "/api/auth/login", { username, password: "temp-pass-1" }, null);
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  assert.equal(c.status, 200);
  return cookieOf(c);
}
const settings = (site, closedDays) => req("POST", "/api/db/set", {
  path: (site === "roastery" ? "" : `sites/${site}/`) + "settings/main",
  data: { closedDays, units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} },
});
const addShift = async (s, cookie = ADMIN) => {
  const r = await rota("POST", "shifts?with=problems", { breakMins: 30, job: "", ...s }, cookie);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const kinds = (problems) => problems.map((p) => p.kind);

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("George Farrow", "george", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  SAM = await signUp("Sam Okafor", "sam", "staff");
  await signUp("Priya Shah", "priya", "staff");
  await settings("roastery", [0, 6]); // closed weekends
  await settings("cafe", [0]); // closed Sundays
  await settings("asg", []);
  // Factory has no settings: not in use.
  const w = await rota("GET", "week?start=" + WEEK, undefined, ADMIN);
  for (const p of w.body.people) ids[p.name.split(" ")[0]] = p.id;
});
after(async () => { await srv?.stop(); });


const changesOf = async (cookie = ADMIN) => (await rota("GET", "week?start=" + WEEK, undefined, cookie)).body;
const brief = (cs) => cs.map((c) => [c.kind, c.day, c.name, c.site, c.start, c.end, ...(c.what ? [c.what.join("+")] : [])].filter(Boolean).join(" "));

test("what's changed since publishing: shifts and time off, not requests that change nothing", async () => {
  const keep = await addShift({ site: "cafe", day: MON, start: "09:00", end: "17:00", userId: ids.Alex });
  const move = await addShift({ site: "cafe", day: TUE, start: "09:00", end: "17:00", userId: ids.Sam });
  const drop = await addShift({ site: "asg", day: WED, start: "08:00", end: "12:00", userId: ids.Priya });
  assert.equal((await rota("POST", "week/publish", { week: WEEK }, ADMIN)).status, 200);
  let w = await changesOf();
  assert.equal(w.changesSincePublish, 0);
  assert.deepEqual(w.changes, []);
  assert.equal(w.changesBasis, "published");

  // A time-off request that's then declined touches the week but changes nothing on it.
  const asked = await rota("POST", "time-off", { from: THU, to: THU, reason: "Dentist" }, ALEX);
  assert.equal((await rota("PATCH", "time-off/" + asked.body.id, { status: "declined" }, ADMIN)).status, 200);
  w = await changesOf();
  assert.equal(w.changesSincePublish, 0, "but nothing changed, so nothing to send");

  // Real changes: a new shift, a moved one, a removed one, approved time off.
  await addShift({ site: "roastery", day: THU, start: "08:00", end: "16:00", userId: ids.George });
  assert.equal((await rota("PATCH", "shifts/" + move.shift.id, { start: "10:00", end: "18:00", site: "roastery" }, ADMIN)).status, 200);
  assert.equal((await rota("DELETE", "shifts/" + drop.shift.id, undefined, ADMIN)).status, 200);
  await rota("POST", "time-off", { userId: ids.Priya, from: FRI, to: FRI, reason: "PRIVATE REASON" }, ADMIN);
  w = await changesOf();
  assert.deepEqual(brief(w.changes), [
    `changed ${TUE} Sam Okafor roastery 10:00 18:00 site+time`,
    `removed ${WED} Priya Shah asg 08:00 12:00`,
    `added ${THU} George Farrow roastery 08:00 16:00`,
    `off-added ${FRI} Priya Shah    `,
  ].map((x) => x.replace(/ +$/, "")));
  const moved = w.changes.find((c) => c.kind === "changed");
  assert.deepEqual(moved.was, { day: TUE, site: "cafe", start: "09:00", end: "17:00", name: "Sam Okafor" });
  assert.equal(w.changesSincePublish, 4);
  assert.doesNotMatch(JSON.stringify(w.changes), /PRIVATE REASON/, "no reasons");

  // Staff and managers never get the list (it names people), only their own week as before.
  for (const cookie of [ALEX, MGR]) {
    const mine = await changesOf(cookie);
    assert.equal(mine.changes, undefined);
    assert.equal(mine.changesBasis, undefined);
  }

  // Putting a shift back as it was takes it off the list; publishing clears it.
  assert.equal((await rota("PATCH", "shifts/" + move.shift.id, { start: "09:00", end: "17:00", site: "cafe" }, ADMIN)).status, 200);
  assert.equal((await changesOf()).changes.filter((c) => c.kind === "changed").length, 0);
  assert.equal((await rota("POST", "week/publish", { week: WEEK }, ADMIN)).status, 200);
  assert.deepEqual((await changesOf()).changes, []);
  assert.ok(keep);
});

test("weeks published before the snapshot compare with the last email", async () => {
  const W2 = "2030-02-04";
  const a = await addShift({ site: "cafe", day: W2, start: "09:00", end: "17:00", userId: ids.Alex });
  await addShift({ site: "cafe", day: W2, start: "12:00", end: "16:00", userId: null });
  assert.equal((await rota("POST", "week/publish", { week: W2 }, ADMIN)).status, 200);
  // As an older week: no snapshot, but what Alex was last emailed.
  srv.sql(`UPDATE rota_weeks SET published_shifts = NULL, emailed = '${JSON.stringify({ people: { [ids.Alex]: [{ id: a.shift.id, day: W2, start: "08:00", end: "17:00", site: "cafe", job: "", hours: 8.5 }] }, open: [] })}' WHERE week = '${W2}'`);
  const w = (await rota("GET", "week?start=" + W2, undefined, ADMIN)).body;
  assert.equal(w.changesBasis, "emailed");
  assert.deepEqual(brief(w.changes), [`changed ${W2} Alex Brown cafe 09:00 17:00 time`], "open shifts aren't in an email, so aren't compared");
  // No snapshot and no email: the old counter.
  srv.sql(`UPDATE rota_weeks SET emailed = NULL, changes = 3 WHERE week = '${W2}'`);
  const old = (await rota("GET", "week?start=" + W2, undefined, ADMIN)).body;
  assert.equal(old.changes, null);
  assert.equal(old.changesSincePublish, 3);
});

test("diffWeek on its own", async () => {
  const { diffWeek, readSnapshot } = await import("../src/rota/changes.ts");
  const snap = readSnapshot(JSON.stringify({ at: 1, shifts: [{ id: "a", day: "2030-01-07", site: "cafe", start: "09:00", end: "17:00", breakMins: 30, job: "", userId: "u1", note: "" }], timeOff: [] }), null);
  const now = [{ id: "a", day: "2030-01-07", site: "cafe", start: "09:00", end: "17:00", breakMins: 45, job: "opens", userId: "u2", note: "Till" }];
  const [c] = diffWeek(snap, now, [], (id) => ({ u1: "One", u2: "Two" })[id] ?? null);
  assert.deepEqual(c.what, ["person", "break", "job", "note"]);
  assert.equal(c.was.name, "One");
  assert.equal(readSnapshot("not json", "also not"), null);
});
