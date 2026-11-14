// The customer sign-in page's "Forgotten your details?" (public/wholesale/signin.js,
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
let confirmationText;
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
    await p.goto(srv.base + "/wholesale/signin");
    assert.equal(await p.getByText("Staff sign-in").count(), 0, "no staff sign-in on the customer page");
    assert.equal(await p.locator("#contact-link").getAttribute("href"), "mailto:sales@strangerscoffee.com");
    assert.equal(await p.locator('#password').getAttribute('autocomplete'), 'current-password');
    await p.locator('#password').fill('unsent-preview-password');
    await p.getByRole('button', { name: 'Show password', exact: true }).click();
    assert.equal(await p.locator('#password').getAttribute('type'), 'text');
    assert.equal(await p.locator('#password').evaluate(node => node.spellcheck), false, 'revealed passwords stay out of spellchecking');
    assert.equal(await p.locator('#password').getAttribute('autocapitalize'), 'none');
    assert.equal(await p.getByRole('button', { name: 'Hide password', exact: true }).getAttribute('aria-pressed'), 'true');
    const centred = await p.locator('.login-recovery').evaluate(node => {
      const outer = node.getBoundingClientRect(), button = node.querySelector('button').getBoundingClientRect();
      return Math.abs((outer.left + outer.right - button.left - button.right) / 2) < 1;
    });
    assert.equal(centred, true, 'recovery sits centrally under the password field');
    assert.match(await p.locator('.login-footer').innerText(), /Help\s+Terms\s+Strangers Coffee Company/);
    await p.getByRole("button", { name: "Forgotten your details?" }).click();
    assert.equal(await p.locator('#password').getAttribute('type'), 'password');
    assert.equal(await p.locator('#password').inputValue(), '', 'leaving sign-in clears its password');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.locator("#forgot-form").waitFor();
    assert.equal(await p.locator("#wholesale-login").isHidden(), true);
    await p.locator("#forgot-identifier").fill("rae@reset.example");
    await p.getByRole("button", { name: "Email me a reset link" }).click();
    await p.locator("#forgot-sent", { hasText: "If those details match an account" }).waitFor();
    assert.equal(await p.locator('#login-title').textContent(), 'Check your inbox.');
    const confirmation = await p.locator('#forgot-sent').textContent();
    if (!confirmationText) confirmationText = confirmation;
    assert.equal(confirmation, confirmationText);
    assert.equal(await p.locator('#forgot-form').isVisible(), false);
    await shot("sent");
    const mail = await nextMail();
    assert.ok(mail, "emailed");
    const link = /(\/wholesale\/signin\?reset=[a-f0-9]+)/.exec(mail.text)[1];
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

test('an unknown account gets the same recovery confirmation and retains its details for correction', async () => {
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 } }), p = await ctx.newPage();
  try {
    await p.goto(srv.base + '/wholesale/signin');
    await p.locator('#forgot-toggle').click();
    await p.locator('#forgot-identifier').fill('nobody-here@example.test');
    await p.locator('#forgot-submit').click();
    await p.locator('#forgot-complete').waitFor();
    assert.match(await p.locator('#forgot-sent').textContent(), /If those details match an account/, 'confirmation stays conditional for unknown accounts');
    assert.doesNotMatch(await p.locator('#forgot-complete').innerText(), /nobody-here@example\.test/, 'confirmation does not reveal or reflect a submitted identity');
    assert.equal(sent.length, 0, 'no email is sent to an unknown address');
    await p.locator('#forgot-again').click();
    assert.equal(await p.locator('#forgot-identifier').inputValue(), 'nobody-here@example.test');
    assert.equal(await p.locator('#forgot-identifier').evaluate(node => node === document.activeElement), true);
  } finally { await ctx.close(); }
});

