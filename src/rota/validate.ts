// Checking what's sent: shifts, weekly patterns, sites and contract hours.
import { invalid, Env } from "../http";
import { activeUser, loadClosures, loadSites } from "./load";
import { openState } from "./problems";
import { DAY_KEYS, JOBS, Pattern, SITE_IDS, ShiftInput } from "./types";
import { isDay, isTime, mins, round2, text } from "./util";

/* ---------- validation ---------- */

export async function checkShift(env: Env, v: ShiftInput): Promise<ShiftInput> {
  if (!SITE_IDS.has(v.site)) throw invalid("Choose one of the four sites.");
  if (!isDay(v.day)) throw invalid("Choose a real date.");
  if (!isTime(v.start) || !isTime(v.end)) throw invalid("Times are HH:MM, for example 07:30.");
  if (mins(v.end) <= mins(v.start)) throw invalid("A shift has to end after it starts (overnight shifts aren't supported).");
  if (!Number.isInteger(v.breakMins) || v.breakMins < 0 || v.breakMins > 180) throw invalid("The unpaid break is 0 to 180 minutes.");
  if (v.breakMins >= mins(v.end) - mins(v.start)) throw invalid("The break has to be shorter than the shift.");
  if (!JOBS.has(v.job)) throw invalid("The job is opens, closes or nothing.");
  if (v.userId !== null) await activeUser(env, v.userId);
  v.note = text(v.note, "The note");
  const [sites, closures] = await Promise.all([loadSites(env), loadClosures(env, v.day, v.day)]);
  const st = openState({ sites, closures }, v.site, v.day);
  if (!st.open) throw invalid(`${st.reason}, so no shifts can go there.`);
  return v;
}

export function checkPattern(v: unknown): Pattern {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw invalid("The weekly pattern isn't valid.");
  const out: Pattern = {};
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (!(DAY_KEYS as readonly string[]).includes(k)) throw invalid("The weekly pattern uses mon to sun.");
    if (d === "any" || d === "off") { out[k] = d; continue; }
    if (!d || typeof d !== "object") throw invalid("Each day is any, off, or a from/until time.");
    const { from, to } = d as { from?: unknown; to?: unknown };
    if ((from != null && from !== "" && !isTime(from)) || (to != null && to !== "" && !isTime(to))) throw invalid("Times are HH:MM, for example 07:30.");
    if (isTime(from) && isTime(to) && mins(to) <= mins(from)) throw invalid("Until has to be after from.");
    out[k] = { ...(isTime(from) ? { from } : {}), ...(isTime(to) ? { to } : {}) };
    if (!Object.keys(out[k] as object).length) out[k] = "any";
  }
  return out;
}
export function checkSites(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !SITE_IDS.has(s))) throw invalid("Choose sites from the list.");
  return [...new Set(v as string[])];
}
export function checkContract(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || n > 80) throw invalid("Contract hours are 0 to 80 a week.");
  return round2(n);
}
