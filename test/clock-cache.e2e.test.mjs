// The page's clock is the server's (public/shared/core.js), learned from x-now. A file the browser keeps (the logo,
// for 24 hours) came back instantly with the time it was first fetched: as the quickest reading it wound the clock
// back to yesterday and the diary opened on yesterday as "Today". Only answers never kept (no-store) set the clock,
// and kept files no longer carry the time. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE, serverTimeIs } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, b;
before(async () => {
  srv = await startServer();
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await b?.close(); await srv?.stop(); });

test("kept files don't carry the server's time; API answers do", async () => {
  const logo = await fetch(srv.base + "/logo.svg");
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("cache-control"), /max-age/);
  assert.equal(logo.headers.get("x-now"), null, "a file the browser keeps has no x-now");
  const api = await fetch(srv.base + "/api/auth/me");
  assert.ok(Math.abs(Number(api.headers.get("x-now")) - Date.now()) < 5000, "the API says the server's time");
});

test("a kept copy of a file with yesterday's time doesn't put the diary on yesterday", async () => {
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will M", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  const C = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  const morning = Date.parse("2026-11-11T07:44:00Z"), yesterday = Date.parse("2026-11-10T20:30:00Z");
  const logo = await fetch(srv.base + "/logo.svg");
  const body = Buffer.from(await logo.arrayBuffer()), headers = Object.fromEntries(logo.headers);
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["iPad", { width: 1180, height: 820 }]]) {
    const ctx = await b.newContext({ viewport });
    await ctx.addCookies([{ name: "sfbb_session", value: C.split("=")[1], url: srv.base }]);
    const p = await ctx.newPage();
    await p.clock.setFixedTime(morning);
    await serverTimeIs(p, morning);
    // A copy kept since last night, as from before this fix: instant, with last night's time.
    await p.route("**/logo.svg", (route) => route.fulfill({ status: 200, body, headers: { ...headers, "x-now": String(yesterday), "cache-control": "private, max-age=86400" } }));
    await p.goto(srv.base + "/#day");
    await p.locator("#openList").waitFor({ state: "attached" });
    await p.evaluate(() => fetch("/logo.svg").then((r) => r.text()));
    assert.equal(await p.evaluate(() => SC.londonToday()), "2026-11-11", `${name}: the page's clock stays on the server's time`);
    assert.equal(await p.locator("#dayDate").inputValue(), "2026-11-11", `${name}: the diary shows today, not yesterday`);
    await ctx.close();
  }
});
