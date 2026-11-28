// New wholesale order emails (src/email/orders.ts), sent to a stand-in for Resend: one per new customer order to the
// addresses set in Admin (sales@strangerscoffee.com unless changed), from orders@staffstrangerscoffee.com with
// Reply-To the customer; never for staff previews or retries; switchable and testable by admins only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, A;
const sent = [];
let collectionResponse = 200, providerId = 0;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (sent.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 300)); return sent.length; }
const take = () => sent.splice(0, sent.length);
async function until(check) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Expected email state did not settle");
}
const EMAIL_SETTINGS = "/api/admin/wholesale/order-emails";
async function customerEmails(enabled) {
  const { body: { version } } = await call("GET", EMAIL_SETTINGS);
  assert.equal((await call("PUT", EMAIL_SETTINGS, { ifVersion: version, enabled: false, to: [], confirmCustomers: enabled })).status, 200);
}
async function updateEmail(email) {
  const { customer } = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  assert.equal((await call("PUT", "/api/wholesale/account", { ifVersion: customer.version, email }, A)).status, 200);
}
async function orderStatus(order, status) {
  const r = await call("PATCH", `/api/admin/wholesale/orders/${order.id}`, { ifVersion: order.version, status, customerId: order.customerId });
  assert.equal(r.status, 200, r.text);
  return r.body.order;
}
const dispatchRow = id => srv.sql(`SELECT state,last_error FROM wholesale_email_outbox WHERE order_id='${id}'`)[0];
async function place(extra = {}, cookie = A) {
  const session = cookie === A ? (await call("GET", "/api/wholesale/session", undefined, A)).body : null;
  const body = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }, { productId: "campo", pack: "quarter", grind: "filter", quantity: 4, price: 500 }], delivery: "Delivery", reference: "PO-77", ...(session ? { customerVersion: session.customer.version } : {}), ...extra };
  const r = await call("POST", "/api/wholesale/orders", body, cookie);
  assert.equal(r.status, 201, r.text); return { body, order: r.body.order };
}

before(async () => {
  mock = createServer((rq, rs) => {
    let body = "";
    rq.on("data", chunk => body += chunk);
    rq.on("end", () => {
      const mail = JSON.parse(body);
      const status = mail.subject.startsWith("Collected:") ? collectionResponse : 200;
      sent.push({ ...mail, status, deliveryKey: rq.headers["idempotency-key"] });
      rs.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ id: "test-" + ++providerId }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails` } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "mail.buyer", password: "mail-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Café <Lune> & Co", contact: "Sam Buyer", email: "buyer@lune.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((row) => row.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
  const me = (await call("GET", "/api/wholesale/session", undefined, A)).body.customer;
  const saved = await call("PUT", "/api/wholesale/account", { ifVersion: me.version, address: "1 Elm Hill, Norwich", postcode: "NR3 1HN", phone: "01603 000000" }, A);
  assert.equal(saved.status, 200, saved.text);
});
after(async () => { await srv?.stop(); await new Promise((r) => mock?.close(r)); });

test("each new customer order emails sales@ from orders@, with Reply-To the customer; retries and staff previews don't", async () => {
  const defaults = (await call("GET", "/api/admin/wholesale/order-emails")).body;
  assert.deepEqual([defaults.enabled, defaults.to, defaults.from, defaults.sending, defaults.version, defaults.confirmCustomers], [true, ["sales@strangerscoffee.com"], "orders@staffstrangerscoffee.com", true, 0, true]);
  // Customer confirmations are tested on their own (below); here only Strangers' own emails are counted.
  assert.equal((await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: 0, enabled: true, to: ["sales@strangerscoffee.com"], confirmCustomers: false })).body.confirmCustomers, false);
  take();
  const { body, order } = await place({ customerNote: "Use our own custom labels" });
  assert.equal(await settle(1), 1);
  const [mail] = take();
  assert.equal(mail.from, "Strangers Wholesale <orders@staffstrangerscoffee.com>");
  assert.deepEqual(mail.to, ["sales@strangerscoffee.com"]);
  assert.equal(mail.reply_to, "buyer@lune.example");
  assert.equal(mail.headers, undefined, "a business notification has no unsubscribe header");
  assert.match(mail.subject, /^New wholesale order: Café <Lune> & Co · 10 bags · £/);
  assert.match(mail.text, new RegExp(order.id));
  assert.match(mail.text, /6 × Brazil.*1 kg, Beans/); assert.match(mail.text, /4 × 250 g · 6 × 1 kg · 10 bags · 7 kg/);
  assert.match(mail.text, /Deliver to: .*1 Elm Hill, Norwich, NR3 1HN/); assert.match(mail.text, /Reference: PO-77/); assert.match(mail.text, /Use our own custom labels/);
  assert.match(mail.html, /Café &lt;Lune&gt; &amp; Co/); assert.doesNotMatch(mail.html, /<Lune>/, "customer text is escaped");
  assert.match(mail.html, new RegExp(`/orders#${order.id}"`), "the button opens the order on the staff Wholesale orders page");
  assert.match(mail.html, />Open the order</); assert.doesNotMatch(mail.html, /#wholesale/);

  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).status, 200, "an exact retry returns the order");
  await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 1, price: 500 }], delivery: "Roastery collection", reference: "" });
  assert.equal(await settle(1, 1500), 0, "no email for a retry or a staff preview");
});

