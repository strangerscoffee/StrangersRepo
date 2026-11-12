// Customer tabs (src/wholesaleTabs.ts): orders go on a customer's tab by hand or automatically (Admin's "Put orders on
// a tab"), the tab adds up kg and bags (and £ for admins only), shows ready at 6 kg, and is cleared then (or earlier)
// with a record; a fresh tab starts. Staff with wholesale orders access and admins only; never shown to customers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, STAFF, MANAGER, staffId, A, B;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function ok(method, path, body, cookie = ADMIN) { const r = await call(method, path, body, cookie); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`); return r; }
async function customer(username, extra = {}) {
  const c = (await ok("POST", "/api/admin/wholesale/customers", { business: username, contact: "Sam", email: username + "@example.test", address: "1 Elm Hill", postcode: "NR3 1HN", note: "", status: "Active", ...extra })).body.customer;
  const account = (await ok("POST", `/api/admin/wholesale/customers/${c.id}/account`, { username })).body;
  const cookie = (await ok("POST", "/api/wholesale/auth/change-password", { username, password: account.temporaryPassword, newPassword: username + "-own-password" }, null)).cookie;
  return { customer: c, cookie };
}
async function order(who, kilos, quarters = 0) {
  const session = (await ok("GET", "/api/wholesale/session", undefined, who.cookie)).body;
  const lines = [...(kilos ? [{ productId: "campo", pack: "kilo", grind: "beans", quantity: kilos, price: 1800 }] : []), ...(quarters ? [{ productId: "rosalina", pack: "quarter", grind: "filter", quantity: quarters, price: 625 }] : [])];
  return (await ok("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Delivery", reference: "", customerVersion: session.customer.version }, who.cookie)).body.order;
}
const tabs = (cookie = STAFF) => call("GET", "/api/staff-orders/tabs", undefined, cookie);
const tabOf = async (who, cookie) => (await tabs(cookie)).body.open.find((t) => t.customerId === who.customer.id);

before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  ADMIN = (await ok("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  for (const role of ["staff", "manager"]) {
    const u = (await ok("POST", "/api/admin/users", { name: role === "staff" ? "Pat Packer" : "Manager", username: role, role, password: "temporary-password" })).body.user;
    const auth = await ok("POST", "/api/auth/change", { username: role, password: "temporary-password", newPassword: role + "-own-password" }, null);
    if (role === "staff") { staffId = u.id; STAFF = auth.cookie; } else MANAGER = auth.cookie;
  }
  await ok("PUT", `/api/admin/users/${staffId}/orders-access`, { ifVersion: 0, enabled: true });
  A = await customer("tab.cafe");
  B = await customer("tab.shop", { autoTab: true });
});
after(async () => { await srv?.stop(); });

test("orders go on a tab by hand or automatically; the tab adds up and is ready at 6 kg", async () => {
  // Automatic: B's orders go straight on their tab; the business appears even before they order.
  assert.ok((await tabOf(B)).autoTab);
  const b1 = await order(B, 2), b2 = await order(B, 0, 8);
  let tab = await tabOf(B);
  assert.deepEqual([tab.grams, tab.packs, tab.ready, tab.toGo, tab.orders.length], [4000, 10, false, 2000, 2]);
  assert.equal(tab.pence, undefined, "staff see no money");
  assert.equal(tab.orders[0].addedBy, "Automatically");
  // By hand: A's order isn't on a tab until someone puts it there.
  const a1 = await order(A, 3);
  assert.equal(await tabOf(A), undefined);
  const row = (await ok("GET", "/api/staff-orders/orders", undefined, STAFF)).body.orders.find((o) => o.id === a1.id);
  assert.equal(row.onTab, false);
  const put = await ok("PUT", `/api/staff-orders/orders/${a1.id}/tab`, { ifVersion: row.version, onTab: true }, STAFF);
  assert.equal(put.body.order.onTab, true);
  assert.equal((await call("PUT", `/api/staff-orders/orders/${a1.id}/tab`, { ifVersion: row.version, onTab: false }, STAFF)).status, 409, "version-checked");
  tab = await tabOf(A);
  assert.deepEqual([tab.grams, tab.orders[0].addedBy], [3000, "Pat Packer"]);
  // Admins see £ too.
  assert.equal((await tabOf(A, ADMIN)).pence, undefined, "the staff route never sends money, even to an admin");
  const adminTab = (await ok("GET", "/api/admin/wholesale/tabs")).body.open.find((t) => t.customerId === A.customer.id);
  assert.equal(adminTab.pence, 3 * 1800);
  // Customers never see a tab on their orders.
  const mine = (await ok("GET", "/api/wholesale/orders", undefined, B.cookie)).body.orders;
  assert.ok(mine.every((o) => o.tab === undefined && o.tabClearedId === undefined));
  // Cancelled orders don't count.
  const b3 = await order(B, 9);
  let o = (await ok("GET", "/api/admin/wholesale")).body.orders.find((x) => x.id === b3.id);
  await ok("PATCH", `/api/admin/wholesale/orders/${b3.id}`, { ifVersion: o.version, status: "Cancelled", customerId: o.customerId, note: "" });
  tab = await tabOf(B);
  assert.equal(tab.grams, 4000); assert.equal(tab.orders.length, 3); assert.equal(tab.orders.find((x) => x.id === b3.id).counts, false);
  // 6 kg reached: ready, listed first.
  await order(B, 2);
  tab = await tabOf(B);
  assert.deepEqual([tab.grams, tab.ready, tab.toGo], [6000, true, 0]);
  assert.equal((await tabs()).body.open[0].customerId, B.customer.id, "ready tabs first");
});

