// Admin → Wholesale → Insights in a browser: import a QuickBooks "Sales by Product/Service Detail" Excel export and a
// "Sales by Customer Detail" CSV, confirm the product matches, then the tiles, charts, forecast, roast plan (with
// stock taken off), CSV download and printing; on a desktop, and on a phone and an iPad in light and dark.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }
const XLSX = fileURLToPath(new URL("./fixtures/qb-sales-by-product.xlsx", import.meta.url));
let srv, b, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function adminPage(viewport, extra = {}) {
  const ctx = await b.newContext({ viewport, acceptDownloads: true, ...extra });
  const [n, v] = ADMIN.split("="); await ctx.addCookies([{ name: n, value: v, url: srv.base }]);
  await ctx.addInitScript(() => { window.print = () => { window.__printed = document.getElementById("wPrintArea")?.innerText || ""; }; });
  const p = await ctx.newPage(), errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(srv.base + "/admin#wholesale");
  await p.locator('[data-act="wh-tab"][data-id="insights"]').first().click();
  await p.locator("#insTitle").waitFor();
  return { ctx, p, errors };
}
const CUSTOMER_CSV = [
  "Strangers Coffee Company", "Sales by Customer Detail", "January - October 2026", "",
  "Date,Transaction Type,Num,Product/Service,Memo/Description,Qty,Sales Price,Amount,Balance",
  "Market Stall Co,,,,,,,,",
  "05/10/2026,Invoice,M-1,Campo Santo 1kg,,4,24.00,96.00,96.00",
  "12/10/2026,Invoice,M-2,Campo Santo 1kg,,4,24.00,96.00,192.00",
  "12/10/2026,Payment,,,,,,\"(96.00)\",96.00",
  "19/10/2026,Credit Note,M-3,Campo Santo 1kg,,1,24.00,24.00,72.00",
  "Total for Market Stall Co,,,,,,,\"168.00\",",
].join("\n");

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "lune.buyer", password: "lune-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Lune", contact: "Sam", email: "lune@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  const A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  const order = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 10, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, A);
  assert.equal(order.status, 201, order.text);
});
after(async () => { await b?.close(); await srv?.stop(); });

