// Employee ownership is independent of display names and historical diary attribution.
import type { User } from "./auth";
import { ApiError, type Env } from "./http";

type Data = Record<string, any>;
const PRIVATE_COLLECTIONS = new Set(["staff", "contacts", "onboarding", "accidents"]);
// Records that always belong to one account (no shared-business classification): training records, and accident
// book entries (owned by whoever recorded them; injury details are personal data seen only by admins and them).
const OWNED = new Set(["staff", "accidents"]);
export const employeeCollection = (collection: string) => PRIVATE_COLLECTIONS.has(collection.split("/").at(-1) || "");
export const docCollection = (path: string) => path.slice(0, path.lastIndexOf("/"));
const kind = (collection: string) => collection.split("/").at(-1);
const owned = (collection: string) => OWNED.has(kind(collection) || "");
const denied = () => new ApiError(403, "permission_denied", "Only admins or the employee can access this private record.");
const bad = (message: string) => new ApiError(400, "invalid_data", message);

export function canReadEmployeeDoc(user: User, collection: string, data: Data | undefined, verified = false): boolean {
  if (user.role === "admin" || !employeeCollection(collection)) return true;
  if (!data || !verified) return false;
  if (!owned(collection) && data.visibility === "shared-business") return true;
  return (owned(collection) || data.visibility === "employee") && data.ownerUserId === user.id;
}

/** Never present historical, unverified JSON claims as a reviewed owner/classification. */
export function employeeData(collection: string, data: Data, verified: boolean): Data {
  if (!employeeCollection(collection) || verified) return data;
  return { ...data, ownerUserId: null, ...(owned(collection) ? {} : { visibility: null }) };
}

/** Applied in SQL before ordering/limits. Unclassified legacy records are admin-only. */
export function employeeReadFilter(user: User | undefined, collection: string): { sql: string; values: string[] } {
  if (!user || user.role === "admin" || !employeeCollection(collection)) return { sql: "", values: [] };
  const own = "json_extract(data, '$.ownerUserId') = ?";
  return { sql: " AND employee_privacy_version = seq" + (owned(collection) ? ` AND (${own})` : ` AND (json_extract(data, '$.visibility') = 'shared-business' OR (json_extract(data, '$.visibility') = 'employee' AND ${own}))`), values: [user.id] };
}

/** Check current and proposed ownership before any CAS response can disclose its contents. */
export async function protectEmployeeWrite(env: Env, user: User, collection: string, op: "set" | "update" | "delete", current: Data | undefined, input: unknown, verified = false): Promise<void> {
  if (!employeeCollection(collection)) return;
  if (user.role !== "admin" && current && !canReadEmployeeDoc(user, collection, current, verified)) throw denied();
  if (user.role !== "admin" && !current && !owned(collection)) throw denied();
  if (op === "delete") {
    if (user.role !== "admin" && (owned(collection) || current?.visibility !== "shared-business")) throw denied();
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return; // normal shape validation reports this
  const data = input as Data, ownedRecord = owned(collection);
  if (user.role !== "admin") {
    if (data.ownerUserId !== undefined && data.ownerUserId !== (current?.ownerUserId ?? user.id)) throw denied();
    if (!ownedRecord && data.visibility !== undefined && data.visibility !== (current?.visibility ?? "employee")) throw denied();
    if (ownedRecord && data.visibility !== undefined && data.visibility !== "employee") throw denied();
    // Full-document saves from older pages must retain the protected metadata.
    if (ownedRecord || current?.visibility === "employee" || !current) data.ownerUserId = current?.ownerUserId ?? user.id;
    if (!ownedRecord) data.visibility = current?.visibility ?? "employee";
  } else {
    if (data.ownerUserId === undefined && current) data.ownerUserId = verified ? current.ownerUserId ?? null : null;
    if (!ownedRecord && data.visibility === undefined && current) data.visibility = verified ? current.visibility ?? null : null;
  }
  if (ownedRecord && data.visibility !== undefined && data.visibility !== "employee") throw bad(kind(collection) === "accidents" ? "Accident book entries are private records." : "Staff training records are private employee records.");
  if (!ownedRecord && data.visibility !== undefined && data.visibility !== null && data.visibility !== "shared-business" && data.visibility !== "employee") throw bad("Choose shared business information or a private employee record.");
  if (!ownedRecord && data.visibility === "shared-business") {
    if (user.role !== "admin" && data.ownerUserId != null && data.ownerUserId !== current?.ownerUserId) throw denied();
    data.ownerUserId = null;
    return;
  }
  const owner = data.ownerUserId;
  if (owner !== undefined && owner !== null && owner !== "") {
    if (typeof owner !== "string" || !await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner).first()) throw bad("Choose an existing employee account as the private record's owner.");
  } else if (!ownedRecord && data.visibility === "employee") throw bad("Choose the employee who owns this private record.");
  // Admins may retain unlinked legacy training, which stays invisible to all other accounts.
}
