// A 4-digit PIN pad in a bottom sheet, used by the diary (switch person, set a quick PIN) and the sign-in
// page (quick sign-in). onPin(pin, signal) should pass the signal to any request and return null
// on success or an error message to show.
(() => {
  "use strict";
  let open = null;
  let activeRequest = null;
  const locked = () => document.documentElement.hasAttribute("data-sc-session-locked");

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") e.textContent = v;
      else if (k === "onclick") e.addEventListener("click", v);
      else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  function close() {
    if (!open) return;
    const sheet = open;
    open = null;
    activeRequest?.abort();
    activeRequest = null;
    if (sheet.open) sheet.close();
    const animations = sheet.getAnimations?.().filter((animation) => animation.transitionProperty === "opacity") ?? [];
    if (animations.length) Promise.allSettled(animations.map((animation) => animation.finished)).then(() => sheet.remove());
    else sheet.remove();
  }

  function show({ title, sub, onPin }) {
    if (locked()) return;
    close();
    let pin = "", busy = false;
    const dots = el("div", { class: "pp-dots", "aria-hidden": "true" }, ...[0, 1, 2, 3].map(() => el("i")));
    const msg = el("p", { class: "pp-msg", role: "alert" });
    const live = el("span", { class: "pp-live", "aria-live": "polite" });
    const paint = () => {
      dots.querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i < pin.length));
      live.textContent = `${pin.length} of 4 digits`;
    };
    async function press(k) {
      if (busy) return;
      if (k === "del") pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      msg.textContent = "";
      paint();
      if (pin.length < 4) return;
      busy = true;
      sheet.classList.add("busy");
      sheet.setAttribute("aria-busy", "true");
      msg.textContent = "Checking PIN…";
      const request = new AbortController();
      activeRequest = request;
      const deadline = setTimeout(() => request.abort(), 10000);
      let err;
      try { err = await onPin(pin, request.signal); } catch (e) { err = (e && e.message) || "Something went wrong. Try again."; }
      finally { clearTimeout(deadline); }
      if (open !== sheet) return;
      activeRequest = null;
      busy = false;
      sheet.classList.remove("busy");
      sheet.removeAttribute("aria-busy");
      if (request.signal.aborted) err = "The PIN check took too long. Try again.";
      if (!err) return close();
      msg.textContent = err;
      pin = "";
      paint();
      sheet.classList.remove("shake");
      void sheet.offsetWidth;
      sheet.classList.add("shake");
    }
    const cancel = () => { if (!busy && open === sheet) close(); };
    const key = (k, label, extra) => el("button", { type: "button", class: "pp-key" + (extra ? " " + extra : ""), "aria-label": label || k, autofocus: k === "1", onclick: () => press(k) }, label === "Delete" ? "⌫" : k);
    const keys = el("div", { class: "pp-keys" },
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => key(k)),
      el("button", { type: "button", class: "pp-key alt", onclick: cancel }, "Cancel"),
      key("0"), key("del", "Delete", "alt"));
    const sheet = el("dialog", { class: "pp-sheet", "aria-label": title },
      el("div", { class: "pp-grab", "aria-hidden": "true" }),
      el("h2", { text: title }), sub ? el("p", { class: "pp-sub", text: sub }) : null,
      dots, live, msg, keys);
    sheet.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const digit = /^\d$/.test(event.key);
      if (!digit && event.key !== "Backspace") return;
      event.preventDefault();
      press(digit ? event.key : "del");
    });
    sheet.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
    sheet.addEventListener("click", (event) => {
      if (event.target !== sheet) return;
      const bounds = sheet.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
    });
    sheet.addEventListener("close", () => { if (open === sheet) close(); });
    document.body.append(sheet);
    open = sheet;
    paint();
    sheet.showModal();
  }

  new MutationObserver(() => { if (locked()) close(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-sc-session-locked"] });
  window.PinPad = { open: show, close };
})();
