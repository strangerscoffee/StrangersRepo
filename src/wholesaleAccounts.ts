// Wholesale identities never become staff identities. Their host-only cookie is accepted only by wholesale routes.
import { checkPassword, checkUsername, hashPassword, newId, tempPassword, type User } from "./auth";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson, safeEqual } from "./http";

export interface Customer {
  business: string; contact: string; email: string; status: "Active" | "On hold"; note: string;
  phone?: string; address?: string; postcode?: string; deliveryNotes?: string;
}
export type CustomerRecord = Customer & { id: string; version: number; updatedAt: number };
export interface WholesaleUser { id: string; accountId: string; customerId: string; username: string; name: string; role: "wholesale" }
export type OrderingUser = User | WholesaleUser;
interface Account {
  id: string; customer_id: string; username: string; password_hash: string; password_salt: string;
  active: number; must_change: number; session_ver: number; failed: number; locked_until: number; version: number;
  approval_status: "pending" | "approved" | "rejected";
}
const COOKIE = "sf_wholesale_session";
const SESSION_MS = 30 * 86400000;
const LOCK_MS = 10 * 60000;
const WINDOW_MS = 15 * 60000;
const tokenFrom = (req: Request) => /(?:^|;\s*)sf_wholesale_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get("cookie") || "")?.[1];
const digest = async (token: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const cookie = (token: string, age: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const unauthenticated = () => new ApiError(401, "unauthenticated", "Check your wholesale username and password.");
const conflict = () => new ApiError(409, "conflict", "This account changed. Reload before saving.");

export async function wholesaleCustomer(env: Env, id: string): Promise<CustomerRecord | null> {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_preview WHERE kind = 'customer' AND id = ?").bind(id).first<{ data: string; version: number; updated_at: number }>();
  return row ? { ...JSON.parse(row.data), id, version: row.version, updatedAt: row.updated_at } : null;
}
export function publicCustomer(row: CustomerRecord) {
  return { id: row.id, version: row.version, updatedAt: row.updatedAt, business: row.business, contact: row.contact, email: row.email, phone: row.phone || "", address: row.address || "", postcode: row.postcode || "", deliveryNotes: row.deliveryNotes || "", status: row.status };
}
export async function wholesaleSession(req: Request, env: Env): Promise<WholesaleUser | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT a.id, a.customer_id, a.username, c.data FROM wholesale_sessions s JOIN wholesale_accounts a ON a.id = s.account_id JOIN wholesale_preview c ON c.kind = 'customer' AND c.id = a.customer_id WHERE s.hash = ? AND s.expires_at > ? AND s.session_ver = a.session_ver AND a.active = 1 AND a.must_change = 0 AND a.approval_status = 'approved'")
    .bind(await digest(token), Date.now()).first<{ id: string; customer_id: string; username: string; data: string }>();
  if (!row) return null;
  const customer: Customer = JSON.parse(row.data);
  return { id: "wholesale:" + row.id, accountId: row.id, customerId: row.customer_id, username: row.username, name: customer.contact || customer.business, role: "wholesale" };
}
async function newSession(env: Env, account: Account): Promise<string> {
  const token = newId(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM wholesale_sessions WHERE expires_at <= ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO wholesale_sessions(hash, account_id, session_ver, expires_at) VALUES (?, ?, ?, ?)").bind(await digest(token), account.id, account.session_ver, Date.now() + SESSION_MS),
  ]);
  return cookie(token, SESSION_MS / 1000);
}
async function credentials(req: Request, env: Env, body: any): Promise<Account> {
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const window = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const attempts = await env.DB.prepare("INSERT INTO rate_limits(ip, window, n) VALUES (?, ?, 1) ON CONFLICT(ip, window) DO UPDATE SET n = n + 1 RETURNING n").bind("wholesale-login:" + ip, window).first<{ n: number }>();
  if ((attempts?.n || 0) > 30) throw new ApiError(429, "rate_limited", "Too many sign-in attempts. Try again in 15 minutes.");
  const username = checkUsername(body?.username);
  const password = checkPassword(body?.password);
  const account = await env.DB.prepare("SELECT * FROM wholesale_accounts WHERE username = ?").bind(username).first<Account>();
  if (!account || (!account.active && account.approval_status === "approved")) throw unauthenticated();
  const now = Date.now();
  await env.DB.prepare("UPDATE wholesale_accounts SET failed = 0, locked_until = 0 WHERE id = ? AND locked_until > 0 AND locked_until <= ?").bind(account.id, now).run();
  const reserved = await env.DB.prepare("UPDATE wholesale_accounts SET failed = failed + 1 WHERE id = ? AND (active = 1 OR approval_status <> 'approved') AND locked_until <= ? AND failed < 5 RETURNING failed").bind(account.id, now).first<{ failed: number }>();
  if (!reserved) throw new ApiError(423, "locked", "This wholesale account is locked. Try again in 10 minutes or ask Strangers to reset your password.");
  const rounds = Number(/^p(\d+):/.exec(account.password_hash)?.[1]) || 10000;
  const { hash } = await hashPassword(password, account.password_salt, rounds);
  if (!await safeEqual(hash, account.password_hash)) {
    if (reserved.failed >= 5) await env.DB.prepare("UPDATE wholesale_accounts SET locked_until = ? WHERE id = ?").bind(now + LOCK_MS, account.id).run();
    throw unauthenticated();
  }
  // Do not reset attempts belonging to a newly reset/disabled account.
  await env.DB.prepare("UPDATE wholesale_accounts SET failed = 0, locked_until = 0 WHERE id = ? AND session_ver = ?").bind(account.id, account.session_ver).run();
  if (account.approval_status !== "approved") throw new ApiError(403, account.approval_status === "pending" ? "approval_pending" : "approval_rejected", account.approval_status === "pending" ? "Your account is awaiting review by Strangers. You can sign in once it has been approved." : "Your account has not been approved. Contact the Strangers team.");
  return account;
}

