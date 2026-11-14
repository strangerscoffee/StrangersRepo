import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { appForHost, appLinks, isPreviewFile, unifiedSignin } from "../src/hosts.ts";

let srv, ADMIN, STAFF, OTHER, MANAGER;
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sfbb_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN, base = srv.base, extraHeaders = {}) {
  const response = await fetch(base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, headers: response.headers, body: data, text };
}
async function setup(base) {
  const response = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Preview Owner", username: "owner", password: "preview-owner-pass", code: SETUP_CODE }) });
  assert.equal(response.status, 200); return cookieOf(response);
}
async function person(name, username, role) {
  assert.equal((await call("POST", "/api/admin/users", { name, username, role, password: "temporary-pass" })).status, 200);
  const response = await fetch(srv.base + "/api/auth/change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "temporary-pass", newPassword: username + "-own-password" }) });
  assert.equal(response.status, 200); return cookieOf(response);
}
const payload = (values = {}) => ({ requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 2, price: 500 }], business: "Preview café", delivery: "Delivery", reference: "PO preview", ...values });

before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = await setup(srv.base);
  STAFF = await person("Preview Staff", "staff", "staff");
  OTHER = await person("Other Staff", "other", "staff");
  MANAGER = await person("Preview Manager", "manager", "manager");
});
after(async () => { await srv?.stop(); });

test("wholesale: keeps the existing hostname and isolates customer and staff ordering", async () => {
  const host = "preview.staffstrangerscoffee.com";
  assert.equal(appForHost(host, undefined, undefined, host), "preview");
  assert.equal(appForHost(host.toUpperCase(), undefined, undefined, host), "preview");
  const links = appLinks(new URL(`https://${host}/`), "rota.staffstrangerscoffee.com", "admin.staffstrangerscoffee.com", host);
  assert.deepEqual(links, { rota: "https://rota.staffstrangerscoffee.com/", diary: "https://staffstrangerscoffee.com/", admin: "https://admin.staffstrangerscoffee.com/", preview: "/" });
  assert.equal(unifiedSignin(new URL(`https://${host}/signin?next=%2F%3Forder%3D1`), "staffstrangerscoffee.com"), `https://staffstrangerscoffee.com/signin?next=https%3A%2F%2F${host}%2F%3Forder%3D1`);
  assert.ok(isPreviewFile("/wholesale/wholesale.js") && isPreviewFile("/wholesale/images/house.jpg") && isPreviewFile("/shared/core.js"));
  for (const path of ["/wholesale/", "/wholesale/dashboard/index.html", "/diary/core.js", "/admin/admin.js"]) assert.equal(isPreviewFile(path), false, path);
  // Wrangler rewrites the local request hostname to the first configured custom domain.
  const preview = await startServer({ vars: { PREVIEW_HOST: "staffstrangerscoffee.com" } });
  try {
    const owner = await setup(preview.base);
    const signin = await call("GET", "/signin", undefined, null, preview.base);
    assert.equal(signin.status, 200); assert.match(signin.text, /Wholesale sign-in/); assert.doesNotMatch(signin.text, /Wholesale Beta|beta-badge/); assert.match(signin.text, /\/theme.css\?v=/);
    const theme = await call("GET", "/theme.css", undefined, null, preview.base);
    assert.equal(theme.status, 200); assert.match(theme.headers.get("content-type"), /text\/css/);
    assert.match(theme.text, /--glass/);
    const signedOut = await call("GET", "/", undefined, null, preview.base);
    assert.equal(signedOut.status, 302); assert.equal(signedOut.headers.get("location"), "/signin");
    for (const path of ["/", "/index.html"]) {
      const page = await call("GET", path, undefined, owner, preview.base);
      assert.equal(page.status, 200); assert.match(page.text, /<h1>Wholesale<\/h1>/); assert.doesNotMatch(page.text, /Wholesale Beta|beta-badge/); assert.doesNotMatch(page.text, /By the kilo/); assert.match(page.text, /\/wholesale\/wholesale.js\?v=/);
      assert.equal(page.headers.get("cache-control"), "private, no-store");
    }
    for (const path of ["/api/db/get", "/api/rota/week", "/api/admin/wholesale"]) assert.equal((await call("GET", path, undefined, owner, preview.base)).status, 404, path);
    assert.equal((await call("GET", "/diary/core.js", undefined, owner, preview.base)).headers.get("location"), "/");
    assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, owner, preview.base)).status, 200);
    assert.equal((await call("POST", "/api/wholesale/orders", payload(), owner, preview.base)).status, 201);
    assert.equal((await call("GET", "/wholesale/dashboard/", undefined, owner, preview.base)).headers.get("location"), "/admin#wholesale");
  } finally { await preview.stop(); }
});

