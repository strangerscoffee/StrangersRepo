// Native Admin → Wholesale view. Uses the admin shell, escaped templates and shared D1 wholesale APIs.
window.WholesaleAdmin = function ({ api, html, raw, svg, put, head, openSheet, closeSheet, reload, toast, onNavigationChange = () => {}, onSectionChange = () => {} }) {
  const $ = (selector) => document.querySelector(selector);
  const wideOrders = matchMedia("(min-width:1340px)");
  const packing = window.SCWholesalePacking;
  const invoiceUI = window.WholesaleInvoices({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast });
  const printUI = window.WholesalePrint({ api, html, raw, svg, put, openSheet, closeSheet, toast });
  const insightsUI = window.WholesaleInsights({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast });
  const tabsUI = window.WholesaleTabs({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast });
  // Picking orders to print: while on, tapping an order ticks it instead of opening it.
  let picking = false; const picked = new Set();
  // Batch actions on the picked orders: {status, confirm} while asking, {running, done, total} while saving.
  let batch = null;
  const FLOW = ["New", "Preparing", "Ready", "Dispatched"];
  const movable = (row, to) => row.preview === false && FLOW.includes(row.status) && FLOW.indexOf(row.status) < FLOW.indexOf(to);
  const wholesaleMenus = ".w-print-menu[open], .w-order-settings[open], .ins-tools[open]";
  document.addEventListener("click", event => {
    for (const menu of document.querySelectorAll(wholesaleMenus)) {
      if (!menu.contains(event.target)) menu.open = false;
      else if (event.target.closest("[data-act]")) {
        menu.open = false;
        menu.querySelector("summary").focus({ preventScroll: true });
      }
    }
  });
  document.addEventListener("focusin", event => {
    for (const menu of document.querySelectorAll(wholesaleMenus)) if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", event => {
    const menu = $(wholesaleMenus);
    if (event.key === "Escape" && menu) {
      menu.open = false;
      menu.querySelector("summary").focus({ preventScroll: true });
    }
  });
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  const weight = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const shortId = (id) => id.slice(0, 20);
  const date = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", year: "numeric", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let tab = "orders", status = wideOrders.matches ? "open" : "all", approval = "all", query = "", data = null, timer, sequence = 0, emailDraft = null, emailHealthToken = 0;
  let orderQueue = "", previewOrder = "", packingOrder = "", hideOrderPreview = false;
  // Orders list newest first by default (the owner's request, 23 Nov 2026), on every screen; the column headings change
  // it. The Dispatched list keeps newest dispatched first unless a heading is tapped (sortChosen).
  let dispatchScope = "all", orderSort = "ordered", sortChosen = false, packingSession = 0;
  wideOrders.addEventListener("change", () => {
    if (!$("#wOrdersTitle")) return;
    if (!wideOrders.matches && status === "open") status = "all";
    orderPages = 1;
    reload();
  });
  let orderPages = 1, customerPages = 1, loadingMore = false;
  const sectionGroups = [
    ["Order management", [["orders", "Orders", "doc"], ["customers", "Customers", "people"], ["tabs", "Tabs", "db"]]],
    ["Catalogue and reporting", [["catalogue", "Coffee catalogue", "coffee"], ["custom", "Custom coffees", "pen"], ["invoices", "Invoicing", "doc"], ["insights", "Insights", "pulse"]]],
  ];
  const sections = sectionGroups.flatMap(([, group]) => group);
  const pendingReviews = () => data?.stats?.pendingAccounts ?? data?.accounts?.filter((row) => row.approvalStatus === "pending").length ?? 0;
  function navigation({ active = true } = {}) {
    const pending = pendingReviews();
    return html`${sections.map(([id, label]) => html`<span class="nav-wholesale-item"><button class="nav nav-wholesale-child" type="button" data-act="wh-tab" data-id="${id}" aria-current="${active && tab === id ? "page" : "false"}">${label}</button>${id === "customers" && pending > 0 ? html`<button class="nav-wholesale-review" type="button" data-act="wh-pending" aria-label="${pending} ${pending === 1 ? "account awaits" : "accounts await"} review">${pending}</button>` : ""}</span>`)}`;
  }
  function openNavigation(opener, onSelect) {
    openSheet(html`<div class="w-section-list">
      <div class="w-section-handle" aria-hidden="true"></div>
      <div class="w-section-head"><h2 id="sheetTitle">Wholesale sections</h2><button class="w-section-close" type="button" data-sheet="close" aria-label="Close sections">${svg("x")}</button></div>
      ${sectionGroups.map(([title, group]) => html`<section class="w-section-group" aria-label="${title}">
        <h3 class="side-label">${title}</h3>
        <div class="group">
          ${group.map(([id, label, icon]) => html`<button class="item" type="button" data-sheet="${id}" aria-current="${tab === id ? "page" : "false"}">${svg(icon)}<span>${label}</span>${tab === id ? svg("ok") : ""}</button>`)}
        </div>
      </section>`)}
    </div>`, (id) => {
      closeSheet();
      if (id !== tab) return onSelect(id);
    }, opener);
  }
  function syncNavigation(desktop) {
    const checklist = $("#wPackChecklist");
    if (tab === "orders" && checklist && !checklist.hasChildNodes()) mountPacking(checklist);
    const stages = $(".w-preview-stages");
    if (stages && !stages.hasChildNodes()) mountStages(stages);
    const host = $("#wSectionsHost");
    if (!host) return;
    const pending = pendingReviews();
    const key = JSON.stringify([desktop, tab, pending]);
    if (host.dataset.navigation === key) return;
    host.dataset.navigation = key; host.hidden = desktop;
    const current = sections.find(([id]) => id === tab)?.[1];
    put(host, desktop ? html`` : html`
      <div class="w-section-picker">
        <button id="wSection" class="glass" type="button" data-act="wh-sections" aria-haspopup="dialog" aria-controls="sheet">
          ${svg("grid")}<span class="w-section-label">Wholesale section</span><span class="w-section-value">${current}</span>${svg("chev")}
        </button>
        ${pending ? html`<button class="btn sm soft" type="button" data-act="wh-pending">${pending} awaiting review</button>` : ""}
      </div>`);
  }
  function workspaceState() {
    return { tab, status, approval, query, orderQueue, orderPages, customerPages, previewOrder, packingOrder, hideOrderPreview, dispatchScope, orderSort, sortChosen, invoices: invoiceUI.state(), insights: insightsUI.state() };
  }
  function restoreWorkspace(saved) {
    if (!saved || !sections.some(([id]) => id === saved.tab)) return;
    clearTimeout(timer);
    ({ tab, status, approval, query, orderQueue, orderPages, customerPages, previewOrder, packingOrder, hideOrderPreview, dispatchScope, orderSort, sortChosen = false } = saved);
    invoiceUI.restore(saved.invoices); insightsUI.restore(saved.insights);
  }

  function selectSection(id, { pending = false, queue = "", resetStatus = false } = {}) {
    if (!sections.some(([value]) => value === id)) return false;
    clearTimeout(timer); tab = id; query = ""; previewOrder = packingOrder = ""; dispatchScope = "all"; invoiceUI.resetList(); approval = pending && id === "customers" ? "pending" : "all"; orderPages = customerPages = 1;
    orderQueue = id === "orders" && ["prepare", "ready", "due-prepare", "due-ready"].includes(queue) ? queue : "";
    if (orderQueue || resetStatus) status = "all";
    onNavigationChange(); return true;
  }
  const quickBusy = new Set(), orderErrors = new Map();
  const nextStatus = (row) => row.preview === false ? ({ New: "Preparing", Preparing: "Ready", Ready: "Dispatched" }[row.status] || null) : null;
  const customer = (id) => data.customers.find((row) => row.id === id);
  const isCustomCoffee = (coffee) => coffee.customerOnly === true || !!coffee.whiteLabel?.length;
  const assignedNames = (coffee) => (coffee.whiteLabel || []).map(id => (data.customerNames || data.customers).find(row => row.id === id)?.business).filter(Boolean);
  const accountFor = (id) => data.accounts.find((row) => row.customerId === id);
  const pill = (value) => html`<span class="pill ${["New", "Pending review", "Out of stock", "Needs customers"].includes(value) ? "warn" : ["Ready", "Active", "In stock"].includes(value) ? "ok" : ["Cancelled", "On hold", "Declined"].includes(value) ? "bad" : ""}">${value}</span>`;
  // Dispatch day and standing order (src/wholesaleStanding.ts).
  const EVERY = [[1, "Every week"], [2, "Every 2 weeks"], [4, "Every 4 weeks"]];
  const today = () => window.SC?.londonToday?.() || new Date().toISOString().slice(0, 10);
  const day = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const everyText = (n) => n === 1 ? "every week" : `every ${n} weeks`;
  const scheduleOf = (form) => form.querySelector("#wDispatchDate") ? { dispatchDate: form.querySelector("#wDispatchDate").value || null, every: form.querySelector("#wStanding").checked ? Number(form.querySelector("#wEvery").value) : 0 } : undefined;
  const draftOf = (form, row) => ({ status: form.querySelector("#wStatus").value, customerId: row.preview === false ? row.customerId : form.querySelector("#wCustomer").value || null, note: form.querySelector("#wNote").value, trackingUrl: form.querySelector("#wTrackingUrl").value, schedule: scheduleOf(form) });
  // "250 g £6.50 · 1 kg £21.50", or "1 kg bags only £21.50" for a coffee sold in one size.
  const sizesText = (p) => p.packs?.length === 1 ? (p.packs[0] === "kilo" ? `1 kg bags only ${money(p.prices.kilo)}` : `250 g bags only ${money(p.prices.quarter)}`) : `250 g ${money(p.prices.quarter)} · 1 kg ${money(p.prices.kilo)}`;
  const field = (label, input) => html`<label class="field"><span class="fl">${label}</span>${input}</label>`;
  const buttons = (label) => html`<p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">${label}</button></div>`;
  const editorHead = (title, close = "") => html`<header class="w-editor-head"><h2 id="sheetTitle" tabindex="-1">${title}</h2>${close ? html`<button class="btn soft" type="button" data-sheet="close" aria-label="${close}">${svg("x")}</button>` : ""}</header>`;
  const note = html`<p class="hint">Manage payment and invoicing according to the customer’s agreed terms.</p>`;
  const {grindFor,decafLine,coffeeColour,coffeeFill,coffeeStyle} = window.SCWholesalePreparation;
  const matches = (value) => value.toLowerCase().includes(query.toLowerCase().trim());
  const minimumKg = () => `${(data?.minimumOrderGrams || 6000) / 1000} kg`;
  const termsFor = (row) => data.paymentTermChoices.find((term) => term.id === row.paymentTerms)?.label || "To be agreed";
  const search = (label, placeholder) => html`<label class="search">${svg("search")}<input id="wq" type="search" maxlength="120" aria-label="${label}" placeholder="${placeholder}" value="${query}"></label>`;
  const resultCount = (loaded, total, noun) => `${loaded < total ? loaded + " of " + total : total} ${total === 1 ? noun : noun + "s"}`;
  const emptyState = (icon, title, text, filtered = false) => html`<div class="w-empty"><span class="ic mut">${svg(icon)}</span><h3>${title}</h3><p>${text}</p>${filtered ? html`<button class="btn soft" type="button" data-act="wh-clear">Clear filters</button>` : ""}</div>`;
  function listing(id, title, count, tools, contents, footer, actions = "") {
    const orders = id === "wOrdersTitle";
    const heading = html`<h2 id="${id}">${title}</h2>`;
    const result = html`<span class="w-result-count">${count}</span>`;
    return html`<section class="w-list-panel glass ${orders ? "w-orders-panel" : ""}" aria-labelledby="${id}"><header class="w-list-header">
      ${orders ? html`<div class="w-queue-heading">${heading}${result}</div>` : heading}
      <div class="w-header-actions">${orders ? "" : result}${actions}</div></header><div class="w-panel-tools">${tools}${query.trim() || (tab === "orders" && (!["all","open"].includes(status) || orderQueue || dispatchScope !== "all")) || (tab === "customers" && approval !== "all") ? html`<div class="w-active-filters"><span>Filtered results${orderQueue ? ` · Customer orders: ${orderQueue.endsWith("prepare") ? "to prepare" + (orderQueue.startsWith("due-") ? " today" : "") : "ready to dispatch" + (orderQueue.startsWith("due-") ? " today" : "")}` : ""}${query.trim() ? ` · “${query.trim()}”` : ""}</span><button class="btn sm soft" type="button" data-act="wh-clear">Clear filters</button></div>` : ""}</div><div class="group w-record-list">${contents}</div>${footer}</section>`;
  }
  const merge = (first, next) => [...new Map([...first, ...next].map((row) => [row.id, row])).values()];
  const packingRow = id => data?.orders.find(order => order.id === id) || (data?.packingSelection?.id === id ? data.packingSelection : null);

  async function pages(snapshot, kind, requested, filter) {
    const params = new URLSearchParams();
    if (kind === "orders" && filter.queue) params.set("queue", filter.queue);
    if (filter.query.trim()) params.set("q", filter.query.trim());
    if (kind === "orders" && filter.status !== "all") params.set("status", filter.status);
    if (kind === "orders" && filter.dispatch !== "all") params.set("dispatch", filter.dispatch);
    if (kind === "orders" && filter.sort !== "updated" && !(filter.status === "Dispatched" && !filter.sortChosen)) params.set("sort", filter.sort);
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
    const current = ++sequence, section = tab, filter = { query, status, approval, queue: orderQueue, dispatch: dispatchScope, sort: orderSort, sortChosen };
    const snapshot = await api("GET", "/api/admin/wholesale");
    if (section === "orders" || section === "customers") {
      const result = await pages(snapshot, section, section === "orders" ? orderPages : customerPages, filter);
      snapshot[section] = result.rows; snapshot.accounts = result.accounts;
      snapshot.nextCursor = result.cursor; snapshot.matchingCount = result.count;
      const active = section === "orders" && ($("#wPackSheet")?.dataset.id || packingOrder);
      if (active && !result.rows.some(row => row.id === active)) {
        const { orders } = await api("GET", "/api/admin/wholesale/orders?q=" + encodeURIComponent(active));
        snapshot.packingSelection = orders.find(row => row.id === active);
      }
    }
    if (section === "custom") snapshot.customerNames = (await api("GET", "/api/admin/wholesale/customers/names")).customers;
    if (section === "customers") snapshot.invites = (await api("GET", "/api/admin/wholesale/customers/invites")).invites;
    if (current !== sequence) return html``;
    data = snapshot;
    onNavigationChange();
    const sensitive = section === "insights" || section === "invoices";
    document.documentElement.toggleAttribute("data-w-sensitive", sensitive);
    return html`<div class="w-workspace w-operations">${head(section === "orders" ? wideOrders.matches ? "Wholesale orders" : "Wholesale" : sections.find(([id]) => id === section)[1], "", sensitive ? privacyToggle() : undefined)}
      <div id="wSectionsHost" class="w-sections-host" hidden></div>
      <div class="w-content${sensitive ? " w-sensitive" : ""}">${section === "orders" ? orders() : section === "customers" ? customers() : section === "invoices" ? await invoiceUI.view() : section === "insights" ? await insightsUI.view() : section === "tabs" ? await tabsUI.view() : catalogue()}</div></div>`;
  }

  function more(kind) {
    return data.nextCursor ? html`<div class="w-more"><button class="btn soft" type="button" data-act="wh-more" data-id="${kind}">Load more ${kind}</button></div>` : "";
  }
  function orders() {
    const rows = data.orders, filtered = !!query.trim() || status !== "all" || !!orderQueue || dispatchScope !== "all";
    if (!packingRow(previewOrder)) { previewOrder = rows[0]?.id || ""; packingOrder = ""; }
    const canPrintShown = rows.length > 0 && rows.length <= 200;
    const counts = data.stats?.statusCounts;
    const allCount = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : data.counts.order;
    const hasNew = counts ? (counts.New || 0) > 0 : true;
    const hasPreparation = counts ? (counts.New || 0) + (counts.Preparing || 0) > 0 : true;
    const queues = wideOrders.matches ?
      [["open", "Open orders", data.stats?.openOrders || 0], ["prepare", "To pack", data.stats?.toPrepare || 0], ["ready", "Ready to go", data.stats?.ready || 0]] :
      [["prepare", "To prepare", data.stats?.toPrepare || 0], ["ready", "Ready to dispatch", data.stats?.ready || 0], ["", "All orders", allCount]];
    const queueControls = html`<div class="w-queue-controls" role="group" aria-label="Order queues">${queues.map(([value, label, count]) => html`<button class="btn sm soft" type="button" data-act="wh-queue" data-id="${value}" aria-pressed="${value === "open" ? status === "open" : orderQueue === value && status === "all"}">${label}${dispatchScope === "all" ? html` <span class="w-status-count">${count}</span>` : ""}</button>`)}${data.standingIssues?.length ? html`<button class="btn sm soft" type="button" data-act="wh-review-queue">Needs review</button>` : ""}</div>`;
    const countStatus = value => value === "all" ? allCount : value === "open" ? data.stats?.openOrders : counts?.[value];
    const statusChoices = ["all", ...(wideOrders.matches ? ["open"] : []), ...data.statuses];
    const statusLabel = value => value === "all" ? "All orders" : value === "open" ? "Open orders" : value;
    const dispatch = html`<label class="w-dispatch-scope"><span>Dispatch date</span><select id="wDispatchScope" aria-label="Dispatch date">${[["all","All dates"],["today","Today"],["upcoming","Upcoming"]].map(([id,label]) => html`<option value="${id}" ${dispatchScope === id ? raw("selected") : ""}>${label}</option>`)}</select></label>`;
    const tools = html`${queueControls}${data.standingIssues?.length ? html`<div class="w-order-feedback" id="wStandingIssues" role="status"><b>${data.standingIssues[0].count} standing ${data.standingIssues[0].count === 1 ? "delivery needs" : "deliveries need"} review</b><p>The next delivery is paused. Check the business account and available coffee, size and grind before retrying.</p><div class="toolbar">${data.standingIssues.slice(0, 5).map(issue => html`<button class="btn sm soft" type="button" data-act="wh-standing-review" data-id="${issue.id}">Review ${issue.business || "standing order"}</button>`)}</div></div>` : ""}<div class="w-order-toolbar"><div class="toolbar">${search("Search wholesale orders", "Search orders")}${dispatch}</div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Order status">${statusChoices.map(value => html`<button type="button" data-act="wh-status" data-id="${value}" aria-pressed="${status === value}">${statusLabel(value)}${dispatchScope === "all" && countStatus(value) > 0 ? html`<span class="w-status-count">${countStatus(value)}</span>` : ""}</button>`)}</div></div>
      ${wideOrders.matches ? html`<select class="w-status-select" id="wOrderStatus" aria-label="Order status">${statusChoices.map(value => html`<option value="${value}" ${status === value ? raw("selected") : ""}>${statusLabel(value)}</option>`)}</select>` : ""}
      ${picking ? html`<div class="w-print-bar w-picking" role="region" aria-label="Choose orders"><span class="w-picked-count" aria-live="polite">${picked.size ? `${picked.size} selected` : "Tap orders to select them"}</span><button class="btn sm soft" type="button" data-act="wh-pick-all">Select all shown</button><button class="btn sm soft" type="button" data-act="wh-totals" ${picked.size ? "" : raw("disabled")}>Bag totals</button><button class="btn sm" type="button" data-act="wh-print-picked" ${picked.size ? "" : raw("disabled")}>${svg("doc")}Print selected</button><button class="btn sm soft" type="button" data-act="wh-pick-done">Done</button><div class="w-batch" id="wBatch" role="group" aria-label="Change the selected orders">${batchControls()}</div></div>`
        : html`<div class="w-print-bar">${hasNew || rows.length ? html`<details class="w-print-menu"><summary class="btn sm ${rows.length ? "" : "soft"}">${svg("doc")}Print<span aria-hidden="true">⌄</span></summary><div class="w-print-options"><button class="btn sm soft" type="button" data-act="wh-print-shown" ${canPrintShown ? "" : raw("disabled")}>${rows.length > 200 ? "Print up to 200 selected orders" : "Print shown orders"}</button><button class="btn sm soft" type="button" data-act="wh-print-new" ${hasNew ? "" : raw("disabled")}>Print new orders</button><button class="btn sm soft" type="button" data-act="wh-pick-start" ${rows.length ? "" : raw("disabled")}>Select to print</button></div></details>` : html`<button class="btn sm" type="button" disabled>${svg("doc")}Print<span aria-hidden="true">⌄</span></button>`}<button class="btn sm soft" type="button" data-act="wh-pick-start" ${rows.length ? "" : raw("disabled")}>Select</button><button class="btn sm soft" type="button" data-act="wh-totals" ${hasPreparation ? "" : raw("disabled")}>Bag totals</button></div>`}</div>`;
    const list = listing("wOrdersTitle", "Order queue", resultCount(rows.length, data.matchingCount, "order"), wideOrders.matches ? html`` : tools,
      rows.length ? html`${orderColumns()}${rows.map(orderRow)}` : emptyState(filtered ? "search" : "coffee", filtered ? "No matching orders" : "No orders yet", filtered ? "Try another search or status, or clear your filters to see all orders." : "Customer orders will appear here when they’re placed.", filtered),
      html`${more("orders")}<p class="hint">Coffee subtotals are saved with each order. Delivery and invoicing are managed separately.</p>`, html`<button class="btn sm soft w-expand-queue" type="button" data-act="wh-full-queue" aria-pressed="${hideOrderPreview}">${hideOrderPreview ? "Show preview" : "Full width"}</button><a class="btn sm w-new-order" href="${(data.links?.diary || "").replace(/\/$/, "")}/orders#new"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>New order</a> <details class="w-order-settings"><summary class="btn sm soft">Order settings${svg("chev")}</summary><div class="w-order-settings-actions"><button class="btn sm soft w-alerts-button" type="button" data-act="wh-announcement"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7"/></svg>Announcement</button> <button class="btn sm soft w-alerts-button" type="button" data-act="wh-order-emails"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>Order alerts</button></div></details>`);
    return html`${wideOrders.matches ? html`<div class="w-order-controls glass">${tools}</div>` : ""}<div class="w-order-layout ${picking ? "is-picking" : ""} ${hideOrderPreview ? "w-queue-expanded" : ""}">${list}<div class="w-order-preview" id="wOrderPreview" ${hideOrderPreview ? raw("hidden") : ""}>${orderPreview()}</div></div>`;
  }
  // Hide figures (the owner's request, 23 Nov 2026): on Insights and Invoicing, one tap blurs sales, money, customer
  // names and charts on screen, for when someone's looking at the display. On this device only (localStorage
  // sc.admin.hideFigures), a screen shield rather than security: the data is still in the page.
  const figuresHidden = () => { try { return localStorage.getItem("sc.admin.hideFigures") === "1"; } catch { return false; } };
  document.documentElement.toggleAttribute("data-hide-figures", figuresHidden());
  function privacyToggle() {
    const on = figuresHidden();
    return html`<button class="btn soft w-privacy-toggle" type="button" data-act="wh-privacy" aria-pressed="${on ? "true" : "false"}" title="Blur figures on screen (H)">${raw(on
      ? '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
      : '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>')}<span>${on ? "Figures hidden" : "Hide figures"}</span></button>`;
  }
  function setFiguresHidden(on) {
    try { if (on) localStorage.setItem("sc.admin.hideFigures", "1"); else localStorage.removeItem("sc.admin.hideFigures"); } catch {}
    document.documentElement.toggleAttribute("data-hide-figures", on);
    for (const button of document.querySelectorAll('[data-act="wh-privacy"]')) { const next = document.createElement("div"); put(next, privacyToggle()); button.replaceWith(next.firstElementChild); }
    $('[data-act="wh-privacy"]')?.focus({ preventScroll: true });
    toast(on ? "Figures hidden on this screen" : "Figures shown");
  }
  // "H" switches it too (not while typing).
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "h" || event.metaKey || event.ctrlKey || event.altKey || !document.documentElement.hasAttribute("data-w-sensitive")) return;
    if (event.target.closest?.("input,textarea,select,[contenteditable]")) return;
    if (!document.querySelector('[data-act="wh-privacy"]')) return;
    event.preventDefault(); setFiguresHidden(!figuresHidden());
  });
  function orderColumns() {
    const arrow = (up, down) => status === "Dispatched" && !sortChosen ? "" : orderSort === up ? " ↑" : orderSort === down ? " ↓" : "";
    return html`<div class="w-order-columns"><span>Customer</span><button type="button" data-act="wh-sort" data-id="ordered" aria-label="Sort by order date${orderSort.startsWith("ordered") ? orderSort === "ordered" ? ", currently newest first" : ", currently oldest first" : ""}">Ordered${arrow("ordered-asc","ordered")}</button><button type="button" data-act="wh-sort" data-id="dispatch" aria-label="Sort by dispatch date${orderSort.startsWith("dispatch") ? orderSort === "dispatch" ? ", currently earliest first" : ", currently latest first" : ""}">Dispatch${arrow("dispatch","dispatch-desc")}</button><span class="w-order-method">Fulfilment</span><button type="button" data-act="wh-sort" data-id="bags" aria-label="Sort by bag count${orderSort.startsWith("bags") ? orderSort === "bags-asc" ? ", currently fewest first" : ", currently most first" : ""}">Bags${arrow("bags-asc","bags")}</button><span class="w-order-weight">Weight</span><span>Total</span><span>Status</span></div>`;
  }
  // When the order was placed, in UK time ("Mon, 23 Nov"; the year too if it isn't this year).
  function orderedOn(at) {
    if (!at) return "";
    const d = new Date(at), year = (t) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "Europe/London" }).format(t);
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(year(d) === year(new Date()) ? {} : { year: "numeric" }), timeZone: "Europe/London" }).format(d);
  }
  function compactOrder(row) {
    return html`<span class="w-order-compact"><span class="w-order-customer"><b>${row.business || row.createdName}</b><small>${row.locationSnapshot?.name || "Main location"}${row.reference ? " · " + row.reference : ""}${row.customerNote ? " · Customer note" : ""}${row.preview !== false ? " · Staff preview" : ""}</small></span><span class="w-order-placed">${orderedOn(row.createdAt)}</span><span>${row.dispatchDate ? day(row.dispatchDate).replace(/,? \d{4}$/, "") : "Unscheduled"}</span><span class="w-order-method">${row.delivery === "Delivery" ? "Delivery" : "Collection"}</span><span class="num">${row.packs}</span><span class="w-order-weight num">${weight(row.grams)}</span><strong class="num">${money(row.totalPence ?? row.pence)}</strong>${pill(row.status)}</span>`;
  }
  function orderPreview() {
    const row = packingRow(previewOrder) || data.orders[0];
    const active = row && row.id === packingOrder;
    return html`<section class="group glass w-preview-panel ${active ? "w-is-packing" : ""}" aria-label="${active ? "Order processing" : "Order preview"}"><header><h2>${active ? "Order processing" : "Order preview"}</h2>${active ? html`<div class="w-preview-actions"><button class="btn sm soft" type="button" data-act="wh-print-one" data-id="${row.id}">Print list</button><button class="btn sm soft" type="button" data-act="wh-exit-pack">Exit packing</button></div>` : ""}</header>
      ${row ? html`<div class="w-preview-body"><div class="w-order-heading"><h3>${row.business || row.createdName}</h3>${pill(row.status)}</div><p class="w-id">${row.id} · ${row.packs} bags · ${weight(row.grams)}</p>
        <div class="w-preview-stages" data-order-stage="${row.status}"></div>
        <div class="w-preview-destination"><b>${row.delivery}${row.locationSnapshot?.name ? " · " + row.locationSnapshot.name : ""}</b><span>${row.dispatchDate ? day(row.dispatchDate) : "Unscheduled"}</span>${row.delivery === "Delivery" && row.locationSnapshot?.address ? html`<span>${[row.locationSnapshot.address,row.locationSnapshot.postcode].filter(Boolean).join(", ")}</span>` : ""}</div>
        ${row.customerNote ? html`<p class="wp-work-note"><b>Customer note</b>${row.customerNote}</p>` : ""}
        ${active ? html`<div id="wPackChecklist" data-id="${row.id}"></div>` : html`
          <h3 class="w-preview-lines-title">Packing list</h3>${(row.lines || []).map(line => html`<div class="kv"><span>${line.title} · ${grindFor(line).label}</span><span>${line.quantity} × ${line.packLabel}</span></div>`)}
          <div class="kv"><span>Order total</span><strong>${money(row.totalPence ?? row.pence)}</strong></div>
          <div class="w-preview-actions"><button class="btn sm soft" type="button" data-act="wh-edit-preview" data-id="${row.id}">Open order</button>
            ${row.preview === false ? html`<button class="btn sm soft" type="button" data-act="wh-preview-invoice" data-id="${row.id}">Review invoice</button>` : ""}
            ${nextStatus(row) ? html`<button class="btn sm" type="button" data-act="wh-pack" data-id="${row.id}">${row.status === "Ready" ? "Process dispatch" : "Pack order"}</button>` : ""}</div>`}</div>` : html`<p class="hint w-preview-body">Select an order to see its packing list and dispatch details.</p>`}
      </section>`;
  }
  function mountStages(node) {
    const track = packing.stageTrack(node.dataset.orderStage);
    if (track) node.replaceChildren(track);
  }
  function drawOrderPreview() {
    const pane = $("#wOrderPreview");
    if (!pane || !data) return;
    pane.hidden = hideOrderPreview;
    pane.closest(".w-order-layout").classList.toggle("w-queue-expanded", hideOrderPreview);
    put(pane, orderPreview());
    const stages = pane.querySelector(".w-preview-stages");
    const checklist = pane.querySelector("#wPackChecklist");
    if (stages) mountStages(stages);
    if (checklist) mountPacking(checklist);
    for (const button of document.querySelectorAll('.w-order-layout [data-act="wh-order"]')) {
      const selected = !hideOrderPreview && button.dataset.id === previewOrder;
      button.setAttribute("aria-pressed", String(selected));
      button.closest(".w-order-entry").classList.toggle("w-order-selected", selected);
    }
    const toggle = $(".w-expand-queue");
    if (toggle) {
      toggle.textContent = hideOrderPreview ? "Show preview" : "Full width";
      toggle.setAttribute("aria-pressed", String(hideOrderPreview));
    }
  }
  function mountPacking(node) {
    const row = packingRow(node.dataset.id);
    if (!row || row.preview !== false) {
      node.replaceChildren(SC.el("p", { class: "hint" }, "This order is outside the current queue."));
      return;
    }
    const controls = packing.checklist(row, {
      busy: quickBusy.has(row.id), problem: orderErrors.get(row.id)?.message || "",
      change: (line, packed) => savePackingLine(row.id, line, packed),
      advance: () => advanceOrder(row.id, true),
      refresh: async () => { orderErrors.delete(row.id); await reload(); refreshPacking(row.id); }
    });
    const title = $("#wPackSheetTitle");
    if (node.id === "wPackSheet" && title) title.textContent = row.business || "Pack order";
    node.replaceChildren(controls);
  }
  function refreshPacking(id) {
    for (const node of document.querySelectorAll("#wPackSheet, #wPackChecklist")) if (node.dataset.id === id) mountPacking(node);
  }
  async function savePackingLine(id, line, packed) {
    if (quickBusy.has(id) || orderErrors.has(id)) return;
    const row = packingRow(id);
    if (!row || row.status !== "Preparing") return;
    const session = packingSession;
    quickBusy.add(id); refreshPacking(id);
    try {
      const { order } = await api("PATCH", `/api/admin/wholesale/orders/${id}/packing`, { ifVersion: row.version, line, packed });
      if (session !== packingSession) return;
      if (order?.id !== id || !Number.isSafeInteger(order.version) || order.version < row.version || !Array.isArray(order.packedLines) || order.packedLines.includes(line) !== packed) {
        throw new Error("The packing update could not be confirmed.");
      }
      const index = data?.orders.findIndex(item => item.id === id) ?? -1;
      if (index >= 0 && data.orders[index].version <= order.version) data.orders[index] = order;
      if (data?.packingSelection?.id === id && data.packingSelection.version <= order.version) data.packingSelection = order;
    } catch (error) {
      if (session === packingSession && packingRow(id)) orderErrors.set(id, { version: row.version, message: error.message });
    } finally {
      if (session === packingSession) {
        quickBusy.delete(id); refreshPacking(id);
        if (document.activeElement === document.body) document.querySelector(`[data-id="${id}"] [data-pack-line="${line}"]:enabled`)?.focus({ preventScroll: true });
      }
    }
  }
  function openPackingSheet(row, back) {
    openSheet(html`<div class="w-sheet w-pack-sheet"><h2 id="sheetTitle" tabindex="-1">${row.business || "Pack order"}</h2>
      <p class="w-id">${row.id} · ${row.delivery}${row.dispatchDate ? " · " + day(row.dispatchDate) : ""}</p>
      ${row.customerNote ? html`<p class="wp-work-note"><b>Customer note</b>${row.customerNote}</p>` : ""}
      <div id="wPackSheet" data-id="${row.id}"></div><div class="w-preview-actions"><button class="btn soft" type="button" data-sheet="back">Back to order</button></div></div>`,
      action => { if (action === "back") back(); });
    mountPacking($("#wPackSheet"));
  }
  function orderRow(row) {
    const next = nextStatus(row), busy = quickBusy.has(row.id), problem = orderErrors.get(row.id);
    const chosen = picked.has(row.id);
    return html`<div class="w-order-entry ${picking ? "is-picking" : row.id === previewOrder && !hideOrderPreview ? "w-order-selected" : ""}" data-order-entry="${row.id}" aria-busy="${busy}"><button class="item w-order" type="button" data-act="${picking ? "wh-pick" : "wh-order"}" data-id="${row.id}" ${picking ? html`aria-pressed="${chosen}"` : wideOrders.matches ? html`aria-pressed="${row.id === previewOrder && !hideOrderPreview}" aria-controls="wOrderPreview"` : ""} ${busy ? raw("disabled") : ""}><span class="ic ${picking ? chosen ? "ok w-pick-on" : "mut w-pick-off" : row.preview === false ? "acc" : "mut"}">${picking ? chosen ? svg("ok") : html`<span class="w-pick-ring" aria-hidden="true"></span>` : svg("coffee")}</span><span class="tx"><b>${row.business || customer(row.customerId)?.business || row.createdName}</b><span>${shortId(row.id)}… · ${date(row.createdAt)}</span><span>${row.locationSnapshot?.name ? row.locationSnapshot.name + " · " : ""}${row.delivery} · ${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)}</span>${row.dispatchDate || row.standing ? html`<span class="w-dispatch">${row.dispatchDate ? `Dispatch ${day(row.dispatchDate)}` : ""}${row.dispatchDate && row.standing ? " · " : ""}${row.standing ? `Standing order, ${everyText(row.standing.every)}` : ""}</span>` : ""}${row.reference ? html`<span>Reference: ${row.reference}</span>` : ""}${row.customerNote ? html`<span class="w-has-note">Customer comments</span>` : ""}${row.takenFor ? html`<span>Taken by ${row.createdName} (${row.takenFor.source.toLowerCase()})</span>` : ""}${row.tab && !row.tabClearedId ? html`<span class="w-has-note">On tab</span>` : ""}${row.preview === false ? "" : html`<span class="w-test-label">Staff preview · ${row.createdName}</span>`}</span><span class="end"><strong class="num">${money(Number.isSafeInteger(row.totalPence) ? row.totalPence : row.pence)}</strong>${pill(row.status)}<span class="chev">${svg("chev")}</span></span>${compactOrder(row)}</button>
      ${!picking && (next || problem) ? html`<div class="w-order-actions"><div class="w-order-feedback" data-order-error="${row.id}" role="alert" ${problem ? "" : raw("hidden")}>${problem ? html`<p>${problem.message}</p><button class="btn sm soft" type="button" data-act="wh-refresh-orders" data-id="${row.id}">Reload orders</button>` : ""}</div>${next ? html`<button class="btn sm soft" type="button" data-act="wh-next" data-id="${row.id}" aria-label="Mark ${row.business || "order"} ${next.toLowerCase()}" ${busy || problem ? raw("disabled") : ""}>${busy ? "Saving…" : "Mark " + next.toLowerCase()}</button>` : ""}</div>` : ""}</div>`;
  }
  // Who gets an email for each new customer order (sent from orders@staffstrangerscoffee.com).
  async function openOrderEmails() {
    emailHealthToken++;
    const retained = emailDraft;
    let settings = retained?.settings || await api("GET", "/api/admin/wholesale/order-emails");
    const view = () => html`<div class="w-sheet wp-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">New-order alerts</h2><p class="hint">An email for every new customer order, from ${settings.from}. Replies go to the customer.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${settings.sending ? "" : html`<p class="err">Email isn’t set up on this site yet, so nothing will be sent.</p>`}
      <form id="wOrderEmailsForm" class="w-order-emails" novalidate><div class="checks"><label><input id="wOrderEmailsOn" type="checkbox" ${(retained?.enabled ?? settings.enabled) ? raw("checked") : ""}>Email new orders</label></div>
      <label class="field"><span class="fl">Send to</span><textarea id="wOrderEmailsTo" rows="3" autocapitalize="none" spellcheck="false" aria-describedby="wOrderEmailsHint">${retained?.toText ?? settings.to.join("\n")}</textarea></label><p class="hint" id="wOrderEmailsHint">One address per line, up to 5.</p>
      <h3>Customers</h3><div class="checks"><label><input id="wConfirmCustomers" type="checkbox" ${(retained?.confirmCustomers ?? settings.confirmCustomers !== false) ? raw("checked") : ""}>Email customers about their orders</label></div><p class="hint">When an order is placed, when a collection is ready to collect, and when it's shipped or collected.</p>
      <p class="hint">The business’s current order email receives the confirmation and the shipping or collection notice. It also receives changes Strangers makes to standing orders. Replies come to the first address above.</p>
      <p class="err" id="wOrderEmailsErr" role="alert" hidden></p></form>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="test" ${settings.sending ? "" : raw("disabled")}>Send a test email</button><button class="btn" type="button" data-sheet="save">Save</button></div>
      <h3>Slack</h3><p class="hint" id="wSlackState">${settings.slack ? "Each new order is posted to the orders channel: straight away from 07:45 to 16:45 (Sunday 10:00 to 15:30), otherwise at 07:50 (Sunday 10:00)." : "Not set up: add the SLACK_ORDERS_WEBHOOK_URL secret in Cloudflare (README-deploy.md)."}</p>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="slack-test" ${settings.slack ? "" : raw("disabled")}>Send a test to Slack</button></div></div>`;
    const deliveryView = () => html`<section class="w-order-section" aria-label="Notification delivery"><h3 id="wDeliveryTitle" tabindex="-1">Notification delivery</h3><p class="hint">Provider acceptance is separate from delivery and inbox placement.</p><button class="btn sm soft" type="button" data-sheet="email-health">Email health and setup</button>${["email", "slack"].map(channel => { const counts = settings.delivery?.[channel] || {pending:0,failed:0,unknown:0}; return html`<p id="wDelivery-${channel}" class="hint">${channel === "email" ? "Dispatch emails" : "Slack posts"}: ${counts.pending} waiting · ${counts.failed} retrying or failed · ${counts.unknown} need review${counts.oldestWaitingAt && Date.now() - counts.oldestWaitingAt >= 60000 ? ` · oldest due ${Math.floor((Date.now() - counts.oldestWaitingAt) / 60000)} min ago` : ""}</p><div class="toolbar">${counts.failed ? html`<button class="btn sm soft" type="button" data-sheet="retry-${channel}">Retry failed ${channel === "email" ? "emails" : "posts"}</button>` : ""}${counts.unknown ? html`<button class="btn sm soft" type="button" data-sheet="review-${channel}">Review uncertain ${channel === "email" ? "emails" : "posts"}</button>` : ""}</div>`; })}<div id="wLegacyDispatch">${(settings.delivery?.legacyDispatch || []).map(row => html`<button class="btn sm soft" type="button" data-sheet="review-legacy" data-id="${row.id}">Review previous failed dispatch: ${row.business}</button>`)}</div><div id="wRetryConfirm" class="w-order-feedback" role="group" aria-label="Confirm notification retry" aria-describedby="wRetryWarning" tabindex="-1" hidden><p id="wRetryWarning">Check whether these notifications already arrived. Retrying an uncertain delivery may send a duplicate.</p><div class="toolbar"><button class="btn sm" type="button" data-sheet="retry-reviewed">Retry after checking</button><button class="btn sm soft" type="button" data-sheet="retry-cancel">Cancel</button></div></div></section>`;
    let reviewedChannel = null, reviewedOrder = null, reviewTrigger = null, retrying = false;
    const fail = (error) => { const box = $("#wOrderEmailsErr"); if (box) { box.textContent = error.message; box.hidden = false; } };
    openSheet(view(), async (action, button) => {
      if (action === "close") { closeSheet(); return; }
      $("#wOrderEmailsErr").hidden = true;
      if (action === "email-health") { emailDraft = {settings,enabled:$("#wOrderEmailsOn").checked,toText:$("#wOrderEmailsTo").value,confirmCustomers:$("#wConfirmCustomers").checked}; try { await openEmailHealth(); } catch(error) { fail(error); } return; }
      if (action === "retry-cancel") {
        $("#wRetryConfirm").hidden = true;
        reviewTrigger?.focus();
        reviewedChannel = reviewedOrder = reviewTrigger = null;
        return;
      }
      if (action.startsWith("review-")) {
        reviewedChannel = action.slice(7);
        reviewedOrder = button?.dataset.id || null;
        reviewTrigger = button;
        const confirmation = $("#wRetryConfirm");
        confirmation.hidden = false;
        confirmation.scrollIntoView({ block: "center", behavior: "instant" });
        confirmation.focus({ preventScroll: true });
        return;
      }
      if (action.startsWith("retry-") && action !== "retry-cancel") {
        if (retrying) return;
        const unknown = action === "retry-reviewed", channel = unknown ? reviewedChannel : action.slice(6);
        if (!["email", "slack", "legacy"].includes(channel)) return;
        retrying = true;
        try {
          const result = await api("POST", `/api/admin/wholesale/order-emails/${channel}-retry`, { acknowledgeUnknown: unknown, ...(channel === "legacy" ? { orderId: reviewedOrder } : {}) });
          settings.delivery = result.delivery;
          reviewedChannel = reviewedOrder = reviewTrigger = null;
          const active = document.activeElement;
          put(deliveryHost, deliveryView());
          if (active === document.body || !active?.isConnected) deliveryHost.querySelector("#wDeliveryTitle").focus();
          toast(`${result.queued} notifications queued for retry`);
        }
        catch (error) { fail(error); } finally { retrying = false; }
        return;
      }
      if (action === "save") {
        const to = $("#wOrderEmailsTo").value.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
        try { settings = await api("PUT", "/api/admin/wholesale/order-emails", { ifVersion: settings.version, enabled: $("#wOrderEmailsOn").checked, to, confirmCustomers: $("#wConfirmCustomers").checked }); emailDraft = null; closeSheet(); toast(settings.enabled ? "Order emails saved" : "Order emails switched off"); }
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
    }, $(".w-order-settings > summary"));
    const deliveryHost = document.createElement("div"); put(deliveryHost, deliveryView()); $("#sheet .w-sheet").append(deliveryHost);
  }
  async function openEmailHealth(existing) {
    const current = sequence, token = ++emailHealthToken, origin = $("#sheet .w-sheet");
    let health = existing || await api("GET", "/api/admin/wholesale/order-emails/delivery");
    if (current !== sequence || token !== emailHealthToken || (origin && !origin.isConnected)) return;
    const labels = {accepted:"Accepted by provider",delivered:"Delivered to mail server",delayed:"Delivery delayed",bounced:"Bounced",complained:"Marked as spam",failed:"Delivery failed",suppressed:"Suppressed"};
    const code = value => html`<code class="w-email-code">${value}</code>`;
    const view = () => html`<div class="w-sheet w-email-health"><div class="wp-sheet-head"><div><button class="btn sm soft" type="button" data-sheet="email-back">Back to order alerts</button><h2 id="sheetTitle" tabindex="-1">Email health</h2><p class="hint">Delivery feedback and sender authentication for wholesale and staff emails.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <section><h3>Delivery feedback</h3><p class="hint" id="wEmailWebhook">${health.webhookConfigured ? health.lastWebhookAt ? `Signed feedback last received ${date(health.lastWebhookAt)}.` : "Signing secret configured. Waiting for the first verified event." : "Not connected. Complete the Resend webhook setup below to receive delivery feedback."}</p><p class="hint">Delivered means the recipient’s mail server accepted it. The inbox or spam folder is decided by their provider.</p><button class="btn sm soft" type="button" data-sheet="email-refresh">Refresh feedback</button>
      ${health.staff && (health.staff.queued || health.staff.retrying || health.staff.needsReview) ? html`<p class="hint">Staff email · ${health.staff.queued} queued · ${health.staff.retrying} retrying · ${health.staff.needsReview} need review. Review Activity for details.</p>` : ""}
      <div class="w-email-messages" id="wEmailMessages">${health.messages.length ? health.messages.map(message => html`<article>
        <b>${message.name || message.recipient}</b><span>${message.recipient}</span><span>${message.subject}</span>
        ${message.orderReference ? html`<span class="hint">${message.orderReference}</span>` : ""}
        <span class="hint">${message.stream === "wholesale" ? "Wholesale" : "Staff rota"} · ${date(message.acceptedAt)}</span>
        <strong>${labels[message.status] || "Awaiting feedback"}</strong>${message.detail ? html`<span class="hint">${message.detail}</span>` : ""}
      </article>`) : html`<p class="hint">Messages appear here after Resend accepts them.</p>`}</div></section>
      <section><h3>Suppressed addresses</h3><p class="hint">Further sends to these addresses are blocked. Correct the address or resolve the issue in Resend; only verified provider feedback removes the block.</p>${health.suppressed.length ? health.suppressed.map(row=>html`<p class="hint">${row.email} · ${row.source}</p>`) : html`<p class="hint">No verified suppressions recorded.</p>`}</section>
      <section><h3>Sender authentication</h3><p class="hint">${health.setup.senders.join(" · ")}</p><p class="hint">DMARC reporting address · ${health.setup.reportTo || "Set a monitored inbox"}. External reporters need a TXT record in the receiving domain’s DNS.</p><button class="btn sm soft" type="button" data-sheet="email-dns">Check published DNS</button><p class="hint" id="wEmailDns" role="status">Use Check published DNS to see the current records.</p>
      ${health.setup.records.map((record,index)=>html`<div class="w-email-record"><b>${record.type} record</b>${code(record.name)}${code(record.value)}<button class="btn sm soft" type="button" data-sheet="email-copy-record" data-id="${index}">Copy record</button></div>`)}</section>
      <section><h3>Connect Resend feedback</h3><p class="hint">In Resend → Webhooks, add this endpoint and subscribe to delivery, bounce, complaint, failure and suppression events:</p>${code(health.setup.webhookUrl)}<button class="btn sm soft" type="button" data-sheet="email-copy-url">Copy webhook URL</button><p class="hint">Save Resend’s signing secret in Cloudflare Worker → Settings → Variables and Secrets as ${health.setup.webhookSecretName}. The secret is never displayed here.</p><p class="hint">In Resend’s sending-domain settings, keep open and click tracking disabled for operational emails. Public DNS records alone cannot prove a received message passed SPF, DKIM and DMARC; check its original headers.</p><p class="hint">DNS records and provider settings require configuration in their respective dashboards. This window checks DNS without changing it.</p></section><p class="err" id="wEmailHealthError" hidden role="alert"></p></div>`;
    openSheet(view(), async(action,button)=>{
      const error = $("#wEmailHealthError"); if (error) error.hidden=true;
      try {
        if (action === "email-back") { await openOrderEmails(); return; }
        if (action === "email-refresh") { const next=await api("GET","/api/admin/wholesale/order-emails/delivery");if(current===sequence && token===emailHealthToken && panel.isConnected)await openEmailHealth(next);return; }
        if (action === "email-dns") {
          const result = await api("GET", "/api/admin/wholesale/order-emails/delivery/dns"), target = panel.querySelector("#wEmailDns");
          if (target && panel.isConnected) target.textContent = result.domains.map(row => {
            const checks = [`DMARC ${row.dmarc}`, `Resend DKIM ${row.dkim}`, `bounce-domain SPF ${row.bounceSpf}`];
            if (row.reportAddress) checks.push(`reporting address ${row.reportAddress}`);
            if (row.reportAuthorization) checks.push(`external reporting authorisation ${row.reportAuthorization.status}`);
            return `${row.domain} · ${checks.join(" · ")}`;
          }).join(". ");
          return;
        }
        if (action === "email-copy-url") { await navigator.clipboard.writeText(health.setup.webhookUrl);toast("Webhook URL copied");return; }
        if (action === "email-copy-record") { const record=health.setup.records[Number(button.dataset.id)];if(record){await navigator.clipboard.writeText(`${record.name}\n${record.type}\n${record.value}`);toast("DNS record copied");} }
      } catch(e) { if(error?.isConnected){error.textContent=e.message;error.hidden=false;} }
    });
    const panel = $("#sheet .w-email-health");
  }
  // The ordering page's announcement bar: a heading, a message, Information or Important, optional dates, on or off.
  async function openAnnouncement() {
    let a = await api("GET", "/api/admin/wholesale/announcement");
    const fmtDay = (d) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
    const state = () => !a.enabled ? "Off: customers don’t see it." : a.showing ? `Showing on the ordering page now${a.until ? `, until the end of ${fmtDay(a.until)}` : ""}.` : a.from ? `Switched on: shows from ${fmtDay(a.from)}${a.until ? ` to ${fmtDay(a.until)}` : ""}.` : "Switched on, but its dates have passed.";
    const view = () => html`<div class="w-sheet wp-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Announcement</h2><p class="hint">A message at the top of the wholesale ordering page, such as Christmas dispatch dates or a closure. Customers can close it; a new message shows again.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <p class="hint w-ann-state" id="wAnnState">${state()}</p>
      <form id="wAnnForm" class="w-ann" novalidate>
        <div class="checks"><label><input id="wAnnOn" type="checkbox" ${a.enabled ? raw("checked") : ""}>Show it to customers</label></div>
        <label class="field"><span class="fl">Heading (optional)</span><input id="wAnnTitle" maxlength="80" value="${a.title}" placeholder="Christmas dispatch dates"></label>
        <label class="field"><span class="fl">Message</span><textarea id="wAnnMessage" rows="5" maxlength="500" placeholder="Last dispatch before Christmas: Friday 19 December. We reopen on Monday 5 January.">${a.message}</textarea></label>
        <p class="hint"><span id="wAnnCount">${a.message.length}</span> of 500 characters. New lines are kept.</p>
        <fieldset class="field w-ann-tone"><legend class="fl">Style (see the preview)</legend><div class="checks"><label><input type="radio" name="wAnnTone" value="info" ${a.tone !== "important" ? raw("checked") : ""}>Information</label><label><input type="radio" name="wAnnTone" value="important" ${a.tone === "important" ? raw("checked") : ""}>Important</label></div></fieldset>
        <div class="w-ann-dates"><label class="field"><span class="fl">Show from (optional)</span><input id="wAnnFrom" type="date" value="${a.from}"></label><label class="field"><span class="fl">Until the end of (optional)</span><input id="wAnnUntil" type="date" value="${a.until}"></label></div>
        <h3>Preview</h3>
        <div class="w-ann-preview" id="wAnnPreview" aria-live="polite"></div>
        <p class="err" id="wAnnErr" role="alert" hidden></p>
      </form>
      <div class="row w-actions"><button class="btn" type="button" data-sheet="save">Save</button></div></div>`;
    const preview = () => {
      const box = $("#wAnnPreview"); if (!box) return;
      const title = $("#wAnnTitle").value.trim(), message = $("#wAnnMessage").value.trim(), important = $('input[name="wAnnTone"]:checked')?.value === "important";
      $("#wAnnCount").textContent = String($("#wAnnMessage").value.length);
      box.className = `w-ann-preview${important ? " important" : ""}`;
      box.replaceChildren(...(message ? [Object.assign(document.createElement("strong"), { textContent: title, hidden: !title }), Object.assign(document.createElement("p"), { textContent: message })] : [Object.assign(document.createElement("p"), { className: "hint", textContent: "Write a message to see it here." })]));
    };
    const fail = (error) => { const box = $("#wAnnErr"); if (box) { box.textContent = error.message; box.hidden = false; } };
    openSheet(view(), async (action) => {
      if (action === "close") { closeSheet(); return; }
      if (action !== "save") return;
      $("#wAnnErr").hidden = true;
      try {
        a = await api("PUT", "/api/admin/wholesale/announcement", { ifVersion: a.version, enabled: $("#wAnnOn").checked, title: $("#wAnnTitle").value, message: $("#wAnnMessage").value, tone: $('input[name="wAnnTone"]:checked')?.value || "info", from: $("#wAnnFrom").value, until: $("#wAnnUntil").value });
        closeSheet(); toast(a.showing ? "Announcement showing on the ordering page" : a.enabled ? "Announcement saved: it shows on its start date" : "Announcement switched off");
      } catch (error) {
        if (error.code === "conflict") { a = await api("GET", "/api/admin/wholesale/announcement"); }
        fail(error);
      }
    }, $(".w-order-settings > summary"));
    preview();
    $("#wAnnForm").addEventListener("input", preview);
  }
  // Mark the picked orders preparing, ready or dispatched: one version-checked save each, the same as the quick
  // step (dispatch emails and standing orders work as usual). Orders only move forward; staff previews are left
  // alone. Dispatching asks once more, because customers are emailed.
  function batchControls() {
    const chosen = (data?.orders || []).filter((row) => picked.has(row.id));
    if (batch?.running) return html`<span class="w-batch-label" aria-live="polite">Saving ${batch.done} of ${batch.total}…</span>`;
    if (batch?.confirm) {
      const n = chosen.filter((row) => movable(row, "Dispatched")).length;
      return html`<span class="w-batch-label">Mark ${n} ${n === 1 ? "order" : "orders"} dispatched? Customers are emailed that their order has been shipped or collected.</span><button class="btn sm" type="button" data-act="wh-batch-confirm">Dispatch ${n}</button><button class="btn sm soft" type="button" data-act="wh-batch-cancel">Cancel</button>`;
    }
    return html`<span class="w-batch-label">Selected orders:</span>${[["Preparing", "Mark preparing"], ["Ready", "Mark ready"], ["Dispatched", "Mark dispatched"]].map(([to, label]) => { const n = chosen.filter((row) => movable(row, to)).length; return html`<button class="btn sm soft" type="button" data-act="wh-batch" data-id="${to}" ${n ? "" : raw("disabled")}>${n ? `${label} (${n})` : label}</button>`; })}`;
  }
  function refreshBatch() { const box = $("#wBatch"); if (box) put(box, batchControls()); }
  async function runBatch(to) {
    const targets = data.orders.filter((row) => picked.has(row.id) && movable(row, to)).map(row => ({ ...row }));
    if (!targets.length || batch?.running) return;
    const operation = { running: true, done: 0, total: targets.length };
    batch = operation; refreshBatch();
    let saved = 0, failed = 0, conflict = false;
    for (const row of targets) {
      if (batch !== operation) return;
      try {
        const result = await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: to, customerId: row.customerId, note: row.note || "", trackingUrl: row.trackingUrl || "" });
        if (batch !== operation) return;
        if (result.order?.id !== row.id || result.order.status !== to || !Number.isSafeInteger(result.order.version) || result.order.version <= row.version) throw new Error("The status update could not be confirmed.");
        saved++; picked.delete(row.id);
      } catch (error) { if (batch !== operation || error.code === "session_changed" || error.code === "session_unverified" || error.status === 401 || error.status === 403) { if (batch === operation) batch = null; return; } failed++; if (error.code === "conflict") conflict = true; }
      operation.done++; refreshBatch();
    }
    if (batch !== operation) return; batch = null;
    await reload();
    const word = to.toLowerCase();
    toast(failed ? `${saved} marked ${word}. ${failed} couldn't be saved${conflict ? " (changed elsewhere)" : ""}; they're still selected.` : `${saved} ${saved === 1 ? "order" : "orders"} marked ${word}.`);
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
    if (!batch?.running) { batch = null; refreshBatch(); }
  }
  function refreshOrderFeedback(id) {
    const entry = document.querySelector(`[data-order-entry="${id}"]`);
    if (!entry) return;
    const row = data.orders.find((order) => order.id === id);
    if (!row) return;
    const busy = quickBusy.has(id), problem = orderErrors.get(id), next = nextStatus(row);
    entry.setAttribute("aria-busy", String(busy));
    const orderButton = entry.querySelector('[data-act="wh-order"]');
    if (orderButton) orderButton.disabled = busy;
    const button = entry.querySelector('[data-act="wh-next"]');
    if (button) { button.disabled = busy || !!problem || !next; button.textContent = busy ? "Saving…" : next ? "Mark " + next.toLowerCase() : "Up to date"; }
    const feedback = entry.querySelector('[data-order-error]');
    if (feedback) {
      feedback.hidden = !problem;
      put(feedback, problem ? html`<p>${problem.message}</p><button class="btn sm soft" type="button" data-act="wh-refresh-orders" data-id="${id}">Reload orders</button>` : html``);
    }
  }
  async function advanceOrder(id, fromChecklist = false) {
    if (quickBusy.has(id) || orderErrors.has(id)) return;
    const row = packingRow(id), next = row && nextStatus(row);
    if (!next) return;
    if (next === "Dispatched") { dispatchOrder(row); return; }
    const session = packingSession;
    const source = fromChecklist ? document.activeElement : document.querySelector(`[data-act="wh-next"][data-id="${id}"]`);
    const wasFocused = document.activeElement === source;
    let restoreFocus = false;
    quickBusy.add(id); refreshOrderFeedback(id); if (fromChecklist) refreshPacking(id);
    try {
      const result = await api("PATCH", `/api/admin/wholesale/orders/${id}`, { ifVersion: row.version, status: next, customerId: row.customerId, note: row.note || "", ...(fromChecklist && next === "Ready" ? { requirePacked: true } : {}) });
      if (session !== packingSession) return;
      if (result.order?.id !== id || result.order.status !== next || result.order.version !== row.version + 1) throw new Error("The status update could not be confirmed. Reload orders to check the latest status.");
      orderErrors.delete(id);
      restoreFocus = wasFocused && (document.activeElement === source || document.activeElement === document.body);
      await reload();
      if (session === packingSession) toast(`${row.business || "Order"} marked ${next.toLowerCase()}.`);
    } catch (error) {
      if (session !== packingSession) return;
      orderErrors.set(id, { version: row.version, message: error.message + " Reload orders before updating this order again." });
      restoreFocus = wasFocused && (document.activeElement === source || document.activeElement === document.body);
    } finally {
      if (session === packingSession) { quickBusy.delete(id); refreshOrderFeedback(id); if (fromChecklist) refreshPacking(id); }
      if (session === packingSession && restoreFocus && $("#scrim").hidden) {
        const target = (fromChecklist && document.querySelector(`[data-id="${id}"] [data-pack-line]:enabled, [data-id="${id}"] [data-pack-next]:enabled`)) || document.querySelector(`[data-act="wh-refresh-orders"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-next"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-order"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-status"][data-id="${status}"]`);
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
    const collection = row.delivery === "Roastery collection", session = packingSession;
    const confirmation = collection ? "Confirm collection" : "Confirm dispatch";
    let cleanup = () => {};
    const back = () => {
      cleanup(); closeSheet();
      const target = document.querySelector(`[data-act="wh-refresh-orders"][data-id="${row.id}"]`) || document.querySelector(`[data-act="wh-next"][data-id="${row.id}"]:not(:disabled)`) || document.querySelector(`[data-act="wh-order"][data-id="${row.id}"]`);
      if (target) target.focus({ preventScroll: true }); else focusOrderList(row.id);
    };
    openSheet(html`<form id="wDispatchOrderForm" class="w-sheet w-editor">${editorHead(collection ? "Confirm collection" : "Dispatch order")}<div class="w-editor-body"><div class="w-order-heading"><h3>${row.business || row.createdName}</h3>${pill(row.status)}</div><p class="w-id">${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)} · ${row.id}</p><div class="w-preview-destination"><b>${row.delivery}</b>${row.locationSnapshot?.name ? html`<span>${row.locationSnapshot.name}</span>` : ""}${!collection && row.locationSnapshot?.address ? html`<span>${[row.locationSnapshot.address,row.locationSnapshot.postcode].filter(Boolean).join(", ")}</span>` : ""}</div>
      ${collection ? html`<p class="hint">Only confirm once the customer has collected their order.</p>` : field("Tracking link (optional)", html`<input id="wDispatchTracking" type="url" inputmode="url" maxlength="2000" placeholder="https://" autocapitalize="none" spellcheck="false" autocomplete="off" value="${restoredTracking ?? row.trackingUrl ?? ""}">`)}<p class="hint">The customer will be notified where order emails are enabled.</p></div>
      <footer class="w-editor-footer"><p class="err" id="wErr" role="alert"></p><button class="btn soft" type="button" data-sheet="dispatch-reload" hidden>Reload latest order</button><div class="row w-actions"><button class="btn soft" type="button" data-sheet="dispatch-cancel">Cancel</button><fieldset id="wDispatchConfirmControls" class="w-delete-confirm-controls"><button class="btn" type="submit">${confirmation}</button></fieldset></div></footer></form>`, async (action, element) => {
      const form = element.closest("form");
      if (form.dataset.whBusy) return;
      if (action === "dispatch-cancel") { back(); return; }
      if (action === "dispatch-reload") {
        const typed = form.querySelector("#wDispatchTracking")?.value;
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
      const tracking = form.querySelector("#wDispatchTracking")?.value.trim() || "";
      if (!validTrackingUrl(tracking)) { form.querySelector("#wErr").textContent = "Use a full HTTP or HTTPS tracking link without a username or password."; form.querySelector("#wDispatchTracking").focus(); return; }
      const button = form.querySelector('button[type="submit"]'); button.textContent = "Saving…";
      quickBusy.add(row.id); refreshOrderFeedback(row.id);
      try {
        await saveForm(form, async () => {
          const result = await api("PATCH", `/api/admin/wholesale/orders/${row.id}`, { ifVersion: row.version, status: "Dispatched", customerId: row.customerId, note: row.note || "", trackingUrl: tracking });
          if (session !== packingSession) return;
          if (result.order?.id !== row.id || result.order.status !== "Dispatched" || !Number.isSafeInteger(result.order.version) || result.order.version <= row.version) throw new Error("The dispatch could not be confirmed. Reload the latest order to check its status.");
          orderErrors.delete(row.id); cleanup(); closeSheet(); await reload(); toast(`${row.business || "Order"} marked dispatched.`);
        });
        if (form.isConnected) {
          button.textContent = confirmation;
          if (form.querySelector("#wErr").textContent) {
            form.querySelector("#wDispatchConfirmControls").disabled = true; form.querySelector('[data-sheet="dispatch-reload"]').hidden = false;
            orderErrors.set(row.id, { version: row.version, message: form.querySelector("#wErr").textContent + " Reload orders before updating this order again." });
          }
        }
      } finally {
        if (session === packingSession) { quickBusy.delete(row.id); refreshOrderFeedback(row.id); }
        if (session === packingSession && !form.isConnected && $("#scrim").hidden) focusOrderList(row.id);
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
  // Accounts emails: a QuickBooks customer list matched to businesses by exact company name (nothing is added). Where the
  // list's email isn't the business's order email, it becomes the accounts email. Preview first, then apply.
  function openAccountsEmails(state = {}) {
    const results = state.results || [], changes = results.filter((r) => r.status === "update" || r.status === "replace");
    const LABEL = { update: "Add accounts email", replace: "Replace accounts email", same: "Same as the order email: nothing to do", already: "Already has this accounts email", notFound: "Not on the website: not added", ambiguous: "More than one business has this name: skipped", noEmail: "No email in the list", updated: "Accounts email saved", changed: "Changed by someone else since the preview: not saved" };
    const groups = state.applied ? ["updated", "changed", "already", "same", "noEmail", "ambiguous", "notFound"] : ["update", "replace", "already", "same", "noEmail", "ambiguous", "notFound"];
    const rowOf = (r) => html`<div class="item"><span class="tx"><b>${r.business || r.company}</b>${r.accountsEmail ? html`<span>Accounts: ${r.accountsEmail}${r.status === "replace" ? ` (was ${r.current})` : ""}</span>` : ""}${r.customerId ? html`<span>Order email: ${r.email || "none"}</span>` : ""}</span></div>`;
    openSheet(html`<form class="w-sheet w-import-sheet" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Accounts emails from QuickBooks</h2><p class="hint">Matches each company in the customer list to a business here by its exact name. Where the list's email isn't the business's order email, it's saved as the accounts email. No businesses are added.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${results.length ? html`<p class="w-import-count">${state.applied ? html`<b>${state.updated}</b> accounts ${state.updated === 1 ? "email" : "emails"} saved` : html`<b>${changes.length}</b> ${changes.length === 1 ? "business" : "businesses"} to update`} · from ${state.fileName}</p>
        ${groups.map((g) => { const list = results.filter((r) => r.status === g); return list.length ? html`<details class="w-ae-group" ${["update", "replace", "updated", "changed"].includes(g) ? raw("open") : ""}><summary><b>${LABEL[g]}</b> · ${list.length}</summary><div class="group">${list.map(rowOf)}</div></details>` : ""; })}
        <p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="ae-file">Choose another file</button>${state.applied ? html`<button class="btn" type="button" data-sheet="close">Done</button>` : html`<button class="btn" type="submit" ${changes.length ? "" : raw("disabled")}>Save ${changes.length} accounts ${changes.length === 1 ? "email" : "emails"}</button>`}</div>`
      : html`<ol class="ins-steps"><li>In QuickBooks, go to <b>Sales → Customers</b> and choose <b>Export to Excel</b>.</li><li>If it saves as an old .xls file, open it and save it as .xlsx or CSV.</li><li>Choose the file here. You'll see every match before anything is saved.</li></ol>
        <label class="btn ins-file">${svg("plus")}Choose the customer list<input type="file" id="wAeFile" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label><p class="err" id="wErr" role="alert">${state.error || ""}</p>`}
      </form>`, async (action, element) => {
      const form = element.closest("form") || element;
      if (action === "ae-file") return openAccountsEmails({});
      if (action !== "submit" || state.applied) return;
      await saveForm(form, async () => {
        const versions = Object.fromEntries(changes.map((r) => [r.customerId, r.version]));
        const r = await api("POST", "/api/admin/wholesale/customers/accounts-emails", { rows: state.rows, apply: true, versions });
        await reload();
        openAccountsEmails({ ...state, results: r.results, updated: r.updated, applied: true });
        toast(`${r.updated} accounts ${r.updated === 1 ? "email" : "emails"} saved.`);
      });
    });
    const input = $("#wAeFile");
    input?.addEventListener("change", async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const parsed = await window.SCCustomerImport.parseFile(file);
        const rows = parsed.rows.filter((r) => r.company).map((r) => ({ company: r.company, emails: r.emails }));
        if (!rows.length) throw new Error("No company names found in that file. Export the customer list from QuickBooks with the Company name column.");
        const r = await api("POST", "/api/admin/wholesale/customers/accounts-emails", { rows, apply: false });
        openAccountsEmails({ rows, fileName: parsed.fileName, results: r.results });
      } catch (error) { openAccountsEmails({ error: error.message }); }
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
    const tools = html`<div class="toolbar">${search("Search wholesale customers", "Search business, contact or email")}<button class="btn" type="button" data-act="wh-customer">${svg("plus")}Add customer</button><button class="btn soft" type="button" data-act="wh-import-customers">Import from QuickBooks</button><button class="btn soft" type="button" data-act="wh-accounts-emails">${svg("mail")}Accounts emails</button><button class="btn soft" type="button" data-act="wh-invite-customers">${svg("mail")}Invite to order online</button></div>
      <div class="segwrap w-filters"><div class="seg" role="group" aria-label="Customer access">${[["all", "All customers"], ["pending", "Awaiting review"]].map(([id, label]) => html`<button type="button" data-act="wh-approval" data-id="${id}" aria-pressed="${approval === id}">${label}</button>`)}</div></div>`;
    return listing("wCustomersTitle", "Customers", resultCount(rows.length, data.matchingCount, "customer"), tools,
      rows.length ? rows.map((row) => html`<button class="item w-customer" type="button" data-act="wh-customer" data-id="${row.id}"><span class="ic ${accountFor(row.id)?.approvalStatus === "pending" ? "warn" : "ok"}">${svg("people")}</span><span class="tx"><b>${row.business}</b><span>${[row.contact, row.email].filter(Boolean).join(" · ") || "No contact details"}</span><span>${accountFor(row.id)?.approvalStatus === "pending" ? "Awaiting account approval" : accountFor(row.id) ? accountFor(row.id).active ? "Sign-in enabled" : "Sign-in disabled" : inviteText(row.id)} · ${termsFor(row)}${row.noMinimumOrder ? " · No minimum order" : ""}${row.hidePrices ? " · Prices hidden" : ""}${row.autoTab ? " · On a tab" : ""}</span></span><span class="end">${pill(row.status)}<span class="chev">${svg("chev")}</span></span></button>`) : emptyState(filtered ? "search" : "people", filtered ? "No matching customers" : "No customers yet", filtered ? "Try another search or clear your filters to see all customers." : "Add a business, or review new registrations as they arrive.", filtered),
      html`${more("customers")}<p class="hint">Customers can access ordering after an admin approves their registration.</p>`);
  }
  function catalogue() {
    const custom = tab === "custom", title = custom ? "Custom coffees" : "Coffee catalogue";
    const coffees = data.products.filter(row => isCustomCoffee(row) === custom);
    const rows = coffees.filter(row => matches(`${row.title} ${row.name} ${row.origin} ${row.process} ${row.notes} ${assignedNames(row).join(" ")}`));
    const tools = html`<div class="toolbar">${search(custom ? "Search custom coffees" : "Search coffee catalogue", custom ? "Search coffee or customer" : "Search coffee, origin or tasting notes")}<button class="btn" type="button" data-act="wh-coffee">${svg("plus")}${custom ? "Add custom coffee" : "Add coffee"}</button></div>`;
    return listing("wCatalogueTitle", title, resultCount(rows.length, coffees.length, "coffee"), tools,
      rows.length ? rows.map((row) => html`<div class="item w-coffee w-coffee-tone" style="${coffeeStyle(row)}">${row.imageUrls.length ? html`<img src="${row.imageUrls[0]}" alt="" width="52" height="52" loading="lazy">` : html`<span class="ic mut">${svg("coffee")}</span>`}<span class="tx"><b><span class="w-coffee-swatch" aria-hidden="true"></span>${row.title}${custom ? html`<span class="w-wl-tag">Custom</span>` : ""}</b><span>${sizesText(row)}</span>${custom ? html`<span>${assignedNames(row).length ? `For ${assignedNames(row).join(", ")}` : row.whiteLabel?.length ? `For ${row.whiteLabel.length} selected ${row.whiteLabel.length === 1 ? "customer" : "customers"}` : "No customers selected · Hidden from customers"}</span>` : ""}${row.recipe?.length ? html`<span>Made from ${row.recipe.map((p) => `${p.percent}% ${p.name}`).join(" · ")}</span>` : ""}<span>${row.notes}</span></span><span class="end"><span class="w-coffee-state">${pill(custom && !row.whiteLabel?.length ? "Needs customers" : row.active ? "Visible" : "Hidden")}${pill(row.inStock ? "In stock" : "Out of stock")}</span><button class="btn sm soft" type="button" data-act="wh-coffee" data-id="${row.id}" aria-label="Edit ${row.name || row.title}">Edit</button></span></div>`) : emptyState(query.trim() ? "search" : "coffee", query.trim() ? "No matching coffees" : custom ? "Your custom coffees" : "Your catalogue starts here", query.trim() ? "Try another search or clear your filters to see all coffees." : custom ? "Add a coffee and choose the customers who can see and order it." : "Add your first coffee, with its prices, photos and availability.", !!query.trim()),
      html`<p class="hint">${custom ? "Only selected customers can see and order these coffees. Unassigned custom coffees stay private. Staff preview includes all coffees." : "Edit coffees, bag prices, photos and availability. Manage customer-specific products in Custom coffees."} Existing orders retain their original details.</p>`);
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
  // Change the bags on a customer order until it's dispatched. Kept lines keep the price they were ordered at; added ones
  // take today's catalogue price. `back` reopens the order with what was typed there.
  function editLines(row, state = null, back = null) {
    const lines = state || row.lines.map((line) => ({ ...line }));
    const coffees = data.products.filter((p) => p.active && (!isCustomCoffee(p) || p.whiteLabel?.includes(row.customerId)));
    const total = lines.reduce((sum, l) => sum + l.quantity, 0), grams = lines.reduce((sum, l) => sum + (l.pack === "kilo" ? 1000 : l.pack === "half" ? 500 : 250) * l.quantity, 0);
    openSheet(html`<form class="w-sheet w-lines-sheet w-editor" novalidate>${editorHead("Edit bags")}<div class="w-editor-body"><p class="hint">${row.business} · ${shortId(row.id)}…</p>
      <div class="w-edit-lines">${lines.length ? lines.map((line, i) => html`<div class="w-edit-line"><span class="w-edit-tx"><b>${line.title}</b><span>${line.packLabel} · ${line.grindLabel}</span></span><input class="w-qty" type="number" inputmode="numeric" min="1" max="999" step="1" value="${line.quantity}" data-line-qty="${i}" aria-label="Bags of ${line.title}, ${line.packLabel}, ${line.grindLabel}"><button class="btn sm soft" type="button" data-sheet="remove-line" data-index="${i}" aria-label="Remove ${line.title} ${line.packLabel} ${line.grindLabel}">Remove</button></div>`) : html`<p class="hint">No bags on this order. Add at least one.</p>`}</div>
      <p class="hint" id="wLinesTotal">${total} ${total === 1 ? "bag" : "bags"} · ${weight(grams)}</p>
      <fieldset class="w-add-line"><legend>Add a coffee</legend>
        ${field("Coffee and grind", html`<select id="wAddCoffee"><option value="">Choose a coffee</option>${coffees.map((p) => html`<optgroup label="${p.title}">${p.grindOptions.filter((g) => g.enabled).map((g) => html`<option value="${p.id}|${g.id}">${p.name || p.title} · ${g.label}</option>`)}</optgroup>`)}</select>`)}
        <div class="w-add-row">${field("Bag size", html`<select id="wAddPack"><option value="quarter">250 g bag</option><option value="kilo">1 kg bag</option></select>`)}${field("Bags", html`<input id="wAddQty" type="number" inputmode="numeric" min="1" max="999" value="1">`)}</div>
        <button class="btn sm soft" type="button" data-sheet="add-line">Add to order</button></fieldset>
      ${row.standing ? html`<fieldset class="w-add-line w-scope"><legend>Change</legend><label class="w-check"><input type="radio" name="wScope" value="once" ${lines.scope !== "ongoing" ? "checked" : ""}> Just this delivery <span class="hint">(the next delivery goes back to the usual bags)</span></label><label class="w-check"><input type="radio" name="wScope" value="ongoing" ${lines.scope === "ongoing" ? "checked" : ""}> This and every delivery after it <span class="hint">(these become the usual bags)</span></label></fieldset>` : ""}
      <p class="hint">Bags already on the order keep their price; added bags use today's price. The order total and delivery charge are worked out again. The customer sees the updated order.</p></div>
      <footer class="w-editor-footer"><p class="err" id="wErr" role="alert"></p><div class="row w-actions"><button class="btn soft" type="button" data-sheet="lines-back">Back</button><button class="btn" type="submit">Save bags</button></div></footer></form>`, async (action, element) => {
      const form = element.closest("form") || element;
      const scopeInput = form.querySelector('input[name="wScope"]:checked'); if (scopeInput) lines.scope = scopeInput.value;
      for (const input of form.querySelectorAll("[data-line-qty]")) lines[Number(input.dataset.lineQty)].quantity = Number(input.value);
      const error = form.querySelector("#wErr");
      if (action === "lines-back") { editOrder(row.id, back, row); return; }
      if (action === "remove-line") { lines.splice(Number(element.dataset.index), 1); editLines(row, lines, back); return; }
      if (action === "add-line") {
        const [productId, grind] = form.querySelector("#wAddCoffee").value.split("|"), pack = form.querySelector("#wAddPack").value, quantity = Number(form.querySelector("#wAddQty").value);
        const product = coffees.find((p) => p.id === productId), option = product?.grindOptions.find((g) => g.id === grind);
        if (!product || !option) { error.textContent = "Choose a coffee and grind to add."; return; }
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) { error.textContent = "Choose from 1 to 999 bags."; return; }
        if (product.packs?.length === 1 && !product.packs.includes(pack)) { error.textContent = `${product.name || product.title} is sold in ${product.packs[0] === "kilo" ? "1 kg" : "250 g"} bags only.`; return; }
        const same = lines.find((l) => l.productId === productId && l.pack === pack && l.grind === grind);
        if (same) same.quantity += quantity;
        else lines.push({ productId, pack, grind, quantity, title: product.title, packLabel: pack === "kilo" ? "1 kg bag" : "250 g bag", grindLabel: option.label });
        editLines(row, lines, back); return;
      }
      if (action !== "submit") return;
      if (!lines.length) { error.textContent = "Keep at least one coffee on the order, or cancel the order instead."; return; }
      if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999)) { error.textContent = "Each line needs from 1 to 999 bags. Use Remove to take a coffee off."; return; }
      await saveForm(form, async () => {
        const result = await api("PUT", `/api/admin/wholesale/orders/${row.id}/lines`, { ifVersion: row.version, lines: lines.map(({ productId, pack, grind, quantity }) => ({ productId, pack, grind, quantity })), ...(row.standing ? { scope: lines.scope === "ongoing" ? "ongoing" : "once" } : {}) });
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
    openSheet(html`<form class="w-sheet w-order-sheet w-editor">${editorHead("Order details", "Close order details")}<div class="w-editor-body"><div class="w-order-heading"><h3>${row.business || row.createdName}</h3>${pill(row.status)}${row.preview === false ? "" : html`<span class="pill">Staff preview</span>`}</div><p class="w-id">${row.id}</p>
      ${nextStatus(row) ? html`<button class="btn sm soft w-sheet-pack" type="button" data-sheet="pack-order">${row.status === "Ready" ? "Process dispatch" : "Pack order"}</button>` : ""}
      <div class="kvs">${row.locationSnapshot?.name ? html`<div class="kv"><span>Location</span><span>${row.locationSnapshot.name}</span></div>` : ""}<div class="kv"><span>Received</span><span>${date(row.createdAt)}</span></div><div class="kv"><span>Reference</span><span>${row.reference || "None supplied"}</span></div><div class="kv"><span>${row.takenFor ? "Taken by" : "Ordered by"}</span><span>${row.takenFor ? `${row.createdName} (${row.takenFor.source.toLowerCase()})` : row.createdName}</span></div></div>
      ${row.customerNote ? html`<section class="w-order-section w-customer-note" aria-labelledby="wCustomerNoteTitle"><h3 id="wCustomerNoteTitle">Customer comments</h3><p class="w-address">${row.customerNote}</p></section>` : ""}
      <section class="w-order-section" aria-labelledby="wPackingTitle"><div class="w-section-head"><h3 id="wPackingTitle">Packing list</h3>${row.preview === false && ["New", "Preparing"].includes(row.status) ? html`<span class="row">${row.standing ? html`<button class="btn sm soft" type="button" data-sheet="skip-run">Skip this delivery</button>` : ""}<button class="btn sm soft" type="button" data-sheet="edit-lines">Edit bags</button></span>` : ""}</div>${row.amendedAt ? html`<p class="hint w-amended">Bags changed${row.amendedBy ? ` by ${row.amendedBy}${row.amendedByCustomer ? " (the customer)" : ""}` : ""} on ${date(row.amendedAt)}${row.repeatLines ? ", for this delivery only: the next delivery goes back to the usual bags" : ""}. The customer sees the updated order.</p>` : ""}${row.skipped ? html`<p class="hint w-amended">Delivery skipped by ${row.skipped.by}${row.skipped.customer ? " (the customer)" : ""} on ${date(row.skipped.at)}.</p>` : ""}${choices.length > 1 ? html`<div class="w-grind-filters" role="group" aria-label="Filter packing list by grind"><button type="button" data-sheet="grind-filter" data-grind-key="" aria-pressed="true">All grinds</button>${choices.map(grind => html`<button type="button" class="w-grind-tone" style="--w-grind-h:${grind.hue}" data-sheet="grind-filter" data-grind-key="${grind.key}" aria-pressed="false">${svg(grind.icon)}${grind.label}</button>`)}</div><p id="wGrindCount" class="hint" role="status">${row.lines.length} packing lines · Order totals include all lines.</p>` : ""}<div class="group w-packing-list">${row.lines.map((line, index) => { const grind = grinds[index]; return html`<div class="item w-packing-line w-grind-tone w-coffee-tone" style="--w-grind-h:${grind.hue};${coffeeStyle(line, data.products)}" data-grind-line="${grind.key}"><span class="w-pack-quantity"><b>${line.quantity}</b><span>${line.quantity === 1 ? "bag" : "bags"}</span></span><span class="tx"><b class="w-pack-coffee"><span class="w-coffee-swatch" aria-hidden="true"></span>${line.title}${decafLine(line) ? html`<span class="w-decaf-label">Decaf</span>` : ""}</b>${line.recipe ? html`<span class="w-recipe">Made from ${line.recipe}</span>` : ""}<span class="w-pack-size">${line.packLabel}</span><span class="w-grind-details"><span class="w-grind-badge">${svg(grind.icon)}${grind.label}</span>${grind.hint ? html`<span class="w-grind-hint">${grind.hint}</span>` : ""}</span></span><span class="end num">${money(line.price * line.quantity)}</span></div>`; })}</div><div class="kv"><span>${row.packs} ${row.packs === 1 ? "bag" : "bags"} · ${weight(row.grams)} total</span><strong>${money(row.pence)}</strong></div>${Number.isSafeInteger(row.deliveryPence) ? html`<div class="kv"><span>${row.delivery === "Delivery" ? "Delivery (including VAT)" : "Roastery collection"}</span><strong>${row.deliveryPence ? money(row.deliveryPence) : "Free"}</strong></div><div class="kv"><span>Order total</span><strong>${money(row.totalPence ?? row.pence + row.deliveryPence)}</strong></div>` : ""}</section>
      <section class="w-order-section" aria-labelledby="wDeliveryTitle"><h3 id="wDeliveryTitle">${row.delivery}</h3>${snapshot ? html`<p class="w-address">${[snapshot.contact, snapshot.email, snapshot.phone].filter(Boolean).join(" · ") || "No contact details recorded"}</p>${row.delivery === "Delivery" ? html`<div class="kvs"><div class="kv"><span>Delivery address at checkout</span><span class="w-address">${[snapshot.address, snapshot.postcode].filter(Boolean).join("\n") || "Not recorded"}</span></div><div class="kv"><span>Delivery instructions</span><span class="w-address">${row.deliveryNotes || "None supplied"}</span></div></div>` : ""}` : html`<p class="hint">Staff preview order.</p>`}</section>
      ${row.preview === false ? html`<section class="w-order-section" aria-labelledby="wTermsTitle"><h3 id="wTermsTitle">Payment terms at order</h3><p>${row.paymentTerms?.label || "Not recorded on this order"}</p>${row.paymentTerms?.note ? html`<p class="w-address">${row.paymentTerms.note}</p>` : ""}</section>` : ""}
      ${invoiceUI.orderPanel(row)}
      ${row.preview === false && row.customerId ? html`<section class="w-order-section" aria-labelledby="wTabTitle"><div class="w-section-head"><h3 id="wTabTitle">Customer tab</h3>${row.tabClearedId ? "" : html`<button class="btn sm soft" type="button" data-sheet="tab-toggle">${row.tab ? "Take off tab" : "Put on tab"}</button>`}</div>
        <p class="hint">${row.tabClearedId ? "On a tab that has been cleared." : row.tab ? `On this customer’s tab${row.tab.auto ? " (added automatically)" : row.tab.by ? ` (added by ${row.tab.by})` : ""}.` : "Not on a tab."} Tabs are cleared in Wholesale → Tabs here, or on the staff <a href="${(data.links?.diary || "").replace(/\/$/, "")}/orders#tabs">Wholesale orders page</a>.</p></section>` : ""}
      ${row.preview === false ? scheduleSection(row, draft?.schedule) : ""}
      <section class="w-order-section w-order-management" aria-labelledby="wManageTitle"><h3 id="wManageTitle">Manage order</h3>${field("Order status", html`<select id="wStatus">${data.statuses.map((value) => html`<option ${value === (draft?.status ?? row.status) ? raw("selected") : ""}>${value}</option>`)}</select>`)}
      ${row.preview === false ? html`<div class="field"><span class="fl">Customer</span><p id="wCustomerName">${selectedCustomer ? customer(selectedCustomer)?.business || snapshot?.business || row.business : "Not linked to a customer"}</p></div>` : field("Customer", html`<select id="wCustomer"><option value="">Not linked to a customer</option>${selectedCustomer && !customer(selectedCustomer) ? html`<option value="${selectedCustomer}" selected>${snapshot?.business || row.business}</option>` : ""}${data.customers.map((value) => html`<option value="${value.id}" ${value.id === selectedCustomer ? raw("selected") : ""}>${value.business}</option>`)}</select>`)}
      ${field("Tracking link (optional)", html`<input id="wTrackingUrl" type="url" inputmode="url" maxlength="2000" placeholder="https://" autocapitalize="none" spellcheck="false" autocomplete="off" value="${draft?.trackingUrl ?? row.trackingUrl ?? ""}">`)}<p class="hint">Add, edit or clear the link. Customers see it on dispatched delivery orders.</p>
      ${field("Internal note", html`<textarea id="wNote" maxlength="1000">${draft?.note ?? row.note}</textarea>`)}</section>${note}<div class="w-order-danger"><button class="btn bad" type="button" data-sheet="delete-order">Delete order</button></div></div><footer class="w-editor-footer">${buttons("Save order")}</footer></form>`, async (action, element) => {
      const form = element.closest("form");
      if (action === "pack-order") {
        const draft = draftOf(form, row);
        if (draft.status === row.status) delete draft.status;
        openPackingSheet(row, () => editOrder(row.id, draft, packingRow(row.id)));
        return;
      }
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
      if (action === "skip-run") {
        if (!confirm(`Skip this delivery for ${row.business}? Nothing goes out${row.dispatchDate ? ` on ${new Date(row.dispatchDate + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}` : ""}, and the next delivery is made with the usual bags.`)) return;
        await saveForm(form, async () => {
          await api("POST", `/api/admin/wholesale/orders/${row.id}/skip`, { ifVersion: row.version });
          await reload(); toast("Delivery skipped. The next one is made.");
          const fresh = data.orders.find((r) => r.id === row.id); if (fresh) editOrder(row.id, null, fresh);
        });
        return;
      }
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
    return row.locations?.length ? row.locations.map((location) => ({ ...location })) : [{ id: "primary", name: row.business || "Main location", ...Object.fromEntries(locationKeys.map((key) => [key, row[key] || ""])) }];
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
      const fields = { business: "wBusiness", contact: "wContact", email: "wEmail", accountsEmail: "wAccountsEmail", phone: "wPhone", address: "wAddress", postcode: "wPostcode", deliveryNotes: "wDeliveryNotes", paymentTerms: "wPaymentTerms", paymentNote: "wPaymentNote", status: "wStatus", note: "wNote" };
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
      ${field("Order email (optional)", html`<input id="wEmail" type="email" value="${state.email || ""}" maxlength="150">`)}
      ${field("Accounts email (optional, if different)", html`<input id="wAccountsEmail" type="email" value="${state.accountsEmail || ""}" maxlength="150" placeholder="For invoices and statements">`)}
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
      <div class="checks w-minimum-check"><label><input id="wAutoTab" type="checkbox" ${state.autoTab ? raw("checked") : ""}>Put orders on a tab</label></div><p class="hint">Each new order goes on this business’s tab automatically. Tabs are cleared in Wholesale → Tabs, or on the staff Wholesale orders page, when they reach 6 kg, or sooner.</p></section>
      ${id ? ((own) => html`<section class="w-customer-card" aria-labelledby="wWlCustomerTitle"><h3 id="wWlCustomerTitle">Custom coffees</h3>${own.length ? html`<div class="group">${own.map((p) => html`<div class="item w-coffee-tone" style="${coffeeStyle(p)}"><span class="tx"><b><span class="w-coffee-swatch" aria-hidden="true"></span>${p.title}</b><span>${sizesText(p)}${p.active ? "" : " · Hidden"}</span>${p.recipe?.length ? html`<span>Made from ${p.recipe.map((r) => `${r.percent}% ${r.name}`).join(" · ")}</span>` : ""}</span></div>`)}</div>` : html`<p class="hint">None yet.</p>`}<p class="hint">These coffees are available to this business and any other selected customers. Manage access, prices and recipes in Custom coffees.</p></section>`)(data.products.filter((p) => p.whiteLabel?.includes(id))) : ""}
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
  // copyOf: the coffee being duplicated. The copy opens as a new coffee with everything filled in from it (prices, sizes,
  // grinds, colours, white label and recipe) except photos, and starts hidden so customers don't see it until it's ready.
  function editCoffee(id, copyOf = null) {
    let current = id ? data.products.find((row) => row.id === id) : copyOf ? { ...copyOf, id: null, title: `${copyOf.title} (copy)`, name: `${copyOf.name || copyOf.title} (copy)`, active: false, images: [], imageUrls: [], version: 0 } : { id: null, title: "", name: "", origin: "", process: "", notes: "", badge: "", categories: ["single-origin"], prices: { quarter: 0, half: 0, kilo: 0 }, active: true, inStock: true, images: [], imageUrls: [], version: 0 };
    if (!current) return;
    if (!id && !copyOf && tab === "custom") current = { ...current, customerOnly: true, whiteLabel: [], active: false };
    let form, busy = false, pendingRemoval = null, colourChoice = copyOf?.colours?.length ? { colours: [...copyOf.colours], colourStyle: copyOf.colourStyle || "solid" } : undefined;
    const drawPhotos = () => {
      if (!form?.isConnected) return;
      const content = html`${current.imageUrls.length ? html`<div class="w-photos">${current.imageUrls.map((url, i) => html`<div class="w-photo"><img src="${url}" alt="${current.title} photo ${i + 1}"><button class="btn sm soft" type="button" data-sheet="photo-remove" data-ref="${current.images[i]}" aria-label="Remove photo ${i + 1}">Remove</button>${pendingRemoval === current.images[i] ? html`<div class="w-photo-confirm" role="group" aria-label="Remove this photo"><p>Remove this uploaded photo?</p><button class="btn sm bad" type="button" data-sheet="photo-confirm" data-ref="${current.images[i]}">Confirm remove photo</button><button class="btn sm soft" type="button" data-sheet="photo-keep">Keep photo</button></div>` : ""}</div>`)}</div>` : html`<p class="hint">No photos yet.</p>`}${current.sourceImage && !current.images.includes("source:" + current.image) ? html`<button class="btn sm soft" type="button" data-sheet="photo-restore">Restore original photo</button>` : ""}`;
      put(form.querySelector('#wPhotos'), content);
    };
    const defaultOptions = [["beans", "Beans", "Whole beans, for your own grinder"], ["espresso", "Fine", "Commercial espresso machine"], ["filter", "Medium", "Filter"], ["cafetiere", "Coarse", "Cafetiere and batch brewers"]].map(([id, label, hint]) => ({ id, label, hint, enabled: true }));
    const grindRow = option => html`<div class="w-grind-row" data-grind-id="${option.id}"><label class="field"><span class="fl">Grind name</span><input data-grind-label value="${option.label}" maxlength="60" required></label><label class="field"><span class="fl">What it's for (optional)</span><input data-grind-hint value="${option.hint || ""}" maxlength="120" placeholder="e.g. Commercial espresso machine"></label><label class="w-grind-enabled"><input type="checkbox" data-grind-enabled ${option.enabled ? raw("checked") : ""}>Available</label><button type="button" class="btn soft sm" data-sheet="grind-remove" aria-label="Remove ${option.label}">${svg("x")}</button></div>`;
    const others = data.products.filter((p) => p.id !== current.id);
    const recipeRow = (part) => html`<div class="w-recipe-row" data-recipe><label class="field"><span class="fl">Coffee</span><select data-recipe-coffee><option value="">Another coffee (type its name)</option>${others.map((p) => html`<option value="${p.id}" ${p.id === part.coffee ? raw("selected") : ""}>${p.name || p.title}</option>`)}</select></label><label class="field" ${part.coffee ? raw("hidden") : ""}><span class="fl">Name</span><input data-recipe-name value="${part.coffee ? "" : part.name || ""}" maxlength="80" placeholder="e.g. Brazil Cerrado"></label><label class="field w-recipe-pc"><span class="fl">%</span><input data-recipe-percent type="number" min="1" max="100" step="1" inputmode="numeric" value="${part.percent || ""}" required></label><button type="button" class="btn soft sm" data-sheet="recipe-remove" aria-label="Remove this part">${svg("x")}</button></div>`;
    openSheet(html`<form id="wCoffeeForm" class="w-sheet w-editor">${editorHead(id ? "Edit coffee" : copyOf ? "Duplicate coffee" : tab === "custom" ? "Add custom coffee" : "Add coffee", "Close coffee editor")}<div class="w-editor-body">${id ? html`<button class="btn sm soft w-duplicate" type="button" data-sheet="duplicate">${svg("plus")}Duplicate this coffee</button>` : copyOf ? html`<p class="hint">A copy of ${copyOf.title}. Change what you need and add it. It starts hidden from customers; photos aren't copied.</p>` : ""}
      ${field("Product name", html`<input id="wCoffeeTitle" value="${current.title}" maxlength="180" required>`)}
      ${field("Short name (optional)", html`<input id="wCoffeeName" value="${current.name}" maxlength="120" placeholder="For catalogue cards">`)}
      ${field("Origin", html`<input id="wCoffeeOrigin" value="${current.origin}" maxlength="100">`)}
      ${field("Process", html`<input id="wCoffeeProcess" value="${current.process}" maxlength="120">`)}
      ${field("Tasting notes", html`<textarea id="wCoffeeNotes" maxlength="400">${current.notes}</textarea>`)}
      ${field("Photo label (optional)", html`<input id="wCoffeeBadge" value="${current.badge}" maxlength="60" placeholder="e.g. Natural">`)}
      <fieldset class="w-categories"><legend>Categories</legend>${[["single-origin","Single origin"],["blend","Blend"],["decaf","Decaf"]].map(([key,label]) => html`<label><input type="checkbox" name="coffeeCategory" value="${key}" ${current.categories.includes(key) ? raw("checked") : ""}>${label}</label>`)}</fieldset>
      <fieldset class="w-sizes"><legend>Bag sizes and prices</legend>${[["quarter", "250 g bags", "250 g bag (£)"], ["kilo", "1 kg bags", "1 kg bag (£)"]].map(([key, sold, label]) => html`<div class="w-size"><label class="w-size-on"><input type="checkbox" data-pack-on="${key}" ${!current.packs?.length || current.packs.includes(key) ? raw("checked") : ""}>Sell ${sold}</label>${field(label, html`<input id="wPrice-${key}" type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required value="${current.prices?.[key] ? (current.prices[key] / 100).toFixed(2) : ""}">`)}</div>`)}<p class="hint" id="wSizesHint">Turn one size off for a coffee only sold in the other, such as a white-label blend in 1 kg bags. Customers then see only the size on sale.</p></fieldset>
      <div class="checks"><label><input id="wActive" type="checkbox" ${current.active ? raw("checked") : ""}>Visible in catalogue</label><label><input id="wInStock" type="checkbox" ${current.inStock ? raw("checked") : ""}>In stock</label></div><p class="hint">Out-of-stock coffees remain visible but cannot be ordered. Hidden coffees are removed from the ordering list.</p>
      <section aria-labelledby="wWlTitle"><h3 id="wWlTitle">Customer visibility</h3><div class="checks"><label><input id="wWhiteLabel" type="checkbox" ${isCustomCoffee(current) ? raw("checked") : ""}>Only selected customers can see and order this coffee</label></div><p class="hint" id="wVisibilityHint"></p>
        <div id="wWlPick" ${isCustomCoffee(current) ? "" : raw("hidden")}><label class="field"><span class="fl">Find a business</span><input id="wWlSearch" type="search" autocomplete="off" placeholder="Business name"></label><p class="hint" id="wWlCount" aria-live="polite"></p><div id="wWlList" class="w-wl-list" role="group" aria-label="Businesses this coffee belongs to"><p class="hint">Loading businesses…</p></div></div></section>
      <section aria-labelledby="wRecipeTitle"><h3 id="wRecipeTitle">Made from</h3><p class="hint">What this coffee or blend is made of, for wholesale staff: shown on orders, packing sheets and Bags to process, never to customers. Leave empty for a single coffee.</p><div id="wRecipe">${(current.recipe || []).map(recipeRow)}</div><p class="hint" id="wRecipeTotal" aria-live="polite"></p><button class="btn soft" type="button" data-sheet="recipe-add">${svg("plus")}Add a coffee</button></section>
      <section aria-labelledby="wColourTitle"><h3 id="wColourTitle">Packaging colour</h3><p class="hint" id="wColourSource"></p><div class="w-colour-row"><span class="w-coffee-swatch w-coffee-swatch-lg" id="wColourPreview" aria-hidden="true"></span>${[["A", "Colour"], ["B", "Second colour"]].map(([key, label]) => html`<div class="w-colour-pick" id="wColourPick${key}"><span class="fl">${label}</span><span class="w-colour-inputs"><input type="color" id="wColour${key}" aria-label="${label}"><input id="wColour${key}Hex" type="text" maxlength="7" placeholder="#4B8E68" autocapitalize="characters" spellcheck="false" autocomplete="off" aria-label="${label} hex code"></span></div>`)}</div>
      <div class="checks"><label><input id="wColourTwo" type="checkbox">Two colours (shown as stripes)</label><label><input id="wColourStriped" type="checkbox">Striped, to tell it from a similar colour</label></div><button class="btn soft sm" type="button" data-sheet="colour-reset">Use the packaging or automatic colour</button></section>
      <section aria-labelledby="wGrindTitle"><h3 id="wGrindTitle">Grind options</h3><p class="hint">Choose the names and options customers can order for this coffee. Keep at least one available. Changes save with the coffee; existing orders keep their original details.</p><div id="wGrindOptions">${(current.grindOptions || defaultOptions).map(grindRow)}</div><button class="btn soft" type="button" data-sheet="grind-add">${svg("plus")}Add grind option</button></section>
      <h3>Photos</h3><div id="wPhotos"></div>${id ? html`<label class="field"><span class="fl">Add photos</span><input id="wPhotoFiles" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="hint">Photos save immediately. Up to six per coffee. JPEG, PNG or WebP, up to 5 MB each.</p><button class="btn soft" type="button" data-sheet="photo-upload">Upload photos</button>` : html`<p class="hint">Save the coffee, then add its photos.</p>`}
      </div><footer class="w-editor-footer">${buttons(id ? "Save coffee" : copyOf ? "Add the copy" : "Add coffee")}</footer></form>`, async (action, element) => {
      if (busy) return;
      if (action === "grind-add") {
        if (form.querySelectorAll("[data-grind-id]").length >= 20) { form.querySelector("#wErr").textContent = "Each coffee supports up to 20 grind options."; return; }
        const holder = document.createElement("div"); put(holder, grindRow({ id: "grind-" + crypto.randomUUID(), label: "", enabled: true }));
        const row = holder.firstElementChild; form.querySelector("#wGrindOptions").append(row); row.querySelector("input").focus(); return;
      }
      if (action === "grind-remove") { element.closest("[data-grind-id]").remove(); return; }
      if (action === "colour-reset") { colourChoice = null; drawColour(); return; }
      if (action === "duplicate") { editCoffee(null, current); return; }
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
          const packs = ["quarter", "kilo"].filter((key) => form.querySelector(`[data-pack-on="${key}"]`).checked);
          if (!packs.length) throw new Error("Sell this coffee in at least one bag size.");
          const prices = Object.fromEntries(["quarter", "kilo"].filter((key) => packs.includes(key) || value("#wPrice-" + key) !== "").map((key) => [key, Math.round(Number(value("#wPrice-" + key)) * 100)]));
          const whiteLabel = form.querySelector("#wWhiteLabel").checked ? [...chosen] : [];
          const customerOnly = form.querySelector("#wWhiteLabel").checked;
          const recipe = readRecipe();
          if (recipe.length && recipe.reduce((t, p) => t + p.percent, 0) !== 100) throw new Error("The recipe's percentages need to add up to 100.");
          const result = await api(id ? "PUT" : "POST", "/api/admin/wholesale/catalogue" + (id ? "/" + current.id : ""), { ifVersion: current.version, title: value('#wCoffeeTitle'), name: value('#wCoffeeName') || value('#wCoffeeTitle'), origin: value('#wCoffeeOrigin'), process: value('#wCoffeeProcess'), notes: value('#wCoffeeNotes'), badge: value('#wCoffeeBadge'), categories: [...form.querySelectorAll('[name="coffeeCategory"]:checked')].map(input => input.value), grindOptions: [...form.querySelectorAll("[data-grind-id]")].map(row => ({ id: row.dataset.grindId, label: row.querySelector("[data-grind-label]").value.trim(), hint: row.querySelector("[data-grind-hint]").value.trim(), enabled: row.querySelector("[data-grind-enabled]").checked })), prices, active: form.querySelector('#wActive').checked, inStock: form.querySelector('#wInStock').checked, packs, whiteLabel, customerOnly, recipe, ...(colourChoice === undefined ? {} : colourChoice === null ? { colours: null } : colourChoice) });
          const stillOpen = form.isConnected;
          if (stillOpen) closeSheet();
          const destination = customerOnly ? "custom" : "catalogue";
          if (stillOpen && tab !== destination) await onSectionChange(destination);
          else await reload();
          toast(id ? "Coffee saved." : "Coffee added. You can now add photos.");
          if (!id && stillOpen) editCoffee(result.product.id);
        }
      } catch (error) { if (form.isConnected) { form.querySelector('#wErr').textContent = error.message; form.querySelector('#wErr').scrollIntoView({ block: "nearest" }); } else toast(error.message); }
      finally { busy = false; form.removeAttribute("aria-busy"); drawPhotos(); buttons.forEach((button) => { if (button.isConnected) button.disabled = false; }); }
    });
    form = $('#wCoffeeForm');
    // Bag sizes: a size that's off keeps its price box (greyed, not needed), so turning it back on is one tick.
    const drawSizes = () => { if (!form.isConnected) return; for (const box of form.querySelectorAll("[data-pack-on]")) { const input = form.querySelector("#wPrice-" + box.dataset.packOn); input.disabled = !box.checked; input.required = box.checked; } };
    form.querySelectorAll("[data-pack-on]").forEach((box) => box.addEventListener("change", () => { if (![...form.querySelectorAll("[data-pack-on]")].some((b) => b.checked)) { box.checked = true; form.querySelector("#wErr").textContent = "Sell this coffee in at least one bag size."; } drawSizes(); }));
    drawSizes();
    // White label: the businesses it belongs to (all of them listed, searchable; ticked ones first).
    const chosen = new Set(current.whiteLabel || []);
    let names = null;
    const updateVisibility = () => {
      const picked = (names || []).filter(c => chosen.has(c.id)).map(c => c.business);
      form.querySelector("#wWlCount").textContent = !form.querySelector("#wActive").checked
        ? "Hidden in the catalogue. Assigned businesses: " + (picked.join(", ") || "none") + "."
        : picked.length ? "Visible to " + picked.join(", ") + "." : "Private. No businesses selected.";
    };
    form.querySelector("#wActive").addEventListener("change", updateVisibility);
    const drawBusinesses = () => {
      if (!form.isConnected || !names) return;
      const q = form.querySelector("#wWlSearch").value.trim().toLowerCase();
      const shown = names.filter((c) => !q || c.business.toLowerCase().includes(q)).sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id))).slice(0, 80);
      put(form.querySelector("#wWlList"), shown.length ? html`${shown.map((c) => html`<label><input type="checkbox" data-wl value="${c.id}" ${chosen.has(c.id) ? raw("checked") : ""}><span>${c.business || "Unnamed business"}</span></label>`)}` : html`<p class="hint">No business matches.</p>`);
      updateVisibility();
    };
    const loadBusinesses = async () => {
      if (names) return drawBusinesses();
      form.querySelector("#wWlList").replaceChildren(SC.skeleton({label:"Loading businesses…",rows:2}));
      try {
        names = (await api("GET", "/api/admin/wholesale/customers/names")).customers;
        // Keep unavailable saved choices removable, without inventing a replacement customer.
        for (const id of chosen) if (!names.some(row => row.id === id)) names.push({ id, business: "Unavailable customer" });
        drawBusinesses();
      }
      catch (error) { if (form.isConnected) put(form.querySelector("#wWlList"), html`<p class="hint">${error.message}</p>`); }
    };
    const drawVisibility = () => {
      const only = form.querySelector("#wWhiteLabel").checked;
      form.querySelector("#wWlPick").hidden = !only;
      form.querySelector("#wVisibilityHint").textContent = only ? "Only the selected customers can see and order this coffee. Without a selection it stays private. Staff preview can see all custom coffees." : "This coffee is available to all approved wholesale customers when visible. Select the option above to restrict it to chosen customers.";
      if (only) loadBusinesses();
    };
    form.querySelector("#wWhiteLabel").addEventListener("change", drawVisibility);
    drawVisibility();
    form.querySelector("#wWlSearch").addEventListener("input", drawBusinesses);
    form.querySelector("#wWlList").addEventListener("change", (event) => { const box = event.target.closest("[data-wl]"); if (!box) return; box.checked ? chosen.add(box.value) : chosen.delete(box.value); updateVisibility(); });

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
    clear() { invoiceUI.clear(); insightsUI.clear(); sequence++; emailHealthToken++; packingSession++; data = null; previewOrder = packingOrder = ""; hideOrderPreview = false; quickBusy.clear(); orderErrors.clear(); emailDraft = null; batch = null; picked.clear(); picking = false; clearTimeout(timer); },
    view,
    navigation,
    syncNavigation,
    openNavigation,
    selectSection,
    currentSection: () => tab,
    workspaceState, restoreWorkspace,
    openInvoiceQueue: queue => invoiceUI.setFilter(queue),
    openRoastPlan: insightsUI.openRoastPlan,
    searchInvoices: invoiceUI.search,
    async act(name, id) {
      if (name.startsWith("wh-invoice-")) { await invoiceUI.act(name, id); return; }
      if (name.startsWith("wh-ins-")) { await insightsUI.act(name, id); return; }
      if (name.startsWith("wh-tabs-")) { await tabsUI.act(name, id); return; }
      if (name === "wh-standing-review") { selectSection("orders"); query = id; status = "all"; orderQueue = ""; await reload(); editOrder(id); return; }
      if (name === "wh-queue") { clearTimeout(timer); orderQueue = ["prepare", "ready"].includes(id) ? id : ""; status = id === "open" ? "open" : "all"; orderPages = 1; previewOrder = packingOrder = ""; await reload(); return; }
      if (name === "wh-review-queue") { $("#wStandingIssues")?.scrollIntoView({ block: "center" }); $("#wStandingIssues button")?.focus({ preventScroll: true }); return; }
      if (name === "wh-privacy") { setFiguresHidden(!figuresHidden()); return; }
      if (name === "wh-full-queue") { hideOrderPreview = !hideOrderPreview; drawOrderPreview(); return; }
      if (name === "wh-dispatch-scope" && ["all","today","upcoming"].includes(id)) {
        dispatchScope = id; packingOrder = ""; orderPages = 1; await reload(); $("#wDispatchScope")?.focus({ preventScroll:true }); return;
      }
      if (name === "wh-sort") {
        sortChosen = true;
        orderSort = id === "dispatch" ? (orderSort === "dispatch" ? "dispatch-desc" : "dispatch") : id === "ordered" ? (orderSort === "ordered" ? "ordered-asc" : "ordered") : (orderSort === "bags" ? "bags-asc" : "bags");
        orderPages = 1; await reload(); $(`[data-act="wh-sort"][data-id="${id}"]`)?.focus({ preventScroll:true }); return;
      }
      if (name === "wh-pack" || name === "wh-exit-pack") {
        packingOrder = name === "wh-pack" ? id : ""; drawOrderPreview();
        ($("#wPackChecklist [data-pack-line]:enabled:not(:checked)") || $("#wPackChecklist [data-pack-next]:enabled") || $('[data-act="wh-pack"]'))?.focus({ preventScroll:true });
        return;
      }
      if (name === "wh-preview-invoice") {
        const row = data.orders.find(order => order.id === id);
        if (row) await invoiceUI.openOrder(row, () => { closeSheet(); document.querySelector('[data-act="wh-preview-invoice"]')?.focus({ preventScroll: true }); });
        return;
      }
      if (name === "wh-edit-preview") { editOrder(id); return; }
      if (name === "wh-order-emails") { await openOrderEmails(); return; }
      if (name === "wh-announcement") { await openAnnouncement(); return; }
      if (name === "wh-print-shown" && data.orders.length && data.orders.length <= 200) { await printUI.printOrders({ ids: data.orders.map(row => row.id), label: "Orders in this view" }); return; }
      if (name === "wh-print-one" && id) { await printUI.printOrders({ ids: [id], label: "Order packing list" }); return; }
      if (name === "wh-print-new") { await printUI.printOrders(printUI.scopes.New); return; }
      if (name === "wh-totals") { await printUI.openTotals(picking ? [...picked] : []); return; }
      if (name === "wh-pick-start" || name === "wh-pick-done") { if (batch?.running) return; picking = name === "wh-pick-start"; picked.clear(); batch = null; await reload(); return; }
      if (name === "wh-batch" && id) { if (batch?.running) return; if (id === "Dispatched") { batch = { confirm: true }; refreshBatch(); $('[data-act="wh-batch-confirm"]')?.focus({ preventScroll: true }); } else await runBatch(id); return; }
      if (name === "wh-batch-confirm") { await runBatch("Dispatched"); return; }
      if (name === "wh-batch-cancel") { batch = null; refreshBatch(); return; }
      if (name === "wh-pick" && id) { picked.has(id) ? picked.delete(id) : picked.add(id); refreshPicks(); return; }
      if (name === "wh-pick-all") { for (const row of data.orders) picked.add(row.id); refreshPicks(); return; }
      if (name === "wh-print-picked" && picked.size) { await printUI.printOrders({ ids: [...picked], label: `${picked.size} selected ${picked.size === 1 ? "order" : "orders"}` }); return; }
      if (name === "wh-import-customers") { openCustomerImport(); return; }
      if (name === "wh-accounts-emails") { openAccountsEmails(); return; }
      if (name === "wh-invite-customers") { await openInvites(); return; }
      if (name === "wh-tab" && selectSection(id)) await reload();
      if ((name === "wh-status" || name === "wh-status-select") && ["all", "open", ...data.statuses].includes(id)) { clearTimeout(timer); orderQueue = ""; packingOrder = ""; status = id; orderPages = 1; await reload(); if (name === "wh-status-select") $("#wOrderStatus")?.focus({ preventScroll:true }); }
      if (name === "wh-approval" && ["all", "pending"].includes(id)) { clearTimeout(timer); approval = id; customerPages = 1; await reload(); }
      if (name === "wh-pending") { selectSection("customers", { pending: true }); await reload(); }
      if (name === "wh-clear") { clearTimeout(timer); query = ""; orderQueue = ""; status = approval = dispatchScope = "all"; orderPages = customerPages = 1; await reload(); $("#wq")?.focus({ preventScroll: true }); }
      if (name === "wh-more" && id === tab && data.nextCursor && !loadingMore) { loadingMore = true; const button = $(".w-more button"); if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); } try { if (id === "orders") orderPages++; else if (id === "customers") customerPages++; await reload(); } finally { loadingMore = false; } }
      if (name === "wh-next") await advanceOrder(id);
      if (name === "wh-refresh-orders") { orderErrors.delete(id); await reload(); (document.querySelector(`[data-act="wh-next"][data-id="${id}"]`) || document.querySelector(`[data-act="wh-order"][data-id="${id}"]`))?.focus({ preventScroll: true }); }
      if (name === "wh-order") {
        if (!wideOrders.matches || hideOrderPreview) editOrder(id);
        else { if (previewOrder !== id) packingOrder = ""; previewOrder = id; hideOrderPreview = false; drawOrderPreview(); }
      }
      if (name === "wh-customer") editCustomer(id);
      if (name === "wh-coffee") editCoffee(id);
    },
    search(value) {
      query = value; packingOrder = ""; orderPages = customerPages = 1; clearTimeout(timer);
      timer = setTimeout(async () => { await reload(); const input = $("#wq"); if (input) { input.focus(); input.setSelectionRange(query.length, query.length); } }, 250);
    },
  };
};
