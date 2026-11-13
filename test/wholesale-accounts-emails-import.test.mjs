// Accounts emails from a QuickBooks customer list: exact company-name matches only, nothing added; the list's email
// becomes the accounts email when it isn't the order email; preview, then apply at the previewed versions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const add = async (business, email, extra = {}) => (await call("POST", "/api/admin/wholesale/customers", { business, contact: "Sam", email, status: "Active", ...extra })).body.customer;
const customers = async () => Object.fromEntries((await call("GET", "/api/admin/wholesale")).body.customers.map((c) => [c.business, c]));
before(async () => {
  srv = await startServer({ writeLimit: 1000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  await add("Akcela", "hello@akcela.co.uk");
  await add("Ampersand Brew Co", "andy@ampersandbrew.co");
  await add("Black Rabbit Cafe", "manager@blackrabbitcafe.co.uk");
  await add("Green & Purple", "lee@greenandpurple.net", { accountsEmail: "old@greenandpurple.net" });
  await add("Twin Cafe", "a@twin.example"); await add("Twin Cafe", "b@twin.example");
  await add("No Email Cafe", "");
  await add("Done Cafe", "orders@done.example", { accountsEmail: "accounts@done.example" });
});
after(async () => { await srv?.stop(); });

const rows = [
  { company: "Akcela", emails: ["accounts@akcela.co.uk"] },
  { company: "Ampersand Brew Co", emails: ["andy@ampersandbrew.co"] },
  { company: "Black Rabbit Cafe", emails: ["accounts@blackrabbitcafe.co.uk", "blackrabbitcafe@multiple.dext.cc", "manager@blackrabbitcafe.co.uk"] },
  { company: "Green & Purple", emails: ["accounts@greenandpurple.net", "lee@greenandpurple.net"] },
  { company: "akcela", emails: ["someone@akcela.co.uk"] },
  { company: "A Bit on the Side", emails: ["kathryn@example.com"] },
  { company: "Twin Cafe", emails: ["x@twin.example"] },
  { company: "No Email Cafe", emails: ["books@noemail.example"] },
  { company: "Done Cafe", emails: ["accounts@done.example"] },
  { company: "Ampersand Brew Co", emails: ["second@ampersandbrew.co"] },
];

test("preview matches exact names only, adds nothing and saves nothing", async () => {
  const before = await customers();
  const r = await call("POST", "/api/admin/wholesale/customers/accounts-emails", { rows, apply: false });
  assert.equal(r.status, 200, r.text);
  const by = (company) => r.body.results.filter((x) => x.company === company).map((x) => [x.status, x.accountsEmail]);
  assert.deepEqual(by("Akcela"), [["update", "accounts@akcela.co.uk"]]);
  assert.deepEqual(by("Ampersand Brew Co"), [["same", undefined]], "same email: nothing to do, and a repeat row is ignored");
  assert.deepEqual(by("Black Rabbit Cafe"), [["update", "accounts@blackrabbitcafe.co.uk"]]);
  assert.deepEqual(by("Green & Purple"), [["replace", "accounts@greenandpurple.net"]]);
  assert.deepEqual(by("akcela"), [["notFound", undefined]], "names must match exactly");
  assert.deepEqual(by("A Bit on the Side"), [["notFound", undefined]]);
  assert.deepEqual(by("Twin Cafe"), [["ambiguous", undefined]]);
  assert.deepEqual(by("No Email Cafe"), [["update", "books@noemail.example"]], "no order email on the site: the list's email is the accounts email");
  assert.deepEqual(by("Done Cafe"), [["already", "accounts@done.example"]]);
  const after = await customers();
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "nothing added");
  assert.equal(after.Akcela.accountsEmail ?? "", "", "nothing saved by a preview");
});

test("apply saves only the previewed changes, at the previewed versions", async () => {
  const preview = (await call("POST", "/api/admin/wholesale/customers/accounts-emails", { rows, apply: false })).body.results;
  const changes = preview.filter((r) => r.status === "update" || r.status === "replace");
  const versions = Object.fromEntries(changes.map((r) => [r.customerId, r.version]));
  // Someone edits Black Rabbit Cafe after the preview: that one isn't saved.
  const br = (await customers())["Black Rabbit Cafe"];
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${br.id}`, { business: br.business, contact: "Alex", email: br.email, status: "Active", note: "", ifVersion: br.version })).status, 200);
  const r = await call("POST", "/api/admin/wholesale/customers/accounts-emails", { rows, apply: true, versions });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.updated, 3);
  assert.equal(r.body.results.find((x) => x.company === "Black Rabbit Cafe").status, "changed");
  const now = await customers();
  assert.equal(now.Akcela.accountsEmail, "accounts@akcela.co.uk");
  assert.equal(now.Akcela.email, "hello@akcela.co.uk", "the order email is unchanged");
  assert.equal(now["Green & Purple"].accountsEmail, "accounts@greenandpurple.net");
  assert.equal(now["No Email Cafe"].accountsEmail, "books@noemail.example");
  assert.equal(now["Black Rabbit Cafe"].accountsEmail ?? "", "");
  assert.equal(now["Ampersand Brew Co"].accountsEmail ?? "", "");
  const log = srv.sql("SELECT text FROM audit_log WHERE kind = 'wholesale_accounts_emails'");
  assert.match(JSON.stringify(log), /on 3 wholesale businesses/);
});

test("refuses bad input; only admins may use it", async () => {
  assert.equal((await call("POST", "/api/admin/wholesale/customers/accounts-emails", { rows: "nope" })).status, 400);
  assert.ok([401, 403].includes((await call("POST", "/api/admin/wholesale/customers/accounts-emails", { rows: [] }, null)).status));
});
