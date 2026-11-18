// Opening and closing ticks show at once (public/diary/today.js instantPatch; the owner's request, 18 Nov 2026):
// the count and tick update before the save comes back, your own tick doesn't "pop", a refused save puts it back,
// and the saved day matches. On a phone and an iPad, light and dark. Run with `npm run test:e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

let srv, browser, ADMIN;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie: ADMIN }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const settings = { units: [], opening: [{ id: "o1", t: "Hands washed" }, { id: "o2", t: "Fridges on" }, { id: "o3", t: "Floor clean" }], closing: [{ id: "c1", t: "Bins out" }], weekly: [], closedDays: [], hide: {}, info: {}, startDate: "2020-01-01", startSet: true };

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  await call("POST", "/api/db/set", { path: "settings/main", data: settings });
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [label, viewport, scheme] of [["phone", { width: 393, height: 852 }, "light"], ["iPad", { width: 1180, height: 820 }, "dark"]]) test(`opening ticks show at once on a ${label} (${scheme})`, { timeout: 90000 }, async () => {
  await call("POST", "/api/db/delete", { path: "days/" + londonToday() }).catch(() => {});
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: true, isMobile: viewport.width < 1024 });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(srv.base + "/");
    const box = page.locator("#openList");
    await box.locator("label", { hasText: "Hands washed" }).waitFor({ timeout: 20000 });
    if (await box.isHidden()) await page.locator("#openCard .sec").first().click();
    // Hold every save for 2 seconds, like a slow signal.
    let release, held = 0;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/db/{update,set}", async (route) => { held++; await gate; await route.continue().catch(() => {}); });
    await box.locator("label", { hasText: "Hands washed" }).click();
    await box.locator("label", { hasText: "Fridges on" }).click();
    // Both show straight away, with the count, while the saves are still waiting.
    await page.locator("#openCard", { hasText: "2 of 3 ticked" }).waitFor({ timeout: 1500 });
    assert.equal(await box.locator("input#opening_o1").isChecked(), true);
    assert.equal(await box.locator("input#opening_o2").isChecked(), true);
    assert.equal(await box.locator("input.pop").count(), 0, "your own ticks don't pop");
    assert.ok(held >= 1, "the save is still on its way");
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `ticks-${label}-${scheme}.png`) });
    release();
    await page.unroute("**/api/db/{update,set}");
    await page.waitForFunction(() => true);
    // Saved on the server as before.
    for (let i = 0; i < 40; i++) { const d = await call("POST", "/api/db/get", { path: "days/" + londonToday() }).catch(() => null); if (d?.data?.opening?.items?.o2) break; await new Promise((r) => setTimeout(r, 250)); }
    const saved = (await call("POST", "/api/db/get", { path: "days/" + londonToday() })).data;
    assert.deepEqual(saved.opening.items, { o1: true, o2: true });
    assert.equal(await box.locator("input#opening_o1").isChecked(), true, "still ticked after the save");
    // A refused save puts the tick back.
    await page.route("**/api/db/{update,set}", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "permission_denied", message: "Not allowed (test)." }) }).catch(() => {}));
    await box.locator("label", { hasText: "Floor clean" }).click();
    await page.locator("#opening_o3:not(:checked)").waitFor({ timeout: 5000 });
    await page.locator("#openCard", { hasText: "2 of 3 ticked" }).waitFor();
    await page.unroute("**/api/db/{update,set}");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
