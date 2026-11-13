// Accounts emails in Admin: choose a QuickBooks customer list, see the matches, save them. Phone and iPad, light and dark.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, file;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sfbb_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/accounts-emails-${name}.png` });
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  for (const [business, email] of [["Akcela", "hello@akcela.co.uk"], ["Ampersand Brew Co", "andy@ampersandbrew.co"], ["Black Rabbit Cafe", "manager@blackrabbitcafe.co.uk"]]) await call("POST", "/api/admin/wholesale/customers", { business, contact: "Sam", email, status: "Active" });
  file = join(mkdtempSync(join(tmpdir(), "ae-")), "Customers.csv");
  writeFileSync(file, 'Name,Company name,Email\nAkcela,Akcela,accounts@akcela.co.uk\nAmpersand Brew Co,Ampersand Brew Co,andy@ampersandbrew.co\nBlack Rabbit,Black Rabbit Cafe,"accounts@blackrabbitcafe.co.uk, manager@blackrabbitcafe.co.uk"\nA Bit on the Side,A Bit on the Side,kathryn@example.com\n');
});
after(async () => { await b?.close(); await srv?.stop(); });

async function open(viewport, colorScheme) {
  const ctx = await b.newContext({ viewport, colorScheme, isMobile: true, hasTouch: true });
  const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator('[data-act="wh-tab"][data-id="customers"]').first().click();
  await p.locator('[data-act="wh-accounts-emails"]').click();
  await p.locator("#wAeFile").setInputFiles(file);
  await p.locator(".w-ae-group").first().waitFor();
  return { ctx, p, errors };
}

test("previews on phone and iPad, light and dark, without saving", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await open(viewport, colorScheme);
    const text = await p.locator("#sheet").innerText();
    assert.match(text, /2 businesses to update/);
    assert.match(text, /Add accounts email\s*· 2/);
    assert.match(text, /Same as the order email: nothing to do\s*· 1/);
    assert.match(text, /Not on the website: not added\s*· 1/);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} ${colorScheme}: no sideways scroll`);
    await shot(p, `${name}-${colorScheme}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const rows = (await call("GET", "/api/admin/wholesale")).body.customers;
  assert.ok(rows.every((c) => !c.accountsEmail), "previews save nothing");
  assert.equal(rows.length, 3, "nothing added");
});

test("Save writes the accounts emails and shows what was saved", async () => {
  const { ctx, p, errors } = await open({ width: 1180, height: 820 }, "light");
  await p.locator('#sheet button[type="submit"]').click();
  await p.locator("#sheet", { hasText: "2 accounts emails saved" }).waitFor();
  assert.match(await p.locator("#sheet").innerText(), /Accounts email saved\s*· 2/);
  await shot(p, "saved");
  const rows = Object.fromEntries((await call("GET", "/api/admin/wholesale")).body.customers.map((c) => [c.business, c]));
  assert.equal(rows.Akcela.accountsEmail, "accounts@akcela.co.uk");
  assert.equal(rows["Black Rabbit Cafe"].accountsEmail, "accounts@blackrabbitcafe.co.uk");
  assert.equal(rows["Ampersand Brew Co"].accountsEmail ?? "", "");
  assert.deepEqual(errors, []);
  await ctx.close();
});