test('recovery blocks duplicate requests and preserves the input after a failed send', async () => {
  const ctx = await b.newContext({ viewport: { width: 320, height: 700 } }), p = await ctx.newPage();
  let release; const pending = new Promise(resolve => { release = resolve; }); let requests = 0;
  await p.route('**/api/wholesale/auth/forgot', async route => {
    requests++;
    if (requests === 1) { await pending; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Please try again.' }) }); }
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  try {
    await p.goto(srv.base + '/wholesale/signin'); await p.locator('#forgot-toggle').click();
    await p.locator('#forgot-identifier').fill('customer@example.test'); await p.locator('#forgot-submit').click();
    assert.equal(await p.locator('#forgot-submit').isDisabled(), true);
    assert.equal(await p.locator('#auth-back').isDisabled(), true);
    await p.locator('#forgot-identifier').press('Enter');
    assert.equal(requests, 1);
    release(); await p.locator('#forgot-error', { hasText: 'Please try again.' }).waitFor();
    assert.equal(await p.locator('#forgot-identifier').inputValue(), 'customer@example.test');
    assert.equal(await p.locator('#forgot-submit').isEnabled(), true);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.locator('#forgot-submit').click(); await p.locator('#forgot-complete').waitFor(); assert.equal(requests, 2);
  } finally { release(); await ctx.close(); }
});

test('temporary passwords still require a new password before opening the catalogue', async () => {
  const customer = (await call('POST', '/api/admin/wholesale/customers', { business: 'Temporary Password Café', contact: 'Buyer', email: 'temporary@example.test', address: '10 Coffee Street', postcode: 'NR1 1AA', status: 'Active' })).body.customer;
  const account = (await call('POST', `/api/admin/wholesale/customers/${customer.id}/account`, { username: 'temporary.buyer' })).body;
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, colorScheme: 'dark' }), p = await ctx.newPage();
  try {
    await p.goto(srv.base + '/wholesale/signin'); await p.locator('#username').fill('temporary.buyer'); await p.locator('#password').fill(account.temporaryPassword); await p.locator('#login-submit').click();
    await p.locator('#password-change').waitFor(); assert.equal(await p.locator('#login-title').innerText(), 'Choose your own password.');
    await p.locator('#new-password').fill('new-temporary-buyer-password'); await p.locator('#confirm-password').fill('a-different-password'); await p.locator('#login-submit').click();
    await p.locator('#login-error', { hasText: 'do not match' }).waitFor();
    await p.locator('#confirm-password').fill('new-temporary-buyer-password'); await p.locator('#login-submit').click();
    await p.waitForURL('**/wholesale/'); await p.locator('#products article').first().waitFor();
    assert.equal((await call('POST', '/api/wholesale/auth/login', { username: 'temporary.buyer', password: 'new-temporary-buyer-password' }, null)).status, 200);
  } finally { await ctx.close(); }
});

test('leaving reset-link verification prevents its late response from reopening the form', async () => {
  const ctx = await b.newContext({ viewport: { width: 820, height: 1000 } }), p = await ctx.newPage();
  let release; const pending = new Promise(resolve => { release = resolve; });
  await p.route('**/api/wholesale/auth/reset?token=*', async route => {
    await pending;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'late.username', business: 'Late Business' }) });
  });
  try {
    await p.goto(srv.base + '/wholesale/signin?reset=' + 'a'.repeat(64));
    await p.locator('#reset-form').waitFor(); assert.equal(await p.locator('#reset-submit').isDisabled(), true);
    assert.equal(new URL(p.url()).search, '');
    await p.locator('#auth-back').click();
    const response = p.waitForResponse(r => new URL(r.url()).pathname.endsWith('/auth/reset'));
    release(); await (await response).finished();
    await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await p.locator('#reset-form').isVisible(), false);
    assert.equal(await p.locator('#login-title').innerText(), 'Welcome back.');
    assert.doesNotMatch(await p.locator('main').innerText(), /late.username|Late Business/);
  } finally { release(); await ctx.close(); }
});

test('a browser without JavaScript cannot submit credentials into the page URL', async () => {
  const ctx = await b.newContext({ javaScriptEnabled: false, viewport: { width: 393, height: 852 } }), p = await ctx.newPage();
  const requests = []; p.on('request', request => requests.push(request.url()));
  try {
    await p.goto(srv.base + '/wholesale/signin');
    await p.locator('#username').fill('unsent.user'); await p.locator('#password').fill('unsent-private-password');
    assert.equal(await p.locator('#login-submit').isDisabled(), true);
    await p.locator('#password').press('Enter');
    assert.equal(new URL(p.url()).search, '');
    assert.ok(requests.every(url => !url.includes('unsent.user') && !url.includes('unsent-private-password')));
    assert.equal(await p.locator('noscript').isVisible(), true);
  } finally { await ctx.close(); }
});
