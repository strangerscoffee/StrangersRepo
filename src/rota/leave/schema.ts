// Leave records extend the existing rota time-off source; no employee data is made public.
import { Env } from "../../http";
export async function migrateLeave(env: Env) {
    const columns = new Set((await env.DB.prepare("PRAGMA table_info(rota_time_off)").all<{
        name: string;
    }>()).results.map(r => r.name));
    for (const [name, type] of [["kind", "TEXT NOT NULL DEFAULT 'legacy'"], ["version", "INTEGER NOT NULL DEFAULT 1"], ["request_key", "TEXT"], ["request_payload", "TEXT"], ["from_time", "TEXT"], ["to_time", "TEXT"], ["covered_opening", "INTEGER NOT NULL DEFAULT 0"]]) {
        if (!columns.has(name)) {
            try {
                await env.DB.prepare(`ALTER TABLE rota_time_off ADD COLUMN ${name} ${type}`).run();
            }
            catch (error) {
                if (!(await env.DB.prepare("PRAGMA table_info(rota_time_off)").all<{
                    name: string;
                }>()).results.some(r => r.name === name))
                    throw error;
            }
        }
    }
    await env.DB.batch([
        env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS rota_leave_request_key ON rota_time_off(user_id, request_key) WHERE request_key IS NOT NULL"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)"),
        env.DB.prepare("INSERT OR IGNORE INTO rota_leave_state(id,version) VALUES(1,1)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_allowances (user_id TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(user_id,from_day))"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS rota_leave_allowances_period ON rota_leave_allowances(user_id,to_day,from_day)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_days (time_off_id TEXT NOT NULL REFERENCES rota_time_off(id), day TEXT NOT NULL, units INTEGER NOT NULL CHECK(units>0), unit TEXT NOT NULL CHECK(unit IN ('days','hours')), year_start TEXT NOT NULL, PRIMARY KEY(time_off_id,day))"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS rota_leave_days_day ON rota_leave_days(day,time_off_id)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_blocks (id TEXT PRIMARY KEY, from_day TEXT NOT NULL, to_day TEXT NOT NULL, site TEXT, title TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS rota_leave_blocks_range ON rota_leave_blocks(to_day,from_day)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS rota_leave_events (id TEXT PRIMARY KEY, user_id TEXT, time_off_id TEXT, action TEXT NOT NULL, at INTEGER NOT NULL, by_user TEXT NOT NULL, data TEXT NOT NULL)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS rota_leave_events_user ON rota_leave_events(user_id,at DESC)"),
    ]);
}
