// Native Admin → Wholesale view. Uses the admin shell, escaped templates and shared D1 wholesale APIs.
window.WholesaleAdmin = function ({ api, html, raw, svg, put, head, openSheet, closeSheet, reload, toast, onNavigationChange = () => {} }) {
  const $ = (selector) => document.querySelector(selector);
  const invoiceUI = window.WholesaleInvoices({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast });
  const printUI = window.WholesalePrint({ api, html, raw, svg, put, openSheet, closeSheet, toast });
  const insightsUI = window.WholesaleInsights({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast });
  // Picking orders to print: while on, tapping an order ticks it instead of opening it.
  let picking = false; const picked = new Set();
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const shortId = (id) => id.slice(0, 20);
  const date = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", year: "numeric", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let tab = "orders", status = "all", approval = "all", query = "", data = null, timer, sequence = 0;
  let orderPages = 1, customerPages = 1, loadingMore = false;
  const sections = [["orders", "Orders"], ["customers", "Customers"], ["catalogue", "Coffee catalogue"], ["invoices", "Invoicing"], ["insights", "Insights"]];
  const pendingReviews = () => data?.stats?.pendingAccounts ?? data?.accounts?.filter((row) => row.approvalStatus === "pending").length ?? 0;
  function navigation({ sidebar = false, active = true } = {}) {
    const pending = pendingReviews();
    return html`${sections.map(([id, label]) => html`<span class="${sidebar ? "nav-wholesale-item" : "w-section-item"}"><button class="${sidebar ? "nav nav-wholesale-child" : ""}" type="button" data-act="wh-tab" data-id="${id}" aria-pressed="${active && tab === id ? "true" : "false"}" ${sidebar ? html`aria-current="${active && tab === id ? "page" : "false"}"` : ""}>${label}</button>${id === "customers" && pending > 0 ? html`<button class="w-review-chip ${sidebar ? "nav-wholesale-review" : ""}" type="button" data-act="wh-pending" aria-label="${pending} ${pending === 1 ? "account awaits" : "accounts await"} review"><span>${pending}</span><span class="w-review-word"> ${pending === 1 ? "review" : "reviews"}</span></button>` : ""}</span>`)}`;
  }
  function syncNavigation(desktop) {
    const host = $("#wSectionsHost");
    if (!host) return;
    const key = JSON.stringify([desktop, tab, pendingReviews()]);
    if (host.dataset.navigation === key) return;
    host.dataset.navigation = key; host.hidden = desktop;
    put(host, desktop ? html`` : html`<div class="segwrap w-sections"><div class="seg" role="group" aria-label="Wholesale sections">${navigation()}</div></div>`);
    // Keep the open section in view when the sections scroll sideways (Invoicing, Insights on a phone).
    if (!desktop) requestAnimationFrame(() => { const wrap = host.querySelector(".w-sections"), on = wrap?.querySelector('[aria-pressed="true"]'); if (wrap && on) { const r = on.getBoundingClientRect(), w = wrap.getBoundingClientRect(); if (r.left < w.left || r.right > w.right) wrap.scrollLeft += r.left - w.left - 12; } });
  }
  function selectSection(id, { pending = false } = {}) {
    if (!sections.some(([value]) => value === id)) return false;
    clearTimeout(timer); tab = id; query = ""; approval = pending && id === "customers" ? "pending" : "all"; orderPages = customerPages = 1;
    onNavigationChange(); return true;
  }
  const quickBusy = new Set(), orderErrors = new Map();
  const nextStatus = (row) => row.preview === false ? ({ New: "Preparing", Preparing: "Ready", Ready: "Dispatched" }[row.status] || null) : null;
  const customer = (id) => data.customers.find((row) => row.id === id);
  const accountFor = (id) => data.accounts.find((row) => row.customerId === id);
  const pill = (value) => html`<span class="pill ${["New", "Pending review", "Out of stock"].includes(value) ? "warn" : ["Ready", "Active", "In stock"].includes(value) ? "ok" : ["Cancelled", "On hold", "Declined"].includes(value) ? "bad" : ""}">${value}</span>`;
  // Dispatch day and standing order (src/wholesaleStanding.ts).
  const EVERY = [[1, "Every week"], [2, "Every 2 weeks"], [4, "Every 4 weeks"]];
  const today = () => window.SC?.londonToday?.() || new Date().toISOString().slice(0, 10);
  const day = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const everyText = (n) => n === 1 ? "every week" : `every ${n} weeks`;
  const scheduleOf = (form) => form.querySelector("#wDispatchDate") ? { dispatchDate: form.querySelector("#wDispatchDate").value || null, every: form.querySelector("#wStanding").checked ? Number(form.querySelector("#wEvery").value) : 0 } : undefined;
  const draftOf = (form, row) => ({ status: form.querySelector("#wStatus").value, customerId: row.preview === false ? row.customerId : form.querySelector("#wCustomer").value || null, note: form.querySelector("#wNote").value, trackingUrl: form.querySelector("#wTrackingUrl").value, schedule: scheduleOf(form) });
  const field = (label, input) => html`<label class="field"><span class="fl">${label}</span>${input}</label>`;
  const buttons = (label) => html`<p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${label}</button></div>`;
  const note = html`<p class="hint">Manage payment and invoicing according to the customer’s agreed terms.</p>`;
  const {grindFor,decafLine,coffeeColour,coffeeFill,coffeeStyle} = window.SCWholesalePreparation;
  const matches = (value) => value.toLowerCase().includes(query.toLowerCase().trim());
  const minimumKg = () => `${(data?.minimumOrderGrams || 6000) / 1000} kg`;
  const termsFor = (row) => data.paymentTermChoices.find((term) => term.id === row.paymentTerms)?.label || "To be agreed";
  const search = (label, placeholder) => html`<label class="search">${svg("search")}<input id="wq" type="search" maxlength="120" aria-label="${label}" placeholder="${placeholder}" value="${query}"></label>`;
  const resultCount = (loaded, total, noun) => `${loaded < total ? loaded + " of " + total : total} ${total === 1 ? noun : noun + "s"}`;
  const emptyState = (icon, title, text, filtered = false) => html`<div class="w-empty"><span class="ic mut">${svg(icon)}</span><h3>${title}</h3><p>${text}</p>${filtered ? html`<button class="btn soft" type="button" data-act="wh-clear">Clear filters</button>` : ""}</div>`;
  const listing = (id, title, count, tools, contents, footer) => html`<section class="w-list-panel glass" aria-labelledby="${id}"><header class="w-list-header"><h2 id="${id}">${title}</h2><span class="w-result-count">${count}</span></header><div class="w-panel-tools">${tools}</div><div class="group w-record-list">${contents}</div>${footer}</section>`;
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
    if (section === "customers") snapshot.invites = (await api("GET", "/api/admin/wholesale/customers/invites")).invites;
    if (current !== sequence) return html``;
    data = snapshot;
    const stats = data.stats || { openOrders: data.orders.filter((row) => row.preview === false && !["Dispatched", "Cancelled"].includes(row.status)).length, gramsToPrepare: data.orders.filter((row) => row.preview === false && ["New", "Preparing"].includes(row.status)).reduce((total, row) => total + row.grams, 0), totalCustomers: data.counts.customer || 0, visibleCoffees: data.products.filter((row) => row.active).length, totalCoffees: data.products.length, pendingAccounts: data.accounts.filter((row) => row.approvalStatus === "pending").length };
    const metrics = [["Open orders", stats.openOrders, "New, preparing and ready"], ["Coffee to prepare", weight(stats.gramsToPrepare), "Customer orders only"]];
    if (section !== "orders") metrics.push(["Customers", stats.totalCustomers, "Business accounts"], ["Visible coffees", stats.visibleCoffees, `Of ${stats.totalCoffees} coffees`]);
    onNavigationChange();
    return html`<div class="w-workspace">${head("Wholesale")}
      ${section === "orders" || section === "insights" ? "" : html`<div class="label w-overview-label">Wholesale at a glance</div>`}<div class="stats w-stats ${section === "orders" ? "w-stats-orders" : ""}" ${section === "insights" ? raw("hidden") : ""} role="group" aria-label="${section === "orders" ? "Order preparation overview" : "Wholesale overview"}">${metrics.map(([label, value, sub]) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span><span class="s">${sub}</span></div>`)}</div>
      <div id="wSectionsHost" class="w-sections-host" hidden></div>
      <div class="w-content">${tab === "orders" ? orders() : tab === "customers" ? customers() : tab === "invoices" ? await invoiceUI.view() : tab === "insights" ? await insightsUI.view() : catalogue()}</div></div>`;
  }
  function more(kind) {
    return data.nextCursor ? html`<div class="w-more"><button class="btn soft" type="button" data-act="wh-more" data-id="${kind}">Load more ${kind}</button></div>` : "";
  }
  function orders() {
    const rows = data.orders, filtered = !!query.trim() || status !== "all";
    const tools = html`<div class="w-order-toolbar"><div class="toolbar">${search("Search wholesale orders", "Search order, reference or customer")}</div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Order status">${["all", ...data.statuses].map((value) => html`<button type="button" data-act="wh-status" data-id="${value}" aria-pressed="${status === value}">${value === "all" ? "All orders" : value}</button>`)}</div></div>
      ${picking ? html`<div class="w-print-bar w-picking" role="region" aria-label="Choose orders to print"><span class="w-picked-count" aria-live="polite">${picked.size ? `${picked.size} selected` : "Tap orders to select them"}</span><button class="btn sm soft" type="button" data-act="wh-pick-all">Select all shown</button><button class="btn sm soft" type="button" data-act="wh-totals" ${picked.size ? "" : raw("disabled")}>Bag totals</button><button class="btn sm" type="button" data-act="wh-print-picked" ${picked.size ? "" : raw("disabled")}>${svg("doc")}Print selected</button><button class="btn sm soft" type="button" data-act="wh-pick-done">Done</button></div>`
        : html`<div class="w-print-bar"><button class="btn sm" type="button" data-act="wh-print-new">${svg("doc")}Print new orders</button><button class="btn sm soft" type="button" data-act="wh-pick-start">Select to print</button><button class="btn sm soft" type="button" data-act="wh-totals">Bags to process</button><button class="btn sm soft" type="button" data-act="wh-order-emails">Order alerts</button></div>`}</div>`;
    return listing("wOrdersTitle", "Orders", resultCount(rows.length, data.matchingCount, "order"), tools,
      rows.length ? rows.map(orderRow) : emptyState(filtered ? "search" : "coffee", filtered ? "No matching orders" : "No orders yet", filtered ? "Try another search or status, or clear your filters to see all orders." : "Customer orders will appear here when they’re placed.", filtered),
      html`${more("orders")}<p class="hint">Coffee subtotals are saved with each order. Delivery and invoicing are managed separately.</p>`);
  }
  function orderRow(row) {
    const next = nextStatus(row), busy = quickBusy.has(row.id), problem = orderErrors.get(row.id);
    const chosen = picked.has(row.id);
    return html`<div class="w-order-entry ${picking ? "is-picking" : ""}" data-order-entry="${row.id}" aria-busy="${busy}"><button class="item w-order" type="button" data-act="${picking ? "wh-pick" : "wh-order"}" data-id="${row.id}" ${picking ? html`aria-pressed="${chosen}"` : ""} ${busy ? raw("disabled") : ""}><span class="ic ${picking ? chosen ? "ok w-pick-on" : "mut w-pick-off" : row.preview === false ? "acc" : "mut"}">${picking ? chosen ? svg("ok") : html`<span class="w-pick-ring" aria-hidden="true"></span>` : svg("coffee")}</span><span class="tx"><b>${row.business || customer(row.customerId)?.business || row.createdName}</b><span>${shortId(row.id)}… · ${date(row.createdAt)}</span><span>${row.locationSnapshot?.name ? row.locationSnapshot.name + " · " : ""}${row.delivery} · ${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)}</span>${row.dispatchDate || row.standing ? html`<span class="w-dispatch">${row.dispatchDate ? `Dispatch ${day(row.dispatchDate)}` : ""}${row.dispatchDate && row.standing ? " · " : ""}${row.standing ? `Standing order, ${everyText(row.standing.every)}` : ""}</span>` : ""}${row.reference ? html`<span>Reference: ${row.reference}</span>` : ""}${row.customerNote ? html`<span class="w-has-note">Customer comments</span>` : ""}${row.tab && !row.tabClearedId ? html`<span class="w-has-note">On tab</span>` : ""}${row.preview === false ? "" : html`<span class="w-test-label">Staff preview · ${row.createdName}</span>`}</span><span class="end"><strong class="num">${money(Number.isSafeInteger(row.totalPence) ? row.totalPence : row.pence)}</strong>${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>
      ${!picking && (next || problem) ? html`<div class="w-order-actions"><div class="w-order-feedback" data-order-error="${row.id}" role="alert" ${problem ? "" : raw("hidden")}>${problem ? html`<p>${problem.message}</p><button class="btn sm soft" type="button" data-act="wh-refresh-orders" data-id="${row.id}">Reload orders</button>` : ""}</div>${next ? html`<button class="btn sm soft" type="button" data-act="wh-next" data-id="${row.id}" aria-label="Mark ${row.business || "order"} ${next.toLowerCase()}" ${busy || problem ? raw("disabled") : ""}>${busy ? "Saving…" : "Mark " + next.toLowerCase()}</button>` : ""}</div>` : ""}</div>`;
  }
  // Who gets an email for each new customer order (sent from orders@staffstrangerscoffee.com).
  async function openOrderEmails() {
    let settings = await api("GET", "/api/admin/wholesale/order-emails");
    const view = () => html`<div class="w-sheet wp-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">New-order alerts</h2><p class="hint">An email for every new customer order, from ${settings.from}. Replies go to the customer.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${settings.sending ? "" : html`<p class="err">Email isn’t set up on this site yet, so nothing will be sent.</p>`}
      <form id="wOrderEmailsForm" class="w-order-emails" novalidate><div class="checks"><label><input id="wOrderEmailsOn" type="checkbox" ${settings.enabled ? raw("checked") : ""}>Email new orders</label></div>
      <label class="field"><span class="fl">Send to</span><textarea id="wOrderEmailsTo" rows="3" autocapitalize="none" spellcheck="false" aria-describedby="wOrderEmailsHint">${settings.to.join("\n")}</textarea></label><p class="hint" id="wOrderEmailsHint">One address per line, up to 5.</p>
      <h3>Customers</h3><div class="checks"><label><input id="wConfirmCustomers" type="checkbox" ${settings.confirmCustomers !== false ? raw("checked") : ""}>Email customers about their orders</label></div>
      <p class="hint">Two emails to the business’s email address. When they place an order: a confirmation with their bags, delivery or collection, totals (not for businesses with hidden prices) and payment terms. When it’s marked dispatched: that it’s been shipped (with the tracking link, if added) or collected from the Roastery. Replies come to the first address above.</p>
      <p class="err" id="wOrderEmailsErr" role="alert" hidden></p></form>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="test" ${settings.sending ? "" : raw("disabled")}>Send a test email</button><button class="btn" type="button" data-sheet="save">Save</button></div>
      <h3>Slack</h3><p class="hint" id="wSlackState">${settings.slack ? "Each new order is posted to the orders channel: straight away from 07:45 to 16:45 (Sunday 10:00 to 15:30), otherwise at 07:50 (Sunday 10:00)." : "Not set up: add the SLACK_ORDERS_WEBHOOK_URL secret in Cloudflare (README-deploy.md)."}</p>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="slack-test" ${settings.slack ? "" : raw("disabled")}>Send a test to Slack</button></div></div>`;
    const fail = (error) => { const box = $("#wOrderEmailsErr"); if (box) { box.textContent = error.message; box.hidden = false; } };
    openSheet(view(), async (action) => {
      if (action === "close") { closeSheet(); return; }
      $("#wOrderEmailsErr").hidden = true;
      if (action === "save") {
        const to = $("#wOrderEmailsTo").value.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
        try { settings = await api("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: $("#wOrderEmailsOn").checked, to, confirmCustomers: $("#wConfirmCustomers").checked }); closeSheet(); toast(settings.enabled ? "Order emails saved" : "Order emails switched off"); }
        catch (error) { if (error.code === "conflict") { settings = await api("GET", "/api/admin/wholesale/order-emails"); } fail(error); }
      }
      if (action === "slack-test") {
        try { await api("POST", "/api/admin/wholesale/order-emails/slack-test", {}); toast("Test posted to Slack"); }
        catch (error) { fail(error); }
      }
      if (action === "test") {
        try { const result = await api("POST", "/api/admin/wholesale/order-emails/test", {}); toast(`Test email sent to ${result.sent.join(", ")}`); }
        catch (error) { fail(error); }
      }
    });
  }
  function refreshPicks() {
    document.querySelectorAll('[data-act="wh-pick"]').forEach((button) => {
      const chosen = picked.has(button.dataset.id), icon = button.querySelector(".ic");
      button.setAttribute("aria-pressed", String(chosen));
      icon.className = `ic ${chosen ? "ok w-pick-on" : "mut w-pick-off"}`;
      put(icon, chosen ? svg("ok") : html`<span class="w-pick-ring" aria-hidden="true"></span>`);
    });
    const count = $(".w-picked-count"); if (count) count.textContent = picked.size ? `${picked.size} selected` : "Tap orders to select them";
    for (const act of ["wh-totals", "wh-print-picked"]) { const button = $(`.w-picking [data-act="${act}"]`); if (button) button.disabled = !picked.size; }
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
    if (next === "Dispatched") { dispatchOrder(row); return; }
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
  function validTrackingUrl(value) {
    if (!value) return true;
    if (value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) return false;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
    catch { return false; }
  }
  function dispatchOrder(row, restoredTracking) {
    let cleanup = () => {};
    const back = () => {
      cleanup(); closeSheet();
      const target = document.querySelector(`[data-act="wh-refresh-orders"][data-id="${row.id}"]`) || document.querySelector(`[data-act="wh-next"][data-id="${row.id}"]:not(:disabled)`) || document.querySelector(`[data-act="wh-order"][data-id="${row.id}"]`);
      if (target) target.focus({ preventScroll: true }); else focusOrderList(row.id);
    };
    openSheet(html`<form id="wDispatchOrderForm" class="w-sheet"><h2 id="sheetTitle" tabindex="-1">Dispatch order</h2><p>${row.business || row.createdName}</p><p class="w-id">${row.id}</p><div class="kv"><span>Coffee subtotal</span><strong>${money(row.pence)}</strong></div>
      ${field("Tracking link (optional)", html`<input id="wDispatchTracking" type="url" inputmode="url" maxlength="2000" placeholder="https://" autocapitalize="none" spellcheck="false" autocomplete="off" value="${restoredTracking ?? row.trackingUrl ?? ""}">`)}<p class="hint">A tracking link is optional. Customers see it on dispatched delivery orders.</p><p class="err" id="wErr" role="alert"></p><button class="btn soft" type="button" data-sheet="dispatch-reload" hidden>Reload latest order</button><div class="row w-actions"><button class="btn soft" type="button" data-sheet="dispatch-cancel">Cancel</button><fieldset id="wDispatchConfirmControls" class="w-delete-confirm-controls"><button class="btn" type="submit">Confirm dispatch</button></fieldset></div></form>`, async (action, element) => {
      const form = element.closest("form");
      if (form.dataset.whBusy) return;
      if (action === "dispatch-cancel") { back(); return; }
      if (action === "dispatch-reload") {
        const typed = form.querySelector("#wDispatchTracking").value;
        await saveForm(form, async () => {
          await reload();
          let latest = data.orders.find((order) => order.id === row.id);
          if (!latest) latest = (await api("GET", "/api/admin/wholesale/orders?q=" + encodeURIComponent(row.id))).orders.find((order) => order.id === row.id);
          cleanup(); orderErrors.delete(row.id); refreshOrderFeedback(row.id);
          if (!latest) { closeSheet(); focusOrderList(row.id); toast("This order is no longer available."); return; }
          const draftTracking = (latest.trackingUrl || "") === (row.trackingUrl || "") ? typed : undefined;
          if (latest.status === "Ready") dispatchOrder(latest, draftTracking);
          else editOrder(latest.id, draftTracking === undefined ? null : { trackingUrl: draftTracking }, latest);
        });
        return;
      }
      if (action !== "submit" || form.querySelector("#wDispatchConfirmControls").disabled || quickBusy.has(row.id)) return;
      const tracking = form.querySelector("#wDispatchTracking").value.trim();
      if (!validTrackingUrl(tracking)) { form.querySelector("#wErr").textContent = "Use a full HTTP or HTTPS tracking link without a username or password."; form.querySelector("#wDispatchTracking").focus(); return; }
      const button = form.querySelector('button[type="submit"]'); button.textContent = "Saving…";
      quickBusy.add(row.id); refreshOrderFeedback(row.id);
      try {
        await saveForm(form, async () => {
          const result = await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: "Dispatched", customerId: row.customerId, note: row.note || "", trackingUrl: tracking });
          if (result.order?.id !== row.id || result.order.status !== "Dispatched" || result.order.version !== row.version + 1) throw new Error("The dispatch could not be confirmed. Reload the latest order to check its status.");
          orderErrors.delete(row.id); cleanup(); closeSheet(); await reload(); toast(`${row.business || "Order"} marked dispatched.`);
        });
        if (form.isConnected) {
          button.textContent = "Confirm dispatch";
          if (form.querySelector("#wErr").textContent) {
            form.querySelector("#wDispatchConfirmControls").disabled = true; form.querySelector('[data-sheet="dispatch-reload"]').hidden = false;
            orderErrors.set(row.id, { version: row.version, message: form.querySelector("#wErr").textContent + " Reload orders before updating this order again." });
          }
        }
      } finally {
        quickBusy.delete(row.id); refreshOrderFeedback(row.id);
        if (!form.isConnected && $("#scrim").hidden) focusOrderList(row.id);
      }
    });
    const form = $("#wDispatchOrderForm"), controller = new AbortController(), scrim = $("#scrim");
    const observer = new MutationObserver(() => { if (!form.isConnected) cleanup(); });
    cleanup = () => { controller.abort(); observer.disconnect(); };
    observer.observe($("#sheet"), { childList: true });
    document.addEventListener("keydown", (event) => { if (event.key !== "Escape" || !form.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); if (!form.dataset.whBusy) back(); }, { capture: true, signal: controller.signal });
    scrim.addEventListener("click", (event) => { if (event.target !== scrim || !form.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); if (!form.dataset.whBusy) back(); }, { capture: true, signal: controller.signal });
    $("#sheetTitle").focus({ preventScroll: true }); $("#sheet").scrollTop = 0;
  }
  // Invites to order online (src/wholesaleImport.ts): what each business's sign-in looks like before it has one.
  const inviteText = (id) => { const i = data.invites?.[id]; return !i ? "No sign-in yet" : i.used ? "Invite accepted" : i.expired ? "Invite ran out" : `Invited ${date(i.invitedAt)}`; };
  const invitable = (row) => !accountFor(row.id) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email || "");
  const keyOf = (v) => String(v || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const OWN = /strangers|pottergate/i;
  async function sendInvites(ids, onProgress) {
    const sent = [], problems = {};
    for (let i = 0; i < ids.length; i += 25) {
      const r = await api("POST", "/api/admin/wholesale/customers/invites", { customerIds: ids.slice(i, i + 25) });
      for (const [id, result] of Object.entries(r.results)) (result === "sent" ? sent : (problems[result] ||= [])).push(id);
      onProgress?.(sent.length);
      if (problems.limit || problems.off) break;
    }
    return { sent, problems, notTried: ids.length - sent.length - Object.values(problems).flat().length };
  }
  const inviteSummary = ({ sent, problems, notTried }) => [
    `${sent.length} ${sent.length === 1 ? "invite" : "invites"} sent.`,
    problems.limit || notTried ? `The rest weren’t sent: today’s email limit was reached. Send them tomorrow.` : "",
    problems.off ? "Email isn’t set up on the site, so no invites could be sent." : "",
    problems.no_email ? `${problems.no_email.length} had no email address.` : "",
    problems.account ? `${problems.account.length} already had a sign-in.` : "",
    problems.failed ? `${problems.failed.length} couldn’t be sent; see Activity.` : "",
  ].filter(Boolean).join(" ");
  // Import from QuickBooks: read the exported customer list, tick who to bring in (by default everyone who bought in
  // the last 12 months, from the QuickBooks history in Insights, except Strangers' own businesses), then add or fill in.
  function openCustomerImport(state = {}) {
    const rows = state.rows || [], picked = state.picked || new Set();
    const existing = new Map(data.customers.map((c) => [keyOf(c.quickbooksName || c.business), c]));
    const recent = state.recent || new Map();
    const stateOf = (r) => existing.get(keyOf(r.quickbooksName)) || existing.get(keyOf(r.business)) ? "Already set up: fills any gaps" : "New";
    const lastOf = (r) => recent.get(keyOf(r.quickbooksName)) || recent.get(keyOf(r.business));
    openSheet(html`<form class="w-sheet w-import-sheet" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Import customers from QuickBooks</h2><p class="hint">Each ticked customer becomes a wholesale business with their contact details and delivery address. No logins are made and nothing is emailed: invite them afterwards.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${rows.length ? html`<p class="w-import-count"><b>${picked.size}</b> of ${rows.length} customers ticked · from ${state.fileName}</p>
        <div class="row w-import-picks"><button class="btn sm soft" type="button" data-sheet="pick-recent">Bought in the last 12 months</button><button class="btn sm soft" type="button" data-sheet="pick-all">All</button><button class="btn sm soft" type="button" data-sheet="pick-none">None</button></div>
        <div class="group w-import-list">${rows.map((r, i) => { const last = lastOf(r); return html`<label class="item w-import-row"><input type="checkbox" data-import-row="${i}" ${picked.has(i) ? raw("checked") : ""}><span class="tx"><b>${r.business}</b><span>${[r.contact, r.email || "No email", r.postcode].filter(Boolean).join(" · ")}</span><span>${last ? `Last bought ${new Date(last.last + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}` : "No sales in the last 12 months"}${OWN.test(r.business) ? " · Strangers business" : ""}</span></span><span class="end">${pill(stateOf(r))}</span></label>`; })}</div>
        <p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="import-file">Choose another file</button><button class="btn" type="submit">Import ${picked.size} ${picked.size === 1 ? "customer" : "customers"}</button></div>`
      : html`<ol class="ins-steps"><li>In QuickBooks, go to <b>Sales → Customers</b>.</li><li>Choose <b>Export to Excel</b> (the icon above the list). The Customer Contact List report works too.</li><li>Choose the file here.</li></ol>
        <label class="btn ins-file">${svg("plus")}Choose the customer list<input type="file" id="wImportFile" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label><p class="err" id="wErr" role="alert">${state.error || ""}</p>`}
      </form>`, async (action, element) => {
      const form = element.closest("form") || element;
      for (const box of form.querySelectorAll("[data-import-row]")) box.checked ? picked.add(Number(box.dataset.importRow)) : picked.delete(Number(box.dataset.importRow));
      if (action === "import-file") return openCustomerImport({});
      if (action === "pick-all") { rows.forEach((_, i) => picked.add(i)); return openCustomerImport({ ...state, picked }); }
      if (action === "pick-none") { picked.clear(); return openCustomerImport({ ...state, picked }); }
      if (action === "pick-recent") { picked.clear(); rows.forEach((r, i) => { if (lastOf(r) && !OWN.test(r.business)) picked.add(i); }); return openCustomerImport({ ...state, picked }); }
      if (action !== "submit") return;
      if (!picked.size) { form.querySelector("#wErr").textContent = "Tick at least one customer to import."; return; }
      await saveForm(form, async () => {
        const r = await api("POST", "/api/admin/wholesale/customers/import", { customers: [...picked].sort((a, b) => a - b).map((i) => rows[i]) });
        closeSheet(); query = ""; await reload();
        toast(`${r.created} ${r.created === 1 ? "business" : "businesses"} added${r.updated ? `, ${r.updated} filled in` : ""}${r.unchanged ? `, ${r.unchanged} already up to date` : ""}.`);
      });
    });
    // Ticking and unticking keeps the count and the button up to date.
    $("#sheet .w-import-sheet")?.addEventListener("change", (event) => {
      const box = event.target.closest?.("[data-import-row]"); if (!box) return;
      box.checked ? picked.add(Number(box.dataset.importRow)) : picked.delete(Number(box.dataset.importRow));
      const count = $("#sheet .w-import-count b"), submit = $('#sheet button[type="submit"]');
      if (count) count.textContent = picked.size; if (submit) submit.textContent = `Import ${picked.size} ${picked.size === 1 ? "customer" : "customers"}`;
    });
    const input = $("#wImportFile");
    input?.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const parsed = await window.SCCustomerImport.parseFile(file);
        let recentMap = new Map();
        try { const ins = await api("GET", "/api/admin/wholesale/insights"), cutoff = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10); recentMap = new Map(ins.customers.filter((c) => c.last >= cutoff).map((c) => [c.key, c])); } catch {}
        const pickedNow = new Set(); parsed.rows.forEach((r, i) => { if ((recentMap.get(keyOf(r.quickbooksName)) || recentMap.get(keyOf(r.business))) && !OWN.test(r.business)) pickedNow.add(i); });
        if (!pickedNow.size && !recentMap.size) parsed.rows.forEach((r, i) => { if (!OWN.test(r.business)) pickedNow.add(i); });
        openCustomerImport({ rows: parsed.rows, fileName: parsed.fileName, picked: pickedNow, recent: recentMap });
      } catch (error) { openCustomerImport({ error: error.message }); }
    });
    $("#sheetTitle").focus({ preventScroll: true });
  }
  // Invite to order online: every business without a sign-in that has an email, not invited in the last 14 days
  // ticked; sent 25 at a time, stopping at the day's email limit.
  async function openInvites(state = {}) {
    if (!state.rows) {
      const all = await api("GET", "/api/admin/wholesale"), invites = (await api("GET", "/api/admin/wholesale/customers/invites")).invites;
      const accounts = new Set(all.accounts.map((a) => a.customerId));
      const rows = all.customers.filter((c) => !accounts.has(c.id)).sort((a, b) => a.business.localeCompare(b.business));
      const ok = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email || "");
      const fresh = (c) => invites[c.id] && !invites[c.id].expired && !invites[c.id].used;
      state = { rows, invites, picked: new Set(rows.filter((c) => ok(c) && !fresh(c) && c.status === "Active").map((c) => c.id)), ok };
    }
    const { rows, invites, picked, ok } = state;
    openSheet(html`<form class="w-sheet w-import-sheet" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Invite to order online</h2><p class="hint">Each ticked business is emailed a link to set up their own username and password (it lasts 14 days and works once). Their account is ready to order as soon as they do.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${rows.length ? html`<p class="w-import-count"><b>${picked.size}</b> of ${rows.length} businesses without a sign-in ticked</p>
      <div class="group w-import-list">${rows.map((c) => { const i = invites[c.id]; return html`<label class="item w-import-row ${ok(c) ? "" : "off"}"><input type="checkbox" data-invite="${c.id}" ${picked.has(c.id) ? raw("checked") : ""} ${ok(c) ? "" : raw("disabled")}><span class="tx"><b>${c.business}</b><span>${c.email || "No email address: add one to invite them"}</span></span><span class="end">${i ? pill(i.expired ? "Invite ran out" : i.used ? "Accepted" : `Invited ${date(i.invitedAt)}`) : ""}</span></label>`; })}</div>
      <p class="hint">Emails share the site’s daily email limit; if it’s reached, the rest can be sent tomorrow.</p>
      <p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">Send ${picked.size} ${picked.size === 1 ? "invite" : "invites"}</button></div>` : html`<p class="hint">Every business already has a sign-in.</p>`}</form>`, async (action, element) => {
      const form = element.closest("form") || element;
      for (const box of form.querySelectorAll("[data-invite]")) box.checked ? picked.add(box.dataset.invite) : picked.delete(box.dataset.invite);
      if (action !== "submit") return;
      if (!picked.size) { form.querySelector("#wErr").textContent = "Tick at least one business."; return; }
      await saveForm(form, async () => {
        const submit = form.querySelector('button[type="submit"]');
        const result = await sendInvites([...picked], (n) => { if (submit) submit.textContent = `Sending… ${n} sent`; });
        closeSheet(); await reload(); toast(inviteSummary(result));
      });
    });
    $("#sheet .w-import-sheet")?.addEventListener("change", (event) => {
      const box = event.target.closest?.("[data-invite]"); if (!box) return;
      box.checked ? picked.add(box.dataset.invite) : picked.delete(box.dataset.invite);
      const count = $("#sheet .w-import-count b"), submit = $('#sheet button[type="submit"]');
      if (count) count.textContent = picked.size; if (submit) submit.textContent = `Send ${picked.size} ${picked.size === 1 ? "invite" : "invites"}`;
    });
    $("#sheetTitle").focus({ preventScroll: true });
  }
  function customers() {
    const rows = [...data.customers].sort((a,b) => Number(accountFor(b.id)?.approvalStatus === "pending") - Number(accountFor(a.id)?.approvalStatus === "pending"));
    const filtered = !!query.trim() || approval !== "all";
    const tools = html`<div class="toolbar">${search("Search wholesale customers", "Search business, contact or email")}<button class="btn" type="button" data-act="wh-customer">${svg("plus")}Add customer</button><button class="btn soft" type="button" data-act="wh-import-customers">Import from QuickBooks</button><button class="btn soft" type="button" data-act="wh-invite-customers">${svg("mail")}Invite to order online</button></div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Customer access">${[["all", "All customers"], ["pending", "Awaiting review"]].map(([id, label]) => html`<button type="button" data-act="wh-approval" data-id="${id}" aria-pressed="${approval === id}">${label}</button>`)}</div></div>`;
    return listing("wCustomersTitle", "Customers", resultCount(rows.length, data.matchingCount, "customer"), tools,
      rows.length ? rows.map((row) => html`<button class="item w-customer" type="button" data-act="wh-customer" data-id="${row.id}"><span class="ic ${accountFor(row.id)?.approvalStatus === "pending" ? "warn" : "ok"}">${svg("people")}</span><span class="tx"><b>${row.business}</b><span>${[row.contact, row.email].filter(Boolean).join(" · ") || "No contact details"}</span><span>${accountFor(row.id)?.approvalStatus === "pending" ? "Awaiting account approval" : accountFor(row.id) ? accountFor(row.id).active ? "Sign-in enabled" : "Sign-in disabled" : inviteText(row.id)} · ${termsFor(row)}${row.noMinimumOrder ? " · No minimum order" : ""}${row.hidePrices ? " · Prices hidden" : ""}${row.autoTab ? " · On a tab" : ""}</span></span><span class="end">${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : emptyState(filtered ? "search" : "people", filtered ? "No matching customers" : "No customers yet", filtered ? "Try another search or clear your filters to see all customers." : "Add a business, or review new registrations as they arrive.", filtered),
      html`${more("customers")}<p class="hint">Customers can access ordering after an admin approves their registration.</p>`);
  }
  function catalogue() {
    const rows = data.products.filter((row) => matches(`${row.title} ${row.name} ${row.origin} ${row.process} ${row.notes}`));
    const tools = html`<div class="toolbar">${search("Search coffee catalogue", "Search coffee, origin or tasting notes")}<button class="btn" type="button" data-act="wh-coffee">${svg("plus")}Add coffee</button></div>`;
    return listing("wCatalogueTitle", "Coffee catalogue", resultCount(rows.length, data.products.length, "coffee"), tools,
      rows.length ? rows.map((row) => html`<div class="item w-coffee w-coffee-tone" style="${coffeeStyle(row)}">${row.imageUrls.length ? html`<img src="${row.imageUrls[0]}" alt="" width="52" height="52" loading="lazy">` : html`<span class="ic mut">${svg("coffee")}</span>`}<span class="tx"><b><span class="w-coffee-swatch" aria-hidden="true"></span>${row.title}${row.whiteLabel?.length ? html`<span class="w-wl-tag">White label</span>` : ""}</b><span>250 g ${money(row.prices.quarter)} · 1 kg ${money(row.prices.kilo)}</span>${row.whiteLabel?.length ? html`<span>For ${row.whiteLabel.map((cid) => customer(cid)?.business).filter(Boolean).join(", ") || `${row.whiteLabel.length} ${row.whiteLabel.length === 1 ? "business" : "businesses"}`}</span>` : ""}${row.recipe?.length ? html`<span>Made from ${row.recipe.map((p) => `${p.percent}% ${p.name}`).join(" · ")}</span>` : ""}<span>${row.notes}</span></span><span class="end"><span class="w-coffee-state">${pill(row.active ? "Visible" : "Hidden")}${pill(row.inStock ? "In stock" : "Out of stock")}</span><button class="btn sm soft" type="button" data-act="wh-coffee" data-id="${row.id}" aria-label="Edit ${row.name}">Edit</button></span></div>`) : emptyState(query.trim() ? "search" : "coffee", query.trim() ? "No matching coffees" : "Your catalogue starts here", query.trim() ? "Try another search or clear your filters to see all coffees." : "Add your first coffee, with its prices, photos and availability.", !!query.trim()),
      html`<p class="hint">Edit coffees, bag prices, photos and availability. Existing orders retain their original details.</p>`);
  }
  function scheduleSection(row, draft) {
    const dispatchDate = draft ? draft.dispatchDate || "" : row.dispatchDate || "", every = draft ? draft.every : row.standing?.every || 0;
    const closed = ["Dispatched", "Cancelled"].includes(row.status);
    return html`<section class="w-order-section w-schedule" aria-labelledby="wScheduleTitle"><h3 id="wScheduleTitle">Dispatch and standing order</h3>
      ${field("Dispatch day", html`<input id="wDispatchDate" type="date" min="${dispatchDate && dispatchDate < today() ? dispatchDate : today()}" value="${dispatchDate}">`)}
      <div class="checks"><label><input id="wStanding" type="checkbox" ${every ? raw("checked") : ""}>Standing order</label></div>
      ${field("Repeats", html`<select id="wEvery">${EVERY.map(([n, label]) => html`<option value="${n}" ${n === (every || 1) ? raw("selected") : ""}>${label}</option>`)}</select>`)}
      <p class="hint">${row.nextRunId ? html`The next run has been made: <button class="link" type="button" data-sheet="open-run" data-id="${row.nextRunId}">${shortId(row.nextRunId)}…</button>` : closed && row.standing ? "Saving makes the next run." : "When a standing order is marked dispatched (or cancelled, to skip one), the next run is made straight away as a New order for the next dispatch day, so you can prepare it and change its bags in advance."}${row.standing?.run > 1 ? ` This is run ${row.standing.run}.` : ""}${row.previousRunId ? html` <button class="link" type="button" data-sheet="open-run" data-id="${row.previousRunId}">Previous run</button>` : ""}</p>
      <p class="hint">Untick Standing order to stop it repeating. The customer sees the dispatch day and the schedule on their orders.</p></section>`;
  }
  // Change the bags on a New or Preparing customer order. Kept lines keep the price they were ordered at; added ones
  // take today's catalogue price. `back` reopens the order with what was typed there.
  function editLines(row, state = null, back = null) {
    const lines = state || row.lines.map((line) => ({ ...line }));
    const coffees = data.products.filter((p) => p.active);
    const total = lines.reduce((sum, l) => sum + l.quantity, 0), grams = lines.reduce((sum, l) => sum + (l.pack === "kilo" ? 1000 : l.pack === "half" ? 500 : 250) * l.quantity, 0);
    openSheet(html`<form class="w-sheet w-lines-sheet" novalidate><h2 id="sheetTitle" tabindex="-1">Edit bags</h2><p class="hint">${row.business} · ${shortId(row.id)}…</p>
      <div class="w-edit-lines">${lines.length ? lines.map((line, i) => html`<div class="w-edit-line"><span class="w-edit-tx"><b>${line.title}</b><span>${line.packLabel} · ${line.grindLabel}</span></span><input class="w-qty" type="number" inputmode="numeric" min="1" max="999" step="1" value="${line.quantity}" data-line-qty="${i}" aria-label="Bags of ${line.title}, ${line.packLabel}, ${line.grindLabel}"><button class="btn sm soft" type="button" data-sheet="remove-line" data-index="${i}" aria-label="Remove ${line.title} ${line.packLabel} ${line.grindLabel}">Remove</button></div>`) : html`<p class="hint">No bags on this order. Add at least one.</p>`}</div>
      <p class="hint" id="wLinesTotal">${total} ${total === 1 ? "bag" : "bags"} · ${weight(grams)}</p>
      <fieldset class="w-add-line"><legend>Add a coffee</legend>
        ${field("Coffee and grind", html`<select id="wAddCoffee"><option value="">Choose a coffee</option>${coffees.map((p) => html`<optgroup label="${p.title}">${p.grindOptions.filter((g) => g.enabled).map((g) => html`<option value="${p.id}|${g.id}">${p.name || p.title} · ${g.label}</option>`)}</optgroup>`)}</select>`)}
        <div class="w-add-row">${field("Bag size", html`<select id="wAddPack"><option value="quarter">250 g bag</option><option value="kilo">1 kg bag</option></select>`)}${field("Bags", html`<input id="wAddQty" type="number" inputmode="numeric" min="1" max="999" value="1">`)}</div>
        <button class="btn sm soft" type="button" data-sheet="add-line">Add to order</button></fieldset>
      <p class="hint">Bags already on the order keep their price; added bags use today's price. The order total and delivery charge are worked out again. The customer sees the updated order.</p>
      <p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="lines-back">Back</button><button class="btn" type="submit">Save bags</button></div></form>`, async (action, element) => {
      const form = element.closest("form") || element;
      for (const input of form.querySelectorAll("[data-line-qty]")) lines[Number(input.dataset.lineQty)].quantity = Number(input.value);
      const error = form.querySelector("#wErr");
      if (action === "lines-back") { editOrder(row.id, back, row); return; }
      if (action === "remove-line") { lines.splice(Number(element.dataset.index), 1); editLines(row, lines, back); return; }
      if (action === "add-line") {
        const [productId, grind] = form.querySelector("#wAddCoffee").value.split("|"), pack = form.querySelector("#wAddPack").value, quantity = Number(form.querySelector("#wAddQty").value);
        const product = coffees.find((p) => p.id === productId), option = product?.grindOptions.find((g) => g.id === grind);
        if (!product || !option) { error.textContent = "Choose a coffee and grind to add."; return; }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) { error.textContent = "Choose from 1 to 999 bags."; return; }
        const same = lines.find((l) => l.productId === productId && l.pack === pack && l.grind === grind);
        if (same) same.quantity += quantity;
        else lines.push({ productId, pack, grind, quantity, title: product.title, packLabel: pack === "kilo" ? "1 kg bag" : "250 g bag", grindLabel: option.label });
        editLines(row, lines, back); return;
      }
      if (action !== "submit") return;
      if (!lines.length) { error.textContent = "Keep at least one coffee on the order, or cancel the order instead."; return; }
      if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999)) { error.textContent = "Each line needs from 1 to 999 bags. Use Remove to take a coffee off."; return; }
      await saveForm(form, async () => {
        const result = await api("PUT", `/api/admin/wholesale/orders/${row.id}/lines`, { ifVersion: row.version, lines: lines.map(({ productId, pack, grind, quantity }) => ({ productId, pack, grind, quantity })) });
        await reload();
        toast("Bags updated.");
        editOrder(row.id, back, data.orders.find((r) => r.id === row.id) || result.order);
      });
    });
    $("#sheetTitle").focus({ preventScroll: true });
  }
  function editOrder(id, draft = null, displayed = null) {
    const row = displayed || data.orders.find((row) => row.id === id);
    if (!row || quickBusy.has(id)) return;
    const snapshot = row.customerSnapshot, selectedCustomer = draft && Object.hasOwn(draft, "customerId") ? draft.customerId : row.customerId;
    const grinds = row.lines.map(grindFor), choices = [...new Map(grinds.map(grind => [grind.key, grind])).values()];
    openSheet(html`<form class="w-sheet w-order-sheet"><h2 id="sheetTitle" tabindex="-1">Order details</h2><div class="w-order-heading"><h3>${row.business || row.createdName}</h3>${pill(row.status)}${row.preview === false ? "" : html`<span class="pill">Staff preview</span>`}</div><p class="w-id">${row.id}</p>
      <div class="kvs">${row.locationSnapshot?.name ? html`<div class="kv"><span>Location</span><span>${row.locationSnapshot.name}</span></div>` : ""}<div class="kv"><span>Received</span><span>${date(row.createdAt)}</span></div><div class="kv"><span>Reference</span><span>${row.reference || "None supplied"}</span></div><div class="kv"><span>Ordered by</span><span>${row.createdName}</span></div></div>
      ${row.customerNote ? html`<section class="w-order-section w-customer-note" aria-labelledby="wCustomerNoteTitle"><h3 id="wCustomerNoteTitle">Customer comments</h3><p class="w-address">${row.customerNote}</p></section>` : ""}
      <section class="w-order-section" aria-labelledby="wPackingTitle"><div class="w-section-head"><h3 id="wPackingTitle">Packing list</h3>${row.preview === false && ["New", "Preparing"].includes(row.status) ? html`<button class="btn sm soft" type="button" data-sheet="edit-lines">Edit bags</button>` : ""}</div>${row.amendedAt ? html`<p class="hint w-amended">Bags changed${row.amendedBy ? ` by ${row.amendedBy}` : ""} on ${date(row.amendedAt)}. The customer sees the updated order.</p>` : ""}${choices.length > 1 ? html`<div class="w-grind-filters" role="group" aria-label="Filter packing list by grind"><button type="button" data-sheet="grind-filter" data-grind-key="" aria-pressed="true">All grinds</button>${choices.map(grind => html`<button type="button" class="w-grind-tone" style="--w-grind-h:${grind.hue}" data-sheet="grind-filter" data-grind-key="${grind.key}" aria-pressed="false">${svg(grind.icon)}${grind.label}</button>`)}</div><p id="wGrindCount" class="hint" role="status">${row.lines.length} packing lines · Order totals include all lines.</p>` : ""}<div class="group w-packing-list">${row.lines.map((line, index) => { const grind = grinds[index]; return html`<div class="item w-packing-line w-grind-tone w-coffee-tone" style="--w-grind-h:${grind.hue};${coffeeStyle(line, data.products)}" data-grind-line="${grind.key}"><span class="w-pack-quantity"><b>${line.quantity}</b><span>${line.quantity === 1 ? "bag" : "bags"}</span></span><span class="tx"><b class="w-pack-coffee"><span class="w-coffee-swatch" aria-hidden="true"></span>${line.title}${decafLine(line) ? html`<span class="w-decaf-label">Decaf</span>` : ""}</b>${line.recipe ? html`<span class="w-recipe">Made from ${line.recipe}</span>` : ""}<span class="w-pack-size">${line.packLabel}</span><span class="w-grind-details"><span class="w-grind-badge">${svg(grind.icon)}${grind.label}</span>${grind.hint ? html`<span class="w-grind-hint">${grind.hint}</span>` : ""}</span></span><span class="end num">${money(line.price * line.quantity)}</span></div>`; })}</div><div class="kv"><span>${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)} total</span><strong>${money(row.pence)}</strong></div>${Number.isSafeInteger(row.deliveryPence) ? html`<div class="kv"><span>${row.delivery === "Delivery" ? "Delivery (including VAT)" : "Roastery collection"}</span><strong>${row.deliveryPence ? money(row.deliveryPence) : "Free"}</strong></div><div class="kv"><span>Order total</span><strong>${money(row.totalPence ?? row.pence + row.deliveryPence)}</strong></div>` : ""}</section>
      <section class="w-order-section" aria-labelledby="wDeliveryTitle"><h3 id="wDeliveryTitle">${row.delivery}</h3>${snapshot ? html`<p class="w-address">${[snapshot.contact, snapshot.email, snapshot.phone].filter(Boolean).join(" · ") || "No contact details recorded"}</p>${row.delivery === "Delivery" ? html`<div class="kvs"><div class="kv"><span>Delivery address at checkout</span><span class="w-address">${[snapshot.address, snapshot.postcode].filter(Boolean).join("\n") || "Not recorded"}</span></div><div class="kv"><span>Delivery instructions</span><span class="w-address">${row.deliveryNotes || "None supplied"}</span></div></div>` : ""}` : html`<p class="hint">Staff preview order.</p>`}</section>
      ${row.preview === false ? html`<section class="w-order-section" aria-labelledby="wTermsTitle"><h3 id="wTermsTitle">Payment terms at order</h3><p>${row.paymentTerms?.label || "Not recorded on this order"}</p>${row.paymentTerms?.note ? html`<p class="w-address">${row.paymentTerms.note}</p>` : ""}</section>` : ""}
      ${invoiceUI.orderPanel(row)}
      ${row.preview === false && row.customerId ? html`<section class="w-order-section" aria-labelledby="wTabTitle"><div class="w-section-head"><h3 id="wTabTitle">Customer tab</h3>${row.tabClearedId ? "" : html`<button class="btn sm soft" type="button" data-sheet="tab-toggle">${row.tab ? "Take off tab" : "Put on tab"}</button>`}</div>
        <p class="hint">${row.tabClearedId ? "On a tab that has been cleared." : row.tab ? `On this customer’s tab${row.tab.auto ? " (added automatically)" : row.tab.by ? ` (added by ${row.tab.by})` : ""}.` : "Not on a tab."} Tabs are cleared on the staff <a href="${(data.links?.diary || "").replace(/\/$/, "")}/orders#tabs">Wholesale orders page</a>.</p></section>` : ""}
      ${row.preview === false ? scheduleSection(row, draft?.schedule) : ""}
      <section class="w-order-section w-order-management" aria-labelledby="wManageTitle"><h3 id="wManageTitle">Manage order</h3>${field("Order status", html`<select id="wStatus">${data.statuses.map((value) => html`<option ${value === (draft?.status ?? row.status) ? raw("selected") : ""}>${value}</option>`)}</select>`)}
      ${field("Customer", html`<select id="wCustomer" ${row.preview === false ? raw("disabled") : ""}><option value="">Not linked to a customer</option>${selectedCustomer && !customer(selectedCustomer) ? html`<option value="${selectedCustomer}" selected>${snapshot?.business || row.business}</option>` : ""}${data.customers.map((value) => html`<option value="${value.id}" ${value.id === selectedCustomer ? raw("selected") : ""}>${value.business}</option>`)}</select>`)}
      ${field("Tracking link (optional)", html`<input id="wTrackingUrl" type="url" inputmode="url" maxlength="2000" placeholder="https://" autocapitalize="none" spellcheck="false" autocomplete="off" value="${draft?.trackingUrl ?? row.trackingUrl ?? ""}">`)}<p class="hint">Add, edit or clear the link. Customers see it on dispatched delivery orders.</p>
      ${field("Internal note", html`<textarea id="wNote" maxlength="1000">${draft?.note ?? row.note}</textarea>`)}</section>${note}${buttons("Save order")}<div class="w-order-danger"><button class="btn bad" type="button" data-sheet="delete-order">Delete order</button></div></form>`, async (action, element) => {
      const form = element.closest("form");
      if (action === "grind-filter") {
        const key = element.dataset.grindKey;
        for (const button of form.querySelectorAll('[data-sheet="grind-filter"]')) button.setAttribute("aria-pressed", String(button.dataset.grindKey === key));
        let shown = 0;
        for (const line of form.querySelectorAll("[data-grind-line]")) { line.hidden = !!key && line.dataset.grindLine !== key; if (!line.hidden) shown++; }
        form.querySelector("#wGrindCount").textContent = `${shown} of ${row.lines.length} packing lines · Order totals include all lines.`;
        return;
      }
      if (action === "invoice-open") {
        const draft = draftOf(form, row);
        await invoiceUI.openOrder(row, () => editOrder(row.id, draft, row));
        return;
      }
      if (action === "tab-toggle") {
        const draft = { status: form.querySelector("#wStatus").value, customerId: row.customerId, note: form.querySelector("#wNote").value, trackingUrl: form.querySelector("#wTrackingUrl").value };
        await saveForm(form, async () => {
          await api("PUT", `/api/admin/wholesale/orders/${row.id}/tab`, { ifVersion: row.version, onTab: !row.tab });
          await reload(); toast(row.tab ? "Taken off the tab." : "Put on the tab.");
          const fresh = data.orders.find((r) => r.id === row.id); if (fresh) editOrder(row.id, draft, fresh);
        });
        return;
      }
      if (action === "delete-order") {
        confirmOrderDeletion(row, draftOf(form, row));
        return;
      }
      if (action === "edit-lines") { editLines(row, null, draftOf(form, row)); return; }
      if (action === "open-run") { const run = data.orders.find((r) => r.id === element.dataset.id); if (run) editOrder(run.id); else { query = element.dataset.id; closeSheet(); await reload(); } return; }
      if (action !== "submit") return;
      await saveForm(form, async () => {
        const schedule = scheduleOf(form);
        const result = await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: $("#wStatus").value, customerId: row.preview === false ? row.customerId : $("#wCustomer").value || null, note: $("#wNote").value, trackingUrl: $("#wTrackingUrl").value, ...(schedule ? { schedule } : {}) });
        orderErrors.delete(row.id);
        if (form.isConnected) closeSheet(); await reload();
        const nextRun = result.order?.nextRunId && !row.nextRunId ? data.orders.find((r) => r.id === result.order.nextRunId) : null;
        toast(result.order?.nextRunId && !row.nextRunId ? `Order saved. The next standing order run is ready${nextRun?.dispatchDate ? ` for ${day(nextRun.dispatchDate)}` : ""}.` : "Order saved.");
      });
    });
    $("#sheetTitle").focus({ preventScroll: true });
    $("#sheet").scrollTop = 0;
  }
  function confirmOrderDeletion(row, draft) {
    let cleanup = () => {};
    const back = () => { cleanup(); editOrder(row.id, draft, row); };
    openSheet(html`<form id="wDeleteOrderForm" class="w-sheet"><h2 id="sheetTitle" tabindex="-1">Delete order?</h2><p>${row.preview === false ? "This removes the order from Admin and the customer’s order history." : "This removes the staff preview order from Admin."}</p><div class="kvs w-delete-summary"><div class="kv"><span>Business</span><strong>${row.business || row.createdName}</strong></div><div class="kv"><span>Order</span><span class="w-id">${row.id}</span></div><div class="kv"><span>Coffee subtotal</span><strong>${money(row.pence)}</strong></div><div class="kv"><span>Status</span><span>${row.status}</span></div></div><p>The order cannot be restored from this page. An audit record is kept.</p><p>Payments are unchanged. No refund is issued. Issued invoices remain available.</p><p class="err" id="wErr" role="alert"></p><button class="btn soft" type="button" data-sheet="reload-delete" hidden>Reload latest order</button><div class="row w-actions"><button class="btn soft" type="button" data-sheet="cancel-delete">Cancel</button><fieldset id="wDeleteConfirmControls" class="w-delete-confirm-controls"><button class="btn solidbad" type="submit">Confirm delete order</button></fieldset></div></form>`, async (action, element) => {
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
  const locationKeys = ["contact", "phone", "address", "postcode", "deliveryNotes"];
  function customerLocations(row) {
    return row.locations?.length ? row.locations.map((location) => ({ ...location })) : [{ id: "primary", name: "Main location", ...Object.fromEntries(locationKeys.map((key) => [key, row[key] || ""])) }];
  }
  function customerChoiceField(label, id, value, options) {
    const selected = options.find((option) => option.value === value) || options[0];
    return html`<div class="field w-customer-choice-field"><span class="fl" id="${id}Label">${label}</span><select id="${id}" hidden aria-hidden="true" tabindex="-1">${options.map((option) => html`<option value="${option.value}" ${option.value === selected?.value ? raw("selected") : ""}>${option.label}</option>`)}</select><button class="w-customer-choice-trigger" type="button" data-sheet="customer-choice" data-choice="${id}" aria-haspopup="dialog" aria-labelledby="${id}Label ${id}Value"><span id="${id}Value">${selected?.label || "Choose"}</span><span class="chev">${svg("chev")}</span></button></div>`;
  }
  function editCustomer(id, restored = null, displayed = null) {
    const row = displayed || (id ? customer(id) : { business: "", contact: "", email: "", status: "Active", note: "" });
    if (!row) return;
    const state = restored || { ...row, locations: customerLocations(row), defaultLocationId: row.defaultLocationId || "primary" };
    const locations = state.locations.map((location) => ({ ...location }));
    const defaultId = locations.some((location) => location.id === state.defaultLocationId) ? state.defaultLocationId : "primary";
    let form;
    const capture = () => {
      const fields = { business: "wBusiness", contact: "wContact", email: "wEmail", phone: "wPhone", address: "wAddress", postcode: "wPostcode", deliveryNotes: "wDeliveryNotes", paymentTerms: "wPaymentTerms", paymentNote: "wPaymentNote", status: "wStatus", note: "wNote" };
      const draft = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, form.querySelector("#" + input).value]));
      draft.locations = locations.map((location) => ({ ...location }));
      draft.locations[0] = { ...draft.locations[0], ...Object.fromEntries(locationKeys.map((key) => [key, draft[key]])) };
      draft.defaultLocationId = form.querySelector("#wDefaultLocation").value;
      draft.noMinimumOrder = form.querySelector("#wNoMinimum").checked;
      draft.hidePrices = form.querySelector("#wHidePrices").checked;
      draft.autoTab = form.querySelector("#wAutoTab").checked;
      draft.scrollTop = $("#sheet").scrollTop;
      return draft;
    };
    openSheet(html`<form id="wCustomerForm" class="w-sheet"><header id="wCustomerHeader" class="w-customer-header"><div><h2 id="sheetTitle" tabindex="-1">${id ? "Edit customer" : "Add customer"}</h2><p>${state.business || "Business account and delivery locations"}</p></div><button class="btn soft w-customer-close" type="button" data-sheet="close" aria-label="Close customer editor">${svg("x")}</button></header>
      <div class="w-customer-layout"><div class="w-customer-column"><section class="w-customer-card" aria-labelledby="wBusinessTitle"><h3 id="wBusinessTitle">Business details</h3>
      ${field("Business name", html`<input id="wBusiness" value="${state.business}" maxlength="120" required>`)}
      ${field("Contact name (optional)", html`<input id="wContact" value="${state.contact || ""}" maxlength="120">`)}
      ${field("Contact email (optional)", html`<input id="wEmail" type="email" value="${state.email || ""}" maxlength="150">`)}
      ${field("Phone (optional)", html`<input id="wPhone" type="tel" value="${state.phone || ""}" maxlength="40">`)}
      </section><section class="w-customer-card" aria-labelledby="wMainLocationTitle"><h3 id="wMainLocationTitle">Main location</h3>
      ${field("Main location address", html`<textarea id="wAddress" maxlength="500">${state.address || ""}</textarea>`)}
      ${field("Postcode", html`<input id="wPostcode" value="${state.postcode || ""}" maxlength="20">`)}
      ${field("Delivery notes", html`<textarea id="wDeliveryNotes" maxlength="1000">${state.deliveryNotes || ""}</textarea>`)}
      </section><section class="w-location-section w-customer-card" aria-labelledby="wLocationsTitle"><div class="w-location-heading"><h3 id="wLocationsTitle">Saved locations</h3><button class="btn sm soft" type="button" data-sheet="location-add" ${locations.length >= 20 ? raw("disabled") : ""}>${svg("plus")}Add location</button></div><p class="hint">Keep an address and contact for each shop. Location changes save when you save the customer.</p><div class="group w-location-list" id="wLocations">${locations.map((location, index) => html`<button class="item" type="button" data-sheet="location-edit" data-index="${index}"><span class="ic mut">${svg("house")}</span><span class="tx"><b>${location.name}</b><span>${[location.address, location.postcode].filter(Boolean).join(", ") || "No address yet"}</span>${!location.id ? html`<span>Not saved yet</span>` : ""}</span><span class="end">${location.id === defaultId ? html`<span class="pill acc">Default</span>` : index === 0 ? html`<span class="pill">Main</span>` : ""}<span class="chev">${svg("chev")}</span></span></button>`)}</div>
      ${customerChoiceField("Default location", "wDefaultLocation", defaultId, locations.filter((location) => location.id).map((location) => ({ value: location.id, label: location.name })))}<p class="hint">${locations.some((location) => !location.id) ? "Save new locations before choosing one as default." : "The default is preselected for new orders."} ${locations.length} of 20 locations.</p></section></div>
      <div class="w-customer-column"><section class="w-customer-card" aria-labelledby="wOrderingTitle"><h3 id="wOrderingTitle">Ordering and payment</h3>
      ${customerChoiceField("Payment terms", "wPaymentTerms", state.paymentTerms || "to-agree", data.paymentTermChoices.map((term) => ({ value: term.id, label: term.label })))}
      ${field("Payment instructions (shown to the customer)", html`<textarea id="wPaymentNote" maxlength="500">${state.paymentNote || ""}</textarea>`)}
      ${customerChoiceField("Status", "wStatus", state.status, [{ value: "Active", label: "Active" }, { value: "On hold", label: "On hold" }])}
      <div class="checks w-minimum-check"><label><input id="wNoMinimum" type="checkbox" ${state.noMinimumOrder ? raw("checked") : ""}>No minimum order (invoice as they go)</label></div><p class="hint">Only Strangers sees this setting. Without it, orders must be at least ${minimumKg()} of coffee. The customer just won’t see a minimum.</p>
      <div class="checks w-minimum-check"><label><input id="wHidePrices" type="checkbox" ${state.hidePrices ? raw("checked") : ""}>Hide prices (our own shops)</label></div><p class="hint">Ordering shows no prices or totals to this business: bags and weights only. Orders still record their prices for Admin and invoices.</p>
      <div class="checks w-minimum-check"><label><input id="wAutoTab" type="checkbox" ${state.autoTab ? raw("checked") : ""}>Put orders on a tab</label></div><p class="hint">Each new order goes on this business’s tab automatically. Tabs are cleared on the staff Wholesale orders page (Tabs) when they reach 6 kg, or sooner.</p></section>
      ${id ? ((own) => html`<section class="w-customer-card" aria-labelledby="wWlCustomerTitle"><h3 id="wWlCustomerTitle">White-label coffees</h3>${own.length ? html`<div class="group">${own.map((p) => html`<div class="item w-coffee-tone" style="${coffeeStyle(p)}"><span class="tx"><b><span class="w-coffee-swatch" aria-hidden="true"></span>${p.title}</b><span>250 g ${money(p.prices.quarter)} · 1 kg ${money(p.prices.kilo)}${p.active ? "" : " · Hidden"}</span>${p.recipe?.length ? html`<span>Made from ${p.recipe.map((r) => `${r.percent}% ${r.name}`).join(" · ")}</span>` : ""}</span></div>`)}</div>` : html`<p class="hint">None yet.</p>`}<p class="hint">Only this business sees these coffees, listed first. Add one, or change its prices or recipe, in Coffee catalogue: tick White label and choose this business.</p></section>`)(data.products.filter((p) => p.whiteLabel?.includes(id))) : ""}
      ${id ? html`<section class="w-customer-card" aria-labelledby="wSigninTitle"><h3 id="wSigninTitle">Wholesale sign-in</h3><div class="kv"><span>Username</span><span>${accountFor(id)?.username || "Not created"}</span></div><button class="btn soft" type="button" data-sheet="account">${accountFor(id)?.approvalStatus === "pending" ? "Save and review sign-in" : accountFor(id) ? "Save and manage sign-in" : "Save and create sign-in"}</button>${accountFor(id) ? "" : html`<button class="btn soft" type="button" data-sheet="invite">${svg("mail")}${data.invites?.[id] && !data.invites[id].used ? "Save and send a new invite" : "Save and invite to order online"}</button><p class="hint">${inviteText(id)}. The invite emails a link to choose their own username and password.</p>`}</section>` : ""}
      <section class="w-customer-card" aria-labelledby="wInternalNoteTitle"><h3 id="wInternalNoteTitle">Internal notes</h3>${field("Internal account note", html`<textarea id="wNote" maxlength="1000">${state.note || ""}</textarea>`)}${note}</section></div></div>
      <footer id="wCustomerFooter" class="w-customer-footer"><p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">Save customer</button></div></footer></form>`, async (action, element) => {
      if (action === "location-add" || action === "location-edit") {
        const draft = capture(), index = action === "location-add" ? -1 : Number(element.dataset.index);
        draft.focusLocationIndex = index;
        editCustomerLocation(id, index, draft, row);
        return;
      }
      if (action === "customer-choice") {
        const key = element.dataset.choice;
        if (!["wPaymentTerms", "wDefaultLocation", "wStatus"].includes(key)) return;
        const draft = capture(); draft.focusChoiceId = key;
        editCustomerChoice(id, key, draft, row);
        return;
      }
      if (!["submit", "account", "invite"].includes(action)) return;
      const draft = capture();
      await saveForm(form, async () => {
        const { scrollTop, focusLocationIndex, focusChoiceId, ...body } = draft;
        await api(id ? "PUT" : "POST", "/api/admin/wholesale/customers" + (id ? `/${id}` : ""), { ...body, ifVersion: row.version });
        const stillOpen = form.isConnected;
        if (stillOpen) closeSheet(); await reload();
        if (action === "account" && stillOpen) editAccount(id);
        else if (action === "invite") { const result = await sendInvites([id]); await reload(); toast(result.sent.length ? `Invite sent to ${body.email}.` : inviteSummary(result)); }
        else toast("Customer saved.");
      });
    });
    form = $("#wCustomerForm");
    let target = $("#sheetTitle");
    if (restored?.focusChoiceId) target = form.querySelector(`[data-sheet="customer-choice"][data-choice="${restored.focusChoiceId}"]`) || target;
    else if (restored) target = (restored.focusLocationIndex >= 0 ? form.querySelector(`[data-sheet="location-edit"][data-index="${restored.focusLocationIndex}"]`) : form.querySelector('[data-sheet="location-add"]')) || target;
    target.focus({ preventScroll: true }); $("#sheet").scrollTop = restored?.scrollTop || 0;
  }
  function editCustomerChoice(customerId, key, draft, row) {
    const fieldKey = { wPaymentTerms: "paymentTerms", wDefaultLocation: "defaultLocationId", wStatus: "status" }[key];
    const title = { wPaymentTerms: "Payment terms", wDefaultLocation: "Default location", wStatus: "Customer status" }[key];
    const options = key === "wPaymentTerms" ? data.paymentTermChoices.map((term) => ({ value: term.id, label: term.label, detail: term.id === "custom" ? "Add the agreed terms in payment instructions." : "" })) : key === "wDefaultLocation" ? draft.locations.filter((location) => location.id).map((location) => ({ value: location.id, label: location.name, detail: [location.address, location.postcode].filter(Boolean).join(", ") })) : [{ value: "Active", label: "Active", detail: "Approved accounts can submit new orders." }, { value: "On hold", label: "On hold", detail: "Customers can view their orders but cannot submit a new one." }];
    let cleanup = () => {};
    const back = () => { cleanup(); editCustomer(customerId, draft, row); };
    openSheet(html`<div id="wCustomerChoice" class="w-customer-choice"><header class="w-customer-choice-header"><h2 id="sheetTitle" tabindex="-1">${title}</h2><p>${draft.business || "Customer account"}</p></header><div class="w-customer-choice-body"><div class="group" role="group" aria-label="${title}">${options.map((option) => html`<button class="item w-customer-choice-option" type="button" data-sheet="customer-choice-apply" data-value="${option.value}" aria-pressed="${draft[fieldKey] === option.value}"><span class="tx"><b>${option.label}</b>${option.detail ? html`<span>${option.detail}</span>` : ""}</span><span class="w-choice-check" aria-hidden="true">${draft[fieldKey] === option.value ? svg("ok") : ""}</span></button>`)}</div>${key === "wDefaultLocation" && draft.locations.some((location) => !location.id) ? html`<p class="hint">Save new locations before choosing one as default.</p>` : ""}</div><footer class="w-customer-choice-footer"><button class="btn soft" type="button" data-sheet="customer-choice-cancel">Cancel</button></footer></div>`, (action, element) => {
      if (action === "customer-choice-cancel") { back(); return; }
      if (action !== "customer-choice-apply" || !options.some((option) => option.value === element.dataset.value)) return;
      draft[fieldKey] = element.dataset.value; back();
    });
    const panel = $("#wCustomerChoice"), controller = new AbortController(), scrim = $("#scrim");
    const observer = new MutationObserver(() => { if (!panel.isConnected) cleanup(); });
    cleanup = () => { controller.abort(); observer.disconnect(); };
    observer.observe($("#sheet"), { childList: true });
    document.addEventListener("keydown", (event) => { if (event.key !== "Escape" || !panel.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); back(); }, { capture: true, signal: controller.signal });
    scrim.addEventListener("click", (event) => { if (event.target !== scrim || !panel.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); back(); }, { capture: true, signal: controller.signal });
    $("#sheetTitle").focus({ preventScroll: true }); $("#sheet").scrollTop = 0;
  }
  function editCustomerLocation(customerId, index, draft, row) {
    if (index < 0 && draft.locations.length >= 20) { editCustomer(customerId, draft, row); toast("A customer can have up to 20 saved locations."); return; }
    const location = index < 0 ? { name: "", contact: "", phone: "", address: "", postcode: "", deliveryNotes: "" } : draft.locations[index];
    if (!location) return;
    let cleanup = () => {};
    const back = () => { cleanup(); editCustomer(customerId, draft, row); };
    openSheet(html`<form id="wLocationForm" class="w-sheet"><h2 id="sheetTitle" tabindex="-1">${index < 0 ? "Add location" : "Edit location"}</h2><p>${draft.business || "Customer location"}</p>
      ${field("Location name", html`<input id="wLocationName" maxlength="80" required value="${location.name}" placeholder="e.g. City centre café">`)}
      ${field("Contact name (optional)", html`<input id="wLocationContact" maxlength="120" value="${location.contact || ""}">`)}
      ${field("Phone (optional)", html`<input id="wLocationPhone" type="tel" maxlength="40" value="${location.phone || ""}">`)}
      ${field("Address", html`<textarea id="wLocationAddress" maxlength="500">${location.address || ""}</textarea>`)}
      ${field("Postcode", html`<input id="wLocationPostcode" maxlength="20" value="${location.postcode || ""}">`)}
      ${field("Delivery instructions", html`<textarea id="wLocationNotes" maxlength="1000">${location.deliveryNotes || ""}</textarea>`)}
      <p class="hint">Apply the location, then save the customer to keep these changes. Existing orders retain their saved address.</p><p class="err" id="wErr" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="location-cancel">Cancel</button><button class="btn" type="submit">Apply location</button></div>
      ${index > 0 ? html`<div class="w-order-danger"><button class="btn bad" type="button" data-sheet="location-remove">Remove location</button></div><div class="w-location-remove" id="wLocationRemoveConfirm" hidden><p>Remove this saved location? Existing orders keep their original location and address.</p><div class="row"><button class="btn soft" type="button" data-sheet="location-remove-cancel">Keep location</button><button class="btn bad" type="button" data-sheet="location-remove-confirm">Confirm remove location</button></div></div>` : index === 0 ? html`<p class="hint">The main location stays linked to the business contact and address.</p>` : ""}</form>`, (action) => {
      const form = $("#wLocationForm");
      if (action === "location-cancel") { back(); return; }
      if (action === "location-remove") { form.querySelector("#wLocationRemoveConfirm").hidden = false; form.querySelector('[data-sheet="location-remove-confirm"]').focus(); return; }
      if (action === "location-remove-cancel") { form.querySelector("#wLocationRemoveConfirm").hidden = true; form.querySelector('[data-sheet="location-remove"]').focus(); return; }
      if (action === "location-remove-confirm" && index > 0) {
        draft.locations.splice(index, 1);
        if (draft.defaultLocationId === location.id) draft.defaultLocationId = "primary";
        draft.focusLocationIndex = Math.max(0, index - 1); back(); return;
      }
      if (action !== "submit") return;
      const value = (id) => form.querySelector(id).value.trim();
      const updated = { ...(location.id ? { id: location.id } : {}), name: value("#wLocationName"), contact: value("#wLocationContact"), phone: value("#wLocationPhone"), address: value("#wLocationAddress"), postcode: value("#wLocationPostcode"), deliveryNotes: value("#wLocationNotes") };
      if (!updated.name) { form.querySelector("#wErr").textContent = "Add a location name."; return; }
      if (index < 0) { draft.locations.push(updated); draft.focusLocationIndex = draft.locations.length - 1; }
      else draft.locations[index] = updated;
      if (index === 0) for (const key of locationKeys) draft[key] = updated[key];
      back();
    });
    const form = $("#wLocationForm"), controller = new AbortController(), scrim = $("#scrim");
    const observer = new MutationObserver(() => { if (!form.isConnected) cleanup(); });
    cleanup = () => { controller.abort(); observer.disconnect(); };
    observer.observe($("#sheet"), { childList: true });
    document.addEventListener("keydown", (event) => { if (event.key !== "Escape" || !form.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); back(); }, { capture: true, signal: controller.signal });
    scrim.addEventListener("click", (event) => { if (event.target !== scrim || !form.isConnected) return; event.preventDefault(); event.stopImmediatePropagation(); back(); }, { capture: true, signal: controller.signal });
    $("#sheetTitle").focus({ preventScroll: true }); $("#sheet").scrollTop = 0;
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
    let form, busy = false, pendingRemoval = null, colourChoice;
    const drawPhotos = () => {
      if (!form?.isConnected) return;
      const content = html`${current.imageUrls.length ? html`<div class="w-photos">${current.imageUrls.map((url, i) => html`<div class="w-photo"><img src="${url}" alt="${current.title} photo ${i + 1}"><button class="btn sm soft" type="button" data-sheet="photo-remove" data-ref="${current.images[i]}" aria-label="Remove photo ${i + 1}">Remove</button>${pendingRemoval === current.images[i] ? html`<div class="w-photo-confirm" role="group" aria-label="Remove this photo"><p>Remove this uploaded photo?</p><button class="btn sm bad" type="button" data-sheet="photo-confirm" data-ref="${current.images[i]}">Confirm remove photo</button><button class="btn sm soft" type="button" data-sheet="photo-keep">Keep photo</button></div>` : ""}</div>`)}</div>` : html`<p class="hint">No photos yet.</p>`}${current.sourceImage && !current.images.includes("source:" + current.image) ? html`<button class="btn sm soft" type="button" data-sheet="photo-restore">Restore original photo</button>` : ""}`;
      put(form.querySelector('#wPhotos'), content);
    };
    const defaultOptions = [["beans", "Beans", "Whole beans, for your own grinder"], ["espresso", "Fine", "Commercial espresso machine"], ["filter", "Medium", "Filter"], ["cafetiere", "Coarse", "Cafetiere and batch brewers"]].map(([id, label, hint]) => ({ id, label, hint, enabled: true }));
    const grindRow = option => html`<div class="w-grind-row" data-grind-id="${option.id}"><label class="field"><span class="fl">Grind name</span><input data-grind-label value="${option.label}" maxlength="60" required></label><label class="field"><span class="fl">What it's for (optional)</span><input data-grind-hint value="${option.hint || ""}" maxlength="120" placeholder="e.g. Commercial espresso machine"></label><label class="w-grind-enabled"><input type="checkbox" data-grind-enabled ${option.enabled ? raw("checked") : ""}>Available</label><button type="button" class="btn soft sm" data-sheet="grind-remove" aria-label="Remove ${option.label}">${svg("x")}</button></div>`;
    const others = data.products.filter((p) => p.id !== current.id);
    const recipeRow = (part) => html`<div class="w-recipe-row" data-recipe><label class="field"><span class="fl">Coffee</span><select data-recipe-coffee><option value="">Another coffee (type its name)</option>${others.map((p) => html`<option value="${p.id}" ${p.id === part.coffee ? raw("selected") : ""}>${p.name || p.title}</option>`)}</select></label><label class="field" ${part.coffee ? raw("hidden") : ""}><span class="fl">Name</span><input data-recipe-name value="${part.coffee ? "" : part.name || ""}" maxlength="80" placeholder="e.g. Brazil Cerrado"></label><label class="field w-recipe-pc"><span class="fl">%</span><input data-recipe-percent type="number" min="1" max="100" step="1" inputmode="numeric" value="${part.percent || ""}" required></label><button type="button" class="btn soft sm" data-sheet="recipe-remove" aria-label="Remove this part">${svg("x")}</button></div>`;
    openSheet(html`<form id="wCoffeeForm" class="w-sheet"><h2 id="sheetTitle">${id ? "Edit coffee" : "Add coffee"}</h2>
      ${field("Product name", html`<input id="wCoffeeTitle" value="${current.title}" maxlength="180" required>`)}
      ${field("Short name (optional)", html`<input id="wCoffeeName" value="${current.name}" maxlength="120" placeholder="For catalogue cards">`)}
      ${field("Origin", html`<input id="wCoffeeOrigin" value="${current.origin}" maxlength="100">`)}
      ${field("Process", html`<input id="wCoffeeProcess" value="${current.process}" maxlength="120">`)}
      ${field("Tasting notes", html`<textarea id="wCoffeeNotes" maxlength="400">${current.notes}</textarea>`)}
      ${field("Photo label (optional)", html`<input id="wCoffeeBadge" value="${current.badge}" maxlength="60" placeholder="e.g. Natural">`)}
      <fieldset class="w-categories"><legend>Categories</legend>${[["single-origin","Single origin"],["blend","Blend"],["decaf","Decaf"]].map(([key,label]) => html`<label><input type="checkbox" name="coffeeCategory" value="${key}" ${current.categories.includes(key) ? raw("checked") : ""}>${label}</label>`)}</fieldset>
      ${[["quarter", "250 g bag (£)"], ["kilo", "1 kg bag (£)"]].map(([key, label]) => field(label, html`<input id="wPrice-${key}" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required value="${id ? (current.prices[key] / 100).toFixed(2) : ""}">`))}
      <div class="checks"><label><input id="wActive" type="checkbox" ${current.active ? raw("checked") : ""}>Visible in catalogue</label><label><input id="wInStock" type="checkbox" ${current.inStock ? raw("checked") : ""}>In stock</label></div><p class="hint">Out-of-stock coffees remain visible but cannot be ordered. Hidden coffees are removed from the ordering list.</p>
      <section aria-labelledby="wWlTitle"><h3 id="wWlTitle">White label</h3><div class="checks"><label><input id="wWhiteLabel" type="checkbox" ${current.whiteLabel?.length ? raw("checked") : ""}>White-label coffee for chosen businesses</label></div><p class="hint">Only the businesses ticked here see and order it, listed first as "Your coffee", at the prices above. Everyone else never sees it.</p>
        <div id="wWlPick" ${current.whiteLabel?.length ? "" : raw("hidden")}><label class="field"><span class="fl">Find a business</span><input id="wWlSearch" type="search" autocomplete="off" placeholder="Business name"></label><p class="hint" id="wWlCount" aria-live="polite"></p><div id="wWlList" class="w-wl-list" role="group" aria-label="Businesses this coffee belongs to"><p class="hint">Loading businesses…</p></div></div></section>
      <section aria-labelledby="wRecipeTitle"><h3 id="wRecipeTitle">Made from</h3><p class="hint">What this coffee or blend is made of, for wholesale staff: shown on orders, packing sheets and Bags to process, never to customers. Leave empty for a single coffee.</p><div id="wRecipe">${(current.recipe || []).map(recipeRow)}</div><p class="hint" id="wRecipeTotal" aria-live="polite"></p><button class="btn soft" type="button" data-sheet="recipe-add">${svg("plus")}Add a coffee</button></section>
      <section aria-labelledby="wColourTitle"><h3 id="wColourTitle">Packaging colour</h3><p class="hint" id="wColourSource"></p><div class="w-colour-row"><span class="w-coffee-swatch w-coffee-swatch-lg" id="wColourPreview" aria-hidden="true"></span>${[["A", "Colour"], ["B", "Second colour"]].map(([key, label]) => html`<div class="w-colour-pick" id="wColourPick${key}"><span class="fl">${label}</span><span class="w-colour-inputs"><input type="color" id="wColour${key}" aria-label="${label}"><input id="wColour${key}Hex" type="text" maxlength="7" placeholder="#4B8E68" autocapitalize="characters" spellcheck="false" autocomplete="off" aria-label="${label} hex code"></span></div>`)}</div>
      <div class="checks"><label><input id="wColourTwo" type="checkbox">Two colours (shown as stripes)</label><label><input id="wColourStriped" type="checkbox">Striped, to tell it from a similar colour</label></div><button class="btn soft sm" type="button" data-sheet="colour-reset">Use the packaging or automatic colour</button></section>
      <section aria-labelledby="wGrindTitle"><h3 id="wGrindTitle">Grind options</h3><p class="hint">Choose the names and options customers can order for this coffee. Keep at least one available. Changes save with the coffee; existing orders keep their original details.</p><div id="wGrindOptions">${(current.grindOptions || defaultOptions).map(grindRow)}</div><button class="btn soft" type="button" data-sheet="grind-add">${svg("plus")}Add grind option</button></section>
      <h3>Photos</h3><div id="wPhotos"></div>${id ? html`<label class="field"><span class="fl">Add photos</span><input id="wPhotoFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="hint">Photos save immediately. Up to six per coffee. JPEG, PNG or WebP, up to 5 MB each.</p><button class="btn soft" type="button" data-sheet="photo-upload">Upload photos</button>` : html`<p class="hint">Save the coffee, then add its photos.</p>`}
      ${buttons(id ? "Save coffee" : "Add coffee")}</form>`, async (action, element) => {
      if (busy) return;
      if (action === "grind-add") {
        if (form.querySelectorAll("[data-grind-id]").length >= 20) { form.querySelector("#wErr").textContent = "Each coffee supports up to 20 grind options."; return; }
        const holder = document.createElement("div"); put(holder, grindRow({ id: "grind-" + crypto.randomUUID(), label: "", enabled: true }));
        const row = holder.firstElementChild; form.querySelector("#wGrindOptions").append(row); row.querySelector("input").focus(); return;
      }
      if (action === "grind-remove") { element.closest("[data-grind-id]").remove(); return; }
      if (action === "colour-reset") { colourChoice = null; drawColour(); return; }
      if (action === "recipe-add") { if (form.querySelectorAll("[data-recipe]").length >= 10) { form.querySelector("#wErr").textContent = "A recipe has up to 10 parts."; return; } const holder = document.createElement("div"); put(holder, recipeRow({ percent: "" })); form.querySelector("#wRecipe").append(holder.firstElementChild); drawRecipe(); form.querySelector("#wRecipe [data-recipe]:last-child select").focus(); return; }
      if (action === "recipe-remove") { element.closest("[data-recipe]").remove(); drawRecipe(); return; }
      if (!["submit", "photo-upload", "photo-remove", "photo-confirm", "photo-keep", "photo-restore"].includes(action)) return;
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
          const prices = Object.fromEntries(["quarter", "kilo"].map((key) => [key, Math.round(Number(value("#wPrice-" + key)) * 100)]));
          const whiteLabel = form.querySelector("#wWhiteLabel").checked ? [...chosen] : [];
          if (form.querySelector("#wWhiteLabel").checked && !whiteLabel.length) throw new Error("Tick the businesses this white-label coffee belongs to.");
          const recipe = readRecipe();
          if (recipe.length && recipe.reduce((t, p) => t + p.percent, 0) !== 100) throw new Error("The recipe's percentages need to add up to 100.");
          const result = await api(id ? "PUT" : "POST", "/api/admin/wholesale/catalogue" + (id ? "/" + current.id : ""), { ifVersion: current.version, title: value('#wCoffeeTitle'), name: value('#wCoffeeName') || value('#wCoffeeTitle'), origin: value('#wCoffeeOrigin'), process: value('#wCoffeeProcess'), notes: value('#wCoffeeNotes'), badge: value('#wCoffeeBadge'), categories: [...form.querySelectorAll('[name="coffeeCategory"]:checked')].map(input => input.value), grindOptions: [...form.querySelectorAll("[data-grind-id]")].map(row => ({ id: row.dataset.grindId, label: row.querySelector("[data-grind-label]").value.trim(), hint: row.querySelector("[data-grind-hint]").value.trim(), enabled: row.querySelector("[data-grind-enabled]").checked })), prices, active: form.querySelector('#wActive').checked, inStock: form.querySelector('#wInStock').checked, whiteLabel, recipe, ...(colourChoice === undefined ? {} : colourChoice === null ? { colours: null } : colourChoice) });
          const stillOpen = form.isConnected;
          if (stillOpen) closeSheet();
          await reload(); toast(id ? "Coffee saved." : "Coffee added. You can now add photos.");
          if (!id && stillOpen) editCoffee(result.product.id);
        }
      } catch (error) { if (form.isConnected) { form.querySelector('#wErr').textContent = error.message; form.querySelector('#wErr').scrollIntoView({ block: "nearest" }); } else toast(error.message); }
      finally { busy = false; form.removeAttribute("aria-busy"); drawPhotos(); buttons.forEach((button) => { if (button.isConnected) button.disabled = false; }); }
    });
    form = $('#wCoffeeForm');
    // White label: the businesses it belongs to (all of them listed, searchable; ticked ones first).
    const chosen = new Set(current.whiteLabel || []);
    let names = null;
    const drawBusinesses = () => {
      if (!form.isConnected || !names) return;
      const q = form.querySelector("#wWlSearch").value.trim().toLowerCase();
      const shown = names.filter((c) => !q || c.business.toLowerCase().includes(q)).sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id))).slice(0, 80);
      put(form.querySelector("#wWlList"), shown.length ? html`${shown.map((c) => html`<label><input type="checkbox" data-wl value="${c.id}" ${chosen.has(c.id) ? raw("checked") : ""}>${c.business || "Unnamed business"}</label>`)}` : html`<p class="hint">No business matches.</p>`);
      const picked = names.filter((c) => chosen.has(c.id)).map((c) => c.business);
      form.querySelector("#wWlCount").textContent = picked.length ? `For ${picked.join(", ")}` : "No businesses ticked yet.";
    };
    const loadBusinesses = async () => {
      if (names) return drawBusinesses();
      try { names = (await api("GET", "/api/admin/wholesale/customers/names")).customers; drawBusinesses(); }
      catch (error) { if (form.isConnected) put(form.querySelector("#wWlList"), html`<p class="hint">${error.message}</p>`); }
    };
    form.querySelector("#wWhiteLabel").addEventListener("change", (event) => { form.querySelector("#wWlPick").hidden = !event.target.checked; if (event.target.checked) loadBusinesses(); });
    form.querySelector("#wWlSearch").addEventListener("input", drawBusinesses);
    form.querySelector("#wWlList").addEventListener("change", (event) => { const box = event.target.closest("[data-wl]"); if (!box) return; box.checked ? chosen.add(box.value) : chosen.delete(box.value); const picked = names.filter((c) => chosen.has(c.id)).map((c) => c.business); form.querySelector("#wWlCount").textContent = picked.length ? `For ${picked.join(", ")}` : "No businesses ticked yet."; });
    if (chosen.size) loadBusinesses();
    // Made from: coffees from the catalogue, or a typed name, with whole percentages adding up to 100.
    function readRecipe() {
      return [...form.querySelectorAll("[data-recipe]")].map((row) => {
        const coffee = row.querySelector("[data-recipe-coffee]").value, product = others.find((p) => p.id === coffee);
        return { ...(coffee ? { coffee } : {}), name: product ? (product.name || product.title) : row.querySelector("[data-recipe-name]").value.trim(), percent: Math.round(Number(row.querySelector("[data-recipe-percent]").value)) };
      });
    }
    function drawRecipe() {
      if (!form.isConnected) return;
      form.querySelectorAll("[data-recipe]").forEach((row) => { row.querySelector("[data-recipe-name]").closest(".field").hidden = !!row.querySelector("[data-recipe-coffee]").value; });
      const parts = readRecipe(), total = parts.reduce((t, p) => t + (p.percent || 0), 0);
      form.querySelector("#wRecipeTotal").textContent = parts.length ? (total === 100 ? `Adds up to 100%: ${parts.map((p) => `${p.percent}% ${p.name || "…"}`).join(" · ")}` : `Adds up to ${total}%. Make it 100%.`) : "";
    }
    form.querySelector("#wRecipe").addEventListener("input", drawRecipe);
    form.querySelector("#wRecipe").addEventListener("change", drawRecipe);
    drawRecipe();
    // Packaging colour: unchanged (undefined) keeps what the coffee has; null goes back to the packaging/automatic colour.
    const hexOk = value => /^#[0-9a-f]{6}$/i.test(value);
    const currentColour = () => coffeeColour(colourChoice === null ? { ...current, colours: undefined, title: form.querySelector("#wCoffeeTitle").value } : colourChoice ? colourChoice : { ...current, title: form.querySelector("#wCoffeeTitle").value });
    function drawColour() {
      const shown = currentColour(), two = shown.colours.length > 1;
      form.querySelector("#wColourPreview").setAttribute("style", "--w-coffee:" + coffeeFill(shown));
      for (const [key, value] of [["A", shown.colours[0]], ["B", shown.colours[1] || shown.colours[0]]]) {
        form.querySelector("#wColour" + key).value = value.toLowerCase();
        if (document.activeElement !== form.querySelector("#wColour" + key + "Hex")) form.querySelector("#wColour" + key + "Hex").value = value.toUpperCase();
      }
      form.querySelector("#wColourTwo").checked = two; form.querySelector("#wColourPickB").hidden = !two;
      form.querySelector("#wColourStriped").checked = !two && shown.striped; form.querySelector("#wColourStriped").disabled = two;
      form.querySelector("#wColourSource").textContent = colourChoice ? "Shown beside this coffee in packing lists and the catalogue. Saves with the coffee." : shown.source === "saved" ? "Set in Admin. Shown beside this coffee in packing lists and the catalogue." : shown.source === "packaging" ? "From the packaging. Change it here if you need to." : "Picked automatically so it stands apart. Type the packaging’s hex code here when you have it.";
    }
    function pickColour(event) {
      const t = event.target; if (!t.closest?.(".w-colour-row, .checks") || !/^wColour/.test(t.id)) return;
      if (t.id.endsWith("Hex")) { const v = t.value.trim().replace(/^([0-9a-f]{6})$/i, "#$1"); if (!hexOk(v)) return; form.querySelector("#" + t.id.slice(0, -3)).value = v.toLowerCase(); }
      const a = form.querySelector("#wColourA").value.toUpperCase(), b = form.querySelector("#wColourB").value.toUpperCase(), two = form.querySelector("#wColourTwo").checked;
      colourChoice = { colours: two ? [a, b] : [a], colourStyle: two || form.querySelector("#wColourStriped").checked ? "striped" : "solid" };
      drawColour();
    }
    form.addEventListener("input", event => { if (event.target.id === "wCoffeeTitle" && colourChoice === undefined) drawColour(); else pickColour(event); });
    form.addEventListener("change", pickColour);
    drawColour();
    drawPhotos();
  }
  return {
    view,
    navigation,
    syncNavigation,
    selectSection,
    currentSection: () => tab,
    async act(name, id) {
      if (name.startsWith("wh-invoice-")) { await invoiceUI.act(name, id); return; }
      if (name.startsWith("wh-ins-")) { await insightsUI.act(name, id); return; }
      if (name === "wh-order-emails") { await openOrderEmails(); return; }
      if (name === "wh-print-new") { await printUI.printOrders(printUI.scopes.New); return; }
      if (name === "wh-totals") { await printUI.openTotals(picking ? [...picked] : []); return; }
      if (name === "wh-pick-start" || name === "wh-pick-done") { picking = name === "wh-pick-start"; picked.clear(); await reload(); return; }
      if (name === "wh-pick" && id) { picked.has(id) ? picked.delete(id) : picked.add(id); refreshPicks(); return; }
      if (name === "wh-pick-all") { for (const row of data.orders) picked.add(row.id); refreshPicks(); return; }
      if (name === "wh-print-picked" && picked.size) { await printUI.printOrders({ ids: [...picked], label: `${picked.size} selected ${picked.size === 1 ? "order" : "orders"}` }); return; }
      if (name === "wh-import-customers") { openCustomerImport(); return; }
      if (name === "wh-invite-customers") { await openInvites(); return; }
      if (name === "wh-tab" && selectSection(id)) await reload();
      if (name === "wh-status" && ["all", ...data.statuses].includes(id)) { clearTimeout(timer); status = id; orderPages = 1; await reload(); }
      if (name === "wh-approval" && ["all", "pending"].includes(id)) { clearTimeout(timer); approval = id; customerPages = 1; await reload(); }
      if (name === "wh-pending") { selectSection("customers", { pending: true }); await reload(); }
      if (name === "wh-clear") { clearTimeout(timer); query = ""; status = approval = "all"; orderPages = customerPages = 1; await reload(); $("#wq")?.focus({ preventScroll: true }); }
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
