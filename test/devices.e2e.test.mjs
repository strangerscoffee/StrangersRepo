// Two devices at once, in the browser (docs/runtime-api.md, "Changes from several devices"):
// - an admin's rota redraws by itself when another admin device changes it;
// - two people editing the same supplier: the second save, made from the older copy, is stopped with a message
//   (not silently overwriting the first), and goes through once they save again having seen the change.
// Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let srv, browser, ADMIN, MGR;
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", cookie }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${path}: ${JSON.stringify(j)}`);
  return j;
}
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const settings = { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], hide: {}, info: {}, startDate: "2020-01-01", startSet: true };

async function device(cookie, viewport = { width: 1180, height: 820 }) {
  const ctx = await browser.newContext({ viewport });
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = cookieOf(r);
  await call("POST", "/api/admin/users", { name: "George Farrow", username: "george", role: "manager", password: "temp-pass-1" });
  const c = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "george", password: "temp-pass-1", newPassword: "george-own-pass" }) });
  MGR = cookieOf(c);
  await call("POST", "/api/db/set", { path: "settings/main", data: settings });
  await call("POST", "/api/db/set", { path: "suppliers/s1", data: { name: "Easters", phone: "01603 000001", supplies: "Milk" } });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test("the admin rota redraws by itself when another admin device adds a shift", async () => {
  const a = await device(ADMIN);
  await a.page.goto(srv.base + "/rota/#week");
  await a.page.locator("#pageTitle", { hasText: /^Week of / }).waitFor();
  // Another device adds a shift today.
  await call("POST", "/api/rota/shifts", { site: "roastery", day: londonToday(), start: "06:15", end: "07:45", breakMins: 0, job: "", userId: null });
  await a.page.locator(".shc", { hasText: "06:15–07:45" }).waitFor({ timeout: 20000 });
  assert.deepEqual(a.errors, []);
  await a.ctx.close();
});

test("two people saving the same supplier: different changes both keep; the same change is stopped, not lost", async () => {
  const a = await device(MGR), b = await device(ADMIN);
  const open = async (d) => {
    await d.page.evaluate(() => editSupplier(S.suppliers.find((x) => x.name === "Easters")));
    await d.page.locator("#s_phone").waitFor({ state: "visible" });
  };
  for (const d of [a, b]) {
    await d.page.goto(srv.base + "/#suppliers");
    await d.page.locator("#sList", { hasText: "Easters" }).waitFor();
    await open(d);
  }
  // A changes the phone number; B, who opened it before A saved, changes the notes. Both changes are kept.
  await a.page.fill("#s_phone", "01603 111111");
  await a.page.locator("button", { hasText: "Save supplier" }).click();
  await a.page.locator("#toast", { hasText: "Saved Easters" }).waitFor();
  await b.page.waitForTimeout(6000); // B's list catches up with A's change; B's form is still the copy B opened
  await b.page.fill("#s_notes", "Delivers Tuesdays");
  await b.page.locator("button", { hasText: "Save supplier" }).click();
  await b.page.locator("#toast", { hasText: "Saved Easters" }).waitFor();
  let doc = await call("POST", "/api/db/get", { path: "suppliers/s1" });
  assert.equal(doc.data.phone, "01603 111111", "A's change is kept");
  assert.equal(doc.data.notes, "Delivers Tuesdays", "and so is B's");

  // Both change the phone number: the second is stopped with a message; saving again (having been told) replaces it.
  await a.page.waitForTimeout(6000);
  await open(a); await open(b);
  await a.page.fill("#s_phone", "01603 222222");
  await a.page.locator("button", { hasText: "Save supplier" }).click();
  await a.page.locator("#toast", { hasText: "Saved Easters" }).waitFor();
  await b.page.fill("#s_phone", "01603 333333");
  await b.page.locator("button", { hasText: "Save supplier" }).click();
  await b.page.locator("#toast", { hasText: "changed this on another device" }).waitFor();
  assert.equal((await call("POST", "/api/db/get", { path: "suppliers/s1" })).data.phone, "01603 222222", "A's isn't overwritten unseen");
  await b.page.locator("button", { hasText: "Save supplier" }).click();
  await b.page.locator("#toast", { hasText: "Saved Easters" }).waitFor();
  doc = await call("POST", "/api/db/get", { path: "suppliers/s1" });
  assert.equal(doc.data.phone, "01603 333333");
  assert.equal(doc.data.notes, "Delivers Tuesdays");
  assert.deepEqual([...a.errors, ...b.errors], []);
  await a.ctx.close(); await b.ctx.close();
});
