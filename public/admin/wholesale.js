// Native Admin → Wholesale view. Uses the admin shell, escaped templates and shared D1 preview APIs.
window.WholesaleAdmin = function ({ api, html, raw, svg, head, openSheet, closeSheet, reload, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const shortId = (id) => id.slice(0, 20);
  const date = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let tab = "orders", status = "all", query = "", data = null, timer;
  const customer = (id) => data.customers.find((row) => row.id === id);
  const accountFor = (id) => data.accounts.find((row) => row.customerId === id);
  const pill = (value) => html`<span class="pill ${value === "New" ? "warn" : value === "Ready" || value === "Active" ? "ok" : value === "Cancelled" || value === "On hold" ? "bad" : ""}">${value}</span>`;
  const field = (label, input) => html`<label class="field"><span class="fl">${label}</span>${input}</label>`;
  const buttons = (label) => html`<p class="err" id="wErr" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${label}</button></div>`;
  const note = html`<p class="hint">Orders are received here for your team to prepare. Payments and emails are not sent automatically.</p>`;

  async function view() {
    data = await api("GET", "/api/admin/wholesale");
    const open = data.orders.filter((row) => !["Dispatched", "Cancelled"].includes(row.status));
    const grams = data.orders.filter((row) => ["New", "Preparing"].includes(row.status)).reduce((total, row) => total + row.grams, 0);
    return html`${head("Wholesale", "Customer accounts, wholesale orders and coffee catalogue.", html`<a class="btn" href="${data.links.preview}">Open ordering preview</a>`)}
      <div class="group glass"><div class="item"><span class="ic warn">${svg("coffee")}</span><span class="tx"><b>Wholesale ordering</b><span>Review new registrations in Customers before approving access. Catalogue prices start from Strangers’ published prices (${data.sourceDate}) and can be edited below. Payments and emails are handled separately.</span></span></div></div>
      <div class="stats w-stats">${[["Open orders", open.length, "New, preparing and ready"], ["Coffee to prepare", weight(grams), "From the loaded orders"], ["Customers", data.counts.customer || 0, "Managed by admins"], ["Visible coffees", data.products.filter((row) => row.active).length, `Of ${data.products.length} sourced coffees`]].map(([label, value, sub]) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span><span class="s">${sub}</span></div>`)}</div>
      <div class="segwrap"><div class="seg" role="group" aria-label="Wholesale sections">${[["orders", "Orders"], ["customers", "Customers"], ["catalogue", "Coffee catalogue"]].map(([id, label]) => html`<button type="button" data-act="wh-tab" data-id="${id}" aria-pressed="${tab === id}">${label}</button>`)}</div></div>
      ${tab === "orders" ? orders() : tab === "customers" ? customers() : catalogue()}`;
  }
  function orders() {
    const rows = data.orders.filter((row) => (status === "all" || row.status === status) && `${row.id} ${row.business} ${row.createdName} ${customer(row.customerId)?.business || ""}`.toLowerCase().includes(query.toLowerCase().trim()));
    return html`<div class="toolbar"><label class="search">${svg("search")}<input id="wq" type="search" aria-label="Search wholesale preview orders" placeholder="Search order or customer" value="${query}"></label></div>
      <div class="segwrap"><div class="seg" role="group" aria-label="Order status">${["all", ...data.statuses].map((value) => html`<button type="button" data-act="wh-status" data-id="${value}" aria-pressed="${status === value}">${value === "all" ? "All orders" : value}</button>`)}</div></div>
      <div class="label">Orders <span class="count">${rows.length} shown</span></div>
      <div class="group glass">${rows.length ? rows.map((row) => html`<button class="item w-order" type="button" data-act="wh-order" data-id="${row.id}"><span class="ic acc">${svg("coffee")}</span><span class="tx"><b>${customer(row.customerId)?.business || row.business || row.createdName}</b><span>${shortId(row.id)}… · ${date(row.createdAt)}</span><span>${row.packs} bags · ${weight(row.grams)} · ${row.preview === false ? "Ordered" : "Staff preview"} by ${row.createdName}</span></span><span class="end"><strong class="num">${money(row.pence)}</strong>${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : html`<div class="empty">${svg("coffee")}<span>${query || status !== "all" ? "No matching orders." : "No orders yet."}</span></div>`}</div>
      <p class="hint">Showing the latest ${data.orders.length} of ${data.counts.order || 0} saved orders. Coffee subtotals exclude delivery and tax calculations.</p>`;
  }
  function customers() {
    const pending = data.accounts.filter((row) => row.approvalStatus === "pending").length;
    return html`<div class="toolbar"><button class="btn" type="button" data-act="wh-customer">${svg("plus")}Add customer</button></div>
      ${pending ? html`<p class="hint"><b>${pending} ${pending === 1 ? "registration needs" : "registrations need"} review.</b> Open the customer, then Review sign-in.</p>` : ""}
      <div class="group glass">${data.customers.length ? [...data.customers].sort((a,b) => Number(accountFor(b.id)?.approvalStatus === "pending") - Number(accountFor(a.id)?.approvalStatus === "pending")).map((row) => html`<button class="item" type="button" data-act="wh-customer" data-id="${row.id}"><span class="ic ok">${svg("people")}</span><span class="tx"><b>${row.business}</b><span>${[row.contact, row.email].filter(Boolean).join(" · ") || "No contact details"}</span><span>${accountFor(row.id)?.approvalStatus === "pending" ? "Awaiting account approval" : accountFor(row.id) ? accountFor(row.id).active ? "Sign-in enabled" : "Sign-in disabled" : "No sign-in yet"}</span></span><span class="end">${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : html`<div class="empty">${svg("people")}<span>No customers yet.</span></div>`}</div><p class="hint">Latest ${data.customers.length} of ${data.counts.customer || 0} customer records. New registrations need approval before customers can access ordering.</p>`;
  }
  function catalogue() {
    return html`<p class="hint">Coffee details and default retail prices come from strangerscoffee.com. Changes here affect the signed-in preview for everyone; existing orders keep their original prices.</p><div class="group glass">${data.products.map((row) => html`<div class="item w-coffee"><img src="/wholesale-preview/images/${row.image}" alt="" width="52" height="52"><span class="tx"><b>${row.title}</b><span>250 g ${money(row.prices.quarter)} · 500 g ${money(row.prices.half)} · 1 kg ${money(row.prices.kilo)}</span><span>${row.notes}</span></span><span class="end">${pill(row.active ? "Visible" : "Hidden")}<button class="btn sm soft" type="button" data-act="wh-coffee" data-id="${row.id}" aria-label="Edit ${row.name}">Edit</button></span></div>`)}</div>`;
  }
  function editOrder(id) {
    const row = data.orders.find((row) => row.id === id);
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">Order</h2><p class="w-id">${row.id}</p><div class="kvs"><div class="kv"><span>Saved by</span><span>${row.createdName} · ${date(row.createdAt)}</span></div><div class="kv"><span>Business</span><span>${row.business || "Not provided"}</span></div><div class="kv"><span>Reference</span><span>${row.reference || "None"}</span></div><div class="kv"><span>Delivery preference</span><span>${row.delivery}</span></div></div>
      <div class="group">${row.lines.map((line) => html`<div class="item"><span class="tx"><b>${line.title}</b><span>${line.quantity} × ${line.packLabel} · ${line.grindLabel}</span></span><span class="end num">${money(line.price * line.quantity)}</span></div>`)}</div><div class="kv"><span>Coffee subtotal · ${weight(row.grams)}</span><strong>${money(row.pence)}</strong></div>
      ${field("Order status", html`<select id="wStatus">${data.statuses.map((value) => html`<option ${value === row.status ? raw("selected") : ""}>${value}</option>`)}</select>`)}
      ${field("Customer", html`<select id="wCustomer" ${row.preview === false ? raw("disabled") : ""}><option value="">Not linked to a customer</option>${data.customers.map((value) => html`<option value="${value.id}" ${value.id === row.customerId ? raw("selected") : ""}>${value.business}</option>`)}</select>`)}
      ${row.customerSnapshot ? html`<div class="kvs"><div class="kv"><span>Contact</span><span>${row.customerSnapshot.contact} · ${row.customerSnapshot.email} · ${row.customerSnapshot.phone}</span></div><div class="kv"><span>Delivery address at checkout</span><span class="w-address">${row.customerSnapshot.address} ${row.customerSnapshot.postcode}</span></div><div class="kv"><span>Delivery notes</span><span>${row.deliveryNotes || "None"}</span></div></div>` : html`<p class="hint">Staff preview order.</p>`}
      ${field("Internal note", html`<textarea id="wNote" maxlength="1000">${row.note}</textarea>`)}${note}${buttons("Save order")}</form>`, async (action) => {
      if (action !== "submit") return;
      try {
        await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: $("#wStatus").value, customerId: row.preview === false ? row.customerId : $("#wCustomer").value || null, note: $("#wNote").value });
        closeSheet(); await reload(); toast("Order saved.");
      } catch (error) { $("#wErr").textContent = error.message; }
    });
  }
  function editCustomer(id) {
    const row = id ? customer(id) : { business: "", contact: "", email: "", status: "Active", note: "" };
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">${id ? "Edit customer" : "Add customer"}</h2>
      ${field("Business name", html`<input id="wBusiness" value="${row.business}" maxlength="120" required>`)}
      ${field("Contact name (optional)", html`<input id="wContact" value="${row.contact}" maxlength="120">`)}
      ${field("Contact email (optional)", html`<input id="wEmail" type="email" value="${row.email}" maxlength="150">`)}
      ${field("Phone (optional)", html`<input id="wPhone" type="tel" value="${row.phone || ""}" maxlength="40">`)}
      ${field("Delivery address", html`<textarea id="wAddress" maxlength="500">${row.address || ""}</textarea>`)}
      ${field("Postcode", html`<input id="wPostcode" value="${row.postcode || ""}" maxlength="20">`)}
      ${field("Delivery notes", html`<textarea id="wDeliveryNotes" maxlength="1000">${row.deliveryNotes || ""}</textarea>`)}
      ${id ? html`<div class="kv"><span>Wholesale sign-in</span><span>${accountFor(id)?.username || "Not created"}</span></div><button class="btn soft" type="button" data-sheet="account">${accountFor(id)?.approvalStatus === "pending" ? "Review sign-in" : accountFor(id) ? "Manage sign-in" : "Create sign-in"}</button>` : ""}
      ${field("Status", html`<select id="wStatus"><option ${row.status === "Active" ? raw("selected") : ""}>Active</option><option ${row.status === "On hold" ? raw("selected") : ""}>On hold</option></select>`)}
      ${field("Internal account note", html`<textarea id="wNote" maxlength="1000">${row.note}</textarea>`)}${note}${buttons("Save customer")}</form>`, async (action) => {
      if (action === "account") { editAccount(id); return; }
      if (action !== "submit") return;
      try {
        await api(id ? "PUT" : "POST", "/api/admin/wholesale/customers" + (id ? `/${id}` : ""), { ifVersion: row.version, business: $("#wBusiness").value, contact: $("#wContact").value, email: $("#wEmail").value, phone: $("#wPhone").value, address: $("#wAddress").value, postcode: $("#wPostcode").value, deliveryNotes: $("#wDeliveryNotes").value, status: $("#wStatus").value, note: $("#wNote").value });
        closeSheet(); await reload(); toast("Customer saved.");
      } catch (error) { $("#wErr").textContent = error.message; }
    });
  }
  function showCredentials(row, result) {
    openSheet(html`<h2 id="sheetTitle">Wholesale sign-in</h2><p>Give these details to ${row.business}. They will choose their own password on first sign-in.</p><div class="kvs"><div class="kv"><span>Username</span><strong>${result.account.username}</strong></div><div class="kv"><span>Temporary password</span><code>${result.temporaryPassword}</code></div></div><a class="btn soft" href="${data.links.preview}">Open wholesale sign-in</a><button class="btn" type="button" data-sheet="close">Done</button>`);
  }
  function editAccount(customerId) {
    const row = customer(customerId), account = accountFor(customerId);
    if (!row) return;
    openSheet(html`<form><h2 id="sheetTitle">${account?.approvalStatus === "pending" ? "Review wholesale account" : account ? "Manage wholesale sign-in" : "Create wholesale sign-in"}</h2><p>${row.business}</p>
      ${field("Username", html`<input id="wUsername" value="${account?.username || ""}" minlength="3" maxlength="32" autocapitalize="none" required>`)}
      ${account ? html`${field("Account approval", html`<select id="wApproval"><option value="pending" ${account.approvalStatus === "pending" ? raw("selected") : ""}>Pending review</option><option value="approved" ${account.approvalStatus === "approved" ? raw("selected") : ""}>Approved</option><option value="rejected" ${account.approvalStatus === "rejected" ? raw("selected") : ""}>Declined</option></select>`)}<div class="checks"><label><input id="wAccountActive" type="checkbox" ${account.active || account.approvalStatus === "pending" ? raw("checked") : ""}>Allow sign-in when approved</label></div><p class="hint">Pending and declined accounts cannot access the catalogue or order. Disabling an account or changing its username signs it out on every device.</p><button class="btn soft" type="button" data-sheet="reset">Reset password and unlock</button>` : html`<p class="hint">A temporary password will be generated. This sign-in is approved immediately.</p>`}
      ${buttons(account ? "Save account" : "Create sign-in")}</form>`, async (action) => {
      if (!["submit", "reset"].includes(action)) return;
      try {
        const result = await api(action === "reset" || !account ? "POST" : "PUT", `/api/admin/wholesale/customers/${customerId}/account${action === "reset" ? "/reset-password" : ""}`, action === "reset" ? { ifVersion: account.version } : { username: $("#wUsername").value, ...(account ? { ifVersion: account.version, active: $("#wAccountActive").checked, approvalStatus: $("#wApproval").value } : {}) });
        closeSheet(); await reload();
        if (result.temporaryPassword) showCredentials(row, result);
        else toast("Wholesale account saved.");
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
