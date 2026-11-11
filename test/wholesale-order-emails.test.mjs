// New wholesale order emails (src/email/orders.ts), sent to a stand-in for Resend: one per new customer order to the
// addresses set in Admin (sales@strangerscoffee.com unless changed), from orders@staffstrangerscoffee.com with
// Reply-To the customer; never for staff previews or retries; switchable and testable by admins only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, A;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (sent.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 300)); return sent.length; }
const take = () => sent.splice(0, sent.length);
async function place(extra = {}, cookie = A) {
  const session = cookie === A ? (await call("GET", "/api/wholesale/session", undefined, A)).body : null;
  const body = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }, { productId: "campo", pack: "quarter", grind: "filter", quantity: 4, price: 500 }], delivery: "Delivery", reference: "PO-77", ...(session ? { customerVersion: session.customer.version } : {}), ...extra };
  const r = await call("POST", "/api/wholesale/orders", body, cookie);
  assert.equal(r.status, 201, r.text); return { body, order: r.body.order };
}

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
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
  assert.deepEqual([defaults.enabled, defaults.to, defaults.from, defaults.sending, defaults.version], [true, ["sales@strangerscoffee.com"], "orders@staffstrangerscoffee.com", true, 0]);
  take();
  const { body, order } = await place({ customerNote: "Use our own custom labels" });
  assert.equal(await settle(1), 1);
  const [mail] = take();
  assert.equal(mail.from, "Strangers Coffee Orders <orders@staffstrangerscoffee.com>");
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
  assert.deepEqual([settings.to, settings.version], [["sales@strangerscoffee.com", "roastery@x.example"], 1]);
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
