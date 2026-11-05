// Small helpers for the rota: errors, dates and times, text, stored JSON (see src/rota/index.ts).
import { ApiError, invalid } from "../http";
import { DAY_KEYS, MAX_TEXT, ROTA_SITES } from "./types";

export const siteName = (id: string) => ROTA_SITES.find((s) => s.id === id)?.name || id;

export const conflict = (message: string) => new ApiError(409, "conflict", message);
export const denied = (message = "Only managers can do this.") => new ApiError(403, "permission_denied", message);
export const notFound = (message: string) => new ApiError(404, "not_found", message);

/** Days are YYYY-MM-DD strings; date arithmetic is done in UTC so it never shifts with daylight saving. */
export const dateOf = (s: string) => new Date(s + "T00:00:00Z");
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);
export function isDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dateOf(s).getTime()) && isoOf(dateOf(s)) === s;
}
export const addDays = (s: string, n: number) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
/** 0 = Monday … 6 = Sunday. */
export const dow = (s: string) => (dateOf(s).getUTCDay() + 6) % 7;
export const mondayOf = (s: string) => addDays(s, -dow(s));
export const dayName = (s: string) => dateOf(s).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
export const shortDay = (s: string) => dateOf(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** Today in the UK, whatever the server's clock zone. */
export function londonToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** "7.5h", "8h". */
export const fmtH = (h: number) => `${round2(h)}h`;

export function text(v: unknown, label: string, max = MAX_TEXT): string {
  if (v == null) return "";
  if (typeof v !== "string") throw invalid(`${label} must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > max) throw invalid(`${label} can be up to ${max} characters.`);
  return t;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { const v = s ? JSON.parse(s) : fallback; return v ?? fallback; } catch { return fallback; }
}
/** Stored day hours, keeping only well-formed days. */
export function cleanDayHours(v: unknown): Record<string, { opensAt: string; closesAt: string }> {
  const out: Record<string, { opensAt: string; closesAt: string }> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const k of DAY_KEYS) {
    const d = (v as any)[k];
    if (d && isTime(d.opensAt) && isTime(d.closesAt) && mins(d.closesAt) > mins(d.opensAt)) out[k] = { opensAt: d.opensAt, closesAt: d.closesAt };
  }
  return out;
}

/** "16–24h", "20h", "up to 24h", "at least 16h". */
export function contractText(p: { contractMin: number | null; contractMax: number | null }): string {
  const { contractMin: a, contractMax: b } = p;
  if (a != null && b != null) return a === b ? fmtH(b) : `${round2(a)}–${fmtH(b)}`;
  if (b != null) return `up to ${fmtH(b)}`;
  if (a != null) return `at least ${fmtH(a)}`;
  return "none";
}

export const nowMs = () => Date.now();
