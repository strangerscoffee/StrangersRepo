import { type Env, ApiError } from "./http";
import { readConsumerCatalogue } from "./consumerCatalogue";
import { applyEditorPreviewSurfaces } from "./consumerEditorSurfaces";
import { PAGES, cataloguePageForKey, customPageForKey } from "../public/consumer-preview/assets/editor-model.js";

const assetPrefix = "/api/admin/consumer/editor/assets/";
const sourcePrefix = "/consumer-preview/assets/";
const sourceAsset = /^[a-z0-9][a-z0-9_.-]{0,110}\.(css|js|svg|webp|woff2)$/;
const htmlPages = new Set(["/", "/coffee/", "/location/", "/about/", "/brewguides/", "/contact/", "/shipping/",
  "/privacy-policy/", "/terms-conditions/", "/account/", "/checkout/"]);

function adminAsset(raw: string): string {
  return raw.replaceAll(sourcePrefix, assetPrefix);
}

/** Called only behind the Consumer administrator route. This serves source artwork and a scriptless
 * canvas, never account records. Its source becomes a sandboxed srcdoc on the same admin origin. */
export async function handleConsumerEditorCanvas(req: Request, env: Env, route: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError(405, "method_not_allowed", "Read this preview with GET.");
  if (route.startsWith("editor/assets/")) {
    const name = route.slice("editor/assets/".length);
    if (!sourceAsset.test(name)) throw new ApiError(404, "not_found", "Preview asset not found.");
    const res = await env.ASSETS.fetch(new Request(new URL(sourcePrefix + name, req.url), {method: req.method}));
    if (!res.ok) return new Response(null, {status: 404});
    const headers = new Headers(res.headers);
    headers.set("cache-control", "private, max-age=0, must-revalidate");
    if (!name.endsWith(".css") || req.method === "HEAD") return new Response(res.body, {headers});
    headers.delete("content-length"); headers.delete("content-encoding"); headers.delete("etag");
    return new Response(adminAsset(await res.text()), {headers});
  }
  const scope = new URL(req.url).searchParams.get("page") || "home";
  const page = Object.hasOwn(PAGES, scope) ? PAGES[scope] : customPageForKey(scope) ?? cataloguePageForKey(scope);
  if (route !== "editor/canvas" || !page) throw new ApiError(404, "not_found", "Preview page not found.");
  const p = page.path;
  const source = scope === "product" || scope.startsWith("product:") ? "/product/" : htmlPages.has(p) ? p : "/";
  const res = await env.ASSETS.fetch(new Request(new URL("/consumer-preview" + source, req.url), {method: req.method}));
  if (!res.ok) return new Response(null, {status: 404});
  const headers = {"cache-control":"private, no-store","content-type":"text/html; charset=utf-8","referrer-policy":"no-referrer"};
  if (req.method === "HEAD") return new Response(null, {headers});
  const state = new URL(req.url).searchParams.get("state") ?? undefined;
  const merchandising = scope === "shop" || scope === "home" || scope === "product" || scope.startsWith("product:");
  const catalogue = merchandising ? await readConsumerCatalogue(env) : null;
  if (scope.startsWith("product:") && !Object.hasOwn(PAGES, scope) && !catalogue?.some(item => "product:" + item.id === scope)) {
    await res.body?.cancel();
    throw new ApiError(catalogue ? 404 : 503, "preview_unavailable", "This product is unavailable in the current catalogue.");
  }
  const hydrated = applyEditorPreviewSurfaces(new HTMLRewriter(), scope, state, catalogue).transform(res);
  const clean = new HTMLRewriter();
  if (scope.startsWith("custom:")) clean.on("main", {element(e){
    e.setAttribute("class","consumer-custom-page");
    e.setInnerContent('<h1 class="consumer-page-title"></h1>', {html:true});
  }});
  const doc = clean.on("script,iframe,noscript", {element(e){e.remove();}})
    .on("img[src^='/consumer-product-media/']", {element(e){
      const src = e.getAttribute("src");
      if (src && /^\/consumer-product-media\/[a-f0-9]{64}$/.test(src)) e.setAttribute("src", src.replace("/consumer-product-media/", "/api/admin/consumer/product-photos/"));
    }})
    .on("form", {element(e){e.removeAttribute("action"); e.setAttribute("autocomplete","off");}})
    .on("input,textarea", {element(e){e.setAttribute("autocomplete","off"); e.setAttribute("readonly","");}})
    .on("a[target]", {element(e){e.removeAttribute("target");}})
    .on("head", {element(e){
      e.prepend('<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; connect-src \'none\'; object-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">', {html:true});
      e.append('<link rel="stylesheet" href="' + assetPrefix + 'editor-render.css">', {html:true});
    }}).transform(hydrated);
  return new Response(adminAsset(await doc.text()), {headers});
}