async function register(req: Request, env: Env): Promise<Response> {
  const window = Math.floor(Date.now() / 3600000) * 3600000;
  const attempts = await env.DB.prepare("INSERT INTO rate_limits(ip, window, n) VALUES (?, ?, 1) ON CONFLICT(ip, window) DO UPDATE SET n = n + 1 RETURNING n").bind("wholesale-register:" + (req.headers.get("cf-connecting-ip") || "local"), window).first<{ n: number }>();
  if ((attempts?.n || 0) > 5) throw new ApiError(429, "rate_limited", "Too many registration requests. Try again later.");
  const body = await readJson(req, 4096);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send a JSON object.");
  const username = checkUsername(body?.username);
  const clean = (key: string, max: number, required = false) => {
    const value = body?.[key];
    if ((value !== undefined && typeof value !== "string") || (required && !value?.trim()) || (value?.trim().length || 0) > max) throw invalid(`Check ${key}.`);
    return (value || "").trim();
  };
  const email = clean("email", 150, true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("Check your email address.");
  const customer: Customer = { business: clean("business", 120, true), contact: clean("contact", 120, true), email, phone: clean("phone", 40), address: "", postcode: "", deliveryNotes: "", note: "", status: "On hold" };
  const { hash, salt } = await hashPassword(checkPassword(body.password));
  const customerId = crypto.randomUUID(), at = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO wholesale_preview(kind, id, data, version, updated_at) VALUES ('customer', ?, ?, 1, ?)").bind(customerId, JSON.stringify(customer), at),
      env.DB.prepare("INSERT INTO wholesale_accounts(id, customer_id, username, password_hash, password_salt, must_change, active, approval_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?)").bind(crypto.randomUUID(), customerId, username, hash, salt, at, at),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new ApiError(409, "conflict", "That wholesale username is already in use. Choose another or contact Strangers.");
    throw error;
  }
  await audit(env, "wholesale_registration", username, `${customer.business} requested a wholesale account. Admin approval is required.`);
  return json({ registered: true, approvalStatus: "pending" }, 201);
}

