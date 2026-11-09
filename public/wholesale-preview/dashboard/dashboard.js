import { products, packs, grinds, productFor, money, weight, unitPrice } from "../order.js";
import { statuses, DASHBOARD_KEY, CATALOGUE_KEY, readDashboard, saveDashboard, readCatalogue, applyCatalogue, saveCatalogue, readBasket, orderTotals, freshDashboard, freshCatalogue } from "./store.js";

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let state = readDashboard();
let catalogue = readCatalogue();
applyCatalogue(catalogue);
let filter = "all";
let timer;
let dialogAction = null;
const customerFor = (id) => state.customers.find((customer) => customer.id === id);
const statusBadge = (status) => `<span class="status-badge status-${escape(status.toLowerCase().replaceAll(" ", "-"))}">${escape(status)}</span>`;
const dateLabel = (date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(`${date}T12:00:00Z`));
const inputField = (name, label, value = "", attributes = "") => `<label class="form-field">${label}<input name="${name}" value="${escape(value)}" ${attributes}></label>`;
const noteField = (value = "") => `<label class="form-field">Demo account / order note<textarea name="note" maxlength="1000">${escape(value)}</textarea></label>`;
const disclaimer = `<p class="demo-disclaimer"><strong>Sample data only.</strong> These changes stay in this browser. No order, customer account, payment or fulfilment action is sent to a server.</p>`;

function toast(message) {
  clearTimeout(timer);
  $("#dashboard-toast").textContent = message;
  $("#dashboard-toast").classList.add("visible");
  timer = setTimeout(() => { $("#dashboard-toast").classList.remove("visible"); $("#dashboard-toast").textContent = ""; }, 4000);
}
function persist(message) {
  const saved = saveDashboard(state);
  render();
  toast(saved ? message : "Updated for now. Browser storage is unavailable, so these changes are temporary.");
}
function openDialog(content, action) {
  $("#dashboard-dialog-content").innerHTML = content;
  dialogAction = action;
  $("#dashboard-dialog").showModal();
}
function closeDialog() { $("#dashboard-dialog").close(); dialogAction = null; }

function renderStats() {
  const open = state.orders.filter((order) => !["Dispatched", "Cancelled"].includes(order.status));
  const toPrepare = state.orders.filter((order) => ["New", "Preparing"].includes(order.status)).reduce((grams, order) => grams + orderTotals(order).grams, 0);
  const value = state.orders.filter((order) => order.status !== "Cancelled").reduce((pence, order) => pence + orderTotals(order).pence, 0);
  const stats = [
    ["Open orders", open.length, "New, preparing & ready"],
    ["Coffee to prepare", weight(toPrepare), "New & preparing orders"],
    ["Demo order value", money(value), "All non-cancelled sample orders"],
    ["Active customers", state.customers.filter((customer) => customer.status === "Active").length, "Fictional wholesale accounts"],
  ];
  $("#dashboard-stats").innerHTML = stats.map(([label, value, caption]) => `<div class="stat-card"><p>${label}</p><strong>${value}</strong><span>${caption}</span></div>`).join("");
  $("#nav-order-count").textContent = open.length;
}

function renderOrders() {
  const query = $("#order-search").value.trim().toLowerCase();
  const orders = state.orders.filter((order) => (filter === "all" || order.status === filter) && `${order.id} ${customerFor(order.customerId)?.business || ""}`.toLowerCase().includes(query));
  $("#orders-list").innerHTML = orders.map((order) => {
    const total = orderTotals(order);
    return `<div class="order-table-row" role="row"><div class="order-identity" role="cell"><strong>${escape(order.id)}</strong><span>${escape(customerFor(order.customerId)?.business || "Demo customer")}</span></div><span class="table-muted" role="cell" data-cell="date">${dateLabel(order.date)}</span><span class="table-muted" role="cell" data-cell="weight">${weight(total.grams)}</span><strong role="cell" data-cell="total">${money(total.pence)}</strong><span role="cell" data-cell="status">${statusBadge(order.status)}</span><span role="cell" data-cell="open"><button class="row-open" type="button" data-order="${escape(order.id)}" aria-label="Open ${escape(order.id)} for ${escape(customerFor(order.customerId)?.business || "Demo customer")}">↗</button></span></div>`;
  }).join("");
  $("#orders-empty").hidden = orders.length !== 0;
  $("#orders-count").textContent = `${orders.length} of ${state.orders.length} sample orders · Illustrative coffee subtotals only`;
}

