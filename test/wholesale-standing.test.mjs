// Standing orders and dispatch days (src/wholesaleStanding.ts): Admin sets a dispatch day and a repeat on a customer
// order, amends its bags, and each run that is dispatched (or cancelled, to skip it) makes the next one once. The
// customer sees the day, the schedule and that it was changed (never who changed it); only admins can do any of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addDays, ukDay } from "../src/insightsMath.ts";

let srv, ADMIN, A, STAFF, orderId;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const today = ukDay(Date.now());
const order = async (id = orderId) => (await call("GET", `/api/wholesale/orders/${id}`)).body.order;
const patch = (o, extra) => call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: o.status, customerId: o.customerId, note: o.note || "", trackingUrl: o.trackingUrl || "", ...extra });

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const staff = await call("POST", "/api/admin/users", { name: "Shop Staff", username: "shop.staff", role: "staff" });
  STAFF = (await call("POST", "/api/auth/login", { username: "shop.staff", password: staff.body.temporaryPassword }, null)).cookie;
  const credentials = { username: "standing.buyer", password: "standing-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Standing", contact: "Sam", email: "standing@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  let session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  assert.equal((await call("PUT", "/api/wholesale/account", { ifVersion: session.customer.version, address: "1 Market Place, Norwich", postcode: "NR2 1AA" }, A)).status, 200);
  session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  const r = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Delivery", reference: "Weekly", customerVersion: session.customer.version }, A);
  assert.equal(r.status, 201, r.text);
  orderId = r.body.order.id;
});
after(async () => { await srv?.stop(); });

test("dispatch day and standing order are checked and saved on the order", async () => {
  let o = await order();
  for (const [schedule, why] of [[{ dispatchDate: addDays(today, -1), every: 1 }, "past day"], [{ dispatchDate: "2026-02-30", every: 1 }, "not a day"], [{ dispatchDate: addDays(today, 3), every: 3 }, "every 3 weeks"], [{ dispatchDate: null, every: 2 }, "standing without a day"]]) {
    assert.equal((await patch(o, { schedule })).status, 400, why);
  }
  const r = await patch(o, { schedule: { dispatchDate: addDays(today, 3), every: 2 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.order.dispatchDate, addDays(today, 3));
  assert.deepEqual(r.body.order.standing, { every: 2, seriesId: orderId, run: 1 });
  assert.equal(r.body.order.nextRunId, undefined, "nothing repeats until it goes out");
  // A save without `schedule` (quick status buttons, the staff page) leaves it alone.
  o = r.body.order;
  const again = await patch(o, { note: "Pack Thursday" });
  assert.equal(again.body.order.dispatchDate, addDays(today, 3)); assert.equal(again.body.order.standing.every, 2);
  // Customers see the day and schedule.
  const mine = (await call("GET", "/api/wholesale/orders", undefined, A)).body.orders.find((x) => x.id === orderId);
  assert.equal(mine.dispatchDate, addDays(today, 3)); assert.equal(mine.standing.every, 2);
});

test("admins amend the bags: kept lines keep their price, added ones take today's, totals worked out again", async () => {
  let o = await order();
  const lines = [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 4 }, { productId: "rosalina", pack: "quarter", grind: "filter", quantity: 12 }];
  assert.equal((await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: o.version + 5, lines })).status, 409);
  for (const cookie of [STAFF, A]) assert.ok([401, 403].includes((await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: o.version, lines }, cookie)).status));
  for (const bad of [[], [{ ...lines[0], quantity: 0 }], [{ ...lines[0], pack: "litre" }], [{ ...lines[0], productId: "nope" }]]) assert.equal((await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: o.version, lines: bad })).status, 400, JSON.stringify(bad));
  const r = await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: o.version, lines });
  assert.equal(r.status, 200, r.text);
  o = r.body.order;
  assert.deepEqual(o.lines.map((l) => [l.productId, l.quantity, l.price]), [["campo", 4, 1800], ["rosalina", 12, 625]]);
  assert.deepEqual([o.pence, o.grams, o.packs], [4 * 1800 + 12 * 625, 7000, 16]);
  assert.equal(o.deliveryPence, 744); assert.equal(o.totalPence, o.pence + 744);
  assert.equal(o.originalLines[0].quantity, 6); assert.equal(o.amendedBy, "Admin");
  const mine = (await call("GET", `/api/wholesale/orders/${o.id}`, undefined, A)).body.order;
  assert.ok(mine.amendedAt); assert.equal(mine.amendedBy, undefined, "customers never see who changed it");
  assert.equal(mine.packs, 16);
});

