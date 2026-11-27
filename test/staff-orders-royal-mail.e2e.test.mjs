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
    let addressSaves = 0, postageRequests = 0;
    await page.route("**/api/admin/wholesale/orders/" + order.id + "/shipping**", (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/location")) {
        if (route.request().method() === "PUT") {
          addressSaves++;
          assert.equal(route.request().postDataJSON().recipient.line1, "12 Example Road");
        }
        return route.fulfill({ json: { customerId: order.customerId, locationId: "primary", version: 1,
          name: "Example Café", address: "10 Example Road", postcode: "NR1 1AA" } });
      }
      if (route.request().method() === "POST") postageRequests++;
      return route.fulfill({ json: eligible() });
    });
    await page.goto(server.base + "/admin#wholesale");
    await page.locator(`[data-act="wh-order"][data-id="${order.id}"]`).locator("visible=true").first().click();
    await page.getByRole("button", { name: "Royal Mail shipping" }).locator("visible=true").first().click();
    const weightBox = page.locator('input[name="weightGrams"]');
    await weightBox.waitFor();
    assert.equal(await weightBox.inputValue(), "1555");
    assert.match(await page.locator("#sheet").innerText(), /Filled in with an estimate/);
    assert.equal(await page.getByLabel("Town or city").inputValue(), "Norwich");
    assert.equal(await page.getByLabel("County (optional)").inputValue(), "Norfolk");
    await weightBox.fill("1620");
    assert.equal(await weightBox.inputValue(), "1620");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${process.env.SHOT_DIR || "/tmp"}/royal-mail-weight-${name}-${colorScheme}.png` });
    if (name === "phone" && colorScheme === "light") {
      await page.getByLabel("Address line 1").fill("12 Example Road");
      await page.getByRole("button", { name: "Review label request" }).click();
      assert.match(await page.getByRole("region", { name: "Parcel review" }).innerText(), /12 Example Road\nNorwich\nNorfolk\nNR1 1AA/);
      const future = page.getByRole("button", { name: "Update saved location for future orders" });
      await future.click();
      await page.getByRole("button", { name: "Keep current address" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
      await page.getByRole("button", { name: "Keep current address" }).click();
      assert.equal(addressSaves, 0);
      await future.click();
      await page.getByRole("button", { name: "Save delivery address" }).click();
      await page.getByText("Delivery address saved for future orders.").waitFor();
      await page.getByRole("button", { name: "Request Royal Mail label" }).waitFor();
      assert.equal(addressSaves, 1);
      assert.equal(postageRequests, 0);
    }
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

for (const [device, options] of [["desktop", desktop], ["phone", phone]]) {
  test("the staff dispatch queue opens a parcel, returns to the queue and rechecks a handover on " + device, async (t) => {
    const context = await browser.newContext(options);
    t.after(() => context.close());
    const [name, value] = staffCookie.split("=");
    await context.addCookies([{ name, value, url: server.base }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let stage = "weigh", state = eligible(), attemptedHandover;
    await page.route("**/api/staff-orders/dispatch-queue?**", route => {
      const row = {
        id: order.id, version: order.version, business: order.business, stage,
        stageLabel: stage === "weigh" ? "Weigh" : "Awaiting handover",
        action: stage === "weigh" ? "shipping" : "handover",
        actionLabel: stage === "weigh" ? "Weigh parcel" : "Review handover",
      };
      return route.fulfill({ json: { orders: stage ? [row] : [], nextCursor: null,
        counts: { weigh: Number(stage === "weigh"), handover: Number(stage === "handover"), print: 0, checking: 0, attention: 0 } } });
    });
    await page.route("**/api/staff-orders/orders/" + order.id + "/shipping", route => route.fulfill({ json: state }));
    await page.route("**/api/staff-orders/orders/" + order.id, route => {
      attemptedHandover = route.request().postDataJSON();
      stage = "";
      return route.fulfill({ json: { order: { ...order, status: "Dispatched", version: order.version + 1 } } });
    });
    await page.goto(server.base + "/orders");
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const queue = page.getByRole("region", { name: "Dispatch queue" });
    const action = queue.locator('[data-queue-order="' + order.id + '"] button');
    await action.click();
    const shipping = page.getByRole("dialog", { name: "Royal Mail" });
    await shipping.getByRole("spinbutton", { name: "Packed parcel weight (grams)" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    stage = "handover";
    state = labelled(state);
    state.shipment.destination = { address: "22 Verified Street, Norwich", postcode: "NR2 2AA" };
    state.shipment.labelDownloadedAt = Date.now();
    await shipping.getByRole("button", { name: "Done" }).click();
    await queue.getByRole("button", { name: "Review handover" }).click();
    const handover = page.getByRole("dialog", { name: "Confirm dispatch" });
    await handover.getByText(/22 Verified Street/).waitFor();
    assert.equal(await handover.getByLabel("Tracking link (optional)").isVisible(), false);
    await handover.getByRole("button", { name: "Cancel", exact: true }).click();
    await queue.getByRole("button", { name: "Review handover" }).waitFor();
    if (!options.isMobile) await page.waitForFunction(() => !!document.activeElement?.closest("[data-queue-order]"));
    assert.equal(attemptedHandover, undefined);
    state = financeBlock(state);
    await action.click();
    await handover.getByText(/account has an overdue balance/).waitFor();
    assert.equal(await handover.getByRole("button", { name: "Mark dispatched" }).isDisabled(), true);
    await handover.getByRole("button", { name: "Cancel", exact: true }).click();
    state = { ...state, eligibility: { eligible: true } };
    await action.click();
    await handover.getByRole("button", { name: "Mark dispatched" }).click();
    await queue.getByText("No parcels are waiting for dispatch.").waitFor();
    assert.equal(attemptedHandover.queueHandover, true);
    assert.equal(attemptedHandover.trackingUrl, "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB");
    assert.deepEqual(errors, []);
  });
}

async function adminDispatchPage(t, options, task, details) {
  const context = await browser.newContext(options);
  t.after(() => context.close());
  const [name, value] = adminCookie.split("=");
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/api/admin/wholesale/dispatch-queue?**", route => {
    const stage = new URL(route.request().url()).searchParams.get("stage");
    const row = { id: order.id, version: order.version, business: order.business, customerId: order.customerId,
      dispatchDate: null, reference: "Test parcel", reason: null, ...task };
    return route.fulfill({ json: { orders: stage === "all" || stage === row.stage ? [row] : [], nextCursor: null,
      counts: { weigh: 0, print: 0, handover: 0, checking: 0, attention: 0, [row.stage]: 1 } } });
  });
  await page.route("**/api/admin/wholesale/orders/" + order.id + "/shipping", details);
  await page.goto(server.base + "/admin#wholesale/royal-mail");
  return { page, action: page.locator(`[data-queue-order="${order.id}"] button`) };
}

for (const [name, options] of [["desktop", desktop], ["phone", phone]]) {
  test(`Admin dispatch queue opens settings and returns to a rejected booking on ${name}`, async t => {
    let attempts = 0;
    const { page, action } = await adminDispatchPage(t, options,
      { stage: "weigh", stageLabel: "Weigh", action: "shipping", actionLabel: "Weigh parcel" },
      route => {
        const result = eligible();
        if (route.request().method() === "POST") {
          attempts++;
          result.shipment = { state: "failed", requestedAt: Date.now(), problem: "Check the service code configured for this account." };
        }
        return route.fulfill({ json: result });
      });
    let serviceChecks = 0;
    await page.route("**/api/admin/wholesale/orders/" + order.id + "/shipping/service-check", route => {
      const body = route.request().postDataJSON();
      assert.deepEqual(body, { ifVersion: order.version, bookingVersion: 2, postcode: "NR1 1AA", weightGrams: 1650 });
      serviceChecks++;
      return route.fulfill({ json: { bookingService: "TPS48", available: false, message: "This service is unavailable for this parcel." } });
    });
    await page.getByRole("button", { name: "Shipping settings", exact: true }).click();
    await page.getByRole("switch", { name: "New Royal Mail bookings" }).waitFor();
    await page.getByRole("button", { name: "Dispatch queue", exact: true }).click();
    await action.click();
    await page.getByRole("button", { name: "Review label request" }).click();
    await page.getByText("TPS48", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Request Royal Mail label" }).click();
    await page.getByText("Label request rejected", { exact: true }).waitFor();
    assert.equal(await page.getByText("Ready to request a label", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
    assert.equal(attempts, 1);
    assert.equal(serviceChecks, 0);
    await page.locator('input[name="weightGrams"]').fill("1650");
    await page.getByRole("button", { name: "Check service for this parcel" }).click();
    await page.getByText("TPS48 · 1,650 g · NR1 1AA. This service is unavailable for this parcel.").waitFor();
    assert.equal(serviceChecks, 1);
    await page.locator('input[name="postcode"]').fill("NR3 1AA");
    assert.equal(await page.locator("#wServiceAdvice").isVisible(), false);
    assert.equal(attempts, 1);
    await page.getByRole("button", { name: "Back to dispatch queue" }).click();
    await action.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest("[data-queue-order]"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}

test("Admin dispatch queue hands over the reviewed label with its booked address and payment safeguards", async t => {
  const tracking = "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB";
  const { page, action } = await adminDispatchPage(t, desktop,
    { stage: "handover", stageLabel: "Awaiting handover", action: "handover", actionLabel: "Confirm handover" },
    route => {
      const result = labelled(eligible());
      Object.assign(result.shipment, { labelDownloadedAt: Date.now(), trackingUrl: tracking, destination: { address: "30 New Lane, Norwich", postcode: "NR3 1AA" } });
      return route.fulfill({ json: result });
    });
  let saves = 0;
  await page.route("**/api/admin/wholesale/orders/" + order.id, route => {
    assert.equal(route.request().method(), "PATCH");
    const payload = route.request().postDataJSON();
    assert.equal(payload.queueHandover, true);
    assert.equal(payload.trackingUrl, tracking);
    saves++;
    return route.fulfill({ json: { order: { ...order, status: "Dispatched", version: order.version + 1 } } });
  });
  await action.click();
  await page.getByText("30 New Lane, Norwich, NR3 1AA", { exact: true }).waitFor();
  assert.equal(await page.locator("#wDispatchTracking").count(), 0);
  assert.equal(saves, 0);
  await page.getByRole("button", { name: "Confirm dispatch", exact: true }).click();
  await page.locator("#wDispatchOrderForm").waitFor({ state: "detached" });
  assert.equal(saves, 1);
});

test("a staff dispatch deep link opens the real queue and discards its rows when access is lost", async (t) => {
  const context = await browser.newContext(phone);
  t.after(() => context.close());
  const [name, value] = staffCookie.split("=");
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  await page.goto(server.base + "/orders#dispatch");
  const queue = page.getByRole("region", { name: "Dispatch queue" });
  await queue.locator('[data-queue-order="' + order.id + '"]').waitFor();
  assert.equal(await page.getByRole("button", { name: "Dispatch", exact: true }).getAttribute("aria-pressed"), "true");
  await page.route("**/api/staff-orders/dispatch-queue?**", route => route.fulfill({ status: 403, json: { code: "permission_denied" } }));
  await queue.getByRole("button", { name: "Refresh" }).click();
  await page.getByText("You no longer have access to wholesale orders.").waitFor();
  assert.equal(await page.locator("[data-queue-order]").count(), 0);
});

test("a lost label response is recovered in the staff dialog without a second purchase", async (t) => {
  let state = eligible(), purchases = 0, reads = 0;
  const { dialog } = await staffPage(t, phone, async route => {
    if (route.request().method() === "POST") {
      purchases++;
      state = labelled(state);
      return route.abort();
    }
    reads++;
    return route.fulfill({ json: state });
  });
  await dialog.getByRole("button", { name: "Review label request" }).click();
  await dialog.getByRole("button", { name: "Request Royal Mail label" }).click();
  await dialog.getByRole("button", { name: "Download label PDF" }).waitFor({ timeout: 20000 });
  assert.equal(purchases, 1);
  assert.ok(reads >= 2);
});

test("Admin can investigate an uncertain booking from the queue without generating postage", async t => {
  let checks = 0;
  const { page, action } = await adminDispatchPage(t, phone,
    { stage: "attention", stageLabel: "Needs attention", action: "shipping", actionLabel: "Review booking" }, route => {
      const lookup = route.request().method() === "GET";
      if (lookup) checks++;
      assert.equal(lookup, true);
      return route.fulfill({ json: { ...eligible(), canCreate: false, shipment: { state: "review", requestedAt: Date.now(),
        recovery: { status: "needs_admin", attempts: 4, lastCheckedAt: Date.now(), nextCheckAt: null } } } });
    });
  await action.click();
  const recovery = page.locator('#sheet [aria-label="Booking recovery"]');
  await recovery.getByText(order.id, { exact: true }).waitFor();
  await page.getByText("Booking needs admin review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Request Royal Mail label" }).count(), 0);
  assert.equal(checks, 1);
  await page.getByRole("button", { name: "Back to dispatch queue" }).click();
  await action.waitFor();
});

test("Admin can open a held order’s billing account and return to the queue", async t => {
  const { page, action } = await adminDispatchPage(t, desktop,
    { stage: "attention", stageLabel: "Needs attention", action: "account", actionLabel: "Review billing account" }, route => route.abort());
  await action.click();
  await page.getByRole("heading", { name: "Billing account", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.closest("[data-queue-order]"));
  assert.equal(await action.isVisible(), true);
});
