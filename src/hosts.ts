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