test("dispatching a run makes the next one once; cancelling skips a run; unticking stops it", async () => {
  let o = await order();
  const sent = await patch(o, { status: "Dispatched" });
  assert.equal(sent.status, 200, sent.text);
  const nextId = sent.body.order.nextRunId;
  assert.match(nextId, /^WS-[A-F0-9]{32}$/);
  assert.equal((await call("PUT", `/api/admin/wholesale/orders/${o.id}/lines`, { ifVersion: sent.body.order.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 1 }] })).status, 409, "dispatched orders can't be amended");
  let next = await order(nextId);
  assert.equal(next.status, "New"); assert.equal(next.dispatchDate, addDays(today, 3 + 14));
  assert.deepEqual(next.standing, { every: 2, seriesId: orderId, run: 2 });
  assert.equal(next.previousRunId, orderId);
  assert.deepEqual(next.lines.map((l) => [l.productId, l.quantity]), [["campo", 4], ["rosalina", 12]], "the amended bags repeat");
  assert.equal(next.amendedAt, undefined); assert.equal(next.note, ""); assert.equal(next.preview, false);
  assert.equal(next.dispatchEmailedAt, undefined, "the next run gets its own shipped/collected email");
  assert.equal(next.tab, undefined, "not on a tab unless the customer uses one");
  assert.equal(next.reference, "Weekly"); assert.equal(next.customerSnapshot.business, "Café Standing");
  // Saving the dispatched run again never makes a second next run.
  const resaved = await patch(sent.body.order, { note: "Sent" });
  assert.equal(resaved.body.order.nextRunId, nextId);
  assert.equal((await call("GET", "/api/admin/wholesale/orders?q=" + encodeURIComponent("Café Standing"))).body.orders.length, 2);
  // The customer sees the next run with its dispatch day.
  assert.ok((await call("GET", "/api/wholesale/orders", undefined, A)).body.orders.some((x) => x.id === nextId && x.dispatchDate === next.dispatchDate));
  // The staff orders page shows the dispatch day too.
  const staffRow = (await call("GET", "/api/staff-orders/orders")).body.orders.find((x) => x.id === nextId);
  assert.equal(staffRow.dispatchDate, next.dispatchDate); assert.equal(staffRow.standingEvery, 2);

  const skipped = await patch(next, { status: "Cancelled" });
  const third = await order(skipped.body.order.nextRunId);
  assert.equal(third.dispatchDate, addDays(today, 3 + 28)); assert.equal(third.standing.run, 3);
  const stopped = await patch(third, { schedule: { dispatchDate: third.dispatchDate, every: 0 } });
  assert.equal(stopped.body.order.standing, undefined);
  const done = await patch(stopped.body.order, { status: "Dispatched" });
  assert.equal(done.body.order.nextRunId, undefined, "no longer a standing order");
  // Ticking standing on an order that's already dispatched makes its next run straight away.
  const restarted = await patch(done.body.order, { schedule: { dispatchDate: done.body.order.dispatchDate, every: 1 } });
  const fourth = await order(restarted.body.order.nextRunId);
  assert.equal(fourth.dispatchDate, addDays(today, 3 + 28 + 7));
});

test("staff previews can't have a dispatch day, and only admins can set one", async () => {
  const preview = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Roastery collection", reference: "", business: "Test" });
  assert.equal(preview.status, 201, preview.text);
  assert.equal((await patch(preview.body.order, { schedule: { dispatchDate: today, every: 0 } })).status, 400);
  const o = await order();
  const denied = await call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: o.status, schedule: { dispatchDate: today, every: 1 } }, STAFF);
  assert.ok([401, 403].includes(denied.status), String(denied.status));
});
