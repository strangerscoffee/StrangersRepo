// Import from QuickBooks and invites in a browser: Admin uploads a QuickBooks customer list, sees who bought in the
// last year ticked (from the QuickBooks history in Insights; Strangers' own businesses left out), imports them, then
// invites one; the customer opens the emailed link, chooses a username and password and lands on ordering. Phone and
// iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addDays, ukDay } from "../src/insightsMath.ts";

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
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/import-${name}.png` });
// As QuickBooks exports it: Sales → Customers → Export to Excel (here as CSV).
const LIST = [
  "Customer Contact List", "",
  "Name,Company name,Street Address,City,County/State,Country,Post code/Zip,Phone,Email,Open balance",
  '"Green Grocers, The",The Green Grocers,2 Earlham Road,Norwich,Norfolk,UK,NR2 3RB,01603 222222,pip@greengrocers.example,0.00',
  "Old Dairy,The Old Dairy,Dairy Lane,Wymondham,Norfolk,UK,NR18 0AA,,sam@olddairy.example,12.00",
  "Strangers Roastery,,10 Dove Street,Norwich,,UK,NR2 1DE,,,0.00",
  "Long Gone Ltd,,1 Old Street,Norwich,,UK,NR1 1AA,,gone@example.com,0.00",
].join("\n");
async function adminPage(viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, ...extra });
  const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator('[data-act="wh-tab"][data-id="customers"]').first().click();
  await p.locator('[data-act="wh-import-customers"]').waitFor();
  return { ctx, p, errors };
}
before(async () => {
  mock = createServer((rq, rs) => { let body = ""; rq.on("data", (d) => (body += d)); rq.on("end", () => { try { sent.push(JSON.parse(body)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 3000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  // QuickBooks history: Green Grocers, Old Dairy and Strangers Roastery bought recently; Long Gone two years ago.
  const today = ukDay(Date.now()), row = (customer, date) => ({ date, type: "Invoice", num: customer + date, customer, product: "Campo Santo 1kg", qty: 2, pence: 4800, n: 1 });
  const r = await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: crypto.randomUUID(), fileName: "sales.csv", rows: [row("Green Grocers, The", addDays(today, -10)), row("Old Dairy", addDays(today, -40)), row("Strangers Roastery", addDays(today, -3)), row("Long Gone Ltd", addDays(today, -700))] });
  assert.equal(r.status, 200, r.text);
});
after(async () => { await b?.close(); await srv?.stop(); mock?.close(); });

test("import the QuickBooks customer list, invite one, and the customer sets up their account", async () => {
  const { ctx, p, errors } = await adminPage({ width: 1280, height: 900 });
  await p.locator('[data-act="wh-import-customers"]').click();
  await p.locator("#wImportFile").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(LIST) });
  await p.locator(".w-import-row").first().waitFor();
  assert.equal(await p.locator(".w-import-row").count(), 4);
  const ticked = async () => p.locator(".w-import-row").evaluateAll((rows) => rows.filter((r) => r.querySelector("input").checked).map((r) => r.querySelector("b").textContent));
  assert.deepEqual(await ticked(), ["The Green Grocers", "The Old Dairy"], "bought in the last 12 months, not Strangers' own");
  assert.match(await p.locator(".w-import-row", { hasText: "The Green Grocers" }).innerText(), /pip@greengrocers\.example[\s\S]*NR2 3RB[\s\S]*Last bought/);
  await p.locator('#sheet button[type="submit"]').click();
  await p.locator(".toast, #toast", { hasText: "2 businesses added" }).first().waitFor();
  const grocers = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.business === "The Green Grocers");
  assert.deepEqual([grocers.address, grocers.postcode, grocers.phone, grocers.quickbooksName], ["2 Earlham Road, Norwich, Norfolk", "NR2 3RB", "01603 222222", "Green Grocers, The"]);
  // Invite to order online: both ticked; send.
  await p.locator('[data-act="wh-invite-customers"]').click();
  await p.locator(".w-import-row", { hasText: "The Old Dairy" }).waitFor();
  await p.locator(".w-import-row", { hasText: "The Old Dairy" }).locator("input").uncheck();
  await p.locator('#sheet button[type="submit"]', { hasText: "Send 1 invite" }).click();
  await p.locator(".toast, #toast", { hasText: "1 invite sent" }).first().waitFor();
  assert.match(await p.locator('[data-act="wh-customer"]', { hasText: "The Green Grocers" }).innerText(), /Invited/);
  assert.deepEqual(errors, []);
  await ctx.close();
  const mail = sent.find((m) => m.to[0] === "pip@greengrocers.example");
  const link = /https?:\/\/\S+invite=[a-f0-9]+/.exec(mail.text)[0];
  // The customer: open the link, choose a username and password, land on ordering.
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cp = await c.newPage(), cerrors = []; cp.on("pageerror", (e) => cerrors.push(String(e)));
  await cp.goto(srv.base + new URL(link).pathname + new URL(link).search);
  await cp.locator("#login-intro", { hasText: "The Green Grocers" }).waitFor();
  assert.equal(await cp.evaluate(() => location.search), "", "the token leaves the address bar");
  await cp.locator("#username").fill("greengrocers"); await cp.locator("#password").fill("grocers-own-password"); await cp.locator("#invite-password2").fill("grocers-own-pass");
  await cp.locator("#login-submit").click();
  await cp.locator("#login-error", { hasText: "do not match" }).waitFor();
  await cp.locator("#invite-password2").fill("grocers-own-password");
  await shot(cp, "invite-phone");
  await cp.locator("#login-submit").click();
  await cp.locator(".product-card").first().waitFor();
  assert.deepEqual(cerrors, []);
  await c.close();
});

test("on a phone and an iPad, light and dark", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await adminPage(viewport, { isMobile: true, hasTouch: true, colorScheme });
    await shot(p, `customers-${name}-${colorScheme}`);
    await p.locator('[data-act="wh-import-customers"]').click();
    await p.locator("#wImportFile").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(LIST) });
    await p.locator(".w-import-row").first().waitFor();
    await shot(p, `sheet-${name}-${colorScheme}`);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
