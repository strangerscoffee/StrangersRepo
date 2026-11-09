// Customer location drafts/defaults and immutable delivery snapshots across the native admin editor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
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
  srv = await startServer({ writeLimit: 3000 });
  const setup = await api("POST", "/api/auth/setup", { name: "Locations Admin", username: "owner", password: "locations-owner-password", code: SETUP_CODE }, null);
  ADMIN = cookieOf(setup.response);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["iPad", { width: 1180, height: 820 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale locations ${device} ${color}: customer drafts/defaults, selected checkout snapshot and admin edits`, { timeout: 150000 }, async () => {
    const username = `locations.${device.toLowerCase()}.${color}`, business = `${device} ${color} Location Coffee`;
    const customer = (await api("POST", "/api/admin/wholesale/customers", { business, contact: "Coffee Buyer", email: `${username}@example.test`, status: "Active", paymentTerms: "net-30", note: "Private account note" })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
    const password = username + "-password";
    await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: password }, null);
    const options = { viewport, colorScheme: color, hasTouch: true, isMobile: device === "phone" };
    const customerContext = await browser.newContext(options), adminContext = await browser.newContext(options);
    const [cookieName, cookieValue] = ADMIN.split("=");
    await adminContext.addCookies([{ name: cookieName, value: cookieValue, url: srv.base }]);
    try {
      const page = await customerContext.newPage(), admin = await adminContext.newPage(), errors = [];
      for (const current of [page, admin]) current.on("pageerror", (error) => errors.push(error.message));
      const profile = () => page.evaluate(() => fetch("/api/wholesale/session").then((response) => response.json()).then((result) => result.customer));
      async function customerLocation(values) {
        await page.locator("#location-dialog").waitFor();
        for (const [field, value] of Object.entries(values)) await page.locator(`#location-form [name="${field}"]`).fill(value);
        await page.locator("#save-location").click();
        await page.locator("#location-dialog").waitFor({ state: "hidden" });
      }
      async function saveCustomer() {
        await page.locator('#account-form button[type="submit"]').click();
        await page.locator("#account-dialog").waitFor({ state: "hidden" });
        return profile();
      }
      async function openAdminCustomer() {
        await admin.locator('[data-act="wh-tab"][data-id="customers"]').click();
        await admin.locator(`[data-act="wh-customer"][data-id="${customer.id}"]`).click();
        await admin.locator("#wCustomerForm").waitFor();
      }
      async function adminLocation(values) {
        await admin.locator("#wLocationForm").waitFor();
        for (const [field, value] of Object.entries(values)) await admin.locator("#wLocation" + field).fill(value);
        await admin.locator('#wLocationForm button[type="submit"]').click();
        await admin.locator("#wCustomerForm").waitFor();
      }
      async function saveAdmin() {
        await admin.locator('#wCustomerForm button[type="submit"]').click();
        await admin.locator("#scrim").waitFor({ state: "hidden" });
        return profile();
      }

      await page.goto(srv.base + "/wholesale-preview/signin");
      await page.locator("#username").fill(username); await page.locator("#password").fill(password);
      await page.locator("#login-submit").click(); await page.waitForURL(/\/wholesale-preview\/$/);
      await page.locator("#products article").first().waitFor();
      await page.locator("#my-account").click(); await page.locator("#account-dialog").waitFor();
      assert.equal(await page.locator("#account-business").textContent(), business);
      assert.equal(await page.locator('#account-form input[name="business"]:not([readonly]):not([hidden])').count(), 0);
      assert.equal(await page.locator('[data-location-remove="primary"]').count(), 0, "the primary delivery location cannot be removed");
      await page.locator('[data-location-edit="primary"]').click();
      await customerLocation({ name: "Main café", contact: "Main Manager", phone: "01603 111111", address: "10 Dove Street\nNorwich", postcode: "NR2 1DE", deliveryNotes: "Front counter" });
      await page.locator("#add-location").click();
      await customerLocation({ name: "Riverside café", contact: "Riverside Manager", phone: "01603 222222", address: "20 Riverside Road\nNorwich", postcode: "NR1 2AB", deliveryNotes: "Use loading door" });
      assert.equal((await profile()).locations.length, 1, "location dialogs stage edits until Save details commits the account");
      let current = await saveCustomer();
      assert.equal(current.business, business); assert.equal(current.locations.length, 2);
      let riverside = current.locations.find((location) => location.name === "Riverside café");
      assert.ok(uuid.test(riverside.id), "new delivery locations receive a persisted server UUID");
      assert.equal(current.locations[0].id, "primary");
      await page.locator("#my-account").click();
      await page.locator(`[data-location-edit="${riverside.id}"]`).click();
      await customerLocation({ address: "22 Riverside Road\nNorwich", deliveryNotes: "Ring the side bell" });
      // A native blur/change must not replace the target between pointerdown and click.
      // Locator.click may retry a detached button and conceal a lost real-world gesture.
      const phone = page.locator('#account-form [name="phone"]');
      await phone.fill("01603 111112");
      const makeDefault = page.locator(`[data-location-default="${riverside.id}"]`);
      await makeDefault.scrollIntoViewIfNeeded();
      const defaultBounds = await makeDefault.boundingBox();
      assert.ok(defaultBounds);
      await page.mouse.click(defaultBounds.x + defaultBounds.width / 2, defaultBounds.y + defaultBounds.height / 2);
      await page.locator(`[data-account-location="${riverside.id}"] .location-default`).waitFor();
      await phone.fill("01603 111111");
      await page.locator("#account-locations").scrollIntoViewIfNeeded();
      await screenshot(page, `locations-account-${device}-${color}`);
      current = await saveCustomer(); riverside = current.locations.find((location) => location.id === riverside.id);
      assert.equal(current.defaultLocationId, riverside.id); assert.equal(riverside.address, "22 Riverside Road\nNorwich");
      assert.equal(current.address, "10 Dove Street\nNorwich", "changing the default does not overwrite the primary location");

      const card = page.locator('article[data-product="brazil"]');
      await card.locator('button[type="submit"]').click();
      await page.locator("#review-order").click(); await page.locator("#review-dialog").waitFor();
      assert.equal(await page.locator("#review-business").textContent(), business);
      assert.equal(await page.locator('#review-form [name="locationId"]').inputValue(), riverside.id, "checkout starts at the saved default location");
      assert.match(await page.locator("#delivery-summary").textContent(), /22 Riverside Road/);
      await page.locator("#review-location").click(); await page.locator("#location-choice-dialog").waitFor();
      await page.locator('[name="location-choice"][value="primary"]').check();
      await page.locator("#location-choice-dialog .close-button").click();
      assert.equal(await page.locator('#review-form [name="locationId"]').inputValue(), riverside.id, "cancelling the location sheet preserves the reviewed choice");
      await page.locator("#review-location").click();
      await page.locator('[name="location-choice"][value="primary"]').check();
      await screenshot(page, `locations-checkout-choice-${device}-${color}`);
      await page.locator("#confirm-location").click();
      assert.equal(await page.locator('#review-form [name="locationId"]').inputValue(), "primary");
      assert.match(await page.locator("#delivery-summary").textContent(), /10 Dove Street/);
      await page.locator('#review-form [name="reference"]').fill(username);
      await page.locator("#submit-preview-order").click(); await page.locator("#preview-complete").waitFor();
      let order = (await api("GET", "/api/admin/wholesale")).body.orders.find((row) => row.reference === username);
      assert.ok(order); assert.equal(order.locationId, "primary"); assert.equal(order.locationSnapshot.name, "Main café");
      assert.equal(order.locationSnapshot.address, "10 Dove Street\nNorwich"); assert.equal(order.customerSnapshot.address, order.locationSnapshot.address);
      assert.equal(order.customerSnapshot.contact, "Main Manager"); assert.equal(order.deliveryNotes, "Front counter");
      assert.equal(Object.hasOwn(order.customerSnapshot, "locations"), false, "an order snapshots only its selected location");
      assert.equal((await profile()).defaultLocationId, riverside.id, "a checkout choice does not change the saved default");
      await page.locator("#preview-complete [data-close]").click();

      await admin.goto(srv.base + "/admin#wholesale"); await openAdminCustomer();
      assert.equal(await admin.locator("#wDefaultLocation").inputValue(), riverside.id);
      await admin.locator('#wLocations [data-sheet="location-edit"][data-index="0"]').click();
      assert.equal(await admin.locator("#wLocationName").inputValue(), "Main café");
      await screenshot(admin, `locations-admin-editor-${device}-${color}`);
      await adminLocation({ Address: "11 Dove Street\nNorwich", Contact: "Updated Main Manager", Notes: "New instructions for future orders" });
      await admin.locator('[data-sheet="location-add"]').click();
      await adminLocation({ Name: "Airport kiosk", Contact: "Airport Manager", Phone: "01603 333333", Address: "3 Airport Road\nNorwich", Postcode: "NR6 1AA", Notes: "Reception desk" });
      current = await saveAdmin();
      const airport = current.locations.find((location) => location.name === "Airport kiosk");
      assert.ok(uuid.test(airport.id)); assert.equal(current.locations.length, 3);
      await openAdminCustomer(); await admin.locator("#wDefaultLocation").selectOption(airport.id);
      const riversideIndex = current.locations.findIndex((location) => location.id === riverside.id);
      await admin.locator(`#wLocations [data-sheet="location-edit"][data-index="${riversideIndex}"]`).click();
      await admin.locator('[data-sheet="location-remove"]').click();
      await admin.locator('[data-sheet="location-remove-confirm"]').click();
      await admin.locator("#wCustomerForm").waitFor();
      current = await saveAdmin();
      assert.equal(current.defaultLocationId, airport.id); assert.equal(current.locations.length, 2);
      assert.equal(current.locations.some((location) => location.id === riverside.id), false);
      assert.equal(current.address, "11 Dove Street\nNorwich");
      order = (await api("GET", "/api/admin/wholesale")).body.orders.find((row) => row.reference === username);
      assert.equal(order.locationSnapshot.address, "10 Dove Street\nNorwich", "later location edits do not rewrite the saved delivery agreement");
      assert.equal(order.locationSnapshot.contact, "Main Manager");
      await admin.locator('[data-act="wh-tab"][data-id="orders"]').click();
      await admin.locator(`[data-act="wh-order"][data-id="${order.id}"]`).click();
      assert.match(await admin.locator("#sheet").textContent(), /Main café/);
      assert.match(await admin.locator("#sheet").textContent(), /10 Dove Street/);
      await page.locator("#my-orders").click(); await page.locator(`[data-history-order="${order.id}"]`).waitFor();
      await page.locator(`[data-history-order="${order.id}"] summary`).click();
      const details = await page.locator(`[data-history-order="${order.id}"] .history-details`).textContent();
      assert.match(details, /Main café/); assert.match(details, /10 Dove Street/); assert.doesNotMatch(details, /11 Dove Street|Airport kiosk/);
      await screenshot(page, `locations-saved-history-${device}-${color}`);
      for (const currentPage of [page, admin]) assert.ok(await currentPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "customer/admin location flows fit the viewport");
      assert.deepEqual(errors, []);
    } finally { await customerContext.close(); await adminContext.close(); }
  });
}
