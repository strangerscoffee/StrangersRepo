import { invalid } from "./http";

// See docs/data-model.md. The Roastery's records are at the top level; the other sites are under sites/<id>/.
export const SITE_PREFIXES = ["", "sites/cafe/", "sites/asg/", "sites/factory/"];

export const COLLECTIONS = [
  "settings", "days", "weeks", "extras", "cleaning", "proveit", "allergens", "allergenDocs",
  "suppliers", "contacts", "staff", "reviews", "plans", "onboarding", "inspections", "deliveries", "maintenance",
];

/** Single documents outside the per-site collections. config/people holds names for people who recorded in
 * the old Claude diary (read-only now). */
const CONFIG_DOCS = new Set(["config/shared", "config/people"]);

const SITE_COLLECTIONS = new Set(SITE_PREFIXES.flatMap((p) => COLLECTIONS.map((c) => p + c)));


const ID_RE = /^[^/\u0000-\u001f\u007f]{1,200}$/;

export interface DocPath {
  path: string;
  collection: string;
  id: string;
}

export function parseDocPath(path: unknown): DocPath {
  if (typeof path !== "string") throw invalid("Path must be a string.");
  const parts = path.split("/");
  if (parts.length % 2 !== 0 || parts.some((p) => p === "")) throw invalid(`Not a document path: ${path}`);
  const id = parts.pop()!;
  const collection = parts.join("/");
  if (!ID_RE.test(id) || id === "." || id === "..") throw invalid(`Invalid document id: ${path}`);
  if (!SITE_COLLECTIONS.has(collection) && !CONFIG_DOCS.has(path)) throw invalid(`Path not allowed: ${path}`);
  return { path, collection, id };
}

export function parseCollectionPath(path: unknown): string {
  if (typeof path !== "string" || !SITE_COLLECTIONS.has(path)) throw invalid(`Collection not allowed: ${String(path)}`);
  return path;
}

/** Paths the website itself (the page) may read and write. */
export function parseWebDocPath(path: unknown, mode: "read" | "write"): DocPath {
  const p = parseDocPath(path);
  if (mode === "write" && p.path === "config/people") throw invalid("config/people is read-only.");
  return p;
}

export const MAX_DOC_BYTES = 256 * 1024;

/** Validates document data and returns its JSON text. */
export function encodeDoc(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw invalid("Document data must be an object.");
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).length > MAX_DOC_BYTES) throw invalid("Document is larger than 256 KB.");
  return text;
}

/** JSON with object keys sorted, for comparing documents regardless of key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as any)[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

/** Deep merge for update(): nested plain objects merge, everything else (arrays, null, scalars) replaces. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = isOp(v) ? applyOp(cur, v) : isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : resolveOps(v);
  }
  return out;
}

/*
 * List and number operations, applied on the server against the stored document inside the same versioned
 * read-merge-write as any update, so two devices adding to the same log both keep their entry
 * (docs/runtime-api.md, "Changes from several devices"):
 *   {"$op": "prepend", "items": [...], "key"?: "at", "max"?: 300}  add items to the front, skipping any already
 *                                                                  there (same `key` value, or identical);
 *                                                                  "order": "desc" keeps the list newest `key` first
 *   {"$op": "remove", "key": "at", "values": [...]}                 drop items whose `key` is one of `values`
 *   {"$op": "max", "value": n}                                      keep the larger number
 */
const OPS = new Set(["prepend", "remove", "max"]);
export function isOp(v: unknown): v is Record<string, any> {
  return isPlainObject(v) && typeof v.$op === "string";
}
function checkOp(v: Record<string, any>) {
  if (!OPS.has(v.$op)) throw invalid(`Unknown list operation ${String(v.$op).slice(0, 20)}.`);
  if (v.$op === "prepend" && (!Array.isArray(v.items) || (v.max != null && !(Number.isInteger(v.max) && v.max > 0)))) throw invalid("prepend needs items.");
  if (v.$op === "remove" && (typeof v.key !== "string" || !Array.isArray(v.values))) throw invalid("remove needs a key and values.");
  if (v.$op === "max" && typeof v.value !== "number") throw invalid("max needs a number.");
  if (v.key != null && typeof v.key !== "string") throw invalid("A list operation's key is a field name.");
}
function applyOp(cur: unknown, v: Record<string, any>): unknown {
  checkOp(v);
  // Only on what's already a list (or a number, for max), or nothing yet: never a way to replace a section.
  if (cur != null && (v.$op === "max" ? typeof cur !== "number" : !Array.isArray(cur))) throw invalid(`${v.$op} only works on a ${v.$op === "max" ? "number" : "list"}.`);
  if (v.$op === "max") return typeof cur === "number" && cur > v.value ? cur : v.value;
  const list = Array.isArray(cur) ? cur : [];
  const same = (a: any, b: any) => (v.key ? isPlainObject(a) && isPlainObject(b) && a[v.key] !== undefined && a[v.key] === b[v.key] : JSON.stringify(a) === JSON.stringify(b));
  if (v.$op === "remove") return list.filter((x: any) => !(isPlainObject(x) && v.values.includes(x[v.key])));
  const add = (v.items as unknown[]).filter((x) => !list.some((y) => same(x, y))).map(resolveOps);
  const all = [...add, ...list];
  if (v.order === "desc" && v.key) {
    const at = (x: unknown): any => (isPlainObject(x) ? x[v.key] ?? 0 : 0);
    all.sort((a, b) => (at(b) > at(a) ? 1 : at(b) < at(a) ? -1 : 0));
  }
  return all.slice(0, v.max ?? 500);
}
/** A value written where nothing was before: any operations inside it apply to nothing. */
export function resolveOps(v: unknown): unknown {
  if (isOp(v)) return applyOp(undefined, v);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveOps(x)]));
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
