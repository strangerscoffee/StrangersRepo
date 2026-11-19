// Sending the rota's emails through Resend (https://resend.com), and the bits every email needs: each person's
// address and which emails they want, the links to change that or unsubscribe, a daily limit, and a line in the
// admin section's activity for each one sent or refused. With no RESEND_API_KEY (the host adds it as a secret in
// Cloudflare), nothing is sent and the rota works as before.
import { recordAccepted, recipientSuppressed } from "./delivery";
export { cleanEmail } from "./address";
import { audit } from "../audit";
import { readToken, signToken } from "../auth";
import { Env, invalid } from "../http";
import { Built, Links } from "./templates";
import { isWholesaleEmail, rotaSender } from "./sender";

/** The emails people can turn on or off, and how each starts (docs/data-model.md, users.email_prefs). */
export const EMAIL_KINDS = { published: true, changed: true, requests: true, open: false, weekly: true, holiday: true } as const;
/** The sites a manager's Monday summary covers (email_prefs.weeklySites); none chosen means all four. */
export const SUMMARY_SITES = ["roastery", "cafe", "asg", "factory"] as const;
export type EmailKind = keyof typeof EMAIL_KINDS;
export type Prefs = Record<EmailKind, boolean>;

export function prefsOf(raw: unknown): Prefs {
  let p: any = {};
  try { p = typeof raw === "string" ? JSON.parse(raw) : raw || {}; } catch {}
  const out = {} as Prefs;
  for (const k of Object.keys(EMAIL_KINDS) as EmailKind[]) out[k] = typeof p[k] === "boolean" ? p[k] : EMAIL_KINDS[k];
  return out;
}
export const isEmailKind = (k: unknown): k is EmailKind => typeof k === "string" && Object.hasOwn(EMAIL_KINDS, k);

export function weeklySitesOf(raw: unknown): string[] {
  let p: any = {};
  try { p = typeof raw === "string" ? JSON.parse(raw) : raw || {}; } catch {}
  const s = Array.isArray(p.weeklySites) ? p.weeklySites.filter((x: unknown) => (SUMMARY_SITES as readonly unknown[]).includes(x)) : [];
  return s.length ? SUMMARY_SITES.filter((x) => s.includes(x)) : [...SUMMARY_SITES];
}

/** Changes someone's email choices: any of the switches, and the Monday summary's sites. Throws invalid_argument. */
export async function savePrefs(env: Env, userId: string, change: { prefs?: unknown; weeklySites?: unknown }) {
  const row = await env.DB.prepare("SELECT email_prefs FROM users WHERE id = ?").bind(userId).first<{ email_prefs: string }>();
  let raw: any = {};
  try { raw = JSON.parse(row?.email_prefs || "{}") || {}; } catch {}
  const prefs = prefsOf(raw);
  if (change.prefs !== undefined) {
    if (!change.prefs || typeof change.prefs !== "object" || Array.isArray(change.prefs)) throw invalid("Choose which emails to get.");
    for (const [k, v] of Object.entries(change.prefs)) {
      if (!isEmailKind(k) || typeof v !== "boolean") throw invalid("Choose which emails to get.");
      prefs[k] = v;
    }
  }
  let sites: string[] | undefined;
  if (change.weeklySites !== undefined) {
    if (!Array.isArray(change.weeklySites) || change.weeklySites.some((x) => !(SUMMARY_SITES as readonly unknown[]).includes(x))) throw invalid("Choose the sites for the Monday summary.");
    sites = SUMMARY_SITES.filter((x) => (change.weeklySites as unknown[]).includes(x));
    if (!sites.length) throw invalid("Choose at least one site, or switch the Monday summary off.");
  }
  const next = { ...prefs, weeklySites: sites ?? weeklySitesOf(raw) };
  await env.DB.prepare("UPDATE users SET email_prefs = ? WHERE id = ?").bind(JSON.stringify(next), userId).run();
  return { prefs, weeklySites: next.weeklySites };
}

export const emailReady = (env: Env) => !!env.RESEND_API_KEY;
const DAILY = (env: Env) => Math.max(1, Number(env.EMAIL_DAILY_LIMIT) || 100);


export interface Recipient { id: string; name: string; email: string | null; email_prefs: string; active: number; role?: string }

