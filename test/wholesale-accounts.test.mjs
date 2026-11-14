import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, accountA, customerA, customerB;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN, headers = {}) {
  const response = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, body: data, cookie: cookieOf(response), headers: response.headers, text };
}
const registration = (username) => ({ username, password: username + "-password", business: username + " café", contact: username + " buyer", email: username + "@example.com", phone: "01603 123456" });
async function approve(username) {
  const dashboard = (await call("GET", "/api/admin/wholesale")).body;
  const account = dashboard.accounts.find((row) => row.username === username);
  assert.ok(account);
  const result = await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  assert.equal(result.status, 200, result.text);
  return result.body.account;
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("wholesale registration: pending accounts cannot access until an admin approves; approval is versioned", async () => {
  for (const username of ["buyer.a", "buyer.b"]) {
    const body = registration(username);
    const result = await call("POST", "/api/wholesale/auth/register", { ...body, active: true, approvalStatus: "approved", role: "admin" }, null);
    assert.equal(result.status, 201, result.text); assert.equal(result.body.approvalStatus, "pending"); assert.equal(result.cookie, "");
    const login = await call("POST", "/api/wholesale/auth/login", body, null);
    assert.equal(login.status, 403); assert.equal(login.body.code, "approval_pending"); assert.equal(login.cookie, "");
    assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, null)).status, 401);
  }
  const before = (await call("GET", "/api/admin/wholesale")).body;
  accountA = await approve("buyer.a"); await approve("buyer.b");
  const stale = before.accounts.find((row) => row.username === "buyer.a");
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${accountA.customerId}/account`, { username: "buyer.a", ifVersion: stale.version, active: false })).status, 409);
  A = (await call("POST", "/api/wholesale/auth/login", registration("buyer.a"), null)).cookie;
  B = (await call("POST", "/api/wholesale/auth/login", registration("buyer.b"), null)).cookie;
  assert.ok(A.startsWith("sf_wholesale_session=")); assert.ok(B);
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  customerA = session.customer; customerB = (await call("GET", "/api/wholesale/session", undefined, B)).body.customer;
  assert.equal(customerA.status, "Active"); assert.equal(session.me.role, "wholesale");
  assert.equal(customerA.paymentTerms.id, "to-agree");
  assert.equal(session.links.admin, undefined); assert.equal(customerA.note, undefined);
  assert.equal(JSON.stringify(before).includes("password_hash"), false);
});

test("wholesale accounts: host-only cookies never grant staff, diary or admin access; foreign writes are refused", async () => {
  const photo = await call("GET", "/wholesale/images/brazil.webp", undefined, A);
  assert.equal(photo.status, 200); assert.match(photo.headers.get("content-type"), /^image\//);
  for (const path of ["/api/admin/wholesale", "/api/admin/users", "/api/db/get", "/api/rota/week", "/api/live"]) assert.equal((await call("GET", path, undefined, A)).status, 401, path);
  const response = await call("POST", "/api/wholesale/auth/login", registration("buyer.a"), null);
  const header = response.headers.getSetCookie().find((value) => value.startsWith("sf_wholesale_session="));
  assert.match(header, /HttpOnly/); assert.match(header, /Secure/); assert.match(header, /SameSite=Lax/); assert.doesNotMatch(header, /Domain=/i);
  assert.equal((await call("PUT", "/api/wholesale/account", {}, A, { origin: "https://foreign.example" })).body.code, "bad_origin");
  const forged = A.replace(/.$/, A.endsWith("a") ? "b" : "a");
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, forged)).status, 401);
});

let order;
test("wholesale ordering: customer identity and delivery snapshots are server-owned, orders are private and retries safe", async () => {
  const body = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 1800 }], delivery: "Delivery", business: "Forged business", customerId: customerB.id, reference: "PO 123" };
  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).status, 400, "delivery needs an address");
  customerA = (await call("PUT", "/api/wholesale/account", { ...customerA, locations: undefined, ifVersion: customerA.version, address: "10 Coffee Street\nNorwich", postcode: "NR1 1AA", deliveryNotes: "Side door", note: "cannot write private notes", status: "On hold" }, A)).body.customer;
  body.customerVersion = customerA.version;
  assert.equal(customerA.status, "Active"); assert.equal(customerA.note, undefined);
  const created = await call("POST", "/api/wholesale/orders", body, A);
  assert.equal(created.status, 201, created.text); order = created.body.order;
  assert.match(order.id, /^WS-/); assert.equal(created.body.preview, false); assert.equal(order.customerId, customerA.id); assert.equal(order.business, "buyer.a café"); assert.equal(order.customerSnapshot.postcode, "NR1 1AA"); assert.equal(order.pence, 3600);
  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).body.order.id, order.id);
  assert.equal((await call("GET", `/api/wholesale/orders/${order.id}`, undefined, B)).status, 404);
  assert.deepEqual((await call("GET", "/api/wholesale/orders", undefined, B)).body.orders, []);
  const update = await call("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, status: "Preparing", customerId: customerA.id, note: "Private credit check" });
  assert.equal(update.status, 200, update.text);
  const own = (await call("GET", "/api/wholesale/orders", undefined, A)).body.orders[0];
  assert.equal(own.status, "Preparing"); assert.equal(own.note, undefined); assert.equal(own.requestKey, undefined);
  assert.equal((await call("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: update.body.order.version, status: "Ready", customerId: customerB.id, note: "" })).status, 400);
  const changed = await call("PUT", "/api/wholesale/account", { ...customerA, locations: undefined, ifVersion: customerA.version, address: "Another address" }, A);
  assert.equal(changed.status, 200); customerA = changed.body.customer;
  assert.equal((await call("GET", `/api/wholesale/orders/${order.id}`, undefined, A)).body.order.customerSnapshot.address, "10 Coffee Street\nNorwich");
  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).body.order.id, order.id, "a retry retains the original snapshot after a profile edit");
});

test("wholesale order comments: optional, kept with the order, shown to its business and admins, and part of the retry check", async () => {
  const base = { lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 3, price: 500 }], delivery: "Roastery collection", reference: "", customerVersion: customerA.version };
  const withNote = { ...base, requestId: crypto.randomUUID(), customerNote: "  Use our own custom labels\nThanks  " };
  const created = await call("POST", "/api/wholesale/orders", withNote, A);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.order.customerNote, "Use our own custom labels\nThanks");
  assert.equal((await call("GET", `/api/wholesale/orders/${created.body.order.id}`, undefined, A)).body.order.customerNote, "Use our own custom labels\nThanks");
  assert.equal((await call("GET", `/api/wholesale/orders/${created.body.order.id}`, undefined, B)).status, 404);
  assert.equal((await call("POST", "/api/wholesale/orders", withNote, A)).status, 200, "an identical retry returns the order");
  assert.equal((await call("POST", "/api/wholesale/orders", { ...withNote, customerNote: "Different" }, A)).status, 409, "changed comments are a different order");
  const updated = await call("PATCH", `/api/admin/wholesale/orders/${created.body.order.id}`, { ifVersion: created.body.order.version, status: "Preparing", customerId: customerA.id, note: "Internal only" });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.body.order.customerNote, "Use our own custom labels\nThanks", "admin updates keep the customer's comments");
  const own = (await call("GET", "/api/wholesale/orders", undefined, A)).body.orders.find((row) => row.id === created.body.order.id);
  assert.equal(own.customerNote, "Use our own custom labels\nThanks"); assert.equal(own.note, undefined);
  const plain = { ...base, requestId: crypto.randomUUID() };
  const first = await call("POST", "/api/wholesale/orders", plain, A);
  assert.equal(first.status, 201, first.text); assert.equal(Object.hasOwn(first.body.order, "customerNote"), false);
  assert.equal((await call("POST", "/api/wholesale/orders", { ...plain, customerNote: "   " }, A)).status, 200, "blank comments match a request without them");
  assert.equal((await call("POST", "/api/wholesale/orders", { ...base, requestId: crypto.randomUUID(), customerNote: "x".repeat(1001) }, A)).status, 400);
  assert.equal((await call("POST", "/api/wholesale/orders", { ...base, requestId: crypto.randomUUID(), customerNote: 12 }, A)).status, 400);
});

test("wholesale account holds prevent new orders; reset, disabling and logout revoke existing sessions", async () => {
  const current = (await call("GET", "/api/admin/wholesale")).body;
  let customer = current.customers.find((row) => row.id === customerA.id);
  const held = await call("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...customer, ifVersion: customer.version, status: "On hold" });
  assert.equal(held.status, 200);
  const payload = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }], delivery: "Roastery collection" };
  assert.equal((await call("POST", "/api/wholesale/orders", payload, A)).body.code, "account_on_hold");
  assert.equal((await call("GET", "/api/wholesale/orders", undefined, A)).status, 200);
  let account = current.accounts.find((row) => row.customerId === customer.id);
  const reset = await call("POST", `/api/admin/wholesale/customers/${customer.id}/account/reset-password`, { ifVersion: account.version });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, A)).status, 401);
  const temporary = { username: account.username, password: reset.body.temporaryPassword };
  assert.equal((await call("POST", "/api/wholesale/auth/login", temporary, null)).body.code, "password_change_required");
  const changed = await call("POST", "/api/wholesale/auth/change-password", { ...temporary, newPassword: "a-new-wholesale-password" }, null);
  assert.equal(changed.status, 200, changed.text); A = changed.cookie;
  assert.equal((await call("POST", "/api/wholesale/auth/logout", {}, A)).status, 200);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, A)).status, 401);
  B = (await call("POST", "/api/wholesale/auth/login", registration("buyer.b"), null)).cookie;
  account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.customerId === customerB.id);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customerB.id}/account`, { username: account.username, ifVersion: account.version, active: false })).status, 200);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, B)).status, 401);
});

