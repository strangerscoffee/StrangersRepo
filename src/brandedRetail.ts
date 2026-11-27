import { type Env, ApiError, json, readBytes } from "./http";
import { cleanEmail } from "./email/address";
import { sendRetailAccountMail } from "./retailAccountMail";
import { retailInstagram } from "./retailInstagram";
import { retailServicePublicKey, retailServiceRequest } from "./retailService";
import { readConsumerCatalogue, retailCatalogueResponse, retailProductPhoto } from "./consumerCatalogue";
import { noStore, staticFile, withFingerprints } from "./siteAssets";
import { applyStaticConsumerFields, customConsumerContent, applyConsumerFooterLinks } from "./consumerEditorStatic";
import { applyConsumerPageMetadata } from "./consumerEditorMetadata";
import { readPublishedConsumerEditor, readPublishedConsumerMedia } from "./consumerEditorClient";
import { PAGES as EDITOR_PAGES, customPageForKey, pageForPath, type ConsumerEditorPage } from "../public/consumer-preview/assets/editor-model.js";
import { productFromPath, productPath, type ProductRoute } from "../public/consumer-preview/assets/product-paths.js";

export const BRANDED_RETAIL_ORIGIN = "https://preview.staffstrangerscoffee.com";
const ACCOUNT_ORIGIN = "https://strangers-coffee-retail-demo.magicloom512.chatgpt.site";
const SESSION_COOKIE = "__Host-strangers_consumer_session";
const MAX_SESSION_SECONDS = 4 * 60 * 60;
const PROOF = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const AUTH_ROUTE = /^\/consumer-auth\/(register|setup|login|forgot|reset|logout)$/;
const ORDER_ROUTE = /^\/api\/retail\/orders(?:\/(SC-[A-F0-9]{8}))?$/;
const ASSET = /^(?:\/_releases\/[0-9a-f]{20})?\/consumer-preview\/assets\/[a-z0-9][a-z0-9_.-]{0,110}\.(?:css|js|svg|webp|woff2|txt)$/i;
const PAGES = new Set([
  "/", "/coffee/", "/checkout/", "/account/", "/location/", "/about/", "/brewguides/", "/contact/",
  "/shipping/", "/privacy-policy/", "/terms-conditions/",
]);
function proof(value: unknown): value is string {
  return typeof value === "string" && PROOF.test(value);
}

