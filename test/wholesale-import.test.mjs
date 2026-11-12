// QuickBooks customer import and invites to order online (src/wholesaleImport.ts): businesses are added or filled in
// (never duplicated or overwritten), invites email a one-time link (to a stand-in for Resend) that sets up an approved
// account with the customer's own username and password, and only admins can import or invite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, mock, ADMIN, STAFF;
const sent = [];
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
async function settle(n, ms = 5000) { const end = Date.now() + ms; while (sent.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return sent.length; }
const take = () => sent.splice(0, sent.length);
const customers = async () => (await call("GET", "/api/admin/wholesale")).body.customers;
const tokenOf = (mail) => /invite=([a-f0-9]+)/.exec(mail.text)[1];

before(async () => {
  mock = createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", () => { try { sent.push(JSON.parse(b)); } catch {} rs.writeHead(200, { "content-type": "application/json" }).end('{"id":"x"}'); }); });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  srv = await startServer({ writeLimit: 3000, vars: { RESEND_API_KEY: "re_test_key", RESEND_API_URL: `http://127.0.0.1:${mock.address().port}/emails`, EMAIL_DAILY_LIMIT: "6" } });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await call("POST", "/api/admin/users", { name: "Shop", username: "shop", role: "manager", password: "temporary-password" });
  STAFF = (await call("POST", "/api/auth/change", { username: "shop", password: "temporary-password", newPassword: "shop-own-password" }, null)).cookie;
  // One business already set up by hand, with its own phone number.
  assert.equal((await call("POST", "/api/admin/wholesale/customers", { business: "The Green Grocers", contact: "", email: "", phone: "01603 111111", status: "Active", note: "" })).status, 201);
});
after(async () => { await srv?.stop(); mock?.close(); });

test("import adds new businesses and fills gaps in existing ones, without duplicates or overwriting", async () => {
  const rows = [
    { business: "The Green Grocers", quickbooksName: "Green Grocers, The", contact: "Pip", email: "pip@greengrocers.example", phone: "07000 000000", address: "1 Earlham Rd, Norwich", postcode: "nr2 3rb" },
    { business: "The Old Dairy", quickbooksName: "The Old Dairy", contact: "Sam Hall", email: "sam@olddairy.example", phone: "", address: "Dairy Lane, Norfolk", postcode: "NR9 4AA" },
    { business: "Cal's Coffee", quickbooksName: "Cal's Coffee", contact: "", email: "", phone: "", address: "", postcode: "" },
  ];
  let r = await call("POST", "/api/admin/wholesale/customers/import", { customers: rows });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.created, r.body.updated, r.body.unchanged], [2, 1, 0]);
  let list = await customers();
  const grocers = list.find((c) => c.business === "The Green Grocers");
  assert.equal(list.filter((c) => c.business === "The Green Grocers").length, 1, "no duplicate");
  assert.deepEqual([grocers.phone, grocers.email, grocers.contact, grocers.postcode, grocers.quickbooksName], ["01603 111111", "pip@greengrocers.example", "Pip", "NR2 3RB", "Green Grocers, The"], "only empty fields filled; the typed phone kept");
  const dairy = list.find((c) => c.business === "The Old Dairy");
  assert.deepEqual([dairy.status, dairy.address, dairy.paymentTerms?.id ?? dairy.paymentTerms], ["Active", "Dairy Lane, Norfolk", "to-agree"]);
  // Again: matched by the QuickBooks name, nothing new; an admin's later edit survives.
  const { id, version, updatedAt, ...fields } = dairy;
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${id}`, { ...fields, paymentTerms: "to-agree", email: "orders@olddairy.example", ifVersion: version })).status, 200);
  r = await call("POST", "/api/admin/wholesale/customers/import", { customers: rows });
  assert.deepEqual([r.body.created, r.body.updated, r.body.unchanged], [0, 0, 3]);
  list = await customers();
  assert.equal(list.length, 3);
  assert.equal(list.find((c) => c.business === "The Old Dairy").email, "orders@olddairy.example", "admin's edit kept");
  assert.equal(list.find((c) => c.business === "The Old Dairy").quickbooksName, "The Old Dairy", "kept through an admin save");
  for (const bad of [[], [{ business: "" }], Array(501).fill({ business: "x" })]) assert.equal((await call("POST", "/api/admin/wholesale/customers/import", { customers: bad })).status, 400);
});

test("invites email a one-time link; accepting it makes an approved account and signs in", async () => {
  const list = await customers(), dairy = list.find((c) => c.business === "The Old Dairy"), cals = list.find((c) => c.business === "Cal's Coffee");
  take();
  let r = await call("POST", "/api/admin/wholesale/customers/invites", { customerIds: [dairy.id, cals.id] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.results, { [dairy.id]: "sent", [cals.id]: "no_email" });
  assert.ok(r.body.invites[dairy.id] && !r.body.invites[dairy.id].used);
  await settle(1);
  const [mail] = take();
  assert.deepEqual(mail.to, ["orders@olddairy.example"]);
  assert.equal(mail.reply_to, "sales@strangerscoffee.com");
  assert.match(mail.subject, /Order your Strangers Coffee online/);
  assert.match(mail.html, /Set up your account/); assert.match(mail.text, /The Old Dairy/);
  const token = tokenOf(mail);
  // A second invite replaces the first.
  await call("POST", `/api/admin/wholesale/customers/${dairy.id}/invite`, {});
  await settle(1); const token2 = tokenOf(take()[0]);
  assert.equal((await call("GET", "/api/wholesale/auth/invite?token=" + token, undefined, null)).status, 404, "the old link no longer works");
  const info = await call("GET", "/api/wholesale/auth/invite?token=" + token2, undefined, null);
  assert.deepEqual(info.body, { business: "The Old Dairy", contact: "Sam Hall" });
  assert.equal((await call("POST", "/api/wholesale/auth/invite", { token: token2, username: "x", password: "short" }, null)).status, 400);
  const accepted = await call("POST", "/api/wholesale/auth/invite", { token: token2, username: "olddairy", password: "dairy-own-password" }, null);
  assert.equal(accepted.status, 201, accepted.text);
  assert.ok(accepted.cookie, "signed in straight away");
  const session = (await call("GET", "/api/wholesale/session", undefined, accepted.cookie)).body;
  assert.equal(session.customer.business, "The Old Dairy");
  assert.equal(session.customer.quickbooksName, undefined, "never shown to the customer");
  assert.equal((await call("POST", "/api/wholesale/auth/login", { username: "olddairy", password: "dairy-own-password" }, null)).status, 200);
  // Used: can't be used again, and the business can't be invited again.
  assert.equal((await call("POST", "/api/wholesale/auth/invite", { token: token2, username: "olddairy2", password: "dairy-own-password" }, null)).status, 410);
  assert.equal((await call("POST", `/api/admin/wholesale/customers/${dairy.id}/invite`, {})).body.results[dairy.id], "account");
  assert.equal((await call("GET", "/api/admin/wholesale/customers/invites")).body.invites[dairy.id].used, true);
  assert.equal((await call("GET", "/api/wholesale/auth/invite?token=" + "ab".repeat(32), undefined, null)).status, 404);
});

test("a taken username keeps the invite usable; the daily email limit stops sending", async () => {
  const grocers = (await customers()).find((c) => c.business === "The Green Grocers");
  take();
  await call("POST", `/api/admin/wholesale/customers/${grocers.id}/invite`, {});
  await settle(1); const token = tokenOf(take()[0]);
  assert.equal((await call("POST", "/api/wholesale/auth/invite", { token, username: "olddairy", password: "grocers-own-password" }, null)).status, 409);
  assert.equal((await call("POST", "/api/wholesale/auth/invite", { token, username: "greengrocers", password: "grocers-own-password" }, null)).status, 201, "still usable after the clash");
  // EMAIL_DAILY_LIMIT is 6 here and 3 invites have gone: the fourth of these stops at the limit.
  const extra = [];
  for (const n of [1, 2, 3, 4]) extra.push((await call("POST", "/api/admin/wholesale/customers", { business: `Extra ${n}`, contact: "", email: `extra${n}@x.example`, status: "Active", note: "" })).body.customer.id);
  const r = await call("POST", "/api/admin/wholesale/customers/invites", { customerIds: extra });
  assert.deepEqual(Object.values(r.body.results), ["sent", "sent", "sent", "limit"]);
  assert.equal(r.body.invites[extra[3]], undefined, "no invite kept when it couldn't be sent");
});

test("only admins import or invite", async () => {
  for (const cookie of [STAFF, null]) {
    assert.ok([401, 403].includes((await call("POST", "/api/admin/wholesale/customers/import", { customers: [{ business: "Nope" }] }, cookie)).status));
    assert.ok([401, 403].includes((await call("GET", "/api/admin/wholesale/customers/invites", undefined, cookie)).status));
    assert.ok([401, 403].includes((await call("POST", "/api/admin/wholesale/customers/invites", { customerIds: [crypto.randomUUID()] }, cookie)).status));
  }
  assert.ok(!(await customers()).some((c) => c.business === "Nope"));
});
