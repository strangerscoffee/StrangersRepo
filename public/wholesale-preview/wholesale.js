import { products, setCatalogue, isAvailable, packs, grinds, MAX_QUANTITY, money, weight, productFor, lineKey, unitPrice, validQuantity, sanitiseBasket, addToBasket, totals } from "./order.js";

let STORAGE_KEY = null;
let session = null;
let ready = false;
let requestId = null;
let saving = false;
let pendingAttempt = null;
let reviewNeedsRefresh = false;
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let storageAvailable = true;
let basket = [];
let currentFilter = "all";
let currentSort = "catalogue", catalogueLoading = false;
const sortLabels = { catalogue: "Catalogue order", "price-asc": "Price: low to high", "price-desc": "Price: high to low" };
function refreshBusy(id, busy) {
  const button = $(id); button.disabled = busy; button.setAttribute("aria-busy", String(busy));
}
let orderVisible = false;
let toastTimer;
let history = [];
const photoIndexes = new Map();
const canOrder = () => session?.customer?.status !== "On hold";
const goSignIn = () => location.replace(location.pathname.startsWith("/wholesale-preview/") ? "/wholesale-preview/signin" : "/signin");

const LOCATION_FIELDS = ["name", "contact", "phone", "address", "postcode", "deliveryNotes"];
let accountLocations = [], accountDefaultLocation = "primary", editingLocation = null, removingLocation = null, accountSaving = false;
const locationKey = (location) => location.id || location.draftKey;
function locationsFor(customer = session?.customer) {
  if (!customer) return [];
  return (customer.locations?.length ? customer.locations : [{ id: "primary", name: "Main location", ...Object.fromEntries(["contact", "phone", "address", "postcode", "deliveryNotes"].map(key => [key, customer[key] || ""])) }]).map(location => ({ ...location }));
}
function locationSummary(location) {
  return [location?.contact, location?.phone, location?.address, location?.postcode, location?.deliveryNotes].filter(Boolean).join(" · ");
}
function reviewBusiness(business) {
  const customer = !!session.customer, input = $("#review-form").elements.business;
  $("#review-business-block").hidden = !customer;
  $("#review-business").textContent = business || "";
  $("#staff-business-field").hidden = customer;
  input.type = customer ? "hidden" : "text";
  input.value = business || "";
  input.readOnly = customer;
}
function renderReviewLocation() {
  const customer = session.customer, block = $("#review-location-block");
  block.hidden = !customer;
  if (!customer) { $("#delivery-summary").textContent = ""; return; }
  const field = $("#review-form").elements.locationId, locations = locationsFor(customer);
  const selected = locations.find(location => location.id === field.value) || locations.find(location => location.id === customer.defaultLocationId) || locations[0];
  field.value = selected.id;
  $("#review-location-label").textContent = $("#review-form").elements.delivery.value === "collection" ? "Business location" : "Delivery location";
  $("#review-location-name").textContent = selected.name;
  $("#delivery-summary").textContent = locationSummary(selected) || "Add delivery details in My account, or choose roastery collection.";
}
function syncPrimaryLocation() {
  const primary = accountLocations.find(location => location.id === "primary"), form = $("#account-form");
  if (primary) for (const key of ["contact", "phone", "address", "postcode", "deliveryNotes"]) primary[key] = form.elements[key].value;
}
function renderAccountLocations() {
  $("#account-locations").innerHTML = accountLocations.map(location => {
    const key = locationKey(location), primary = location.id === "primary", currentDefault = location.id === accountDefaultLocation;
    return `<article class="saved-location" data-account-location="${escape(key)}"><div class="location-row-heading"><strong>${escape(location.name)}</strong>${currentDefault ? '<span class="location-default">Default</span>' : ""}</div><p>${escape([location.address, location.postcode].filter(Boolean).join(" · ") || "Add a delivery address")}</p><div class="location-row-actions"><button class="text-button" type="button" data-location-edit="${escape(key)}">Edit location</button>${!currentDefault && location.id ? `<button class="text-button" type="button" data-location-default="${escape(key)}">Make default</button>` : ""}${!primary ? `<button class="text-button location-remove" type="button" data-location-remove="${escape(key)}">Remove</button>` : ""}</div>${!location.id ? '<p class="location-hint">Save account details before making this the default.</p>' : ""}</article>`;
  }).join("");
  $("#add-location").disabled = accountLocations.length >= 20 || accountSaving;
  $("#location-limit-note").hidden = accountLocations.length < 20;
}
function openLocationEditor(key) {
  if (accountSaving) return;
  syncPrimaryLocation();
  const row = key ? accountLocations.find(location => locationKey(location) === key) : null;
  if (key && !row) return;
  if (!row && accountLocations.length >= 20) { toast("You can save up to 20 locations."); return; }
  editingLocation = row ? locationKey(row) : null;
  $("#location-title").textContent = row ? "Edit location" : "Add location";
  const form = $("#location-form");
  form.reset();
  for (const key of LOCATION_FIELDS) form.elements[key].value = row?.[key] || "";
  $("#location-dialog").showModal();
}

function loadBasket() {
  let stored;
  if (!STORAGE_KEY) return [];
  try { stored = localStorage.getItem(STORAGE_KEY); }
  catch { storageAvailable = false; return []; }
  try { return sanitiseBasket(JSON.parse(stored || "[]")); }
  catch { return []; }
}

function saveBasket() {
  if (!STORAGE_KEY) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(basket)); storageAvailable = true; }
  catch { storageAvailable = false; }
}

const basketKeyFor = identity => "strangers.wholesale-preview.v2." + identity;
const basketSnapshot = lines => JSON.stringify(sanitiseBasket(lines).sort((a, b) => lineKey(a).localeCompare(lineKey(b))));
function reconcileStoredBasket() {
  if (!ready || saving || pendingAttempt || $("#review-dialog").open || STORAGE_KEY !== basketKeyFor(session?.me.id)) return;
  let stored;
  try { stored = sanitiseBasket(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")); }
  catch { storageAvailable = false; return; }
  if (basketSnapshot(stored) === basketSnapshot(basket)) return;
  basket = stored;
  renderBasket();
}
window.addEventListener("storage", event => {
  // A different tab's pending-key removal is not evidence that this tab's request succeeded.
  try { if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) reconcileStoredBasket(); } catch {}
});
async function reconcileVisibleBasket() {
  if (!ready || saving || document.visibilityState === "hidden") return;
  try { if (await confirmIdentity()) reconcileStoredBasket(); } catch {}
}
document.addEventListener("visibilitychange", reconcileVisibleBasket);
window.addEventListener("focus", reconcileVisibleBasket);
let basketChannel = null;
try {
  if ("BroadcastChannel" in window) {
    basketChannel = new BroadcastChannel("strangers.wholesale.basket");
    basketChannel.addEventListener("message", event => {
      if (event.data?.type === "order-confirmed" && event.data.identity === session?.me.id) reconcileStoredBasket();
    });
  }
} catch {}

function toast(message) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  toastTimer = setTimeout(() => { element.classList.remove("visible"); element.textContent = ""; }, 3500);
}

function stepper(id, quantity, label, errorId) {
  return `<div class="stepper">
    <button type="button" data-step="-1" data-for="${id}" aria-label="${escape(`Decrease packs of ${label}`)}" ${quantity <= 1 ? "disabled" : ""}>−</button>
    <input id="${id}" type="number" min="1" max="${MAX_QUANTITY}" step="1" inputmode="numeric" required value="${quantity}" aria-label="${escape(`Number of packs of ${label}`)}" aria-describedby="${errorId}">
    <button type="button" data-step="1" data-for="${id}" aria-label="${escape(`Increase packs of ${label}`)}" ${quantity >= MAX_QUANTITY ? "disabled" : ""}>+</button>
  </div>`;
}

