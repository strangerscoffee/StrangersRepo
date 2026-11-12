// Admin → Wholesale → Insights (src/insights.ts): site orders plus QuickBooks history, imported in chunks without
// counting anything twice; product names matched to coffees and bag sizes; roasting settings; history stopping where
// site orders start; removing an import; and admins only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addDays, mondayOf, ukDay } from "../src/insightsMath.ts";

let srv, ADMIN, A, STAFF;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const today = ukDay(Date.now()), thisWeek = mondayOf(today);
const historyRows = () => {
  const rows = [];
  for (let i = 30; i >= 1; i--) {
    const date = addDays(thisWeek, -7 * i + 1);
    rows.push({ date, type: "Invoice", num: `INV-${i}`, customer: "Café Lune", product: "Campo Santo 1kg", qty: 8, pence: 19200, n: 1 });
    rows.push({ date, type: "Invoice", num: `INV-${i}`, customer: "Café Lune", product: "Delivery", qty: 1, pence: 744, n: 1 });
    if (i % 2) rows.push({ date, type: "Invoice", num: `INV-B${i}`, customer: "Bakehouse", product: "Rosalina 250g", qty: 12, pence: 7500, n: 1 });
  }
  rows.push({ date: addDays(thisWeek, -20), type: "Credit Note", num: "CN-1", customer: "Café Lune", product: "Campo Santo 1kg", qty: -1, pence: -2400, n: 1 });
  return rows;
};

before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const staff = await call("POST", "/api/admin/users", { name: "Shop Staff", username: "shop.staff", role: "staff" });
  STAFF = (await call("POST", "/api/auth/login", { username: "shop.staff", password: staff.body.temporaryPassword }, null)).cookie;
  const credentials = { username: "insight.buyer", password: "insight-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café Lune", contact: "Sam", email: "lune@example.com" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  for (const lines of [[{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], [{ productId: "rosalina", pack: "quarter", grind: "filter", quantity: 12, price: 625 }]]) {
    const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
    const r = await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines, delivery: "Roastery collection", reference: "", customerVersion: session.customer.version }, A);
    assert.equal(r.status, 201, r.text);
  }
});
after(async () => { await srv?.stop(); });

test("site orders on their own: this week's sales, open orders in the roast plan in whole batches", async () => {
  const r = await call("GET", "/api/admin/wholesale/insights");
  assert.equal(r.status, 200, r.text);
  const ins = r.body;
  assert.equal(ins.sources.siteOrders, 2); assert.equal(ins.sources.historyRows, 0);
  assert.deepEqual(ins.settings, { batchKg: 10, yieldKg: 8, historyUntil: null, version: 0 });
  const week = ins.weekly.at(-1);
  assert.equal(week.week, thisWeek); assert.equal(week.grams, 9000); assert.equal(week.pence, 6 * 1800 + 12 * 625); assert.equal(week.orders, 2);
  const campo = ins.roast.rows.find((x) => x.key === "campo");
  assert.deepEqual([campo.openGrams, campo.batches, campo.greenKg], [6000, 1, 10]);
  assert.equal(ins.customers[0].name, "Café Lune");
});

test("QuickBooks history: imported in chunks, nothing counted twice, products guessed then confirmed", async () => {
  const rows = historyRows(), importId = crypto.randomUUID();
  let added = 0;
  for (let i = 0; i < rows.length; i += 40) added += (await call("POST", "/api/admin/wholesale/insights/history/rows", { importId, fileName: "sales.xlsx", offset: i, rows: rows.slice(i, i + 40) })).body.added;
  assert.equal(added, rows.length);
  const again = await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: crypto.randomUUID(), fileName: "sales again.xlsx", rows: rows.slice(0, 40) });
  assert.deepEqual([again.body.added, again.body.skipped], [0, 40], "the same lines again add nothing");
  const twice = await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: crypto.randomUUID(), fileName: "dupes.csv", rows: [{ ...rows[0], n: 2 }] });
  assert.equal(twice.body.added, 1, "a second identical line in the same report does count");

  const h = (await call("GET", "/api/admin/wholesale/insights/history")).body;
  const map = Object.fromEntries(h.products.map((p) => [p.product, p.mapping]));
  assert.deepEqual([map["Campo Santo 1kg"].coffee, map["Campo Santo 1kg"].pack, map["Campo Santo 1kg"].reviewed], ["campo", "kilo", false]);
  assert.deepEqual([map["Rosalina 250g"].coffee, map["Rosalina 250g"].pack], ["rosalina", "quarter"]);
  assert.equal(map["Delivery"].pack, "ignore");
  assert.deepEqual(h.imports.map((x) => x.fileName).sort(), ["dupes.csv", "sales.xlsx"], "a file that added nothing isn't listed");

  let ins = (await call("GET", "/api/admin/wholesale/insights")).body;
  assert.equal(ins.sources.unreviewedProducts, 3);
  assert.equal(ins.sources.historyUntil, today, "history stops where site orders start");
  const lastWeekGrams = ins.weekly.find((w) => w.week === addDays(thisWeek, -7)).grams;
  assert.equal(lastWeekGrams, 8000 + 3000, "Campo 8 × 1 kg + Rosalina 12 × 250 g; delivery isn't coffee");
  assert.ok(ins.weekly.length >= 31);
  const fcCampo = ins.forecast.byCoffee.find((c) => c.key === "campo");
  assert.ok(fcCampo.weeks[0].grams > 5000 && fcCampo.weeks[0].grams < 11000, String(fcCampo.weeks[0].grams));
  assert.equal(ins.forecast.total.basis, "recent");
  assert.ok(ins.customers.some((c) => c.name === "Bakehouse" && c.usualDays === 14));

  // Confirm: Rosalina is really a 227 g retail bag here, and Delivery stays out.
  const saved = await call("PUT", "/api/admin/wholesale/insights/history/products", { mappings: [
    { product: "Campo Santo 1kg", coffee: "campo", title: "Colombia Campo Santo Washed", pack: "kilo" },
    { product: "Rosalina 250g", coffee: "rosalina", title: "Honduras Rosalina Ramos Natural", pack: "other", grams: 227 },
    { product: "Delivery", pack: "ignore" }] });
  assert.equal(saved.status, 200, saved.text);
  ins = (await call("GET", "/api/admin/wholesale/insights")).body;
  assert.equal(ins.sources.unreviewedProducts, 0);
  assert.equal(ins.weekly.find((w) => w.week === addDays(thisWeek, -7)).grams, 8000 + 12 * 227);
  for (const bad of [{ product: "Delivery", pack: "other", coffee: "campo", grams: 0 }, { product: "Delivery", pack: "litre" }]) {
    assert.equal((await call("PUT", "/api/admin/wholesale/insights/history/products", { mappings: [bad] })).status, 400, JSON.stringify(bad));
  }
});

