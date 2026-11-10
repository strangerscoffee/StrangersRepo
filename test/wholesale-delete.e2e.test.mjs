// Wholesale deletion is explicit, version checked and separate from payment/refund handling.
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
const dashboard = async () => (await api("GET", "/api/admin/wholesale")).body;
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "Orders Admin", username: "owner", password: "orders-owner-password", code: SETUP_CODE }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale deletion ${device} ${color}: explicit confirmation, preserved drafts, busy guards and concurrent edits`, { timeout: 120000 }, async () => {
    const business = `${device} ${color} Delete Café`, username = `delete.${device.toLowerCase()}.${color}`;
    const customer = (await api("POST", "/api/admin/wholesale/customers", { business, contact: "Order Buyer", email: "orders@example.com", address: "10 Coffee Street", postcode: "NR1 1AA", status: "Active", note: "Private account note", paymentTerms: "net-30" })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
    const customerCookie = (await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-password" }, null)).cookie;
    const profile = (await api("GET", "/api/wholesale/session", undefined, customerCookie)).body.customer;
    const makeOrder = async (pack, quantity, price, cookie = customerCookie) => (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: profile.version, business, reference: `Delete-${pack}-${device}-${color}`, delivery: "Roastery collection", lines: [{ productId: "brazil", pack, grind: "beans", quantity, price }] }, cookie)).body.order;
    const first = await makeOrder("kilo", 2, 1800), stale = await makeOrder("quarter", 1, 500), preview = await makeOrder("quarter", 3, 500, ADMIN);
    const context = await browser.newContext({ viewport, colorScheme: color, hasTouch: true, isMobile: device === "phone" });
    const [name, value] = ADMIN.split("=");
    await context.addCookies([{ name, value, url: srv.base }]);
    const gates = new Set();
    try {
      const page = await context.newPage(), errors = [], deletes = [];
      let nextGate = null;
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/admin/wholesale/orders/*", async (route) => {
        if (route.request().method() !== "DELETE") { await route.continue(); return; }
        const request = { id: route.request().url().split("/").at(-1), body: route.request().postDataJSON() };
        deletes.push(request);
        const gate = nextGate?.id === request.id ? nextGate : null;
        if (gate) { nextGate = null; gate.arrive(request); await gate.released; }
        await route.continue();
      });
      function holdDelete(id) {
        let arrive, release;
        const arrived = new Promise((resolve) => { arrive = resolve; });
        const released = new Promise((resolve) => { release = resolve; });
        const gate = { id, arrive, arrived, released, release };
        gates.add(gate); nextGate = gate; return gate;
      }
      const detail = (id) => page.locator(`[data-act="wh-order"][data-id="${id}"]`);
      const confirmation = page.locator("#wDeleteOrderForm");
      const confirm = confirmation.locator('button[type="submit"]');
      async function openConfirmation() {
        await page.locator('#sheet [data-sheet="delete-order"]').click();
        await confirmation.waitFor();
        assert.equal((await confirm.textContent()).trim(), "Confirm delete order");
      }
      async function assertDraft(status, note, customerId) {
        await page.locator("#wStatus").waitFor();
        assert.equal(await page.locator("#wStatus").inputValue(), status);
        assert.equal(await page.locator("#wNote").inputValue(), note);
        assert.equal(await page.locator("#wCustomer").inputValue(), customerId);
      }
      await page.goto(srv.base + "/admin#wholesale");
      await detail(first.id).click();
      const draft = "Unsaved packing note retained after cancellation.";
      await page.locator("#wStatus").selectOption("Preparing");
      await page.locator("#wNote").fill(draft);
      await openConfirmation();
      const copy = await confirmation.textContent();
      for (const value of [business, first.id, "£36.00"]) assert.ok(copy.includes(value), `confirmation identifies ${value}`);
      assert.match(copy, /history/i); assert.match(copy, /payment/i); assert.match(copy, /refund/i);
      assert.equal(deletes.length, 0, "opening confirmation sends no delete request");
      await confirmation.locator('[data-sheet="cancel-delete"]').click();
      await assertDraft("Preparing", draft, customer.id);
      await openConfirmation(); await page.keyboard.press("Escape");
      await assertDraft("Preparing", draft, customer.id);
      await openConfirmation(); await page.mouse.click(4, 4);
      await assertDraft("Preparing", draft, customer.id);
      assert.equal(deletes.length, 0, "Cancel, Escape and backdrop preserve the order and unsaved editor fields");
      const unchanged = (await dashboard()).orders.find((row) => row.id === first.id);
      assert.equal(unchanged.status, "New"); assert.equal(unchanged.note, ""); assert.equal(unchanged.version, first.version);

      const before = await dashboard(), busy = holdDelete(first.id);
      await openConfirmation(); await confirm.click();
      const pending = await busy.arrived;
      assert.deepEqual(pending.body, { ifVersion: first.version }, "cancelled confirmation preserves its original displayed version");
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await confirmation.locator('[data-sheet="cancel-delete"]').isDisabled(), true);
      await page.keyboard.press("Escape"); await page.mouse.click(4, 4);
      assert.equal(await confirmation.isVisible(), true, "a pending delete cannot be dismissed before its result is known");
      const button = await confirm.boundingBox();
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      assert.equal(deletes.length, 1, "repeated taps do not duplicate the pending deletion");
      await screenshot(page, `delete-confirm-${device}-${color}`);
      busy.release(); gates.delete(busy);
      await confirmation.waitFor({ state: "hidden" }); await detail(first.id).waitFor({ state: "detached" });
      const after = await dashboard();
      assert.equal(after.orders.some((row) => row.id === first.id), false);
      assert.equal(after.counts.order, before.counts.order - 1);
      assert.equal(after.stats.openOrders, before.stats.openOrders - 1);
      assert.equal(after.stats.gramsToPrepare, before.stats.gramsToPrepare - first.grams);
      const history = (await api("GET", "/api/wholesale/orders", undefined, customerCookie)).body.orders;
      assert.deepEqual(history.map((row) => row.id), [stale.id], "deleted customer order leaves customer history while other orders remain");
      assert.equal((await api("GET", "/api/wholesale/session", undefined, customerCookie)).body.customer.paymentTerms.id, "net-30", "deletion preserves the customer agreement");

      await detail(stale.id).click();
      const staleDraft = "Unsaved note survives a rejected delete.";
      await page.locator("#wStatus").selectOption("Preparing"); await page.locator("#wNote").fill(staleDraft);
      const conflict = holdDelete(stale.id);
      await openConfirmation(); await confirm.click();
      assert.equal((await conflict.arrived).body.ifVersion, stale.version);
      const otherNote = "Another admin changed this order.";
      const changed = (await api("PATCH", `/api/admin/wholesale/orders/${stale.id}`, { ifVersion: stale.version, customerId: customer.id, status: "Ready", note: otherNote })).body.order;
      conflict.release(); gates.delete(conflict);
      await confirmation.locator('[data-sheet="reload-delete"]').waitFor();
      assert.equal(await confirm.isDisabled(), true, "a rejected deletion requires an explicit reload before confirming this form again");
      assert.equal(await confirmation.locator('[data-sheet="cancel-delete"]').isEnabled(), true);
      assert.equal(await confirmation.locator('[data-sheet="reload-delete"]').isEnabled(), true);
      assert.match(await confirmation.textContent(), /changed|reload/i);
      const retained = (await dashboard()).orders.find((row) => row.id === stale.id);
      assert.equal(retained.version, changed.version); assert.equal(retained.status, "Ready"); assert.equal(retained.note, otherNote);
      await screenshot(page, `delete-conflict-${device}-${color}`);
      await confirmation.locator('[data-sheet="cancel-delete"]').click();
      await assertDraft("Preparing", staleDraft, customer.id);
      await openConfirmation(); await confirm.click();
      await confirmation.locator('[data-sheet="reload-delete"]').waitFor();
      assert.equal(await confirm.isDisabled(), true, "a rejected deletion requires an explicit reload before confirming this form again");
      assert.equal(await confirmation.locator('[data-sheet="cancel-delete"]').isEnabled(), true);
      assert.equal(await confirmation.locator('[data-sheet="reload-delete"]').isEnabled(), true);
      assert.equal(deletes.at(-1).body.ifVersion, stale.version, "cancelling a failed confirmation does not silently promote its version");
      await confirmation.locator('[data-sheet="reload-delete"]').click();
      await assertDraft("Ready", otherNote, customer.id);
      const countBeforeFreshConfirmation = deletes.length;
      await openConfirmation();
      assert.equal(deletes.length, countBeforeFreshConfirmation, "reloading latest still requires explicit confirmation");
      await confirm.click(); await confirmation.waitFor({ state: "hidden" }); await detail(stale.id).waitFor({ state: "detached" });
      assert.equal(deletes.at(-1).body.ifVersion, changed.version);
      assert.deepEqual((await api("GET", "/api/wholesale/orders", undefined, customerCookie)).body.orders, []);

      await detail(preview.id).click();
      assert.match(await page.locator("#sheet").textContent(), /Staff preview/);
      await page.locator("#wStatus").selectOption("Ready"); await page.locator("#wNote").fill("Preview draft");
      await page.locator("#wCustomer").selectOption(customer.id);
      await openConfirmation(); await confirmation.locator('[data-sheet="cancel-delete"]').click();
      await assertDraft("Ready", "Preview draft", customer.id);
      const beforePreview = await dashboard();
      await openConfirmation(); await confirm.click();
      await confirmation.waitFor({ state: "hidden" }); await detail(preview.id).waitFor({ state: "detached" });
      const afterPreview = await dashboard();
      assert.equal(afterPreview.counts.order || 0, beforePreview.counts.order - 1);
      assert.equal(afterPreview.stats.openOrders, beforePreview.stats.openOrders);
      assert.equal(afterPreview.stats.gramsToPrepare, beforePreview.stats.gramsToPrepare);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "deletion flow fits the screen");
      assert.deepEqual(errors, []);
    } finally {
      for (const gate of gates) gate.release();
      await context.close();
    }
  });
}