function renderProducts() {
  $("#products").innerHTML = products.map((product, index) => `<article class="product-card" data-product="${product.id}" aria-labelledby="name-${product.id}">
    <div class="product-image"><div class="product-photo">${product.imageUrls.length ? `<img data-product-photo src="${escape(product.imageUrls[Math.min(photoIndexes.get(product.id) || 0, product.imageUrls.length - 1)])}" alt="${escape(product.title)}" width="722" height="511" ${index > 1 ? 'loading="lazy"' : 'fetchpriority="high"'}>` : '<div class="image-placeholder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12v7a6 6 0 0 1-12 0V7Zm12 1h2a3 3 0 0 1 0 6h-2M3 22h15M8 4V1M12 4V1"/></svg><span>Photo coming soon</span></div>'}</div>${product.badge ? `<span class="product-badge">${escape(product.badge)}</span>` : ""}</div>
    ${product.imageUrls.length > 1 ? `<div class="photo-controls"><button type="button" data-photo-step="-1" aria-label="Previous photo of ${escape(product.name)}">Previous</button><span data-photo-count>${Math.min(photoIndexes.get(product.id) || 0, product.imageUrls.length - 1) + 1} / ${product.imageUrls.length}</span><button type="button" data-photo-step="1" aria-label="Next photo of ${escape(product.name)}">Next</button></div>` : ""}
    <div class="product-info"><p class="product-origin">${escape(product.origin)}</p><h3 class="product-name" id="name-${product.id}">${escape(product.name)}</h3><p class="product-process">${escape(product.process)}</p><p class="tasting-notes">${escape(product.notes)}</p><p class="product-stock ${product.inStock ? "" : "out"}">${product.inStock ? "In stock" : "Out of stock"}</p></div>
    <form class="product-config" data-product="${product.id}">
      <fieldset class="pack-options"><legend>Pack size <span class="sr-only">for ${escape(product.name)}</span></legend>${Object.entries(packs).map(([id, pack]) => `<label class="pack-choice"><input type="radio" name="pack" value="${id}" ${id === "kilo" ? "checked" : ""}><span>${escape(pack.short)} bag</span></label>`).join("")}</fieldset>
      <div class="grind-field"><span class="field-label">Grind</span><select name="grind" hidden aria-label="Grind for ${escape(product.name)}">${Object.entries(grinds).map(([id, grind]) => `<option value="${id}">${escape(grind)}</option>`).join("")}</select><button class="grind-picker" type="button" data-grind-open aria-haspopup="dialog" aria-controls="grind-dialog" aria-label="Choose grind for ${escape(product.name)}"><span data-grind-label>${escape(grinds.beans)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 7 7-7 7"/></svg></button></div>
      <div class="product-price"><strong data-price>${money(product.price)}</strong><span data-price-unit>per 1 kg bag</span></div>
      <div class="add-row">${stepper(`qty-${product.id}`, 1, product.name, `error-${product.id}`)}<button class="button button-dark" type="submit" aria-label="Add ${escape(product.name)} to order" ${isAvailable(product) ? "" : "disabled"}>${product.inStock ? 'Add to order <span aria-hidden="true">+</span>' : "Out of stock"}</button></div>
      <p class="quantity-error" id="error-${product.id}" hidden role="status">Choose a whole number of packs, from 1 to 99.</p>
    </form>
  </article>`).join("");
}

function sortProducts() {
  const container = $("#products"), focused = document.activeElement;
  const cards = products.map((product, index) => {
    const card = container.querySelector(`article[data-product="${product.id}"]`);
    return { card, index, price: unitPrice(product, card.querySelector("form").elements.pack.value) };
  });
  if (currentSort !== "catalogue") cards.sort((a, b) => (currentSort === "price-asc" ? a.price - b.price : b.price - a.price) || a.index - b.index);
  for (let i = 0; i < cards.length; i++) if (container.children[i] !== cards[i].card) container.insertBefore(cards[i].card, container.children[i] || null);
  if (focused && container.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
}
const sortMenu = $("#sort-menu"), sortButton = $("#sort-coffee");
sortMenu.addEventListener("beforetoggle", event => {
  sortButton.setAttribute("aria-expanded", String(event.newState === "open"));
  if (event.newState !== "open") return;
  positionSortMenu();
});
function positionSortMenu() {
  const rect = sortButton.getBoundingClientRect(), width = Math.min(290, innerWidth - 32);
  sortMenu.style.width = width + "px";
  sortMenu.style.left = Math.max(16, Math.min(rect.right - width, innerWidth - width - 16)) + "px";
  const below = innerHeight - rect.bottom - 16;
  sortMenu.style.top = (below >= 210 ? rect.bottom + 8 : Math.max(16, rect.top - 210)) + "px";
  sortMenu.style.maxHeight = Math.max(100, innerHeight - 32) + "px";
}
sortMenu.addEventListener("toggle", event => {
  if (event.newState === "open") sortMenu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
});
sortMenu.addEventListener("click", event => {
  const option = event.target.closest("[data-sort]");
  if (!option || !Object.hasOwn(sortLabels, option.dataset.sort)) return;
  currentSort = option.dataset.sort; $("#sort-label").textContent = sortLabels[currentSort];
  sortButton.setAttribute("aria-label", "Sort coffee: " + sortLabels[currentSort]);
  for (const button of sortMenu.querySelectorAll("[data-sort]")) button.setAttribute("aria-checked", String(button === option));
  if (ready) sortProducts();
  sortMenu.hidePopover(); sortButton.focus({ preventScroll: true });
});
sortMenu.addEventListener("keydown", event => {
  const options = [...sortMenu.querySelectorAll("[data-sort]")], index = options.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index + options.length - 1) % options.length : null;
  if (next !== null) { event.preventDefault(); options[next].focus(); }
});
function closeSortMenu() { if (sortMenu.matches(":popover-open")) sortMenu.hidePopover(); }
window.addEventListener("resize", () => { if (sortMenu.matches(":popover-open")) positionSortMenu(); });
window.addEventListener("scroll", event => { if (!sortMenu.contains(event.target) && sortMenu.matches(":popover-open")) positionSortMenu(); }, true);
function filterProducts() {
  if (!ready) return;
  const query = $("#coffee-search").value.trim().toLocaleLowerCase("en-GB");
  let count = 0;
  for (const product of products) {
    const matchesFilter = currentFilter === "all" || product.categories.includes(currentFilter);
    const matchesQuery = `${product.origin} ${product.name} ${product.process} ${product.notes}`.toLocaleLowerCase("en-GB").includes(query);
    const visible = product.active !== false && matchesFilter && matchesQuery;
    $(`article[data-product="${product.id}"]`).hidden = !visible;
    if (visible) count++;
  }
  $("#product-count").textContent = `${count} ${count === 1 ? "coffee" : "coffees"}`;
  $("#no-results").hidden = count !== 0;
  sortProducts();
}

function validateQuantity(input) {
  const valid = validQuantity(input.value);
  input.setAttribute("aria-invalid", String(!valid));
  const error = document.getElementById(input.getAttribute("aria-describedby"));
  if (error) error.hidden = valid;
  const stepper = input.closest(".stepper");
  stepper.querySelector('[data-step="-1"]').disabled = valid && Number(input.value) <= 1;
  stepper.querySelector('[data-step="1"]').disabled = valid && Number(input.value) >= MAX_QUANTITY;
  const form = input.closest(".product-config");
  if (form) form.querySelector('[type="submit"]').disabled = !valid || !isAvailable(productFor(form.dataset.product));
  return valid;
}

