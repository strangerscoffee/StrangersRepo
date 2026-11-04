import { User, sessionUser } from "./auth";
import { ApiError, Env } from "./http";

/** Who is making a request. */
export type Caller =
  | { kind: "user"; user: User } // a signed-in member of staff
  | { kind: "anon" }; // not signed in

/**
 * The one place access is decided. Every request passes through here before routing.
 *
 * People are identified by their session cookie (username + password sign-in, see auth.ts); index.ts then
 * decides what an anonymous caller may reach (only the sign-in page and its assets) and what each role may
 * do (see canWrite below).
 */
export async function authorize(req: Request, env: Env): Promise<Caller> {
  const user = await sessionUser(req, env);
  return user ? { kind: "user", user } : { kind: "anon" };
}

/** Pages and files anyone may load: the sign-in screen and what it needs. */
export function isPublicAsset(path: string): boolean {
  return (
    path === "/signin" || path === "/signin.html" || path === "/signin.js" || path === "/theme.css" || path === "/pinpad.js" ||
    path === "/robots.txt" || path === "/manifest.webmanifest" || /^\/icon-\d+\.png$/.test(path) ||
    path === "/logo.svg" || path === "/mark.svg"
  );
}

export function requireUser(caller: Caller): User {
  if (caller.kind !== "user") throw new ApiError(401, "unauthenticated", "Sign in to continue.");
  return caller.user;
}

/** The id written into records ("by" fields): web:<name>, as before accounts existed. */
export const recordId = (u: User) => "web:" + u.name;

/* ---------- the rota (src/rota.ts) ---------- */

// Plans the week, publishes it and approves pickups, covers and time off.
export const isRotaManager = (u: User) => u.role === "manager" || u.role === "admin";

// Which app each hostname serves, and links between them: src/hosts.ts (no imports, so tests can load it directly).
export { appForHost, appLinks, isAdminSharedFile, isPublicCode, isRotaSharedFile, unifiedSignin } from "./hosts";

/* ---------- roles ---------- */

// Sections and data only managers and admins may change. Staff can still read them (the "Needs attention"
// summary counts overdue reviews and plans), but the page hides these sections from them.
const MANAGER_TABS = new Set(["eho", "plans", "suppliers", "contacts", "staff", "onboarding", "review", "setup"]);
// The 4-weekly review (reviews) is a record staff fill in when it's due, so it isn't in this list.
const MANAGER_COLLECTIONS = new Set(["settings", "plans", "inspections", "suppliers", "contacts", "staff", "onboarding"]);

export const canOpenTab = (u: User, tab: string) => u.role !== "staff" || !MANAGER_TABS.has(tab);

export function canWrite(u: User, path: string): boolean {
  if (u.role !== "staff") return true;
  if (path === "config/shared") return false;
  const parts = path.split("/");
  return !MANAGER_COLLECTIONS.has(parts[parts.length - 2]);
}

/* The diary's own records: day pages, end-of-week pages and the 4-weekly reviews. The page never deletes them, so only
   managers and admins can (to tidy up a mistake); staff can't wipe a day's checks or a signed review. */
const RECORD_COLLECTIONS = new Set(["days", "weeks", "reviews"]);
export const isRecordPath = (path: unknown) => typeof path === "string" && RECORD_COLLECTIONS.has(path.split("/").slice(-2, -1)[0]);

export function requireDelete(u: User, path: unknown): void {
  if (u.role === "staff" && isRecordPath(path)) throw new ApiError(403, "permission_denied", "Only managers can remove diary records.");
}

/* Signatures. A staff member's sign-off is in their own name: a signed block they write (signed:{by,name} on a day,
   a week or their training record, and by on a 4-weekly review) must be theirs, unless it's the one already there. */
export function requireOwnSignature(u: User, collection: string, data: unknown, current: Record<string, unknown> | undefined, canon: (v: unknown) => string): void {
  if (u.role !== "staff" || !data || typeof data !== "object") return;
  const d = data as Record<string, any>;
  // A signature carries both the record id and the name, and both must be the person's own (a patch with only
  // `by` would leave someone else's name on it).
  const mine = (by: unknown, name: unknown) => by === recordId(u) && name === u.name;
  const bad = () => new ApiError(403, "permission_denied", "You can only sign in your own name.");
  if (d.signed != null && canon(d.signed) !== canon(current?.signed) && !(typeof d.signed === "object" && mine(d.signed.by, d.signed.name))) throw bad();
  // Training dates on a staff record say who recorded them: staff record new ones in their own name only.
  if (collection.split("/").pop() === "staff" && d.topics && typeof d.topics === "object") {
    for (const [k, t] of Object.entries(d.topics as Record<string, any>)) {
      if (t && typeof t === "object" && t.by !== undefined && t.by !== recordId(u) && canon(t) !== canon((current?.topics as any)?.[k])) throw bad();
    }
  }
  if (collection.split("/").pop() === "reviews") {
    if (d.by !== undefined && d.by !== current?.by && d.by !== recordId(u)) throw bad();
    // A review someone else has signed is theirs: staff can't rewrite or empty it.
    if (current?.by && current.by !== recordId(u)) throw new ApiError(403, "permission_denied", "This review was signed by someone else. Ask a manager to change it.");
  }
}