test("admins choose who gets them, switch them off and send a test; others can't", async () => {
  let settings = (await call("GET", "/api/admin/wholesale/order-emails")).body;
  for (const bad of [{ to: ["not-an-email"] }, { to: [] }, { to: Array.from({ length: 6 }, (_, i) => `a${i}@x.example`) }, { enabled: "yes" }]) {
    assert.equal((await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: true, to: ["sales@strangerscoffee.com"], ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: 9, enabled: true, to: ["a@x.example"] })).status, 409);
  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: true, to: ["Sales@StrangersCoffee.com", "roastery@x.example", "sales@strangerscoffee.com"] })).body;
  assert.deepEqual([settings.to, settings.version, settings.confirmCustomers], [["sales@strangerscoffee.com", "roastery@x.example"], 2, false], "saving without confirmCustomers keeps it");
  take(); await place();
  assert.equal(await settle(2), 2);
  assert.deepEqual(take().map((m) => m.to[0]).sort(), ["roastery@x.example", "sales@strangerscoffee.com"]);

  const test = await call("POST", "/api/admin/wholesale/order-emails/test", {});
  assert.equal(test.status, 200, test.text); assert.equal(await settle(2), 2);
  assert.ok(take().every((m) => /^Test: New wholesale order/.test(m.subject) && m.from.includes("orders@staffstrangerscoffee.com")));

  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [] })).body;
  assert.equal(settings.enabled, false);
  await place();
  assert.equal(await settle(1, 1500), 0, "switched off: nothing sent");

  for (const cookie of [null, A]) assert.equal((await call("GET", "/api/admin/wholesale/order-emails", undefined, cookie)).status, 401);
  assert.equal((await call("POST", "/api/admin/wholesale/order-emails/test", {}, A)).status, 401);
  const backup = await call("POST", "/api/admin/backups", {});
  assert.ok(backup.status < 300, backup.text);
});

