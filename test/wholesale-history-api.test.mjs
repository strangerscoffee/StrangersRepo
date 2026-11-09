import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, customerA, customerB;
const cookieOf = response => (response.headers.getSetCookie().find(value => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await api("POST", "/api/auth/setup", { name: "History Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const admin = (await api("GET", "/api/auth/me")).body.user;
  for (const name of ["a", "b"]) {
    const customer = (await api("POST", "/api/admin/wholesale/customers", { business: "History partner " + name, contact: "Buyer", email: name + "@example.test", status: "Active", note: "Internal credit note" })).body.customer;
    const account = (await api("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username: "history." + name })).body;
    const session = await api("POST", "/api/wholesale/auth/change-password", { username: "history." + name, password: account.temporaryPassword, newPassword: "history-password-" + name }, null);
    assert.equal(session.status, 200);
    if (name === "a") { A = session.cookie; customerA = customer; } else { B = session.cookie; customerB = customer; }
  }
  srv.sql(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205)
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at)
    SELECT 'order','WS-' || printf('%032d',x),json_object('customerId','${customerA.id}','preview',json('false'),'createdBy','wholesale:fixture','business','History partner a','status','New','pence',3700,'grams',1000,'packs',1,'lines',json('[]'),'note','Internal order note','requestKey','private-digest'),1,1700000000000 FROM n;
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES
    ('order','WS-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',json_object('customerId','${customerB.id}','preview',json('false'),'createdBy','wholesale:other','business','History partner b','lines',json('[]'),'note','Other private note'),1,1700000000000),
    ('order','PREVIEW-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',json_object('customerId','${customerA.id}','createdBy','${admin.id}','preview',json('true'),'business','Staff test','lines',json('[]'),'note','Staff note'),1,1700000000000);`);
});
after(async () => { await srv?.stop(); });

test("wholesale history: customers can page beyond 200 orders without duplicates or private fields", async () => {
  const first = await api("GET", "/api/wholesale/orders", undefined, A);
  assert.equal(first.status, 200); assert.equal(first.body.orders.length, 200); assert.equal(first.body.count, 205); assert.ok(first.body.nextCursor);
  const next = await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(first.body.nextCursor), undefined, A);
  assert.equal(next.status, 200); assert.equal(next.body.orders.length, 5); assert.equal(next.body.count, 205); assert.equal(next.body.nextCursor, null);
  const all = [...first.body.orders, ...next.body.orders];
  assert.equal(new Set(all.map(row => row.id)).size, 205);
  for (const row of all) { assert.equal(row.customerId, customerA.id); assert.equal(row.preview, false); assert.equal(row.note, undefined); assert.equal(row.requestKey, undefined); }
});

test("wholesale history: cursors never change business ownership or reveal staff tests", async () => {
  const first = (await api("GET", "/api/wholesale/orders", undefined, A)).body;
  const other = await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(first.nextCursor), undefined, B);
  assert.equal(other.status, 200); assert.equal(other.body.count, 1);
  assert.ok(other.body.orders.every(row => row.customerId === customerB.id));
  const staff = await api("GET", "/api/wholesale/orders");
  assert.equal(staff.status, 200); assert.equal(staff.body.count, 1); assert.match(staff.body.orders[0].id, /^PREVIEW-/);
  for (const cursor of ["not-valid", "9007199254740992:id", "1700000000000:' OR 1=1"]) assert.equal((await api("GET", "/api/wholesale/orders?cursor=" + encodeURIComponent(cursor), undefined, A)).status, 400);
  assert.equal((await api("GET", "/api/wholesale/orders", undefined, null)).status, 401);
  const stale = await api("PUT", "/api/wholesale/account", { ...customerA, ifVersion: customerB.version, orderingIdentity: "another-account" }, B);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "account_changed");
  assert.equal((await api("GET", "/api/wholesale/session", undefined, B)).body.customer.business, customerB.business);
});
