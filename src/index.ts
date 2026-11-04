// Strangers Coffee Kitchen Diary staff site.
// Serves the diary page (public/index.html) and the API it uses through claude-shim.js, and, on its own
// hostname (ROTA_HOST), the staff rota (public/rota/, src/rota.ts). One Worker, one database, one set of accounts.
import { appForHost, appLinks, authorize, isAdminSharedFile, isPublicAsset, isPublicCode, isRotaManager, isRotaSharedFile, limitWrites, recordId, requireUser, unifiedSignin } from "./access";
import { handleAdmin } from "./admin";
import { handleAdminView } from "./adminView";
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

/** A file from public/. Scripts and styles may be kept for a minute (so moving between pages doesn't ask again
 * for each one), then checked again; images for a day. */
async function staticFile(req: Request, env: Env, p: string): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if (!res.ok || !/\.(js|css|svg|png|webmanifest)$/.test(p)) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", /\.(svg|png)$/.test(p) ? "private, max-age=86400" : "private, max-age=60, must-revalidate");
  return out;
}

const noStore = (res: Response) => {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-store");
  return out;
};
const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
// The rota app's page. Served at /rota/ on any host (local dev and tests) and at / on the rota's own host.
const rotaPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(new Request(new URL("/rota/", url), req)).then(noStore);
// The admin section's page. Served at / on its own host (ADMIN_HOST), and at /admin on the diary's when there's none.
const adminPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(new Request(new URL("/admin/", url), req)).then(noStore);
const ADMIN_PAGES = new Set(["/admin", "/admin/", "/admin.html", "/admin/index.html"]);

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const p = url.pathname;
  const isGet = req.method === "GET" || req.method === "HEAD";
  const app = appForHost(url.hostname, env.ROTA_HOST, env.ADMIN_HOST);
  const links = appLinks(url, env.ROTA_HOST, env.ADMIN_HOST);
  // One Staff Login for every address: the rota's sign-in page is the diary's (src/hosts.ts).
  if (isGet && (p === "/signin" || p === "/signin.html")) {
    const to = unifiedSignin(url, env.COOKIE_DOMAIN);
    if (to) return redirect(to);
  }
  // Writes only from the site's own pages: a browser always sends Origin on a cross-site POST, so a page
  // elsewhere can't use someone's session (a second layer on top of SameSite cookies).
  if (!isGet && p.startsWith("/api/")) {
    const origin = req.headers.get("origin");
    if (origin && origin !== "null") {
      let host = "";
      try { host = new URL(origin).hostname; } catch {}
      const own = host === url.hostname || (!!env.COOKIE_DOMAIN && (host === env.COOKIE_DOMAIN || host.endsWith("." + env.COOKIE_DOMAIN)));
      if (!own) throw new ApiError(403, "bad_origin", "That request came from another site.");
    } else if (origin === "null") throw new ApiError(403, "bad_origin", "That request came from another site.");
  }
  // The sign-in page and its files need no session (and no database); nor do the diary's and the rota's
  // scripts, styles and images (code, no data: see isPublicCode in src/hosts.ts).
  if (isGet && isPublicAsset(p)) return env.ASSETS.fetch(req);
  if (isGet && isPublicCode(app, p)) return staticFile(req, env, p);
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

  if (p.startsWith("/api/rota/")) return handleRota(req, env, ctx, p.slice("/api/rota/".length), user, links);

  // The rota's own host serves the rota and nothing of the diary's: diary pages go to the rota, diary APIs are refused.
  if (app === "rota") {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(404, "not_found", "Not available on the rota's address.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    if (p === "/") return rotaPage(req, env, url);
    if (isRotaSharedFile(p)) return env.ASSETS.fetch(req);
    return redirect("/");
  }

  // The admin section's own host: admins only. Its page, its files, the admin API and (above) the rota's API;
  // nothing of the diary's. Everyone else goes back to the diary.
  if (app === "admin") {
    if (user.role !== "admin") {
      if (p.startsWith("/api/")) throw new ApiError(403, "permission_denied", "Only admins can use the admin section.");
      return redirect(links.diary);
    }
    if (!p.startsWith("/api/admin/")) {
      if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(404, "not_found", "Not available on the admin address.");
      if (!isGet) return new Response("Method not allowed", { status: 405 });
      if (p === "/") return adminPage(req, env, url);
      if (isAdminSharedFile(p)) return env.ASSETS.fetch(req);
      return redirect("/");
    }
  }

  if (p.startsWith("/api/admin/")) {
    if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can do this.");
    const r = p.slice("/api/admin/".length);
    if (r === "backups" || r.startsWith("backups/")) return handleBackups(req, env, r.slice("backups/".length), user.name);
    return (await handleAdminView(req, env, r, user, links)) ?? handleAdmin(req, env, r, user);
  }

  const db = p.match(/^\/api\/db\/([a-z]+)$/);
  if (db) {
    if (WRITE_OPS.has(db[1])) await limitWrites(req, env, ctx);
    return handleDb(req, env, db[1], user);
  }

  // Stored files (allergen PDFs from before the matrix was generated): managers and admins only, so no one
  // can delete another person's file or fill the store.
  const needFileManager = () => {
    if (!isRotaManager(requireUser(caller))) throw new ApiError(403, "permission_denied", "Only a manager or admin can add or remove stored files.");
  };
  if (p === "/api/assets" && req.method === "POST") {
    needFileManager();
    await limitWrites(req, env, ctx);
    return uploadAsset(req, env, recordId(requireUser(caller)));
  }
  const asset = p.match(/^\/api\/assets\/([^/]+)$/);
  if (asset && req.method === "DELETE") {
    needFileManager();
    await limitWrites(req, env, ctx);
    return deleteAsset(env, asset[1]);
  }

  const blob = p.match(/^\/_blob\/([^/]+)$/);
  if (blob && isGet) return serveBlob(env, blob[1]);

  if (p.startsWith("/api/")) throw new ApiError(404, "not_found", "Unknown API route.");
  if (!isGet) return new Response("Method not allowed", { status: 405 });
  if (p === "/rota" || p === "/rota/" || p === "/rota/index.html") return p === "/rota" ? redirect("/rota/") : rotaPage(req, env, url);
  // The admin section: admins only. With its own address (ADMIN_HOST) /admin goes there; otherwise (local dev,
  // tests) it's served here.
  if (ADMIN_PAGES.has(p)) {
    if (user.role !== "admin") return redirect("/");
    return env.ADMIN_HOST ? redirect(links.admin) : adminPage(req, env, url);
  }
  // Pages behind sign-in must not be cached by shared devices' browsers or proxies.
  if (p === "/" || p === "/index.html") {
    const res = await env.ASSETS.fetch(req);
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "private, no-store");
    return out;
  }
  return staticFile(req, env, p);
}

function withSecurityHeaders(res: Response, local: boolean): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  // Only the site's own scripts run (no inline or third-party scripts), it only talks to itself, and it can't be framed.
  // Defence in depth: even if text someone typed into a record were ever shown as HTML, it couldn't run as script.
  h.set("content-security-policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "));
  if (!local) h.set("strict-transport-security", "max-age=31536000");
  return out;
}
