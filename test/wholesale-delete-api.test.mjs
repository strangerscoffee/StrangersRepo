import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, ADMIN_ID, STAFF, MANAGER, A, B, removedCustomer, removedStaff;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN, extraHeaders = {}) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
async function customer(username) {
  const credentials = { username, password: username + "-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business: username + " café", contact: "Buyer", email: username + "@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === username);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { ifVersion: account.version, username, active: true, approvalStatus: "approved" })).status, 200);
  const login = await call("POST", "/api/wholesale/auth/login", credentials, null);
  assert.equal(login.status, 200);
  const session = (await call("GET", "/api/wholesale/session", undefined, login.cookie)).body;
  return { cookie: login.cookie, ...session };
}
const payload = (reference = "DELETE-PO") => ({ requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 1800 }], delivery: "Roastery collection", business: "Staff test", reference });
async function customerOrder(reference) {
  const body = { ...payload(reference), customerVersion: A.customer.version, orderingIdentity: A.me.id };
  const response = await call("POST", "/api/wholesale/orders", body, A.cookie);
  assert.equal(response.status, 201);
  return { body, order: response.body.order };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  const setup = await call("POST", "/api/auth/setup", { name: "Wholesale Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie; ADMIN_ID = setup.body.user.id;
  for (const role of ["staff", "manager"]) {
    assert.equal((await call("POST", "/api/admin/users", { name: role, username: role, role, password: "temporary-password" })).status, 200);
    const login = await call("POST", "/api/auth/change", { username: role, password: "temporary-password", newPassword: role + "-own-password" }, null);
    assert.equal(login.status, 200);
    if (role === "staff") STAFF = login.cookie; else MANAGER = login.cookie;
  }
  A = await customer("delete.buyer"); B = await customer("other.buyer");
});
after(async () => { await srv?.stop(); });

test("wholesale deletion: only admins may remove orders; Origin and write limits apply before deletion", async () => {
  const { order } = await customerOrder("Protected order");
  const path = "/api/admin/wholesale/orders/" + order.id;
  const body = { ifVersion: order.version };
  assert.equal((await call("DELETE", path, body, null)).status, 401);
  assert.equal((await call("DELETE", path, body, A.cookie)).status, 401, "wholesale accounts are not staff/admin identities");
  for (const cookie of [STAFF, MANAGER]) assert.equal((await call("DELETE", path, body, cookie)).status, 403);
  for (const origin of ["https://foreign.example", "null"]) assert.equal((await call("DELETE", path, body, ADMIN, { origin })).status, 403);
  const window = Math.floor(Date.now() / 900000) * 900000;
  srv.sql(`INSERT INTO rate_limits(ip,window,n) VALUES('user:${ADMIN_ID}',${window},2000) ON CONFLICT(ip,window) DO UPDATE SET n=2000`);
  try {
    const limited = await call("DELETE", path, body);
    assert.equal(limited.status, 429); assert.equal(limited.body.code, "rate_limited");
  } finally { srv.sql(`UPDATE rate_limits SET n=0 WHERE ip='user:${ADMIN_ID}'`); }
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, A.cookie)).body.order.version, order.version);
});

test("wholesale deletion: versioned customer deletion hides every read, count and preparation total without changing the snapshot", async () => {
  removedCustomer = await customerOrder("Remove this customer order");
  let { order } = removedCustomer;
  const path = "/api/admin/wholesale/orders/" + order.id;
  const prepared = await call("PATCH", path, { ifVersion: order.version, status: "Preparing", customerId: order.customerId, note: "Keep this internal note in the retained record" });
  assert.equal(prepared.status, 200); order = prepared.body.order;
  const stale = await call("DELETE", path, { ifVersion: order.version - 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "conflict");
  assert.equal((await call("DELETE", path, {})).status, 400);
  const before = (await call("GET", "/api/admin/wholesale")).body;
  const ownBefore = (await call("GET", "/api/wholesale/orders", undefined, A.cookie)).body;
  const original = JSON.parse(srv.sql(`SELECT data FROM wholesale_preview WHERE kind='order' AND id='${order.id}'`)[0].data);
  const start = Date.now();
  const deleted = await call("DELETE", path, { ifVersion: order.version, deletedAt: 1, deletedBy: "Forged actor" });
  assert.equal(deleted.status, 200); assert.deepEqual(deleted.body, { deleted: true, id: order.id, version: order.version + 1 });
  const retainedRow = srv.sql(`SELECT data,version FROM wholesale_preview WHERE kind='order' AND id='${order.id}'`)[0];
  const retained = JSON.parse(retainedRow.data);
  assert.ok(retained.deletedAt >= start && retained.deletedAt <= Date.now()); assert.equal(retained.deletedBy, "Wholesale Owner");
  assert.deepEqual(retained, { ...original, deletedAt: retained.deletedAt, deletedBy: "Wholesale Owner" });
  assert.equal(retainedRow.version, order.version + 1);
  for (const cookie of [ADMIN, A.cookie, B.cookie]) assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, cookie)).status, 404);
  assert.equal((await call("PATCH", path, { ifVersion: retainedRow.version, status: "New", customerId: order.customerId, note: "" })).status, 404);
  assert.equal((await call("DELETE", path, { ifVersion: retainedRow.version })).status, 404);
  const after = (await call("GET", "/api/admin/wholesale")).body;
  assert.equal(after.orders.some((row) => row.id === order.id), false);
  assert.equal(after.counts.order || 0, before.counts.order - 1);
  assert.equal(after.stats.openOrders, before.stats.openOrders - 1);
  assert.equal(after.stats.gramsToPrepare, before.stats.gramsToPrepare - order.grams);
  const ownAfter = (await call("GET", "/api/wholesale/orders", undefined, A.cookie)).body;
  assert.equal(ownAfter.orders.some((row) => row.id === order.id), false); assert.equal(ownAfter.count, ownBefore.count - 1);
  const search = (await call("GET", "/api/admin/wholesale/orders?q=" + order.id)).body;
  assert.equal(search.orders.length, 0); assert.equal(search.count, 0); assert.equal(search.nextCursor, null);
  const preparing = (await call("GET", "/api/admin/wholesale/orders?status=Preparing")).body;
  assert.equal(preparing.orders.some((row) => row.id === order.id), false);
});

