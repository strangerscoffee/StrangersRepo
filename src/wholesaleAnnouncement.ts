// The wholesale ordering page's announcement bar (Christmas dispatch dates, a closure, a new coffee): one message an
// admin edits in Admin → Wholesale → Orders → Announcement, shown at the top of the ordering page while it's switched
// on and today (UK) is within its optional from/until dates. One versioned row (migration 29), in backups.
import { audit } from "./audit";
import { ApiError, Env, invalid, json, readJson } from "./http";
import { object } from "./wholesaleStore";

export interface Announcement { enabled: boolean; title: string; message: string; tone: "info" | "important"; from: string; until: string }
const TONES = ["info", "important"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ukToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function migrateAnnouncement(env: Env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_announcement (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)").run();
}

export async function announcementSettings(env: Env): Promise<Announcement & { version: number; updatedAt: number | null; showing: boolean }> {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_announcement WHERE id = 1").first<{ data: string; version: number; updated_at: number }>();
  let saved: Partial<Announcement> = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch {}
  const a: Announcement = { enabled: saved.enabled === true, title: saved.title || "", message: saved.message || "", tone: saved.tone === "important" ? "important" : "info", from: saved.from || "", until: saved.until || "" };
  return { ...a, version: row?.version || 0, updatedAt: row?.updated_at || null, showing: live(a) };
}

function live(a: Announcement, today = ukToday()) {
  return a.enabled && !!a.message && (!a.from || a.from <= today) && (!a.until || a.until >= today);
}

/** What the ordering page shows, or null. `key` changes whenever the message is saved, so a bar someone closed comes
 *  back when there's something new. */
export async function activeAnnouncement(env: Env): Promise<{ title: string; message: string; tone: string; until: string; key: string } | null> {
  const a = await announcementSettings(env);
  return a.showing ? { title: a.title, message: a.message, tone: a.tone, until: a.until, key: `${a.version}` } : null;
}

/** Admin: GET/PUT announcement {ifVersion, enabled, title, message, tone, from, until}. */
export async function handleAnnouncementAdmin(req: Request, env: Env, route: string, actor: string): Promise<Response | null> {
  if (route !== "announcement") return null;
  if (req.method === "GET") return json(await announcementSettings(env));
  if (req.method !== "PUT") return null;
  const body = object(await readJson(req, 8192));
  const expected = body.ifVersion;
  if (!Number.isSafeInteger(expected) || expected < 0) throw invalid("Send the announcement's ifVersion.");
  if (typeof body.enabled !== "boolean") throw invalid("Choose whether to show the announcement.");
  const str = (v: unknown, label: string, max: number) => { if (v === undefined || v === null) return ""; if (typeof v !== "string" || v.trim().length > max) throw invalid(`Check the ${label} (up to ${max} characters).`); return v.trim().replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n"); };
  const a: Announcement = {
    enabled: body.enabled, title: str(body.title, "heading", 80).replace(/\n/g, " "), message: str(body.message, "message", 500),
    tone: TONES.includes(body.tone) ? body.tone : (() => { if (body.tone !== undefined) throw invalid("Choose Information or Important."); return "info" as const; })(),
    from: str(body.from, "start date", 10), until: str(body.until, "end date", 10),
  };
  for (const [d, label] of [[a.from, "start date"], [a.until, "end date"]] as const) if (d && !DAY.test(d)) throw invalid(`Check the ${label}.`);
  if (a.from && a.until && a.until < a.from) throw invalid("The end date is before the start date.");
  if (a.enabled && !a.message) throw invalid("Write the message to show, or switch the announcement off.");
  const at = Date.now(), data = JSON.stringify(a);
  const result = expected === 0
    ? await env.DB.prepare("INSERT INTO wholesale_announcement(id, data, version, updated_at) SELECT 1, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM wholesale_announcement WHERE id = 1)").bind(data, at).run()
    : await env.DB.prepare("UPDATE wholesale_announcement SET data = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?").bind(data, at, expected).run();
  if (!result.meta.changes) throw new ApiError(409, "conflict", "The announcement was changed on another device. It has been reloaded: check it and save again.");
  await audit(env, "wholesale_announcement", actor, a.enabled ? `${actor} set the ordering page announcement${a.from || a.until ? ` (${a.from || "now"} to ${a.until || "no end date"})` : ""}: ${(a.title || a.message).slice(0, 80)}` : `${actor} switched the ordering page announcement off.`);
  return json(await announcementSettings(env));
}
