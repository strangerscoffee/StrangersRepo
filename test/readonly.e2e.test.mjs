// What staff see read-only (a signed-off day and week, a HACCP plan, an onboarding document) has no stray "null"
// where a manager's button would be, and Undo sign-off is only for managers and admins. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, b;
before(async () => {
  srv = await startServer();
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await b?.close(); await srv?.stop(); });
const ck = (r) => r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
const post = (p, body, c) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });

test("read-only views: no stray null, and Undo sign-off only for managers and admins", async () => {
  const base = srv.base;
  const A = ck(await post("/api/auth/setup", { name: "William Maddocks", username: "will", password: "admin-pass-1", code: SETUP_CODE }));
  await post("/api/admin/users", { name: "Test Account", username: "test", role: "staff", password: "temp-pass-1" }, A);
  await post("/api/auth/login", { username: "test", password: "temp-pass-1" });
  const T = ck(await post("/api/auth/change", { username: "test", password: "temp-pass-1", newPassword: "test-own-pass" }));
  const today = new Date().toLocaleDateString("en-CA");
  const mon = (() => { const t = new Date(today + "T12:00"); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.toLocaleDateString("en-CA"); })();
  await post("/api/db/set", { path: "settings/main", data: { units: [], opening: [{ id: "o1", t: "Hands" }], closing: [], weekly: [{ id: "w1", t: "Deep clean" }], closedDays: [] } }, A);
  await post("/api/db/set", { path: `days/${today}`, data: { date: today, opening: { items: { o1: true } }, signed: { by: "web:William Maddocks", name: "William Maddocks", at: Date.now() } } }, A);
  await post("/api/db/set", { path: `weeks/${mon}`, data: { week: mon, items: { w1: true }, signed: { by: "web:William Maddocks", name: "William Maddocks", at: Date.now() } } }, A);
  await post("/api/db/set", { path: "plans/h1", data: { type: "haccp", title: "HACCP plan", scope: "Coffee", steps: [], notes: "", history: [] } }, A);
  await post("/api/db/set", { path: "onboarding/o1", data: { category: "Induction", title: "Barista induction", visibility: "shared-business", ownerUserId: null, sections: [{ heading: "Hi", body: "Welcome" }], history: [] } }, A);
  const bad = [];
  for (const [who, c] of [["staff", T], ["admin", A]]) {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 1000 } });
    await ctx.addCookies([{ name: "sfbb_session", value: c.split("=")[1], url: base }]);
    const p = await ctx.newPage();
    const check = async (where) => { const t = await p.locator("main").innerText(); if (/(^|\s)null(\s|$)/.test(t)) bad.push(`${who}: "null" on ${where}`); };
    await p.goto(base + "/#day"); await p.locator("text=Day signed off").first().waitFor(); await check("Today");
    const undo = await p.locator("button", { hasText: "Undo sign-off" }).count();
    if ((who === "staff") !== (undo === 0)) bad.push(`${who}: Undo sign-off shown=${undo}`);
    await p.goto(base + "/#week"); await p.reload(); await p.locator("text=Week signed off").first().waitFor(); await check("This week");
    await p.goto(base + "/#plans"); await p.reload(); await p.locator("#plList .lrow", { hasText: "HACCP plan" }).click(); await p.waitForTimeout(600); await check("HACCP plan");
    await p.goto(base + "/#onboarding"); await p.reload(); await p.locator(".lrow", { hasText: "Barista induction" }).first().click(); await p.waitForTimeout(600); await check("onboarding document");
    await ctx.close();
  }
  assert.deepEqual(bad, []);
});