function renderCustomers() {
  $("#customers-list").innerHTML = state.customers.map((customer) => {
    const orders = state.orders.filter((order) => order.customerId === customer.id);
    const initials = customer.business.split(/\s+/).slice(0, 2).map((word) => word.charAt(0)).join("");
    return `<article class="customer-card"><span class="customer-initials" aria-hidden="true">${escape(initials)}</span><h3>${escape(customer.business)}</h3>${statusBadge(customer.status)}<div class="customer-details"><p>${escape(customer.contact || "No demo contact name")}</p><p>${escape(customer.email || "No demo email")}</p></div><div class="customer-card-footer"><span>${orders.length} sample ${orders.length === 1 ? "order" : "orders"}</span><button class="text-button" type="button" data-customer="${escape(customer.id)}" aria-label="Edit ${escape(customer.business)}">View account <span aria-hidden="true">↗</span></button></div></article>`;
  }).join("");
}

function renderCatalogue() {
  $("#catalogue-list").innerHTML = catalogue.map((entry) => {
    const product = productFor(entry.id);
    return `<article class="catalogue-row ${entry.active ? "" : "inactive"}"><img src="../images/${product.image}" alt="" width="68" height="68"><div><h3>${escape(product.name)}</h3><p>${escape(product.origin)} · ${escape(product.process)}</p></div><div class="catalogue-price">${money(entry.prices.kilo)}<span>1 kg bag</span></div><div class="catalogue-price">${money(entry.prices.quarter)} / ${money(entry.prices.half)}<span>250 g / 500 g</span></div>${statusBadge(entry.active ? "Visible" : "Hidden")}<button class="row-open" type="button" data-coffee="${product.id}" aria-label="Edit ${escape(product.name)}">↗</button></article>`;
  }).join("");
}
function render() { renderStats(); renderOrders(); renderCustomers(); renderCatalogue(); }

