// What went wrong, for the admin section: page errors reported by the site's own pages (public/errors.js, POST
// /api/errors) and the Worker's own unexpected failures. The same error from the same page is one row with a
// count, kept 30 days. Shown in Admin → Activity → Errors and, when recent, on the Overview.
import { Env } from "./http";

export interface ErrorReport { source: "page" | "server"; app: string; page: string; message: string; detail?: string; ua?: string; who?: string | null }

const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
// The details keep their line breaks (a stack trace is one call per line).
const clipLines = (v: unknown, n: number) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);

// Each error has a short code (E- and six letters or digits) worked out from what it is and where, so the same error
// always has the same code: the page shows it to the person (public/errors.js, which works it out the same way, so it
// shows even offline), a server failure puts it in its message, and the admin section's report leads with it. A
// screenshot of either is enough to find the row and the line of code.
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function errorCode(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let s = "";
  for (let i = 0; i < 6; i++) { s += C32[h & 31]; h >>>= 5; }
  return "E-" + s;
}

function normalize(e: ErrorReport) {
  const r = { source: e.source, app: clip(e.app, 20) || "?", page: clip(e.page, 200), message: clip(e.message, 300) || "Unknown error",
    detail: clipLines(e.detail, 2000), ua: clip(e.ua, 200), who: e.who ? clip(e.who, 60) : null };
  const key = [r.source, r.app, r.page.split("#")[0], r.message].join("|").slice(0, 600);
  return { r, key, code: errorCode(key) };
}

/** The code an error will be recorded under. */
export const codeFor = (e: ErrorReport) => normalize(e).code;

/** Records one error and returns its code (never throws: reporting must not cause another failure). */
export async function recordError(env: Env, e: ErrorReport): Promise<string> {
  const { r, key, code } = normalize(e);
  try {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO errors (key, source, app, page, message, detail, ua, who, first_at, last_at, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET count = count + 1, last_at = excluded.last_at, page = excluded.page,
         detail = CASE WHEN excluded.detail <> '' THEN excluded.detail ELSE errors.detail END,
         ua = CASE WHEN excluded.ua <> '' THEN excluded.ua ELSE errors.ua END, who = COALESCE(excluded.who, errors.who)`,
    ).bind(key, r.source, r.app, r.page, r.message, r.detail, r.ua, r.who, now, now).run();
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM errors WHERE last_at < ?").bind(now - 30 * 864e5).run();
  } catch { /* the database itself may be what failed */ }
  return code;
}

/** The first place in a stack trace that's the site's own code: "/diary/today.js:123:45 in renderDay (file v1a2b3c4d)". */
export function whereOf(detail: string): string {
  for (const line of String(detail || "").split("\n")) {
    const m = line.match(/(?:https?:\/\/[^/\s]+)?(\/?[\w./-]+\.(?:js|ts|mjs))(?:\?v=([\w-]+))?:(\d+):(\d+)/);
    if (!m) continue;
    const fn = (line.match(/^\s*at (?:async )?([\w$.<>]+) \(/) || line.match(/^\s*([\w$.<>]+)@/) || [])[1];
    return `${m[1]}:${m[3]}:${m[4]}${fn ? ` in ${fn}` : ""}${m[2] ? ` (file v${m[2].replace(/^W-/, "").slice(0, 8)})` : ""}`;
  }
  return "";
}

/** A short device description from a User-Agent: "iPhone · Safari", "Mac · Chrome". */
export function deviceOf(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" · ") || "Unknown device";
}

export async function recentErrors(env: Env, limit = 60) {
  const { results } = await env.DB.prepare("SELECT key, source, app, page, message, detail, ua, who, first_at, last_at, count FROM errors ORDER BY last_at DESC LIMIT ?")
    .bind(limit).all<{ key: string; source: string; app: string; page: string; message: string; detail: string; ua: string; who: string | null; first_at: number; last_at: number; count: number }>();
  return results;
}
