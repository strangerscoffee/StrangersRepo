// Strangers Coffee Kitchen Diary staff site.
// Serves the diary page (public/index.html) and the API it uses through claude-shim.js, and, on its own
// hostname (ROTA_HOST), the staff rota (public/rota/, src/rota.ts). One Worker, one database, one set of accounts.
import { appForHost, appLinks, authorize, isPublicAsset, isRotaSharedFile, limitWrites, recordId, requireUser, unifiedSignin } from "./access";
import { handleAdmin } from "./admin";
import { handleAuth } from "./auth";
import { handleBackups, makeBackup } from "./backup";
import { deleteAsset, serveBlob, uploadAsset } from "./assets";
import { WRITE_OPS, handleDb } from "./docs";
import { ApiError, Env, errorResponse, json } from "./http";
import { handleRota } from "./rota";
import { ensureSchema } from "./schema";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // One address for the site, so sign-in cookies always match: https and no www.
    const www = url.hostname.startsWith("www.");
    if ((url.protocol === "http:" || www) && !local) {
      url.protocol = "https:";
      if (www) url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    let res: Response;
    try {
      res = await route(req, env, ctx, url);
    } catch (e) {
      if (e instanceof ApiError) res = errorResponse(e);
      else {
        console.error(e);
        const msg = String((e as Error)?.message || e);
        // D1 reports a full database as SQLITE_FULL; the page shows a specific message for quota_exceeded.
        res = /SQLITE_FULL|database or disk is full/i.test(msg)
          ? json({ code: "quota_exceeded", message: "The database is full." }, 507)
          : json({ code: "internal", message: "Something went wrong." }, 500);
      }
    }
    return withSecurityHeaders(res, local);
  },

  // The daily backup (cron in wrangler.jsonc).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureSchema(env).then(() => makeBackup(env, "daily")));
  },
} satisfies ExportedHandler<Env>;

const noStore = (res: Response) => {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-store");
  return out;
};
const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
// The rota app's page. Served at /rota/ on any host (local dev and tests) and at / on the rota's own host.
const rotaPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(new Request(new URL("/rota/", url), req)).then(noStore);

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const p = url.pathname;
  const isGet = req.method === "GET" || req.method === "HEAD";
  const app = appForHost(url.hostname, env.ROTA_HOST);
  // One Staff Login for every address: the rota's sign-in page is the diary's (src/hosts.ts).
  if (isGet && (p === "/signin" || p === "/signin.html")) {
    const to = unifiedSignin(url, env.COOKIE_DOMAIN);
    if (to) return redirect(to);
  }
  // The sign-in page and its files need no session (and no database).
  if (isGet && isPublicAsset(p)) return env.ASSETS.fetch(req);
  // On its own host the rota lives at /, so /rota/ (the address used in local dev) goes there.
  if (app === "rota" && isGet && (p === "/rota" || p === "/rota/" || p === "/rota/index.html")) return redirect("/" + url.search);

  await ensureSchema(env);
  const caller = await authorize(req, env);

  if (p.startsWith("/api/auth/")) return handleAuth(req, env, p.slice("/api/auth/".length), caller.kind === "user" ? caller.user : null);

  // Everything below needs a signed-in person.
  if (caller.kind !== "user") {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    const next = p === "/" ? "" : `?next=${encodeURIComponent(p + url.search)}`;
    return new Response(null, { status: 302, headers: { location: "/signin" + next, "cache-control": "no-store" } });
  }
  const user = caller.user;

  if (p.startsWith("/api/rota/")) return handleRota(req, env, ctx, p.slice("/api/rota/".length), user, appLinks(url, env.ROTA_HOST));

  // The rota's own host serves the rota and nothing of the diary's: diary pages go to the rota, diary APIs are refused.
  if (app === "rota") {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(404, "not_found", "Not available on the rota's address.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    if (p === "/") return rotaPage(req, env, url);
    if (isRotaSharedFile(p)) return env.ASSETS.fetch(req);
    return redirect("/");
  }

  if (p.startsWith("/api/admin/")) {
    if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can do this.");
    const r = p.slice("/api/admin/".length);
    if (r === "backups" || r.startsWith("backups/")) return handleBackups(req, env, r.slice("backups/".length), user.name);
    return handleAdmin(req, env, r, user);
  }

  const db = p.match(/^\/api\/db\/([a-z]+)$/);
  if (db) {
    if (WRITE_OPS.has(db[1])) await limitWrites(req, env, ctx);
    return handleDb(req, env, db[1], user);
  }

  if (p === "/api/assets" && req.method === "POST") {
    await limitWrites(req, env, ctx);
    return uploadAsset(req, env, recordId(requireUser(caller)));
  }
  const asset = p.match(/^\/api\/assets\/([^/]+)$/);
  if (asset && req.method === "DELETE") {
    await limitWrites(req, env, ctx);
    return deleteAsset(env, asset[1]);
  }

  const blob = p.match(/^\/_blob\/([^/]+)$/);
  if (blob && isGet) return serveBlob(env, blob[1]);

  if (p.startsWith("/api/")) throw new ApiError(404, "not_found", "Unknown API route.");
  if (!isGet) return new Response("Method not allowed", { status: 405 });
  if (p === "/rota" || p === "/rota/" || p === "/rota/index.html") return p === "/rota" ? redirect("/rota/") : rotaPage(req, env, url);
  if ((p === "/admin" || p === "/admin.html") && user.role !== "admin") {
    return new Response(null, { status: 302, headers: { location: "/", "cache-control": "no-store" } });
  }
  // Pages behind sign-in must not be cached by shared devices' browsers or proxies.
  const res = await env.ASSETS.fetch(req);
  if (p === "/" || p === "/index.html" || p.startsWith("/admin")) {
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "private, no-store");
    return out;
  }
  return res;
}

function withSecurityHeaders(res: Response, local: boolean): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("content-security-policy", "frame-ancestors 'none'");
  if (!local) h.set("strict-transport-security", "max-age=31536000");
  return out;
}