function renderBasket() {
  const active = document.activeElement;
  const focusId = active?.id || active?.dataset.for;
  const focusStep = active?.dataset.step;
  const sum = totals(basket);
  const packText = `${sum.packs} ${sum.packs === 1 ? "pack" : "packs"}`;
  $("#basket-count").textContent = sum.packs;
  $("#basket-count").hidden = !sum.packs;
  $("#order-count").textContent = `${sum.packs} ${sum.packs === 1 ? "bag" : "bags"}`;
  $("#order-count").hidden = !sum.packs;
  $(".basket-link").setAttribute("aria-label", `View your order, ${sum.packs} ${sum.packs === 1 ? "bag" : "bags"}`);
  $("#order-items").innerHTML = basket.length ? basket.map((line, index) => {
    const product = productFor(line.productId);
    return `<div class="order-item" data-line="${lineKey(line)}">
      ${product.imageUrls?.length ? `<img src="${escape(product.imageUrls[0])}" alt="" width="42" height="48">` : '<span class="basket-photo-placeholder" aria-hidden="true">—</span>'}
      <div><h3>${escape(product.name)}</h3><p class="line-variant">${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}<br>${money(unitPrice(product, line.pack))} per pack${!isAvailable(product) ? "<br>Unavailable — remove to continue." : ""}</p>
      <div class="line-actions">${stepper(`line-qty-${index}`, line.quantity, `${product.name}, ${packs[line.pack].label}, ${grinds[line.grind]}`, `line-error-${index}`)}<strong class="line-price">${money(unitPrice(product, line.pack) * line.quantity)}</strong></div>
      <p class="quantity-error" id="line-error-${index}" role="status" hidden>Choose a whole number from 1 to 99.</p>
      <button class="remove-button" type="button" data-remove aria-label="Remove ${escape(`${product.name}, ${packs[line.pack].label}, ${grinds[line.grind]}`)}">Remove</button></div>
    </div>`;
  }).join("") : `<div class="empty-basket"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h3l3 12h11l3-9H6M9 19a1 1 0 1 0 0 .01M18 19a1 1 0 1 0 0 .01"/></svg><h3>Your order is empty</h3><p>Choose a coffee, bag size and grind, then add it to your order.</p></div>`;
  $("#order-totals").hidden = !basket.length;
  $("#total-weight").textContent = weight(sum.grams);
  $("#subtotal").textContent = money(sum.pence);
  $("#review-order").disabled = !pendingAttempt && (!canOrder() || !basket.length || basket.some((line) => !isAvailable(productFor(line.productId))));
  $("#review-order").textContent = pendingAttempt ? "Check submitted order" : "Review order";
  lockPendingUi();
  $("#basket-storage-note").textContent = storageAvailable ? "Your basket stays on this browser." : "Basket is temporary: browser storage is unavailable.";
  $("#mobile-packs").textContent = packText;
  $("#mobile-total").textContent = money(sum.pence);
  updateMobileBasket();
  scheduleDesktopBasketLayout();
  if (focusId?.startsWith("line-qty-")) {
    const replacement = focusStep ? document.querySelector(`[data-for="${focusId}"][data-step="${focusStep}"]`) : document.getElementById(focusId);
    // At a limit the step button becomes disabled; keep keyboard focus in its quantity field instead.
    (replacement?.disabled ? document.getElementById(focusId) : replacement)?.focus({ preventScroll: true });
  }
}

function updateMobileBasket() { $("#mobile-basket").hidden = !basket.length || orderVisible; }
function changedBasket() { saveBasket(); renderBasket(); }

$("#products").addEventListener("change", (event) => {
  const form = event.target.closest(".product-config");
  if (!form) return;
  if (event.target.name === "pack") {
    const pack = form.elements.pack.value;
    const product = productFor(form.dataset.product);
    form.querySelector("[data-price]").textContent = money(unitPrice(product, pack));
    form.querySelector("[data-price-unit]").textContent = `per ${packs[pack].label}`;
    if (currentSort !== "catalogue") sortProducts();
  }
  if (event.target.type === "number") validateQuantity(event.target);
});
$("#products").addEventListener("click", (event) => {
  const button = event.target.closest("[data-photo-step]");
  if (!button) return;
  const card = button.closest("article"), product = productFor(card.dataset.product);
  const length = product?.imageUrls.length || 0;
  if (!length) return;
  const current = Math.min(photoIndexes.get(product.id) || 0, length - 1);
  const next = (current + Number(button.dataset.photoStep) + length) % length;
  photoIndexes.set(product.id, next);
  card.querySelector("[data-product-photo]").src = product.imageUrls[next];
  card.querySelector("[data-photo-count]").textContent = `${next + 1} / ${length}`;
});

let grindProductId = null;
$("#products").addEventListener("click", event => {
  const button = event.target.closest("[data-grind-open]");
  if (!button || !ready || pendingAttempt) return;
  const form = button.closest(".product-config"), product = productFor(form.dataset.product);
  if (!product) return;
  grindProductId = product.id;
  $("#grind-product-name").textContent = product.name;
  for (const radio of $("#grind-choice-form").elements["grind-choice"]) radio.checked = radio.value === form.elements.grind.value;
  $("#grind-dialog").showModal();
});
$("#grind-choice-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!ready || pendingAttempt) return;
  const form = document.querySelector(`.product-config[data-product="${grindProductId}"]`);
  const selected = $("#grind-choice-form").elements["grind-choice"].value;
  if (!form || !Object.hasOwn(grinds, selected)) { $("#grind-dialog").close(); return; }
  form.elements.grind.value = selected;
  form.querySelector("[data-grind-label]").textContent = grinds[selected];
  form.elements.grind.dispatchEvent(new Event("change", { bubbles: true }));
  $("#grind-dialog").close();
  form.querySelector("[data-grind-open]").focus({ preventScroll: true });
});

document.addEventListener("input", (event) => {
  if (event.target.matches(".stepper input")) {
    validateQuantity(event.target);
    // Do not let the review include a different quantity from an invalid basket field on screen.
    if (event.target.closest("#order-items")) $("#review-order").disabled = !canOrder() || !!$("#order-items input[aria-invalid='true']") || basket.some((line) => !isAvailable(productFor(line.productId)));
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-step]");
  if (!button) return;
  const input = document.getElementById(button.dataset.for);
  const base = validQuantity(input.value) ? Number(input.value) : 1;
  input.value = Math.min(MAX_QUANTITY, Math.max(1, base + Number(button.dataset.step)));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});

$("#products").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const product = productFor(form.dataset.product);
  if (!isAvailable(product)) { toast("This coffee is unavailable."); return; }
  const quantity = form.querySelector('input[type="number"]');
  if (!validateQuantity(quantity)) { quantity.focus(); return; }
  const result = addToBasket(basket, { productId: product.id, pack: form.elements.pack.value, grind: form.elements.grind.value }, quantity.value);
  basket = result.basket;
  changedBasket();
  if (!result.added) { toast("This pack and grind already has the maximum of 99 packs."); return; }
  toast(`${result.added} ${result.added === 1 ? "pack" : "packs"} of ${product.name} added${result.added < Number(quantity.value) ? " — maximum 99 per pack and grind" : " to your order"}.`);
});

$("#order-items").addEventListener("change", (event) => {
  const input = event.target;
  if (input.type !== "number" || !validateQuantity(input)) return;
  const key = input.closest("[data-line]").dataset.line;
  basket = basket.map((line) => lineKey(line) === key ? { ...line, quantity: Number(input.value) } : line);
  changedBasket();
});

$("#order-items").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  const key = button.closest("[data-line]").dataset.line;
  const removed = basket.find((line) => lineKey(line) === key);
  basket = basket.filter((line) => lineKey(line) !== key);
  changedBasket();
  toast(`${productFor(removed.productId).name} removed from your order.`);
  const next = $("#order-items [data-remove]") || (!$("#review-order").disabled && $("#review-order")) || $("#your-order");
  next.focus({ preventScroll: true });
});

document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  currentFilter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((filter) => {
    const selected = filter === button;
    filter.classList.toggle("selected", selected);
    filter.setAttribute("aria-pressed", String(selected));
  });
  filterProducts();
}));
$("#coffee-search").addEventListener("input", filterProducts);
$("#reset-filters").addEventListener("click", () => {
  $("#coffee-search").value = "";
  $('[data-filter="all"]').click();
  $("#coffee-search").focus();
});

document.querySelectorAll("[data-basket]").forEach((button) => button.addEventListener("click", () => {
  $("#your-order").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  $("#your-order").focus({ preventScroll: true });
}));

$("#review-form").addEventListener("change", event => {
  if (event.target.name === "delivery" && !saving && !pendingAttempt) renderReviewLocation();
});
$("#review-location").addEventListener("click", () => {
  if (!session.customer || saving || pendingAttempt) return;
  const selected = $("#review-form").elements.locationId.value;
  $("#location-choices").innerHTML = '<legend class="sr-only">Saved locations</legend>' + locationsFor().map(location => `<label><input type="radio" name="location-choice" value="${escape(location.id)}" ${location.id === selected ? "checked" : ""}><span><strong>${escape(location.name)}</strong><small>${escape([location.address, location.postcode].filter(Boolean).join(" · ") || "Delivery address not yet added")}</small></span></label>`).join("");
  $("#location-choice-dialog").showModal();
});
$("#location-choice-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!session.customer || saving || pendingAttempt) return;
  const selected = event.target.elements["location-choice"]?.value;
  if (!locationsFor().some(location => location.id === selected)) return;
  $("#review-form").elements.locationId.value = selected;
  renderReviewLocation();
  $("#location-choice-dialog").close();
  $("#review-location").focus({ preventScroll: true });
});

