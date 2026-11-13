// "Forgotten your password?" for wholesale customers (the customer sign-in page).
//
// A customer types their username or their business's email address. If it matches an approved, active sign-in, a
// one-time link is emailed to the business's own email address on file (the order email, or the accounts email when
// that's the one typed): never to an address typed in. The answer is always the same ("if it matches, we've emailed
// a link"), so the form can't be used to find out who has an account. The email also says the username, for anyone
// who's forgotten that instead.
//
// Only the link's SHA-256 hash is kept (migration 28's `wholesale_resets`); it works once and for an hour, and asking
// again replaces it. Choosing the new password ends every other session for that sign-in, clears any lockout and
// signs them in. Rate-limited per address (5 requests an hour) and per sign-in (3 emails an hour); the emails share
// the daily email limit. Not in backups.
import { checkPassword, checkUsername, hashPassword, newId } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, json, readJson } from "./http";
import { cleanEmail, emailReady, send } from "./email/send";
import { orderEmailSettings } from "./email/orders";

const RESET_MS = 60 * 60000;
const digest = async (token: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const FORGOT_ANSWER = "If that matches a wholesale account, we've emailed a link to reset the password to the business's email address. It works once, for an hour. Check your junk folder too.";

export async function migrateResets(env: Env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_resets (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_resets_account ON wholesale_resets (account_id, created_at)"),
  ]);
}

async function limit(env: Env, key: string, windowMs: number, max: number) {
  const window = Math.floor(Date.now() / windowMs) * windowMs;
  const r = await env.DB.prepare("INSERT INTO rate_limits(ip, window, n) VALUES (?, ?, 1) ON CONFLICT(ip, window) DO UPDATE SET n = n + 1 RETURNING n").bind(key, window).first<{ n: number }>();
  return (r?.n || 0) <= max;
}

/** Where to reach Strangers, for the sign-in page's "Need help?" (the first Order alerts address). */
export async function contactEmail(env: Env) {
  return (await orderEmailSettings(env)).to[0] || "sales@strangerscoffee.com";
}

