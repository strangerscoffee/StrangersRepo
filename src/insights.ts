// Admin → Wholesale → Insights: sales, volumes, customers, a forecast and next week's roast plan, from the site's own
// customer orders plus sales history imported from a QuickBooks report (migration 21). Admin only. The sums are in
// src/insightsMath.ts; the report file is read in the browser (public/admin/wholesale-insights-import.js) and arrives
// here as plain rows, so nothing from the file is ever run or stored as HTML.
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { catalogue } from "./wholesaleCatalogue";
import { buildInsights, type InsightSettings, type Mapping, type OpenLine, type Pack, type SaleLine, suggestMapping, ukDay } from "./insightsMath";

const DEFAULTS: InsightSettings = { batchKg: 10, yieldKg: 8, historyUntil: null };
const MAX_ROWS = 500;
const TYPES = /^(invoice|sales receipt|credit note|credit memo|refund receipt|refund)$/i;

export async function migrateInsights(env: Env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sales_history (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, date TEXT NOT NULL, customer TEXT NOT NULL, product TEXT NOT NULL, qty REAL NOT NULL, pence INTEGER NOT NULL, doc TEXT NOT NULL, kind TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS sales_history_import ON sales_history (import_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS sales_history_product ON sales_history (product)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sales_history_imports (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, imported_at INTEGER NOT NULL, imported_by TEXT NOT NULL, rows INTEGER NOT NULL DEFAULT 0, first_date TEXT, last_date TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sales_history_products (product TEXT PRIMARY KEY, data TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS insights_settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
}

async function settings(env: Env) {
  const row = await env.DB.prepare("SELECT data, version FROM insights_settings WHERE id = 1").first<{ data: string; version: number }>();
  let saved: Partial<InsightSettings> = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch {}
  return { ...DEFAULTS, ...saved, version: row?.version || 0 };
}

interface StoredOrder { business?: string; customerSnapshot?: { name?: string }; status: string; date?: string; createdAt: number; lines: { productId: string; title: string; pack: Pack; quantity: number; grams: number; price: number }[] }
async function siteOrders(env: Env) {
  const rows = await env.DB.prepare("SELECT id, data FROM wholesale_preview WHERE kind = 'order' AND json_extract(data, '$.preview') = 0 AND json_extract(data, '$.deletedAt') IS NULL AND json_extract(data, '$.status') <> 'Cancelled'").all<{ id: string; data: string }>();
  const lines: SaleLine[] = [], open: OpenLine[] = [];
  let first: string | null = null;
  for (const row of rows.results) {
    let o: StoredOrder; try { o = JSON.parse(row.data); } catch { continue; }
    const day = o.date || ukDay(o.createdAt), customer = o.business || o.customerSnapshot?.name || "Unknown";
    if (!first || day < first) first = day;
    for (const l of o.lines || []) {
      const bags = Number(l.quantity) || 0, grams = (Number(l.grams) || 0) * bags;
      lines.push({ day, customer, coffee: l.productId, title: l.title, pack: (["quarter", "kilo", "half"].includes(l.pack) ? l.pack : "other") as Pack, bags, grams, pence: (Number(l.price) || 0) * bags, source: "site", order: row.id });
      if (o.status === "New" || o.status === "Preparing") open.push({ coffee: l.productId, title: l.title, grams, bags });
    }
  }
  return { lines, open, first, count: rows.results.length };
}

const coffeeKey = (m: Mapping) => m.coffee || "other:" + m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
async function mappings(env: Env) {
  const rows = await env.DB.prepare("SELECT product, data, reviewed FROM sales_history_products").all<{ product: string; data: string; reviewed: number }>();
  return new Map(rows.results.map((r) => [r.product, { ...(JSON.parse(r.data) as Mapping), reviewed: !!r.reviewed }]));
}
async function historyLines(env: Env, until: string | null) {
  const map = await mappings(env);
  const rows = await env.DB.prepare(`SELECT date, customer, product, doc, kind, SUM(qty) AS qty, SUM(pence) AS pence FROM sales_history${until ? " WHERE date < ?" : ""} GROUP BY date, customer, product, doc, kind`)
    .bind(...(until ? [until] : [])).all<{ date: string; customer: string; product: string; doc: string; kind: string; qty: number; pence: number }>();
  const lines: SaleLine[] = [];
  for (const r of rows.results) {
    const m = map.get(r.product);
    if (!m || m.pack === "ignore" || !(m.grams > 0)) continue;
    lines.push({ day: r.date, customer: r.customer, coffee: coffeeKey(m), title: m.title, pack: m.pack, bags: r.qty, grams: Math.round(r.qty * m.grams), pence: r.pence, source: "history", order: `qb:${r.kind}:${r.doc || r.date + r.customer}` });
  }
  return lines;
}

async function insights(env: Env) {
  const s = await settings(env), site = await siteOrders(env);
  const until = s.historyUntil || site.first;
  const history = await historyLines(env, until);
  const span = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM sales_history").first<{ n: number; first: string | null; last: string | null }>();
  const unreviewed = await env.DB.prepare("SELECT COUNT(*) AS n FROM sales_history_products WHERE reviewed = 0").first<{ n: number }>();
  const result = buildInsights({ today: ukDay(Date.now()), lines: [...history, ...site.lines], open: site.open, settings: s });
  // Each coffee's packaging colours as saved in Admin, so the page draws every coffee in its own colour.
  const palette = (await catalogue(env, true)).map((c: any) => ({ id: c.id, title: c.title, name: c.name, ...(Array.isArray(c.colours) && c.colours.length ? { colours: c.colours, colourStyle: c.colourStyle } : {}) }));
  return { ...result, palette, settings: s, sources: { siteOrders: site.count, firstSiteOrder: site.first, historyRows: span?.n || 0, historyFirst: span?.first || null, historyLast: span?.last || null, historyUntil: until, historyUsed: history.length, unreviewedProducts: unreviewed?.n || 0 } };
}

function cleanRow(value: any) {
  const str = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
  if (!value || typeof value !== "object") throw invalid("Each history row must be an object.");
  const date = str(value.date, 10), product = str(value.product, 200), kind = str(value.type, 40) || "Invoice";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date) throw invalid("Each history row needs a real date (YYYY-MM-DD).");
  if (!product) throw invalid("Each history row needs a product or service.");
  if (!TYPES.test(kind)) throw invalid(`History rows must be sales, not "${kind}".`);
  const qty = Number(value.qty), pence = Number(value.pence);
  if (!Number.isFinite(qty) || Math.abs(qty) > 1e6 || !Number.isSafeInteger(pence) || Math.abs(pence) > 1e10) throw invalid("Check the quantities and amounts in the file.");
  // n: which copy of an identical line this is, counted across the whole file by the page, so a report imported
  // twice adds nothing while two genuinely identical lines both count.
  const n = Number.isSafeInteger(value.n) && value.n >= 1 && value.n <= 1e6 ? value.n : 1;
  return { date, customer: str(value.customer, 200) || "Unknown", product, qty, pence, doc: str(value.num, 40), kind, n };
}
async function rowId(r: ReturnType<typeof cleanRow>) {
  const bytes = new TextEncoder().encode(JSON.stringify([r.kind, r.doc, r.date, r.customer, r.product, r.qty, r.pence, r.n]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleInsights(req: Request, env: Env, route: string, actor: string): Promise<Response | null> {
  if (!route.startsWith("insights")) return null;
  if (route === "insights" && req.method === "GET") return json(await insights(env));
  if (route === "insights/settings" && req.method === "PUT") {
    const body = await readJson<Record<string, any>>(req, 4096), current = await settings(env);
    if (body.ifVersion !== current.version) throw new ApiError(409, "conflict", "These settings were changed on another device. Reload and try again.");
    const batchKg = Number(body.batchKg), yieldKg = Number(body.yieldKg), until = body.historyUntil ?? null;
    if (!(batchKg > 0 && batchKg <= 500) || !(yieldKg > 0 && yieldKg <= batchKg)) throw invalid("The roasted weight must be more than 0 and no more than the batch size.");
    if (until !== null && (typeof until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(until))) throw invalid("Choose a date for the end of QuickBooks history, or leave it automatic.");
    const data = JSON.stringify({ batchKg: Math.round(batchKg * 100) / 100, yieldKg: Math.round(yieldKg * 100) / 100, historyUntil: until }), at = Date.now();
    const result = current.version === 0
      ? await env.DB.prepare("INSERT INTO insights_settings (id, data, version, updated_at) SELECT 1, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM insights_settings WHERE id = 1)").bind(data, at).run()
      : await env.DB.prepare("UPDATE insights_settings SET data = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?").bind(data, at, current.version).run();
    if (!result.meta.changes) throw new ApiError(409, "conflict", "These settings were changed on another device. Reload and try again.");
    return json(await settings(env));
  }
  if (route === "insights/history" && req.method === "GET") {
    const [imports, products, coffees, map] = await Promise.all([
      env.DB.prepare("SELECT id, file_name AS fileName, imported_at AS importedAt, imported_by AS importedBy, rows, first_date AS firstDate, last_date AS lastDate FROM sales_history_imports ORDER BY imported_at DESC").all(),
      env.DB.prepare("SELECT product, COUNT(*) AS lines, SUM(qty) AS qty, SUM(pence) AS pence, MIN(date) AS first, MAX(date) AS last FROM sales_history GROUP BY product ORDER BY SUM(pence) DESC").all<{ product: string }>(),
      catalogue(env, true), mappings(env),
    ]);
    return json({ imports: imports.results, products: products.results.map((p) => ({ ...p, mapping: map.get(p.product) || null })), coffees: coffees.map((c) => ({ id: c.id, title: c.title })) });
  }
  if (route === "insights/history/rows" && req.method === "POST") {
    const body = await readJson<Record<string, any>>(req, 600_000);
    const id = typeof body.importId === "string" && /^[a-f0-9-]{36}$/.test(body.importId) ? body.importId : null;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 120) : "";
    if (!id || !fileName) throw invalid("Send the import's id and file name.");
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_ROWS) throw invalid(`Send between 1 and ${MAX_ROWS} rows at a time.`);
    const offset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
    const rows = body.rows.map(cleanRow), stmts = [];
    const coffees = (await catalogue(env, true)).map((c) => ({ id: c.id, name: c.name, title: c.title }));
    for (const r of rows) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO sales_history (id, import_id, date, customer, product, qty, pence, doc, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(await rowId(r), id, r.date, r.customer, r.product, r.qty, r.pence, r.doc, r.kind));
    for (const product of new Set(rows.map((r) => r.product))) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO sales_history_products (product, data, reviewed, updated_at) VALUES (?, ?, 0, ?)").bind(product, JSON.stringify(suggestMapping(product, coffees)), Date.now()));
    const results = await env.DB.batch(stmts);
    const added = results.slice(0, rows.length).reduce((t, r) => t + (r.meta.changes || 0), 0);
    const dates = rows.map((r) => r.date).sort();
    // A file is listed once it adds something: importing the same report again leaves no empty entry behind.
    if (added) await env.DB.prepare(`INSERT INTO sales_history_imports (id, file_name, imported_at, imported_by, rows, first_date, last_date) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET rows = rows + excluded.rows, first_date = MIN(first_date, excluded.first_date), last_date = MAX(last_date, excluded.last_date)`)
      .bind(id, fileName, Date.now(), actor, added, dates[0], dates[dates.length - 1]).run();
    if (offset === 0 && added) await audit(env, "sales_history_import", actor, `${actor} imported QuickBooks sales history from ${fileName}.`);
    return json({ added, skipped: rows.length - added });
  }
  if (route === "insights/history/products" && req.method === "PUT") {
    const body = await readJson<Record<string, any>>(req, 500_000);
    if (!Array.isArray(body.mappings) || body.mappings.length > 2000) throw invalid("Send the product mappings as a list.");
    const ids = new Set((await catalogue(env, true)).map((c) => c.id)), stmts = [];
    for (const m of body.mappings) {
      if (!m || typeof m.product !== "string" || !m.product || m.product.length > 200) throw invalid("Each mapping needs its product.");
      const pack = m.pack;
      if (!["quarter", "kilo", "half", "other", "ignore"].includes(pack)) throw invalid("Choose a bag size, or Not coffee.");
      const coffee = pack === "ignore" ? null : typeof m.coffee === "string" && ids.has(m.coffee) ? m.coffee : null;
      const title = pack === "ignore" ? m.product : coffee ? String(m.title || "").slice(0, 120) : String(m.title || m.product).trim().slice(0, 120);
      const grams = pack === "ignore" ? 0 : pack === "other" ? Number(m.grams) : { quarter: 250, kilo: 1000, half: 500 }[pack as "quarter"];
      if (pack !== "ignore" && (!Number.isSafeInteger(grams) || grams <= 0 || grams > 100000)) throw invalid(`Give the weight in grams for ${m.product}.`);
      if (pack !== "ignore" && !title) throw invalid(`Name the coffee for ${m.product}.`);
      stmts.push(env.DB.prepare("UPDATE sales_history_products SET data = ?, reviewed = 1, updated_at = ? WHERE product = ?").bind(JSON.stringify({ coffee, title, pack, grams }), Date.now(), m.product));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ saved: stmts.length });
  }
  const del = route.match(/^insights\/history\/imports\/([a-f0-9-]{36})$/);
  if (del && req.method === "DELETE") {
    const row = await env.DB.prepare("SELECT file_name FROM sales_history_imports WHERE id = ?").bind(del[1]).first<{ file_name: string }>();
    if (!row) throw new ApiError(404, "not_found", "That import has already been removed.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sales_history WHERE import_id = ?").bind(del[1]),
      env.DB.prepare("DELETE FROM sales_history_imports WHERE id = ?").bind(del[1]),
      env.DB.prepare("DELETE FROM sales_history_products WHERE product NOT IN (SELECT DISTINCT product FROM sales_history)"),
    ]);
    await audit(env, "sales_history_import", actor, `${actor} removed the QuickBooks history imported from ${row.file_name}.`);
    return json({ removed: true });
  }
  return null;
}
