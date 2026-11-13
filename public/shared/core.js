// Helpers shared by the three apps: the diary (public/diary/), the rota (public/rota/) and the admin section
// (public/admin/). A classic script loaded before each app's own scripts; it defines window.SC, and makes the
// page's clock the server's (see "the time" below). Only what is the same in every app that uses it lives here: an app with different needs keeps its
// own (the diary's dates are the device's local days, the admin section builds HTML only through its escaping
// html`` template).
(() => {
  "use strict";

  /* ---------- the time: the server's, in UK time ----------
   * Every page runs on the server's clock, not the device's: a shop iPad left on manual time, the wrong time zone
   * or a clock reset by a flat battery would otherwise put readings on the wrong day or at the wrong time. Every
   * response from the site says the server's time (the x-now header, src/index.ts); each page works out how far
   * its device is off and from then on Date.now() and new Date() (with no arguments) give the server's time,
   * everywhere on the page. The last difference is remembered, so it holds offline too. Dates and times are then
   * shown in UK time (Europe/London), whatever time zone the device is set to. */
  const RealDate = Date;
  let offset = 0, bestRtt = Infinity, learnedAt = 0;
  try { const c = JSON.parse(localStorage.getItem("sc.clock") || "null"); if (c && Number.isFinite(c.offset)) offset = c.offset; } catch (e) {}
  class ServerDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = ServerDate;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
    const own = !!url && new URL(url, location.origin).origin === location.origin;
    const path = own ? new URL(url, location.origin).pathname : "";
    const protectedCall = /^\/api\/(?:db\/|admin\/|rota\/|staff-orders\/|wholesale\/|assets(?:\/|$))/.test(path) || /^\/api\/auth\/(?:pin|notifications\/seen)$/.test(path);
    if (protectedCall && sessionIdentity) {
      if (!(await ensureSession())) throw sessionError();
      init = Object.assign({}, init);
      const headers = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
      for (const [key, value] of Object.entries(sessionHeaders())) if (!headers.has(key)) headers.set(key, value);
      init.headers = headers;
    }
    const generation = sessionGeneration;
    // The device's own clock goes with requests to the site, so the server can flag a device that's far out.
    if (own) { init = Object.assign({}, init); const h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {}); h.set("x-device-time", String(RealDate.now())); init.headers = h; }
    const t0 = RealDate.now();
    const res = await (/^\/api\/auth\/(?:me|logout)$/.test(path) ? authRequest(input, init) : realFetch(input, init));
    if (path === "/api/auth/me" && res.ok) {
      const me = await res.clone().json().catch(() => null);
      rememberCookieDomain(me && me.cookieDomain);
    }
    if (protectedCall && sessionIdentity) {
      if (res.status === 401) invalidateSession(true);
      if (res.status === 409 && (await res.clone().json().catch(() => null))?.code === "session_changed") invalidateSession();
      if (sessionInvalid || ((sessionLocked || generation !== sessionGeneration) && !(await ensureSession()))) throw sessionError();
    }
    if (/^\/api\/auth\/(?:login|switch|change|setup|recover|logout)$/.test(path) && res.ok) notifyAuthChange();
    if (/^\/api\/wholesale\/auth\/(?:login|change-password|invite|logout)$/.test(path) && res.ok) notifyAuthChange();
    // Only from answers the browser never keeps (no-store, the API): a kept file comes back instantly with the time
    // it was first fetched, which would win as the quickest reading and put the page on an earlier day.
    const fresh = own && /no-store/i.test(res.headers.get("cache-control") || "");
    const t1 = RealDate.now(), server = fresh ? Number(res.headers.get("x-now")) : NaN;
    if (Number.isFinite(server) && server > 0) {
      // The quickest round trips give the best reading; take a new one at least every 10 minutes regardless.
      const rtt = t1 - t0;
      if (rtt <= bestRtt * 1.5 || t1 - learnedAt > 600000) {
        const was = offset;
        offset = server - (t0 + t1) / 2; bestRtt = Math.min(bestRtt, rtt); learnedAt = t1;
        try { localStorage.setItem("sc.clock", JSON.stringify({ offset })); } catch (e) {}
        // A change of more than a minute (the first reading on a device that's out): pages re-check the date.
        if (Math.abs(offset - was) > 60000) dispatchEvent(new Event("sc-clock"));
      }
    }
    return protectedCall && sessionIdentity ? guardResponse(res, generation) : res;
  };
  /** How far this device's own clock is from the server's, in ms (positive: the device is slow). */
  const clockOffset = () => offset;

  /* ---------- the page ---------- */

  const $ = (s, root = document) => root.querySelector(s);

  // An element, safely: text goes in as text, on* entries become event listeners, true/false/null attributes are
  // set empty or left out. Children may be nodes, strings or arrays of them; null and false are left out.
  const el = (t, a = {}, ...kids) => {
    const e = document.createElement(t);
    for (const [k, v] of Object.entries(a)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "value") e.value = v;
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  };

  // Children for the native append/replaceChildren, which would write null as the text "null": leaves out null and false.
  const kids = (...a) => a.filter((k) => k != null && k !== false);

  // A 24×24 line icon from its SVG path(s).
  const svgi = (d) => { const n = document.createElementNS("http://www.w3.org/2000/svg", "svg"); n.setAttribute("viewBox", "0 0 24 24"); n.setAttribute("class", "i"); n.setAttribute("aria-hidden", "true"); n.innerHTML = d; return n; };

  // "Alex Brown" -> "AB" (an avatar's letters).
  const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  // A short message in #toast. With an action (e.g. ["Undo", fn]) it stays longer and shows a button. ms: how long a
  // message without an action stays.
  function makeToast(ms) {
    let timer;
    return function toast(m, action) {
      const t = $("#toast"); t.hidden = true; void t.offsetWidth;
      t.replaceChildren(el("span", { text: m }), action ? el("button", { type: "button", onclick: () => { t.hidden = true; action[1](); } }, action[0]) : "");
      t.hidden = false; clearTimeout(timer); timer = setTimeout(() => (t.hidden = true), action ? 7000 : ms);
    };
  }

  /* ---------- dates in Europe/London (YYYY-MM-DD; arithmetic in UTC so daylight saving never shifts a day) ---------- */

  const dOf = (s) => new Date(s + "T12:00:00Z");
  const isoOf = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = dOf(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
  const dow = (s) => (dOf(s).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = (s) => addDays(s, -dow(s));
  const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const londonNow = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());

  /* ---------- the session ---------- */

  // To the sign-in page, coming back to `next` (by default, here) once signed in.
  function goSignIn(next = location.pathname + location.search + location.hash) {
    location.replace("/signin?next=" + encodeURIComponent(next));
  }
  // Identity is immutable account ID + current role, never the display name used for diary attribution.
  const SESSION_EVENT = "sc.session.event", LOGOUT_KEY = "sc.logout.pending", LOGOUT_COOKIE = "sfbb_logout_pending";
  let sessionIdentity = null, sessionLocked = false, sessionInvalid = false, sessionGeneration = 0;
  let sessionCheck = null, sessionCheckedAt = 0, sessionEnabled = false, sessionSignedOut = goSignIn, logoutTask = null, cookieDomain = "";
  const sessionClearers = new Set(), sessionWaiters = new Set();
  let startupTask = null, wakeStartup = null, retryTimer = null, retryAttempt = 0, resumeTimer = null;
  let sessionScope = "staff";
  const sessionUrl = () => sessionScope === "wholesale" ? "/api/wholesale/session" : "/api/auth/me";
  const sessionData = raw => sessionScope === "wholesale" ? { ...raw, user: Object.hasOwn(raw || {}, "user") ? raw.user : raw?.me ?? null } : raw;
  async function authRequest(input, init = {}) {
    const controller = new AbortController(), outer = init.signal;
    const abort = () => controller.abort();
    if (outer?.aborted) abort(); else outer?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    try {
      const response = await realFetch(input, { ...init, signal: controller.signal });
      await response.clone().arrayBuffer(); // Bound the whole reply, including a stalled response body.
      return response;
    } finally { clearTimeout(timeout); outer?.removeEventListener("abort", abort); }
  }
  function guardResponse(response, generation) {
    for (const method of ["json", "text", "blob", "arrayBuffer", "formData"]) {
      if (typeof response[method] !== "function") continue;
      const read = response[method].bind(response);
      Object.defineProperty(response, method, { value: async (...args) => {
        const result = await read(...args);
        if (sessionInvalid || ((sessionLocked || generation !== sessionGeneration) && !(await ensureSession()))) throw sessionError();
        return result;
      } });
    }
    const clone = response.clone.bind(response);
    Object.defineProperty(response, "clone", { value: () => guardResponse(clone(), generation) });
    return response;
  }
  function rememberCookieDomain(domain) {
    if (typeof domain === "string" && (domain === "" || location.hostname === domain || location.hostname.endsWith("." + domain))) cookieDomain = domain;
  }
  function logoutIntent() {
    // A customer's host-only identity is separate from any pending staff-domain sign-out.
    if (sessionScope === "wholesale" && sessionIdentity?.role === "wholesale") return "";
    const cookie = document.cookie.match(/(?:^|;\s*)sfbb_logout_pending=([^;]*)/);
    if (cookie) { try { return decodeURIComponent(cookie[1]) || "1"; } catch (_) { return "1"; } }
    try { return localStorage.getItem(LOGOUT_KEY) || ""; } catch (_) { return ""; }
  }
  function setLogoutIntent(value) {
    try { if (value) localStorage.setItem(LOGOUT_KEY, value); else localStorage.removeItem(LOGOUT_KEY); } catch (_) {}
    const attrs = "; Path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    if (cookieDomain) document.cookie = LOGOUT_COOKIE + "=; Max-Age=0" + attrs;
    document.cookie = LOGOUT_COOKIE + "=" + encodeURIComponent(value) + attrs + (cookieDomain ? "; Domain=" + cookieDomain : "") + "; Max-Age=" + (value ? "2592000" : "0");
  }
  const sessionError = () => Object.assign(new Error(sessionInvalid ? "The signed-in account changed. Reload to continue." : "Verify your sign-in before continuing."), { code: sessionInvalid ? "session_changed" : "session_unverified" });
  function loadingView(message = "Loading…") {
    if (!document.getElementById("sc-loader-style")) {
      const style = el("style", { id: "sc-loader-style" });
      style.textContent = 'html[data-sc-session-locked] body>:not(#sc-session-shield),html[data-sc-session-locked] body>:not(#sc-session-shield) *{visibility:hidden!important;pointer-events:none!important}#sc-session-shield{box-sizing:border-box;position:fixed;inset:0;z-index:2147483647;margin:0;width:100vw;max-width:none;height:100dvh;max-height:none;border:0;border-radius:0;display:grid;place-content:center;justify-items:center;gap:20px;padding:32px;text-align:center;background:var(--bg,#edf1f6);color:var(--fg,#17212f);font:16px system-ui}#sc-session-shield[hidden],#sc-session-shield button[hidden]{display:none}@media(prefers-color-scheme:dark){#sc-session-shield{background:var(--bg,#05070b);color:var(--fg,#f0f3f8)}}';
      document.head.append(style);
    }
    return el("div", { class: "sc-loading" }, el("span", { class: "sc-loading-logo", role: "img", "aria-label": "Strangers Coffee" }), el("span", { class: "sc-loading-track", "aria-hidden": "true" }), el("p", { "data-loading-message": "" }, message));
  }
  function retrySession() {
    if (!sessionIdentity && wakeStartup) { wakeStartup(); return; }
    if (logoutIntent()) return finishLogout();
    return ensureSession({ force: true });
  }
  function sessionShield(message = "Checking your sign-in…", error = false) {
    if (!sessionEnabled) return;
    sessionLocked = true; sessionGeneration++;
    document.documentElement.setAttribute("data-sc-session-locked", "");
    let box = document.getElementById("sc-session-shield");
    if (!box && document.body) {
      box = el("dialog", { id: "sc-session-shield", role: "status", "aria-live": "polite" }, loadingView(message), el("button", { type: "button", onclick: retrySession, hidden: true }, "Try again"));
      box.addEventListener("cancel", event => event.preventDefault());
      document.body.append(box);
    }
    if (box) {
      box.hidden = false; if (!box.open) box.showModal(); box.dataset.phase = error ? "error" : "checking";
      box.setAttribute("aria-busy", String(!error));
      box.querySelector("[data-loading-message]").textContent = message;
      box.querySelector("button").hidden = !error;
    }
  }
  function settleSessionWaiters(value) { for (const resolve of sessionWaiters) resolve(value); sessionWaiters.clear(); }
  function scheduleSessionRetry() {
    clearTimeout(retryTimer);
    if (sessionInvalid || !sessionLocked || document.hidden || navigator.onLine === false || logoutIntent()) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (!document.hidden) ensureSession({ force: true }); }, Math.min(1000 * 2 ** retryAttempt++, 15000));
  }
  function unlockSession() {
    if (sessionInvalid || logoutIntent()) return;
    clearTimeout(retryTimer); retryTimer = null; retryAttempt = 0;
    sessionLocked = false; document.documentElement.removeAttribute("data-sc-session-locked");
    const box = document.getElementById("sc-session-shield"); if (box) { if (box.open) box.close(); box.hidden = true; }
    settleSessionWaiters(true);
  }
  function invalidateSession(signedOut = false, navigate = true) {
    if (sessionInvalid) return false;
    sessionShield(signedOut ? "Signed out. Opening sign-in…" : "Your sign-in changed. Reloading…"); sessionInvalid = true;
    clearTimeout(retryTimer); clearTimeout(resumeTimer); settleSessionWaiters(false); wakeStartup?.();
    for (const dialog of document.querySelectorAll("dialog[open]:not(#sc-session-shield)")) try { dialog.close(); } catch (_) {}
    for (const clear of sessionClearers) try { clear(); } catch (_) {}
    dispatchEvent(new CustomEvent("sc:session-invalid"));
    if (navigate) { if (signedOut) sessionSignedOut(); else location.reload(); }
    return true;
  }
  async function bindSession(user, { clear } = {}) {
    sessionEnabled = true;
    if (typeof clear === "function") sessionClearers.add(clear);
    if (!user || typeof user.id !== "string" || typeof user.role !== "string") { invalidateSession(true); return false; }
    if (sessionIdentity && (sessionIdentity.id !== user.id || sessionIdentity.role !== user.role)) { invalidateSession(); return false; }
    if (sessionInvalid) return false;
    sessionIdentity = { id: user.id, role: user.role }; sessionCheckedAt = 0;
    sessionShield();
    if (logoutIntent()) { sessionShield("Finishing sign out…"); finishLogout(); return false; }
    // A transient proof failure keeps startup pending. A successful retry resumes this same bootstrap.
    const verified = new Promise(resolve => sessionWaiters.add(resolve));
    ensureSession({ force: true });
    return verified; // The startup reply may predate a switch; no render or queue load before fresh proof.
  }
  async function startSession({ clear, scope = "staff" } = {}) {
    if (!startupTask) sessionScope = scope === "wholesale" ? "wholesale" : "staff";
    if (sessionInvalid) return null;
    if (typeof clear === "function") sessionClearers.add(clear);
    sessionEnabled = true;
    if (!startupTask) startupTask = (async () => {
      for (let attempt = 0; !sessionInvalid; attempt++) {
        sessionShield();
        try {
          const response = await fetch(sessionUrl(), { cache: "no-store" });
          if (response.status === 401) { invalidateSession(true); return null; }
          if (!response.ok) throw new Error();
          const me = sessionData(await response.json());
          if (!me || !("user" in me)) throw new Error();
          if (me.user === null) { invalidateSession(true); return null; }
          if (!me.user || typeof me.user.id !== "string" || typeof me.user.role !== "string") throw new Error();
          return await bindSession(me.user, { clear }) ? me : null;
        } catch (_) {
          if (sessionInvalid) return null;
          sessionShield("Couldn't verify your sign-in. Reconnect, then try again.", true);
          await new Promise(resolve => {
            const timer = setTimeout(finish, Math.min(1000 * 2 ** attempt, 15000));
            function finish() { clearTimeout(timer); if (wakeStartup === finish) wakeStartup = null; resolve(); }
            wakeStartup = finish;
          });
        }
      }
      return null;
    })();
    const me = await startupTask;
    return me && await ensureSession() ? me : null; // Never release cached bootstrap metadata after a switch or failed logout.
  }
  function sessionHeaders() { return sessionIdentity ? (sessionScope === "wholesale" ? { "x-expected-ordering-id": sessionIdentity.id, "x-expected-ordering-role": sessionIdentity.role } : { "x-expected-user-id": sessionIdentity.id, "x-expected-user-role": sessionIdentity.role }) : {}; }
  async function ensureSession({ force = false } = {}) {
    if (!sessionEnabled || !sessionIdentity) return !sessionInvalid && !logoutIntent();
    if (sessionInvalid || logoutIntent()) return false;
    if (!force && !sessionLocked && RealDate.now() - sessionCheckedAt < 15000) return true;
    if (sessionCheck) return sessionCheck;
    clearTimeout(retryTimer); retryTimer = null;
    if (sessionLocked) sessionShield();
    sessionCheck = (async () => {
      try {
        for (;;) {
          if (sessionInvalid || logoutIntent()) return false;
          const generation = sessionGeneration;
          const response = await authRequest(sessionUrl(), { cache: "no-store", headers: { "x-sc-session-check": "1" } });
          if (response.status === 401) { invalidateSession(true); return false; }
          if (!response.ok) throw new Error();
          const me = sessionData(await response.json()); rememberCookieDomain(me.cookieDomain);
          // A switch/focus event during this request means its cookie snapshot is already obsolete.
          if (generation !== sessionGeneration) continue;
          if (!me.user) { invalidateSession(true); return false; }
          if (me.user.id !== sessionIdentity.id || me.user.role !== sessionIdentity.role) { invalidateSession(); return false; }
          sessionCheckedAt = RealDate.now(); unlockSession(); return !sessionInvalid && !logoutIntent();
        }
      } catch (_) { if (!sessionInvalid) { sessionShield("Couldn't verify your sign-in. Reconnect, then try again.", true); scheduleSessionRetry(); } return false; }
      finally { sessionCheck = null; }
    })();
    return sessionCheck;
  }
  function notifyAuthChange() {
    try { localStorage.setItem(SESSION_EVENT, JSON.stringify({ nonce: Math.random().toString(36).slice(2), at: RealDate.now() })); } catch (_) {}
    if (sessionIdentity && !sessionInvalid) { sessionShield(); if (!logoutIntent()) ensureSession({ force: true }); }
  }
  async function finishLogout() {
    if (logoutTask) return logoutTask;
    sessionEnabled = true; sessionShield("Finishing sign out…");
    logoutTask = (async () => {
      try {
        const owner = logoutIntent();
        const response = await authRequest("/api/auth/logout", { method: "POST", headers: owner && owner !== "1" ? { "x-expected-user-id": owner } : {} });
        const changed = response.status === 409 && (await response.clone().json().catch(() => null))?.code === "session_changed";
        if (!response.ok && !changed) throw new Error();
        setLogoutIntent("");
        const leaving = invalidateSession(true, false); // Clear locally before broadcasting; never start another local /me check.
        notifyAuthChange();
        if (leaving) location.replace("/signin");
        return true;
      } catch (_) { sessionShield("Sign out hasn't finished. Reconnect, then try again. Your screen is protected.", true); return false; }
      finally { logoutTask = null; }
    })();
    return logoutTask;
  }
  async function signOut() {
    setLogoutIntent(sessionIdentity?.id || "1"); notifyAuthChange(); return finishLogout();
  }
  // Shield before a browser saves/restores an old page; no private cache is shown until ID and role are verified.
  function recheckOnPageshow(signedOut) {
    sessionEnabled = true; sessionSignedOut = signedOut || goSignIn; sessionShield();
  }
  const resumeSession = () => {
    if (!sessionEnabled || sessionInvalid) return;
    if (!sessionIdentity) { wakeStartup?.(); return; }
    // Invalidate every activation immediately, even if an earlier proof is still in flight.
    // Start the request after a burst of focus/pageshow/visibility events has settled.
    sessionShield(); clearTimeout(resumeTimer);
    if (document.hidden) return;
    resumeTimer = setTimeout(() => { resumeTimer = null; if (logoutIntent()) finishLogout(); else ensureSession({ force: true }); }, 0);
  };
  addEventListener("pagehide", () => { if (sessionIdentity) sessionShield(); });
  addEventListener("blur", () => { if (sessionIdentity) sessionShield(); });
  addEventListener("focus", () => resumeSession());
  addEventListener("pageshow", (event) => { if (event.persisted) resumeSession(); });
  document.addEventListener("visibilitychange", () => { if (!sessionIdentity) return; if (document.hidden) sessionShield(); else resumeSession(); });
  addEventListener("online", () => resumeSession(true));
  addEventListener("storage", (event) => { if (event.key === SESSION_EVENT || event.key === LOGOUT_KEY) resumeSession(true); });
  setInterval(() => { if (sessionIdentity && !document.hidden && !sessionInvalid) { if (logoutIntent()) finishLogout(); else ensureSession({ force: true }); } }, 15000);

  /* ---------- several devices at once ---------- */

  // Every `ms` while the page is in view, asks GET /api/changes whether something changed elsewhere (keyOf picks
  // the counters this page cares about) and, once it may (canRedraw: nothing open or half typed), calls redraw.
  // now: also check straight away.
  /* Live updates (GET /api/live, src/live.ts): one WebSocket per page that the server uses to say the moment
   * anything changes, with the change counters ({docs, rota, accounts}, as GET /api/changes). While it's open, pages
   * stop asking every few seconds and only check now and then; when it drops (no signal, the phone locked, a
   * deploy), they ask as before until it's back. Listeners get the counters, or {open: true|false}. */
  const liveFns = new Set();
  let ws = null, wsOpen = false, retries = 0, retryT = null, lastPong = 0;
  const tell = (m) => { for (const f of liveFns) try { f(m); } catch (e) { console.error(e); } };
  function liveConnect() {
    if (ws || document.hidden || !("WebSocket" in window)) return;
    clearTimeout(retryT);
    try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live"); } catch (e) { ws = null; return; }
    const me = ws;
    me.onopen = () => { wsOpen = true; retries = 0; lastPong = Date.now(); tell({ open: true }); };
    me.onmessage = (e) => {
      if (e.data === "pong") { lastPong = Date.now(); return; }
      let c = null;
      try { c = JSON.parse(e.data); } catch (_) {}
      if (c && typeof c.docs === "number") tell(c);
    };
    me.onclose = () => {
      if (ws !== me) return;
      const was = wsOpen;
      ws = null; wsOpen = false;
      if (was) tell({ open: false });
      if (!document.hidden) retryT = setTimeout(liveConnect, Math.min(30000, 1000 * 2 ** retries++));
    };
    me.onerror = () => {};
  }
  // A keep-alive every 25 s (answered by the server without waking it); no answer for a while means the line is dead.
  setInterval(() => {
    if (!ws || !wsOpen) return;
    if (Date.now() - lastPong > 70000) { ws.close(); return; }
    try { ws.send("ping"); } catch (e) {}
  }, 25000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) liveConnect(); });
  addEventListener("online", () => { retries = 0; liveConnect(); });
  /** Listens for live changes; returns whether the line is open right now. */
  function live(fn) {
    if (fn) liveFns.add(fn);
    liveConnect();
    return { open: () => wsOpen };
  }

  // While the live line is open, checks only this often anyway (in case a message was missed).
  const LIVE_CHECK_MS = 60000;
  function watchChanges(ms, keyOf, canRedraw, redraw, now) {
    let known = null, pending = false, last = 0;
    const seen = (c) => {
      const key = keyOf(c);
      if (known !== null && key !== known) pending = true;
      known = key;
      if (pending && canRedraw()) { pending = false; redraw(); }
    };
    const check = async () => {
      if (document.hidden) return;
      last = Date.now();
      try {
        const c = await fetch("/api/changes").then((r) => (r.ok ? r.json() : null));
        if (c) seen(c);
      } catch (e) { /* offline: try again next time */ }
    };
    const line = live((m) => {
      if (m.open === true) check(); // anything missed while it was down
      else if (typeof m.docs === "number" && !document.hidden) seen(m);
    });
    setInterval(() => { if (!line.open() || Date.now() - last >= LIVE_CHECK_MS) check(); }, ms);
    if (now) check();
  }

  window.SC = Object.freeze({
    $, el, kids, svgi, initials, makeToast,
    dOf, isoOf, addDays, dow, monday, londonToday, londonNow,
    goSignIn, signOut, recheckOnPageshow, bindSession, startSession, loadingView, ensureSession, sessionHeaders, notifyAuthChange, watchChanges, live, clockOffset,
  });
})();