function resetEmail(business: string, contact: string, username: string, link: string) {
  const hello = contact.split(/\s+/)[0];
  const subject = "Reset your Strangers Coffee wholesale password";
  const text = [hello ? `Hi ${hello},` : "Hello,", "", `Someone asked to reset the password for ${business}'s wholesale ordering sign-in.`, "", `Your username: ${username}`, "", `Choose a new password: ${link}`, "", "The link works once and lasts an hour. If you didn't ask for this, ignore this email: your password hasn't changed.", "", "Strangers Coffee"].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14181f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;border:1px solid #e3e6eb;">
<tr><td style="padding:24px 24px 8px;"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6675;">Strangers Coffee · Wholesale</div>
<h1 style="margin:6px 0 8px;font-size:22px;line-height:1.25;">Reset your password</h1>
<p style="margin:0;font-size:15px;line-height:1.55;">${hello ? `Hi ${esc(hello)}, someone` : "Someone"} asked to reset the password for <b>${esc(business)}</b>'s wholesale ordering sign-in.</p>
<p style="margin:12px 0 0;font-size:15px;line-height:1.55;">Your username: <b>${esc(username)}</b></p></td></tr>
<tr><td style="padding:18px 24px 6px;"><a href="${esc(link)}" style="display:inline-block;background:#0062cc;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;">Choose a new password</a></td></tr>
<tr><td style="padding:10px 24px 22px;font-size:13px;color:#5d6675;line-height:1.5;">The link works once and lasts an hour. If you didn't ask for this, ignore this email: your password hasn't changed.</td></tr>
</table><div style="font-size:12px;color:#5d6675;padding:12px;">Strangers Coffee · 10 Dove Street, Norwich NR2 1DE.</div></td></tr></table></body></html>`;
  return { subject, html, text };
}

type Match = { id: string; username: string; business: string; contact: string; email: string };

/** The sign-ins an identifier points to: a username, or a business's order or accounts email. */
async function matches(env: Env, identifier: string): Promise<Match[]> {
  const rows = identifier.includes("@")
    ? await env.DB.prepare(`SELECT a.id, a.username, c.data FROM wholesale_accounts a JOIN wholesale_preview c ON c.kind = 'customer' AND c.id = a.customer_id
        WHERE a.active = 1 AND a.approval_status = 'approved' AND (lower(trim(json_extract(c.data, '$.email'))) = ? OR lower(trim(json_extract(c.data, '$.accountsEmail'))) = ?) LIMIT 3`).bind(identifier, identifier).all<{ id: string; username: string; data: string }>()
    : await env.DB.prepare(`SELECT a.id, a.username, c.data FROM wholesale_accounts a JOIN wholesale_preview c ON c.kind = 'customer' AND c.id = a.customer_id
        WHERE a.active = 1 AND a.approval_status = 'approved' AND a.username = ?`).bind(identifier).all<{ id: string; username: string; data: string }>();
  const out: Match[] = [];
  for (const r of rows.results) {
    const c = JSON.parse(r.data || "{}");
    // The address the link goes to is always one on file: the one typed if it's the accounts email, else the order email.
    const order = cleanEmail(c.email), accounts = cleanEmail(c.accountsEmail);
    const email = identifier.includes("@") && accounts === identifier ? accounts : order;
    if (email) out.push({ id: r.id, username: r.username, business: c.business || "your business", contact: c.contact || "", email });
  }
  return out;
}

async function sendReset(env: Env, m: Match, signinUrl: string, replyTo: string) {
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_resets WHERE account_id = ? AND created_at > ?").bind(m.id, Date.now() - 3600000).first<{ n: number }>();
  if ((recent?.n || 0) >= 3) return;
  const token = newId(32), now = Date.now(), hash = await digest(token);
  await env.DB.batch([
    env.DB.prepare("UPDATE wholesale_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL").bind(now, m.id),
    env.DB.prepare("INSERT INTO wholesale_resets (hash, account_id, email, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)").bind(hash, m.id, m.email, now, now + RESET_MS),
  ]);
  const link = `${signinUrl}${signinUrl.includes("?") ? "&" : "?"}reset=${token}`;
  const result = await send(env, { to: { id: "customer", name: m.business, email: m.email, email_prefs: "{}", active: 1 }, kind: "order", mail: resetEmail(m.business, m.contact, m.username, link), about: `wholesale password reset for ${m.business}`, from: env.ORDER_EMAIL_FROM || "Strangers Coffee Orders <orders@staffstrangerscoffee.com>", replyTo });
  if (result !== "sent") await env.DB.prepare("DELETE FROM wholesale_resets WHERE hash = ?").bind(hash).run();
  else await audit(env, "wholesale_reset_sent", m.username, `A password reset link was emailed for wholesale sign-in ${m.username} (${m.business}).`);
}

async function liveReset(env: Env, token: unknown) {
  const invalidLink = () => new ApiError(404, "reset_invalid", "This reset link isn't valid. Ask for a new one from the sign-in page.");
  if (typeof token !== "string" || !/^[a-f0-9]{16,128}$/.test(token)) throw invalidLink();
  const row = await env.DB.prepare(`SELECT r.hash, r.account_id, r.expires_at, r.used_at, a.username, a.session_ver, a.active, a.approval_status, c.data FROM wholesale_resets r
      JOIN wholesale_accounts a ON a.id = r.account_id JOIN wholesale_preview c ON c.kind = 'customer' AND c.id = a.customer_id WHERE r.hash = ?`)
    .bind(await digest(token)).first<{ hash: string; account_id: string; expires_at: number; used_at: number | null; username: string; session_ver: number; active: number; approval_status: string; data: string }>();
  if (!row || !row.active || row.approval_status !== "approved") throw invalidLink();
  if (row.used_at) throw new ApiError(410, "reset_used", "This reset link has already been used, or a newer one was sent. Sign in, or ask for a new link.");
  if (row.expires_at <= Date.now()) throw new ApiError(410, "reset_expired", "This reset link has run out. Ask for a new one from the sign-in page.");
  return { row, business: String(JSON.parse(row.data || "{}").business || "") };
}

/** The sign-in page's routes: forgot (ask for a link), reset (GET: who it's for; POST: the new password) and contact. */
export async function handleReset(req: Request, env: Env, route: string, opts: { signinUrl: string; startSession: (accountId: string) => Promise<string>; waitUntil?: (p: Promise<unknown>) => void }): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") || "local";
  if (route === "contact" && req.method === "GET") return json({ email: await contactEmail(env) });
  if (route === "forgot" && req.method === "POST") {
    if (!await limit(env, "wholesale-forgot:" + ip, 3600000, 5)) throw new ApiError(429, "rate_limited", "Too many requests. Try again in an hour, or contact Strangers.");
    const body = await readJson<Record<string, unknown>>(req, 1024);
    const raw = typeof body?.identifier === "string" ? body.identifier.trim().toLowerCase() : "";
    if (!raw || raw.length > 150) throw new ApiError(400, "invalid_argument", "Type your username or your business's email address.");
    let identifier = raw;
    if (!raw.includes("@")) { try { identifier = checkUsername(raw); } catch { identifier = ""; } }
    if (identifier && emailReady(env)) {
      const work = (async () => {
        try {
          const found = await matches(env, identifier);
          if (!found.length) return;
          const replyTo = await contactEmail(env);
          for (const m of found) await sendReset(env, m, opts.signinUrl, replyTo);
        } catch (error) {
          await audit(env, "email_failed", null, `Couldn't send a wholesale password reset: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
        }
      })();
      // In the background where possible, so the answer takes the same time whether or not anything matched.
      if (opts.waitUntil) opts.waitUntil(work); else await work;
    }
    return json({ ok: true, message: FORGOT_ANSWER });
  }
  if (route === "reset") {
    if (!await limit(env, "wholesale-reset:" + ip, 3600000, 30)) throw new ApiError(429, "rate_limited", "Too many tries. Try again later.");
    if (req.method === "GET") {
      const { row, business } = await liveReset(env, new URL(req.url).searchParams.get("token"));
      return json({ username: row.username, business });
    }
    if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
    const body = await readJson<Record<string, unknown>>(req, 4096);
    const { row, business } = await liveReset(env, body?.token);
    const password = checkPassword(body?.password);
    const { hash, salt } = await hashPassword(password);
    const at = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE wholesale_resets SET used_at = ? WHERE hash = ? AND used_at IS NULL").bind(at, row.hash),
      env.DB.prepare("UPDATE wholesale_accounts SET password_hash = ?, password_salt = ?, must_change = 0, failed = 0, locked_until = 0, session_ver = session_ver + 1, version = version + 1, updated_at = ? WHERE id = ? AND session_ver = ? AND active = 1 AND changes() = 1")
        .bind(hash, salt, at, row.account_id, row.session_ver),
    ]);
    if (!results[1].meta.changes) {
      await env.DB.prepare("UPDATE wholesale_resets SET used_at = NULL WHERE hash = ? AND used_at = ?").bind(row.hash, at).run();
      throw new ApiError(409, "conflict", "This sign-in changed while you were choosing a password. Ask for a new link.");
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM wholesale_sessions WHERE account_id = ?").bind(row.account_id),
      env.DB.prepare("UPDATE wholesale_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL").bind(at, row.account_id),
      env.DB.prepare("DELETE FROM wholesale_resets WHERE created_at < ?").bind(at - 30 * 86400000),
    ]);
    await audit(env, "wholesale_reset", row.username, `Wholesale sign-in ${row.username} (${business}) chose a new password from a reset link.`);
    return json({ ok: true }, 200, { "set-cookie": await opts.startSession(row.account_id) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale sign-in route.");
}
