// Upgrading a database from name + PIN accounts to username + password. Run with `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { startServer } from "./harness.mjs";

// The users table as it was when people signed in with name + PIN.
const salt = "0123456789abcdef0123456789abcdef";
const pinHash = "p3000:" + pbkdf2Sync("1234", salt, 3000, 32, "sha256").toString("hex");
const OLD = `
CREATE TABLE docs (path TEXT PRIMARY KEY, collection TEXT NOT NULL, doc_id TEXT NOT NULL, data TEXT,
  updated_at INTEGER NOT NULL, source TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, claude_data TEXT,
  seq INTEGER NOT NULL DEFAULT 0, updated_by TEXT);
CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO meta VALUES ('seq',8);
INSERT INTO docs (path,collection,doc_id,data,updated_at,source,seq) VALUES
  ('staff/legacy-claimed','staff','legacy-claimed','{"name":"Sam Patel","ownerUserId":"aaaaaaaaaaaaaaaaaaaaaaaa","notes":"retained historical training"}',1,'web',7),
  ('contacts/legacy-shared','contacts','legacy-shared','{"name":"Legacy personal contact","visibility":"shared-business","phone":"07000 000000"}',1,'web',8);
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, session_ver INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_by TEXT,
  updated_at INTEGER NOT NULL, last_login_at INTEGER);
INSERT INTO users (id, name, name_key, role, pin_hash, pin_salt, created_at, updated_at)
  VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 'Sam Patel', 'sam patel', 'admin', '${pinHash}', '${salt}', 1, 1);
INSERT INTO users (id, name, name_key, role, pin_hash, pin_salt, created_at, updated_at, active) VALUES
  ('bbbbbbbbbbbbbbbbbbbbbbbb','Historical Staff','historical staff','staff','${pinHash}','${salt}',1,1,1),
  ('cccccccccccccccccccccccc','Historical Manager','historical manager','manager','${pinHash}','${salt}',1,1,0);
CREATE TABLE rota_shifts (id TEXT PRIMARY KEY, site TEXT NOT NULL, day TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  break_mins INTEGER NOT NULL DEFAULT 0, job TEXT NOT NULL DEFAULT '', user_id TEXT, note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE rota_sites (site TEXT PRIMARY KEY, opens_at TEXT, closes_at TEXT, min_people INTEGER NOT NULL DEFAULT 1);
CREATE TABLE rota_people (user_id TEXT PRIMARY KEY, contract_hours REAL, sites TEXT NOT NULL DEFAULT '[]', pattern TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
INSERT INTO rota_shifts VALUES ('s1', 'cafe', '2030-01-07', '07:00', '15:00', 30, 'opens', 'aaaaaaaaaaaaaaaaaaaaaaaa', '', 1, 'aaaaaaaaaaaaaaaaaaaaaaaa');
INSERT INTO rota_sites VALUES ('cafe', '07:00', '17:00', 2);
INSERT INTO rota_people VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 20, '[]', '{}', 1);`;

let srv;
before(async () => { srv = await startServer({ preSql: OLD }); });
after(async () => { await srv?.stop(); });

const post = (url, body) => fetch(srv.base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PIN accounts get a username from their name and choose a password at next sign-in", async () => {
  const first = await post("/api/auth/login", { username: "sam.patel", password: "1234" });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { mustChange: true, name: "Sam Patel" });
  assert.equal(first.headers.get("set-cookie"), null, "not signed in until a password is chosen");
  assert.ok(srv.sql("SELECT session_ver,pin_hash FROM users").every(row => row.session_ver === 2 && row.pin_hash === pinHash), "privacy cutover invalidates every old session/device, including admin and inactive accounts, without changing credentials");

  const change = await post("/api/auth/change", { username: "sam.patel", password: "1234", newPassword: "a-real-password" });
  assert.equal(change.status, 200);
  const cookie = change.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  const me = await (await fetch(srv.base + "/api/auth/me", { headers: { cookie } })).json();
  assert.equal(me.user.name, "Sam Patel");
  assert.equal(me.user.role, "admin");

  assert.equal((await post("/api/auth/login", { username: "sam.patel", password: "1234" })).status, 401, "the old PIN stops working");
  const again = await post("/api/auth/login", { username: "sam.patel", password: "a-real-password" });
  assert.ok(again.headers.get("set-cookie"));
});

test("rota tables from before day-by-day hours, amended shifts and contract ranges are upgraded in place", async () => {
  const login = await post("/api/auth/login", { username: "sam.patel", password: "a-real-password" });
  const cookie = login.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  const w = await (await fetch(srv.base + "/api/rota/week?start=2030-01-07", { headers: { cookie } })).json();
  const me = w.people.find((p) => p.name === "Sam Patel");
  assert.deepEqual([me.contractMin, me.contractMax, me.contractHours], [20, 20, 20], "the old contract becomes both ends");
  assert.deepEqual([w.shifts[0].hours, w.shifts[0].adjusted, w.shifts[0].actualStart], [7.5, false, null]);
  const cafe = w.sites.find((s) => s.id === "cafe");
  assert.deepEqual([cafe.opensAt, cafe.minPeople, cafe.dayHours], ["07:00", 2, {}]);
});

