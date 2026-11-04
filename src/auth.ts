// Accounts: sign in with username + password, signed session cookies, first-admin setup and recovery.
import { ApiError, Env, SQL_NOW_MS, invalid, json, readJson, safeEqual } from "./http";

export type Role = "admin" | "manager" | "staff";
export const ROLES: Role[] = ["admin", "manager", "staff"];

export interface User {
  id: string;
  name: string; // shown on records
  role: Role;
}

export interface UserRow extends User {
  name_key: string;
  username: string;
  pin_hash: string; // password hash; the column names date from PINs
  pin_salt: string;
  must_change: number;
  active: number;
  session_ver: number;
  failed: number;
  locked_until: number;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  last_login_at: number | null;
  quick_hash: string | null; // quick-switch PIN (see "quick switching" below)
  quick_salt: string | null;
}

const COOKIE = "sfbb_session";
const DEVICE_COOKIE = "sfbb_device"; // marks a device someone has signed in on with a password
const DEVICE_MS = 180 * 24 * 3600 * 1000;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 5; // wrong passwords in a row before the account locks
const LOCK_MS = 10 * 60 * 1000;
const IP_FAILS = 30; // failed sign-ins per IP per 15 minutes
const WINDOW_MS = 15 * 60 * 1000;
// PBKDF2 rounds for new hashes. Each hash records its own rounds, so this can be raised later without
// breaking existing passwords. Kept within the Workers CPU budget for a sign-in request.
const ROUNDS = 10000;

/* ---------- helpers ---------- */

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function newId(bytes = 12): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A display name as shown on records, e.g. "Sam Patel". */
export function cleanName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const name = s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return name && name.length <= 60 ? name : null;
}

export const nameKey = (name: string) => name.toLowerCase();

/** Usernames: 3-32 characters, lower-case letters, digits, dots, dashes and underscores. */
export function checkUsername(u: unknown): string {
  const v = typeof u === "string" ? u.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(v)) {
    throw invalid("Usernames are 3 to 32 characters: letters, numbers, dots, dashes or underscores.");
  }
  return v;
}

/** A suggested username from a name: "Sam O'Brien" -> "sam.obrien". */
export function usernameFrom(name: string): string {
  const u = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 .-]/g, "").trim().replace(/\s+/g, ".");
  return (u.length >= 3 ? u : (u + "user").slice(0, 8)).slice(0, 32);
}

export function checkPassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < 8) throw invalid("Passwords need at least 8 characters.");
  if (pw.length > 128) throw invalid("Passwords can be up to 128 characters.");
  return pw;
}

/** A temporary password that's easy to read out and type: e.g. "k7mp-2rqx-h9tw". */
export function tempPassword(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => abc[x % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export async function hashPassword(pw: string, salt = newId(16), rounds = ROUNDS): Promise<{ hash: string; salt: string }> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: rounds }, key, 256);
  return { hash: `p${rounds}:${hex(bits)}`, salt };
}

async function passwordMatches(pw: string, row: { pin_hash: string; pin_salt: string }): Promise<boolean> {
  const rounds = Number(/^p(\d+):/.exec(row.pin_hash)?.[1]) || ROUNDS;
  const { hash } = await hashPassword(pw, row.pin_salt, rounds);
  return safeEqual(hash, row.pin_hash);
}

/* ---------- sessions ---------- */

let keyPromise: Promise<CryptoKey> | null = null;

/** HMAC key for session cookies, generated on first use and kept in the secrets table. */
function sessionKey(env: Env): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      await env.DB.prepare("INSERT OR IGNORE INTO secrets (k, v) VALUES ('session_key', ?)").bind(newId(32)).run();
      const row = await env.DB.prepare("SELECT v FROM secrets WHERE k = 'session_key'").first<{ v: string }>();
      return crypto.subtle.importKey("raw", enc.encode(row!.v), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })().catch((e) => {
      keyPromise = null;
      throw e;
    });
  }
  return keyPromise;
}

