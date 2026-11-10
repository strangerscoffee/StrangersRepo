import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF, MANAGER, A, B, config, sourceOrder, secondOrder, issued, issuedPayload, originalPdf, immutableData;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN, headers = {}) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await response.arrayBuffer()); let data; try { data = JSON.parse(bytes.toString()); } catch {}
  return { status: response.status, body: data, bytes, headers: response.headers, cookie: cookieOf(response) };
}
async function customer(username) {
  const credentials = { username, password: username + "-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business: username + " business", contact: "Invoice Buyer", email: username + "@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === username);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { ifVersion: account.version, username, active: true, approvalStatus: "approved" })).status, 200);
  const login = await call("POST", "/api/wholesale/auth/login", credentials, null);
  assert.equal(login.status, 200);
  return { cookie: login.cookie, ...(await call("GET", "/api/wholesale/session", undefined, login.cookie)).body };
}
async function newOrder(reference = "INV-PO") {
  const session = (await call("GET", "/api/wholesale/session", undefined, A.cookie)).body;
  const result = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: session.customer.version, orderingIdentity: session.me.id, locationId: "primary", lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 3, price: 500 }, { productId: "brazil", pack: "kilo", grind: "filter", quantity: 1, price: 1800 }], delivery: "Roastery collection", reference }, A.cookie);
  assert.equal(result.status, 201); return result.body.order;
}
async function saveSettings(fields = {}) {
  const current = (await call("GET", "/api/admin/wholesale/invoice-settings")).body;
  const result = await call("PUT", "/api/admin/wholesale/invoice-settings", { ...current.settings, ifVersion: current.version, ...fields });
  if (result.status === 200) config = result.body;
  return result;
}
const validSettings = () => ({ seller: { legalName: "TEST Supplier Limited", address: "1 Test Street\nNorwich NR1 1AA", vatNumber: "TEST-GB123456789", companyNumber: "TEST0001", email: "test@example.com", phone: "01603 000000" }, priceBasis: "exclusive", vatRates: [{ id: "zero", label: "Zero", basisPoints: 0 }, { id: "reduced", label: "Reduced", basisPoints: 500 }, { id: "standard", label: "Standard", basisPoints: 2000 }], defaultCoffeeRateId: "standard", deliveryRateId: "standard", invoicePrefix: "TEST-", firstInvoiceNumber: 1000, paymentInstructions: "TEST instructions only: quote invoice number.", confirmed: true });
const invoiceRequest = (order = sourceOrder, fields = {}) => ({ orderVersion: order.version, settingsVersion: config.version, invoiceDate: "2020-01-01", supplyDate: "2020-01-01", ...fields });
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  const setup = await call("POST", "/api/auth/setup", { name: "Invoice Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie;
  for (const role of ["staff", "manager"]) {
    await call("POST", "/api/admin/users", { name: role, username: role, role, password: "temporary-password" });
    const response = await call("POST", "/api/auth/change", { username: role, password: "temporary-password", newPassword: role + "-own-password" }, null);
    assert.equal(response.status, 200); if (role === "staff") STAFF = response.cookie; else MANAGER = response.cookie;
  }
  A = await customer("invoice.a"); B = await customer("invoice.b");
  const profile = await call("PUT", "/api/wholesale/account", { ifVersion: A.customer.version, address: "10 Buyer Street", postcode: "NR2 2AA", phone: "01603 111111" }, A.cookie);
  assert.equal(profile.status, 200);
  const raw = (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === A.customer.id);
  assert.equal((await call("PUT", "/api/admin/wholesale/customers/" + raw.id, { ...raw, ifVersion: raw.version, paymentTerms: "net-14", paymentNote: "14 days from invoice" })).status, 200);
  sourceOrder = await newOrder(); secondOrder = await newOrder("SECOND-PO");
});
after(async () => { await srv?.stop(); });

