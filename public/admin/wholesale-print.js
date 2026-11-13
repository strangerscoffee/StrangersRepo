// Admin → Wholesale → Orders: print orders (all new ones, or the ones picked) as packing sheets, and the bags to
// process for New, New & preparing or the picked orders. The pages, tables and totals are shared with the staff
// orders page (/shared/wholesale-packing.js). Printing uses the browser's own dialog, so it can be saved as a PDF.
window.WholesalePrint = function ({ api, html, svg, put, openSheet, closeSheet, toast }) {
  const packing = window.SCWholesalePacking;
  const root = "/api/admin/wholesale";
  const scopes = { New: { status: "New", label: "New orders" }, open: { status: "New,Preparing", label: "New and preparing orders" } };

  async function load(scope) {
    const query = scope.ids ? "ids=" + encodeURIComponent(scope.ids.join(",")) : "status=" + encodeURIComponent(scope.status);
    return api("GET", `${root}/orders/print?${query}`);
  }
  async function printOrders(scope, options) {
    const { orders, printedAt } = await load(scope);
    if (!orders.length) { toast(scope.ids ? "Those orders are no longer available." : `No ${scope.label.toLowerCase()} to print.`); return; }
    packing.printOrders(orders, scope.label, printedAt, options);
  }

  // On screen: the bags to process for new orders, new and preparing, or the picked orders.
  async function openTotals(selected = []) {
    let current = selected.length ? "selected" : "New";
    const scopeFor = (key) => key === "selected" ? { ids: selected, label: `${selected.length} selected ${selected.length === 1 ? "order" : "orders"}` } : scopes[key];
    async function draw() {
      const scope = scopeFor(current), body = document.getElementById("wpBody");
      if (!body) return;
      body.replaceChildren(SC.skeleton({ label: "Loading bag totals…", rows: 2 }));
      try {
        const { orders } = await load(scope);
        if (!document.getElementById("wpBody")) return;
        body.replaceChildren(packing.summaryBody(orders, scope.label));
        document.getElementById("wpPrintTotals").disabled = !orders.length;
        document.getElementById("wpPrintSheets").disabled = !orders.length;
      } catch (error) { body.replaceChildren(Object.assign(document.createElement("p"), { className: "err", textContent: error.message })); }
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
      if (action === "print-totals") await printOrders(scope, { onlyTotals: true });
      if (action === "print-sheets") await printOrders(scope);
    });
    await draw();
  }
  return { printOrders, openTotals, scopes };
};
