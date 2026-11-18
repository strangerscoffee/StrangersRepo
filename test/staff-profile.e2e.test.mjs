// Browser test of the private staff profile and primary sites (18 Nov 2026), on a phone and an iPad in light and
// dark: staff keep their own contact details on the rota's My profile page and see no "Ask for cover"; admins set the
// start date and a primary site plus other sites in Admin → People. Run with `npm run test:e2e` (needs Playwright).
// SHOT_DIR=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN, ALEX, ALEX_ID;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const shot = (page, name) => process.env.SHOT_DIR ? page.screenshot({ path: join(process.env.SHOT_DIR, name + ".png"), fullPage: false }) : null;

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  ALEX_ID = (await call("POST", "/api/admin/users", { name: "Alex Brown", username: "alex", role: "staff", password: "temp-pass-1", email: "alex@example.test" })).user.id;
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alex", password: "temp-pass-1", newPassword: "alex-own-pass" }) });
  ALEX = cookieOf(c);
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function pageFor(viewport, cookie, colorScheme) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 1024, colorScheme });
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { ctx, page, errors };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

for (const [label, viewport, scheme] of [["phone", { width: 393, height: 852 }, "light"], ["iPad", { width: 1180, height: 820 }, "dark"]]) {
  test(`staff profile and primary site on a ${label} (${scheme})`, async () => {
    const phone = label === "phone" ? "07700 900123" : "01603 222333";
    const [start, startText] = label === "phone" ? ["2024-03-04", "4 March 2024"] : ["2023-09-18", "18 September 2023"];
    // Alex fills in their own details.
    const s = await pageFor(viewport, ALEX, scheme);
    await s.page.goto(srv.base + "/rota/#profile");
    await s.page.locator("#pf_phone").waitFor();
    assert.equal(await s.page.locator("text=Ask for cover").count(), 0);
    await s.page.fill("#pf_phone", phone);
    await s.page.fill("#pf_address", "1 Elm Hill\nNorwich\nNR3 1HN");
    await s.page.locator("button", { hasText: "Save my details" }).click();
    await s.page.locator("#toast", { hasText: /admin has been told/ }).waitFor();
    assert.ok(await noOverflow(s.page), "no sideways scroll");
    await shot(s.page, `profile-staff-${label}-${scheme}`);
    // No "Ask for cover" on My shifts either.
    await s.page.goto(srv.base + "/rota/#mine");
    await s.page.locator("#pageTitle").waitFor();
    assert.equal(await s.page.locator("text=Ask for cover").count(), 0);
    assert.deepEqual(s.errors, []);
    await s.ctx.close();

    // The admin sees it on People, sets the start date and a primary site.
    const a = await pageFor(viewport, ADMIN, scheme);
    await a.page.goto(srv.base + "/admin#people");
    await a.page.locator(`[data-person="${ALEX_ID}"]`).first().click();
    const card = a.page.locator("section[aria-label='Staff profile']");
    await card.waitFor();
    assert.match(await card.innerText(), new RegExp(phone));
    assert.match(await card.innerText(), /Elm Hill/);
    await card.locator("button[data-act=profile]").click();
    await a.page.fill("#fStart", start);
    await a.page.locator("#sheet button[type=submit]").click();
    await a.page.locator("#toast", { hasText: "Saved" }).waitFor();
    await a.page.locator("section[aria-label='Staff profile']", { hasText: new RegExp(start.slice(0, 4)) }).waitFor();

    await a.page.locator("button[data-act=avail]").click();
    await a.page.selectOption("#fPrimary", label === "phone" ? "roastery" : "cafe");
    await a.page.selectOption("#fPrimary", "cafe");
    assert.ok(await a.page.locator("#sheet .checks input[value=cafe]").evaluate((i) => i.closest("label").hidden), "the primary site isn't offered twice");
    await a.page.locator("#sheet .checks input[value=asg]").check();
    await shot(a.page, `profile-avail-${label}-${scheme}`);
    await a.page.locator("#sheet button[type=submit]").click();
    await a.page.locator("#toast", { hasText: "Saved" }).waitFor();
    const person = (await call("GET", "/api/admin/people")).people.find((p) => p.id === ALEX_ID);
    assert.equal(person.rota.primarySite, "cafe");
    assert.deepEqual(person.rota.sites, ["asg"]);
    assert.equal(person.profile.startDate, start);
    await a.page.locator("text=Can also work at").first().waitFor();
    await a.page.waitForTimeout(300);
    await a.page.locator("section[aria-label='Staff profile']").scrollIntoViewIfNeeded();
    assert.ok(await noOverflow(a.page), "no sideways scroll");
    await shot(a.page, `profile-admin-${label}-${scheme}`);
    assert.deepEqual(a.errors, []);
    await a.ctx.close();

    // Alex sees the start date read-only.
    const back = await pageFor(viewport, ALEX, scheme);
    await back.page.goto(srv.base + "/rota/#profile");
    await back.page.locator(`text=${startText}`).waitFor();
    await back.ctx.close();
  });
}