$("#review-order").addEventListener("click", async () => {
  if (pendingAttempt) { await resumeAttempt(); return; }
  reviewNeedsRefresh = false;
  lockReview(false);
  if (!canOrder() || !basket.length || $("#order-items input[aria-invalid='true']") || basket.some((line) => !isAvailable(productFor(line.productId)))) return;
  $("#review-order").disabled = true;
  try {
    const fresh = await api("/api/wholesale/catalogue");
    if (fresh.me.id !== session.me.id) { location.reload(); return; }
    applyCatalogue(fresh, false);
    if (!canOrder() || !basket.length || basket.some((line) => !isAvailable(productFor(line.productId)))) { toast("Check the updated basket before ordering."); return; }
  } catch (error) { toast(error.message); renderBasket(); return; }
  $("#review-items").innerHTML = basket.map((line) => {
    const product = productFor(line.productId);
    return `<div class="review-line"><div><h3>${escape(product.name)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}</p></div><strong>${money(unitPrice(product, line.pack) * line.quantity)}</strong></div>`;
  }).join("");
  $("#review-total").textContent = money(totals(basket).pence);
  $("#review-form").reset();
  reviewBusiness(session.customer?.business || "");
  $("#review-form").elements.locationId.value = session.customer?.defaultLocationId || "primary";
  renderReviewLocation();
  $("#review-account").hidden = !session.customer;
  $("#review-payment-terms").textContent = session.customer ? `Payment terms: ${session.customer.paymentTerms.label}${session.customer.paymentTerms.note ? " · " + session.customer.paymentTerms.note : ""}` : "";
  requestId = crypto.randomUUID();
  $("#submit-preview-order").disabled = false;
  $("#preview-submit-error").hidden = true;
  $("#review-content").hidden = false;
  $("#preview-complete").hidden = true;
  $("#review-dialog").setAttribute("aria-labelledby", "review-title");
  $("#review-dialog").showModal();
});

// Persist an uncertain submission before sending it. Every retry uses exactly the same ID and payload.
function pendingKey() { return STORAGE_KEY + ".pending-order"; }
function validAttempt(value) {
  return value?.identity === session?.me.id && /^[a-f0-9-]{36}$/i.test(value.payload?.requestId) && Array.isArray(value.payload.lines) && value.payload.lines.length && Array.isArray(value.summary);
}
function removeOwnAttempt(store, key, attempt) {
  const saved = JSON.parse(store.getItem(key) || "null");
  if (!saved || (saved.identity === attempt?.identity && saved.payload?.requestId === attempt?.payload.requestId)) store.removeItem(key);
}
function saveAttempt(attempt) {
  const previous = pendingAttempt;
  if (attempt) {
    try { localStorage.setItem(pendingKey(), JSON.stringify(attempt)); pendingAttempt = attempt; }
    catch { storageAvailable = false; pendingAttempt = null; return; }
    // A tab keeps its own recovery copy if another tab replaces/removes the shared pending key.
    try { sessionStorage.setItem(pendingKey(), JSON.stringify(attempt)); } catch {}
  } else {
    try { removeOwnAttempt(localStorage, pendingKey(), previous); } catch { storageAvailable = false; }
    try { removeOwnAttempt(sessionStorage, pendingKey(), previous); } catch {}
    pendingAttempt = null;
  }
}
function readAttempt() {
  for (const name of ["sessionStorage", "localStorage"]) try {
    const store = window[name];
    const saved = JSON.parse(store.getItem(pendingKey()) || "null");
    if (!validAttempt(saved)) continue;
    try { sessionStorage.setItem(pendingKey(), JSON.stringify(saved)); } catch {}
    return saved;
  } catch {}
  return null;
}
function lockReview(locked) {
  for (const field of $("#review-form").elements) {
    if (field.tagName === "BUTTON") continue;
    if (field.type === "radio") field.disabled = locked;
    else field.readOnly = locked || (field.name === "business" && !!session.customer);
  }
  $("#review-account").disabled = locked;
  $("#review-location").disabled = locked;
  $("#submit-preview-order").textContent = locked ? "Retry same order" : session?.preview ? "Save preview order" : "Place order";
}
function lockPendingUi() {
  if (!pendingAttempt) return;
  for (const control of document.querySelectorAll('.product-config input,.product-config button,.product-config select,#order-items input,#order-items button')) control.disabled = true;
}
function showReceipt(result) {
  const expected = pendingAttempt && (session.preview ? "PREVIEW-" : "WS-") + pendingAttempt.payload.requestId.replaceAll("-", "").toUpperCase();
  if (pendingAttempt?.identity !== session.me.id || !result?.order || result.order.id !== expected || !Number.isSafeInteger(result.order.pence) || result.order.pence < 0 || !Array.isArray(result.order.lines) || result.preview !== session.preview || result.order.createdBy !== session.me.id) throw new Error("The order response was incomplete. Check the submitted order before trying again.");
  const attempt = pendingAttempt, key = basketKeyFor(attempt.identity);
  if (STORAGE_KEY !== key) throw new Error("Sign in to the account that placed this order to check its receipt.");
  let newerBasketKept = false;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && basketSnapshot(JSON.parse(saved)) !== basketSnapshot(attempt.payload.lines)) newerBasketKept = true;
    else localStorage.removeItem(key);
  } catch {
    storageAvailable = false;
    throw new Error("Your order was received, but this browser could not clear its saved basket. Check the submitted order again to recover the receipt.");
  }
  // Commit the confirmed state before rendering optional receipt details. Never write [] over a newer tab's basket.
  saveAttempt(null);
  basket = []; requestId = null; reviewNeedsRefresh = false;
  renderBasket(); renderProducts(); filterProducts();
  try { basketChannel?.postMessage({ type: "order-confirmed", identity: attempt.identity, orderId: result.order.id, requestId: attempt.payload.requestId }); } catch {}
  $("#complete-message").textContent = result.preview ? `${result.order.id} was saved as a staff preview order.` : `${result.order.id} has been received by Strangers. Follow its progress in My orders.`;
  if (newerBasketKept) $("#complete-message").textContent += " A newer basket from another tab has been kept for your next order.";
  $("#complete-dashboard-link").hidden = session.me.role !== "admin";
  if (session.me.role === "admin") $("#complete-dashboard-link").href = session.links.admin + "#wholesale";
  $("#complete-total").textContent = money(result.order.pence);
  $("#complete-location").hidden = !result.order.locationSnapshot;
  $("#complete-location").textContent = result.order.locationSnapshot ? `${result.order.delivery === "Delivery" ? "Delivery to" : "Ordered for"}: ${result.order.locationSnapshot.name}` : "";
  $("#complete-payment-terms").textContent = result.order.paymentTerms ? `Payment terms: ${result.order.paymentTerms.label}${result.order.paymentTerms.note ? " · " + result.order.paymentTerms.note : ""}` : "";
  $("#review-content").hidden = true;
  $("#preview-complete").hidden = false;
  $("#review-dialog").setAttribute("aria-labelledby", "complete-title");
  if (!$("#review-dialog").open) $("#review-dialog").showModal();
  $("#review-dialog").scrollTop = 0;
  $("#preview-complete [data-close]").focus({ preventScroll: true });
  $("#review-form").reset();
}
async function confirmIdentity() {
  const current = await api("/api/wholesale/session");
  if (current.me.id !== session.me.id) { location.reload(); return false; }
  return true;
}
async function resumeAttempt() {
  if (saving || !pendingAttempt) return;
  try { if (!await confirmIdentity()) return; } catch (error) { toast(error.message); return; }
  const id = (session.preview ? "PREVIEW-" : "WS-") + pendingAttempt.payload.requestId.replaceAll("-", "").toUpperCase();
  try { const result = await api("/api/wholesale/orders/" + id); showReceipt(result); return; }
  catch (error) { if (error.status === 401) return; }
  const attempt = pendingAttempt, form = $("#review-form");
  $("#review-items").innerHTML = attempt.summary.map(line => `<div class="review-line"><div><h3>${escape(line.title)}</h3><p>${escape(line.description)}</p></div><strong>${money(line.pence)}</strong></div>`).join("");
  $("#review-total").textContent = money(attempt.payload.lines.reduce((sum,line) => sum + line.price * line.quantity, 0));
  form.elements.delivery.value = attempt.payload.delivery === "Roastery collection" ? "collection" : "dispatch";
  form.elements.reference.value = attempt.payload.reference;
  reviewBusiness(attempt.payload.business);
  form.elements.locationId.value = attempt.payload.locationId || "";
  $("#review-location-block").hidden = !session.customer;
  $("#review-location-name").textContent = attempt.locationLabel || "Saved account location";
  $("#delivery-summary").textContent = attempt.deliverySummary;
  $("#review-payment-terms").textContent = attempt.terms;
  $("#review-account").hidden = !session.customer;
  lockReview(true);
  $("#preview-submit-error").textContent = "The previous submission is awaiting confirmation. Retry checks the same order and cannot create a second copy.";
  $("#preview-submit-error").hidden = false;
  $("#review-content").hidden = false; $("#preview-complete").hidden = true;
  $("#review-dialog").setAttribute("aria-labelledby", "review-title");
  if (!$("#review-dialog").open) $("#review-dialog").showModal();
}
$("#review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || reviewNeedsRefresh || !ready || (!basket.length && !pendingAttempt)) return;
  if (pendingAttempt) { try { if (!await confirmIdentity()) return; } catch (error) { toast(error.message); return; } }
  if (saving) return;
  saving = true;
  const button = $("#submit-preview-order"), form = $("#review-form");
  button.disabled = true;
  $("#preview-submit-error").hidden = true;
  if (!pendingAttempt) saveAttempt({ identity: session.me.id, payload: {
    requestId, orderingIdentity: session.me.id, lines: basket.map(line => ({ ...line, price: unitPrice(productFor(line.productId), line.pack) })),
    delivery: form.elements.delivery.value === "collection" ? "Roastery collection" : "Delivery",
    reference: form.elements.reference.value, business: form.elements.business.value,
    ...(session.customer ? { customerVersion: session.customer.version, locationId: form.elements.locationId.value } : {}),
  }, summary: basket.map(line => ({ title: productFor(line.productId).name, description: `${line.quantity} × ${packs[line.pack].label} · ${grinds[line.grind]}`, pence: unitPrice(productFor(line.productId),line.pack) * line.quantity })),
    deliverySummary: $("#delivery-summary").textContent, locationLabel: session.customer ? $("#review-location-name").textContent : "", terms: $("#review-payment-terms").textContent });
  if (!pendingAttempt) { saving = false; button.disabled = false; $("#preview-submit-error").textContent = "Allow browser storage before placing an order so an interrupted submission can be recovered safely."; $("#preview-submit-error").hidden = false; return; }
  lockReview(true); lockPendingUi();
  try { showReceipt(await api("/api/wholesale/orders", pendingAttempt.payload)); }
  catch (error) {
    // A validated rejection means nothing was saved. Network/5xx/invalid-response failures remain uncertain.
    if (error.status >= 400 && error.status < 500 && error.status !== 401) { saveAttempt(null); reviewNeedsRefresh = true; lockReview(false); renderProducts(); filterProducts(); renderBasket(); }
    $("#preview-submit-error").textContent = pendingAttempt ? "We couldn’t confirm this order. Retry the same order, or reopen this page to check its status. Your submission has been kept." : error.message;
    $("#preview-submit-error").hidden = false;
  } finally { saving = false; button.disabled = reviewNeedsRefresh; }
});

