import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { COSEALG, decodeAttestationObject, decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import { audit } from "./audit";
import { cleanName, completePasskeySignIn, newId, reauthenticateStaffPassword, type StaffSession, type UserRow } from "./auth";
import { ApiError, invalid, json, readJson, SQL_NOW_MS, type Env } from "./http";

const ROOT = "/api/auth/passkeys";
const CHALLENGE_MS = 5 * 60_000;
const CLIENT_TIMEOUT_MS = 120_000;
const MAX_PASSKEYS = 20;
const FLOW_COOKIE = "__Host-staff-passkey-";
const ALGORITHMS = [COSEALG.ES256, COSEALG.RS256];
const ELIGIBLE = "active = 1 AND must_change = 0 AND role IN ('admin','manager','staff')";
const SESSION_ELIGIBLE = `${ELIGIBLE} AND session_ver = ? AND role = ? AND ? > ${SQL_NOW_MS}
  AND NOT EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = ?)`;
const idPattern = /^[a-f0-9]{32}$/;
const credentialPattern = /^[A-Za-z0-9_-]{1,1364}$/;
const expectedJson = (req: Request) => req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

interface RelyingParty { origin: string; rpId: string }
interface Challenge {
  challenge: string;
  name: string | null;
  expires_at: number;
}
interface Passkey {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  device_type: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}
type SignInUser = Pick<UserRow, "id" | "name" | "role" | "username" | "session_ver">;
type ListedPasskey = Pick<Passkey, "id" | "name" | "created_at" | "last_used_at">;

function relyingParty(url: URL, env: Env): RelyingParty | null {
  const host = url.hostname;
  const rpId = (env.COOKIE_DOMAIN || "").trim().toLowerCase().replace(/^\./, "");
  const [preview, retail] = [env.PREVIEW_HOST, env.LEGACY_PREVIEW_HOST]
    .map(value => value?.trim().toLowerCase());
  if (host === preview || host === retail) return null;
  if (env.STAFF_PASSKEYS_LOCAL === "1" && host === "localhost" && (url.protocol === "http:" || url.protocol === "https:")) {
    return { origin: url.origin, rpId: "localhost" };
  }
  if (rpId.includes(".") && host === rpId && url.protocol === "https:" && !url.port) {
    return { origin: url.origin, rpId };
  }
  return null;
}

export function passkeysAvailable(url: URL, env: Env): boolean {
  return relyingParty(url, env) !== null;
}

function publicPasskey(key: ListedPasskey) {
  return { id: key.id, name: key.name, createdAt: key.created_at, lastUsedAt: key.last_used_at };
}

function expired() {
  return new ApiError(400, "passkey_expired", "This passkey request has expired. Please try again.");
}

function rejected() {
  return new ApiError(401, "passkey_rejected", "Could not sign in with that passkey. Try again or use your password.");
}

function unavailable() {
  return new ApiError(404, "not_found", "Passkeys are unavailable at this address.");
}

function managementUnavailable() {
  return new ApiError(403, "passkey_unavailable", "Sign in with your current password to manage passkeys.");
}

function sessionArgs(session: StaffSession) {
  return [session.user.id, session.sessionVersion, session.user.role, session.exp, session.sid] as const;
}

// Account IDs are stable, but a digest keeps the original identifier out of the authenticator.
async function userHandle(userId: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("staff-passkey:" + userId)));
}

function flowToken(req: Request, challengeId: string): string | null {
  const cookie = new RegExp(`(?:^|;\\s*)${FLOW_COOKIE}${challengeId}=([a-f0-9]{64})(?:;|$)`);
  return cookie.exec(req.headers.get("cookie") || "")?.[1] ?? null;
}

