// A lost checkout response must never become a second customer order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return { response, body: result };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const setup = await api("POST", "/api/auth/setup", { name: "Beta Owner", username: "owner", password: "beta-owner-password", code: SETUP_CODE }, null);
  ADMIN = cookieOf(setup.response);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

async function buyerAccount(username) {
  const customer = (await api("POST", "/api/admin/wholesale/customers", { business: `${username} cafe`, contact: "Coffee Buyer", email: `${username}@example.test`, status: "Active", paymentTerms: "net-30", paymentNote: "Quote your invoice number.", note: "Private customer note" })).body.customer;
  const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
  const password = `${username}-password`;
  await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: password }, null);
  return { customer, username, password };
}
async function buyer(username, productId, reference) {
  const { customer, password } = await buyerAccount(username);
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(srv.base + "/wholesale-preview/signin");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#login-submit").click();
  await page.waitForURL(/\/wholesale-preview\/$/);
  const card = page.locator(`article[data-product="${productId}"]`);
  await card.waitFor();
  await card.locator('input[name="pack"][value="kilo"]').check();
  await card.locator('button[type="submit"]').click();
  await page.locator("#review-order").click();
  await page.locator("#review-dialog").waitFor();
  await page.locator('#review-form [name="delivery"][value="collection"]').check();
  await page.locator('#review-form [name="reference"]').fill(reference);
  return { context, page, customer };
}
async function ownOrders(customerId) {
  return (await api("GET", "/api/admin/wholesale")).body.orders.filter((row) => row.customerId === customerId);
}

test("beta checkout: a saved order with a lost response is recovered after reload, even if stock, prices and terms changed", { timeout: 90000 }, async () => {
  const { context, page, customer } = await buyer("beta.saved", "brazil", "BETA-LOST-RESPONSE");
  try {
    let submitted, saved;
    let sent;
    const persisted = new Promise((resolve) => { sent = resolve; });
    await page.route("**/api/wholesale/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submitted = route.request().postDataJSON();
      const response = await route.fetch();
      saved = { status: response.status(), body: await response.json() };
      await route.abort("failed");
      sent();
    });
    await page.locator("#submit-preview-order").click();
    await persisted;
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    await page.locator("#preview-submit-error:not([hidden])").waitFor();
    assert.equal((await ownOrders(customer.id)).length, 1);

    // An exact saved request must keep its agreement despite newer catalogue/account data.
    const catalogue = (await api("GET", "/api/admin/wholesale")).body;
    const coffee = catalogue.products.find((row) => row.id === "brazil");
    await api("PUT", "/api/admin/wholesale/catalogue/brazil", { ifVersion: coffee.version, prices: { ...coffee.prices, kilo: coffee.prices.kilo + 500 }, active: true, inStock: false });
    const currentCustomer = catalogue.customers.find((row) => row.id === customer.id);
    await api("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...currentCustomer, ifVersion: currentCustomer.version, paymentTerms: "net-7", paymentNote: "New agreement for future orders." });

    await page.reload();
    await page.locator("#products article").first().waitFor();
    await page.locator("#review-order").click();
    await page.locator("#preview-complete").waitFor();
    assert.match(await page.locator("#complete-message").textContent(), new RegExp(saved.body.order.id));
    assert.equal(await page.locator("#complete-total").textContent(), "£37.00");
    assert.match(await page.locator("#complete-payment-terms").textContent(), /30 days from invoice/);
    assert.equal((await ownOrders(customer.id)).length, 1, "recovering a receipt cannot submit a duplicate order");
    assert.equal(saved.body.order.reference, submitted.reference);
    assert.equal(saved.body.order.paymentTerms.id, "net-30");
  } finally { await context.close(); }
});