const dialogBusy = (dialog) => (saving && dialog.id === "review-dialog") || (accountSaving && dialog.id === "account-dialog");
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialogBusy(button.closest("dialog")) || button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", event => { if (dialogBusy(dialog)) event.preventDefault(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && !dialogBusy(dialog)) dialog.close(); });
  dialog.addEventListener("close", () => {
    if (dialog.id !== "review-dialog") return;
    $("#review-form").reset();
    requestAnimationFrame(() => {
      if (document.querySelector("dialog[open]")) return;
      reconcileStoredBasket();
      ($("#review-order").disabled ? $("#your-order") : $("#review-order")).focus({ preventScroll: true });
    });
  });
});

async function api(path, body, method) {
  let response;
  try { response = await fetch(path, { method: method || (body ? "POST" : "GET"), cache: "no-store", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error("Couldn’t reach the site. Check your connection and try again."); }
  if (response.status === 401 && !path.startsWith("/api/wholesale/auth/")) { goSignIn(); throw Object.assign(new Error("Sign in to continue."), { status: 401 }); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || "Couldn’t save. Try again."), { status: response.status, code: data.code });
  return data;
}
function showPaymentTerms() {
  $("#account-payment-terms").textContent = session.customer?.paymentTerms.label || "";
  $("#account-payment-note").textContent = session.customer?.paymentTerms.note || "";
}
function applyCatalogue(fresh, initial) {
  session = fresh;
  setCatalogue(session.products);
  if (initial) {
    STORAGE_KEY = "strangers.wholesale-preview.v2." + session.me.id;
    basket = loadBasket();
    pendingAttempt = readAttempt();
    if (pendingAttempt) basket = sanitiseBasket(pendingAttempt.payload.lines);
  } else { basket = sanitiseBasket(basket); saveBasket(); }
  $("#signed-in-name").textContent = session.customer?.business || session.me.name;
  $("#signed-in-name").title = session.customer?.business || session.me.name;
  $("#preview-home").href = session.links.preview;
  $("#admin-wholesale-link").hidden = session.me.role !== "admin";
  if (session.me.role === "admin") $("#admin-wholesale-link").href = session.links.admin + "#wholesale";
  $("#my-account").hidden = !session.customer;
  $("#history-invoices").hidden = !session.customer;
  $("#staff-preview-notice").hidden = !session.preview;
  $("#submit-preview-order").textContent = session.preview ? "Save preview order" : "Place order";
  $("#account-hold").hidden = canOrder();
  showPaymentTerms();
  ready = true;
  renderProducts(); filterProducts(); renderBasket();
  if (pendingAttempt) toast("An order is awaiting confirmation. Choose Check submitted order.");
}
async function start() {
  if (catalogueLoading) return;
  catalogueLoading = true; $("#products").setAttribute("aria-busy", "true");
  $("#retry-catalogue").hidden = true;
  $("#catalogue-status").hidden = false;
  $("#catalogue-status").textContent = "Loading the signed-in catalogue…";
  try {
    applyCatalogue(await api("/api/wholesale/catalogue"), true);
    $("#catalogue-status").hidden = true;
  } catch (error) {
    $("#catalogue-status").textContent = error.message;
    $("#retry-catalogue").hidden = false;
  } finally { catalogueLoading = false; $("#products").setAttribute("aria-busy", "false"); }
}
$("#preview-sign-out").addEventListener("click", async () => {
  if (session?.me.role !== "wholesale") return SC.signOut();
  try { await api("/api/wholesale/auth/logout", {}); goSignIn(); }
  catch (error) { toast(error.message); }
});
$("#retry-catalogue").addEventListener("click", start);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  // Cached dialogs contain private business data; restore against the current session and scoped storage.
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  closeSortMenu();
  location.reload();
});

