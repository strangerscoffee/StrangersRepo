// Rota emails in the browser: an admin adds someone's email address; a manager publishes with "Email everyone on
// this week's rota" and the email goes out (to a stand-in for Resend); the person sees their address and switches an
// email off in the rota. Run with `npm run test:e2e` (needs Playwright). SHOTS=<dir> saves screenshots, including the
// email itself as it arrives.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, mock, browser, ADMIN, MGR, ALEX;
const sent = [];
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const london = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const WEEK = addDays(addDays(london(), -((new Date(london() + "T12:00:00Z").getUTCDay() + 6) % 7)), 7);

async function signUp(name, username, role) {
  await call("POST", "/api/admin/users", { name, username, role, password: "temp-pass-1" });
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temp-pass-1", newPassword: username + "-own-pass" }) });
  return cookieOf(c);
}
async function page(cookie, viewport, scheme = "light") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}

before(async () => {
  mock = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (d) => (b += d));
    rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end("{}"); });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  MGR = await signUp("Giles Armstrong", "giles", "manager");
  ALEX = await signUp("Alex Brown", "alex", "staff");
  await call("POST", "/api/db/set", { path: "settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
  await call("POST", "/api/db/set", { path: "sites/cafe/settings/main", data: { closedDays: [], units: [], opening: [], closing: [], weekly: [], hide: {}, info: {} } });
});
after(async () => { await browser?.close(); await srv?.stop(); mock?.close(); });

test("admin adds an address; publishing emails it; the person switches an email off", async () => {
  const people = (await call("GET", "/api/admin/people")).people;
  const alexId = people.find((p) => p.username === "alex").id;

  // Admin → People → Alex → Edit: the email address.
  const a = await page(ADMIN, { width: 1180, height: 820 });
  await a.p.goto(srv.base + "/admin#people");
  await a.p.locator(".prow, [data-person]", { hasText: "Alex Brown" }).first().click();
  await a.p.locator("button[data-act=edit]").first().click();
  await a.p.fill("#fEmail", "alex@example.com");
  await a.p.locator("#sheet button[type=submit]").click();
  await a.p.locator("#toast", { hasText: "Saved" }).waitFor();
  assert.equal((await call("GET", "/api/admin/people")).people.find((p) => p.id === alexId).email, "alex@example.com");
  await a.p.goto(srv.base + "/admin#overview");
  await a.p.locator("#rem", { hasText: "Rota emails" }).waitFor();
  assert.match(await a.p.locator("section[aria-labelledby=rem]").innerText(), /1 of 3 people have an email address/);
  await a.ctx.close();

  // Shifts for Alex next week, then the manager publishes with emails.
  for (const [i, site, start, end] of [[0, "roastery", "07:30", "15:30"], [1, "roastery", "07:30", "15:30"], [3, "cafe", "09:00", "17:00"], [5, "roastery", "08:00", "14:00"]])
    await call("POST", "/api/rota/shifts", { site, day: addDays(WEEK, i), start, end, breakMins: 30, job: i === 3 ? "closes" : i < 2 ? "opens" : "", userId: alexId }, MGR);
  const m = await page(MGR, { width: 1180, height: 820 });
  await m.p.goto(srv.base + `/rota/#week/${WEEK}`);
  await m.p.locator(".pubbtn").click();
  await m.p.locator(".pubemail", { hasText: "Email everyone on this week's rota" }).waitFor();
  await m.p.locator(".pubemail", { hasText: "1 person to email" }).waitFor();
  assert.equal(await m.p.locator("#pubEmail").isChecked(), true, "ticked by default");
  if (process.env.SHOTS) await m.p.screenshot({ path: process.env.SHOTS + "/publish-ipad.png" });
  await m.p.locator(".sfoot button", { hasText: /^Publish$/ }).click();
  await m.p.locator("#toast", { hasText: "Emailing 1 person" }).waitFor();
  for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], "alex@example.com");
  assert.deepEqual([...a.errors, ...m.errors], []);
  await m.ctx.close();

  // The email itself, as it arrives (design C: the week strip), on a phone and a desktop.
  if (process.env.SHOTS) for (const [n, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1000, height: 900 }]]) {
    const e = await browser.newPage({ viewport: vp });
    await e.setContent(sent[0].html);
    await e.screenshot({ path: `${process.env.SHOTS}/email-${n}.png`, fullPage: true });
    await e.close();
  }

  // Alex sees their address (read-only) and turns open-shift emails on, in light and dark.
  for (const scheme of ["light", "dark"]) {
    const s = await page(ALEX, { width: 390, height: 844 }, scheme);
    await s.p.goto(srv.base + "/rota/#avail");
    await s.p.locator(".lrow", { hasText: "alex@example.com" }).waitFor();
    if (scheme === "light") {
      const sw = s.p.locator("#em_open");
      assert.equal(await sw.isChecked(), false);
      await s.p.locator(".lrow", { hasText: "Open shifts I could take" }).locator(".rswitch").click();
      await s.p.locator("#toast", { hasText: "Emails on" }).waitFor();
    }
    await s.p.locator(".lrow", { hasText: "Open shifts I could take" }).scrollIntoViewIfNeeded();
    if (process.env.SHOTS) await s.p.screenshot({ path: `${process.env.SHOTS}/avail-emails-phone-${scheme}.png` });
    assert.deepEqual(s.errors, []);
    await s.ctx.close();
  }
  assert.equal((await call("GET", "/api/rota/me", undefined, ALEX)).email.prefs.open, true);
});
