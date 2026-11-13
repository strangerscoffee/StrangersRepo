import { openWholesaleOrders } from './wholesale-ui-helpers.mjs';
// Native wholesale order handling: packing details, quick statuses, busy guards and concurrent edits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
let srv, browser, ADMIN;

async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return { body: data, cookie: cookieOf(response) };
}
async function orderFor(id) { return (await api("GET", "/api/admin/wholesale")).body.orders.find((row) => row.id === id); }
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "Packing Admin", username: "owner", password: "packing-owner-password", code: SETUP_CODE }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale handling ${device} ${color}: packing, guarded statuses, delivery tracking and concurrent admin edits`, { timeout: 120000 }, async () => {
    const business = `${device} ${color} Packing Café`, username = `packing.${device.toLowerCase()}.${color}`;
    const created = (await api("POST", "/api/admin/wholesale/customers", { business, contact: "Coffee Buyer", email: "packing@example.com", phone: "01603 123456", address: "10 Coffee Street\nNorwich", postcode: "NR1 1AA", deliveryNotes: "Ring the side-door bell", status: "Active", note: "Private account note", paymentTerms: "net-14", paymentNote: "Quote the invoice number." })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${created.id}/account`, { username })).body;
    const customerCookie = (await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-password" }, null)).cookie;
    const customer = (await api("GET", "/api/wholesale/session", undefined, customerCookie)).body.customer;
    const reference = `PO-${device}-${color}`;
    const lines = [
      { productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 1800 },
      { productId: "brazil", pack: "quarter", grind: "filter", quantity: 1, price: 500 },
      { productId: "colombia", pack: "quarter", grind: "espresso", quantity: 3, price: 625 },
    ];
    let order = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: customer.version, delivery: "Delivery", reference, lines }, customerCookie)).body.order;
    const originalNote = "Keep the customer's requested packing sequence.";
    order = (await api("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, customerId: customer.id, status: "New", note: originalNote })).body.order;
    const preview = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), business: `${device} ${color} staff test`, delivery: "Roastery collection", lines: [lines[0]] })).body.order;

    const context = await browser.newContext({ viewport, colorScheme: color, hasTouch: true, isMobile: device === "phone" });
    const customerContext = await browser.newContext({ viewport, colorScheme: color, hasTouch: true, isMobile: device === "phone" });
    const [name, value] = ADMIN.split("=");
    await context.addCookies([{ name, value, url: srv.base }]);
    const [customerName, customerValue] = customerCookie.split("=");
    await customerContext.addCookies([{ name: customerName, value: customerValue, url: srv.base }]);
    const gates = new Set();
    try {
      const page = await context.newPage(), buyer = await customerContext.newPage(), errors = [];
      for (const current of [page, buyer]) current.on("pageerror", (error) => errors.push(error.message));
      await page.goto(srv.base + "/admin#wholesale");
      const detail = page.locator(`[data-act="wh-order"][data-id="${order.id}"]`);
      const quick = page.locator(`[data-act="wh-next"][data-id="${order.id}"]`);
      await detail.waitFor();
      assert.match(await page.locator(`[data-act="wh-order"][data-id="${preview.id}"]`).textContent(), /Staff preview/);
      assert.equal(await page.locator(`[data-act="wh-next"][data-id="${preview.id}"]`).count(), 0, "staff tests cannot be advanced as customer packing work");
      assert.equal((await quick.textContent()).trim(), "Mark preparing");
      await detail.click();
      await page.getByRole("heading", { name: "Packing list", exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => ({ scrollTop: document.querySelector("#sheet").scrollTop, focused: document.activeElement.id })), { scrollTop: 0, focused: "sheetTitle" }, "order details open at the heading so packing information is read before status controls");
      const sheet = await page.locator("#sheet").textContent();
      for (const text of [business, reference, "10 Coffee Street", "NR1 1AA", "Ring the side-door bell", "14 days from invoice", "Quote the invoice number.", "1 kg bag", "250 g bag", "Whole bean", "Medium", "Fine"]) assert.ok(sheet.includes(text), `packing sheet includes ${text}`);
      const packing = await page.locator(".w-packing-line").evaluateAll((rows) => rows.map((row) => ({ quantity: Number(row.querySelector(".w-pack-quantity b").textContent), unit: row.querySelector(".w-pack-quantity span").textContent, description: row.querySelector(".tx").textContent })));
      assert.equal(packing.length, 3);
      for (const [quantity, unit, pack, grind] of [[2, "bags", "1 kg bag", "Whole bean"], [1, "bag", "250 g bag", "Medium"], [3, "bags", "250 g bag", "Fine"]]) assert.ok(packing.some((row) => row.quantity === quantity && row.unit === unit && row.description.includes(pack) && row.description.includes(grind)), `packing quantities show ${quantity} ${unit}, ${pack}, ${grind}`);
      assert.equal(await page.locator("#wNote").inputValue(), originalNote);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "packing sheet fits the screen");
      await screenshot(page, `packing-${device}-${color}`);
      await page.locator('#sheet [data-sheet="close"]').click();

      let patchCount = 0, nextGate = null;
      const patchPayloads = [];
      await page.route(`**/api/admin/wholesale/orders/${order.id}`, async (route) => {
        if (route.request().method() !== "PATCH") { await route.continue(); return; }
        patchCount++; patchPayloads.push(route.request().postDataJSON());
        const gate = nextGate;
        nextGate = null;
        if (gate) { gate.arrive(route.request().postDataJSON()); await gate.released; }
        await route.continue();
      });
      function holdNextPatch() {
        let arrive, release;
        const arrived = new Promise((resolve) => { arrive = resolve; });
        const released = new Promise((resolve) => { release = resolve; });
        const gate = { arrive, arrived, released, release };
        gates.add(gate); nextGate = gate;
        return gate;
      }

      const busy = holdNextPatch();
      await quick.click();
      const firstPayload = await busy.arrived;
      assert.equal(await quick.isDisabled(), true, "quick action disables while its write is pending");
      assert.equal((await quick.textContent()).trim(), "Saving…");
      const button = await quick.boundingBox();
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      assert.equal(patchCount, 1, "repeated taps cannot send duplicate status writes");
      assert.deepEqual(firstPayload, { ifVersion: order.version, customerId: customer.id, status: "Preparing", note: originalNote });
      await screenshot(page, `quick-saving-${device}-${color}`);
      busy.release(); gates.delete(busy);
      await quick.filter({ hasText: "Mark ready" }).waitFor();
      order = await orderFor(order.id);
      assert.equal(order.status, "Preparing"); assert.equal(order.note, originalNote);

      const conflict = holdNextPatch();
      await quick.click();
      const stalePayload = await conflict.arrived;
      assert.equal(stalePayload.ifVersion, order.version);
      const otherNote = "Another admin confirmed this order is ready.";
      const changed = (await api("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, customerId: customer.id, status: "Ready", note: otherNote })).body.order;
      conflict.release(); gates.delete(conflict);
      const error = page.locator(`[data-order-error="${order.id}"]`);
      await error.waitFor();
      assert.match(await error.textContent(), /changed|reload/i, "a concurrent edit is shown instead of being overwritten");
      assert.equal(await quick.isDisabled(), true, "the stale action stays disabled until the row is refreshed");
      const retained = await orderFor(order.id);
      assert.equal(retained.version, changed.version); assert.equal(retained.status, "Ready"); assert.equal(retained.note, otherNote);
      await screenshot(page, `quick-conflict-${device}-${color}`);
      // A normal view redraw (also used by live updates) must not acknowledge a rejected edit.
      const previousError = await error.elementHandle();
      await page.locator('[data-act="wh-tab"][data-id="orders"]').click();
      await page.waitForFunction((previous) => !previous.isConnected, previousError);
      await previousError.dispose();
      await error.waitFor();
      assert.match(await error.textContent(), /changed|reload/i, "a redraw retains the unresolved conflict message");
      assert.equal(await quick.isDisabled(), true, "a redraw cannot re-enable an unresolved quick action");
      assert.equal(await page.locator(`[data-act="wh-refresh-orders"][data-id="${order.id}"]`).isVisible(), true, "explicit refresh remains available after the view redraws");
      await page.locator(`[data-act="wh-refresh-orders"][data-id="${order.id}"]`).click();
      await page.waitForFunction((id) => {
        const button = document.querySelector(`[data-act="wh-next"][data-id="${id}"]`);
        return button && !button.disabled && button.textContent.trim() === "Mark dispatched";
      }, order.id);
      assert.equal(await quick.isEnabled(), true);
      assert.equal(await quick.evaluate((button) => document.activeElement === button), true, "refresh returns keyboard focus to the available next action");
      await buyer.goto(srv.base + "/wholesale-preview/");
      await buyer.locator("#products article").first().waitFor();
      const historyRow = buyer.locator(`[data-history-order="${order.id}"]`);
      const tracking = buyer.locator(`a[data-order-tracking="${order.id}"]`);
      async function refreshHistory(first = false) {
        const loaded = buyer.waitForResponse((response) => new URL(response.url()).pathname === "/api/wholesale/orders" && response.request().method() === "GET");
        if (first) await openWholesaleOrders(buyer); else await buyer.locator("#refresh-orders").click();
        await loaded;
        await buyer.waitForFunction(() => document.querySelector("#order-history")?.getAttribute("aria-busy") === "false");
        await historyRow.waitFor();
      }
      await refreshHistory(true);
      assert.equal(await tracking.count(), 0, "Ready orders do not expose delivery tracking");

      const dispatchForm = page.locator("#wDispatchOrderForm");
      const dispatchTracking = page.locator("#wDispatchTracking");
      const confirmDispatch = dispatchForm.locator('button[type="submit"]');
      async function openDispatch() {
        await quick.click(); await dispatchForm.waitFor();
        assert.equal((await confirmDispatch.textContent()).trim(), "Confirm dispatch");
      }
      async function assertDispatchCancelled() {
        await dispatchForm.waitFor({ state: "hidden" });
        assert.equal(await quick.evaluate((button) => document.activeElement === button), true, "cancelling dispatch restores the originating action's keyboard focus");
        assert.equal(patchCount, 2, "opening or cancelling dispatch sends no status write");
      }
      await openDispatch();
      assert.ok((await dispatchForm.textContent()).includes(business));
      assert.ok((await dispatchForm.textContent()).includes(order.id));
      assert.equal(await dispatchTracking.getAttribute("type"), "url");
      assert.equal(await dispatchTracking.inputValue(), "");
      await dispatchForm.locator('[data-sheet="dispatch-cancel"]').click(); await assertDispatchCancelled();
      await openDispatch(); await page.keyboard.press("Escape"); await assertDispatchCancelled();
      await openDispatch(); await page.mouse.click(4, 4); await assertDispatchCancelled();
      assert.equal((await orderFor(order.id)).status, "Ready");

      const trackingUrl = `https://tracking.example.test/${order.id}`;
      const dispatchConflict = holdNextPatch();
      await openDispatch(); await dispatchTracking.fill(trackingUrl); await confirmDispatch.click();
      const dispatchPayload = await dispatchConflict.arrived;
      assert.deepEqual(dispatchPayload, { ifVersion: changed.version, customerId: customer.id, status: "Dispatched", note: otherNote, trackingUrl });
      assert.equal(await confirmDispatch.isDisabled(), true);
      assert.equal(await dispatchForm.locator('[data-sheet="dispatch-cancel"]').isDisabled(), true);
      const dispatchButton = await confirmDispatch.boundingBox();
      await page.mouse.click(dispatchButton.x + dispatchButton.width / 2, dispatchButton.y + dispatchButton.height / 2);
      await page.mouse.click(dispatchButton.x + dispatchButton.width / 2, dispatchButton.y + dispatchButton.height / 2);
      assert.equal(patchCount, 3, "busy dispatch confirmation prevents duplicate writes");
      const latestNote = "Another admin updated dispatch instructions.";
      const latestTracking = `https://tracking.example.test/review-${order.id}`;
      const dispatchChanged = (await api("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: changed.version, customerId: customer.id, status: "Ready", note: latestNote, trackingUrl: latestTracking })).body.order;
      dispatchConflict.release(); gates.delete(dispatchConflict);
      await dispatchForm.locator('[data-sheet="dispatch-reload"]').waitFor();
      assert.equal(await confirmDispatch.isDisabled(), true, "stale dispatch stays locked until explicitly reloaded");
      assert.match(await dispatchForm.textContent(), /changed|reload/i);
      const notDispatched = await orderFor(order.id);
      assert.equal(notDispatched.version, dispatchChanged.version); assert.equal(notDispatched.status, "Ready");
      assert.equal(notDispatched.note, latestNote); assert.equal(notDispatched.trackingUrl, latestTracking);
      await screenshot(page, `dispatch-conflict-${device}-${color}`);
      await dispatchForm.locator('[data-sheet="dispatch-reload"]').click();
      await page.waitForFunction((value) => {
        const form = document.querySelector("#wDispatchOrderForm"), input = document.querySelector("#wDispatchTracking"), button = form?.querySelector('button[type="submit"]');
        return input?.value === value && button && !button.disabled;
      }, latestTracking);
      assert.equal(await dispatchTracking.inputValue(), latestTracking, "explicit reload shows another admin's latest saved link");
      assert.equal(patchCount, 3, "reloading a dispatch conflict cannot submit an order update");
      await dispatchTracking.fill(trackingUrl);
      await screenshot(page, `dispatch-confirm-${device}-${color}`);
      await confirmDispatch.click(); await dispatchForm.waitFor({ state: "hidden" });
      await quick.waitFor({ state: "detached" });
      order = await orderFor(order.id);
      assert.equal(order.status, "Dispatched"); assert.equal(order.note, latestNote);
      assert.equal(order.customerId, customer.id); assert.equal(order.paymentTerms.id, "net-14"); assert.equal(order.trackingUrl, trackingUrl);
      assert.deepEqual(patchPayloads.at(-1), { ifVersion: dispatchChanged.version, customerId: customer.id, status: "Dispatched", note: latestNote, trackingUrl });
      assert.equal(patchCount, 4, "only explicit dispatch confirmations send the rejected and successful dispatch writes");
      await refreshHistory();
      assert.equal(await tracking.count(), 1);
      assert.equal(await tracking.getAttribute("href"), trackingUrl);
      assert.equal(await tracking.getAttribute("target"), "_blank");
      assert.deepEqual((await tracking.getAttribute("rel")).split(/\s+/).sort(), ["noopener", "noreferrer"]);
      assert.match(await tracking.textContent(), /Track delivery/);
      await screenshot(buyer, `tracking-history-${device}-${color}`);

      await detail.click();
      assert.equal(await page.locator("#wTrackingUrl").inputValue(), trackingUrl);
      const editedTracking = `https://tracking.example.test/edited-${order.id}`;
      await page.locator("#wStatus").selectOption("Ready");
      await page.locator("#wTrackingUrl").fill(editedTracking);
      await page.locator('#sheet button[type="submit"]').click();
      await page.locator("#scrim").waitFor({ state: "hidden" });
      await quick.filter({ hasText: "Mark dispatched" }).waitFor();
      order = await orderFor(order.id);
      assert.equal(order.status, "Ready", "the full status sheet remains available to correct dispatch");
      assert.equal(order.trackingUrl, editedTracking); assert.equal(order.note, latestNote);
      await refreshHistory();
      assert.equal(await tracking.count(), 0, "a valid stored link is hidden again while an order is Ready");
      await detail.click();
      assert.equal(await page.locator("#wTrackingUrl").inputValue(), editedTracking);
      await page.locator("#wStatus").selectOption("Dispatched");
      await page.locator("#wTrackingUrl").fill("");
      await page.locator('#sheet button[type="submit"]').click();
      await page.locator("#scrim").waitFor({ state: "hidden" }); await quick.waitFor({ state: "detached" });
      order = await orderFor(order.id);
      assert.equal(order.status, "Dispatched"); assert.equal(order.trackingUrl || "", "", "clearing the detail field removes tracking");
      await refreshHistory();
      assert.equal(await tracking.count(), 0, "dispatched orders without a tracking URL have no tracking button");
      const collection = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: customer.version, delivery: "Roastery collection", reference: "Collection guard", lines: [lines[0]] }, customerCookie)).body.order;
      await api("PATCH", `/api/admin/wholesale/orders/${collection.id}`, { ifVersion: collection.version, customerId: customer.id, status: "Dispatched", note: "Collection order", trackingUrl });
      await refreshHistory();
      assert.equal(await buyer.locator(`a[data-order-tracking="${collection.id}"]`).count(), 0, "roastery collections never show parcel tracking");
      if (device === "phone" && color === "light") {
        const legacyTracking = async (route) => {
          if (new URL(route.request().url()).pathname !== "/api/wholesale/orders") { await route.continue(); return; }
          const response = await route.fetch(), body = await response.json();
          body.orders = body.orders.map((row) => row.id === order.id ? { ...row, trackingUrl: "javascript:alert('unsafe tracking')" } : row);
          await route.fulfill({ response, json: body });
        };
        await buyer.route("**/api/wholesale/orders*", legacyTracking);
        await refreshHistory();
        assert.equal(await tracking.count(), 0, "legacy unsafe URLs cannot become customer navigation links");
        await buyer.unroute("**/api/wholesale/orders*", legacyTracking);
      }
      assert.ok(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "customer tracking history fits the screen");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "order handling fits the screen");
      assert.deepEqual(errors, []);
    } finally {
      for (const gate of gates) gate.release();
      await context.close(); await customerContext.close();
    }
  });
}
