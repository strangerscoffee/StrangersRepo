import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

let server, browser, adminCookie, staffCookie, order, heavy;
async function call(method, path, body, cookie = adminCookie) {
  const response = await fetch(server.base + path, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, method + " " + path + " " + JSON.stringify(data));
  return { ...data, cookie: (response.headers.getSetCookie().find(value => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0] };
}

before(async () => {
  server = await startServer({ writeLimit: 4000 });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  adminCookie = (await call("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const { user } = await call("POST", "/api/admin/users", { name: "Packer", username: "packer", role: "staff", password: "temporary-password" });
  await call("PUT", "/api/admin/users/" + user.id + "/orders-access", { ifVersion: 0, enabled: true });
  staffCookie = (await call("POST", "/api/auth/change", { username: "packer", password: "temporary-password", newPassword: "packer-own-password" }, null)).cookie;
  const { customer } = await call("POST", "/api/admin/wholesale/customers", {
    business: "Example Café", contact: "Example Packer", email: "packer@example.test", address: "10 Example Road\nNorwich", postcode: "NR1 1AA", status: "Active",
  });
  const account = await call("POST", "/api/admin/wholesale/customers/" + customer.id + "/account", { username: "label-cafe" });
  const { cookie: buyerCookie } = await call("POST", "/api/wholesale/auth/change-password", {
    username: "label-cafe", password: account.temporaryPassword, newPassword: "label-cafe-password",
  }, null);
  const placed = await call("POST", "/api/wholesale/orders", {
    requestId: crypto.randomUUID(), delivery: "Delivery", customerVersion: customer.version,
    lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }],
  }, buyerCookie);
  ({ order } = await call("PATCH", "/api/admin/wholesale/orders/" + placed.order.id, {
    ifVersion: placed.order.version, customerId: customer.id, status: "Ready",
  }));
  // 29 kg of coffee: about 31.2 kg packed, so over Royal Mail's 30 kg limit for one parcel.
  const big = await call("POST", "/api/wholesale/orders", {
    requestId: crypto.randomUUID(), delivery: "Delivery", customerVersion: customer.version,
    lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 29, price: 1800 }],
  }, buyerCookie);
  ({ order: heavy } = await call("PATCH", "/api/admin/wholesale/orders/" + big.order.id, {
    ifVersion: big.order.version, customerId: customer.id, status: "Ready",
  }));
});
after(async () => { await browser?.close(); await server?.stop(); });

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 } };
const eligible = () => ({
  enabled: true, bookingEnabled: true, bookingConfigured: true, canCreate: true, orderVersion: order.version,
  shipment: null, trackingEnabled: false, eligibility: { eligible: true }, bookingService: "TPS48", bookingVersion: 2,
  recipient: { name: "Example Packer", line1: "10 Example Road", city: "Norwich", county: "Norfolk", postcode: "NR1 1AA" }, canDownloadLabel: false,
});
const financeBlock = (state) => ({
  ...state, canCreate: false, eligibility: { eligible: false, code: "royal_mail_account_overdue", message: "The account has an overdue balance. Ask an admin to check it." },
});
const labelled = (state) => ({
  ...state, canCreate: false, canDownloadLabel: true,
  shipment: { state: "labelled", orderId: "10001", weightGrams: 1200, trackingNumber: "AB123456789GB" },
});

async function staffPage(t, options, shipping) {
  const context = await browser.newContext(options);
  t.after(() => context.close());
  const [name, value] = staffCookie.split("=");
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  await page.route("**/api/staff-orders/orders/" + order.id + "/shipping**", shipping);
  await page.goto(server.base + "/orders");
  await page.locator('[data-order-id="' + order.id + '"]').click();
  const host = options.isMobile ? "#orderDialog" : "#packingDesk";
  await page.locator(host).getByRole("button", { name: "Royal Mail", exact: true }).click();
  return { page, dialog: page.getByRole("dialog", { name: "Royal Mail" }) };
}

