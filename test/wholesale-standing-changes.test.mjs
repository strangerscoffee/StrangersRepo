// Changing and skipping standing order deliveries (src/wholesaleStanding.ts): customers change the bags on, or skip,
// a delivery of their own standing order while it's still New (the minimum order applies; Strangers is emailed);
// staff with wholesale orders access and admins can too while it's New or Preparing. A change is for this delivery
// only (the next delivery goes back to the usual bags) or every delivery from now on. Nobody sees which staff member.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addDays, ukDay } from "../src/insightsMath.ts";

let srv, mock, ADMIN, STAFF, OTHER, A, B, staffId;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function ok(method, path, body, cookie = ADMIN) { const r = await call(method, path, body, cookie); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`); return r; }
const today = ukDay(Date.now());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const adminOrder = async (id) => (await ok("GET", "/api/admin/wholesale")).body.orders.find((o) => o.id === id);
const mine = async (id, cookie = A) => (await ok("GET", "/api/wholesale/orders", undefined, cookie)).body.orders.find((o) => o.id === id);
const setStatus = async (id, status) => { const o = await adminOrder(id); return (await ok("PATCH", `/api/admin/wholesale/orders/${id}`, { ifVersion: o.version, status, customerId: o.customerId, note: o.note || "", trackingUrl: o.trackingUrl || "" })).body.order; };
const usual = [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6 }];

async function customer(username, business) {
  const credentials = { username, password: username + "-password" };
  await ok("POST", "/api/wholesale/auth/register", { ...credentials, business, contact: "Sam", email: username + "@example.com" }, null);
  const account = (await ok("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === username);
  await ok("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  return (await ok("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
}
async function standing(cookie = A, lines = usual) {
  const session = (await ok("GET", "/api/wholesale/session", undefined, cookie)).body;
  const prices = Object.fromEntries((await ok("GET", "/api/wholesale/catalogue", undefined, cookie)).body.products.map((p) => [p.id, p.prices]));
  const r = await ok("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: lines.map((l) => ({ ...l, price: prices[l.productId][l.pack] })), delivery: "Roastery collection", customerVersion: session.customer.version }, cookie);
  const o = await adminOrder(r.body.order.id);
  return (await ok("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: "New", customerId: o.customerId, note: "", trackingUrl: "", schedule: { dispatchDate: addDays(today, 3), every: 1 } })).body.order;
}

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 4000, vars: { WHOLESALE_MINIMUM_ORDER_GRAMS: "6000", RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  ADMIN = (await ok("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  for (const [username, name] of [["packer", "Pat Packer"], ["other", "Olly Other"]]) {
    const u = (await ok("POST", "/api/admin/users", { name, username, role: "staff", password: "temporary-password" })).body.user;
    const cookie = (await ok("POST", "/api/auth/change", { username, password: "temporary-password", newPassword: username + "-own-password" }, null)).cookie;
    if (username === "packer") { STAFF = cookie; staffId = u.id; } else OTHER = cookie;
  }
  await ok("PUT", `/api/admin/users/${staffId}/orders-access`, { ifVersion: 0, enabled: true });
  A = await customer("weekly.buyer", "Café Weekly");
  B = await customer("other.buyer", "Other Café");
});
after(async () => { await srv?.stop(); mock?.close(); });

test("customers change this delivery only: the next delivery goes back to the usual bags; Strangers is emailed", async () => {
  const run = await standing();
  sent.length = 0;
  const lines = [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 4 }, { productId: "rosalina", pack: "quarter", grind: "filter", quantity: 8 }];
  const r = await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines, scope: "once" }, A);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.order.lines.map((l) => [l.productId, l.quantity]), [["campo", 4], ["rosalina", 8]]);
  assert.deepEqual(r.body.order.repeatLines.map((l) => [l.productId, l.quantity]), [["campo", 6]], "the usual bags are kept");
  assert.equal(r.body.order.amendedByCustomer, true); assert.equal(r.body.order.amendedBy, undefined);
  const end = Date.now() + 4000; while (Date.now() < end && !sent.length) await wait(100);
  assert.match(sent[0]?.subject || "", /Café Weekly changed a standing order/);
  assert.match(sent[0].text, /this delivery only/);
  const next = await adminOrder((await setStatus(run.id, "Dispatched")).nextRunId);
  assert.deepEqual(next.lines.map((l) => [l.productId, l.quantity]), [["campo", 6]], "back to the usual bags");
  assert.equal(next.repeatLines, undefined); assert.equal(next.amendedAt, undefined); assert.equal(next.amendedByCustomer, undefined);
  // Every delivery from now on: the next one keeps the change.
  const changed = await call("PUT", `/api/wholesale/orders/${next.id}/lines`, { ifVersion: next.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 8 }], scope: "ongoing" }, A);
  assert.equal(changed.status, 200, changed.text); assert.equal(changed.body.order.repeatLines, undefined);
  const after = await adminOrder((await setStatus(next.id, "Dispatched")).nextRunId);
  assert.deepEqual(after.lines.map((l) => [l.productId, l.quantity]), [["campo", 8]]);
});

test("customers skip a delivery: it's cancelled as skipped and the next one is made", async () => {
  const run = await standing();
  const r = await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: run.version }, A);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.order.status, "Cancelled");
  assert.deepEqual(Object.keys(r.body.order.skipped).sort(), ["at", "customer"]); assert.equal(r.body.order.skipped.customer, true);
  const saved = await adminOrder(run.id);
  assert.equal(saved.skipped.by, "Café Weekly"); assert.ok(saved.nextRunId);
  const next = await mine(saved.nextRunId);
  assert.equal(next.status, "New"); assert.equal(next.dispatchDate, addDays(today, 10));
  assert.equal((await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: saved.version }, A)).status, 409, "already skipped");
});

test("what customers can't do: below the minimum, once it's being prepared, someone else's, a one-off order", async () => {
  const run = await standing();
  const small = await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 2 }] }, A);
  assert.equal(small.status, 409); assert.equal(small.body.code, "below_minimum");
  assert.equal((await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: usual }, B)).status, 404, "not theirs");
  assert.equal((await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: run.version }, B)).status, 404);
  assert.equal((await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: usual, scope: "sometimes" }, A)).status, 400);
  const preparing = await setStatus(run.id, "Preparing");
  const late = await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: preparing.version }, A);
  assert.equal(late.status, 409); assert.equal(late.body.code, "order_closed");
  // A one-off order isn't changed here.
  const session = (await ok("GET", "/api/wholesale/session", undefined, A)).body;
  const price = (await ok("GET", "/api/wholesale/catalogue", undefined, A)).body.products.find((p) => p.id === "campo").prices.kilo;
  const once = (await ok("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ ...usual[0], price }], delivery: "Roastery collection", customerVersion: session.customer.version }, A)).body.order;
  const r = await call("PUT", `/api/wholesale/orders/${once.id}/lines`, { ifVersion: once.version, lines: usual }, A);
  assert.equal(r.status, 409); assert.equal(r.body.code, "not_standing");
});

test("wholesale staff and admins change and skip deliveries (no minimum, even while preparing); staff see no prices or names", async () => {
  const run = await standing();
  const r = await call("PUT", `/api/staff-orders/orders/${run.id}/lines`, { ifVersion: run.version, lines: [{ productId: "campo", pack: "quarter", grind: "beans", quantity: 2 }], scope: "once" }, STAFF);
  assert.equal(r.status, 200, r.text);
  assert.ok(!/"price"|"pence"|Pat Packer/.test(r.text));
  assert.deepEqual(r.body.order.changed && [r.body.order.changed.byCustomer, r.body.order.changed.thisDeliveryOnly], [false, true]);
  assert.equal((await call("PUT", `/api/staff-orders/orders/${run.id}/lines`, { ifVersion: r.body.order.version, lines: usual }, OTHER)).status, 403, "no access, no changes");
  const preparing = await setStatus(run.id, "Preparing");
  const skipped = await call("POST", `/api/staff-orders/orders/${run.id}/skip`, { ifVersion: preparing.version }, STAFF);
  assert.equal(skipped.status, 200, skipped.text);
  assert.deepEqual(skipped.body.order.skipped && skipped.body.order.skipped.byCustomer, false);
  assert.equal((await adminOrder(run.id)).skipped.by, "Pat Packer");
  const seen = await mine(run.id);
  assert.ok(!JSON.stringify(seen).includes("Pat Packer"), "the customer never sees who skipped it");
  // The next delivery has the usual bags (the change was for that delivery only).
  const next = await adminOrder((await adminOrder(run.id)).nextRunId);
  assert.deepEqual(next.lines.map((l) => [l.productId, l.pack, l.quantity]), [["campo", "kilo", 6]]);
  // Admin skips too.
  const admin = await call("POST", `/api/admin/wholesale/orders/${next.id}/skip`, { ifVersion: next.version });
  assert.equal(admin.status, 200, admin.text); assert.equal(admin.body.order.skipped.by, "Admin");
  assert.equal((await call("POST", `/api/admin/wholesale/orders/${next.id}/skip`, { ifVersion: next.version }, STAFF)).status, 403, "staff can't use Admin's routes");
});