test("wholesale: catalogue, ordering pages and every management route require the right session", async () => {
  const signin = await call("GET", "/wholesale/signin", undefined, null);
  assert.equal(signin.status, 200); assert.match(signin.text, /Request a wholesale account/);
  assert.equal((await call("GET", "/wholesale/staff-signin", undefined, null)).headers.get("location"), "/signin?next=%2Fwholesale%2F");
  for (const path of ["/wholesale/", "/wholesale/index.html"]) assert.equal((await call("GET", path, undefined, null)).status, 302);
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, null)).status, 401);
  assert.equal((await call("POST", "/api/wholesale/orders", payload(), null)).status, 401);
  const data = (await call("GET", "/api/wholesale/catalogue", undefined, STAFF)).body;
  assert.equal(data.products.length, 14); assert.equal(data.products[0].prices.quarter, 500); assert.equal(data.preview, true); assert.equal(data.stage, "beta");
  for (const cookie of [STAFF, MANAGER]) for (const [method, path, body] of [
    ["GET", "/api/admin/wholesale"], ["POST", "/api/admin/wholesale/customers", {}],
    ["PUT", "/api/admin/wholesale/catalogue/brazil", {}], ["PATCH", "/api/admin/wholesale/orders/PREVIEW-" + "A".repeat(32), {}],
    ["PUT", "/api/admin/wholesale/customers/" + crypto.randomUUID(), {}],
  ]) {
    const result = await call(method, path, body, cookie);
    assert.equal(result.status, 403, `${method} ${path}`); assert.equal(result.body.code, "permission_denied");
  }
  const old = await call("GET", "/wholesale/dashboard/");
  assert.equal(old.status, 302); assert.equal(old.headers.get("location"), "/admin#wholesale");
  assert.equal((await call("GET", "/wholesale/dashboard/", undefined, STAFF)).status, 403);
  const foreign = await call("POST", "/api/wholesale/orders", payload(), STAFF, srv.base, { origin: "https://another.example" });
  assert.equal(foreign.status, 403); assert.equal(foreign.body.code, "bad_origin");
});

test("wholesale: checkout saves shared, server-priced orders once, with owner-only reads", async () => {
  const body = payload();
  const first = await call("POST", "/api/wholesale/orders", body, STAFF);
  assert.equal(first.status, 201, first.text);
  const order = first.body.order;
  assert.equal(order.pence, 1000); assert.equal(order.grams, 500); assert.equal(order.status, "New"); assert.equal(order.createdName, "Preview Staff");
  assert.equal(order.lines[0].title, "Brazil Fazenda Bom Jesus Natural"); assert.ok(order.createdAt > Date.now() - 10000);
  assert.equal(order.requestKey, undefined, "idempotency hash stays server-side");
  assert.equal((await call("POST", "/api/wholesale/orders", body, STAFF)).body.order.id, order.id);
  const concurrent = payload();
  const results = await Promise.all([call("POST", "/api/wholesale/orders", concurrent, STAFF), call("POST", "/api/wholesale/orders", concurrent, STAFF)]);
  assert.ok(results.every((result) => result.status === 200 || result.status === 201));
  assert.equal(results[0].body.order.id, results[1].body.order.id);
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, OTHER)).status, 404);
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, STAFF)).body.order.id, order.id);
  assert.equal((await call("POST", "/api/wholesale/orders", { ...body, reference: "Different attempt" }, STAFF)).status, 409);
  assert.equal((await call("POST", "/api/wholesale/orders", body, OTHER)).status, 409);
  const dashboard = (await call("GET", "/api/admin/wholesale")).body;
  assert.ok(dashboard.orders.some((record) => record.id === order.id));
});

