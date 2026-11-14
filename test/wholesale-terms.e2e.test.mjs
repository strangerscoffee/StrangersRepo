import { openWholesaleBasket } from './wholesale-ui-helpers.mjs';
// Wholesale Coffee Order Terms and Conditions (public/wholesale-preview/terms.js): read from the sign-in page, the
// footer, My account and the checkout note above Place order; the sign-in page shows the company logo, not a heading
// or the small mark. On a phone and an iPad, light and dark. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, BUYER;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "terms.buyer", password: "terms-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Terms", contact: "Buyer", email: "terms@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  BUYER = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

async function readTerms(p, trigger, label) {
  await trigger.click();
  const d = p.locator("#terms-dialog[open]"); await d.waitFor();
  const text = await d.innerText();
  assert.match(text, /Wholesale Coffee Order Terms and Conditions/, label);
  for (const h of ["Orders", "Prices and payment", "Delivery", "Changes and cancellations", "Problems with an order", "Contact"]) assert.ok(text.includes(h), `${label}: ${h}`);
  assert.match(text, /Payment is due according to the payment terms agreed for your account/);
  return d;
}

test("terms on the sign-in page, footer and checkout; logo on sign-in", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport, isMobile: true, hasTouch: true, colorScheme });
    const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(e.message));
    const shot = (what) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/terms-${what}-${name}-${colorScheme}.png` });

    // Sign-in and registration keep the logo and a clear page heading; terms stay available in the compact footer.
    await p.goto(srv.base + "/wholesale-preview/signin");
    assert.equal(await p.locator(".login-mark").count(), 0, "no small mark");
    assert.equal(await p.locator(".login-logo img[alt='Strangers Coffee Company']").isVisible(), true);
    await p.locator("#registration-toggle").click();
    assert.equal(await p.locator("#login-title").textContent(), "Join us.", "screen readers still get the heading");
    await shot("signin");
    let d = await readTerms(p, p.locator(".login-footer [data-terms]"), `${name} sign-in`);
    await shot("dialog");
    await d.locator(".close-button").click(); await p.locator("#terms-dialog[open]").waitFor({ state: "detached" });

    // Ordering page: footer, My account, and the note above Place order.
    const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
    // The emails' "See your orders" link (…/#orders) opens My orders, then the address loses the #orders.
    await p.goto("about:blank"); await p.goto(srv.base + "/wholesale-preview/#orders"); await p.locator("#orders-dialog[open]").waitFor();
    assert.equal(await p.evaluate(() => location.hash), "");
    await p.locator("#orders-dialog .close-button").click();
    d = await readTerms(p, p.locator(".footer-actions [data-terms]"), `${name} footer`);
    await d.getByRole("button", { name: "Done" }).click();
    const card = p.locator(".product-card").first();
    await card.locator("input[type=number]").fill("2"); await card.locator("button[type=submit]").click();
    await p.locator("#basket-count").waitFor();
    await openWholesaleBasket(p);
    await p.waitForFunction(() => !document.querySelector("#review-order").disabled);
    await openWholesaleBasket(p); await p.locator("#review-order").click(); await p.locator("#review-dialog[open]").waitFor();
    const note = p.locator("#checkout-terms");
    assert.match(await note.innerText(), /By placing this order, you accept the payment terms and conditions set up for your account\./);
    const [noteBox, submitBox] = [await note.boundingBox(), await p.locator("#submit-preview-order").boundingBox()];
    assert.ok(noteBox.y < submitBox.y, "the note sits above Place order");
    await note.scrollIntoViewIfNeeded(); await shot("checkout");
    d = await readTerms(p, note.locator("[data-terms]"), `${name} checkout`);
    await d.locator(".close-button").click();
    assert.equal(await p.locator("#review-dialog").evaluate((x) => x.open), true, "closing the terms keeps the order review open");
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${name} ${colorScheme}: no sideways scroll (${overflow}px)`);
    assert.deepEqual(errors, []);
    await p.evaluate(() => localStorage.clear());
    await ctx.close();
  }
});