test("the customer gets their own confirmation: their bags, delivery, totals and terms, replies to Strangers", async () => {
  let settings = (await call("GET", "/api/admin/wholesale/order-emails")).body;
  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [], confirmCustomers: true })).body;
  assert.equal(settings.confirmCustomers, true);
  take();
  const { body, order } = await place({ customerNote: "Ring the bell" });
  assert.equal(await settle(1), 1, "just the confirmation (Strangers' own alert is switched off here)");
  const [mail] = take();
  assert.deepEqual(mail.to, ["buyer@lune.example"]);
  assert.equal(mail.from, "Strangers Wholesale <orders@staffstrangerscoffee.com>");
  assert.equal(mail.reply_to, "sales@strangerscoffee.com", "replies go to Strangers");
  assert.equal(mail.headers, undefined);
  assert.match(mail.subject, /^Order confirmed: 10 bags of Strangers Coffee/);
  assert.match(mail.text, /^Hi Sam,/); assert.match(mail.text, new RegExp(order.id));
  assert.match(mail.text, /6 × Brazil.*1 kg, Beans · £108\.00/); assert.match(mail.text, /Total £/);
  assert.match(mail.text, /Delivering to: .*1 Elm Hill, Norwich, NR3 1HN/); assert.match(mail.text, /Your reference: PO-77/);
  assert.match(mail.text, /Ring the bell/); assert.match(mail.text, /Payment terms: To be agreed/);
  assert.match(mail.text, /accepted the payment terms and conditions/);
  assert.match(mail.html, /See your orders/); assert.match(mail.html, /#orders"/);
  assert.match(mail.html, /Café &lt;Lune&gt; &amp; Co/); assert.doesNotMatch(mail.html, /<Lune>/);
  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).status, 200);
  assert.equal(await settle(1, 1500), 0, "no second confirmation for a retry");

  // Hidden prices: bags only, no money.
  const rows = (await call("GET", "/api/admin/wholesale")).body.customers, c = rows.find((x) => x.business === "Café <Lune> & Co");
  const { id, version, updatedAt, ...fields } = c;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, hidePrices: true, ifVersion: version })).status, 200);
  await place();
  assert.equal(await settle(1), 1);
  const [hidden] = take();
  assert.doesNotMatch(hidden.text + hidden.html, /£/, "no prices for a business that doesn't see them");

  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [], confirmCustomers: false })).body;
  await place();
  assert.equal(await settle(1, 1500), 0, "switched off: no confirmation");
  assert.equal((await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [], confirmCustomers: "yes" })).status, 400);
});

test("when an order is marked dispatched the customer is told, once: shipped (with tracking) or collected from the Roastery", async () => {
  let settings = (await call("GET", "/api/admin/wholesale/order-emails")).body;
  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [], confirmCustomers: true })).body;
  const patch = (o, extra) => call("PATCH", `/api/admin/wholesale/orders/${o.id}`, { ifVersion: o.version, status: o.status, customerId: o.customerId, note: o.note || "", trackingUrl: o.trackingUrl || "", ...extra });
  const latest = async (id) => (await call("GET", `/api/wholesale/orders/${id}`)).body.order;

  // Delivery: shipped, with the tracking link.
  const { order } = await place(); await settle(1); take();
  let r = await patch(await latest(order.id), { status: "Preparing" });
  assert.equal(await settle(1, 1200), 0, "nothing for other statuses");
  r = await patch(r.body.order, { status: "Dispatched", trackingUrl: "https://track.example/abc" });
  assert.equal(r.status, 200, r.text);
  assert.equal(await settle(1), 1);
  const [shipped] = take();
  assert.deepEqual(shipped.to, ["buyer@lune.example"]); assert.equal(shipped.reply_to, "sales@strangerscoffee.com");
  assert.match(shipped.subject, /^Shipped: your Strangers Coffee order/);
  assert.match(shipped.text, /SHIPPED/); assert.match(shipped.text, /on its way to .*1 Elm Hill/);
  assert.match(shipped.html, /Your order has been shipped/); assert.match(shipped.html, /href="https:\/\/track\.example\/abc"/);
  assert.doesNotMatch(shipped.text + shipped.html, /£/, "no prices in the dispatch email");
  // Back and forth never sends it again.
  r = await patch(r.body.order, { status: "Ready" }); r = await patch(r.body.order, { status: "Dispatched" });
  assert.equal(await settle(1, 1500), 0, "only once");

  // Collection, marked dispatched from the staff orders page: collected from the Roastery.
  const { order: pickup } = await place({ delivery: "Roastery collection" }); await settle(1); take();
  const o = await latest(pickup.id);
  r = await call("PATCH", `/api/staff-orders/orders/${o.id}`, { ifVersion: o.version, status: "Dispatched", note: "", trackingUrl: "" });
  assert.equal(r.status, 200, r.text);
  assert.equal(await settle(1), 1);
  const [collected] = take();
  assert.match(collected.subject, /^Collected: your Strangers Coffee order/);
  assert.match(collected.html, /Your order has been collected from the Roastery/); assert.match(collected.text, /COLLECTED FROM THE ROASTERY/);
  assert.doesNotMatch(collected.html, /Track your delivery/);

  // Switched off: nothing.
  settings = (await call("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: false, to: [], confirmCustomers: false })).body;
  const { order: quiet } = await place();
  await patch(await latest(quiet.id), { status: "Dispatched" });
  assert.equal(await settle(1, 1500), 0);
});

