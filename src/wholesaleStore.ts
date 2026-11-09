// Versioned records shared by wholesale ordering and catalogue management.
import { ApiError, type Env, invalid } from "./http";
export type Kind = "order" | "customer" | "catalogue";
export interface Row { id: string; data: string; version: number; updated_at: number }
export interface Versioned { id: string; version: number; updatedAt: number }
const conflict = () => new ApiError(409, "conflict", "This record changed on another device. Reload it before saving.");
export const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Send a JSON object.");
  return value as Record<string, any>;
};
export function text(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw invalid(`Check ${label} (maximum ${max} characters).`);
  return value.trim();
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid("Send the record's ifVersion.");
  return value as number;
}
export const decode = <T>(row: Row): T & Versioned => ({ ...JSON.parse(row.data), id: row.id, version: row.version, updatedAt: row.updated_at });
export async function get<T>(env: Env, kind: Kind, id: string): Promise<(T & Versioned) | null> {
  const row = await env.DB.prepare("SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = ? AND id = ?").bind(kind, id).first<Row>();
  return row ? decode<T>(row) : null;
}
export async function list<T>(env: Env, kind: Kind, limit = 200): Promise<(T & Versioned)[]> {
  const rows = await env.DB.prepare("SELECT id, data, version, updated_at FROM wholesale_preview WHERE kind = ? ORDER BY updated_at DESC, id LIMIT ?").bind(kind, limit).all<Row>();
  return rows.results.map((row) => decode<T>(row));
}
export async function save<T extends object>(env: Env, kind: Kind, id: string, data: T, expected: number): Promise<T & Versioned> {
  const at = Date.now();
  const result = expected === 0
    ? await env.DB.prepare("INSERT INTO wholesale_preview (kind, id, data, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(kind, id) DO NOTHING").bind(kind, id, JSON.stringify(data), at).run()
    : await env.DB.prepare("UPDATE wholesale_preview SET data = ?, version = version + 1, updated_at = ? WHERE kind = ? AND id = ? AND version = ?").bind(JSON.stringify(data), at, kind, id, expected).run();
  if (!result.meta.changes) throw conflict();
  return { ...data, id, version: expected + 1, updatedAt: at };
}
