// Orders already invoiced in QuickBooks (the owner's request, 26 Nov 2026): invoices raised by hand in QuickBooks before
// automatic invoicing are matched to their orders, so the orders stop showing as unbilled, without the website issuing,
// posting or emailing anything.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pairUp } from "../src/invoicing/quickbooksMatchMath.ts";
import { startServer, SETUP_CODE } from "./harness.mjs";

const at = (date, time = "10:00") => Date.parse(`${date}T${time}:00Z`);
const order = (id, business, totalPence, created, dispatched, extra = {}) => ({ id, version: 3, customerId: "c-" + business, business, quickbooksName: null,
  totalPence, createdAt: at(created), dispatchedAt: dispatched ? at(dispatched) : null, onTab: 0, ...extra });
const invoice = (id, customerName, totalPence, date, number = id) => ({ id, number, date, totalPence, customerId: "q-" + customerName, customerName, balancePence: totalPence });

test("pairs each order with one QuickBooks invoice: same customer and total, dated around the order", () => {
  const orders = [
    order("A", "The Old Dairy", 49600, "2026-11-16", null),
    order("B", "The Old Dairy", 49600, "2026-11-17", "2026-11-24"),
    order("C", "The Green Grocers", 61725, "2026-11-23", "2026-11-24"),
    order("D", "The Weavers Arms", 1800, "2026-11-19", "2026-11-19"),
    order("E", "Ribs", 10800, "2026-11-16", "2026-11-24", { quickbooksName: "The Ribs of Beef" }),
    order("F", "SRAM", 2400, "2026-11-23", "2026-11-23"),
    order("G", "Linked Ltd", 5000, "2026-11-20", "2026-11-20"),
    order("H", "Café Ümlaut", 3000, "2026-11-20", "2026-11-20"),
  ];
  const remote = [
    invoice("10237", "The Old Dairy", 49600, "2026-11-23"),
    invoice("10205", "The Old Dairy", 49600, "2026-11-17"),
    invoice("10231", "The Green Grocers", 54225, "2026-11-23"),
    invoice("10197", "The Weavers Arms", 1800, "2026-11-16"),
    invoice("10206", "The Ribs of Beef", 10800, "2026-11-17"),
    invoice("10225", "SRAM", 0, "2026-11-23"),
    { ...invoice("900", "Something else in QuickBooks", 5000, "2026-11-21"), customerId: "q-linked" },
    invoice("901", "Cafe Umlaut", 3000, "2026-11-20"),
    invoice("902", "Cafe Umlaut", 3000, "2026-11-20", "already-used"),
  ];
  const result = Object.fromEntries(pairUp(orders, remote, { "c-Linked Ltd": "q-linked" }, new Set(["902"]), "2026-11-26").map(s => [s.orderId, s]));
  assert.deepEqual([result.A.match, result.A.invoice.id], ["exact", "10205"], "the first order takes the earlier invoice");
  assert.deepEqual([result.B.match, result.B.invoice.id], ["exact", "10237"]);
  assert.deepEqual([result.C.match, result.C.invoice.id], ["amount", "10231"], "a different total is offered, not assumed");
  assert.equal(result.D.match, "none", "an invoice from before the order was placed isn't its invoice");
  assert.deepEqual([result.E.match, result.E.invoice.id], ["exact", "10206"], "the QuickBooks name is used");
  assert.equal(result.F.match, "none", "a voided (£0) invoice never counts");
  assert.deepEqual([result.G.match, result.G.invoice.id], ["exact", "900"], "a linked QuickBooks customer matches whatever it's called");
  assert.deepEqual([result.H.match, result.H.invoice.id], ["exact", "901"], "accents and punctuation are ignored; used invoices aren't offered again");
});

test("an invoice too long after dispatch, or for another customer, isn't offered", () => {
  const [late] = pairUp([order("A", "Flint", 12000, "2026-11-01", "2026-11-02")], [invoice("1", "Flint", 12000, "2026-11-20")], {}, new Set(), "2026-11-26");
  assert.equal(late.match, "none");
  const [other] = pairUp([order("A", "Flint", 12000, "2026-11-21", "2026-11-21")], [invoice("1", "Flintstones", 12000, "2026-11-21")], {}, new Set(), "2026-11-26");
  assert.equal(other.match, "none");
});

