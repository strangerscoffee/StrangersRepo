// Bringing QuickBooks customers into Wholesale, and inviting them to order online.
//
// Import (Admin → Wholesale → Customers → Import from QuickBooks): the customer list exported from QuickBooks is read
// in the browser (public/admin/wholesale-import.js) and sent here as plain rows. Each becomes an Active business with
// its contact details and delivery address, matched first by the QuickBooks name saved on a business (`quickbooksName`,
// admin-only) and then by business name (case, accents and punctuation ignored, like Insights), so running it again
// fills gaps instead of making duplicates. An existing business only has its empty fields filled; nothing typed in
// Admin is overwritten. No logins are made and nothing is emailed.
//
// Invites: an admin sends a business a one-time link (migration 23's `wholesale_invites`: only the token's hash is
// kept; 14 days; a new invite replaces the old one) to the business email. The link opens the customer sign-in page,
// where they choose a username and password; the account is approved straight away and signed in. A business that
// already has a sign-in can't be invited. Invites share the daily email limit.
import { checkPassword, checkUsername, hashPassword, newId } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { customerKey } from "./insightsMath";
import { cleanEmail, emailReady, send } from "./email/send";
import { get, save } from "./wholesaleStore";
import type { Customer } from "./wholesaleAccounts";

const INVITE_MS = 14 * 86400000;
const digest = async (token: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const str = (v: unknown, max: number) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

export async function migrateInvites(env: Env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS wholesale_invites (hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_by TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS wholesale_invites_customer ON wholesale_invites (customer_id)"),
  ]);
}

type Row = { id: string; data: string; version: number };
type ImportRow = { business: string; contact: string; email: string; phone: string; address: string; postcode: string; quickbooksName: string };

/** Adds or fills in businesses from the QuickBooks customer list. */
export async function importCustomers(env: Env, value: unknown, actor: string) {
  const body = value as Record<string, unknown>;
  if (!body || !Array.isArray(body.customers) || !body.customers.length || body.customers.length > 500) throw invalid("Send from 1 to 500 customers.");
  const rows: ImportRow[] = body.customers.map((raw: any, i: number) => {
    const business = str(raw?.business, 120), email = cleanEmail(str(raw?.email, 150));
    if (!business) throw invalid(`Customer ${i + 1} needs a business name.`);
    return { business, contact: str(raw?.contact, 120), email: email || "", phone: str(raw?.phone, 40), address: typeof raw?.address === "string" ? raw.address.trim().slice(0, 500) : "", postcode: str(raw?.postcode, 20).toUpperCase(), quickbooksName: str(raw?.quickbooksName, 200) || business };
  });
  const existing = (await env.DB.prepare("SELECT id, data, version FROM wholesale_preview WHERE kind = 'customer'").all<Row>()).results.map((r) => ({ ...r, c: JSON.parse(r.data) as Customer & { quickbooksName?: string } }));
  const byQb = new Map(existing.filter((r) => r.c.quickbooksName).map((r) => [customerKey(r.c.quickbooksName!), r]));
  const byName = new Map(existing.map((r) => [customerKey(r.c.business), r]));
  const seen = new Set<string>(), results: { business: string; id: string; action: "created" | "updated" | "unchanged" }[] = [];
  for (const row of rows) {
    const key = customerKey(row.quickbooksName);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byQb.get(key) || byName.get(key) || byName.get(customerKey(row.business));
    if (match) {
      const c = match.c, next = { ...c };
      const fill = (field: "contact" | "email" | "phone" | "address" | "postcode") => { if (!String(c[field] || "").trim() && row[field]) (next as any)[field] = row[field]; };
      (["contact", "email", "phone", "address", "postcode"] as const).forEach(fill);
      if (!c.quickbooksName) next.quickbooksName = row.quickbooksName;
      if (JSON.stringify(next) === JSON.stringify(c)) { results.push({ business: c.business, id: match.id, action: "unchanged" }); continue; }
      const saved = await save(env, "customer", match.id, next, match.version);
      match.version = saved.version; match.c = next;
      results.push({ business: c.business, id: match.id, action: "updated" });
    } else {
      const id = crypto.randomUUID();
      const customer: Customer & { quickbooksName: string } = { business: row.business, contact: row.contact, email: row.email, phone: row.phone, address: row.address, postcode: row.postcode, deliveryNotes: "", note: "", status: "Active", paymentTerms: "to-agree", quickbooksName: row.quickbooksName };
      const saved = await save(env, "customer", id, customer, 0);
      const entry = { id, data: JSON.stringify(customer), version: saved.version, c: customer };
      byName.set(customerKey(row.business), entry); byQb.set(key, entry);
      results.push({ business: row.business, id, action: "created" });
    }
  }
  const count = (a: string) => results.filter((r) => r.action === a).length;
  await audit(env, "wholesale_import", actor, `${actor} imported QuickBooks customers: ${count("created")} added, ${count("updated")} filled in, ${count("unchanged")} already up to date.`);
  return { created: count("created"), updated: count("updated"), unchanged: count("unchanged"), results };
}

