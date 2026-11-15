// The announcement bar in a browser: an admin writes it in Admin → Wholesale → Orders → Announcement (with a preview);
// the customer sees it at the top of the ordering page, can close it (it stays closed after a reload), and a new
// message shows again. On a phone and an iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, A;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { body: data, cookie: cookieOf(r) };
}
async function page(cookie, viewport, isMobile, scheme) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
  const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "lune.cafe", password: "lune-cafe-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Lune", contact: "Mia", email: "mia@lune.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`announcement: an admin writes it, the customer sees and closes it, on a ${name} (${scheme})`, async () => {
    const title = `Christmas dispatch dates (${name} ${scheme})`;
    const admin = await page(ADMIN, viewport, isMobile, scheme);
    await admin.p.goto(srv.base + "/admin#wholesale");
    await admin.p.locator('[data-act="wh-announcement"]').click();
    await admin.p.locator("#wAnnForm").waitFor();
    await admin.p.locator("#wAnnOn").check();
    await admin.p.locator("#wAnnTitle").fill(title);
    await admin.p.locator("#wAnnMessage").fill("Last dispatch before Christmas: Friday 19 December.\nWe reopen on Monday 5 January.");
    await admin.p.locator('input[name="wAnnTone"][value="important"]').check();
    assert.match(await admin.p.locator("#wAnnPreview").innerText(), /Christmas dispatch dates[\s\S]*Friday 19 December/);
    assert.equal(await admin.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.SHOT_DIR) await admin.p.screenshot({ path: `${process.env.SHOT_DIR}/ann-admin-${name}-${scheme}.png` });
    await admin.p.locator('#sheet [data-sheet="save"]').click();
    await admin.p.locator("#wAnnForm").waitFor({ state: "detached" });
    assert.deepEqual(admin.errors, []);
    await admin.ctx.close();

    const c = await page(A, viewport, isMobile, scheme);
    await c.p.goto(srv.base + "/wholesale/"); await c.p.locator(".product-card").first().waitFor();
    const bar = c.p.locator("#announcement");
    await bar.waitFor();
    assert.match(await bar.innerText(), new RegExp(`${title.replace(/[()]/g, "\\$&")}[\\s\\S]*Friday 19 December\\.\\nWe reopen`));
    assert.equal(await bar.evaluate((n) => n.classList.contains("important")), true);
    assert.equal(await c.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.SHOT_DIR) await c.p.screenshot({ path: `${process.env.SHOT_DIR}/ann-customer-${name}-${scheme}.png` });
    await c.p.locator("#announcement-close").click();
    assert.equal(await bar.isHidden(), true);
    await c.p.reload(); await c.p.locator(".product-card").first().waitFor();
    assert.equal(await bar.isHidden(), true, "stays closed on this device");
    // A new message shows again.
    const current = (await call("GET", "/api/admin/wholesale/announcement")).body;
    await call("PUT", "/api/admin/wholesale/announcement", { ifVersion: current.version, enabled: true, title: "", message: "Closed on Boxing Day.", tone: "info" });
    await c.p.reload(); await c.p.locator(".product-card").first().waitFor();
    await bar.waitFor();
    assert.equal((await bar.innerText()).trim().replace(/\s*×$/, ""), "Closed on Boxing Day.");
    assert.deepEqual(c.errors, []);
    await c.ctx.close();
  });
}
