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
export { appForHost, appLinks, isRotaSharedFile } from "./hosts";

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
export async function limitWrites(req: Request, env: Env, ctx: ExecutionContext): Promise<void> {
  const limit = Number(env.WRITE_LIMIT_PER_15_MIN) || 600;
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const window = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (ip, window, n) VALUES (?, ?, 1) ON CONFLICT (ip, window) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(ip, window).first<{ n: number }>();
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_limits WHERE window < ?").bind(window - WINDOW_MS).run());
  }
  if (row && row.n > limit) {
    throw new ApiError(429, "rate_limited", "Too many changes from this connection. Wait a few minutes and try again.");
  }
}
