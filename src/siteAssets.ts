interface AssetEnv { ASSETS: Fetcher }

/*
 * Fingerprinted files. Each page's scripts and stylesheets are linked as /diary/core.js?v=<the file's own hash> (from its
 * ETag), and a file asked for with ?v= is kept by the browser for a year: opening a page again costs no requests for
 * them at all, and a changed file has a new address, so a deploy reaches everyone straight away. Hashes are looked up
 * once per Worker instance (a deploy starts new ones).
 */
const fingerprints = new Map<string, string>();
async function fingerprint(env: AssetEnv, url: URL, path: string): Promise<string | null> {
  if (fingerprints.has(path)) return fingerprints.get(path)!;
  const res = await env.ASSETS.fetch(new Request(new URL(path, url)));
  const tag = res.ok ? (res.headers.get("etag") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) : "";
  await res.body?.cancel();
  if (!tag) return null;
  fingerprints.set(path, tag);
  return tag;
}
/** A page (HTML) with its own scripts and stylesheets linked by fingerprint. */
export function withFingerprints(res: Response, env: AssetEnv, url: URL, aliases?: ReadonlyMap<string, string>): Response {
  if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return res;
  const pin = (attr: string) => ({
    async element(e: Element) {
      const v = e.getAttribute(attr);
      if (!v || !/^\/[^/?#]*(\/[^/?#]+)*\.(js|css)$/.test(v)) return; // only this site's own files
      const tag = await fingerprint(env, url, aliases?.get(v) ?? v);
      if (tag) e.setAttribute(attr, `${v}?v=${tag}`);
    },
  });
  return new HTMLRewriter().on("script[src]", pin("src")).on('link[rel="stylesheet"][href]', pin("href")).transform(res);
}

/** A file from public/. Fingerprinted ones (?v=) are kept for a year; otherwise scripts and styles for a minute, then
 * checked again, and images for a day. */
export async function staticFile(req: Request, env: AssetEnv, p: string): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  if (!res.ok || !/\.(js|css|svg|png|ico|webmanifest)$/.test(p)) return res;
  const out = new Response(res.body, res);
  const pinned = new URL(req.url).searchParams.has("v");
  out.headers.set("cache-control", pinned ? "private, max-age=31536000, immutable" : /\.(svg|png|ico)$/.test(p) ? "private, max-age=86400" : "private, max-age=60, must-revalidate");
  return out;
}

export const noStore = (res: Response) => {
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "private, no-store");
  out.headers.delete("etag"); out.headers.delete("last-modified");
  return out;
};
export function pageRequest(req: Request, target: URL | string = req.url): Request {
  const fresh = new Request(target, req);
  fresh.headers.delete("if-none-match");
  fresh.headers.delete("if-modified-since");
  return fresh;
}