test("clearing: exactly the orders seen, recorded, and a fresh tab starts; early clears are allowed", async () => {
  let tab = await tabOf(B);
  const ids = tab.orders.map((x) => x.id);
  assert.equal((await call("POST", `/api/staff-orders/tabs/${B.customer.id}/clear`, { orderIds: ids.slice(1) }, STAFF)).status, 409, "a tab that changed isn't cleared");
  const cleared = await ok("POST", `/api/staff-orders/tabs/${B.customer.id}/clear`, { orderIds: ids }, STAFF);
  assert.deepEqual([cleared.body.cleared.grams, cleared.body.cleared.packs, cleared.body.cleared.early, cleared.body.cleared.clearedBy, cleared.body.cleared.pence], [6000, 12, false, "Pat Packer", undefined]);
  tab = await tabOf(B);
  assert.deepEqual([tab.grams, tab.orders.length], [0, 0], "fresh tab (still listed: automatic)");
  const list = (await tabs()).body;
  assert.equal(list.cleared[0].business, "tab.shop"); assert.equal(list.cleared[0].orderIds.length, ids.length);
  // A cleared order can't be taken off or put back.
  const row = (await ok("GET", "/api/admin/wholesale")).body.orders.find((x) => x.id === ids[0]);
  assert.equal((await call("PUT", `/api/admin/wholesale/orders/${ids[0]}/tab`, { ifVersion: row.version, onTab: false })).status, 409);
  // The next order starts the new tab.
  await order(B, 1);
  assert.equal((await tabOf(B)).grams, 1000);
  // Early clear (under 6 kg), by an admin, with £ in the record.
  const a = await tabOf(A);
  const early = await ok("POST", `/api/admin/wholesale/tabs/${A.customer.id}/clear`, { orderIds: a.orders.map((x) => x.id) });
  assert.deepEqual([early.body.cleared.early, early.body.cleared.pence], [true, 3 * 1800]);
  assert.equal(await tabOf(A), undefined);
  assert.equal((await call("POST", `/api/admin/wholesale/tabs/${A.customer.id}/clear`, { orderIds: ["x"] })).status, 404, "nothing on the tab");
});

test("only admins and staff with wholesale orders access; customers never", async () => {
  const a = await order(A, 1);
  const row = (await ok("GET", "/api/admin/wholesale")).body.orders.find((x) => x.id === a.id);
  for (const cookie of [MANAGER, A.cookie, null]) {
    assert.ok([401, 403, 404].includes((await tabs(cookie)).status));
    assert.ok([401, 403, 404].includes((await call("PUT", `/api/staff-orders/orders/${a.id}/tab`, { ifVersion: row.version, onTab: true }, cookie)).status));
    assert.ok([401, 403, 404].includes((await call("POST", `/api/staff-orders/tabs/${B.customer.id}/clear`, { orderIds: [] }, cookie)).status));
    assert.ok([401, 403].includes((await call("GET", "/api/admin/wholesale/tabs", undefined, cookie)).status));
  }
  assert.equal((await call("GET", "/api/admin/wholesale/tabs", undefined, STAFF)).status === 200, false, "Admin's tab route (with £) is admins only");
  await ok("PUT", `/api/admin/users/${staffId}/orders-access`, { ifVersion: 1, enabled: false });
  assert.equal((await tabs()).status, 403, "revoked access");
  // The customer's own profile save keeps the admin-only setting; it never shows in their profile.
  const me = (await ok("GET", "/api/wholesale/session", undefined, B.cookie)).body.customer;
  assert.equal(me.autoTab, undefined);
  await ok("PUT", "/api/wholesale/account", { ifVersion: me.version, phone: "01603 1" }, B.cookie);
  assert.equal((await ok("GET", "/api/admin/wholesale")).body.customers.find((c) => c.id === B.customer.id).autoTab, true);
});