function showTab() {
  const tab = ["orders", "customers", "catalogue"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "orders";
  for (const name of ["orders", "customers", "catalogue"]) {
    $(`#${name}-view`).hidden = name !== tab;
    const link = $(`[data-tab="${name}"]`);
    if (tab === name) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  $("#breadcrumb").textContent = { orders: "Orders", customers: "Customers", catalogue: "Coffee catalogue" }[tab];
}

function openOrder(id) {
  const order = state.orders.find((order) => order.id === id);
  if (!order) return;
  const total = orderTotals(order);
  openDialog(`<p class="eyebrow">SAMPLE WHOLESALE ORDER</p><h2 id="dashboard-dialog-title">${escape(order.id)}</h2><p class="dialog-intro">${escape(customerFor(order.customerId)?.business || "Demo customer")}</p><div class="detail-meta"><div><p>Placed</p><strong>${dateLabel(order.date)}</strong></div><div><p>Delivery preference</p><strong>${escape(order.delivery)}</strong></div></div><div class="review-items">${order.lines.map((line) => `<div class="review-line"><div><h3>${escape(productFor(line.productId).name)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}</p></div><strong>${money(line.price * line.quantity)}</strong></div>`).join("")}</div><div class="review-subtotal"><span>Coffee subtotal · ${weight(total.grams)}</span><strong>${money(total.pence)}</strong></div><p class="terms-note">Retail prices sourced from Strangers, or locally edited demo prices. Wholesale rates, delivery and tax treatment are not calculated.</p><form class="dashboard-form"><label class="form-field">Demo order status<select name="status">${statuses.map((status) => `<option ${order.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>${noteField(order.note)}${disclaimer}<button class="button button-dark" type="submit">Save demo status <span aria-hidden="true">↗</span></button></form>`, (form) => {
    order.status = form.elements.status.value;
    order.note = form.elements.note.value.trim();
    closeDialog(); persist(`${order.id} updated in this demo.`);
  });
}

function editCustomer(id = null) {
  const customer = id ? customerFor(id) : { business: "", contact: "", email: "", note: "", status: "Active" };
  if (!customer) return;
  if (!id && state.customers.length >= 200) { toast("The demo supports 200 customers. Reset demo data to start over."); return; }
  openDialog(`<p class="eyebrow">FICTIONAL WHOLESALE ACCOUNT</p><h2 id="dashboard-dialog-title">${id ? "Good company." : "A new connection."}</h2><form class="dashboard-form">${inputField("business", "Demo business name", customer.business, 'required maxlength="120" autocomplete="off"')}${inputField("contact", "Demo contact name (optional)", customer.contact, 'maxlength="120" autocomplete="off"')}${inputField("email", "Demo email (optional)", customer.email, 'type="email" maxlength="150" placeholder="orders@example.test" autocomplete="off"')}<label class="form-field">Demo account status<select name="status"><option ${customer.status === "Active" ? "selected" : ""}>Active</option><option ${customer.status === "On hold" ? "selected" : ""}>On hold</option></select></label>${noteField(customer.note)}${disclaimer}<button class="button button-dark" type="submit">${id ? "Save demo customer" : "Add demo customer"} <span aria-hidden="true">↗</span></button></form>`, (form) => {
    const values = { business: form.elements.business.value.trim(), contact: form.elements.contact.value.trim(), email: form.elements.email.value.trim(), status: form.elements.status.value, note: form.elements.note.value.trim() };
    if (!values.business) { form.elements.business.focus(); return; }
    if (id) Object.assign(customer, values); else state.customers.push({ id: `demo-${crypto.randomUUID()}`, ...values });
    closeDialog(); persist("Demo customer saved in this browser.");
  });
}

function editCoffee(id) {
  const entry = catalogue.find((entry) => entry.id === id);
  if (!entry) return;
  const product = productFor(id);
  openDialog(`<p class="eyebrow">SOURCED CATALOGUE / DEMO SETTINGS</p><h2 id="dashboard-dialog-title">${escape(product.name)}</h2><p class="dialog-intro">${escape(product.origin)} · ${escape(product.process)}</p><form class="dashboard-form"><div class="form-pair">${inputField("price", "Demo 1 kg price (£)", (entry.prices.kilo / 100).toFixed(2), 'type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required')}${inputField("quarterPrice", "Demo 250 g price (£)", (entry.prices.quarter / 100).toFixed(2), 'type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required')}${inputField("halfPrice", "Demo 500 g price (£)", (entry.prices.half / 100).toFixed(2), 'type="number" min="0.01" max="10000" step="0.01" inputmode="decimal" required')}</div><label class="check-field"><input type="checkbox" name="active" ${entry.active ? "checked" : ""}>Show in the ordering preview</label><p class="form-error" id="price-error" role="status" hidden>Enter a price from £0.01 to £10,000.00, with at most two decimal places.</p>${disclaimer}<p class="terms-note">Reload the ordering preview in this browser to see these prices and availability. Existing demo order prices stay as they were when created.</p><button class="button button-dark" type="submit">Save demo coffee <span aria-hidden="true">↗</span></button></form>`, (form) => {
    const pounds = [Number(form.elements.price.value), Number(form.elements.quarterPrice.value), Number(form.elements.halfPrice.value)];
    const pence = pounds.map((value) => Math.round(value * 100));
    if (pounds.some((value, index) => !Number.isFinite(value) || value < .01 || value > 10000 || Math.abs(value * 100 - pence[index]) > .00001)) { $("#price-error").hidden = false; return; }
    Object.assign(entry, { prices: { kilo: pence[0], quarter: pence[1], half: pence[2] }, active: form.elements.active.checked });
    const saved = saveCatalogue(catalogue);
    applyCatalogue(catalogue);
    closeDialog(); renderCatalogue();
    toast(saved ? "Demo coffee saved. Reload the ordering preview to see the change." : "Updated for now. Browser storage is unavailable; this change is temporary.");
  });
}

function createOrder() {
  if (state.orders.length >= 200) { toast("The demo supports 200 orders. Reset demo data to start over."); return; }
  const customers = state.customers.filter((customer) => customer.status === "Active");
  if (!customers.length) { toast("Add an active demo customer first."); return; }
  let lines = readBasket().filter((line) => productFor(line.productId).active !== false);
  const fromBasket = lines.length > 0;
  if (!lines.length) {
    const product = products.find((product) => product.active !== false);
    if (!product) { toast("Make a coffee visible in the catalogue first."); return; }
    lines = [{ productId: product.id, quantity: 2, pack: "kilo", grind: "beans" }];
  }
  lines = lines.map((line) => ({ ...line, price: unitPrice(productFor(line.productId), line.pack) }));
  openDialog(`<p class="eyebrow">ADD A LOCAL SAMPLE RECORD</p><h2 id="dashboard-dialog-title">A demo order.</h2><p class="dialog-intro">${fromBasket ? "Using the coffees currently in your ordering preview basket." : "Your basket is empty, so we’ve picked a sample coffee."}</p><div class="review-items">${lines.map((line) => `<div class="review-line"><div><h3>${escape(productFor(line.productId).name)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}</p></div><strong>${money(line.price * line.quantity)}</strong></div>`).join("")}</div><form class="dashboard-form"><label class="form-field">Demo customer<select name="customerId">${customers.map((customer) => `<option value="${escape(customer.id)}">${escape(customer.business)}</option>`).join("")}</select></label><label class="form-field">Delivery preference<select name="delivery"><option>Delivery</option><option>Roastery collection</option></select></label>${noteField("Sample order. Please do not fulfil.")}${disclaimer}<button class="button button-dark" type="submit">Create demo order <span aria-hidden="true">+</span></button></form>`, (form) => {
    const number = Math.max(1000, ...state.orders.map((order) => Number(order.id.slice(5)))) + 1;
    const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date());
    state.orders.unshift({ id: `DEMO-${number}`, customerId: form.elements.customerId.value, date, delivery: form.elements.delivery.value, status: "New", note: form.elements.note.value.trim(), lines });
    closeDialog(); filter = "all"; $("#order-search").value = "";
    document.querySelectorAll("[data-status]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.status === "all")));
    persist("Sample order created in this browser only.");
  });
}

$("#orders-list").addEventListener("click", (event) => { const button = event.target.closest("[data-order]"); if (button) openOrder(button.dataset.order); });
$("#customers-list").addEventListener("click", (event) => { const button = event.target.closest("[data-customer]"); if (button) editCustomer(button.dataset.customer); });
$("#catalogue-list").addEventListener("click", (event) => { const button = event.target.closest("[data-coffee]"); if (button) editCoffee(button.dataset.coffee); });
$("#create-customer").addEventListener("click", () => editCustomer());
$("#create-order").addEventListener("click", createOrder);
$("#close-dialog").addEventListener("click", closeDialog);
$("#dashboard-dialog").addEventListener("click", (event) => { if (event.target === $("#dashboard-dialog")) closeDialog(); });
$("#dashboard-dialog").addEventListener("close", () => { dialogAction = null; });
$("#dashboard-dialog-content").addEventListener("submit", (event) => { event.preventDefault(); dialogAction?.(event.target); });
$("#order-search").addEventListener("input", renderOrders);
document.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
  filter = button.dataset.status;
  document.querySelectorAll("[data-status]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  renderOrders();
}));
$("#reset-demo").addEventListener("click", () => openDialog(`<p class="eyebrow">A FRESH START</p><h2 id="dashboard-dialog-title">Reset the demo?</h2><p class="dialog-intro">This restores the sample orders, fictional customers and published retail prices in this browser. Your ordering basket keeps its items.</p><form class="dashboard-form">${disclaimer}<button class="button button-dark" type="submit">Reset demo data <span aria-hidden="true">↺</span></button></form>`, () => {
  state = freshDashboard(); catalogue = freshCatalogue(); applyCatalogue(catalogue);
  const catalogueSaved = saveCatalogue(catalogue);
  const dashboardSaved = saveDashboard(state);
  closeDialog(); render();
  toast(catalogueSaved && dashboardSaved ? "The demo has a fresh start." : "Reset for now. Browser storage is unavailable, so the reset is temporary.");
}));
window.addEventListener("hashchange", showTab);
window.addEventListener("storage", (event) => {
  if (event.key === DASHBOARD_KEY || event.key === CATALOGUE_KEY) {
    state = readDashboard(); catalogue = readCatalogue(); applyCatalogue(catalogue);
    if ($("#dashboard-dialog").open) closeDialog();
    render(); toast("Demo data updated from another tab.");
  }
});
render();
showTab();
const requestedOrder = new URLSearchParams(location.search).get("order");
if (requestedOrder && state.orders.some((order) => order.id === requestedOrder)) openOrder(requestedOrder);