export async function recipients(env: Env, ids: string[]): Promise<Map<string, Recipient>> {
  if (!ids.length) return new Map();
  const { results } = await env.DB.prepare("SELECT id, name, email, email_prefs, active, role FROM users WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(ids)])).all<Recipient>();
  return new Map(results.map((r) => [r.id, r]));
}

/** Whether this person gets this kind of email: an active account with an address that hasn't turned it off. */
export const wants = (r: Recipient | undefined, kind: EmailKind): r is Recipient & { email: string } =>
  !!r && !!r.active && !!r.email && prefsOf(r.email_prefs)[kind];

/** The links in an email to this person: the rota, their email settings, and a signed one-tap unsubscribe. */
export async function linksFor(env: Env, base: { rota: string; diary: string }, userId: string, kind: EmailKind | "test"): Promise<Links> {
  const t = await signToken(env, "unsub:", { u: userId, k: kind });
  return { rota: base.rota, prefs: `${base.rota.replace(/\/$/, "")}/#avail`, unsubscribe: `${base.diary.replace(/\/$/, "")}/email/unsubscribe?t=${t}` };
}
export const readUnsubscribe = (env: Env, t: unknown) => readToken(env, "unsub:", t) as Promise<{ u: string; k: string } | null>;

export interface Outgoing {
  to: Recipient & { email: string }; kind: EmailKind | "test" | "order"; mail: Built; about: string; calendar?: string;
  /** Unsubscribe links for emails to people; business notifications (new orders) have none. */
  links?: Links;
  /** Another sender on the same verified domain (new orders come from orders@), and where replies go. */
  from?: string; replyTo?: string;
}

/** Sends one email (never throws): "sent", "off" (no API key), "limit" (the day's allowance is used) or "failed". */
export async function sendOutcome(env: Env, o: Outgoing, idempotencyKey?: string): Promise<{ status: "sent" | "off" | "limit" | "failed"; uncertain?: boolean; permanent?: boolean }> {
  if (!emailReady(env)) return { status: "off" };
  const prefix = isWholesaleEmail(o) ? "wholesale_email_" : "email_";
  let started = false;
  try {
    if (await recipientSuppressed(env,o.to.email)) {
      await audit(env, prefix + "failed", null, `Email to ${o.to.name} (${o.about}) is suppressed after a delivery problem. Review Email health in Admin.`);
      return {status:"failed",permanent:true};
    }
    const since = Date.now() - 864e5;
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind IN ('email_sent','wholesale_email_sent') AND at > ?").bind(since).first<{ n: number }>();
    if ((n?.n ?? 0) >= DAILY(env)) {
      await audit(env, prefix + "failed", null, `The daily email limit delayed mail to ${o.to.name} (${o.about}).`);
      return { status: "limit" };
    }
    started = true;
    const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        from: o.from || rotaSender(env), to: [o.to.email], subject: o.mail.subject, html: o.mail.html, text: o.mail.text,
        ...(o.replyTo ? { reply_to: o.replyTo } : {}),
        // Replies use the configured business From address. Account email addresses stay private to their owner.
        // One-tap unsubscribe in Gmail and Apple Mail (RFC 8058).
        ...(o.links ? { headers: { "List-Unsubscribe": `<${o.links.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
        ...(o.calendar ? { attachments: [{ filename: "shifts.ics", content: btoa(unescape(encodeURIComponent(o.calendar))), content_type: "text/calendar; charset=utf-8" }] } : {}),
      }),
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => "")).slice(0, 200);
      await audit(env, prefix + "failed", null, `Couldn't email ${o.to.name} (${o.about}). Resend returned ${res.status}${why ? ` ${why}` : ""}`);
      return { status: "failed", uncertain: !!idempotencyKey && res.status === 409 };
    }
    const acknowledged = await res.json().catch(()=>null) as {id?:unknown}|null;
    await recordAccepted(env, o, acknowledged?.id, idempotencyKey).catch(() => audit(env, prefix + "tracking_failed", null, "An accepted email could not be recorded for delivery feedback."));
    await audit(env, prefix + "sent", null, `Resend accepted email for ${o.to.name} — ${o.about}`);
    return { status: "sent" };
  } catch (e) {
    await audit(env, prefix + "failed", null, `Couldn't email ${o.to.name} (${o.about}). ${String((e as Error)?.message || e).slice(0, 160)}`).catch(() => {});
    return { status: "failed", uncertain: started };
  }
}

export async function send(env: Env, o: Outgoing): Promise<"sent" | "off" | "limit" | "failed"> {
  return (await sendOutcome(env, o)).status;
}

/** Sends several, one after another (Resend allows a few a second), in the background of a request. */
export function sendAll(env: Env, ctx: ExecutionContext | undefined, list: Outgoing[]): void {
  if (!list.length || !emailReady(env)) return;
  const run = (async () => { for (const o of list) await send(env, o); })();
  if (ctx) ctx.waitUntil(run); else void run;
}
