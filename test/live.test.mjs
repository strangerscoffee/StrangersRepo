// Live updates (src/live.ts): a page's WebSocket to GET /api/live is told the change counters the moment a write
// lands, answers keep-alives, and is refused when signed out or opened from another site. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const wsUrl = () => srv.base.replace(/^http/, "ws") + "/api/live";
// Under wrangler dev the Worker sees the live address (staffstrangerscoffee.com), which pages' Origin matches.
const ORIGIN = "https://staffstrangerscoffee.com";

/** Opens a live connection; resolves with it once open, or rejects with how it failed. */
function connect({ cookie = ADMIN, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
    const got = [];
    ws.addEventListener("message", (e) => got.push(String(e.data)));
    ws.addEventListener("open", () => resolve({ ws, got }));
    ws.addEventListener("error", () => reject(new Error("refused")));
  });
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return null;
}
const counters = (got) => got.filter((m) => m.startsWith("{")).map((m) => JSON.parse(m));

before(async () => {
  srv = await startServer();
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
});
after(() => srv?.stop());

test("signed out, or from another site, the live connection is refused", async () => {
  await assert.rejects(connect({ cookie: null }), /refused/);
  await assert.rejects(connect({ origin: "https://evil.example" }), /refused/);
  await assert.rejects(connect({ origin: null }), /refused/);
  // Not a WebSocket: says so.
  assert.equal((await fetch(srv.base + "/api/live", { headers: { cookie: ADMIN } })).status, 426);
});

test("a write is pushed to every open page at once, as the change counters only", async () => {
  const a = await connect(), b = await connect();
  const before = await (await fetch(srv.base + "/api/changes", { headers: { cookie: ADMIN } })).json();
  const w = await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "suppliers/s1", data: { name: "Easters" } }) });
  assert.equal(w.status, 200);
  for (const p of [a, b]) {
    const c = await until(() => counters(p.got).find((m) => m.docs > before.docs));
    assert.ok(c, "told about the diary save: " + JSON.stringify(p.got));
    assert.deepEqual(Object.keys(c).sort(), ["accounts", "docs", "rota"], "counters only, no data");
  }
  // A rota change moves the rota counter.
  const s = await fetch(srv.base + "/api/rota/sites/cafe", { method: "PUT", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ minPeople: 2 }) });
  assert.equal(s.status, 200, await s.text());
  assert.ok(await until(() => counters(a.got).find((m) => m.rota > before.rota)), "told about the rota change");
  // Reads don't push anything.
  const n = a.got.length;
  await fetch(srv.base + "/api/db/get", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "suppliers/s1" }) });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(a.got.length, n);
  // Keep-alives are answered.
  a.ws.send("ping");
  assert.ok(await until(() => a.got.includes("pong")));
  a.ws.close(); b.ws.close();
});

test("a closed page is simply dropped; the next write still reaches the others", async () => {
  const a = await connect(), b = await connect();
  a.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "suppliers/s2", data: { name: "Bidfood" } }) });
  assert.ok(await until(() => counters(b.got).length), "the open one is told");
  b.ws.close();
});
