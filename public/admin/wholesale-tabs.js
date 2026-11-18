// Admin → Wholesale → Tabs: every customer's open tab (a running tally of their orders until 6 kg), with £ for admins,
// and recently cleared tabs. Clearing works as on the staff Wholesale orders page: tick the orders to clear (all of
// them, or some, leaving the rest on the tab); if the tab changed meanwhile nothing is cleared
// (src/wholesaleTabs.ts, /api/admin/wholesale/tabs).
window.WholesaleTabs = function ({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast }) {
  let data = null, pick = new Set(), pickFor = null;
  const ordered = (ms) => "Ordered " + new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const sumOf = (list) => { const c = list.filter((o) => o.counts); return { orders: list.length, grams: c.reduce((t, o) => t + (o.grams || 0), 0), pence: c.reduce((t, o) => t + (o.pence || 0), 0) }; };
  const NOW = { "on-tab": "Still on the tab", cleared: "Cleared since", "off-tab": "Taken off the tab" };
  const weight = (g) => `${(g / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 })} kg`;
  const money = (p) => Number.isFinite(p) ? (p / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" }) : "";
  const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
  const counted = (t) => t.orders.filter((o) => o.counts).length;
  // What's on a tab, itemised by coffee, bag size and grind; a shorter version on the cards.
  const itemText = (i) => `${i.size} · ${i.grind}${i.decaf ? " · Decaf" : ""}`;
  const itemList = (items) => html`<ul class="w-tab-items">${items.map((i) => html`<li><span class="n">${i.bags} ×</span><span class="t"><b>${i.title}</b><span>${itemText(i)}</span></span><span class="kg">${weight(i.grams)}</span></li>`)}</ul>`;
  const itemPeek = (items) => html`<span class="w-tab-peek">${items.slice(0, 3).map((i) => html`<span>${i.bags} × ${i.title} · ${itemText(i)}</span>`)}${items.length > 3 ? html`<span class="more">and ${items.length - 3} more</span>` : ""}</span>`;
  const lineText = (o) => (o.lines || []).map((l) => `${l.bags} × ${l.title} ${l.size} ${l.grind}${l.decaf ? " decaf" : ""}`).join(", ");
  const bar = (t) => { const pct = Math.min(100, Math.round(t.grams / data.threshold * 100)); return html`<span class="w-tab-bar ${t.ready ? "ready" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${data.threshold / 1000}" aria-valuenow="${t.grams / 1000}" aria-label="${weight(t.grams)} of ${weight(data.threshold)}"><span style="width:${pct}%"></span></span>`; };

  async function view() {
    try { data = await api("GET", "/api/admin/wholesale/tabs"); }
    catch (error) { return html`<section class="w-tabs-workspace w-list-panel glass" aria-label="Customer tabs"><p class="err" role="alert">Tabs could not be loaded: ${error.message}</p></section>`; }
    const open = [...data.open].sort((a, b) => Number(b.ready) - Number(a.ready)), ready = open.filter((t) => t.ready).length;
    return html`<section class="w-tabs-workspace w-list-panel glass" aria-label="Customer tabs">
      <div class="w-tabs-head"><div><h2>Customer tabs</h2><p class="hint">A running tally of a customer's orders. Clear the tab once it reaches ${weight(data.threshold)}, or sooner. Orders on a tab are packed and dispatched as usual. Put an order on a tab from the order, or tick "Put orders on a tab" on the customer.</p></div>${open.length ? html`<p class="w-tabs-count">${open.length} ${open.length === 1 ? "tab" : "tabs"}${ready ? html` · <b>${ready} ready to clear</b>` : ""}</p>` : ""}</div>
      ${open.length ? html`<div class="w-tab-cards">${open.map((t) => html`<button class="w-tab-card ${t.ready ? "ready" : ""}" type="button" data-act="wh-tabs-open" data-id="${t.customerId}">
          <span class="w-tab-top"><b>${t.business}</b>${t.ready ? html`<span class="pill ok">${svg("ok")}Ready to clear</span>` : t.autoTab ? html`<span class="pill">Automatic</span>` : ""}</span>
          <span class="w-tab-kg"><strong>${weight(t.grams)}</strong> of ${weight(data.threshold)}</span>${bar(t)}
          ${t.items?.length ? itemPeek(t.items) : ""}
          <span class="w-tab-meta">${t.orders.length ? `${counted(t)} ${counted(t) === 1 ? "order" : "orders"} · ${t.packs} ${t.packs === 1 ? "bag" : "bags"} · ${money(t.pence)}${t.ready ? "" : ` · ${weight(t.toGo)} to go`}` : "Nothing on the tab yet"}</span>
        </button>`)}</div>` : html`<div class="w-empty"><span class="ic mut">${svg("coffee")}</span><h3>No open tabs</h3><p>Open an order and choose Put on tab, or enable automatic tabs in a customer’s settings.</p></div>`}
      <h3 class="w-tabs-sub">Recently cleared</h3>
      ${data.cleared.length ? html`<div class="group">${data.cleared.map((c) => html`<button class="item w-tab-cleared" type="button" data-act="wh-tabs-cleared" data-id="${c.id}"><span class="tx"><b>${c.business}</b><span>${c.kept?.length ? "Part cleared" : "Cleared"} ${date(c.clearedAt)} by ${c.clearedBy}${c.kept?.length ? ` · ${c.kept.length} kept on the tab` : ""}</span></span><span class="end"><strong class="num">${weight(c.grams)}</strong>${Number.isFinite(c.pence) ? html`<span class="w-tab-money">${money(c.pence)}</span>` : ""}${c.kept?.length ? html`<span class="pill">Part</span>` : ""}${c.early ? html`<span class="pill">Early</span>` : ""}</span></button>`)}</div>` : html`<p class="hint">No tabs cleared yet.</p>`}
    </section>`;
  }

  function openTab(customerId, confirm = false, error = "") {
    const t = data?.open.find((x) => x.customerId === customerId);
    if (!t) { closeSheet(); return; }
    if (pickFor !== customerId) { pickFor = customerId; pick = new Set(t.orders.map((o) => o.id)); }
    pick = new Set([...pick].filter((id) => t.orders.some((o) => o.id === id)));
    const picked = t.orders.filter((o) => pick.has(o.id)), keep = t.orders.filter((o) => !pick.has(o.id)), chosen = sumOf(picked), rest = sumOf(keep), all = !keep.length;
    const last = t.lastCleared;
    const question = all ? (t.ready ? `Clear ${weight(t.grams)}?` : `Clear early at ${weight(t.grams)}?`) : `Clear ${weight(chosen.grams)} (${money(chosen.pence)})? ${rest.orders} ${rest.orders === 1 ? "order stays" : "orders stay"} on the tab.`;
    openSheet(html`<form class="w-sheet w-tab-sheet" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${t.business}</h2><p class="hint">${t.ready ? `This tab has reached ${weight(data.threshold)} and is ready to clear.` : `${weight(t.toGo)} to go before it's ready to clear. You can clear it sooner if needed.`}</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="w-tab-summary ${t.ready ? "ready" : ""}"><span class="w-tab-kg big"><strong>${weight(t.grams)}</strong> of ${weight(data.threshold)}</span>${bar(t)}<span class="w-tab-meta">${t.packs} ${t.packs === 1 ? "bag" : "bags"} · ${money(t.pence)}</span>${last ? html`<span class="w-tab-meta">Last cleared ${date(last.clearedAt)} by ${last.clearedBy}: ${weight(last.grams)}${last.partial ? " (part of the tab; the rest stayed on it)" : ""}</span>` : ""}</div>
      ${t.items?.length ? html`<h3>On the tab</h3>${itemList(t.items)}` : ""}
      <h3>Orders on the tab</h3>
      ${t.orders.length > 1 ? html`<p class="hint">Untick any orders that should stay on the tab. Only the ticked ones are cleared.</p>` : ""}
      ${t.orders.length ? html`<div class="group">${t.orders.map((o) => html`<label class="item w-tab-order ${o.counts ? "" : "w-tab-not-counted"} ${pick.has(o.id) ? "" : "kept"}"><input type="checkbox" class="w-tab-pick" data-sheet="tab-pick" data-id="${o.id}" aria-label="Clear the order of ${date(o.createdAt)}" ${pick.has(o.id) ? raw("checked") : ""}><span class="tx"><b>${ordered(o.createdAt)}${o.reference ? ` · ${o.reference}` : ""}</b><span>${o.packs} ${o.packs === 1 ? "bag" : "bags"} · ${weight(o.grams)} · ${o.status}${o.counts ? "" : " · cancelled, not counted"}</span>${o.lines?.length ? html`<span>${lineText(o)}</span>` : ""}<span>${o.addedBy === "Automatically" ? "Added automatically" : o.addedBy ? `Added by ${o.addedBy}` : ""}</span></span><span class="end"><strong class="num">${money(o.pence)}</strong>${pick.has(o.id) ? "" : html`<span class="pill">Stays on tab</span>`}</span></label>`)}</div>` : html`<p class="hint">Nothing on the tab yet.</p>`}
      <p class="err" id="wErr" role="alert">${error}</p>
      <div class="row w-actions">${!t.orders.length ? html`<button class="btn soft" type="button" data-sheet="close">Done</button>`
        : confirm && picked.length ? html`<span class="w-tab-confirm">${question}</span><button class="btn soft" type="button" data-sheet="tab-cancel">Cancel</button><button class="btn" type="submit">${all ? "Clear tab" : "Clear these"}</button>`
        : html`${all ? "" : html`<span class="w-tab-confirm">${picked.length ? `${weight(chosen.grams)} to clear · ${weight(rest.grams)} stays` : "Tick the orders to clear"}</span>`}<button class="btn soft" type="button" data-sheet="close">Close</button><button class="btn ${t.ready || !all ? "" : "soft"}" type="button" data-sheet="tab-clear" ${picked.length ? "" : raw("disabled")}>${all ? (t.ready ? "Clear tab" : "Clear tab early") : `Clear ${picked.length} of ${t.orders.length}`}</button>`}</div>
    </form>`, async (action, element) => {
      if (action === "tab-pick") { const id = element.dataset.id; element.checked ? pick.add(id) : pick.delete(id); return openTab(customerId, false); }
      if (action === "tab-clear") return openTab(customerId, true);
      if (action === "tab-cancel") return openTab(customerId, false);
      if (action !== "submit" || !confirm) return;
      const button = (element.closest("form") || element).querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = "Clearing…"; }
      try {
        const { cleared } = await api("POST", `/api/admin/wholesale/tabs/${encodeURIComponent(customerId)}/clear`, {
          orderIds: picked.map(o => o.id), seen: t.orders.map(o => o.id), seenVersions: Object.fromEntries(t.orders.map(o => [o.id, o.version])),
        });
        pickFor = null;
        closeSheet(); toast(cleared.keptIds?.length ? `${cleared.business}: ${weight(cleared.grams)} cleared, ${cleared.keptIds.length} ${cleared.keptIds.length === 1 ? "order stays" : "orders stay"} on the tab.` : `${cleared.business}: tab cleared at ${weight(cleared.grams)}.`); await reload();
      } catch (error) {
        if (error.code === "conflict") {
          try { data = await api("GET", "/api/admin/wholesale/tabs"); }
          catch { return openTab(customerId, false, "This tab changed. Reload Tabs before trying again."); }
          return openTab(customerId, false, "This tab changed. Check the updated orders before clearing.");
        }
        openTab(customerId, false, error.message);
      }
    });
    if (!document.activeElement?.classList.contains("w-tab-pick")) document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  // A cleared tab, read only: what was cleared, when each order was placed and, after a part clear, what stayed on the tab.
  function openCleared(id) {
    const c = data?.cleared.find((x) => x.id === id);
    if (!c) return;
    const row = (o, end) => html`<div class="item ${o.counts ? "" : "w-tab-not-counted"}"><span class="tx"><b>${ordered(o.createdAt)}${o.reference ? ` · ${o.reference}` : ""}</b><span>${o.packs} ${o.packs === 1 ? "bag" : "bags"} · ${weight(o.grams)} · ${o.status}${o.counts ? "" : " · cancelled, not counted"}</span>${o.lines?.length ? html`<span>${lineText(o)}</span>` : ""}</span>${end ? html`<span class="end">${end}</span>` : ""}</div>`;
    openSheet(html`<div class="w-sheet w-tab-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${c.business}</h2><p class="hint">${c.kept?.length ? "Part cleared" : "Cleared"} ${date(c.clearedAt)} by ${c.clearedBy}${c.early ? `, before it reached ${weight(data.threshold)}` : ""}.</p></div><button class="btn soft" type="button" data-sheet="close">Close</button></div>
      <div class="w-tab-summary"><span class="w-tab-kg big"><strong>${weight(c.grams)}</strong></span><span class="w-tab-meta">${c.packs} ${c.packs === 1 ? "bag" : "bags"}${Number.isFinite(c.pence) ? ` · ${money(c.pence)}` : ""}</span></div>
      ${c.items?.length ? html`<h3>What was cleared</h3>${itemList(c.items)}` : ""}
      <h3>Orders cleared</h3>
      ${c.orders?.length ? html`<div class="group">${c.orders.map((o) => row(o))}</div>` : html`<p class="hint">The orders on this tab are no longer available.</p>`}
      ${c.kept?.length ? html`<h3>Kept on the tab</h3><div class="group">${c.kept.map((o) => row(o, html`<span class="pill">${NOW[o.now] || o.now}</span>`))}</div>` : ""}
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Done</button></div></div>`, () => {});
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  return { view, async act(name, id) { if (name === "wh-tabs-open") { pickFor = null; openTab(id); } if (name === "wh-tabs-cleared") openCleared(id); } };
};
