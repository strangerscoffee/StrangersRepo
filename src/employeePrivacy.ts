// Employee ownership is independent of display names and historical diary attribution.
import type { User } from "./auth";
import { ApiError, type Env } from "./http";

type Data = Record<string, any>;
const PRIVATE_COLLECTIONS = new Set(["staff", "contacts", "onboarding"]);
export const employeeCollection = (collection: string) => PRIVATE_COLLECTIONS.has(collection.split("/").at(-1) || "");
export const docCollection = (path: string) => path.slice(0, path.lastIndexOf("/"));
const kind = (collection: string) => collection.split("/").at(-1);
const denied = () => new ApiError(403, "permission_denied", "Only admins or the employee can access this private record.");
const bad = (message: string) => new ApiError(400, "invalid_data", message);

export function canReadEmployeeDoc(user: User, collection: string, data: Data | undefined, verified = false): boolean {
  if (user.role === "admin" || !employeeCollection(collection)) return true;
  if (!data || !verified) return false;
  if (kind(collection) !== "staff" && data.visibility === "shared-business") return true;
  return (kind(collection) === "staff" || data.visibility === "employee") && data.ownerUserId === user.id;
}

/** Never present historical, unverified JSON claims as a reviewed owner/classification. */
export function employeeData(collection: string, data: Data, verified: boolean): Data {
  if (!employeeCollection(collection) || verified) return data;
  return { ...data, ownerUserId: null, ...(kind(collection) === "staff" ? {} : { visibility: null }) };
}

/** Applied in SQL before ordering/limits. Unclassified legacy records are admin-only. */
export function employeeReadFilter(user: User | undefined, collection: string): { sql: string; values: string[] } {
  if (!user || user.role === "admin" || !employeeCollection(collection)) return { sql: "", values: [] };
  const own = "json_extract(data, '$.ownerUserId') = ?";
  return { sql: " AND employee_privacy_version = seq" + (kind(collection) === "staff" ? ` AND (${own})` : ` AND (json_extract(data, '$.visibility') = 'shared-business' OR (json_extract(data, '$.visibility') = 'employee' AND ${own}))`), values: [user.id] };
}

/** Check current and proposed ownership before any CAS response can disclose its contents. */
export async function protectEmployeeWrite(env: Env, user: User, collection: string, op: "set" | "update" | "delete", current: Data | undefined, input: unknown, verified = false): Promise<void> {
  if (!employeeCollection(collection)) return;
  if (user.role !== "admin" && current && !canReadEmployeeDoc(user, collection, current, verified)) throw denied();
  if (user.role !== "admin" && !current && kind(collection) !== "staff") throw denied();
  if (op === "delete") {
    if (user.role !== "admin" && (kind(collection) === "staff" || current?.visibility !== "shared-business")) throw denied();
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return; // normal shape validation reports this
  const data = input as Data, staff = kind(collection) === "staff";
  if (user.role !== "admin") {
    if (data.ownerUserId !== undefined && data.ownerUserId !== (current?.ownerUserId ?? user.id)) throw denied();
    if (!staff && data.visibility !== undefined && data.visibility !== (current?.visibility ?? "employee")) throw denied();
    if (staff && data.visibility !== undefined && data.visibility !== "employee") throw denied();
    // Full-document saves from older pages must retain the protected metadata.
    if (staff || current?.visibility === "employee" || !current) data.ownerUserId = current?.ownerUserId ?? user.id;
    if (!staff) data.visibility = current?.visibility ?? "employee";
  } else {
    if (data.ownerUserId === undefined && current) data.ownerUserId = verified ? current.ownerUserId ?? null : null;
    if (!staff && data.visibility === undefined && current) data.visibility = verified ? current.visibility ?? null : null;
  }
  if (staff && data.visibility !== undefined && data.visibility !== "employee") throw bad("Staff training records are private employee records.");
  if (!staff && data.visibility !== undefined && data.visibility !== null && data.visibility !== "shared-business" && data.visibility !== "employee") throw bad("Choose shared business information or a private employee record.");
  if (!staff && data.visibility === "shared-business") {
    if (user.role !== "admin" && data.ownerUserId != null && data.ownerUserId !== current?.ownerUserId) throw denied();
    data.ownerUserId = null;
    return;
  }
  const owner = data.ownerUserId;
  if (owner !== undefined && owner !== null && owner !== "") {
    if (typeof owner !== "string" || !await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner).first()) throw bad("Choose an existing employee account as the private record's owner.");
  } else if (!staff && data.visibility === "employee") throw bad("Choose the employee who owns this private record.");
  // Admins may retain unlinked legacy training, which stays invisible to all other accounts.
}
