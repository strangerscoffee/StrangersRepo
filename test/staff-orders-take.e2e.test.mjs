// Taking an order for a customer on the staff orders page (it came by email, phone or at the door): find the
// customer, choose coffees, bag sizes, grinds and how many, how it came in, and place it; on a phone and an iPad,
// light and dark. No prices on the page. Needs Playwright with Chromium.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, STAFF;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${text}`);
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await call("POST", "/api/admin/wholesale/customers", { business: "Lune Café", contact: "Sam Buyer", email: "sam@lune.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" });
  const staff = (await call("POST", "/api/admin/users", { name: "Sam Packer", username: "packer", role: "staff", password: "temporary-password" })).body.user;
  await call("PUT", `/api/admin/users/${staff.id}/orders-access`, { ifVersion: 0, enabled: true });
  STAFF = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
});
after(async () => { await b?.close(); await srv?.stop(); });

for (const [name, viewport, isMobile] of [["phone", { width: 390, height: 844 }, true], ["iPad", { width: 1180, height: 820 }, false]]) for (const scheme of ["light", "dark"]) {
  test(`staff take an order for a customer on a ${name} (${scheme})`, async () => {
    const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, colorScheme: scheme });
    const [n, v] = STAFF.split("=");
    await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(srv.base + "/orders");
    await page.locator("#newOrder").click();
    const dialog = page.locator("#newOrderDialog");
    await dialog.locator("#noSearch").fill("Lune");
    await dialog.locator(".order-row", { hasText: "Lune Café" }).click();
    await dialog.locator(".no-line select").first().waitFor();
    await dialog.getByRole("button", { name: "In person" }).click();
    await dialog.locator('.no-line input[type="number"]').first().fill("3");
    await dialog.getByRole("button", { name: "Add another coffee" }).click();
    assert.equal(await dialog.locator(".no-line").count(), 2);
    await dialog.locator('.no-line input[type="number"]').nth(1).fill("2");
    assert.match(await dialog.locator("#noTotals").innerText(), /^5 bags · 5 kg/);
    await dialog.locator("#noTab").check();
    assert.ok(!/£/.test(await dialog.innerText()), "no prices");
    assert.equal(await page.evaluate(() => { const d = document.querySelector("#newOrderDialog"); return d.scrollWidth <= d.clientWidth + 1; }), true, "no sideways scrolling");
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/take-${name}-${scheme}.png` });
    await dialog.locator("#placeOrder").click();
    await page.locator("#orderDialog[open]").waitFor();
    assert.match(await page.locator("#orderDetail").innerText(), /Lune Café[\s\S]*Came in\s*In person/);
    assert.match(await page.locator("#tabToggle").innerText(), /Take off tab/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
