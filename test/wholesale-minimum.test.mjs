// The 6 kg minimum wholesale order (any mix of coffees and 250 g / 1 kg bags), and Admin's per-business "No minimum
// order" exemption, which customers never see. Runs with the real minimum (the harness turns it off elsewhere).
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
async function setExempt(value) {
  const row = await customerRow();
  const { id, version, updatedAt, ...fields } = row;
  const saved = await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, ...(value === undefined ? {} : { noMinimumOrder: value }), ifVersion: version });
  assert.equal(saved.status, 200, saved.text); return saved.body.customer;
}

before(async () => {
  srv = await startServer({ writeLimit: 2000, vars: { WHOLESALE_MINIMUM_ORDER_GRAMS: "" } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "minimum.buyer", password: "minimum-buyer-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Minimum Café", contact: "Buyer", email: "buyer@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  customerId = account.customerId;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("orders under 6 kg are refused; 6 kg of any mix of coffees and bag sizes is accepted", async () => {
  assert.equal((await session()).minimumOrderGrams, 6000);
  assert.equal((await call("GET", "/api/admin/wholesale")).body.minimumOrderGrams, 6000);
  const short = (await order([line("kilo", 5), line("quarter", 3, "campo")])).result;
  assert.equal(short.status, 409, short.text); assert.equal(short.body.code, "below_minimum");
  assert.match(short.body.message, /minimum order is 6 kg.*Add 0\.25 kg more/);
  const enough = (await order([line("kilo", 4), line("quarter", 4, "campo"), line("quarter", 4, "house")])).result;
  assert.equal(enough.status, 201, enough.text); assert.equal(enough.body.order.grams, 6000);
  assert.equal((await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [line("quarter", 2)], delivery: "Roastery collection", reference: "" })).status, 409, "staff previews follow the minimum too");
});

test("Admin's No minimum order exemption: admin-only, kept by other edits, never shown to the customer", async () => {
  { const row = await customerRow(); const { id, version, updatedAt, ...fields } = row; assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, noMinimumOrder: "yes", ifVersion: version })).status, 400, "only true or false"); }
  let saved = await setExempt(true);
  assert.equal(saved.noMinimumOrder, true);
  const current = await session();
  assert.equal(current.minimumOrderGrams, 0);
  assert.equal(Object.hasOwn(current.customer, "noMinimumOrder"), false, "the customer never sees the setting");
  assert.equal(Object.hasOwn((await call("GET", "/api/wholesale/catalogue", undefined, A)).body.customer, "noMinimumOrder"), false);
  const small = await order([line("quarter", 1)]);
  assert.equal(small.result.status, 201, small.result.text);
  assert.equal(Object.hasOwn(small.result.body.order.customerSnapshot || {}, "noMinimumOrder"), false);
  saved = await setExempt(undefined);
  assert.equal(saved.noMinimumOrder, true, "an admin save without the field keeps it");
  const profile = await call("PUT", "/api/wholesale/account", { ifVersion: current.customer.version + 1, contact: "New Buyer", noMinimumOrder: false }, A);
  assert.equal(profile.status, 200, profile.text);
  assert.equal((await customerRow()).noMinimumOrder, true, "the customer's own profile save keeps it and can't change it");
  saved = await setExempt(false);
  assert.equal(saved.noMinimumOrder, undefined);
  assert.equal((await session()).minimumOrderGrams, 6000);
  const again = await call("POST", "/api/wholesale/orders", small.body, A);
  assert.equal(again.status, 200, "an order already placed is still returned on an exact retry");
  const sneaky = await call("PUT", "/api/wholesale/account", { ifVersion: (await session()).customer.version, noMinimumOrder: true }, A);
  assert.equal(sneaky.status, 200);
  assert.equal((await customerRow()).noMinimumOrder, undefined, "customers can't exempt themselves");
  assert.equal((await order([line("quarter", 1)])).result.body.code, "below_minimum");
});
