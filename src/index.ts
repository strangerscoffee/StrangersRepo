// Strangers Coffee Kitchen Diary staff site.
// Serves the diary page (public/index.html) and the API it uses through claude-shim.js, and, on its own
// hostname (ROTA_HOST), the staff rota (public/rota/, src/rota.ts). One Worker, one database, one set of accounts.
import { appForHost, appLinks, authorize, isAdminSharedFile, isPreviewFile, isPublicAsset, isPublicCode, isRotaManager, isRotaSharedFile, limitWrites, recordId, requireUser, unifiedSignin } from "./access";
import { handleAdmin } from "./admin";
import { handleStaffOrders } from "./staffOrders";
import { requireStaffOrders } from "./staffOrdersAccess";
import { handleAdminView } from "./adminView";
import { handleAuth } from "./auth";
import { handleBackups, makeBackup } from "./backup";
import { deleteAsset, serveBlob, uploadAsset } from "./assets";
import { WRITE_OPS, handleDb } from "./docs";
import { ApiError, Env, errorResponse, json, readJson } from "./http";
import { handleRota } from "./rota";
import { ensureSchema } from "./schema";
import { codeFor, deviceOf, recordError } from "./errors";
import { audit } from "./audit";
import { handleUnsubscribe } from "./email/unsubscribe";
import { notifyLive, openLive } from "./live";
import { sendWeeklySummaries } from "./email/weekly";
import { handleWholesale, handleWholesaleAdmin } from "./wholesale";
import { handleWholesaleAuth, wholesaleSession } from "./wholesaleAccounts";
import {handleWebhook} from "./quickbooks/webhooks";
import {processEvents,runQuickBooksJobs} from "./quickbooks/jobs";
export { LiveHub } from "./live";

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
    // Reads are tried once more if the database drops out for a moment (D1 can, briefly, during its own maintenance
    // or a network blip), instead of showing someone an error. Only reads: a write might have happened.
    const readOnly = req.method === "GET" || req.method === "HEAD" || (req.method === "POST" && /^\/api\/db\/(get|query|poll|profiles)$/.test(url.pathname));
    const spare = readOnly && req.method === "POST" ? req.clone() : null;
    try {
      try {
        res = await route(req, env, ctx, url);
      } catch (e) {
        if (!readOnly || e instanceof ApiError || !isTransient(e)) throw e;
        await new Promise((r) => setTimeout(r, 150));
        res = await route(spare || req, env, ctx, url);
      }
    } catch (e) {
      if (e instanceof ApiError) res = errorResponse(e);
      else {
        console.error(e);
        const report = { source: "server" as const, app: "worker", page: `${req.method} ${url.pathname}`, message: String((e as Error)?.message || e),
          detail: String((e as Error)?.stack || ""), ua: req.headers.get("user-agent") || "" };
        ctx.waitUntil(recordError(env, report));
        const ref = codeFor(report);
        const msg = String((e as Error)?.message || e);
        // D1 reports a full database as SQLITE_FULL; the page shows a specific message for quota_exceeded.
        res = /SQLITE_FULL|database or disk is full/i.test(msg)
          ? json({ code: "quota_exceeded", message: "The database is full." }, 507)
          : json({ code: "internal", ref, message: `Something went wrong on the server (error ${ref}). Try again; if it keeps happening, send a screenshot of this to whoever looks after the site.` }, 500);
      }
    }
    // A write other devices should hear about: tell every open page (src/live.ts), after answering this one.
    if (res.ok && req.method !== "GET" && req.method !== "HEAD" && LIVE_WRITES.test(url.pathname)) ctx.waitUntil(notifyLive(env));
    // An opened live connection (101) goes back as it is: its WebSocket can't be copied into a new response.
    if (res.status === 101) return res;
    return withSecurityHeaders(res, local);
  },

  // The daily backup, and the managers' Monday summary (crons in wrangler.jsonc).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if(event.cron === "*/5 * * * *"){
      ctx.waitUntil(ensureSchema(env).then(async()=>{
        // App credentials can be saved in Admin instead of Worker vars. Keep idle cron runs small.
        if(env.QUICKBOOKS_CLIENT_ID||env.QUICKBOOKS_PRODUCTION_CLIENT_ID||await env.DB.prepare('SELECT 1 FROM quickbooks_app_settings WHERE data IS NOT NULL LIMIT 1').first())await runQuickBooksJobs(env);
      }));
      return;
    }
    if (event.cron === "30 6,7 * * 1") {
      const domain = env.COOKIE_DOMAIN || "staffstrangerscoffee.com";
      const base = { diary: `https://${domain}/`, rota: env.ROTA_HOST ? `https://${env.ROTA_HOST}/` : `https://${domain}/rota/` };
      ctx.waitUntil(ensureSchema(env).then(() => sendWeeklySummaries(env, base, { anyTime: env.WEEKLY_ANY_TIME === "1" })));
      return;
    }
    ctx.waitUntil(ensureSchema(env).then(() => makeBackup(env, "daily")));
  },
} satisfies ExportedHandler<Env>;

