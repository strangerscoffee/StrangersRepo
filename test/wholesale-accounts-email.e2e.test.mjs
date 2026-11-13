// The accounts email in the browser: applying for an account (phone, light and dark), Admin's customer form (iPad) and
// My account (phone).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { openWholesaleAccount } from "./wholesale-ui-helpers.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/accounts-email-${name}.png` });
async function page(cookie, viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, ...extra });
  if (cookie) { const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]); }
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

test("applying for an account takes an accounts email if it's different", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(null, { width: 390, height: 844 }, { colorScheme, isMobile: true, hasTouch: true });
    await p.goto(srv.base + "/wholesale-preview/signin");
    await p.locator("#registration-toggle").click();
    const form = p.locator("#wholesale-login");
    await form.locator('[name="business"]').fill(`Lune House ${colorScheme}`);
    await form.locator('[name="contact"]').fill("Sam");
    await form.locator('[name="email"]').fill("orders@lune.example");
    await form.locator('[name="accountsEmail"]').fill("accounts@lune.example");
    assert.match(await form.innerText(), /Accounts email\s*\(optional, if different: for invoices\)/);
    await p.locator("#username").fill(`lune.${colorScheme}`);
    await p.locator("#password").fill("lune-password-1");
    await shot(p, `apply-${colorScheme}`);
    await form.locator('button[type="submit"]').click();
    await p.locator("#registration-complete").waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const lune = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.business === "Lune House light");
  assert.equal(lune.accountsEmail, "accounts@lune.example");
});

test("Admin edits it on the customer, and the business sees it in My account", async () => {
  const lune = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.business === "Lune House light");
  for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(ADMIN, { width: 820, height: 1180 }, { colorScheme, isMobile: true, hasTouch: true });
    await p.goto(srv.base + "/admin#wholesale");
    await p.locator('[data-act="wh-tab"][data-id="customers"]').first().click();
    await p.locator('[data-act="wh-customer"]', { hasText: "Lune House light" }).click();
    assert.equal(await p.locator("#wAccountsEmail").inputValue(), colorScheme === "light" ? "accounts@lune.example" : "finance@lune.example");
    await p.locator("#wAccountsEmail").fill("finance@lune.example");
    await shot(p, `admin-${colorScheme}`);
    await p.locator('#wCustomerForm button[type="submit"]').click();
    await p.locator("#wCustomerForm").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const saved = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === lune.id);
  assert.equal(saved.accountsEmail, "finance@lune.example");
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((a) => a.customerId === lune.id);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${lune.id}/account`, { username: account.username, ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
  const cookie = (await call("POST", "/api/wholesale/auth/login", { username: "lune.light", password: "lune-password-1" }, null)).cookie;
  const { ctx, p, errors } = await page(cookie, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
  await openWholesaleAccount(p); await p.locator("#account-dialog").waitFor();
  await p.locator('#account-form [name="accountsEmail"]').waitFor({ state: "visible" });
  assert.equal(await p.locator('#account-form [name="accountsEmail"]').inputValue(), "finance@lune.example");
  await p.locator('#account-form [name="accountsEmail"]').scrollIntoViewIfNeeded();
  await shot(p, "my-account");
  assert.deepEqual(errors, []);
  await ctx.close();
});
