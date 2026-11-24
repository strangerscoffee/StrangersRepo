// The release applies the schema before activating a Worker. Local and legacy environments can initialise it on demand.
import { ApiError, type Env } from "./http";
import { migrateHolidayReminders, migrateLeave } from "./rota/leave/schema";
import { migrateSickness } from "./rota/sickness";
import { migrateInvites } from "./wholesaleImport";
import { migrateAnnouncement } from "./wholesaleAnnouncement";
import { migrateResets } from "./wholesaleReset";
import { migrateInsights } from "./insights";
import { migrateReporting } from "./reporting";
import { migrateQuickBooks } from "./quickbooks/schema";
import { migrateQuickBooksRuntime } from "./quickbooks/runtimeSchema";

import {migrateQuickBooksAppSettings} from "./quickbooks/appSettings";

const SCHEMA = [
  // Every diary document, stored by path (see docs/data-model.md).
  `CREATE TABLE IF NOT EXISTS docs (
    path        TEXT PRIMARY KEY,           -- e.g. 'sites/cafe/days/2026-10-27'
    collection  TEXT NOT NULL,              -- e.g. 'sites/cafe/days'
    doc_id      TEXT NOT NULL,              -- e.g. '2026-10-27'
    data        TEXT,                       -- JSON; NULL when deleted
    updated_at  INTEGER NOT NULL,           -- ms since epoch
    source      TEXT NOT NULL,              -- 'web'; 'claude' on rows copied from the old Claude diary
    deleted     INTEGER NOT NULL DEFAULT 0, -- tombstone (deletes are kept as rows; the page's polling relies on it)
    claude_data TEXT,                       -- unused since the Claude sync was removed
    seq         INTEGER NOT NULL DEFAULT 0, -- change counter used by the page's live polling
    updated_by  TEXT                        -- 'web:<name>', for auditing
  )`,
  "CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection, deleted)",
  "CREATE INDEX IF NOT EXISTS docs_web_changes ON docs(source, updated_at)",
  "CREATE INDEX IF NOT EXISTS docs_collection_seq ON docs(collection, seq)",
  // A range of days at one site (the rota's closed days), without reading every day ever recorded.
  "CREATE INDEX IF NOT EXISTS docs_collection_doc ON docs(collection, doc_id)",
  // Small key/value table: 'seq' (bumped on every write) and 'lastApplyAt'.
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  // Sessions signed out on their own (POST /api/auth/logout), until they'd have expired anyway.
  "CREATE TABLE IF NOT EXISTS revoked_sessions (sid TEXT PRIMARY KEY, exp INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0), ('lastApplyAt', 0)",
  // Change counters for live pages on several devices (GET /api/changes): the rota's and the accounts'.
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('rota', 0), ('accounts', 0)",
  // Staff accounts (sign in with username + password). Records use 'web:<name>' as the user id.
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,             -- random
    name          TEXT NOT NULL,                -- as shown on records, e.g. 'Sam Patel'
    name_key      TEXT NOT NULL UNIQUE,         -- lower-cased name, so two people can't share a name on records
    username      TEXT UNIQUE,                  -- lower-case sign-in name, e.g. 'sam.patel'
    role          TEXT NOT NULL,                -- 'admin' | 'manager' | 'staff'
    pin_hash      TEXT NOT NULL,                -- password hash (the column names date from 4-6 digit PINs)
    pin_salt      TEXT NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0,   -- 1 = choose a new password at next sign-in
    active        INTEGER NOT NULL DEFAULT 1,
    session_ver   INTEGER NOT NULL DEFAULT 1,   -- bump to sign this person out everywhere
    failed        INTEGER NOT NULL DEFAULT 0,   -- wrong passwords or quick PINs in a row
    locked_until  INTEGER NOT NULL DEFAULT 0,   -- ms since epoch
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    quick_hash    TEXT,                         -- 4-digit quick-switch PIN hash (NULL = not set)
    quick_salt    TEXT
  )`,
  // Server-generated secrets (the session signing key), created on first use.
  "CREATE TABLE IF NOT EXISTS secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  // Per-IP write counters for rate limiting.
  "CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT NOT NULL, window INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, window))",
  // The staff rota (src/rota.ts, docs/data-model.md). Its own tables, because it needs per-row rules.
  `CREATE TABLE IF NOT EXISTS rota_shifts (
    id          TEXT PRIMARY KEY,
    site        TEXT NOT NULL,                -- roastery | cafe | asg | factory
    day         TEXT NOT NULL,                -- YYYY-MM-DD
    start       TEXT NOT NULL,                -- HH:MM, UK time
    end         TEXT NOT NULL,                -- HH:MM, after start
    break_mins  INTEGER NOT NULL DEFAULT 0,   -- unpaid
    job         TEXT NOT NULL DEFAULT '',     -- 'opens' | 'closes' | ''
    user_id     TEXT,                         -- users.id; NULL = open shift
    note        TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT NOT NULL,                -- users.id
    actual_start TEXT,                        -- amended on the day (HH:MM); NULL = as planned
    actual_end   TEXT,
    actual_break INTEGER,                     -- unpaid minutes actually taken; NULL = as planned
    adjust_note  TEXT NOT NULL DEFAULT '',    -- why, for example "went home sick"
    adjusted_by  TEXT,
    adjusted_at  INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS rota_shifts_day ON rota_shifts(day)",
  "CREATE INDEX IF NOT EXISTS rota_shifts_user_day ON rota_shifts(user_id, day)",
  `CREATE TABLE IF NOT EXISTS rota_weeks (
    week          TEXT PRIMARY KEY,           -- the Monday, YYYY-MM-DD
    published_at  INTEGER,                    -- NULL = draft
    published_by  TEXT,
    changed_at    INTEGER,                    -- last shift change in the week
    changes       INTEGER NOT NULL DEFAULT 0  -- shift changes since it was last published
  )`,
  `CREATE TABLE IF NOT EXISTS rota_sites (
    site        TEXT PRIMARY KEY,
    opens_at    TEXT,                         -- HH:MM; NULL = not set
    closes_at   TEXT,
    min_people  INTEGER NOT NULL DEFAULT 1,   -- wanted on shift for every open hour
    day_hours   TEXT NOT NULL DEFAULT '{}'    -- JSON {"sat"|"sun"|…: {"opensAt","closesAt"}}: days with other hours
  )`,
  `CREATE TABLE IF NOT EXISTS rota_people (
    user_id         TEXT PRIMARY KEY,         -- users.id
    contract_hours  REAL,                     -- per week; NULL = none (kept equal to contract_max)
    contract_min    REAL,                     -- contracted hours a week, at least; NULL = none
    contract_max    REAL,                     -- and at most; more is overtime; NULL = none
    sites           TEXT NOT NULL DEFAULT '[]', -- JSON site ids they can get to; [] = any
    pattern         TEXT NOT NULL DEFAULT '{}', -- JSON {"mon":{"from","to"}|"any"|"off", …}; missing day = any
    updated_at      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rota_time_off (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    from_day    TEXT NOT NULL,                -- inclusive
    to_day      TEXT NOT NULL,                -- inclusive
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,                -- requested | approved | declined | cancelled
    decided_by  TEXT, decided_at INTEGER,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rota_requests (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,                -- claim (take an open shift) | cover (give my shift away)
    shift_id    TEXT NOT NULL,
    from_user   TEXT NOT NULL,                -- who asked
    to_user     TEXT,                         -- cover: who's asked (NULL = anyone)
    taker       TEXT,                         -- who will take the shift
    message     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,                -- open | accepted | approved | declined | cancelled
    decided_by  TEXT, decided_at INTEGER,
    created_at  INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS rota_requests_shift ON rota_requests(shift_id, status)",
  "CREATE INDEX IF NOT EXISTS rota_requests_status ON rota_requests(status, decided_at)",
  "CREATE INDEX IF NOT EXISTS rota_time_off_user ON rota_time_off(user_id, to_day)",
  "CREATE INDEX IF NOT EXISTS rota_time_off_status ON rota_time_off(status, from_day)",
  // Account and admin events for the admin section's Activity and Security pages (src/audit.ts): who added or
  // changed an account, lockouts, failed sign-ins, backups made by hand. Never passwords or PINs.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,                 -- ms since epoch
    kind    TEXT NOT NULL,                    -- e.g. user_added, role_changed, locked, signin_failed, backup
    actor   TEXT,                             -- who did it (a name), NULL for the system
    text    TEXT NOT NULL                     -- what happened, in words
  )`,
  "CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at)",
  // Errors from the site's pages and the Worker, one row per error and page with a count (src/errors.ts).
  `CREATE TABLE IF NOT EXISTS errors (
    key TEXT PRIMARY KEY, source TEXT NOT NULL, app TEXT NOT NULL, page TEXT NOT NULL, message TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '', ua TEXT NOT NULL DEFAULT '', who TEXT, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, count INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS errors_last ON errors(last_at)",
];

/*
 * Migrations: numbered, run once each, in order, and recorded in schema_migrations (id, name, applied_at). Add new ones
 * at the end with the next id; never change or reorder one that has shipped. Each also checks before it changes
 * anything, so it's safe if two Worker instances start at once, and on databases from before this list (which
 * already have some of these changes): running one again changes nothing.
 */
interface Migration { id: number; name: string; run(env: Env): Promise<void> }

const columns = async (env: Env, table: string) =>
  new Set((await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name));
const runAll = (env: Env, steps: string[]) => (steps.length ? env.DB.batch(steps.map((s) => env.DB.prepare(s))).then(() => undefined) : Promise.resolve());

const MIGRATIONS: Migration[] = [
  { id: 1, name: "rota: amended hours on shifts", async run(env) {
    const has = await columns(env, "rota_shifts");
    await runAll(env, [["actual_start", "TEXT"], ["actual_end", "TEXT"], ["actual_break", "INTEGER"], ["adjust_note", "TEXT NOT NULL DEFAULT ''"], ["adjusted_by", "TEXT"], ["adjusted_at", "INTEGER"]]
      .filter(([c]) => !has.has(c)).map(([c, type]) => `ALTER TABLE rota_shifts ADD COLUMN ${c} ${type}`));
  } },
  { id: 2, name: "rota: opening hours by day", async run(env) {
    if (!(await columns(env, "rota_sites")).has("day_hours")) await runAll(env, ["ALTER TABLE rota_sites ADD COLUMN day_hours TEXT NOT NULL DEFAULT '{}'"]);
  } },
  { id: 3, name: "rota: contract ranges (min and max), from the old single contract_hours", async run(env) {
    if ((await columns(env, "rota_people")).has("contract_min")) return;
    await runAll(env, ["ALTER TABLE rota_people ADD COLUMN contract_min REAL", "ALTER TABLE rota_people ADD COLUMN contract_max REAL",
      "UPDATE rota_people SET contract_min = contract_hours, contract_max = contract_hours WHERE contract_hours IS NOT NULL"]);
  } },
  // Before usernames and passwords (when people signed in with name + PIN): each account gets a username made from
  // its name, and must choose a password at next sign-in (their old PIN works for that sign-in).
  { id: 4, name: "accounts: usernames and choosing a password", async run(env) {
    const has = await columns(env, "users");
    if (has.has("username") && has.has("must_change")) return;
    const steps: string[] = [];
    if (!has.has("username")) steps.push("ALTER TABLE users ADD COLUMN username TEXT");
    if (!has.has("must_change")) steps.push("ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0");
    steps.push(
      "UPDATE users SET username = lower(replace(trim(name), ' ', '.')), must_change = 1 WHERE username IS NULL",
      // Same name twice is already impossible (name_key is unique), but keep usernames unique regardless.
      "UPDATE users SET username = username || '-' || substr(id, 1, 4) WHERE rowid NOT IN (SELECT min(rowid) FROM users GROUP BY username)",
    );
    await runAll(env, steps);
  } },
  { id: 5, name: "accounts: quick PINs", async run(env) {
    if (!(await columns(env, "users")).has("quick_hash")) await runAll(env, ["ALTER TABLE users ADD COLUMN quick_hash TEXT", "ALTER TABLE users ADD COLUMN quick_salt TEXT"]);
  } },
  // Notifications (the diary's bell): the time up to which this person has seen them, on any device.
  { id: 6, name: "accounts: notifications seen", async run(env) {
    if (!(await columns(env, "users")).has("notif_seen")) await runAll(env, ["ALTER TABLE users ADD COLUMN notif_seen INTEGER NOT NULL DEFAULT 0"]);
  } },
  { id: 7, name: "accounts: unique usernames", async run(env) {
    await runAll(env, ["CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)"]);
  } },
  // The fields pages sort diary lists by, so a site's latest 400 days (or deliveries, or Prove it records) are read
  // straight off an index however many years have built up (src/docs.ts queryStatement). The expressions must match
  // that query's exactly.
  { id: 8, name: "diary: indexes for lists by date, week and time", async run(env) {
    await runAll(env, ["date", "week", "at"].map((f) =>
      `CREATE INDEX IF NOT EXISTS docs_by_${f} ON docs(collection, deleted, json_extract(data, '$.${f}'), doc_id)`));
  } },
  // Rota emails (src/email/): each person's address (set by admins) and which emails they want; and, per week, what
  // each person was last emailed about it, so "Publish changes" emails only the people whose shifts changed.
  { id: 9, name: "rota emails: addresses, preferences and what was sent", async run(env) {
    const users = await columns(env, "users"), weeks = await columns(env, "rota_weeks");
    await runAll(env, [
      ...(users.has("email") ? [] : ["ALTER TABLE users ADD COLUMN email TEXT"]),
      ...(users.has("email_prefs") ? [] : ["ALTER TABLE users ADD COLUMN email_prefs TEXT NOT NULL DEFAULT '{}'"]),
      ...(weeks.has("emailed") ? [] : ["ALTER TABLE rota_weeks ADD COLUMN emailed TEXT"]),
    ]);
  } },
  { id: 10, name: "admin overview: notices an admin has dismissed", async run(env) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_dismissed (key TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT)").run();
  } },
  { id: 11, name: "wholesale preview: shared orders, customers and catalogue settings", async run(env) {
    await runAll(env, [
      "CREATE TABLE IF NOT EXISTS wholesale_preview (kind TEXT NOT NULL CHECK(kind IN ('order', 'customer', 'catalogue')), id TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(kind, id))",
      "CREATE INDEX IF NOT EXISTS wholesale_preview_updated ON wholesale_preview(kind, updated_at DESC, id)",
    ]);
  } },
  { id: 12, name: "wholesale customer accounts and isolated sessions", async run(env) {
    await runAll(env, [
      "CREATE TABLE IF NOT EXISTS wholesale_accounts (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, approval_status TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending', 'approved', 'rejected')), session_ver INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER)",
      "CREATE TABLE IF NOT EXISTS wholesale_sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES wholesale_accounts(id) ON DELETE CASCADE, session_ver INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS wholesale_sessions_expiry ON wholesale_sessions(expires_at)",
      "CREATE INDEX IF NOT EXISTS wholesale_sessions_account ON wholesale_sessions(account_id)",
      "CREATE INDEX IF NOT EXISTS wholesale_customer_orders ON wholesale_preview(kind, json_extract(data, '$.customerId'), updated_at DESC)",
    ]);
  } },
  { id: 13, name: "wholesale immutable VAT invoices and payment records", async run(env) {
    await runAll(env, [
      "CREATE TABLE IF NOT EXISTS wholesale_invoice_settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS wholesale_invoices (seq INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, request_key TEXT NOT NULL, data TEXT NOT NULL, issued_at INTEGER NOT NULL, issued_by TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)), paid_date TEXT, paid_at INTEGER, payment_reference TEXT NOT NULL DEFAULT '', payment_version INTEGER NOT NULL DEFAULT 1)",
      "CREATE INDEX IF NOT EXISTS wholesale_invoices_customer ON wholesale_invoices(customer_id, seq DESC)",
    ]);
  } },
  { id: 14, name: "verified employee privacy metadata", async run(env) {
    // Existing JSON fields were client-writable. Only a validated new write can verify them.
    if (!(await columns(env, "docs")).has("employee_privacy_version")) {
      try { await env.DB.prepare("ALTER TABLE docs ADD COLUMN employee_privacy_version INTEGER").run(); }
      catch (error) { if (!(await columns(env, "docs")).has("employee_privacy_version")) throw error; }
    }
    // Claim this cutover in the same transaction as its one-time counters. Concurrent isolates must not
    // invalidate sessions created after another isolate has already completed the migration.
    await env.DB.batch([
      env.DB.prepare("UPDATE meta SET v=v+1 WHERE k='seq' AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE id=14)"),
      env.DB.prepare("UPDATE users SET session_ver=session_ver+1 WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE id=14)"),
      env.DB.prepare("INSERT OR IGNORE INTO schema_migrations(id,name,applied_at) VALUES(14,?,?)").bind("verified employee privacy metadata", Date.now()),
    ]);
  } },
  { id: 15, name: "QuickBooks sandbox connection", run: migrateQuickBooks },
  { id: 16, name: "QuickBooks environments and durable accounting operations", run: migrateQuickBooksRuntime },
  { id: 17, name: "Encrypted QuickBooks app settings", run: migrateQuickBooksAppSettings },
  { id: 18, name: "Read-only staff wholesale order access", run: async env => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS staff_order_access (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)").run();
  } },
  { id: 19, name: "Wholesale new-order emails", run: async env => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_order_emails (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  } },
  { id: 20, name: "Wholesale new-order Slack posts", run: async env => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS slack_order_posts (order_id TEXT PRIMARY KEY, payload TEXT NOT NULL, send_after INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS slack_order_posts_due ON slack_order_posts (sent_at, send_after)"),
    ]);
  } },
  { id: 21, name: "Wholesale insights and QuickBooks sales history", run: migrateInsights },
  { id: 22, name: "Wholesale customer tabs", run: async env => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_tabs (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, cleared_at INTEGER NOT NULL, data TEXT NOT NULL)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_tabs_cleared ON wholesale_tabs (cleared_at)"),
    ]);
  } },
  { id: 23, name: "Wholesale invites", run: migrateInvites },
  { id: 24, name: "Rota holiday allowances, calendar and absence records", run: migrateLeave },
  // The owner's decision (13 Nov 2026): every wholesale business whose payment terms were still "To be agreed" (or never
  // set) moves to "30 days from invoice". Businesses already on other terms are left alone; orders keep their snapshots.
  // Runs once; businesses added later start on "To be agreed" as usual.
  { id: 25, name: "Wholesale businesses on To be agreed move to 30 days from invoice", run: async env => {
    const now = Date.now();
    const result = await env.DB.prepare("UPDATE wholesale_preview SET data = json_set(data, '$.paymentTerms', 'net-30'), version = version + 1, updated_at = ? WHERE kind = 'customer' AND COALESCE(json_extract(data, '$.paymentTerms'), 'to-agree') NOT IN ('before-dispatch', 'net-7', 'net-14', 'net-30', 'net-60', 'custom')").bind(now).run();
    const changed = result.meta?.changes || 0;
    if (changed) await env.DB.prepare("INSERT INTO audit_log (at, kind, actor, text) VALUES (?, 'wholesale_terms_bulk', 'system', ?)").bind(now, `Payment terms set to 30 days from invoice for ${changed} wholesale ${changed === 1 ? "business" : "businesses"} that were on To be agreed.`).run();
  } },
  { id: 26, name: "Self-certified sickness forms", run: migrateSickness },
  // The diary's morning and end-of-day Slack reminders (src/slackDiary.ts): one row per site, day and slot, so each
  // is sent once.
  { id: 27, name: "Diary Slack reminders", run: async env => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS slack_diary_posts (site TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (site, day, slot))").run();
  } },
  { id: 28, name: "Wholesale password reset links", run: migrateResets },
  { id: 29, name: "Wholesale ordering page announcement", run: migrateAnnouncement },
  { id: 30, name: "Recoverable wholesale notification delivery", run: async env => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_email_outbox (event_key TEXT PRIMARY KEY,order_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,attempted_at INTEGER,first_attempt_at INTEGER,lease_until INTEGER,claim_token TEXT,uncertain INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,last_error TEXT)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_email_outbox_due ON wholesale_email_outbox(state,next_attempt_at,lease_until)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS slack_order_delivery (order_id TEXT PRIMARY KEY,state TEXT NOT NULL,claim_token TEXT,lease_until INTEGER,attempted_at INTEGER,updated_at INTEGER NOT NULL,last_error TEXT)"),
      // Preserve historical sent markers: legacy acknowledged sends and interrupted claims cannot be distinguished.
      env.DB.prepare("INSERT OR IGNORE INTO slack_order_delivery(order_id,state,updated_at,last_error) SELECT order_id,CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN attempts>=6 THEN 'failed' ELSE 'queued' END,created_at,last_error FROM slack_order_posts"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS slack_order_delivery_lease ON slack_order_delivery(state,lease_until)"),
    ]);
  } },
  { id: 31, name: "Email delivery feedback and suppression", run: async env => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS email_delivery_messages (id TEXT PRIMARY KEY,provider_id TEXT,recipient TEXT NOT NULL,recipient_name TEXT NOT NULL,subject TEXT NOT NULL,stream TEXT NOT NULL,about TEXT NOT NULL,accepted_at INTEGER NOT NULL)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS email_delivery_provider ON email_delivery_messages(provider_id) WHERE provider_id IS NOT NULL"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS email_delivery_recent ON email_delivery_messages(accepted_at DESC)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS email_delivery_recipient ON email_delivery_messages(recipient)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS email_delivery_events (id TEXT PRIMARY KEY,provider_id TEXT,type TEXT NOT NULL,event_at INTEGER NOT NULL,received_at INTEGER NOT NULL,recipients TEXT NOT NULL,reason TEXT NOT NULL,ingest_id TEXT NOT NULL)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS email_delivery_event_message ON email_delivery_events(provider_id,type,event_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS email_suppressions (email TEXT PRIMARY KEY,active INTEGER NOT NULL,source TEXT NOT NULL,event_at INTEGER NOT NULL,event_id TEXT NOT NULL)"),
    ]);
  } },
  // Holiday for extra hours and reminders about holiday left to take (src/rota/leave/accrual.ts, reminders.ts).
  { id: 32, name: "Holiday reminders and contract history", run: migrateHolidayReminders },
  // Bradford Factor review: an absence left out (with a reason) or joined to the spell before (src/rota/sickness.ts).
  { id: 33, name: "Bradford Factor review", run: async (env) => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_bradford_review (time_off_id TEXT PRIMARY KEY, excluded_reason TEXT, continues INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)").run();
  } },
  // The private staff profile (src/profile.ts) and each person's primary site on the rota.
  { id: 34, name: "Staff profile and primary site", run: async (env) => {
    const users = await columns(env, "users"), people = await columns(env, "rota_people");
    await runAll(env, [
      ...(users.has("start_date") ? [] : ["ALTER TABLE users ADD COLUMN start_date TEXT"]),
      ...(users.has("phone") ? [] : ["ALTER TABLE users ADD COLUMN phone TEXT"]),
      ...(users.has("home_address") ? [] : ["ALTER TABLE users ADD COLUMN home_address TEXT"]),
      ...(users.has("profile_version") ? [] : ["ALTER TABLE users ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0"]),
      ...(people.has("primary_site") ? [] : ["ALTER TABLE rota_people ADD COLUMN primary_site TEXT"]),
    ]);
  } },
  // What each week looked like when it was last published (src/rota/changes.ts), to show what's changed since.
  { id: 35, name: "Published week snapshot", run: async (env) => {
    if (!(await columns(env, "rota_weeks")).has("published_shifts")) await env.DB.prepare("ALTER TABLE rota_weeks ADD COLUMN published_shifts TEXT").run();
  } },
  { id: 36, name: "Operational totals and Insights snapshots", run: migrateReporting },
  { id: 37, name: "Recoverable staff email delivery", run: async env => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS staff_email_outbox (
        event_key TEXT PRIMARY KEY,batch_key TEXT NOT NULL,scope TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,
        payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        first_attempt_at INTEGER,lease_until INTEGER,claim_token TEXT,uncertain INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,last_error TEXT
      )`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS staff_email_outbox_due ON staff_email_outbox(state,next_attempt_at,lease_until)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS staff_email_outbox_scope ON staff_email_outbox(scope,user_id,kind,state)"),
    ]);
  } },
  // Automatic invoicing (src/autoInvoice.ts, the owner's request of 23 Nov 2026): its switches, one row per dispatched
  // order or cleared tab it handles, the QuickBooks items made for each coffee and size, each coffee's product number,
  // and whether QuickBooks has emailed an automatically exported invoice.
  { id: 38, name: "Automatic invoicing", run: async env => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_auto_invoicing (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS wholesale_auto_invoices (
        source TEXT PRIMARY KEY, customer_id TEXT NOT NULL, business TEXT NOT NULL DEFAULT '', invoice_id INTEGER, state TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_auto_invoices_due ON wholesale_auto_invoices(state,retry_at)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS quickbooks_product_items (environment TEXT NOT NULL, realm_id TEXT NOT NULL, product_key TEXT NOT NULL,
        item_id TEXT NOT NULL, name TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', created_remote INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY(environment, realm_id, product_key))`),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_product_numbers (product_id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL)"),
    ]);
    const has = await columns(env, "quickbooks_exports");
    for (const [name, type] of [["auto", "INTEGER NOT NULL DEFAULT 0"], ["email_to", "TEXT NOT NULL DEFAULT ''"], ["email_state", "TEXT NOT NULL DEFAULT ''"], ["email_at", "INTEGER NOT NULL DEFAULT 0"], ["email_error", "TEXT NOT NULL DEFAULT ''"]])
      if (!has.has(name)) await env.DB.prepare(`ALTER TABLE quickbooks_exports ADD COLUMN ${name} ${type}`).run();
  } },
  { id: 39, name: "QuickBooks processing safeguards", run: async env => {
    const has = await columns(env, "quickbooks_exports");
    if (!has.has("manual_retry")) await env.DB.prepare("ALTER TABLE quickbooks_exports ADD COLUMN manual_retry INTEGER NOT NULL DEFAULT 0").run();
    await env.DB.batch([
      env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_auto_invoices_invoice ON wholesale_auto_invoices(invoice_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS quickbooks_queued_invoice_events ON quickbooks_events(environment,realm_id,entity_id) WHERE entity='Invoice' AND state='queued'"),
    ]);
  } },
];

