// The shape of each kind of diary record (docs/data-model.md), checked on the server before a write, so a bug or an
// old offline change can't save, say, a temperature as text or a log that isn't a list. Deliberately loose:
// only the types of fields we know, never required fields, null always allowed (older records have them), unknown
// fields allowed (newer pages may add some). A whole document (set) is checked in full; an update only for the
// fields it sends, so an old imperfect record never blocks an unrelated change. A refusal is 400 `invalid_data`
// with what was wrong (not invalid_argument, which the diary treats as "read-only").
import { ApiError } from "./http";

type T = "string" | "number" | "boolean" | "object" | "array" | "date" | "numberish";
type Shape = Record<string, T>;

const SHAPES: Record<string, Shape> = {
  settings: { units: "array", opening: "array", closing: "array", weekly: "array", closedDays: "array", info: "object", startDate: "date" },
  days: { date: "date", temps: "object", opening: "object", closing: "object", signed: "object", closed: "object", problems: "object" },
  weeks: { week: "date", items: "object", signed: "object", notes: "object" },
  extras: { name: "string", how: "string", freq: "string", who: "string", createdAt: "number", lastAt: "number", lastBy: "string", lastSet: "boolean", log: "array", sites: "array" },
  cleaning: { name: "string", how: "string", freq: "string", who: "string", createdAt: "number", lastAt: "number", lastBy: "string", lastSet: "boolean", log: "array", sites: "array" },
  deliveries: { date: "date", at: "number", supplier: "string", items: "string", chilled: "numberish", frozen: "numberish", noTemp: "boolean", outcome: "string", note: "string", by: "string" },
  maintenance: { title: "string", area: "string", details: "string", priority: "string", status: "string", reportedBy: "string", reportedAt: "number", doneAt: "number", at: "number", log: "array" },
  proveit: { date: "date", method: "string", food: "string", reading: "numberish", unit: "string", pass: "boolean", by: "string", at: "number" },
  allergens: { name: "string", contains: "array", notes: "string", by: "string", at: "number", sites: "array" },
  allergenDocs: { title: "string", fileName: "string", assetId: "string", size: "number", at: "number" },
  suppliers: { name: "string", supplies: "string", phone: "string", email: "string", notes: "string", at: "number", sites: "array" },
  contacts: { type: "string", name: "string", phone: "string", email: "string", notes: "string", at: "number", sites: "array" },
  staff: { name: "string", role: "string", topics: "object", sites: "array", signed: "object", at: "number" },
  reviews: { date: "date", answers: "object", notes: "string", by: "string", at: "number" },
  plans: { type: "string", title: "string", history: "array", updatedAt: "number" },
  onboarding: { title: "string", sections: "array", history: "array", updatedAt: "number" },
  inspections: { inspectionDate: "date", issues: "array", goodPoints: "array", scores: "object", updatedAt: "number" },
};

const LABEL: Record<T, string> = { string: "text", number: "a number", boolean: "yes or no", object: "a group of fields", array: "a list", date: "a date (YYYY-MM-DD)", numberish: "a number" };

function fits(v: unknown, t: T): boolean {
  if (v === null || v === undefined) return true;
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "object": return typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "date": return typeof v === "string" && (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v));
    // Readings entered in a box: a number, or text that reads as one (older pages saved what was typed).
    case "numberish": return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && (v.trim() === "" || Number.isFinite(Number(v))));
  }
}

const isOp = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).$op === "string";

/** Throws 400 invalid_data if `data` (a whole document) or `patch` (an update) doesn't fit its collection's shape. */
export function checkShape(collection: string, data: unknown, mode: "whole" | "patch"): void {
  const shape = SHAPES[collection.split("/").pop() || ""];
  if (!shape || !data || typeof data !== "object" || Array.isArray(data)) return;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const t = shape[k];
    if (!t || (mode === "patch" && isOp(v))) continue; // list operations are checked where they're applied
    if (!fits(v, t)) {
      const name = collection.split("/").pop();
      throw new ApiError(400, "invalid_data", `This couldn't be saved: "${k}" in ${name} should be ${LABEL[t]}. Reload the page and try again.`);
    }
  }
}
