// VAT invoicing in the native Admin and customer interfaces. Payment records never move money.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");
let srv, browser, ADMIN;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return { response, body: result, cookie: cookieOf(response) };
}
before(async () => {
  srv = await startServer({ writeLimit: 5000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "Invoice Admin", username: "owner", password: "invoice-owner-password", code: SETUP_CODE }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
async function buyer(label) {
  const username = `invoice.${label}`, password = username + "-password";
  const customer = (await api("POST", "/api/admin/wholesale/customers", { business: `${label} Invoice Coffee`, contact: "Accounts Buyer", email: `${username}@example.test`, phone: "01603 123456", address: "10 Coffee Street\nNorwich", postcode: "NR1 1AA", deliveryNotes: "Use the side door", status: "Active", note: "Private customer note", paymentTerms: "net-14", paymentNote: "Use the invoice number as the bank reference." })).body.customer;
  const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username })).body;
  const cookie = (await api("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: password }, null)).cookie;
  return { username, password, cookie, customer: (await api("GET", "/api/wholesale/session", undefined, cookie)).body.customer };
}
async function screenshot(page, name) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${name}.png` });
}
async function pdfFrom(page, href) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, href);
}
function pdfCheck(pdf) {
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /^application\/pdf/);
  assert.ok(Buffer.from(pdf.bytes).subarray(0, 5).equals(Buffer.from("%PDF-")), "the protected download is a real PDF");
}
function noOverflow(page) { return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1); }
const londonDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const addDays = (day, count) => new Date(Date.parse(day + "T12:00:00Z") + count * 86400000).toISOString().slice(0, 10);

for (const [device, viewport] of [["phone", { width: 393, height: 852 }], ["desktop", { width: 1440, height: 1000 }]]) for (const color of ["light", "dark"]) {
  test(`wholesale invoices ${device} ${color}: reviewed VAT issue, protected customer documents and manual payment`, { timeout: 180000 }, async () => {
    const label = `${device}.${color}`, supplier = `Test Coffee ${device} ${color} Limited`, prefix = `TEST-${device}-${color}-`;
    // Start each viewport with a saved incomplete configuration; existing numbering must remain fixed.
    const previous = (await api("GET", "/api/admin/wholesale/invoice-settings")).body;
    await api("PUT", "/api/admin/wholesale/invoice-settings", { ...previous.settings, seller: { ...previous.settings.seller, legalName: "" }, confirmed: false, ifVersion: previous.version });
    const owner = await buyer(label), stranger = await buyer(`other.${label}`);
    const order = (await api("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: owner.customer.version, locationId: "primary", delivery: "Delivery", reference: `PO-INVOICE-${label}`, lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 1800 }] }, owner.cookie)).body.order;
    const options = { viewport, colorScheme: color, hasTouch: device === "phone", isMobile: device === "phone", acceptDownloads: true };
    const adminContext = await browser.newContext(options), customerContext = await browser.newContext(options), strangerContext = await browser.newContext(options);
    for (const [context, cookie] of [[adminContext, ADMIN], [customerContext, owner.cookie], [strangerContext, stranger.cookie]]) {
      const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: srv.base }]);
    }
    let releaseIssue = () => {};
    try {
      const admin = await adminContext.newPage(), customer = await customerContext.newPage(), other = await strangerContext.newPage(), errors = [];
      for (const page of [admin, customer, other]) page.on("pageerror", (error) => errors.push(error.message));
      await admin.goto(srv.base + "/admin#wholesale");
      await admin.locator(`[data-act="wh-order"][data-id="${order.id}"]`).click();
      await admin.locator('[data-sheet="invoice-open"]').click();
      await admin.locator("#wiSetupRequired").waitFor();
      await admin.locator('[data-sheet="wi-setup"]').click();
      await admin.locator("#wiSettingsForm").waitFor();
      await admin.locator("#wiLegalName").fill("");
      await admin.locator("#wiConfirmed").uncheck();
      if (await admin.locator("#wiFirstNumber").isEditable()) await admin.locator("#wiFirstNumber").fill("500");
      else assert.equal(await admin.locator("#wiFirstNumber").inputValue(), "500", "issued numbering cannot be reset by a later settings editor");
      await admin.locator('#wiSettingsForm button[type="submit"]').click();
      await admin.locator("#wiSetupRequired").waitFor();
      assert.equal((await api("GET", "/api/admin/wholesale/invoice-settings")).body.ready, false);
      assert.equal((await api("GET", `/api/admin/wholesale/orders/${order.id}/invoice`)).body.invoice, null, "saving incomplete settings cannot issue an invoice");
      assert.equal(await admin.locator("#wiIssueInvoice").count(), 0);
      await admin.locator('[data-sheet="wi-setup"]').click();
      await admin.locator("#wiSettingsForm").waitFor();
      for (const [id, value] of Object.entries({ wiLegalName: supplier, wiSellerAddress: "1 Test Roastery Street\nNorwich\nNR1 1ZZ", wiVatNumber: "GBTEST123456", wiCompanyNumber: "TEST01234", wiSellerEmail: "accounts@example.test", wiSellerPhone: "01603 987654", wiPrefix: prefix, wiPaymentInstructions: "Bank transfer using this invoice number. Test account details only." })) await admin.locator("#" + id).fill(value);
      await admin.locator('[data-sheet="wi-settings-choice"][data-key="priceBasis"]').click();
      await admin.locator('#wiChoiceList [data-sheet="wi-choice"][data-value="exclusive"]').click();
      const rateLabels = { coffee: `Zero coffee ${label}`, delivery: `Standard delivery ${label}` };
      for (const [name, percent] of [[rateLabels.coffee, "0"], [rateLabels.delivery, "20"]]) {
        await admin.locator('[data-sheet="wi-rate-add"]').click();
        await admin.locator("#wiRateLabel").fill(name); await admin.locator("#wiRatePercent").fill(percent);
        await admin.locator('#wiRateForm button[type="submit"]').click();
        await admin.locator("#wiSettingsForm").waitFor();
      }
      for (const [key, name] of [["defaultCoffeeRateId", rateLabels.coffee], ["deliveryRateId", rateLabels.delivery]]) {
        await admin.locator(`[data-sheet="wi-settings-choice"][data-key="${key}"]`).click();
        await admin.locator('#wiChoiceList [data-sheet="wi-choice"]', { hasText: name }).click();
      }
      await admin.locator("#wiConfirmed").check();
      assert.match(await admin.locator("#wiSetupStatus").textContent(), /Save invoice settings to check the updated/);
      assert.doesNotMatch(await admin.locator("#wiSetupStatus").textContent(), /Add the supplier/);
      assert.equal(await noOverflow(admin), true);
      await screenshot(admin, `invoice-settings-${device}-${color}`);
      await admin.locator('#wiSettingsForm button[type="submit"]').click();
      await admin.locator("#wiInvoiceForm").waitFor();
      const config = (await api("GET", "/api/admin/wholesale/invoice-settings")).body;
      assert.equal(config.ready, true); assert.equal(config.settings.priceBasis, "exclusive");
      const now = Number((await api("GET", "/api/wholesale/session", undefined, owner.cookie)).response.headers.get("x-now")) || Date.now();
      const day = londonDay(now), invoiceDate = addDays(day, -28), dueDate = addDays(invoiceDate, 14);
      await admin.locator("#wiInvoiceDate").fill(invoiceDate); await admin.locator("#wiSupplyDate").fill(invoiceDate);
      await admin.locator("#wiDeliveryPounds").fill("5.00");
      await admin.locator("#wiDeliveryDescription").fill("Delivery to the café");
      assert.match(await admin.locator("#wiInvoiceForm").textContent(), /14 days from invoice/);
      await admin.locator('#wiInvoiceForm button[type="submit"]').click();
      await admin.locator("#wiPreviewForm").waitFor();
      assert.deepEqual(await admin.locator("#wiPreviewForm .wi-totals dd").allTextContents(), ["£41.00", "£1.00", "£42.00"]);
      assert.match(await admin.locator("#wiPreviewForm").textContent(), /Draft invoice/);
      assert.equal(await admin.locator("#wiPreviewForm tbody tr").count(), 2, "preview includes the saved coffee and delivery lines");
      const invoiceTable = await admin.locator("#wiPreviewForm .wi-table-wrap").evaluate(region => ({ visibleHeight: region.clientHeight, tableHeight: region.querySelector("table").getBoundingClientRect().height }));
      assert.ok(invoiceTable.visibleHeight + 1 >= invoiceTable.tableHeight, "invoice lines use their full height; only the window body scrolls vertically");
      assert.equal((await api("GET", `/api/admin/wholesale/orders/${order.id}/invoice`)).body.invoice, null, "preview is a readonly review and does not allocate an invoice");
      assert.equal(await noOverflow(admin), true);
      const footer = await admin.locator("#wiPreviewForm .wi-foot").boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= viewport.height + 1, "the issue controls stay inside the invoice window");
      await screenshot(admin, `invoice-preview-${device}-${color}`);

      let issueCount = 0, arrived;
      const issueArrived = new Promise((resolve) => { arrived = resolve; }), issueReleased = new Promise((resolve) => { releaseIssue = resolve; });
      await admin.route(`**/api/admin/wholesale/orders/${order.id}/invoice`, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        issueCount++; arrived(route.request().postDataJSON()); await issueReleased; await route.continue();
      });
      const issueButton = admin.locator("#wiIssueInvoice");
      await issueButton.click();
      const submitted = await issueArrived;
      assert.equal(submitted.orderVersion, order.version); assert.equal(submitted.settingsVersion, config.version);
      assert.equal(await issueButton.isDisabled(), true, "issuing blocks repeated actions while the save is pending");
      const bounds = await issueButton.boundingBox();
      await admin.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await admin.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.equal((await api("GET", `/api/admin/wholesale/orders/${order.id}/invoice`)).body.invoice, null);
      assert.equal(issueCount, 1, "repeat clicks send exactly one issuance request");
      releaseIssue();
      await admin.locator("#wiIssuedInvoice").waitFor();
      const issued = (await api("GET", `/api/admin/wholesale/orders/${order.id}/invoice`)).body.invoice;
      assert.ok(issued.id); assert.ok(issued.number.startsWith(prefix));
      assert.deepEqual(issued.totals, { netPence: 4100, vatPence: 100, grossPence: 4200 });
      assert.equal(issued.invoiceDate, invoiceDate); assert.equal(issued.dueDate, dueDate); assert.equal(issued.paymentTerms.id, "net-14");
      assert.equal(issued.payment.status, "overdue"); assert.equal(issued.payment.outstandingPence, 4200);
      const all = (await api("GET", "/api/admin/wholesale/invoices")).body.invoices;
      assert.equal(all.filter((invoice) => invoice.orderId === order.id).length, 1);
      const adminPdf = await pdfFrom(admin, await admin.locator("#wiDownloadPdf").getAttribute("href")); pdfCheck(adminPdf);
      assert.match(adminPdf.disposition, new RegExp(issued.number));
      // The remaining customer/payment steps use the public hooks supplied by WholesaleInvoices.
      await customer.goto(srv.base + "/wholesale-preview/");
      await customer.locator("#products article").first().waitFor();
      await customer.locator("#my-orders").click();
      await customer.locator("#history-invoices").click();
      const card = customer.locator(`[data-customer-invoice="${issued.id}"]`);
      await card.waitFor();
      await customer.locator("#orders-body").evaluate(async body => {
        body.scrollTop = body.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      // Read one settled layout: invoice loading can resize and recenter the native dialog.
      const { invoiceHeader, invoiceTabs, invoiceTitle } = await customer.evaluate(() => {
        const bounds = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { y: rect.y, height: rect.height }; };
        return { invoiceHeader: bounds(".history-window-header"), invoiceTabs: bounds(".history-sections"), invoiceTitle: bounds("#orders-title") };
      });
      assert.ok(invoiceHeader.y >= 0 && invoiceTitle.y >= invoiceHeader.y && invoiceTitle.y + invoiceTitle.height <= invoiceHeader.y + invoiceHeader.height + 1, "invoice title stays in the pinned close toolbar");
      assert.ok(invoiceTabs.y >= invoiceHeader.y + invoiceHeader.height - 1 && invoiceTabs.y + invoiceTabs.height <= viewport.height, "invoice navigation remains visible below the toolbar after content scrolls");
      assert.match(await card.textContent(), new RegExp(issued.number));
      assert.equal((await card.locator(".invoice-state").textContent()).trim(), "Overdue");
      assert.match(await card.locator(".invoice-balance").textContent(), /£42\.00/);
      assert.deepEqual(await customer.locator("#customer-invoice-summary > div strong").allTextContents(), ["£42.00", "£42.00"]);
      await card.locator(".invoice-details summary").click();
      assert.match(await card.locator(".invoice-details").textContent(), /Use the invoice number|Bank transfer/);
      const customerPdfHref = await card.locator("[data-invoice-pdf]").getAttribute("href");
      assert.equal(customerPdfHref, `/api/wholesale/invoices/${issued.id}/pdf`);
      assert.equal(await card.locator("[data-invoice-pdf]").getAttribute("target"), "_blank", "the invoice opens in the browser's built-in PDF window");
      const customerPdf = await pdfFrom(customer, customerPdfHref); pdfCheck(customerPdf);
      assert.deepEqual(customerPdf.bytes, adminPdf.bytes, "customer and admin receive the same protected issued document");
      assert.equal(await noOverflow(customer), true);
      await screenshot(customer, `invoice-customer-overdue-${device}-${color}`);

      await other.goto(srv.base + "/wholesale-preview/");
      await other.locator("#products article").first().waitFor();
      await other.locator("#my-orders").click(); await other.locator("#history-invoices").click();
      await other.locator("#customer-invoices-list", { hasText: "Your issued invoices will appear here" }).waitFor();
      assert.equal(await other.locator("[data-customer-invoice]").count(), 0);
      const privateReads = await other.evaluate(async (id) => {
        const invoice = await fetch(`/api/wholesale/invoices/${id}`), pdf = await fetch(`/api/wholesale/invoices/${id}/pdf`), list = await fetch("/api/wholesale/invoices").then((response) => response.json());
        return { invoice: invoice.status, pdf: pdf.status, invoices: list.invoices, outstanding: list.summary.outstandingPence };
      }, issued.id);
      assert.equal(privateReads.invoice, 404); assert.equal(privateReads.pdf, 404);
      assert.deepEqual(privateReads.invoices, []); assert.equal(privateReads.outstanding, 0);

      const changedSettings = { ...config.settings, seller: { ...config.settings.seller, legalName: "Changed supplier for future invoices", address: "20 New Office Road\nNorwich" }, priceBasis: "inclusive", vatRates: config.settings.vatRates.map((rate) => rate.id === config.settings.defaultCoffeeRateId ? { ...rate, basisPoints: 2000 } : rate), paymentInstructions: "Changed instructions for future invoices only." };
      await api("PUT", "/api/admin/wholesale/invoice-settings", { ...changedSettings, ifVersion: config.version });
      const unchanged = (await api("GET", `/api/admin/wholesale/invoices/${issued.id}`)).body.invoice;
      assert.deepEqual(unchanged, issued, "issued dates, VAT, supplier and agreed terms are immutable after settings edits");
      const afterSettingsPdf = await pdfFrom(customer, customerPdfHref); pdfCheck(afterSettingsPdf);
      assert.deepEqual(afterSettingsPdf.bytes, customerPdf.bytes, "changing invoice settings cannot rewrite an issued PDF");

      await admin.locator('[data-sheet="wi-payment"]').click();
      await admin.locator("#wiPaymentForm").waitFor();
      await admin.locator("#wiPaymentPaid").check(); await admin.locator("#wiPaymentDate").fill(day);
      await admin.locator("#wiPaymentReference").fill(`BANK-${label}`);
      const recorded = admin.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/admin/wholesale/invoices/${issued.id}/payment`);
      await admin.locator('#wiPaymentForm button[type="submit"]').click();
      const paymentResponse = await recorded;
      assert.equal(paymentResponse.status(), 200);
      assert.equal(paymentResponse.request().postDataJSON().ifVersion, issued.payment.version, "manual payment recording uses the displayed version");
      await admin.locator("#wiIssuedInvoice .wi-issued-heading .pill", { hasText: "Paid" }).waitFor();
      const paid = (await api("GET", `/api/admin/wholesale/invoices/${issued.id}`)).body.invoice;
      assert.equal(paid.payment.paid, true); assert.equal(paid.payment.paidDate, day); assert.equal(paid.payment.reference, `BANK-${label}`);
      assert.equal(paid.payment.outstandingPence, 0);
      await customer.locator("#refresh-invoices").click();
      await card.locator(".invoice-state", { hasText: "Paid" }).waitFor();
      assert.deepEqual(await customer.locator("#customer-invoice-summary > div strong").allTextContents(), ["£0.00", "£0.00"]);
      assert.equal(await card.locator(".invoice-balance").count(), 0);
      const paidPdf = await pdfFrom(customer, customerPdfHref); pdfCheck(paidPdf);
      assert.deepEqual(paidPdf.bytes, customerPdf.bytes, "recording payment does not rewrite the issued financial document");
      await screenshot(customer, `invoice-customer-paid-${device}-${color}`);

      // Issued financial records remain available even when the source order is removed.
      await api("DELETE", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version });
      await customer.locator("#refresh-invoices").click(); await card.waitFor();
      assert.equal((await api("GET", "/api/wholesale/invoices", undefined, owner.cookie)).body.invoices.length, 1);
      await admin.locator('#wiIssuedInvoice .wi-foot [data-sheet="wi-back"]').click();
      // Return from the old order editor, then open the independent invoicing work queue.
      if (await admin.locator('#sheet [data-sheet="close"]').count()) await admin.locator('#sheet [data-sheet="close"]').click();
      await admin.locator('[data-act="wh-tab"][data-id="invoices"]').click();
      await admin.locator(`[data-act="wh-invoice-open"][data-id="${issued.id}"]`).waitFor();
      assert.equal(await noOverflow(admin), true); assert.equal(await noOverflow(customer), true);
      assert.deepEqual(errors, []);
    } finally {
      releaseIssue();
      await adminContext.close(); await customerContext.close(); await strangerContext.close();
    }
  });
}
