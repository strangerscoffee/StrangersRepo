// What the diary shows about every site at a glance (the site switcher's "2 to do", Today's needs-attention, the
// maintenance bell): one small answer for all four sites instead of a live list of each one's days, checks,
// cleaning and maintenance. Asked for in the poll as {kind: "summary", from, to} (docs/runtime-api.md).
import { Env, invalid } from "./http";
import { SITE_PREFIXES } from "./paths";

const SITE_IDS = ["roastery", "cafe", "asg", "factory"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DONE_KEPT_MS = 14 * 864e5; // done jobs the bell still mentions

export interface SummarySpec { from: string; to: string }

export function checkSummary(q: { from?: unknown; to?: unknown }): SummarySpec {
  const from = String(q.from ?? ""), to = String(q.to ?? "");
  if (!DATE.test(from) || !DATE.test(to) || from > to || Date.parse(to) - Date.parse(from) > 31 * 864e5) throw invalid("Bad summary dates.");
  return { from, to };
}

const cols = (name: string) => SITE_PREFIXES.map((p) => p + name);
/** Every collection a summary reads from (for its version). */
export const summaryCollections = () => [...cols("settings"), ...cols("days"), ...cols("extras"), ...cols("cleaning"), ...cols("fire"), ...cols("maintenance")];

export async function siteSummary(env: Env, spec: SummarySpec) {
  const j = JSON.stringify;
  const siteOf = (collection: string) => SITE_IDS[SITE_PREFIXES.indexOf(collection.slice(0, collection.lastIndexOf("/") + 1))] ?? SITE_IDS[0];
  type Row = { collection: string; doc_id: string; data: string; seq: number };
  const [settings, days, first, tasks, maint] = await env.DB.batch([
    env.DB.prepare("SELECT collection, doc_id, data, seq FROM docs WHERE deleted = 0 AND path IN (SELECT value FROM json_each(?))").bind(j(cols("settings").map((c) => c + "/main"))),
    // The days around today (today, the last trading day before it), by date: the (collection, doc_id) index.
    env.DB.prepare("SELECT collection, doc_id, data, seq FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) AND doc_id BETWEEN ? AND ?").bind(j(cols("days")), spec.from, spec.to),
    env.DB.prepare("SELECT collection, MIN(doc_id) AS doc_id FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?)) GROUP BY collection").bind(j(cols("days"))),
    // Extra checks, cleaning and fire safety checks without their logs (only when each was last done matters here).
    env.DB.prepare("SELECT collection, doc_id, json_remove(data, '$.log') AS data, seq FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?))").bind(j([...cols("extras"), ...cols("cleaning"), ...cols("fire")])),
    env.DB.prepare(`SELECT collection, doc_id, data, seq FROM docs WHERE deleted = 0 AND collection IN (SELECT value FROM json_each(?))
      AND (json_extract(data, '$.status') IS NOT 'done' OR COALESCE(json_extract(data, '$.doneAt'), 0) > ?)`).bind(j(cols("maintenance")), Date.now() - DONE_KEPT_MS),
  ]);
  const out: Record<string, { settings: unknown; days: Record<string, unknown>; firstDay: string | null; extras: unknown[]; cleaning: unknown[]; fire: unknown[]; maintenance: unknown[] }> = {};
  for (const id of SITE_IDS) out[id] = { settings: null, days: {}, firstDay: null, extras: [], cleaning: [], fire: [], maintenance: [] };
  for (const r of settings.results as Row[]) out[siteOf(r.collection)].settings = JSON.parse(r.data);
  for (const r of days.results as Row[]) out[siteOf(r.collection)].days[r.doc_id] = JSON.parse(r.data);
  for (const r of first.results as Row[]) out[siteOf(r.collection)].firstDay = r.doc_id;
  for (const r of tasks.results as Row[]) {
    const kind = r.collection.endsWith("cleaning") ? "cleaning" : r.collection.endsWith("fire") ? "fire" : "extras";
    out[siteOf(r.collection)][kind].push({ id: r.doc_id, ...JSON.parse(r.data) });
  }
  for (const r of maint.results as Row[]) out[siteOf(r.collection)].maintenance.push({ id: r.doc_id, ...JSON.parse(r.data) });
  return out;
}
