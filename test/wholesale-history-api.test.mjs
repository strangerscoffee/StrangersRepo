import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, customerA, customerB, trackingOrder, trackingPayload, invoiceId, invoiceData;
const cookieOf = response => (response.headers.getSetCookie().find(value => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN, extraHeaders = {}) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "History Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const admin = (await api("GET", "/api/auth/me")).body.user;
  for (const name of ["a", "b"]) {
    const customer = (await api("POST", "/api/admin/wholesale/customers", { business: "History partner " + name, contact: "Buyer", email: name + "@example.test", status: "Active", note: "Internal credit note" })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username: "history." + name })).body;
    const session = await api("POST", "/api/wholesale/auth/change-password", { username: "history." + name, password: account.temporaryPassword, newPassword: "history-password-" + name }, null);
    assert.equal(session.status, 200);
    if (name === "a") { A = session.cookie; customerA = customer; } else { B = session.cookie; customerB = customer; }
  }
  srv.sql(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205)
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at)
    SELECT 'order','WS-' || printf('%032d',x),json_object('customerId','${customerA.id}','preview',json('false'),'createdBy','wholesale:fixture','business','History partner a','status','New','pence',3700,'grams',1000,'packs',1,'lines',json('[]'),'note','Internal order note','requestKey','private-digest'),1,1700000000000 FROM n;
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES
    ('order','WS-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',json_object('customerId','${customerB.id}','preview',json('false'),'createdBy','wholesale:other','business','History partner b','lines',json('[]'),'note','Other private note'),1,1700000000000),
    ('order','PREVIEW-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',json_object('customerId','${customerA.id}','createdBy','${admin.id}','preview',json('true'),'business','Staff test','lines',json('[]'),'note','Staff note'),1,1700000000000);`);
});
after(async () => { await srv?.stop(); });

test("wholesale history: customers can page beyond 200 orders without duplicates or private fields", async () => {
  const first = await api("GET", "/api/wholesale/orders", undefined, A);
  assert.equal(first.status, 200); assert.equal(first.body.orders.length, 200); assert.equal(first.body.count, 205); assert.ok(first.body.nextCursor);
  const next = await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(first.body.nextCursor), undefined, A);
  assert.equal(next.status, 200); assert.equal(next.body.orders.length, 5); assert.equal(next.body.count, 205); assert.equal(next.body.nextCursor, null);
  const all = [...first.body.orders, ...next.body.orders];
  assert.equal(new Set(all.map(row => row.id)).size, 205);
  for (const row of all) { assert.equal(row.customerId, customerA.id); assert.equal(row.preview, false); assert.equal(row.note, undefined); assert.equal(row.requestKey, undefined); }
});

test("wholesale history: cursors never change business ownership or reveal staff tests", async () => {
  const first = (await api("GET", "/api/wholesale/orders", undefined, A)).body;
  const other = await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(first.nextCursor), undefined, B);
  assert.equal(other.status, 200); assert.equal(other.body.count, 1);
  assert.ok(other.body.orders.every(row => row.customerId === customerB.id));
  const staff = await api("GET", "/api/wholesale/orders");
  assert.equal(staff.status, 200); assert.equal(staff.body.count, 1); assert.match(staff.body.orders[0].id, /^PREVIEW-/);
  for (const cursor of ["not-valid", "9007199254740992:id", "1700000000000:' OR 1=1"]) assert.equal((await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(cursor), undefined, A)).status, 400);
  assert.equal((await api("GET", "/api/wholesale/orders", undefined, null)).status, 401);
  const stale = await api("PUT", "/api/wholesale/account", { ...customerA, ifVersion: customerB.version, orderingIdentity: "another-account" }, B);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "account_changed");
  assert.equal((await api("GET", "/api/wholesale/session", undefined, B)).body.customer.business, customerB.business);
});

test("wholesale tracking: admin dispatch links are customer-readable and preserve immutable order and invoice details", async () => {
  const session = (await api("GET", "/api/wholesale/session", undefined, A)).body;
  trackingPayload = { requestId: crypto.randomUUID(), customerVersion: session.customer.version, lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }], delivery: "Roastery collection", reference: "TRACKING-PO", trackingUrl: "https://forged.example/checkout" };
  const created = await api("POST", "/api/wholesale/orders", trackingPayload, A);
  assert.equal(created.status, 201); trackingOrder = created.body.order;
  assert.equal(trackingOrder.trackingUrl, "", "checkout cannot set admin dispatch metadata");
  const legacy = (await api("GET", "/api/wholesale/orders/WS-00000000000000000000000000000001", undefined, A)).body.order;
  assert.equal(legacy.trackingUrl, "", "existing orders default to no tracking link");
  const settings = await api("PUT", "/api/admin/wholesale/invoice-settings", { ifVersion: 0, seller: { legalName: "TEST Tracking Supplier", address: "1 Test Street Norwich", vatNumber: "TEST123456789" }, priceBasis: "exclusive", vatRates: [{ id: "zero", label: "Explicit test zero rate", basisPoints: 0 }], defaultCoffeeRateId: "zero", deliveryRateId: "", invoicePrefix: "TRACK-", firstInvoiceNumber: 1, paymentInstructions: "TEST only", confirmed: true });
  assert.equal(settings.status, 200);
  const invoice = await api("POST", `/api/admin/wholesale/orders/${trackingOrder.id}/invoice`, { orderVersion: trackingOrder.version, settingsVersion: settings.body.version, invoiceDate: "2026-11-09", supplyDate: "2026-11-09", billTo: { name: trackingOrder.business, address: "TEST Buyer Billing Address" } });
  assert.equal(invoice.status, 201); invoiceId = invoice.body.invoice.id;
  invoiceData = srv.sql(`SELECT data FROM wholesale_invoices WHERE seq=${invoiceId}`)[0].data;
  const original = structuredClone(trackingOrder);
  const updated = await api("PATCH", `/api/admin/wholesale/orders/${trackingOrder.id}`, { ifVersion: trackingOrder.version, status: "Dispatched", customerId: trackingOrder.customerId, note: "Internal dispatch note", trackingUrl: "  HTTPS://Carrier.example:443/track?parcel=SC-123#updates  " });
  assert.equal(updated.status, 200); trackingOrder = updated.body.order;
  assert.equal(trackingOrder.status, "Dispatched"); assert.equal(trackingOrder.trackingUrl, "https://carrier.example/track?parcel=SC-123#updates");
  for (const key of ["business", "lines", "pence", "grams", "packs", "customerSnapshot", "paymentTerms", "locationSnapshot", "deliveryNotes"]) assert.deepEqual(trackingOrder[key], original[key], key);
  assert.equal(srv.sql(`SELECT data FROM wholesale_invoices WHERE seq=${invoiceId}`)[0].data, invoiceData);
  const own = (await api("GET", "/api/wholesale/orders/" + trackingOrder.id, undefined, A)).body.order;
  assert.equal(own.trackingUrl, trackingOrder.trackingUrl); assert.equal(own.note, undefined);
  const history = (await api("GET", "/api/wholesale/orders", undefined, A)).body.orders.find(order => order.id === trackingOrder.id);
  assert.equal(history.trackingUrl, trackingOrder.trackingUrl);
  const replay = await api("POST", "/api/wholesale/orders", { ...trackingPayload, trackingUrl: "https://another-forgery.example/" }, A);
  assert.equal(replay.status, 200); assert.equal(replay.body.order.id, trackingOrder.id); assert.equal(replay.body.order.trackingUrl, trackingOrder.trackingUrl, "extra checkout metadata neither changes the UUID hash nor overwrites admin tracking");
});

test("wholesale tracking: updates preserve omitted links, reject unsafe links atomically and allow explicit removal", async () => {
  const path = "/api/admin/wholesale/orders/" + trackingOrder.id;
  const payload = () => ({ ifVersion: trackingOrder.version, status: trackingOrder.status, customerId: trackingOrder.customerId, note: trackingOrder.note });
  const preserved = await api("PATCH", path, payload());
  assert.equal(preserved.status, 200); assert.equal(preserved.body.order.trackingUrl, trackingOrder.trackingUrl); trackingOrder = preserved.body.order;
  for (const value of ["javascript:alert(1)", "data:text/html,unsafe", "/relative", "//carrier.example/track", "https:carrier.example/track", "ftp://carrier.example/track", "https://user:password@carrier.example/track", "https://@carrier.example/track", "https://carrier.example/track\nunsafe", "https://carrier.example/%0aunsafe", 123, "https://carrier.example/" + "a".repeat(2000)]) {
    const invalid = await api("PATCH", path, { ...payload(), trackingUrl: value });
    assert.equal(invalid.status, 400, String(value));
  }
  const unchanged = (await api("GET", "/api/admin/wholesale/orders?q=" + trackingOrder.id)).body.orders[0];
  assert.equal(unchanged.version, trackingOrder.version); assert.equal(unchanged.trackingUrl, trackingOrder.trackingUrl);
  const http = await api("PATCH", path, { ...payload(), trackingUrl: "http://carrier.example/parcel?id=SC-123" });
  assert.equal(http.status, 200); trackingOrder = http.body.order;
  const removed = await api("PATCH", path, { ...payload(), trackingUrl: "   " });
  assert.equal(removed.status, 200); trackingOrder = removed.body.order; assert.equal(trackingOrder.trackingUrl, "");
  assert.equal((await api("GET", "/api/wholesale/orders/" + trackingOrder.id, undefined, A)).body.order.trackingUrl, "");
  assert.equal(srv.sql(`SELECT data FROM wholesale_invoices WHERE seq=${invoiceId}`)[0].data, invoiceData);
});

test("wholesale tracking: admin role, Origin, stale-version and business ownership boundaries protect tracking updates", async () => {
  const path = "/api/admin/wholesale/orders/" + trackingOrder.id;
  const payload = { ifVersion: trackingOrder.version, status: "Dispatched", customerId: trackingOrder.customerId, note: trackingOrder.note, trackingUrl: "https://carrier.example/safe" };
  assert.equal((await api("PATCH", path, payload, null)).status, 401);
  assert.equal((await api("PATCH", path, payload, A)).status, 401);
  for (const role of ["staff", "manager"]) {
    const username = "tracking." + role;
    assert.equal((await api("POST", "/api/admin/users", { name: username, username, role, password: "tracking-temporary" })).status, 200);
    const login = await api("POST", "/api/auth/change", { username, password: "tracking-temporary", newPassword: username + "-password" }, null);
    assert.equal(login.status, 200); assert.equal((await api("PATCH", path, payload, login.cookie)).status, 403);
  }
  assert.equal((await api("PATCH", path, payload, ADMIN, { origin: "https://foreign.example" })).status, 403);
  const stale = await api("PATCH", path, { ...payload, ifVersion: trackingOrder.version - 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "conflict");
  assert.equal((await api("PATCH", path, { ...payload, customerId: customerB.id })).status, 400);
  const updated = await api("PATCH", path, payload); assert.equal(updated.status, 200); trackingOrder = updated.body.order;
  assert.equal((await api("GET", "/api/wholesale/orders/" + trackingOrder.id, undefined, B)).status, 404);
  assert.equal(JSON.stringify((await api("GET", "/api/wholesale/orders", undefined, B)).body).includes("carrier.example"), false);
  assert.equal((await api("GET", "/api/wholesale/orders/" + trackingOrder.id, undefined, A)).body.order.trackingUrl, payload.trackingUrl);
});
