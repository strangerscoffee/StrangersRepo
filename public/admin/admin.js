// The admin section (admin.staffstrangerscoffee.com; /admin on the diary's address in local dev): an overview of
// the Kitchen Diary and the Rota, people, sites, activity, security, backups and exports. Admins only: the Worker
// refuses everyone else. Talks to /api/admin/* (src/adminView.ts, src/admin.ts) and /api/rota/* with fetch.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);

  /* ---------- safe HTML: every ${value} is escaped unless it's itself html`` or an icon ---------- */
  const RAW = Symbol("raw");
  const raw = (s) => ({ [RAW]: String(s) });
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const part = (v) => (v == null || v === false ? "" : Array.isArray(v) ? v.map(part).join("") : typeof v === "object" && RAW in v ? v[RAW] : esc(v));
  const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ""), ""));
  const put = (el, t) => { el.innerHTML = t[RAW]; };

  const P = {
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c.8-3.5 3.2-5.5 6-5.5s5.2 2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.6c2.4.3 4.2 2 5 5"/>',
    house: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
    pulse: '<path d="M4 12h4l3-7 4 14 3-7h2"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.9-3.8 3.8-6 7-6s6.1 2.2 7 6"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
    out: '<path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
    pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  };
  const svg = (k) => raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[k]}</svg>`);
  document.querySelectorAll("[data-icon]").forEach((e) => { e.innerHTML = svg(e.dataset.icon)[RAW]; });

  /* ---------- data ---------- */
  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw new Error("Couldn't reach the site. Check your connection."); }
    if (r.status === 401) { location.replace("/signin?next=" + encodeURIComponent(location.pathname + location.hash)); throw new Error("Signed out."); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Something went wrong. Try again.");
    return j;
  }

  const SITES = [["roastery", "Roastery"], ["cafe", "Cafe"], ["asg", "ASG"], ["factory", "Factory"]];
  const siteName = (id) => (SITES.find((s) => s[0] === id) || [id, id])[1];
  const DAYS = [["mon", "Mo", "Monday"], ["tue", "Tu", "Tuesday"], ["wed", "We", "Wednesday"], ["thu", "Th", "Thursday"], ["fri", "Fr", "Friday"], ["sat", "Sa", "Saturday"], ["sun", "Su", "Sunday"]];
  const TOPIC_NAMES = { hygiene: "Hygiene", cross: "Cross-contamination", cleaning: "Cleaning", chilling: "Chilling", cooking: "Cooking", allergens: "Allergens", diary: "Opening & closing", l2: "Level 2" };
  const ROLE = { admin: "Admin", manager: "Manager", staff: "Staff" };
  const S = { me: null, links: { diary: "/", rota: "/rota/", admin: "/" }, page: "overview", open: null, filter: "all", q: "", feed: "all", fq: "", locked: 0 };

  const ini = (n) => String(n || "").split(/\s+/).filter(Boolean).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  const LON = { timeZone: "Europe/London" };
  const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA", LON);
  const hm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { ...LON, hour: "2-digit", minute: "2-digit" });
  const dmy = (ms) => new Date(ms).toLocaleDateString("en-GB", { ...LON, weekday: "short", day: "numeric", month: "short" });
  const isoShort = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  function when(ms) {
    if (!ms) return "never";
    const k = dayKey(ms), today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5);
    return k === today ? `today ${hm(ms)}` : k === yest ? `yesterday ${hm(ms)}` : dmy(ms);
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const hrs = (n) => `${Math.round(n * 10) / 10}h`;
  const meter = (pct, cls = "") => html`<span class="meter ${cls}" role="img" aria-label="${Math.round(pct)}%"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;
  const kv = (k, v) => html`<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const rolePill = (r) => html`<span class="pill ${r === "admin" ? "acc" : r === "manager" ? "ok" : ""}">${ROLE[r] || r}</span>`;
  const head = (title, sub, action) => html`<div class="pagehead"><h1>${title}</h1>${action || raw("<span></span>")}${sub ? html`<p>${sub}</p>` : ""}</div>`;
  const contract = (r) => (r.contractMin != null && r.contractMax != null ? (r.contractMin === r.contractMax ? `${r.contractMax}h a week` : `${r.contractMin}–${r.contractMax}h a week`) : r.contractMax != null ? `up to ${r.contractMax}h a week` : r.contractMin != null ? `at least ${r.contractMin}h a week` : "None set");

  /* ---------- toasts and sheets ---------- */
  let toastT;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
  let sheetDone = null, lastFocus = null;
  function openSheet(content, onAct) {
    lastFocus = document.activeElement;
    put($("#sheet"), content);
    $("#scrim").hidden = false;
    sheetDone = onAct || null;
    const f = $("#sheet input, #sheet select, #sheet button");
    if (f) f.focus();
  }
  function closeSheet() { $("#scrim").hidden = true; $("#sheet").innerHTML = ""; sheetDone = null; if (lastFocus && lastFocus.isConnected) lastFocus.focus(); }
  $("#scrim").addEventListener("click", (e) => { if (e.target.id === "scrim") closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#scrim").hidden) closeSheet(); });
  $("#sheet").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sheet]");
    if (!b) return;
    if (b.dataset.sheet === "close") { closeSheet(); return; }
    if (sheetDone) once(b, () => sheetDone(b.dataset.sheet, b));
  });
  $("#sheet").addEventListener("submit", (e) => { e.preventDefault(); if (sheetDone) once(e.target, () => sheetDone("submit", e.target)); });
  // While a sheet's action is running, a second tap (or Enter) does nothing, so nothing is sent twice.
  async function once(owner, fn) {
    if (owner.dataset.busy) return;
    owner.dataset.busy = "1";
    const btns = [...(owner.matches("form") ? owner.querySelectorAll("button[type=submit]") : [owner])];
    btns.forEach((x) => { x.disabled = true; });
    try { await fn(); } finally { delete owner.dataset.busy; btns.forEach((x) => { if (x.isConnected) x.disabled = false; }); }
  }

  /** Asks before doing something that can't be undone. Resolves true when confirmed. */
  function confirmSheet({ title, text, confirm, danger }) {
    return new Promise((resolve) => {
      openSheet(html`<h2 id="sheetTitle">${title}</h2><p>${text}</p>
        <div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn ${danger ? "solidbad" : ""}" type="button" data-sheet="ok">${confirm}</button></div>`,
      (act) => { if (act === "ok") { closeSheet(); resolve(true); } });
      const obs = new MutationObserver(() => { if ($("#scrim").hidden) { obs.disconnect(); resolve(false); } });
      obs.observe($("#scrim"), { attributes: true, attributeFilter: ["hidden"] });
    });
  }
  /** Shows a temporary password once, with the username, to pass on. */
  function showPassword(name, username, password) {
    openSheet(html`<h2 id="sheetTitle">Temporary password for ${name}</h2>
      <p>Give these to ${name}. They sign in with them and then choose their own password. This is the only time the password is shown.</p>
      <div class="secret"><span>Username</span><b>${username}</b></div>
      <div class="secret"><span>Temporary password</span><b id="pwText">${password}</b></div>
      <div class="row"><button class="btn soft" type="button" data-sheet="copy">${svg("copy")}Copy both</button><button class="btn" type="button" data-sheet="close">Done</button></div>`,
    async (act) => {
      if (act !== "copy") return;
      try { await navigator.clipboard.writeText(`Username: ${username}\nTemporary password: ${password}`); toast("Copied"); }
      catch (e) { const r = document.createRange(); r.selectNodeContents($("#pwText")); getSelection().removeAllRanges(); getSelection().addRange(r); }
    });
  }

  /* ---------- navigation ---------- */
  const NAV = [["overview", "Overview", "grid"], ["people", "People", "people"], ["sites", "Sites", "house"], ["activity", "Activity", "pulse"], ["security", "Security", "shield"], ["data", "Backups & exports", "db"]];
  const TABS = [["overview", "Overview", "grid"], ["people", "People", "people"], ["sites", "Sites", "house"], ["activity", "Activity", "pulse"], ["more", "More", "more"]];
  const PAGES = ["overview", "people", "sites", "activity", "security", "data", "more"];
  function renderNav() {
    const badge = S.locked ? html`<span class="badge" aria-label="${plural(S.locked, "account")} locked">${S.locked}</span>` : "";
    put($("#sideNav"), html`${NAV.map(([id, t, ic]) => html`<button class="nav" type="button" data-go="${id}" aria-current="${S.page === id ? "page" : "false"}">${svg(ic)}${t}${id === "security" ? badge : ""}</button>`)}`);
    const tab = S.page === "security" || S.page === "data" ? "more" : S.page;
    put($("#tabBar"), html`${TABS.map(([id, t, ic]) => html`<button type="button" data-go="${id}" aria-current="${tab === id ? "page" : "false"}">${svg(ic)}${t}${id === "more" ? badge : ""}</button>`)}`);
  }
  async function refreshBadge() {
    try { S.locked = (await api("GET", "/api/admin/security")).locked.length; renderNav(); } catch (e) { /* keep the last count */ }
  }

  let seq = 0;
  async function show(page, { keepScroll } = {}) {
    S.page = PAGES.includes(page) ? page : "overview";
    if (location.hash !== "#" + S.page) { try { history.replaceState(null, "", "#" + S.page); } catch (e) { /* ignore */ } }
    renderNav();
    const my = ++seq;
    const main = $("#main");
    if (!keepScroll) { put(main, html`<p class="loading">Loading…</p>`); window.scrollTo(0, 0); }
    try {
      const view = await VIEWS[S.page]();
      if (my !== seq) return;
      put(main, view);
      document.title = "Strangers Coffee - Admin"; // the same tab name on every page
    } catch (e) {
      if (my !== seq) return;
      put(main, html`${head("Couldn't load this page", "")}<div class="group glass"><div class="empty">${svg("warn")}<span>${e.message}</span></div></div>`);
    }
  }
  const reload = () => show(S.page, { keepScroll: true });

  /* ---------- views ---------- */
  const VIEWS = {};
  let cache = {};

  VIEWS.overview = async () => {
    const d = await api("GET", "/api/admin/overview");
    S.locked = d.stats.people.locked; renderNav();
    const st = d.stats;
    const attention = d.attention.length ? d.attention.map((a) => html`
      <div class="item"><span class="ic ${a.tone}">${svg(a.icon)}</span><span class="tx"><b>${a.title}</b><span>${a.detail}</span></span>
        <span class="end">${a.action.href ? html`<a class="btn sm soft" href="${a.action.href}">${a.action.label}</a>`
          : html`<button class="btn sm soft" type="button" data-act="${a.action.act || "go"}" data-id="${a.action.id || a.action.go || ""}">${a.action.label}</button>`}</span></div>`)
      : html`<div class="empty">${raw(`<span class="ic ok">${svg("ok")[RAW]}</span>`)}<span>Nothing needs attention.</span></div>`;
    return html`
      ${head("Overview", `The Kitchen Diary and the Rota at a glance. ${new Date().toLocaleDateString("en-GB", { ...LON, weekday: "long", day: "numeric", month: "long" })}.`)}
      <div class="label">Needs attention <span class="count">${d.attention.length || ""}</span></div>
      <div class="group glass">${attention}</div>
      <div class="label">Today and this week</div>
      <div class="stats">
        <a class="stat glass" href="${S.links.diary}"><span class="k">${svg("cal")}Diary today</span><span class="v">${st.diary.done} of ${st.diary.open}</span><span class="s">sites signed off</span></a>
        <a class="stat glass" href="${S.links.rota}"><span class="k">${svg("clock")}Rota hours</span><span class="v">${hrs(st.rota.hours)}</span><span class="s">${st.rota.overtime ? `${hrs(st.rota.overtime)} overtime` : st.rota.published ? "this week, published" : "this week, not published"}</span></a>
        <button class="stat glass" type="button" data-go="people"><span class="k">${svg("people")}People</span><span class="v">${st.people.active}</span><span class="s">${[st.people.locked ? `${st.people.locked} locked` : "", st.people.notSignedIn ? `${st.people.notSignedIn} not signed in yet` : ""].filter(Boolean).join(", ") || "active accounts"}</span></button>
        <button class="stat glass" type="button" data-go="data"><span class="k">${svg("db")}Last backup</span><span class="v">${st.backup ? hm(st.backup.at) : "None"}</span><span class="s">${st.backup ? `${cap(when(st.backup.at).replace(/ \d\d:\d\d$/, ""))}, ${st.backup.count} kept` : "Make one now"}</span></button>
      </div>
      <div class="pair">
        <section class="panel glass" aria-labelledby="dtd"><h2 id="dtd">Diary today <a class="link" href="${S.links.diary}">Open</a></h2>
          ${d.diaryToday.map((s) => html`<div class="siteline"><span class="nm"><span class="dot ${s.id}"></span>${s.name}</span>${meter(s.pct, s.pct < 100 && !s.closed ? "part" : "")}<span class="st">${s.status}</span></div>`)}
        </section>
        <section class="panel glass" aria-labelledby="rtw"><h2 id="rtw">Rota this week ${d.rotaPublished ? "" : html`<span class="pill warn">Not published</span>`}<a class="link" href="${S.links.rota}#week/${d.week}">Open</a></h2>
          ${(() => { const max = Math.max(1, ...d.rotaWeek.map((s) => s.hours)); return d.rotaWeek.map((s) => html`<div class="siteline"><span class="nm"><span class="dot ${s.id}"></span>${s.name}</span>${meter((s.hours / max) * 100)}<span class="st num">${!s.inUse ? "Not set up" : s.hours || s.open ? `${hrs(s.hours)} · ${plural(s.people, "person", "people")}${s.open ? ` · ${s.open} open` : ""}` : "No shifts"}</span></div>`); })()}
        </section>
      </div>`;
  };

  VIEWS.people = async () => {
    // Searching, filtering and opening a row reuse what's loaded; anything else (a save, a page visit) loads afresh.
    const d = S.local && cache.peopleData ? cache.peopleData : await api("GET", "/api/admin/people");
    S.local = false;
    cache.peopleData = d;
    cache.people = d.people;
    const counts = { all: d.people.filter((p) => p.active).length, staff: 0, manager: 0, admin: 0, off: d.people.filter((p) => !p.active).length };
    d.people.forEach((p) => { if (p.active) counts[p.role]++; });
    const q = S.q.trim().toLowerCase();
    const list = d.people.filter((p) => (S.filter === "off" ? !p.active : p.active && (S.filter === "all" || p.role === S.filter)) &&
      (!q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q)));
    const filters = [["all", "Everyone"], ["staff", "Staff"], ["manager", "Managers"], ["admin", "Admins"], ...(counts.off ? [["off", "Switched off"]] : [])];
    return html`
      ${head("People", "Everyone's account, rota details and training in one place.", html`<button class="btn" type="button" data-act="add">${svg("plus")}Add person</button>`)}
      <div class="toolbar">
        <label class="search">${svg("search")}<input id="q" type="search" placeholder="Search by name or username" aria-label="Search people" value="${S.q}"></label>
        <div class="segwrap"><div class="seg" role="group" aria-label="Show">${filters.map(([k, t]) => html`<button type="button" aria-pressed="${S.filter === k}" data-filter="${k}">${t}</button>`)}</div></div>
      </div>
      <div class="label">${(filters.find((f) => f[0] === S.filter) || ["", "Everyone"])[1]} <span class="count">${plural(list.length, "person", "people")}</span></div>
      <div class="group glass">
        ${list.length ? list.map((p) => personRow(p, d.topics)) : html`<div class="empty">${svg("search")}<span>No one matches.</span></div>`}
      </div>`;
  };
  function personRow(p, topics) {
    const flag = !p.active ? html`<span class="pill">Switched off</span>` : p.locked ? html`<span class="pill bad">Locked</span>`
      : !p.lastLoginAt ? html`<span class="pill warn">Not signed in yet</span>` : p.rota.weekOvertime ? html`<span class="pill warn">${hrs(p.rota.weekOvertime)} overtime</span>` : "";
    const where = p.rota.sites.length ? p.rota.sites.map(siteName).join(", ") : "Any site";
    const open = S.open === p.id;
    return html`
      <button class="item ${p.active ? "" : "off"}" type="button" data-person="${p.id}" aria-expanded="${open}">
        <span class="av" aria-hidden="true">${ini(p.name)}</span>
        <span class="tx"><b>${p.name}${p.id === S.me.id ? " (you)" : ""}</b><span>${where} · ${p.lastLoginAt ? `signed in ${when(p.lastLoginAt)}` : "never signed in"}</span></span>
        <span class="end">${flag}<span class="${flag ? "opt" : ""}">${rolePill(p.role)}</span><span class="chev">${svg("chev")}</span></span>
      </button>
      ${open ? personDetail(p, topics) : ""}`;
  }
  function personDetail(p, topics) {
    const r = p.rota, max = r.contractMax;
    const pat = r.pattern || {};
    const over = r.weekOvertime;
    const offs = r.timeOff.length ? r.timeOff.map((t) => `${isoShort(t.from)}${t.to !== t.from ? `–${isoShort(t.to)}` : ""}${t.status === "requested" ? " (asked)" : ""}`).join(", ") : "None booked";
    const done = p.training.topics.length;
    const self = p.id === S.me.id;
    return html`
      <div class="detail">
        <div class="dbar" role="group" aria-label="Account actions for ${p.name}">
          <button class="btn sm soft" type="button" data-act="edit" data-id="${p.id}">${svg("pen")}Edit</button>
          ${p.active ? html`<button class="btn sm soft" type="button" data-act="password" data-id="${p.id}">${svg("key")}Temporary password</button>` : ""}
          ${p.locked ? html`<button class="btn sm soft" type="button" data-act="unlock" data-id="${p.id}">${svg("lock")}Unlock</button>` : ""}
          ${p.active ? html`<button class="btn sm soft" type="button" data-act="signout" data-id="${p.id}">${svg("out")}Sign out everywhere</button>` : ""}
          ${self ? "" : p.active ? html`<button class="btn sm bad" type="button" data-act="off" data-id="${p.id}">Switch off</button>` : html`<button class="btn sm" type="button" data-act="on" data-id="${p.id}">Switch back on</button>`}
        </div>
        <div class="cards">
          <section class="card" aria-label="Account">
            <div class="chead"><h3><span class="ic acc">${svg("user")}</span>Account</h3></div>
            ${kv("Username", p.username)}${kv("Role", rolePill(p.role))}${kv("Last sign-in", p.lastLoginAt ? cap(when(p.lastLoginAt)) : "Never")}
            ${kv("Quick PIN", p.role === "admin" ? "Admins use their password" : p.quickPin ? "Set" : "Not set")}
            ${kv("Added", `${dmy(p.createdAt)}${p.createdBy ? ` by ${p.createdBy}` : ""}`)}
          </section>
          <section class="card" aria-label="Rota">
            <div class="chead"><h3><span class="ic acc">${svg("clock")}</span>Rota</h3><a class="link" href="${S.links.rota}">Open</a></div>
            <div class="hero">
              <div class="big"><b>${hrs(r.weekHours)}</b><span>this week · contract ${contract(r)}</span>${over ? html`<span class="pill warn">${hrs(over)} overtime</span>` : ""}</div>
              ${max ? html`${meter((r.weekHours / max) * 100, over ? "over" : "")}<div class="scale"><span>0</span><span>${max}h max</span></div>` : ""}
            </div>
            ${kv("Works at", r.sites.length ? html`<span class="chips">${r.sites.map((s) => html`<span class="chip">${siteName(s)}</span>`)}</span>` : "Any site")}
            <div class="kv stack"><span>When they can work</span>
              <div class="week">${DAYS.map(([k, ab, full]) => { const v = pat[k]; const off = v === "off"; const t = v && typeof v === "object" ? `${v.from || ""}–${v.to || ""}` : "";
                return html`<span class="${off ? "off" : ""}" title="${full}: ${off ? "can't work" : t || "any time"}" aria-label="${full}: ${off ? "can't work" : t || "any time"}">${ab}${t ? html`<small>${t}</small>` : ""}</span>`; })}</div></div>
            ${kv("Time off", offs)}
            ${p.active ? html`<div class="foot"><button class="btn sm soft" type="button" data-act="avail" data-id="${p.id}">${svg("pen")}Edit availability</button></div>` : ""}
          </section>
          <section class="card" aria-label="Kitchen Diary">
            <div class="chead"><h3><span class="ic ok">${svg("cal")}</span>Kitchen Diary</h3><a class="link" href="${S.links.diary}#staff">Open</a></div>
            <div class="hero">
              <div class="big"><b>${done} of ${topics.length}</b><span>training topics${done === topics.length ? " · all done" : ""}</span></div>
              ${meter((done / topics.length) * 100, done < topics.length ? "part" : "")}<div class="scale"><span>0</span><span>${topics.length} topics</span></div>
            </div>
            <div class="kv stack"><span>Topics</span><span class="chips left">${topics.map((k) => p.training.topics.includes(k) ? html`<span class="chip done">${svg("ok")}${TOPIC_NAMES[k] || k}</span>` : html`<span class="chip off">${TOPIC_NAMES[k] || k}</span>`)}</span></div>
            ${kv("Signed their record", p.training.signedAt ? dmy(p.training.signedAt) : "Not yet")}
          </section>
        </div>
      </div>`;
  }

  VIEWS.sites = async () => {
    const d = await api("GET", "/api/admin/sites");
    cache.sites = d.sites;
    const hoursText = (r) => (r.opensAt && r.closesAt ? `${r.opensAt}–${r.closesAt}` : "Not set");
    const other = (r) => { const e = Object.entries(r.dayHours || {}); return e.length ? e.map(([k, v]) => `${(DAYS.find((x) => x[0] === k) || [k, k, k])[2].slice(0, 3)} ${v.opensAt}–${v.closesAt}`).join(", ") : "Same every day"; };
    return html`
      ${head("Sites", "Each site's diary setup and rota hours side by side. Change them in the diary's Setup and the Rota's settings.")}
      <div class="sites">
        ${d.sites.map((s) => !s.setUp ? html`
          <section class="site glass"><header><div><h2><span class="dot ${s.id}"></span>${s.name}</h2><p>${s.address}</p></div><span class="pill warn">Not set up</span></header>
            <div class="callout">${svg("warn")}<span>The ${s.name} has no diary Setup yet, so it isn't counted in the diary and can't have shifts on the Rota.</span></div>
            ${kv("People who work here", s.people ? `${s.people}${s.anywhere ? `, plus ${s.anywhere} at any site` : ""}` : s.anywhere ? `${s.anywhere} at any site` : "None yet")}
            <div class="acts">${d.sites.some((x) => x.setUp) ? html`<button class="btn sm" type="button" data-act="copy" data-id="${s.id}">${svg("copy")}Copy setup from another site</button>` : ""}<a class="btn sm soft" href="${S.links.diary}#setup">Open Setup</a></div></section>` : html`
          <section class="site glass"><header><div><h2><span class="dot ${s.id}"></span>${s.name}</h2><p>${s.address}</p></div><span class="pill ok">${svg("ok")}Set up</span></header>
            <div class="sub">${svg("cal")}Kitchen Diary</div>
            ${kv("Fridges and freezers", s.diary.units)}${kv("Checks", `${s.diary.opening} opening · ${s.diary.closing} closing · ${s.diary.weekly} weekly`)}
            ${kv("Closed on", s.diary.closedDays.length ? s.diary.closedDays.join(", ") : "Open every day")}
            <div class="sub">${svg("clock")}Rota</div>
            ${kv("Usual hours", hoursText(s.rota))}${kv("Other days", other(s.rota))}${kv("Minimum on shift", plural(s.rota.minPeople, "person", "people"))}
            ${kv("People who work here", `${s.people}${s.anywhere ? `, plus ${s.anywhere} at any site` : ""}`)}
            <div class="acts"><a class="btn sm soft" href="${S.links.diary}#setup">Diary Setup</a><a class="btn sm soft" href="${S.links.rota}#settings">Rota settings</a></div></section>`)}
      </div>
      <p class="hint">Diary Setup opens at the site that device last used: switch site at the top of the diary if needed.</p>`;
  };

  const KIND = { diary: ["ok", "cal", "Diary"], rota: ["acc", "clock", "Rota"], account: ["warn", "user", "Accounts"] };
  VIEWS.activity = async () => {
    const d = await api("GET", "/api/admin/activity?kind=" + encodeURIComponent(S.feed));
    const q = S.fq.trim().toLowerCase();
    const items = d.items.filter((i) => !q || i.text.toLowerCase().includes(q) || i.where.toLowerCase().includes(q));
    const groups = [];
    for (const i of items) {
      const k = dayKey(i.at), label = k === dayKey(Date.now()) ? "Today" : k === dayKey(Date.now() - 864e5) ? "Yesterday" : new Date(i.at).toLocaleDateString("en-GB", { ...LON, weekday: "long", day: "numeric", month: "long" });
      if (!groups.length || groups[groups.length - 1][0] !== label) groups.push([label, []]);
      groups[groups.length - 1][1].push(i);
    }
    return html`
      ${head("Activity", "Who changed what in the diary, the Rota and accounts. Newest first.")}
      <div class="toolbar">
        <div class="segwrap"><div class="seg" role="group" aria-label="Show">${[["all", "All"], ["diary", "Diary"], ["rota", "Rota"], ["account", "Accounts"]].map(([k, t]) => html`<button type="button" aria-pressed="${S.feed === k}" data-feed="${k}">${t}</button>`)}</div></div>
        <label class="search">${svg("search")}<input id="fq" type="search" placeholder="Search a name or site" aria-label="Search activity" value="${S.fq}"></label>
      </div>
      ${groups.length ? groups.map(([label, list]) => html`<div class="day">${label}</div><div class="group glass">${list.map((i) => html`
        <div class="item"><span class="ic ${KIND[i.kind][0]}">${svg(KIND[i.kind][1])}</span><span class="tx"><b class="plain">${i.text}</b><span>${i.where}</span></span><span class="end time">${hm(i.at)}</span></div>`)}</div>`)
        : html`<div class="group glass"><div class="empty">${svg("pulse")}<span>Nothing yet.</span></div></div>`}
      <p class="hint">Diary entries show each record's latest change. Account changes are kept for about a year.</p>`;
  };

  VIEWS.security = async () => {
    const d = await api("GET", "/api/admin/security");
    S.locked = d.locked.length; renderNav();
    return html`
      ${head("Security", "Sign-in problems, and controls for every account.")}
      <div class="stats">
        <div class="stat glass"><span class="k">${svg("lock")}Locked now</span><span class="v">${d.locked.length}</span><span class="s">${d.locked.length ? d.locked.map((l) => l.name).join(", ") : "No one"}</span></div>
        <div class="stat glass"><span class="k">${svg("warn")}Failed sign-ins</span><span class="v">${d.failed24h}</span><span class="s">Last 24 hours</span></div>
        <div class="stat glass"><span class="k">${svg("key")}Quick PINs</span><span class="v">${d.quickPins}</span><span class="s">People using one</span></div>
        <div class="stat glass"><span class="k">${svg("shield")}Admins</span><span class="v">${d.admins}</span><span class="s">${d.switchedOff ? `${plural(d.switchedOff, "account")} switched off` : "Active admin accounts"}</span></div>
      </div>
      ${d.locked.length ? html`<div class="label">Locked</div><div class="group glass">${d.locked.map((l) => html`
        <div class="item"><span class="av" aria-hidden="true">${ini(l.name)}</span><span class="tx"><b>${l.name}</b><span>Unlocks by itself at ${hm(l.until)}.${l.pinOff ? " Their quick PIN is switched off." : ""}</span></span><span class="end"><button class="btn sm soft" type="button" data-act="unlock" data-id="${l.id}">Unlock</button></span></div>`)}</div>` : ""}
      ${d.recentFailed.length ? html`<div class="label">Recent failed sign-ins</div><div class="group glass">${d.recentFailed.map((f) => html`
        <div class="item"><span class="ic warn">${svg("warn")}</span><span class="tx"><b class="plain">${f.text}</b></span><span class="end time">${hm(f.at)}</span></div>`)}</div>` : ""}
      <div class="label">Protections</div>
      <div class="group glass">
        ${[["Lockouts", "5 wrong passwords or PINs lock an account for 10 minutes; wrong PINs also switch the PIN off"], ["Sign-in limits", "30 failed attempts per connection every 15 minutes"], ["Script lock-down", "Only the site's own code can run on its pages"], ["Nightly backups", "Every night at 03:17, the last 30 kept"]]
          .map(([t, s]) => html`<div class="item"><span class="ic ok">${svg("ok")}</span><span class="tx"><b>${t}</b><span>${s}</span></span><span class="end"><span class="pill ok">On</span></span></div>`)}
      </div>
      <div class="label">For everyone</div>
      <div class="group glass">
        <div class="item"><span class="ic warn">${svg("key")}</span><span class="tx"><b>Reset all quick PINs</b><span>For example when an iPad is lost. People set a new PIN after signing in with their password.</span></span><span class="end"><button class="btn sm soft" type="button" data-act="resetpins">Reset</button></span></div>
        <div class="item"><span class="ic bad">${svg("out")}</span><span class="tx"><b>Sign everyone out</b><span>Ends every session on every device, including yours.</span></span><span class="end"><button class="btn sm bad" type="button" data-act="signoutall">Sign out all</button></span></div>
      </div>`;
  };

  VIEWS.data = async () => {
    const d = await api("GET", "/api/admin/backups");
    const mon = (() => { const t = new Date(new Date().toLocaleDateString("en-CA", LON) + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t; })();
    const weeks = Array.from({ length: 8 }, (_, i) => { const w = new Date(mon); w.setUTCDate(w.getUTCDate() - 7 * i); return w.toISOString().slice(0, 10); });
    const today = dayKey(Date.now());
    const monthAgo = dayKey(Date.now() - 30 * 864e5);
    return html`
      ${head("Backups & exports", "Everything is backed up every night. Download a copy now and then and keep it somewhere safe.", html`<button class="btn" type="button" data-act="backup">${svg("db")}Back up now</button>`)}
      <div class="label">Backups <span class="count">${d.backups.length} of ${d.keep} kept</span></div>
      <div class="group glass">
        ${d.backups.length ? d.backups.slice(0, 10).map((b) => html`<div class="item"><span class="ic mut">${svg("db")}</span><span class="tx"><b>${cap(when(b.at))}</b><span>${b.by === "daily" ? "Nightly" : `Made by ${b.by}`} · ${Math.max(1, Math.round(b.bytes / 1024))} KB · ${b.docs.toLocaleString("en-GB")} diary records</span></span><span class="end"><a class="btn sm soft" href="/api/admin/backups/${b.id}" download>${svg("dl")}Download</a></span></div>`)
          : html`<div class="empty">${svg("db")}<span>No backups yet. The first is made tonight, or tap Back up now.</span></div>`}
      </div>
      <p class="hint">A backup holds every diary record, the rota and the list of accounts (never passwords). Allergen PDFs aren't included.</p>
      <div class="label">Exports</div>
      <div class="group glass">
        <div class="item"><span class="ic acc">${svg("clock")}</span><span class="tx"><b>Hours for payroll</b><span>Rota · CSV per person and site for a week, with overtime</span>
          <span class="inline"><label class="fl" for="hoursWeek">Week of</label><select id="hoursWeek">${weeks.map((w, i) => html`<option value="${w}">${isoShort(w)}${i === 0 ? " (this week)" : i === 1 ? " (last week)" : ""}</option>`)}</select></span></span>
          <span class="end"><button class="btn sm soft" type="button" data-act="hours">${svg("dl")}CSV</button></span></div>
        <div class="item"><span class="ic acc">${svg("clock")}</span><span class="tx"><b>All shifts</b><span>Rota · CSV, planned and as worked</span>
          <span class="inline"><input type="date" id="shFrom" value="${monthAgo}" aria-label="From"><span>to</span><input type="date" id="shTo" value="${today}" aria-label="To"></span></span>
          <span class="end"><button class="btn sm soft" type="button" data-act="shifts">${svg("dl")}CSV</button></span></div>
        <div class="item"><span class="ic warn">${svg("people")}</span><span class="tx"><b>People</b><span>Accounts · CSV of names, roles, sites and contracted hours. Never passwords.</span></span>
          <span class="end"><a class="btn sm soft" href="/api/admin/export/people.csv" download>${svg("dl")}CSV</a></span></div>
        <div class="item"><span class="ic ok">${svg("cal")}</span><span class="tx"><b>EHO inspection pack</b><span>Kitchen Diary · a PDF for a period and a site, from EHO inspection mode</span></span>
          <span class="end"><a class="btn sm soft" href="${S.links.diary}#inspect">Open</a></span></div>
      </div>`;
  };

  VIEWS.more = async () => html`
    ${head("More", "")}
    <div class="group glass">
      <button class="item" type="button" data-go="security"><span class="ic ${S.locked ? "bad" : "ok"}">${svg("shield")}</span><span class="tx"><b>Security</b><span>${S.locked ? `${plural(S.locked, "account")} locked` : "Sign-ins, PINs and protections"}</span></span><span class="end">${S.locked ? html`<span class="badge">${S.locked}</span>` : ""}<span class="chev">${svg("chev")}</span></span></button>
      <button class="item" type="button" data-go="data"><span class="ic mut">${svg("db")}</span><span class="tx"><b>Backups &amp; exports</b><span>Nightly backups, payroll hours and other downloads</span></span><span class="end"><span class="chev">${svg("chev")}</span></span></button>
    </div>
    <div class="label">Open</div>
    <div class="group glass">
      <a class="item" href="${S.links.diary}"><span class="ic ok">${svg("cal")}</span><span class="tx"><b>Kitchen Diary</b></span><span class="end"><span class="chev">${svg("chev")}</span></span></a>
      <a class="item" href="${S.links.rota}"><span class="ic acc">${svg("clock")}</span><span class="tx"><b>Rota</b></span><span class="end"><span class="chev">${svg("chev")}</span></span></a>
    </div>
    <div class="label">Account</div>
    <div class="group glass"><div class="item"><span class="av" aria-hidden="true">${ini(S.me.name)}</span><span class="tx"><b>${S.me.name}</b><span>Admin</span></span><span class="end"><button class="btn sm soft" type="button" data-act="logout">Sign out</button></span></div></div>`;

  /* ---------- actions ---------- */
  const person = (id) => (cache.people || []).find((p) => p.id === id);
  const usernameFrom = (name) => name.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "").slice(0, 32);

  function personForm({ title, p, submit }) {
    return html`<form class="sheetform" novalidate><h2 id="sheetTitle">${title}</h2>
      <div class="field"><label for="fName">Name (shown on records)</label><input id="fName" maxlength="60" autocapitalize="words" required value="${p ? p.name : ""}" placeholder="e.g. Sam Patel"></div>
      <div class="field"><label for="fUser">Username</label><input id="fUser" maxlength="32" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${p ? p.username : ""}" placeholder="e.g. sam.patel"></div>
      <div class="field"><label for="fRole">Role</label><select id="fRole">${["staff", "manager", "admin"].map((r) => html`<option value="${r}" ${(p ? p.role : "staff") === r ? raw("selected") : ""}>${ROLE[r]}</option>`)}</select></div>
      ${p ? "" : html`<div class="field"><label for="fPw">Temporary password (optional)</label><input id="fPw" maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Leave blank to create one"></div>`}
      ${p ? "" : html`<p>They sign in with the username and the temporary password, then choose their own. If they've recorded entries before, use exactly the same name to keep their history together.</p>`}
      <p class="err" id="fErr" role="alert"></p>
      <div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${submit}</button></div></form>`;
  }

  async function addPerson() {
    openSheet(personForm({ title: "Add a person", submit: "Add person" }), async (act, form) => {
      if (act !== "submit") return;
      const name = $("#fName").value.trim(), username = $("#fUser").value.trim(), role = $("#fRole").value, password = $("#fPw").value.trim();
      try {
        const r = await api("POST", "/api/admin/users", { name, username, role, ...(password ? { password } : {}) });
        S.open = r.user.id;
        if (r.password) showPassword(r.user.name, r.user.username, r.password);
        else { closeSheet(); toast(`${r.user.name} added. They sign in with the password you chose.`); }
        if (S.page === "people") reload();
      } catch (e) { $("#fErr").textContent = e.message; }
    });
    let touched = false;
    $("#fUser").addEventListener("input", () => { touched = true; });
    $("#fName").addEventListener("input", () => { if (!touched) $("#fUser").value = usernameFrom($("#fName").value); });
  }

  function editPerson(p) {
    openSheet(personForm({ title: `Edit ${p.name}`, p, submit: "Save" }), async (act) => {
      if (act !== "submit") return;
      const body = {};
      const name = $("#fName").value.trim(), username = $("#fUser").value.trim(), role = $("#fRole").value;
      if (name !== p.name) body.name = name;
      if (username !== p.username) body.username = username;
      if (role !== p.role) body.role = role;
      if (!Object.keys(body).length) { closeSheet(); return; }
      try {
        await api("PATCH", `/api/admin/users/${p.id}`, body);
        closeSheet();
        if (p.id === S.me.id && (body.name || body.role)) { location.replace("/signin"); return; }
        toast("Saved");
        reload();
      } catch (e) { $("#fErr").textContent = e.message; }
    });
  }

  function editAvailability(p) {
    const pat = p.rota.pattern || {};
    const mode = (v) => (v === "off" ? "off" : v && typeof v === "object" ? "times" : "any");
    openSheet(html`<form novalidate><h2 id="sheetTitle">When ${p.name} can work</h2>
      <p>Managers see this when they plan the rota. ${p.name} sees it read-only and still asks for time off themselves.</p>
      <div class="avail">${DAYS.map(([k, , full]) => { const v = pat[k], m = mode(v); return html`
        <div class="arow" data-day="${k}"><b>${full.slice(0, 3)}</b>
          <div class="seg" role="group" aria-label="${full}">${[["any", "Any time"], ["times", "Times"], ["off", "Can't work"]].map(([mk, t]) => html`<button type="button" data-sheet="mode" data-mode="${mk}" aria-pressed="${m === mk}">${t}</button>`)}</div>
          <div class="times" ${m === "times" ? "" : raw("hidden")}><input type="time" aria-label="${full} from" value="${v && v.from ? v.from : ""}"><span>to</span><input type="time" aria-label="${full} until" value="${v && v.to ? v.to : ""}"></div>
        </div>`; })}</div>
      <div class="field"><span class="fl">Sites they can get to</span><div class="checks">${SITES.map(([id, n]) => html`<label><input type="checkbox" value="${id}" ${p.rota.sites.includes(id) ? raw("checked") : ""}>${n}</label>`)}</div></div>
      <p>None ticked means any site.</p>
      <p class="err" id="fErr" role="alert"></p>
      <div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">Save</button></div></form>`,
    async (act, el) => {
      if (act === "mode") {
        const row = el.closest(".arow");
        row.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
        row.querySelector(".times").hidden = el.dataset.mode !== "times";
        return;
      }
      if (act !== "submit") return;
      const pattern = {};
      document.querySelectorAll("#sheet .arow").forEach((row) => {
        const m = row.querySelector('.seg button[aria-pressed="true"]').dataset.mode;
        const [a, b] = row.querySelectorAll(".times input");
        pattern[row.dataset.day] = m === "off" ? "off" : m === "times" ? { from: a.value, to: b.value } : "any";
      });
      const sites = [...document.querySelectorAll("#sheet .checks input:checked")].map((i) => i.value);
      try { await api("PUT", `/api/rota/people/${p.id}`, { pattern, sites }); closeSheet(); toast("Saved"); reload(); }
      catch (e) { $("#fErr").textContent = e.message; }
    });
  }

  async function copySetup(siteId) {
    const target = (cache.sites || []).find((s) => s.id === siteId);
    const from = (cache.sites || []).filter((s) => s.setUp);
    openSheet(html`<form novalidate><h2 id="sheetTitle">Set up the ${target.name}</h2>
      <p>Copies another site's checks, fridges and freezers and closed days into the ${target.name}'s diary Setup. Its diary starts today; managers can change anything in Setup afterwards.</p>
      <div class="field"><label for="fFrom">Copy from</label><select id="fFrom">${from.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <p class="err" id="fErr" role="alert"></p>
      <div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">Copy setup</button></div></form>`,
    async (act) => {
      if (act !== "submit") return;
      try { await api("POST", `/api/admin/sites/${siteId}/copy-setup`, { from: $("#fFrom").value }); closeSheet(); toast(`The ${target.name} is set up`); reload(); }
      catch (e) { $("#fErr").textContent = e.message; }
    });
  }

  async function patchUser(id, body, done) {
    try { const r = await api("PATCH", `/api/admin/users/${id}`, body); if (done) done(r); reload(); refreshBadge(); }
    catch (e) { toast(e.message); }
  }

  async function act(name, id, el) {
    const p = person(id);
    switch (name) {
      case "go": show(id); return;
      case "add": addPerson(); return;
      case "edit": if (p) editPerson(p); return;
      case "avail": if (p) editAvailability(p); return;
      case "copy": copySetup(id); return;
      case "unlock": patchUser(id, { unlock: true }, () => toast("Unlocked")); return;
      case "password": {
        const who = p || { name: "this person" };
        if (!(await confirmSheet({ title: `Give ${who.name} a temporary password?`, text: "Their current password and quick PIN stop working, and they're signed out everywhere. They choose a new password when they sign in.", confirm: "Create password" }))) return;
        patchUser(id, { password: "generate" }, (r) => showPassword(r.user.name, r.user.username, r.password));
        return;
      }
      case "signout":
        if (!(await confirmSheet({ title: `Sign ${p.name} out everywhere?`, text: "They'll need to sign in again on every device.", confirm: "Sign out everywhere" }))) return;
        patchUser(id, { signOut: true }, () => toast(`${p.name} is signed out everywhere`));
        return;
      case "off":
        if (!(await confirmSheet({ title: `Switch off ${p.name}'s account?`, text: "They can't sign in until it's switched back on. Their records stay as they are.", confirm: "Switch off", danger: true }))) return;
        patchUser(id, { active: false }, () => toast(`${p.name}'s account is switched off`));
        return;
      case "on": patchUser(id, { active: true }, () => toast(`${p.name}'s account is back on`)); return;
      case "resetpins":
        if (!(await confirmSheet({ title: "Reset everyone's quick PIN?", text: "Quick switching stops working for everyone until they sign in with their password and set a new PIN.", confirm: "Reset all PINs", danger: true }))) return;
        try { const r = await api("POST", "/api/admin/security/reset-pins"); toast(`${plural(r.reset, "quick PIN")} reset`); reload(); } catch (e) { toast(e.message); }
        return;
      case "signoutall":
        if (!(await confirmSheet({ title: "Sign everyone out?", text: "Every session on every device ends, including yours. Everyone signs in again with their password.", confirm: "Sign everyone out", danger: true }))) return;
        try { await api("POST", "/api/admin/security/sign-out-all"); location.replace("/signin"); } catch (e) { toast(e.message); }
        return;
      case "backup":
        el.disabled = true;
        try { await api("POST", "/api/admin/backups"); toast("Backup made"); reload(); } catch (e) { toast(e.message); el.disabled = false; }
        return;
      case "hours": location.href = `/api/rota/hours?start=${encodeURIComponent($("#hoursWeek").value)}&format=csv`; return;
      case "shifts": {
        const a = $("#shFrom").value, b = $("#shTo").value;
        if (!a || !b || b < a) { toast("Choose a start date before the end date."); return; }
        location.href = `/api/admin/export/shifts.csv?from=${encodeURIComponent(a)}&to=${encodeURIComponent(b)}`;
        return;
      }
      case "logout":
        try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) { /* signing out locally anyway */ }
        location.replace("/signin");
        return;
    }
  }

  function accountMenu() {
    openSheet(html`<h2 id="sheetTitle">${S.me.name}</h2>
      <div class="menu" role="menu">
        <a role="menuitem" href="${S.links.diary}">${svg("cal")}Kitchen Diary</a>
        <a role="menuitem" href="${S.links.rota}">${svg("clock")}Rota</a>
        <a role="menuitem" href="/signin#change">${svg("key")}Change password</a>
        <button role="menuitem" type="button" class="danger" data-sheet="logout">${svg("out")}Sign out</button>
      </div>`, (a) => { if (a === "logout") act("logout"); });
  }

  /* ---------- events ---------- */
  document.addEventListener("click", (e) => {
    if (e.target.closest("#sheet")) return;
    const g = e.target.closest("[data-go]");
    if (g) { e.preventDefault(); show(g.dataset.go); return; }
    const a = e.target.closest("[data-act]");
    if (a) { e.preventDefault(); act(a.dataset.act, a.dataset.id, a); return; }
    const pr = e.target.closest("[data-person]");
    if (pr) { S.open = S.open === pr.dataset.person ? null : pr.dataset.person; S.local = S.page === "people"; reload(); return; }
    const f = e.target.closest("[data-filter]");
    if (f) { S.filter = f.dataset.filter; S.local = S.page === "people"; reload(); return; }
    const fd = e.target.closest("[data-feed]");
    if (fd) { S.feed = fd.dataset.feed; reload(); return; }
  });
  // Search as you type, keeping the cursor in the box.
  let searchT;
  document.addEventListener("input", (e) => {
    if (e.target.id !== "q" && e.target.id !== "fq") return;
    const id = e.target.id;
    if (id === "q") S.q = e.target.value; else S.fq = e.target.value;
    clearTimeout(searchT);
    searchT = setTimeout(async () => { S.local = S.page === "people"; await reload(); const box = $("#" + id); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, 200);
  });
  $("#meBtn").addEventListener("click", accountMenu);
  $("#whoBtn").addEventListener("click", accountMenu);
  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h !== S.page && PAGES.includes(h)) show(h); });

  // Safari can bring the page back from memory after the session has ended: check, and go to sign-in if so.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) fetch("/api/auth/me").then((r) => r.json()).then((me) => { if (!me.user) location.replace("/signin?next=" + encodeURIComponent(location.pathname)); }).catch(() => {});
  });

  /* ---------- start ---------- */
  (async () => {
    try {
      const [me, links] = await Promise.all([api("GET", "/api/auth/me"), api("GET", "/api/rota/links").catch(() => null)]);
      if (!me.user) { location.replace("/signin?next=" + encodeURIComponent(location.pathname)); return; }
      if (me.user.role !== "admin") { location.replace((links && links.diary) || "/"); return; }
      S.me = me.user;
      if (links) S.links = links;
      $("#sideDiary").href = S.links.diary; $("#sideRota").href = S.links.rota;
      $("#meBtn").textContent = ini(S.me.name); $("#meBtn").setAttribute("aria-label", `Signed in as ${S.me.name}`);
      $("#whoInit").textContent = ini(S.me.name); $("#whoName").textContent = S.me.name;
      const h = location.hash.slice(1);
      await show(PAGES.includes(h) ? h : "overview");
      refreshBadge();
    } catch (e) {
      put($("#main"), html`<div class="group glass"><div class="empty">${svg("warn")}<span>${e.message}</span></div></div>`);
    }
  })();
})();