test("wholesale: quantities, unknown variants and forged prices cannot enter a preview order", async () => {
  for (const line of [
    { productId: "unknown", quantity: 1 }, { pack: "case", quantity: 1 }, { grind: "__proto__", quantity: 1 },
    { quantity: -2 }, { quantity: 1.5 }, { quantity: 1000 }, { price: 1 },
  ]) {
    const normal = payload(); normal.lines[0] = { ...normal.lines[0], ...line };
    const result = await call("POST", "/api/wholesale/orders", normal, STAFF);
    assert.ok(result.status === 400 || result.status === 409, result.text);
  }
  assert.equal((await call("POST", "/api/wholesale/orders", payload({ lines: [], createdName: "Forged Admin" }), STAFF)).status, 400);
  const normal = payload(); normal.lines = [{ ...normal.lines[0], quantity: 999 }, normal.lines[0]];
  assert.equal((await call("POST", "/api/wholesale/orders", normal, STAFF)).status, 400);
});

test("wholesale: catalogue overrides are shared, checked at checkout and keep historical prices", async () => {
  const before = (await call("POST", "/api/wholesale/orders", payload(), STAFF)).body.order;
  const product = (await call("GET", "/api/admin/wholesale")).body.products.find((coffee) => coffee.id === "brazil");
  const edit = { ifVersion: product.version, prices: { quarter: 1250, half: 2100, kilo: 3700 }, active: true };
  assert.equal((await call("PUT", "/api/admin/wholesale/catalogue/brazil", edit)).status, 200);
  assert.equal((await call("PUT", "/api/admin/wholesale/catalogue/brazil", edit)).status, 409, "stale edits are refused");
  assert.equal((await call("GET", "/api/wholesale/catalogue", undefined, OTHER)).body.products[0].prices.quarter, 1250);
  assert.equal((await call("POST", "/api/wholesale/orders", payload(), STAFF)).status, 409, "old quoted price cannot be submitted");
  assert.equal((await call("GET", "/api/wholesale/orders/" + before.id, undefined, STAFF)).body.order.pence, 1000);
  const updated = (await call("GET", "/api/admin/wholesale")).body.products[0];
  assert.equal((await call("PUT", "/api/admin/wholesale/catalogue/brazil", { ifVersion: updated.version, prices: updated.prices, active: false })).status, 200);
  const hidden = payload(); hidden.lines[0].price = 1250;
  assert.equal((await call("POST", "/api/wholesale/orders", hidden, STAFF)).status, 409);
  const current = (await call("GET", "/api/admin/wholesale")).body.products[0];
  await call("PUT", "/api/admin/wholesale/catalogue/brazil", { ifVersion: current.version, prices: { quarter: 500, half: 2100, kilo: 1800 }, active: true });
});

