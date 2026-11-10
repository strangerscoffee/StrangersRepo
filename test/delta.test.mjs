// Lists kept up to date by changes (docs/runtime-api.md, "Live updates"): a device that already has a list asks
// for what changed since its copy and gets just that, or the whole list when only that is safe. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function db(op, body) {
  const r = await fetch(srv.base + "/api/db/" + op, { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
});
after(() => srv?.stop());

test("a device that already has a list gets only what changed since its copy", async () => {
  const col = "sites/cafe/deliveries";
  for (let i = 1; i <= 5; i++) await db("set", { path: `${col}/d${i}`, data: { at: i, supplier: "S" + i } });
  const q = (extra) => db("poll", { queries: [{ key: "k", kind: "col", path: col, orderBy: "at", dir: "desc", limit: 3, ...extra }] });
  const first = (await q({})).body.results.k;
  assert.deepEqual(first.docs.map((d) => d.id), ["d5", "d4", "d3"]);
  // Nothing new: nothing sent.
  assert.equal((await q({ ver: first.ver, delta: true })).body.results.k, undefined);
  // One change: just that one, with its version.
  await db("update", { path: `${col}/d4`, patch: { supplier: "Easters" } });
  const d1 = (await q({ ver: first.ver, delta: true })).body.results.k;
  assert.ok(d1.ver > first.ver);
  assert.equal(d1.docs, undefined, "not the whole list");
  assert.deepEqual(d1.delta.map((c) => [c.id, c.data.supplier]), [["d4", "Easters"]]);
  assert.ok(d1.delta[0].ver > 0);
  // Without asking for changes (an older page), the whole list as before.
  assert.deepEqual((await q({ ver: first.ver })).body.results.k.docs.map((d) => d.id), ["d5", "d4", "d3"]);
  // A deletion from a limited list leaves a gap only the whole list can fill: the whole list.
  await db("delete", { path: `${col}/d5` });
  const d2 = (await q({ ver: d1.ver, delta: true })).body.results.k;
  assert.equal(d2.delta, undefined);
  assert.deepEqual(d2.docs.map((d) => d.id), ["d4", "d3", "d2"]);
  // From an unlimited list a deletion is sent as one.
  const all = "sites/cafe/contacts";
  await db("set", { path: `${all}/c1`, data: { name: "Business helpline", visibility: "shared-business", ownerUserId: null } });
  const c0 = (await db("poll", { queries: [{ key: "k", kind: "col", path: all }] })).body.results.k;
  await db("delete", { path: `${all}/c1` });
  const c1 = (await db("poll", { queries: [{ key: "k", kind: "col", path: all, ver: c0.ver, delta: true }] })).body.results.k;
  assert.deepEqual(c1.delta.map((c) => [c.id, c.deleted]), [["c1", true]]);
});

test("too many changes since a device's copy: the whole list instead", async () => {
  const col = "sites/cafe/proveit";
  await db("set", { path: `${col}/p0`, data: { at: 0 } });
  const v0 = (await db("poll", { queries: [{ key: "k", kind: "col", path: col }] })).body.results.k.ver;
  for (let i = 1; i <= 101; i++) await db("set", { path: `${col}/p${i}`, data: { at: i } });
  const r = (await db("poll", { queries: [{ key: "k", kind: "col", path: col, orderBy: "at", dir: "desc", ver: v0, delta: true }] })).body.results.k;
  assert.equal(r.delta, undefined);
  assert.equal(r.docs.length, 102);
});

test("one summary of every site: recent days, the first day, checks without logs, open and recent jobs", async () => {
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  await db("set", { path: "sites/asg/settings/main", data: { units: [], opening: [{ id: "o1", t: "Lights" }], closing: [], weekly: [], closedDays: [] } });
  await db("set", { path: `sites/asg/days/${day(0)}`, data: { date: day(0), opening: { o1: "y" } } });
  await db("set", { path: `sites/asg/days/${day(20)}`, data: { date: day(20) } });
  await db("set", { path: "sites/asg/extras/x1", data: { name: "Probe", freq: "daily", createdAt: 1, lastAt: 5, log: [{ at: 5, by: "web:Will Owner" }] } });
  await db("set", { path: "sites/asg/maintenance/open1", data: { title: "Tap", status: "open" } });
  await db("set", { path: "sites/asg/maintenance/old", data: { title: "Door", status: "done", doneAt: Date.now() - 40 * 864e5 } });
  await db("set", { path: "sites/asg/maintenance/recent", data: { title: "Light", status: "done", doneAt: Date.now() - 864e5 } });
  const q = (ver) => db("poll", { queries: [{ key: "s", kind: "summary", from: day(8), to: day(0), ver }] });
  const r = (await q()).body.results.s;
  assert.ok(r.ver > 0);
  const asg = r.summary.asg;
  assert.deepEqual(asg.settings.opening, [{ id: "o1", t: "Lights" }]);
  assert.deepEqual(Object.keys(asg.days), [day(0)], "only the days asked for");
  assert.equal(asg.firstDay, day(20), "and when the diary started there");
  assert.equal(asg.extras[0].name, "Probe");
  assert.equal(asg.extras[0].lastAt, 5);
  assert.equal(asg.extras[0].log, undefined, "without its log");
  assert.deepEqual(asg.maintenance.map((m) => m.id).sort(), ["open1", "recent"], "open jobs and those done lately");
  assert.deepEqual(Object.keys(r.summary).sort(), ["asg", "cafe", "factory", "roastery"]);
  // Nothing changed: nothing sent. A change anywhere it covers: sent again.
  assert.equal((await q(r.ver)).body.results.s, undefined);
  await db("update", { path: "sites/asg/maintenance/open1", patch: { status: "done", doneAt: Date.now() } });
  const r2 = (await q(r.ver)).body.results.s;
  assert.ok(r2 && r2.ver > r.ver);
  assert.equal(r2.summary.asg.maintenance.find((m) => m.id === "open1").status, "done");
  // Bad dates are refused.
  assert.equal((await db("poll", { queries: [{ key: "s", kind: "summary", from: "x", to: day(0) }] })).status, 400);
});
