// Orders already invoiced in QuickBooks (the owner's request, 26 Nov 2026): invoices raised by hand in QuickBooks before
// automatic invoicing are matched to their orders, so the orders stop showing as unbilled, without the website issuing,
// posting or emailing anything.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pairUp, ukDay } from "../src/invoicing/quickbooksMatchMath.ts";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { startQuickBooksProvider, quickBooksVars } from "./quickbooks-provider.mjs";

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

test("verified links win over a matching name, while fallback rejects ambiguous identities and foreign currency", () => {
  const today = "2026-11-26";
  const local = order("A", "Café 1", 12000, today, today);
  const named = invoice("1", "Cafe 1", 12000, today);
  const collision = { ...named, id: "2", customerId: "different" };
  const linked = { ...named, id: "3", customerId: "verified", customerName: "Another name" };
  assert.equal(pairUp([local], [named], { [local.customerId]: "verified" }, new Set(), today)[0].match, "none");
  assert.equal(pairUp([local], [named, linked], { [local.customerId]: "verified" }, new Set(), today)[0].invoice.id, "3");
  assert.equal(pairUp([local], [named, collision], {}, new Set(["2"]), today)[0].match, "none");
  assert.equal(pairUp([local], [named], { "another-local": named.customerId }, new Set(), today)[0].match, "none");
  assert.equal(pairUp([local], [{ ...named, currency: "EUR" }], {}, new Set(), today)[0].match, "none");
  assert.equal(pairUp([local], [{ ...named, currency: "" }], {}, new Set(), today)[0].match, "none");
  assert.equal(pairUp([local], [named], {}, new Set(), today, [local, { ...local, customerId: "other" }])[0].match, "none");
});