test("wholesale invoices: supplier/VAT settings remain draft until explicitly complete and confirmed; edits are versioned", async () => {
  const empty = (await call("GET", "/api/admin/wholesale/invoice-settings")).body;
  assert.equal(empty.version, 0); assert.equal(empty.ready, false); assert.equal(empty.settings.priceBasis, null); assert.deepEqual(empty.settings.vatRates, []); assert.equal(empty.settings.seller.vatNumber, "");
  assert.equal((await saveSettings()).status, 200); assert.equal(config.ready, false); assert.ok(config.reasons.length >= 5);
  const incomplete = await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice/preview`, invoiceRequest());
  assert.equal(incomplete.status, 409); assert.equal(incomplete.body.code, "invoice_settings_incomplete");
  assert.equal((await call("PUT", "/api/admin/wholesale/invoice-settings", { ...validSettings(), ifVersion: 0 })).status, 409);
  assert.equal((await saveSettings({ ...validSettings(), confirmed: false })).status, 200); assert.equal(config.ready, false);
  assert.equal((await saveSettings({ confirmed: true })).status, 200); assert.equal(config.ready, true);
  assert.deepEqual(config.reasons, []);
});

test("wholesale invoices: preview uses fixed saved lines, exact inclusive/exclusive/mixed VAT and net-term calendar dates without allocating numbers", async () => {
  const path = `/api/admin/wholesale/orders/${sourceOrder.id}/invoice/preview`;
  const exclusive = (await call("POST", path, invoiceRequest(sourceOrder, { deliveryCharge: { pence: 555, vatRateId: "standard" }, lineVatRateIds: ["standard", "zero"] }))).body.invoice;
  // Order lines are canonically sorted: kilo first (1800), then three quarter bags (1500).
  assert.deepEqual(exclusive.totals, { netPence: 3855, vatPence: 471, grossPence: 4326 });
  assert.equal(exclusive.id, null); assert.equal(exclusive.number, null); assert.equal(exclusive.dueDate, "2020-01-15"); assert.equal(exclusive.orderReference, "INV-PO");
  assert.equal(exclusive.billTo.name, A.customer.business); assert.equal(exclusive.billTo.address, "10 Buyer Street"); assert.equal(exclusive.lines[0].quantity, sourceOrder.lines[0].quantity); assert.equal(exclusive.lines[0].unitPricePence, sourceOrder.lines[0].price);
  assert.equal((await saveSettings({ priceBasis: "inclusive" })).status, 200);
  const inclusive = (await call("POST", path, invoiceRequest(sourceOrder, { deliveryCharge: { pence: 555, vatRateId: "standard" } }))).body.invoice;
  assert.deepEqual(inclusive.totals, { netPence: 3212, vatPence: 643, grossPence: 3855 });
  assert.equal((await saveSettings({ priceBasis: "exclusive", defaultCoffeeRateId: "reduced" })).status, 200);
  const reduced = (await call("POST", path, invoiceRequest(sourceOrder, { deliveryCharge: { pence: 555, vatRateId: "standard" } }))).body.invoice;
  assert.deepEqual(reduced.totals, { netPence: 3855, vatPence: 276, grossPence: 4131 });
  const leap = (await call("POST", path, invoiceRequest(sourceOrder, { invoiceDate: "2024-02-29", supplyDate: "2024-02-29" }))).body.invoice;
  assert.equal(leap.dueDate, "2024-03-14");
  for (const fields of [{ invoiceDate: "2026-02-30" }, { supplyDate: "2026-02-29" }, { dueDate: "2020-01-20" }, { lineVatRateIds: ["standard"] }, { deliveryCharge: { pence: -1 } }]) assert.equal((await call("POST", path, invoiceRequest(sourceOrder, fields))).status, 400);
  const draftPdf = await call("POST", path + "/pdf", invoiceRequest());
  assert.equal(draftPdf.status, 200); assert.match(draftPdf.headers.get("content-type"), /application\/pdf/); assert.ok(draftPdf.bytes.subarray(0, 4).equals(Buffer.from("%PDF")));
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM wholesale_invoices")[0].n, 0);
  assert.equal(srv.sql("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='wholesale_invoices'),0) AS n")[0].n, 0);
  assert.equal((await saveSettings({ defaultCoffeeRateId: "standard" })).status, 200);
});

test("wholesale invoices: concurrent issue/retry creates one immutable invoice per order and consecutive unique numbers", async () => {
  issuedPayload = invoiceRequest();
  const otherPayload = invoiceRequest(secondOrder);
  const [first, retry, other] = await Promise.all([
    call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload),
    call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload),
    call("POST", `/api/admin/wholesale/orders/${secondOrder.id}/invoice`, otherPayload),
  ]);
  assert.ok([first.status, retry.status].every((status) => status === 200 || status === 201)); assert.equal(other.status, 201);
  assert.equal(first.body.invoice.id, retry.body.invoice.id); issued = first.body.invoice;
  assert.deepEqual([issued.number, other.body.invoice.number].sort(), ["TEST-001000", "TEST-001001"]);
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM wholesale_invoices")[0].n, 2); assert.equal(srv.sql("SELECT seq FROM sqlite_sequence WHERE name='wholesale_invoices'")[0].seq, 2);
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, { ...issuedPayload, invoiceDate: "2020-01-02" })).status, 409);
  assert.deepEqual((await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload)).body.invoice, issued);
  immutableData = srv.sql(`SELECT data FROM wholesale_invoices WHERE seq=${issued.id}`)[0].data;
  const pdf = await call("GET", `/api/admin/wholesale/invoices/${issued.id}/pdf`); assert.equal(pdf.status, 200); originalPdf = pdf.bytes;
});

test("wholesale invoices: stale reviews, cancelled/deleted/test orders, missing billing details and unsafe numbering cannot issue invoices", async () => {
  assert.equal((await saveSettings({ firstInvoiceNumber: 9999 })).status, 400);
  const oldVersion = config.version;
  assert.equal((await saveSettings({ seller: { ...config.settings.seller, legalName: "Changed TEST Supplier", address: "A different legal address" }, priceBasis: "inclusive", defaultCoffeeRateId: "zero" })).status, 200);
  assert.equal((await call("GET", `/api/admin/wholesale/invoices/${issued.id}`)).body.invoice.seller.legalName, "TEST Supplier Limited");
  const fresh = await newOrder("Stale review");
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${fresh.id}/invoice`, invoiceRequest(fresh, { settingsVersion: oldVersion }))).status, 409);
  const updated = (await call("PATCH", `/api/admin/wholesale/orders/${fresh.id}`, { ifVersion: fresh.version, status: "Preparing", customerId: fresh.customerId, note: "" })).body.order;
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${fresh.id}/invoice`, invoiceRequest(fresh))).status, 409);
  assert.equal((await call("GET", `/api/admin/wholesale/orders/${fresh.id}/invoice`)).body.invoice, null);
  const cancelled = await newOrder("Cancelled");
  await call("PATCH", `/api/admin/wholesale/orders/${cancelled.id}`, { ifVersion: cancelled.version, status: "Cancelled", customerId: cancelled.customerId, note: "" });
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${cancelled.id}/invoice`, invoiceRequest(cancelled))).status, 400);
  const deleted = await newOrder("Deleted before invoice"); await call("DELETE", `/api/admin/wholesale/orders/${deleted.id}`, { ifVersion: deleted.version });
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${deleted.id}/invoice`, invoiceRequest(deleted))).status, 404);
  const staffOrder = (await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }], business: "Staff test", delivery: "Roastery collection" }, STAFF)).body.order;
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${staffOrder.id}/invoice`, invoiceRequest(staffOrder))).status, 400);
  const noBilling = { ...updated.customerSnapshot, address: "", postcode: "" };
  srv.sql(`UPDATE wholesale_preview SET data=json_set(data,'$.customerSnapshot',json('${JSON.stringify(noBilling).replaceAll("'", "''")}')) WHERE kind='order' AND id='${updated.id}'`);
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${updated.id}/invoice/preview`, invoiceRequest(updated))).status, 400);
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${updated.id}/invoice/preview`, invoiceRequest(updated, { billTo: { name: "Legal Buyer", address: "An explicit billing address", postcode: "NR3 3AA" } }))).status, 200);
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM wholesale_invoices")[0].n, 2);
  assert.equal(srv.sql("SELECT seq FROM sqlite_sequence WHERE name='wholesale_invoices'")[0].seq, 2);
});

