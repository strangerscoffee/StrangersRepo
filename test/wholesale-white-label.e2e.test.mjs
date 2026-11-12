// White-label coffees in the browser: Admin makes one in Coffee catalogue (White label for one business, Made from two
// coffees); that business sees it first as "Your coffee", another business doesn't see it; staff see what it's made
// from on the staff orders page and in Bags to process; the customer's Admin sheet lists it. Phone and iPad, light and dark.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
let srv, b, ADMIN, lune, other;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function customer(business, username) {
  const c = (await call("POST", "/api/admin/wholesale/customers", { business, contact: "Sam", email: username + "@x.example", address: "1 Elm Hill", postcode: "NR3 1HN", status: "Active" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username })).body;
  const cookie = (await call("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-own-password" }, null)).cookie;
  return { c, cookie };
}
const shot = (p, name) => process.env.WHOLESALE_SCREENSHOT_DIR && p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/white-label-${name}.png` });
async function page(cookie, viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, ...extra });
  const [n, v] = cookie.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, p, errors };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  lune = await customer("Lune House", "lune");
  other = await customer("Other Cafe", "other");
});
after(async () => { await b?.close(); await srv?.stop(); });

test("Admin makes a white-label coffee for one business, made from two coffees", async () => {
  const { ctx, p, errors } = await page(ADMIN, { width: 1180, height: 820 });
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
  await p.locator('[data-act="wh-coffee"]:not([data-id])').click();
  await p.locator("#wCoffeeTitle").fill("Lune House Blend");
  await p.locator("#wCoffeeName").fill("Lune House Blend");
  await p.locator("#wCoffeeOrigin").fill("Brazil & Colombia");
  for (const [pack, price] of [["quarter", "6.50"], ["kilo", "21.50"]]) await p.locator("#wPrice-" + pack).fill(price);
  assert.equal(await p.locator("#wWlPick").isHidden(), true);
  await p.locator("#wWhiteLabel").check();
  await p.locator("#wWlList [data-wl]").first().waitFor();
  await p.locator("#wWlSearch").fill("lune");
  assert.equal(await p.locator("#wWlList [data-wl]").count(), 1);
  await p.locator("#wWlList label", { hasText: "Lune House" }).locator("input").check();
  assert.match(await p.locator("#wWlCount").innerText(), /For Lune House/);
  await p.locator('[data-sheet="recipe-add"]').click();
  await p.locator("[data-recipe]").nth(0).locator("[data-recipe-coffee]").selectOption("brazil");
  await p.locator("[data-recipe]").nth(0).locator("[data-recipe-percent]").fill("60");
  await p.locator('[data-sheet="recipe-add"]').click();
  await p.locator("[data-recipe]").nth(1).locator("[data-recipe-name]").fill("Bom Jesus");
  await p.locator("[data-recipe]").nth(1).locator("[data-recipe-percent]").fill("30");
  assert.match(await p.locator("#wRecipeTotal").innerText(), /90%/);
  await p.locator("#wCoffeeForm button[type=submit]").click();
  assert.match(await p.locator("#wErr").innerText(), /add up to 100/);
  await p.locator("[data-recipe]").nth(1).locator("[data-recipe-percent]").fill("40");
  assert.match(await p.locator("#wRecipeTotal").innerText(), /Adds up to 100%/);
  await p.locator("#wCoffeeForm button[type=submit]").click();
  await p.locator("#wPhotoFiles").waitFor();
  const product = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.title === "Lune House Blend");
  assert.deepEqual(product.whiteLabel, [lune.c.id]);
  assert.deepEqual(product.recipe.map((r) => [r.coffee, r.percent]), [["brazil", 60], [undefined, 40]]);
  assert.equal(product.prices.kilo, 2150);
  // The editor reopens (for photos) with both sections as saved.
  assert.equal(await p.locator("#wWhiteLabel").isChecked(), true);
  assert.equal(await p.locator("[data-recipe]").count(), 2);
  await p.keyboard.press("Escape");
  await p.locator(".w-coffee", { hasText: "Lune House Blend" }).locator(".w-wl-tag").waitFor();
  assert.match(await p.locator(".w-coffee", { hasText: "Lune House Blend" }).innerText(), /Made from 60% .+ · 40% Bom Jesus/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the coffee editor fits phones and iPads, light and dark", async () => {
  const product = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.title === "Lune House Blend");
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(ADMIN, viewport, { colorScheme, isMobile: true, hasTouch: true });
    await p.goto(srv.base + "/admin#wholesale");
    await p.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
    await p.locator(`[data-act="wh-coffee"][data-id="${product.id}"]`).click();
    await p.locator("#wWlList [data-wl]").first().waitFor();
    await p.locator("#wRecipeTitle").scrollIntoViewIfNeeded();
    const overflow = await p.evaluate(() => [...document.querySelectorAll("#wCoffeeForm .w-recipe-row, #wWlPick")].some((n) => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > innerWidth + 1));
    assert.equal(overflow, false, `${name} ${colorScheme}: no sideways overflow`);
    await shot(p, `editor-${name}-${colorScheme}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("its business sees it first as Your coffee; another business never sees it", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(lune.cookie, viewport, { colorScheme, isMobile: true, hasTouch: true });
    await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
    const first = p.locator(".product-card").first();
    assert.match(await first.innerText(), /Your coffee[\s\S]*Lune House Blend/);
    assert.match(await first.innerText(), /£21\.50/);
    // Sorting by price still keeps it first.
    if (await p.locator("#sort-coffee").isVisible()) { await p.locator("#sort-coffee").click(); await p.locator('#sort-menu [data-sort="price-desc"], #sort-menu [value="price-desc"]').first().click().catch(() => {}); }
    assert.match(await p.locator(".product-card").first().innerText(), /Lune House Blend/);
    await shot(p, `customer-${name}-${colorScheme}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { ctx, p } = await page(other.cookie, { width: 390, height: 844 });
  await p.goto(srv.base + "/wholesale-preview/"); await p.locator(".product-card").first().waitFor();
  assert.equal(await p.locator(".product-card", { hasText: "Lune House Blend" }).count(), 0);
  assert.equal(await p.locator(".product-yours").count(), 0);
  await ctx.close();
});

test("staff see what it's made from; the customer's Admin sheet lists it", async () => {
  const product = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.title === "Lune House Blend");
  const session = (await call("GET", "/api/wholesale/session", undefined, lune.cookie)).body;
  const placed = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: product.id, pack: "kilo", grind: "beans", quantity: 10, price: 2150 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, lune.cookie);
  assert.equal(placed.status, 201, placed.text);
  for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await page(ADMIN, { width: 390, height: 844 }, { colorScheme, isMobile: true, hasTouch: true });
    await p.goto(srv.base + "/orders"); await p.locator("#orderList .order-row").first().waitFor();
    await p.locator("#orderList .order-row", { hasText: "Lune House" }).click();
    await p.locator("#orderDetail .w-recipe").waitFor();
    assert.match(await p.locator("#orderDetail .w-recipe").innerText(), /^Made from 60% \S.* · 40% Bom Jesus$/);
    await shot(p, `staff-order-${colorScheme}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  const { ctx, p, errors } = await page(ADMIN, { width: 1180, height: 820 });
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator('[data-act="wh-totals"]').first().click();
  await p.getByText("Coffee for blends and white labels").waitFor();
  assert.match(await p.locator("table", { hasText: "Coffee for blends and white labels" }).innerText(), /Bom Jesus\s+4 kg/);
  await shot(p, "bags-to-process");
  await p.keyboard.press("Escape");
  await p.locator('[data-act="wh-tab"][data-id="customers"]').click();
  await p.locator('[data-act="wh-customer"]', { hasText: "Lune House" }).click();
  await p.locator("#wWlCustomerTitle").scrollIntoViewIfNeeded();
  assert.match(await p.locator("section", { has: p.locator("#wWlCustomerTitle") }).innerText(), /Lune House Blend[\s\S]*£21\.50[\s\S]*Bom Jesus/);
  await p.keyboard.press("Escape");
  await p.locator('[data-act="wh-customer"]', { hasText: "Other Cafe" }).click();
  assert.match(await p.locator("section", { has: p.locator("#wWlCustomerTitle") }).innerText(), /None yet/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
