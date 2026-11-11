// The basket explains the 6 kg minimum and holds Review order until it's met, on a phone and an iPad; an exempt
// business sees no minimum at all. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, BUYER, customerId;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000, vars: { WHOLESALE_MINIMUM_ORDER_GRAMS: "" } });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "basket.buyer", password: "basket-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Basket Café", contact: "Buyer", email: "basket@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  customerId = account.customerId;
  await call("PUT", `/api/admin/wholesale/customers/${customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  BUYER = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

test("the basket shows the 6 kg minimum and an exempt business sees none", async () => {
  for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile });
    const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const p = await ctx.newPage();
    await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
    assert.match(await p.locator("#minimum-note").textContent(), /Minimum order 6 kg/, name);
    await p.locator(".product-card").first().locator("button[type=submit]").click();
    if (isMobile) await p.locator("#mobile-basket [data-basket]").click();
    await p.waitForFunction(() => /Add 5 kg more to reach the 6 kg minimum/.test(document.querySelector("#minimum-note").textContent));
    assert.equal(await p.locator("#review-order").isDisabled(), true, `${name}: can't review below the minimum`);
    await p.locator("#order-items input").first().fill("6"); await p.locator("#order-items input").first().press("Tab");
    await p.waitForFunction(() => document.querySelector("#minimum-note").hidden);
    assert.equal(await p.locator("#review-order").isEnabled(), true, `${name}: 6 kg can be reviewed`);
    await p.evaluate(() => localStorage.clear());
    await ctx.close();
  }
  const row = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === customerId);
  const { id, version, updatedAt, ...fields } = row;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, noMinimumOrder: true, ifVersion: version })).status, 200);
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const [n, v] = BUYER.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage();
  await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
  assert.equal(await p.locator("#minimum-note").isHidden(), true, "no minimum shown to an exempt business");
  assert.doesNotMatch(await p.locator("body").textContent(), /minimum/i);
  await p.locator(".product-card").first().locator("button[type=submit]").click();
  await p.locator("#mobile-basket [data-basket]").click();
  await p.waitForFunction(() => !document.querySelector("#review-order").disabled);
  await ctx.close();
});
