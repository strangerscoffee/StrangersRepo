// Admin's per-business "Hide prices" (Strangers' own shops): the ordering page shows no money; orders keep prices.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, customerId;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, body: data, cookie: cookieOf(response), text };
}
const session = async () => (await call("GET", "/api/wholesale/session", undefined, A)).body;
const customerRow = async () => (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === customerId);
const line = (pack, quantity, productId = "brazil") => ({ productId, pack, grind: "beans", quantity, price: pack === "kilo" ? 1800 : 500 });
async function order(lines, cookie = A) {
  const current = cookie === A ? await session() : null;
  const body = { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", ...(current ? { customerVersion: current.customer.version } : {}) };
  return { body, result: await call("POST", "/api/wholesale/orders", body, cookie) };
}
async function setHidden(value) {
  const row = await customerRow();
  const { id, version, updatedAt, ...fields } = row;
  const saved = await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, ...(value === undefined ? {} : { hidePrices: value }), ifVersion: version });
  assert.equal(saved.status, 200, saved.text); return saved.body.customer;
}

before(async () => {
  srv = await startServer({ writeLimit: 2000, });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "shop.buyer", password: "shop-buyer-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Strangers Shop", contact: "Buyer", email: "buyer@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  customerId = account.customerId;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("Admin hides prices from one business: the page is told showPrices:false, nothing else changes", async () => {
  assert.equal((await session()).showPrices, true, "prices shown by default");
  const saved = await setHidden(true);
  assert.equal(saved.hidePrices, true);
  const current = await session();
  assert.equal(current.showPrices, false);
  assert.equal(Object.hasOwn(current.customer, "hidePrices"), false, "the setting itself stays admin-only");
  const catalogue = (await call("GET", "/api/wholesale/catalogue", undefined, A)).body;
  assert.equal(catalogue.showPrices, false);
  assert.ok(catalogue.products.length > 0);
  // Orders still record prices (Admin, invoices): hiding is a display choice only.
  const placed = await order([line("kilo", 6)]);
  assert.equal(placed.result.status, 201, placed.result.text);
  assert.equal(placed.result.body.order.lines[0].price, 1800);
  assert.equal(Object.hasOwn(placed.result.body.order.customerSnapshot || {}, "hidePrices"), false);
  assert.equal((await setHidden(undefined)).hidePrices, true, "an admin save without the field keeps it");
  const profile = await call("PUT", "/api/wholesale/account", { ifVersion: (await session()).customer.version, contact: "Shop Manager", hidePrices: false }, A);
  assert.equal(profile.status, 200, profile.text);
  assert.equal((await customerRow()).hidePrices, true, "the customer's own profile save keeps it and can't change it");
  assert.equal((await setHidden(false)).hidePrices, undefined);
  assert.equal((await session()).showPrices, true);
  const row = await customerRow(); const { id, version, updatedAt, ...fields } = row;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, hidePrices: "yes", ifVersion: version })).status, 400);
});

test("staff previews always show prices", async () => {
  assert.equal((await call("GET", "/api/wholesale/session")).body.showPrices, true);
});