/** Every business's invite and sign-in state, for Admin. */
export async function inviteStates(env: Env) {
  const now = Date.now();
  const invites = (await env.DB.prepare("SELECT customer_id, email, created_at, expires_at, used_at FROM wholesale_invites ORDER BY created_at").all<{ customer_id: string; email: string; created_at: number; expires_at: number; used_at: number | null }>()).results;
  const out: Record<string, { invitedAt: number; email: string; expired: boolean; used: boolean }> = {};
  for (const i of invites) out[i.customer_id] = { invitedAt: i.created_at, email: i.email, expired: !i.used_at && i.expires_at <= now, used: !!i.used_at };
  return out;
}

function inviteEmail(business: string, contact: string, link: string) {
  const hello = contact.split(/\s+/)[0];
  const subject = "Order your Strangers Coffee online";
  const text = [hello ? `Hi ${hello},` : "Hello,", "", `You can now order Strangers Coffee for ${business} online: see the coffee list, place orders, repeat past ones and keep track of deliveries.`, "", `Set up your account (choose a username and password): ${link}`, "", "The link works once and lasts 14 days. If it runs out, just reply and we'll send another.", "", "Strangers Coffee"].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14181f;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 0;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;border:1px solid #e3e6eb;">
<tr><td style="padding:24px 24px 8px;"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5d6675;">Strangers Coffee · Wholesale</div>
<h1 style="margin:6px 0 8px;font-size:22px;line-height:1.25;">Order your coffee online</h1>
<p style="margin:0;font-size:15px;line-height:1.55;">${hello ? `Hi ${esc(hello)}, you` : "You"} can now order Strangers Coffee for <b>${esc(business)}</b> online: see the coffee list, place orders, repeat past ones and keep track of deliveries.</p></td></tr>
<tr><td style="padding:18px 24px 6px;"><a href="${esc(link)}" style="display:inline-block;background:#0062cc;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;">Set up your account</a></td></tr>
<tr><td style="padding:10px 24px 22px;font-size:13px;color:#5d6675;line-height:1.5;">You'll choose your own username and password. The link works once and lasts 14 days; if it runs out, just reply and we'll send another.</td></tr>
</table><div style="font-size:12px;color:#5d6675;padding:12px;">Strangers Coffee · 10 Dove Street, Norwich NR2 1DE.</div></td></tr></table></body></html>`;
  return { subject, html, text };
}

/** Emails one business its invite. Returns "sent", or why not ("account", "no_email", "limit", "off", "failed"). */
export async function inviteCustomer(env: Env, customerId: string, actor: string, signinUrl: string, replyTo: string) {
  const customer = await get<Customer>(env, "customer", customerId);
  if (!customer) throw new ApiError(404, "not_found", "Customer not found.");
  if (await env.DB.prepare("SELECT 1 FROM wholesale_accounts WHERE customer_id = ?").bind(customerId).first()) return "account" as const;
  const email = cleanEmail(customer.email);
  if (!email) return "no_email" as const;
  if (!emailReady(env)) return "off" as const;
  const token = newId(32), now = Date.now(), hash = await digest(token);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM wholesale_invites WHERE customer_id = ? AND used_at IS NULL").bind(customerId),
    env.DB.prepare("INSERT INTO wholesale_invites (hash, customer_id, email, created_at, expires_at, used_at, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?)").bind(hash, customerId, email, now, now + INVITE_MS, actor),
  ]);
  const link = `${signinUrl}${signinUrl.includes("?") ? "&" : "?"}invite=${token}`;
  const result = await send(env, { to: { id: "customer", name: customer.business, email, email_prefs: "{}", active: 1 }, kind: "order", mail: inviteEmail(customer.business, customer.contact || "", link), about: `wholesale invite to ${customer.business}`, from: env.ORDER_EMAIL_FROM || "Strangers Coffee Orders <orders@staffstrangerscoffee.com>", replyTo });
  if (result !== "sent") await env.DB.prepare("DELETE FROM wholesale_invites WHERE hash = ?").bind(hash).run();
  else await audit(env, "wholesale_invite", actor, `${actor} invited ${customer.business} to order online.`);
  return result;
}

async function liveInvite(env: Env, token: unknown) {
  if (typeof token !== "string" || !/^[a-f0-9]{16,128}$/.test(token)) throw new ApiError(404, "invite_invalid", "This invite link isn't valid. Ask Strangers for a new one.");
  const row = await env.DB.prepare("SELECT hash, customer_id, email, expires_at, used_at FROM wholesale_invites WHERE hash = ?").bind(await digest(token)).first<{ hash: string; customer_id: string; email: string; expires_at: number; used_at: number | null }>();
  if (!row) throw new ApiError(404, "invite_invalid", "This invite link isn't valid. Ask Strangers for a new one.");
  if (row.used_at) throw new ApiError(410, "invite_used", "This invite has already been used. Sign in with the username and password you chose.");
  if (row.expires_at <= Date.now()) throw new ApiError(410, "invite_expired", "This invite has run out. Ask Strangers for a new one.");
  const customer = await get<Customer>(env, "customer", row.customer_id);
  if (!customer) throw new ApiError(404, "invite_invalid", "This invite link isn't valid. Ask Strangers for a new one.");
  if (await env.DB.prepare("SELECT 1 FROM wholesale_accounts WHERE customer_id = ?").bind(row.customer_id).first()) throw new ApiError(410, "invite_used", "This business already has a sign-in. Sign in with it, or ask Strangers to reset it.");
  return { row, customer };
}

/** The customer side: what the invite is for (GET), and accepting it with a chosen username and password (POST),
 *  which makes an approved account and returns its session (via `startSession`). */
export async function handleInvite(req: Request, env: Env, startSession: (accountId: string) => Promise<string>) {
  const window = Math.floor(Date.now() / 3600000) * 3600000;
  const attempts = await env.DB.prepare("INSERT INTO rate_limits(ip, window, n) VALUES (?, ?, 1) ON CONFLICT(ip, window) DO UPDATE SET n = n + 1 RETURNING n").bind("wholesale-invite:" + (req.headers.get("cf-connecting-ip") || "local"), window).first<{ n: number }>();
  if ((attempts?.n || 0) > 30) throw new ApiError(429, "rate_limited", "Too many tries. Try again later.");
  if (req.method === "GET") {
    const { customer } = await liveInvite(env, new URL(req.url).searchParams.get("token"));
    return json({ business: customer.business, contact: customer.contact || "" });
  }
  if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Use GET or POST.");
  const body = await readJson<Record<string, unknown>>(req, 4096);
  const { row, customer } = await liveInvite(env, body?.token);
  const username = checkUsername(body?.username), password = checkPassword(body?.password);
  const { hash, salt } = await hashPassword(password);
  const accountId = crypto.randomUUID(), at = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE wholesale_invites SET used_at = ? WHERE hash = ? AND used_at IS NULL").bind(at, row.hash),
      env.DB.prepare("INSERT INTO wholesale_accounts(id, customer_id, username, password_hash, password_salt, must_change, active, approval_status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 0, 1, 'approved', ?, ? WHERE changes() = 1").bind(accountId, row.customer_id, username, hash, salt, at, at),
    ]);
    if (!results[1].meta.changes) throw new ApiError(410, "invite_used", "This invite has already been used. Sign in with the username and password you chose.");
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      await env.DB.prepare("UPDATE wholesale_invites SET used_at = NULL WHERE hash = ? AND used_at = ?").bind(row.hash, at).run();
      throw new ApiError(409, "conflict", "That username is already in use. Choose another.");
    }
    throw error;
  }
  if (customer.status !== "Active") await env.DB.prepare("UPDATE wholesale_preview SET data = json_set(data, '$.status', 'Active'), version = version + 1, updated_at = ? WHERE kind = 'customer' AND id = ?").bind(at, row.customer_id).run();
  await audit(env, "wholesale_invite_accepted", username, `${customer.business} set up their wholesale sign-in (${username}) from an invite.`);
  return json({ ok: true, business: customer.business }, 201, { "set-cookie": await startSession(accountId) });
}

/* Accounts emails from a QuickBooks customer list (Admin → Wholesale → Customers → Accounts emails). Each row's
 * company name must match a business on the site exactly (surrounding spaces aside); nothing is ever added. When the
 * file's email isn't the business's order email, it becomes the business's accounts email. A cell with several
 * addresses gives the one that looks like an accounts address (accounts@, finance@, invoices@…), else the first that
 * isn't the order email; if the order email is in the cell and nothing looks like an accounts address, it's a match.
 * `apply: false` previews; `apply: true` saves each change against the version it was previewed at. */
const VALID = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNTS_LIKE = /^(accounts?|finance|invoices?|invoicing|bills?|billing|payables|purchase-?ledger|ap)[@._-]/i;
type Outcome = { company: string; status: "update" | "replace" | "same" | "already" | "notFound" | "noEmail" | "ambiguous" | "updated" | "changed"; customerId?: string; business?: string; email?: string; current?: string; accountsEmail?: string; version?: number };
export async function matchAccountsEmails(env: Env, value: unknown, actor: string): Promise<{ results: Outcome[]; updated: number }> {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!Array.isArray(body.rows) || body.rows.length > 2000) throw invalid("Send up to 2,000 rows from the customer list.");
  const apply = body.apply === true;
  const versions = apply && body.versions && typeof body.versions === "object" ? body.versions as Record<string, unknown> : {};
  const customers = (await env.DB.prepare("SELECT id, data, version FROM wholesale_preview WHERE kind = 'customer'").all<{ id: string; data: string; version: number }>()).results
    .map((row) => ({ id: row.id, version: row.version, ...(JSON.parse(row.data) as Customer) }));
  const byName = new Map<string, typeof customers>();
  for (const c of customers) { const key = String(c.business || "").trim(); byName.set(key, [...(byName.get(key) || []), c]); }
  const results: Outcome[] = [], done = new Set<string>();
  let updated = 0;
  for (const raw of body.rows) {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const company = typeof row.company === "string" ? row.company.trim().slice(0, 200) : "";
    if (!company) continue;
    const emails = (Array.isArray(row.emails) ? row.emails : []).filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()).filter((e) => VALID.test(e) && e.length <= 150).slice(0, 10);
    const found = byName.get(company) || [];
    if (!found.length) { results.push({ company, status: "notFound" }); continue; }
    if (found.length > 1) { results.push({ company, status: "ambiguous" }); continue; }
    const c = found[0], base = { company, customerId: c.id, business: c.business, email: c.email || "", current: c.accountsEmail || "", version: c.version };
    if (done.has(c.id)) continue;
    done.add(c.id);
    if (!emails.length) { results.push({ ...base, status: "noEmail" }); continue; }
    const order = (c.email || "").trim().toLowerCase(), others = emails.filter((e) => e !== order);
    const pick = others.find((e) => ACCOUNTS_LIKE.test(e)) || (emails.includes(order) ? undefined : others[0]);
    if (!pick) { results.push({ ...base, status: "same" }); continue; }
    if ((c.accountsEmail || "").toLowerCase() === pick) { results.push({ ...base, status: "already", accountsEmail: pick }); continue; }
    const status = c.accountsEmail ? "replace" : "update";
    if (!apply) { results.push({ ...base, status, accountsEmail: pick }); continue; }
    // Applying: only what was previewed, at the version it was previewed at.
    if (versions[c.id] !== c.version) { results.push({ ...base, status: "changed", accountsEmail: pick }); continue; }
    const { id, version, ...data } = c;
    try {
      await save(env, "customer", id, { ...data, accountsEmail: pick }, version);
      results.push({ ...base, status: "updated", accountsEmail: pick });
      updated++;
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") { results.push({ ...base, status: "changed", accountsEmail: pick }); continue; }
      throw error;
    }
  }
  if (updated) await audit(env, "wholesale_accounts_emails", actor, `${actor} set the accounts email on ${updated} wholesale ${updated === 1 ? "business" : "businesses"} from a QuickBooks customer list.`);
  return { results, updated };
}