/* Cookies are shared across COOKIE_DOMAIN (wrangler.jsonc: staffstrangerscoffee.com), so one sign-in covers the
 * diary and the rota (rota.staffstrangerscoffee.com). On any other host (local dev, previews) they stay host-only. */
function cookieDomain(req: Request, env: Env): string {
  const d = (env.COOKIE_DOMAIN || "").trim().toLowerCase().replace(/^\./, "");
  const h = new URL(req.url).hostname.toLowerCase();
  return d && (h === d || h.endsWith("." + d)) ? d : "";
}

/** Set-Cookie headers for one cookie. With a shared domain, the older host-only copy (from before cookies were
 * shared) is removed first, so it can't shadow the shared one; the order matters, as browsers apply them in turn. */
function cookieHeaders(req: Request, env: Env, name: string, value: string, maxAgeSec: number): [string, string][] {
  const attrs = (domain: string, age: number) => `; Path=/${domain ? "; Domain=" + domain : ""}; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  const domain = cookieDomain(req, env);
  const out: [string, string][] = [];
  if (domain) out.push(["set-cookie", `${name}=${attrs("", 0)}`]);
  out.push(["set-cookie", `${name}=${value}${attrs(domain, maxAgeSec)}`]);
  return out;
}

/** Every signed value a cookie of this name carries, newest first. A request can carry both a host-only copy from
 * before cookies were shared and a shared one (say the diary and the rota were signed in as different people on a
 * shared iPad); browsers list same-path cookies oldest first, so the shared one, set since, is last and wins. */
function cookieValues(req: Request, name: string): { payload: string; sig: string }[] {
  const re = new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)`, "g");
  return [...(req.headers.get("cookie") || "").matchAll(re)].map((m) => ({ payload: m[1], sig: m[2] })).reverse();
}

/** A cookie's newest value with a good signature and expiry: its raw value, parsed payload and time left. */
async function verifiedCookie(req: Request, env: Env, name: string, prefix: string): Promise<{ value: string; data: any; leftSec: number } | null> {
  for (const { payload, sig } of cookieValues(req, name)) {
    try {
      if (!(await crypto.subtle.verify("HMAC", await sessionKey(env), unb64url(sig), enc.encode(prefix + payload)))) continue;
      const data = JSON.parse(new TextDecoder().decode(unb64url(payload)));
      if (typeof data.e !== "number" || data.e <= Date.now()) continue;
      return { value: `${payload}.${sig}`, data, leftSec: Math.floor((data.e - Date.now()) / 1000) };
    } catch {}
  }
  return null;
}

async function sessionCookie(req: Request, env: Env, user: { id: string; session_ver: number }): Promise<[string, string][]> {
  const payload = b64url(enc.encode(JSON.stringify({ u: user.id, v: user.session_ver, e: Date.now() + SESSION_MS })));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload))));
  return cookieHeaders(req, env, COOKIE, `${payload}.${sig}`, SESSION_MS / 1000);
}

/** Signing out ends the session on the diary and the rota alike: the shared cookie and any host-only one. */
function clearSession(req: Request, env: Env): [string, string][] {
  const domain = cookieDomain(req, env);
  const out = cookieHeaders(req, env, COOKIE, "", 0);
  return domain ? out : out.slice(-1);
}

/** A device someone has signed in on with a username and password. Quick switching (a 4-digit PIN) only
 * works on such a device, so a PIN alone can't sign anyone in from elsewhere. */
async function deviceCookie(req: Request, env: Env): Promise<[string, string][]> {
  const payload = b64url(enc.encode(JSON.stringify({ d: newId(8), e: Date.now() + DEVICE_MS })));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode("device." + payload))));
  return cookieHeaders(req, env, DEVICE_COOKIE, `${payload}.${sig}`, DEVICE_MS / 1000);
}

