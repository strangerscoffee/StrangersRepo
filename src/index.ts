// Strangers Coffee Kitchen Diary staff site.
// Serves the diary page (public/index.html) and the API it uses through claude-shim.js, and, on its own
// hostname (ROTA_HOST), the staff rota (public/rota/, src/rota.ts). One Worker, one database, one set of accounts.
import { refreshInsights } from "./insights";
import { deliverIntegrationBatch } from "./integrationConsumer";
import type { IntegrationSignal } from "./integrationSignals";
import { runHolidayReminders } from "./rota/leave/notify";
import { repairStandingRuns } from "./wholesaleStanding";
import { deliverSlackPosts } from "./slackOrders";
import { handleResendWebhook } from "./email/delivery";
import { deliverDispatchEmails } from "./email/outbox";
import { deliverStaffEmails } from "./email/staffOutbox";
import { deliverDiaryReminders } from "./slackDiary";
import { appForHost, appLinks, authorize, isAdminSharedFile, isPreviewFile, isPublicAsset, isPublicCode, isRotaManager, isRotaSharedFile, limitWrites, recordId, requireUser, unifiedSignin } from "./access";
import { handleAdmin } from "./admin";
import { handleConsumerAdmin } from "./consumerAdmin";
import { handleStaffOrders } from "./staffOrders";
import { requireStaffOrders } from "./staffOrdersAccess";
import { handleAdminView } from "./adminView";
import { handleAuth, SessionUnavailableError } from "./auth";
import { handleBackups, makeBackup } from "./backup";
import { deleteAsset, serveBlob, uploadAsset } from "./assets";
import { WRITE_OPS, handleDb } from "./docs";
import { ApiError, Env, errorResponse, json, readJson } from "./http";
import { handleRota } from "./rota";
import { ensureSchema } from "./schema";
import { browserMessagingNoise, codeFor, deviceOf, FILE_SERVED, recordError } from "./errors";
import { audit } from "./audit";
import { handleUnsubscribe } from "./email/unsubscribe";
import { notifyLive, openLive } from "./live";
import { sendWeeklySummaries } from "./email/weekly";
import { handleWholesale, handleWholesaleAdmin } from "./wholesale";
import { handleWholesaleAuth, wholesaleSession } from "./wholesaleAccounts";
import {handleWebhook} from "./quickbooks/webhooks";
import {processEvents,runQuickBooksJobs} from "./quickbooks/jobs";
import { QB_ROOT } from "./quickbooks/connection";
import { runAutoInvoicing } from "./autoInvoice";
import { runInvoiceBatches } from "./invoicing/batches";
import {trustedOrigin} from "./requestOrigins";
import { isWholesaleCode, wholesalePath } from "./hosts";
import { catalogueRetrievedAt } from "./wholesale/catalogue.js";
import { catalogue } from "./wholesaleCatalogue";
import { catalogueFor } from "./wholesaleWhiteLabel";
import { isRetailShopPath } from "./retailPreview";
import { BRANDED_RETAIL_ORIGIN, handleBrandedRetail } from "./brandedRetail";
import { noStore, pageRequest, staticFile, withFingerprints } from "./siteAssets";
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
    const readOnly = (req.method === "GET" || req.method === "HEAD")
      ? !sideEffectingRead(url.pathname)
      : req.method === "POST" && /^\/api\/db\/(get|query|poll|profiles)$/.test(url.pathname);
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
        if (e instanceof SessionUnavailableError) {
          res = json({ code: "session_unavailable", ref, message: "Sign-in could not be checked. Try again shortly." }, 503);
        } else if (/SQLITE_FULL|database or disk is full/i.test(msg)) {
          res = json({ code: "quota_exceeded", message: "The database is full." }, 507);
        } else {
          res = json({ code: "internal", ref, message: `Something went wrong on the server (error ${ref}). Try again; if it keeps happening, send a screenshot of this to whoever looks after the site.` }, 500);
        }
      }
    }
    // A write other devices should hear about: tell every open page (src/live.ts), after answering this one.
    if (res.ok && req.method !== "GET" && req.method !== "HEAD" && LIVE_WRITES.test(url.pathname)) ctx.waitUntil(notifyLive(env));
    // An opened live connection (101) goes back as it is: its WebSocket can't be copied into a new response.
    if (res.status === 101) return res;
    const brandedBrewGuide = url.origin === BRANDED_RETAIL_ORIGIN && url.pathname === "/brewguides/";
    return withSecurityHeaders(res, local, brandedBrewGuide);
  },

  queue: deliverIntegrationBatch,

  // The daily backup, and the managers' Monday summary (crons in wrangler.jsonc).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(ensureSchema(env).then(() => refreshInsights(env)).catch(error => {
        console.error("Insights snapshot refresh failed", error);
      }));
      return;
    }
    if(event.cron === "*/5 * * * *"){
      ctx.waitUntil(ensureSchema(env).then(async()=>{
        // Each job is tried again once if the database dropped out for a moment (it runs again in five minutes anyway);
        // a failure that's left is recorded with what went wrong, so it can be fixed.
        const run = async (name: string, task: () => Promise<unknown>) => {
          try { await task(); } catch (first) {
            let error = first;
            if (isTransient(first)) { await new Promise((r) => setTimeout(r, 1500)); try { await task(); return; } catch (again) { error = again; } }
            console.error(`Scheduled task failed: ${name}`, error);
            const e = error as Error;
            await recordError(env, { source: "server", app: "worker", page: "scheduled / five-minute jobs", message: `${name} did not complete.`, detail: [String(e?.message || e), ...(String(e?.stack || "").split("\n").slice(1, 8))].join("\n") });
          }
        };
        const domain = env.COOKIE_DOMAIN || "staffstrangerscoffee.com";
        const at = env.SLACK_TEST_HOOKS === "1" && env.HOLIDAY_NOW ? new Date(env.HOLIDAY_NOW) : new Date();
        await Promise.all([
          run("Standing-order recovery", () => repairStandingRuns(env)),
          run("Wholesale Slack notifications", () => deliverSlackPosts(env)),
          run("Dispatch emails", () => deliverDispatchEmails(env)),
          run("Automatic invoicing", () => runAutoInvoicing(env)),
          run("Invoice batches", () => runInvoiceBatches(env)),
          run("Staff email delivery", () => deliverStaffEmails(env)),
          run("Diary reminders", () => deliverDiaryReminders(env)),
          run("Holiday reminders", () => runHolidayReminders(env, { diary: `https://${domain}/`, rota: env.ROTA_HOST ? `https://${env.ROTA_HOST}/` : `https://${domain}/rota/` }, at)),
          run("QuickBooks jobs", async () => {
            if (env.QUICKBOOKS_CLIENT_ID || env.QUICKBOOKS_PRODUCTION_CLIENT_ID || await env.DB.prepare('SELECT 1 FROM quickbooks_app_settings WHERE data IS NOT NULL LIMIT 1').first()) await runQuickBooksJobs(env);
          }),
        ]);
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
} satisfies ExportedHandler<Env, IntegrationSignal>;

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
const LIVE_WRITES = /^\/api\/(db\/(set|update|delete)$|rota\/|admin\/(?!consumer(?:\/|$))|wholesale\/|staff-orders\/|assets)/;

/** A database error that's worth one more try: the connection dropped or D1 was busy restarting. */
function isTransient(e: unknown): boolean {
  return /network connection lost|connection reset|storage caused object to be reset|object to be reset|D1_ERROR: (internal|overloaded)|timed? ?out|Durable Object reset|try again/i.test(String((e as Error)?.message || e));
}

function sideEffectingRead(path: string): boolean {
  if (path === "/api/live" || /^\/api\/wholesale\/auth\/(?:invite|reset)$/.test(path)) return true;
  if (path === "/api/admin/wholesale/quickbooks-matches") return true;
  if (!path.startsWith(QB_ROOT + "/")) return false;
  // The callback consumes OAuth state. The provider reads can rotate the refresh token.
  const action = path.slice(QB_ROOT.length);
  return action === "/callback" || action === "/references" ||
    /^\/(?:invoices\/\d+\/preview|exports\/\d+\/billing-review)$/.test(action);
}

/** Moves the change counters that GET /api/changes reports, after the underlying write has committed. */
async function bumpChanges(env: Env, ctx: ExecutionContext, page: string, ...keys: string[]) {
  const bump = () => env.DB.prepare(`UPDATE meta SET v = v + 1 WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys).run();
  try {
    await bump();
  } catch (error) {
    // Preserve the write's response. Repeating a notification increment can only invalidate a cache again.
    ctx.waitUntil((async () => {
      let failure = error;
      if (isTransient(error)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          await bump();
          await notifyLive(env);
          return;
        } catch (retryError) {
          failure = retryError;
        }
      }
      console.error("Change counters failed after a successful write", failure);
      await recordError(env, { source: "server", app: "worker", page,
        message: "Change counters failed after a successful write.", detail: String((failure as Error)?.stack || failure) });
    })());
  }
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
// The rota app's page. Served at /rota/ on any host (local dev and tests) and at / on the rota's own host.
const rotaPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/rota/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
// The admin section's page. Served at / on its own host (ADMIN_HOST), and at /admin on the diary's when there's none.
const adminPage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/admin/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
const wholesalePage = (req: Request, env: Env, url: URL) => env.ASSETS.fetch(pageRequest(req,new URL("/wholesale/", url))).then(noStore).then((r) => withFingerprints(r, env, url));
const ADMIN_PAGES = new Set(["/admin", "/admin/", "/admin.html", "/admin/index.html"]);
const WHOLESALE_PAGES = new Set(["/wholesale", "/wholesale/", "/wholesale/index.html"]);
const OLD_WHOLESALE_DASHBOARD = new Set(["/wholesale/dashboard", "/wholesale/dashboard/", "/wholesale/dashboard/index.html"]);
async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const isGet = req.method === "GET" || req.method === "HEAD";
  const app = appForHost(url.hostname, env.ROTA_HOST, env.ADMIN_HOST, env.PREVIEW_HOST, env.LEGACY_PREVIEW_HOST);
  if (url.origin === BRANDED_RETAIL_ORIGIN) {
    // The retail hostname only serves its own routes. Shared-domain staff cookies cannot reach staff or
    // wholesale handlers here, including through old paths or a release's archived assets.
    const retail = await handleBrandedRetail(req, env, url, ctx);
    if (retail) return retail;
    if (isGet && url.pathname === "/robots.txt") return staticFile(req, env, url.pathname);
    if (isGet && (url.pathname === "/index.html" || /^\/shop(?:\/[\w%+-]+)*\/?$/i.test(url.pathname))) {
      return redirect("/" + url.search);
    }
    return new Response("Not found", { status: 404 });
  }
  if (app === "retail") return new Response("Not found", { status: 404 });

  const canonical = wholesalePath(url.pathname);
  if (isGet && canonical !== url.pathname) {
    const target = new URL(url); target.pathname = canonical;
    // Redirect old document links, retaining reset/invite/order queries. Serve old asset URLs directly so
    // cached module imports keep their relative base, conditional headers and fingerprint query intact.
    if (WHOLESALE_PAGES.has(canonical) || canonical === "/wholesale/signin" || canonical === "/wholesale/signin.html") return redirect(target.pathname + target.search);
    req = new Request(target, req); url = target;
  }
  const p = url.pathname;
  // Assets and auth routes have a single public entry point on the retail hostname.
  // Match encoded paths too so they cannot fall through to the general Assets binding.
  let assetPath = p;
  try { assetPath = decodeURIComponent(p); } catch { /* An invalid path cannot name an asset. */ }
  if (/^\/(?:consumer-preview|consumer-auth|consumer-social|signin-with-chatgpt|signout-with-chatgpt|api\/(?:account|retail))(?:\/|$)/.test(assetPath) ||
      /^\/_releases\/[a-f0-9]{20}\/consumer-preview(?:\/|$)/.test(assetPath)) {
    return new Response("Not found", { status: 404 });
  }
  if (p.startsWith("/_releases/")) {
    const asset = /^\/_releases\/[a-f0-9]{20}(\/[-\w/]+\.(?:js|css))$/.exec(p)?.[1];
    const publicCode = asset && !isRetailShopPath(asset) && (isPublicAsset(asset) || isPublicCode(app, asset) ||
      (app === "preview" && ["/theme.css", "/shared/core.js", "/shared/focus.js"].includes(asset)));
    if (!isGet || !asset || !publicCode) return new Response("Not found", { status: 404 });
    const response = await staticFile(req, env, asset);
    // The standalone reporter can recover an expired page without loading a mixture of old and new app modules.
    if (asset === "/errors.js" && response.status === 404) {
      await response.body?.cancel();
      return noStore(await env.ASSETS.fetch(pageRequest(req, new URL(asset, url))));
    }
    return response;
  }
  if (isRetailShopPath(p)) return new Response("Not found", { status: 404 });
  if (p === "/api/email/resend-webhook") return handleResendWebhook(req, env, () => ensureSchema(env));
  if(p.startsWith("/api/quickbooks/webhook/"))return handleWebhook(req,env,ctx,processEvents);
  const links = appLinks(url, env.ROTA_HOST, env.ADMIN_HOST, env.PREVIEW_HOST, env.LEGACY_PREVIEW_HOST);
  // The wholesale customer domain must not mint staff cookies or accept them for ordering.
  const staffDomain = (env.COOKIE_DOMAIN || "").toLowerCase().replace(/^\./, "");
  const customerOnly = app === "preview" && !!staffDomain && url.hostname !== staffDomain && !url.hostname.endsWith("." + staffDomain);
  if (customerOnly && p.startsWith("/api/") && !p.startsWith("/api/wholesale/") && p !== "/api/errors") throw new ApiError(404, "not_found", "Not available on the ordering address.");
  const wholesaleHost = app === "preview" || app === "diary";
  const wholesaleSignin = app === "preview" ? "/signin" : "/wholesale/signin";
  if (wholesaleHost && isGet && (p === "/wholesale/signin" || p === "/wholesale/signin.html" || (app === "preview" && (p === "/signin" || p === "/signin.html")))) {
    const response = await env.ASSETS.fetch(pageRequest(req,new URL("/wholesale/signin", url)));
    return withFingerprints(noStore(response), env, url);
  }
  // The privacy policy is public (QuickBooks and anyone signing up need to read it before having an account).
  for (const page of ["privacy", "terms"]) if (wholesaleHost && isGet && (p === `/wholesale/${page}` || p === `/wholesale/${page}.html` || (app === "preview" && (p === `/${page}` || p === `/${page}.html`)))) {
    const response = await env.ASSETS.fetch(pageRequest(req,new URL(`/wholesale/${page}`, url)));
    return withFingerprints(noStore(response), env, url);
  }
  if (wholesaleHost && isGet && p === "/wholesale/staff-signin") {
    if (app === "diary") return redirect("/signin?next=" + encodeURIComponent("/wholesale/"));
    const target = new URL("signin", new URL(links.diary, url));
    const next = customerOnly ? `https://${staffDomain}/wholesale/` : new URL(links.preview || "/wholesale/", url).href;
    target.searchParams.set("next", next);
    return redirect(target.toString());
  }
  // App code must load even when the session ends between HTML and its module requests. Otherwise the
  // browser receives sign-in HTML as JavaScript and cannot run its normal identity/redirect handling.
  // The source-price snapshot, catalogue API, customer images and every private page remain protected.
  if (wholesaleHost && isGet && (isWholesaleCode(p) || ["/theme.css", "/shared/core.js", "/shared/focus.js"].includes(p) || p === "/wholesale/images/logo.svg")) return staticFile(req, env, p);
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
      if (!trustedOrigin(origin,url,env)) throw new ApiError(403, "bad_origin", "That request came from another site.");
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
    if (browserMessagingNoise(b.message, b.detail)) return new Response(null, { status: 204 });
    // Record whether the requested file is available now. The original load could still have failed.
    let detail = b.detail;
    const missing = /^Couldn't load (\/[-\w./]+)$/.exec(String(b.message || ""))?.[1];
    if (missing && !missing.includes("..") && /\.(?:js|css|svg|png|ico|webmanifest)$/.test(missing)) {
      const served = await env.ASSETS.fetch(new Request(new URL(missing, url))).then(async (r) => { await r.body?.cancel(); return r.ok; }).catch(() => false);
      if (served) detail = FILE_SERVED;
    }
    const code = await recordError(env, { source: "page", app: b.app, page: b.page, message: b.message, detail, ua: req.headers.get("user-agent") || "", who: who?.name ?? null });
    return json({ code });
  }

  if (p.startsWith("/api/auth/")) return handleAuth(req, env, p.slice("/api/auth/".length), caller.kind === "user" ? caller : null);

  // Wholesale cookies have their own namespace and are never accepted by any staff route.
  const wholesaleScope = app === "preview" || (app === "diary" && (p.startsWith("/api/wholesale/") || WHOLESALE_PAGES.has(p) || OLD_WHOLESALE_DASHBOARD.has(p) || (p.startsWith("/wholesale/") && isPreviewFile(p))));
  if (wholesaleScope) {
    if (p.startsWith("/api/wholesale/auth/")) {
      if (!isGet) await limitWrites(req, env, ctx);
      const response = await handleWholesaleAuth(req, env, p.slice("/api/wholesale/auth/".length), ctx);
      if (!isGet && response.ok) await bumpChanges(env, ctx, p, "accounts");
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
      const response = await handleWholesale(req, env, p.slice("/api/wholesale/".length), user, links, ctx);
      if (!isGet && response.ok) await bumpChanges(env, ctx, p, "accounts");
      return response;
    }
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) throw new ApiError(404, "not_found", "Not available on the ordering address.");
    if (!isGet) return new Response("Method not allowed", { status: 405 });
    if (OLD_WHOLESALE_DASHBOARD.has(p) || p === "/dashboard" || p === "/dashboard/") {
      if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can open Wholesale in Admin.");
      return redirect(links.admin + "#wholesale");
    }
    if ((app === "preview" && (p === "/" || p === "/index.html")) || WHOLESALE_PAGES.has(p)) return p === "/wholesale" ? redirect("/wholesale/" + url.search) : wholesalePage(req, env, url);
    // Pre-migration cached order.js modules imported this snapshot. Preserve that authenticated import
    // without putting the price file back in public/ or exposing it through the data-free code allowlist.
    if (p === "/wholesale/catalogue.js") return noStore(new Response(
      `export const catalogueRetrievedAt = ${JSON.stringify(catalogueRetrievedAt)};\nexport const products = ${JSON.stringify(catalogueFor(await catalogue(env), user.role === "wholesale" ? user.customerId : null))};\n`,
      { headers: { "content-type": "application/javascript; charset=utf-8" } },
    ));
    if (/^\/wholesale\/images\/[\w-]+\.(webp|jpg|png)$/.test(p)) {
      if (user.role === "wholesale" && !catalogueFor(await catalogue(env), user.customerId).some(c => c.active && c.imageUrls.includes(p))) throw new ApiError(404, "not_found", "Coffee or photo not found.");
      return noStore(await env.ASSETS.fetch(req));
    }
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
    if(!isGet)await limitWrites(req,env,ctx,user.id);
    const response=await handleStaffOrders(req,env,p.slice("/api/staff-orders/".length),user,links,ctx);
    if(!isGet&&response.ok)await bumpChanges(env,ctx,p,"accounts");
    return response;
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
    if (!trustedOrigin(req.headers.get("origin"),url,env)) throw new ApiError(403, "bad_origin", "That request came from another site.");
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
    if (!isGet && res.ok) await bumpChanges(env, ctx, p, "rota");
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
      if (isAdminSharedFile(p)) {
        const asset = await env.ASSETS.fetch(req);
        return p.startsWith("/wholesale/images/") ? noStore(asset) : asset;
      }
      return redirect("/");
    }
  }

  if (p.startsWith("/api/admin/")) {
    if (user.role !== "admin") throw new ApiError(403, "permission_denied", "Only admins can do this.");
    const r = p.slice("/api/admin/".length);
    if (r === "backups" || r.startsWith("backups/")) return handleBackups(req, env, r.slice("backups/".length), user.name);
    if (r === "consumer" || r.startsWith("consumer/")) {
      if (!isGet) await limitWrites(req, env, ctx, user.id);
      const action = r === "consumer" ? "" : r.slice("consumer/".length);
      const response = await handleConsumerAdmin(req, env, action);
      if (!isGet && response.ok) ctx.waitUntil(audit(env, "consumer_preview", user.name, `Updated Consumer (Preview) ${action}`));
      return response;
    }
    let res;
    if (r === "wholesale" || r.startsWith("wholesale/")) {
      if (!isGet) await limitWrites(req, env, ctx, user.id);
      res = await handleWholesaleAdmin(req, env, r === "wholesale" ? "" : r.slice("wholesale/".length), user, links, ctx);
    } else res = (await handleAdminView(req, env, r, user, links)) ?? (await handleAdmin(req, env, r, user));
    // Accounts and sites show on the rota too (names, who's switched off, opening hours).
    if (!isGet && res.ok) await bumpChanges(env, ctx, p, "accounts", "rota");
    return res;
  }

  if (p.startsWith("/api/wholesale/")) {
    if (!isGet) await limitWrites(req, env, ctx, user.id);
    const response = await handleWholesale(req, env, p.slice("/api/wholesale/".length), user, links, ctx);
    if (!isGet && response.ok) await bumpChanges(env, ctx, p, "accounts");
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
    return p === "/wholesale" ? redirect("/wholesale/" + url.search) : wholesalePage(req, env, url);
  }
  // Pages behind sign-in must not be cached by shared devices' browsers or proxies.
  if (p === "/" || p === "/index.html") return withFingerprints(noStore(await env.ASSETS.fetch(pageRequest(req))), env, url);
  return staticFile(req, env, p);
}

function withSecurityHeaders(res: Response, local: boolean, brandedBrewGuide: boolean): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  // The server's time: pages run on it, not the device's clock (public/shared/core.js). Only on responses the
  // browser never keeps (no-store): a kept copy (the logo, for a day) would come back instantly with the time it was
  // first fetched and wind the page's clock back to it.
  if (/no-store/i.test(h.get("cache-control") || "")) h.set("x-now", String(Date.now())); else h.delete("x-now");
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("x-content-type-options", "nosniff");
  if (h.get("referrer-policy") !== "no-referrer") h.set("referrer-policy", "same-origin");
  h.set("cross-origin-resource-policy", "same-origin");
  // Only the site's own scripts run (no inline or third-party scripts), it only talks to itself, and it can't be framed.
  // Defence in depth: even if text someone typed into a record were ever shown as HTML, it couldn't run as script.
  h.set("content-security-policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ...(brandedBrewGuide ? ["frame-src https://www.youtube-nocookie.com"] : []),
  ].join("; "));
  if (!local) h.set("strict-transport-security", "max-age=31536000");
  return out;
}
