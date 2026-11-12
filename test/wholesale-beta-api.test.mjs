import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF, MANAGER;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: cookieOf(response) };
}
before(async () => {
  srv = await startServer();
  const setup = await call("POST", "/api/auth/setup", { name: "Beta Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null);
  assert.equal(setup.status, 200); ADMIN = setup.cookie;
  for (const role of ["staff", "manager"]) {
    assert.equal((await call("POST", "/api/admin/users", { name: role, username: role, role, password: "temporary-password" })).status, 200);
    const login = await call("POST", "/api/auth/change", { username: role, password: "temporary-password", newPassword: role + "-own-password" }, null);
    assert.equal(login.status, 200);
    if (role === "staff") STAFF = login.cookie; else MANAGER = login.cookie;
  }
  srv.sql(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 205)
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at)
    SELECT 'customer', '00000000-0000-4000-8000-' || printf('%012d',x), json_object('business','Coffee partner ' || printf('%03d',x),'contact','Buyer ' || x,'email','buyer' || x || '@example.com','status','Active','note','Private'),1,1700000000000 FROM n;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 205)
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at)
    SELECT 'order','WS-' || printf('%032d',x),json_object('business','Coffee partner ' || printf('%03d',x),'reference','PO ' || x,'createdName','Buyer ' || x,'createdBy','wholesale:fixture','status','New','preview',json('false'),'grams',1000,'pence',3700,'packs',1,'lines',json('[]'),'note','Private','requestKey','secret-digest'),1,1700000000000 FROM n;
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES
      ('order','PREVIEW-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF','{"business":"Staff preview","preview":true,"status":"New","grams":99000,"lines":[]}',1,1700000000000),
      ('order','WS-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF','{"business":"Completed partner","preview":false,"status":"Dispatched","grams":1000,"lines":[]}',1,1700000000000);
    INSERT INTO wholesale_accounts(id,customer_id,username,password_hash,password_salt,approval_status,active,created_at,updated_at) VALUES
      ('account-205','00000000-0000-4000-8000-000000000205','older.pending','fixture','fixture','pending',0,1700000000000,1700000000000);`);
});
after(async () => { await srv?.stop(); });

test("wholesale beta: indexed admin pages expose older orders/customers and all-record preparation totals", async () => {
  const bootstrap = (await call("GET", "/api/admin/wholesale")).body;
  assert.equal(bootstrap.stage, "beta");
  assert.equal(bootstrap.orders.length, 200); assert.equal(bootstrap.customers.length, 200);
  assert.equal(bootstrap.stats.openOrders, 205); assert.equal(bootstrap.stats.gramsToPrepare, 205000);
  assert.equal(bootstrap.stats.totalCustomers, 205); assert.equal(bootstrap.stats.pendingAccounts, 1);
  assert.equal(bootstrap.stats.visibleCoffees, 14); assert.equal(bootstrap.stats.totalCoffees, 14);
  assert.ok(bootstrap.orderCursor); assert.ok(bootstrap.customerCursor);
  const orders = (await call("GET", "/api/admin/wholesale/orders?cursor=" + encodeURIComponent(bootstrap.orderCursor))).body;
  assert.equal(orders.count, 207); assert.equal(orders.orders.length, 7); assert.equal(orders.nextCursor, null);
  assert.equal(new Set([...bootstrap.orders, ...orders.orders].map((row) => row.id)).size, 207, "equal timestamps page by id without duplicates");
  for (const order of [...bootstrap.orders, ...orders.orders]) assert.equal(order.requestKey, undefined);
  const customers = (await call("GET", "/api/admin/wholesale/customers?cursor=" + encodeURIComponent(bootstrap.customerCursor))).body;
  assert.equal(customers.count, 205); assert.equal(customers.customers.length, 5); assert.equal(customers.nextCursor, null);
  assert.equal(new Set([...bootstrap.customers, ...customers.customers].map((row) => row.id)).size, 205);
  assert.equal(customers.accounts.length, 1); assert.equal(customers.accounts[0].username, "older.pending");
  assert.equal(customers.accounts[0].password_hash, undefined);
  const pending = (await call("GET", "/api/admin/wholesale/customers?approval=pending")).body;
  assert.equal(pending.count, 1); assert.equal(pending.customers[0].id, "00000000-0000-4000-8000-000000000205");
});

test("wholesale beta: admin search reaches older records, escapes literal wildcards and validates filters/cursors", async () => {
  srv.sql("UPDATE wholesale_preview SET data = json_set(data, '$.business', 'Older 100%_Coffee Partner') WHERE kind = 'customer' AND id = '00000000-0000-4000-8000-000000000205'");
  for (const q of ["100%_", "%", "buyer205@example.com", "OLDER 100%_"]) {
    const page = (await call("GET", "/api/admin/wholesale/customers?q=" + encodeURIComponent(q))).body;
    assert.equal(page.count, 1, q); assert.equal(page.customers[0].id, "00000000-0000-4000-8000-000000000205");
  }
  const order = (await call("GET", "/api/admin/wholesale/orders?q=" + encodeURIComponent("PO 205"))).body;
  assert.equal(order.count, 1); assert.equal(order.orders[0].reference, "PO 205");
  const dispatched = (await call("GET", "/api/admin/wholesale/orders?status=Dispatched")).body;
  assert.equal(dispatched.count, 1); assert.equal(dispatched.orders[0].business, "Completed partner");
  const injection = (await call("GET", "/api/admin/wholesale/customers?q=" + encodeURIComponent("%' OR 1=1 --"))).body;
  assert.equal(injection.count, 0);
  for (const query of ["cursor=not-a-cursor", "cursor=9007199254740992:id", "status=not-a-status", "approval=not-an-approval", "q=" + "a".repeat(121)]) {
    assert.equal((await call("GET", "/api/admin/wholesale/customers?" + query)).status, 400, query);
  }
  assert.equal((await call("GET", "/api/admin/wholesale/orders?approval=pending")).status, 400);
});

test("wholesale beta: paged management routes remain admin-only", async () => {
  const switched = await call("POST", "/api/wholesale/orders", { orderingIdentity: "another-account" }, STAFF);
  assert.equal(switched.status, 409); assert.equal(switched.body.code, "account_changed");
  for (const path of ["/api/admin/wholesale/orders", "/api/admin/wholesale/customers?approval=pending"]) {
    assert.equal((await call("GET", path, undefined, null)).status, 401);
    for (const cookie of [STAFF, MANAGER]) assert.equal((await call("GET", path, undefined, cookie)).status, 403);
  }
});
