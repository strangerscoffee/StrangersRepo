// Migration 25: businesses still on "To be agreed" (or with no terms) move to "30 days from invoice" once; any other
// terms, and businesses added afterwards, are left alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN;
const cookieOf = (r) => (r.headers.getSetCookie().find((v) => /^sfbb_session=[\w-]/.test(v)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const r = await fetch(srv.base + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, body: data, cookie: cookieOf(r), text };
}
const row = (id, terms) => `('customer', '${id}', '${JSON.stringify({ business: id, contact: "Sam", email: "", status: "Active", note: "", ...(terms === undefined ? {} : { paymentTerms: terms }), ...(terms === "custom" ? { paymentNote: "Monthly statement" } : {}) })}', 3, 1)`;
before(async () => {
  srv = await startServer({ preSql: [
    "CREATE TABLE IF NOT EXISTS wholesale_preview (kind TEXT NOT NULL CHECK(kind IN ('order', 'customer', 'catalogue')), id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(kind, id))",
    `INSERT INTO wholesale_preview (kind, id, data, version, updated_at) VALUES ${[row("Agree Cafe", "to-agree"), row("Unset Cafe"), row("Fortnight Cafe", "net-14"), row("Custom Cafe", "custom"), row("Prepay Cafe", "before-dispatch")].join(", ")}`,
  ].join("; ") });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Admin", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
});
after(async () => { await srv?.stop(); });

test("To be agreed and unset businesses move to 30 days from invoice; others keep their terms", async () => {
  const customers = (await call("GET", "/api/admin/wholesale")).body.customers;
  const terms = Object.fromEntries(customers.map((c) => [c.business, c.paymentTerms]));
  assert.deepEqual(terms, { "Agree Cafe": "net-30", "Unset Cafe": "net-30", "Fortnight Cafe": "net-14", "Custom Cafe": "custom", "Prepay Cafe": "before-dispatch" });
  const byName = Object.fromEntries(customers.map((c) => [c.business, c]));
  assert.equal(byName["Agree Cafe"].version, 4, "changed records get a new version, so open editors see the change");
  assert.equal(byName["Fortnight Cafe"].version, 3);
  assert.equal(byName["Custom Cafe"].paymentNote, "Monthly statement");
  const log = srv.sql("SELECT text FROM audit_log WHERE kind = 'wholesale_terms_bulk'");
  assert.match(JSON.stringify(log), /for 2 wholesale businesses/);
});

test("a business added afterwards still starts on To be agreed", async () => {
  const made = await call("POST", "/api/admin/wholesale/customers", { business: "New Cafe", contact: "Jo", email: "", status: "Active" });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.customer.paymentTerms ?? "to-agree", "to-agree");
});
