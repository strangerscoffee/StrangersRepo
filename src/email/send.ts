// Sending the rota's emails through Resend (https://resend.com), and the bits every email needs: each person's
// address and which emails they want, the links to change that or unsubscribe, a daily limit, and a line in the
// admin section's activity for each one sent or refused. With no RESEND_API_KEY (the host adds it as a secret in
// Cloudflare), nothing is sent and the rota works as before.
import { audit } from "../audit";
import { readToken, signToken } from "../auth";
import { Env } from "../http";
import { Built, Links } from "./templates";

/** The emails people can turn on or off, and how each starts (docs/data-model.md, users.email_prefs). */
export const EMAIL_KINDS = { published: true, changed: true, requests: true, open: false } as const;
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

export const emailReady = (env: Env) => !!env.RESEND_API_KEY;
const FROM = (env: Env) => env.EMAIL_FROM || "Strangers Rota <rota@staffstrangerscoffee.com>";
const DAILY = (env: Env) => Math.max(1, Number(env.EMAIL_DAILY_LIMIT) || 100);

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
/** A cleaned email address, "" to remove it, or null if it isn't one. */
export function cleanEmail(v: unknown): string | null {
  if (v === null || v === "") return "";
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "" ? "" : s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

export interface Recipient { id: string; name: string; email: string | null; email_prefs: string; active: number }

export async function recipients(env: Env, ids: string[]): Promise<Map<string, Recipient>> {
  if (!ids.length) return new Map();
  const { results } = await env.DB.prepare("SELECT id, name, email, email_prefs, active FROM users WHERE id IN (SELECT value FROM json_each(?))")
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

export interface Outgoing { to: Recipient & { email: string }; kind: EmailKind | "test"; mail: Built; links: Links; about: string; replyTo?: string | null; calendar?: string }

/** Sends one email (never throws): "sent", "off" (no API key), "limit" (the day's allowance is used) or "failed". */
export async function send(env: Env, o: Outgoing): Promise<"sent" | "off" | "limit" | "failed"> {
  if (!emailReady(env)) return "off";
  try {
    const since = Date.now() - 864e5;
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'email_sent' AND at > ?").bind(since).first<{ n: number }>();
    if ((n?.n ?? 0) >= DAILY(env)) {
      await audit(env, "email_failed", null, `Didn't email ${o.to.name} (${o.about}): the day's limit of ${DAILY(env)} emails was reached`);
      return "limit";
    }
    const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM(env), to: [o.to.email], subject: o.mail.subject, html: o.mail.html, text: o.mail.text,
        ...(o.replyTo ? { reply_to: o.replyTo } : {}),
        // One-tap unsubscribe in Gmail and Apple Mail (RFC 8058).
        headers: { "List-Unsubscribe": `<${o.links.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        ...(o.calendar ? { attachments: [{ filename: "shifts.ics", content: btoa(unescape(encodeURIComponent(o.calendar))), content_type: "text/calendar; charset=utf-8" }] } : {}),
      }),
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => "")).slice(0, 200);
      await audit(env, "email_failed", null, `Couldn't email ${o.to.name} (${o.about}): Resend said ${res.status}${why ? ` ${why}` : ""}`);
      return "failed";
    }
    await audit(env, "email_sent", null, `Emailed ${o.to.name}: ${o.about}`);
    return "sent";
  } catch (e) {
    await audit(env, "email_failed", null, `Couldn't email ${o.to.name} (${o.about}): ${String((e as Error)?.message || e).slice(0, 160)}`).catch(() => {});
    return "failed";
  }
}

/** Sends several, one after another (Resend allows a few a second), in the background of a request. */
export function sendAll(env: Env, ctx: ExecutionContext | undefined, list: Outgoing[]): void {
  if (!list.length || !emailReady(env)) return;
  const run = (async () => { for (const o of list) await send(env, o); })();
  if (ctx) ctx.waitUntil(run); else void run;
}
