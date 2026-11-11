// Admin printing: GET /api/admin/wholesale/orders/print returns customer orders by status (no staff previews or
// removed orders), or exactly the orders picked, in the order picked. Admin only (staff and managers: security.test.mjs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const PRICES = { brazil: [500, 1800], campo: [500, 1800], house: [500, 1800], decaf: [550, 2000], rocko: [625, 2400] };
const line = (productId, pack, quantity) => ({ productId, pack, grind: "beans", quantity, price: PRICES[productId][pack === "kilo" ? 1 : 0] });
async function place(lines, cookie = A) {
  const session = cookie === A ? (await call("GET", "/api/wholesale/session", undefined, A)).body : null;
  const r = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", ...(session ? { customerVersion: session.customer.version } : {}) }, cookie);
  assert.equal(r.status, 201, r.text + " " + JSON.stringify(lines)); return r.body.order;
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "print.buyer", password: "print-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Print Café", contact: "Buyer", email: "print@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("orders to print: new customer orders by status, or exactly the ones picked; admin only", async () => {
  const first = await place([line("brazil", "kilo", 6)]), second = await place([line("campo", "quarter", 8), line("house", "kilo", 2)]);
  const removed = await place([line("decaf", "quarter", 4)]);
  assert.equal((await call("DELETE", `/api/admin/wholesale/orders/${removed.id}`, { ifVersion: removed.version })).status, 200);
  const preview = await place([line("brazil", "quarter", 1)], ADMIN);
  const preparing = await place([line("rocko", "kilo", 1)]);
  assert.equal((await call("PATCH", `/api/admin/wholesale/orders/${preparing.id}`, { ifVersion: preparing.version, status: "Preparing", customerId: preparing.customerId, note: "" })).status, 200);

  const fresh = await call("GET", "/api/admin/wholesale/orders/print?status=New");
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(fresh.body.orders.map((o) => o.id), [first.id, second.id], "new customer orders, oldest first: no previews or removed orders");
  assert.ok(fresh.body.orders[1].lines.length === 2 && fresh.body.orders[1].customerSnapshot, "full orders for packing sheets");
  const open = await call("GET", "/api/admin/wholesale/orders/print?status=New,Preparing");
  assert.deepEqual(open.body.orders.map((o) => o.id).sort(), [first.id, second.id, preparing.id].sort());
  const picked = await call("GET", `/api/admin/wholesale/orders/print?ids=${second.id},${preview.id},${removed.id}`);
  assert.deepEqual(picked.body.orders.map((o) => o.id), [second.id, preview.id], "picked orders in the order picked; removed ones left out");

  for (const bad of ["", "?status=Lost", "?ids=nope", `?ids=${Array.from({ length: 201 }, () => first.id).join(",")}`]) assert.equal((await call("GET", "/api/admin/wholesale/orders/print" + bad)).status, 400, bad);
  for (const cookie of [null, A]) assert.equal((await call("GET", "/api/admin/wholesale/orders/print?status=New", undefined, cookie)).status, 401);
});
