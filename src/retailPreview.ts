import { retailInstagram } from "./retailInstagram";
import { noStore, pageRequest, staticFile, withFingerprints } from "./siteAssets";

interface RetailEnv {
  ASSETS: Fetcher;
  VERSION?: WorkerVersionMetadata;
  RETAIL_INSTAGRAM_ACCESS_TOKEN?: string;
}

const SHOP_PAGE = /^\/shop\/(?:(?:home|information|location|locations|brewguides|brew-guides|about|contact|shipping|privacy-policy|terms-conditions|wholesale|norwich-racing-team|basket|cart|checkout)\/|coffee\/(?:[a-z0-9-]+\/|p\/[a-z0-9-]+\/)?|blog\/(?:tag\/[a-z0-9+%_-]+\/|\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9-]+\/)?)?$/i;
const SHOP_FILE = /^\/shop\/(?:shop\.(?:css|js)|(?:catalogue|site-content)\.json|content\/[a-f0-9]{12}\.json|photos\/[a-z0-9-]+\.webp)$/;

const assetAliases = new Map([
  ["/shop/theme.css", "/theme.css"],
  ["/shop/logo.svg", "/logo.svg"],
  ["/shop/mark.svg", "/mark.svg"],
]);

export function isRetailShopPath(path: string): boolean {
  return path === "/shop" || path.startsWith("/shop/");
}

export async function serveRetailShop(req: Request, env: RetailEnv, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const path = url.pathname;
  if (path === "/shop/instagram.json") return retailInstagram(req, env, ctx, url);
  const instagramPhoto = path.match(/^\/shop\/instagram-photo\/([A-Za-z0-9_-]{3,35})$/);
  if (instagramPhoto) return retailInstagram(req, env, ctx, url, instagramPhoto[1]);

  const asset = assetAliases.get(path);
  if (asset) return staticFile(new Request(new URL(asset, url), req), env, asset);
  if (SHOP_FILE.test(path)) return staticFile(req, env, path);
  if (!path.endsWith("/") && SHOP_PAGE.test(path + "/")) return shopRedirect(path + "/" + url.search);
  if (!SHOP_PAGE.test(path)) return new Response("Not found", { status: 404 });
  const page = await env.ASSETS.fetch(pageRequest(req, new URL("/shop/", url)));
  return withFingerprints(noStore(page), env, url, assetAliases);
}

function shopRedirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    let response: Response;
    if (isRetailShopPath(url.pathname)) {
      response = await serveRetailShop(req, env, ctx, url);
    } else if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      response = shopRedirect("/shop/" + url.search);
    } else {
      response = new Response("Not found", { status: 404 });
    }
    const out = new Response(response.body, response);
    out.headers.set("x-retail-preview-worker", "strangers-dev-preview");
    if (env.VERSION) out.headers.set("x-retail-preview-version", env.VERSION.id);
    out.headers.set("x-robots-tag", "noindex, nofollow");
    out.headers.set("x-content-type-options", "nosniff");
    out.headers.set("referrer-policy", "same-origin");
    out.headers.set("cross-origin-resource-policy", "same-origin");
    const shop = url.origin + "/shop/";
    out.headers.set("content-security-policy", [
      "default-src 'none'", `script-src ${shop}`, `style-src ${shop}`, `img-src ${shop}`,
      `connect-src ${shop}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join("; "));
    return out;
  },
} satisfies ExportedHandler<RetailEnv>;
