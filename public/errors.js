// Tells the site when something breaks on this device: a script error, a promise nobody caught, or a file (a
// script, stylesheet or image) that didn't load. Reports go to POST /api/errors (src/errors.ts) and show in
// Admin → Activity → Errors. Loaded first on every page. At most 10 a page, each only once; nothing about what
// someone typed, only the error's own message and where it happened.
(() => {
  "use strict";
  const p = location.pathname, h = location.hostname;
  const app = h.startsWith("rota.") || p.startsWith("/rota") ? "rota" : h.startsWith("admin.") || p.startsWith("/admin") ? "admin" : p.startsWith("/signin") ? "signin" : "diary";
  const seen = new Set();
  let sent = 0;
  function report(message, detail) {
    const m = String(message || "Unknown error").slice(0, 300);
    if (sent >= 10 || seen.has(m)) return;
    seen.add(m); sent++;
    const body = JSON.stringify({ app, page: p + (location.hash.split("/")[0] || ""), message: m, detail: String(detail || "").slice(0, 2000) });
    try { fetch("/api/errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch (e) { /* nothing more to do */ }
  }
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) { report("Couldn't load " + String(t.src || t.href).replace(location.origin, "").split("?")[0]); return; }
    report(e.message || "Script error", (e.error && e.error.stack) || (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ""));
  }, true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // Not reaching the server and being signed out are handled by the pages themselves.
    if (r && (r.code === "unavailable" || r.code === "unauthenticated" || r.name === "AbortError")) return;
    report("Unhandled: " + ((r && r.message) || String(r)), r && r.stack);
  });
  window.SCReportError = report;
})();