test("rows are checked: only sales, real dates, sensible numbers, up to 500 at a time", async () => {
  const id = crypto.randomUUID(), row = { date: "2026-01-05", type: "Invoice", num: "1", customer: "X", product: "Campo Santo 1kg", qty: 1, pence: 2400, n: 1 };
  for (const bad of [{ type: "Payment" }, { date: "05/01/2026" }, { date: "2026-02-30" }, { product: "" }, { pence: 12.5 }, { qty: "lots" }]) {
    assert.equal((await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: id, fileName: "x.csv", rows: [{ ...row, ...bad }] })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: id, fileName: "x.csv", rows: Array(501).fill(row) })).status, 400);
  assert.equal((await call("POST", "/api/admin/wholesale/insights/history/rows", { importId: "nope", fileName: "x.csv", rows: [row] })).status, 400);
});

test("roasting settings and where history stops; versioned", async () => {
  let s = (await call("GET", "/api/admin/wholesale/insights")).body.settings;
  assert.equal((await call("PUT", "/api/admin/wholesale/insights/settings", { ifVersion: s.version, batchKg: 10, yieldKg: 12, historyUntil: null })).status, 400, "can't roast more than went in");
  assert.equal((await call("PUT", "/api/admin/wholesale/insights/settings", { ifVersion: 7, batchKg: 12, yieldKg: 10, historyUntil: null })).status, 409);
  const until = addDays(thisWeek, -14);
  s = (await call("PUT", "/api/admin/wholesale/insights/settings", { ifVersion: s.version, batchKg: 12, yieldKg: 10, historyUntil: until })).body;
  assert.deepEqual([s.batchKg, s.yieldKg, s.historyUntil, s.version], [12, 10, until, 1]);
  const ins = (await call("GET", "/api/admin/wholesale/insights")).body;
  assert.equal(ins.weekly.find((w) => w.week === addDays(thisWeek, -7)).grams, 0, "history after the cut-off isn't used");
  assert.ok(ins.weekly.find((w) => w.week === addDays(thisWeek, -21)).grams > 0);
  assert.equal(ins.roast.yieldKg, 10);
  for (const r of ins.roast.rows) assert.equal(r.greenKg, r.batches * 12);
});

test("removing an import takes its lines (and products only it had) out", async () => {
  const h = (await call("GET", "/api/admin/wholesale/insights/history")).body;
  const main = h.imports.find((x) => x.fileName === "sales.xlsx");
  assert.equal((await call("DELETE", `/api/admin/wholesale/insights/history/imports/${main.id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/admin/wholesale/insights/history/imports/${main.id}`)).status, 404);
  const after = (await call("GET", "/api/admin/wholesale/insights/history")).body;
  assert.deepEqual(after.imports.map((x) => x.fileName), ["dupes.csv"]);
  assert.ok(!after.products.some((p) => p.product === "Rosalina 250g"), "only the removed file had it");
});

test("admins only: staff, customers and signed-out requests can't read or change Insights", async () => {
  for (const cookie of [STAFF, A, null]) {
    for (const [method, path, body] of [["GET", "/api/admin/wholesale/insights"], ["GET", "/api/admin/wholesale/insights/history"], ["POST", "/api/admin/wholesale/insights/history/rows", { importId: crypto.randomUUID(), fileName: "x", rows: [] }], ["PUT", "/api/admin/wholesale/insights/settings", { ifVersion: 0 }]]) {
      const r = await call(method, path, body, cookie);
      assert.ok([401, 403].includes(r.status), `${method} ${path}: ${r.status}`);
      assert.ok(!r.text.includes("Café Lune"));
    }
  }
});