/** How far out a device's clock must be before the admin section mentions it. */
const CLOCK_FLAG_MS = 5 * 60 * 1000;
async function flagClock(env: Env, user: { name: string }, diffMs: number, ua: string) {
  try {
    const recent = await env.DB.prepare("SELECT 1 FROM audit_log WHERE kind = 'clock_off' AND actor = ? AND at > ? LIMIT 1").bind(user.name, Date.now() - 864e5).first();
    if (recent) return;
    const mins = Math.round(Math.abs(diffMs) / 60000), h = Math.floor(mins / 60), m = mins % 60;
    const by = h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
    await audit(env, "clock_off", user.name, `${user.name}'s ${(deviceOf(ua).split(" · ")[0] || "device").replace(/^Unknown device$/, "device")} clock is ${by} ${diffMs > 0 ? "fast" : "slow"}. The site uses the right time anyway; set the device to set its time automatically.`);
  } catch { /* only a note */ }
}

/** The writes that move a change counter (diary saves, the rota, accounts and sites, stored files). */
const LIVE_WRITES = /^\/api\/(db\/(set|update|delete)$|rota\/|admin\/|wholesale\/|assets)/;

/** A database error that's worth one more try: the connection dropped or D1 was busy restarting. */
function isTransient(e: unknown): boolean {
  return /network connection lost|connection reset|storage caused object to be reset|object to be reset|D1_ERROR: (internal|overloaded)|timed? ?out|Durable Object reset|try again/i.test(String((e as Error)?.message || e));
}

