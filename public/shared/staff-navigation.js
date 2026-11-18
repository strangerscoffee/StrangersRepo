// Shared navigation between staff apps. Links come from the signed-in session and work on the separate hosts.
(() => {
  "use strict";
  const { el, svgi } = SC;
  const apps = [
    ["diary", "Kitchen Diary", '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 2 2 4-4"/>'],
    ["rota", "Rota", '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'],
    ["orders", "Wholesale", '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zm12 1h2a2 2 0 0 1 0 4h-2M3 21h16M8 3v2m4-2v2"/>'],
  ];
  const publicRoutes = { diary: "/", rota: "/rota/" };
  const containers = () => document.querySelectorAll("[data-staff-workspaces]");
  const workspaceLink = "[data-staff-workspaces] a[data-workspace]";
  let active, listening = false;
  let focusedWorkspace;

  document.addEventListener("focusin", event => {
    focusedWorkspace = event.target.closest?.(workspaceLink);
  });
  document.addEventListener("focusout", event => {
    if (event.target === focusedWorkspace && (event.relatedTarget || event.target.getClientRects().length)) {
      focusedWorkspace = null;
    }
  });
  matchMedia("(min-width: 1024px)").addEventListener("change", () => {
    const previous = focusedWorkspace;
    if (!previous?.isConnected || previous.getClientRects().length || !document.hasFocus()) return;
    // Keyboard users keep the same destination when its navigation moves between the header and dock.
    const next = [...document.querySelectorAll(workspaceLink)].find(link =>
      link.dataset.workspace === previous.dataset.workspace && link.getClientRects().length && !link.closest("[inert]"));
    next?.focus({ preventScroll: true });
  });

  function render(current, links = publicRoutes, ordersAccess = false) {
    const hrefs = {
      diary: links.diary || publicRoutes.diary,
      rota: links.rota || publicRoutes.rota,
      orders: new URL("/orders", new URL(links.diary || publicRoutes.diary, location.href)).href,
    };
    for (const nav of containers()) {
      const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.workspace : null;
      nav.replaceChildren(...apps.filter(([id]) => id !== "orders" || ordersAccess).map(([id, label, path]) =>
        el("a", { href: hrefs[id], "data-workspace": id, "aria-current": id === current ? "page" : null },
          svgi(path), el("span", { text: label }))));
      nav.hidden = false;
      if (focused) (nav.querySelector(`[data-workspace="${focused}"]`) || nav.querySelector("[aria-current=page]"))?.focus({ preventScroll: true });
    }
  }

  function clear() {
    active = null;
    for (const nav of containers()) {
      nav.hidden = true;
      nav.replaceChildren();
    }
  }

  async function refreshAccess() {
    const watched = active;
    if (!watched || document.hidden || watched.pending) return;
    const revision = watched.revision;
    watched.pending = true;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) return;
      const me = await response.json();
      if (active !== watched || me.user?.id !== watched.userId || me.user.role !== watched.role) return;
      const allowed = me.capabilities?.staffOrders === true;
      if (allowed !== watched.ordersAccess) {
        watched.ordersAccess = allowed;
        render(watched.current, me.links, allowed);
      }
    } catch { /* Keep the current links if the connection is unavailable. */ }
    finally {
      watched.pending = false;
      if (active === watched && revision !== watched.revision) refreshAccess();
    }
  }

  // Reuse the account-change stream to reflect a grant or revocation in already open staff apps.
  function watch(current, { userId, role, links, ordersAccess }) {
    render(current, links, ordersAccess);
    if (!userId || role === "admin") return; // Admins always inherit order access while their session is valid.
    active = { current, userId, role, ordersAccess, revision: null, pending: false };
    if (listening) return;
    listening = true;
    SC.live(change => {
      if (!active) return;
      if (typeof change.accounts === "number") {
        // The socket sends revisions after writes, so the first frame can be an access change.
        const changed = change.accounts !== active.revision;
        active.revision = change.accounts;
        if (changed) refreshAccess();
      } else if (change.open && active.revision !== null) refreshAccess();
    });
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (Date.now() - hiddenAt > 10000) refreshAccess();
    });
    addEventListener("pageshow", event => { if (event.persisted) refreshAccess(); });
  }

  // These per-tab preferences contain only navigation identifiers. Business and employee data stay in the apps.
  const stateKey = (app, id) => `sc.staff-navigation.${app}.${id}`;
  function read(app, id) {
    if (!id) return null;
    try { return JSON.parse(sessionStorage.getItem(stateKey(app, id))); } catch { return null; }
  }
  function save(app, id, value) {
    if (!id) return;
    try { sessionStorage.setItem(stateKey(app, id), JSON.stringify(value)); } catch { /* storage may be disabled */ }
  }

  window.SCStaffNavigation = { render, watch, clear, read, save };
})();
