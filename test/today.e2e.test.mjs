// Today on a phone: overdue reminders fold after the first two, and in the morning the closing checks wait folded
// until the opening checks are done (an iPad keeps both open side by side). Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE, serverTimeIs } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, b, C = "";
before(async () => {
  srv = await startServer();
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await b?.close(); await srv?.stop(); });
const set = (path, data) => fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: C }, body: JSON.stringify({ path, data }) });

test("Today: reminders fold after two; closing checks wait folded on a phone in the morning", async () => {
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will M", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  C = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await set("settings/main", { units: [], opening: [{ id: "o1", t: "Hands" }, { id: "o2", t: "Surfaces" }], closing: [{ id: "c1", t: "Bins" }], weekly: [], closedDays: [] });
  for (let i = 0; i < 5; i++) await set(`cleaning/c${i}`, { name: `Overdue job ${i}`, how: "", freq: "weekly", who: "", createdAt: 1, lastAt: Date.now() - (20 + i) * 864e5, log: [] });
  const nine = new Date(); nine.setHours(9, 0, 0, 0);
  const shut = (p) => p.evaluate(() => document.querySelector("#closeCard").classList.contains("shut"));

  const phone = await b.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
  const p = await phone.newPage();
  await p.clock.setFixedTime(nine);
  await serverTimeIs(p, nine.getTime());
  await p.goto(srv.base + "/#day");
  await p.locator("#openList label").first().waitFor();
  await p.locator(".alertmore", { hasText: "3 more overdue" }).waitFor();
  assert.equal(await p.locator("#dayAlerts .alert").count(), 2, "two reminders shown");
  await p.locator(".alertmore").click();
  await p.locator("#dayAlerts .alert", { hasText: "Overdue job 4" }).waitFor();
  assert.equal(await p.locator("#dayAlerts .alert").count(), 5, "all five after Show");
  assert.equal(await shut(p), true, "closing checks folded at 9am while opening is to do");
  for (const t of ["Hands", "Surfaces"]) await p.locator("#openList label", { hasText: t }).click();
  await p.waitForFunction(() => !document.querySelector("#closeCard").classList.contains("shut"));
  await phone.close();

  const ipad = await b.newContext({ viewport: { width: 1194, height: 834 } });
  await ipad.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
  const q = await ipad.newPage();
  await q.clock.setFixedTime(nine);
  await serverTimeIs(q, nine.getTime());
  await set(`days/${nine.toLocaleDateString("en-CA")}`, { date: nine.toLocaleDateString("en-CA") });
  await q.goto(srv.base + "/#day");
  await q.locator("#closeList label").first().waitFor();
  assert.equal(await shut(q), false, "an iPad keeps closing checks open beside opening");
  await ipad.close();
});