for (const [device, options] of [["desktop packing desk", desktop], ["phone order details", phone]]) {
  test("staff can review, request once and reprint from the " + device, async (t) => {
    let state = eligible(), posts = 0, downloads = 0;
    const { page, dialog } = await staffPage(t, options, async (route) => {
      if (route.request().url().endsWith("/label")) {
        downloads++;
        return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF\n" });
      }
      if (route.request().method() === "POST") {
        posts++;
        assert.deepEqual(route.request().postDataJSON(), { ifVersion: order.version, bookingVersion: 2, bookingService: "TPS48", weightGrams: 1200 });
        state = labelled(state);
      }
      return route.fulfill({ json: state });
    });
    const grams = dialog.getByRole("spinbutton", { name: "Packed parcel weight (grams)" });
    // Pre-filled estimate: 1 kg of coffee, 15 g overfill, a 40 g bag and about 500 g of box and packing (the owner's figures).
    assert.equal(await grams.inputValue(), "1555");
    assert.match(await dialog.innerText(), /Filled in with an estimate/);
    await grams.fill("950");
    await dialog.getByRole("button", { name: "Review label request" }).click();
    assert.equal(await dialog.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
    assert.equal(posts, 0);
    await grams.fill("1200");
    await dialog.getByRole("button", { name: "Review label request" }).click();
    assert.equal(await page.locator(":focus").innerText(), "Confirm label request");
    assert.match(await dialog.innerText(), /10 Example Road\s+Norwich\s+Norfolk\s+NR1 1AA/);
    assert.match(await dialog.innerText(), /TPS48/);
    assert.match(await dialog.innerText(), /1,200 g/);
    assert.doesNotMatch(await dialog.innerText(), /£|API key|invoice ID/);
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.equal(posts, 0, "review leaves the carrier untouched");
    await dialog.getByRole("button", { name: "Edit weight" }).click();
    assert.equal(await grams.inputValue(), "1200");
    await dialog.getByRole("button", { name: "Review label request" }).click();
    await dialog.getByRole("button", { name: "Request Royal Mail label" }).click();
    const label = dialog.getByRole("button", { name: "Download label PDF" });
    await label.waitFor();
    assert.equal(posts, 1);
    assert.equal(await dialog.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const download = page.waitForEvent("download");
      await label.click();
      assert.equal((await download).suggestedFilename(), "Royal-Mail-" + order.id + ".pdf");
      await dialog.getByRole("status").filter({ hasText: "Label downloaded" }).waitFor();
    }
    assert.equal(downloads, 2);
    assert.equal(posts, 1, "reprinting uses the existing shipment");
    const current = (await call("GET", "/api/staff-orders/orders?status=all&q=" + order.id, undefined, staffCookie)).orders[0];
    assert.equal(current.status, "Ready", "the order still awaits handover");
  });
}

test("an overdue account explains the hold on both booking and reprinting before handover", async (t) => {
  let state = financeBlock(eligible()), posts = 0, downloads = 0;
  const { page, dialog } = await staffPage(t, phone, async (route) => {
    if (route.request().method() === "POST") posts++;
    if (route.request().url().endsWith("/label")) {
      downloads++;
      state = { ...financeBlock(state), canDownloadLabel: false };
      return route.fulfill({ status: 409, json: state.eligibility });
    }
    return route.fulfill({ json: state });
  });
  await dialog.getByText(/account has an overdue balance/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Review label request" }).count(), 0);
  await dialog.getByRole("button", { name: "Done" }).click();
  state = labelled(eligible());
  await page.locator("#orderDialog").getByRole("button", { name: "Royal Mail", exact: true }).click();
  await dialog.getByRole("button", { name: "Download label PDF" }).click();
  await dialog.getByText("Label on hold", { exact: true }).waitFor();
  await dialog.getByText(/account has an overdue balance/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Download label PDF" }).count(), 0);
  await dialog.getByRole("button", { name: "Check shipment" }).waitFor();
  assert.equal(downloads, 1);
  assert.equal(posts, 0);
});

test("staff check an uncertain request and recover an existing label", async (t) => {
  let state = eligible(), posts = 0;
  const { dialog } = await staffPage(t, desktop, async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      state = labelled(state);
      return route.abort();
    }
    return route.fulfill({ json: state });
  });
  await dialog.getByRole("spinbutton", { name: "Packed parcel weight (grams)" }).fill("1200");
  await dialog.getByRole("button", { name: "Review label request" }).click();
  await dialog.getByRole("button", { name: "Request Royal Mail label" }).click();
  const check = dialog.getByRole("button", { name: "Check label request" });
  await check.waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
  await check.click();
  await dialog.getByRole("button", { name: "Download label PDF" }).waitFor();
  assert.equal(posts, 1);
});

test("staff can recheck an account hold that arrived during review", async (t) => {
  let state = eligible(), posts = 0;
  const { dialog } = await staffPage(t, phone, async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      state = financeBlock(state);
      return route.fulfill({ status: 409, json: state.eligibility });
    }
    return route.fulfill({ json: state });
  });
  await dialog.getByRole("spinbutton", { name: "Packed parcel weight (grams)" }).fill("1200");
  await dialog.getByRole("button", { name: "Review label request" }).click();
  await dialog.getByRole("button", { name: "Request Royal Mail label" }).click();
  await dialog.getByRole("status").filter({ hasText: /account has an overdue balance/ }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
  state = eligible();
  await dialog.getByRole("button", { name: "Recheck eligibility" }).click();
  await dialog.getByRole("button", { name: "Review label request" }).waitFor();
  assert.equal(posts, 1);
});

