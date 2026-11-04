// The two apps on one Worker: the diary on its own address, the rota on ROTA_HOST (wrangler.jsonc).
// Kept free of imports so test/rota.test.mjs can load it directly. Re-exported from access.ts.

/** Which app a hostname serves: the rota on ROTA_HOST, the diary everywhere else. */
export function appForHost(hostname: string, rotaHost: string | undefined): "rota" | "diary" {
  return rotaHost && hostname.toLowerCase() === rotaHost.toLowerCase() ? "rota" : "diary";
}

/** On the rota's hostname, files it may serve besides its own (/rota/…): the diary's shared styles and icons. */
export function isRotaSharedFile(path: string): boolean {
  return path === "/app.css" || path === "/ui.css" || path === "/theme.css" || path === "/pinpad.js" || path === "/robots.txt" ||
    path === "/logo.svg" || path === "/mark.svg" || /^\/icon-\d+\.png$/.test(path) || path.startsWith("/rota/");
}

/** Links between the two apps, as seen from this request. Without a ROTA_HOST (local dev, tests) the rota is at /rota/. */
export function appLinks(url: URL, rotaHost: string | undefined): { rota: string; diary: string } {
  if (!rotaHost) return { rota: "/rota/", diary: "/" };
  const onRota = appForHost(url.hostname, rotaHost) === "rota";
  // The diary is the rota host without its first label (rota.staffstrangerscoffee.com -> staffstrangerscoffee.com).
  const diaryHost = rotaHost.includes(".") ? rotaHost.slice(rotaHost.indexOf(".") + 1) : url.hostname;
  return { rota: onRota ? "/" : `https://${rotaHost}/`, diary: onRota ? `https://${diaryHost}/` : "/" };
}

/** One sign-in page for every staff address. On another subdomain of the shared cookie domain (COOKIE_DOMAIN: the
 * rota), /signin goes to the sign-in page on the domain itself, with next= as a full link back to where the person
 * was. Sign-in cookies are shared across the domain (src/auth.ts), so signing in there signs them in here too.
 * null: show the sign-in page on this address (the diary itself, local dev, or no shared domain). */
export function unifiedSignin(url: URL, cookieDomain: string | undefined): string | null {
  const d = (cookieDomain || "").trim().toLowerCase().replace(/^\./, "");
  const h = url.hostname.toLowerCase();
  if (!d || h === d || !h.endsWith("." + d)) return null;
  const n = url.searchParams.get("next") || "/";
  const back = n.startsWith("/") && !n.startsWith("//") ? n : "/";
  const target = new URL(`https://${d}/signin`);
  target.searchParams.set("next", `https://${h}${back}`);
  return target.toString();
}
