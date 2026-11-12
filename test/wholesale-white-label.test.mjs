// White-label coffees: private to the businesses they're made for (seen, ordered and photographed only by them, listed
// first), with their own prices; and recipes ("Made from") that staff see on orders and customers never see.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, A, B, idA, idB, label;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, body: data, cookie: cookieOf(response), text };
}
async function customer(username, business) {
  const credentials = { username, password: username + "-password" };
  assert.equal((await call("POST", "/api/wholesale/auth/register", { ...credentials, business, contact: "Buyer", email: username + "@example.com" }, null)).status, 201);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === username);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username, ifVersion: account.version, active: true, approvalStatus: "approved" })).status, 200);
  return { id: account.customerId, cookie: (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie };
}
const products = async (cookie) => (await call("GET", "/api/wholesale/catalogue", undefined, cookie)).body.products;
async function order(cookie, productId, quantity = 6) {
  const session = (await call("GET", "/api/wholesale/session", undefined, cookie)).body;
  const price = (await products(ADMIN)).find((p) => p.id === productId).prices.kilo;
  return call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId, pack: "kilo", grind: "beans", quantity, price }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, cookie);
}

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Wholesale Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  ({ id: idA, cookie: A } = await customer("lune.buyer", "Lune House"));
  ({ id: idB, cookie: B } = await customer("other.buyer", "Other Cafe"));
});
after(async () => { await srv?.stop(); });

test("Admin makes a white-label coffee with a recipe; bad recipes and businesses are refused", async () => {
  const base = { title: "Lune House Blend", name: "Lune House Blend", origin: "Brazil & Colombia", process: "Washed", notes: "Toffee", categories: ["blend"], prices: { quarter: 650, kilo: 2150 }, active: true, inStock: true };
  for (const bad of [
    { whiteLabel: ["not-a-business"] },
    { whiteLabel: [crypto.randomUUID()] },
    { recipe: [{ coffee: "brazil", name: "x", percent: 60 }, { name: "Bom Jesus", percent: 30 }] },
    { recipe: [{ coffee: "no-such-coffee", name: "x", percent: 100 }] },
    { recipe: [{ name: "Half", percent: 50.5 }, { name: "Half", percent: 49.5 }] },
  ]) assert.equal((await call("POST", "/api/admin/wholesale/catalogue", { ...base, ...bad })).status, 400, JSON.stringify(bad));
  const made = await call("POST", "/api/admin/wholesale/catalogue", { ...base, whiteLabel: [idA], recipe: [{ coffee: "brazil", name: "Brazil", percent: 60 }, { name: "Bom Jesus", percent: 40 }] });
  assert.equal(made.status, 201, made.text);
  label = made.body.product;
  assert.deepEqual(label.whiteLabel, [idA]);
  assert.equal(label.recipe.length, 2);
  // A coffee can't be made from itself.
  const self = await call("PUT", `/api/admin/wholesale/catalogue/${label.id}`, { ...base, ifVersion: label.version, recipe: [{ coffee: label.id, name: "Me", percent: 100 }] });
  assert.equal(self.status, 400);
  // An edit that leaves the fields out keeps them.
  const kept = await call("PUT", `/api/admin/wholesale/catalogue/${label.id}`, { ...base, notes: "Toffee and plum", ifVersion: label.version });
  assert.equal(kept.status, 200, kept.text);
  assert.deepEqual(kept.body.product.whiteLabel, [idA]);
  label = kept.body.product;
  const names = (await call("GET", "/api/admin/wholesale/customers/names")).body.customers;
  assert.deepEqual(names.map((c) => c.business), ["Lune House", "Other Cafe"]);
  for (const cookie of [A, B]) assert.ok([401, 403].includes((await call("GET", "/api/admin/wholesale/customers/names", undefined, cookie)).status));
});