let srv, provider, ADMIN, STAFF;
const root = "/api/admin/wholesale";
const cookieOf = r => (r.headers.getSetCookie().find(v => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, text, cookie: cookieOf(r) };
}
async function ok(method, path, body, cookie = ADMIN) { const r = await call(method, path, body, cookie); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${r.text}`); return r; }
before(async () => {
  provider = await startQuickBooksProvider();
  srv = await startServer({ writeLimit: 4000, vars: ({ base }) => ({ ...quickBooksVars(provider.origin), QUICKBOOKS_REDIRECT_URI: base + root + "/quickbooks/callback" }) });
  ADMIN = (await ok("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await ok("POST", "/api/admin/users", { name: "Pat", username: "pat", role: "staff", password: "temporary-password" });
  STAFF = (await ok("POST", "/api/auth/change", { username: "pat", password: "temporary-password", newPassword: "pat-password-1" }, null)).cookie;
});
after(async () => { await srv?.stop(); await provider?.stop(); });

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

async function connectFixture() {
  const config = root + "/quickbooks";
  const { body: started } = await ok("POST", config + "/connect?environment=production", {});
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin, provider.origin);
  const callback = await call("GET", config + "/callback?code=test-code&realmId=1234567890&state=" + url.searchParams.get("state"));
  assert.equal(callback.status, 303, callback.text);
  const { body: pending } = await ok("GET", config + "/status?environment=production");
  await ok("POST", config + "/confirm?environment=production", { ifVersion: pending.connection.version, vatNumber: "GB123456789", confirmed: true });
  srv.sql("UPDATE quickbooks_settings SET active_environment='production',version=version+1 WHERE id=1");
}

async function whileReading(work, change) {
  let release;
  provider.state.readGate = { path: "/query", once: true, wait: new Promise(resolve => { release = resolve; }) };
  const before = provider.state.calls.length;
  const started = () => provider.state.calls.slice(before).some(c => c.path.endsWith("/query"));
  const pending = work();
  try {
    for (let n = 0; n < 500 && !started(); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(started(), "the confirmation is waiting for QuickBooks");
    await change();
  } finally { release(); }
  return pending;
}

test("the Live order pages and confirmations use the same pairing, with all-or-none writes against concurrent changes", async () => {
  await connectFixture();
  const route = root + "/invoicing/quickbooks-matches", now = Date.now(), date = ukDay(now), day = 86400000;
  const { body: { customer } } = await ok("POST", root + "/customers", { business: "Bulk Coffee", address: "1 Road", postcode: "NR1 1AA", status: "Active" });
  const { body: { customer: sibling } } = await ok("POST", root + "/customers", { business: "Bulk Coffee Wholesale", address: "2 Road", postcode: "NR1 1AA", status: "Active" });
  const links = JSON.stringify({ customerLinks: { [customer.id]: "5", [sibling.id]: "5" } });
  srv.sql(`INSERT INTO quickbooks_environment_mappings(environment,realm_id,data,version,updated_at)
    VALUES ('production','1234567890','${links}',1,${now})`);
  srv.sql(`WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n<201)
    INSERT INTO wholesale_preview(kind,id,data,version,updated_at)
    SELECT 'order','WS-' || printf('%032X',n),json_object('preview',0,'status','Dispatched',
      'createdAt',CASE WHEN n=201 THEN ${now - day} ELSE ${now - 8 * day} END,'dispatchedAt',CASE WHEN n=201 THEN ${now} ELSE ${now - 7 * day} END,
      'customerId',CASE WHEN n=201 THEN '${sibling.id}' ELSE '${customer.id}' END,'totalPence',n+2000),1,${now} FROM counter`);
  const remote = provider.state.invoices.production;
  remote.set("1201", { Id: "1201", DocNumber: "1201", TxnDate: date, TotalAmt: 22.01, Balance: 0, CustomerRef: { value: "5", name: "Bulk Coffee" } });
  const one = (await ok("GET", route + "?limit=1")).body;
  assert.equal(one.suggestions[0].match, "none", "a linked sibling's exact match on a later page takes precedence over an amount suggestion");
  const siblingOrder = "WS-" + (201).toString(16).toUpperCase().padStart(32, "0");
  await ok("PATCH", `${root}/orders/${siblingOrder}`, { ifVersion: 1, status: "Cancelled", customerId: sibling.id });
  const amount = (await ok("GET", route + "?limit=1")).body;
  assert.equal(amount.suggestions[0].match, "amount");
  const peerAdded = await whileReading(() => call("POST", route, { limit: 1, review: amount.review,
    matches: [{ orderId: amount.suggestions[0].orderId, version: amount.suggestions[0].version, remoteId: "1201" }] }),
  () => ok("PATCH", `${root}/orders/${siblingOrder}`, { ifVersion: 2, status: "Dispatched", customerId: sibling.id }));
  assert.deepEqual([peerAdded.status, peerAdded.body.code], [409, "quickbooks_match_changed"], peerAdded.text);
  for (let n = 1; n <= 10000; n++) {
    const id = String(n + 2000);
    remote.set(id, { Id: id, TxnDate: date, TotalAmt: 1, Balance: 0, CustomerRef: { value: "6", name: "Other Coffee" } });
  }
  const incomplete = (await ok("GET", route + "?limit=1")).body;
  assert.deepEqual([incomplete.complete, incomplete.suggestions.length, incomplete.review], [false, 0, null]);
  assert.ok(incomplete.next, "review can move past an incomplete page");
  const refused = await call("POST", route, { review: one.review, limit: 1, matches: [{ orderId: one.suggestions[0].orderId, version: 1, remoteId: "1201" }] });
  assert.deepEqual([refused.status, refused.body.code], [409, "quickbooks_match_incomplete"]);
  remote.clear();
  for (let n = 1; n <= 201; n++) {
    const id = String(n + 1000);
    remote.set(id, { Id: id, DocNumber: id, TxnDate: n === 201 ? date : ukDay(now - 7 * day), TotalAmt: (n + 2000) / 100, Balance: 0, CustomerRef: { value: "5", name: "Bulk Coffee" }, CurrencyRef: { value: "GBP" } });
  }
  const first = (await ok("GET", route)).body;
  assert.equal(first.complete, true);
  assert.equal(first.suggestions.length, 200);
  const second = (await ok("GET", route + "?after=" + first.next)).body;
  assert.ok(second.suggestions.some(entry => entry.invoice?.id === "1201"));
  const matches = first.suggestions.map(({ orderId, version, invoice }) => ({ orderId, version, remoteId: invoice.id }));
  const before = provider.state.calls.length;
  const stale = await whileReading(() => call("POST", route, { matches, review: first.review }),
    () => ok("PATCH", `${root}/orders/${matches[1].orderId}`, { ifVersion: matches[1].version, status: "Dispatched", customerId: customer.id, note: "Updated during confirmation" }));
  assert.deepEqual([stale.status, stale.body.code], [409, "quickbooks_match_changed"], stale.text);
  assert.equal(srv.sql("SELECT count(*) AS n FROM wholesale_invoiced_elsewhere")[0].n, 0);

  const fresh = (await ok("GET", route)).body;
  const request = { review: fresh.review, matches: fresh.suggestions.map(({ orderId, version, invoice }) => ({ orderId, version, remoteId: invoice.id })) };
  const confirmations = await Promise.all([call("POST", route, request), call("POST", route, request)]);
  assert.deepEqual(confirmations.map(result => result.status).sort(), [200, 409], JSON.stringify(confirmations));

  const remaining = (await ok("GET", route)).body;
  const last = remaining.suggestions.find(entry => entry.invoice?.id === "1201");
  const { body: { modeVersion } } = await ok("GET", root + "/quickbooks/status?environment=production");
  const switched = await whileReading(() => call("POST", route, { review: remaining.review, matches: [{ orderId: last.orderId, version: last.version, remoteId: "1201" }] }),
    () => ok("PUT", root + "/quickbooks/mode", { environment: "sandbox", ifVersion: modeVersion, reviewed: true }));
  assert.deepEqual([switched.status, switched.body.code], [409, "quickbooks_match_changed"], switched.text);
  assert.equal(srv.sql("SELECT count(*) AS n FROM wholesale_invoiced_elsewhere")[0].n, 200);
  assert.ok(provider.state.calls.slice(before).every(c => c.method === "GET"), "matching only reads from QuickBooks");
});