export async function handleWholesaleAuth(req: Request, env: Env, route: string): Promise<Response> {
  if (route === "register" && req.method === "POST") return register(req, env);
  if (route === "me" && req.method === "GET") return json({ user: await wholesaleSession(req, env) });
  if (route === "logout" && req.method === "POST") {
    const token = tokenFrom(req);
    if (token) await env.DB.prepare("DELETE FROM wholesale_sessions WHERE hash = ?").bind(await digest(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  }
  if ((route === "login" || route === "change-password") && req.method === "POST") {
    const body = await readJson(req, 4096);
    let account = await credentials(req, env, body);
    if (route === "login" && account.must_change) throw new ApiError(403, "password_change_required", "Choose your own password to finish signing in.");
    if (route === "change-password") {
      const password = checkPassword(body.newPassword);
      if (password === body.password) throw invalid("Choose a different password.");
      const { hash, salt } = await hashPassword(password);
      const result = await env.DB.prepare("UPDATE wholesale_accounts SET password_hash = ?, password_salt = ?, must_change = 0, session_ver = session_ver + 1, version = version + 1, updated_at = ? WHERE id = ? AND session_ver = ? AND active = 1 RETURNING *")
        .bind(hash, salt, Date.now(), account.id, account.session_ver).first<Account>();
      if (!result) throw conflict();
      account = result;
      await env.DB.prepare("DELETE FROM wholesale_sessions WHERE account_id = ? AND session_ver < ?").bind(account.id, account.session_ver).run();
    }
    await env.DB.prepare("UPDATE wholesale_accounts SET last_login_at = ? WHERE id = ?").bind(Date.now(), account.id).run();
    await audit(env, "wholesale_signin", account.username, `Wholesale account ${account.username} signed in.`);
    return json({ ok: true }, 200, { "set-cookie": await newSession(env, account) });
  }
  throw new ApiError(404, "not_found", "Unknown wholesale sign-in route.");
}

export async function wholesaleAccounts(env: Env) {
  const result = await env.DB.prepare("SELECT id, customer_id AS customerId, username, active, approval_status AS approvalStatus, must_change AS mustChange, version, last_login_at AS lastLoginAt FROM wholesale_accounts ORDER BY username").all<{ id: string; customerId: string; username: string; active: number; approvalStatus: string; mustChange: number; version: number; lastLoginAt: number | null }>();
  return result.results.map((row) => ({ ...row, active: !!row.active, mustChange: !!row.mustChange }));
}
export async function manageWholesaleAccount(req: Request, env: Env, customerId: string, reset: boolean, by: string): Promise<Response> {
  if (!await wholesaleCustomer(env, customerId)) throw new ApiError(404, "not_found", "Customer not found.");
  const body = await readJson(req, 4096);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send a JSON object.");
  const existing = await env.DB.prepare("SELECT * FROM wholesale_accounts WHERE customer_id = ?").bind(customerId).first<Account>();
  const creating = req.method === "POST" && !reset;
  if (creating && existing) throw new ApiError(409, "conflict", "This customer already has a sign-in.");
  if (!creating && !existing) throw new ApiError(404, "not_found", "Wholesale sign-in not found.");
  if (!creating && (!Number.isSafeInteger(body.ifVersion) || body.ifVersion !== existing!.version)) throw conflict();
  const password = creating || reset ? checkPassword(body.password || tempPassword()) : null;
  const username = creating || !reset ? checkUsername(body.username) : existing!.username;
  const approval = creating ? "approved" : body.approvalStatus ?? existing!.approval_status;
  if (!["pending", "approved", "rejected"].includes(approval)) throw invalid("Choose Pending, Approved or Declined.");
  if (!creating && !reset && typeof body.active !== "boolean") throw invalid("Choose whether this sign-in is active.");
  const at = Date.now();
  try {
    if (creating) {
      const { hash, salt } = await hashPassword(password!);
      await env.DB.prepare("INSERT INTO wholesale_accounts(id, customer_id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), customerId, username, hash, salt, at, at).run();
    } else if (reset) {
      const { hash, salt } = await hashPassword(password!);
      const result = await env.DB.prepare("UPDATE wholesale_accounts SET password_hash = ?, password_salt = ?, must_change = 1, session_ver = session_ver + 1, failed = 0, locked_until = 0, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(hash, salt, at, existing!.id, body.ifVersion).run();
      if (!result.meta.changes) throw conflict();
    } else {
      const result = await env.DB.prepare("UPDATE wholesale_accounts SET username = ?, active = ?, approval_status = ?, session_ver = session_ver + 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(username, body.active && approval === "approved" ? 1 : 0, approval, at, existing!.id, body.ifVersion).run();
      if (!result.meta.changes) throw conflict();
      if (approval === "approved" && existing!.approval_status === "pending") await env.DB.prepare("UPDATE wholesale_preview SET data = json_set(data, '$.status', 'Active'), version = version + 1, updated_at = ? WHERE kind = 'customer' AND id = ?").bind(at, customerId).run();
    }
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new ApiError(409, "conflict", "That wholesale username or customer sign-in is already in use.");
    throw error;
  }
  if (existing) await env.DB.prepare("DELETE FROM wholesale_sessions WHERE account_id = ? AND session_ver <= ?").bind(existing.id, existing.session_ver).run();
  await audit(env, "wholesale_account", by, `${by} ${creating ? "created" : reset ? "reset the password for" : "updated"} wholesale sign-in ${username}.`);
  return json({ account: (await wholesaleAccounts(env)).find((row) => row.customerId === customerId), ...(password ? { temporaryPassword: password } : {}) }, creating ? 201 : 200);
}
