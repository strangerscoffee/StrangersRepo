// The rota's types and constants (see src/rota/index.ts).
import { User } from "../auth";
import { Env } from "../http";

/* ---------- constants ---------- */

// Where people work. The diary's sites (prefix: where its documents live) open on the days their Setup says, with
// opening hours and minimum cover. Ad hoc places (adHoc) are used as needed: always open on the rota, no opening
// hours, no minimum cover and no diary needed. The Factory has a diary prefix but isn't open to the public; the
// Office is a space for paperwork away from the other sites and has no diary at all.
export const ROTA_SITES: readonly { id: string; name: string; prefix: string | null; adHoc: boolean }[] = [
  { id: "roastery", name: "Roastery", prefix: "", adHoc: false },
  { id: "cafe", name: "Cafe", prefix: "sites/cafe/", adHoc: false },
  { id: "asg", name: "ASG", prefix: "sites/asg/", adHoc: false },
  { id: "factory", name: "Factory", prefix: "sites/factory/", adHoc: true },
  { id: "office", name: "Office", prefix: null, adHoc: true },
];
export type SiteId = string;
export const SITE_IDS = new Set<string>(ROTA_SITES.map((s) => s.id));
export const JOBS = new Set(["", "opens", "closes"]);
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const REST_MINS = 11 * 60; // UK Working Time Regulations: 11 hours' daily rest
export const BREAK_AFTER_MINS = 6 * 60; // a 20-minute rest break for shifts over 6 hours
export const BREAK_MINS = 20;
export const MAX_TEXT = 500;

/* ---------- types ---------- */

export interface ShiftRow {
  id: string; site: string; day: string; start: string; end: string; break_mins: number; job: string;
  user_id: string | null; note: string; updated_at: number; updated_by: string;
  actual_start: string | null; actual_end: string | null; actual_break: number | null; adjust_note: string | null;
  adjusted_by: string | null; adjusted_at: number | null;
}
/** A shift as planned (start, end, breakMins) and, once amended on the day, as worked (actual*). `hours` are the
 *  paid hours that count (as worked when amended); `plannedHours` as planned; `overtime` the part of `hours` over
 *  the person's maximum contracted hours that week (set by the week and My shifts views). */
export interface Shift {
  id: string; site: string; day: string; start: string; end: string; breakMins: number; job: string;
  userId: string | null; note: string; hours: number; plannedHours: number;
  adjusted: boolean; actualStart: string | null; actualEnd: string | null; actualBreakMins: number | null; adjustNote: string;
  adjustedBy: string | null; adjustedAt: number | null; overtime?: number;
  updatedAt?: number; // the shift's version: a change sent with ifUpdatedAt is refused if someone changed it since
}
export type Pattern = Record<string, "any" | "off" | { from?: string; to?: string }>;
/** `contractHours` is kept for older pages: it's the maximum. */
export interface Person {
  id: string; name: string; role: string; contractMin: number | null; contractMax: number | null; contractHours: number | null;
  /** Sites they can be rota'd at: their primary site plus the other sites ticked (empty: any site). */
  sites: string[]; pattern: Pattern;
  /** Where they mainly work (rota_people.primary_site), or null if not set. */
  primarySite?: string | null;
  /** Their colour on the rota, a hue (0–359): fixed by the order accounts were made, so it never changes. */
  hue: number;
}
export type Hours = { opensAt: string | null; closesAt: string | null };
export interface SiteInfo {
  id: string; name: string; inUse: boolean; closedDays: number[]; trainingOff: string[];
  /** Used as needed (Factory, Office): always open, no opening hours or minimum cover. */
  adHoc: boolean;
  opensAt: string | null; closesAt: string | null; minPeople: number;
  /** Days of the week with other opening hours than the usual ones, by mon…sun. */
  dayHours: Record<string, { opensAt: string; closesAt: string }>;
}
export interface TimeOff { id: string; userId: string; from: string; to: string; reason: string; status: string; kind?:string; fromTime?:string|null; toTime?:string|null }
export interface Problem {
  kind: string; severity: "error" | "warn" | "info"; day?: string; site?: string; userId?: string; shiftIds: string[]; message: string;
}

export interface WeekRow { week: string; published_at: number | null; published_by: string | null; changed_at: number | null; changes: number; emailed?: string | null; published_shifts?: string | null }

/** Everything the checks need for one week (plus the days either side, for rest between shifts). */
export interface Ctx {
  week: string; days: string[]; sites: Map<string, SiteInfo>; closures: Map<string, Record<string, string>>;
  people: Map<string, Person>; shifts: Shift[]; timeOff: TimeOff[];
}

export interface ReqRow {
  id: string; kind: string; shift_id: string; from_user: string; to_user: string | null; taker: string | null; message: string;
  status: string; decided_by: string | null; decided_at: number | null; created_at: number;
}

export interface ShiftInput { site: string; day: string; start: string; end: string; breakMins: number; job: string; userId: string | null; note: string }

/** One rota API request, as the router's handlers by area see it (src/rota/index.ts). */
export interface RotaRequest {
  env: Env; exec: ExecutionContext; user: User; route: string; seg: string[]; m: string; q: (k: string) => string | null;
  mgr: boolean; admin: boolean; needMgr: () => void; needAdmin: () => void; needSiteManager: () => void; body: () => Promise<any>;
  withProblems: boolean; links: { rota: string; diary: string; admin?: string };
  mailLinks: { rota: string; diary: string }; // the same as full addresses, for emails
}