test("import QuickBooks history, confirm products, then read the insights and plan the roast", async () => {
  const { ctx, p, errors } = await adminPage({ width: 1280, height: 900 });
  assert.match(await p.locator(".ins-workspace").innerText(), /1 site order since/);
  // Excel export: preview, import, then the product matches open.
  await p.locator('[data-act="wh-ins-import"]').first().click();
  await p.locator("#insFile").setInputFiles(XLSX);
  await p.locator(".ins-preview").waitFor();
  const preview = await p.locator(".ins-preview").innerText();
  assert.match(preview, /sales lines/); assert.match(preview, /2 Jun 2025 to 26 Oct 2026/); assert.match(preview, /4 products · 2 customers/);
  assert.match(preview, /other rows left out/, "payments are left out");
  await p.locator("#insImportGo").click();
  await p.locator(".ins-products").waitFor({ timeout: 20000 });
  const row = (name) => p.locator("[data-product-row]", { hasText: name });
  assert.equal(await row("Campo Santo 1kg").locator("[data-map-coffee]").inputValue(), "campo");
  assert.equal(await row("Campo Santo 1kg").locator("[data-map-pack]").inputValue(), "kilo");
  assert.equal(await row("Rosalina 250g").locator("[data-map-pack]").inputValue(), "quarter");
  assert.equal(await row("House Blend 1kg").locator("[data-map-coffee]").inputValue(), "house");
  assert.equal(await row("Delivery").locator("[data-map-coffee]").inputValue(), "", "Not coffee");
  assert.equal(await row("Delivery").locator("[data-map-pack]").isDisabled(), true);
  await p.locator('#sheet [data-sheet="save"]').click();
  await p.locator(".ins-products").waitFor({ state: "detached" });

  // The page: tiles, roast plan, charts, forecast with last year's pattern, coffees and customers.
  await p.locator(".ins-note").waitFor({ state: "detached" }); // no products left to check
  await p.locator(".ins-tiles").waitFor();
  const text = await p.locator(".ins-workspace").innerText();
  assert.match(text, /QuickBooks history 2 Jun 2025 to/);
  assert.match(text, /last year's pattern for the same weeks/, "over a year of history: seasonal forecast");
  assert.match(text, /Roast plan · week of/);
  assert.match(text, /Bakehouse Norwich/);
  const campo = p.locator('[data-roast="campo"]');
  assert.match(await campo.innerText(), /10 kg/, "the open site order is in the plan");
  const before = Number(await campo.locator("[data-batches]").innerText());
  assert.ok(before >= 2);
  await campo.locator(".ins-stock").fill("100");
  assert.equal(await campo.locator("[data-batches]").innerText(), "0", "stock in hand takes it off");
  await campo.locator(".ins-stock").fill("");
  await p.locator('[data-act="wh-ins-print-roast"]').click(); await p.waitForFunction(() => window.__printed);
  assert.match(await p.evaluate(() => window.__printed), /Roast plan[\s\S]*Colombia Campo Santo Washed[\s\S]*Total/);
  // Coffee colours: the mix chart stacks each coffee in its packaging colour with a named legend, the movers name
  // coffees, and each coffee has a 12-week line in the by-coffee table.
  const legend = await p.locator(".ins-section", { hasText: "by coffee" }).first().locator(".ins-legend").innerText();
  assert.match(legend, /Colombia Campo Santo Washed/);
  const fills = await p.locator(".ins-seg").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundImage + getComputedStyle(e).backgroundColor))]);
  assert.ok(fills.length >= 2, "coffees are drawn in different colours");
  assert.ok(await p.locator(".ins-move").count() >= 1);
  assert.ok(await p.locator(".ins-trend .ins-spark").count() >= 2);
  // Period and measure switch without reloading the data; the chart has one bar per week up to 3 months.
  await p.locator('[data-act="wh-ins-period"][data-id="4"]').click();
  await p.locator('[data-act="wh-ins-period"][data-id="4"][aria-pressed="true"]').waitFor();
  assert.equal(await p.locator(".ins-section").nth(1).locator(".ins-col").count(), 4);
  await p.locator('[data-act="wh-ins-measure"][data-id="grams"]').click();
  await p.locator("#insTime", { hasText: "Coffee sold by week" }).waitFor();
  await p.locator('[data-act="wh-ins-period"][data-id="all"]').click();
  await p.locator("#insTime", { hasText: "by month" }).waitFor();
  const [download] = await Promise.all([p.waitForEvent("download"), p.locator('[data-act="wh-ins-csv"]').click()]);
  const csv = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  assert.match(csv, /^Week starting,Coffee,Coffee \(kg\)/); assert.match(csv, /Colombia Campo Santo Washed/); assert.match(csv, /Forecast week starting/);

  // A Sales by Customer Detail CSV: customer from the group rows, product from its column; credit notes count against.
  await p.locator('[data-act="wh-ins-import"]').first().click();
  await p.locator("#insFile").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(CUSTOMER_CSV) });
  await p.locator(".ins-preview").waitFor();
  assert.match(await p.locator(".ins-preview").innerText(), /3 sales lines[\s\S]*1 products · 1 customers · £168\.00/);
  await p.locator("#insImportGo").click();
  await p.locator(".ins-products").waitFor({ timeout: 20000 });
  await p.locator('#sheet [data-sheet="close"]').first().click();
  await p.locator(".ins-workspace", { hasText: "Market Stall Co" }).waitFor();
  // One customer: search, pick, and see just their sales and forecast; then back to everyone.
  await p.locator('[data-act="wh-ins-pick"]').click();
  await p.locator("#insCustSearch").fill("bakehouse");
  assert.equal(await p.locator(".ins-pick-row").count(), 1);
  await p.locator(".ins-pick-row").click();
  await p.locator("#insCustTitle", { hasText: "Bakehouse Norwich" }).waitFor();
  assert.match(await p.locator(".ins-pick").innerText(), /Bakehouse Norwich/);
  assert.match(await p.locator("#insFc").innerText(), /Bakehouse Norwich's coffee/);
  assert.equal(await p.locator("#insCust").count(), 0, "no customer table for one customer");
  if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/insights-customer-desktop.png`, fullPage: true });
  await p.locator('[aria-label="Show all customers"]').click();
  await p.locator("#insCust").waitFor();
  await p.locator('[data-act="wh-ins-customer"]', { hasText: "Market Stall Co" }).click();
  await p.locator("#insCustTitle", { hasText: "Market Stall Co" }).waitFor();
  await p.locator('[aria-label="Show all customers"]').click(); await p.locator("#insCust").waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("on a phone and an iPad, light and dark", async () => {
  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["ipad", { width: 820, height: 1180 }]]) for (const colorScheme of ["light", "dark"]) {
    const { ctx, p, errors } = await adminPage(viewport, { isMobile: true, hasTouch: true, colorScheme });
    await p.locator(".ins-tiles").waitFor();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${name} ${colorScheme}: the page doesn't scroll sideways (${overflow}px)`);
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/insights-${name}-${colorScheme}.png`, fullPage: true });
    await p.locator('[data-act="wh-ins-pick"]').click(); await p.locator(".ins-pick-row").first().waitFor();
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/insights-picker-${name}-${colorScheme}.png` });
    await p.locator(".ins-pick-row").first().click(); await p.locator("#insCustTitle").waitFor();
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/insights-one-${name}-${colorScheme}.png`, fullPage: true });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, "one customer: no sideways scroll");
    await p.locator('[aria-label="Show all customers"]').click(); await p.locator("#insCust").waitFor();
    await p.locator('[data-act="wh-ins-products"]').first().click(); await p.locator(".ins-products").waitFor();
    if (process.env.WHOLESALE_SCREENSHOT_DIR) await p.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/insights-products-${name}-${colorScheme}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