test("wholesale deletion: a removed UUID cannot be recreated by retries, including stale quotes and other owners", async () => {
  const { body, order } = removedCustomer;
  const before = (await call("GET", "/api/admin/wholesale")).body.counts.order || 0;
  const exact = await call("POST", "/api/wholesale/orders", body, A.cookie);
  assert.equal(exact.status, 410); assert.equal(exact.body.code, "order_deleted");
  const changed = await call("POST", "/api/wholesale/orders", { ...body, reference: "Changed payload" }, A.cookie);
  assert.equal(changed.status, 409); assert.equal(changed.body.code, "conflict");
  const other = await call("POST", "/api/wholesale/orders", { ...body, orderingIdentity: B.me.id, customerVersion: B.customer.version }, B.cookie);
  assert.equal(other.status, 409); assert.equal(other.body.code, "conflict");
  const coffee = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.id === "brazil");
  assert.equal((await call("PUT", "/api/admin/wholesale/catalogue/brazil", { ifVersion: coffee.version, prices: { ...coffee.prices, kilo: 3900 }, active: false, inStock: false })).status, 200);
  const stale = await call("POST", "/api/wholesale/orders", body, A.cookie);
  assert.equal(stale.status, 410); assert.equal(stale.body.code, "order_deleted", "deletion precedes current catalogue validation");
  const restore = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.id === "brazil");
  await call("PUT", "/api/admin/wholesale/catalogue/brazil", { ifVersion: restore.version, prices: coffee.prices, active: true, inStock: true });
  assert.equal((await call("GET", "/api/admin/wholesale")).body.counts.order || 0, before);
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE kind='order' AND id='${order.id}'`)[0].n, 1);
});

test("wholesale deletion: staff test orders can also be removed without entering customer histories or prep totals", async () => {
  const body = payload("Remove staff test");
  const before = (await call("GET", "/api/admin/wholesale")).body;
  const created = await call("POST", "/api/wholesale/orders", body, STAFF);
  assert.equal(created.status, 201); const order = created.body.order; removedStaff = { body, order };
  const withPreview = (await call("GET", "/api/admin/wholesale")).body;
  assert.equal(withPreview.stats.openOrders, before.stats.openOrders); assert.equal(withPreview.stats.gramsToPrepare, before.stats.gramsToPrepare);
  const deleted = await call("DELETE", "/api/admin/wholesale/orders/" + order.id, { ifVersion: order.version });
  assert.equal(deleted.status, 200);
  const history = (await call("GET", "/api/wholesale/orders", undefined, STAFF)).body;
  assert.equal(history.count, 0); assert.deepEqual(history.orders, []);
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, STAFF)).status, 404);
  assert.equal((await call("POST", "/api/wholesale/orders", body, STAFF)).status, 410);
  assert.equal((await call("POST", "/api/wholesale/orders", body, MANAGER)).status, 409);
  const after = (await call("GET", "/api/admin/wholesale")).body;
  assert.equal(after.counts.order || 0, before.counts.order || 0); assert.equal(after.stats.gramsToPrepare, before.stats.gramsToPrepare);
});

test("wholesale deletion: removed records and original snapshots stay in backups and successful removals are audited once", async () => {
  const made = await call("POST", "/api/admin/backups", {});
  assert.equal(made.status, 200);
  const backup = (await call("GET", "/api/admin/backups/" + made.body.backup.id)).body;
  for (const { order } of [removedCustomer, removedStaff]) {
    const retained = backup.wholesalePreview.find((row) => row.kind === "order" && row.id === order.id);
    assert.ok(retained); const data = JSON.parse(retained.data);
    assert.equal(data.deletedBy, "Wholesale Owner"); assert.ok(data.deletedAt); assert.equal(data.pence, order.pence); assert.deepEqual(data.lines, order.lines);
    const audit = srv.sql(`SELECT actor,text FROM audit_log WHERE kind='wholesale_order_deleted' AND text LIKE '%${order.id}%'`);
    assert.equal(audit.length, 1); assert.equal(audit[0].actor, "Wholesale Owner"); assert.match(audit[0].text, /removed wholesale/);
  }
});
