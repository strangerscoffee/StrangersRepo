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
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const own = url.startsWith("/") || url.startsWith(location.origin);
    // The device's own clock goes with requests to the site, so the server can flag a device that's far out.
    if (own) { init = Object.assign({}, init); const h = new Headers(init.headers || (typeof input !== "string" && input.headers) || {}); h.set("x-device-time", String(RealDate.now())); init.headers = h; }
    const t0 = RealDate.now();
    const res = await realFetch(input, init);
    const t1 = RealDate.now(), server = own ? Number(res.headers.get("x-now")) : NaN;
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
    return res;
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
  // Signs out on the server too (src/auth.ts), then goes to sign-in.
  async function signOut() { try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) { /* signing out here anyway */ } location.replace("/signin"); }
  // Safari can bring a page back from memory (going back to a tab) after the session has ended: check, and call
  // signedOut (go to sign-in) rather than show a page that can't load anything.
  function recheckOnPageshow(signedOut) {
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) fetch("/api/auth/me").then((r) => r.json()).then((me) => { if (!me.user) signedOut(); }).catch(() => {});
    });
  }

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
    goSignIn, signOut, recheckOnPageshow, watchChanges, live, clockOffset,
  });
})();