test("wholesale invoices: only admins configure/issue/record payment; customers and PDFs remain scoped to their own business", async () => {
  const paths = [["GET", "/api/admin/wholesale/invoice-settings"], ["PUT", "/api/admin/wholesale/invoice-settings", {}], ["GET", "/api/admin/wholesale/invoices"], ["GET", `/api/admin/wholesale/invoices/${issued.id}/pdf`], ["POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload], ["PATCH", `/api/admin/wholesale/invoices/${issued.id}/payment`, { ifVersion: 1, paid: true }]];
  for (const [method, path, body] of paths) {
    assert.equal((await call(method, path, body, null)).status, 401);
    assert.equal((await call(method, path, body, A.cookie)).status, 401);
    for (const cookie of [STAFF, MANAGER]) assert.equal((await call(method, path, body, cookie)).status, 403);
  }
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload, ADMIN, { origin: "https://foreign.example" })).status, 403);
  const own = (await call("GET", "/api/wholesale/invoices", undefined, A.cookie)).body;
  assert.equal(own.count, 2); assert.equal(own.summary.count, 2); assert.equal(own.summary.overdueCount, 2);
  assert.equal((await call("GET", "/api/wholesale/invoices", undefined, B.cookie)).body.count, 0);
  for (const path of [`/api/wholesale/invoices/${issued.id}`, `/api/wholesale/invoices/${issued.id}/pdf`, `/api/wholesale/orders/${sourceOrder.id}/invoice`]) {
    assert.equal((await call("GET", path, undefined, A.cookie)).status, 200); assert.equal((await call("GET", path, undefined, B.cookie)).status, 404);
    assert.equal((await call("GET", path, undefined, STAFF)).status, 403);
  }
  assert.equal((await call("PATCH", `/api/wholesale/invoices/${issued.id}`, {}, A.cookie)).status, 403);
  const history = (await call("GET", "/api/wholesale/orders", undefined, A.cookie)).body.orders.find((order) => order.id === sourceOrder.id);
  assert.deepEqual(history.invoice, { id: issued.id, number: issued.number });
});

