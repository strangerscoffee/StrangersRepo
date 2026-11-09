// Native Admin → Wholesale view. Uses the admin shell, escaped templates and shared D1 preview APIs.
window.WholesaleAdmin = function ({ api, html, raw, svg, head, openSheet, closeSheet, reload, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const shortId = (id) => id.slice(0, 20);
  const date = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let tab = "orders", status = "all", query = "", data = null, timer;
  const customer = (id) => data.customers.find((row) => row.id === id);
  const pill = (value) => html`<span class="pill ${value === "New" ? "warn" : value === "Ready" || value === "Active" ? "ok" : value === "Cancelled" || value === "On hold" ? "bad" : ""}">${value}</span>`;
  const field = (label, input) => html`<label class="field"><span class="fl">${label}</span>${input}</label>`;
  const buttons = (label) => html`<p class="err" id="wErr" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${label}</button></div>`;
  const note = html`<p class="hint">Preview records are shared with signed-in staff and admins. Saving here does not send an email, take payment or arrange fulfilment.</p>`;

  async function view() {
    data = await api("GET", "/api/admin/wholesale");
    const open = data.orders.filter((row) => !["Dispatched", "Cancelled"].includes(row.status));
    const grams = data.orders.filter((row) => ["New", "Preparing"].includes(row.status)).reduce((total, row) => total + row.grams, 0);
    return html`${head("Wholesale", "Orders, customers and the signed-in coffee ordering preview.", html`<a class="btn" href="${data.links.preview}">Open ordering preview</a>`)}
      <div class="group glass"><div class="item"><span class="ic warn">${svg("coffee")}</span><span class="tx"><b>Wholesale ordering preview</b><span>Shared preview data. Default prices are Strangers’ published retail prices (${data.sourceDate}), with any preview overrides set below. No payments, emails or fulfilment actions are sent.</span></span></div></div>
      <div class="stats w-stats">${[["Open preview orders", open.length, "New, preparing and ready"], ["Coffee to prepare", weight(grams), "From the loaded preview orders"], ["Preview customers", data.counts.customer || 0, "Managed by admins"], ["Visible coffees", data.products.filter((row) => row.active).length, `Of ${data.products.length} sourced coffees`]].map(([label, value, sub]) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span><span class="s">${sub}</span></div>`)}</div>
      <div class="segwrap"><div class="seg" role="group" aria-label="Wholesale sections">${[["orders", "Orders"], ["customers", "Customers"], ["catalogue", "Coffee catalogue"]].map(([id, label]) => html`<button type="button" data-act="wh-tab" data-id="${id}" aria-pressed="${tab === id}">${label}</button>`)}</div></div>
      ${tab === "orders" ? orders() : tab === "customers" ? customers() : catalogue()}`;
  }
  function orders() {
    const rows = data.orders.filter((row) => (status === "all" || row.status === status) && `${row.id} ${row.business} ${row.createdName} ${customer(row.customerId)?.business || ""}`.toLowerCase().includes(query.toLowerCase().trim()));
    return html`<div class="toolbar"><label class="search">${svg("search")}<input id="wq" type="search" aria-label="Search wholesale preview orders" placeholder="Search order or customer" value="${query}"></label></div>
      <div class="segwrap"><div class="seg" role="group" aria-label="Preview order status">${["all", ...data.statuses].map((value) => html`<button type="button" data-act="wh-status" data-id="${value}" aria-pressed="${status === value}">${value === "all" ? "All orders" : value}</button>`)}</div></div>
      <div class="label">Preview orders <span class="count">${rows.length} shown</span></div>
      <div class="group glass">${rows.length ? rows.map((row) => html`<button class="item w-order" type="button" data-act="wh-order" data-id="${row.id}"><span class="ic acc">${svg("coffee")}</span><span class="tx"><b>${customer(row.customerId)?.business || row.business || row.createdName}</b><span>${shortId(row.id)}… · ${date(row.createdAt)}</span><span>${row.packs} bags · ${weight(row.grams)} · Saved by ${row.createdName}</span></span><span class="end"><strong class="num">${money(row.pence)}</strong>${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : html`<div class="empty">${svg("coffee")}<span>${query || status !== "all" ? "No matching preview orders." : "No preview orders yet. Open the ordering preview to save the first one."}</span></div>`}</div>
      <p class="hint">Showing the latest ${data.orders.length} of ${data.counts.order || 0} saved preview orders. Coffee subtotals exclude delivery and tax calculations.</p>`;
  }
  function customers() {
    return html`<div class="toolbar"><button class="btn" type="button" data-act="wh-customer">${svg("plus")}Add preview customer</button></div>
      <div class="group glass">${data.customers.length ? data.customers.map((row) => html`<button class="item" type="button" data-act="wh-customer" data-id="${row.id}"><span class="ic ok">${svg("people")}</span><span class="tx"><b>${row.business}</b><span>${[row.contact, row.email].filter(Boolean).join(" · ") || "No contact details"}</span></span><span class="end">${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : html`<div class="empty">${svg("people")}<span>No preview customers yet.</span></div>`}</div><p class="hint">Latest ${data.customers.length} of ${data.counts.customer || 0} preview customer records. No customer accounts or contact details are imported from strangerscoffee.com.</p>`;
  }
  function catalogue() {
    return html`<p class="hint">Coffee details and default retail prices come from strangerscoffee.com. Changes here affect the signed-in preview for everyone; existing orders keep their original prices.</p><div class="group glass">${data.products.map((row) => html`<div class="item w-coffee"><img src="/wholesale-preview/images/${row.image}" alt="" width="52" height="52"><span class="tx"><b>${row.title}</b><span>250 g ${money(row.prices.quarter)} · 500 g ${money(row.prices.half)} · 1 kg ${money(row.prices.kilo)}</span><span>${row.notes}</span></span><span class="end">${pill(row.active ? "Visible" : "Hidden")}<button class="btn sm soft" type="button" data-act="wh-coffee" data-id="${row.id}" aria-label="Edit ${row.name}">Edit</button></span></div>`)}</div>`;
  }
  function editOrder(id) {
    const row = data.orders.find((row) => row.id === id);
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">Preview order</h2><p class="w-id">${row.id}</p><div class="kvs"><div class="kv"><span>Saved by</span><span>${row.createdName} · ${date(row.createdAt)}</span></div><div class="kv"><span>Business</span><span>${row.business || "Not provided"}</span></div><div class="kv"><span>Reference</span><span>${row.reference || "None"}</span></div><div class="kv"><span>Delivery preference</span><span>${row.delivery}</span></div></div>
      <div class="group">${row.lines.map((line) => html`<div class="item"><span class="tx"><b>${line.title}</b><span>${line.quantity} × ${line.packLabel} · ${line.grindLabel}</span></span><span class="end num">${money(line.price * line.quantity)}</span></div>`)}</div><div class="kv"><span>Coffee subtotal · ${weight(row.grams)}</span><strong>${money(row.pence)}</strong></div>
      ${field("Preview order status", html`<select id="wStatus">${data.statuses.map((value) => html`<option ${value === row.status ? raw("selected") : ""}>${value}</option>`)}</select>`)}
      ${field("Preview customer", html`<select id="wCustomer"><option value="">Not linked to a customer</option>${data.customers.map((value) => html`<option value="${value.id}" ${value.id === row.customerId ? raw("selected") : ""}>${value.business}</option>`)}</select>`)}
      ${field("Internal preview note", html`<textarea id="wNote" maxlength="1000">${row.note}</textarea>`)}${note}${buttons("Save preview order")}</form>`, async (action) => {
      if (action !== "submit") return;
      try {
        await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: $("#wStatus").value, customerId: $("#wCustomer").value || null, note: $("#wNote").value });
        closeSheet(); await reload(); toast("Preview order saved.");
      } catch (error) { $("#wErr").textContent = error.message; }
    });
  }
  function editCustomer(id) {
    const row = id ? customer(id) : { business: "", contact: "", email: "", status: "Active", note: "" };
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">${id ? "Edit preview customer" : "Add preview customer"}</h2>
      ${field("Business name", html`<input id="wBusiness" value="${row.business}" maxlength="120" required>`)}
      ${field("Contact name (optional)", html`<input id="wContact" value="${row.contact}" maxlength="120">`)}
      ${field("Contact email (optional)", html`<input id="wEmail" type="email" value="${row.email}" maxlength="150">`)}
      ${field("Status", html`<select id="wStatus"><option ${row.status === "Active" ? raw("selected") : ""}>Active</option><option ${row.status === "On hold" ? raw("selected") : ""}>On hold</option></select>`)}
      ${field("Preview account note", html`<textarea id="wNote" maxlength="1000">${row.note}</textarea>`)}${note}${buttons("Save preview customer")}</form>`, async (action) => {
      if (action !== "submit") return;
      try {
        await api(id ? "PUT" : "POST", "/api/admin/wholesale/customers" + (id ? `/${id}` : ""), { ifVersion: row.version, business: $("#wBusiness").value, contact: $("#wContact").value, email: $("#wEmail").value, status: $("#wStatus").value, note: $("#wNote").value });
        closeSheet(); await reload(); toast("Preview customer saved.");
      } catch (error) { $("#wErr").textContent = error.message; }
    });
  }
  function editCoffee(id) {
    const row = data.products.find((row) => row.id === id);
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">${row.name}</h2><p>Preview prices only. Published retail rates are the default; wholesale rates have not been agreed.</p>
      ${[["quarter", "250 g bag (£)"], ["half", "500 g bag (£)"], ["kilo", "1 kg bag (£)"]].map(([key, label]) => field(label, html`<input id="wPrice-${key}" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required value="${(row.prices[key] / 100).toFixed(2)}">`))}
      <div class="checks"><label><input id="wActive" type="checkbox" ${row.active ? raw("checked") : ""}>Show in the ordering preview</label></div>${note}${buttons("Save preview coffee")}</form>`, async (action) => {
      if (action !== "submit") return;
      try {
        const prices = Object.fromEntries(["quarter", "half", "kilo"].map((key) => [key, Math.round(Number($("#wPrice-" + key).value) * 100)]));
        await api("PUT", `/api/admin/wholesale/catalogue/${row.id}`, { ifVersion: row.version, prices, active: $("#wActive").checked });
        closeSheet(); await reload(); toast("Preview coffee saved. Reload the ordering page to see the changes.");
      } catch (error) { $("#wErr").textContent = error.message; }
    });
  }
  return {
    view,
    async act(name, id) {
      if (name === "wh-tab" && ["orders", "customers", "catalogue"].includes(id)) { tab = id; await reload(); }
      if (name === "wh-status" && ["all", ...data.statuses].includes(id)) { status = id; await reload(); }
      if (name === "wh-order") editOrder(id);
      if (name === "wh-customer") editCustomer(id);
      if (name === "wh-coffee") editCoffee(id);
    },
    search(value) {
      query = value; clearTimeout(timer);
      timer = setTimeout(async () => { await reload(); const input = $("#wq"); if (input) { input.focus(); input.setSelectionRange(query.length, query.length); } }, 200);
    },
  };
};
