// The account and admin event log (audit_log, src/schema.ts), shown in the admin section's Activity and Security.
import { Env } from "./http";

const KEEP_MS = 400 * 24 * 3600 * 1000;

/** Records an event. Never throws: a failed log write mustn't stop the change it describes. */
export async function audit(env: Env, kind: string, actor: string | null, text: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO audit_log (at, kind, actor, text) VALUES (?, ?, ?, ?)").bind(Date.now(), kind, actor, text.slice(0, 300)).run();
    if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM audit_log WHERE at < ?").bind(Date.now() - KEEP_MS).run();
  } catch (e) {
    console.error("audit", e);
  }
}
