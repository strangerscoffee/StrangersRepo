// Tells the site when something breaks on this device: a script error, a promise nobody caught, or a file (a
// script, stylesheet or image) that didn't load. Reports go to POST /api/errors (src/errors.ts) and show in
// Admin → Activity → Errors. Loaded first on every page. At most 10 a page, each only once; nothing about what
// someone typed, only the error's own message and where it happened.
//
// When it's a real fault (not an image), a small card on the screen says so, with the error's code (E-…), what and
// where: a screenshot of it is enough to find the error in the admin section and the line of code. The code is
// worked out here exactly as the Worker does (errorCode in src/errors.ts), so it shows even when the report can't
// be sent. The card is styled inline because a stylesheet that didn't load may be what went wrong.
(() => {
  "use strict";
  const p = location.pathname, h = location.hostname;
  const app = document.documentElement.dataset.scApp === "wholesale" ? "wholesale" : h.startsWith("rota.") || p.startsWith("/rota") ? "rota" : h.startsWith("admin.") || p.startsWith("/admin") ? "admin" : p.startsWith("/signin") ? "signin" : "diary";
  const APP = { diary: "Kitchen Diary", rota: "Rota", admin: "Admin", signin: "Staff Login", wholesale: "Strangers Wholesale" };
  const seen = new Set();
  let sent = 0;

  // The same as src/errors.ts: clip, the key, and FNV-1a to six base-32 characters.
  const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
  const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function codeOf(page, message) {
    const key = ["page", clip(app, 20) || "?", clip(page, 200).split("#")[0], clip(message, 300) || "Unknown error"].join("|").slice(0, 600);
    let x = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { x ^= key.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    let s = "";
    for (let i = 0; i < 6; i++) { s += C32[x & 31]; x >>>= 5; }
    return "E-" + s;
  }
  // The first line of a stack that's the site's own code: "/diary/today.js:123:45 in renderDay".
  function whereOf(detail) {
    for (const line of String(detail || "").split("\n")) {
      const m = line.match(/(?:https?:\/\/[^/\s]+)?(\/[\w./-]+\.(?:js|mjs))(?:\?v=[\w-]+)?:(\d+):(\d+)/);
      if (!m) continue;
      const fn = (line.match(/^\s*at (?:async )?([\w$.<>]+) \(/) || line.match(/^\s*([\w$.<>]+)@/) || [])[1];
      return `${m[1]}:${m[2]}:${m[3]}${fn ? " in " + fn : ""}`;
    }
    return "";
  }

  let card = null, extra = 0;
  function show(code, message, where) {
    if (card) { extra++; const more = card.querySelector("[data-more]"); if (more) more.textContent = `and ${extra} more error${extra === 1 ? "" : "s"} on this page`; return; }
    const dark = matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
    const fg = dark ? "#f2f5f9" : "#0b1220", muted = dark ? "#a2acba" : "#545f70";
    const mk = (tag, css, text) => { const e = document.createElement(tag); Object.assign(e.style, css); if (text != null) e.textContent = text; return e; };
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
    card = mk("div", { position: "fixed", left: "12px", right: "12px", bottom: "calc(12px + env(safe-area-inset-bottom, 0px))", zIndex: "2147483647", maxWidth: "460px", margin: "0 auto",
      background: dark ? "#1c2230" : "#ffffff", color: fg, border: "1px solid " + (dark ? "#3a4252" : "#d5dae2"), borderRadius: "16px", padding: "14px 16px",
      boxShadow: "0 10px 30px rgba(0,0,0,.25)", font: "14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", textAlign: "left" });
    card.id = "sc-error";
    card.setAttribute("role", "alert");
    card.append(
      mk("div", { fontWeight: "700", fontSize: "16px" }, "Something went wrong"),
      mk("div", { font: "700 20px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace", margin: "6px 0 4px", letterSpacing: ".04em", color: dark ? "#ff8a80" : "#c62828" }, code),
      mk("div", { wordBreak: "break-word" }, message.slice(0, 200)),
      where ? mk("div", { font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace", color: muted, marginTop: "4px", wordBreak: "break-all" }, where) : "",
      mk("div", { fontSize: "12px", color: muted, marginTop: "4px" }, `${APP[app] || app} · ${(p + location.hash).slice(0, 60)} · ${when}`),
      mk("div", { fontSize: "13px", marginTop: "8px" }, "Take a screenshot of this and send it to whoever looks after the site. Reloading usually gets you going again."),
    );
    const more = mk("div", { fontSize: "12px", color: muted, marginTop: "4px" }, "");
    more.dataset.more = "";
    const row = mk("div", { display: "flex", gap: "8px", marginTop: "10px" });
    const btn = (label, primary, fn) => { const b = mk("button", { flex: "1", font: "600 15px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif", padding: "11px 12px", borderRadius: "12px", border: "0", cursor: "pointer",
      background: primary ? (dark ? "#4ea4ff" : "#0062cc") : (dark ? "#2b3342" : "#eef1f5"), color: primary ? (dark ? "#03101f" : "#ffffff") : fg }, label); b.type = "button"; b.addEventListener("click", fn); return b; };
    row.append(btn("Reload", true, () => location.reload()), btn("Hide", false, () => { card.remove(); }));
    card.append(more, row);
    const put = () => (document.body || document.documentElement).appendChild(card);
    if (document.body) put(); else addEventListener("DOMContentLoaded", put, { once: true });
  }

  function report(message, detail, opts) {
    const m = String(message || "Unknown error").slice(0, 300);
    if (sent >= 10 || seen.has(m)) return;
    seen.add(m); sent++;
    const page = p + (location.hash.split("/")[0] || "");
    const code = codeOf(page, m);
    if (!(opts && opts.quiet)) show(code, m, whereOf(detail));
    const body = JSON.stringify({ app, page, message: m, detail: String(detail || "").slice(0, 2000) });
    try { fetch("/api/errors", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch (e) { /* nothing more to do */ }
    return code;
  }
  // Only the site's own code and files: anything from another address (a browser extension, or a script something
  // between here and the phone added, like Cloudflare's analytics beacon, which the site's security rules block on
  // purpose) says nothing about the site and isn't reported.
  const ours = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch (e) { return false; } };
  const ownFrame = detail => (String(detail || "").match(/https?:\/\/[^\s)]+|\/[\w./-]+\.(?:js|mjs)(?:\?[^\s)]*)?(?::\d+:\d+)?/g) || []).some(ours);
  const browserAutofill = (message, detail, file) => /^Could not find identifiable element\.?$/.test(message) && !(file && ours(file)) && !ownFrame(detail);
  const retriedBranding = new WeakSet();
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      const u = String(t.src || t.href);
      if (!ours(u)) return;
      const imageLink = t.tagName === "LINK" && (t.relList?.contains("icon") || t.relList?.contains("apple-touch-icon") || (t.relList?.contains("preload") && t.as === "image"));
      const image = t.tagName === "IMG" || imageLink;
      // A dropped logo request must not interrupt sign-in. Retry the original element once at a fresh URL;
      // retain a quiet report if that retry also fails. Scripts/styles keep their existing visible errors.
      if (image && /^\/(?:(?:logo|mark)\.svg|favicon\.ico|wholesale(?:-preview)?\/images\/logo\.svg)$/.test(new URL(u).pathname) && !t.srcset && t.isConnected && navigator.onLine !== false && !retriedBranding.has(t)) {
        retriedBranding.add(t);
        const retry = new URL(u); retry.searchParams.set("sc-asset-retry", "1");
        queueMicrotask(() => { if (t.isConnected) { if (t.tagName === "IMG") t.src = retry.href; else t.href = retry.href; } });
        return;
      }
      // A picture that didn't load is reported but doesn't interrupt anyone; a script or stylesheet breaks the page.
      report("Couldn't load " + u.replace(location.origin, "").split("?")[0], "", { quiet: image });
      return;
    }
    const msg = e.message || "Script error";
    // Chrome's harmless layout warning; "Script error." with no file is another site's script (browsers hide what it
    // was); and an error in a file from elsewhere isn't the site's.
    if (/ResizeObserver loop/.test(msg)) return;
    if (/^Script error\.?$/.test(msg) && !e.filename && !ownFrame(e.error && e.error.stack)) return;
    if (browserAutofill(msg, e.error && e.error.stack, e.filename)) return;
    if (e.filename && !ours(e.filename)) return;
    report(msg, (e.error && e.error.stack) || (e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : ""));
  }, true);
  // How each browser says a request didn't reach the server (Safari, Chrome, Firefox).
  const NETWORK = /^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|The network connection was lost\.?)$/;
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // Not reaching the server and being signed out are handled by the pages themselves.
    if (r && (r.code === "unavailable" || r.code === "unauthenticated" || r.name === "AbortError")) return;
    const msg = (r && r.message) || String(r);
    if (browserAutofill(msg, r && r.stack)) return;
    // A request that didn't get through (the signal dropped) and that nothing caught: worth fixing, so it's
    // reported, but it isn't put in front of anyone; the page carries on and tries again.
    report("Unhandled: " + msg, r && r.stack, { quiet: r && r.name === "TypeError" && NETWORK.test(msg) });
  });
  window.SCReportError = report;
})();