export async function trustedDevice(req: Request, env: Env): Promise<boolean> {
  return !!(await verifiedCookie(req, env, DEVICE_COOKIE, "device."));
}

/** Response headers for a password sign-in: the session, and this device marked as trusted. */
async function signedIn(req: Request, env: Env, user: { id: string; session_ver: number }): Promise<[string, string][]> {
  return [...(await sessionCookie(req, env, user)), ...(await deviceCookie(req, env))];
}

/** Sessions and trusted devices from before cookies were shared are host-only: moves them to the shared domain,
 * unchanged (same value and expiry), so someone signed in on the diary is signed in on the rota too. */
async function shareCookies(req: Request, env: Env): Promise<[string, string][]> {
  if (!cookieDomain(req, env)) return [];
  const out: [string, string][] = [];
  const session = await currentSession(req, env);
  if (session) out.push(...cookieHeaders(req, env, COOKIE, session.value, session.leftSec));
  const device = await verifiedCookie(req, env, DEVICE_COOKIE, "device.");
  if (device) out.push(...cookieHeaders(req, env, DEVICE_COOKIE, device.value, device.leftSec));
  return out;
}

/** The signed-in person, or null. Checks the signature, expiry, and that the account is still active and
 * hasn't been signed out everywhere since (session_ver). */
export async function sessionUser(req: Request, env: Env): Promise<User | null> {
  return (await currentSession(req, env))?.user ?? null;
}

/** The session cookie that signs this request in, with its raw value and time left. */
async function currentSession(req: Request, env: Env): Promise<{ user: User; value: string; leftSec: number } | null> {
  for (const { payload, sig } of cookieValues(req, COOKIE)) {
    try {
      if (!(await crypto.subtle.verify("HMAC", await sessionKey(env), unb64url(sig), enc.encode(payload)))) continue;
      const s = JSON.parse(new TextDecoder().decode(unb64url(payload)));
      if (typeof s.e !== "number" || s.e < Date.now()) continue;
      const row = await env.DB.prepare("SELECT id, name, role, active, session_ver FROM users WHERE id = ?")
        .bind(s.u).first<{ id: string; name: string; role: Role; active: number; session_ver: number }>();
      if (!row || !row.active || row.session_ver !== s.v) continue;
      return { user: { id: row.id, name: row.name, role: row.role }, value: `${payload}.${sig}`, leftSec: Math.floor((s.e - Date.now()) / 1000) };
    } catch {}
  }
  return null;
}

/* ---------- sign-in rate limits ---------- */

async function ipFailures(env: Env, ip: string): Promise<number> {
  const window = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const row = await env.DB.prepare("SELECT n FROM rate_limits WHERE ip = ? AND window = ?").bind("login:" + ip, window).first<{ n: number }>();
  return row?.n ?? 0;
}

async function recordIpFailure(env: Env, ip: string): Promise<void> {
  const window = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  await env.DB.prepare("INSERT INTO rate_limits (ip, window, n) VALUES (?, ?, 1) ON CONFLICT (ip, window) DO UPDATE SET n = n + 1")
    .bind("login:" + ip, window).run();
}

/** Why setup can't start, naming the text settings the Worker can see (names only, never values) so a
 * secret saved under a slightly different name, or in the wrong place, is easy to spot. Only reachable
 * before the first admin exists. */
