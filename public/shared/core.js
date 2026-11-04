// Helpers shared by the three apps: the diary (public/diary/), the rota (public/rota/) and the admin section
// (public/admin/). A classic script loaded before each app's own scripts; it defines one global, window.SC, and
// nothing else. Only what is the same in every app that uses it lives here: an app with different needs keeps its
// own (the diary's dates are the device's local days, the admin section builds HTML only through its escaping
// html`` template).
(() => {
  "use strict";

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
  function watchChanges(ms, keyOf, canRedraw, redraw, now) {
    let known = null, pending = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const c = await fetch("/api/changes").then((r) => (r.ok ? r.json() : null));
        if (!c) return;
        const key = keyOf(c);
        if (known !== null && key !== known) pending = true;
        known = key;
        if (pending && canRedraw()) { pending = false; redraw(); }
      } catch (e) { /* offline: try again next time */ }
    };
    setInterval(check, ms);
    if (now) check();
  }

  window.SC = Object.freeze({
    $, el, kids, svgi, initials, makeToast,
    dOf, isoOf, addDays, dow, monday, londonToday, londonNow,
    goSignIn, signOut, recheckOnPageshow, watchChanges,
  });
})();