test("beta checkout: an unsent request survives reload and retries its exact reviewed payload once", { timeout: 90000 }, async () => {
  const { context, page, customer } = await buyer("beta.unsent", "colombia", "BETA-FROZEN-REFERENCE");
  try {
    const payloads = [];
    let failNext = true;
    await page.route("**/api/wholesale/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      payloads.push(route.request().postDataJSON());
      if (failNext) { failNext = false; return route.abort("failed"); }
      return route.continue();
    });
    await page.locator("#submit-preview-order").click();
    await page.locator("#preview-submit-error:not([hidden])").waitFor();
    assert.equal((await ownOrders(customer.id)).length, 0, "the first request never reached the Worker");
    await page.reload();
    await page.locator("#products article").first().waitFor();
    await page.locator("#review-order").click();
    await page.locator("#review-dialog").waitFor();
    assert.equal(await page.locator('#review-form [name="reference"]').inputValue(), "BETA-FROZEN-REFERENCE");
    assert.equal(await page.locator('#review-form [name="reference"]').getAttribute("readonly"), "");
    assert.equal(await page.locator('#review-form [name="delivery"][value="collection"]').isChecked(), true);
    await page.locator("#submit-preview-order").click();
    await page.locator("#preview-complete").waitFor();
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1], payloads[0], "retry uses the original request ID, reference, quoted prices and customer version");
    const orders = await ownOrders(customer.id);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].reference, "BETA-FROZEN-REFERENCE");
    assert.match(await page.locator("#complete-message").textContent(), new RegExp(orders[0].id));
  } finally { await context.close(); }
});

test("beta checkout: malformed success JSON preserves recovery of an order that was saved", { timeout: 90000 }, async () => {
  const { context, page, customer } = await buyer("beta.malformed", "colombia", "BETA-MALFORMED-RESPONSE");
  try {
    let saved;
    await page.route("**/api/wholesale/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      saved = { status: response.status(), body: await response.json() };
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.locator("#submit-preview-order").click();
    await page.locator("#preview-submit-error:not([hidden])").waitFor();
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await ownOrders(customer.id)).length, 1);
    await page.reload();
    await page.locator("#products article").first().waitFor();
    await page.locator("#review-order").click();
    await page.locator("#preview-complete").waitFor();
    assert.match(await page.locator("#complete-message").textContent(), new RegExp(saved.body.order.id));
    assert.equal((await ownOrders(customer.id)).length, 1, "invalid confirmation data cannot discard the saved attempt and create a new order");
  } finally { await context.close(); }
});

test("beta checkout: switching business sessions cannot send another customer's pending request", { timeout: 90000 }, async () => {
  const { context, page, customer } = await buyer("beta.original", "colombia", "BETA-ORIGINAL-BUSINESS");
  try {
    const other = await buyerAccount("beta.other");
    let failNext = true;
    await page.route("**/api/wholesale/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (failNext) { failNext = false; return route.abort("failed"); }
      return route.continue();
    });
    await page.locator("#submit-preview-order").click();
    await page.locator("#preview-submit-error:not([hidden])").waitFor();
    const switched = await page.evaluate(async ({ username, password }) => {
      const response = await fetch("/api/wholesale/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      return { status: response.status, body: await response.json() };
    }, { username: other.username, password: other.password });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    await page.locator("#submit-preview-order").click();
    await page.waitForFunction((business) => document.querySelector("#signed-in-name")?.textContent === business, other.customer.business);
    assert.equal(await page.locator("#review-dialog").isVisible(), false, "a new business starts with its own ordering state");
    assert.equal((await ownOrders(customer.id)).length, 0);
    assert.equal((await ownOrders(other.customer.id)).length, 0, "a pending request from a previous business can never be submitted as the newly signed-in business");
  } finally { await context.close(); }
});