/* Sign-offs and closed days on the diary's day and week pages, for staff:
   - only a manager or admin can undo a sign-off (set signed back to null);
   - staff can mark only today closed, in their own name and with a reason, and only a manager or admin can reopen
     a closed day or close an earlier one (a past day marked closed stops counting as missed). */
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export function requireStaffDayRules(u: User, collection: string, id: string, data: unknown, current: Record<string, any> | undefined, canon: (v: unknown) => string): void {
  if (u.role !== "staff" || !data || typeof data !== "object") return;
  const col = collection.split("/").pop();
  if (col !== "days" && col !== "weeks") return;
  const d = data as Record<string, any>;
  const denied = (m: string) => new ApiError(403, "permission_denied", m);
  if ("signed" in d && d.signed === null && current?.signed) throw denied("Only a manager or admin can undo a sign-off.");
  // Clearing a whole section (the temperatures, the opening or closing checks…) is a manager's job.
  for (const [k, v] of Object.entries(d)) {
    if (v === null && k !== "signed" && k !== "closed" && current?.[k] != null) throw denied("Only a manager or admin can clear part of a day's record.");
  }
  if (col !== "days" || !("closed" in d) || canon(d.closed) === canon(current?.closed)) return;
  if (d.closed === null) {
    if (current?.closed) throw denied("Only a manager or admin can reopen a closed day.");
    return;
  }
  const c = d.closed;
  const ok = id === londonToday() && c && typeof c === "object" && c.by === recordId(u) && typeof c.reason === "string" && c.reason.trim();
  if (!ok) throw denied("Staff can only mark today closed, in their own name and with a reason. Ask a manager for other days.");
}

export function requireWrite(u: User, path: unknown): void {
  if (typeof path === "string" && !canWrite(u, path)) {
    // Not invalid_argument: the page treats that as "read-only for everything".
    throw new ApiError(403, "permission_denied", "Only managers can change this.");
  }
}

/* Staff training: staff fill in and sign their own record. A staff member may create or change a staff/<id>
   document only when it is in their own name (before and after the change), and may never delete one. Managers and
   admins are unaffected. Everything else in MANAGER_COLLECTIONS stays manager-only. */
export const isStaffRecordPath = (path: unknown) => typeof path === "string" && path.split("/").slice(-2, -1)[0] === "staff";
const sameName = (a: unknown, b: string) =>
  typeof a === "string" && a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
export function requireOwnStaffRecord(u: User, op: "set" | "update" | "delete", existingName: unknown, exists: boolean, nextName: unknown): void {
  const ok =
    op !== "delete" &&
    (!exists || sameName(existingName, u.name)) &&
    (op === "set" ? sameName(nextName, u.name) : nextName === undefined || sameName(nextName, u.name));
  if (!ok) throw new ApiError(403, "permission_denied", "Staff can only fill in their own training record.");
}

const WINDOW_MS = 15 * 60 * 1000;

/** Counts a write against the caller's IP; throws rate_limited once over the limit for this 15-minute window. */
export async function limitWrites(req: Request, env: Env, ctx: ExecutionContext, userId?: string): Promise<void> {
  // Several devices in one shop share its Wi-Fi, so one address: the limit is per person, with a much higher
  // ceiling for the address as a whole (a backstop against one connection flooding the site).
  const limit = Number(env.WRITE_LIMIT_PER_15_MIN) || 600;
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const window = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const take = (key: string) => env.DB.prepare(
    "INSERT INTO rate_limits (ip, window, n) VALUES (?, ?, 1) ON CONFLICT (ip, window) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(key, window).first<{ n: number }>();
  const [mine, all] = await Promise.all([userId ? take("user:" + userId) : Promise.resolve(null), take(ip)]);
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - WINDOW_MS).run());
  }
  if ((mine && mine.n > limit) || (all && all.n > (userId ? limit * 5 : limit))) {
    throw new ApiError(429, "rate_limited", "Too many changes in a short time. Wait a few minutes and try again.");
  }
}