test("Only its business sees it, first, without the recipe or who else it's for", async () => {
  const mine = await products(A);
  assert.equal(mine[0].id, label.id);
  assert.equal(mine[0].yours, true);
  assert.equal(mine[0].prices.kilo, 2150);
  assert.equal(Object.hasOwn(mine[0], "whiteLabel"), false);
  assert.equal(Object.hasOwn(mine[0], "recipe"), false);
  assert.ok(mine.length > 1, "the rest of the range is still there");
  assert.ok(mine.slice(1).every((p) => !p.yours));
  const theirs = await products(B);
  assert.equal(theirs.some((p) => p.id === label.id), false);
  assert.ok(!JSON.stringify(theirs).includes("Lune House"));
  // Staff previews see every coffee, marked as white label.
  const preview = (await products(ADMIN)).find((p) => p.id === label.id);
  assert.equal(preview.whiteLabel, true);
});

test("Another business can't order it; its own business gets its price, and only staff see the recipe", async () => {
  const refused = await order(B, label.id);
  assert.equal(refused.status, 400);
  const placed = await order(A, label.id);
  assert.equal(placed.status, 201, placed.text);
  const o = placed.body.order;
  assert.equal(o.lines[0].price, 2150);
  assert.equal(Object.hasOwn(o.lines[0], "recipe"), false, "the customer's receipt has no recipe");
  const history = (await call("GET", "/api/wholesale/orders", undefined, A)).body;
  assert.ok(!JSON.stringify(history).includes("Bom Jesus"));
  const admin = (await call("GET", "/api/admin/wholesale")).body.orders.find((row) => row.id === o.id);
  assert.equal(admin.lines[0].recipe, "60% Brazil · 40% Bom Jesus");
  const staff = (await call("GET", "/api/staff-orders/orders")).body.orders.find((row) => row.id === o.id);
  assert.equal(staff.lines[0].recipe, "60% Brazil · 40% Bom Jesus");
  const printed = (await call("GET", `/api/admin/wholesale/orders/print?ids=${o.id}`)).body;
  assert.ok(JSON.stringify(printed).includes("40% Bom Jesus"));
  // A recipe change later doesn't rewrite the order.
  const changed = await call("PUT", `/api/admin/wholesale/catalogue/${label.id}`, { title: label.title, name: label.name, origin: label.origin, process: label.process, notes: label.notes, categories: label.categories, prices: label.prices, active: true, inStock: true, ifVersion: label.version, recipe: [{ coffee: "brazil", name: "Brazil", percent: 100 }] });
  assert.equal(changed.status, 200, changed.text);
  label = changed.body.product;
  assert.equal((await call("GET", "/api/admin/wholesale")).body.orders.find((row) => row.id === o.id).lines[0].recipe, "60% Brazil · 40% Bom Jesus");
});

test("Edit bags can't add someone else's white label; it can add the business's own", async () => {
  const placed = (await order(B, "brazil")).body.order;
  const lines = [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6 }, { productId: label.id, pack: "kilo", grind: "beans", quantity: 1 }];
  assert.equal((await call("PUT", `/api/admin/wholesale/orders/${placed.id}/lines`, { ifVersion: placed.version, lines })).status, 400);
  const own = (await order(A, "brazil")).body.order;
  const amended = await call("PUT", `/api/admin/wholesale/orders/${own.id}/lines`, { ifVersion: own.version, lines });
  assert.equal(amended.status, 200, amended.text);
  assert.equal(amended.body.order.lines.find((l) => l.productId === label.id).recipe, "100% Brazil");
  const seen = (await call("GET", "/api/wholesale/orders", undefined, A)).body;
  assert.ok(!JSON.stringify(seen).includes("100% Brazil"));
});

test("Taking the white label off puts it back in everyone's range", async () => {
  const opened = await call("PUT", `/api/admin/wholesale/catalogue/${label.id}`, { title: label.title, name: label.name, origin: label.origin, process: label.process, notes: label.notes, categories: label.categories, prices: label.prices, active: true, inStock: true, ifVersion: label.version, whiteLabel: [] });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(Object.hasOwn(opened.body.product, "whiteLabel"), false);
  assert.ok((await products(B)).some((p) => p.id === label.id && !p.yours));
});
