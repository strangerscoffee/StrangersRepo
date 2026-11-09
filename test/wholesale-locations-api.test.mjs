import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF, A, B, selectedOrder, selectedPayload, legacyOrder, legacyPayload, foreignLocation;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
async function register(username) {
  const credentials = { username, password: username + "-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business: username + " business", contact: username + " buyer", email: username + "@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === username);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { ifVersion: account.version, username, active: true, approvalStatus: "approved" })).status, 200);
  const login = await call("POST", "/api/wholesale/auth/login", credentials, null);
  assert.equal(login.status, 200);
  return { cookie: login.cookie, ...(await call("GET", "/api/wholesale/session", undefined, login.cookie)).body };
}
async function refresh(account = A) { Object.assign(account, (await call("GET", "/api/wholesale/session", undefined, account.cookie)).body); return account.customer; }
async function profile(fields, account = A) {
  const response = await call("PUT", "/api/wholesale/account", { ifVersion: account.customer.version, orderingIdentity: account.me.id, ...fields }, account.cookie);
  if (response.status === 200) account.customer = response.body.customer;
  return response;
}
async function adminEdit(fields, account = A) {
  const current = (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === account.customer.id);
  const response = await call("PUT", "/api/admin/wholesale/customers/" + current.id, { ...current, ifVersion: current.version, ...fields });
  if (response.status === 200) await refresh(account);
  return response;
}
const orderPayload = (fields = {}) => ({ requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 3700 }], delivery: "Delivery", reference: "LOCATIONS-PO", business: "Forged checkout business", customerVersion: A.customer.version, ...fields });
const extra = (name = "Riverside café") => ({ name, contact: "Riverside manager", phone: "01603 333333", address: "2 River Street\nNorwich", postcode: "NR2 2AA", deliveryNotes: "Use the riverside entrance" });
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  const setup = await call("POST", "/api/auth/setup", { name: "Locations Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie;
  assert.equal((await call("POST", "/api/admin/users", { name: "Staff", username: "staff", role: "staff", password: "temporary-password" })).status, 200);
  STAFF = (await call("POST", "/api/auth/change", { username: "staff", password: "temporary-password", newPassword: "staff-own-password" }, null)).cookie;
  A = await register("locations.a"); B = await register("locations.b");
});
after(async () => { await srv?.stop(); });

test("wholesale locations: legacy primary is stable, customer business names are admin-controlled and legacy profile writes stay compatible", async () => {
  const raw = JSON.parse(srv.sql(`SELECT data FROM wholesale_preview WHERE kind='customer' AND id='${A.customer.id}'`)[0].data);
  assert.equal(raw.locations, undefined, "legacy records need no migration");
  assert.deepEqual(A.customer.locations, [{ id: "primary", name: "Main location", contact: "locations.a buyer", phone: "", address: "", postcode: "", deliveryNotes: "" }]);
  assert.equal(A.customer.defaultLocationId, "primary");
  const denied = await profile({ business: "A different legal business" });
  assert.equal(denied.status, 403); assert.equal(denied.body.code, "permission_denied");
  assert.match(denied.body.message, /admins can change the registered business name/);
  assert.equal((await profile({ phone: "01603 111111" })).status, 200, "business may be omitted");
  const updated = await profile({ business: A.customer.business, contact: "Main manager", address: "1 Main Street\nNorwich", postcode: "NR1 1AA", deliveryNotes: "Main entrance", paymentTerms: "net-60", status: "On hold" });
  assert.equal(updated.status, 200); assert.equal(A.customer.status, "Active"); assert.equal(A.customer.paymentTerms.id, "to-agree");
  assert.equal(A.customer.locations[0].address, A.customer.address); assert.equal(A.customer.locations[0].id, "primary");
  const renamed = await adminEdit({ business: "Approved Coffee Group" });
  assert.equal(renamed.status, 200); assert.equal(A.customer.business, "Approved Coffee Group");
  const admin = (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === A.customer.id);
  assert.equal(admin.locations[0].id, "primary"); assert.equal(admin.defaultLocationId, "primary");
});

