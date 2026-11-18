import { readBytes } from "./http";

type InstagramEnv = { RETAIL_INSTAGRAM_ACCESS_TOKEN?: string };

const homepage = "https://strangerscoffee.com/";
const graph = "https://graph.instagram.com/v22.0";
const postLimit = 6;
const feedSeconds = 900;
const mediaFields = "permalink,caption,media_type,media_url,thumbnail_url,timestamp";

interface Post {
  code: string;
  href: string;
  image: string;
  label: string;
}

function instagramLink(value: string | null | undefined): Pick<Post, "code" | "href"> | null {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]{3,35})\/?$/);
    return match ? { code: match[2], href: `https://www.instagram.com/${match[1]}/${match[2]}/` } : null;
  } catch { return null; }
}

function imageUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value || "");
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.hostname === "images.squarespace-cdn.com") {
      url.searchParams.set("format", "500w");
      return url.href;
    }
    if (url.hostname.endsWith(".cdninstagram.com") || url.hostname.endsWith(".fbcdn.net")) return url.href;
    return null;
  } catch { return null; }
}

function postLabel(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim().slice(0, 150) || "Strangers Coffee on Instagram";
}

async function graphRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(graph + path, {
    headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(4500),
  });
  if (!response.ok) throw new Error("Instagram is unavailable");
  return response.json<T>();
}

async function fromInstagram(token: string): Promise<Post[]> {
  const account = await graphRequest<{ user_id: string; username: string }>("/me?fields=user_id,username", token);
  if (account.username?.toLowerCase() !== "strangerscoffee" || !/^\d+$/.test(String(account.user_id))) return [];
  const result = await graphRequest<{ data: Array<{
    permalink: string; caption?: string; media_type: string; media_url?: string; thumbnail_url?: string; timestamp: string;
  }> }>(`/${account.user_id}/media?fields=${mediaFields}&limit=12`, token);
  return (result.data || []).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).flatMap(item => {
    const link = instagramLink(item.permalink);
    const image = imageUrl(item.media_type === "VIDEO" ? item.thumbnail_url : item.media_url);
    return link && image ? [{ ...link, image, label: postLabel(item.caption) }] : [];
  }).slice(0, postLimit);
}

async function fromPublicHomepage(): Promise<Post[]> {
  const response = await fetch(homepage, {
    headers: { accept: "text/html", "user-agent": "Strangers Coffee retail preview" },
    redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return [];
  const posts: Post[] = [];
  let active: Pick<Post, "code" | "href"> | null = null;
  const html = new HTMLRewriter().on("a[href]", { element(anchor) {
    active = instagramLink(anchor.getAttribute("href"));
    if (active) anchor.onEndTag(() => { active = null; });
  } }).on("a[href] img", { element(img) {
    if (!active || posts.length >= postLimit || posts.some(post => post.code === active?.code)) return;
    const image = imageUrl(img.getAttribute("data-src") || img.getAttribute("src"));
    if (image) posts.push({ ...active, image, label: postLabel(img.getAttribute("alt") || undefined) });
  } }).transform(response);
  await html.body?.pipeTo(new WritableStream<Uint8Array>());
  return posts;
}

let pending: Promise<Post[]> | undefined;
async function getPosts(url: URL, env: InstagramEnv, ctx: ExecutionContext): Promise<Post[]> {
  const key = new Request(new URL("/shop/instagram-cache", url));
  const cached = await caches.default.match(key).catch(() => undefined);
  if (cached) return cached.json<Post[]>();
  if (!pending) {
    pending = (async () => {
      const direct = env.RETAIL_INSTAGRAM_ACCESS_TOKEN
        ? await fromInstagram(env.RETAIL_INSTAGRAM_ACCESS_TOKEN).catch(() => []) : [];
      const posts = direct.length ? direct : await fromPublicHomepage().catch(() => []);
      const age = posts.length ? feedSeconds : 120;
      const body = Response.json(posts, { headers: { "cache-control": `public, max-age=${age}` } });
      await caches.default.put(key, body).catch(() => {});
      return posts;
    })().finally(() => { pending = undefined; });
    ctx.waitUntil(pending.catch(() => {}));
  }
  return pending;
}

export async function retailInstagram(req: Request, env: InstagramEnv, ctx: ExecutionContext, url: URL, code?: string): Promise<Response> {
  if (!code) {
    const posts = await getPosts(url, env, ctx);
    const headers = { "cache-control": `public, max-age=${posts.length ? feedSeconds : 120}` };
    if (req.method === "HEAD") return new Response(null, { headers: { ...headers, "content-type": "application/json" } });
    return Response.json({ posts: posts.map(({ code, href, label }) => ({ code, href, label })) }, { headers });
  }

  const key = new Request(new URL(`/shop/instagram-photo/${code}`, url));
  const cached = await caches.default.match(key).catch(() => undefined);
  if (cached) return req.method === "HEAD" ? new Response(null, cached) : cached;
  const post = (await getPosts(url, env, ctx)).find(item => item.code === code);
  if (!post) return new Response(null, { status: 404 });
  try {
    const remote = await fetch(post.image, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const type = remote.headers.get("content-type") || "";
    if (!remote.ok || !/^image\/(?:avif|jpeg|png|webp)(?:\s*;|$)/i.test(type)) throw new Error("Image unavailable");
    const bytes = await readBytes(remote, 2 * 1024 * 1024, "Instagram image is too large");
    const image = new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } });
    ctx.waitUntil(caches.default.put(key, image.clone()).catch(() => {}));
    return req.method === "HEAD" ? new Response(null, image) : image;
  } catch {
    return new Response(null, { status: 404 });
  }
}
