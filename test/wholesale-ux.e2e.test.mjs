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
  test(`wholesale handling ${device} ${color}: packing details, guarded quick statuses and concurrent admin edits`, { timeout: 120000 }, async () => {
    const business = `${device} ${color} Packing Café`, username = `packing.${device.toLowerCase()}.${color}`;
    const created = (await api("POST", "/api/admin/wholesale/customers", { business, contact: "Coffee Buyer", email: "packing@example.com", phone: "01603 123456", address: "10 Coffee Street\nNorwich", postcode: "NR1 1AA", deliveryNotes: "Ring the side-door bell", status: "Active", note: "Private account note", paymentTerms: "net-14", paymentNote: "Quote the invoice number." })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${created.id}/account`, { username })).body;
    const customerCookie = (await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-password" }, null)).cookie;
    const customer = (await api("GET", "/api/wholesale/session", undefined, customerCookie)).body.customer;
    const reference = `PO-${device}-${color}`;
    const lines = [
      { productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 3700 },
      { productId: "brazil", pack: "quarter", grind: "filter", quantity: 1, price: 1050 },
      { productId: "colombia", pack: "half", grind: "espresso", quantity: 3, price: 2800 },
    ];
    let order = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: customer.version, delivery: "Delivery", reference, lines }, customerCookie)).body.order;
    const originalNote = "Keep the customer's requested packing sequence.";
    order = (await api("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, customerId: customer.id, status: "New", note: originalNote })).body.order;
    const preview = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), business: `${device} ${color} staff test`, delivery: "Roastery collection", lines: [lines[0]] })).body.order;

    const context = await browser.newContext({ viewport, colorScheme: color, hasTouch: true, isMobile: device === "phone" });
    const [name, value] = ADMIN.split("=");
    await context.addCookies([{ name, value, url: srv.base }]);
    const gates = new Set();
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
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
      for (const text of [business, reference, "10 Coffee Street", "NR1 1AA", "Ring the side-door bell", "14 days from invoice", "Quote the invoice number.", "1 kg bag", "250 g bag", "500 g bag", "Beans", "Filter / Medium", "Espresso / Fine"]) assert.ok(sheet.includes(text), `packing sheet includes ${text}`);
      const packing = await page.locator(".w-packing-line").evaluateAll((rows) => rows.map((row) => ({ quantity: Number(row.querySelector(".w-pack-quantity b").textContent), unit: row.querySelector(".w-pack-quantity span").textContent, description: row.querySelector(".tx").textContent })));
      assert.equal(packing.length, 3);
      for (const [quantity, unit, pack, grind] of [[2, "bags", "1 kg bag", "Beans"], [1, "bag", "250 g bag", "Filter / Medium"], [3, "bags", "500 g bag", "Espresso / Fine"]]) assert.ok(packing.some((row) => row.quantity === quantity && row.unit === unit && row.description.includes(pack) && row.description.includes(grind)), `packing quantities show ${quantity} ${unit}, ${pack}, ${grind}`);
      assert.equal(await page.locator("#wNote").inputValue(), originalNote);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "packing sheet fits the screen");
      await screenshot(page, `packing-${device}-${color}`);
      await page.locator('#sheet [data-sheet="close"]').click();

      let patchCount = 0, nextGate = null;
      await page.route(`**/api/admin/wholesale/orders/${order.id}`, async (route) => {
        if (route.request().method() !== "PATCH") { await route.continue(); return; }
        patchCount++;
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
      await quick.click();
      await quick.waitFor({ state: "detached" });
      order = await orderFor(order.id);
      assert.equal(order.status, "Dispatched"); assert.equal(order.note, otherNote);
      assert.equal(order.customerId, customer.id); assert.equal(order.paymentTerms.id, "net-14");
      assert.equal(patchCount, 3, "one busy-guarded write, one rejected stale write and one fresh dispatch write");

      await detail.click();
      await page.locator("#wStatus").selectOption("Preparing");
      await page.locator('#sheet button[type="submit"]').click();
      await page.locator("#scrim").waitFor({ state: "hidden" });
      await quick.filter({ hasText: "Mark ready" }).waitFor();
      assert.equal((await orderFor(order.id)).status, "Preparing", "the full status sheet remains available to correct a quick advance");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "order handling fits the screen");
      assert.deepEqual(errors, []);
    } finally {
      for (const gate of gates) gate.release();
      await context.close();
    }
  });
}
