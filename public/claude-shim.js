// claude-shim.js: the diary's data connection. The page (app.js) talks to its data only through
// window.claude.use(name), the API it was first written against in Claude (docs/runtime-api.md);
// this implements it against the Worker's /api routes. Loaded before app.js.
//
// It also keeps the diary usable on bad Wi-Fi: a change that can't reach the server is queued on this
// device (localStorage), shown straight away, and sent in order once the connection is back. The page
// hears about it through a "diary:connection" event ({offline, pending}).
(() => {
  "use strict";

  /* ---------- the signed-in person ---------- */

  function goSignIn() {
    location.replace("/signin?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
  }

  // Never settles when redirecting to sign-in, so the page doesn't start up with no one signed in.
  const mePromise = fetch("/api/auth/me")
    .then((r) => r.json())
    .then((me) => (me.user ? me : (goSignIn(), new Promise(() => {}))));

  // Safari can bring a page back from memory (going back to a tab) after the session has ended: check, and go to
  // sign-in rather than show a page that can't load anything.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) fetch("/api/auth/me").then((r) => r.json()).then((me) => { if (!me.user) goSignIn(); }).catch(() => {});
  });

  // Sign-off asks for a typed name; start it from the signed-in person's. The page fills the box from
  // localStorage on its first render, before we know who's signed in, so clear the last person's name
  // straight away (devices are shared) and set this person's once known.
  try { localStorage.removeItem("sfbb.signName"); } catch (e) {}
  mePromise.then((me) => { try { localStorage.setItem("sfbb.signName", me.user.name); } catch (e) {} });

  /* ---------- API calls ---------- */

  const OFFLINE = "unavailable";

  async function call(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw { code: OFFLINE, message: "Couldn't reach the diary. Check your connection." };
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 401) goSignIn();
    // A gateway error means the request didn't get through: treat it like no connection.
    if (res.status === 502 || res.status === 503 || res.status === 504) throw { code: OFFLINE, message: "The diary didn't respond. Try again." };
    if (res.status === 401) throw { code: "unauthenticated", message: (body && body.message) || "Signed out." };
    if (!res.ok) throw Object.assign({}, body || {}, { code: (body && body.code) || OFFLINE, message: (body && body.message) || `HTTP ${res.status}`, retry: res.status >= 500 });
    return body;
  }

  const api = (op, body) =>
    call("/api/db/" + op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** A write; afterwards this device knows the document's new version. */
  async function send(op, body) {
    try {
      const r = await api(op, body);
      if (r && typeof r.ver === "number") seen(body.path, r.ver);
      return r;
    } catch (e) {
      if (e && e.code === "conflict" && e.current) seen(body.path, e.current.ver);
      throw e;
    }
  }

  /* ---------- versions: what this device has seen of each document ----------
   Every write gets a new version from the server (docs/runtime-api.md, "Changes from several devices"). A save
   that replaces a document (or a list in it) says which version it was based on, so the server refuses it with
   `conflict` if another device changed it meanwhile, instead of silently overwriting that change. */
  const vers = new Map(); // path -> highest version seen
  const seen = (path, v) => { if (typeof v === "number" && v > (vers.get(path) || 0)) vers.set(path, v); };
  // Day and week pages are only ever merged into, never replaced: no version needed.
  const isPage = (path) => /(^|\/)(days|weeks)\/[^/]+$/.test(path);
  const hasArray = (v) => Array.isArray(v) || (isObjV(v) && !("$op" in v) && Object.values(v).some(hasArray));
  function isObjV(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  /** The version a write is based on: the page's own (opts.ifVersion), else what this device last saw, for a
   * replace, a delete, or an update that replaces a list. undefined: no check (a new document, or a merge). */
  function baseFor(op, body, opts) {
    if (opts && opts.ifVersion !== undefined) return opts.ifVersion === null ? undefined : opts.ifVersion;
    if (isPage(body.path)) return undefined;
    if (op === "update" && !hasArray(body.patch)) return undefined;
    return vers.get(body.path);
  }

  /* ---------- the offline queue ---------- */

  let queue = [];     // [{op: "set"|"update"|"delete", path, data?, patch?}], oldest first
  let queueKey = "";  // per person, so a queued change is only ever sent as the person who made it
  let offline = false;
  let flushing = null;

  mePromise.then((me) => {
    queueKey = "sfbb.queue." + me.user.id;
    try { queue = JSON.parse(localStorage.getItem(queueKey) || "[]"); } catch (e) { queue = []; }
    if (queue.length) { announce(); flush(); }
  });

  function saveQueue() {
    if (!queueKey) return;
    try {
      if (queue.length) localStorage.setItem(queueKey, JSON.stringify(queue));
      else localStorage.removeItem(queueKey);
    } catch (e) { /* storage full or blocked: the queue still lives in memory */ }
  }

  function announce() {
    window.dispatchEvent(new CustomEvent("diary:connection", { detail: { offline, pending: queue.length } }));
  }

  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    announce();
  }

  let dropped = 0; // changes refused for good since the page loaded (the page says so rather than "all saved")
  let retryWait = 0, retryTimer = null;
  function retryLater() {
    retryWait = Math.min(retryWait ? retryWait * 2 : 5000, 120000);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => flush(), retryWait);
  }

  /** Sends queued changes in order. Stops at the first that can't get through (still offline). */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        const w = queue[0];
        const ifVersion = w.after ? vers.get(w.path) : w.ifVersion;
        try {
          if (w.op === "update") {
            try { await send("update", { path: w.path, patch: w.patch, ifVersion }); }
            catch (e) {
              // A day or week page that doesn't exist yet is created by merging; anything else that's gone was
              // deleted meanwhile, and stays deleted (no nameless stub brought back).
              if (e && e.code === "not_found" && /\/(days|weeks)\/[^/]+$/.test(w.path)) await send("set", { path: w.path, data: w.patch });
              else throw e;
            }
          } else if (w.op === "set") await send("set", { path: w.path, data: w.data, ifVersion });
          else await send("delete", { path: w.path, ifVersion });
        } catch (e) {
          if (e && e.code === OFFLINE) { setOffline(true); break; }
          // Signed out, busy or a fault on the server: keep everything and try again later (after signing in,
          // for a session that ended). Only a change that's refused for good is dropped.
          if (e && (e.code === "unauthenticated" || e.code === "rate_limited" || e.code === "internal" || e.code === "quota_exceeded" || e.retry)) {
            retryLater();
            break;
          }
          dropped++;
          const msg = e && e.code === "conflict" ? "It was changed on another device while this one was offline, so this device's change wasn't saved. Check it and do it again." : e && e.message;
          window.dispatchEvent(new CustomEvent("diary:dropped", { detail: { path: w.path, message: msg, conflict: e && e.code === "conflict" } }));
        }
        queue.shift();
        saveQueue();
        announce();
      }
      if (!queue.length) { setOffline(false); retryWait = 0; }
      flushing = null;
      refresh();
    })();
    return flushing;
  }

  window.addEventListener("online", () => flush());

  /** A write: straight to the server, or into the queue when there's no connection (or a queue already). */
  async function write(op, body, opts) {
    const ifVersion = baseFor(op, body, opts);
    if (ifVersion !== undefined) body = Object.assign({}, body, { ifVersion });
    if (!queue.length) {
      try {
        await send(op, body);
        setOffline(false);
        refresh();
        return;
      } catch (e) {
        if (!(e && e.code === OFFLINE)) { refresh(); throw e; }
      }
    }
    // A later change to a document already waiting is based on that earlier one, whatever its version turns out to be.
    const after = queue.some((w) => w.path === body.path);
    const v = after ? { after: true } : ifVersion !== undefined ? { ifVersion } : {};
    queue.push(Object.assign(op === "update" ? { op, path: body.path, patch: body.patch } : op === "set" ? { op, path: body.path, data: body.data } : { op, path: body.path }, v));
    saveQueue();
    setOffline(true);
    announce();
    redeliver();
    flush();
  }

  /* ---------- applying queued changes to what the page sees ---------- */

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  // The server's update semantics: nested plain objects merge; everything else (null included) replaces.
  function merge(base, patch) {
    const out = isObj(base) ? Object.assign({}, base) : {};
    for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && "$op" in v ? applyOp(out[k], v) : isObj(v) && isObj(out[k]) ? merge(out[k], v) : isObj(v) ? merge({}, v) : v;
    return out;
  }
  // The server's list operations (src/paths.ts), so a change waiting offline shows as it will be saved.
  function applyOp(cur, v) {
    if (v.$op === "max") return typeof cur === "number" && cur > v.value ? cur : v.value;
    const list = Array.isArray(cur) ? cur : [];
    if (v.$op === "remove") return list.filter((x) => !(isObj(x) && (v.values || []).includes(x[v.key])));
    const same = (a, b) => (v.key ? isObj(a) && isObj(b) && a[v.key] !== undefined && a[v.key] === b[v.key] : JSON.stringify(a) === JSON.stringify(b));
    const all = [...(v.items || []).filter((x) => !list.some((y) => same(x, y))), ...list];
    if (v.order === "desc" && v.key) all.sort((a, b) => ((isObj(b) ? b[v.key] : 0) > (isObj(a) ? a[v.key] : 0) ? 1 : (isObj(b) ? b[v.key] : 0) < (isObj(a) ? a[v.key] : 0) ? -1 : 0));
    return all.slice(0, v.max || 500);
  }
  const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));
  const idOf = (path) => path.slice(path.lastIndexOf("/") + 1);

  function overlay(spec, res) {
    if (!queue.length || !res) return res;
    if (spec.kind === "doc") {
      let exists = res.exists, data = res.data;
      for (const w of queue) {
        if (w.path !== spec.path) continue;
        if (w.op === "set") { exists = true; data = merge({}, w.data); }
        else if (w.op === "update") { exists = true; data = merge(data, w.patch); }
        else { exists = false; data = undefined; }
      }
      return Object.assign({}, res, { exists, data });
    }
    let docs = (res.docs || []).slice();
    for (const w of queue) {
      if (parentOf(w.path) !== spec.path) continue;
      const id = idOf(w.path), i = docs.findIndex((d) => d.id === id);
      if (w.op === "delete") { if (i >= 0) docs.splice(i, 1); continue; }
      const data = w.op === "set" ? merge({}, w.data) : merge(i >= 0 ? docs[i].data : {}, w.patch);
      if (i >= 0) docs[i] = { id, data }; else docs.push({ id, data });
    }
    if (spec.orderBy) {
      const f = spec.orderBy, dir = spec.dir === "desc" ? -1 : 1;
      docs.sort((a, b) => { const x = a.data && a.data[f], y = b.data && b.data[f]; return x === y ? 0 : (x > y ? 1 : -1) * dir; });
    }
    if (spec.limit) docs = docs.slice(0, spec.limit);
    return Object.assign({}, res, { docs });
  }

  /* ---------- live updates: one batched poll for every subscription ---------- */

  const VISIBLE_MS = 5000;
  const HIDDEN_MS = 30000;
  const subs = new Map();
  let nextKey = 1, seq = null, timer = null, inflight = false, again = false;

  function subscribe(spec, deliver, onError) {
    const key = String(nextKey++);
    subs.set(key, { spec, deliver, onError, ver: undefined, last: undefined, raw: undefined });
    schedule(0);
    return () => { subs.delete(key); };
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(pollNow, ms);
  }

  function refresh() {
    if (inflight) again = true;
    else schedule(0);
  }

  function deliver(s) {
    if (s.raw === undefined) return;
    const res = overlay(s.spec, s.raw);
    const text = JSON.stringify(res);
    if (text === s.last) return; // same as last time: don't re-render
    s.last = text;
    try { s.deliver(res); } catch (e) { console.error(e); }
  }

  /** Re-sends every subscription's last result with the queued changes applied. */
  function redeliver() {
    for (const s of subs.values()) deliver(s);
  }

  async function pollNow() {
    if (inflight) { again = true; return; }
    if (!subs.size) return;
    inflight = true;
    const entries = [...subs];
    try {
      const r = await api("poll", { since: seq, queries: entries.map(([key, s]) => Object.assign({ key, ver: s.ver }, s.spec)) });
      seq = r.seq;
      if (!queue.length) setOffline(false);
      for (const [key, res] of Object.entries(r.results || {})) {
        const s = subs.get(key);
        if (!s) continue;
        s.ver = res.ver;
        s.raw = res;
        if (s.spec.kind === "doc") seen(s.spec.path, res.docVer != null ? res.docVer : res.ver);
        else for (const d of res.docs || []) seen(s.spec.path + "/" + d.id, d.ver);
        deliver(s);
      }
      if (queue.length) flush();
    } catch (e) {
      if (e && e.code === OFFLINE) setOffline(true);
      if (e && e.code === "invalid_argument") for (const [, s] of entries) if (s.onError) try { s.onError(e); } catch (_) {}
    }
    inflight = false;
    if (again) { again = false; schedule(0); }
    else if (subs.size) schedule(offline ? 4000 : document.hidden ? HIDDEN_MS : VISIBLE_MS);
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && subs.size && !inflight) schedule(0); });

  /* ---------- db ---------- */

  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const docSnap = (id, exists, data, ver) => ({ id, exists, ver: ver || 0, data: () => (exists ? copy(data) : undefined) });
  const querySnap = (docs, base) => ({ docs: docs.map((d) => ({ id: d.id, ver: (base && vers.get(base + "/" + d.id)) || d.ver || 0, data: () => copy(d.data) })) });

  function segments(path) {
    if (typeof path !== "string") throw new TypeError("Path must be a string");
    const parts = path.split("/");
    if (parts.some((p) => !p)) throw new TypeError(`Invalid path: ${path}`);
    return parts;
  }

  const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
  function randomId() {
    const b = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(b, (x) => ALNUM[x % 36]).join("");
  }

  function docRef(path) {
    const parts = segments(path);
    if (parts.length % 2 !== 0) throw new TypeError(`Not a document path: ${path}`);
    const id = parts[parts.length - 1];
    const spec = { kind: "doc", path };
    return {
      id,
      path,
      async get() {
        let r;
        try { r = await api("get", { path }); seen(path, r && r.ver); }
        catch (e) { if (e && e.code === OFFLINE && queue.some((w) => w.path === path)) r = { exists: false }; else throw e; }
        r = overlay(spec, r);
        return docSnap(id, r.exists, r.data, vers.get(path));
      },
      // opts.ifVersion: the version the change is based on (from snap.ver or version()), to refuse it with
      // `conflict` if the document has changed since; null: no check. Left out: what this device last saw.
      set: (data, opts) => write("set", { path, data }, opts),
      update: (patch, opts) => write("update", { path, patch }, opts),
      delete: (opts) => write("delete", { path }, opts),
      /** The latest version of this document this device has seen (0 if none). */
      version: () => vers.get(path) || 0,
      onSnapshot(next, error) {
        return subscribe(spec, (r) => next(docSnap(id, r.exists, r.data, vers.get(path))), error);
      },
    };
  }

  function query(path, opts) {
    const spec = () => ({ kind: "col", path, orderBy: opts.orderBy, dir: opts.dir, limit: opts.limit });
    return {
      orderBy: (field, dir) => query(path, Object.assign({}, opts, { orderBy: field, dir: dir === "desc" ? "desc" : "asc" })),
      limit: (n) => query(path, Object.assign({}, opts, { limit: n })),
      async get() {
        const raw = await api("query", spec());
        for (const d of raw.docs || []) seen(path + "/" + d.id, d.ver);
        const r = overlay(spec(), raw);
        return querySnap(r.docs, path);
      },
      onSnapshot(next, error) {
        return subscribe(spec(), (r) => next(querySnap(r.docs, path)), error);
      },
    };
  }

  function collectionRef(path) {
    const parts = segments(path);
    if (parts.length % 2 !== 1) throw new TypeError(`Not a collection path: ${path}`);
    return Object.assign(query(path, {}), {
      id: parts[parts.length - 1],
      path,
      doc: (id) => docRef(path + "/" + (id || randomId())),
      async add(data) {
        const ref = docRef(path + "/" + randomId());
        await ref.set(data);
        return ref;
      },
    });
  }

  const db = { doc: docRef, collection: collectionRef };

  /* ---------- user ---------- */

  const user = {
    async me() {
      const { user: u, quickSwitch } = await mePromise;
      return { id: u.recordId, name: u.name, avatarUrl: "", role: u.role, quickPin: !!u.quickPin, quickSwitch: !!quickSwitch };
    },
    async can(perm) { return perm === "data.write"; }, // every role records entries; section limits are separate
    async profiles(ids) {
      try { return await api("profiles", { ids }); }
      catch (e) { if (e && e.code === OFFLINE) return null; throw e; } // null: keep the names already shown
    },
    // Everyone with an active account: [{id: "web:<name>", name, role}]. null when offline.
    async team() {
      try { return (await call("/api/auth/team")).team; }
      catch (e) { if (e && e.code === OFFLINE) return null; throw e; }
    },
  };

  /* ---------- assets (allergen PDFs) ---------- */

  const assets = {
    async upload(file, opts) {
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      return call("/api/assets", { method: "POST", headers: { "content-type": type }, body: file });
    },
    async delete(id) {
      return call("/api/assets/" + encodeURIComponent(id), { method: "DELETE" });
    },
  };

  /* ---------- rota (src/rota.ts): who's on shift today ---------- */

  const rota = {
    // Today's published shifts at a site: {site, day, published, shifts:[{name, me, open, start, end, job}], rotaUrl}.
    // null when offline, so the page keeps what it showed.
    async today(site) {
      try { return await call("/api/rota/today?site=" + encodeURIComponent(site)); }
      catch (e) { if (e && e.code === OFFLINE) return null; throw e; }
    },
    // Where the rota lives, for links: {rota, diary}.
    async links() {
      try { return await call("/api/rota/links"); }
      catch (e) { return null; }
    },
  };

  const services = { db, user, assets, rota };
  window.claude = { use: async (n) => services[n] ?? null };
})();
