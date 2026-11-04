// The staff rota (rota.staffstrangerscoffee.com): who works where and when across the four sites.
// Managers plan and publish each week; everyone sees their shifts, picks up open shifts, asks for cover and
// says when they can work. Talks to /api/rota/* (src/rota.ts) and /api/auth/* with fetch, like admin.js.
// Shares the diary's look: /app.css, /theme.css, /ui.css, plus rota.css.
(() => {
  "use strict";

  /* ---------- small helpers ---------- */

  // Shared with the diary and the admin section (public/shared/core.js): the page, dates in Europe/London, the session.
  const { $, el, svgi, initials, makeToast, dOf, addDays, dow, monday, londonToday, londonNow, goSignIn, signOut } = SC;
  const ICON = {
    week: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
    mine: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5"/>',
    swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    avail: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    requests: '<path d="M5 5h14v10H9l-4 4z"/><path d="M9 9h6M9 12h4"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    hours: '<path d="M5 20V10M10 20V4M15 20v-7M20 20v-4"/>',
    setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    diary: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    staff: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 11a3 3 0 100-6M21 20c0-3-1.8-5.2-4.5-5.8"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    out: '<path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
    chevR: '<path d="M9 6l6 6-6 6"/>', chevL: '<path d="M15 6l-6 6 6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4M12 13v4M10 15h4"/>',
    send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5L20 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    plane: '<path d="M3 13l18-7-7 18-2-8z"/>',
    hand: '<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7a6 6 0 01-6 6h-1a6 6 0 01-5-3l-2-3a1.5 1.5 0 012.5-1.6L8 13"/>',
  };
  const ROLE = { admin: "Admin", manager: "Manager", staff: "Staff" };
  const SITE_TONE = { roastery: "blue", cafe: "green", asg: "orange", factory: "purple" };
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // Dates are YYYY-MM-DD (SC.addDays, SC.monday: arithmetic in UTC so daylight saving never shifts a day).
  const fmt = (s, o) => dOf(s).toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
  const short = (s) => fmt(s, { weekday: "short", day: "numeric" }); // "Mon 9"
  const shortM = (s) => fmt(s, { weekday: "short", day: "numeric", month: "short" }); // "Mon 9 Nov"
  const longD = (s) => fmt(s, { weekday: "long", day: "numeric", month: "short" }); // "Thursday 12 Nov"
  const weekLabel = (w) => "Week of " + fmt(w, { day: "numeric", month: "long" });
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const r2 = (n) => Math.round(n * 100) / 100;
  const hrs = (n) => `${r2(n)}`;
  const first = (n) => String(n || "").split(" ")[0];
  const jobWord = (j) => (j === "opens" ? "Opens" : j === "closes" ? "Closes" : "");
  // A shift as worked: amended on the day, otherwise as planned.
  const effS = (s) => s.actualStart || s.start;
  const effE = (s) => s.actualEnd || s.end;
  const span = (s) => `${effS(s)}–${effE(s)}`;
  // Contracted hours as a range: "16–24", "20", "up to 24", "at least 16" (hours a week).
  const contractLabel = (p) => {
    const a = p.contractMin, b = p.contractMax;
    if (a != null && b != null) return a === b ? hrs(b) : `${hrs(a)}–${hrs(b)}`;
    if (b != null) return `up to ${hrs(b)}`;
    if (a != null) return `at least ${hrs(a)}`;
    return "";
  };
  // A site's hours on day i of the week (its own hours for that weekday, if it has them).
  const hoursOn = (site, i) => site.hours?.[i] || { opensAt: site.opensAt, closesAt: site.closesAt };
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b || a + "s"}`;
  const when = (ms) => {
    if (!ms) return "";
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const wide = matchMedia("(min-width:1024px)");

  const toast = makeToast(2600);

  /* ---------- talking to the Worker ---------- */

  const R = {
    me: null, auth: null, links: { rota: "/rota/", diary: "/" }, approvers: [], tab: "", week: monday(londonToday()),
    view: (() => { try { return localStorage.getItem("rota.view") || "site"; } catch (e) { return "site"; } })(),
    pday: dow(londonToday()), weekData: null, everyone: false, offline: false, badge: 0,
  };
  const mgr = () => !!R.me?.user?.manager;
  const isAdmin = () => !!R.me?.user?.admin;

  function setOffline(v) {
    if (R.offline === v) return;
    R.offline = v;
    document.body.classList.toggle("offline", v);
    const c = $("#conn");
    c.hidden = !v; c.textContent = "Offline · showing what was last loaded";
    if (!v) toast("Back online.");
  }
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      setOffline(true);
      throw Object.assign(new Error("Couldn't reach the rota. Check your connection."), { code: "unavailable" });
    }
    if (res.status === 401) { goSignIn(); throw new Error("Signed out."); }
    if (res.status >= 502 && res.status <= 504) { setOffline(true); throw Object.assign(new Error("The rota didn't respond. Try again."), { code: "unavailable" }); }
    setOffline(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || "Something went wrong."), data, { code: data.code, status: res.status });
    return data;
  }
  const get = (u) => api("GET", u);
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }
    catch (e) { toast(e.message || "Something went wrong."); return null; }
  }

  /* ---------- navigation ---------- */

  // Every page. mgr: managers and admins only. parent: where its back link goes.
  const PAGES = {
    week: { t: "Rota", nav: "Week", ic: "week", mgr: true },
    day: { t: "Day", ic: "week", mgr: true, parent: "week" },
    mine: { t: "My shifts", ic: "mine" },
    swaps: { t: "Open shifts & cover", nav: "Open shifts & cover", ic: "swap" },
    avail: { t: "When I can work", ic: "avail" },
    requests: { t: "Requests", ic: "requests", mgr: true },
    more: { t: "More", ic: "more", mgr: true },
    hours: { t: "Hours", ic: "hours", mgr: true, parent: "more" },
    settings: { t: "Rota settings", ic: "setup", mgr: true, parent: "more" },
  };
  const TABS = () => (mgr() ? ["week", "mine", "requests", "more"] : ["mine", "swaps", "avail"]);
  const allowed = (p) => PAGES[p] && (!PAGES[p].mgr || mgr());
  const tabOf = (p) => (TABS().includes(p) ? p : PAGES[p]?.parent && TABS().includes(PAGES[p].parent) ? PAGES[p].parent : mgr() ? "more" : p);

  function parseHash() {
    const [p, ...rest] = location.hash.replace(/^#/, "").split("/");
    return { page: p, args: rest };
  }
  function go(hash) { if (location.hash === "#" + hash) render(); else location.hash = hash; }

  function renderNav() {
    const cur = R.tab;
    const sn = $("#snav"); sn.replaceChildren();
    const link = (id, label, ic, badge) => el("a", { href: "#" + id, class: cur === id || tabOf(cur) === id && !TABS().includes(cur) && PAGES[cur]?.parent === id ? "on" : "", "aria-current": cur === id ? "page" : null },
      svgi(ICON[ic]), el("span", { text: label }), badge ? el("span", { class: "n pill bad", text: String(badge) }) : null);
    if (mgr()) {
      sn.append(link("week", "Week", "week"), link("mine", "My shifts", "mine"), link("requests", "Requests", "requests", R.badge),
        link("swaps", "Open shifts & cover", "swap"), link("avail", "When I can work", "avail"),
        el("div", { class: "h", text: "Manage" }), link("hours", "Hours", "hours"), link("settings", "Rota settings", "setup"));
    } else {
      sn.append(link("mine", "My shifts", "mine"), link("swaps", "Open shifts & cover", "swap"), link("avail", "When I can work", "avail"));
    }
    sn.append(el("div", { class: "h", text: "Kitchen Diary" }), el("a", { href: R.links.diary }, svgi(ICON.diary), el("span", { text: "Open the diary" })));
    const tb = $("#tabbar"); tb.replaceChildren();
    const label = { week: "Week", mine: "My shifts", swaps: "Open shifts", avail: "When I work", requests: "Requests", more: "More" };
    for (const t of TABS()) {
      const on = tabOf(cur) === t;
      tb.append(el("button", { type: "button", class: "tab" + (on ? " on" : ""), "aria-current": on ? "page" : null, onclick: () => go(t) },
        svgi(ICON[PAGES[t].ic]), el("span", { text: label[t] }), t === "requests" && R.badge ? el("span", { class: "n", text: String(R.badge) }) : null));
    }
  }

  // Each page sets its own heading; one that finishes loading after someone has moved on leaves it alone.
  function setHead(page, title, sub, { back, actions } = {}) {
    if (page !== R.tab) return;
    $("#pageTitle").textContent = title;
    $("#pageSub").textContent = sub || "";
    const b = $("#backBtn");
    b.hidden = !back;
    if (back) { b.replaceChildren(svgi(ICON.chevL), back[0]); b.onclick = () => go(back[1]); }
    $("#pageAction").replaceChildren(...(actions || []));
    document.title = "Strangers Coffee - Rota"; // the same tab name on every page
  }

  async function refreshBadge() {
    if (!mgr()) return;
    try {
      const r = await get("/api/rota/requests");
      R.badge = r.timeOff.length + r.requests.filter((q) => (q.kind === "claim" && q.status === "open") || (q.kind === "cover" && q.status === "accepted")).length;
      renderNav();
    } catch (e) { /* offline: keep the last count */ }
  }

  let renderSeq = 0;
  async function render() {
    let { page, args } = parseHash();
    if (!allowed(page)) page = mgr() ? "week" : "mine";
    R.tab = page;
    renderNav();
    closeSheets();
    document.body.dataset.page = page;
    const seq = ++renderSeq;
    // The last page's buttons in the heading would act on what it showed: clear them while this one loads.
    $("#pageAction").replaceChildren(); $("#backBtn").hidden = true;
    const box = $("#page");
    try {
      const out = await PAGE_RENDER[page](args);
      if (seq !== renderSeq) return;
      box.replaceChildren(...[out].flat().filter(Boolean));
    } catch (e) {
      if (seq !== renderSeq) return;
      box.replaceChildren(el("div", { class: "empty", text: e.message || "Couldn't load this page." }));
    }
  }
  const rerender = () => render();

  /* ---------- shared pieces ---------- */

  const sitePill = (id, name) => el("span", { class: "spill " + (SITE_TONE[id] || ""), text: name || id });
  const avatar = (name, cls = "") => el("span", { class: "avatar sm " + cls, text: initials(name), "aria-hidden": "true" });
  // A button whose action is still running is disabled, so a double tap can't do it twice.
  const btn = (label, onclick, cls = "btn", extra = {}) => el("button", { type: "button", class: cls, "data-w": "", ...extra, onclick: onclick && (async (e) => {
    const b = e.currentTarget;
    if (b.dataset.busy) return;
    const r = onclick(e);
    if (!r || typeof r.then !== "function") return;
    b.dataset.busy = "1"; b.disabled = true;
    try { await r; } finally { delete b.dataset.busy; if (b.isConnected) b.disabled = false; }
  }) }, label);
  const ghost = (label, onclick, extra) => btn(label, onclick, "btn ghost", extra);
  const label = (t) => el("div", { class: "label", text: t });
  const empty = (t) => el("div", { class: "empty", text: t });

  /** A button that asks once more before acting (the diary's two-tap delete). */
  function twoTap(text, confirmText, fn, cls = "btn ghost danger") {
    const b = btn(text, async () => {
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = confirmText; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = text; } }, 4000); return; }
      b.disabled = true; await fn(); b.disabled = false;
    }, cls);
    return b;
  }

  function seg(options, value, onchange, aria) {
    const box = el("div", { class: "seg rseg", role: "group", "aria-label": aria || "" });
    for (const [v, t] of options) box.append(el("button", { type: "button", "aria-pressed": String(v === value), onclick: () => onchange(v) }, t));
    return box;
  }

  function dayStrip(days, idx, onpick, marks = []) {
    const box = el("div", { class: "days glass", role: "group", "aria-label": "Day" });
    days.forEach((d, i) => box.append(el("button", {
      type: "button", class: "wday" + (i === idx ? " today" : "") + (marks[i] ? " " + marks[i] : ""), "aria-pressed": String(i === idx),
      "aria-label": longD(d) + (marks[i] === "bad" ? ", has problems" : marks[i] === "part" ? ", has warnings" : ""), onclick: () => onpick(i),
    }, fmt(d, { weekday: "narrow" }), el("b", { text: fmt(d, { day: "numeric" }) }), el("span", { class: "d" }))));
    return box;
  }

  /** "Mon–Fri", "Every day", "Mon, Wed". */
  function openDays(open) {
    const n = open.filter(Boolean).length;
    if (!n) return "Closed all week";
    if (n === 7) return "Every day";
    const idx = open.map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
    const ab = (i) => fmt(addDays("2026-11-09", i), { weekday: "short" });
    if (idx[idx.length - 1] - idx[0] === idx.length - 1) return `${ab(idx[0])}–${ab(idx[idx.length - 1])}`;
    return idx.map(ab).join(", ");
  }

  function downloadText(name, type, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /** An .ics file for one shift, in UK time. */
  function calendarFile(s) {
    const t = (day, hm) => day.replace(/-/g, "") + "T" + hm.replace(":", "") + "00";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const esc = (v) => String(v).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Strangers Coffee//Rota//EN", "CALSCALE:GREGORIAN",
      "BEGIN:VTIMEZONE", "TZID:Europe/London",
      "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100", "TZNAME:BST", "DTSTART:19700329T010000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
      "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0000", "TZNAME:GMT", "DTSTART:19701025T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", `UID:rota-${s.id}@strangerscoffee`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/London:${t(s.day, s.start)}`, `DTEND;TZID=Europe/London:${t(s.day, s.end)}`,
      `SUMMARY:${esc(`Strangers Coffee ${s.siteName}${s.job ? " · " + jobWord(s.job).toLowerCase() : ""}`)}`,
      s.note ? `DESCRIPTION:${esc(s.note)}` : null, "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean);
    downloadText(`shift-${s.day}-${s.site}.ics`, "text/calendar", lines.join("\r\n") + "\r\n");
  }

  const approverText = () => (R.approvers.length === 1 ? first(R.approvers[0]) : "A manager");

  /* ---------- sheets and the account menu ---------- */

  function closeSheets() {
    $("#sheetVeil").hidden = true; $("#sheet").hidden = true; $("#peopleSheet").hidden = true; $("#acctMenu").hidden = true;
  }
  function openSheet(title, body, { left, right } = {}) {
    const s = $("#sheet");
    s.replaceChildren(el("div", { class: "grab", "aria-hidden": "true" }),
      el("div", { class: "shead" }, left || el("span"), el("h2", { id: "sheetTitle", text: title }), right || el("span")), body);
    $("#sheetVeil").hidden = false; s.hidden = false;
    const f = s.querySelector("input,select,button:not(.linkbtn)"); if (f && wide.matches) f.focus({ preventScroll: true });
    return s;
  }
  const cancelLink = () => el("button", { type: "button", class: "linkbtn", onclick: closeSheets }, "Cancel");

  function accountItems() {
    const a = R.auth || {};
    return [
      ...(a.quickSwitch ? [["Switch person", "staff", openPeopleSheet]] : []),
      ...(R.me?.user?.role !== "admin" ? [[a.user?.quickPin ? "Change quick PIN" : "Set a quick PIN", "key", setQuickPin]] : []),
      ["Change password", "key", () => { location.href = "/signin#change"; }],
      ["Open the diary", "diary", () => { location.href = R.links.diary; }],
      ...(isAdmin() ? [["Admin", "setup", () => { location.href = R.links.admin || "/admin"; }]] : []),
      ["Sign out", "out", signOut, true],
    ];
  }
  async function authPost(route, body) {
    let r;
    try { r = await fetch("/api/auth/" + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { return { ok: false, message: "Couldn't reach the rota. Check your connection." }; }
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, message: j.message || "Something went wrong." };
  }
  function setQuickPin() {
    PinPad.open({ title: "Choose a quick PIN", sub: "4 digits, to switch to yourself on shared devices", onPin: async (firstPin) => {
      setTimeout(() => PinPad.open({ title: "Enter it again", sub: "To check it", onPin: async (again) => {
        if (again !== firstPin) return "Those didn't match. Start again by choosing a PIN.";
        const r = await authPost("pin", { pin: firstPin }); if (!r.ok) return r.message;
        if (R.auth?.user) R.auth.user.quickPin = true;
        toast("Quick PIN set. Use Switch person on a shared device."); return null;
      } }), 250);
      return null;
    } });
  }
  async function openPeopleSheet() {
    const box = $("#peopleList"); box.replaceChildren(empty("Loading…"));
    $("#sheetVeil").hidden = false; $("#peopleSheet").hidden = false;
    let people = [];
    try { people = (await (await fetch("/api/auth/people")).json()).people || []; } catch (e) {}
    const me = R.me.user.name;
    box.replaceChildren(...people.map((p) => el("button", { class: "lrow" + (p.name === me ? " on" : ""), type: "button", onclick: () => {
      closeSheets(); if (p.name === me) return;
      PinPad.open({ title: `Hi ${first(p.name)}`, sub: "Enter your quick PIN", onPin: async (pin) => {
        const r = await authPost("switch", { id: p.id, pin }); if (!r.ok) return r.message;
        location.reload(); return null;
      } });
    } }, avatar(p.name), el("span", { class: "t" }, el("b", { text: p.name }), p.name === me ? el("span", { class: "s", text: "Signed in now" }) : null))));
    if (!people.length) box.replaceChildren(empty("No one has a quick PIN yet. Each person sets one from the account menu."));
    $("#peopleNote").replaceChildren("Not listed? ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); signOut(); } }, "Sign in with your password"), ".");
  }
  function openAcctMenu(anchor) {
    const m = $("#acctMenu"), u = R.me.user;
    m.replaceChildren(el("div", { class: "who" }, el("b", { text: u.name }), el("span", { class: "s", text: ROLE[u.role] || "" })),
      ...accountItems().map(([t, ic, fn, danger]) => el("button", { class: "m" + (danger ? " danger" : ""), type: "button", role: "menuitem", onclick: () => { closeSheets(); fn(); } }, svgi(ICON[ic]), el("span", { text: t }))));
    const r = anchor.getBoundingClientRect();
    m.style.top = r.bottom + 8 + "px"; m.style.left = Math.max(12, Math.min(r.left, innerWidth - 272)) + "px";
    if (anchor.id === "meBox") { m.style.top = ""; m.style.bottom = innerHeight - r.top + 8 + "px"; } else m.style.bottom = "";
    $("#sheetVeil").hidden = false; m.hidden = false; m.querySelector("button").focus();
  }

  /* ---------- week planner (managers) ---------- */

  async function loadWeek(week, force) {
    if (!force && R.weekData && R.weekData.week === week && Date.now() - R.weekData._at < 15000) return R.weekData;
    const d = await get("/api/rota/week?start=" + week);
    d._at = Date.now();
    if (mgr()) R.weekData = d;
    return d;
  }
  const personOf = (d, id) => d.people.find((p) => p.id === id);
  const nameOf = (d, id) => (id ? personOf(d, id)?.name || "Someone" : null);
  const errorsIn = (d) => d.problems.filter((p) => p.severity === "error");
  const clashIds = (d) => new Set(d.problems.filter((p) => p.kind === "clash" || p.kind === "time_off").flatMap((p) => p.shiftIds));

  // "Mon, Tue and Thu".
  // Runs of three or more days read as a range: "Mon–Sat", "Mon, Wed–Fri and Sun".
  const dayList = (days) => {
    const ds = [...new Set(days)].sort(), parts = [];
    for (let i = 0; i < ds.length;) {
      let j = i;
      while (j + 1 < ds.length && ds[j + 1] === addDays(ds[j], 1)) j++;
      const w = (x) => fmt(x, { weekday: "short" });
      if (j - i >= 2) parts.push(`${w(ds[i])}–${w(ds[j])}`); else for (let k = i; k <= j; k++) parts.push(w(ds[k]));
      i = j + 1;
    }
    return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || "";
  };
  const joinAnd = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : xs[0] || "");

  // The week's problems, grouped so repeats read as one line: open shifts together, each site's missing openers,
  // closers and short cover across its days, and everyone's overtime and short hours. Each group has its fix.
  function problemGroups(d) {
    const out = [];
    const open = d.problems.filter((p) => p.kind === "open_shift");
    if (open.length) {
      const s = d.shifts.find((x) => x.id === open[0].shiftIds?.[0]);
      out.push({ sev: "error", text: open.length === 1 ? open[0].message : `${plural(open.length, "open shift")} to fill`,
        sub: open.length === 1 ? (s ? "Fill shows who could take it, best fit first" : "") : dayList(open.map((p) => p.day)), act: "Fill", go: () => focusProblem(d, open[0]) });
    }
    for (const p of d.problems) if (["clash", "time_off", "closed", "inactive"].includes(p.kind)) out.push({ sev: "error", text: p.message, act: "Fix", go: () => focusProblem(d, p) });
    const perSite = (kind) => {
      const by = {};
      for (const p of d.problems) if (p.kind === kind) (by[p.site] ||= []).push(p);
      return Object.entries(by).map(([site, ps]) => ({ site: d.sites.find((x) => x.id === site), ps }));
    };
    for (const { site, ps } of perSite("short_cover")) {
      out.push({ sev: "warn", text: `${site.name} drops below ${plural(site.minPeople, "person", "people")} at times on ${dayList(ps.map((p) => p.day))}`, sub: ps[0].message + (ps.length > 1 ? `, and ${plural(ps.length - 1, "more gap")}` : ""),
        act: "See", go: () => go(`day/${site.id}/${ps[0].day}`) });
    }
    for (const [kind, verb] of [["no_opener", "opens"], ["no_closer", "closes"]]) {
      for (const { site, ps } of perSite(kind)) out.push({ sev: "warn", text: `No one ${verb} ${site.name} on ${dayList(ps.map((p) => p.day))}`, act: "Fix", go: () => go(`day/${site.id}/${ps[0].day}`) });
    }
    const rows = personRows(d);
    const over = rows.filter((r) => r.ot > 0).sort((a, b) => b.ot - a.ot);
    if (over.length) out.push({ sev: "warn", text: `Overtime: ${over.map((r) => `${first(r.p.name)} +${hrs(r.ot)}h`).join(", ")}`, sub: over.length === 1 ? `Over their ${hrs(over[0].p.contractMax)}h maximum` : "Over their contracted maximum",
      act: "See", go: () => focusPerson(over[0].p.id) });
    for (const p of d.problems) if (p.kind === "rest") out.push({ sev: "warn", text: p.message, act: "See", go: () => focusProblem(d, p) });
    const shortH = rows.filter((r) => r.short > 0 && d.problems.some((p) => p.kind === "under_contract" && p.userId === r.p.id));
    if (shortH.length) out.push({ sev: "info", text: `${joinAnd(shortH.map((r) => `${first(r.p.name)} ${hrs(r.short)}h`))} short of their minimum hours`, act: "See", go: () => focusPerson(shortH[0].p.id) });
    for (const p of d.problems) if (["break", "availability", "seven_days"].includes(p.kind)) out.push({ sev: "info", text: p.message, act: "See", go: () => focusProblem(d, p) });
    return out;
  }

  function problemPanel(d) {
    const groups = problemGroups(d);
    if (!groups.length) return el("p", { class: "note okline" }, svgi(ICON.check), " No problems found this week.");
    const n = (s) => groups.filter((g) => g.sev === s).length;
    const settled = d.published && !d.changesSincePublish;
    const det = el("details", { class: "glass probs", open: R.probsOpen ?? (!settled && wide.matches) },
      el("summary", {}, el("span", { class: "pt", text: settled ? "This week's checks" : "Before you publish" }),
        el("span", { class: "counts" }, n("error") ? el("span", { class: "cnt bad", text: `${n("error")} must fix` }) : null,
          n("warn") ? el("span", { class: "cnt warn", text: `${n("warn")} to check` }) : null,
          n("info") ? el("span", { class: "cnt info", text: plural(n("info"), "note") }) : null),
        el("span", { class: "chev" }, svgi(ICON.chevR))),
      el("div", { class: "pgroups", role: "list" }, ...groups.map((g) => el("div", { class: "prob " + (g.sev === "error" ? "bad" : g.sev === "warn" ? "warn" : "info"), role: "listitem" },
        el("span", { class: "vh", text: (g.sev === "error" ? "Must fix" : g.sev === "warn" ? "Check" : "Note") + ": " }),
        el("span", { class: "tx" }, g.text, g.sub ? el("span", { text: g.sub }) : null),
        g.go ? btn(g.act, g.go, g.sev === "error" ? "btn sm" : "btn sm soft") : null))));
    det.addEventListener("toggle", () => { R.probsOpen = det.open; });
    return det;
  }

  // Highlight one person's shifts in the planner (tap again, or tap the same person, to clear).
  function focusPerson(id) {
    R.focusPerson = R.focusPerson === id ? null : id;
    if (R.view !== "site") { R.view = "site"; try { localStorage.setItem("rota.view", "site"); } catch (e) {} render(); return; }
    rerenderWeekBody();
    const p = R.focusPerson && R.weekData && personOf(R.weekData, R.focusPerson);
    if (p) toast(`${first(p.name)}'s shifts highlighted`);
  }

  function focusProblem(d, p) {
    const s = p.shiftIds?.length ? d.shifts.find((x) => x.id === p.shiftIds[p.kind === "clash" ? 1 : 0]) || d.shifts.find((x) => x.id === p.shiftIds[0]) : null;
    if (p.kind === "overtime" || p.kind === "under_contract") { R.view = "person"; render(); return; }
    if ((p.kind === "clash" || p.kind === "no_opener" || p.kind === "no_closer" || p.kind === "short_cover") && p.site && p.day) { go(`day/${p.site}/${p.day}`); return; }
    if (s) openShift(s, d);
    else if (p.site && p.day) go(`day/${p.site}/${p.day}`);
  }

  function shiftCard(d, s, { clash, ro, showSite, showName = true, compact } = {}) {
    const nm = nameOf(d, s.userId);
    const cls = "shc" + (!s.userId ? " open" : "") + (clash ? " clash" : "") + (s.overtime > 0 ? " ot" : "") + (s.adjusted ? " amended" : "") + (showSite ? " tone-" + (SITE_TONE[s.site] || "") : "");
    const site = d.sites.find((x) => x.id === s.site);
    const ot = s.overtime > 0;
    const tag = !s.userId ? [jobWord(s.job), "Fill"].filter(Boolean).join(" · ") : clash ? "Clash" : [jobWord(s.job), s.adjusted ? "Amended" : ""].filter(Boolean).join(" · ");
    const aria = `${effS(s)} to ${effE(s)}${s.adjusted ? ` (amended, planned ${s.start} to ${s.end})` : ""}, ${nm || "open shift"}${s.job ? ", " + s.job : ""}${clash ? ", clash" : ""}${ot ? `, ${hrs(s.overtime)} hours overtime` : ""}${showSite ? ", " + site.name : ""}`;
    const dim = R.focusPerson && s.userId !== R.focusPerson ? " dim" : "";
    if (compact) {
      // The planner grid: the time on one line, then the name with one small tag (Fill, Clash, Overtime, Opens…).
      const small = !s.userId ? "Fill" : clash ? "Clash" : ot ? "Overtime" : s.adjusted ? "Amended" : jobWord(s.job);
      const k = [el("b", { class: "tm", text: span(s) }), el("span", { class: "w" }, el("span", { class: "nm", text: showSite && !showName ? site.name : nm ? first(nm) : "Open" }), small ? el("small", { class: ot && s.userId && !clash ? "o" : "", text: small }) : null)];
      return ro ? el("div", { class: cls + " cmp" + dim, "aria-label": aria }, ...k) : el("button", { type: "button", class: cls + " cmp" + dim, "aria-label": aria, onclick: (e) => { e.stopPropagation(); openShift(s, d); } }, ...k);
    }
    const kids = [el("b", { class: "tm", text: span(s) }),
      showName ? el("span", { class: "nm", text: nm ? first(nm) : "Open shift" }) : null,
      showSite ? el("span", { class: "nm", text: site.name }) : null,
      tag ? el("span", { class: "jb", text: tag }) : null,
      ot ? el("span", { class: "otag", text: `Overtime ${hrs(s.overtime)}h` }) : null];
    return ro ? el("div", { class: cls + dim, "aria-label": aria }, ...kids) : el("button", { type: "button", class: cls + dim, "aria-label": aria, onclick: (e) => { e.stopPropagation(); openShift(s, d); } }, ...kids);
  }

  function peopleOnDay(d, day) { return new Set(d.shifts.filter((s) => s.day === day && s.userId).map((s) => s.userId)).size; }

  // People on a site that day (each counted once) against the site's minimum.
  function coverOf(d, site, day) {
    const n = new Set(d.shifts.filter((s) => s.site === site.id && s.day === day && s.userId).map((s) => s.userId)).size;
    return { n, min: site.minPeople || 0, short: site.minPeople > 0 && n < site.minPeople };
  }
  function coverBar(d, site, day, add) {
    const c = coverOf(d, site, day);
    return el("div", { class: "cover" + (c.short ? " short" : "") },
      el("span", { class: "num", title: c.min ? `${c.n} on, minimum ${c.min}` : `${c.n} on`, "aria-label": c.min ? `${plural(c.n, "person", "people")} on, minimum ${c.min}` : plural(c.n, "person", "people") + " on", text: c.min ? `${c.n}/${c.min}` : `${c.n} on` }),
      el("span", { class: "cb", "aria-hidden": "true" }, el("i", { style: `width:${c.min ? Math.min(100, (c.n / c.min) * 100) : c.n ? 100 : 0}%` })),
      add || null);
  }
  const siteHours = (site) => (site.opensAt && site.closesAt ? `${site.opensAt}–${site.closesAt}` : "");

  function siteGrid(d, ro) {
    const clashes = clashIds(d);
    const today = londonToday();
    const td = (day) => (day === today ? " td" : "");
    const used = d.sites.filter((s) => s.inUse), unused = d.sites.filter((s) => !s.inUse);
    const g = el("div", { class: "rgrid sgrid", role: "table", "aria-label": "Shifts by site and day" });
    g.append(el("div", { class: "gh corner", role: "columnheader", text: "Site" }),
      ...d.days.map((day) => el("div", { class: "gh" + (day === today ? " now td" : ""), role: "columnheader" }, el("b", { text: short(day) }), el("span", { text: day === today ? "Today" : "\u00a0" }))));
    for (const site of used) {
      g.append(el("div", { class: "gsite", role: "rowheader" },
        el("b", {}, el("i", { class: "sq tone-" + (SITE_TONE[site.id] || ""), "aria-hidden": "true" }), site.name),
        siteHours(site) ? el("span", { text: siteHours(site) }) : null,
        el("span", { text: openDays(site.open.map((o, i) => o || !!site.closedWhy[i])) }),
        site.minPeople ? el("span", { text: `Min ${site.minPeople} on shift` }) : null));
      d.days.forEach((day, i) => {
        if (!site.open[i]) {
          const here = d.shifts.filter((s) => s.site === site.id && s.day === day);
          g.append(el("div", { class: "gcell closed" + td(day) }, el("span", { class: "cl", text: site.closedWhy[i] ? `Closed: ${site.closedWhy[i]}` : "Closed" }), ...here.map((s) => shiftCard(d, s, { clash: true, ro, compact: true }))));
          return;
        }
        const list = d.shifts.filter((s) => s.site === site.id && s.day === day).sort((a, b) => effS(a).localeCompare(effS(b)));
        const add = ro ? null : el("button", { type: "button", class: "gadd", "data-w": "", "aria-label": `Add a shift at ${site.name} on ${longD(day)}`, onclick: () => newShift(d, site.id, day) }, svgi(ICON.plus));
        const cell = el("div", { class: "gcell" + td(day) + (ro ? "" : " addable"), onclick: ro ? null : (e) => { if (e.target === cell) newShift(d, site.id, day); } },
          ro ? null : coverBar(d, site, day, add),
          ...list.map((s) => shiftCard(d, s, { clash: clashes.has(s.id), ro, compact: true })));
        g.append(cell);
      });
    }
    g.append(el("div", { class: "gsite gtot", role: "rowheader" }, el("span", { text: "People on" })),
      ...d.days.map((day) => el("div", { class: "gtot" + td(day), text: plural(peopleOnDay(d, day), "person", "people") })));
    if (unused.length && !ro) {
      g.append(el("div", { class: "gfoot" }, el("span", { text: `${joinAnd(unused.map((s) => s.name))} ${unused.length === 1 ? "isn't" : "aren't"} set up in the diary yet, so ${unused.length === 1 ? "it can't" : "they can't"} have shifts.` }),
        el("a", { class: "btn sm soft", href: R.links.diary }, "Set up in the diary")));
    }
    return el("div", { class: "glass gridcard" }, el("div", { class: "gridwrap" }, g));
  }

  function personRows(d) {
    return d.people.map((p) => {
      const mine = d.shifts.filter((s) => s.userId === p.id);
      const h = r2(mine.reduce((a, s) => a + s.hours, 0));
      const ot = p.contractMax != null ? r2(Math.max(0, h - p.contractMax)) : 0;
      const short = p.contractMin != null ? r2(Math.max(0, p.contractMin - h)) : 0;
      return { p, mine, h, ot, short, over: ot > 0 };
    });
  }
  const offWord = (d, p, day) => {
    if (d.timeOff.some((t) => t.userId === p.id && t.from <= day && t.to >= day)) return ["Holiday", "hol"];
    if (p.pattern?.[DAYS[dow(day)]] === "off") return ["Can't work", "cant"];
    return ["Off", ""];
  };
  // Hours against the contract: the bar runs to the maximum (or past it, in the overtime colour), with the
  // minimum marked.
  function hoursBar(h, p) {
    const min = p.contractMin, max = p.contractMax ?? p.contractMin;
    if (!max) return el("div", { class: "hbar", role: "img", "aria-label": `${hrs(h)} hours, no contract set` });
    const scale = Math.max(max, h);
    const inPct = (Math.min(h, max) / scale) * 100, otPct = (Math.max(0, h - max) / scale) * 100;
    const label = `${hrs(h)} hours, contract ${contractLabel(p)}${h > max ? `, ${hrs(r2(h - max))} overtime` : min != null && h < min ? `, ${hrs(r2(min - h))} short of the minimum` : ""}`;
    return el("div", { class: "hbar" + (h > max ? " over" : ""), role: "img", "aria-label": label },
      el("i", { style: `width:${inPct}%` }), otPct ? el("i", { class: "ot", style: `width:${otPct}%` }) : null,
      min != null && min < max ? el("span", { class: "min", style: `left:${(min / scale) * 100}%` }) : null);
  }
  const hoursText = (h, p, ot, short) => `${hrs(h)}${contractLabel(p) ? " of " + contractLabel(p) : ""}h`;

  function personGrid(d) {
    const clashes = clashIds(d);
    const g = el("div", { class: "rgrid pgrid", role: "table", "aria-label": "Shifts by person and day" });
    g.append(el("div", { class: "gh corner", text: "Person" }), el("div", { class: "gh", text: "Hours" }), ...d.days.map((day) => el("div", { class: "gh" }, el("b", { text: short(day) }))));
    for (const { p, mine, h, ot, short } of personRows(d)) {
      g.append(el("div", { class: "gperson" }, avatar(p.name), el("span", { class: "t" }, el("b", { text: p.name }), el("span", { class: "s", text: ROLE[p.role] || "" }))),
        el("div", { class: "ghours" + (ot ? " over" : "") }, el("b", { text: `${hrs(h)}${contractLabel(p) ? " / " + contractLabel(p) : ""}h` }),
          ot ? el("span", { class: "otag", text: `${hrs(ot)}h overtime` }) : short ? el("span", { class: "shortx", text: `${hrs(short)}h short` }) : null, hoursBar(h, p)));
      d.days.forEach((day) => {
        const list = mine.filter((s) => s.day === day);
        if (list.length) { g.append(el("div", { class: "gcell" }, ...list.map((s) => shiftCard(d, s, { clash: clashes.has(s.id), showSite: true, showName: false, compact: true })))); return; }
        const [w, c] = offWord(d, p, day);
        g.append(el("button", { type: "button", class: "gcell offcell " + c, "data-w": "", "aria-label": `${p.name}, ${longD(day)}: ${w}. Add a shift`, onclick: () => newShift(d, p.sites?.[0] || firstOpenSite(d, day), day, p.id) }, w));
      });
    }
    // Open shifts, so they're not lost in this view.
    const open = d.shifts.filter((s) => !s.userId);
    if (open.length) {
      g.append(el("div", { class: "gperson" }, el("span", { class: "t" }, el("b", { text: "Open shifts" }), el("span", { class: "s", text: plural(open.length, "to fill", "to fill") }))), el("div", { class: "ghours" }));
      d.days.forEach((day) => g.append(el("div", { class: "gcell" }, ...open.filter((s) => s.day === day).map((s) => shiftCard(d, s, { showSite: true, showName: false, compact: true })))));
    }
    return el("div", { class: "glass gridcard" }, el("div", { class: "gridwrap" }, g));
  }
  const firstOpenSite = (d, day) => (d.sites.find((s) => s.open[d.days.indexOf(day)]) || d.sites[0]).id;

  // Phones: one day at a time.
  function dayMarks(d) {
    return d.days.map((day) => {
      const ps = d.problems.filter((p) => p.day === day);
      return ps.some((p) => p.severity === "error") ? "bad" : ps.some((p) => p.severity === "warn") ? "part" : d.shifts.some((s) => s.day === day) ? "ok" : "";
    });
  }
  function phoneDay(d, ro, onPick = rerenderWeekBody) {
    const day = d.days[R.pday], i = R.pday;
    const clashes = clashIds(d);
    const out = [dayStrip(d.days, R.pday, (k) => { R.pday = k; onPick(); }, ro ? [] : dayMarks(d))];
    if (R.view === "person" && !ro) {
      const rows = personRows(d).map(({ p, mine, h, ot, short }) => {
        const list = mine.filter((s) => s.day === day);
        const [w] = offWord(d, p, day);
        return el("div", { class: "lrow prow" }, avatar(p.name),
          el("span", { class: "t" }, el("b", { text: p.name }), el("span", { class: "s" + (ot ? " overtx" : ""), text: `${hoursText(h, p)} this week${ot ? ` · ${hrs(ot)}h overtime` : short ? ` · ${hrs(short)}h short` : ""}` }), hoursBar(h, p)),
          list.length ? el("span", { class: "pshifts" }, ...list.map((s) => shiftCard(d, s, { clash: clashes.has(s.id), showSite: true, showName: false })))
            : el("button", { type: "button", class: "btn ghost sm", "data-w": "", onclick: () => newShift(d, p.sites?.[0] || firstOpenSite(d, day), day, p.id) }, w === "Off" ? "Add" : w));
      });
      out.push(el("div", { class: "list glass" }, ...rows));
      return out;
    }
    for (const site of d.sites) {
      const head = el("div", { class: "scardh" }, el("b", { text: site.name }),
        !ro && site.inUse && site.open[i] ? el("span", { class: "scardr" }, coverBar(d, site, day), el("button", { type: "button", class: "linkbtn", onclick: () => go(`day/${site.id}/${day}`) }, "Day view")) : null);
      if (!site.inUse) continue;
      if (!site.open[i]) {
        out.push(el("section", { class: "panel sitecard" }, head, el("p", { class: "note", text: site.closedWhy[i] ? `Closed: ${site.closedWhy[i]}` : "Closed" }),
          ...d.shifts.filter((s) => s.site === site.id && s.day === day).map((s) => shiftCard(d, s, { clash: true, ro }))));
        continue;
      }
      const list = d.shifts.filter((s) => s.site === site.id && s.day === day).sort((a, b) => effS(a).localeCompare(effS(b)));
      out.push(el("section", { class: "panel sitecard" }, head,
        list.length ? el("div", { class: "shlist" }, ...list.map((s) => shiftCard(d, s, { clash: clashes.has(s.id), ro }))) : el("p", { class: "note", text: "No shifts yet." }),
        ro ? null : el("button", { type: "button", class: "btn ghost sm addshift", "data-w": "", onclick: () => newShift(d, site.id, day) }, svgi(ICON.plus), "Add shift")));
    }
    const unused = d.sites.filter((x) => !x.inUse);
    if (unused.length && !ro) out.push(el("p", { class: "note", text: `${joinAnd(unused.map((x) => x.name))} ${unused.length === 1 ? "isn't" : "aren't"} set up in the diary yet, so ${unused.length === 1 ? "it can't" : "they can't"} have shifts.` }));
    if (!ro && R.view !== "person") out.push(peoplePanel(d));
    return out;
  }

  // Everyone's hours this week against their contract, with what to know (holiday, days they can't work,
  // one site only). Tapping someone highlights their shifts.
  function peoplePanel(d) {
    const rows = personRows(d).sort((a, b) => b.ot - a.ot || b.h - a.h);
    const box = el("section", { class: "glass people", "aria-label": "People this week" },
      el("h2", {}, "People this week", el("span", { text: "hours / contract" })));
    const list = el("div", { class: "plist" });
    for (const { p, h, ot, short: sh } of rows) {
      const hol = d.days.filter((day) => d.timeOff.some((t) => t.userId === p.id && t.from <= day && t.to >= day));
      const cant = d.days.filter((day) => p.pattern?.[DAYS[dow(day)]] === "off" && !hol.includes(day));
      const meta = [contractLabel(p) ? contractLabel(p) + "h" : "No contract set",
        hol.length ? `Holiday ${dayList(hol)}` : "", cant.length ? `Can't work ${dayList(cant)}` : "",
        p.sites?.length === 1 ? `${d.sites.find((x) => x.id === p.sites[0])?.name || p.sites[0]} only` : ""].filter(Boolean);
      const flag = ot ? el("b", { class: "o", text: `Overtime ${hrs(ot)}h` }) : sh && contractLabel(p) ? el("b", { class: "s", text: `${hrs(sh)}h short` }) : null;
      list.append(el("button", { type: "button", class: "pr", "aria-pressed": String(R.focusPerson === p.id), onclick: () => focusPerson(p.id) },
        avatar(p.name), el("span", { class: "top" }, el("span", { class: "n", text: p.name }), el("span", { class: "h" + (ot ? " o" : sh ? " s" : ""), text: `${hrs(h)}h` })),
        hoursBar(h, p), el("span", { class: "meta" }, flag, flag ? " · " : null, meta.join(" · "))));
    }
    box.append(list, el("p", { class: "pfoot", text: R.focusPerson ? "Tap them again to show everyone." : "Tap someone to highlight their shifts. The tick on each bar is their minimum." }));
    return box;
  }

  let weekBody = null;
  function rerenderWeekBody() { if (weekBody && R.weekData) weekBody.replaceChildren(...weekBodyKids(R.weekData)); }
  function weekBodyKids(d) {
    if (!wide.matches) return phoneDay(d, false);
    const legend = el("div", { class: "legend rlegend" }, el("span", { class: "lg" }, el("i", { class: "sw" }), "Shift"), el("span", { class: "lg" }, el("i", { class: "sw open" }), "Open shift"),
      el("span", { class: "lg" }, el("i", { class: "sw clash" }), "Clash"), el("span", { class: "lg" }, el("i", { class: "sw ot" }), "Overtime"), el("span", { text: "Tap a shift to change, move or copy it. The + adds one." }));
    if (R.view === "person") return [personGrid(d), legend];
    return [el("div", { class: "split" }, el("div", { class: "stack" }, siteGrid(d, false), legend), peoplePanel(d))];
  }

  const weekRange = (w) => {
    const e = addDays(w, 6), sm = fmt(w, { month: "short" }) === fmt(e, { month: "short" });
    return sm ? `${fmt(w, { day: "numeric" })}–${fmt(e, { day: "numeric", month: "short" })}` : `${fmt(w, { day: "numeric", month: "short" })}–${fmt(e, { day: "numeric", month: "short" })}`;
  };
  function weekNav(cur, set, { min, max } = {}) {
    const thisWeek = monday(londonToday());
    return [el("button", { type: "button", class: "iconbtn", "aria-label": "Previous week", disabled: min && cur <= min, onclick: () => set(addDays(cur, -7)) }, svgi(ICON.chevL)),
      cur === thisWeek ? el("span", { class: "wk", text: weekRange(cur) }) : el("button", { type: "button", class: "btn ghost sm wk", onclick: () => set(thisWeek), "aria-label": `Showing ${weekRange(cur)}. Back to this week` }, "This week"),
      el("button", { type: "button", class: "iconbtn", "aria-label": "Next week", disabled: max && cur >= max, onclick: () => set(addDays(cur, 7)) }, svgi(ICON.chevR))];
  }

  async function renderWeek([day] = []) {
    // #week/<date> (from the admin section) opens that week; the address then goes back to #week.
    if (/^\d{4}-\d{2}-\d{2}$/.test(day || "")) { R.week = monday(day); try { history.replaceState(null, "", "#week"); } catch (e) { /* ignore */ } }
    const d = await loadWeek(R.week, true);
    if (R.focusWeek !== d.week) { R.focusPerson = null; R.probsOpen = undefined; R.focusWeek = d.week; }
    if (R.focusPerson && !personOf(d, R.focusPerson)) R.focusPerson = null;
    const total = r2(d.shifts.reduce((a, s) => a + s.hours, 0));
    const people = new Set(d.shifts.filter((s) => s.userId).map((s) => s.userId)).size;
    const settled = d.published && !d.changesSincePublish;
    const status = !d.published ? ["draft", "Draft"] : settled ? ["pub", "Published"] : ["chg", `Published · ${plural(d.changesSincePublish, "change")} not sent`];
    setHead("week", weekLabel(d.week), `${hrs(total)} hours · ${plural(d.shifts.length, "shift")} · ${plural(people, "person", "people")}${d.publishedAt ? ` · published ${fmt(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(d.publishedAt)), { weekday: "short", day: "numeric", month: "short" })}` : ""}`, {
      actions: weekNav(d.week, (w) => { R.week = w; render(); }),
    });
    $("#pageTitle").append(" ", el("span", { class: "wstatus " + status[0], text: status[1] }));
    if (R.pday > 6) R.pday = 0;
    const pub = settled ? btn("Up to date", null, "btn ghost pubbtn", { disabled: true, title: "Nothing to send: everyone has the latest" })
      : el("button", { type: "button", class: "btn pubbtn", "data-w": "", onclick: () => publishSheet(d) }, svgi(ICON.send), d.published ? `Publish ${plural(d.changesSincePublish, "change")}` : "Publish week");
    const prevWeek = addDays(d.week, -7);
    const copy = d.shifts.length
      ? twoTap("Copy last week", `Replace ${plural(d.shifts.length, "shift")}?`, () => copyWeek(prevWeek, d.week, true), "btn soft")
      : btn("Copy last week", () => copyWeek(prevWeek, d.week, false), "btn soft");
    const toolbar = el("div", { class: "rtool" },
      seg([["site", "By site"], ["person", "By person"]], R.view, (v) => { R.view = v; try { localStorage.setItem("rota.view", v); } catch (e) {} render(); }, "View"),
      el("span", { class: "grow" }), copy, pub);
    weekBody = el("div", { class: "stack" }, ...weekBodyKids(d));
    return [toolbar, problemPanel(d), weekBody];
  }

  // What goes out before it goes: the shifts and hours, who'll see it, and anything still to check.
  function publishSheet(d) {
    const groups = problemGroups(d);
    const errs = groups.filter((g) => g.sev === "error").length, warns = groups.filter((g) => g.sev === "warn").length;
    const total = r2(d.shifts.reduce((a, s) => a + s.hours, 0));
    const people = new Set(d.shifts.filter((s) => s.userId).map((s) => s.userId)).size;
    const kv = (k, v, cls) => el("div", { class: "kv" }, el("span", { text: k }), el("span", { class: cls || "", text: v }));
    const still = [errs ? plural(errs, "problem") : "", warns ? plural(warns, "warning") : ""].filter(Boolean).join(" · ");
    const changes = d.published ? plural(d.changesSincePublish, "change") : "";
    const msg = el("p", { class: "smsg", role: "alert" });
    openSheet(d.published ? `Publish ${changes}?` : `Publish the ${weekLabel(d.week).replace(/^W/, "w")}?`, el("div", { class: "sbody" },
      d.published ? el("p", { class: "note", text: "Everyone on the rota sees the updated week straight away." }) : null,
      el("div", { class: "kvs" }, kv("Shifts", `${d.shifts.length} · ${hrs(total)} hours`), kv("People who'll see it", String(people)),
        kv("Still to check", still || "Nothing", errs ? "bad" : warns ? "warn" : "ok")),
      errs ? el("p", { class: "note", text: "You can publish with problems; open shifts go to Open shifts for staff to pick up." }) : null, msg,
      el("div", { class: "sfoot" }, ghost("Not yet", closeSheets), btn(d.published ? "Publish changes" : "Publish", async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await api("POST", "/api/rota/week/publish", { week: d.week }); closeSheets(); toast("Published. Staff can see this week now."); render(); }
        catch (err) { msg.textContent = err.message; b.disabled = false; }
      }))), { left: cancelLink() });
  }

  async function copyWeek(from, to, replace) {
    const r = await act(() => api("POST", "/api/rota/week/copy", { from, to, replace }));
    if (!r) return;
    toast(`Copied ${plural(r.copied, "shift")}${r.skipped.length ? `. ${r.skipped.length} skipped: ${r.skipped[0].reason}` : ""}.`);
    render();
  }

  /* ---------- the shift sheet ---------- */

  function newShift(d, site, day, userId) {
    const s = d.sites.find((x) => x.id === site) || {};
    const h = s.id ? hoursOn(s, d.days.indexOf(day)) : {};
    openShift({ id: null, site, day, start: h.opensAt || "08:00", end: h.closesAt || "16:00", breakMins: 30, job: "", userId: userId || null, note: "" }, d);
  }

  function shiftFields(d, s) {
    const f = {};
    f.site = el("select", { id: "f_site" }, ...d.sites.filter((x) => x.inUse).map((x) => el("option", { value: x.id }, x.name)));
    f.site.value = s.site;
    f.day = el("input", { type: "date", id: "f_day", value: s.day });
    f.start = el("input", { type: "time", id: "f_start", value: s.start, step: 300 });
    f.end = el("input", { type: "time", id: "f_end", value: s.end, step: 300 });
    f.breakMins = el("input", { type: "number", id: "f_break", value: String(s.breakMins), min: 0, max: 180, step: 5, inputmode: "numeric" });
    let job = s.job;
    f.jobBox = el("div");
    const drawJob = () => f.jobBox.replaceChildren(seg([["", "No job"], ["opens", "Opens"], ["closes", "Closes"]], job, (v) => { job = v; drawJob(); }, "Job"));
    drawJob();
    f.job = () => job;
    f.note = el("input", { type: "text", id: "f_note", value: s.note, maxlength: 500, placeholder: "e.g. Training with Priya" });
    const fld = (id, t, input) => el("div", { class: "field" }, el("label", { class: "label", for: id, text: t }), input);
    f.box = el("div", { class: "sfields" },
      fld("f_site", "Site", f.site), fld("f_day", "Day", f.day), fld("f_start", "Starts", f.start), fld("f_end", "Ends", f.end),
      fld("f_break", "Unpaid break (minutes)", f.breakMins), el("div", { class: "field wide" }, el("span", { class: "label", text: "Job" }), f.jobBox),
      el("div", { class: "field wide" }, el("label", { class: "label", for: "f_note", text: "Note" }), f.note));
    f.values = () => ({ site: f.site.value, day: f.day.value, start: f.start.value, end: f.end.value, breakMins: Number(f.breakMins.value || 0), job: f.job(), note: f.note.value.trim() });
    return f;
  }

  async function openShift(s, d) {
    const isNew = !s.id;
    const f = shiftFields(d, s);
    const msg = el("p", { class: "smsg", role: "alert" });
    const who = el("div", { class: "who" });
    const foot = el("div", { class: "sfoot" });
    let pick = null; // chosen person from the suggestions
    let changing = !s.userId;

    async function save(extra = {}, okText) {
      msg.textContent = "";
      const body = { ...f.values(), ...extra };
      try {
        const before = isNew ? null : { site: s.site, day: s.day, start: s.start, end: s.end, breakMins: s.breakMins, job: s.job, note: s.note, userId: s.userId };
        // Sent with the version this sheet opened, so a change someone else made meanwhile isn't overwritten.
        const r = isNew ? await api("POST", "/api/rota/shifts", { ...body, userId: extra.userId !== undefined ? extra.userId : s.userId })
          : await api("PATCH", "/api/rota/shifts/" + s.id, { ...body, ifUpdatedAt: s.updatedAt });
        closeSheets();
        if (R.weekData) R.weekData._at = 0;
        const undo = isNew ? ["Undo", async () => { await act(() => api("DELETE", "/api/rota/shifts/" + r.shift.id)); render(); }]
          : ["Undo", async () => { await act(() => api("PATCH", "/api/rota/shifts/" + s.id, before)); render(); }];
        toast(okText || (isNew ? "Shift added" : "Shift saved"), undo);
        render();
        return r;
      } catch (e) {
        msg.textContent = e.message;
        // Someone else changed it: show the shift as it is now (the sheet reopens with it).
        if (e.code === "conflict" && e.shift) { if (R.weekData) R.weekData._at = 0; setTimeout(() => { closeSheets(); openShift(e.shift, R.weekData || d); toast(e.message); }, 50); }
        return null;
      }
    }

    async function drawWho() {
      who.replaceChildren();
      if (!changing && s.userId) {
        who.append(label("Who"), el("div", { class: "list glass" }, el("div", { class: "lrow" }, avatar(nameOf(d, s.userId)),
          el("span", { class: "t" }, el("b", { text: nameOf(d, s.userId) })), ghost("Change person", () => { changing = true; drawWho(); drawFoot(); }, { class: "btn ghost sm" }))));
        return;
      }
      if (isNew) {
        const sel = el("select", { id: "f_person" }, el("option", { value: "" }, "Open shift (fill it later)"), ...d.people.map((p) => el("option", { value: p.id }, p.name)));
        sel.value = s.userId || "";
        sel.onchange = () => { pick = sel.value || null; drawFoot(); };
        pick = s.userId || null;
        who.append(el("div", { class: "field" }, el("label", { class: "label", for: "f_person", text: "Who" }), sel),
          el("p", { class: "note", text: "Save it as an open shift to see who's free, best fit first." }));
        return;
      }
      who.append(label("Who can do it"), el("div", { class: "list glass" }, empty("Checking who's free…")));
      let r;
      try { r = await get("/api/rota/suggest?shift=" + s.id); } catch (e) { who.lastChild.replaceChildren(empty(e.message)); return; }
      const rows = r.candidates.map((c) => {
        const flag = c.flags[0];
        const pill = c.best ? el("span", { class: "pill ok", text: "Best fit" })
          : flag ? el("span", { class: "pill " + (flag.severity === "error" || flag.kind === "untrained" ? "bad" : flag.severity === "warn" ? "warn" : ""), text: { clash: "Clash", time_off: "Time off", overtime: "Overtime", rest: "Short rest", untrained: "Training", availability: "Availability", break: "Break", seven_days: "7 days", closed: "Closed" }[flag.kind] || "Check" }) : null;
        const sub = flag ? flag.message : `Free · would be ${hoursText(c.hoursIfGiven, c)}`;
        const row = el("button", { type: "button", class: "lrow cand" + (c.selectable ? "" : " dim"), disabled: !c.selectable, role: "radio", "aria-checked": "false",
          onclick: () => { pick = c.userId; for (const x of who.querySelectorAll(".cand")) x.setAttribute("aria-checked", String(x === row)); drawFoot(c.name); } },
          avatar(c.name), el("span", { class: "t" }, el("b", { text: c.name }), el("span", { class: "s", text: sub + (c.flags.length > 1 ? ` (+${c.flags.length - 1} more)` : "") })), pill, c.selectable ? el("span", { class: "radio", "aria-hidden": "true" }) : null);
        if (c.best && !pick) { pick = c.userId; row.setAttribute("aria-checked", "true"); }
        return row;
      });
      who.lastChild.replaceChildren(...(rows.length ? rows : [empty("No one else has an account yet.")]));
      who.lastChild.setAttribute("role", "radiogroup");
      who.append(el("p", { class: "note", text: "Checks hours, other shifts, time off, when people can work, and opening and closing training for this site." }));
      const best = r.candidates.find((c) => c.userId === pick);
      drawFoot(best?.name);
    }

    function drawFoot(pickName) {
      foot.replaceChildren();
      if (isNew) {
        foot.append(btn(pick ? "Add shift" : "Add open shift", () => save({ userId: pick || null })));
        return;
      }
      if (changing || !s.userId) {
        const nm = pickName || (pick ? nameOf(d, pick) : null);
        foot.append(ghost(s.userId ? "Make it open" : "Offer to everyone", () => save({ userId: null }, s.userId ? "Shift is open now" : "Left open. Staff who could take it see it once the week is published.")),
          btn(nm ? `Give to ${first(nm)}` : "Choose someone", () => pick && save({ userId: pick }, `Given to ${first(nm)}`), "btn", { disabled: !pick }));
      } else {
        foot.append(btn("Save changes", () => save()));
      }
    }

    const tools = isNew ? null : el("div", { class: "row stools" },
      ghost("Move to…", () => { f.site.focus(); f.box.classList.add("flash"); setTimeout(() => f.box.classList.remove("flash"), 900); }, { class: "btn ghost sm" }),
      ghost("Duplicate", async () => {
        const r = await act(() => api("POST", "/api/rota/shifts", { ...f.values(), userId: null }), "Duplicated as an open shift. Change its day or person.");
        if (r) { closeSheets(); if (R.weekData) R.weekData._at = 0; const nd = await loadWeek(mondayOfDay(r.shift.day), true); openShift(r.shift, nd); rerenderSoon(); }
      }, { class: "btn ghost sm" }),
      ghost("Day view", () => { closeSheets(); go(`day/${s.site}/${s.day}`); }, { class: "btn ghost sm" }),
      twoTap("Delete", "Delete this shift?", async () => {
        const r = await act(() => api("DELETE", "/api/rota/shifts/" + s.id));
        if (!r) return;
        closeSheets(); if (R.weekData) R.weekData._at = 0;
        toast("Shift deleted", ["Undo", async () => { await act(() => api("POST", "/api/rota/shifts", { site: s.site, day: s.day, start: s.start, end: s.end, breakMins: s.breakMins, job: s.job, userId: s.userId, note: s.note })); render(); }]);
        render();
      }, "btn ghost sm danger"));

    // On the day (or after): amend when they actually started and finished.
    const onDay = !isNew && s.userId && s.day <= londonToday()
      ? el("div", { class: "stack amendbox" }, label("On the day"), el("div", { class: "list glass" }, amendRow(d, s, { onSaved: () => { closeSheets(); render(); } })))
      : null;
    const title = isNew ? "New shift" : !s.userId ? "Open shift" : `${first(nameOf(d, s.userId))}'s shift`;
    openSheet(title, el("div", { class: "sbody" }, onDay, f.box, who, msg, tools, foot), { left: cancelLink() });
    drawFoot();
    drawWho();
  }
  const mondayOfDay = (day) => monday(day);
  const rerenderSoon = () => setTimeout(render, 50);

  /* ---------- day view (managers) ---------- */

  async function renderDay([site, day]) {
    if (!site || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) { go("week"); return []; }
    const d = await loadWeek(monday(day), true);
    R.week = d.week;
    const s = d.sites.find((x) => x.id === site);
    if (!s) { go("week"); return []; }
    const i = d.days.indexOf(day);
    const list = d.shifts.filter((x) => x.site === site && x.day === day).sort((a, b) => a.start.localeCompare(b.start));
    const people = new Set(list.filter((x) => x.userId).map((x) => x.userId)).size;
    const oh = hoursOn(s, i);
    setHead("day", longD(day), `${s.name} · ${s.open[i] ? (oh.opensAt && oh.closesAt ? `open ${oh.opensAt}–${oh.closesAt}` : "open") : "closed"} · ${plural(people, "person", "people")}`, { back: ["Rota", "week"] });
    const strip = dayStrip(d.days, i, (k) => go(`day/${site}/${d.days[k]}`));
    const sitePick = seg(d.sites.filter((x) => x.inUse).map((x) => [x.id, x.name]), site, (v) => go(`day/${v}/${day}`), "Site");
    if (!s.open[i]) return [sitePick, strip, el("section", { class: "panel" }, el("p", { class: "note", text: s.closedWhy[i] ? `${s.name} is closed: ${s.closedWhy[i]}.` : `${s.name} is closed on ${DAY_NAMES[dow(day)]}s.` }))];

    // The timeline: from opening (or the earliest shift) to closing (or the latest).
    const starts = list.flatMap((x) => [mins(x.start), mins(effS(x))]), ends = list.flatMap((x) => [mins(x.end), mins(effE(x))]);
    let a = Math.min(oh.opensAt ? mins(oh.opensAt) : 24 * 60, ...starts, 23 * 60), b = Math.max(oh.closesAt ? mins(oh.closesAt) : 0, ...ends, 60);
    if (!list.length && !oh.opensAt) { a = 7 * 60; b = 18 * 60; }
    a = Math.floor(a / 60) * 60; b = Math.ceil(b / 60) * 60; if (b <= a) b = a + 60;
    const pos = (m) => ((m - a) / (b - a)) * 100;
    const clashes = clashIds(d);
    const axis = el("div", { class: "tl-axis", "aria-hidden": "true" });
    for (let h = a; h <= b; h += 60) if ((h / 60) % (b - a > 9 * 60 ? 3 : 1) === 0) axis.append(el("span", { style: `left:${pos(h)}%`, text: String(h / 60).padStart(2, "0") }));
    const rows = list.map((x) => {
      const nm = nameOf(d, x.userId);
      const other = x.userId ? d.shifts.filter((o) => o.userId === x.userId && o.day === day && o.id !== x.id) : [];
      const xs = mins(effS(x)), xe = Math.max(mins(effE(x)), xs + 1);
      return el("div", { class: "tl-row" }, el("span", { class: "tl-name", text: nm ? first(nm) : "Open" }),
        el("div", { class: "tl-track" },
          ...other.map((o) => el("span", { class: "tl-bar ghost", style: `left:${pos(Math.max(a, mins(o.start)))}%;width:${pos(Math.min(b, mins(o.end))) - pos(Math.max(a, mins(o.start)))}%` }, `At ${d.sites.find((z) => z.id === o.site).name} till ${o.end}`)),
          // Amended: the plan stays as an outline behind what was worked.
          x.adjusted ? el("span", { class: "tl-plan", "aria-hidden": "true", style: `left:${pos(mins(x.start))}%;width:${pos(mins(x.end)) - pos(mins(x.start))}%` }) : null,
          el("button", { type: "button", class: "tl-bar" + (!x.userId ? " open" : "") + (clashes.has(x.id) ? " clash" : "") + (x.overtime > 0 ? " ot" : "") + (x.adjusted ? " amended" : ""),
            style: `left:${pos(xs)}%;width:${pos(xe) - pos(xs)}%`,
            onclick: () => openShift(x, d), "aria-label": `${nm || "Open shift"} ${span(x)}${x.adjusted ? `, amended from ${x.start} to ${x.end}` : ""}${x.job ? ", " + x.job : ""}${clashes.has(x.id) ? ", clash" : ""}${x.overtime > 0 ? ", overtime" : ""}` },
          `${span(x)}${x.job ? " · " + jobWord(x.job) : ""}${x.adjusted ? " · Amended" : ""}${x.overtime > 0 ? " · Overtime" : ""}${clashes.has(x.id) ? " · Clash" : ""}`)));
    });
    rows.push(el("div", { class: "tl-row" }, el("span", { class: "tl-name", text: "Add" }),
      el("button", { type: "button", class: "tl-track tl-add", "data-w": "", "aria-label": `Add a shift at ${s.name} on ${longD(day)}`, onclick: () => newShift(d, site, day) })));
    // People on shift each hour, against the minimum.
    const bars = el("div", { class: "tl-bars" });
    const onAt = (t) => list.filter((x) => x.userId && mins(effS(x)) <= t && mins(effE(x)) >= t + 60).length;
    const max = Math.max(1, s.minPeople, ...Array.from({ length: (b - a) / 60 }, (_, k) => onAt(a + k * 60)));
    for (let t = a; t < b; t += 60) {
      const n = onAt(t);
      const inHours = oh.opensAt && oh.closesAt && t >= mins(oh.opensAt) && t < mins(oh.closesAt);
      const low = inHours && n < s.minPeople;
      bars.append(el("span", { class: "tl-h" + (low ? " low" : ""), style: `left:${pos(t)}%;width:${pos(t + 60) - pos(t)}%;height:${Math.max(8, (n / max) * 100)}%`, title: `${hhmm(t)}: ${plural(n, "person", "people")}${low ? " (below " + s.minPeople + ")" : ""}` }, el("i", { text: String(n) })));
    }
    const tl = el("section", { class: "panel timeline" }, axis, ...rows,
      el("div", { class: "tl-row" }, el("span", { class: "tl-name", text: "On shift" }), bars),
      el("p", { class: "note", text: oh.opensAt && oh.closesAt ? `Each bar shows how many people are on that hour. Red bars are below the ${plural(s.minPeople, "person", "people")} ${s.name} needs from ${oh.opensAt} to ${oh.closesAt} on ${DAY_NAMES[dow(day)]}s.` : "Set opening hours and minimum cover in Rota settings to check cover." }));

    // On the day: a slider per person to amend when they started and finished (sent home sick, stayed late).
    const staffed = list.filter((x) => x.userId);
    const amend = day <= londonToday() && staffed.length
      ? el("section", { class: "stack amendbox" }, label("Amend hours on the day"), el("div", { class: "list glass" }, ...staffed.map((x) => amendRow(d, x, { onSaved: () => render() }))),
        el("p", { class: "note", text: "Slide when someone actually started or finished, for example if they went home sick or stayed late. The planned shift is kept; hours, overtime and cover use the amended times." }))
      : null;

    // Problems for this day, with a one-tap fix where there's an obvious one.
    const probs = d.problems.filter((p) => p.day === day && (!p.site || p.site === site || p.shiftIds.some((id) => list.some((x) => x.id === id))));
    const alerts = [];
    for (const p of probs) {
      const fixes = [];
      const sh = list.find((x) => p.shiftIds.includes(x.id));
      if (p.kind === "open_shift" && sh) fixes.push(btn("Fill", () => openShift(sh, d)));
      if (p.kind === "clash" && sh) {
        const fixBtn = btn("Finding who's free…", null, "btn", { disabled: true });
        fixes.push(fixBtn);
        get("/api/rota/suggest?shift=" + sh.id).then((r) => {
          const best = r.candidates.find((c) => c.best);
          if (!best) { fixBtn.textContent = "Change person"; fixBtn.disabled = false; fixBtn.onclick = () => openShift(sh, d); return; }
          fixBtn.textContent = `Give the ${sh.job === "closes" ? "close" : sh.job === "opens" ? "open" : "shift"} to ${first(best.name)}`; fixBtn.disabled = false;
          fixBtn.onclick = async () => { const before = sh.userId; const ok = await act(() => api("PATCH", "/api/rota/shifts/" + sh.id, { userId: best.userId })); if (ok) { toast(`Given to ${first(best.name)}`, ["Undo", async () => { await act(() => api("PATCH", "/api/rota/shifts/" + sh.id, { userId: before })); render(); }]); render(); } };
        }).catch(() => { fixBtn.textContent = "Change person"; fixBtn.disabled = false; fixBtn.onclick = () => openShift(sh, d); });
      }
      if ((p.kind === "no_opener" || p.kind === "no_closer") && list.length) {
        const job = p.kind === "no_opener" ? "opens" : "closes";
        const cand = [...list].filter((x) => x.userId && !x.job).sort((x, y) => (job === "opens" ? x.start.localeCompare(y.start) : y.end.localeCompare(x.end)))[0];
        if (cand) fixes.push(btn(`${first(nameOf(d, cand.userId))} ${job === "opens" ? "opens" : "closes"}`, async () => { if (await act(() => api("PATCH", "/api/rota/shifts/" + cand.id, { job }), "Saved")) render(); }));
      }
      if (p.kind === "short_cover") {
        const m = p.message.match(/(\d\d:\d\d)–(\d\d:\d\d)$/);
        if (m) fixes.push(btn("Add a shift then", () => openShift({ id: null, site, day, start: m[1], end: m[2], breakMins: 0, job: "", userId: null, note: "" }, d)));
      }
      alerts.push(el("div", { class: "alert rp " + p.severity, role: "note" }, el("span", { class: "ic" }, svgi(ICON.warn)),
        el("span", { class: "t" }, el("b", { text: p.severity === "error" ? "Problem" : p.severity === "warn" ? "Check" : "Note" }), el("span", { text: p.message })), ...fixes));
    }
    return [sitePick, strip, tl, amend, ...alerts];
  }

  // One person's shift with start and finish sliders, in 5-minute steps: the start can move later (came in
  // late) and the finish earlier (went home) or later (stayed on), up to 4 hours past the plan.
  function amendRow(d, x, { onSaved } = {}) {
    const nm = nameOf(d, x.userId) || "Someone";
    const ps = mins(x.start), pe = mins(x.end);
    let st = mins(effS(x)), en = mins(effE(x)), brk = x.adjusted ? x.actualBreakMins : x.breakMins;
    const id = "am_" + x.id;
    const startR = el("input", { type: "range", id: id + "_s", min: Math.max(0, ps - 180), max: pe, step: 5, value: st, "aria-label": `${first(nm)} started at` });
    const endR = el("input", { type: "range", id: id + "_e", min: ps, max: Math.min(23 * 60 + 55, pe + 240), step: 5, value: en, "aria-label": `${first(nm)} finished at` });
    const sOut = el("output", { for: startR.id }), eOut = el("output", { for: endR.id });
    const brkIn = el("input", { type: "number", min: 0, max: 180, step: 5, value: String(brk), inputmode: "numeric", "aria-label": `${first(nm)}'s unpaid break in minutes` });
    const why = el("input", { type: "text", maxlength: 200, value: x.adjustNote || "", placeholder: "Reason, e.g. went home sick", "aria-label": `Why ${first(nm)}'s hours changed` });
    const sum = el("span", { class: "amsum", "aria-live": "polite" });
    const save = btn("Save", null, "btn sm");
    const reset = x.adjusted ? ghost("As planned", async () => {
      if (await act(() => api("PUT", `/api/rota/shifts/${x.id}/actual`, { clear: true }), `${first(nm)}'s shift is back to ${x.start}–${x.end}`)) { if (R.weekData) R.weekData._at = 0; onSaved?.(); }
    }, { class: "btn ghost sm" }) : null;
    const quick = el("span", { class: "amquick" }, ...["Went home sick", "Left early", "Came in late", "Stayed late"].map((t) =>
      el("button", { type: "button", class: "fchip", onclick: () => { why.value = t; draw(); } }, t)));
    const changed = () => st !== mins(effS(x)) || en !== mins(effE(x)) || Number(brkIn.value || 0) !== brk || why.value.trim() !== (x.adjustNote || "");
    function draw() {
      st = Number(startR.value); en = Number(endR.value);
      if (en < st) { en = st; endR.value = String(en); }
      sOut.textContent = hhmm(st); eOut.textContent = hhmm(en);
      const paid = r2(Math.max(0, en - st - Number(brkIn.value || 0)) / 60);
      const diff = r2(paid - x.plannedHours);
      sum.textContent = `${hrs(paid)}h paid` + (diff ? ` (${diff > 0 ? "+" : "−"}${hrs(Math.abs(diff))}h on the plan)` : "") + (en === st ? " · didn't work" : "");
      sum.className = "amsum" + (diff > 0 ? " up" : diff < 0 ? " down" : "");
      save.disabled = !changed() || (st === ps && en === pe && !x.adjusted);
    }
    startR.oninput = draw; endR.oninput = draw; brkIn.oninput = draw; why.oninput = draw;
    save.onclick = async () => {
      if (st === ps && en === pe && Number(brkIn.value || 0) === x.breakMins && !why.value.trim()) {
        if (await act(() => api("PUT", `/api/rota/shifts/${x.id}/actual`, { clear: true }), "Back to the plan")) { if (R.weekData) R.weekData._at = 0; onSaved?.(); }
        return;
      }
      if (await act(() => api("PUT", `/api/rota/shifts/${x.id}/actual`, { start: hhmm(st), end: hhmm(en), breakMins: Number(brkIn.value || 0), note: why.value.trim() }),
        `${first(nm)}: ${hhmm(st)}–${hhmm(en)} saved`)) { if (R.weekData) R.weekData._at = 0; onSaved?.(); }
    };
    draw();
    return el("div", { class: "lrow amrow" },
      el("div", { class: "amhead" }, avatar(nm), el("span", { class: "t" }, el("b", { text: nm }),
        el("span", { class: "s", text: `Planned ${x.start}–${x.end}${x.adjusted ? ` · amended${x.adjustNote ? ": " + x.adjustNote : ""}` : ""}` })), sum),
      el("label", { class: "amslide", for: startR.id }, el("span", { text: "Started" }), startR, sOut),
      el("label", { class: "amslide", for: endR.id }, el("span", { text: "Finished" }), endR, eOut),
      el("div", { class: "amfoot" }, el("label", { class: "chours" }, el("span", { text: "Break" }), brkIn, el("span", { text: "min" })), why, quick, el("span", { class: "row" }, reset, save)));
  }

  /* ---------- my shifts (everyone) ---------- */

  async function renderMine() {
    const u = R.me.user;
    const toggle = seg([["mine", "Mine"], ["all", "Everyone"]], R.everyone ? "all" : "mine", (v) => { R.everyone = v === "all"; render(); }, "Whose shifts");
    if (R.everyone) {
      const d = await loadWeek(R.everyoneWeek || (R.everyoneWeek = monday(londonToday())), true);
      setHead("mine", "My shifts", `${weekLabel(d.week)} · ${d.published ? "published" : mgr() ? "draft (staff can't see it yet)" : "not published yet"}`, {
        actions: [el("button", { type: "button", class: "iconbtn", "aria-label": "Previous week", onclick: () => { R.everyoneWeek = addDays(d.week, -7); render(); } }, svgi(ICON.chevL)),
          el("button", { type: "button", class: "iconbtn", "aria-label": "Next week", onclick: () => { R.everyoneWeek = addDays(d.week, 7); render(); } }, svgi(ICON.chevR))],
      });
      if (!d.shifts.length) return [toggle, empty(d.published ? "No shifts this week." : "This week's rota hasn't been published yet.")];
      if (R.pday > 6) R.pday = 0;
      const body = el("div", { class: "stack" });
      const draw = () => body.replaceChildren(...(wide.matches ? [siteGrid(d, true)] : phoneDay(d, true, () => draw())));
      draw();
      return [toggle, body];
    }
    const today = londonToday(), now = londonNow();
    // Four weeks back to eight ahead, so one request (up to three months) covers it.
    const lo = addDays(monday(today), -28), hi = addDays(monday(today), 56);
    if (!R.mineWeek || R.mineWeek < lo || R.mineWeek > hi) R.mineWeek = monday(today);
    const wk = R.mineWeek;
    // One request covers the chosen week and the next four weeks from today.
    const from = wk < today ? wk : today, to = addDays(wk, 6) > addDays(today, 27) ? addDays(wk, 6) : addDays(today, 27);
    const [r, me, open] = await Promise.all([get(`/api/rota/mine?from=${from}&to=${to}`), get("/api/rota/me"), get("/api/rota/open").catch(() => ({ shifts: [] }))]);
    R.approvers = me.approvers;
    const ap = approverText(), apWord = ap === "A manager" ? "a manager" : ap;
    setHead("mine", "My shifts", u.name, { actions: weekNav(wk, (w) => { R.mineWeek = w; render(); }, { min: lo, max: hi }) });
    const coverOf = (s) => me.requests.find((q) => q.kind === "cover" && q.fromUser === u.id && q.shift?.id === s.id && ["open", "accepted"].includes(q.status));
    const upcoming = r.shifts.filter((s) => s.day > today || (s.day === today && s.end > now));
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(wk, i));
    const weekOut = r.published.includes(wk);
    const inWeek = r.shifts.filter((s) => s.day >= wk && s.day <= days[6]);
    const holidayOn = (day) => me.timeOff.find((t) => t.status === "approved" && t.from <= day && t.to >= day);
    const pat = (day) => me.pattern?.[DAYS[dow(day)]];

    // The left column: next shift (or what to do while nothing's out), the week strip, what's coming up.
    const left = [];
    if (upcoming.length) {
      const nx = upcoming[0];
      const whenWord = nx.day === today ? "Today" : nx.day === addDays(today, 1) ? "Tomorrow" : longD(nx.day);
      const others = nx.others.filter((o) => !o.open);
      left.push(el("section", { class: "hero nextshift" },
        el("div", { class: "kick", text: `Next shift · ${whenWord}` }), el("div", { class: "big", text: span(nx) }),
        nx.adjusted ? el("div", { class: "with", text: `Amended from ${nx.start}–${nx.end}${nx.adjustNote ? ": " + nx.adjustNote : ""}` }) : null,
        nx.overtime > 0 ? el("div", { class: "with", text: `Includes ${hrs(nx.overtime)}h overtime` }) : null,
        el("div", { text: `${nx.siteName}${nx.job ? ` · you ${nx.job === "opens" ? "open" : "close"}` : ""}${nx.breakMins ? ` · ${nx.breakMins} min break` : ""}` }),
        others.length ? el("div", { class: "with", text: "With " + others.map((o) => first(o.name) + (o.start !== nx.start ? ` from ${o.start}` : "")).join(", ") }) : el("div", { class: "with", text: "On your own" }),
        nx.note ? el("div", { class: "with", text: nx.note }) : null,
        el("div", { class: "row" }, el("button", { type: "button", class: "hbtn", onclick: () => calendarFile(nx) }, svgi(ICON.cal), "Add to calendar"),
          coverOf(nx) ? el("span", { class: "hbtn on", text: "Cover asked" }) : el("button", { type: "button", class: "hbtn", "data-w": "", onclick: () => askCover(nx) }, "Ask for cover"))));
    } else {
      const anyAhead = r.published.some((w) => w >= monday(today));
      const last = [...r.shifts].filter((s) => s.day < today).pop();
      const patText = availText(me.pattern);
      left.push(el("section", { class: "panel mempty" },
        el("h2", { text: anyAhead ? "No shifts for you yet" : "The rota isn't out yet" }),
        el("p", { class: "note", text: (anyAhead ? "You're not on the published weeks ahead. New shifts appear here as soon as a manager adds you." : "Your shifts appear here as soon as a manager publishes the week.") + (last ? ` Your last shift was ${shortM(last.day)} at ${last.siteName}.` : "") }),
        el("div", { class: "msteps" },
          step("avail", "acc", "Check when you can work", patText ? `Managers plan around it. ${patText}.` : "Managers plan around it.", "Check", () => go("avail")),
          step("plane", "ok", "Need time off?", "Ask now so it's in before they plan.", "Ask", askTimeOff))));
    }
    left.push(el("div", { class: "label mlabel" }, el("span", { text: wk === monday(today) ? "Your week" : `Week of ${fmt(wk, { day: "numeric", month: "long" })}` }),
      el("span", { text: weekOut ? plural(inWeek.length, "shift") : "not published yet" })));
    left.push(el("div", { class: "glass mweek", role: "list", "aria-label": "Your week" }, ...days.map((day) => {
      const here = inWeek.filter((s) => s.day === day);
      const hol = holidayOn(day);
      let blks;
      if (!weekOut) blks = [el("div", { class: "blk draft", text: "Not out yet" })];
      else if (here.length) blks = here.map((s) => {
        const tone = SITE_TONE[s.site] || "";
        return el("button", { type: "button", class: `blk shift tone-${tone}` + (s.overtime > 0 ? " ot" : "") + (day < today ? " past" : ""), onclick: () => shiftActions(s, coverOf(s)),
          "aria-label": `${longD(day)}: ${span(s)} at ${s.siteName}${s.job ? ", " + jobWord(s.job).toLowerCase() : ""}${s.overtime > 0 ? `, ${hrs(s.overtime)}h overtime` : ""}` },
          el("b", { class: "tm" }, effS(s), el("br"), effE(s)), el("span", { class: "site", "data-s": s.siteName.slice(0, 1), text: s.siteName }), el("span", { class: "jobw", text: jobWord(s.job) || " " }));
      });
      else if (hol) blks = [el("div", { class: "blk hol", text: "Holiday" })];
      else if (pat(day) === "off") blks = [el("div", { class: "blk off cant", text: "Can't work" })];
      else blks = [el("div", { class: "blk off", text: "Off" })];
      return el("div", { class: "mday" + (day === today ? " today" : ""), role: "listitem" },
        el("div", { class: "dh" }, fmt(day, { weekday: "short" }), el("b", { text: fmt(day, { day: "numeric" }) })), ...blks);
    }), weekOut && inWeek.length ? el("div", { class: "mlegend" }, ...[...new Map(inWeek.map((s) => [s.site, s.siteName]))].map(([id, n]) => el("span", {}, el("i", { class: "tone-" + (SITE_TONE[id] || "") }), `${n[0]} ${n}`)),
      inWeek.some((s) => s.overtime > 0) ? el("span", {}, el("i", { class: "otsw" }), "Overtime") : null) : null));
    const later = upcoming.filter((s) => s.day > days[6]).slice(0, 8);
    if (later.length) {
      left.push(label("Coming up"));
      left.push(el("div", { class: "list glass" }, ...later.map((s) => mineRow(s, coverOf(s)))));
    }
    if (inWeek.some((s) => s.overtime > 0)) left.push(el("p", { class: "note mnote", text: "Overtime shows in pink: it's hours over your contract's maximum." }));

    // The right column: hours, what needs the person, their requests, when they can work.
    const right = [];
    const wkTot = (r.weeks || []).find((x) => x.week === wk);
    const h = wkTot ? wkTot.hours : r2(inWeek.reduce((a, s) => a + s.hours, 0));
    const ot = wkTot?.overtime || 0;
    const range = contractLabel(r);
    right.push(label(wk === monday(today) ? "This week" : "That week"));
    right.push(el("section", { class: "panel mhours" },
      el("div", { class: "big" }, el("b", { text: `${hrs(h)}h` }), el("span", { text: !weekOut ? `nothing published yet${range ? ` · contract ${range}h` : ""}` : range ? `of ${range}h contract${ot ? ` · ${hrs(ot)}h overtime` : r.contractMin != null && h < r.contractMin ? ` · ${hrs(r2(r.contractMin - h))}h under your minimum` : ""}` : "no contract hours set" })),
      range ? hoursBar(h, r) : null,
      range ? el("div", { class: "scale" }, el("span", { text: "0" }), r.contractMin != null && r.contractMin !== r.contractMax ? el("span", { text: `${hrs(r.contractMin)}h min` }) : null, el("span", { text: `${hrs(r.contractMax ?? r.contractMin)}h max` })) : null));

    const asked = me.requests.filter((q) => q.kind === "cover" && q.status === "open" && q.fromUser !== u.id && (!q.toUser || q.toUser === u.id) && q.shift && q.shift.day >= today);
    const takeable = (open.shifts || []).filter((s) => !s.asked && !s.takenBySomeone).slice(0, 3);
    const needs = [
      ...asked.slice(0, 3).map((q) => el("div", { class: "lrow nrow" }, el("span", { class: "ic warn" }, svgi(ICON.hand)),
        el("span", { class: "t" }, el("b", { text: `${first(q.fromName)} asked ${q.toUser ? "you" : "anyone"} to cover` }), el("span", { class: "s", text: `${shortM(q.shift.day)} · ${q.shift.start}–${q.shift.end} · ${q.shift.siteName}` })),
        btn("Cover it", async () => { if (await act(() => api("PATCH", "/api/rota/requests/" + q.id, { action: "accept" }), `Thanks. ${ap} approves it before it's yours.`)) render(); }, "btn sm"))),
      ...takeable.map((s) => el("div", { class: "lrow nrow" }, el("span", { class: "ic acc" }, svgi(ICON.swap)),
        el("span", { class: "t" }, el("b", { text: "Open shift you could take" }), el("span", { class: "s", text: `${shortM(s.day)} · ${s.start}–${s.end} · ${s.siteName}` })),
        btn("Take it", async () => { if (await act(() => api("POST", "/api/rota/requests", { kind: "claim", shiftId: s.id }), `Asked. ${ap} approves it before it's yours.`)) render(); }, "btn sm soft"))),
    ];
    right.push(el("div", { class: "label mlabel" }, el("span", { text: "Needs you" }), needs.length ? el("a", { href: "#swaps", class: "lk", text: "See all" }) : null));
    right.push(needs.length ? el("div", { class: "list glass" }, ...needs) : el("section", { class: "panel" }, el("p", { class: "note", text: "Nothing needs you right now." })));

    const recent = Date.now() - 14 * 864e5;
    const reqs = [
      ...me.timeOff.filter((o) => o.to >= today && ["requested", "approved", "declined"].includes(o.status) && (o.status !== "declined" || (o.decidedAt || 0) > recent)).map((o) => {
        const st = { approved: ["Approved", "ok"], requested: ["Waiting", "warn"], declined: ["Declined", "bad"] }[o.status];
        const rng = o.from === o.to ? shortM(o.from) : `${fmt(o.from, { day: "numeric", month: "short" })}–${fmt(o.to, { day: "numeric", month: "short" })}`;
        return el("div", { class: "lrow nrow" }, el("span", { class: "ic " + (st[1] === "ok" ? "ok" : st[1] === "bad" ? "bad" : "warn") }, svgi(ICON.plane)),
          el("span", { class: "t" }, el("b", { text: `Time off: ${rng}` }), el("span", { class: "s", text: o.status === "requested" ? `Waiting for ${apWord}` : o.reason || (o.status === "approved" ? "Booked" : "Not approved") })),
          el("span", { class: "pill " + st[1], text: st[0] }));
      }),
      ...me.requests.filter((q) => q.fromUser === u.id && q.shift && q.shift.day >= today && (["open", "accepted"].includes(q.status) || (q.decidedAt || q.createdAt || 0) > recent && q.status !== "cancelled")).map((q) => {
        const [txt, cls] = statusText({ ...q, takerId: q.taker }, u.id);
        return el("div", { class: "lrow nrow" }, el("span", { class: "ic " + (cls === "ok" ? "ok" : cls === "bad" ? "bad" : "warn") }, svgi(ICON.swap)),
          el("span", { class: "t" }, el("b", { text: `${q.kind === "claim" ? "Pick up" : "Cover for"} ${shortM(q.shift.day)}` }), el("span", { class: "s", text: txt })),
          el("span", { class: "pill " + (cls || ""), text: q.status === "approved" ? "Approved" : q.status === "declined" ? "Declined" : "Waiting" }));
      }),
    ];
    if (reqs.length) {
      right.push(el("div", { class: "label mlabel" }, el("span", { text: "Your requests" }), el("a", { href: "#swaps", class: "lk", text: "All" })));
      right.push(el("div", { class: "list glass" }, ...reqs.slice(0, 5)));
    }

    right.push(el("div", { class: "label mlabel" }, el("span", { text: "When you can work" }), el("a", { href: "#avail", class: "lk", text: "Details" })));
    const chip = (k, i) => {
      const v = me.pattern?.[k];
      const dn = DAY_NAMES[i].slice(0, 2);
      if (v === "off") return el("span", { class: "off", "aria-label": `${DAY_NAMES[i]}: can't work` }, dn);
      const t = v && typeof v === "object" ? `${v.from ? v.from.replace(/:00$/, "") : ""}–${v.to ? v.to.replace(/:00$/, "") : ""}` : "";
      return el("span", { "aria-label": `${DAY_NAMES[i]}: ${t ? (v.from ? "from " + v.from : "") + (v.to ? " until " + v.to : "") : "any time"}` }, dn, t ? el("small", { text: t }) : null);
    };
    const sitesText = (me.sites || []).length ? joinAnd(me.sites.map(siteName)) : "Any site";
    right.push(el("section", { class: "panel mavail" }, el("div", { class: "avail" }, ...DAYS.map(chip)), el("p", { class: "note", text: `${sitesText} · set by an admin` })));

    return [toggle, el("div", { class: "mgrid" }, el("div", { class: "mcol" }, ...left), el("div", { class: "mcol" }, ...right))];
  }

  const SITE_NAMES = { roastery: "Roastery", cafe: "Cafe", asg: "ASG", factory: "Factory" };
  const siteName = (id) => SITE_NAMES[id] || id;
  // "Mon from 07:00, Sun off".
  function availText(pattern) {
    const parts = [];
    DAYS.forEach((k, i) => {
      const v = pattern?.[k], dn = DAY_NAMES[i].slice(0, 3);
      if (v === "off") parts.push(`${dn} off`);
      else if (v && typeof v === "object") parts.push(`${dn} ${v.from || ""}–${v.to || ""}`);
    });
    return parts.join(", ");
  }
  function step(ic, tone, title, text, action, fn) {
    return el("div", { class: "mstep" }, el("span", { class: "ic " + tone }, svgi(ICON[ic])), el("span", { class: "t" }, el("b", { text: title }), el("span", { class: "s", text })), btn(action, fn, "btn sm soft"));
  }
  function mineRow(s, cov) {
    const o = s.others.filter((x) => !x.open);
    return el("button", { type: "button", class: "lrow mrow", onclick: () => shiftActions(s, cov) },
      el("span", { class: "dbadge" }, el("span", { text: fmt(s.day, { weekday: "short" }).toUpperCase() }), el("b", { text: fmt(s.day, { day: "numeric" }) })),
      el("span", { class: "t" }, el("b", { text: `${span(s)}${s.job ? " · " + jobWord(s.job) : ""}` }),
        el("span", { class: "s", text: (s.adjusted ? `Amended from ${s.start}–${s.end} · ` : "") + (o.length ? "With " + o.map((x) => first(x.name)).join(", ") : "On your own") + (cov ? " · cover asked" : "") }),
        s.overtime > 0 ? el("span", { class: "otag", text: `${hrs(s.overtime)}h overtime` }) : null),
      sitePill(s.site, s.siteName));
  }

  function shiftActions(s, cov) {
    openSheet(`${shortM(s.day)} · ${s.start}–${s.end}`, el("div", { class: "sbody" },
      el("p", { class: "note", text: `${s.siteName}${s.job ? " · " + jobWord(s.job).toLowerCase() : ""} · ${hrs(s.hours)} paid hours${s.breakMins ? ` (${s.adjusted ? s.actualBreakMins : s.breakMins} min unpaid break)` : ""}${s.overtime > 0 ? ` · ${hrs(s.overtime)}h overtime` : ""}` }),
      s.adjusted ? el("p", { class: "note", text: `Amended from ${s.start}–${s.end}${s.adjustNote ? ": " + s.adjustNote : ""}` }) : null,
      s.note ? el("p", { text: s.note }) : null,
      el("div", { class: "sfoot" }, ghost("Add to calendar", () => { calendarFile(s); closeSheets(); }),
        // Cover only for a shift that hasn't started.
        cov ? btn("Cover asked", null, "btn", { disabled: true }) : s.day > londonToday() || (s.day === londonToday() && s.start > londonNow()) ? btn("Ask for cover", () => askCover(s)) : null)), { left: cancelLink() });
  }

  async function askCover(s) {
    // Everyone on the rota (names and account ids) comes with the week.
    let people = [];
    try { people = (await get("/api/rota/week?start=" + monday(s.day))).people || []; } catch (e) {}
    const u = R.me.user;
    const sel = el("select", { id: "c_to" }, el("option", { value: "" }, "Anyone who can"), ...people.filter((p) => p.id !== u.id).map((p) => el("option", { value: p.id }, p.name)));
    const note = el("input", { type: "text", id: "c_msg", maxlength: 300, placeholder: "e.g. Family wedding, could you take my shift?" });
    const msg = el("p", { class: "smsg", role: "alert" });
    openSheet("Ask for cover", el("div", { class: "sbody" },
      el("p", { class: "note", text: `${shortM(s.day)} · ${s.start}–${s.end} at ${s.siteName}` }),
      el("div", { class: "field" }, el("label", { class: "label", for: "c_to", text: "Ask" }), sel),
      el("div", { class: "field" }, el("label", { class: "label", for: "c_msg", text: "Message (optional)" }), note), msg,
      el("p", { class: "note", text: `${approverText()} approves it before it changes hands. It stays your shift until then.` }),
      el("div", { class: "sfoot" }, btn("Send request", async () => {
        try {
          await api("POST", "/api/rota/requests", { kind: "cover", shiftId: s.id, toUserId: sel.value || null, message: note.value.trim() });
          closeSheets(); toast("Asked. You'll see replies under Open shifts & cover."); render();
        } catch (e) { msg.textContent = e.message; }
      }))), { left: cancelLink() });
  }

  /* ---------- open shifts and cover (everyone) ---------- */

  const statusText = (q, u) => {
    const ap = approverText();
    if (q.status === "approved") return ["Approved", "ok"];
    if (q.status === "declined") return ["Declined", "bad"];
    if (q.status === "cancelled") return ["Cancelled", ""];
    if (q.kind === "claim") return [`Waiting for ${ap === "A manager" ? "a manager" : ap} to approve`, "warn"];
    if (q.status === "accepted") return [`${q.takerId === u ? "You" : first(q.takerName)} offered · ${ap === "A manager" ? "a manager" : ap} to approve`, "warn"];
    return [q.toUser ? `Waiting for ${first(q.toName)}` : "Offered to anyone", "warn"];
  };

  async function renderSwaps() {
    const u = R.me.user;
    const today = londonToday();
    const [open, me, mine] = await Promise.all([get("/api/rota/open"), get("/api/rota/me"), get(`/api/rota/mine?from=${monday(today)}&to=${addDays(today, 41)}`)]);
    R.approvers = me.approvers;
    setHead("swaps", "Open shifts & cover", "Open shifts you can pick up, and cover requests", mgr() ? {} : {});
    const weekHours = (day) => r2(mine.shifts.filter((s) => monday(s.day) === monday(day)).reduce((a, s) => a + s.hours, 0));
    let hidden = []; try { hidden = JSON.parse(localStorage.getItem("rota.notForMe") || "[]"); } catch (e) {}
    const ap = approverText();
    const out = [];

    const shifts = open.shifts.filter((s) => !hidden.includes(s.id));
    out.push(label("Open shifts you can do"));
    if (!shifts.length) out.push(el("section", { class: "panel" }, el("p", { class: "note", text: "None right now. Open shifts from published weeks appear here." })));
    for (const s of shifts) {
      const after = r2(weekHours(s.day) + s.hours);
      const myClaim = me.requests.find((q) => q.kind === "claim" && q.fromUser === u.id && q.shift?.id === s.id && q.status === "open");
      out.push(el("section", { class: "panel ocard" },
        el("div", { class: "row spread" }, el("b", { class: "big", text: `${short(s.day)} · ${s.start}–${s.end}` }), sitePill(s.site, s.siteName)),
        el("p", { class: "note", text: [jobWord(s.job) && (s.job === "opens" ? "Opening" : "Closing"), `${hrs(s.hours)} hours`, `you'd be on ${hrs(after)}h that week`].filter(Boolean).join(" · ") }),
        s.asked
          ? el("div", { class: "row" }, el("span", { class: "pill warn", text: `Asked · waiting for ${ap === "A manager" ? "a manager" : ap}` }), myClaim ? ghost("Cancel", async () => { if (await act(() => api("PATCH", "/api/rota/requests/" + myClaim.id, { action: "cancel" }), "Cancelled")) render(); }, { class: "btn ghost sm" }) : null)
          : s.takenBySomeone ? el("p", { class: "note", text: "Someone has already asked for this one." })
          : el("div", { class: "row two" },
            ghost("Not for me", () => { hidden.push(s.id); try { localStorage.setItem("rota.notForMe", JSON.stringify(hidden.slice(-200))); } catch (e) {} render(); }),
            btn("I'll take it", async () => { if (await act(() => api("POST", "/api/rota/requests", { kind: "claim", shiftId: s.id }), `Asked. ${ap} approves it before it's yours.`)) render(); })),
        el("p", { class: "note", text: `${ap} approves it before it's yours.` })));
    }

    const asked = me.requests.filter((q) => q.kind === "cover" && q.status === "open" && q.fromUser !== u.id && (!q.toUser || q.toUser === u.id) && q.shift && q.shift.day >= today);
    out.push(label("Asked of you"));
    if (!asked.length) out.push(el("section", { class: "panel" }, el("p", { class: "note", text: "No one has asked you to cover a shift." })));
    for (const q of asked) {
      const s = q.shift;
      const clash = mine.shifts.some((m) => m.day === s.day && mins(m.start) < mins(s.end) && mins(s.start) < mins(m.end));
      out.push(el("section", { class: "panel ocard" },
        el("div", { class: "row" }, avatar(q.fromName), el("span", { class: "t" }, el("b", { text: `${first(q.fromName)} asks ${q.toUser ? "you" : "anyone"} to cover` }), el("span", { class: "s", text: "Sent " + when(q.createdAt) }))),
        q.message ? el("blockquote", { class: "quote", text: `“${q.message}”` }) : null,
        el("div", { class: "row spread" }, el("b", { text: `${short(s.day)} · ${s.start}–${s.end}${s.job ? " · " + jobWord(s.job) : ""}` }), sitePill(s.site, s.siteName)),
        el("p", { class: "note", text: clash ? "You already have a shift then." : `You're free · you'd be on ${hrs(weekHours(s.day) + s.hours)}h that week` }),
        el("div", { class: "row two" },
          q.toUser === u.id ? ghost("Decline", async () => { if (await act(() => api("PATCH", "/api/rota/requests/" + q.id, { action: "decline" }), "Declined")) render(); }) : el("span"),
          btn("Cover it", async () => { if (await act(() => api("PATCH", "/api/rota/requests/" + q.id, { action: "accept" }), `Thanks. ${ap} approves it before it's yours.`)) render(); }, "btn", { disabled: clash })),
        el("p", { class: "note", text: `${ap} approves it before it's yours.` })));
    }

    const own = me.requests.filter((q) => (q.fromUser === u.id || (q.taker === u.id && q.kind === "cover")) && q.shift);
    out.push(label("Your requests"));
    if (!own.length) out.push(el("section", { class: "panel" }, el("p", { class: "note", text: "Nothing yet. Ask for cover from a shift under My shifts." })));
    else out.push(el("div", { class: "list glass" }, ...own.map((q) => {
      const s = q.shift;
      const [txt, cls] = statusText({ ...q, takerId: q.taker }, u.id);
      const what = q.kind === "claim" ? "You asked to pick this up" : q.fromUser === u.id ? (q.toUser ? `Asked ${first(q.toName)} to cover` : `Offered to anyone at ${s.siteName}`) : `You offered to cover ${first(q.fromName)}'s shift`;
      return el("div", { class: "lrow" }, el("span", { class: "t" }, el("b", { text: `${short(s.day)} · ${s.start}–${s.end}` }), el("span", { class: "s", text: what }),
        el("span", { class: "stat " + cls }, el("span", { class: "sdot " + (cls === "ok" ? "ok" : cls === "bad" ? "bad" : cls ? "warn" : ""), "aria-hidden": "true" }), txt)),
        sitePill(s.site, s.siteName),
        ["open", "accepted"].includes(q.status) && q.fromUser === u.id ? ghost("Cancel", async () => { if (await act(() => api("PATCH", "/api/rota/requests/" + q.id, { action: "cancel" }), "Cancelled")) render(); }, { class: "btn ghost sm" }) : null);
    })));
    return out;
  }

  /* ---------- when I can work (everyone) ---------- */

  // Which days and sites someone can work. Only admins change it (their own, or anyone's from Rota settings:
  // #avail/<userId>); everyone else sees theirs read-only, and still books their own time off here.
  async function renderAvail([uid] = []) {
    const me = await get("/api/rota/me");
    R.approvers = me.approvers;
    const other = uid && uid !== me.user.id && isAdmin();
    let person = null;
    if (other) {
      person = (await loadWeek(R.week, true)).people.find((p) => p.id === uid);
      if (!person) { go("settings"); return []; }
    }
    const canEdit = isAdmin();
    setHead("avail", other ? person.name : "When I can work", other ? "When they can work" : canEdit ? "Managers see this when they plan the rota" : "Set by an admin. Managers see this when they plan the rota",
      other ? { back: ["Rota settings", "settings"] } : {});
    let pattern = JSON.parse(JSON.stringify((other ? person.pattern : me.pattern) || {}));
    let sites = [...((other ? person.sites : me.sites) || [])];
    let t;
    const saveSoon = () => { clearTimeout(t); t = setTimeout(async () => {
      const ok = await act(() => other ? api("PUT", "/api/rota/people/" + uid, { pattern, sites }) : api("PUT", "/api/rota/me/availability", { pattern, sites }), "Saved");
      if (ok && R.weekData) R.weekData._at = 0;
    }, 500); };
    const dayText = (v) => v === "off" ? "Can't work" : v === "any" ? "Any time" : v.from && v.to ? `${v.from}–${v.to}` : v.from ? `From ${v.from}` : `Until ${v.to}`;
    const SITES = [["roastery", "Roastery"], ["cafe", "Cafe"], ["asg", "ASG"], ["factory", "Factory"]];
    if (!canEdit) {
      const rowsRO = el("div", { class: "list glass" }, ...DAYS.map((k, i) => el("div", { class: "lrow avrow" },
        el("b", { class: "dn", text: fmt(addDays("2026-11-09", i), { weekday: "short" }) }), el("span", { class: "s", text: dayText(pattern[k] ?? "any") }))));
      const siteText = sites.length ? SITES.filter(([id]) => sites.includes(id)).map(([, n]) => n).join(", ") : "Any site";
      return [label("Each week"), rowsRO,
        label("Sites"), el("section", { class: "panel" }, el("p", { text: siteText })),
        el("p", { class: "note", text: "Only an admin can change which days and sites you work. Ask them if something here is wrong." }),
        label("Time off"), timeOffList(me), el("div", { class: "row" }, btn("Ask for time off", askTimeOff))];
    }

    const rows = el("div", { class: "list glass" });
    const drawRows = () => rows.replaceChildren(...DAYS.map((k, i) => {
      const v = pattern[k] ?? "any";
      const on = v !== "off";
      const sw = el("input", { type: "checkbox", id: "av_" + k, "data-w": "", "aria-label": `${DAY_NAMES[i]}: can work` });
      sw.checked = on;
      sw.onchange = () => { pattern[k] = sw.checked ? "any" : "off"; drawRows(); saveSoon(); };
      const desc = dayText(v);
      const row = el("div", { class: "lrow avrow" }, el("b", { class: "dn", text: fmt(addDays("2026-11-09", i), { weekday: "short" }) }),
        on ? el("button", { type: "button", class: "tchip" + (v === "any" ? " any" : ""), "data-w": "", "aria-expanded": "false", onclick: () => times.hidden = !times.hidden }, desc) : el("span", { class: "s", text: desc }),
        el("span", { class: "grow" }), el("label", { class: "rswitch" }, sw));
      const fromI = el("input", { type: "time", value: typeof v === "object" ? v.from || "" : "", "aria-label": `${DAY_NAMES[i]} from` });
      const toI = el("input", { type: "time", value: typeof v === "object" ? v.to || "" : "", "aria-label": `${DAY_NAMES[i]} until` });
      const apply = () => { const o = {}; if (fromI.value) o.from = fromI.value; if (toI.value) o.to = toI.value; if (o.from && o.to && o.to <= o.from) { toast("Until has to be after from."); return; } pattern[k] = Object.keys(o).length ? o : "any"; drawRows(); saveSoon(); };
      const times = el("div", { class: "avtimes", hidden: true }, el("label", {}, "From ", fromI), el("label", {}, "Until ", toI),
        ghost("Any time", () => { pattern[k] = "any"; drawRows(); saveSoon(); }, { class: "btn ghost sm" }), btn("Set", apply, "btn sm"));
      return el("div", { class: "avwrap" }, row, times);
    }));
    drawRows();

    const siteBox = el("div", { class: "fchips", role: "group", "aria-label": other ? "Sites they can work at" : "Sites I can get to" });
    const drawSites = () => siteBox.replaceChildren(...SITES.map(([id, nm]) => el("button", { type: "button", class: "fchip", "data-w": "", "aria-pressed": String(sites.includes(id)),
      onclick: () => { sites = sites.includes(id) ? sites.filter((x) => x !== id) : [...sites, id]; drawSites(); saveSoon(); } }, nm)));
    drawSites();

    if (other) {
      return [label("Each week"), rows, el("p", { class: "note", text: "Switch off days they can't work. Tap a day's time to give a from or until time." }),
        label("Sites they can work at"), el("section", { class: "panel" }, siteBox, el("p", { class: "note", text: "None ticked means any site." }))];
    }
    return [label("Each week"), rows, el("p", { class: "note", text: "Switch off days you can't work. Tap a day's time to give a from or until time." }),
      label("Sites I can get to"), el("section", { class: "panel" }, siteBox, el("p", { class: "note", text: "None ticked means any site." })),
      label("Time off"), timeOffList(me), el("div", { class: "row" }, btn("Ask for time off", askTimeOff))];
  }

  function timeOffList(me) {
    return el("div", { class: "list glass" }, ...(me.timeOff.length ? me.timeOff.map((o) => {
      const days = Math.round((dOf(o.to) - dOf(o.from)) / 864e5) + 1;
      const range = o.from === o.to ? fmt(o.from, { weekday: "short", day: "numeric", month: "long" }) : `${fmt(o.from, { day: "numeric", month: "short" })}–${fmt(o.to, { day: "numeric", month: "short" })}`;
      const ap = approverText();
      const st = { approved: ["Approved", "ok"], requested: [`Waiting for ${ap === "A manager" ? "a manager" : ap}`, "warn"], declined: ["Declined", "bad"], cancelled: ["Cancelled", ""] }[o.status] || [o.status, ""];
      return el("div", { class: "lrow" }, el("span", { class: "t" }, el("b", { text: range }), el("span", { class: "s", text: [o.reason, plural(days, "day")].filter(Boolean).join(" · ") })),
        el("span", { class: "pill " + st[1], text: st[0] }),
        // Time off that has started is a manager's to change.
        ["requested", "approved"].includes(o.status) && o.to >= londonToday() && (mgr() || o.status === "requested" || o.from >= londonToday()) ? ghost("Cancel", async () => { if (await act(() => api("PATCH", "/api/rota/time-off/" + o.id, { status: "cancelled" }), "Cancelled")) render(); }, { class: "btn ghost sm" }) : null);
    }) : [el("div", { class: "empty", text: "No time off booked." })]));
  }

  function askTimeOff() {
    const t = londonToday();
    const from = el("input", { type: "date", id: "t_from", value: addDays(t, 14), min: t });
    const to = el("input", { type: "date", id: "t_to", value: addDays(t, 14), min: t });
    from.onchange = () => { if (to.value < from.value) to.value = from.value; };
    const why = el("input", { type: "text", id: "t_why", maxlength: 200, placeholder: "e.g. Holiday" });
    const msg = el("p", { class: "smsg", role: "alert" });
    openSheet("Ask for time off", el("div", { class: "sbody" },
      el("div", { class: "sfields" }, el("div", { class: "field" }, el("label", { class: "label", for: "t_from", text: "First day" }), from),
        el("div", { class: "field" }, el("label", { class: "label", for: "t_to", text: "Last day" }), to),
        el("div", { class: "field wide" }, el("label", { class: "label", for: "t_why", text: "Reason (optional)" }), why)), msg,
      el("p", { class: "note", text: `${approverText()} approves it. You'll see the answer here.` }),
      el("div", { class: "sfoot" }, btn("Send", async () => {
        try { await api("POST", "/api/rota/time-off", { from: from.value, to: to.value, reason: why.value.trim() }); closeSheets(); toast("Asked. You'll see the answer under Time off."); render(); }
        catch (e) { msg.textContent = e.message; }
      }))), { left: cancelLink() });
  }

  /* ---------- requests (managers) ---------- */

  async function renderRequests() {
    const r = await get("/api/rota/requests");
    R.badge = r.timeOff.length + r.requests.filter((q) => (q.kind === "claim" && q.status === "open") || (q.kind === "cover" && q.status === "accepted")).length;
    renderNav();
    setHead("requests", "Requests", R.badge ? `${plural(R.badge, "thing")} waiting for you` : "Nothing waiting for you");
    const decide = (url, body, ok) => async () => { if (await act(() => api("PATCH", url, body), ok)) { if (R.weekData) R.weekData._at = 0; render(); } };
    const out = [label("Time off")];
    out.push(r.timeOff.length ? el("div", { class: "list glass" }, ...r.timeOff.map((t) => el("div", { class: "lrow wraprow" }, avatar(t.name),
      el("span", { class: "t" }, el("b", { text: t.name }), el("span", { class: "s", text: `${t.from === t.to ? shortM(t.from) : shortM(t.from) + " – " + shortM(t.to)}${t.reason ? " · " + t.reason : ""}` })),
      // Another manager or an admin decides a manager's own time off.
      t.userId === R.me.user.id && !isAdmin() ? el("span", { class: "acts note", text: "Another manager or an admin decides this" })
        : el("span", { class: "acts" }, ghost("Decline", decide("/api/rota/time-off/" + t.id, { status: "declined" }, "Declined"), { class: "btn ghost sm" }),
          btn("Approve", decide("/api/rota/time-off/" + t.id, { status: "approved" }, "Approved"), "btn sm")))))
      : el("section", { class: "panel" }, el("p", { class: "note", text: "No time off waiting." })));
    out.push(label("Pickups and covers"));
    const rows = r.requests.map((q) => {
      const s = q.shift;
      const line = `${shortM(s.day)} · ${s.start}–${s.end} · ${s.siteName}${s.job ? " · " + jobWord(s.job).toLowerCase() : ""}`;
      let title, ready = false;
      if (q.kind === "claim") { title = `${q.fromName} wants to pick up an open shift`; ready = true; }
      else if (q.status === "accepted") { title = `${q.takerName} will cover ${q.fromName}'s shift`; ready = true; }
      else title = `${q.fromName} asked ${q.toUser ? q.toName : "anyone"} to cover · no reply yet`;
      return el("div", { class: "lrow wraprow" }, avatar(q.kind === "claim" ? q.fromName : q.takerName || q.fromName),
        el("span", { class: "t" }, el("b", { text: title }), el("span", { class: "s", text: line }), q.message ? el("span", { class: "s", text: `“${q.message}”` }) : null),
        el("span", { class: "acts" }, ghost("Decline", decide("/api/rota/requests/" + q.id, { action: "decline" }, "Declined"), { class: "btn ghost sm" }),
          ready ? btn("Approve", decide("/api/rota/requests/" + q.id, { action: "approve" }, "Approved. The rota is updated."), "btn sm") : null));
    });
    out.push(rows.length ? el("div", { class: "list glass" }, ...rows) : el("section", { class: "panel" }, el("p", { class: "note", text: "No pickups or covers waiting." })));
    return out;
  }

  /* ---------- more, hours and settings (managers) ---------- */

  function renderMore() {
    setHead("more", "More", "");
    const row = (t, sub, ic, tile, fn) => el("button", { class: "lrow", type: "button", onclick: fn }, el("span", { class: "tile " + tile }, svgi(ICON[ic])),
      el("span", { class: "t" }, el("b", { text: t }), sub ? el("span", { class: "s", text: sub }) : null), el("span", { class: "chev" }, svgi(ICON.chevR)));
    return [el("div", { class: "list glass" },
        row("Hours", "Rota hours against contracts, CSV download", "hours", "blue", () => go("hours")),
        row("Rota settings", "Opening times, minimum cover and contract hours", "setup", "grey", () => go("settings"))),
      label("Your own shifts"),
      el("div", { class: "list glass" }, row("Open shifts & cover", "Pick up shifts, ask for cover", "swap", "teal", () => go("swaps")),
        row("When I can work", "Your weekly pattern and time off", "avail", "indigo", () => go("avail"))),
      label("Kitchen Diary"),
      el("div", { class: "list glass" }, row("Open the diary", "Today's checks and records", "diary", "green", () => { location.href = R.links.diary; })),
      label("Account"),
      el("div", { class: "list glass" }, ...accountItems().map(([t, ic, fn, danger]) => el("button", { class: "lrow" + (danger ? " danger" : ""), type: "button", onclick: fn },
        el("span", { class: "tile " + (danger ? "red" : "grey") }, svgi(ICON[ic])), el("span", { class: "t" }, el("b", { text: t }), danger ? el("span", { class: "s", text: "Signed in as " + R.me.user.name }) : null))))];
  }

  async function renderHours() {
    const w = R.hoursWeek || (R.hoursWeek = R.week);
    const r = await get("/api/rota/hours?start=" + w);
    setHead("hours", "Hours", `${weekLabel(r.week)} · all sites${r.published ? "" : " · draft"}`, {
      back: ["More", "more"],
      actions: [el("button", { type: "button", class: "iconbtn", "aria-label": "Previous week", onclick: () => { R.hoursWeek = addDays(r.week, -7); render(); } }, svgi(ICON.chevL)),
        el("button", { type: "button", class: "iconbtn", "aria-label": "Next week", onclick: () => { R.hoursWeek = addDays(r.week, 7); render(); } }, svgi(ICON.chevR))],
    });
    const names = { roastery: "Roastery", cafe: "Cafe", asg: "ASG", factory: "Factory" };
    const stats = el("div", { class: "stat3 hstats" }, ...Object.entries(r.siteTotals).filter(([id, h]) => h || id !== "factory").map(([id, h]) => el("div", { class: "stat glass" }, el("b", { text: hrs(h) }), el("span", { text: names[id] }))));
    const table = el("table", { class: "htable" },
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Person" }), el("th", { scope: "col", class: "n", text: "Hours" }), el("th", { scope: "col", class: "n", text: "Contract" }), el("th", { scope: "col", class: "n", text: "Overtime" }))),
      el("tbody", {}, ...r.people.map((p) => el("tr", {}, el("th", { scope: "row", text: p.name }),
        el("td", { class: "n", text: hrs(p.rotaHours) + (p.amended ? "*" : ""), title: p.amended ? `Planned ${hrs(p.plannedHours)}h; ${plural(p.amended, "shift")} amended on the day` : "" }),
        el("td", { class: "n", text: contractLabel(p) || "–" }),
        el("td", { class: "n" + (p.overtime ? " over" : p.shortOfMin ? " short" : ""), text: p.overtime ? `+${hrs(p.overtime)}` : p.shortOfMin ? `−${hrs(p.shortOfMin)}` : "–", title: p.overtime ? "Overtime" : p.shortOfMin ? "Short of their minimum" : "" })))),
      el("tfoot", {}, el("tr", {}, el("th", { scope: "row", text: "Total" }), el("td", { class: "n", text: hrs(r.total) }), el("td"), el("td", { class: "n" + (r.overtime ? " over" : ""), text: r.overtime ? `+${hrs(r.overtime)}` : "–" }))));
    return [stats, el("section", { class: "panel tablepanel" }, table),
      el("p", { class: "note", text: `Paid hours on the rota (unpaid breaks taken off), including changes not yet published. Overtime (+) is anything over someone's maximum contracted hours; − is hours short of their minimum.${r.people.some((p) => p.amended) ? " * Includes shifts amended on the day." : ""}${r.openHours ? ` ${hrs(r.openHours)} hours of open shifts aren't counted.` : ""}` }),
      el("div", { class: "row" }, el("a", { class: "btn ghost", href: `/api/rota/hours?start=${r.week}&format=csv`, download: `rota-hours-${r.week}.csv` }, "Download CSV"))];
  }

  async function renderSettings() {
    setHead("settings", "Rota settings", "Opening times, minimum cover and contracted hours", { back: ["More", "more"] });
    const [sites, wk] = await Promise.all([get("/api/rota/sites"), loadWeek(R.week, true)]);
    const out = [label("Sites")];
    const dayAb = (n) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n];
    out.push(el("div", { class: "list glass" }, ...sites.sites.map((s) => {
      const o = el("input", { type: "time", value: s.opensAt || "", "aria-label": `${s.name} opens at` });
      const c = el("input", { type: "time", value: s.closesAt || "", "aria-label": `${s.name} closes at` });
      const n = el("input", { type: "number", value: String(s.minPeople), min: 0, max: 20, inputmode: "numeric", "aria-label": `${s.name} minimum people on shift` });
      // Days with other hours (Sundays everywhere, Saturdays at ASG…): leave a day empty for the usual hours.
      const dayIns = DAYS.map((k, i) => {
        const h = s.dayHours?.[k] || {};
        const di = el("input", { type: "time", value: h.opensAt || "", "aria-label": `${s.name} opens on ${DAY_NAMES[i]}s` });
        const dc = el("input", { type: "time", value: h.closesAt || "", "aria-label": `${s.name} closes on ${DAY_NAMES[i]}s` });
        const closed = s.closedDays.includes((i + 1) % 7);
        return { k, i, di, dc, closed };
      });
      const daySummary = () => DAYS.map((k, i) => s.dayHours?.[k] ? `${DAY_NAMES[i].slice(0, 3)} ${s.dayHours[k].opensAt}–${s.dayHours[k].closesAt}` : null).filter(Boolean).join(", ");
      const sumLine = el("span", { class: "s" });
      const drawSum = () => { sumLine.textContent = daySummary() || "Same hours every day"; };
      drawSum();
      const dayGrid = el("details", { class: "dayhours" }, el("summary", {}, el("b", { text: "Hours by day" }), sumLine),
        el("div", { class: "dhgrid" }, ...dayIns.map(({ i, di, dc, closed }) => el("div", { class: "dhrow" + (closed ? " closed" : "") },
          el("span", { class: "dn", text: DAY_NAMES[i] }), closed ? el("span", { class: "s", text: "Closed" }) : null, di, dc))),
        el("p", { class: "note", text: "Leave a day empty to use the usual hours above." }));
      const sv = btn("Save", async () => {
        const dayHours = {};
        for (const { k, di, dc } of dayIns) if (di.value || dc.value) dayHours[k] = { opensAt: di.value || null, closesAt: dc.value || null };
        const r = await act(() => api("PUT", "/api/rota/sites/" + s.id, { opensAt: o.value || null, closesAt: c.value || null, minPeople: Number(n.value || 0), dayHours }), `${s.name} saved`);
        if (r) { s.dayHours = r.dayHours; drawSum(); if (R.weekData) R.weekData._at = 0; }
      }, "btn sm");
      const status = !s.inUse ? "Not in use yet: set it up in the diary first" : s.closedDays.length ? `Closed ${s.closedDays.map(dayAb).join(", ")} (from the diary's Setup)` : "Open every day (from the diary's Setup)";
      return el("div", { class: "lrow setrow" }, el("span", { class: "t" }, el("b", { text: s.name }), el("span", { class: "s", text: status })),
        el("span", { class: "setf" }, el("label", {}, el("span", { text: "Usually opens" }), o), el("label", {}, el("span", { text: "Closes" }), c), el("label", {}, el("span", { text: "Min people" }), n), sv),
        dayGrid);
    })));
    out.push(el("p", { class: "note", text: "Cover is checked hour by hour between opening and closing, using each day's own hours where it has them. Which days each site opens comes from the diary's Setup, and planned closures from Closures & holidays." }));
    out.push(label("Contracted hours a week"));
    out.push(el("div", { class: "list glass" }, ...wk.people.map((p) => {
      const opts = { type: "number", min: 0, max: 80, step: 0.5, inputmode: "decimal", placeholder: "–" };
      const lo = el("input", { ...opts, value: p.contractMin == null ? "" : String(p.contractMin), "aria-label": `${p.name} minimum contracted hours a week` });
      const hi = el("input", { ...opts, value: p.contractMax == null ? "" : String(p.contractMax), "aria-label": `${p.name} maximum contracted hours a week` });
      const save = async () => {
        const body = { contractMin: lo.value === "" ? null : Number(lo.value), contractMax: hi.value === "" ? null : Number(hi.value) };
        const r = await act(() => api("PUT", "/api/rota/people/" + p.id, body), `${first(p.name)}: ${contractLabel(body) || "no"} contracted hours`);
        if (r) { p.contractMin = r.contractMin; p.contractMax = r.contractMax; if (R.weekData) R.weekData._at = 0; }
        else { lo.value = p.contractMin == null ? "" : String(p.contractMin); hi.value = p.contractMax == null ? "" : String(p.contractMax); }
      };
      lo.onchange = save; hi.onchange = save;
      return el("div", { class: "lrow crow" }, avatar(p.name), el("span", { class: "t" }, el("b", { text: p.name }), el("span", { class: "s", text: ROLE[p.role] || "" })),
        el("span", { class: "crange" }, el("label", { class: "chours" }, el("span", { text: "Min" }), lo), el("label", { class: "chours" }, el("span", { text: "Max" }), hi)));
    })));
    if (isAdmin()) {
      // Which days and sites people work is set in the admin section (Admin → People → Edit availability).
      out.push(label("When people can work"));
      out.push(el("div", { class: "list glass" }, el("a", { class: "lrow", href: (R.links.admin || "/admin") + "#people" }, svgi(ICON.avail),
        el("span", { class: "t" }, el("b", { text: "Change in Admin" }), el("span", { class: "s", text: "Admin → People → open someone → Edit availability" })), svgi(ICON.chevR))));
    }
    out.push(el("p", { class: "note", text: "Hours over someone's maximum show as overtime on the rota, in Hours and in their own shifts. Under the minimum shows as a note while planning." }));
    out.push(el("p", { class: "note", text: "Everyone with an active account can be on the rota. Add people and change roles on the diary's Admin page." }));
    return out;
  }

  const PAGE_RENDER = { week: renderWeek, day: renderDay, mine: renderMine, swaps: renderSwaps, avail: renderAvail, requests: renderRequests, more: renderMore, hours: renderHours, settings: renderSettings };

  /* ---------- start ---------- */

  // Safari can bring the page back from memory after the session has ended: check, and go to sign-in if so.
  SC.recheckOnPageshow(() => goSignIn());

  async function start() {
    try {
      const [auth, me] = await Promise.all([fetch("/api/auth/me").then((r) => r.json()), get("/api/rota/me")]);
      if (!auth.user) { goSignIn(); return; }
      R.auth = auth; R.me = me; R.links = me.links; R.approvers = me.approvers;
    } catch (e) {
      $("#page").replaceChildren(el("div", { class: "empty", text: e.message || "Couldn't load the rota." }));
      return;
    }
    const u = R.me.user;
    $("#avatarBtn").textContent = initials(u.name);
    $("#meBox").replaceChildren(avatar(u.name), el("span", { class: "t" }, el("b", { text: u.name }), el("span", { class: "s", text: ROLE[u.role] || "" })), svgi(ICON.chevR));
    $("#avatarBtn").addEventListener("click", (e) => openAcctMenu(e.currentTarget));
    $("#meBox").addEventListener("click", (e) => openAcctMenu(e.currentTarget));
    $("#sheetVeil").addEventListener("click", closeSheets);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheetVeil").hidden) closeSheets(); });
    $("#snav").addEventListener("click", (e) => { const a = e.target.closest("a[href^='#']"); if (a) { e.preventDefault(); go(a.getAttribute("href").slice(1)); } });
    window.addEventListener("hashchange", render);
    wide.addEventListener("change", () => { if (R.tab === "week" || R.tab === "mine") render(); });
    // Coming back to the tab (after a while) or back online refreshes the page, but never over something
    // half typed or an open sheet or menu.
    const busy = () => !$("#sheet").hidden || ($("#peopleSheet") && !$("#peopleSheet").hidden) || ($("#acctMenu") && !$("#acctMenu").hidden) ||
      (document.activeElement && document.activeElement.closest?.("#page") && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) || !!$("#page [data-dirty]");
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (Date.now() - hiddenAt > 30000 && !busy()) { refreshBadge(); render(); }
    });
    window.addEventListener("online", () => { if (!busy()) render(); });
    // Several devices at once: every 10 seconds while the page is in view, ask whether the rota (or anyone's
    // account) has changed elsewhere, and if so redraw, unless someone is in the middle of something here.
    SC.watchChanges(10000, (c) => `${c.rota}.${c.accounts}`, () => !busy(), () => { if (R.weekData) R.weekData._at = 0; refreshBadge(); render(); }, true);
    // Typing into a page's form marks it, so a refresh doesn't throw it away.
    $("#page").addEventListener("input", (e) => { if (e.target.matches("input,select,textarea")) e.target.setAttribute("data-dirty", ""); });
    render();
    refreshBadge();
  }
  start();
})();
