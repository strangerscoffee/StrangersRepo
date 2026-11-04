// The database schema. The Worker applies it itself (once per Worker instance) so a fresh deploy needs no
// migration step. Every statement is idempotent. To change the schema later, append statements here
// (for example ALTER TABLE ... ADD COLUMN guarded by a check of pragma_table_info).
import { Env } from "./http";

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
];

// Upgrades older databases in place:
// - before usernames and passwords (when people signed in with name + PIN): each account gets a username
//   made from its name, and must choose a password at next sign-in (their old PIN works for that sign-in);
// - before quick switching: adds the quick-PIN columns;
// - before day-by-day opening hours, amended shifts and contract ranges: adds those rota columns
//   (contract_min and contract_max start as the old single contract_hours).
async function migrateRota(env: Env): Promise<void> {
  const cols = await env.DB.prepare(
    "SELECT 'shifts' AS t, name FROM pragma_table_info('rota_shifts') UNION ALL SELECT 'sites', name FROM pragma_table_info('rota_sites') UNION ALL SELECT 'people', name FROM pragma_table_info('rota_people')",
  ).all<{ t: string; name: string }>();
  const has = (t: string, c: string) => cols.results.some((x) => x.t === t && x.name === c);
  const steps: string[] = [];
  for (const [c, type] of [["actual_start", "TEXT"], ["actual_end", "TEXT"], ["actual_break", "INTEGER"], ["adjust_note", "TEXT NOT NULL DEFAULT ''"], ["adjusted_by", "TEXT"], ["adjusted_at", "INTEGER"]]) {
    if (!has("shifts", c)) steps.push(`ALTER TABLE rota_shifts ADD COLUMN ${c} ${type}`);
  }
  if (!has("sites", "day_hours")) steps.push("ALTER TABLE rota_sites ADD COLUMN day_hours TEXT NOT NULL DEFAULT '{}'");
  if (!has("people", "contract_min")) {
    steps.push("ALTER TABLE rota_people ADD COLUMN contract_min REAL", "ALTER TABLE rota_people ADD COLUMN contract_max REAL",
      "UPDATE rota_people SET contract_min = contract_hours, contract_max = contract_hours WHERE contract_hours IS NOT NULL");
  }
  if (steps.length) await env.DB.batch(steps.map((s) => env.DB.prepare(s)));
}

async function migrate(env: Env): Promise<void> {
  await migrateRota(env);
  const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('users')").all<{ name: string }>();
  const has = new Set(cols.results.map((c) => c.name));
  const steps: string[] = [];
  if (!has.has("username") || !has.has("must_change")) {
    if (!has.has("username")) steps.push("ALTER TABLE users ADD COLUMN username TEXT");
    if (!has.has("must_change")) steps.push("ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0");
    steps.push(
      "UPDATE users SET username = lower(replace(trim(name), ' ', '.')), must_change = 1 WHERE username IS NULL",
      // Same name twice is already impossible (name_key is unique), but keep usernames unique regardless.
      "UPDATE users SET username = username || '-' || substr(id, 1, 4) WHERE rowid NOT IN (SELECT min(rowid) FROM users GROUP BY username)",
    );
  }
  if (!has.has("quick_hash")) steps.push("ALTER TABLE users ADD COLUMN quick_hash TEXT", "ALTER TABLE users ADD COLUMN quick_salt TEXT");
  // Notifications (the diary's bell): the time up to which this person has seen them, on any device.
  if (!has.has("notif_seen")) steps.push("ALTER TABLE users ADD COLUMN notif_seen INTEGER NOT NULL DEFAULT 0");
  if (steps.length) await env.DB.batch(steps.map((s) => env.DB.prepare(s)));
}

let ready: Promise<unknown> | null = null;

export function ensureSchema(env: Env): Promise<unknown> {
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => migrate(env)).then(() =>
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)").run(),
    ).catch((e) => {
      ready = null; // retry on the next request
      throw e;
    });
  }
  return ready;
}
