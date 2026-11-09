// Native Admin → Wholesale view. Uses the admin shell, escaped templates and shared D1 wholesale APIs.
window.WholesaleAdmin = function ({ api, html, raw, svg, put, head, openSheet, closeSheet, reload, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const shortId = (id) => id.slice(0, 20);
  const date = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", year: "numeric", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let tab = "orders", status = "all", approval = "all", query = "", data = null, timer, sequence = 0;
  let orderPages = 1, customerPages = 1, loadingMore = false;
  const quickBusy = new Set(), orderErrors = new Map();
  const nextStatus = (row) => row.preview === false ? ({ New: "Preparing", Preparing: "Ready", Ready: "Dispatched" }[row.status] || null) : null;
  const customer = (id) => data.customers.find((row) => row.id === id);
  const accountFor = (id) => data.accounts.find((row) => row.customerId === id);
  const pill = (value) => html`<span class="pill ${["New", "Pending review", "Out of stock"].includes(value) ? "warn" : ["Ready", "Active", "In stock"].includes(value) ? "ok" : ["Cancelled", "On hold", "Declined"].includes(value) ? "bad" : ""}">${value}</span>`;
  const field = (label, input) => html`<label class="field"><span class="fl">${label}</span>${input}</label>`;
  const buttons = (label) => html`<p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${label}</button></div>`;
  const note = html`<p class="hint">Manage payment and invoicing according to the customer’s agreed terms.</p>`;
  const matches = (value) => value.toLowerCase().includes(query.toLowerCase().trim());
  const termsFor = (row) => data.paymentTermChoices.find((term) => term.id === row.paymentTerms)?.label || "To be agreed";
  const search = (label, placeholder) => html`<label class="search">${svg("search")}<input id="wq" type="search" maxlength="120" aria-label="${label}" placeholder="${placeholder}" value="${query}"></label>`;
  const merge = (first, next) => [...new Map([...first, ...next].map((row) => [row.id, row])).values()];

  async function pages(snapshot, kind, requested, filter) {
    const params = new URLSearchParams();
    if (filter.query.trim()) params.set("q", filter.query.trim());
    if (kind === "orders" && filter.status !== "all") params.set("status", filter.status);
    if (kind === "customers" && filter.approval !== "all") params.set("approval", filter.approval);
    let rows = snapshot[kind], accounts = snapshot.accounts, cursor = snapshot[kind === "orders" ? "orderCursor" : "customerCursor"], count = snapshot.counts[kind === "orders" ? "order" : "customer"] || 0;
    if (params.size) {
      const first = await api("GET", "/api/admin/wholesale/" + kind + "?" + params);
      rows = first[kind]; cursor = first.nextCursor; count = first.count;
      if (first.accounts) accounts = merge(accounts, first.accounts);
    }
    for (let page = 1; page < requested && cursor; page++) {
      params.set("cursor", cursor);
      const next = await api("GET", "/api/admin/wholesale/" + kind + "?" + params);
      rows = merge(rows, next[kind]); cursor = next.nextCursor; count = next.count;
      if (next.accounts) accounts = merge(accounts, next.accounts);
    }
    return { rows, accounts, cursor, count };
  }
  async function saveForm(form, work) {
    if (!form?.isConnected || form.dataset.whBusy) return;
    form.dataset.whBusy = "1";
    form.setAttribute("aria-busy", "true");
    const controls = [...form.querySelectorAll("button")];
    controls.forEach((button) => { button.disabled = true; });
    const error = form.querySelector("#wErr");
    if (error) error.textContent = "";
    try { await work(); }
    catch (problem) {
      if (form.isConnected && error) { error.textContent = problem.message; error.scrollIntoView({ block: "nearest" }); }
      else toast(problem.message);
    } finally {
      delete form.dataset.whBusy; form.removeAttribute("aria-busy");
      controls.forEach((button) => { if (button.isConnected) button.disabled = false; });
    }
  }

  async function view() {
    const current = ++sequence, section = tab, filter = { query, status, approval };
    const snapshot = await api("GET", "/api/admin/wholesale");
    if (section === "orders" || section === "customers") {
      const result = await pages(snapshot, section, section === "orders" ? orderPages : customerPages, filter);
      snapshot[section] = result.rows; snapshot.accounts = result.accounts;
      snapshot.nextCursor = result.cursor; snapshot.matchingCount = result.count;
    }
    if (current !== sequence) return html``;
    data = snapshot;
    for (const row of data.orders) if (orderErrors.has(row.id) && orderErrors.get(row.id).version !== row.version) orderErrors.delete(row.id);
    const stats = data.stats || { openOrders: data.orders.filter((row) => row.preview === false && !["Dispatched", "Cancelled"].includes(row.status)).length, gramsToPrepare: data.orders.filter((row) => row.preview === false && ["New", "Preparing"].includes(row.status)).reduce((total, row) => total + row.grams, 0), totalCustomers: data.counts.customer || 0, visibleCoffees: data.products.filter((row) => row.active).length, totalCoffees: data.products.length, pendingAccounts: data.accounts.filter((row) => row.approvalStatus === "pending").length };
    return html`<div class="w-workspace">${head("Wholesale", "Orders, business accounts and coffee catalogue.", html`<div class="w-page-actions"><span class="pill acc">Beta</span></div>`)}
      <div class="label">Needs attention</div><div class="group glass">${stats.pendingAccounts ? html`<button class="item" type="button" data-act="wh-pending"><span class="ic warn">${svg("people")}</span><span class="tx"><b>${stats.pendingAccounts} ${stats.pendingAccounts === 1 ? "account awaits" : "accounts await"} review</b><span>Review the business and payment terms before approving access.</span></span><span class="end"><span class="chev">${svg("chev")}</span></span></button>` : html`<div class="item"><span class="ic ok">${svg("ok")}</span><span class="tx"><b>Account reviews are up to date</b><span>New registrations appear here for approval.</span></span></div>`}</div>
      <div class="label">Wholesale at a glance</div><div class="stats w-stats">${[["Open orders", stats.openOrders, "New, preparing and ready"], ["Coffee to prepare", weight(stats.gramsToPrepare), "Customer orders only"], ["Customers", stats.totalCustomers, "Business accounts"], ["Visible coffees", stats.visibleCoffees, `Of ${stats.totalCoffees} coffees`]].map(([label, value, sub]) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span><span class="s">${sub}</span></div>`)}</div>
      <div class="segwrap w-sections"><div class="seg" role="group" aria-label="Wholesale sections">${[["orders", "Orders"], ["customers", "Customers"], ["catalogue", "Coffee catalogue"]].map(([id, label]) => html`<button type="button" data-act="wh-tab" data-id="${id}" aria-pressed="${tab === id}">${label}</button>`)}</div></div>
      ${tab === "orders" ? orders() : tab === "customers" ? customers() : catalogue()}</div>`;
  }
  function more(kind) {
    return data.nextCursor ? html`<div class="w-more"><button class="btn soft" type="button" data-act="wh-more" data-id="${kind}">Load more ${kind}</button></div>` : "";
  }
  function orders() {
    const rows = data.orders;
    return html`<div class="toolbar">${search("Search wholesale orders", "Search order, reference or customer")}</div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Order status">${["all", ...data.statuses].map((value) => html`<button type="button" data-act="wh-status" data-id="${value}" aria-pressed="${status === value}">${value === "all" ? "All orders" : value}</button>`)}</div></div>
      <div class="label">Orders <span class="count">${rows.length} of ${data.matchingCount}</span></div>
      <div class="group glass">${rows.length ? rows.map(orderRow) : html`<div class="empty">${svg("coffee")}<span>${query || status !== "all" ? "No matching orders. Try another search or status." : "No orders yet. Customer orders will appear here when submitted."}</span></div>`}</div>
      ${more("orders")}<p class="hint">Coffee subtotals are saved with each order. Delivery and invoicing are managed separately.</p>`;
  }
  function orderRow(row) {
    const next = nextStatus(row), busy = quickBusy.has(row.id), problem = orderErrors.get(row.id);
    return html`<div class="w-order-entry" data-order-entry="${row.id}" aria-busy="${busy}"><button class="item w-order" type="button" data-act="wh-order" data-id="${row.id}" ${busy ? raw("disabled") : ""}><span class="ic ${row.preview === false ? "acc" : "mut"}">${svg("coffee")}</span><span class="tx"><b>${row.business || customer(row.customerId)?.business || row.createdName}</b><span>${shortId(row.id)}… · ${date(row.createdAt)}</span><span>${row.delivery} · ${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)}</span>${row.reference ? html`<span>Reference: ${row.reference}</span>` : ""}${row.preview === false ? "" : html`<span class="w-test-label">Staff preview · ${row.createdName}</span>`}</span><span class="end"><strong class="num">${money(row.pence)}</strong>${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>
      ${next || problem ? html`<div class="w-order-actions"><div class="w-order-feedback" data-order-error="${row.id}" role="alert" ${problem ? "" : raw("hidden")}>${problem ? html`<p>${problem.message}</p><button class="btn sm soft" type="button" data-act="wh-refresh-orders" data-id="${row.id}">Reload orders</button>` : ""}</div>${next ? html`<button class="btn sm soft" type="button" data-act="wh-next" data-id="${row.id}" aria-label="Mark ${row.business || "order"} ${next.toLowerCase()}" ${busy || problem ? raw("disabled") : ""}>${busy ? "Saving…" : "Mark " + next.toLowerCase()}</button>` : ""}</div>` : ""}</div>`;
  }
  function refreshOrderFeedback(id) {
    const entry = document.querySelector(`[data-order-entry="${id}"]`);
    if (!entry) return;
    const row = data.orders.find((order) => order.id === id);
    if (!row) return;
    const busy = quickBusy.has(id), problem = orderErrors.get(id), next = nextStatus(row);
    entry.setAttribute("aria-busy", String(busy));
    entry.querySelector('[data-act="wh-order"]').disabled = busy;
    const button = entry.querySelector('[data-act="wh-next"]');
    if (button) { button.disabled = busy || !!problem || !next; button.textContent = busy ? "Saving…" : next ? "Mark " + next.toLowerCase() : "Up to date"; }
    const feedback = entry.querySelector('[data-order-error]');
    if (feedback) {
      feedback.hidden = !problem;
      put(feedback, problem ? html`<p>${problem.message}</p><button class="btn sm soft" type="button" data-act="wh-refresh-orders" data-id="${id}">Reload orders</button>` : html``);
    }
  }
  async function advanceOrder(id) {
    if (quickBusy.has(id) || orderErrors.has(id)) return;
    const row = data.orders.find((order) => order.id === id), next = row && nextStatus(row);
    if (!next) return;
    const source = document.querySelector(`[data-act="wh-next"][data-id="${id}"]`), wasFocused = document.activeElement === source;
    let restoreFocus = false;
    quickBusy.add(id); refreshOrderFeedback(id);
    try {
      const result = await api("PATCH", `/api/admin/wholesale/orders/${id}`, { ifVersion: row.version, status: next, customerId: row.customerId, note: row.note || "" });
      if (result.order?.id !== id || result.order.status !== next || result.order.version !== row.version + 1) throw new Error("The status update could not be confirmed. Reload orders to check the latest status.");
      orderErrors.delete(id);
      restoreFocus = wasFocused && (document.activeElement === source || document.activeElement === document.body);
      await reload();
      toast(`${row.business || "Order"} marked ${next.toLowerCase()}.`);
    } catch (error) {
      orderErrors.set(id, { version: row.version, message: error.message + " Reload orders before updating this order again." });
      restoreFocus = wasFocused && (document.activeElement === source || document.activeElement === document.body);
    } finally {
      quickBusy.delete(id); refreshOrderFeedback(id);
      if (restoreFocus && $("#scrim").hidden) {
        const target = document.querySelector(`[data-act="wh-refresh-orders"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-next"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-order"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-status"][data-id="${status}"]`);
        target?.focus({ preventScroll: true });
      }
    }
  }
  function customers() {
    const rows = [...data.customers].sort((a,b) => Number(accountFor(b.id)?.approvalStatus === "pending") - Number(accountFor(a.id)?.approvalStatus === "pending"));
    return html`<div class="toolbar">${search("Search wholesale customers", "Search business, contact or email")}<button class="btn" type="button" data-act="wh-customer">${svg("plus")}Add customer</button></div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Customer access">${[["all", "All customers"], ["pending", "Awaiting review"]].map(([id, label]) => html`<button type="button" data-act="wh-approval" data-id="${id}" aria-pressed="${approval === id}">${label}</button>`)}</div></div>
      <div class="label">Customers <span class="count">${rows.length} of ${data.matchingCount}</span></div><div class="group glass">${rows.length ? rows.map((row) => html`<button class="item w-customer" type="button" data-act="wh-customer" data-id="${row.id}"><span class="ic ${accountFor(row.id)?.approvalStatus === "pending" ? "warn" : "ok"}">${svg("people")}</span><span class="tx"><b>${row.business}</b><span>${[row.contact, row.email].filter(Boolean).join(" · ") || "No contact details"}</span><span>${accountFor(row.id)?.approvalStatus === "pending" ? "Awaiting account approval" : accountFor(row.id) ? accountFor(row.id).active ? "Sign-in enabled" : "Sign-in disabled" : "No sign-in yet"} · ${termsFor(row)}</span></span><span class="end">${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : html`<div class="empty">${svg("people")}<span>${query || approval !== "all" ? "No matching customers." : "No customers yet. Add a business or review a new registration here."}</span></div>`}</div>${more("customers")}<p class="hint">Customers can access ordering after an admin approves their registration.</p>`;
  }
  function catalogue() {
    const rows = data.products.filter((row) => matches(`${row.title} ${row.name} ${row.origin} ${row.process} ${row.notes}`));
    return html`<div class="toolbar">${search("Search coffee catalogue", "Search coffee, origin or tasting notes")}<button class="btn" type="button" data-act="wh-coffee">${svg("plus")}Add coffee</button></div><div class="label">Coffee catalogue <span class="count">${rows.length} of ${data.products.length}</span></div><div class="group glass">${rows.length ? rows.map((row) => html`<div class="item w-coffee">${row.imageUrls.length ? html`<img src="${row.imageUrls[0]}" alt="" width="52" height="52" loading="lazy">` : html`<span class="ic mut">${svg("coffee")}</span>`}<span class="tx"><b>${row.title}</b><span>250 g ${money(row.prices.quarter)} · 500 g ${money(row.prices.half)} · 1 kg ${money(row.prices.kilo)}</span><span>${row.notes}</span></span><span class="end"><span class="w-coffee-state">${pill(row.active ? "Visible" : "Hidden")}${pill(row.inStock ? "In stock" : "Out of stock")}</span><button class="btn sm soft" type="button" data-act="wh-coffee" data-id="${row.id}" aria-label="Edit ${row.name}">Edit</button></span></div>`) : html`<div class="empty">${svg("coffee")}<span>${query ? "No matching coffees. Try another search." : "Add your first coffee to start the catalogue."}</span></div>`}</div><p class="hint">Edit coffees, bag prices, photos and availability. Existing orders retain their original details.</p>`;
  }
  function editOrder(id, draft = null, displayed = null) {
    const row = displayed || data.orders.find((row) => row.id === id);
    if (!row || quickBusy.has(id)) return;
    const snapshot = row.customerSnapshot, selectedCustomer = draft && Object.hasOwn(draft, "customerId") ? draft.customerId : row.customerId;
    openSheet(html`<form class="w-sheet w-order-sheet"><h2 id="sheetTitle" tabindex="-1">Order details</h2><div class="w-order-heading"><h3>${row.business || row.createdName}</h3>${pill(row.status)}${row.preview === false ? "" : html`<span class="pill">Staff preview</span>`}</div><p class="w-id">${row.id}</p>
      <div class="kvs"><div class="kv"><span>Received</span><span>${date(row.createdAt)}</span></div><div class="kv"><span>Reference</span><span>${row.reference || "None supplied"}</span></div><div class="kv"><span>Ordered by</span><span>${row.createdName}</span></div></div>
      <section class="w-order-section" aria-labelledby="wPackingTitle"><h3 id="wPackingTitle">Packing list</h3><div class="group w-packing-list">${row.lines.map((line) => html`<div class="item w-packing-line"><span class="w-pack-quantity"><b>${line.quantity}</b><span>${line.quantity === 1 ? "bag" : "bags"}</span></span><span class="tx"><b>${line.title}</b><span>${line.packLabel}</span><span>${line.grindLabel}</span></span><span class="end num">${money(line.price * line.quantity)}</span></div>`)}</div><div class="kv"><span>${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)} total</span><strong>${money(row.pence)}</strong></div></section>
      <section class="w-order-section" aria-labelledby="wDeliveryTitle"><h3 id="wDeliveryTitle">${row.delivery}</h3>${snapshot ? html`<p class="w-address">${[snapshot.contact, snapshot.email, snapshot.phone].filter(Boolean).join(" · ") || "No contact details recorded"}</p>${row.delivery === "Delivery" ? html`<div class="kvs"><div class="kv"><span>Delivery address at checkout</span><span class="w-address">${[snapshot.address, snapshot.postcode].filter(Boolean).join("\n") || "Not recorded"}</span></div><div class="kv"><span>Delivery instructions</span><span class="w-address">${row.deliveryNotes || "None supplied"}</span></div></div>` : ""}` : html`<p class="hint">Staff preview order.</p>`}</section>
      ${row.preview === false ? html`<section class="w-order-section" aria-labelledby="wTermsTitle"><h3 id="wTermsTitle">Payment terms at order</h3><p>${row.paymentTerms?.label || "Not recorded on this order"}</p>${row.paymentTerms?.note ? html`<p class="w-address">${row.paymentTerms.note}</p>` : ""}</section>` : ""}
      <section class="w-order-section w-order-management" aria-labelledby="wManageTitle"><h3 id="wManageTitle">Manage order</h3>${field("Order status", html`<select id="wStatus">${data.statuses.map((value) => html`<option ${value === (draft?.status ?? row.status) ? raw("selected") : ""}>${value}</option>`)}</select>`)}
      ${field("Customer", html`<select id="wCustomer" ${row.preview === false ? raw("disabled") : ""}><option value="">Not linked to a customer</option>${selectedCustomer && !customer(selectedCustomer) ? html`<option value="${selectedCustomer}" selected>${snapshot?.business || row.business}</option>` : ""}${data.customers.map((value) => html`<option value="${value.id}" ${value.id === selectedCustomer ? raw("selected") : ""}>${value.business}</option>`)}</select>`)}
      ${field("Internal note", html`<textarea id="wNote" maxlength="1000">${draft?.note ?? row.note}</textarea>`)}</section>${note}${buttons("Save order")}<div class="w-order-danger"><button class="btn bad" type="button" data-sheet="delete-order">Delete order</button></div></form>`, async (action, element) => {
      const form = element.closest("form");
      if (action === "delete-order") {
        confirmOrderDeletion(row, { status: form.querySelector("#wStatus").value, customerId: row.preview === false ? row.customerId : form.querySelector("#wCustomer").value || null, note: form.querySelector("#wNote").value });
        return;
      }
      if (action !== "submit") return;
      await saveForm(form, async () => {
        await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: $("#wStatus").value, customerId: row.preview === false ? row.customerId : $("#wCustomer").value || null, note: $("#wNote").value });
        if (form.isConnected) closeSheet(); await reload(); toast("Order saved.");
      });
    });
    $("#sheetTitle").focus({ preventScroll: true });
    $("#sheet").scrollTop = 0;
  }
  function confirmOrderDeletion(row, draft) {
    let cleanup = () => {};
    const back = () => { cleanup(); editOrder(row.id, draft, row); };
    openSheet(html`<form id="wDeleteOrderForm" class="w-sheet"><h2 id="sheetTitle" tabindex="-1">Delete order?</h2><p>${row.preview === false ? "This removes the order from Admin and the customer’s order history." : "This removes the staff preview order from Admin."}</p><div class="kvs w-delete-summary"><div class="kv"><span>Business</span><strong>${row.business || row.createdName}</strong></div><div class="kv"><span>Order</span><span class="w-id">${row.id}</span></div><div class="kv"><span>Coffee subtotal</span><strong>${money(row.pence)}</strong></div><div class="kv"><span>Status</span><span>${row.status}</span></div></div><p>The order cannot be restored from this page. An audit record is kept.</p><p>Payments are unchanged. No refund is issued.</p><p class="err" id="wErr" role="alert"></p><button class="btn soft" type="button" data-sheet="reload-delete" hidden>Reload latest order</button><div class="row w-actions"><button class="btn soft" type="button" data-sheet="cancel-delete">Cancel</button><fieldset id="wDeleteConfirmControls" class="w-delete-confirm-controls"><button class="btn solidbad" type="submit">Confirm delete order</button></fieldset></div></form>`, async (action, element) => {
      const form = element.closest("form");
      if (form.dataset.whBusy) return;
      if (action === "cancel-delete") { back(); return; }
      if (action === "reload-delete") {
        await saveForm(form, async () => {
          await reload();
          let latest = data.orders.find((order) => order.id === row.id);
          if (!latest) latest = (await api("GET", "/api/admin/wholesale/orders?q=" + encodeURIComponent(row.id))).orders.find((order) => order.id === row.id);
          cleanup();
          if (latest) editOrder(row.id, null, latest);
          else { closeSheet(); focusOrderList(row.id); toast("This order is no longer available."); }
        });
        return;
      }
      if (action !== "submit" || form.querySelector("#wDeleteConfirmControls").disabled) return;
      const position = data.orders.findIndex((order) => order.id === row.id), button = form.querySelector('button[type="submit"]');
      button.textContent = "Deleting…";
      await saveForm(form, async () => {
        const result = await api("DELETE", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version });
        if (result.deleted !== true || result.id !== row.id) throw new Error("The deletion could not be confirmed. Reload the latest order to check its status.");
        orderErrors.delete(row.id); cleanup(); closeSheet(); await reload(); focusOrderList(data.orders[Math.min(Math.max(position, 0), data.orders.length - 1)]?.id); toast("Order deleted from the order lists.");
      });
      if (form.isConnected) {
        button.textContent = "Confirm delete order";
        if (form.querySelector("#wErr").textContent) { form.querySelector("#wDeleteConfirmControls").disabled = true; form.querySelector('[data-sheet="reload-delete"]').hidden = false; }
      }
    });
    const form = $("#wDeleteOrderForm"), controller = new AbortController(), scrim = $("#scrim");
    const observer = new MutationObserver(() => { if (!form.isConnected) cleanup(); });
    cleanup = () => { controller.abort(); observer.disconnect(); };
    observer.observe($("#sheet"), { childList: true });
    // Cancel confirmation gestures return to the original editor without discarding its draft.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !form.isConnected) return;
      event.preventDefault(); event.stopImmediatePropagation(); if (!form.dataset.whBusy) back();
    }, { capture: true, signal: controller.signal });
    scrim.addEventListener("click", (event) => {
      if (event.target !== scrim || !form.isConnected) return;
      event.preventDefault(); event.stopImmediatePropagation(); if (!form.dataset.whBusy) back();
    }, { capture: true, signal: controller.signal });
    $("#sheetTitle").focus({ preventScroll: true }); $("#sheet").scrollTop = 0;
  }
  function focusOrderList(id) {
    const target = id && document.querySelector(`[data-act="wh-order"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-status"][data-id="${status}"]`) || document.querySelector('[data-act="wh-tab"][data-id="orders"]');
    target?.focus({ preventScroll: true });
  }
  function editCustomer(id) {
    const row = id ? customer(id) : { business: "", contact: "", email: "", status: "Active", note: "" };
    if (!row) return;
    openSheet(html`<form class="w-sheet"><h2 id="sheetTitle">${id ? "Edit customer" : "Add customer"}</h2>
      ${field("Business name", html`<input id="wBusiness" value="${row.business}" maxlength="120" required>`)}
      ${field("Contact name (optional)", html`<input id="wContact" value="${row.contact}" maxlength="120">`)}
      ${field("Contact email (optional)", html`<input id="wEmail" type="email" value="${row.email}" maxlength="150">`)}
      ${field("Phone (optional)", html`<input id="wPhone" type="tel" value="${row.phone || ""}" maxlength="40">`)}
      ${field("Delivery address", html`<textarea id="wAddress" maxlength="500">${row.address || ""}</textarea>`)}
      ${field("Postcode", html`<input id="wPostcode" value="${row.postcode || ""}" maxlength="20">`)}
      ${field("Delivery notes", html`<textarea id="wDeliveryNotes" maxlength="1000">${row.deliveryNotes || ""}</textarea>`)}
      ${field("Payment terms", html`<select id="wPaymentTerms">${data.paymentTermChoices.map((term) => html`<option value="${term.id}" ${(row.paymentTerms || "to-agree") === term.id ? raw("selected") : ""}>${term.label}</option>`)}</select>`)}
      ${field("Payment instructions (shown to the customer)", html`<textarea id="wPaymentNote" maxlength="500">${row.paymentNote || ""}</textarea>`)}
      ${id ? html`<div class="kv"><span>Wholesale sign-in</span><span>${accountFor(id)?.username || "Not created"}</span></div><button class="btn soft" type="button" data-sheet="account">${accountFor(id)?.approvalStatus === "pending" ? "Save and review sign-in" : accountFor(id) ? "Save and manage sign-in" : "Save and create sign-in"}</button>` : ""}
      ${field("Status", html`<select id="wStatus"><option ${row.status === "Active" ? raw("selected") : ""}>Active</option><option ${row.status === "On hold" ? raw("selected") : ""}>On hold</option></select>`)}
      ${field("Internal account note", html`<textarea id="wNote" maxlength="1000">${row.note}</textarea>`)}${note}${buttons("Save customer")}</form>`, async (action, element) => {
      if (!["submit", "account"].includes(action)) return;
      const form = element.closest("form");
      await saveForm(form, async () => {
        await api(id ? "PUT" : "POST", "/api/admin/wholesale/customers" + (id ? `/${id}` : ""), { ifVersion: row.version, business: $("#wBusiness").value, contact: $("#wContact").value, email: $("#wEmail").value, phone: $("#wPhone").value, address: $("#wAddress").value, postcode: $("#wPostcode").value, deliveryNotes: $("#wDeliveryNotes").value, paymentTerms: $("#wPaymentTerms").value, paymentNote: $("#wPaymentNote").value, status: $("#wStatus").value, note: $("#wNote").value });
        const stillOpen = form.isConnected;
        if (stillOpen) closeSheet(); await reload();
        if (action === "account" && stillOpen) editAccount(id); else toast("Customer saved.");
      });
    });
  }
  function showCredentials(row, result) {
    openSheet(html`<h2 id="sheetTitle">Wholesale sign-in</h2><p>Give these details to ${row.business}. They will choose their own password on first sign-in. The temporary password is shown only once.</p><div class="secret"><span>Username</span><b>${result.account.username}</b></div><div class="secret"><span>Temporary password</span><b id="wTemporaryPassword">${result.temporaryPassword}</b></div><div class="row"><button class="btn soft" type="button" data-sheet="copy">${svg("copy")}Copy both</button><button class="btn" type="button" data-sheet="close">Done</button></div>`, async (action) => {
      if (action !== "copy") return;
      try { await navigator.clipboard.writeText(`Username: ${result.account.username}\nTemporary password: ${result.temporaryPassword}`); toast("Sign-in details copied."); }
      catch { const selection = getSelection(), range = document.createRange(); range.selectNodeContents($("#wTemporaryPassword")); selection.removeAllRanges(); selection.addRange(range); toast("Select and copy the temporary password."); }
    });
  }
  function editAccount(customerId) {
    const row = customer(customerId), account = accountFor(customerId);
    if (!row) return;
    openSheet(html`<form class="w-sheet"><h2 id="sheetTitle">${account?.approvalStatus === "pending" ? "Review wholesale account" : account ? "Manage wholesale sign-in" : "Create wholesale sign-in"}</h2><p>${row.business}</p>
      ${field("Username", html`<input id="wUsername" value="${account?.username || ""}" minlength="3" maxlength="32" autocapitalize="none" required>`)}
      ${account ? html`${field("Account approval", html`<select id="wApproval"><option value="pending" ${account.approvalStatus === "pending" ? raw("selected") : ""}>Pending review</option><option value="approved" ${account.approvalStatus === "approved" ? raw("selected") : ""}>Approved</option><option value="rejected" ${account.approvalStatus === "rejected" ? raw("selected") : ""}>Declined</option></select>`)}<div class="checks"><label><input id="wAccountActive" type="checkbox" ${account.active || account.approvalStatus === "pending" ? raw("checked") : ""}>Allow sign-in when approved</label></div><p class="hint">Pending and declined accounts cannot access the catalogue or order. Disabling an account or changing its username signs it out on every device.</p><button class="btn soft" type="button" data-sheet="reset">Reset password and unlock</button>` : html`<p class="hint">A temporary password will be generated. This sign-in is approved immediately.</p>`}
      ${buttons(account ? "Save account" : "Create sign-in")}</form>`, async (action, element) => {
      if (!["submit", "reset"].includes(action)) return;
      const form = element.closest("form");
      await saveForm(form, async () => {
        const result = await api(action === "reset" || !account ? "POST" : "PUT", `/api/admin/wholesale/customers/${customerId}/account${action === "reset" ? "/reset-password" : ""}`, action === "reset" ? { ifVersion: account.version } : { username: $("#wUsername").value, ...(account ? { ifVersion: account.version, active: $("#wAccountActive").checked, approvalStatus: $("#wApproval").value } : {}) });
        if (form.isConnected) closeSheet(); await reload();
        if (result.temporaryPassword) showCredentials(row, result);
        else toast("Wholesale account saved.");
      });
    });
  }
  function editCoffee(id) {
    let current = id ? data.products.find((row) => row.id === id) : { id: null, title: "", name: "", origin: "", process: "", notes: "", badge: "", categories: ["single-origin"], prices: { quarter: 0, half: 0, kilo: 0 }, active: true, inStock: true, images: [], imageUrls: [], version: 0 };
    if (!current) return;
    let form, busy = false, pendingRemoval = null;
    const drawPhotos = () => {
      if (!form?.isConnected) return;
      const content = html`${current.imageUrls.length ? html`<div class="w-photos">${current.imageUrls.map((url, i) => html`<div class="w-photo"><img src="${url}" alt="${current.title} photo ${i + 1}"><button class="btn sm soft" type="button" data-sheet="photo-remove" data-ref="${current.images[i]}" aria-label="Remove photo ${i + 1}">Remove</button>${pendingRemoval === current.images[i] ? html`<div class="w-photo-confirm" role="group" aria-label="Remove this photo"><p>Remove this uploaded photo?</p><button class="btn sm bad" type="button" data-sheet="photo-confirm" data-ref="${current.images[i]}">Confirm remove photo</button><button class="btn sm soft" type="button" data-sheet="photo-keep">Keep photo</button></div>` : ""}</div>`)}</div>` : html`<p class="hint">No photos yet.</p>`}${current.sourceImage && !current.images.includes("source:" + current.image) ? html`<button class="btn sm soft" type="button" data-sheet="photo-restore">Restore original photo</button>` : ""}`;
      put(form.querySelector('#wPhotos'), content);
    };
    openSheet(html`<form id="wCoffeeForm" class="w-sheet"><h2 id="sheetTitle">${id ? "Edit coffee" : "Add coffee"}</h2>
      ${field("Product name", html`<input id="wCoffeeTitle" value="${current.title}" maxlength="180" required>`)}
      ${field("Short name (optional)", html`<input id="wCoffeeName" value="${current.name}" maxlength="120" placeholder="For catalogue cards">`)}
      ${field("Origin", html`<input id="wCoffeeOrigin" value="${current.origin}" maxlength="100">`)}
      ${field("Process", html`<input id="wCoffeeProcess" value="${current.process}" maxlength="120">`)}
      ${field("Tasting notes", html`<textarea id="wCoffeeNotes" maxlength="400">${current.notes}</textarea>`)}
      ${field("Photo label (optional)", html`<input id="wCoffeeBadge" value="${current.badge}" maxlength="60" placeholder="e.g. Natural">`)}
      <fieldset class="w-categories"><legend>Categories</legend>${[["single-origin","Single origin"],["blend","Blend"],["decaf","Decaf"]].map(([key,label]) => html`<label><input type="checkbox" name="coffeeCategory" value="${key}" ${current.categories.includes(key) ? raw("checked") : ""}>${label}</label>`)}</fieldset>
      ${[["quarter", "250 g bag (£)"], ["half", "500 g bag (£)"], ["kilo", "1 kg bag (£)"]].map(([key, label]) => field(label, html`<input id="wPrice-${key}" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required value="${id ? (current.prices[key] / 100).toFixed(2) : ""}">`))}
      <div class="checks"><label><input id="wActive" type="checkbox" ${current.active ? raw("checked") : ""}>Visible in catalogue</label><label><input id="wInStock" type="checkbox" ${current.inStock ? raw("checked") : ""}>In stock</label></div><p class="hint">Out-of-stock coffees remain visible but cannot be ordered. Hidden coffees are removed from the ordering list.</p>
      <h3>Photos</h3><div id="wPhotos"></div>${id ? html`<label class="field"><span class="fl">Add photos</span><input id="wPhotoFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="hint">Photos save immediately. Up to six per coffee. JPEG, PNG or WebP, up to 5 MB each.</p><button class="btn soft" type="button" data-sheet="photo-upload">Upload photos</button>` : html`<p class="hint">Save the coffee, then add its photos.</p>`}
      ${buttons(id ? "Save coffee" : "Add coffee")}</form>`, async (action, element) => {
      if (busy || !["submit", "photo-upload", "photo-remove", "photo-confirm", "photo-keep", "photo-restore"].includes(action)) return;
      if (action === "photo-keep") { pendingRemoval = null; drawPhotos(); return; }
      if (action === "photo-remove" && element.dataset.ref.startsWith("upload:")) { pendingRemoval = element.dataset.ref; drawPhotos(); return; }
      busy = true; form.setAttribute("aria-busy", "true");
      const buttons = [...form.querySelectorAll('button')]; buttons.forEach((button) => { button.disabled = true; });
      form.querySelector('#wErr').textContent = "";
      try {
        if (action === "photo-upload") {
          const files = [...form.querySelector('#wPhotoFiles').files];
          if (!files.length) throw new Error("Choose a photo first.");
          if (current.images.length + files.length > 6) throw new Error("Each coffee can have up to six photos.");
          for (const file of files) {
            if (file.size > 5 * 1024 * 1024) throw new Error("Photos can be up to 5 MB.");
            const response = await fetch(`/api/admin/wholesale/catalogue/${current.id}/images?ifVersion=${current.version}`, { method: "POST", headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) }, body: file });
            const result = await response.json();
            if (response.status === 401) SC.goSignIn();
            if (!response.ok) throw new Error(result.message || "Could not upload the photo.");
            current = result.product; drawPhotos();
          }
          if (form.isConnected) form.querySelector('#wPhotoFiles').value = "";
          drawPhotos(); await reload(); toast("Photos added.");
        } else if (action === "photo-remove" || action === "photo-confirm" || action === "photo-restore") {
          const result = await api("PATCH", `/api/admin/wholesale/catalogue/${current.id}/images`, { ifVersion: current.version, ...(action === "photo-restore" ? { restore: true } : { remove: element.dataset.ref }) });
          current = result.product; pendingRemoval = null; drawPhotos(); await reload(); toast(action === "photo-restore" ? "Original photo restored." : "Photo removed.");
        } else {
          const value = (selector) => form.querySelector(selector).value;
          const prices = Object.fromEntries(["quarter", "half", "kilo"].map((key) => [key, Math.round(Number(value("#wPrice-" + key)) * 100)]));
          const result = await api(id ? "PUT" : "POST", "/api/admin/wholesale/catalogue" + (id ? "/" + current.id : ""), { ifVersion: current.version, title: value('#wCoffeeTitle'), name: value('#wCoffeeName') || value('#wCoffeeTitle'), origin: value('#wCoffeeOrigin'), process: value('#wCoffeeProcess'), notes: value('#wCoffeeNotes'), badge: value('#wCoffeeBadge'), categories: [...form.querySelectorAll('[name="coffeeCategory"]:checked')].map(input => input.value), prices, active: form.querySelector('#wActive').checked, inStock: form.querySelector('#wInStock').checked });
          const stillOpen = form.isConnected;
          if (stillOpen) closeSheet();
          await reload(); toast(id ? "Coffee saved." : "Coffee added. You can now add photos.");
          if (!id && stillOpen) editCoffee(result.product.id);
        }
      } catch (error) { if (form.isConnected) { form.querySelector('#wErr').textContent = error.message; form.querySelector('#wErr').scrollIntoView({ block: "nearest" }); } else toast(error.message); }
      finally { busy = false; form.removeAttribute("aria-busy"); drawPhotos(); buttons.forEach((button) => { if (button.isConnected) button.disabled = false; }); }
    });
    form = $('#wCoffeeForm');
    drawPhotos();
  }
  return {
    view,
    async act(name, id) {
      if (name === "wh-tab" && ["orders", "customers", "catalogue"].includes(id)) { clearTimeout(timer); tab = id; query = ""; approval = "all"; orderPages = customerPages = 1; await reload(); }
      if (name === "wh-status" && ["all", ...data.statuses].includes(id)) { clearTimeout(timer); status = id; orderPages = 1; await reload(); }
      if (name === "wh-approval" && ["all", "pending"].includes(id)) { clearTimeout(timer); approval = id; customerPages = 1; await reload(); }
      if (name === "wh-pending") { clearTimeout(timer); tab = "customers"; approval = "pending"; query = ""; customerPages = 1; await reload(); }
      if (name === "wh-more" && id === tab && data.nextCursor && !loadingMore) { loadingMore = true; const button = $(".w-more button"); if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); } try { if (id === "orders") orderPages++; else if (id === "customers") customerPages++; await reload(); } finally { loadingMore = false; } }
      if (name === "wh-next") await advanceOrder(id);
      if (name === "wh-refresh-orders") { orderErrors.delete(id); await reload(); (document.querySelector(`[data-act="wh-next"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-order"][data-id="${id}"]`))?.focus({ preventScroll: true }); }
      if (name === "wh-order") editOrder(id);
      if (name === "wh-customer") editCustomer(id);
      if (name === "wh-coffee") editCoffee(id);
    },
    search(value) {
      query = value; orderPages = customerPages = 1; clearTimeout(timer);
      timer = setTimeout(async () => { await reload(); const input = $("#wq"); if (input) { input.focus(); input.setSelectionRange(query.length, query.length); } }, 250);
    },
  };
};