function cookie(req: Request, name: string): string {
  const prefix = name + "=";
  return req.headers.get("cookie")?.split(";").map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function setCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(destination: string, status = 302): Response {
  const headers = new Headers({ location: destination, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  return new Response(null, { status, headers });
}

function unavailable(): Response {
  return json({ error: "retail_unavailable", message: "The preview account service is temporarily unavailable. Please try again." }, 503);
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed" }, 405, { Allow: allow });
}

// This connection carries only the minimum fields needed for a retail request. Staff and wholesale
// session cookies, browser identity headers, and arbitrary upstream redirects never cross it.
async function accountService(path: string, method = "GET", session = "", body?: string, origin?: string) {
  const headers = new Headers({ accept: "application/json" });
  if (session) headers.set("authorization", "Bearer " + session);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (origin) headers.set("origin", origin);
  try {
    const response = await fetch(ACCOUNT_ORIGIN + path, {
      method, headers, body, redirect: "manual", signal: AbortSignal.timeout(8000),
    });
    return await serviceResult(response, 2 * 1024 * 1024);
  } catch {
    return null;
  }
}

async function serviceResult(response: Response, limit: number) {
  if ((response.status >= 300 && response.status < 400)
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    return null;
  }
  const bytes = await readBytes(response, limit, "The preview account response was too large.");
  const data: unknown = JSON.parse(decode(bytes));
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return { status: response.status, data: data as Record<string, unknown>, retryAfter: response.headers.get("retry-after") };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function authApi(req: Request, env: Env, action: string, ctx?: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");
  if (req.headers.get("origin") !== BRANDED_RETAIL_ORIGIN) {
    return json({ error: "bad_origin", message: "Open My Account to make this change." }, 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") || "")) {
    return json({ error: "unsupported_media_type", message: "Send this request as JSON." }, 415);
  }
  const sendingLink = action === "register" || action === "forgot";
  if (sendingLink && !env.RESEND_API_KEY) return unavailable();
  const bytes = await readBytes(req, 2048, "The account request was too large.");
  let body: string;
  try {
    body = decode(bytes);
  } catch {
    return json({ error: "invalid_json", message: "This request must use UTF-8." }, 400);
  }

  const current = cookie(req, SESSION_COOKIE);
  const signedOut = () => json({ signedIn: false }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
  if (action === "logout" && !proof(current)) return signedOut();
  let result;
  try {
    const upstream = await retailServiceRequest(env, "/consumer-auth-service/" + action, {
      method: "POST", body, client: req.headers.get("cf-connecting-ip"),
      session: action === "logout" ? current : undefined,
    });
    result = await serviceResult(upstream, 8192);
  } catch {
    return action === "logout" ? signedOut() : unavailable();
  }
  if (action === "logout") return signedOut();
  if (!result) return unavailable();
  if (result.status >= 400) {
    const code = result.data.error;
    const message = result.data.message;
    const headers = new Headers();
    if (result.retryAfter && /^\d{1,6}$/.test(result.retryAfter)) headers.set("retry-after", result.retryAfter);
    return json({
      error: typeof code === "string" ? code : "retail_auth_unavailable",
      message: typeof message === "string" ? message : "The account service could not complete this request.",
    }, result.status, headers);
  }
  if (sendingLink && result.status === 202) {
    const mail = result.data.mail as { kind?: unknown; email?: unknown; token?: unknown } | undefined;
    const kind = action === "register" ? "verify" : "reset";
    const email = typeof mail?.email === "string" ? cleanEmail(mail.email) : "";
    if (email && mail?.kind === kind && proof(mail.token)) {
      const delivery = sendRetailAccountMail(env, BRANDED_RETAIL_ORIGIN, kind, email, mail.token);
      if (ctx) ctx.waitUntil(delivery);
      else await delivery;
    }
    return json({ accepted: true }, 202);
  }
  const session = result.data.session as { token?: unknown; expiresIn?: unknown } | undefined;
  const seconds = session?.expiresIn;
  if (result.status !== 200 || !proof(session?.token) || typeof seconds !== "number"
      || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SESSION_SECONDS) return unavailable();
  return json({ signedIn: true }, 200, { "set-cookie": setCookie(SESSION_COOKIE, session.token, seconds) });
}

// The browser receives a one-way session binding, never the upstream bearer.
async function profileBinding(session: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("retail-profile:" + session));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function accountApi(req: Request, path: string): Promise<Response> {
  const profile = path === "/api/account";
  const writing = req.method === (profile ? "PUT" : "POST");
  if (!writing && !(profile && req.method === "GET")) return methodNotAllowed(profile ? "GET, PUT" : "POST");
  if (writing && req.headers.get("origin") !== BRANDED_RETAIL_ORIGIN) {
    return json({ error: "bad_origin", message: "Open checkout or My Account to make this change." }, 403);
  }
  const session = cookie(req, SESSION_COOKIE);
  if (!proof(session)) return json({ error: "sign_in_required", message: "Sign in to open your account." }, 401);

  let body: string | undefined;
  if (writing) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") || "")) {
      return json({ error: "unsupported_media_type", message: "Send this request as JSON." }, 415);
    }
    const bytes = await readBytes(req, 24 * 1024, "The account request was too large.");
    try {
      body = decode(bytes);
    } catch {
      throw new ApiError(400, "invalid_json", "This request must use UTF-8.");
    }
  }

  const binding = await profileBinding(session);
  if (writing && req.headers.get("x-retail-profile-session") !== binding) {
    return json({ error: profile ? "account_changed" : "checkout_session_changed",
      message: "Your account session changed. Open the page again before continuing." }, 409);
  }
  const result = await accountService(path, req.method, session, body, writing ? BRANDED_RETAIL_ORIGIN : undefined);
  if (!result) return unavailable();
  // A delayed read from a revoked session must leave a newer sign-in cookie intact.
  if (profile && !writing && result.status === 200) return json({ ...result.data, profileSession: binding }, 200);
  return json(result.data, result.status);
}

async function availability(): Promise<Response> {
  const result = await accountService("/consumer-bridge/availability");
  if (!result || result.status !== 200 || !Array.isArray(result.data.unavailable)) return unavailable();
  const unavailableIds = result.data.unavailable.filter((id): id is string =>
    typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(id)).slice(0, 100);
  return json({ unavailable: unavailableIds });
}

async function retailWriteApi(req: Request, env: Env, path: string, maxBytes: number): Promise<Response> {
  const support = path === "/consumer-support-service/message";
  if (req.method !== "POST") return methodNotAllowed("POST");
  if (req.headers.get("origin") !== BRANDED_RETAIL_ORIGIN) {
    return json({ error: "bad_origin", message: "Open this page on the retail preview." }, 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") || "")) {
    return json({ error: "unsupported_media_type", message: "Send this request as JSON." }, 415);
  }
  const bytes = await readBytes(req, maxBytes, "The request was too large.");
  let body: string;
  try {
    body = decode(bytes);
  } catch {
    throw new ApiError(400, "invalid_json", "This request must use UTF-8.");
  }
  const expectedSession = req.headers.get("x-retail-profile-session");
  const session = support || expectedSession === "guest" ? "" : cookie(req, SESSION_COOKIE);
  if (!support && expectedSession !== "guest" && (!proof(session) || expectedSession !== await profileBinding(session))) {
    return json({ error: "checkout_session_unverified", message: "Your account session changed. Review the checkout under the correct account." }, 409);
  }
  try {
    const response = await retailServiceRequest(env, path, {
      method: "POST", body, client: req.headers.get("cf-connecting-ip"),
      session: proof(session) ? session : undefined,
    });
    const result = await serviceResult(response, 128 * 1024);
    if (result) {
      const headers = new Headers({ "referrer-policy": "no-referrer" });
      if (result.retryAfter && /^\d{1,6}$/.test(result.retryAfter)) headers.set("retry-after", result.retryAfter);
      return json(result.data, result.status, headers);
    }
  } catch {
    // A retry with the same checkout key can safely recover an uncertain response.
  }
  return json({ error: "retail_unavailable", message: support ? "The contact form is temporarily unavailable. Try again shortly." :
    "Checkout is temporarily unavailable. Try again to confirm this order." }, 503);
}

async function retailPage(req: Request, env: Env, url: URL, page = url.pathname, product?: ProductRoute, catalogue?: ProductRoute[]): Promise<Response> {
  const path = "/consumer-preview" + page;
  const custom = /^\/pages\/([a-z0-9-]+)\/$/.exec(url.pathname)?.[1];
  // The released design is display data only. An unavailable editor must leave the shop usable.
  const [asset, release] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL(path, url), { method: req.method })),
    req.method === "HEAD" && !custom ? null : readPublishedConsumerEditor(env).catch(() => undefined),
  ]);
  if (!asset.ok || !(asset.headers.get("content-type") || "").startsWith("text/html")) {
    await asset.body?.cancel();
    return new Response("The consumer storefront is temporarily unavailable.", { status: 503 });
  }
  let response = noStore(asset);
  if (page === "/account/" || page === "/checkout/") response.headers.set("referrer-policy", "no-referrer");
  // The marker makes checkout check the saved profile before taking an order. The account API
  // verifies the actual session before returning customer data or accepting any write.
  const scope = custom ? "custom:" + custom : product ? "product:" + product.id : pageForPath(url.pathname) ?? "home";
  const pages = release?.document.pages ?? {};
  if (custom && !Object.hasOwn(pages, scope)) {
    await response.body?.cancel();
    return new Response(null, {status:release === undefined ? 503 : 404, headers:{"cache-control":"no-store"}});
  }
  const relevant = ["shared", ...(product ? ["product"] : []), scope, "finder", "cart"];
  const selectedPages = Object.fromEntries(relevant.filter(key => key && Object.hasOwn(pages, key))
    .map(key => [key, pages[key]]));
  const navigation = Object.entries(pages).filter(([id, page]) => id.startsWith("custom:") && page.inNavigation === true)
    .map(([id, page]) => ({href:"/pages/" + id.slice(7) + "/", title:page.title}));
  // Product cards can appear in the catalogue, homepage, cart, finder or a merchant's new shelf.
  // Give the renderer only their published merchandising fields, not unrelated pages' editorial content.
  const productFields = Object.fromEntries(Object.entries(pages).filter(([id]) => id.startsWith("product:"))
    .map(([id, config]) => [id, {fields:Object.fromEntries(Object.entries(config.fields ?? {}).filter(([key]) =>
      ["product-title","product-image","product-image-alt","product-description","note-1","note-2","note-3"].includes(key)))}] as const)
    .filter(([, config]) => Object.keys(config.fields).length));
  function definition(key: string, config: ConsumerEditorPage, generic?: ConsumerEditorPage) {
    const builtIn = EDITOR_PAGES[key] ?? (key.startsWith("product:") ? EDITOR_PAGES.product : undefined);
    const meta = builtIn ?? customPageForKey(key,config.title);
    if (!meta) return null;
    const fields = builtIn?.fields.filter(f => Object.hasOwn(config.fields ?? {}, f.id)
      || Object.hasOwn(generic?.fields ?? {}, f.id)).map(({id,kind,selector}) => ({id,kind,selector})) ?? [];
    const needsSections = (item?: ConsumerEditorPage) => item && (item.sections?.length || item.widgets?.length ||
      item.hidden?.length || Object.keys(item.sectionLayouts ?? {}).length);
    const sections = needsSections(config) || needsSections(generic)
      ? (builtIn?.sections ?? []).map(({id,selector,locked}) => ({id,selector,locked})) : [];
    return {root:meta.root, fields, sections};
  }
  const definitions = Object.fromEntries([...new Set(relevant)].map(key =>
    [key, definition(key, pages[key] ?? {}, key === scope && product ? pages.product : undefined)]));
  const design = release && (release.document.theme !== "heritage" || Object.keys(selectedPages).length || navigation.length || Object.keys(productFields).length)
    ? {schema:1, theme:release.document.theme, pages:selectedPages, navigation, productFields, scope, definitions} : null;
  if (response.body && (url.pathname === "/" || page === "/coffee/" || product || design || proof(cookie(req, SESSION_COOKIE)))) {
    const html = new HTMLRewriter();
    if (page === "/coffee/") html.on("[data-catalogue-gifts] [data-catalogue-id]", {element(element) { element.remove(); }});
    if (url.pathname === "/") html.on("#home-roasting-grid", {element(element) {
      // Editorial samples belong to the admin canvas. Shopper highlights use the current range.
      element.setInnerContent("");
    }});
    if (custom) {
      const title = pages[scope].title ?? custom;
      html.on("title", { element(e) { e.setInnerContent(title + " | Strangers Coffee"); } })
        .on('meta[name="description"]', { element(e) { e.setAttribute("content", title); } })
        .on("main", { element(e) {
          e.setAttribute("class", "consumer-custom-page");
          e.setInnerContent(customConsumerContent(pages[scope]), {html:true});
        } });
    }
    if (design) {
      applyStaticConsumerFields(html, "shared", selectedPages.shared);
      applyStaticConsumerFields(html, scope, selectedPages[scope]);
      applyConsumerFooterLinks(html, navigation);
      const encoded = JSON.stringify(design).replace(/</g, "\\u003c");
      const theme = selectedPages[scope]?.theme ?? (product ? selectedPages.product?.theme : undefined) ?? design.theme;
      html.on("html", { element(e) { e.setAttribute("data-consumer-theme", theme); } })
        .on("head", { element(e) {
          e.append('<link rel="stylesheet" href="/consumer-preview/assets/editor-render.css">' +
            '<script type="application/json" id="consumer-design">' + encoded + '</script>' +
            '<script type="module" src="/consumer-preview/assets/editor-presentation.js"></script>', {html: true});
        } });
    }
    if (proof(cookie(req, SESSION_COOKIE))) html.on("body", {
      element(element) { element.setAttribute("data-retail-signed-in", ""); },
    });
    if (product) html.on("title", { element(element) { element.setInnerContent(product.name + " | Strangers Coffee"); } });
    if (catalogue) html.on("head", { element(element) {
      const data = JSON.stringify({products: catalogue}).replace(/</g, "\\u003c");
      element.append('<script type="application/json" id="retail-catalogue">' + data + '</script>', {html:true});
    } });
    applyConsumerPageMetadata(html, {...(product ? selectedPages.product?.meta : {}), ...selectedPages[scope]?.meta});
    response = html.transform(response);
  }
  return withFingerprints(response, env, url);
}

export async function handleBrandedRetail(req: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response | undefined> {
  if (url.origin !== BRANDED_RETAIL_ORIGIN) return undefined;
  const path = url.pathname;
  const reading = req.method === "GET" || req.method === "HEAD";

  const mediaId = /^\/consumer-media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path)?.[1];
  if (mediaId) return reading ? readPublishedConsumerMedia(env, mediaId, req.method) : methodNotAllowed("GET, HEAD");
  if (path === "/api/account" || path === "/api/account/orders") return accountApi(req, path);
  const order = ORDER_ROUTE.exec(path);
  if (order) return retailWriteApi(req, env,
    "/consumer-orders-service/orders" + (order[1] ? "/" + order[1] : ""), order[1] ? 2048 : 24 * 1024);
  if (path === "/api/retail/support") return retailWriteApi(req, env, "/consumer-support-service/message", 12 * 1024);
  if (path === "/api/retail/products") return req.method === "GET" ? retailCatalogueResponse(env) : methodNotAllowed("GET");
  const productPhoto = /^\/consumer-product-media\/([a-f0-9]{64})$/.exec(path)?.[1];
  if (productPhoto) return reading ? retailProductPhoto(env, productPhoto, false, req.method) : methodNotAllowed("GET, HEAD");
  if (path === "/signin") return reading ? redirect("/account/") : methodNotAllowed("GET, HEAD");
  if (path === "/consumer-auth/service-key") {
    return req.method === "GET" ? retailServicePublicKey(env).catch(unavailable) : methodNotAllowed("GET");
  }
  const action = AUTH_ROUTE.exec(path)?.[1];
  if (action) return authApi(req, env, action, ctx);
  if (path === "/consumer-auth/availability") return req.method === "GET" ? availability() : methodNotAllowed("GET");
  const instagramPhoto = /^\/consumer-social\/photo\/([A-Za-z0-9_-]{3,35})$/.exec(path)?.[1];
  if (path === "/consumer-social/posts" || instagramPhoto) {
    if (!reading) return methodNotAllowed("GET, HEAD");
    return ctx ? retailInstagram(req, env, ctx, url, instagramPhoto)
      : json({ error: "feed_unavailable" }, 503);
  }
  if (ASSET.test(path)) {
    if (!reading) return methodNotAllowed("GET, HEAD");
    const conditionals = new Headers();
    for (const name of ["if-none-match", "if-modified-since"]) {
      const value = req.headers.get(name);
      if (value) conditionals.set(name, value);
    }
    return staticFile(new Request(url, { method: req.method, headers: conditionals }), env, path);
  }
  if (path === "/consumer-preview" || path.startsWith("/consumer-preview/") || path.startsWith("/consumer-auth/")) {
    return new Response("Not found", { status: 404 });
  }
  if (!reading) return undefined;
  if (path.startsWith("/pages/") && pageForPath(path)?.startsWith("custom:")) {
    if (!path.endsWith("/")) return redirect(path + "/" + url.search, 308);
    return retailPage(req, env, url, "/");
  }
  if (PAGES.has(path)) return retailPage(req, env, url);
  if (PAGES.has(path + "/")) return redirect(path + "/" + url.search, 308);
  if (/^\/coffee\/p\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(path)) {
    if (!path.endsWith("/")) return redirect(path + "/" + url.search, 308);
    const voucher = productFromPath(path);
    if (voucher?.id === "online-gift-card" || voucher?.id === "in-store-gift-card") {
      return retailPage(req, env, url, "/product/", voucher);
    }
    const catalogue = await readConsumerCatalogue(env);
    if (!catalogue) return new Response("The product catalogue is temporarily unavailable. Please try again.", {
      status: 503, headers: {"cache-control":"no-store","retry-after":"30"},
    });
    const product = catalogue.find(item => productPath(item) === path);
    if (product) return retailPage(req, env, url, "/product/", product, catalogue);
  }
  return undefined;
}