for (const restored of [true, false]) {
  test(`beta account: ${restored ? "a restored cached page" : "saving an open stale profile"} cannot expose or copy another business's details`, { timeout: 90000 }, async () => {
    const suffix = restored ? "cached" : "active";
    const { context, page, customer } = await buyer(`beta.${suffix}.first`, "colombia", "UNSUBMITTED-PROFILE-CHECK");
    try {
      const other = await buyerAccount(`beta.${suffix}.second`);
      await page.locator("#review-dialog .close-button").click();
      await page.locator("#my-account").click();
      await page.locator("#account-dialog").waitFor();
      assert.equal(await page.locator('#account-business').textContent(), customer.business);
      assert.equal(await page.locator('#account-form input[name="business"]:not([readonly]):not([hidden])').count(), 0, 'the approved business name is read-only');
      if (!restored) {
        await page.locator('#account-form [name="contact"]').fill("Unsaved first-business contact");
        await page.locator('#account-form [name="address"]').fill("Do not copy this address to another business");
      }
      const before = (await api("GET", "/api/admin/wholesale")).body.customers.filter((row) => [customer.id, other.customer.id].includes(row.id));
      const switched = await page.evaluate(async ({ username, password }) => {
        window.profileBeforeSessionChange = true;
        const response = await fetch("/api/wholesale/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
        return { status: response.status, body: await response.json() };
      }, { username: other.username, password: other.password });
      assert.equal(switched.status, 200, JSON.stringify(switched.body));
      let profileWrites = 0;
      await page.route("**/api/wholesale/account", async (route) => { if (route.request().method() === "PUT") profileWrites++; return route.continue(); });
      if (restored) await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      else await page.locator('#save-account').click();
      await page.waitForFunction((business) => document.querySelector("#signed-in-name")?.textContent === business, other.customer.business);
      assert.equal(await page.locator("dialog[open]").count(), 0, "the newly signed-in business sees no previous account, history or repeat dialog");
      assert.equal(await page.evaluate(() => window.profileBeforeSessionChange), undefined, "session changes replace the old document and its private form state");
      assert.equal(profileWrites, 0, "a stale profile is refused before any customer update is sent");
      const after = (await api("GET", "/api/admin/wholesale")).body.customers.filter((row) => [customer.id, other.customer.id].includes(row.id));
      const byId = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(byId(after), byId(before), "neither business's contact, delivery or account details change");
    } finally { await context.close(); }
  });
}

test("beta checkout: deleting a saved uncertain order prevents frozen retries from recreating it", { timeout: 90000 }, async () => {
  const { context, page, customer } = await buyer("beta.deleted", "colombia", "BETA-DELETED-PENDING");
  try {
    let saved, postCount = 0;
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/wholesale/orders") postCount++; });
    const lostResponse = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      saved = { status: response.status(), body: await response.json() };
      await route.abort("failed");
    };
    await page.route("**/api/wholesale/orders", lostResponse);
    await page.locator("#submit-preview-order").click();
    await page.locator("#preview-submit-error:not([hidden])").waitFor();
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const original = saved.body.order;
    assert.equal((await ownOrders(customer.id)).length, 1);
    const removed = await api("DELETE", `/api/admin/wholesale/orders/${original.id}`, { ifVersion: original.version });
    assert.equal(removed.body.deleted, true);
    assert.equal((await ownOrders(customer.id)).length, 0);
    const deletedRead = await page.evaluate(async (id) => (await fetch(`/api/wholesale/orders/${id}`)).status, original.id);
    assert.equal(deletedRead, 404);

    await page.unroute("**/api/wholesale/orders", lostResponse);
    await page.reload();
    await page.locator("#products article").first().waitFor();
    await page.locator("#review-order").click();
    await page.locator("#review-dialog").waitFor();
    assert.equal(await page.locator('#review-form [name="reference"]').inputValue(), "BETA-DELETED-PENDING");
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/wholesale/orders");
    await page.locator("#submit-preview-order").click();
    const response = await rejected;
    assert.equal(response.status(), 410);
    assert.equal((await response.json()).code, "order_deleted");
    await page.locator("#preview-submit-error", { hasText: "removed by Strangers" }).waitFor();
    assert.equal(await page.locator("#submit-preview-order").isDisabled(), true, "a deleted frozen request requires closing and freshly reviewing");
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith(".pending-order"))), false, "the confirmed deletion clears uncertain submission recovery");
    await page.locator("#review-form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(postCount, 2, "the rejected review cannot submit again, including through a form submit event");
    await page.locator("#review-dialog .close-button").click();
    await page.locator("#review-order").click();
    await page.locator("#review-dialog").waitFor();
    assert.equal(await page.locator("#submit-preview-order").isEnabled(), true, "a fresh review permits a genuinely new order");
    assert.equal(await page.locator('#review-form [name="reference"]').inputValue(), "");
    assert.equal(await page.locator('#review-form [name="reference"]').getAttribute("readonly"), null);
    assert.equal(postCount, 2, "opening a fresh review never places another order automatically");
    assert.equal((await ownOrders(customer.id)).length, 0, "the removed order stays removed");
  } finally { await context.close(); }
});
