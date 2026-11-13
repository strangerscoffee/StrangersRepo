// Admin → Wholesale → Tabs: every customer's open tab (a running tally of their orders until 6 kg), with £ for admins,
// and recently cleared tabs. Clearing works as on the staff Wholesale orders page: exactly the orders shown are
// cleared, so an order added meanwhile isn't swept in (src/wholesaleTabs.ts, /api/admin/wholesale/tabs).
window.WholesaleTabs = function ({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast }) {
  let data = null;
  const weight = (g) => `${(g / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 })} kg`;
  const money = (p) => Number.isFinite(p) ? (p / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" }) : "";
  const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
  const counted = (t) => t.orders.filter((o) => o.counts).length;
  const bar = (t) => { const pct = Math.min(100, Math.round(t.grams / data.threshold * 100)); return html`<span class="w-tab-bar ${t.ready ? "ready" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${data.threshold / 1000}" aria-valuenow="${t.grams / 1000}" aria-label="${weight(t.grams)} of ${weight(data.threshold)}"><span style="width:${pct}%"></span></span>`; };

  async function view() {
    try { data = await api("GET", "/api/admin/wholesale/tabs"); }
    catch (error) { return html`<div class="w-tabs-workspace"><p class="err" role="alert">Tabs could not be loaded: ${error.message}</p></div>`; }
    const open = data.open, ready = open.filter((t) => t.ready).length;
    return html`<div class="w-tabs-workspace">
      <div class="w-tabs-head"><div><h2>Customer tabs</h2><p class="hint">A running tally of a customer's orders. Clear the tab once it reaches ${weight(data.threshold)}, or sooner. Orders on a tab are packed and dispatched as usual. Put an order on a tab from the order, or tick "Put orders on a tab" on the customer.</p></div>${open.length ? html`<p class="w-tabs-count">${open.length} ${open.length === 1 ? "tab" : "tabs"}${ready ? html` · <b>${ready} ready to clear</b>` : ""}</p>` : ""}</div>
      ${open.length ? html`<div class="w-tab-cards">${open.map((t) => html`<button class="w-tab-card ${t.ready ? "ready" : ""}" type="button" data-act="wh-tabs-open" data-id="${t.customerId}">
          <span class="w-tab-top"><b>${t.business}</b>${t.ready ? html`<span class="pill ok">${svg("ok")}Ready to clear</span>` : t.autoTab ? html`<span class="pill">Automatic</span>` : ""}</span>
          <span class="w-tab-kg"><strong>${weight(t.grams)}</strong> of ${weight(data.threshold)}</span>${bar(t)}
          <span class="w-tab-meta">${t.orders.length ? `${counted(t)} ${counted(t) === 1 ? "order" : "orders"} · ${t.packs} ${t.packs === 1 ? "bag" : "bags"} · ${money(t.pence)}${t.ready ? "" : ` · ${weight(t.toGo)} to go`}` : "Nothing on the tab yet"}</span>
        </button>`)}</div>` : html`<p class="hint w-tabs-empty">No open tabs. Open an order and choose Put on tab, or tick "Put orders on a tab" on a customer.</p>`}
      <h3 class="w-tabs-sub">Recently cleared</h3>
      ${data.cleared.length ? html`<div class="group">${data.cleared.map((c) => html`<div class="item"><span class="tx"><b>${c.business}</b><span>Cleared ${date(c.clearedAt)} by ${c.clearedBy}</span></span><span class="end"><strong class="num">${weight(c.grams)}</strong>${Number.isFinite(c.pence) ? html`<span class="w-tab-money">${money(c.pence)}</span>` : ""}${c.early ? html`<span class="pill">Early</span>` : ""}</span></div>`)}</div>` : html`<p class="hint">No tabs cleared yet.</p>`}
    </div>`;
  }

  function openTab(customerId, confirm = false, error = "") {
    const t = data?.open.find((x) => x.customerId === customerId);
    if (!t) { closeSheet(); return; }
    openSheet(html`<form class="w-sheet w-tab-sheet" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${t.business}</h2><p class="hint">${t.ready ? `This tab has reached ${weight(data.threshold)} and is ready to clear.` : `${weight(t.toGo)} to go before it's ready to clear. You can clear it sooner if needed.`}</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="w-tab-summary ${t.ready ? "ready" : ""}"><span class="w-tab-kg big"><strong>${weight(t.grams)}</strong> of ${weight(data.threshold)}</span>${bar(t)}<span class="w-tab-meta">${t.packs} ${t.packs === 1 ? "bag" : "bags"} · ${money(t.pence)}</span></div>
      <h3>Orders on the tab</h3>
      ${t.orders.length ? html`<div class="group">${t.orders.map((o) => html`<div class="item ${o.counts ? "" : "w-tab-not-counted"}"><span class="tx"><b>${date(o.createdAt)}${o.reference ? ` · ${o.reference}` : ""}</b><span>${o.packs} ${o.packs === 1 ? "bag" : "bags"} · ${weight(o.grams)} · ${o.status}${o.counts ? "" : " · cancelled, not counted"}</span><span>${o.addedBy === "Automatically" ? "Added automatically" : o.addedBy ? `Added by ${o.addedBy}` : ""}</span></span><span class="end"><strong class="num">${money(o.pence)}</strong></span></div>`)}</div>` : html`<p class="hint">Nothing on the tab yet.</p>`}
      <p class="err" id="wErr" role="alert">${error}</p>
      <div class="row w-actions">${!t.orders.length ? html`<button class="btn soft" type="button" data-sheet="close">Done</button>`
        : confirm ? html`<span class="w-tab-confirm">${t.ready ? `Clear ${weight(t.grams)}?` : `Clear early at ${weight(t.grams)}?`}</span><button class="btn soft" type="button" data-sheet="tab-cancel">Cancel</button><button class="btn" type="submit">Clear tab</button>`
        : html`<button class="btn soft" type="button" data-sheet="close">Close</button><button class="btn ${t.ready ? "" : "soft"}" type="button" data-sheet="tab-clear">${t.ready ? "Clear tab" : "Clear tab early"}</button>`}</div>
    </form>`, async (action, element) => {
      if (action === "tab-clear") return openTab(customerId, true);
      if (action === "tab-cancel") return openTab(customerId, false);
      if (action !== "submit" || !confirm) return;
      const button = (element.closest("form") || element).querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = "Clearing…"; }
      try {
        const { cleared } = await api("POST", `/api/admin/wholesale/tabs/${encodeURIComponent(customerId)}/clear`, { orderIds: t.orders.map((o) => o.id) });
        closeSheet(); toast(`${cleared.business}: tab cleared at ${weight(cleared.grams)}.`); await reload();
      } catch (error) {
        if (error.code === "conflict") { try { data = await api("GET", "/api/admin/wholesale/tabs"); } catch {} return openTab(customerId, false, "This tab changed on another device. It has been reloaded: check it and clear again."); }
        openTab(customerId, false, error.message);
      }
    });
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  return { view, async act(name, id) { if (name === "wh-tabs-open") openTab(id); } };
};
