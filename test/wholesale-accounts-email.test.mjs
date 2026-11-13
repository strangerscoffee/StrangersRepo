// A separate accounts email (for invoices) on a wholesale business: given when applying, edited by Admin and by the
// business in My account, kept when a save leaves it out, and shown to staff with order access.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const customers = async () => (await call("GET", "/api/admin/wholesale")).body.customers;
before(async () => {
  srv = await startServer({ writeLimit: 1000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("applying for an account can give a separate accounts email", async () => {
  const base = { username: "lune.orders", password: "lune-password", business: "Lune House", contact: "Sam", email: "orders@lune.example" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...base, accountsEmail: "not an email" }, null)).status, 400);
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...base, accountsEmail: "accounts@lune.example" }, null)).status, 201);
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...base, username: "same.email", business: "Same Email Cafe", accountsEmail: "ORDERS@other.example".toLowerCase().replace("other", "same"), email: "orders@same.example" }, null)).status, 201);
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...base, username: "no.accounts", business: "Plain Cafe", email: "hello@plain.example" }, null)).status, 201);
  const rows = await customers();
  assert.equal(rows.find((c) => c.business === "Lune House").accountsEmail, "accounts@lune.example");
  assert.equal(rows.find((c) => c.business === "Same Email Cafe").accountsEmail ?? "", "", "the same address as the order email isn't kept twice");
  assert.equal(rows.find((c) => c.business === "Plain Cafe").accountsEmail ?? "", "");
});

test("Admin sets, keeps and clears it; the business edits it in My account; staff see it", async () => {
  let lune = (await customers()).find((c) => c.business === "Lune House");
  const fields = { business: lune.business, contact: lune.contact, email: lune.email, status: "Active", note: "" };
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${lune.id}`, { ...fields, accountsEmail: "nope", ifVersion: lune.version })).status, 400);
  const kept = await call("PUT", `/api/admin/wholesale/customers/${lune.id}`, { ...fields, ifVersion: lune.version });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(kept.body.customer.accountsEmail, "accounts@lune.example", "a save without it keeps it");
  const changed = await call("PUT", `/api/admin/wholesale/customers/${lune.id}`, { ...fields, accountsEmail: "finance@lune.example", ifVersion: kept.body.customer.version });
  assert.equal(changed.body.customer.accountsEmail, "finance@lune.example");
  lune = changed.body.customer;
  // Approve and sign in as the business.
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((a) => a.customerId === lune.id);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${lune.id}/account`, { username: account.username, ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
  const cookie = (await call("POST", "/api/wholesale/auth/login", { username: "lune.orders", password: "lune-password" }, null)).cookie;
  const session = (await call("GET", "/api/wholesale/session", undefined, cookie)).body;
  assert.equal(session.customer.accountsEmail, "finance@lune.example");
  const own = await call("PUT", "/api/wholesale/account", { ifVersion: session.customer.version, contact: "Sam", email: "orders@lune.example", accountsEmail: "bills@lune.example" }, cookie);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.customer.accountsEmail, "bills@lune.example");
  const left = await call("PUT", "/api/wholesale/account", { ifVersion: own.body.customer.version, contact: "Sam Jones" }, cookie);
  assert.equal(left.body.customer.accountsEmail, "bills@lune.example", "a save without it keeps it");
  const staff = (await call("GET", "/api/staff-orders/customers")).body.customers.find((c) => c.id === lune.id);
  assert.equal(staff.accountsEmail, "bills@lune.example");
  const cleared = await call("PUT", "/api/wholesale/account", { ifVersion: left.body.customer.version, accountsEmail: "" }, cookie);
  assert.equal(cleared.body.customer.accountsEmail, "");
  assert.equal(Object.hasOwn((await customers()).find((c) => c.id === lune.id), "accountsEmail"), false);
});