test("dispatch review warns on a held Royal Mail label and accepts another courier link", async (t) => {
  const state = { ...labelled(financeBlock(eligible())), canDownloadLabel: false };
  const { page, dialog } = await staffPage(t, desktop, async route => route.fulfill({ json: state }));
  await dialog.getByRole("button", { name: "Done" }).click();
  await page.locator("#packingDesk").getByRole("button", { name: "Review dispatch" }).click();
  const dispatch = page.getByRole("dialog", { name: "Confirm dispatch" });
  await dispatch.getByText(/account has an overdue balance/).waitFor();
  const confirm = dispatch.getByRole("button", { name: "Mark dispatched" });
  assert.equal(await confirm.isDisabled(), true);
  const tracking = dispatch.getByLabel("Tracking link (optional)");
  await tracking.fill("https://tracking.royalmail.net/example");
  assert.equal(await confirm.isDisabled(), true);
  await tracking.fill("https://parcel.example.test/tracking/sample");
  assert.equal(await confirm.isEnabled(), true);
});

// The owner's request, 27 Nov 2026: Admin's Royal Mail shipping also starts on the estimate, which can be changed.
for (const [name, options] of [["phone", phone], ["ipad", { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true }]]) for (const colorScheme of ["light", "dark"]) {
  test(`Admin Royal Mail shipping starts on an estimated parcel weight (${name}, ${colorScheme})`, async (t) => {
    const context = await browser.newContext({ ...options, colorScheme });
    t.after(() => context.close());
    const [cookieName, value] = adminCookie.split("=");
    await context.addCookies([{ name: cookieName, value, url: server.base }]);
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/admin/wholesale/orders/" + order.id + "/shipping**", (route) => route.fulfill({ json: eligible() }));
    await page.goto(server.base + "/admin#wholesale");
    await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).locator("visible=true").first().click();
    await page.getByRole("button", { name: "Royal Mail shipping" }).locator("visible=true").first().click();
    const weightBox = page.locator('input[name="weightGrams"]');
    await weightBox.waitFor();
    assert.equal(await weightBox.inputValue(), "1555");
    assert.match(await page.locator("#sheet").innerText(), /Filled in with an estimate/);
    await weightBox.fill("1620");
    assert.equal(await weightBox.inputValue(), "1620");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${process.env.SHOT_DIR || "/tmp"}/royal-mail-weight-${name}-${colorScheme}.png` });
  });
}

// The owner's note, 27 Nov 2026: orders over 30 kg are split into boxes under Manage order in Click & Drop.
test("an order over 30 kg packed says to book and split it in Click & Drop", async (t) => {
  const context = await browser.newContext(desktop);
  t.after(() => context.close());
  const [name, value] = staffCookie.split("=");
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  await page.route("**/api/staff-orders/orders/" + heavy.id + "/shipping**", (route) => route.fulfill({ json: { ...eligible(), orderVersion: heavy.version } }));
  await page.goto(server.base + "/orders");
  await page.locator('[data-order-id="' + heavy.id + '"]').click();
  await page.locator("#packingDesk").getByRole("button", { name: "Royal Mail", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Royal Mail" });
  await dialog.getByText(/Manage order to split it into boxes/).first().waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Review label request" }).count(), 0);

  const admin = await browser.newContext({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  t.after(() => admin.close());
  const [an, av] = adminCookie.split("=");
  await admin.addCookies([{ name: an, value: av, url: server.base }]);
  const ap = await admin.newPage();
  await ap.route("**/api/admin/wholesale/orders/" + heavy.id + "/shipping**", (route) => route.fulfill({ json: { ...eligible(), orderVersion: heavy.version } }));
  await ap.goto(server.base + "/admin#wholesale");
  await ap.locator(`[data-act="wh-order"][data-id="${heavy.id}"]`).locator("visible=true").first().click();
  await ap.getByRole("button", { name: "Royal Mail shipping" }).locator("visible=true").first().click();
  await ap.getByText("Over 30 kg: book in Click & Drop").waitFor();
  assert.equal(await ap.locator('#sheet button[type="submit"]').count(), 0);
  assert.notEqual(await ap.locator("#wShippingFields").getAttribute("disabled"), null);
  assert.ok(await ap.locator('input[name="weightGrams"]').isDisabled());
  await ap.screenshot({ path: `${process.env.SHOT_DIR || "/tmp"}/royal-mail-over-30kg-ipad-dark.png` });
});
