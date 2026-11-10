import type { Env } from "../http";
export async function migrateQuickBooks(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS quickbooks_connection(id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL DEFAULT 'disconnected', generation TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, realm_id TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT '', vat_number TEXT NOT NULL DEFAULT '', token_data TEXT, token_version INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, connected_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare("INSERT OR IGNORE INTO quickbooks_connection(id,generation) VALUES(1,lower(hex(randomblob(16))))"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS quickbooks_oauth_states(state_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL, session_hash TEXT NOT NULL, connection_version INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS quickbooks_mappings(realm_id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS quickbooks_installation(id INTEGER PRIMARY KEY CHECK(id=1), namespace TEXT NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO quickbooks_installation VALUES(1,lower(hex(randomblob(16))))"),
  ]);
}