let srv, ADMIN, STAFF;
const root = "/api/admin/wholesale";
const cookieOf = r => (r.headers.getSetCookie().find(v => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, text, cookie: cookieOf(r) };
}
async function ok(method, path, body, cookie = ADMIN) { const r = await call(method, path, body, cookie); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`); return r; }
before(async () => {
  srv = await startServer({ writeLimit: 4000 });
  ADMIN = (await ok("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await ok("POST", "/api/admin/users", { name: "Pat", username: "pat", role: "staff", password: "temporary-password" });
  STAFF = (await ok("POST", "/api/auth/change", { username: "pat", password: "temporary-password", newPassword: "pat-password-1" }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("a matched order stops showing as unbilled and can be taken back; only admins, only with QuickBooks Live", async () => {
  const customer = (await ok("POST", root + "/customers", { business: "Matched Cafe", contact: "Sam", email: "matched@example.test", address: "1 Road", postcode: "NR1 1AA", status: "Active" })).body.customer;
  const account = (await ok("POST", `${root}/customers/${customer.id}/account`, { username: "matchedcafe" })).body;
  const buyer = (await ok("POST", "/api/wholesale/auth/change-password", { username: "matchedcafe", password: account.temporaryPassword, newPassword: "buyer-password-1" }, null)).cookie;
  const profile = (await ok("GET", "/api/wholesale/session", undefined, buyer)).body.customer;
  let placed = (await ok("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), customerVersion: profile.version, delivery: "Roastery collection", lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 2, price: 1800 }] }, buyer)).body.order;
  placed = (await ok("PATCH", `${root}/orders/${placed.id}`, { ifVersion: placed.version, status: "Dispatched", customerId: placed.customerId, note: "" })).body.order;
  const period = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()).slice(0, 7);
  const unbilled = async () => (await ok("GET", `${root}/invoicing/reconciliation?period=${period}`)).body.orders.unbilled;
  const candidates = async () => (await ok("GET", `${root}/invoicing/batches?period=${period}`)).body.candidates.map(c => c.id);
  assert.equal(await unbilled(), 1);
  assert.deepEqual(await candidates(), [placed.id]);

  for (const cookie of [null, STAFF]) assert.ok([401, 403].includes((await call("GET", root + "/invoicing/quickbooks-matches", undefined, cookie)).status));
  assert.ok([401, 403].includes((await call("POST", root + "/invoicing/quickbooks-matches", { matches: [] }, STAFF)).status));
  const notLive = await call("GET", root + "/invoicing/quickbooks-matches");
  assert.deepEqual([notLive.status, notLive.body.code], [409, "quickbooks_live_required"], "never matched against Sandbox");
  assert.equal((await call("POST", root + "/invoicing/quickbooks-matches", { matches: [{ orderId: "nope" }] })).status, 400);

  // What a confirmed match records (the Live read itself is covered by the pairing tests above).
  srv.sql(`INSERT INTO wholesale_invoiced_elsewhere(order_id,customer_id,environment,realm_id,remote_id,doc_number,txn_date,total_pence,order_total_pence,actor,created_at)
    VALUES ('${placed.id}','${customer.id}','production','realm','58925','10224','2026-11-21',3600,3600,'Owner',${Date.now()})`);
  assert.equal(await unbilled(), 0, "no longer an unbilled dispatch");
  assert.deepEqual(await candidates(), [], "not offered for a batch");
  const old = (await ok("GET", root + "/invoice-settings")).body;
  const config = (await ok("PUT", root + "/invoice-settings", { ifVersion: old.version, seller: { legalName: "Example Merchant Ltd", address: "Test merchant address", vatNumber: "GB123456789", companyNumber: "", email: "accounts@merchant.example", phone: "" }, priceBasis: "inclusive", vatRates: [{ id: "standard", label: "Standard", basisPoints: 2000 }, { id: "zero", label: "Zero rated", basisPoints: 0 }], defaultCoffeeRateId: "zero", deliveryRateId: "standard", invoicePrefix: "AU-", firstInvoiceNumber: 1, paymentInstructions: "Test bank instructions", confirmed: true })).body;
  const issue = await call("POST", `${root}/orders/${placed.id}/invoice`, { orderVersion: placed.version, settingsVersion: config.version, invoiceDate: "2026-11-21", supplyDate: "2026-11-21" });
  assert.equal(issue.status, 409, "and the website won't invoice it again: " + issue.text);
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM wholesale_invoices")[0].n, 0, "no invoice or number used");

  const undone = await ok("DELETE", `${root}/invoicing/quickbooks-matches/${placed.id}`);
  assert.equal(undone.body.removed, true);
  assert.equal(await unbilled(), 1, "taking it back makes it unbilled again");
  assert.equal((await call("DELETE", `${root}/invoicing/quickbooks-matches/${placed.id}`)).status, 404);
  assert.ok(srv.sql("SELECT COUNT(*) AS n FROM audit_log WHERE kind='wholesale_invoiced_elsewhere'")[0].n >= 1);
});