test("wholesale: admin customers and statuses persist and reject concurrent stale edits", async () => {
  const customer = (await call("POST", "/api/admin/wholesale/customers", { business: "Preview customer", contact: "Example", email: "test@example.test", status: "Active", note: "Preview only" })).body.customer;
  const order = (await call("POST", "/api/wholesale/orders", payload(), STAFF)).body.order;
  const edit = { ifVersion: order.version, status: "Preparing", customerId: customer.id, note: "Testing shared management" };
  assert.equal((await call("PATCH", "/api/admin/wholesale/orders/" + order.id, edit)).status, 200);
  assert.equal((await call("PATCH", "/api/admin/wholesale/orders/" + order.id, edit)).status, 409);
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, STAFF)).body.order.status, "Preparing");
  const customerEdit = { ...customer, ifVersion: customer.version, status: "On hold" };
  assert.equal((await call("PUT", "/api/admin/wholesale/customers/" + customer.id, customerEdit)).status, 200);
  assert.equal((await call("PUT", "/api/admin/wholesale/customers/" + customer.id, customerEdit)).status, 409);
  const dashboard = (await call("GET", "/api/admin/wholesale")).body;
  assert.equal(dashboard.customers.find((record) => record.id === customer.id).status, "On hold");
  assert.equal(dashboard.orders.find((record) => record.id === order.id).customerId, customer.id);
  const backup = (await call("POST", "/api/admin/backups", {})).body.backup;
  const restored = (await call("GET", "/api/admin/backups/" + backup.id)).body;
  assert.ok(restored.wholesalePreview.some((record) => record.kind === "order" && record.id === order.id));
  assert.ok(restored.wholesalePreview.some((record) => record.kind === "customer" && record.id === customer.id));
  const activity = await call("GET", "/api/admin/activity");
  assert.equal(activity.status, 200);
});

test("wholesale: delivery is charged by the server (£7.44 inc VAT under £250, free from £250, none on collection) and 500 g bags are refused", async () => {
  const place = async (values) => { const r = await call("POST", "/api/wholesale/orders", payload(values), STAFF); assert.equal(r.status, 201, r.text); return r.body.order; };
  const small = await place({});
  assert.deepEqual([small.pence, small.deliveryPence, small.totalPence], [1000, 744, 1744]);
  const collect = await place({ delivery: "Roastery collection" });
  assert.deepEqual([collect.deliveryPence, collect.totalPence], [0, 1000]);
  const big = await place({ lines: [{ productId: "ethiopia", pack: "kilo", grind: "beans", quantity: 7, price: 3600 }] }); // £252
  assert.deepEqual([big.pence, big.deliveryPence, big.totalPence], [25200, 0, 25200]);
  const exact = await place({ lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 50, price: 500 }] }); // £250 exactly
  assert.equal(exact.deliveryPence, 0);
  // The charge is the server's: a client can't send its own.
  const forged = await place({ deliveryPence: 0, totalPence: 1 });
  assert.deepEqual([forged.deliveryPence, forged.totalPence], [744, 1744]);
  // An exact retry returns the original order, charge included.
  const body = payload(); const first = await call("POST", "/api/wholesale/orders", body, STAFF), again = await call("POST", "/api/wholesale/orders", body, STAFF);
  assert.equal(again.status, 200); assert.equal(again.body.order.deliveryPence, first.body.order.deliveryPence);
  // 500 g bags are no longer sold.
  const half = await call("POST", "/api/wholesale/orders", payload({ lines: [{ productId: "brazil", pack: "half", grind: "beans", quantity: 1, price: 2100 }] }), STAFF);
  assert.equal(half.status, 409); assert.equal(half.body.code, "pack_unavailable"); assert.match(half.body.message, /500 g bags are no longer available/);
});

test("wholesale: large orders: up to 999 bags of one coffee, size and grind, and they invoice", async () => {
  const big = await call("POST", "/api/wholesale/orders", payload({ lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 250, price: 1800 }] }), STAFF);
  assert.equal(big.status, 201, big.text);
  assert.deepEqual([big.body.order.packs, big.body.order.grams, big.body.order.pence, big.body.order.deliveryPence], [250, 250000, 450000, 0]);
  const most = await call("POST", "/api/wholesale/orders", payload({ lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 999, price: 500 }] }), STAFF);
  assert.equal(most.status, 201, most.text);
  const tooMany = await call("POST", "/api/wholesale/orders", payload({ lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 1000, price: 500 }] }), STAFF);
  assert.equal(tooMany.status, 400); assert.match(tooMany.body.message, /1 to 999/);
});