test("wholesale locations: customer/admin edits share CAS, generated owned IDs, defaults and primary legacy-field mirroring", async () => {
  assert.equal((await profile({ locations: [A.customer.locations[0], extra()] })).status, 200);
  const location = A.customer.locations[1];
  assert.match(location.id, /^[a-f0-9-]{36}$/i); assert.equal(location.name, "Riverside café");
  assert.equal(A.customer.address, "1 Main Street\nNorwich");
  assert.equal((await profile({ defaultLocationId: location.id })).status, 200); assert.equal(A.customer.defaultLocationId, location.id);
  assert.equal((await profile({ business: A.customer.business, address: "3 Updated Main Street" })).status, 200);
  assert.equal(A.customer.locations[0].address, "3 Updated Main Street"); assert.equal(A.customer.locations[1].id, location.id); assert.equal(A.customer.defaultLocationId, location.id);
  const before = A.customer;
  const locations = A.customer.locations.map((row) => row.id === "primary" ? { ...row, name: "Head office" } : { ...row, phone: "01603 444444" });
  assert.equal((await adminEdit({ locations, paymentTerms: "net-14", paymentNote: "Quote invoice number" })).status, 200);
  assert.equal(A.customer.locations[0].name, "Head office"); assert.equal(A.customer.locations[1].phone, "01603 444444"); assert.equal(A.customer.paymentTerms.id, "net-14");
  assert.equal((await call("PUT", "/api/wholesale/account", { ifVersion: before.version, locations: [] }, A.cookie)).status, 409, "stale versions are rejected before invalid removed-location edits");
  assert.equal((await profile({ locations: [B.customer.locations[0], extra("Other business branch")] }, B)).status, 200);
  foreignLocation = B.customer.locations[1];
  assert.equal((await profile({ defaultLocationId: foreignLocation.id })).status, 400);
  assert.equal((await profile({ locations: [A.customer.locations[0], foreignLocation] })).status, 400);
  assert.equal((await call("PUT", "/api/admin/wholesale/customers/" + A.customer.id, { business: A.customer.business, status: "Active", ifVersion: A.customer.version, locations: [A.customer.locations[0], foreignLocation] })).status, 400);
  assert.equal((await call("PUT", "/api/admin/wholesale/customers/" + A.customer.id, {}, STAFF)).status, 403);
  assert.equal((await call("PUT", "/api/wholesale/account", {}, null)).status, 401);
});

test("wholesale locations: checkout owns business identity, snapshots only the selected location and preserves legacy request hashes", async () => {
  legacyPayload = orderPayload();
  const legacy = await call("POST", "/api/wholesale/orders", legacyPayload, A.cookie);
  assert.equal(legacy.status, 201); legacyOrder = legacy.body.order;
  assert.equal(legacyOrder.locationId, "primary", "omitted location keeps the legacy primary even when another default is selected");
  const originalRequest = { id: legacyOrder.id, lines: legacyPayload.lines, delivery: legacyPayload.delivery, reference: legacyPayload.reference, business: A.customer.id };
  const expectedHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(originalRequest))))].map((value) => value.toString(16).padStart(2, "0")).join("");
  const raw = srv.sql(`SELECT data FROM wholesale_preview WHERE kind='order' AND id='${legacyOrder.id}'`)[0];
  assert.equal(JSON.parse(raw.data).requestKey, expectedHash, "omitted locationId leaves the old idempotency digest unchanged");
  const selected = A.customer.locations[1];
  selectedPayload = orderPayload({ locationId: selected.id });
  const created = await call("POST", "/api/wholesale/orders", selectedPayload, A.cookie);
  assert.equal(created.status, 201); selectedOrder = created.body.order;
  assert.equal(selectedOrder.business, A.customer.business); assert.equal(selectedOrder.business, "Approved Coffee Group");
  assert.deepEqual(selectedOrder.locationSnapshot, selected);
  assert.equal(selectedOrder.customerSnapshot.address, selected.address); assert.equal(selectedOrder.customerSnapshot.contact, selected.contact); assert.equal(selectedOrder.customerSnapshot.phone, selected.phone);
  assert.equal(selectedOrder.customerSnapshot.email, A.customer.email); assert.equal(selectedOrder.deliveryNotes, selected.deliveryNotes);
  assert.equal(selectedOrder.customerSnapshot.locations, undefined); assert.equal(selectedOrder.customerSnapshot.defaultLocationId, undefined);
  assert.equal(JSON.stringify(selectedOrder).includes(A.customer.locations[0].address), false, "unselected private addresses are not copied into the order");
  assert.equal(selectedOrder.paymentTerms.id, "net-14");
  const collectionPayload = orderPayload({ delivery: "Roastery collection", locationId: selected.id });
  const collection = await call("POST", "/api/wholesale/orders", collectionPayload, A.cookie);
  assert.equal(collection.status, 201); assert.equal(collection.body.order.locationId, selected.id);
  assert.equal((await call("POST", "/api/wholesale/orders", { ...collectionPayload, locationId: "primary" }, A.cookie)).status, 409, "even collection retries cannot switch selected locations");
  const staff = await call("POST", "/api/wholesale/orders", { ...orderPayload({ delivery: "Roastery collection", locationId: "primary" }), customerVersion: undefined }, STAFF);
  assert.equal(staff.status, 400, "staff test identities do not own customer saved locations");
  const legacyWithoutLocation = JSON.parse(raw.data); delete legacyWithoutLocation.locationId; delete legacyWithoutLocation.locationSnapshot;
  srv.sql(`UPDATE wholesale_preview SET data='${JSON.stringify(legacyWithoutLocation).replaceAll("'", "''")}' WHERE kind='order' AND id='${legacyOrder.id}'`);
  const historicalRetry = await call("POST", "/api/wholesale/orders", legacyPayload, A.cookie);
  assert.equal(historicalRetry.status, 200); assert.equal(historicalRetry.body.order.locationSnapshot, undefined, "pre-location saved orders are not rewritten on retry");
});