function flowCookie(challengeId: string, value: string, maxAge: number) {
  return `${FLOW_COOKIE}${challengeId}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

async function cleanExpired(env: Env) {
  await env.DB.prepare(`DELETE FROM staff_passkey_challenges WHERE id IN (
    SELECT id FROM staff_passkey_challenges WHERE expires_at <= ${SQL_NOW_MS} ORDER BY expires_at LIMIT 100
  )`).run();
}

async function limitLogin(env: Env, ip: string) {
  const window = Math.floor(Date.now() / CHALLENGE_MS) * CHALLENGE_MS;
  const result = await env.DB.prepare(`INSERT INTO rate_limits (ip, window, n) VALUES (?, ?, 1)
    ON CONFLICT (ip, window) DO UPDATE SET n = n + 1 RETURNING n`).bind("staff-passkey:" + ip, window).first<{ n: number }>();
  if ((result?.n ?? 0) > 100) throw new ApiError(429, "rate_limited", "Too many passkey requests. Try again shortly.");
}

async function loginOptions(env: Env, rp: RelyingParty) {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId, userVerification: "required", timeout: CLIENT_TIMEOUT_MS,
  });
  // Each pending request has its own cookie, so tabs opening together do not replace each other's proof.
  const challengeId = newId(16), browserToken = newId(32);
  await cleanExpired(env);
  await env.DB.prepare(`INSERT INTO staff_passkey_challenges
    (id, purpose, challenge, origin, rp_id, expires_at, browser_token) VALUES (?, 'login', ?, ?, ?, ?, ?)`)
    .bind(challengeId, options.challenge, rp.origin, rp.rpId, Date.now() + CHALLENGE_MS, browserToken).run();
  return json({ challengeId, options }, 200, {
    "set-cookie": flowCookie(challengeId, browserToken, CHALLENGE_MS / 1000),
  });
}

async function takeChallenge(
  env: Env, rp: RelyingParty, id: unknown, binding: { token: string | null } | { session: StaffSession },
): Promise<Challenge> {
  if (typeof id !== "string" || !idPattern.test(id)) throw expired();
  // DELETE and RETURNING makes the challenge single-use before cryptographic verification, even across isolates.
  const constraints = "session" in binding
    ? ["purpose = 'register' AND user_id = ? AND session_id = ? AND session_ver = ? AND session_role = ?",
      [binding.session.user.id, binding.session.sid, binding.session.sessionVersion, binding.session.user.role]] as const
    : ["purpose = 'login' AND browser_token = ?", [binding.token]] as const;
  const challenge = await env.DB.prepare(`DELETE FROM staff_passkey_challenges WHERE id = ? AND origin = ? AND rp_id = ?
    AND expires_at > ${SQL_NOW_MS} AND ${constraints[0]} RETURNING challenge, name, expires_at`)
    .bind(id, rp.origin, rp.rpId, ...constraints[1]).first<Challenge>();
  if (!challenge) throw expired();
  return challenge;
}

async function loginVerify(
  req: Request, env: Env, rp: RelyingParty, body: { challengeId?: unknown; credential?: AuthenticationResponseJSON },
) {
  const { challengeId } = body;
  if (typeof challengeId !== "string" || !idPattern.test(challengeId)) throw expired();
  const challenge = await takeChallenge(env, rp, challengeId, { token: flowToken(req, challengeId) });
  const response = body.credential;
  if (!response || typeof response.id !== "string" || !credentialPattern.test(response.id)) throw rejected();
  const stored = await env.DB.prepare(`SELECT p.*, u.session_ver
    FROM staff_passkeys p JOIN users u ON p.user_id = u.id
    WHERE p.rp_id = ? AND p.credential_id = ? AND ${ELIGIBLE}`)
    .bind(rp.rpId, response.id).first<Passkey & { user_id: string; session_ver: number }>();
  if (!stored || response.response?.userHandle !== isoBase64URL.fromBuffer(await userHandle(stored.user_id))) throw rejected();

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    if (decodeClientDataJSON(response.response.clientDataJSON).crossOrigin) throw rejected();
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: { id: stored.credential_id, publicKey: isoBase64URL.toBuffer(stored.public_key), counter: stored.counter },
    });
  } catch {
    throw rejected();
  }
  if (!verification.verified || verification.authenticationInfo.credentialDeviceType !== stored.device_type) throw rejected();
  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  // A nonzero signature counter advances only from the verified value. Authenticators with no counter
  // report zero and rely on the single-use challenge for replay prevention.
  const [updated, user] = await env.DB.batch<SignInUser>([
    env.DB.prepare(`UPDATE staff_passkeys SET counter = ?, last_used_at = ${SQL_NOW_MS}, backed_up = ?
      WHERE id = ? AND counter = ? AND ? > ${SQL_NOW_MS}
      AND EXISTS (SELECT 1 FROM users WHERE id = staff_passkeys.user_id AND session_ver = ? AND ${ELIGIBLE})`)
      .bind(newCounter, Number(credentialBackedUp), stored.id, stored.counter, challenge.expires_at, stored.session_ver),
    env.DB.prepare(`UPDATE users SET last_login_at = ${SQL_NOW_MS}
      WHERE id = ? AND changes() = 1 RETURNING id, name, role, username, session_ver`).bind(stored.user_id),
  ]);
  if (!updated.meta.changes || !user.results[0]) throw rejected();
  const signedIn = await completePasskeySignIn(req, env, user.results[0]);
  signedIn.headers.append("set-cookie", flowCookie(challengeId, "", 0));
  return signedIn;
}

async function registerOptions(
  req: Request, env: Env, rp: RelyingParty, ip: string, session: StaffSession, body: { name?: unknown; password?: unknown },
) {
  const name = body.name == null || body.name === "" ? "Passkey" : cleanName(body.name);
  if (!name) throw invalid("Use a passkey name of up to 60 characters.");
  const user = await reauthenticateStaffPassword(req, env, session, ip, body.password);
  const keys = await env.DB.prepare("SELECT credential_id, transports FROM staff_passkeys WHERE user_id = ? AND rp_id = ?")
    .bind(user.id, rp.rpId).all<Pick<Passkey, "credential_id" | "transports">>();
  if (keys.results.length >= MAX_PASSKEYS) throw new ApiError(409, "passkey_limit", "Remove a passkey before adding another.");

  const options = await generateRegistrationOptions({
    rpID: rp.rpId, rpName: "Strangers Coffee Staff", userName: user.username, userDisplayName: user.name,
    userID: await userHandle(user.id), timeout: CLIENT_TIMEOUT_MS, attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: keys.results.map(key => ({ id: key.credential_id, transports: JSON.parse(key.transports) })),
  });
  const challengeId = newId(16);
  await cleanExpired(env);
  const inserted = await env.DB.prepare(`INSERT INTO staff_passkey_challenges
    (id, purpose, challenge, origin, rp_id, expires_at, user_id, session_id, session_ver, session_role, name)
    SELECT ?, 'register', ?, ?, ?, ?, id, ?, session_ver, role, ? FROM users WHERE id = ? AND ${SESSION_ELIGIBLE}`)
    .bind(challengeId, options.challenge, rp.origin, rp.rpId, Math.min(Date.now() + CHALLENGE_MS, session.exp),
      session.sid, name, ...sessionArgs(session)).run();
  if (!inserted.meta.changes) throw managementUnavailable();
  return json({ challengeId, options });
}

async function registerVerify(
  env: Env, rp: RelyingParty, session: StaffSession, body: { challengeId?: unknown; credential?: RegistrationResponseJSON },
) {
  const challenge = await takeChallenge(env, rp, body.challengeId, { session });
  const response = body.credential;
  const registrationFailed = () => new ApiError(400, "passkey_registration_failed", "Could not add that passkey. Please try again.");
  if (!response || typeof response.id !== "string" || !credentialPattern.test(response.id)) throw registrationFailed();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    if (decodeClientDataJSON(response.response.clientDataJSON).crossOrigin) throw registrationFailed();
    const attestation = decodeAttestationObject(isoBase64URL.toBuffer(response.response.attestationObject));
    if (attestation.get("fmt") !== "none") throw registrationFailed();
    verification = await verifyRegistrationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId,
      requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch {
    throw registrationFailed();
  }
  if (!verification.verified) throw registrationFailed();

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  if (credential.id !== response.id) throw registrationFailed();
  const transports = Array.isArray(credential.transports)
    ? credential.transports.filter(t => ["ble", "hybrid", "internal", "nfc", "usb", "smart-card"].includes(t)).slice(0, 6)
    : [];
  const created = await env.DB.prepare(`INSERT INTO staff_passkeys
    (id, user_id, rp_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at)
    SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_MS} FROM users WHERE id = ? AND ${SESSION_ELIGIBLE}
      AND ? > ${SQL_NOW_MS}
      AND (SELECT COUNT(*) FROM staff_passkeys WHERE user_id = users.id AND rp_id = ?) < ?
    ON CONFLICT (rp_id, credential_id) DO NOTHING RETURNING id, name, created_at, last_used_at`)
    .bind(newId(16), rp.rpId, credential.id, isoBase64URL.fromBuffer(credential.publicKey), credential.counter,
      JSON.stringify(transports), credentialDeviceType, Number(credentialBackedUp), challenge.name,
      ...sessionArgs(session), challenge.expires_at, rp.rpId, MAX_PASSKEYS)
    .first<Passkey>();
  if (!created) throw new ApiError(409, "passkey_not_added", "Could not add this passkey. It may already be registered or your session may have changed.");
  await audit(env, "security", session.user.name, "Added a passkey.");
  return json({ passkey: publicPasskey(created) });
}

async function removePasskey(
  req: Request, env: Env, rp: RelyingParty, ip: string, session: StaffSession, id: string, password: unknown,
) {
  await reauthenticateStaffPassword(req, env, session, ip, password);
  const removed = await env.DB.prepare(`DELETE FROM staff_passkeys WHERE id = ? AND rp_id = ? AND user_id IN (
    SELECT id FROM users WHERE id = ? AND ${SESSION_ELIGIBLE}
  )`).bind(id, rp.rpId, ...sessionArgs(session)).run();
  if (!removed.meta.changes) throw new ApiError(404, "passkey_not_found", "That passkey is no longer available.");
  await audit(env, "security", session.user.name, "Removed a passkey.");
  return json({ ok: true });
}

export async function handlePasskeyAuth(req: Request, env: Env, path: string, ip: string, session: StaffSession | null): Promise<Response> {
  const rp = relyingParty(new URL(req.url), env);
  if (!rp) throw unavailable();

  if (req.method === "GET" && path === ROOT) {
    if (!session?.sid) throw new ApiError(401, "auth_required", "Sign in to manage passkeys.");
    const rows = await env.DB.prepare(`SELECT p.id, p.name, p.created_at, p.last_used_at
      FROM (SELECT id FROM users WHERE id = ? AND ${SESSION_ELIGIBLE}) AS eligible
      LEFT JOIN staff_passkeys p ON p.user_id = eligible.id AND p.rp_id = ?
      ORDER BY p.created_at DESC`)
      .bind(...sessionArgs(session), rp.rpId).all<ListedPasskey | { id: null }>();
    if (!rows.results.length) throw managementUnavailable();
    return json({ passkeys: rows.results.filter(row => row.id !== null).map(publicPasskey) });
  }

  const route = path.slice(ROOT.length + 1);
  const login = req.method === "POST" && (route === "login/options" || route === "login/verify");
  const register = req.method === "POST" && (route === "register/options" || route === "register/verify");
  const remove = req.method === "DELETE" && idPattern.test(route);
  if (!login && !register && !remove) throw unavailable();
  if (req.headers.get("origin") !== rp.origin) throw new ApiError(403, "bad_origin", "That request came from another site.");
  if (!expectedJson(req)) throw new ApiError(415, "invalid_argument", "Send passkey requests as JSON.");
  const body = await readJson(req, 24 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send a passkey request object.");

  if (login) {
    await limitLogin(env, ip);
    return route === "login/options" ? loginOptions(env, rp) : loginVerify(req, env, rp, body);
  }

  if (!session?.sid) throw new ApiError(401, "auth_required", "Sign in to manage passkeys.");
  if (route === "register/options") return registerOptions(req, env, rp, ip, session, body);
  if (route === "register/verify") return registerVerify(env, rp, session, body);
  return removePasskey(req, env, rp, ip, session, route, body.password);
}
