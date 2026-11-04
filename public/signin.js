// Sign-in page: username + password, choosing a password after a temporary one, changing a password,
// first-admin setup and admin password recovery.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const FORMS = ["signin", "newpw", "change", "setup", "recover"];

  // Only paths on this site, or https links to its own subdomains (the rota sends people here to sign in and
  // back again), so the next= link can't send people anywhere else.
  const next = (() => {
    // Resolve it the way the browser will (it reads "\" as "/" and drops tabs and newlines), then check where
    // it actually lands.
    const n = new URLSearchParams(location.search).get("next") || "/";
    try {
      const u = new URL(n, location.origin);
      if (u.username || u.password) return "/";
      if (u.origin === location.origin) return u.pathname + u.search + u.hash;
      if (u.protocol === "https:" && u.hostname.endsWith("." + location.hostname)) return u.href;
    } catch (e) {}
    return "/";
  })();

  function show(id, focus) {
    for (const f of FORMS) $("#" + f).hidden = f !== id;
    if ($("#quick").dataset.ready) $("#quick").hidden = id !== "signin"; // quick sign-in sits above the sign-in form only
    document.querySelectorAll(".err").forEach((e) => { e.textContent = ""; });
    const el = focus ? $(focus) : $(`#${id} input:not([hidden])`);
    if (el) el.focus();
  }

  async function post(url, body) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error("Couldn't reach the site. Check your connection.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Something went wrong. Try again.");
    return data;
  }

  // Runs a form's submit handler with its button disabled and errors shown in its .err.
  function onSubmit(id, fn) {
    $("#" + id).addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $(`#${id} .err`), btn = $(`#${id} button[type=submit]`);
      err.textContent = "";
      btn.disabled = true;
      try { await fn(err); } catch (x) { err.textContent = x.message; }
      btn.disabled = false;
    });
  }

  const val = (s) => $(s).value;
  const user = (s) => $(s).value.trim().toLowerCase();
  const checkNew = (a, b) => (a.length < 8 ? "Passwords need at least 8 characters." : a !== b ? "The two passwords don't match." : "");

  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.go === "change" && $("#username").value) $("#cuser").value = $("#username").value;
    if (b.dataset.go === "recover" && $("#username").value) $("#ruser").value = $("#username").value;
    show(b.dataset.go);
  }));

  document.querySelectorAll(".pw .show").forEach((b) => b.addEventListener("click", () => {
    const input = $("#" + b.getAttribute("aria-controls"));
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    b.textContent = showing ? "Show" : "Hide";
    b.setAttribute("aria-pressed", String(!showing));
    input.focus();
  }));

  /* ---------- sign in ---------- */

  let pending = null; // {username, password} after signing in with a temporary password

  onSubmit("signin", async (err) => {
    const username = user("#username"), password = val("#password");
    if (!username) { err.textContent = "Enter your username."; $("#username").focus(); return; }
    if (!password) { err.textContent = "Enter your password."; $("#password").focus(); return; }
    try {
      const r = await post("/api/auth/login", { username, password });
      if (r.mustChange) {
        pending = { username, password };
        $("#newpw input[name=username]").value = username;
        $("#newpwTitle").textContent = `Hi ${r.name}, choose your password`;
        show("newpw", "#np1");
        return;
      }
      location.replace(next);
    } catch (x) {
      $("#password").value = "";
      $("#password").focus();
      throw x;
    }
  });

  onSubmit("newpw", async (err) => {
    const a = val("#np1"), b = val("#np2");
    const bad = checkNew(a, b);
    if (bad) { err.textContent = bad; return; }
    await post("/api/auth/change", { ...pending, newPassword: a });
    location.replace(next);
  });

  /* ---------- change password ---------- */

  onSubmit("change", async (err) => {
    const username = user("#cuser"), password = val("#ccur"), a = val("#cnew"), b = val("#cnew2");
    if (!username || !password) { err.textContent = "Enter your username and current password."; return; }
    const bad = checkNew(a, b);
    if (bad) { err.textContent = bad; return; }
    await post("/api/auth/change", { username, password, newPassword: a });
    location.replace(next);
  });

  /* ---------- first admin ---------- */

  // Suggest a username from the name until the person types their own.
  let userEdited = false;
  $("#suser").addEventListener("input", () => { userEdited = true; });
  $("#sname").addEventListener("input", () => {
    if (!userEdited) $("#suser").value = $("#sname").value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 .-]/g, "").trim().replace(/\s+/g, ".").slice(0, 32);
  });

  onSubmit("setup", async (err) => {
    const name = val("#sname").trim(), username = user("#suser"), a = val("#spw"), b = val("#spw2"), code = val("#scode").trim();
    if (!name) { err.textContent = "Enter your name."; return; }
    if (!username) { err.textContent = "Choose a username."; return; }
    const bad = checkNew(a, b);
    if (bad) { err.textContent = bad; return; }
    if (!code) { err.textContent = "Enter the setup code."; return; }
    await post("/api/auth/setup", { name, username, password: a, code });
    location.replace("/admin");
  });

  /* ---------- admin password recovery ---------- */

  onSubmit("recover", async (err) => {
    const username = user("#ruser"), a = val("#rpw"), b = val("#rpw2"), code = val("#rcode").trim();
    if (!username) { err.textContent = "Enter the admin username."; return; }
    const bad = checkNew(a, b);
    if (bad) { err.textContent = bad; return; }
    if (!code) { err.textContent = "Enter the setup code."; return; }
    await post("/api/auth/recover", { username, password: a, code });
    location.replace("/admin");
  });

  /* ---------- quick sign-in ---------- */

  // Lists people with a quick PIN, on a device someone has signed in on with a password (the server
  // returns nobody anywhere else). Tapping a name asks for their PIN (pinpad.js).
  async function quickSignIn() {
    let people = [];
    try { people = (await (await fetch("/api/auth/people")).json()).people || []; } catch (e) { return; }
    if (!people.length) return;
    const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const box = $("#quickPeople");
    box.replaceChildren(...people.map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "person";
      const av = document.createElement("span"); av.className = "av"; av.textContent = initials(p.name);
      const nm = document.createElement("span"); nm.textContent = p.name;
      b.append(av, nm);
      b.addEventListener("click", () => PinPad.open({
        title: `Hi ${p.name.split(" ")[0]}`, sub: "Enter your quick PIN",
        onPin: async (pin) => {
          try { await post("/api/auth/switch", { id: p.id, pin }); } catch (e) { return e.message; }
          location.replace(next);
          return null;
        },
      }));
      return b;
    }));
    $("#quick").dataset.ready = "1";
    $("#quick").hidden = $("#signin").hidden;
  }

  /* ---------- start ---------- */

  fetch("/api/auth/me").then((r) => r.json()).then(({ user, setupNeeded }) => {
    if (user && location.hash === "#change") { show("change"); return; } // from the diary's account menu
    if (user) { location.replace(next); return; }
    show(setupNeeded ? "setup" : "signin");
    if (!setupNeeded) quickSignIn();
  }).catch(() => {
    show("signin");
    $("#err").textContent = "Couldn't reach the site. Check your connection and reload.";
  });
})();