test("wholesale invoices: manual paid/unpaid records use CAS, update outstanding/overdue totals and preserve all financial data/PDF bytes", async () => {
  const before = (await call("GET", "/api/wholesale/invoices", undefined, A.cookie)).body.summary;
  const paid = await call("PATCH", `/api/admin/wholesale/invoices/${issued.id}/payment`, { ifVersion: issued.payment.version, paid: true, paidDate: "2020-02-01", reference: "TEST manual bank record" });
  assert.equal(paid.status, 200); assert.equal(paid.body.invoice.payment.status, "paid"); assert.equal(paid.body.invoice.payment.outstandingPence, 0);
  assert.equal((await call("PATCH", `/api/admin/wholesale/invoices/${issued.id}/payment`, { ifVersion: issued.payment.version, paid: false })).status, 409);
  const after = (await call("GET", "/api/wholesale/invoices", undefined, A.cookie)).body.summary;
  assert.equal(after.outstandingPence, before.outstandingPence - issued.totals.grossPence); assert.equal(after.overdueCount, before.overdueCount - 1);
  assert.equal((await call("PATCH", `/api/admin/wholesale/invoices/${issued.id}/payment`, { ifVersion: paid.body.invoice.payment.version, paid: true, paidDate: "9999-01-01" })).status, 400);
  assert.equal(srv.sql(`SELECT data FROM wholesale_invoices WHERE seq=${issued.id}`)[0].data, immutableData);
  assert.deepEqual((await call("GET", `/api/admin/wholesale/invoices/${issued.id}/pdf`)).bytes, originalPdf);
  const unrecord = await call("PATCH", `/api/admin/wholesale/invoices/${issued.id}/payment`, { ifVersion: paid.body.invoice.payment.version, paid: false });
  assert.equal(unrecord.status, 200); assert.equal(unrecord.body.invoice.payment.status, "overdue"); assert.equal(unrecord.body.invoice.payment.paidDate, null); assert.equal(unrecord.body.invoice.payment.outstandingPence, issued.totals.grossPence);
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM audit_log WHERE kind='wholesale_invoice_payment' AND text LIKE '%${issued.number}%'`)[0].n, 2);
});

test("wholesale invoices: deleting the source order keeps issued invoices readable and exact issue retries immutable", async () => {
  assert.equal((await call("DELETE", `/api/admin/wholesale/orders/${sourceOrder.id}`, { ifVersion: sourceOrder.version })).status, 200);
  assert.equal((await call("GET", "/api/wholesale/orders/" + sourceOrder.id, undefined, A.cookie)).status, 404);
  assert.equal((await call("GET", `/api/wholesale/invoices/${issued.id}`, undefined, A.cookie)).status, 200);
  assert.equal((await call("GET", `/api/wholesale/orders/${sourceOrder.id}/invoice`, undefined, A.cookie)).status, 200);
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, issuedPayload)).status, 200);
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${sourceOrder.id}/invoice`, { ...issuedPayload, paymentInstructions: "Changed" })).status, 409);
  assert.equal((await call("DELETE", `/api/admin/wholesale/invoices/${issued.id}`, {})).status, 404);
  assert.equal((await call("PUT", `/api/admin/wholesale/invoices/${issued.id}`, {})).status, 404);
  assert.equal((await call("GET", "/api/wholesale/invoices", undefined, A.cookie)).body.count, 2);
});

test("wholesale invoices: backups retain invoice settings, numbering sequence, immutable documents and separate payment records", async () => {
  const result = await call("POST", "/api/admin/backups", {}); assert.equal(result.status, 200);
  const backup = (await call("GET", "/api/admin/backups/" + result.body.backup.id)).body.wholesaleInvoices;
  assert.equal(backup.settings.length, 1); assert.equal(backup.sequence, 2); assert.equal(backup.invoices.length, 2);
  const retained = backup.invoices.find((row) => row.seq === issued.id);
  assert.equal(retained.data, immutableData); assert.equal(retained.payment_version, 3); assert.equal(retained.paid, 0);
  assert.equal(JSON.parse(retained.data).payment, undefined); assert.equal(JSON.parse(retained.data).seller.legalName, "TEST Supplier Limited");
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM audit_log WHERE kind='wholesale_invoice_issued'")[0].n, 2);
});