async function migrate(env: Env): Promise<void> {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)").run();
  const done = new Set((await env.DB.prepare("SELECT id FROM schema_migrations").all<{ id: number }>()).results.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await m.run(env);
    await env.DB.prepare("INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").bind(m.id, m.name, Date.now()).run();
  }
}

/** The migrations, for tests and the admin section. */
export const MIGRATION_LIST = () => MIGRATIONS.map(({ id, name }) => ({ id, name }));

export async function schemaCurrent(env: Env): Promise<boolean> {
  try {
    const version = await env.DB.prepare(`SELECT COUNT(*) AS applied FROM schema_migrations WHERE id IN (${MIGRATIONS.map(m => m.id).join(",")})`)
      .first<{ applied: number }>();
    return version?.applied === MIGRATIONS.length;
  } catch (error) {
    if (/no such table:\s*schema_migrations/i.test(String(error))) return false;
    throw error;
  }
}

export async function applySchema(env: Env): Promise<void> {
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await migrate(env);
}

// Only completed initialization can cross request lifetimes. A pending D1 promise
// belongs to its creating request and may never settle after that request ends.
const ready = new WeakSet<Env["DB"]>();

export async function ensureSchema(env: Env): Promise<void> {
  if (ready.has(env.DB)) return;
  if (!await schemaCurrent(env)) {
    if (env.SCHEMA_DEPLOY_ONLY === "1") {
      throw new ApiError(503, "schema_pending", "An update is being prepared. Try again shortly.");
    }
    await applySchema(env);
  }
  ready.add(env.DB);
}
