// Taking an order for a customer (it came by email, phone or at the door): staff with wholesale orders access and
// admins place a real customer order from the staff orders page, at the catalogue's prices (which that page never
// shows), with the same checks as the ordering site; the customer is emailed a confirmation only when asked, and
// never sees who took it; a retry with the same request ID never places it twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, STAFF, OTHER, staffId, C, CUSTOMER;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, text, cookie: cookieOf(r) };
}
async function ok(method, path, body, cookie = ADMIN) { const r = await call(method, path, body, cookie); assert.ok(r.status >= 200 && r.status < 300, `${path}: ${r.status} ${r.text}`); return r; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function person(role, username) {
  const u = (await ok("POST", "/api/admin/users", { name: username === "packer" ? "Pat Packer" : "Olly Other", username, role, password: "temporary-password" })).body.user;
  return { id: u.id, cookie: (await ok("POST", "/api/auth/change", { username, password: "temporary-password", newPassword: username + "-own-password" }, null)).cookie };
}
const order = (fields = {}) => ({ requestId: crypto.randomUUID(), customerId: C.id, source: "Email", lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2 }], delivery: "Roastery collection", ...fields });

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 3000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  ADMIN = (await ok("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const staff = await person("staff", "packer"); STAFF = staff.cookie; staffId = staff.id;
  OTHER = (await person("staff", "other")).cookie;
  await ok("PUT", `/api/admin/users/${staffId}/orders-access`, { ifVersion: 0, enabled: true });
  C = (await ok("POST", "/api/admin/wholesale/customers", { business: "Door Café", contact: "Dee", email: "dee@door.example", address: "1 Door Lane", postcode: "NR1 1DD", note: "PRIVATE_NOTE", status: "Active" })).body.customer;
  const account = (await ok("POST", `/api/admin/wholesale/customers/${C.id}/account`, { username: "door.cafe" })).body;
  CUSTOMER = (await ok("POST", "/api/wholesale/auth/change-password", { username: "door.cafe", password: account.temporaryPassword, newPassword: "door-cafe-own-password" }, null)).cookie;
});
after(async () => { await srv?.stop(); mock?.close(); });

test("the coffees a customer can order, for staff: sizes and grinds, no prices", async () => {
  const r = await ok("GET", `/api/staff-orders/catalogue?customer=${C.id}`, undefined, STAFF);
  assert.ok(r.body.products.length > 0);
  assert.ok(r.body.products.every((p) => p.packs.length && p.grinds.length));
  assert.ok(!/"prices?"|"pence"/.test(r.text), "no prices");
  assert.deepEqual(r.body.sources, ["Email", "In person", "Phone", "Other"]);
  assert.equal((await call("GET", `/api/staff-orders/catalogue?customer=${C.id}`, undefined, OTHER)).status, 403, "without the grant");
  assert.equal((await call("GET", "/api/staff-orders/catalogue?customer=nobody", undefined, STAFF)).status, 404);
});

test("staff take an order for a customer: a real order at today's prices, emailed only when asked, never twice", async () => {
  sent.length = 0;
  const body = order({ source: "In person", reference: "Door 1", customerNote: "Collecting at 3" });
  const r = await call("POST", "/api/staff-orders/orders", body, STAFF);
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.order.id, /^WS-/);
  assert.equal(r.body.order.business, "Door Café");
  assert.equal(r.body.order.takenSource, "In person");
  assert.ok(!/"price"|"pence"|Pat Packer/.test(r.text), "the staff page gets no prices or who took it");
  // Admin sees the real order, priced from the catalogue, and who took it.
  const admin = (await ok("GET", "/api/admin/wholesale")).body;
  const saved = admin.orders.find((o) => o.id === r.body.order.id);
  const brazil = admin.products.find((p) => p.id === "brazil");
  assert.deepEqual([saved.preview, saved.customerId, saved.createdName, saved.takenFor.source, saved.lines[0].price, saved.pence], [false, C.id, "Pat Packer", "In person", brazil.prices.kilo, brazil.prices.kilo * 2]);
  assert.equal(saved.customerNote, "Collecting at 3");
  // The same request again returns the same order.
  const again = await call("POST", "/api/staff-orders/orders", body, STAFF);
  assert.equal(again.status, 200); assert.equal(again.body.order.id, r.body.order.id);
  await wait(800);
  assert.equal(sent.filter((m) => (m.to || []).includes("dee@door.example")).length, 0, "no confirmation unless asked");
  // The customer sees it in My orders, without who took it.
  const mine = await ok("GET", "/api/wholesale/orders", undefined, CUSTOMER);
  assert.match(mine.text, new RegExp(r.body.order.id));
  assert.ok(!mine.text.includes("Pat Packer"), "the customer never sees the employee's name");
  // Asked to, the customer gets a confirmation.
  const emailed = await call("POST", "/api/staff-orders/orders", order({ emailCustomer: true }), STAFF);
  assert.equal(emailed.status, 201, emailed.text);
  const end = Date.now() + 4000; while (Date.now() < end && !sent.some((m) => (m.to || []).includes("dee@door.example"))) await wait(100);
  assert.ok(sent.some((m) => (m.to || []).includes("dee@door.example")), "confirmation sent");
});

test("the same checks as the ordering site; only staff with access and admins", async () => {
  for (const bad of [order({ source: "Fax" }), order({ customerId: "00000000-0000-0000-0000-000000000000" }), order({ lines: [{ productId: "nope", pack: "kilo", grind: "beans", quantity: 1 }] }), order({ lines: [] }), order({ delivery: "Drone" })]) {
    const r = await call("POST", "/api/staff-orders/orders", bad, STAFF);
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(bad)}: ${r.status}`);
  }
  assert.equal((await call("POST", "/api/staff-orders/orders", order(), OTHER)).status, 403, "no grant, no orders");
  assert.equal((await call("POST", "/api/staff-orders/orders", order(), null)).status, 401);
  assert.equal((await call("POST", "/api/staff-orders/orders", order(), ADMIN)).status, 201, "admins can too");
  // On hold: refused.
  const current = (await ok("GET", "/api/admin/wholesale")).body.customers.find((x) => x.id === C.id);
  await ok("PUT", `/api/admin/wholesale/customers/${C.id}`, { ...current, ifVersion: current.version, status: "On hold" });
  const held = await call("POST", "/api/staff-orders/orders", order(), STAFF);
  assert.equal(held.status, 403); assert.equal(held.body.code, "account_on_hold");
  // Revoking access stops it.
  await ok("PUT", `/api/admin/users/${staffId}/orders-access`, { ifVersion: 1, enabled: false });
  assert.equal((await call("POST", "/api/staff-orders/orders", order(), STAFF)).status, 403);
});