test("wholesale registration and credentials: duplicate sign-up is atomic, lockout is enforced, expiry is checked", async () => {
  const before = (await call("GET", "/api/admin/wholesale")).body.counts.customer;
  assert.equal((await call("POST", "/api/wholesale/auth/register", registration("buyer.a"), null)).status, 409);
  assert.equal((await call("GET", "/api/admin/wholesale")).body.counts.customer, before, "duplicate username rolls back the customer insert");
  const customer = (await call("POST", "/api/admin/wholesale/customers", { business: "Manual account", contact: "Buyer", email: "buyer@example.com", status: "Active", note: "Private" })).body.customer;
  const created = await call("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username: "locked.buyer" });
  assert.equal(created.status, 201); assert.equal(created.body.account.approvalStatus, "approved");
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/wholesale/auth/login", { username: "locked.buyer", password: "wrong-password" }, null)).status, 401);
  assert.equal((await call("POST", "/api/wholesale/auth/login", { username: "locked.buyer", password: created.body.temporaryPassword }, null)).status, 423);
  const reset = await call("POST", `/api/admin/wholesale/customers/${customer.id}/account/reset-password`, { ifVersion: created.body.account.version });
  assert.equal(reset.status, 200);
  assert.equal((await call("POST", "/api/wholesale/auth/login", { username: "locked.buyer", password: reset.body.temporaryPassword }, null)).body.code, "password_change_required");
  const signedIn = await call("POST", "/api/wholesale/auth/login", { username: "buyer.a", password: "a-new-wholesale-password" }, null);
  assert.equal(signedIn.status, 200);
  srv.sql("UPDATE wholesale_sessions SET expires_at = 0");
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, signedIn.cookie)).status, 401);
});

test("wholesale backups include approval metadata without passwords, salts or sessions", async () => {
  const made = await call("POST", "/api/admin/backups", {});
  assert.equal(made.status, 200, made.text);
  const backup = (await call("GET", "/api/admin/backups/" + made.body.backup.id)).body;
  assert.ok(backup.wholesaleAccounts.length >= 3);
  for (const account of backup.wholesaleAccounts) {
    assert.ok(["pending", "approved", "rejected"].includes(account.approval_status));
    for (const field of ["password_hash", "password_salt", "session_ver", "hash"]) assert.equal(account[field], undefined);
  }
  assert.equal(backup.wholesaleSessions, undefined);
});
