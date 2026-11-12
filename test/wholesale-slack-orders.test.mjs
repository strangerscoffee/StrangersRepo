// New wholesale orders posted to Slack (src/slackOrders.ts, src/slackOrderText.ts): straight away from 07:45 to 16:45
// UK time (Sunday 10:00 to 15:30), otherwise held until 07:50 (Sunday 10:00) and sent by the 5-minute cron; business name, a short summary and
// a link to the staff Wholesale orders page; never for staff previews or retries; retried when Slack refuses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";
import { slackPostTime, buildSlackOrder } from "../src/slackOrderText.ts";

const at = (iso) => Date.parse(iso);
test("orders post at once 07:45–16:45 UK time (Sunday 10:00–15:30); the rest wait for 07:50 (Sunday 10:00), GMT and BST", () => {
  const cases = [
    // Winter (GMT = UTC)
    ["2026-11-12T07:44:00Z", "2026-11-12T07:50:00Z"], ["2026-11-12T07:45:00Z", "now"], ["2026-11-12T12:00:00Z", "now"],
    ["2026-11-12T16:45:59Z", "now"], ["2026-11-12T16:46:00Z", "2026-11-13T07:50:00Z"], ["2026-11-12T23:59:00Z", "2026-11-13T07:50:00Z"],
    ["2026-11-13T00:10:00Z", "2026-11-13T07:50:00Z"],
    // Summer (BST = UTC+1): 07:44 UK is 06:44 UTC
    ["2026-07-01T06:44:00Z", "2026-07-01T06:50:00Z"], ["2026-07-01T06:45:00Z", "now"], ["2026-07-01T15:45:00Z", "now"],
    ["2026-07-01T15:46:00Z", "2026-07-02T06:50:00Z"], ["2026-06-30T23:30:00Z", "2026-07-01T06:50:00Z"],
    // Saturday as the week; Sunday 10:00–15:30, anything held posting at 10:00 (14 and 15 Nov 2026 are Sat and Sun)
    ["2026-11-14T08:00:00Z", "now"], ["2026-11-14T16:45:00Z", "now"], ["2026-11-14T18:00:00Z", "2026-11-15T10:00:00Z"],
    ["2026-11-15T07:50:00Z", "2026-11-15T10:00:00Z"], ["2026-11-15T09:59:00Z", "2026-11-15T10:00:00Z"], ["2026-11-15T10:00:00Z", "now"],
    ["2026-11-15T15:30:59Z", "now"], ["2026-11-15T15:31:00Z", "2026-11-16T07:50:00Z"], ["2026-11-15T22:00:00Z", "2026-11-16T07:50:00Z"],
    ["2026-11-16T07:44:00Z", "2026-11-16T07:50:00Z"],
    // Sunday in summer (BST): 10:00 UK is 09:00 UTC
    ["2026-07-04T17:00:00Z", "2026-07-05T09:00:00Z"], ["2026-07-05T14:30:00Z", "now"], ["2026-07-05T14:31:00Z", "2026-07-06T06:50:00Z"],
    // The clocks change on Sunday nights: 10:00 is BST on 29 March, GMT on 25 October
    ["2026-03-28T20:00:00Z", "2026-03-29T09:00:00Z"], ["2026-10-24T20:00:00Z", "2026-10-25T10:00:00Z"],
  ];
  for (const [placed, expected] of cases) assert.equal(slackPostTime(at(placed)), expected === "now" ? at(placed) : at(expected), placed);
});

test("the post: business name, bags and sizes, each line, collection or delivery place, comments, link; Slack-escaped; no prices", () => {
  const { text } = buildSlackOrder({ id: "WS-ABC123", business: "Café <Lune> & Co", createdAt: at("2026-11-12T22:10:00Z"), delivery: "Delivery", reference: "PO-77", grams: 7000, customerNote: "Use our own labels\nThanks",
    locationSnapshot: { name: "Back door", postcode: "NR3 1HN" },
    lines: [{ title: "Brazil", pack: "kilo", grindLabel: "Beans", quantity: 6 }, { title: "Campo Santo", pack: "quarter", grindLabel: "Medium", quantity: 4, decaf: false }] }, "https://staffstrangerscoffee.com/orders", true);
  assert.match(text, /^:coffee: \*New wholesale order: Café &lt;Lune&gt; &amp; Co\*/);
  assert.match(text, /WS-ABC123 · placed Thu 12 Nov, 22:10 \(overnight, posted this morning\) · ref PO-77/);
  assert.match(text, /\*10 bags\* \(4 × 250 g \+ 6 × 1 kg\) · 7 kg · Delivery to Back door, NR3 1HN/);
  assert.match(text, /• \*6\* × Brazil · 1 kg · Beans\n• \*4\* × Campo Santo · 250 g · Medium/);
  assert.match(text, />Use our own labels\n>Thanks/);
  assert.match(text, /<https:\/\/staffstrangerscoffee\.com\/orders\|Open wholesale orders>$/);
  assert.doesNotMatch(text, /£|<Lune>/);
});

