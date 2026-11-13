import { openWholesaleBasket, openWholesaleAccount } from './wholesale-ui-helpers.mjs';
// Wide customer/admin editors and short desktop windows remain usable with real account/basket data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(ADMIN ? { cookie: ADMIN } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return { response, body: result };
}
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  ADMIN = cookieOf((await api("POST", "/api/auth/setup", { name: "Desktop Admin", username: "owner", password: "desktop-owner-password", code: SETUP_CODE })).response);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}
async function painted(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function reachable(locator, label) {
  const result = await locator.evaluate((node) => {
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { width: box.width, height: box.height, inside: box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1, exposed: hit === node || node.contains(hit) };
  });
  assert.ok(result.width >= 43.5 && result.height >= 43.5, `${label} has a 44px target`);
  assert.ok(result.inside && result.exposed, `${label} stays visible and clickable`);
}

for (const [screen, viewport] of [["compact", { width: 1280, height: 720 }], ["large", { width: 1440, height: 900 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale desktop ${screen} ${color}: grouped editors, draft-safe choices, long identity and scrollable basket`, { timeout: 150000 }, async () => {
    const username = `desktop.${screen}.${color}`, business = `${screen} ${color} ${"NorwichCoffeeHospitality".repeat(6)}`.slice(0, 120);
    const primary = { id: "primary", name: "Main café", contact: "Original Buyer", phone: "01603 111111", address: "10 Main Street", postcode: "NR1 1AA", deliveryNotes: "Main entrance" };
    const locations = [primary, ...Array.from({ length: 9 }, (_, i) => ({ name: i === 0 ? "Riverside café" : `Branch ${i + 1}`, contact: "Branch Manager", phone: "01603 222222", address: `${i + 20} River Street`, postcode: "NR2 2AA", deliveryNotes: "Ring reception" }))];
    const original = (await api("POST", "/api/admin/wholesale/customers", { business, email: `${username}@example.test`, ...Object.fromEntries(["contact", "phone", "address", "postcode", "deliveryNotes"].map((key) => [key, primary[key]])), locations, defaultLocationId: "primary", status: "Active", paymentTerms: "net-30", paymentNote: "Original invoice instructions", note: "Original internal note" })).body.customer;
    const riverside = original.locations.find((location) => location.name === "Riverside café");
    const account = (await api("POST", `/api/admin/wholesale/customers/${original.id}/account`, { username })).body;
    const password = username + "-password";
    await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: password });
    const options = { viewport, colorScheme: color };
    const adminContext = await browser.newContext(options), customerContext = await browser.newContext(options);
    const [name, value] = ADMIN.split("="); await adminContext.addCookies([{ name, value, url: srv.base }]);
    try {
      const admin = await adminContext.newPage(), page = await customerContext.newPage(), errors = [];
      for (const current of [admin, page]) current.on("pageerror", (error) => errors.push(error.message));
      let saves = 0, submitted;
      await admin.route(`**/api/admin/wholesale/customers/${original.id}`, async (route) => {
        if (route.request().method() === "PUT") { saves++; submitted = route.request().postDataJSON(); }
        await route.continue();
      });
      await admin.goto(srv.base + "/admin#wholesale");
      await admin.locator('[data-act="wh-tab"][data-id="customers"]').click();
      await admin.locator(`[data-act="wh-customer"][data-id="${original.id}"]`).click();
      await admin.locator("#wCustomerForm").waitFor();
      assert.equal(await admin.evaluate(() => document.activeElement.id), "sheetTitle", "the editor starts at its title");
      for (const heading of ["#wBusinessTitle", "#wMainLocationTitle", "#wLocationsTitle", "#wOrderingTitle", "#wSigninTitle", "#wInternalNoteTitle"]) assert.equal(await admin.locator(heading).count(), 1, "customer fields are grouped into named sections");
      const columns = await admin.evaluate(() => ({ business: document.querySelector("#wBusinessTitle").getBoundingClientRect().x, ordering: document.querySelector("#wOrderingTitle").getBoundingClientRect().x }));
      assert.ok(columns.ordering > columns.business + 10, "wide editors use both columns rather than a narrow phone form");
      await admin.locator("#wContact").fill("Desktop edited contact");
      await admin.locator("#wEmail").fill("desktop.edited@example.test");
      await admin.locator("#wAddress").fill("25 Edited Main Street");
      await admin.locator("#wPaymentNote").fill("Keep these customer-facing payment instructions.");
      await admin.locator("#wNote").fill("Keep this entire internal draft through all choice sheets.");
      await admin.locator('[data-sheet="location-add"]').click();
      await admin.locator("#wLocationName").fill("Unsaved desktop branch");
      await admin.locator("#wLocationAddress").fill("7 Market Road");
      await admin.locator("#wLocationPostcode").fill("NR3 3AA");
      await admin.locator('#wLocationForm button[type="submit"]').click();
      await admin.locator("#wCustomerForm").waitFor();

      const draft = () => admin.locator("#wCustomerForm").evaluate((form) => Object.fromEntries(["wBusiness", "wContact", "wEmail", "wPhone", "wAddress", "wPostcode", "wDeliveryNotes", "wPaymentTerms", "wPaymentNote", "wStatus", "wNote", "wDefaultLocation"].map((id) => [id, form.querySelector("#" + id).value])));
      const beforeChoices = await draft();
      async function openChoice(id) {
        const opener = admin.locator(`[data-sheet="customer-choice"][data-choice="${id}"]`);
        await opener.evaluate((node) => node.scrollIntoView({ block: "center" }));
        const scrollTop = await admin.locator("#sheet").evaluate((node) => node.scrollTop);
        await opener.focus(); await admin.keyboard.press("Enter");
        await admin.locator("#wCustomerChoice").waitFor();
        return scrollTop;
      }
      async function assertChoiceReturn(id, scrollTop) {
        await admin.locator("#wCustomerForm").waitFor();
        assert.equal(await admin.locator(`[data-sheet="customer-choice"][data-choice="${id}"]`).evaluate((node) => document.activeElement === node), true, "cancel restores the choice opener's keyboard focus");
        assert.ok(Math.abs((await admin.locator("#sheet").evaluate((node) => node.scrollTop)) - scrollTop) <= 2, "choice cancellation restores the editing position");
        assert.deepEqual(await draft(), beforeChoices, "the whole customer draft survives cancellation");
        assert.match(await admin.locator("#wLocations").textContent(), /Unsaved desktop branch/);
      }
      let scrollTop = await openChoice("wPaymentTerms");
      assert.equal(await admin.locator('#wCustomerChoice [data-value="net-30"]').getAttribute("aria-pressed"), "true");
      await admin.locator('[data-sheet="customer-choice-cancel"]').click();
      await assertChoiceReturn("wPaymentTerms", scrollTop);
      scrollTop = await openChoice("wDefaultLocation"); await admin.keyboard.press("Escape");
      await assertChoiceReturn("wDefaultLocation", scrollTop);
      scrollTop = await openChoice("wStatus"); await admin.mouse.click(4, 4);
      await assertChoiceReturn("wStatus", scrollTop);
      assert.equal(saves, 0, "choice sheets never save the customer themselves");
      const unchanged = (await api("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === original.id);
      assert.equal(unchanged.version, original.version); assert.equal(unchanged.contact, "Original Buyer");
      async function choose(id, selected) {
        await openChoice(id);
        await admin.locator(`#wCustomerChoice [data-sheet="customer-choice-apply"][data-value="${selected}"]`).click();
        await admin.locator("#wCustomerForm").waitFor();
      }
      await choose("wPaymentTerms", "net-14"); await choose("wDefaultLocation", riverside.id);
      await choose("wStatus", "On hold"); assert.equal(await admin.locator("#wStatus").inputValue(), "On hold");
      await choose("wStatus", "Active");
      for (const position of [0, Number.MAX_SAFE_INTEGER]) {
        await admin.locator("#sheet").evaluate((node, top) => { node.scrollTop = top; }, position);
        await painted(admin);
        await reachable(admin.locator('#wCustomerHeader [data-sheet="close"]'), "Admin editor close");
        await reachable(admin.locator('#wCustomerFooter [data-sheet="close"]'), "Admin editor cancel");
        await reachable(admin.locator('#wCustomerFooter button[type="submit"]'), "Admin editor save");
      }
      await screenshot(admin, `desktop-admin-editor-${screen}-${color}`);
      await admin.locator('#wCustomerFooter button[type="submit"]').click(); await admin.locator("#scrim").waitFor({ state: "hidden" });
      assert.equal(saves, 1, "the final customer save sends one versioned write");
      assert.equal(submitted.ifVersion, original.version); assert.equal(submitted.note, beforeChoices.wNote); assert.equal(submitted.paymentNote, beforeChoices.wPaymentNote);
      const updated = (await api("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === original.id);
      assert.equal(updated.version, original.version + 1); assert.equal(updated.defaultLocationId, riverside.id); assert.equal(updated.paymentTerms, "net-14"); assert.equal(updated.status, "Active");
      assert.equal(updated.locations.length, 11); assert.ok(updated.locations.some((location) => location.name === "Unsaved desktop branch" && location.id));
      assert.equal(updated.contact, "Desktop edited contact"); assert.equal(updated.address, "25 Edited Main Street");

      await page.goto(srv.base + "/wholesale-preview/signin");
      await page.locator("#username").fill(username); await page.locator("#password").fill(password); await page.locator("#login-submit").click();
      await page.waitForURL(/\/wholesale-preview\/$/); await page.locator("#products article").first().waitFor(); await painted(page);
      assert.equal(await page.locator("#signed-in-name").textContent(), business);
      const header = await page.locator(".site-header").evaluate((node) => {
        const controls = [...node.querySelectorAll("a,button")].map((control) => ({ name: control.getAttribute("aria-label") || control.textContent.trim(), box: control.getBoundingClientRect() })).filter(({ box }) => box.width && box.height);
        const overlapping = [];
        for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i].box, b = controls[j].box;
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlapping.push([controls[i].name, controls[j].name]);
        }
        return { overflowing: document.documentElement.scrollWidth > innerWidth + 1, overlapping, small: controls.filter(({ box }) => box.width < 43.5 || box.height < 43.5).map(({ name }) => name) };
      });
      assert.equal(header.overflowing, false); assert.deepEqual(header.overlapping, []); assert.deepEqual(header.small, []);
      await screenshot(page, `desktop-customer-header-${screen}-${color}`);
      await openWholesaleAccount(page); await page.locator("#account-dialog").waitFor();
      assert.equal(await page.locator("#save-account").getAttribute("form"), "account-form", "the footer save remains associated with its account form");
      await page.locator('#account-form [name="contact"]').fill("Customer desktop contact");
      for (const position of [0, Number.MAX_SAFE_INTEGER]) {
        await page.locator("#account-body").evaluate((node, top) => { node.scrollTop = top; }, position);
        await painted(page);
        await reachable(page.locator(".account-window-header .close-button"), "Customer account close");
        await reachable(page.locator("#save-account"), "Customer account save");
      }
      await screenshot(page, `desktop-customer-account-${screen}-${color}`);
      await page.locator("#save-account").click(); await page.locator("#account-dialog").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#account-toggle")), true, "closing account details restores its opener");
      const savedProfile = await page.evaluate(() => fetch("/api/wholesale/session").then((response) => response.json()).then((result) => result.customer));
      assert.equal(savedProfile.contact, "Customer desktop contact", "the external footer action submits the associated account form");
      assert.equal(savedProfile.business, business); assert.equal(savedProfile.defaultLocationId, riverside.id);
      const catalogue = (await api("GET", "/api/admin/wholesale")).body.products.filter((product) => product.active && product.inStock).slice(0, 10);
      for (const coffee of catalogue) await page.locator(`article[data-product="${coffee.id}"] button[type="submit"]`).click();
      assert.equal(await page.locator("#order-items .order-item").count(), 10);
      const expectedTotal = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(catalogue.reduce((sum, product) => sum + product.prices.kilo, 0) / 100);
      assert.equal(await page.locator("#subtotal").textContent(), expectedTotal);
      await page.evaluate(() => window.scrollTo(0, 0)); await painted(page);
      await openWholesaleBasket(page);
      const list = page.locator("#order-items");
      await list.focus(); await page.keyboard.press("End");
      await page.waitForFunction(() => document.querySelector("#order-items").scrollTop > 0);
      const scroll = await list.evaluate((node) => ({ height: node.clientHeight, content: node.scrollHeight, top: node.scrollTop, active: document.activeElement === node, tabindex: node.getAttribute("tabindex"), label: node.getAttribute("aria-label") }));
      assert.ok(scroll.content > scroll.height && scroll.top > 0, "a long desktop basket scrolls within its list");
      assert.equal(scroll.active, true); assert.equal(scroll.tabindex, "0"); assert.equal(scroll.label, "Coffee in your order");
      await reachable(page.locator("#review-order"), "Basket review");
      assert.equal(await page.locator("#review-order").isEnabled(), true);
      assert.ok(await page.locator("#order-totals").evaluate((node) => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight + 1; }), "coffee totals stay visible outside the scrolling list");
      await screenshot(page, `desktop-long-basket-${screen}-${color}`);
      await openWholesaleBasket(page); await page.locator("#review-order").click(); await page.locator("#review-dialog").waitFor();
      assert.equal(await page.locator("#review-total").textContent(), expectedTotal);
      await page.keyboard.press("Escape"); await page.locator("#review-dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement === document.querySelector("#review-order"));
      assert.equal(await page.locator("#review-order").evaluate((node) => document.activeElement === node), true, "closing the async review returns keyboard focus to Review order");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
    } finally { await adminContext.close(); await customerContext.close(); }
  });
}