test("two sealed boxes are handed over once, with their own email links and carrier delivery states", async () => {
  await customerEmails(true);
  const { order } = await place();
  await settle(1); take();
  const ready = await orderStatus(order, "Ready");
  const path = `/api/admin/wholesale/orders/${order.id}`;
  const weights = [4100, 4200], numbers = ["AB123456789GB", "AB123456780GB"];
  const half = ready.lines.map(line => line.quantity / 2);
  const plan = await call("PUT", path + "/shipping/boxes", { ifVersion: ready.version, planVersion: null, weights, contents: [half,half] });
  assert.equal(plan.status, 200, plan.text);
  function confirmBox(index) {
    srv.sql(`INSERT INTO wholesale_royal_mail_shipments(order_id,operation,state,order_version,provider_id,weight_grams,updated_at,
        label_downloaded_at,shipping_fingerprint,tracking_number,carrier_status,carrier_event_at)
      SELECT order_id||'-B${index+1}','operation-${index}','labelled',${ready.version},${8000+index},${weights[index]},1,
        1,shipping_fingerprint,'${numbers[index]}',NULL,NULL FROM wholesale_royal_mail_box_plans WHERE order_id='${order.id}'`);
  }
  confirmBox(0);
  const original = ready.lines.map(({productId, pack, grind, quantity}) => ({productId,pack,grind,quantity}));
  const amended = original.map((line, i) => i ? line : {...line,quantity:line.quantity+1});
  const changed = await call("PUT", path + "/lines", { ifVersion:ready.version, lines:amended });
  assert.equal(changed.status, 409, changed.text);
  assert.equal(changed.body.code, "royal_mail_boxes_committed");
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, A)).body.order.version, ready.version);
  const dispatchBody = { ifVersion: ready.version, status: "Dispatched", customerId: order.customerId };
  const blocked = await call("PATCH", path, dispatchBody);
  assert.equal(blocked.status, 409, blocked.text);
  const before = await call("GET", "/api/wholesale/orders/" + order.id, undefined, A);
  assert.equal(before.body.order.deliveryParcels, undefined);
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_email_outbox WHERE order_id='${order.id}'`)[0].n, 0);
  confirmBox(1);
  const handover = await call("PATCH", path, dispatchBody);
  assert.equal(handover.status, 200, handover.text);
  assert.equal((await call("PATCH", path, dispatchBody)).status, 409);
  assert.equal(await settle(1), 1);
  const [mail] = take();
  assert.deepEqual(mail.to, ["buyer@lune.example"]);
  assert.match(mail.text, /travelling in 2 boxes/);
  for (const [i, number] of numbers.entries()) {
    assert.ok(mail.text.includes(`Box ${i+1} of 2: https://www.royalmail.com/track-your-item#/tracking-results/${number}`));
    assert.ok(mail.html.includes(`Track box ${i+1} of 2</a>`));
  }
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_email_outbox WHERE order_id='${order.id}'`)[0].n, 1);
  srv.sql(`UPDATE wholesale_royal_mail_shipments SET carrier_status=CASE WHEN order_id='${order.id}-B1' THEN 'Delivered' ELSE 'Item received' END,
    carrier_event_at='2026-11-28T10:00:00Z' WHERE order_id IN ('${order.id}-B1','${order.id}-B2')`);
  // An older booking for this box number cannot supply a scan to the current booking.
  srv.sql(`INSERT INTO wholesale_royal_mail_scan_checks(shipment_id,booking_operation,number,connection_scope,lease,next_at,checked_at,outcome,event_at)
    VALUES('${order.id}-B2','previous-booking','${numbers[1]}','test','','0',1,'delivered','2026-11-28T12:00:00Z')`);
  const detail = await call("GET", "/api/wholesale/orders/" + order.id, undefined, A);
  assert.equal(detail.status, 200, detail.text);
  const expected = numbers.map((number, i) => ({ number: i+1, count: 2,
    trackingUrl: "https://www.royalmail.com/track-your-item#/tracking-results/" + number, status: i ? "in_transit" : "delivered" }));
  assert.deepEqual(detail.body.order.deliveryParcels, expected);
  const list = await call("GET", "/api/wholesale/orders", undefined, A);
  assert.deepEqual(list.body.orders.find(item => item.id === order.id).deliveryParcels, expected);
  const otherCustomer = (await call("POST", "/api/admin/wholesale/customers", { business: "Other parcel buyer", contact: "Buyer", email: "other@example.test", status: "Active" })).body.customer;
  const otherAccount = (await call("POST", `/api/admin/wholesale/customers/${otherCustomer.id}/account`, { username: "other.parcel.buyer" })).body;
  const other = (await call("POST", "/api/wholesale/auth/change-password", {
    username: "other.parcel.buyer", password: otherAccount.temporaryPassword, newPassword: "other-parcel-password",
  }, null)).cookie;
  assert.equal((await call("GET", "/api/wholesale/orders/" + order.id, undefined, other)).status, 404);
  const otherList = await call("GET", "/api/wholesale/orders", undefined, other);
  assert.deepEqual(otherList.body.orders, []);
  srv.sql(`UPDATE wholesale_royal_mail_shipments SET review_required=1 WHERE order_id='${order.id}-B2'`);
  const held = await call("GET", "/api/wholesale/orders/" + order.id, undefined, A);
  assert.equal(held.body.order.deliveryParcels[1].trackingUrl, null);
  assert.equal(held.body.order.deliveryParcels[1].status, "unknown");
  assert.doesNotMatch(JSON.stringify(held.body.order.deliveryParcels), /operation-|provider_id|carrier_status/);
  const alternate = await call("PATCH", path, {ifVersion:handover.body.order.version,customerId:order.customerId,
    status:"Dispatched",trackingUrl:"https://other-carrier.example/parcel"});
  assert.equal(alternate.status, 200, alternate.text);
  const external = await call("GET", "/api/wholesale/orders/" + order.id, undefined, A);
  assert.equal(external.body.order.trackingUrl, "https://other-carrier.example/parcel");
  assert.equal(external.body.order.deliveryParcels, undefined);
});

test("staff-channel Royal Mail dispatch requires confirmed terms and sends shipped mail for legacy delivery labels", async () => {
  await customerEmails(true);
  const link = "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB";
  const dispatch = (order) => call("PATCH", `/api/staff-orders/orders/${order.id}`,
    { ifVersion: order.version, status: "Dispatched", trackingUrl: link });

  const { order: unconfirmed } = await place();
  assert.equal(await settle(1), 1);
  take();
  const held = await dispatch(await orderStatus(unconfirmed, "Ready"));
  assert.equal(held.status, 409, held.text);
  assert.equal(held.body.code, "royal_mail_payment_review");
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_email_outbox WHERE event_key='dispatch:${unconfirmed.id}'`)[0].n, 0);
  assert.equal(await settle(1, 1200), 0);

  const customer = (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === unconfirmed.customerId);
  const approved = await call("PUT", `/api/admin/wholesale/customers/${customer.id}`,
    { ...customer, ifVersion: customer.version, paymentTerms: "net-30" });
  assert.equal(approved.status, 200, approved.text);

  for (const delivery of ["Courier", " delivery "]) {
    const { order } = await place();
    assert.equal(await settle(1), 1);
    take();
    srv.sql(`UPDATE wholesale_preview SET data=json_set(data,'$.delivery','${delivery}') WHERE kind='order' AND id='${order.id}'`);
    const ready = await orderStatus(order, "Ready");
    assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_email_outbox WHERE event_key='ready:${order.id}'`)[0].n, 0);
    const dispatched = await dispatch(ready);
    assert.equal(dispatched.status, 200, dispatched.text);
    assert.equal(await settle(1), 1);
    const [mail] = take();
    assert.match(mail.subject, /^Shipped:/);
    assert.match(mail.text, /on its way to .*1 Elm Hill/);
    assert.ok(mail.text.includes(link));
    assert.doesNotMatch(mail.text, /COLLECTED|READY TO COLLECT/i);
  }
  const restored = await call("PUT", `/api/admin/wholesale/customers/${customer.id}`,
    { ...customer, ifVersion: approved.body.customer.version, paymentTerms: customer.paymentTerms.id });
  assert.equal(restored.status, 200, restored.text);
  await customerEmails(false);
});

test("an open order uses the current customer email and exposes the correct activity and delivery records", async () => {
  await customerEmails(true);
  const { order } = await place({ delivery: "Roastery collection" });
  assert.equal(await settle(1), 1);
  assert.deepEqual(take()[0].to, ["buyer@lune.example"]);
  await updateEmail("current@lune.example");
  await orderStatus(order, "Dispatched");
  assert.equal(await settle(1), 1);
  const [collection] = take();
  assert.match(collection.subject, /^Collected:/);
  assert.deepEqual(collection.to, ["current@lune.example"]);
  const health = (await call("GET", `${EMAIL_SETTINGS}/delivery`)).body;
  const related = health.messages.filter(message => message.orderReference === order.id);
  assert.deepEqual(new Set(related.map(message => message.recipient)), new Set(["buyer@lune.example", "current@lune.example"]));
  assert.ok(related.every(message => message.stream === "wholesale" && message.status === "accepted"));
  const activity = (await call("GET", "/api/admin/activity?kind=account")).body.items.filter(item => item.text.includes(order.id));
  assert.ok(activity.some(item => item.where === "Wholesale" && /Customer email queued/.test(item.text)));
  assert.ok(activity.some(item => item.where === "Wholesale emails" && /Resend accepted/.test(item.text)));
  assert.ok(activity.every(item => !/No fulfilment action was sent/.test(item.text)));
  const overview = await call("GET", "/api/admin/overview");
  assert.equal(overview.body.emails.sentToday, 0, "wholesale mail is not included in the rota total");
});

test("a refused dispatch retargets safely and an uncertain attempt waits after an address change", async () => {
  for (const [response, email] of [[503, "revised@lune.example"], [409, "latest@lune.example"]]) {
    const { order } = await place({ delivery: "Roastery collection" });
    await settle(1); take();
    collectionResponse = response;
    await orderStatus(order, "Dispatched");
    assert.equal(await settle(1), 1);
    const [attempt] = take();
    assert.equal(attempt.status, response);
    await until(() => dispatchRow(order.id)?.state === "retry");
    await updateEmail(email);
    collectionResponse = 200;
    assert.equal((await call("POST", `${EMAIL_SETTINGS}/email-retry`, {})).status, 200);
    if (response === 503) {
      assert.equal(await settle(1), 1);
      const [retry] = take();
      assert.deepEqual(retry.to, [email]);
      assert.notEqual(retry.deliveryKey, attempt.deliveryKey, "new envelope gets a new provider key");
      await until(() => dispatchRow(order.id)?.state === "sent");
    } else {
      await until(() => dispatchRow(order.id)?.state === "unknown");
      assert.equal(await settle(1, 500), 0, "an uncertain envelope never silently changes recipient");
    }
  }
});

test("queued dispatches stop when the order is cancelled or customer mail is turned off", async () => {
  for (const cancelled of [true, false]) {
    await customerEmails(true);
    const { order } = await place({ delivery: "Roastery collection" });
    await settle(1); take();
    collectionResponse = 503;
    const dispatched = await orderStatus(order, "Dispatched");
    await settle(1); take();
    await until(() => dispatchRow(order.id)?.state === "retry");
    if (cancelled) await orderStatus(dispatched, "Cancelled");
    else await customerEmails(false);
    collectionResponse = 200;
    assert.equal((await call("POST", `${EMAIL_SETTINGS}/email-retry`, {})).status, 200);
    const skipped = await until(() => dispatchRow(order.id)?.state === "skipped" && dispatchRow(order.id));
    assert.match(skipped.last_error, cancelled ? /no longer dispatched/ : /switched off/);
    assert.equal(await settle(1, 500), 0);
  }
});

// A collection order marked Ready: the customer hears it's ready to collect from the Roastery, once; never for delivery
// orders (the owner's request, 23 Nov 2026).
test("a collection order marked ready emails the customer that it's ready to collect; delivery orders don't", async () => {
  await customerEmails(true);
  const latest = async (id) => (await call("GET", `/api/wholesale/orders/${id}`)).body.order;
  const { order: pickup } = await place({ delivery: "Roastery collection" }); await settle(1); take();
  let o = await orderStatus(await latest(pickup.id), "Preparing");
  assert.equal(await settle(1, 1000), 0, "nothing while preparing");
  // From the staff orders page, as the packers do.
  let r = await call("PATCH", `/api/staff-orders/orders/${o.id}`, { ifVersion: o.version, status: "Ready", note: "", trackingUrl: "" });
  assert.equal(r.status, 200, r.text);
  assert.equal(await settle(1), 1);
  const [ready] = take();
  assert.deepEqual(ready.to, [(await call("GET", "/api/wholesale/session", undefined, A)).body.customer.email]);
  assert.equal(ready.reply_to, "sales@strangerscoffee.com");
  assert.match(ready.subject, /^Ready to collect: your Strangers Coffee order/);
  assert.match(ready.text, /READY TO COLLECT/); assert.match(ready.text, /10 Dove Street/);
  assert.match(ready.html, /Your order is ready to collect/);
  assert.doesNotMatch(ready.text + ready.html, /£/, "no prices");
  await until(() => srv.sql(`SELECT state FROM wholesale_email_outbox WHERE event_key='ready:${o.id}'`)[0]?.state === "sent");
  // Back to Preparing and Ready again: not sent twice. Collected later: the usual collected email.
  o = await orderStatus(await latest(o.id), "Preparing"); o = await orderStatus(o, "Ready");
  assert.equal(await settle(1, 1200), 0, "only once");
  await orderStatus(o, "Dispatched");
  assert.equal(await settle(1), 1); assert.match(take()[0].subject, /^Collected:/);

  // Delivery orders: nothing when ready.
  const { order: shipped } = await place({ delivery: "Delivery" }); await settle(1); take();
  await orderStatus(await latest(shipped.id), "Ready");
  assert.equal(await settle(1, 1200), 0, "no ready email for delivery");
  assert.equal(srv.sql(`SELECT COUNT(*) AS n FROM wholesale_email_outbox WHERE event_key='ready:${shipped.id}'`)[0].n, 0);

  // Switched off: nothing.
  await customerEmails(false);
  const { order: quiet } = await place({ delivery: "Roastery collection" });
  await orderStatus(await latest(quiet.id), "Ready");
  assert.equal(await settle(1, 1200), 0);
});
