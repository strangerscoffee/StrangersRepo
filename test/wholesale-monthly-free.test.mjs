// Monthly standing orders and Free delivery (the owner's request, 26 Nov 2026): a standing order can repeat on the same
// date every month (the 1st to the 28th), and Admin can give a business free delivery, which its orders, changed bags
// and standing runs keep. Both settings are admin-only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addMonths, ukDay } from "../src/insightsMath.ts";

let srv, ADMIN, A, customerId;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const today = ukDay(Date.now());
const order = async (id) => (await call("GET", `/api/wholesale/orders/${id}`)).body.order;
const patch = (o, extra) => call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: o.status, customerId: o.customerId, note: o.note || "", trackingUrl: o.trackingUrl || "", ...extra });
const fields = { business: "Free Post Ltd", contact: "Sam", email: "free@example.test", address: "8 Close\nBishop's Stortford", postcode: "CM23 1AA", status: "Active", paymentTerms: "net-30" };

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const made = await call("POST", "/api/admin/wholesale/customers", { ...fields, freeDelivery: true });
  assert.equal(made.status, 201, made.text);
  customerId = made.body.customer.id;
  const username = "freepost" + Math.floor(Math.random() * 1e6);
  const account = (await call("POST", `/api/admin/wholesale/customers/${customerId}/account`, { username })).body;
  A = (await call("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: "buyer-password-123" }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("monthly dates step a calendar month at a time", () => {
  assert.equal(addMonths("2026-12-01", 1), "2027-01-01");
  assert.equal(addMonths("2026-01-28", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-01", 13), "2027-12-01");
});

test("Free delivery is admin-only and makes delivered orders, changed bags and standing runs free", async () => {
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  assert.equal(session.freeDelivery, true);
  assert.equal(Object.hasOwn(session.customer, "freeDelivery"), false, "the setting itself stays admin-only");
  const placed = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: session.customer.version, delivery: "Delivery", lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 1, price: 1800 }] }, A);
  assert.equal(placed.status, 201, placed.text);
  let o = placed.body.order;
  assert.equal(o.deliveryPence, 0); assert.equal(o.totalPence, 1800);
  // The customer's own profile save keeps it, and can't switch it off.
  const saved = await call("PUT", "/api/wholesale/account", { ifVersion: session.customer.version, contact: "Sam C", freeDelivery: false }, A);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(srv.sql(`SELECT json_extract(data,'$.freeDelivery') f FROM wholesale_preview WHERE kind='customer' AND id='${customerId}'`)[0].f, 1);
  const current = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === customerId);
  assert.equal(current.freeDelivery, true);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customerId}`, { ...fields, freeDelivery: "yes", ifVersion: current.version })).status, 400);

  // A monthly standing order: the 29th onwards is refused, the 1st is fine.
  o = await order(o.id);
  const late = (n) => { const d = addMonths(today.slice(0, 8) + "01", 1); return d.slice(0, 8) + String(n).padStart(2, "0"); };
  assert.equal((await patch(o, { schedule: { dispatchDate: late(29), every: "month" } })).status, 400);
  assert.equal((await patch(o, { schedule: { dispatchDate: late(1), every: "monthly" } })).status, 400);
  const r = await patch(o, { schedule: { dispatchDate: late(1), every: "month" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.order.standing.every, "month");
  // Changed bags stay free.
  const amended = await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: r.body.order.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 2 }] });
  assert.equal(amended.status, 200, amended.text);
  assert.equal(amended.body.order.deliveryPence, 0); assert.equal(amended.body.order.totalPence, 3600);
  const staffRow = (await call("GET", "/api/staff-orders/orders")).body.orders.find((x) => x.id === o.id);
  assert.equal(staffRow.standingEvery, "month");
  // Dispatching makes next month's run, on the same date, still free.
  const sent = await patch(amended.body.order, { status: "Dispatched" });
  assert.equal(sent.status, 200, sent.text);
  const next = await order(sent.body.order.nextRunId);
  assert.equal(next.dispatchDate, addMonths(late(1), 1));
  assert.deepEqual(next.standing, { every: "month", seriesId: o.id, run: 2 });
  assert.equal(next.deliveryPence, 0); assert.equal(next.freeDelivery, true);
  assert.equal(next.lines[0].quantity, 2);

  // Switched off: the next run is charged again.
  const row = (await call("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === customerId);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customerId}`, { ...fields, freeDelivery: false, ifVersion: row.version })).status, 200);
  const skipped = await patch(next, { status: "Cancelled" });
  const third = await order(skipped.body.order.nextRunId);
  assert.equal(third.dispatchDate, addMonths(late(1), 2));
  assert.equal(third.deliveryPence, 744); assert.equal(third.freeDelivery, undefined);
});
