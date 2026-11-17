// Changing and skipping standing order deliveries (src/wholesaleStanding.ts): customers change the bags on, or skip,
// a delivery of their own standing order until it's dispatched (the minimum order applies; Strangers is emailed and told on Slack);
// staff with wholesale orders access and admins can too; everyone until it's dispatched (New, Preparing or Ready). A change is for this delivery
// only (the next delivery goes back to the usual bags) or every delivery from now on. Nobody sees which staff member.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { addDays, ukDay } from "../src/insightsMath.ts";

let srv, mock, ADMIN, STAFF, OTHER, A, B, staffId;
const sent = [], slack = [];
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
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { (rq.url.startsWith("/slack") ? slack : sent).push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 4000, vars: { WHOLESALE_MINIMUM_ORDER_GRAMS: "6000", RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails`, SLACK_TEST_HOOKS: "1", SLACK_ORDERS_WEBHOOK_URL: `http://127.0.0.1:${mock.address().port}/slack` } });
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
  const mail = () => sent.find((m) => /Café Weekly changed a standing order/.test(m.subject || ""));
  const end = Date.now() + 4000; while (Date.now() < end && !mail()) await wait(100);
  assert.ok(mail(), "Strangers is emailed");
  assert.match(mail().text, /this delivery only/);
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

test("what customers can't do: below the minimum, once it's dispatched, someone else's, a one-off order", async () => {
  const run = await standing();
  const small = await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 2 }] }, A);
  assert.equal(small.status, 409); assert.equal(small.body.code, "below_minimum");
  assert.equal((await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: usual }, B)).status, 404, "not theirs");
  assert.equal((await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: run.version }, B)).status, 404);
  assert.equal((await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: usual, scope: "sometimes" }, A)).status, 400);
  // Until it's dispatched: while preparing or ready they still can, and Strangers is warned; once dispatched, not.
  srv.sql("DELETE FROM slack_order_posts"); sent.length = 0;
  const preparing = await setStatus(run.id, "Preparing");
  const whilePreparing = await call("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: preparing.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 9 }] }, A);
  assert.equal(whilePreparing.status, 200, whilePreparing.text);
  const ready = await setStatus(run.id, "Ready");
  const skipReady = await call("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: ready.version }, A);
  assert.equal(skipReady.status, 200, skipReady.text); assert.equal(skipReady.body.order.status, "Cancelled");
  await until(() => srv.sql("SELECT COUNT(*) AS n FROM slack_order_posts WHERE order_id LIKE '%:%'")[0].n >= 2 && sent.filter((m) => /standing order/.test(m.subject || "") && !/^Next standing/.test(m.subject)).length >= 2);
  const warned = srv.sql("SELECT payload FROM slack_order_posts WHERE order_id LIKE '%:%' ORDER BY created_at").map((r) => JSON.parse(r.payload).text);
  assert.match(warned[0], /already being prepared: check the packing/);
  assert.match(warned[1], /already packed and ready to go: check the packing/);
  const mails = sent.filter((m) => /standing order/.test(m.subject || "") && !/^Next standing/.test(m.subject));
  assert.match(mails[0].subject, /^Already preparing: Café Weekly changed a standing order/);
  assert.match(mails[1].subject, /^Already ready: Café Weekly skipped a standing order delivery/);
  const next = await adminOrder((await adminOrder(run.id)).nextRunId);
  const dispatched = await setStatus(next.id, "Dispatched");
  const late = await call("POST", `/api/wholesale/orders/${next.id}/skip`, { ifVersion: dispatched.version }, A);
  assert.equal(late.status, 409); assert.equal(late.body.code, "order_closed"); assert.match(late.body.message, /dispatched/);
  const lateStaff = await call("PUT", `/api/staff-orders/orders/${next.id}/lines`, { ifVersion: dispatched.version, lines: usual }, STAFF);
  assert.equal(lateStaff.status, 409); assert.equal(lateStaff.body.code, "order_closed");
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

// Slack hears about the customer's own changes (queued like new orders: now in business hours, else the morning), and the
// customer is emailed when Strangers changes or skips a delivery for them. Neither for the other side.
const slackRows = () => srv.sql("SELECT order_id, payload FROM slack_order_posts WHERE order_id LIKE '%:%' ORDER BY created_at").map((r) => ({ key: r.order_id, text: JSON.parse(r.payload).text }));
const toCustomer = () => sent.filter((m) => (m.to || []).includes("weekly.buyer@example.com"));
async function until(check, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end && !check()) await wait(100); await wait(300); }

test("customer changes and skips go to Slack; Strangers' changes and skips email the customer", async () => {
  const run = await standing();
  await until(() => toCustomer().length >= 1); // the order confirmation from placing it
  srv.sql("DELETE FROM slack_order_posts"); sent.length = 0;
  const changed = await ok("PUT", `/api/wholesale/orders/${run.id}/lines`, { ifVersion: run.version, lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 7 }], scope: "once" }, A);
  await until(() => slackRows().length >= 1);
  let rows = slackRows();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].key.startsWith(run.id + ":once:"));
  assert.match(rows[0].text, /Café Weekly changed their standing order/);
  assert.match(rows[0].text, /This delivery only · dispatch /);
  assert.match(rows[0].text, /• \*7\* × .* · 1 kg · Beans/);
  assert.match(rows[0].text, new RegExp(`/orders#${run.id}\\|Open wholesale orders>$`));
  assert.doesNotMatch(rows[0].text, /£/);
  assert.equal(toCustomer().length, 0, "the customer made the change, so isn't emailed about it");
  await ok("POST", `/api/wholesale/orders/${run.id}/skip`, { ifVersion: changed.body.order.version }, A);
  await until(() => slackRows().length >= 2);
  rows = slackRows();
  assert.equal(rows.length, 2);
  assert.match(rows[1].text, /Café Weekly skipped a standing order delivery/);
  assert.match(rows[1].text, /won't go out · next delivery /);
  assert.doesNotMatch(rows[1].text, /• /, "no bags for a skip");
  // Strangers changes the next delivery for them (staff page), then an admin skips it: the customer hears both, and so
  // do the Order alerts addresses and Slack, saying who did it.
  const next = await adminOrder((await adminOrder(run.id)).nextRunId);
  sent.length = 0;
  const staff = await ok("PUT", `/api/staff-orders/orders/${next.id}/lines`, { ifVersion: next.version, lines: [{ productId: "campo", pack: "quarter", grind: "beans", quantity: 3 }], scope: "ongoing" }, STAFF);
  await until(() => toCustomer().length >= 1);
  let mails = toCustomer();
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Changed: your Strangers Coffee standing order/);
  assert.match(mails[0].text, /every delivery from now on/);
  assert.match(mails[0].text, /3 × .*, 250 g, Beans/);
  assert.ok(!/Pat Packer|£/.test(mails[0].text + mails[0].html), "no names or prices");
  await ok("POST", `/api/admin/wholesale/orders/${next.id}/skip`, { ifVersion: staff.body.order.version });
  await until(() => toCustomer().length >= 2);
  mails = toCustomer();
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /^Skipped: your Strangers Coffee standing order for /);
  const after = await adminOrder((await adminOrder(next.id)).nextRunId);
  const nextDay = new Date(after.dispatchDate + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  assert.match(mails[1].text, new RegExp(`next delivery is due for dispatch on ${nextDay}`));
  assert.ok(!/Admin|£/.test(mails[1].text));
  await until(() => slackRows().length >= 4 && sent.filter((m) => /by (Pat Packer|Admin)$/.test(m.subject || "")).length >= 2);
  rows = slackRows();
  assert.equal(rows.length, 4, "Strangers' changes go to Slack too");
  assert.match(rows[2].text, /Pat Packer changed Café Weekly's standing order/);
  assert.match(rows[2].text, /Every delivery from now on/);
  assert.match(rows[3].text, /Admin skipped a standing order delivery for Café Weekly/);
  const alerts = sent.filter((m) => !(m.to || []).includes("weekly.buyer@example.com"));
  assert.ok(alerts.some((m) => m.subject === "Café Weekly: standing order changed by Pat Packer" && /Pat Packer \(Strangers\) changed the bags on Café Weekly's standing order/.test(m.text)), JSON.stringify(alerts.map((m) => m.subject)));
  assert.ok(alerts.some((m) => m.subject === "Café Weekly: standing order delivery skipped by Admin"));
  // With "Email customers about their orders" off, Strangers' changes email nobody.
  const settings = (await ok("GET", "/api/admin/wholesale/order-emails")).body;
  await ok("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: settings.enabled, to: settings.to, confirmCustomers: false });
  sent.length = 0;
  await ok("POST", `/api/admin/wholesale/orders/${after.id}/skip`, { ifVersion: after.version });
  await wait(800);
  assert.equal(toCustomer().length, 0);
});

test("the next delivery of a standing order, made when the last one goes out, is emailed to Strangers and posted to Slack", async () => {
  const run = await standing();
  await wait(500); sent.length = 0;
  const done = await setStatus(run.id, "Dispatched");
  const nextId = done.nextRunId;
  assert.ok(nextId);
  await until(() => srv.sql(`SELECT COUNT(*) AS n FROM slack_order_posts WHERE order_id='${nextId}'`)[0].n === 1 && sent.some((m) => /^Next standing order delivery: Café Weekly/.test(m.subject || "")));
  const next = await adminOrder(nextId);
  const post = JSON.parse(srv.sql(`SELECT payload FROM slack_order_posts WHERE order_id='${nextId}'`)[0].payload).text;
  assert.match(post, /^:repeat: \*Next standing order delivery: Café Weekly\*/);
  assert.match(post, /Standing order, every week · dispatch /);
  assert.doesNotMatch(post, /£/);
  const mail = sent.find((m) => /^Next standing order delivery: Café Weekly/.test(m.subject || ""));
  const day = new Date(next.dispatchDate + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  assert.match(mail.text, new RegExp(`Standing order, every week · dispatch ${day}`));
  assert.ok(!(mail.to || []).includes("weekly.buyer@example.com"), "not to the customer");
  assert.ok(!sent.some((m) => (m.to || []).includes("weekly.buyer@example.com") && /Next standing/.test(m.subject || "")), "the customer isn't sent Strangers' notice");
  // Saving it again doesn't make (or announce) another run.
  await setStatus(run.id, "Dispatched").catch(() => {});
  await wait(500);
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM slack_order_posts WHERE order_id NOT LIKE '%:%' AND payload LIKE '%Next standing order%'")[0].n >= 1, true);
  assert.equal(sent.filter((m) => /^Next standing order delivery/.test(m.subject || "")).length, 1);
});