test("wholesale locations: removed/foreign locations and changed review data cannot create new orders; original retries keep frozen snapshots", async () => {
  const oldVersion = A.customer.version, removedId = A.customer.locations[1].id;
  assert.equal((await adminEdit({ locations: [A.customer.locations[0]], defaultLocationId: undefined, business: "Renamed by admin", paymentTerms: "net-30", paymentNote: "New invoice terms" })).status, 200);
  assert.equal(A.customer.defaultLocationId, "primary", "removing an omitted default selection safely falls back to primary");
  const stale = await call("POST", "/api/wholesale/orders", orderPayload({ locationId: removedId, customerVersion: oldVersion }), A.cookie);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "account_changed");
  for (const locationId of [removedId, foreignLocation.id, crypto.randomUUID(), "invalid-location"]) assert.equal((await call("POST", "/api/wholesale/orders", orderPayload({ locationId }), A.cookie)).status, 400);
  const retried = await call("POST", "/api/wholesale/orders", selectedPayload, A.cookie);
  assert.equal(retried.status, 200); assert.deepEqual(retried.body.order, selectedOrder);
  assert.equal(retried.body.order.business, "Approved Coffee Group"); assert.equal(retried.body.order.paymentTerms.id, "net-14");
  const legacyRetry = await call("POST", "/api/wholesale/orders", legacyPayload, A.cookie);
  assert.equal(legacyRetry.status, 200); assert.equal(legacyRetry.body.order.locationSnapshot, undefined);
  const foreignRetry = await call("POST", "/api/wholesale/orders", { ...selectedPayload, customerVersion: B.customer.version }, B.cookie);
  assert.equal(foreignRetry.status, 409);
  assert.equal((await adminEdit({ status: "On hold" })).status, 200);
  const held = await call("POST", "/api/wholesale/orders", orderPayload({ locationId: "primary" }), A.cookie);
  assert.equal(held.status, 403); assert.equal(held.body.code, "account_on_hold");
  assert.equal((await call("POST", "/api/wholesale/orders", selectedPayload, A.cookie)).status, 200);
  assert.equal((await adminEdit({ status: "Active" })).status, 200);
});

test("wholesale locations: 20-location address books fit existing JSON storage and validate IDs, required primary, names and defaults", async () => {
  const primary = A.customer.locations[0];
  const locations = [primary, ...Array.from({ length: 19 }, (_, i) => ({ ...extra("Branch " + i), deliveryNotes: "a".repeat(1000) }))];
  const body = { ifVersion: A.customer.version, locations };
  assert.ok(JSON.stringify(body).length > 8192, "real address books exceed the old profile request limit");
  assert.equal((await profile({ locations })).status, 200); assert.equal(A.customer.locations.length, 20);
  assert.equal(new Set(A.customer.locations.map((row) => row.id)).size, 20);
  const before = A.customer;
  for (const invalidLocations of [null, [], [primary, primary], [extra()], [...before.locations, extra("Too many")], [primary, { ...extra(), id: crypto.randomUUID() }], [primary, { ...extra(), name: "x".repeat(81) }]]) {
    assert.equal((await profile({ locations: invalidLocations })).status, 400);
  }
  assert.equal((await profile({ defaultLocationId: null })).status, 400);
  assert.equal((await profile({ defaultLocationId: foreignLocation.id })).status, 400);
  assert.equal((await refresh()).version, before.version, "invalid edits leave the whole address book unchanged");
  assert.equal((await profile({ locations: [{ ...primary, name: "Renamed main" }], defaultLocationId: "primary" })).status, 200);
  assert.equal(A.customer.locations.length, 1); assert.equal(A.customer.locations[0].id, "primary"); assert.equal(A.customer.locations[0].name, "Renamed main");
});
