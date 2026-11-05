// The three apps on one Worker: the diary on its own address, the rota on ROTA_HOST and the admin section on
// ADMIN_HOST (wrangler.jsonc). Kept free of imports so test/rota.test.mjs can load it directly. Re-exported from access.ts.

export type App = "diary" | "rota" | "admin";

/** Which app a hostname serves: the rota on ROTA_HOST, the admin section on ADMIN_HOST, the diary everywhere else. */
export function appForHost(hostname: string, rotaHost: string | undefined, adminHost?: string): App {
  const h = hostname.toLowerCase();
  if (rotaHost && h === rotaHost.toLowerCase()) return "rota";
  if (adminHost && h === adminHost.toLowerCase()) return "admin";
  return "diary";
}

/** The helpers all three apps share (public/shared/*.js: code, no data). */
export function isSharedCode(path: string): boolean {
  return /^\/shared\/[\w-]+\.js$/.test(path);
}

/** On the rota's hostname, files it may serve besides its own (/rota/…): the diary's shared styles and icons, and
 * the helpers all three apps share. */
export function isRotaSharedFile(path: string): boolean {
  return path === "/app.css" || path === "/ui.css" || path === "/theme.css" || path === "/pinpad.js" || path === "/robots.txt" ||
    path === "/logo.svg" || path === "/mark.svg" || /^\/icon-\d+\.png$/.test(path) || path.startsWith("/rota/") || isSharedCode(path);
}

/**
 * The diary's and the rota's scripts (with the helpers they share, /shared/…), styles and images (code, no data) load without a session, on their own
 * address. Safari can show a page from memory after the session has ended (going back to a tab); its files then
 * still load, and its script sends the person to sign in, instead of a page with no styles that does nothing.
 * Pages and every API still need sign-in; the admin section's files stay admin-only.
 */
export function isPublicCode(app: string, path: string): boolean {
  if (!/\.(js|css|svg|png|webmanifest)$/.test(path) || path.startsWith("/admin/")) return false;
  return app === "rota" ? isRotaSharedFile(path) : app === "diary";
}

/** On the admin section's hostname, files it may serve: its own (/admin/…), the shared theme and icons, and the
 * helpers all three apps share. */
export function isAdminSharedFile(path: string): boolean {
  return path === "/theme.css" || path === "/robots.txt" || path === "/logo.svg" || path === "/mark.svg" || isSharedCode(path) ||
    /^\/icon-\d+\.png$/.test(path) || (path.startsWith("/admin/") && path !== "/admin/" && path !== "/admin/index.html");
}

/** Links between the apps, as seen from this request. Without a ROTA_HOST or ADMIN_HOST (local dev, tests) the rota
 * is at /rota/ and the admin section at /admin on the diary's address. */
export function appLinks(url: URL, rotaHost: string | undefined, adminHost?: string): { rota: string; diary: string; admin: string } {
  const app = appForHost(url.hostname, rotaHost, adminHost);
  // The diary is the rota's (or admin section's) host without its first label (rota.example.com -> example.com).
  const other = rotaHost || adminHost || "";
  const diaryHost = other.includes(".") ? other.slice(other.indexOf(".") + 1) : url.hostname;
  return {
    rota: app === "rota" ? "/" : rotaHost ? `https://${rotaHost}/` : "/rota/",
    diary: app === "diary" ? "/" : `https://${diaryHost}/`,
    admin: app === "admin" ? "/" : adminHost ? `https://${adminHost}/` : "/admin",
  };
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