test("migrations run once each, in order, and are recorded; the list indexes are used", async () => {
  await post("/api/auth/login", { username: "nobody", password: "x" }); // any API call sets the schema up
  const done = srv.sql("SELECT id, name FROM schema_migrations ORDER BY id");
  assert.deepEqual(done.map((r) => r.id), Array.from({ length: 57 }, (_, index) => index + 1));
  assert.deepEqual(srv.sql("SELECT enabled, version, booking_config, tracking_config FROM wholesale_royal_mail_settings"),
    [{ enabled: 0, version: 0, booking_config: null, tracking_config: null }]);
  assert.deepEqual(srv.sql("SELECT version, scope, automated, manual, length(scope_key) AS keyLength FROM wholesale_royal_mail_setup_checks"),
    [{ version: 0, scope: null, automated: null, manual: "{}", keyLength: 64 }], "setup checks start unconfirmed");
  const shipmentCols = srv.sql("SELECT name FROM pragma_table_info('wholesale_royal_mail_shipments')").map(row => row.name);
  assert.deepEqual(srv.sql("SELECT type,dflt_value FROM pragma_table_info('wholesale_royal_mail_shipments') WHERE name='candidate_provider_id'"),
    [{ type: "INTEGER", dflt_value: null }]);
  for (const column of ["requested_at", "checked_at", "refresh_after", "shipping_fingerprint", "destination_address", "destination_postcode", "recovery_attempts", "recovery_due_at", "booking_connection", "booking_account_scope", "label_downloaded_at", "service_code", "label_order_created_at"]) {
    assert.ok(shipmentCols.includes(column), column);
  }
  const evidencePlan = srv.sql(`EXPLAIN QUERY PLAN SELECT order_id FROM wholesale_royal_mail_shipments
    WHERE booking_connection = 'test' AND provider_id > 0 AND review_required = 0 AND state IN ('labelled','dispatched')
    ORDER BY tracking_number IS NULL, updated_at DESC, order_id LIMIT 12`);
  assert.match(evidencePlan.map(row => row.detail).join(" "), /USING INDEX wholesale_royal_mail_setup_evidence/);
  assert.equal(srv.sql("SELECT dflt_value FROM pragma_table_info('quickbooks_exports') WHERE name='manual_retry'")[0].dflt_value, "0");
  assert.equal(srv.sql("SELECT dflt_value FROM pragma_table_info('quickbooks_exports') WHERE name='paid_review_version'")[0].dflt_value, "0");
  assert.equal(srv.sql("SELECT dflt_value FROM pragma_table_info('quickbooks_observations') WHERE name='payment_voided'")[0].dflt_value, "0");
  assert.equal(srv.sql("SELECT dflt_value FROM pragma_table_info('quickbooks_observations') WHERE name='invoice_issue'")[0].dflt_value, "''");
  assert.deepEqual(srv.sql("SELECT id FROM wholesale_auto_invoicing"), [], "automatic invoicing starts switched off");
  const legacy = srv.sql("SELECT path,data,employee_privacy_version FROM docs ORDER BY path");
  assert.equal(legacy.length, 2);
  assert.ok(legacy.every(row => row.employee_privacy_version === null), "migration never trusts historical owner/shared JSON claims");
  assert.equal(JSON.parse(legacy.find(row => row.path === "staff/legacy-claimed").data).notes, "retained historical training", "the privacy cutover retains the original private content");
  assert.equal(srv.sql("SELECT v FROM meta WHERE k='seq'")[0].v, 9, "privacy cutover moves the change counter once so older live pages fetch filtered snapshots");
  assert.deepEqual(srv.sql("SELECT session_ver FROM users ORDER BY id").map(row => row.session_ver), [3, 2, 2], "cutover runs once; only the admin's subsequent password change increments their version again");
  assert.deepEqual(srv.sql("SELECT kind, id FROM wholesale_preview"), [], "the new preview table starts empty");
  assert.deepEqual(srv.sql("SELECT seq FROM wholesale_invoices"), [], "invoice migration does not issue documents");
  assert.deepEqual(srv.sql("SELECT id FROM wholesale_invoice_settings"), [], "seller and VAT details are not invented by migration");
  assert.deepEqual(srv.sql("SELECT hash FROM wholesale_resets"), [], "reset storage is created without issuing any reset links");
  assert.ok(done.every((r) => r.name), "each has a name");
  // The older rota columns were added by migrations 1-3 on this old database.
  const shiftCols = srv.sql("SELECT name FROM pragma_table_info('rota_shifts')").map((r) => r.name);
  assert.ok(shiftCols.includes("actual_start") && shiftCols.includes("adjusted_at"));
  const plan = srv.sql("EXPLAIN QUERY PLAN SELECT doc_id, data, seq FROM docs WHERE collection = 'days' AND deleted = 0 ORDER BY json_extract(data, '$.date') DESC, doc_id DESC LIMIT 400");
  assert.match(plan.map((r) => r.detail).join(" "), /USING INDEX docs_by_date/);
});