async function openAccount() {
  try {
    const current = await api("/api/wholesale/session");
    if (current.me.id !== session.me.id) { location.reload(); return; }
    session.customer = current.customer;
    if (!session.customer) return;
    showPaymentTerms();
    for (const key of ["contact", "email", "phone", "address", "postcode", "deliveryNotes"]) $("#account-form").elements[key].value = session.customer[key] || "";
    $("#account-business").textContent = session.customer.business;
    accountLocations = locationsFor();
    accountDefaultLocation = session.customer.defaultLocationId || "primary";
    renderAccountLocations();
    $("#account-error").hidden = $("#password-error").hidden = true;
    $("#account-dialog").showModal();
    $("#account-body").scrollTop = 0;
  } catch (error) { toast(error.message); }
}
$("#add-location").addEventListener("click", () => openLocationEditor(null));
$("#account-form").addEventListener("input", event => {
  if (!["contact", "phone", "address", "postcode", "deliveryNotes"].includes(event.target.name)) return;
  syncPrimaryLocation();
  // Preserve location action buttons while a field loses focus during a click.
  const primary = accountLocations.find(location => location.id === "primary");
  const summary = document.querySelector('[data-account-location="primary"] > p');
  if (primary && summary) summary.textContent = [primary.address, primary.postcode].filter(Boolean).join(" · ") || "Add a delivery address";
});
$("#account-locations").addEventListener("click", event => {
  if (accountSaving) return;
  const button = event.target.closest("button"), key = button?.dataset.locationEdit || button?.dataset.locationRemove || button?.dataset.locationDefault;
  const location = key && accountLocations.find(row => locationKey(row) === key);
  if (!location) return;
  if (button.dataset.locationEdit) { openLocationEditor(key); return; }
  if (button.dataset.locationDefault && location.id) { accountDefaultLocation = location.id; renderAccountLocations(); document.querySelector(`[data-location-edit="${location.id}"]`)?.focus({ preventScroll: true }); return; }
  if (button.dataset.locationRemove && location.id !== "primary") {
    removingLocation = key;
    $("#location-remove-summary").textContent = `Remove ${location.name} from your saved locations?`;
    $("#location-remove-dialog").showModal();
  }
});
$("#location-form").addEventListener("submit", event => {
  event.preventDefault();
  if (accountSaving || !$("#account-dialog").open || !event.target.reportValidity()) return;
  const fields = Object.fromEntries(LOCATION_FIELDS.map(key => [key, event.target.elements[key].value.trim()]));
  const current = editingLocation && accountLocations.find(location => locationKey(location) === editingLocation);
  if (editingLocation && !current) return;
  if (current) {
    Object.assign(current, fields);
    if (current.id === "primary") for (const key of ["contact", "phone", "address", "postcode", "deliveryNotes"]) $("#account-form").elements[key].value = current[key];
  } else {
    if (accountLocations.length >= 20) return;
    accountLocations.push({ ...fields, draftKey: "draft-" + crypto.randomUUID() });
  }
  renderAccountLocations();
  $("#location-dialog").close();
  $("#add-location").focus({ preventScroll: true });
});
$("#confirm-location-remove").addEventListener("click", () => {
  if (accountSaving || !$("#account-dialog").open) return;
  const location = accountLocations.find(row => locationKey(row) === removingLocation);
  if (!location || location.id === "primary") return;
  accountLocations = accountLocations.filter(row => locationKey(row) !== removingLocation);
  if (location.id === accountDefaultLocation) accountDefaultLocation = "primary";
  removingLocation = null;
  renderAccountLocations();
  $("#location-remove-dialog").close();
  $("#add-location").focus({ preventScroll: true });
});
$("#my-account").addEventListener("click", openAccount);
$("#review-account").addEventListener("click", () => { if (saving || pendingAttempt) return; $("#review-dialog").close(); openAccount(); });
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (accountSaving || !form.reportValidity()) return;
  accountSaving = true;
  const controls = [...$("#account-dialog").querySelectorAll("button,input,textarea,select")];
  controls.forEach(control => { control.disabled = true; });
  $("#account-error").hidden = true;
  try {
    if (!await confirmIdentity()) return;
    syncPrimaryLocation();
    const fields = Object.fromEntries(["contact", "email", "phone", "address", "postcode", "deliveryNotes"].map((key) => [key, form.elements[key].value]));
    const locations = accountLocations.map(location => ({ ...(location.id ? { id: location.id } : {}), ...Object.fromEntries(LOCATION_FIELDS.map(key => [key, location[key] || ""])) }));
    const result = await api("/api/wholesale/account", { ...fields, locations, defaultLocationId: accountDefaultLocation, ifVersion: session.customer.version, orderingIdentity: session.me.id }, "PUT");
    session.customer = result.customer;
    showPaymentTerms();
    $("#signed-in-name").textContent = session.customer.business;
    $("#signed-in-name").title = session.customer.business;
    $("#account-dialog").close(); toast("Business details saved.");
  } catch (error) { $("#account-error").textContent = error.message; $("#account-error").hidden = false; }
  finally { accountSaving = false; controls.forEach(control => { if (control.isConnected) control.disabled = false; }); if ($("#account-dialog").open) renderAccountLocations(); }
});
$("#account-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type="submit"]');
  button.disabled = true;
  $("#password-error").hidden = true;
  try {
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) throw new Error("The new passwords do not match.");
    await api("/api/wholesale/auth/change-password", { username: session.me.username, password: form.elements.password.value, newPassword: form.elements.newPassword.value });
    form.reset(); toast("Password changed. Your other sessions have been signed out.");
  } catch (error) { $("#password-error").textContent = error.message; $("#password-error").hidden = false; }
  finally { button.disabled = false; }
});

