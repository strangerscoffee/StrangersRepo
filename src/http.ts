export interface Env {
  DB: D1Database;
  LIVE?: DurableObjectNamespace; // live updates (src/live.ts)
  FILES: KVNamespace;
  ASSETS: Fetcher;
  SETUP_CODE?: string; // creates the first admin and resets an admin password
  SYNC_TOKEN?: string; // older name for SETUP_CODE, still accepted
  WRITE_LIMIT_PER_15_MIN?: string;
  COOKIE_DOMAIN?: string; // sign-in cookies are shared across this domain and its subdomains (wrangler.jsonc vars)
  ADMIN_HOST?: string; // the admin section's own hostname, e.g. admin.staffstrangerscoffee.com (wrangler.jsonc vars)
  ROTA_HOST?: string; // the rota app's own hostname, e.g. rota.staffstrangerscoffee.com (wrangler.jsonc vars)
  PREVIEW_HOST?: string; // signed-in wholesale ordering preview, e.g. preview.staffstrangerscoffee.com
  RESEND_API_KEY?: string; // rota emails (src/email/): a secret the host adds in Cloudflare; without it nothing is sent
  RESEND_API_URL?: string; // for tests only: where to send instead of Resend
  EMAIL_FROM?: string; // default "Strangers Rota <rota@staffstrangerscoffee.com>"
  EMAIL_DAILY_LIMIT?: string; // default 100 (Resend's free plan)
  WEEKLY_ANY_TIME?: string; // tests only: "1" sends the Monday summary whenever its cron runs
}

/** Error the page understands: rejected to it as {code, message}. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export const invalid = (message: string) => new ApiError(400, "invalid_argument", message);

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  // Headers rather than an object spread, so a response can set more than one cookie.
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(e: ApiError): Response {
  return json({ ...(e.extra || {}), code: e.code, message: e.message }, e.status);
}

/** Reads a JSON request body, capped at `maxBytes`. */
export async function readJson<T = any>(req: Request, maxBytes: number): Promise<T> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw new ApiError(413, "invalid_argument", "Request body is too large.");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiError(413, "invalid_argument", "Request body is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("Request body is not valid JSON.");
  }
}

/** Constant-time string comparison (via SHA-256 digests so lengths don't leak either). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** SQL expression for the database's current time in ms. */
export const SQL_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";
