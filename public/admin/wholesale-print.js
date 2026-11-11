// Wholesale packing: print orders (all new ones, or the ones picked) as packing sheets, and the bags to process
// (250 g, 1 kg and all bags, by coffee and by coffee, size and grind), on screen and printed. Printing uses the
// browser's own dialog, so the same pages can be saved as a PDF. Prices are left off: these are for packing.
window.WholesalePrint = function ({ api, html, raw, svg, put, openSheet, closeSheet, toast }) {
  const { grindFor, coffeeStyle } = window.SCWholesalePreparation;
  const root = "/api/admin/wholesale";
  const packOrder = ["quarter", "kilo", "half"];
  const packName = { quarter: "250 g", kilo: "1 kg", half: "500 g" };
  const london = (at, style = { dateStyle: "medium", timeStyle: "short" }) => new Intl.DateTimeFormat("en-GB", { ...style, timeZone: "Europe/London" }).format(new Date(at));
  const kg = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const bags = (n) => `${n} ${n === 1 ? "bag" : "bags"}`;
  const scopes = { New: { status: "New", label: "New orders" }, open: { status: "New,Preparing", label: "New and preparing orders" } };

  // Bag counts: by coffee (250 g, 1 kg, all bags, weight) and by coffee, size and grind (what to pack).
  function totals(orders) {
    const coffees = new Map(), packs = new Map(), sum = { quarter: 0, kilo: 0, half: 0, bags: 0, grams: 0 };
    for (const order of orders) for (const line of order.lines || []) {
      const key = line.productId || line.title, pack = packOrder.includes(line.pack) ? line.pack : "half";
      const coffee = coffees.get(key) || { line, title: line.title, quarter: 0, kilo: 0, half: 0, bags: 0, grams: 0 };
      coffee[pack] += line.quantity; coffee.bags += line.quantity; coffee.grams += line.grams * line.quantity; coffees.set(key, coffee);
      sum[pack] += line.quantity; sum.bags += line.quantity; sum.grams += line.grams * line.quantity;
      const grind = grindFor(line), packKey = `${key}|${pack}|${grind.key}|${line.grindLabel}`;
      const entry = packs.get(packKey) || { line, title: line.title, pack, grind: line.grindLabel || grind.label, hint: line.grindHint || "", decaf: !!line.decaf, bags: 0 };
      entry.bags += line.quantity; packs.set(packKey, entry);
    }
    const byTitle = (a, b) => a.title.localeCompare(b.title, "en-GB") || packOrder.indexOf(a.pack) - packOrder.indexOf(b.pack) || String(a.grind).localeCompare(String(b.grind), "en-GB");
    return { coffees: [...coffees.values()].sort(byTitle), packs: [...packs.values()].sort(byTitle), sum, half: sum.half > 0 };
  }

  const swatch = (line) => html`<span class="w-coffee-swatch" style="${coffeeStyle(line)}" aria-hidden="true"></span>`;
  function tiles(sum) {
    return html`<div class="wp-tiles"><div class="wp-tile"><span>250 g bags</span><strong>${sum.quarter}</strong></div><div class="wp-tile"><span>1 kg bags</span><strong>${sum.kilo}</strong></div><div class="wp-tile wp-tile-total"><span>All bags</span><strong>${sum.bags}</strong><small>${kg(sum.grams)} of coffee</small></div></div>`;
  }
  function tables(t) {
    return html`<table class="wp-table"><caption>By coffee</caption><thead><tr><th scope="col">Coffee</th><th scope="col">250 g bags</th><th scope="col">1 kg bags</th>${t.half ? html`<th scope="col">500 g bags</th>` : ""}<th scope="col">All bags</th><th scope="col">Weight</th></tr></thead>
      <tbody>${t.coffees.map((c) => html`<tr><th scope="row">${swatch(c.line)}${c.title}</th><td>${c.quarter || "–"}</td><td>${c.kilo || "–"}</td>${t.half ? html`<td>${c.half || "–"}</td>` : ""}<td><b>${c.bags}</b></td><td>${kg(c.grams)}</td></tr>`)}</tbody>
      <tfoot><tr><th scope="row">Total</th><td>${t.sum.quarter}</td><td>${t.sum.kilo}</td>${t.half ? html`<td>${t.sum.half}</td>` : ""}<td><b>${t.sum.bags}</b></td><td>${kg(t.sum.grams)}</td></tr></tfoot></table>
      <table class="wp-table"><caption>To pack: by coffee, size and grind</caption><thead><tr><th scope="col">Coffee</th><th scope="col">Size</th><th scope="col">Grind</th><th scope="col">Bags</th></tr></thead>
      <tbody>${t.packs.map((p) => html`<tr><th scope="row">${swatch(p.line)}${p.title}${p.decaf ? html` <span class="wp-tag">Decaf</span>` : ""}</th><td>${packName[p.pack]}</td><td>${p.grind}${p.hint ? html`<small>${p.hint}</small>` : ""}</td><td><b>${p.bags}</b></td></tr>`)}</tbody></table>`;
  }
  function summaryBody(orders, label) {
    if (!orders.length) return html`<p class="wp-empty">No ${label.toLowerCase()} to process.</p>`;
    const t = totals(orders);
    return html`${tiles(t.sum)}<p class="wp-meta">${orders.length} ${orders.length === 1 ? "order" : "orders"}: ${label.toLowerCase()}</p>${tables(t)}`;
  }

  // One packing sheet per order, on its own printed page.
  function sheet(order) {
    const t = totals([order]), place = order.locationSnapshot || order.customerSnapshot || {};
    const address = [place.name && place.name !== "Main location" ? place.name : "", place.address, place.postcode].filter(Boolean).join("\n");
    return html`<article class="wp-page wp-order"><header class="wp-head"><div><p class="wp-kicker">Wholesale order · ${order.status}</p><h2>${order.business || order.customerSnapshot?.business || order.createdName}</h2><p class="wp-id">${order.id}</p></div><div class="wp-when"><span>Placed</span><b>${london(order.createdAt)}</b></div></header>
      <div class="wp-details"><div><h3>${order.delivery === "Delivery" ? "Delivery to" : "Collection"}</h3><p class="wp-address">${order.delivery === "Delivery" ? address || "No address saved" : "Roastery collection"}${place.deliveryNotes ? html`<br><small>${place.deliveryNotes}</small>` : ""}</p></div>
        <div><h3>Contact</h3><p>${[place.contact, place.phone].filter(Boolean).join(" · ") || "–"}</p>${order.reference ? html`<h3>Reference</h3><p>${order.reference}</p>` : ""}</div></div>
      ${order.customerNote ? html`<div class="wp-note"><h3>Customer comments</h3><p>${order.customerNote}</p></div>` : ""}
      ${order.note ? html`<div class="wp-note wp-internal"><h3>Internal note</h3><p>${order.note}</p></div>` : ""}
      <table class="wp-table wp-lines"><thead><tr><th scope="col" class="wp-tick"><span class="sr-only">Packed</span></th><th scope="col">Bags</th><th scope="col">Coffee</th><th scope="col">Size</th><th scope="col">Grind</th></tr></thead>
      <tbody>${(order.lines || []).map((line) => html`<tr><td class="wp-tick"><span class="wp-box" aria-hidden="true"></span></td><td><b>${line.quantity}</b></td><th scope="row">${swatch(line)}${line.title}${line.decaf ? html` <span class="wp-tag">Decaf</span>` : ""}</th><td>${packName[line.pack] || line.packLabel}</td><td>${line.grindLabel}${line.grindHint ? html`<small>${line.grindHint}</small>` : ""}</td></tr>`)}</tbody></table>
      <p class="wp-order-total">${t.sum.quarter} × 250 g · ${t.sum.kilo} × 1 kg${t.half ? ` · ${t.sum.half} × 500 g` : ""} · <b>${bags(t.sum.bags)}</b> · ${kg(t.sum.grams)}</p>
      <footer class="wp-sign"><span>Packed by</span><span>Checked by</span><span>Date</span></footer></article>`;
  }

  function print(content) {
    document.getElementById("wPrintArea")?.remove();
    const area = document.createElement("section");
    area.id = "wPrintArea"; area.className = "wp-print"; area.setAttribute("aria-hidden", "true");
    document.body.append(area); put(area, content);
    const done = () => { area.remove(); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    window.print();
  }
  function summaryPage(orders, label, printedAt) {
    return html`<article class="wp-page wp-summary"><header class="wp-head"><div><p class="wp-kicker">Strangers Coffee · Wholesale</p><h2>Bags to process</h2><p class="wp-id">${label}</p></div><div class="wp-when"><span>Printed</span><b>${london(printedAt)}</b></div></header>${summaryBody(orders, label)}</article>`;
  }
  async function load(scope) {
    const query = scope.ids ? "ids=" + encodeURIComponent(scope.ids.join(",")) : "status=" + encodeURIComponent(scope.status);
    return api("GET", `${root}/orders/print?${query}`);
  }
  async function printOrders(scope) {
    const { orders, printedAt } = await load(scope);
    if (!orders.length) { toast(scope.ids ? "Those orders are no longer available." : `No ${scope.label.toLowerCase()} to print.`); return; }
    print(html`${summaryPage(orders, scope.label, printedAt)}${orders.map(sheet)}`);
  }

  // On screen: the bags to process for new orders, new and preparing, or the picked orders.
  async function openTotals(selected = []) {
    let current = selected.length ? "selected" : "New";
    const scopeFor = (key) => key === "selected" ? { ids: selected, label: `${selected.length} selected ${selected.length === 1 ? "order" : "orders"}` } : scopes[key];
    async function draw() {
      const scope = scopeFor(current);
      put(document.getElementById("wpBody"), html`<p class="wp-meta">Loading…</p>`);
      try {
        const { orders } = await load(scope);
        const body = document.getElementById("wpBody"); if (!body) return;
        put(body, summaryBody(orders, scope.label));
        document.getElementById("wpPrintTotals").disabled = !orders.length;
        document.getElementById("wpPrintSheets").disabled = !orders.length;
      } catch (error) { const body = document.getElementById("wpBody"); if (body) put(body, html`<p class="err">${error.message}</p>`); }
    }
    const choices = [["New", "New"], ["open", "New & preparing"], ...(selected.length ? [["selected", "Selected"]] : [])];
    openSheet(html`<div class="w-sheet wp-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Bags to process</h2><p class="hint">250 g and 1 kg bags, and all bags together. Customer orders only, unless you picked them.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="segwrap"><div class="seg" role="group" aria-label="Which orders">${choices.map(([key, label]) => html`<button type="button" data-sheet="scope" data-id="${key}" aria-pressed="${key === current}">${label}</button>`)}</div></div>
      <div id="wpBody" class="wp-body" aria-live="polite"></div>
      <div class="row w-actions"><button class="btn soft" type="button" id="wpPrintSheets" data-sheet="print-sheets" disabled>${svg("doc")}Print with packing sheets</button><button class="btn" type="button" id="wpPrintTotals" data-sheet="print-totals" disabled>${svg("doc")}Print totals</button></div></div>`,
    async (action, element) => {
      if (action === "close") { closeSheet(); return; }
      if (action === "scope") { current = element.dataset.id; document.querySelectorAll('[data-sheet="scope"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === current))); await draw(); return; }
      const scope = scopeFor(current);
      if (action === "print-totals") { const { orders, printedAt } = await load(scope); print(summaryPage(orders, scope.label, printedAt)); }
      if (action === "print-sheets") await printOrders(scope);
    });
    await draw();
  }
  return { printOrders, openTotals, scopes, totals };
};
