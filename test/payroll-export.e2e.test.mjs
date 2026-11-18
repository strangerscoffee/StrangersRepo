// Admin → Backups & exports → Hours for payroll: Month (the default) or Week (the owner's request, 18 Nov 2026),
// on a phone and an iPad in light and dark. Run with `npm run test:e2e`; SHOT_DIR saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

let srv, browser, ADMIN;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [label, viewport, scheme] of [["phone", { width: 393, height: 852 }, "light"], ["iPad", { width: 1180, height: 820 }, "dark"]]) test(`payroll export by month or week on a ${label} (${scheme})`, { timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: true, isMobile: viewport.width < 1024, acceptDownloads: true });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(srv.base + "/admin#data");
    const month = page.locator("#hoursMonth");
    await month.waitFor();
    assert.equal(await page.locator("#hoursWeekPick").isHidden(), true, "Month is the default");
    const today = londonToday(), thisMonth = today.slice(0, 7);
    const last = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5)) - 2, 1)).toISOString().slice(0, 7);
    assert.equal(await month.inputValue(), Number(today.slice(8)) <= 10 ? last : thisMonth);
    await month.selectOption(last);
    await page.locator("#hoursMonth").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, `payroll-${label}-${scheme}.png`) });
    let download = page.waitForEvent("download");
    await page.locator('[data-act="hours"]').click();
    let d = await download;
    assert.equal(d.suggestedFilename(), `payroll-hours-${last}.csv`);
    // Week.
    await page.locator('[data-act="hours-mode"][data-id="week"]').click();
    assert.equal(await page.locator("#hoursMonthPick").isHidden(), true);
    await page.locator("#hoursWeek").waitFor();
    assert.match(await page.locator("#hoursHint").innerText(), /for a week/);
    download = page.waitForEvent("download");
    await page.locator('[data-act="hours"]').click();
    d = await download;
    assert.doesNotMatch(d.suggestedFilename(), /payroll-hours-\d{4}-\d{2}\.csv/);
    assert.match(d.url(), /start=\d{4}-\d{2}-\d{2}&format=csv/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