const bagCount = (value) => `${value} ${value === 1 ? "bag" : "bags"}`;
let reorderPlan = null;
let reordering = false;
function historyStatus(order) {
  const states = ["New", "Preparing", "Ready", "Dispatched"];
  const current = states.indexOf(order.status);
  const descriptions = {
    New: "Received by Strangers.", Preparing: "Your coffee is being prepared.",
    Ready: order.delivery === "Roastery collection" ? "Ready for roastery collection." : "Ready for dispatch.",
    Dispatched: "Marked dispatched by Strangers.", Cancelled: "This order was cancelled.",
  };
  const status = Object.hasOwn(descriptions, order.status) ? order.status : "Status unavailable";
  const badge = `<span class="order-state status-${status.toLowerCase().replaceAll(" ", "-")}">${escape(status)}</span>`;
  if (status === "Cancelled") return `${badge}<p class="history-cancelled">This order was cancelled. No further preparation updates are expected.</p>`;
  return `<div class="history-status">${badge}<p>${descriptions[status] || "Contact Strangers for an update."}</p></div>${current >= 0 ? `<ol class="history-progress" aria-label="Order progress">${states.map((step, i) => `<li ${i < current ? 'class="done"' : ""} ${i === current ? 'aria-current="step"' : ""}><span class="progress-marker" aria-hidden="true">${i < current ? "✓" : i + 1}</span><span>${step === "New" ? "Received" : step}<span class="sr-only">${i < current ? ", completed" : i === current ? ", current stage" : ", not reached"}</span></span></li>`).join("")}</ol>` : ""}`;
}
function historyTrackingUrl(order) {
  if (!session?.customer || order.preview || order.status !== "Dispatched" || order.delivery !== "Delivery") return "";
  const value = typeof order.trackingUrl === "string" ? order.trackingUrl.trim() : "";
  if (!value || value.length > 2000 || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
function historyCard(order, expanded) {
  const date = new Date(order.createdAt).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
  const snapshot = order.customerSnapshot;
  const trackingUrl = historyTrackingUrl(order);
  return `<article class="history-card" data-history-order="${escape(order.id)}"><div class="history-card-head"><h3>${date}</h3><strong>${money(order.pence)}</strong></div><p class="history-summary">${bagCount(order.packs)} · ${escape(order.delivery)}</p>${order.reference ? `<p class="history-summary">Reference: ${escape(order.reference)}</p>` : ""}${historyStatus(order)}
    ${trackingUrl ? `<a class="button button-outline history-tracking" data-order-tracking="${escape(order.id)}" href="${escape(trackingUrl)}" target="_blank" rel="noopener noreferrer">Track delivery <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg><span class="sr-only">(opens in a new tab)</span></a>` : ""}
    <details class="history-details" ${expanded.has(order.id) ? "open" : ""}><summary>Order details · ${bagCount(order.packs)}</summary><p class="history-id">${escape(order.id)}</p><ul class="history-lines">${order.lines.map(line => `<li><span>${line.quantity} × ${escape(line.title)}</span><small>${escape(line.packLabel)} · ${escape(line.grindLabel)}</small><strong>${money(line.price * line.quantity)}</strong></li>`).join("")}</ul>${order.locationSnapshot ? `<p class="history-address"><b>Location at order</b><br>${escape(order.locationSnapshot.name)}</p>` : ""}${snapshot?.address && order.delivery === "Delivery" ? `<p class="history-address"><b>Delivery address at order</b><br>${escape(snapshot.address)}<br>${escape(snapshot.postcode || "")}</p>` : ""}${order.deliveryNotes ? `<p class="history-address">${escape(order.deliveryNotes)}</p>` : ""}${order.paymentTerms ? `<p class="payment-terms">Payment terms: ${escape(order.paymentTerms.label)}${order.paymentTerms.note ? `<br>${escape(order.paymentTerms.note)}` : ""}</p>` : ""}</details>
    <button class="button button-outline history-reorder" type="button" data-reorder="${escape(order.id)}" ${pendingAttempt ? "disabled" : ""}>Order again</button></article>`;
}
let historyCursor = null;
let historyTotal = 0;
let historyLoading = false;
async function loadOrders(append = false) {
  if (historyLoading) return;
  historyLoading = true;
  const expanded = new Set([...document.querySelectorAll('[data-history-order]:has(details[open])')].map(node => node.dataset.historyOrder));
  if (!append) { history = []; historyCursor = null; historyTotal = 0; $("#order-history").textContent = "Loading your orders…"; $("#history-more").hidden = true; }
  $("#history-count").textContent = append ? "Loading earlier orders…" : "Loading orders…";
  $("#order-history").setAttribute("aria-busy", "true");
  refreshBusy("#refresh-orders", true); $("#history-more").disabled = true;
  try {
    if (!await confirmIdentity()) return;
    const result = await api("/api/wholesale/orders" + (append && historyCursor ? "?cursor=" + encodeURIComponent(historyCursor) : ""));
    history = append ? [...new Map([...history, ...result.orders].map(order => [order.id, order])).values()] : result.orders;
    historyTotal = Number.isSafeInteger(result.count) ? result.count : history.length;
    historyCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    $("#order-history").innerHTML = history.length ? history.map(order => historyCard(order, expanded)).join("") : '<p class="dialog-intro">Your orders will appear here once you place one.</p>';
    $("#history-count").textContent = `Showing ${history.length} of ${historyTotal} ${historyTotal === 1 ? "order" : "orders"}`;
    $("#history-more").hidden = !historyCursor;
  } catch (error) { if (!append) $("#order-history").textContent = error.message; $("#history-count").textContent = append ? "Couldn’t load earlier orders. Try again." : ""; }
  finally { historyLoading = false; $("#order-history").setAttribute("aria-busy", "false"); refreshBusy("#refresh-orders", false); $("#history-more").disabled = false; }
}
function showHistorySection(section) {
  const invoices = section === "invoices" && !!session.customer;
  $("#orders-panel").hidden = invoices; $("#invoices-panel").hidden = !invoices;
  $("#history-orders").setAttribute("aria-pressed", String(!invoices)); $("#history-invoices").setAttribute("aria-pressed", String(invoices));
  $("#orders-title").textContent = invoices ? "Invoices" : "Order history";
  $("#orders-body").scrollTop = 0;
}
document.querySelectorAll("#my-orders,[data-order-history]").forEach(button => button.addEventListener("click", () => {
  showHistorySection("orders"); $("#orders-dialog").showModal(); loadOrders();
  if (session.customer) loadInvoices();
}));
$("#history-orders").addEventListener("click", () => showHistorySection("orders"));
$("#history-invoices").addEventListener("click", () => showHistorySection("invoices"));
$("#history-invoice-note").addEventListener("click", () => { showHistorySection("invoices"); $("#history-invoices").focus({ preventScroll: true }); });
$("#refresh-orders").addEventListener("click", () => loadOrders());
$("#history-more").addEventListener("click", () => { if (historyCursor) loadOrders(true); });
function buildReorderPlan(order) {
  let next = sanitiseBasket(basket);
  const additions = [], skipped = [];
  for (const line of order.lines) {
    const product = productFor(line.productId);
    if (!isAvailable(product)) { skipped.push({ title: line.title, quantity: line.quantity, reason: product?.active === false || !product ? "no longer offered" : "out of stock" }); continue; }
    const result = addToBasket(next, line, line.quantity);
    next = result.basket;
    if (result.added) additions.push({ productId: line.productId, pack: line.pack, grind: line.grind, quantity: result.added, title: product.name, price: unitPrice(product, line.pack) });
    if (result.added < line.quantity) skipped.push({ title: line.title, quantity: line.quantity - result.added, reason: "basket limit of 99 bags for this size and grind" });
  }
  const added = totals(additions), combined = totals(next), existing = totals(basket);
  const signature = JSON.stringify({ identity: session.me.id, additions, skipped, next, combined });
  return { order, identity: session.me.id, additions, skipped, next, added, combined, existing, signature };
}
function renderReorderPlan(plan) {
  reorderPlan = plan;
  $("#reorder-summary").textContent = `${bagCount(plan.added.packs)} available to add · ${money(plan.added.pence)} at current prices.`;
  $("#reorder-items").innerHTML = plan.additions.map(line => `<div class="review-line"><div><h3>${escape(line.title)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}</p></div><strong>${money(line.price * line.quantity)}</strong></div>`).join("");
  $("#reorder-skipped").hidden = !plan.skipped.length;
  $("#reorder-skipped-items").innerHTML = plan.skipped.map(line => `<li>${bagCount(line.quantity)} of ${escape(line.title)} — ${escape(line.reason)}.</li>`).join("");
  $("#reorder-existing").textContent = plan.existing.packs ? `Your current ${bagCount(plan.existing.packs)} will stay in the basket. Matching sizes and grinds merge. After adding: ${bagCount(plan.combined.packs)} · ${money(plan.combined.pence)} coffee subtotal.` : `This builds a basket for you to review. Coffee subtotal: ${money(plan.added.pence)}. It does not place an order.`;
  $("#confirm-reorder").textContent = plan.added.packs ? `Add ${bagCount(plan.added.packs)} to basket` : "No available bags to add";
  $("#confirm-reorder").disabled = !plan.added.packs;
  $("#reorder-error").hidden = true;
}
$("#order-history").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-reorder]");
  if (!button || !ready || reordering) return;
  if (pendingAttempt) { toast("Check your submitted order before building another basket."); return; }
  const order = history.find(row => row.id === button.dataset.reorder);
  if (!order) return;
  reordering = true; button.disabled = true;
  try {
    const fresh = await api("/api/wholesale/catalogue");
    if (fresh.me.id !== session.me.id) { location.reload(); return; }
    if (!$("#orders-dialog").open || pendingAttempt) return;
    applyCatalogue(fresh, false);
    renderReorderPlan(buildReorderPlan(order));
    $("#orders-dialog").close();
    $("#reorder-dialog").showModal();
  } catch (error) { toast(error.message); }
  finally { reordering = false; if (button.isConnected) button.disabled = !!pendingAttempt; }
});
$("#confirm-reorder").addEventListener("click", async () => {
  if (reordering || !reorderPlan?.added.packs || !ready) return;
  if (pendingAttempt) { $("#reorder-error").textContent = "Check your submitted order before building another basket."; $("#reorder-error").hidden = false; return; }
  const reviewed = reorderPlan;
  reordering = true; $("#confirm-reorder").disabled = true;
  try {
    const fresh = await api("/api/wholesale/catalogue");
    if (fresh.me.id !== reviewed.identity || fresh.me.id !== session.me.id) { location.reload(); return; }
    if (!$("#reorder-dialog").open || pendingAttempt) return;
    applyCatalogue(fresh, false);
    const current = buildReorderPlan(reviewed.order);
    if (current.signature !== reviewed.signature) { renderReorderPlan(current); $("#reorder-error").textContent = "Prices, availability or your basket changed. Review these updated items before adding."; $("#reorder-error").hidden = false; return; }
    basket = current.next; changedBasket();
    $("#reorder-dialog").close(); reorderPlan = null;
    toast(`${bagCount(current.added.packs)} added at current prices. Review your basket before placing the order.`);
    $("#your-order").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    $("#your-order").focus({ preventScroll: true });
  } catch (error) { $("#reorder-error").textContent = error.message; $("#reorder-error").hidden = false; }
  finally { reordering = false; $("#confirm-reorder").disabled = !reorderPlan?.added.packs; }
});
// Collapse only the mobile account row, keeping a stable sticky shell and any active control visible.
const mobileHeaderQuery = matchMedia("(max-width: 700px)");
const mobileHeader = $(".site-header"), headerShell = $(".header-shell"), headerAccount = $(".header-account");
let mobileHeaderFrame = 0, mobileHeaderNeedsMeasure = true, measuredHeaderWidth = 0;
function scheduleMobileHeaderLayout(measure = false) {
  mobileHeaderNeedsMeasure ||= measure;
  if (mobileHeaderFrame) return;
  mobileHeaderFrame = requestAnimationFrame(() => {
    mobileHeaderFrame = 0;
    let collapsed = mobileHeader.classList.contains("is-account-collapsed");
    if (!mobileHeaderQuery.matches) {
      collapsed = false;
      headerShell.style.removeProperty("--header-expanded-height");
      mobileHeader.style.removeProperty("--header-account-height");
    } else {
      const pageTop = Math.max(0, window.scrollY);
      if (pageTop <= 8 || headerAccount.contains(document.activeElement)) collapsed = false;
      else if (pageTop >= 64) collapsed = true;
      if (mobileHeaderNeedsMeasure) {
        // Measure the expanded state before painting, including after width or navigation changes.
        mobileHeader.classList.add("is-measuring-header");
        mobileHeader.classList.remove("is-account-collapsed");
        mobileHeader.style.setProperty("--header-account-height", `${headerAccount.offsetHeight}px`);
        headerShell.style.setProperty("--header-expanded-height", `${mobileHeader.offsetHeight}px`);
        mobileHeader.classList.toggle("is-account-collapsed", collapsed);
        void mobileHeader.offsetHeight;
        mobileHeader.classList.remove("is-measuring-header");
      }
    }
    mobileHeaderNeedsMeasure = false;
    measuredHeaderWidth = mobileHeader.offsetWidth;
    mobileHeader.classList.toggle("is-account-collapsed", collapsed);
    headerAccount.inert = collapsed;
    if (collapsed) headerAccount.setAttribute("aria-hidden", "true");
    else headerAccount.removeAttribute("aria-hidden");
  });
}
window.addEventListener("scroll", () => scheduleMobileHeaderLayout(), { passive: true });
window.addEventListener("resize", () => scheduleMobileHeaderLayout(true), { passive: true });
window.addEventListener("pageshow", () => scheduleMobileHeaderLayout(true));
mobileHeaderQuery.addEventListener("change", () => scheduleMobileHeaderLayout(true));
headerAccount.addEventListener("focusin", () => scheduleMobileHeaderLayout());
headerAccount.addEventListener("focusout", () => scheduleMobileHeaderLayout());
if ("ResizeObserver" in window) {
  const mobileHeaderObserver = new ResizeObserver(entries => {
    const changedContent = entries.some(entry => entry.target !== mobileHeader);
    scheduleMobileHeaderLayout(changedContent || mobileHeader.offsetWidth !== measuredHeaderWidth);
  });
  [mobileHeader, mobileHeader.querySelector("nav"), ...headerAccount.children].forEach(node => mobileHeaderObserver.observe(node));
}
scheduleMobileHeaderLayout(true);

