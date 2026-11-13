// The customer sign-in page's "Forgotten your password or username?" (public/wholesale-preview/signin.js,
// src/wholesaleReset.ts): ask for a link, open it from the email (a stand-in for Resend), choose a new password and land
// signed in on the ordering page; the contact link; no Staff sign-in link. Phone and iPad, light and dark.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, mock, ADMIN;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function nextMail(ms = 8000) { const end = Date.now() + ms; while (!sent.length && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return sent.shift(); }
before(async () => {
  mock = createServer((rq, rs) => { let x = ""; rq.on("data", (d) => (x += d)); rq.on("end", () => { try { sent.push(JSON.parse(x)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await call("POST", "/api/wholesale/auth/register", { username: "reset.buyer", password: "first-password", business: "Café Reset", contact: "Rae Buyer", email: "rae@reset.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === "reset.buyer");
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: "reset.buyer", ifVersion: account.version, active: true, approvalStatus: "approved" });
});
after(async () => { await b?.close(); await srv?.stop(); mock?.close(); });

test("forgotten password: ask for a link, open it, choose a new password, signed in", async () => {
  let n = 0;
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    srv.sql("DELETE FROM wholesale_resets"); // three emails an hour per sign-in
    const ctx = await b.newContext({ viewport, isMobile: true, hasTouch: true, colorScheme });
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    const shot = (what) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/reset-${what}-${name}-${colorScheme}.png`, fullPage: true });
    await p.goto(srv.base + "/wholesale-preview/signin");
    assert.equal(await p.getByText("Staff sign-in").count(), 0, "no staff sign-in on the customer page");
    assert.equal(await p.locator("#contact-link").getAttribute("href"), "mailto:sales@strangerscoffee.com");
    await p.getByRole("button", { name: "Forgotten your password or username?" }).click();
    await p.locator("#forgot-form").waitFor();
    assert.equal(await p.locator("#wholesale-login").isHidden(), true);
    await p.locator("#forgot-identifier").fill("rae@reset.example");
    await p.getByRole("button", { name: "Email me a reset link" }).click();
    await p.locator("#forgot-sent", { hasText: "If that matches a wholesale account" }).waitFor();
    await shot("sent");
    const mail = await nextMail();
    assert.ok(mail, "emailed");
    const link = /(\/wholesale-preview\/signin\?reset=[a-f0-9]+)/.exec(mail.text)[1];
    await p.getByRole("button", { name: "Back to sign-in" }).click();
    await p.locator("#wholesale-login").waitFor();

    await p.goto(srv.base + link);
    await p.locator("#reset-intro", { hasText: "Your username is reset.buyer" }).waitFor();
    assert.equal(new URL(p.url()).search, "", "the link is taken out of the address bar");
    assert.match(await p.locator("#login-intro").innerText(), /Choose a new password for Café Reset/);
    await shot("choose");
    const pw = `new-password-${++n}`;
    await p.locator("#reset-password").fill(pw);
    await p.locator("#reset-password2").fill("not-the-same-1");
    await p.getByRole("button", { name: "Save password and sign in" }).click();
    await p.locator("#reset-error", { hasText: "do not match" }).waitFor();
    await p.locator("#reset-password2").fill(pw);
    await p.getByRole("button", { name: "Save password and sign in" }).click();
    await p.waitForURL((u) => !u.pathname.endsWith("/signin"));
    assert.equal((await call("POST", "/api/wholesale/auth/login", { username: "reset.buyer", password: pw }, null)).status, 200);
    // The same link again says so.
    await p.goto(srv.base + link);
    await p.locator("#login-intro", { hasText: "already been used" }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
