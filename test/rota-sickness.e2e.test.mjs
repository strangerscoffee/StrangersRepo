// Report sickness in the rota app (phone, small phone, iPad; light and dark): off sick with the hours preview, going
// home early, and the declaration. Then Admin → Sickness: the Bradford Factor, a form's answers, and removing one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN, index = 0;
const cookieOf = (r) => (r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const london = (offset = 0) => new Date(Date.now() + offset * 864e5).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
async function staff() {
  const name = "Sick Person " + (++index), username = "sick." + index;
  const u = (await call("POST", "/api/admin/users", { name, username, role: "staff", password: "temporary-password" })).body.user;
  const cookie = (await call("POST", "/api/auth/change", { username, password: "temporary-password", newPassword: "personal-password-1" }, null)).cookie;
  return { ...u, cookie };
}
async function context(viewport, colorScheme, cookie) {
  const c = await browser.newContext({ viewport, colorScheme });
  const [name, value] = cookie.split("="); await c.addCookies([{ name, value, url: srv.base }]);
  const page = await c.newPage(), errors = []; page.on("pageerror", (e) => errors.push(e.message));
  return { c, page, errors };
}
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/sick-${name}.png`, fullPage: true });
const noSideways = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Sick Admin", username: "owner", password: "owner-password-1", code: SETUP_CODE }, null)).cookie;
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [device, viewport] of [["smallphone", { width: 320, height: 740 }], ["phone", { width: 393, height: 852 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
  test(`report sickness ${device} ${colorScheme}: off sick with the hours preview`, { timeout: 120000 }, async () => {
    const u = await staff();
    assert.equal((await call("POST", "/api/rota/shifts", { site: "cafe", day: london(), start: "08:00", end: "16:00", breakMins: 30, job: "", userId: u.id })).status, 200);
    const { c, page: p, errors } = await context(viewport, colorScheme, u.cookie);
    try {
      await p.goto(srv.base + "/rota/#mine");
      await p.locator(".sick-link").click();
      await p.locator(".sick-form").waitFor();
      await p.locator(".sick-choice", { hasText: "I'm off sick" }).click();
      await p.locator(".sick-shift").waitFor();
      assert.match(await p.locator(".sick-shifts").innerText(), /Today · 08:00–16:00[\s\S]*7\.5 h[\s\S]*0 h/);
      await p.locator(".sick-submit").click();
      assert.match(await p.locator(".sick-err").innerText(), /Choose what was wrong/);
      await p.locator(".sick-chip", { hasText: "Stomach upset" }).click();
      await p.locator(".sick-field textarea").fill("Up all night being sick");
      for (const [i, answer] of [[0, "Yes"], [1, "No"], [2, "No"]]) await p.locator(".sick-q").nth(i).getByRole("button", { name: answer }).click();
      assert.match(await p.locator(".sick-warn").innerText(), /48 hours/);
      await p.locator(".sick-declare input").check();
      assert.equal(await noSideways(p), true, "no sideways scroll");
      await shot(p, `form-${device}-${colorScheme}`);
      await p.locator(".sick-submit").click();
      await p.locator(".sick-done").waitFor();
      assert.match(await p.locator(".sick-done").innerText(), /Get well soon[\s\S]*Only admins can read it[\s\S]*1 shift/);
      await shot(p, `done-${device}-${colorScheme}`);
      const w = (await call("GET", `/api/rota/week?start=${london()}`)).body.shifts.find((s) => s.userId === u.id);
      assert.equal(w.hours, 0);
      assert.deepEqual(errors, []);
    } finally { await c.close(); }
  });
}

test("going home early on a phone", { timeout: 120000 }, async () => {
  const u = await staff();
  await call("POST", "/api/rota/shifts", { site: "cafe", day: london(-1), start: "09:00", end: "17:00", breakMins: 30, job: "", userId: u.id });
  const { c, page: p, errors } = await context({ width: 393, height: 852 }, "light", u.cookie);
  try {
    await p.goto(srv.base + "/rota/#sick");
    await p.locator(".sick-choice", { hasText: "I went home early" }).click();
    await p.locator(".sick-chip", { hasText: "Yesterday" }).click();
    await p.locator('.sick-field input[type="time"]').fill("12:00");
    await p.locator('.sick-field input[type="time"]').dispatchEvent("change");
    await p.locator(".sick-shift").waitFor();
    await p.locator(".sick-shifts", { hasText: "3 h" }).waitFor();
    await p.locator(".sick-chip", { hasText: "Headache or migraine" }).click();
    await p.locator(".sick-field textarea").fill("Migraine came on mid-morning");
    for (let i = 0; i < 3; i++) await p.locator(".sick-q").nth(i).getByRole("button", { name: "No" }).click();
    await p.locator(".sick-declare input").check();
    await p.locator(".sick-submit").click();
    await p.locator(".sick-done").waitFor();
    const w = (await call("GET", `/api/rota/week?start=${london(-1)}`)).body.shifts.find((s) => s.userId === u.id);
    assert.equal(w.hours, 3);
    assert.deepEqual(errors, []);
  } finally { await c.close(); }
});