function missingTokenMessage(env: Env): string {
  const seen = Object.entries(env as unknown as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string")
    .map(([k]) => JSON.stringify(k));
  return "The site can't see a SETUP_CODE secret, so there's no setup code yet. Add it in Cloudflare under " +
    "Workers & Pages → strangers-kitchen-diary → Settings → Variables and Secrets (not the Build section). " +
    `Settings the site can see: ${seen.length ? seen.join(", ") : "none"}.`;
}

/* ---------- routes: /api/auth/* ---------- */

const publicUser = (u: UserRow | User) => ({
  id: u.id, name: u.name, role: u.role, recordId: "web:" + u.name, ...("username" in u ? { username: u.username } : {}),
});

async function userCount(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;
}

/** The setup code: the SETUP_CODE secret (SYNC_TOKEN, its older name, still works). */
const setupCode = (env: Env) => env.SETUP_CODE || env.SYNC_TOKEN || "";

async function checkSetupCode(env: Env, ip: string, code: unknown): Promise<void> {
  if (!setupCode(env)) throw new ApiError(503, "no_setup_code", missingTokenMessage(env));
  if ((await ipFailures(env, ip)) >= IP_FAILS) throw new ApiError(429, "rate_limited", "Too many attempts. Wait 15 minutes.");
  if (typeof code !== "string" || !(await safeEqual(code.trim(), setupCode(env)))) {
    await recordIpFailure(env, ip);
    throw new ApiError(403, "wrong_setup_code", "That setup code isn't right. It's the secret saved in Cloudflare.");
  }
}

/** Checks a username and password, counting failures per account and per IP. Returns the account. */
async function verifyLogin(env: Env, ip: string, username: unknown, password: unknown): Promise<UserRow> {
  if ((await ipFailures(env, ip)) >= IP_FAILS) {
    throw new ApiError(429, "rate_limited", "Too many wrong attempts from this connection. Wait 15 minutes.");
  }
  const u = typeof username === "string" ? username.trim().toLowerCase() : "";
  const pw = typeof password === "string" ? password : "";
  const row = u ? await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(u).first<UserRow>() : null;
  const wrong = new ApiError(401, "wrong_password", "That username and password don't match. Check both and try again.");
  if (!row || !row.active) {
    await hashPassword(pw || "x"); // same work as a real check, so timing doesn't reveal which usernames exist
    await recordIpFailure(env, ip);
    throw wrong;
  }
  const now = Date.now();
  if (row.locked_until > now) {
    const mins = Math.ceil((row.locked_until - now) / 60000);
    throw new ApiError(423, "locked", `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or ask an admin to reset your password.`);
  }
  if (!(await passwordMatches(pw, row))) {
    const failed = row.failed + 1;
    const lock = failed >= MAX_FAILS;
    await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?")
      .bind(lock ? 0 : failed, lock ? now + LOCK_MS : row.locked_until, row.id).run();
    await recordIpFailure(env, ip);
    if (lock) throw new ApiError(423, "locked", "Too many wrong passwords. Try again in 10 minutes, or ask an admin to reset your password.");
    const left = MAX_FAILS - failed;
    throw new ApiError(401, "wrong_password", `That username and password don't match. ${left} ${left === 1 ? "try" : "tries"} left before a 10-minute lock.`);
  }
  return row;
}

export async function handleAuth(req: Request, env: Env, route: string, current: User | null): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") || "local";

  if (route === "me" && req.method === "GET") {
    const quick = current ? await env.DB.prepare("SELECT quick_hash IS NOT NULL AS has FROM users WHERE id = ?").bind(current.id).first<{ has: number }>() : null;
    return json({
      user: current ? { ...publicUser(current), quickPin: !!quick?.has } : null,
      setupNeeded: (await userCount(env)) === 0,
      quickSwitch: await trustedDevice(req, env), // this device can switch person with a quick PIN
    }, 200, await shareCookies(req, env));
  }

  if (route === "logout" && req.method === "POST") {
    return json({ ok: true }, 200, clearSession(req, env));
  }

  // First admin. Guarded by the setup code, which only the host has.
  if (route === "setup" && req.method === "POST") {
    const body = await readJson<any>(req, 4096);
    if ((await userCount(env)) > 0) throw new ApiError(409, "already_set_up", "An admin already exists. Sign in instead.");
    await checkSetupCode(env, ip, body.code);
    const name = cleanName(body.name);
    if (!name) throw invalid("Enter your name (up to 60 characters).");
    const username = checkUsername(body.username);
    const { hash, salt } = await hashPassword(checkPassword(body.password));
    const id = newId();
    const res = await env.DB.prepare(
      `INSERT INTO users (id, name, name_key, username, role, pin_hash, pin_salt, created_at, created_by, updated_at, last_login_at)
       SELECT ?, ?, ?, ?, 'admin', ?, ?, ${SQL_NOW_MS}, 'setup', ${SQL_NOW_MS}, ${SQL_NOW_MS} WHERE NOT EXISTS (SELECT 1 FROM users)`,
    ).bind(id, name, nameKey(name), username, hash, salt).run();
    if (!res.meta.changes) throw new ApiError(409, "already_set_up", "An admin already exists. Sign in instead.");
    return json({ user: publicUser({ id, name, role: "admin" }) }, 200, await signedIn(req, env, { id, session_ver: 1 }));
  }

  // An admin who has forgotten their password sets a new one with the setup code.
  if (route === "recover" && req.method === "POST") {
    const body = await readJson<any>(req, 4096);
    await checkSetupCode(env, ip, body.code);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const row = username
      ? await env.DB.prepare("SELECT * FROM users WHERE username = ? AND role = 'admin' AND active = 1").bind(username).first<UserRow>()
      : null;
    if (!row) throw new ApiError(404, "not_admin", "There's no active admin with that username.");
    const { hash, salt } = await hashPassword(checkPassword(body.password));
    await env.DB.prepare(
      `UPDATE users SET pin_hash = ?, pin_salt = ?, must_change = 0, failed = 0, locked_until = 0, session_ver = session_ver + 1,
         updated_at = ${SQL_NOW_MS}, last_login_at = ${SQL_NOW_MS} WHERE id = ?`,
    ).bind(hash, salt, row.id).run();
    return json({ user: publicUser(row) }, 200, await signedIn(req, env, { id: row.id, session_ver: row.session_ver + 1 }));
  }

  // Sign in. A temporary password (set by an admin, or carried over from a PIN) signs nobody in: the
  // page then asks for a new password and calls /change.
  if (route === "login" && req.method === "POST") {
    const body = await readJson<any>(req, 4096);
    const row = await verifyLogin(env, ip, body.username, body.password);
    if (row.must_change) {
      await env.DB.prepare("UPDATE users SET failed = 0 WHERE id = ?").bind(row.id).run();
      return json({ mustChange: true, name: row.name });
    }
    await env.DB.prepare(`UPDATE users SET failed = 0, locked_until = 0, last_login_at = ${SQL_NOW_MS} WHERE id = ?`).bind(row.id).run();
    return json({ user: publicUser(row) }, 200, await signedIn(req, env, row));
  }

  // Change password (needs the current one). Ends the person's other sessions and signs them in here.
  if (route === "change" && req.method === "POST") {
    const body = await readJson<any>(req, 4096);
    const row = await verifyLogin(env, ip, body.username, body.password);
    const next = checkPassword(body.newPassword);
    if (next === body.password) throw invalid("Choose a password different from the current one.");
    const { hash, salt } = await hashPassword(next);
    await env.DB.prepare(
      `UPDATE users SET pin_hash = ?, pin_salt = ?, must_change = 0, failed = 0, locked_until = 0, session_ver = session_ver + 1,
         updated_at = ${SQL_NOW_MS}, last_login_at = ${SQL_NOW_MS} WHERE id = ?`,
    ).bind(hash, salt, row.id).run();
    return json({ user: publicUser(row) }, 200, await signedIn(req, env, { id: row.id, session_ver: row.session_ver + 1 }));
  }

  /* ---------- quick switching ----------
   * On a shared device where someone has signed in with a password, staff and managers can switch to
   * themselves with a 4-digit PIN. Admins always use their password. Wrong PINs count towards the same
   * 5-tries lock as passwords, and per-IP limits apply. */

  // Set or remove your own quick PIN: {pin: "1234"} or {pin: null}.
  if (route === "pin" && req.method === "POST") {
    if (!current) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    if (current.role === "admin") throw new ApiError(403, "permission_denied", "Admins sign in with their password, so they don't have a quick PIN.");
    const body = await readJson<any>(req, 1024);
    if (body.pin === null) {
      await env.DB.prepare(`UPDATE users SET quick_hash = NULL, quick_salt = NULL, updated_at = ${SQL_NOW_MS} WHERE id = ?`).bind(current.id).run();
      return json({ ok: true });
    }
    if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) throw invalid("A quick PIN is 4 digits.");
    if (/^(\d)\1{3}$|^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)$/.test(body.pin)) {
      throw invalid("Choose a PIN that's harder to guess than repeated or running digits.");
    }
    const { hash, salt } = await hashPassword(body.pin);
    await env.DB.prepare(`UPDATE users SET quick_hash = ?, quick_salt = ?, updated_at = ${SQL_NOW_MS} WHERE id = ?`).bind(hash, salt, current.id).run();
    return json({ ok: true });
  }

  // Everyone with an active account: names and roles only (never usernames), so the page can assign maintenance
  // jobs to people and add new accounts to Staff training. Any signed-in person may read it.
  if (route === "team" && req.method === "GET") {
    if (!current) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    const { results } = await env.DB.prepare("SELECT name, role FROM users WHERE active = 1 ORDER BY name_key").all<{ name: string; role: string }>();
    return json({ team: results.map((r) => ({ id: "web:" + r.name, name: r.name, role: r.role })) });
  }

  // Who can switch in on this device: names only, for the "Switch person" list.
  if (route === "people" && req.method === "GET") {
    if (!(await trustedDevice(req, env))) return json({ people: [] });
    const { results } = await env.DB.prepare(
      "SELECT id, name FROM users WHERE active = 1 AND role != 'admin' AND quick_hash IS NOT NULL AND must_change = 0 ORDER BY name_key",
    ).all<{ id: string; name: string }>();
    return json({ people: results });
  }

  // Switch to someone with their quick PIN: {id, pin}.
  if (route === "switch" && req.method === "POST") {
    if (!(await trustedDevice(req, env))) {
      throw new ApiError(403, "untrusted_device", "Quick switching only works on a device someone has signed in on with a password.");
    }
    if ((await ipFailures(env, ip)) >= IP_FAILS) throw new ApiError(429, "rate_limited", "Too many wrong attempts from this connection. Wait 15 minutes.");
    const body = await readJson<any>(req, 1024);
    const row = typeof body.id === "string" ? await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(body.id).first<UserRow>() : null;
    if (!row || !row.active || row.role === "admin" || !row.quick_hash || row.must_change) {
      throw new ApiError(404, "not_found", "That person can't switch in with a PIN. Sign in with a password instead.");
    }
    const now = Date.now();
    if (row.locked_until > now) {
      const mins = Math.ceil((row.locked_until - now) / 60000);
      throw new ApiError(423, "locked", `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or sign in with a password.`);
    }
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!(await passwordMatches(pin, { pin_hash: row.quick_hash, pin_salt: row.quick_salt || "" }))) {
      const failed = row.failed + 1, lock = failed >= MAX_FAILS;
      await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failed, lock ? now + LOCK_MS : row.locked_until, row.id).run();
      await recordIpFailure(env, ip);
      if (lock) throw new ApiError(423, "locked", "Too many wrong tries. Try again in 10 minutes, or sign in with a password.");
      const left = MAX_FAILS - failed;
      throw new ApiError(401, "wrong_pin", `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`);
    }
    await env.DB.prepare(`UPDATE users SET failed = 0, locked_until = 0, last_login_at = ${SQL_NOW_MS} WHERE id = ?`).bind(row.id).run();
    return json({ user: publicUser(row) }, 200, await sessionCookie(req, env, row));
  }

  throw new ApiError(404, "not_found", "Unknown route.");
}
