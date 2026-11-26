// "Match with QuickBooks" in Admin → Invoicing → Create batch: orders invoiced by hand in QuickBooks are ticked and
// marked as invoiced, with no invoice issued or emailed. QuickBooks Live's answer is stood in by the page's own route
// (the server's pairing is covered by quickbooks-matches.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { selectInvoiceView, selectWholesaleSection } from "./admin-workspace-helpers.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return { body: result, cookie: cookieOf(response) };
}
before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "Invoice Admin", username: "owner", password: "invoice-owner-password", code: SETUP_CODE }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function dispatched(name, quantity) {
  const username = name.toLowerCase().replace(/\W+/g, "");
  const customer = (await api("POST", "/api/admin/wholesale/customers", { business: name, contact: "Sam", email: username + "@example.test", address: "1 Road", postcode: "NR1 1AA", status: "Active" })).body.customer;
  const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
  const cookie = (await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-password" }, null)).cookie;
  const profile = (await api("GET", "/api/wholesale/session", undefined, cookie)).body.customer;
  const order = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: profile.version, delivery: "Roastery collection", lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity, price: 1800 }] }, cookie)).body.order;
  return (await api("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, status: "Dispatched", customerId: order.customerId, note: "" })).body.order;
}

test("orders invoiced by hand in QuickBooks are matched and marked, without issuing or emailing", { timeout: 120000 }, async () => {
  const cafe = await dispatched("Cafe Soul", 2), grocer = await dispatched("The Green Grocers", 3), tester = await dispatched("Test Account", 1);
  const remote = (id, number, total, date) => ({ id, number, date, totalPence: total, balancePence: total, customerId: "q", customerName: "" });
  const entry = (o, match, invoice) => ({ orderId: o.id, version: o.version, customerId: o.customerId, business: o.business, totalPence: o.totalPence,
    createdAt: o.createdAt, dispatchedAt: o.dispatchedAt, onTab: false, match, invoice });
  const suggestions = [entry(cafe, "exact", remote("58925", "10224", cafe.totalPence, "2026-11-21")),
    entry(grocer, "amount", remote("58938", "10231", grocer.totalPence - 7500, "2026-11-23")), entry(tester, "none", null)];
  for (const [width, height, scheme] of [[390, 844, "dark"], [820, 1180, "light"]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, isMobile: width < 500, hasTouch: width < 500 });
    const [name, value] = ADMIN.split("="); await context.addCookies([{ name, value, url: srv.base }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let posted = null;
    await page.route("**/invoicing/quickbooks-matches", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { company: "Example Coffee Ltd", suggestions } });
      posted = route.request().postDataJSON();
      return route.fulfill({ json: { recorded: posted.matches.length } });
    });
    try {
      await page.goto(srv.base + "/admin#wholesale");
      await selectWholesaleSection(page, "invoices");
      await selectInvoiceView(page, "today");
      await page.locator('[data-act="wh-invoice-batch"]').first().click();
      await page.locator("#iwBatchPicker").waitFor();
      await page.getByRole("button", { name: "Match with QuickBooks" }).click();
      const sheet = page.locator("#iwQbMatches");
      await sheet.waitFor();
      const boxes = sheet.locator("[name=match]");
      assert.equal(await boxes.count(), 2, "the order not found in QuickBooks has nothing to tick");
      assert.deepEqual([await boxes.nth(0).isChecked(), await boxes.nth(1).isChecked()], [true, false], "a different total starts unticked");
      assert.match(await sheet.innerText(), /Nothing is sent to customers, and nothing changes in QuickBooks/);
      assert.match(await sheet.innerText(), /Not found in QuickBooks[\s\S]*Test Account/);
      await sheet.getByRole("button", { name: "Mark 1 order as already invoiced" }).waitFor();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/qb-matches-${width}-${scheme}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await sheet.getByRole("button", { name: "Mark 1 order as already invoiced" }).click();
      await page.locator("#iwBatchPicker").waitFor();
      assert.deepEqual(posted, { matches: [{ orderId: cafe.id, version: cafe.version, remoteId: "58925" }] });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