let srv, mock, ADMIN, A, failNext = 0;
const posts = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (posts.length < n && Date.now() < end) await wait(100); await wait(300); return posts.length; }
const cron = () => fetch(srv.base + "/__scheduled?cron=" + encodeURIComponent("*/5 * * * *")).then((r) => r.text());
const row = (id) => srv.sql(`SELECT send_after, sent_at, attempts, last_error FROM slack_order_posts WHERE order_id = '${id}'`)[0];
async function place(extra = {}) {
  const session = (await call("GET", "/api/wholesale/session", undefined, A)).body;
  const body = { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }], delivery: "Roastery collection", reference: "", customerVersion: session.customer.version, ...extra };
  const r = await call("POST", "/api/wholesale/orders", body, A);
  assert.equal(r.status, 201, r.text); return { body, order: r.body.order };
}
/** Whatever the time now, gets this order's post sent: due now, or made due and the cron run. */
async function deliver(id) {
  if (row(id).sent_at == null) { srv.sql(`UPDATE slack_order_posts SET send_after = 0 WHERE order_id = '${id}'`); await cron(); }
}

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => {
    if (failNext > 0) { failNext--; rs.writeHead(500).end("no_service"); return; }
    try { posts.push(JSON.parse(b)); } catch {} rs.writeHead(200).end("ok"); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 2000, scheduled: true, vars: { SLACK_TEST_HOOKS: "1", SLACK_ORDERS_WEBHOOK_URL: `http://127.0.0.1:${mock.address().port}/services/T000/B000/xyz` } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const credentials = { username: "slack.buyer", password: "slack-buyer-password" };
  await call("POST", "/api/wholesale/auth/register", { ...credentials, business: "Slack Café", contact: "Sam Buyer", email: "buyer@slack.example" }, null);
  const account = (await call("GET", "/api/admin/wholesale")).body.accounts.find((r) => r.username === credentials.username);
  await call("PUT", `/api/admin/wholesale/customers/${account.customerId}/account`, { username: credentials.username, ifVersion: account.version, active: true, approvalStatus: "approved" });
  A = (await call("POST", "/api/wholesale/auth/login", credentials, null)).cookie;
});
after(async () => { await srv?.stop(); await new Promise((r) => mock?.close(r)); });

test("a new customer order is queued at the right time and posted once; retries and staff previews post nothing", async () => {
  const { body, order } = await place({ customerNote: "Ring the bell" });
  const queued = row(order.id);
  assert.equal(queued.send_after, slackPostTime(order.createdAt), "held for the morning outside 07:45–16:45 UK time");
  await deliver(order.id);
  assert.equal(await settle(1), 1);
  const [post] = posts.splice(0);
  assert.match(post.text, new RegExp(`New wholesale order: Slack Café\\*\\n${order.id}`));
  assert.match(post.text, /\*6 bags\* \(6 × 1 kg\) · 6 kg · Roastery collection/);
  assert.match(post.text, />Ring the bell/);
  assert.match(post.text, /\/orders\|Open wholesale orders>$/);
  assert.equal(post.unfurl_links, false);
  assert.ok(row(order.id).sent_at > 0);
  await cron(); assert.equal(await settle(1, 1500), 0, "a sent post isn't sent again");

  assert.equal((await call("POST", "/api/wholesale/orders", body, A)).status, 200, "an exact retry returns the order");
  await call("POST", "/api/wholesale/orders", { requestId: crypto.randomUUID(), lines: [{ productId: "brazil", pack: "quarter", grind: "beans", quantity: 1, price: 500 }], delivery: "Roastery collection", reference: "" });
  await cron();
  assert.equal(await settle(1, 1500), 0, "nothing for a retry or a staff preview");
  assert.equal(srv.sql("SELECT COUNT(*) AS n FROM slack_order_posts")[0].n, 1);
});

test("when Slack refuses, the cron tries again; after six tries Admin's Overview says so", async () => {
  failNext = 1;
  const { order } = await place();
  srv.sql(`UPDATE slack_order_posts SET send_after = 0 WHERE order_id = '${order.id}'`);
  if (row(order.id).attempts === 0) await cron();
  assert.equal(row(order.id).sent_at, null); assert.match(row(order.id).last_error, /500/);
  await cron(); assert.equal(await settle(1), 1, "sent on the next run"); posts.splice(0);

  failNext = 99;
  const second = await place();
  srv.sql(`UPDATE slack_order_posts SET send_after = 0 WHERE order_id = '${second.order.id}'`);
  for (let i = 0; i < 7; i++) await cron();
  assert.equal(row(second.order.id).attempts, 6, "stops after six tries");
  failNext = 0;
  const overview = await call("GET", "/api/admin/overview");
  assert.match(JSON.stringify(overview.body), /new-order Slack post didn't send/);
});

test("admins can send a test post; nobody else can", async () => {
  posts.splice(0);
  const settings = (await call("GET", "/api/admin/wholesale/order-emails")).body;
  assert.equal(settings.slack, true);
  assert.equal((await call("POST", "/api/admin/wholesale/order-emails/slack-test", {})).status, 200);
  assert.equal(await settle(1), 1); assert.match(posts[0].text, /Test order \(no action needed\)/);
  assert.notEqual((await call("POST", "/api/admin/wholesale/order-emails/slack-test", {}, A)).status, 200, "not a customer");
  assert.notEqual((await call("POST", "/api/admin/wholesale/order-emails/slack-test", {}, null)).status, 200, "not signed out");
});
