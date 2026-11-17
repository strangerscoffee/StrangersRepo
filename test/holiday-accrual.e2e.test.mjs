// Holiday for extra hours and holiday left to take, in the rota (public/rota/leave.js): an admin reviews the last
// quarter in Holiday management and adds the holiday; the employee sees it with its workings, and how much holiday
// they still have to book before their leave year ends. Phone, small phone and iPad, light and dark.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN, STAFF, staffId, Q;
const cookieOf = (r) => (r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) { const r = await fetch(srv.base + "/api/" + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; }
const day = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const mondayOf = (d) => day(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));
async function context(viewport, colorScheme, cookie) { const c = await browser.newContext({ viewport, colorScheme }); const [name, value] = cookie.split("="); await c.addCookies([{ name, value, url: srv.base }]); const page = await c.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message)); return { c, page, errors }; }
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Holiday Admin", username: "owner", password: "holiday-admin-password", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  await api("POST", "db/set", { path: "settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
  const u = (await api("POST", "admin/users", { name: "Pat Parttime", username: "pat", role: "staff", password: "temporary-holiday-password" })).user;
  staffId = u.id;
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "pat", password: "temporary-holiday-password", newPassword: "personal-holiday-password" }) });
  STAFF = cookieOf(c);
  await api("PUT", `rota/people/${staffId}`, { contractMin: 20, contractMax: 30 });
  await api("PUT", "rota/leave/settings", { enabled: true, yearStart: "04-01", bankHolidayPolicy: "included", limits: {}, ifVersion: 0 });
  const fig = await api("GET", "rota/leave/accrual");
  Q = fig.quarter;
  const W = day(mondayOf(Q.to), -7);
  for (let i = 0; i < 5; i++) await api("POST", "rota/shifts", { site: "roastery", day: day(W, i), start: "07:00", end: "15:30", breakMins: 30, job: "", userId: staffId });
  await api("POST", "rota/week/publish", { week: W });
  const from = (fig.creditDay.slice(5) < "04-01" ? Number(fig.creditDay.slice(0, 4)) - 1 : Number(fig.creditDay.slice(0, 4))) + "-04-01";
  await api("PUT", "rota/leave/allowances", { userId: staffId, from, to: day(`${Number(from.slice(0, 4)) + 1}-04-01`, -1), unit: "days", entitlement: 16, carry: 0, openingUsed: 0, weekly: [1, 1, 1, 1, 1, 0, 0], excludedDates: [], bankHolidays: [], changeReason: "Agreed entitlement", ifVersion: 0 });
  await mkdir("test-results/holiday-accrual", { recursive: true });
});
after(async () => { await browser?.close(); await srv?.stop(); });

let added = false;
for (const [device, viewport] of [["smallphone", { width: 320, height: 740 }], ["phone", { width: 393, height: 852 }], ["portrait iPad", { width: 820, height: 1180 }], ["iPad", { width: 1180, height: 820 }]])
  for (const colorScheme of ["light", "dark"])
    test(`holiday for extra hours and holiday left to take, ${device} ${colorScheme}`, { timeout: 90000 }, async () => {
      const admin = await context(viewport, colorScheme, ADMIN), staff = await context(viewport, colorScheme, STAFF);
      try {
        const p = admin.page;
        await p.goto(srv.base + "/rota/#leave-admin");
        await p.locator("#pageTitle", { hasText: "Holiday management" }).waitFor();
        await p.locator(".leave-takeby-list").waitFor();
        assert.match(await p.locator(".leave-takeby-list").innerText(), /Pat Parttime/);
        await p.getByRole("button", { name: "Review a quarter", exact: true }).click();
        await p.locator(".leave-accrual-row").first().waitFor();
        const row = p.locator(".leave-accrual-row", { hasText: "Pat Parttime" });
        assert.match(await row.innerText(), /12\.07%/);
        assert.equal(await overflow(p), 0, "the quarter fits the screen");
        await p.screenshot({ path: `test-results/holiday-accrual/review-${device.replace(" ", "-")}-${colorScheme}.png`, fullPage: false });
        if (!added) {
          await row.locator("input[type=checkbox]").check();
          await p.getByRole("button", { name: "Add holiday", exact: true }).click();
          await p.locator("#sheet").waitFor({ state: "hidden" });
          added = true;
        } else assert.match(await row.innerText(), /Added/);
        const s = staff.page;
        await s.goto(srv.base + "/rota/#leave");
        await s.locator(".leave-takeby").waitFor();
        assert.match(await s.locator(".leave-takeby").innerText(), /still to book/);
        const details = s.locator(".leave-accruals");
        assert.match(await details.innerText(), /added for extra hours/);
        await details.locator("summary").click();
        assert.match(await details.innerText(), new RegExp(Q.label + ": \\+"));
        assert.match(await details.innerText(), /12\.07%/);
        assert.equal(await overflow(s), 0);
        await s.screenshot({ path: `test-results/holiday-accrual/staff-${device.replace(" ", "-")}-${colorScheme}.png`, fullPage: true });
        assert.deepEqual([...admin.errors, ...staff.errors], []);
      } finally { await admin.c.close(); await staff.c.close(); }
    });