/** Moves the change counters that GET /api/changes reports, after a write that other devices should see. */
async function bumpChanges(env: Env, ...keys: string[]) {
  await env.DB.prepare(`UPDATE meta SET v = v + 1 WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).run();
}

/*
 * Fingerprinted files. Each page's scripts and stylesheets are linked as /diary/core.js?v=<the file's own hash> (from its
 * ETag), and a file asked for with ?v= is kept by the browser for a year: opening a page again costs no requests for
 * them at all, and a changed file has a new address, so a deploy reaches everyone straight away. Hashes are looked up
 * once per Worker instance (a deploy starts new ones).
 */
const fingerprints = new Map<string, string>();
async function fingerprint(env: Env, url: URL, path: string): Promise<string | null> {
  if (fingerprints.has(path)) return fingerprints.get(path)!;
  const res = await env.ASSETS.fetch(new Request(new URL(path, url)));
  const tag = res.ok ? (res.headers.get("etag") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) : "";
  await res.body?.cancel();
  if (!tag) return null;
  fingerprints.set(path, tag);
  return tag;
}
/** A page (HTML) with its own scripts and stylesheets linked by fingerprint. */
function withFingerprints(res: Response, env: Env, url: URL): Response {
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
  const pin = (attr: string) => ({
    async element(e: Element) {
      const v = e.getAttribute(attr);
      if (!v || !/^\/[^/?#]*(\/[^/?#]+)*\.(js|css)$/.test(v)) return; // only this site's own files
      const tag = await fingerprint(env, url, v);
      if (tag) e.setAttribute(attr, `${v}?v=${tag}`);
    },
  });
  return new HTMLRewriter().on("script[src]", pin("src")).on('link[rel="stylesheet"][href]', pin("href")).transform(res);
}

/** A file from public/. Fingerprinted ones (?v=) are kept for a year; otherwise scripts and styles for a minute, then
 * checked again, and images for a day. */
async function staticFile(req: Request, env: Env, p: string): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if (!res.ok || !/\.(js|css|svg|png|webmanifest)$/.test(p)) return res;
  const out = new Response(res.body, res);
  const pinned = new URL(req.url).searchParams.has("v");
  out.headers.set("cache-control", pinned ? "private, max-age=31536000, immutable" : /\.(svg|png)$/.test(p) ? "private, max-age=86400" : "private, max-age=60, must-revalidate");
  return out;
}

const noStore = (res: Response) => {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-store");
  out.headers.delete("etag"); out.headers.delete("last-modified");
  return out;
};
const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
const pageRequest=(req:Request,target:URL|string=req.url)=>{const fresh=new Request(target,req);fresh.headers.delete("if-none-match");fresh.headers.delete("if-modified-since");return fresh;};
// The rota app's page. Served at /rota/ on any host (local dev and tests) and at / on the rota's own host.
const rotaPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/rota/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
// The admin section's page. Served at / on its own host (ADMIN_HOST), and at /admin on the diary's when there's none.
const adminPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/admin/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
const wholesalePage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/wholesale-preview/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
const ADMIN_PAGES = new Set(["/admin", "/admin/", "/admin.html", "/admin/index.html"]);
const WHOLESALE_PAGES = new Set(["/wholesale-preview", "/wholesale-preview/", "/wholesale-preview/index.html"]);
const OLD_WHOLESALE_DASHBOARD = new Set(["/wholesale-preview/dashboard", "/wholesale-preview/dashboard/", "/wholesale-preview/dashboard/index.html"]);

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const p = url.pathname;
  if(p.startsWith("/api/quickbooks/webhook/"))return handleWebhook(req,env,ctx,processEvents);
  const isGet = req.method === "GET" || req.method === "HEAD";
  const app = appForHost(url.hostname, env.ROTA_HOST, env.ADMIN_HOST, env.PREVIEW_HOST, env.LEGACY_PREVIEW_HOST);
  const links = appLinks(url, env.ROTA_HOST, env.ADMIN_HOST, env.PREVIEW_HOST, env.LEGACY_PREVIEW_HOST);
  // A separate customer domain must not mint staff cookies or accept them for ordering.
  // Keep the legacy staff-domain preview working for its existing sessions and saved browser work.
  const staffDomain = (env.COOKIE_DOMAIN || "").toLowerCase().replace(/^\./, "");
  const customerOnly = app === "preview" && !!staffDomain && url.hostname !== staffDomain && !url.hostname.endsWith("." + staffDomain);
  if (customerOnly && p.startsWith("/api/") && !p.startsWith("/api/wholesale/") && p !== "/api/errors") throw new ApiError(404, "not_found", "Not available on the ordering address.");
  const wholesaleHost = app === "preview" || app === "diary";
  const wholesaleSignin = app === "preview" ? "/signin" : "/wholesale-preview/signin";
  if (wholesaleHost && isGet && (p === "/wholesale-preview/signin" || p === "/wholesale-preview/signin.html" || (app === "preview" && (p === "/signin" || p === "/signin.html")))) {
    const response = await env.ASSETS.fetch(pageRequest(req,new URL("/wholesale-preview/signin", url)));
    return withFingerprints(noStore(response), env, url);
  }
  if (wholesaleHost && isGet && p === "/wholesale-preview/staff-signin") {
    if (app === "diary") return redirect("/signin?next=" + encodeURIComponent("/wholesale-preview/"));
    const target = new URL("signin", new URL(links.diary, url));
    target.searchParams.set("next", customerOnly ? (env.LEGACY_PREVIEW_HOST ? `https://${env.LEGACY_PREVIEW_HOST}/` : new URL(links.admin, url).toString()) : new URL(app === "preview" ? "/" : "/wholesale-preview/", url).toString());
    return redirect(target.toString());
  }
  if (wholesaleHost && isGet && ["/wholesale-preview/signin.js", "/wholesale-preview/wholesale.css", "/theme.css", "/shared/core.js"].includes(p)) return staticFile(req, env, p);
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
  if (isGet && isPublicAsset(p)) {
    if(p==="/signin"||p==="/signin.html"){
      // The HTML contains asset fingerprints that change even when the HTML source itself did not.
      // An old conditional HTML request must not pin a previous deploy's immutable scripts forever.
      return withFingerprints(noStore(await env.ASSETS.fetch(pageRequest(req))),env,url);
    }
    return staticFile(req,env,p);
  }
  if (isGet && isPublicCode(app, p)) return staticFile(req, env, p);
  // On its own host the rota lives at /, so /rota/ (the address used in local dev) goes there.
  if (app === "rota" && isGet && (p === "/rota" || p === "/rota/" || p === "/rota/index.html")) return redirect("/" + url.search);

  await ensureSchema(env);
  const caller = await authorize(req, env);
  // A page/queued write belongs to the identity that opened it. Shared cookies may change in another tab
  // between its session check and this request; reject before reading any private data or returning a CAS body.
  const expectedId = req.headers.get("x-expected-user-id"), expectedRole = req.headers.get("x-expected-user-role");
  const identityBound = /^\/api\/(?:db\/|admin\/|rota\/|staff-orders\/|assets(?:\/|$))/.test(p) || p === "/api/auth/logout" || p === "/api/auth/pin" || p === "/api/auth/notifications/seen";
  if (identityBound && (expectedId || expectedRole) && (caller.kind !== "user" || (expectedId && caller.user.id !== expectedId) || (expectedRole && caller.user.role !== expectedRole))) {
    throw new ApiError(409, "session_changed", "The signed-in account changed. Reload to continue.");
  }

  // The unsubscribe link at the foot of rota emails (src/email/unsubscribe.ts): signed in or not, by its signed token.
  if (p === "/email/unsubscribe" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST") await limitWrites(req, env, ctx);
    return handleUnsubscribe(req, env, url);
  }

  // Errors from the site's own pages (public/errors.js), signed in or not (a page that fails to load is often one
  // whose session has ended). Rate-limited like any write; the Origin check above keeps other sites out.
  if (p === "/api/errors" && req.method === "POST") {
    const who = caller.kind === "user" ? caller.user : null;
    await limitWrites(req, env, ctx, who?.id);
    const b = await readJson<any>(req, 8 * 1024).catch(() => null);
    if (!b || typeof b !== "object") return new Response(null, { status: 204 });
    const code = await recordError(env, { source: "page", app: b.app, page: b.page, message: b.message, detail: b.detail, ua: req.headers.get("user-agent") || "", who: who?.name ?? null });
    return json({ code });
  }

  if (p.startsWith("/api/auth/")) return handleAuth(req, env, p.slice("/api/auth/".length), caller.kind === "user" ? caller.user : null);

  // Wholesale cookies have their own namespace and are never accepted by any staff route.
  const wholesaleScope = app === "preview" || (app === "diary" && (p.startsWith("/api/wholesale/") || WHOLESALE_PAGES.has(p) || OLD_WHOLESALE_DASHBOARD.has(p) || (p.startsWith("/wholesale-preview/") && isPreviewFile(p))));
  if (wholesaleScope) {
    if (p.startsWith("/api/wholesale/auth/")) {
      if (!isGet) await limitWrites(req, env, ctx);
      const response = await handleWholesaleAuth(req, env, p.slice("/api/wholesale/auth/".length));
      if (!isGet && response.ok) await bumpChanges(env, "accounts");
      return response;
    }
    const user = await wholesaleSession(req, env) || (!customerOnly && caller.kind === "user" ? caller.user : null);
    if (!user) {
      if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
      if (!isGet) return new Response("Method not allowed", { status: 405 });
      return redirect(wholesaleSignin);
    }
    if (p.startsWith("/api/wholesale/")) {
      if (!isGet) await limitWrites(req, env, ctx, user.id);
      const response = await handleWholesale(req, env, p.slice("/api/wholesale/".length), user, links);
      if (!isGet && response.ok) await bumpChanges(env, "accounts");
      return response;
    }
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(404, "not_found", "Not available on the ordering address.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    if (OLD_WHOLESALE_DASHBOARD.has(p) || p === "/dashboard" || p === "/dashboard/") {
      if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can open Wholesale in Admin.");
      return redirect(links.admin + "#wholesale");
    }
    if ((app === "preview" && (p === "/" || p === "/index.html")) || (app === "diary" && WHOLESALE_PAGES.has(p))) return wholesalePage(req, env, url);
    if (isPreviewFile(p)) return staticFile(req, env, p);
    return redirect("/");
  }

  // Everything below needs a signed-in person.
  if (caller.kind !== "user") {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    const next = p === "/" ? "" : `?next=${encodeURIComponent(p + url.search)}`;
    return new Response(null, { status: 302, headers: { location: "/signin" + next, "cache-control": "no-store" } });
  }
  const user = caller.user;
  if(p.startsWith("/api/staff-orders/")){
    if(app!=="diary")throw new ApiError(404,"not_found","Not available on this address.");
    return handleStaffOrders(req,env,p.slice("/api/staff-orders/".length),user);
  }
  if(app==="diary"&&isGet&&(p==="/orders"||p.startsWith("/orders/"))){
    await requireStaffOrders(env,user);
    if(["/orders","/orders/","/orders/index","/orders/index.html"].includes(p))return withFingerprints(noStore(await env.ASSETS.fetch(pageRequest(req,new URL("/orders/",url)))),env,url);
    return staticFile(req,env,p);
  }
  // A device whose own clock is well out (public/shared/core.js sends it): the page corrects for it, but someone
  // should fix the device's settings, so the admin section says so (once a day per person).
  const deviceTime = Number(req.headers.get("x-device-time"));
  if (Number.isFinite(deviceTime) && deviceTime > 0 && Math.abs(deviceTime - Date.now()) > CLOCK_FLAG_MS) ctx.waitUntil(flagClock(env, user, deviceTime - Date.now(), req.headers.get("user-agent") || ""));

  // Live updates (src/live.ts): a WebSocket that's told the moment anything changes, on every app's address. Only
  // from the site's own pages (a browser always sends Origin when opening one).
  if (p === "/api/live" && isGet) {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new ApiError(426, "upgrade_required", "This address is for a live connection.");
    let host = "";
    try { host = new URL(req.headers.get("origin") || "").hostname; } catch {}
    const own = host === url.hostname || (!!env.COOKIE_DOMAIN && (host === env.COOKIE_DOMAIN || host.endsWith("." + env.COOKIE_DOMAIN)));
    if (!own) throw new ApiError(403, "bad_origin", "That request came from another site.");
    if (!env.LIVE) throw new ApiError(404, "not_found", "Live updates aren't set up.");
    return openLive(req, env);
  }

  // What has changed, for pages open on several devices: one small read, polled every few seconds.
  if (p === "/api/changes" && isGet) {
    const { results } = await env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('seq', 'rota', 'accounts')").all<{ k: string; v: number }>();
    const v = Object.fromEntries(results.map((r) => [r.k, r.v]));
    return json({ docs: v.seq ?? 0, rota: v.rota ?? 0, accounts: v.accounts ?? 0 });
  }

  if (p.startsWith("/api/rota/")) {
    const res = await handleRota(req, env, ctx, p.slice("/api/rota/".length), user, links);
    if (!isGet && res.ok) await bumpChanges(env, "rota");
    return res;
  }

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
    let res;
    if (r === "wholesale" || r.startsWith("wholesale/")) {
      if (!isGet) await limitWrites(req, env, ctx, user.id);
      res = await handleWholesaleAdmin(req, env, r === "wholesale" ? "" : r.slice("wholesale/".length), user, links, ctx);
    } else res = (await handleAdminView(req, env, r, user, links)) ?? (await handleAdmin(req, env, r, user));
    // Accounts and sites show on the rota too (names, who's switched off, opening hours).
    if (!isGet && res.ok) await bumpChanges(env, "accounts", "rota");
    return res;
  }

  if (p.startsWith("/api/wholesale/")) {
    if (!isGet) await limitWrites(req, env, ctx, user.id);
    const response = await handleWholesale(req, env, p.slice("/api/wholesale/".length), user, links);
    if (!isGet && response.ok) await bumpChanges(env, "accounts");
    return response;
  }

  const db = p.match(/^\/api\/db\/([a-z]+)$/);
  if (db) {
    if (WRITE_OPS.has(db[1])) await limitWrites(req, env, ctx, user.id);
    return handleDb(req, env, db[1], user);
  }

  // Stored files (allergen PDFs from before the matrix was generated): managers and admins only, so no one
  // can delete another person's file or fill the store.
  const needFileManager = () => {
    if (!isRotaManager(requireUser(caller))) throw new ApiError(403, "permission_denied", "Only a manager or admin can add or remove stored files.");
  };
  if (p === "/api/assets" && req.method === "POST") {
    needFileManager();
    await limitWrites(req, env, ctx, user.id);
    return uploadAsset(req, env, recordId(requireUser(caller)));
  }
  const asset = p.match(/^\/api\/assets\/([^/]+)$/);
  if (asset && req.method === "DELETE") {
    needFileManager();
    await limitWrites(req, env, ctx, user.id);
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
  if (OLD_WHOLESALE_DASHBOARD.has(p)) {
    if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can open Wholesale in Admin.");
    return redirect(links.admin + "#wholesale");
  }
  if (WHOLESALE_PAGES.has(p)) {
    if (env.PREVIEW_HOST) return redirect(`https://${env.PREVIEW_HOST}/${url.search}`);
    return p === "/wholesale-preview" ? redirect("/wholesale-preview/" + url.search) : wholesalePage(req, env, url);
  }
  // Pages behind sign-in must not be cached by shared devices' browsers or proxies.
  if (p === "/" || p === "/index.html") return withFingerprints(noStore(await env.ASSETS.fetch(pageRequest(req))), env, url);
  return staticFile(req, env, p);
}

function withSecurityHeaders(res: Response, local: boolean): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  // The server's time: pages run on it, not the device's clock (public/shared/core.js). Only on responses the
  // browser never keeps (no-store): a kept copy (the logo, for a day) would come back instantly with the time it was
  // first fetched and wind the page's clock back to it.
  if (/no-store/i.test(h.get("cache-control") || "")) h.set("x-now", String(Date.now())); else h.delete("x-now");
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
