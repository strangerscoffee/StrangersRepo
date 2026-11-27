// The staff admin workspace for the separate consumer storefront.
window.AdminConsumer = ({ api, html, raw, svg, put, head, toast, confirmSheet, openSection }) => {
  const endpoint = "/api/admin/consumer";
  const previewUrl = "https://preview.staffstrangerscoffee.com/";
  const tabs = [
    ["overview", "Overview"], ["orders", "Orders"], ["customers", "Customers"], ["products", "Products"], ["support", "Support"], ["editor", "Site editor"],
  ];
  const statuses = [
    ["placed", "Placed", "acc"],
    ["preparing", "Preparing", "warn"],
    ["ready", "Ready", "ok"],
    ["dispatched", "Dispatched", "acc"],
    ["completed", "Completed", ""],
    ["cancelled", "Cancelled", "bad"],
  ];
  const statusById = new Map(statuses.map(([id, label, tone]) => [id, { label, tone }]));
  const readinessStates = new Map([
    ["ready", ["Ready", "ok"]], ["pending", ["Pending", "warn"]],
    ["paused", ["Paused", "warn"]], ["blocked", ["Blocked", "bad"]],
  ]);
  const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
  const dateTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
  const money = pence => Number.isFinite(pence) ? currency.format(pence / 100) : "—";
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? dateTime.format(new Date(value)) : "—";
  const method = value => ({ delivery: "Delivery", collection: "Collection" })[value] || "—";
  const endpointFor = (area, id) => `${endpoint}/${area}/${encodeURIComponent(id)}`;

  let data, section = "overview", orderFilter = "to-pack", message = "", updating = false, generation = 0;
  let queue = { orders: [], count: 0, nextCursor: null, summary: {} }, selectedReference = "", queueVersion = 0, searchTimer;
  let queuePending = false, orderDrilledIn = false, browseScroll = 0;
  const orderCache = new Map(), packing = new Map(), trackingDrafts = new Map(), orderErrors = new Map(), blockedOrders = new Set();
  const orderReloads = new Map();
  let supportInbox, supportPending = false, supportVersion = 0;
  let queries = {};
  const writes = new Set();
  const find = id => document.getElementById(id);
  const matches = (...values) => {
    const query = (queries[section] || "").trim().toLowerCase();
    return values.some(value => String(value ?? "").toLowerCase().includes(query));
  };

  function storefront() {
    try {
      const url = new URL(data?.previewUrl || previewUrl);
      if (url.protocol === "https:") return url.href;
    } catch { /* The default preview link is always available. */ }
    return previewUrl;
  }

  const badge = (label, tone) => html`<span class="pill ${tone}">${label}</span>`;
  function orderBadge(status) {
    const known = statusById.get(status);
    return known ? badge(known.label, known.tone) : badge("Status unavailable", "");
  }
  const empty = (icon, label) => html`<div class="consumer-empty"><span class="ic acc">${svg(icon)}</span><p>${label}</p></div>`;
  const heading = (title, note) => html`<header class="consumer-panel-title"><h2>${title}</h2>${note ? html`<p>${note}</p>` : ""}</header>`;

  function navigation(active = section) {
    const panelId = active === "editor" ? "consumerEditor" : active === "products" ? "consumerProducts" : "consumerPanel";
    return html`<div class="seg consumer-tabs" id="consumerTabs" role="group" aria-label="Consumer sections">
      ${tabs.map(([id, label]) => html`<button type="button" data-act="consumer-tab" data-id="${id}" aria-controls="${panelId}" aria-pressed="${String(active === id)}">${label}</button>`)}
    </div><label class="field consumer-section-picker"><span class="fl">Consumer section</span>
      <select id="consumerSection" aria-controls="${panelId}">
        ${tabs.map(([id, label]) => html`<option value="${id}" ${active === id ? raw("selected") : ""}>${label}</option>`)}
      </select>
    </label>`;
  }

  function overview() {
    const { orders, orderCount, customers, products, readiness, settings } = data;
    const checkoutEnabled = settings.acceptOrders;
    const summaries = [
      ["orders", "bag", "Preview orders", orderCount ?? orders.length],
      ["customers", "people", "Recent profiles", customers.length],
      ["products", "coffee", "Available products", products.filter(product => product.available).length],
    ];
    return html`
      <div class="consumer-summary" aria-label="Preview summary">
        ${summaries.map(([id, icon, title, number]) => html`<button class="item glass consumer-stat" type="button" data-act="consumer-tab" data-id="${id}">
          <span class="ic acc">${svg(icon)}</span><span class="consumer-stat-text"><b class="num">${number}</b><span>${title}</span></span><span class="chev">${svg("chev")}</span>
        </button>`)}
      </div>
      <div class="consumer-overview">
        <section class="group glass consumer-card" aria-label="Beta readiness">
          ${heading("Beta readiness", "Storefront services and launch dependencies")}
          ${readiness.length ? html`<ul class="consumer-list" role="list">
            ${readiness.map(check => {
              const [label, tone] = readinessStates.get(check.state) || ["Needs review", "warn"];
              return html`<li class="item consumer-readiness"><span class="tx"><b>${check.label}</b>${check.detail ? html`<span>${check.detail}</span>` : ""}</span>${badge(label, tone)}</li>`;
            })}
          </ul>` : empty("tune", "No readiness checks available.")}
        </section>
        <section class="group glass consumer-card" aria-label="Signed-in checkout">
          ${heading("Signed-in checkout")}
          <div class="consumer-checkout">
            ${badge(checkoutEnabled === true ? "Accepting orders" : checkoutEnabled === false ? "Paused" : "Unavailable", checkoutEnabled === true ? "ok" : "warn")}
            <p>${checkoutEnabled ? "Signed-in customers can place test orders. Fulfilment updates their order history." : "Existing preview orders remain available while checkout is paused."}</p>
            <p class="hint">Test orders carry no charge or shipment booking.</p>
            ${typeof checkoutEnabled === "boolean" ? html`<button class="btn soft" type="button" data-act="consumer-checkout" ${writes.has("checkout") ? raw("disabled") : ""}>${checkoutEnabled ? "Pause checkout" : "Resume checkout"}</button>` : ""}
          </div>
        </section>
      </div>`;
  }

  function searchTools(label, placeholder, hasOrderFilter) {
    return html`<div class="consumer-tools">
      <label class="search">${svg("search")}<input id="consumerSearch" type="search" aria-label="${label}" placeholder="${placeholder}" value="${queries[section] || ""}" maxlength="120"></label>
      ${hasOrderFilter ? html`<label class="field"><select id="consumerOrderFilter" aria-label="Order status">
        <option value="">All statuses</option>
        <option value="to-pack" ${orderFilter === "to-pack" ? raw("selected") : ""}>To pack</option>
        ${statuses.map(([id, statusLabel]) => html`<option value="${id}" ${id === orderFilter ? raw("selected") : ""}>${statusLabel}</option>`)}
      </select></label>` : ""}
    </div>`;
  }

  const queueFilters = [["to-pack", "To pack", "toPack"], ["ready", "Ready", "ready"], ["dispatched", "Dispatched", "dispatched"]];
  function orderCount() {
    return queue.count > queue.orders.length ? `${queue.orders.length} of ${queue.count} orders` : `${queue.orders.length} ${queue.orders.length === 1 ? "order" : "orders"}`;
  }

  function orderRows() {
    return html`${queue.orders.length ? html`<ul class="consumer-list" role="list">${queue.orders.map(order => html`
      <li><button class="consumer-queue-order" type="button" data-act="consumer-order" data-id="${order.reference}" aria-controls="consumerOrderDetail" aria-pressed="${String(selectedReference === order.reference)}">
        <span class="ic acc">${svg("bag")}</span>
        <span class="consumer-queue-info"><b>${order.reference}</b><span>${order.contact?.name || "Contact not recorded"} · ${method(order.method)}</span><small>${date(order.createdAt)}</small></span>
        <span class="consumer-queue-badges">${orderBadge(order.status)}${paymentBadge(order)}</span>
        <span class="chev">${svg("chev")}</span>
      </button></li>`)}</ul>` : empty("bag", "No orders match this queue. Try another status or search.")}
      ${queue.nextCursor ? html`<button class="btn soft consumer-more" type="button" data-act="consumer-order-more">Load earlier orders</button>` : ""}`;
  }

  function orders() {
    const chosen = orderCache.get(selectedReference);
    return html`<div id="consumerOrders" class="consumer-orders" data-drilldown="${String(orderDrilledIn)}">
      <section class="group glass consumer-queue-tools" aria-label="Order filters">
        <div class="consumer-queue-filters" role="group" aria-label="Fulfilment queues">${queueFilters.map(([id, label, key]) => html`<button type="button" data-act="consumer-queue" data-id="${id}" aria-pressed="${String(orderFilter === id)}"><span>${label}</span><b data-consumer-count="${key}">${queue.summary?.[key] || 0}</b></button>`)}</div>
        ${searchTools("Search consumer orders", "Search orders", true)}
      </section>
      <div class="consumer-desk">
        <section class="group glass consumer-queue" aria-labelledby="consumerQueueTitle">
          <header><h2 id="consumerQueueTitle">Preview orders</h2><span id="consumerQueueCount" role="status">${orderCount()}</span></header>
          <div id="consumerQueueRows" aria-busy="false">${orderRows()}</div>
        </section>
        <section class="group glass consumer-fulfilment-detail" id="consumerOrderDetail" aria-label="Order details">${chosen ? fulfilmentDetail(chosen) : empty("bag", "Select an order to see its details and packing checklist.")}</section>
      </div>
    </div>`;
  }

  function paymentBadge(order) {
    if (order.paymentMode === "test" || order.paymentStatus === "test") return badge("Test payment", "warn");
    return order.paymentMode === "live" && order.paymentStatus === "paid" ? badge("Paid", "ok") : badge("Payment not recorded", "");
  }
  function support() {
    if (!supportInbox) return supportPending ? empty("people", "Loading support messages…") : "";
    const { messages: rows, count, nextCursor, limited } = supportInbox;
    const total = count ?? rows.length;
    return html`<p class="hint" role="status">${limited
      ? `Showing ${rows.length} loaded ${rows.length === 1 ? "message" : "messages"}. Full inbox search and pagination are temporarily unavailable.`
      : `${rows.length < total ? `${rows.length} of ${total}` : total} ${total === 1 ? "message" : "messages"}`}</p>
      ${rows.length ? html`<ul class="consumer-list consumer-support-list" role="list">${rows.map(item => html`<li class="item"><div class="tx"><b>${item.subject || item.reference}</b><span>${item.name} · ${item.email}</span><span>${date(item.createdAt)} · ${item.reference}${item.orderReference ? " · Order " + item.orderReference : ""}</span><p class="consumer-support-message">${item.message}</p><div class="row"><a class="btn sm soft" href="mailto:${encodeURIComponent(item.email)}">Reply by email</a><button class="btn sm soft" type="button" data-act="consumer-support" data-id="${item.reference}" ${writes.has(item.reference) ? raw("disabled") : ""}>${item.resolved ? "Reopen" : "Mark resolved"}</button>${badge(item.resolved ? "Resolved" : "Open", item.resolved ? "ok" : "warn")}</div></div></li>`)}</ul>` : empty("people", "No support messages match this view.")}
      ${nextCursor ? html`<button class="btn soft consumer-more" type="button" data-act="consumer-support-more">Load more messages</button>` : ""}`;
  }

  function customers() {
    const rows = data.customers.filter(customer => matches(customer.name, customer.phone));
    if (!rows.length) return empty("people", data.customers.length ? "No customers match your search." : "No customer profiles saved yet.");
    return html`<ul class="consumer-list" role="list">
      ${rows.map(customer => html`<li class="item consumer-customer">
        <span class="tx"><b>${customer.name || "Name not provided"}</b><span>${customer.phone || "No phone number saved"}</span></span>
        <span class="consumer-meta">${customer.updatedAt ? `Updated ${date(customer.updatedAt)}` : ""}</span>
      </li>`)}
    </ul>`;
  }

  const lists = { customers, support };
  const listOptions = {
    customers: ["Customers", "Profiles saved by preview customers", "Search consumer customers", "Search name or phone"],
    support: ["Support", "Messages and order enquiries from the preview", "Search consumer support", "Search messages or order references"],
  };
  function panel() {
    if (!data.connected) return html`<section class="group glass consumer-card consumer-unconnected" aria-label="Storefront connection">
      <span class="ic warn">${svg("warn")}</span>
      <div><h2>Storefront connection unavailable</h2><p>${data.readiness[0]?.detail || "Set up the preview connection to manage demo orders, customer profiles and catalogue availability."}</p></div>
      <button class="btn soft" id="consumerRefresh" type="button" data-act="consumer-refresh">Try again</button>
    </section>`;
    if (section === "overview") return overview();
    if (section === "orders") return html`<div id="consumerResults">${orders()}</div>`;
    const [title, note, label, placeholder] = listOptions[section];
    return html`<section class="group glass consumer-card" aria-label="${title}">
      ${heading(title, note)}
      ${searchTools(label, placeholder, false)}
      <div id="consumerResults">${lists[section]()}</div>
    </section>`;
  }

  function workspace() {
    return html`
      ${head("Consumer (Preview)", "Retail orders, shop availability and storefront editing.", html`<div class="consumer-actions">
        <a class="btn soft" href="${storefront()}" target="_blank" rel="noopener">${svg("external")}Open storefront</a>
        ${data.connected ? html`<button class="btn soft consumer-refresh" id="consumerRefresh" type="button" data-act="consumer-refresh" ${updating || writes.size ? raw("disabled") : ""} aria-label="Refresh consumer preview data">
          ${svg("refresh")}<span>Refresh</span>
        </button>` : ""}
      </div>`)}
      ${data.connected ? html`<div class="consumer-toolbar">${navigation()}</div>` : html`<div class="consumer-toolbar"><button class="btn soft" type="button" data-act="consumer-tab" data-id="products">Products</button><button class="btn soft" type="button" data-act="consumer-tab" data-id="editor">Site editor</button></div>`}
      <p class="consumer-message" id="consumerMessage" role="status" ${message ? "" : raw("hidden")}>${message}</p>
      <div id="consumerPanel" aria-busy="${String(updating)}">${panel()}</div>`;
  }

  async function load() {
    const result = await api("GET", endpoint);
    if (result.connected && section === "orders") result.orderQueue = await api("GET", queuePath());
    if (result.connected && section === "support") {
      const search = supportQuery();
      result.support = supportPage(await api("GET", supportPath(search)), search);
    }
    return {
      ...result,
      orders: result.orders || [], customers: result.customers || [], products: result.products || [],
      settings: result.settings || {}, readiness: result.readiness || [],
    };
  }

  async function view() {
    const started = ++generation;
    supportVersion++;
    supportPending = false;
    queueVersion++;
    queuePending = false;
    clearTimeout(searchTimer);
    const result = await load();
    if (started !== generation) return html``;
    acceptData(result);
    message = "";
    updating = false;
    return html`<div class="consumer-workspace" id="consumerWorkspace">${workspace()}</div>`;
  }
  function acceptData(result) {
    data = result;
    supportInbox = result.support;
    acceptQueue(result.orderQueue || { orders: result.orders || [], count: result.orderCount ?? result.orders.length, nextCursor: result.orderCursor, summary: result.orderSummary || {} });
  }
  function acceptQueue(result) {
    queue = result;
    queue.orders.forEach(rememberOrder);
    if (!queue.orders.some(order => order.reference === selectedReference)) {
      orderDrilledIn = false;
      selectedReference = queue.orders[0]?.reference || "";
    }
  }
  function queuePath(cursor) {
    const query = new URLSearchParams();
    if (queries.orders?.trim()) query.set("q", queries.orders.trim());
    if (orderFilter) query.set("status", orderFilter);
    if (cursor) query.set("cursor", cursor);
    return endpoint + "/orders" + (query.size ? "?" + query : "");
  }
  const supportQuery = () => (queries.support || "").trim();
  function supportPath(search, cursor) {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (cursor) query.set("cursor", cursor);
    return endpoint + "/support" + (query.size ? "?" + query : "");
  }
  function supportPage(result, search, cursor = null, previous = []) {
    const rows = result.messages || [];
    const merged = [...new Map([...previous, ...rows].map(item => [item.reference, item])).values()];
    if (result.supportGateway === 1 && result.query?.search === search && result.query.cursor === cursor &&
        Number.isSafeInteger(result.count) && result.count >= rows.length &&
        (!cursor || (result.nextCursor !== cursor && (rows.length ? merged.length > previous.length : !result.nextCursor)))) {
      return { ...result, messages: merged };
    }
    const term = search.toLowerCase();
    const messages = (cursor ? previous : rows).filter(item =>
      [item.reference, item.name, item.email, item.subject, item.message, item.orderReference]
        .some(value => String(value ?? "").toLowerCase().includes(term)));
    return { messages, limited: true };
  }
  async function loadSupport(append = false, restoreFocus) {
    const started = ++supportVersion, identity = generation;
    const root = find("consumerResults");
    supportPending = true;
    root?.setAttribute("aria-busy", "true");
    if (!supportInbox) renderResults();
    try {
      const search = supportQuery(), cursor = append ? supportInbox.nextCursor : null;
      const result = await api("GET", supportPath(search, cursor));
      if (started !== supportVersion || identity !== generation || section !== "support") return;
      supportInbox = supportPage(result, search, cursor, append ? supportInbox.messages : []);
      const active = document.activeElement;
      report("");
      renderResults();
      if (restoreFocus && root && (root.contains(active) || document.activeElement === document.body)) {
        const buttons = [...root.querySelectorAll('[data-act="consumer-support"]')];
        const control = buttons.find(button => button.dataset.id === restoreFocus)
          || root.querySelector('[data-act="consumer-support-more"]') || find("consumerSearch");
        control?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (started === supportVersion && identity === generation) report(error.message);
    } finally {
      if (started === supportVersion && identity === generation) {
        supportPending = false;
        root?.setAttribute("aria-busy", "false");
        if (!supportInbox) renderResults();
      }
    }
  }
  function rememberOrder(order) {
    const cached = orderCache.get(order.reference);
    if (cached && cached.version > order.version) order = cached;
    orderCache.set(order.reference, order);
    const i = data?.orders.findIndex(item => item.reference === order.reference);
    if (i >= 0) data.orders[i] = order;
    const j = queue.orders.findIndex(item => item.reference === order.reference);
    if (j >= 0) queue.orders[j] = order;
  }
  async function loadOrders(append = false) {
    const started = ++queueVersion, identity = generation;
    const rows = find("consumerQueueRows");
    queuePending = true;
    syncOrderFilters();
    rows?.setAttribute("aria-busy", "true");
    try {
      const result = await api("GET", queuePath(append ? queue.nextCursor : null));
      if (started !== queueVersion || identity !== generation) return;
      acceptQueue({ ...result, orders: append ? [...new Map([...queue.orders, ...result.orders].map(order => [order.reference, order])).values()] : result.orders });
      renderResults();
    } catch (error) { if (started === queueVersion && identity === generation) report(error.message); }
    finally {
      if (started === queueVersion && identity === generation) {
        queuePending = false;
        rows?.setAttribute("aria-busy", "false");
      }
    }
  }

  function replaceWorkspace(returnFocus) {
    const root = find("consumerWorkspace");
    if (!root) return;
    put(root, workspace());
    if (returnFocus) find(returnFocus)?.focus({ preventScroll: true });
  }

  function report(text) {
    message = text;
    const status = find("consumerMessage");
    if (!status) return;
    status.hidden = !text;
    status.textContent = text;
  }

  async function selectSection(id, opener) {
    if (!tabs.some(([key]) => key === id)) return;
    if (["editor", "products"].includes(id) || find("consumerToolWorkspace")) {
      if (!await openSection(id)) {
        const picker = find("consumerSection");
        if (picker) picker.value = find("consumerToolWorkspace")?.dataset.tool || section;
      }
      return;
    }
    if (id === section || !data?.connected) return;
    section = id;
    supportVersion++;
    supportPending = false;
    queueVersion++;
    queuePending = false;
    clearTimeout(searchTimer);
    orderDrilledIn = false;
    browseScroll = 0;
    const tabGroup = find("consumerTabs");
    for (const button of tabGroup.querySelectorAll("button")) button.setAttribute("aria-pressed", button.dataset.id === id);
    const picker = find("consumerSection");
    picker.value = id;
    const panelRoot = find("consumerPanel");
    report("");
    put(panelRoot, panel());
    SC.reveal(panelRoot, { offset: 5 });
    if (!opener.isConnected) {
      const control = picker.getClientRects().length ? picker : tabGroup.querySelector('[aria-pressed="true"]');
      control?.focus({ preventScroll: true });
    }
    if (id === "orders") await loadOrders();
    if (id === "support") await loadSupport();
  }

  function syncOrderFilters() {
    const root = find("consumerOrders"), filter = find("consumerOrderFilter");
    if (!root || !filter) return;
    filter.value = orderFilter;
    for (const button of root.querySelectorAll('[data-act="consumer-queue"]')) {
      button.setAttribute("aria-pressed", button.dataset.id === orderFilter);
      const count = button.querySelector("[data-consumer-count]");
      count.textContent = queue.summary?.[count.dataset.consumerCount] || 0;
    }
  }

  function orderButton(reference) {
    return Array.from(find("consumerQueueRows")?.querySelectorAll('[data-act="consumer-order"]') || []).find(button => button.dataset.id === reference);
  }

  function renderResults() {
    if (section === "orders") {
      const rows = find("consumerQueueRows");
      if (!rows) return;
      const focused = rows.contains(document.activeElement) ? document.activeElement : null;
      const wasDrilledIn = find("consumerOrders").dataset.drilldown === "true";
      syncOrderFilters();
      find("consumerQueueCount").textContent = orderCount();
      put(rows, orderRows());
      find("consumerOrders").dataset.drilldown = String(orderDrilledIn);
      renderDetail();
      if (focused?.dataset.id) (orderButton(focused.dataset.id) || find("consumerSearch"))?.focus({ preventScroll: true });
      else if (focused) (rows.querySelector('[data-act="consumer-order-more"]') || find("consumerSearch"))?.focus({ preventScroll: true });
      else if (wasDrilledIn && !orderDrilledIn && isOrderDrilldown()) find("consumerSearch")?.focus();
      return;
    }
    const root = find("consumerResults");
    if (root && lists[section]) put(root, lists[section]());
  }

  async function refresh(opener) {
    if (updating || queuePending || supportPending || writes.size || [...packing.values()].some(state => state.running)) return;
    const started = generation, navigation = queueVersion, activeSection = section, inboxVersion = supportVersion;
    updating = true;
    const refreshButton = find("consumerRefresh");
    refreshButton.disabled = true;
    opener.disabled = true;
    find("consumerPanel").setAttribute("aria-busy", "true");
    try {
      const result = await load();
      if (started !== generation || navigation !== queueVersion || inboxVersion !== supportVersion || section !== activeSection) return;
      acceptData(result);
      updating = false;
      message = "";
      const focused = document.activeElement;
      const restoreFocus = focused === opener || focused === document.body;
      replaceWorkspace(restoreFocus ? refreshButton.id : focused.id);
      if (result.connected) toast("Preview data refreshed.");
    } catch (err) {
      if (started === generation) report(err.message);
    } finally {
      if (started === generation) {
        updating = false;
        refreshButton.disabled = false;
        opener.disabled = false;
        find("consumerPanel")?.setAttribute("aria-busy", "false");
      }
    }
  }

  async function save(key, request, apply) {
    if (updating || writes.has(key)) return false;
    const started = generation;
    const refreshButton = find("consumerRefresh");
    writes.add(key);
    if (refreshButton) refreshButton.disabled = true;
    try {
      const result = await request();
      if (started !== generation) return false;
      apply(result);
      report("");
      return true;
    } finally {
      writes.delete(key);
      if (refreshButton?.isConnected) refreshButton.disabled = updating || writes.size > 0;
    }
  }

  function packedComponents(line) {
    if (!Array.isArray(line.product?.contents)) return "";
    const components = line.product.contents.filter(part => part?.name && Number.isSafeInteger(part.qty) && part.qty > 0)
      .map(part => `${part.qty} × ${part.name}${part.weight ? ` (${part.weight})` : ""}`);
    return components.length ? html`<small>Each pack contains ${components.join(" · ")}</small>` : "";
  }

  function fulfilmentDetail(order) {
    const state = packing.get(order.reference), checked = packedWithChanges(order, state?.changes);
    const busy = updating || writes.has(order.reference) || blockedOrders.has(order.reference), saving = !!state?.running, canPack = ["placed", "preparing"].includes(order.status);
    const allPacked = order.lines.length > 0 && checked.size === order.lines.length;
    const tracking = trackingDrafts.get(order.reference) ?? order.tracking?.number ?? "";
    const error = orderErrors.get(order.reference);
    return html`<header class="consumer-detail-head">
        <button id="consumerOrderBack" class="btn soft consumer-order-back" type="button" data-act="consumer-order-back">${svg("chev")}<span>Preview orders</span></button>
        <div class="consumer-detail-title"><div><h3 id="consumerDetailTitle" tabindex="-1">${order.reference}</h3><p>${method(order.method)} · ${date(order.createdAt)}</p></div>${orderBadge(order.status)}</div>
      </header>
      <dl class="consumer-detail-summary"><div><dt>Customer</dt><dd>${order.contact?.name || "Not recorded"}</dd></div><div><dt>Fulfilment</dt><dd>${order.method === "collection" ? order.cafe?.name || "Collection" : order.deliveryService || "Royal Mail Tracked 48"}</dd></div><div><dt>Total</dt><dd>${money(order.total)}</dd></div><div><dt>Payment</dt><dd>${paymentBadge(order)}</dd></div></dl>
      <div class="consumer-detail-body">${order.contact ? html`<section class="consumer-contact"><h4>Saved customer details</h4><p>${[order.contact.email, order.contact.phone].filter(Boolean).join(" · ") || "No contact details recorded"}</p>${order.method === "delivery" ? html`<p>${[order.contact.address, order.contact.town, order.contact.postcode].filter(Boolean).join(", ")}</p>` : html`<p>${order.cafe?.address || ""}</p>`}</section>` : html`<p class="hint">Customer details were not recorded on this older preview order.</p>`}
      <section><div class="consumer-packing-heading"><h4>Pack order</h4><span id="consumerPackedCount" role="status">${checked.size} of ${order.lines.length} lines${saving ? " · Saving…" : ""}</span></div>
        ${order.lines.length ? html`<progress class="consumer-pack-progress" max="${order.lines.length}" value="${checked.size}" aria-label="Packing progress"></progress>` : ""}
        <div class="consumer-packing-lines">${order.lines.map((line, index) => html`<label class="consumer-packing-line"><input id="consumerPack-${index}" type="checkbox" data-consumer-packed-line="${index}" data-reference="${order.reference}" ${checked.has(index) ? raw("checked") : ""} ${!canPack || busy ? raw("disabled") : ""}><span><b>${line.product?.name || line.name || "Coffee"}</b><small>${line.size} · ${line.grind}</small>${packedComponents(line)}</span><strong>× ${line.qty}</strong></label>`)}</div>
        ${canPack ? html`<div class="row consumer-detail-actions">${order.status === "placed" ? html`<button class="btn soft" type="button" data-act="consumer-status" data-id="preparing" ${busy || saving ? raw("disabled") : ""}>Start preparing</button>` : ""}<button class="btn" type="button" data-act="consumer-status" data-id="ready" ${!allPacked || busy || saving ? raw("disabled") : ""}>Mark packed</button></div>` : ""}</section>
      ${order.method === "delivery" && ["ready", "dispatched", "completed"].includes(order.status) ? html`<form id="consumerDispatchForm" data-reference="${order.reference}"><h4>${order.status === "ready" ? "Dispatch" : "Tracking details"}</h4><label class="field"><span class="fl">Royal Mail tracking number</span><input id="consumerTrackingNumber" name="tracking" maxlength="30" placeholder="e.g. AB123456789GB" autocomplete="off" spellcheck="false" value="${tracking}" ${busy ? raw("disabled") : ""} required></label><button class="btn" type="submit" ${busy || saving ? raw("disabled") : ""}>${order.status === "ready" ? "Save and dispatch" : "Save tracking"}</button>${order.tracking?.url ? html`<a class="btn soft" href="${order.tracking.url}" target="_blank" rel="noopener noreferrer">Track parcel</a>` : ""}</form>` : ""}
      ${order.status === "ready" && order.method === "collection" ? html`<section class="consumer-collection"><h4>Collection</h4><p>Ready to collect from ${order.cafe?.name || "the selected café"}.</p><button class="btn" type="button" data-act="consumer-status" data-id="completed" ${busy ? raw("disabled") : ""}>Mark collected</button></section>` : ""}
      ${order.status === "dispatched" ? html`<div><button class="btn soft" type="button" data-act="consumer-status" data-id="completed" ${busy ? raw("disabled") : ""}>Mark delivered</button></div>` : ""}
      ${error ? html`<div class="consumer-order-problem" role="alert"><p>${error}</p>${blockedOrders.has(order.reference) ? html`<button class="btn soft" type="button" data-act="consumer-order-reload" data-id="${order.reference}" ${orderReloads.get(order.reference)?.generation === generation ? raw("disabled") : ""}>Reload latest order</button>` : ""}</div>` : ""}
      ${order.timeline?.length ? html`<section><h4>Order timeline</h4><ol class="consumer-timeline">${order.timeline.map(event => html`<li><b>${statusById.get(event.status)?.label || event.status}</b><span>${date(event.at)}</span></li>`)}</ol></section>` : ""}
      ${!["completed", "cancelled"].includes(order.status) ? html`<div class="row consumer-detail-actions consumer-detail-footer">${order.status === "ready" ? html`<button class="btn soft" type="button" data-act="consumer-status" data-id="preparing" ${busy ? raw("disabled") : ""}>Reopen packing</button>` : ""}<button class="btn soft bad" type="button" data-act="consumer-cancel" data-id="${order.reference}" ${busy || saving ? raw("disabled") : ""}>Cancel order</button></div>` : ""}</div>`;
  }
  function renderDetail() {
    const target = find("consumerOrderDetail"), order = orderCache.get(selectedReference);
    if (!target) return;
    const focused = target.contains(document.activeElement) ? document.activeElement.id : "";
    put(target, order ? fulfilmentDetail(order) : empty("bag", "Select an order to see its details and packing checklist."));
    if (focused) find(focused)?.focus({ preventScroll: true });
  }
  const isOrderDrilldown = () => matchMedia("(max-width: 880px)").matches;
  function chooseOrder(reference) {
    if (queuePending || !orderCache.has(reference)) return;
    browseScroll = window.scrollY;
    selectedReference = reference;
    orderDrilledIn = true;
    renderResults();
    if (isOrderDrilldown()) {
      window.scrollTo(0, 0);
      find("consumerDetailTitle")?.focus({ preventScroll: true });
    }
  }
  function backToOrders() {
    orderDrilledIn = false;
    find("consumerOrders").dataset.drilldown = "false";
    window.scrollTo(0, browseScroll);
    (orderButton(selectedReference) || find("consumerSearch"))?.focus({ preventScroll: true });
  }
  async function reloadOrder(reference) {
    if (!blockedOrders.has(reference) || orderReloads.get(reference)?.generation === generation) return;
    const request = { generation };
    orderReloads.set(reference, request);
    renderDetail();
    const current = () => generation === request.generation && orderReloads.get(reference) === request;
    try {
      const result = await api("GET", endpoint + "/orders?q=" + encodeURIComponent(reference));
      if (!current()) return;
      const order = result.orders.find(item => item.reference === reference);
      if (!order) throw new Error("This order is no longer available. Refresh the queue.");
      if (!Number.isSafeInteger(order.version) || order.version < orderCache.get(reference)?.version) {
        throw new Error("A newer order was loaded while you waited. Reload the latest order again.");
      }
      rememberOrder(order);
      orderErrors.delete(reference);
      blockedOrders.delete(reference);
    } catch (error) {
      if (current() && section === "orders" && selectedReference === reference) report(error.message);
    } finally {
      if (orderReloads.get(reference) === request) orderReloads.delete(reference);
      if (generation === request.generation && selectedReference === reference) renderDetail();
    }
  }
  async function cancelOrder(reference) {
    const order = orderCache.get(reference), identity = generation;
    if (!order || section !== "orders" || selectedReference !== reference) return;
    if (!await confirmSheet({ title: `Cancel order ${reference}?`, text: "This records cancellation in the preview and customer history. No refund or carrier cancellation is sent.", confirm: "Cancel order", danger: true })) return;
    if (identity !== generation || section !== "orders") return;
    if (selectedReference !== reference || orderCache.get(reference)?.version !== order.version || updating) {
      report("The order view changed. Review the order before confirming cancellation again.");
      return;
    }
    await updateOrder({ status: "cancelled" }, order);
  }
  async function updateOrder(fields, order = orderCache.get(selectedReference)) {
    const reference = order?.reference;
    if (!order || updating || writes.has(reference) || blockedOrders.has(reference) || packing.get(reference)?.running) return;
    orderErrors.delete(reference);
    writes.add(reference); renderDetail();
    const identity = generation, navigation = queueVersion;
    try {
      const result = await api("PATCH", endpointFor("orders", reference), { ifVersion: order.version, ...fields });
      if (identity !== generation) return;
      if (result.order?.reference !== reference || !Number.isSafeInteger(result.order.version)) throw new Error("The order change could not be confirmed. Reload its latest details.");
      rememberOrder(result.order); orderErrors.delete(reference);
      if (fields.tracking) trackingDrafts.delete(reference);
      if (fields.status && section === "orders" && navigation === queueVersion && selectedReference === reference) orderFilter = ["placed", "preparing"].includes(result.order.status) ? "to-pack" : result.order.status;
      if (section === "orders") await loadOrders();
      toast("Order updated.");
    } catch (error) { if (identity === generation) { blockedOrders.add(reference); orderErrors.set(reference, error.message + " Reload the latest order before trying again."); } }
    finally { writes.delete(reference); renderDetail(); }
  }
  function packedWithChanges(order, changes) {
    const checked = new Set(order.packedLines || []);
    for (const [line, change] of changes || []) {
      if (change.checked) checked.add(line); else checked.delete(line);
    }
    return checked;
  }
  async function flushPacking(reference, state) {
    if (state.running) return;
    state.running = true; renderDetail();
    const refreshButton = find("consumerRefresh"); if (refreshButton) refreshButton.disabled = true;
    const identity = generation;
    try {
      while (identity === generation && state.changes.size) {
        const order = orderCache.get(reference), sent = new Map(state.changes);
        const wanted = [...packedWithChanges(order, sent)].sort((a, b) => a - b);
        if (wanted.length !== (order.packedLines || []).length || wanted.some(line => !order.packedLines.includes(line))) {
          const result = await api("PATCH", endpointFor("orders", reference), { ifVersion: order.version, packedLines: wanted });
          if (identity !== generation) return;
          if (result.order?.reference !== reference || !Number.isSafeInteger(result.order.version)) throw new Error("The packing save could not be confirmed.");
          rememberOrder(result.order);
          orderErrors.delete(reference);
        }
        for (const [line, change] of sent) {
          if (state.changes.get(line) === change) state.changes.delete(line);
        }
      }
    } catch (error) {
      if (identity === generation) {
        blockedOrders.add(reference);
        orderErrors.set(reference, error.message + " Reload the latest order before changing its packing again.");
      }
    } finally {
      if (packing.get(reference) === state) packing.delete(reference);
      if (identity === generation && selectedReference === reference) renderDetail();
      if (refreshButton?.isConnected) refreshButton.disabled = updating || writes.size > 0 || [...packing.values()].some(item => item.running);
    }
  }
  function packingChanged(input) {
    const reference = input.dataset.reference, order = orderCache.get(reference);
    if (!order || updating || writes.has(reference) || blockedOrders.has(reference) || !["placed", "preparing"].includes(order.status)) { input.checked = (order?.packedLines || []).includes(Number(input.dataset.consumerPackedLine)); return; }
    let state = packing.get(reference);
    if (!state) { state = { changes: new Map(), running: false }; packing.set(reference, state); }
    state.changes.set(Number(input.dataset.consumerPackedLine), { checked: input.checked });
    void flushPacking(reference, state);
    if (selectedReference === reference) renderDetail();
  }
  async function dispatch(form) {
    if (form.dataset.reference !== selectedReference) return;
    const number = form.querySelector("input").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,30}$/.test(number)) { orderErrors.set(selectedReference, "Use a Royal Mail tracking number with 8 to 30 letters or numbers."); renderDetail(); return; }
    const order = orderCache.get(selectedReference);
    await updateOrder({ tracking: { carrier: "royal-mail", number }, ...(order.status === "ready" ? { status: "dispatched" } : {}) });
  }
  document.addEventListener("change", event => {
    if (event.target.matches("[data-consumer-packed-line]")) packingChanged(event.target);
    if (event.target.id === "consumerSection") void selectSection(event.target.value, event.target);
  });
  document.addEventListener("input", event => { if (event.target.id === "consumerTrackingNumber") { const form = event.target.closest("form"); if (form?.dataset.reference) trackingDrafts.set(form.dataset.reference, event.target.value); } });
  document.addEventListener("submit", event => { if (event.target.id === "consumerDispatchForm") { event.preventDefault(); void dispatch(event.target); } });

  async function checkout(opener) {
    if (typeof data?.settings.acceptOrders !== "boolean") return;
    const acceptOrders = !data.settings.acceptOrders;
    const title = acceptOrders ? "Resume signed-in checkout?" : "Pause signed-in checkout?";
    const text = acceptOrders ? "Signed-in preview customers will be able to save demo orders." : "Signed-in preview customers will be unable to save new demo orders until checkout resumes.";
    if (!await confirmSheet({ title, text, confirm: acceptOrders ? "Resume checkout" : "Pause checkout" })) return;
    if (!opener.isConnected || updating) return;
    opener.disabled = true;
    try {
      const saved = await save("checkout", () => api("PUT", endpoint + "/settings", { acceptOrders }), () => {
        data.settings.acceptOrders = acceptOrders;
        const check = data.readiness.find(item => item.id === "checkout");
        if (check) {
          check.state = acceptOrders ? "ready" : "paused";
          check.detail = acceptOrders ? "The preview accepts test orders." : "Test checkout is paused.";
        }
      });
      if (!saved) return;
      if (section === "overview") {
        const panelRoot = find("consumerPanel");
        if (panelRoot) {
          put(panelRoot, panel());
          panelRoot.querySelector('[data-act="consumer-checkout"]')?.focus({ preventScroll: true });
        }
      }
      toast(acceptOrders ? "Signed-in checkout resumed." : "Signed-in checkout paused.");
    } catch (err) { report(err.message); }
    finally { if (opener.isConnected) opener.disabled = false; }
  }

  return {
    view,
    currentSection: () => section,
    setSection(id) {
      if (tabs.some(([key]) => key === id && !["editor", "products"].includes(key))) section = id;
    },
    toolView(tool) {
      const editor = tool === "editor";
      return html`<div class="consumer-workspace" id="consumerToolWorkspace" data-tool="${tool}">
        ${head(editor ? "Site editor" : "Products", "", html`<a class="btn soft consumer-open-storefront" href="${previewUrl}" target="_blank" rel="noopener" aria-label="Open storefront">${svg("external")}<span>Open storefront</span></a>`)}
        <div class="consumer-toolbar">${navigation(tool)}</div>
        <div id="${editor ? "consumerEditor" : "consumerProducts"}"><p role="status">Loading ${editor ? "site editor" : "products"}…</p></div>
      </div>`;
    },
    async mountTool(tool) {
      const host = find(tool === "editor" ? "consumerEditor" : "consumerProducts");
      if (tool === "products") {
        const {mountConsumerProducts} = await import("./consumer-products.js");
        if (host.isConnected) return mountConsumerProducts(host, {api, confirmSheet, toast});
        return;
      }
      const {mountConsumerEditor} = await import("./consumer-editor.js");
      if (host.isConnected) return mountConsumerEditor(host, {api, confirmSheet, toast});
    },
    clear() {
      generation++;
      data = null;
      section = "overview";
      queries = {};
      supportInbox = null;
      supportVersion++;
      supportPending = false;
      orderFilter = "to-pack";
      message = "";
      updating = false;
      queuePending = false;
      orderDrilledIn = false;
      browseScroll = 0;
      writes.clear();
      clearTimeout(searchTimer); queueVersion++; orderCache.clear(); packing.clear(); trackingDrafts.clear(); orderErrors.clear(); blockedOrders.clear(); orderReloads.clear(); selectedReference = "";
    },
    search(value) {
      queries[section] = value;
      if (section === "support") {
        supportVersion++;
        supportInbox = null;
        supportPending = true;
        renderResults();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void loadSupport(), 250);
      } else if (section === "orders") {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void loadOrders(), 250);
      } else renderResults();
    },
    filterOrders(value) {
      if (!["", "to-pack", ...statusById.keys()].includes(value)) return;
      clearTimeout(searchTimer);
      orderFilter = value;
      void loadOrders();
    },
    async act(name, id, opener) {
      if (name === "consumer-tab") await selectSection(id, opener);
      if (name === "consumer-refresh") await refresh(opener);
      if (name === "consumer-order") chooseOrder(id);
      if (name === "consumer-order-back") backToOrders();
      if (name === "consumer-checkout") await checkout(opener);
      if (name === "consumer-queue") {
        clearTimeout(searchTimer);
        orderFilter = id;
        await loadOrders();
      }
      if (name === "consumer-order-more" && queue.nextCursor && !updating && !queuePending) await loadOrders(true);
      if (name === "consumer-status") await updateOrder({ status: id });
      if (name === "consumer-order-reload") await reloadOrder(id);
      if (name === "consumer-cancel") await cancelOrder(id);
      if (name === "consumer-support-more" && supportInbox?.nextCursor && !supportPending && !updating && !writes.size) {
        await loadSupport(true, document.activeElement === opener ? "more" : null);
      }
      if (name === "consumer-support") {
        const item = supportInbox?.messages.find(message => message.reference === id);
        if (!item || writes.has(id) || updating || supportPending) return;
        const focused = document.activeElement === opener;
        opener.disabled = true;
        try {
          const saved = await save(id, async () => {
            const result = await api("PATCH", endpointFor("support", id), { resolved: !item.resolved });
            return result.message;
          }, updated => Object.assign(item, updated));
          if (!saved || section !== "support") return;
          renderResults();
          if (focused && document.activeElement === document.body) {
            Array.from(find("consumerResults").querySelectorAll('[data-act="consumer-support"]')).find(button => button.dataset.id === id)?.focus({ preventScroll: true });
          }
          clearTimeout(searchTimer);
          await loadSupport(false, focused ? id : null);
        } catch (error) { report(error.message); }
        finally { if (opener.isConnected) opener.disabled = false; }
      }
    },
  };
};
