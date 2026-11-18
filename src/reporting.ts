import type { Env } from "./http";

const actionable = (row: string) => `${row}.kind = 'order' AND json_extract(${row}.data, '$.preview') = 0
  AND json_extract(${row}.data, '$.deletedAt') IS NULL AND json_extract(${row}.data, '$.status') IN ('New', 'Preparing', 'Ready')`;
const orderFields = (row: string) => `${row}.id, json_extract(${row}.data, '$.status'),
  COALESCE(json_extract(${row}.data, '$.dispatchDate'), ''), COALESCE(json_extract(${row}.data, '$.grams'), 0),
  json_extract(${row}.data, '$.createdAt')`;

export async function migrateReporting(env: Env) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS reporting_open_orders (id TEXT PRIMARY KEY, status TEXT NOT NULL, day TEXT NOT NULL, grams INTEGER NOT NULL, created_at INTEGER)",
    "CREATE INDEX IF NOT EXISTS reporting_open_orders_oldest ON reporting_open_orders(status, created_at)",
    "CREATE TABLE IF NOT EXISTS reporting_order_totals (status TEXT NOT NULL, day TEXT NOT NULL, orders INTEGER NOT NULL, grams INTEGER NOT NULL, PRIMARY KEY(status, day))",
    `CREATE TRIGGER IF NOT EXISTS reporting_totals_insert AFTER INSERT ON reporting_open_orders BEGIN
      INSERT INTO reporting_order_totals VALUES (NEW.status, NEW.day, 1, NEW.grams)
      ON CONFLICT(status, day) DO UPDATE SET orders=orders+1, grams=grams+NEW.grams;
    END`,
    `CREATE TRIGGER IF NOT EXISTS reporting_totals_delete AFTER DELETE ON reporting_open_orders BEGIN
      UPDATE reporting_order_totals SET orders=orders-1, grams=grams-OLD.grams WHERE status=OLD.status AND day=OLD.day;
      DELETE FROM reporting_order_totals WHERE status=OLD.status AND day=OLD.day AND orders=0;
    END`,
    "CREATE TABLE IF NOT EXISTS reporting_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)",
    "INSERT OR IGNORE INTO reporting_revision VALUES (1, 0)",
    "CREATE TABLE IF NOT EXISTS reporting_insights (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, report_day TEXT NOT NULL, data TEXT NOT NULL)",
  ];
  const invalidate = "UPDATE reporting_revision SET revision=revision+1 WHERE id=1;";
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const old = operation !== "INSERT", next = operation !== "DELETE";
    const source = [old && "OLD.kind IN ('order', 'catalogue')", next && "NEW.kind IN ('order', 'catalogue')"].filter(Boolean).join(" OR ");
    sql.push(`CREATE TRIGGER IF NOT EXISTS reporting_wholesale_${operation} AFTER ${operation} ON wholesale_preview
      WHEN ${source} BEGIN
        ${old ? "DELETE FROM reporting_open_orders WHERE OLD.kind='order' AND id=OLD.id;" : ""}
        ${next ? `INSERT INTO reporting_open_orders SELECT ${orderFields("NEW")} WHERE ${actionable("NEW")};` : ""}
        ${invalidate}
      END`);
    for (const table of ["sales_history", "sales_history_products", "insights_settings"]) {
      sql.push(`CREATE TRIGGER IF NOT EXISTS reporting_${table}_${operation} AFTER ${operation} ON ${table} BEGIN ${invalidate} END`);
    }
  }
  sql.push(`INSERT OR IGNORE INTO reporting_open_orders
    SELECT ${orderFields("o")} FROM wholesale_preview o WHERE ${actionable("o")}`);
  await env.DB.batch(sql.map(statement => env.DB.prepare(statement)));
}

export async function reportSnapshot<T extends object>(env: Env, scope: string, day: string, calculate: () => Promise<T>) {
  type Report = T & { generatedAt: number };
  const current = await env.DB.prepare(`SELECT revision.revision, snapshot.data
    FROM reporting_revision revision LEFT JOIN reporting_insights snapshot
    ON snapshot.scope=? AND snapshot.report_day=? AND snapshot.revision=revision.revision
    WHERE revision.id=1`).bind(scope, day).first<{ revision: number; data: string | null }>();
  if (current?.data) return JSON.parse(current.data) as Report;
  const report: Report = { ...await calculate(), generatedAt: Date.now() };
  // D1 limits individual row values. Large reports still use the normal calculation.
  const data = JSON.stringify(report);
  if (current && new TextEncoder().encode(data).byteLength < 1_500_000) {
    try {
      await env.DB.prepare(`INSERT INTO reporting_insights(scope, revision, report_day, data)
        SELECT ?, revision, ?, ? FROM reporting_revision WHERE id=1 AND revision=?
        ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision, report_day=excluded.report_day, data=excluded.data`)
        .bind(scope, day, data, current.revision).run();
    } catch (error) {
      console.warn("Could not store Insights snapshot", error);
    }
  }
  return report;
}