// Fit the desktop basket to its actual position, including the first viewport before it sticks.
let basketLayoutFrame = 0;
function scheduleDesktopBasketLayout() {
  if (basketLayoutFrame) return;
  basketLayoutFrame = requestAnimationFrame(() => {
    basketLayoutFrame = 0;
    const column = $("#your-order"), panel = column.querySelector(".order-panel"), header = $(".site-header");
    if (!matchMedia("(min-width: 1101px)").matches) { column.style.removeProperty("--basket-top"); panel.style.removeProperty("--basket-height"); return; }
    const inset = parseFloat(getComputedStyle(header).top) || 8;
    const stickyTop = Math.ceil(header.offsetHeight + inset + 16);
    column.style.setProperty("--basket-top", `${stickyTop}px`);
    const top = Math.max(column.getBoundingClientRect().top, stickyTop);
    panel.style.setProperty("--basket-height", `${Math.max(220, innerHeight - top - 20)}px`);
  });
}
window.addEventListener("resize", scheduleDesktopBasketLayout, { passive: true });
window.addEventListener("scroll", scheduleDesktopBasketLayout, { passive: true });
if ("ResizeObserver" in window) {
  const basketLayoutObserver = new ResizeObserver(scheduleDesktopBasketLayout);
  basketLayoutObserver.observe($(".site-header"));
}
scheduleDesktopBasketLayout();
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => { orderVisible = entry.isIntersecting; updateMobileBasket(); }, { threshold: 0 }).observe($("#your-order"));
}
start();


// Issued invoices remain available in My orders even after their source order is removed.
let customerInvoices = [], invoiceCursor = null, invoiceTotal = 0, invoiceLoading = false;
function customerInvoiceCard(invoice, expanded) {
  const paid = !!invoice.payment?.paid, overdue = !paid && invoice.payment?.status === "overdue";
  const label = paid ? "Paid" : overdue ? "Overdue" : "Unpaid";
  const date = value => value ? new Date(value + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }) : "Not set";
  const href = "/api/wholesale/invoices/" + encodeURIComponent(invoice.id) + "/pdf";
  return `<article class="customer-invoice-card" data-customer-invoice="${escape(invoice.id)}"><div class="history-card-head"><h3>${escape(invoice.number)}</h3><strong>${money(invoice.totals.grossPence)}</strong></div><div class="invoice-status-line"><span class="invoice-state ${paid ? "paid" : overdue ? "overdue" : "unpaid"}">${label}</span><span>${paid ? "Paid " + escape(date(invoice.payment.paidDate)) : invoice.dueDate ? "Due " + escape(date(invoice.dueDate)) : "Payment due under the agreed terms"}</span></div><p class="history-summary">Invoice date: ${escape(date(invoice.invoiceDate))}${invoice.deliveryLocation?.name ? " · " + escape(invoice.deliveryLocation.name) : ""}</p><p class="payment-terms">${escape(invoice.paymentTerms.label)}${invoice.paymentTerms.note ? " · " + escape(invoice.paymentTerms.note) : ""}</p>${!paid ? `<p class="invoice-balance">Outstanding <strong>${money(invoice.payment.outstandingPence)}</strong></p>` : ""}<details class="invoice-details" ${expanded.has(String(invoice.id)) ? "open" : ""}><summary>Invoice details and payment instructions</summary><p class="history-address"><b>Billed to</b><br>${escape([invoice.billTo.name, invoice.billTo.address, invoice.billTo.postcode].filter(Boolean).join("\n")).replaceAll("\n", "<br>")}</p><p>Order: ${escape(invoice.orderId)}${invoice.orderReference ? " · Reference: " + escape(invoice.orderReference) : ""}</p><dl class="invoice-amounts"><div><dt>Net subtotal</dt><dd>${money(invoice.totals.netPence)}</dd></div><div><dt>VAT</dt><dd>${money(invoice.totals.vatPence)}</dd></div><div><dt>Invoice total</dt><dd>${money(invoice.totals.grossPence)}</dd></div></dl>${invoice.paymentInstructions ? `<p class="history-address"><b>How to pay</b><br>${escape(invoice.paymentInstructions).replaceAll("\n", "<br>")}</p>` : ""}</details><a class="button button-outline invoice-pdf" data-invoice-pdf href="${href}" target="_blank" rel="noopener">View invoice PDF <span class="sr-only">(opens in a new tab)</span></a></article>`;
}
async function loadInvoices(append = false) {
  if (invoiceLoading || !session?.customer) return;
  invoiceLoading = true;
  const expanded = new Set([...document.querySelectorAll('[data-customer-invoice]:has(details[open])')].map(node => node.dataset.customerInvoice));
  if (!append) { customerInvoices = []; invoiceCursor = null; invoiceTotal = 0; $("#customer-invoices-list").textContent = "Loading your invoices…"; $("#invoice-more").hidden = true; $("#history-invoice-note").hidden = true; }
  $("#invoice-count").textContent = append ? "Loading earlier invoices…" : "Loading invoices…";
  $("#customer-invoices-list").setAttribute("aria-busy", "true");
  refreshBusy("#refresh-invoices", true); $("#invoice-more").disabled = true;
  try {
    if (!await confirmIdentity()) return;
    const result = await api("/api/wholesale/invoices" + (append && invoiceCursor ? "?cursor=" + encodeURIComponent(invoiceCursor) : ""));
    customerInvoices = append ? [...new Map([...customerInvoices, ...result.invoices].map(invoice => [invoice.id, invoice])).values()] : result.invoices;
    invoiceCursor = result.nextCursor || null; invoiceTotal = result.count;
    const summary = result.summary;
    $("#customer-invoice-summary").innerHTML = `<div><span>Outstanding</span><strong>${money(summary.outstandingPence)}</strong></div><div><span>Overdue</span><strong>${money(summary.overduePence)}</strong></div>`;
    $("#history-invoice-note").hidden = !summary.outstandingPence;
    $("#history-invoice-note").textContent = `${money(summary.outstandingPence)} outstanding${summary.overdueCount ? " · " + summary.overdueCount + " overdue" : ""} · View invoices`;
    $("#customer-invoices-list").innerHTML = customerInvoices.length ? customerInvoices.map(invoice => customerInvoiceCard(invoice, expanded)).join("") : '<p class="dialog-intro">Your issued invoices will appear here. Contact Strangers if you need an invoice for an order.</p>';
    $("#invoice-count").textContent = `Showing ${customerInvoices.length} of ${invoiceTotal} ${invoiceTotal === 1 ? "invoice" : "invoices"}`;
    $("#invoice-more").hidden = !invoiceCursor;
  } catch (error) {
    if (!append) $("#customer-invoices-list").textContent = error.message;
    $("#invoice-count").textContent = append ? "Couldn’t load earlier invoices. Try again." : "Couldn’t load invoices. Use the refresh button to try again.";
  } finally {
    invoiceLoading = false; $("#customer-invoices-list").setAttribute("aria-busy", "false");
    refreshBusy("#refresh-invoices", false); $("#invoice-more").disabled = false;
  }
}
$("#refresh-invoices").addEventListener("click", () => loadInvoices());
$("#invoice-more").addEventListener("click", () => { if (invoiceCursor) loadInvoices(true); });
