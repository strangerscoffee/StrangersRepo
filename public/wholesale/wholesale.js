import { availableGrinds, grindLabel, grindHint, isGrindAvailable } from "./grinds.js";
import { isWholesaleDelivery, shippingFor, SHIPPING_PENCE, FREE_SHIPPING_FROM_PENCE } from "./shipping.js";
import { createCoffeeChoices, setupCatalogueSearch } from "./catalogue-ui.js";
// A fresh module URL avoids reusing a cached pre-migration model that imported the price snapshot.
// This is not a ?v= fingerprint: it retains the normal short revalidation period for future model changes.
import { products, setCatalogue, isAvailable, packs, packsFor, sizeFor, lineOrderable, grinds, MAX_QUANTITY, money, weight, productFor, lineKey, unitPrice, validQuantity, sanitiseBasket, addToBasket, totals } from "./order.js?bootstrap=wholesale";

let STORAGE_KEY = null;
let session = null;
let ready = false;
let requestId = null;
// Order again starts on the site the original order went to (when it's still one of the customer's locations).
let reorderSite = null;
let saving = false;
let pendingAttempt = null;
let reviewNeedsRefresh = false;
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let storageAvailable = true;
// Delivery or Roastery collection, chosen in the basket so its totals are right for collectors (no delivery
// charge), carried into the review and remembered on this device after an order (a convenience only).
const METHOD_KEY = "sc.wholesale.deliveryMethod";
let basketMethod = (() => { try { return localStorage.getItem(METHOD_KEY) === "collection" ? "collection" : "dispatch"; } catch { return "dispatch"; } })();
function setBasketMethod(method, remember = false) {
  basketMethod = method === "collection" ? "collection" : "dispatch";
  if (remember) try { localStorage.setItem(METHOD_KEY, basketMethod); } catch {}
}
let basket = [];
let currentFilter = "all";
let currentSort = "catalogue", catalogueLoading = false;
const sortLabels = { catalogue: "Catalogue order", "price-asc": "Price: low to high", "price-desc": "Price: high to low" };
// The bag size the whole catalogue shows (250 g or 1 kg). Price sorting always compares this size, so every coffee is
// ranked on the same bag and a card doesn't jump when one coffee's own size is changed. Remembered on this browser.
// v2: everyone starts again on 1 kg (the default); a customer who switches to 250 g is remembered from then on.
const BAG_SIZE_KEY = "sc.wholesale.bagSize.v2";
let bagSize = (() => { try { const saved = localStorage.getItem(BAG_SIZE_KEY); return Object.hasOwn(packs, saved) ? saved : "kilo"; } catch { return "kilo"; } })();
function refreshBusy(id, busy) {
  const button = $(id); button.disabled = busy; button.setAttribute("aria-busy", String(busy));
}
let orderVisible = false;
let toastTimer;
let history = [];
let repeatOrder = null;
const addedTimers = new Map();
const catalogueSearch = setupCatalogueSearch();
const coffeeChoices = createCoffeeChoices({ allowed: () => ready && !pendingAttempt && !saving && !document.documentElement.hasAttribute('data-sc-session-locked'), locked: () => !ready || document.documentElement.hasAttribute('data-sc-session-locked') });
const photoIndexes = new Map();
const canOrder = () => session?.customer?.status !== "On hold";
// Strangers can hide prices from a business (its own shops): then the page shows bags and weights, never money.
const pricesShown = () => session?.showPrices !== false;
// Strangers can give a business free delivery (Admin); the server charges nothing for it either.
const freeDelivery = () => session?.freeDelivery === true;
const deliveryCharge = (delivery, coffeePence) => freeDelivery() ? 0 : shippingFor(delivery, coffeePence);
const goSignIn = () => location.replace(location.pathname.startsWith("/wholesale/") ? "/wholesale/signin" : "/signin");

// Elevation follows the real scroll position without changing the header's size or focus.
const updateHeaderElevation = () => $(".site-header").toggleAttribute("data-scrolled", window.scrollY > 8);
window.addEventListener("scroll", updateHeaderElevation, { passive: true });
window.addEventListener("pageshow", updateHeaderElevation);
updateHeaderElevation();

const LOCATION_FIELDS = ["name", "contact", "phone", "address", "postcode", "deliveryNotes"];
let accountLocations = [], accountDefaultLocation = "primary", editingLocation = null, removingLocation = null, accountSaving = false;
const locationKey = (location) => location.id || location.draftKey;
function locationsFor(customer = session?.customer) {
  if (!customer) return [];
  return (customer.locations?.length ? customer.locations : [{ id: "primary", name: customer.business || "Main location", ...Object.fromEntries(["contact", "phone", "address", "postcode", "deliveryNotes"].map(key => [key, customer[key] || ""])) }]).map(location => ({ ...location }));
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
// Delivery needs an address: say so before Place order rather than after the server refuses (the owner's report,
// 26 Nov 2026: switching to collection after that refusal left Place order stuck until the basket was reopened).
function reviewAddressMissing() {
  const form = $("#review-form"), customer = session?.customer;
  if (!customer || form.elements.delivery.value === "collection") return false;
  const location = locationsFor(customer).find(entry => entry.id === form.elements.locationId.value);
  return !!location && (!String(location.address || "").trim() || !String(location.postcode || "").trim());
}
function updateReviewReady() {
  if (pendingAttempt) return;
  const missing = reviewAddressMissing();
  $("#review-address-note").hidden = !missing;
  if (!missing && /delivery address and postcode/.test($("#preview-submit-error").textContent)) $("#preview-submit-error").hidden = true;
  if (!saving) $("#submit-preview-order").disabled = reviewNeedsRefresh || missing;
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
  renderMoreSites();
  updateReviewReady();
}
// "Send to more sites": the same bags as a separate order for each ticked location (one order per site).
function moreSites() { return [...document.querySelectorAll('#more-site-choices input:checked')].map(input => input.value); }
function renderMoreSites() {
  const box = $("#review-more-sites"), field = $("#review-form").elements.locationId;
  const others = session.customer && !session.preview && !pendingAttempt ? locationsFor().filter(location => location.id !== field.value) : [];
  const ticked = new Set(moreSites());
  box.hidden = !others.length;
  $("#more-site-choices").innerHTML = others.map(location => `<label class="more-site"><input type="checkbox" name="moreSites" value="${escape(location.id)}" ${ticked.has(location.id) ? "checked" : ""}><span><strong>${escape(location.name)}</strong><small>${escape([location.address, location.postcode].filter(Boolean).join(" · ") || "Delivery address not yet added")}</small></span></label>`).join("");
  updatePlaceButton();
}
function updatePlaceButton() {
  if (pendingAttempt || saving) return;
  const n = moreSites().length + 1;
  $("#submit-preview-order").textContent = session?.preview ? "Save preview order" : n > 1 ? `Place ${n} orders` : "Place order";
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

// Tapping a quantity selects it, so typing a number replaces it. Selected at once (not after a delay, which
// could swallow the first key), and the release of that same tap mustn't move the caret and undo it.
let quantityJustFocused = null;
document.addEventListener("focusin", (event) => {
  if (!event.target.matches?.(".stepper input")) return;
  try { event.target.select(); } catch {}
  quantityJustFocused = event.target;
});
document.addEventListener("mouseup", (event) => { if (event.target === quantityJustFocused) event.preventDefault(); quantityJustFocused = null; });
document.addEventListener("keydown", () => { quantityJustFocused = null; });
function stepper(id, quantity, label, errorId) {
  return `<div class="stepper">
    <button type="button" data-step="-1" data-for="${id}" aria-label="${escape(`Decrease packs of ${label}`)}" ${quantity <= 1 ? "disabled" : ""}>−</button>
    <input id="${id}" type="number" min="1" max="${MAX_QUANTITY}" step="1" inputmode="numeric" enterkeyhint="done" required value="${quantity}" title="Type a number of packs" aria-label="${escape(`Number of packs of ${label}`)}" aria-describedby="${errorId}">
    <button type="button" data-step="1" data-for="${id}" aria-label="${escape(`Increase packs of ${label}`)}" ${quantity >= MAX_QUANTITY ? "disabled" : ""}>+</button>
  </div>`;
}

function renderProducts() {
  coffeeChoices.close();
  for (const timer of addedTimers.values()) clearTimeout(timer);
  addedTimers.clear();
  $("#products").innerHTML = products.map((product, index) => `<article class="product-card${product.yours ? " yours" : ""}" data-product="${product.id}" aria-labelledby="name-${product.id}">
    <div class="product-gallery"><div class="product-image"><div class="product-photo">${product.imageUrls.length ? `<img data-product-photo src="${escape(product.imageUrls[Math.min(photoIndexes.get(product.id) || 0, product.imageUrls.length - 1)])}" alt="${escape(product.title)}" width="722" height="511" ${index > 1 ? 'loading="lazy"' : 'fetchpriority="high"'}>` : '<div class="image-placeholder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h12v7a6 6 0 0 1-12 0V7Zm12 1h2a3 3 0 0 1 0 6h-2M3 22h15M8 4V1M12 4V1"/></svg><span>Photo coming soon</span></div>'}</div>${product.badge ? `<span class="product-badge">${escape(product.badge)}</span>` : ""}</div>
    ${product.imageUrls.length > 1 ? `<div class="photo-controls"><button type="button" data-photo-step="-1" aria-label="Previous photo of ${escape(product.name)}">Previous</button><span data-photo-count>${Math.min(photoIndexes.get(product.id) || 0, product.imageUrls.length - 1) + 1} / ${product.imageUrls.length}</span><button type="button" data-photo-step="1" aria-label="Next photo of ${escape(product.name)}">Next</button></div>` : ""}
    </div><div class="product-info">${product.yours ? '<p class="product-yours">Your coffee</p>' : product.whiteLabel ? '<p class="product-yours">White label</p>' : ""}<div class="product-meta"><p class="product-origin">${escape(product.origin)}</p><p class="product-stock ${product.inStock ? "" : "out"}">${product.inStock ? "In stock" : "Out of stock"}</p></div><h3 class="product-name" id="name-${product.id}">${escape(product.name)}</h3>${product.process && product.process !== product.badge ? `<p class="product-process">${escape(product.process)}</p>` : ''}<p class="tasting-notes">${escape(product.notes)}</p></div>
    <form class="product-config" data-product="${product.id}">
      <fieldset class="pack-options${packsFor(product).length === 1 ? " one-size" : ""}" hidden><legend>Bag weight for ${escape(product.name)}</legend>${packsFor(product).map(([id, pack]) => `<input type="radio" name="pack" value="${id}" ${id === sizeFor(product, bagSize) ? "checked" : ""} aria-label="${escape(pack.label)}">`).join("")}</fieldset>
      <div class="variant-fields"><button class="pack-picker" type="button" data-pack-open aria-haspopup="menu" aria-controls="coffee-choice-menu" aria-expanded="false" aria-label="Choose bag weight for ${escape(product.name)}" ${packsFor(product).length === 1 ? 'disabled' : ''}><span><small>Bag weight</small><strong data-pack-label>${escape(packs[sizeFor(product, bagSize)].short)} bag${packsFor(product).length === 1 ? 's only' : ''}</strong></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <div class="grind-field"><select name="grind" hidden aria-label="Grind for ${escape(product.name)}">${availableGrinds(product).map(option => `<option value="${escape(option.id)}">${escape(option.label)}</option>`).join("")}</select><button class="grind-picker" type="button" data-grind-open aria-haspopup="menu" aria-controls="coffee-choice-menu" aria-expanded="false" aria-label="Choose grind for ${escape(product.name)}"><span class="grind-current"><small>Bean / grind</small><strong data-grind-label>${escape(availableGrinds(product)[0]?.label || "Unavailable")}</strong><span data-grind-hint hidden>${escape(availableGrinds(product)[0]?.hint || "")}</span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div></div>
      <div class="product-price"><strong data-price>${money(unitPrice(product, sizeFor(product, bagSize)))}</strong><span data-price-unit>per ${escape(packs[sizeFor(product, bagSize)].label)}</span></div>
      <div class="add-row">${stepper(`qty-${product.id}`, 1, product.name, `error-${product.id}`)}<button class="button button-dark" type="submit" aria-label="Add ${escape(product.name)} to order" ${isAvailable(product) ? "" : "disabled"}><span data-add-label>${product.inStock ? 'Add' : 'Out of stock'}</span><span data-add-symbol aria-hidden="true">+</span><svg data-add-check viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></div>
      <p class="quantity-error" id="error-${product.id}" hidden role="status">Choose a whole number of packs, from 1 to ${MAX_QUANTITY}.</p>
    </form>
  </article>`).join("");
}

function sortProducts() {
  const container = $("#products"), focused = document.activeElement;
  const cards = products.map((product, index) => {
    const card = container.querySelector(`article[data-product="${product.id}"]`);
    // A coffee sold only in the other size is compared at the same price per gram.
    const size = sizeFor(product, bagSize), price = unitPrice(product, size);
    return { card, index, yours: product.yours ? 1 : 0, price: Number.isFinite(price) ? price * packs[bagSize].grams / packs[size].grams : Infinity };
  });
  // A business's own white-label coffees always come first.
  if (currentSort !== "catalogue") cards.sort((a, b) => (b.yours - a.yours) || (a.price === b.price ? 0 : currentSort === "price-asc" ? (a.price < b.price ? -1 : 1) : (a.price > b.price ? -1 : 1)) || a.index - b.index);
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
  sortMenu.style.maxHeight = Math.max(44, innerHeight - 32) + "px";
  const height = sortMenu.offsetHeight || Math.min(210, innerHeight - 32);
  const below = innerHeight - rect.bottom - 16, above = rect.top - 16;
  const opensBelow = below >= height + 8 || below >= above;
  const top = opensBelow ? rect.bottom + 8 : rect.top - height - 8;
  sortMenu.style.top = Math.max(16, Math.min(top, innerHeight - height - 16)) + "px";
  sortMenu.dataset.side = opensBelow ? "below" : "above";
}
sortMenu.addEventListener("toggle", event => {
  if (event.newState === "open") {
    positionSortMenu(); // The open popover now has its actual untransformed height.
    sortMenu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }
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
function setPackPrice(form) {
  const pack = form.elements.pack.value, product = productFor(form.dataset.product);
  form.querySelector("[data-price]").textContent = money(unitPrice(product, pack));
  form.querySelector("[data-price-unit]").textContent = `per ${packs[pack].label}`;
  form.querySelector('[data-pack-label]').textContent = `${packs[pack].short} bag${packsFor(product).length === 1 ? 's only' : ''}`;
}
// Shows the chosen size on the switch, or neither when some coffees have been changed to the other size.
function showBagSize() {
  // Coffees sold in only one size don't count: they can't follow the switch.
  const chosen = new Set([...document.querySelectorAll('#products .product-config .pack-options:not(.one-size) input[name="pack"]:checked')].map(input => input.value));
  for (const button of document.querySelectorAll("[data-bag-size]")) {
    const on = button.dataset.bagSize === bagSize && !(chosen.size > 1 || (chosen.size === 1 && !chosen.has(bagSize)));
    button.classList.toggle("selected", on); button.setAttribute("aria-pressed", String(on));
  }
  $("#sort-basis").textContent = `Sort by ${packs[bagSize].label} price`;
}
document.querySelectorAll("[data-bag-size]").forEach(button => button.addEventListener("click", () => {
  if (!Object.hasOwn(packs, button.dataset.bagSize)) return;
  bagSize = button.dataset.bagSize;
  try { localStorage.setItem(BAG_SIZE_KEY, bagSize); } catch {}
  for (const form of document.querySelectorAll("#products .product-config")) {
    const input = form.querySelector(`input[name="pack"][value="${bagSize}"]`);
    if (input && !input.checked) { input.checked = true; setPackPrice(form); }
  }
  showBagSize();
  if (ready) sortProducts();
}));
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
  const countNoun = document.createElement("span");
  countNoun.className = "count-noun";
  countNoun.textContent = count === 1 ? " coffee" : " coffees";
  $("#product-count").replaceChildren(String(count), countNoun);
  $("#no-results").hidden = count !== 0;
  $("#active-filter-bar").hidden = !query && currentFilter === "all";
  const category = currentFilter === "all" ? "All coffee" : document.querySelector(`[data-filter="${currentFilter}"]`).textContent.trim();
  $("#active-filter-summary").textContent = `${category}${query ? ` · “${$("#coffee-search").value.trim()}”` : ""} · ${count} ${count === 1 ? "result" : "results"}`;
  showBagSize();
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
      <div><h3>${escape(product.name)}</h3><p class="line-variant">${escape(packs[line.pack].label)} · ${escape(grindLabel(productFor(line.productId), line.grind))}${pricesShown() ? `<br>${money(unitPrice(product, line.pack))} per pack` : ""}${!isAvailable(product) || !lineOrderable(line) ? "<br>Unavailable — remove to continue." : ""}</p>
      <div class="line-actions">${stepper(`line-qty-${index}`, line.quantity, `${product.name}, ${packs[line.pack].label}, ${grindLabel(productFor(line.productId), line.grind)}`, `line-error-${index}`)}${pricesShown() ? `<strong class="line-price">${money(unitPrice(product, line.pack) * line.quantity)}</strong>` : ""}</div>
      <p class="quantity-error" id="line-error-${index}" role="status" hidden>Choose a whole number from 1 to ${MAX_QUANTITY}.</p>
      <button class="remove-button" type="button" data-remove aria-label="Remove ${escape(`${product.name}, ${packs[line.pack].label}, ${grindLabel(productFor(line.productId), line.grind)}`)}">Remove</button></div>
    </div>`;
  }).join("") : `<div class="empty-basket"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h3l3 12h11l3-9H6M9 19a1 1 0 1 0 0 .01M18 19a1 1 0 1 0 0 .01"/></svg><h3>Your order is empty</h3><p>Choose a coffee, bag size and grind, then add it to your order.</p></div>`;
  $("#order-totals").hidden = !basket.length;
  $("#total-weight").textContent = weight(sum.grams);
  $("#subtotal").textContent = pricesShown() ? money(sum.pence) : "";
  const collecting = basketMethod === "collection";
  for (const input of document.querySelectorAll('input[name="basket-method"]')) input.checked = input.value === basketMethod;
  const delivery = collecting ? 0 : deliveryCharge("Delivery", sum.pence);
  $("#basket-delivery-label").textContent = collecting ? "Roastery collection" : "Delivery";
  $("#basket-delivery").textContent = pricesShown() ? delivery ? money(delivery) : "Free" : "";
  $("#basket-estimate").textContent = pricesShown() ? money(sum.pence + delivery) : "";
  $("#delivery-note").textContent = !pricesShown() ? "" : collecting ? "No delivery charge when you collect from the Roastery, 10 Dove Street, Norwich."
    : freeDelivery() ? "Delivery is free for your account."
    : sum.pence >= FREE_SHIPPING_FROM_PENCE ? "Free delivery on orders of £250 or more of coffee."
    : `Delivery is ${money(SHIPPING_PENCE)} including VAT, free on £250 or more of coffee (add ${money(FREE_SHIPPING_FROM_PENCE - sum.pence)} more). Collecting from the Roastery is free.`;
  // The minimum order (6 kg of any coffees and bag sizes) unless Strangers has exempted this business.
  const minimum = minimumGrams(), short = Math.max(0, minimum - sum.grams);
  $("#minimum-note").hidden = !minimum || (basket.length && !short);
  $("#minimum-note").classList.toggle("short", !!(basket.length && short));
  $("#minimum-note").textContent = !minimum ? "" : !basket.length ? `Minimum order ${weight(minimum)} of coffee: any mix of coffees and bag sizes.` : `Add ${weight(short)} more to reach the ${weight(minimum)} minimum order.`;
  $("#review-order").disabled = !pendingAttempt && (!canOrder() || !basket.length || short > 0 || basket.some((line) => (!isAvailable(productFor(line.productId)) || !lineOrderable(line))));
  $("#review-order").textContent = pendingAttempt ? "Check submitted order" : "Review order";
  lockPendingUi();
  $("#basket-storage-note").textContent = storageAvailable ? "Your basket stays on this browser." : "Basket is temporary: browser storage is unavailable.";
  $("#mobile-packs").textContent = packText;
  $("#mobile-total").textContent = pricesShown() ? money(sum.pence) : weight(sum.grams);
  updateMobileBasket();
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
    setPackPrice(form);
    showBagSize();
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

function openCoffeeChoice(button) {
  if (!button || !ready || pendingAttempt || saving) return;
  const form = button.closest('.product-config'), product = productFor(form.dataset.product), pack = button.hasAttribute('data-pack-open');
  if (!product) return;
  closeAccountMenu(); closeSortMenu();
  coffeeChoices.open(button, {
    title: `${pack ? 'Bag weight' : 'Bean / grind'} · ${product.name}`,
    selected: form.elements[pack ? 'pack' : 'grind'].value,
    options: pack ? packsFor(product).map(([id, value]) => ({ id, label: value.label, hint: pricesShown() ? `${money(unitPrice(product, id))} per bag` : '' })) : availableGrinds(product),
    onChoose(id) {
      if (pack) {
        const input = [...form.querySelectorAll('input[name="pack"]')].find(input => input.value === id);
        if (!input || !packsFor(product).some(([key]) => key === id)) return;
        input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        if (!isGrindAvailable(productFor(product.id), id)) return;
        form.elements.grind.value = id;
        form.querySelector('[data-grind-label]').textContent = grindLabel(product, id);
        form.querySelector('[data-grind-hint]').textContent = grindHint(product, id);
        form.elements.grind.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}
$('#products').addEventListener('click', event => openCoffeeChoice(event.target.closest('[data-pack-open],[data-grind-open]')));
$('#products').addEventListener('keydown', event => {
  const button = event.target.closest('[data-pack-open],[data-grind-open]');
  if (button && event.key === 'ArrowDown') { event.preventDefault(); openCoffeeChoice(button); }
});

document.addEventListener("input", (event) => {
  if (event.target.matches(".stepper input")) {
    validateQuantity(event.target);
    // Do not let the review include a different quantity from an invalid basket field on screen.
    if (event.target.closest("#order-items")) $("#review-order").disabled = !canOrder() || !!$("#order-items input[aria-invalid='true']") || basket.some((line) => (!isAvailable(productFor(line.productId)) || !lineOrderable(line)));
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
  if (!result.added) { toast(`This pack and grind already has the maximum of ${MAX_QUANTITY} packs.`); return; }
  const badge = $("#basket-count");
  badge.getAnimations?.().forEach(animation => animation.cancel());
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) badge.animate?.([
    { transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" },
  ], { duration: 250, easing: "cubic-bezier(.22,1,.36,1)" });
  const addButton = form.querySelector('[type="submit"]');
  clearTimeout(addedTimers.get(product.id));
  addButton.dataset.added = ''; addButton.querySelector('[data-add-label]').textContent = 'Added';
  addedTimers.set(product.id, setTimeout(() => { addedTimers.delete(product.id); if (addButton.isConnected) { delete addButton.dataset.added; addButton.querySelector('[data-add-label]').textContent = 'Add'; } }, 1400));
  toast(`${result.added} ${result.added === 1 ? "pack" : "packs"} of ${product.name} added${result.added < Number(quantity.value) ? ` — maximum ${MAX_QUANTITY} per pack and grind` : " to your order"}.`);
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
  catalogueSearch.open();
});

document.querySelectorAll("[data-basket]").forEach((button) => button.addEventListener("click", () => {
  openBasket();
  $("#your-order").focus({ preventScroll: true });
}));

$("#review-form").addEventListener("change", event => {
  if (event.target.name === "delivery" && !saving && !pendingAttempt) { setBasketMethod(event.target.value); renderReviewLocation(); renderReviewDelivery(); renderBasket(); }
});
$("#basket-method").addEventListener("change", event => {
  if (event.target.name !== "basket-method") return;
  setBasketMethod(event.target.value, true); renderBasket();
});
$("#review-collect-instead").addEventListener("click", () => {
  if (saving || pendingAttempt) return;
  const form = $("#review-form");
  form.elements.delivery.value = "collection";
  setBasketMethod("collection"); renderReviewLocation(); renderReviewDelivery(); renderBasket();
  $("#submit-preview-order").focus({ preventScroll: true });
});
$("#review-location").addEventListener("click", () => {
  if (!session.customer || saving || pendingAttempt) return;
  const selected = $("#review-form").elements.locationId.value;
  $("#location-choices").innerHTML = '<legend class="sr-only">Saved locations</legend>' + locationsFor().map(location => `<label><input type="radio" name="location-choice" value="${escape(location.id)}" ${location.id === selected ? "checked" : ""}><span><strong>${escape(location.name)}</strong><small>${escape([location.address, location.postcode].filter(Boolean).join(" · ") || "Delivery address not yet added")}</small></span></label>`).join("");
  $("#location-choice-dialog").showModal();
});
$("#more-site-choices").addEventListener("change", updatePlaceButton);
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
  if (!canOrder() || !basket.length || totals(basket).grams < minimumGrams() || $("#order-items input[aria-invalid='true']") || basket.some((line) => (!isAvailable(productFor(line.productId)) || !lineOrderable(line)))) return;
  $("#review-order").disabled = true;
  try {
    const fresh = await api("/api/wholesale/catalogue");
    if (fresh.me.id !== session.me.id) { location.reload(); return; }
    applyCatalogue(fresh, false);
    if (!canOrder() || !basket.length || totals(basket).grams < minimumGrams() || basket.some((line) => (!isAvailable(productFor(line.productId)) || !lineOrderable(line)))) { renderBasket(); toast("Check the updated basket before ordering."); return; }
  } catch (error) { toast(error.message); renderBasket(); return; }
  $("#review-items").innerHTML = basket.map((line) => {
    const product = productFor(line.productId);
    return `<div class="review-line"><div><h3>${escape(product.name)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grindLabel(productFor(line.productId), line.grind))}</p></div>${pricesShown() ? `<strong>${money(unitPrice(product, line.pack) * line.quantity)}</strong>` : ""}</div>`;
  }).join("");
  $("#review-total").textContent = money(totals(basket).pence);
  renderReviewDelivery();
  $("#review-form").reset();
  $("#review-form").elements.delivery.value = basketMethod;
  renderReviewDelivery();
  reviewBusiness(session.customer?.business || "");
  $("#review-form").elements.locationId.value = reorderSite && locationsFor().some(location => location.id === reorderSite) ? reorderSite : session.customer?.defaultLocationId || "primary";
  $("#more-site-choices").replaceChildren();
  renderReviewLocation();
  $("#review-account").hidden = !session.customer;
  $("#review-payment-terms").textContent = session.customer ? `Payment terms: ${session.customer.paymentTerms.label}${session.customer.paymentTerms.note ? " · " + session.customer.paymentTerms.note : ""}` : "";
  requestId = crypto.randomUUID();
  $("#preview-submit-error").hidden = true;
  updateReviewReady();
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
    if (field.type === "radio" || field.type === "checkbox") field.disabled = locked;
    else field.readOnly = locked || (field.name === "business" && !!session.customer);
  }
  $("#review-account").disabled = locked;
  $("#review-location").disabled = locked;
  $("#submit-preview-order").textContent = locked ? "Retry same order" : session?.preview ? "Save preview order" : "Place order";
}
function lockPendingUi() {
  $('#repeat-last-order').disabled = !!pendingAttempt;
  if (!pendingAttempt) return;
  coffeeChoices.close();
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
  basket = []; requestId = null; reviewNeedsRefresh = false; reorderSite = null;
  $("#complete-orders").hidden = true; $("#complete-problem").hidden = true; $("#complete-continue").hidden = true;
  renderBasket(); renderProducts(); filterProducts();
  setRepeatOrder(result.order);
  try { basketChannel?.postMessage({ type: "order-confirmed", identity: attempt.identity, orderId: result.order.id, requestId: attempt.payload.requestId }); } catch {}
  $("#complete-message").textContent = result.preview ? `${result.order.id} was saved as a staff preview order.` : `${result.order.id} has been received by Strangers. Follow its progress in My orders.`;
  if (newerBasketKept) $("#complete-message").textContent += " A newer basket from another tab has been kept for your next order.";
  $("#complete-dashboard-link").hidden = session.me.role !== "admin";
  if (session.me.role === "admin") $("#complete-dashboard-link").href = session.links.admin + "#wholesale";
  $("#complete-total-line").hidden = !pricesShown();
  $("#complete-total").textContent = money(orderTotal(result.order)) + (result.order.deliveryPence ? ` (including ${money(result.order.deliveryPence)} delivery)` : "");
  $("#complete-note").hidden = !result.order.customerNote;
  $("#complete-note").textContent = result.order.customerNote ? `Your comments: ${result.order.customerNote}` : "";
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
// Places the same order for each further site, one at a time and each with its own saved attempt, so an
// interrupted submission is recovered exactly like a single order (and the rest can be placed afterwards).
async function placeForSites(source, sites, done) {
  const left = [...sites];
  let problem = "";
  while (left.length) {
    const site = left.shift(), location = locationsFor().find(item => item.id === site);
    if (!location) { problem = "A site you ticked is no longer on your account, so it wasn't ordered."; continue; }
    saveAttempt({ identity: session.me.id, payload: { ...source.payload, requestId: crypto.randomUUID(), locationId: site }, summary: source.summary,
      deliverySummary: locationSummary(location), locationLabel: location.name, terms: source.terms, more: [...left] });
    if (!pendingAttempt) { problem = `Allow browser storage to place the orders for ${[location.name, ...left.map(id => locationsFor().find(item => item.id === id)?.name)].filter(Boolean).join(", ")}.`; break; }
    try {
      const result = await api("/api/wholesale/orders", pendingAttempt.payload);
      showReceipt(result);
      done.push({ order: result.order, site: location.name });
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 401) { saveAttempt(null); problem = `The order for ${location.name} wasn't placed: ${error.message}${left.length ? " The other sites weren't ordered either." : ""}`; }
      else problem = `We couldn't confirm the order for ${location.name}. Use “Check submitted order” in your basket to check it${left.length ? `; the orders for ${left.map(id => locationsFor().find(item => item.id === id)?.name).filter(Boolean).join(", ")} can be placed after that` : ""}.`;
      break;
    }
  }
  showMultiReceipt(done, problem);
}
function showMultiReceipt(done, problem) {
  if (done.length > 1) {
    $("#complete-message").textContent = `${done.length} orders have been received by Strangers, one for each site. Follow their progress in My orders.`;
    $("#complete-orders").innerHTML = done.map(item => `<li><strong>${escape(item.site || "Your account")}</strong><span>${escape(item.order.id)}${pricesShown() ? ` · ${money(orderTotal(item.order))}` : ""}</span></li>`).join("");
    $("#complete-orders").hidden = false;
    $("#complete-location").hidden = true;
    $("#complete-total").textContent = money(done.reduce((sum, item) => sum + orderTotal(item.order), 0)) + " for all sites";
  }
  $("#complete-problem").textContent = problem;
  $("#complete-problem").hidden = !problem;
}
// After recovering an order that was one of several, offer to place the rest (each still checked by the server).
function offerRemaining(attempt) {
  const rest = (attempt?.more || []).filter(id => locationsFor().some(location => location.id === id));
  if (!rest.length) return;
  const button = $("#complete-continue");
  button.textContent = `Place the same order for ${rest.map(id => locationsFor().find(location => location.id === id).name).join(", ")}`;
  button.hidden = false;
  button.onclick = async () => {
    if (saving || pendingAttempt) return;
    saving = true; button.disabled = true;
    try { await placeForSites(attempt, rest, []); } finally { saving = false; button.disabled = false; button.hidden = true; }
  };
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
  try { const attempt = pendingAttempt, result = await api("/api/wholesale/orders/" + id); showReceipt(result); offerRemaining(attempt); return; }
  catch (error) { if (error.status === 401) return; }
  const attempt = pendingAttempt, form = $("#review-form");
  $("#review-items").innerHTML = attempt.summary.map(line => `<div class="review-line"><div><h3>${escape(line.title)}</h3><p>${escape(line.description)}</p></div>${pricesShown() ? `<strong>${money(line.pence)}</strong>` : ""}</div>`).join("");
  $("#review-total").textContent = money(attempt.payload.lines.reduce((sum,line) => sum + line.price * line.quantity, 0));
  form.elements.delivery.value = attempt.payload.delivery === "Roastery collection" ? "collection" : "dispatch";
  renderReviewDelivery(attempt.summary.reduce((sum, line) => sum + line.pence, 0));
  form.elements.reference.value = attempt.payload.reference;
  form.elements.customerNote.value = attempt.payload.customerNote || "";
  reviewBusiness(attempt.payload.business);
  form.elements.locationId.value = attempt.payload.locationId || "";
  $("#review-location-block").hidden = !session.customer;
  $("#review-location-name").textContent = attempt.locationLabel || "Saved account location";
  $("#review-more-sites").hidden = true;
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
  if (saving || reviewNeedsRefresh || !ready || (!basket.length && !pendingAttempt) || (!pendingAttempt && reviewAddressMissing())) return;
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
    ...(form.elements.customerNote.value.trim() ? { customerNote: form.elements.customerNote.value.trim() } : {}),
    ...(session.customer ? { customerVersion: session.customer.version, locationId: form.elements.locationId.value } : {}),
  }, summary: basket.map(line => ({ title: productFor(line.productId).name, description: `${line.quantity} × ${packs[line.pack].label} · ${grindLabel(productFor(line.productId), line.grind)}`, pence: unitPrice(productFor(line.productId),line.pack) * line.quantity })),
    deliverySummary: $("#delivery-summary").textContent, locationLabel: session.customer ? $("#review-location-name").textContent : "", terms: $("#review-payment-terms").textContent, more: session.customer && !session.preview ? moreSites() : [] });
  if (!pendingAttempt) { saving = false; button.disabled = false; $("#preview-submit-error").textContent = "Allow browser storage before placing an order so an interrupted submission can be recovered safely."; $("#preview-submit-error").hidden = false; return; }
  lockReview(true); lockPendingUi();
  setBasketMethod(pendingAttempt.payload.delivery === "Roastery collection" ? "collection" : "dispatch", true);
  try {
    const attempt = pendingAttempt, result = await api("/api/wholesale/orders", attempt.payload);
    showReceipt(result);
    if (attempt.more?.length) await placeForSites(attempt, attempt.more, [{ order: result.order, site: attempt.locationLabel }]);
  }
  catch (error) {
    // A validated rejection means nothing was saved. Network/5xx/invalid-response failures remain uncertain.
    // Nothing in the basket changed when only the delivery address was missing: the review stays open to fix it there.
    const addressOnly = error.status === 400 && /delivery address and postcode/.test(error.message || "");
    if (error.status >= 400 && error.status < 500 && error.status !== 401) { saveAttempt(null); reviewNeedsRefresh = !addressOnly; lockReview(false); renderProducts(); filterProducts(); renderBasket(); }
    $("#preview-submit-error").textContent = pendingAttempt ? "We couldn’t confirm this order. Retry the same order, or reopen this page to check its status. Your submission has been kept." : error.message;
    $("#preview-submit-error").hidden = false;
  } finally { saving = false; button.disabled = reviewNeedsRefresh; if (!pendingAttempt) updateReviewReady(); }
});

const dialogBusy = (dialog) => (saving && dialog.id === "review-dialog") || (accountSaving && dialog.id === "account-dialog");
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialogBusy(button.closest("dialog")) || button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener('beforetoggle', event => { if (event.newState === 'open') { closeAccountMenu(); closeSortMenu(); coffeeChoices.close(); } });
  dialog.addEventListener("cancel", event => { if (dialogBusy(dialog)) event.preventDefault(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && !dialogBusy(dialog)) dialog.close(); });
  dialog.addEventListener("close", () => {
    if (dialog.id !== "review-dialog") return;
    $("#review-form").reset();
    requestAnimationFrame(() => {
      if (document.querySelector('dialog[open]:not(#basket-dialog)')) return;
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
const minimumGrams = () => Number.isSafeInteger(session?.minimumOrderGrams) ? session.minimumOrderGrams : 0;
function showPaymentTerms() {
  $("#account-payment-terms").textContent = session.customer?.paymentTerms.label || "";
  $("#account-payment-note").textContent = session.customer?.paymentTerms.note || "";
}
function renderAccountIdentity() {
  const business = session?.customer?.business || session?.me.name || '';
  const contact = (session?.customer ? session.customer.contact : session?.me.name)?.trim();
  const greeting = session ? (contact ? `Hi, ${contact}` : 'Hi') : '';
  $('#signed-in-name').textContent = business;
  if (business) $('#signed-in-name').title = business;
  else $('#signed-in-name').removeAttribute('title');
  $('#account-greeting').textContent = greeting || 'Account';
  $('#account-menu-greeting').textContent = greeting || 'Hi';
  $('#account-toggle').setAttribute('aria-label', greeting ? `${greeting}. Account menu` : 'Account menu');
}
function applyCatalogue(fresh, initial) {
  session = fresh;
  document.body.classList.toggle("hide-prices", !pricesShown());
  if (!pricesShown() && currentSort !== "catalogue") { currentSort = "catalogue"; sortMenu.querySelectorAll("[data-sort]").forEach(button => button.setAttribute("aria-checked", String(button.dataset.sort === "catalogue"))); }
  setCatalogue(session.products);
  if (initial) {
    STORAGE_KEY = "strangers.wholesale-preview.v2." + session.me.id;
    basket = loadBasket();
    pendingAttempt = readAttempt();
    if (pendingAttempt) basket = sanitiseBasket(pendingAttempt.payload.lines);
  } else { basket = sanitiseBasket(basket); saveBasket(); }
  renderAccountIdentity();
  $("#preview-home").href = session.links.preview;
  $("#admin-wholesale-link").hidden = session.me.role !== "admin";
  if (session.me.role === "admin") $("#admin-wholesale-link").href = session.links.admin + "#wholesale";
  $("#my-account").hidden = !session.customer;
  applyInvoiceSwitch();
  $("#staff-preview-notice").hidden = !session.preview;
  $("#submit-preview-order").textContent = session.preview ? "Save preview order" : "Place order";
  $("#account-hold").hidden = canOrder();
  showPaymentTerms();
  showAnnouncement();
  ready = true;
  renderProducts(); filterProducts(); renderBasket();
  if (pendingAttempt) toast("An order is awaiting confirmation. Choose Check submitted order.");
}
async function start() {
  if (catalogueLoading) return;
  catalogueLoading = true; $("#products").setAttribute("aria-busy", "true");
  $("#retry-catalogue").hidden = true;
  $("#catalogue-status").hidden = false;
  $("#catalogue-status").replaceChildren(SC.skeleton({ kind: "products", rows: 2, label: "Loading your coffee…" }));
  try {
    if (!await SC.startSession({scope:"wholesale",clear:clearOrderingSession})) return;
    applyCatalogue(await api("/api/wholesale/catalogue"), true);
    $("#catalogue-status").hidden = true; SC.reveal($("#products"));
    loadRepeatOrder();
    // The order confirmation email's "See your orders" link (…/#orders) opens My orders once the page is ready.
    if (location.hash === "#orders") { window.history.replaceState(null, "", location.pathname + location.search); document.querySelector("[data-order-history]")?.click(); }
  } catch (error) {
    $("#catalogue-status").textContent = error.message;
    $("#retry-catalogue").hidden = false;
  } finally { catalogueLoading = false; $("#products").setAttribute("aria-busy", "false"); }
}
$("#preview-sign-out").addEventListener("click", async () => {
  closeAccountMenu();
  if (session?.me.role !== "wholesale") return SC.signOut();
  try { await api("/api/wholesale/auth/logout", {}); goSignIn(); }
  catch (error) { toast(error.message); }
});
$("#retry-catalogue").addEventListener("click", start);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  // Shared session verification shields the restored page before proving its owner. Keep its
  // dialog open: reloading here races the guard's sign-in navigation after a session expires.
  document.querySelectorAll("dialog[open]:not(#sc-session-shield)").forEach(dialog => dialog.close());
  closeSortMenu(); closeAccountMenu();
});

async function openAccount() {
  closeAccountMenu();
  try {
    const current = await api("/api/wholesale/session");
    if (current.me.id !== session.me.id) { location.reload(); return; }
    session.customer = current.customer;
    renderAccountIdentity();
    if (!session.customer) return;
    showPaymentTerms();
    for (const key of ["contact", "email", "accountsEmail", "phone", "address", "postcode", "deliveryNotes"]) $("#account-form").elements[key].value = session.customer[key] || "";
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
    const fields = Object.fromEntries(["contact", "email", "accountsEmail", "phone", "address", "postcode", "deliveryNotes"].map((key) => [key, form.elements[key].value]));
    const locations = accountLocations.map(location => ({ ...(location.id ? { id: location.id } : {}), ...Object.fromEntries(LOCATION_FIELDS.map(key => [key, location[key] || ""])) }));
    const result = await api("/api/wholesale/account", { ...fields, locations, defaultLocationId: accountDefaultLocation, ifVersion: session.customer.version, orderingIdentity: session.me.id }, "PUT");
    session.customer = result.customer;
    showPaymentTerms();
    renderAccountIdentity();
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
// Set by Strangers in Admin: the day the order is due to go out, its standing order schedule, and whether its bags were
// changed after it was placed (the lines shown are the current ones).
function historySchedule(order) {
  const parts = [];
  if (typeof order.dispatchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(order.dispatchDate)) parts.push(`Dispatch day: ${escape(new Date(order.dispatchDate + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }))}`);
  const every = order.standing?.every;
  if ([1, 2, 4, "month"].includes(every)) parts.push(`Standing order, ${every === "month" ? "every month" : every === 1 ? "every week" : `every ${every} weeks`}`);
  const on = (at) => escape(new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" }));
  const once = Array.isArray(order.repeatLines) && order.repeatLines.length ? " This delivery only: the next one goes back to your usual bags." : "";
  const amended = Number.isSafeInteger(order.amendedAt) ? `<p class="history-amended">${order.amendedByCustomer ? "You changed the bags" : "Updated by Strangers"} on ${on(order.amendedAt)}. The bags below are the updated order.${once}</p>` : "";
  return (parts.length ? `<p class="history-schedule">${parts.join(" · ")}</p>` : "") + amended;
}
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
  if (status === "Cancelled" && order.skipped) return `<span class="order-state status-cancelled">Skipped</span><p class="history-cancelled">${order.skipped.customer ? "You skipped this delivery." : "Strangers skipped this delivery."} Your standing order carries on with the next one.</p>`;
  if (status === "Cancelled") return `${badge}<p class="history-cancelled">This order was cancelled. No further preparation updates are expected.</p>`;
  return `<div class="history-status">${badge}<p>${descriptions[status] || "Contact Strangers for an update."}</p></div>${current >= 0 ? `<ol class="history-progress" aria-label="Order progress">${states.map((step, i) => `<li ${i < current ? 'class="done"' : ""} ${i === current ? 'aria-current="step"' : ""}><span class="progress-marker" aria-hidden="true">${i < current ? "✓" : i + 1}</span><span>${step === "New" ? "Received" : step}<span class="sr-only">${i < current ? ", completed" : i === current ? ", current stage" : ", not reached"}</span></span></li>`).join("")}</ol>` : ""}`;
}
function historyTrackingUrl(order) {
  if (!session?.customer || order.preview || order.status !== "Dispatched" || !isWholesaleDelivery(order.delivery)) return "";
  const value = typeof order.trackingUrl === "string" ? order.trackingUrl.trim() : "";
  if (!value || value.length > 2000 || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
// The delivery line in the review: worked out exactly as the server will charge it (shipping.js).
function renderReviewDelivery(coffeePence = totals(basket).pence) {
  const delivery = $("#review-form").elements.delivery.value === "collection" ? "Roastery collection" : "Delivery";
  const charge = deliveryCharge(delivery, coffeePence);
  $("#review-delivery-label").textContent = delivery === "Delivery" ? "Delivery" : "Roastery collection";
  $("#review-delivery").textContent = charge ? money(charge) : "Free";
  $("#review-grand").textContent = money(coffeePence + charge);
  $("#review-delivery-note").textContent = !pricesShown() ? "" : delivery !== "Delivery" ? "No delivery charge when you collect from the roastery."
    : freeDelivery() ? "Delivery is free for your account."
    : charge ? `Delivery is ${money(SHIPPING_PENCE)} including VAT. Orders of ${money(FREE_SHIPPING_FROM_PENCE)} or more of coffee are delivered free: add ${money(FREE_SHIPPING_FROM_PENCE - coffeePence)} more.`
    : `Free delivery on orders of ${money(FREE_SHIPPING_FROM_PENCE)} or more of coffee.`;
}
const orderTotal = (order) => Number.isSafeInteger(order.totalPence) ? order.totalPence : order.pence;
function historyCard(order, expanded) {
  const date = new Date(order.createdAt).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" });
  const snapshot = order.locationSnapshot || order.customerSnapshot;
  const isDelivery = isWholesaleDelivery(order.delivery);
  const trackingUrl = historyTrackingUrl(order);
  const deliveryReason = order.deliveryPence ? "Including VAT"
    : !isDelivery ? "No delivery charge"
    : order.freeDelivery ? "Free delivery for this account"
    : `Free on orders of ${money(FREE_SHIPPING_FROM_PENCE)} or more`;
  return `<article class="history-card" data-history-order="${escape(order.id)}"><div class="history-card-head"><h3>${date}</h3>${pricesShown() ? `<strong>${money(orderTotal(order))}</strong>` : ""}</div><p class="history-summary">${bagCount(order.packs)} · ${escape(order.delivery)}</p>${order.reference ? `<p class="history-summary">Reference: ${escape(order.reference)}</p>` : ""}${historySchedule(order)}${historyStatus(order)}${order.standingIssue ? `<p class="standing-hint">Your next standing delivery needs a check from Strangers. Please contact us before expecting the next delivery.</p>` : ""}
    ${trackingUrl ? `<a class="button button-outline history-tracking" data-order-tracking="${escape(order.id)}" href="${escape(trackingUrl)}" target="_blank" rel="noopener noreferrer">Track delivery <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg><span class="sr-only">(opens in a new tab)</span></a>` : ""}
    <details class="history-details" ${expanded.has(order.id) ? "open" : ""}><summary>Order details · ${bagCount(order.packs)}</summary><p class="history-id">${escape(order.id)}</p><ul class="history-lines">${order.lines.map(line => `<li><span>${line.quantity} × ${escape(line.title)}</span><small>${escape(line.packLabel)} · ${escape(line.grindLabel)}</small>${pricesShown() ? `<strong>${money(line.price * line.quantity)}</strong>` : ""}</li>`).join("")}${Number.isSafeInteger(order.deliveryPence) && pricesShown() ? `<li><span>${isDelivery ? "Delivery" : "Roastery collection"}</span><small>${deliveryReason}</small><strong>${order.deliveryPence ? money(order.deliveryPence) : "Free"}</strong></li>` : ""}</ul>${order.customerNote ? `<p class="history-address"><b>Your comments</b><br>${escape(order.customerNote)}</p>` : ""}${order.locationSnapshot ? `<p class="history-address"><b>Location at order</b><br>${escape(order.locationSnapshot.name)}</p>` : ""}${snapshot?.address && isDelivery ? `<p class="history-address"><b>Delivery address at order</b><br>${escape(snapshot.address)}<br>${escape(snapshot.postcode || "")}</p>` : ""}${order.deliveryNotes ? `<p class="history-address">${escape(order.deliveryNotes)}</p>` : ""}${order.paymentTerms ? `<p class="payment-terms">Payment terms: ${escape(order.paymentTerms.label)}${order.paymentTerms.note ? `<br>${escape(order.paymentTerms.note)}` : ""}</p>` : ""}</details>
    ${standingChangeable(order) ? `<div class="standing-actions"><button class="button button-dark" type="button" data-standing-change="${escape(order.id)}">Change bags</button><button class="button button-outline" type="button" data-standing-skip="${escape(order.id)}">Skip this delivery</button></div><p class="standing-hint">You can change or skip this delivery until it's dispatched.</p>` : ""}
    <button class="button button-outline history-reorder" type="button" data-reorder="${escape(order.id)}" ${pendingAttempt ? "disabled" : ""}>Order again</button></article>`;
}
let historyCursor = null;
let historyTotal = 0;
let historyLoading = false;
async function loadOrders(append = false) {
  if (historyLoading) return;
  historyLoading = true;
  const expanded = new Set([...document.querySelectorAll('[data-history-order]:has(details[open])')].map(node => node.dataset.historyOrder));
  if (!append) { history = []; historyCursor = null; historyTotal = 0; $("#order-history").replaceChildren(SC.skeleton({ label: "Loading your orders…" })); $("#history-more").hidden = true; }
  $("#history-count").textContent = append ? "Loading earlier orders…" : "Loading orders…";
  $("#order-history").setAttribute("aria-busy", "true");
  refreshBusy("#refresh-orders", true); $("#history-more").disabled = true;
  try {
    if (!await confirmIdentity()) return;
    const result = await api("/api/wholesale/orders" + (append && historyCursor ? "?cursor=" + encodeURIComponent(historyCursor) : ""));
    history = append ? [...new Map([...history, ...result.orders].map(order => [order.id, order])).values()] : result.orders;
    historyTotal = Number.isSafeInteger(result.count) ? result.count : history.length;
    historyCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    $("#order-history").innerHTML = history.length ? history.map(order => historyCard(order, expanded)).join("") : '<div class="history-empty"><h3>No orders yet</h3><p>Your orders will appear here once you place one. You can then track progress or order again.</p></div>';
    $("#history-count").textContent = historyTotal ? `Showing ${history.length} of ${historyTotal} ${historyTotal === 1 ? "order" : "orders"}` : "";
    $("#history-more").hidden = !historyCursor;
  } catch (error) { if (!append) $("#order-history").textContent = error.message; $("#history-count").textContent = append ? "Couldn’t load earlier orders. Try again." : ""; }
  finally { historyLoading = false; $("#order-history").setAttribute("aria-busy", "false"); refreshBusy("#refresh-orders", false); $("#history-more").disabled = false; }
}
// Admin can switch invoices off for customers: then My orders has no Invoices tab, balance note or invoice loading.
const invoicesShown = () => !!session?.customer && session.invoices !== false;
function applyInvoiceSwitch() {
  const shown = invoicesShown();
  $("#history-invoices").hidden = !shown;
  document.querySelector(".history-sections").hidden = !shown;
  if (!shown) { $("#history-invoice-note").hidden = true; if (!$("#invoices-panel").hidden) showHistorySection("orders"); }
}
async function refreshInvoiceSwitch() {
  try {
    const current = await api("/api/wholesale/session");
    if (current.me.id !== session.me.id) { location.reload(); return; }
    session.invoices = current.invoices; applyInvoiceSwitch();
  } catch {}
  if (invoicesShown()) loadInvoices();
}
function showHistorySection(section) {
  const invoices = section === "invoices" && invoicesShown();
  $("#orders-panel").hidden = invoices; $("#invoices-panel").hidden = !invoices;
  $("#history-orders").setAttribute("aria-pressed", String(!invoices)); $("#history-invoices").setAttribute("aria-pressed", String(invoices));
  $("#orders-title").textContent = invoices ? "Invoices" : "Order history";
  $("#orders-body").scrollTop = 0;
}
document.querySelectorAll("#my-orders,[data-order-history]").forEach(button => button.addEventListener("click", () => {
  closeAccountMenu(); showHistorySection("orders"); $("#orders-dialog").showModal(); loadOrders();
  if (session.customer) refreshInvoiceSwitch();
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
    if (!lineOrderable(line)) { skipped.push({ title: line.title, quantity: line.quantity, reason: !Object.hasOwn(packs, line.pack) ? `${line.packLabel || "this size"}s are no longer sold` : !packsFor(productFor(line.productId)).some(([id]) => id === line.pack) ? `now sold in ${packs[packsFor(productFor(line.productId))[0][0]].label}s only` : "grind no longer offered" }); continue; }
    if (!isAvailable(product)) { skipped.push({ title: line.title, quantity: line.quantity, reason: product?.active === false || !product ? "no longer offered" : "out of stock" }); continue; }
    const result = addToBasket(next, line, line.quantity);
    next = result.basket;
    if (result.added) additions.push({ productId: line.productId, pack: line.pack, grind: line.grind, quantity: result.added, title: product.name, price: unitPrice(product, line.pack) });
    if (result.added < line.quantity) skipped.push({ title: line.title, quantity: line.quantity - result.added, reason: `basket limit of ${MAX_QUANTITY} bags for this size and grind` });
  }
  const added = totals(additions), combined = totals(next), existing = totals(basket);
  const signature = JSON.stringify({ identity: session.me.id, additions, skipped, next, combined });
  return { order, identity: session.me.id, additions, skipped, next, added, combined, existing, signature };
}
function renderReorderPlan(plan) {
  reorderPlan = plan;
  $("#reorder-summary").textContent = pricesShown() ? `${bagCount(plan.added.packs)} available to add · ${money(plan.added.pence)} at current prices.` : `${bagCount(plan.added.packs)} available to add.`;
  $("#reorder-items").innerHTML = plan.additions.map(line => `<div class="review-line"><div><h3>${escape(line.title)}</h3><p>${line.quantity} × ${escape(packs[line.pack].label)} · ${escape(grindLabel(productFor(line.productId), line.grind))}</p></div>${pricesShown() ? `<strong>${money(line.price * line.quantity)}</strong>` : ""}</div>`).join("");
  $("#reorder-skipped").hidden = !plan.skipped.length;
  $("#reorder-skipped-items").innerHTML = plan.skipped.map(line => `<li>${bagCount(line.quantity)} of ${escape(line.title)} — ${escape(line.reason)}.</li>`).join("");
  $("#reorder-existing").textContent = plan.existing.packs ? `Your current ${bagCount(plan.existing.packs)} will stay in the basket. Matching sizes and grinds merge. After adding: ${bagCount(plan.combined.packs)}${pricesShown() ? ` · ${money(plan.combined.pence)} coffee subtotal` : ""}.` : `This builds a basket for you to review.${pricesShown() ? ` Coffee subtotal: ${money(plan.added.pence)}.` : ""} It does not place an order.`;
  $("#confirm-reorder").textContent = plan.added.packs ? `Add ${bagCount(plan.added.packs)} to basket` : "No available bags to add";
  $("#confirm-reorder").disabled = !plan.added.packs;
  $("#reorder-error").hidden = true;
}
async function reviewReorder(order, button) {
  if (!order || !button || !ready || reordering) return;
  if (pendingAttempt) { toast("Check your submitted order before building another basket."); return; }
  reordering = true; button.disabled = true;
  try {
    const fresh = await api("/api/wholesale/catalogue");
    if (fresh.me.id !== session.me.id) { location.reload(); return; }
    if (!ready || pendingAttempt) return;
    applyCatalogue(fresh, false);
    renderReorderPlan(buildReorderPlan(order));
    if ($("#orders-dialog").open) $("#orders-dialog").close();
    $("#reorder-dialog").showModal();
  } catch (error) { toast(error.message); }
  finally { reordering = false; if (button.isConnected) button.disabled = !!pendingAttempt; }
}
$("#order-history").addEventListener('click', event => {
  const button = event.target.closest('[data-reorder]');
  if (button) reviewReorder(history.find(order => order.id === button.dataset.reorder), button);
  const change = event.target.closest('[data-standing-change]'), skip = event.target.closest('[data-standing-skip]');
  if (change) openStanding(history.find(order => order.id === change.dataset.standingChange), "change");
  if (skip) openStanding(history.find(order => order.id === skip.dataset.standingSkip), "skip");
});

// A delivery of the customer's own standing order can be changed or skipped while it's New (before Strangers starts
// preparing it): the server checks the same, and the minimum order still applies to changed bags.
const standingChangeable = (order) => !!session?.customer && !!order?.standing && ["New", "Preparing", "Ready"].includes(order.status) && !order.preview;
const standingDay = (order) => /^\d{4}-\d{2}-\d{2}$/.test(order?.dispatchDate || "") ? new Date(order.dispatchDate + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : "";
let standing = null; // { order, lines, mode, busy }
function openStanding(order, mode) {
  if (!standingChangeable(order)) return;
  standing = { order, mode, busy: false, lines: order.lines.map(l => ({ productId: l.productId, pack: l.pack, grind: l.grind, quantity: l.quantity, title: l.title, packLabel: l.packLabel, grindLabel: l.grindLabel, price: l.price, grams: l.grams })) };
  const day = standingDay(order);
  $("#standing-title").textContent = mode === "skip" ? "Skip this delivery?" : "Change this delivery";
  $("#standing-summary").textContent = mode === "skip"
    ? `Nothing will be sent${day ? ` on ${day}` : ""}. Your standing order carries on with the delivery after it, with your usual bags.`
    : `${day ? `Dispatch day: ${day}. ` : ""}Change how many bags or remove a coffee by setting its quantity to 0.`;
  $("#standing-form").hidden = mode === "skip"; $("#standing-skip").hidden = mode !== "skip";
  $("#standing-error").hidden = true; $("#standing-skip-error").hidden = true;
  $("#standing-form").elements.scope.value = "once";
  if (mode === "change") { fillStandingCoffees(); drawStanding(); }
  if ($("#orders-dialog").open) $("#orders-dialog").close();
  $("#standing-dialog").showModal();
}
function fillStandingCoffees() {
  const choices = products.filter(isAvailable);
  $("#standing-coffee").innerHTML = choices.map(p => `<option value="${escape(p.id)}">${escape(p.title)}${p.yours ? " (your coffee)" : ""}</option>`).join("");
  fillStandingOptions();
}
function fillStandingOptions() {
  const product = productFor($("#standing-coffee").value);
  const available = isAvailable(product);
  $("#standing-add-options").disabled = !available;
  $("#standing-add-unavailable").hidden = available;
  $("#standing-pack").innerHTML = !available ? "" : packsFor(product).map(([id, pack]) => `<option value="${id}">${escape(pack.short)}${pricesShown() ? ` · ${money(unitPrice(product, id))}` : ""}</option>`).join("");
  $("#standing-grind").innerHTML = !available ? "" : availableGrinds(product).map(g => `<option value="${escape(g.id)}">${escape(g.label)}</option>`).join("");
}
function standingSums() {
  let grams = 0, pence = 0, bags = 0;
  for (const l of standing.lines) { grams += (l.grams ?? packs[l.pack]?.grams ?? 0) * l.quantity; pence += (l.price || 0) * l.quantity; bags += l.quantity; }
  return { grams, pence, bags };
}
function standingQuantityLimit(line) {
  if (isAvailable(productFor(line.productId)) && lineOrderable(line)) return MAX_QUANTITY;
  return standing.order.lines.find((original) => lineKey(original) === lineKey(line))?.quantity ?? 0;
}
function drawStanding() {
  $("#standing-lines").innerHTML = standing.lines.map((l, i) => `<div class="standing-line"><span><b>${escape(l.title)}</b><small>${escape(l.packLabel)} · ${escape(l.grindLabel)}${pricesShown() && l.price ? ` · ${money(l.price)} each` : ""}</small></span><label><span class="sr-only">Bags of ${escape(l.title)}, ${escape(l.packLabel)}, ${escape(l.grindLabel)}</span><input type="number" inputmode="numeric" min="0" max="${standingQuantityLimit(l)}" step="1" value="${l.quantity}" data-standing-line="${i}"></label></div>`).join("") || '<p class="standing-empty">No bags yet: add a coffee below.</p>';
  drawStandingTotals();
}
function drawStandingTotals() {
  const { grams, pence, bags } = standingSums(), min = minimumGrams();
  const short = min && grams < min;
  $("#standing-total").innerHTML = `${bagCount(bags)} · ${escape(weight(grams))}${pricesShown() ? ` · ${money(pence)} of coffee` : ""}${short ? `<br><span class="standing-short">The minimum order is ${escape(weight(min))}.${$("#standing-add-options").disabled ? "" : ` Add ${escape(weight(min - grams))} more.`}</span>` : ""}`;
  $("#standing-save").disabled = standing.busy || !bags || !!short;
}
$("#standing-coffee").addEventListener("change", fillStandingOptions);
$("#standing-lines").addEventListener("input", (event) => {
  const input = event.target.closest("[data-standing-line]"); if (!input || !standing) return;
  const line = standing.lines[Number(input.dataset.standingLine)];
  line.quantity = Math.max(0, Math.min(standingQuantityLimit(line), Math.floor(Number(input.value) || 0)));
  if (input.value && Number(input.value) !== line.quantity) input.value = String(line.quantity);
  drawStandingTotals();
});
$("#standing-add").addEventListener("click", () => {
  const product = productFor($("#standing-coffee").value); if (!isAvailable(product) || !standing) return;
  const line = { productId: product.id, pack: $("#standing-pack").value, grind: $("#standing-grind").value };
  const same = standing.lines.find(l => lineKey(l) === lineKey(line));
  if (same) same.quantity = Math.min(MAX_QUANTITY, same.quantity + 1);
  else standing.lines.push({ ...line, quantity: 1, title: product.title, packLabel: packs[line.pack].label, grindLabel: grindLabel(product, line.grind), price: unitPrice(product, line.pack) });
  drawStanding();
  document.querySelector(`[data-standing-line="${standing.lines.findIndex(l => lineKey(l) === lineKey(line))}"]`)?.focus();
});
$("#standing-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!standing || standing.busy) return;
  const lines = standing.lines.filter(l => l.quantity > 0).map(({ productId, pack, grind, quantity }) => ({ productId, pack, grind, quantity }));
  standing.busy = true; drawStanding(); $("#standing-error").hidden = true;
  try {
    await api(`/api/wholesale/orders/${encodeURIComponent(standing.order.id)}/lines`, { ifVersion: standing.order.version, lines, scope: $("#standing-form").elements.scope.value }, "PUT");
    const once = $("#standing-form").elements.scope.value === "once";
    standing = null; $("#standing-dialog").close();
    toast(once ? "Saved: this delivery only." : "Saved: these are now your usual bags.");
    await openOrdersAgain();
  } catch (error) {
    if (!standing) return;
    standing.busy = false; drawStanding();
    $("#standing-error").textContent = error.code === "conflict" ? "This delivery was changed somewhere else. Close this and open it again to see the latest." : error.message;
    $("#standing-error").hidden = false;
  }
});
$("#standing-skip-confirm").addEventListener("click", async () => {
  if (!standing || standing.busy) return;
  standing.busy = true; $("#standing-skip-confirm").disabled = true; $("#standing-skip-error").hidden = true;
  try {
    await api(`/api/wholesale/orders/${encodeURIComponent(standing.order.id)}/skip`, { ifVersion: standing.order.version });
    standing = null; $("#standing-dialog").close(); toast("Delivery skipped.");
    await openOrdersAgain();
  } catch (error) {
    if (standing) standing.busy = false;
    $("#standing-skip-error").textContent = error.message; $("#standing-skip-error").hidden = false;
  } finally { $("#standing-skip-confirm").disabled = false; }
});
$("#standing-dialog").addEventListener("close", () => { if (standing && !standing.busy) standing = null; });
async function openOrdersAgain() {
  if (!$("#orders-dialog").open) $("#orders-dialog").showModal();
  await loadOrders();
}
function setRepeatOrder(order) {
  repeatOrder = order || null;
  $('#repeat-shortcut').hidden = !repeatOrder;
  if (!repeatOrder) return;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(new Date(order.createdAt));
  $('#repeat-summary').textContent = `${bagCount(order.packs)} · ${date}`;
  $('#repeat-last-order').disabled = !!pendingAttempt;
}
async function loadRepeatOrder() {
  const identity = session?.me.id;
  try {
    const result = await api('/api/wholesale/orders');
    if (!ready || !identity || session?.me.id !== identity) return;
    const latest = result.orders.filter(order => order.status !== 'Cancelled').sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!repeatOrder || (latest && latest.createdAt >= repeatOrder.createdAt)) setRepeatOrder(latest);
  } catch { /* A shortcut failure never blocks the catalogue or checkout. */ }
}
$('#repeat-last-order').addEventListener('click', event => reviewReorder(repeatOrder, event.currentTarget));
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
    reorderSite = typeof reviewed.order.locationId === "string" ? reviewed.order.locationId : null;
    $("#reorder-dialog").close(); reorderPlan = null;
    toast(`${bagCount(current.added.packs)} added at current prices. Review your basket before placing the order.`);
    openBasket();
    $("#your-order").focus({ preventScroll: true });
  } catch (error) { $("#reorder-error").textContent = error.message; $("#reorder-error").hidden = false; }
  finally { reordering = false; $("#confirm-reorder").disabled = !reorderPlan?.added.packs; }
});
// Reuse the same nodes at each breakpoint so drafts and selections survive resizing.
const mobileHeaderQuery = matchMedia('(max-width:700px)');
const catalogueActions = $('.catalogue-actions'), mobileCatalogueActions = $('.mobile-catalogue-actions');
const bagSizeControl = $('.bag-size'), coffeeSearch = $('#catalogue-search'), coffeeCategories = $('.coffee-categories');
function configureCatalogue() {
  const focused = document.activeElement;
  if (mobileHeaderQuery.matches) {
    mobileCatalogueActions.append(bagSizeControl, sortButton);
    coffeeCategories.before(coffeeSearch);
    $('.section-heading').before($('#repeat-shortcut'));
  } else {
    catalogueActions.append(coffeeSearch, bagSizeControl, sortButton);
    $('.section-heading').append($('#repeat-shortcut'));
  }
  catalogueSearch.sync();
  if (focused === $('#coffee-search') && !document.documentElement.hasAttribute('data-sc-session-locked')) catalogueSearch.open();
  if (sortMenu.matches(':popover-open')) positionSortMenu();
}
mobileHeaderQuery.addEventListener('change', configureCatalogue); configureCatalogue();

const headerAccount = $('#wholesale-account'), accountToggle = $('#account-toggle');
function closeAccountMenu() { if (headerAccount.matches(':popover-open')) headerAccount.hidePopover(); }
function positionAccountMenu() {
  const rect = accountToggle.getBoundingClientRect(), width = Math.min(312, innerWidth - 24);
  const top = Math.max(8, rect.bottom + 10);
  headerAccount.style.width = width + 'px';
  headerAccount.style.left = Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)) + 'px';
  headerAccount.style.top = top + 'px';
  headerAccount.style.maxHeight = Math.max(44, innerHeight - top - 12) + 'px';
}
headerAccount.addEventListener('beforetoggle', event => {
  const opening = event.newState === 'open';
  if (opening && (!ready || document.documentElement.hasAttribute('data-sc-session-locked'))) { event.preventDefault(); return; }
  accountToggle.setAttribute('aria-expanded', String(opening));
  if (opening) { coffeeChoices.close(); closeSortMenu(); positionAccountMenu(); }
});
headerAccount.addEventListener('toggle', event => {
  if (event.newState === 'open' && ready && !document.documentElement.hasAttribute('data-sc-session-locked') && headerAccount.matches(':popover-open')) headerAccount.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
});
accountToggle.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); headerAccount.showPopover(); } });
headerAccount.addEventListener('keydown', event => {
  const items = [...headerAccount.querySelectorAll('button,a')].filter(node => !node.hidden), i = items.indexOf(document.activeElement);
  const n = event.key === 'ArrowDown' ? (i + 1) % items.length : event.key === 'ArrowUp' ? (i + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
  if (n !== null) { event.preventDefault(); items[n]?.focus(); }
});
window.addEventListener('resize', () => { if (headerAccount.matches(':popover-open')) positionAccountMenu(); }, { passive: true });
window.addEventListener('scroll', () => { if (headerAccount.matches(':popover-open')) positionAccountMenu(); }, { passive: true });
window.addEventListener('blur', closeAccountMenu); window.addEventListener('pagehide', closeAccountMenu);
for (const id of ['#account-dialog', '#orders-dialog']) $(id).addEventListener('close', () => {
  if (ready && !document.documentElement.hasAttribute('data-sc-session-locked') && !document.querySelector('dialog[open]')) accountToggle.focus({ preventScroll: true });
});
function openBasket() {
  if (!ready || document.documentElement.hasAttribute('data-sc-session-locked')) return;
  closeAccountMenu(); coffeeChoices.close(); closeSortMenu();
  if (!$('#basket-dialog').open) $('#basket-dialog').showModal();
  $('#your-order').focus({ preventScroll: true });
}
$('#basket-dialog').addEventListener('close', () => {
  if (ready && !document.documentElement.hasAttribute('data-sc-session-locked') && !document.querySelector('dialog[open]')) $('.site-header [data-basket]').focus({ preventScroll: true });
});

if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => { orderVisible = entry.isIntersecting; updateMobileBasket(); }, { threshold: 0 }).observe($("#your-order"));
}
// The announcement Strangers sets in Admin (Christmas dispatch dates and the like). Closing it hides that message on
// this device until a new one is saved (its key changes).
const ANNOUNCEMENT_KEY = "sc.wholesale.announcement.closed";
function showAnnouncement() {
  const a = session?.announcement, bar = $("#announcement");
  let closed = null; try { closed = localStorage.getItem(ANNOUNCEMENT_KEY); } catch {}
  if (!a || closed === a.key) { bar.hidden = true; return; }
  $("#announcement-title").textContent = a.title || "";
  $("#announcement-title").hidden = !a.title;
  $("#announcement-message").textContent = a.message;
  bar.classList.toggle("important", a.tone === "important");
  bar.hidden = false;
}
$("#announcement-close").addEventListener("click", () => {
  const key = session?.announcement?.key;
  try { if (key) localStorage.setItem(ANNOUNCEMENT_KEY, key); } catch {}
  $("#announcement").hidden = true;
});
function clearOrderingSession() {
  $("#basket-count").getAnimations?.().forEach(animation => animation.cancel());
  coffeeChoices.clear(); catalogueSearch.close({ clear: true }); closeAccountMenu();
  repeatOrder = null; $('#repeat-shortcut').hidden = true; $('#repeat-summary').replaceChildren();
  for (const timer of addedTimers.values()) clearTimeout(timer); addedTimers.clear();
  ready = false; session = null; basket = []; history = []; pendingAttempt = null; $("#announcement").hidden = true;
  accountLocations = []; customerInvoices = []; STORAGE_KEY = null;
  setCatalogue([]); photoIndexes.clear();
  for (const id of ["#products","#order-items","#review-items","#order-history","#customer-invoices-list","#customer-invoice-summary","#history-invoice-note","#account-locations","#signed-in-name","#account-business","#account-payment-terms","#account-payment-note","#review-business","#review-location-name","#delivery-summary","#review-payment-terms","#review-total","#review-grand","#complete-message","#complete-total","#complete-note","#complete-location","#complete-payment-terms","#reorder-items","#reorder-skipped-items","#reorder-summary","#reorder-existing","#location-choices","#location-remove-summary","#grind-product-name",".grind-choices"]) $(id)?.replaceChildren();
  renderAccountIdentity();
  document.querySelectorAll("form").forEach(form=>form.reset());
}
SC.recheckOnPageshow(goSignIn);
start();


// Issued invoices remain available in My orders even after their source order is removed.
let customerInvoices = [], invoiceCursor = null, invoiceTotal = 0, invoiceLoading = false;
function customerInvoiceCard(invoice, expanded) {
  const review = invoice.accounting?.status === "review", paid = !!invoice.payment?.paid, overdue = !paid && invoice.payment?.status === "overdue", partial = invoice.payment?.status === "part-paid";
  const voided = invoice.payment?.status === "voided", settled = invoice.payment?.status === "settled";
  const changed = !!invoice.accounting?.invoiceChanged;
  const label = voided ? "Voided" : review ? "Balance unconfirmed" : settled ? "No payment due" : paid ? "Paid" : partial ? "Part paid" : overdue ? "Overdue" : "Unpaid";
  const date = value => value ? new Date(value + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }) : "Not set";
  const href = "/api/wholesale/invoices/" + encodeURIComponent(invoice.id) + "/pdf";
  const checked = invoice.payment.checkedAt ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(invoice.payment.checkedAt)) : "";
  const dueDate = invoice.payment.dueDate ?? invoice.dueDate;
  const due = voided ? "Voided in QuickBooks" : review ? "Contact Strangers to confirm the current balance" : settled ? "Settled in QuickBooks" : paid ? (invoice.payment.paidDate ? "Paid " + date(invoice.payment.paidDate) : "£0.00 due") : dueDate ? "Due " + date(dueDate) : "Payment due under the agreed terms";
  return `<article class="customer-invoice-card" data-customer-invoice="${escape(invoice.id)}" aria-labelledby="customer-invoice-${escape(invoice.id)}">
    <div class="invoice-card-head"><div><h3 id="customer-invoice-${escape(invoice.id)}">${escape(invoice.number)}</h3>
      <p class="invoice-card-date">${escape(date(invoice.invoiceDate))}${invoice.deliveryLocation?.name ? " · " + escape(invoice.deliveryLocation.name) : ""}</p></div>
      <div class="invoice-card-total"><strong>${voided || settled ? money(0) + " due" : money(invoice.payment.totalPence ?? invoice.totals.grossPence)}</strong>${voided || settled ? "" : "<span>Invoice total</span>"}</div>
    </div>
    <div class="invoice-status-line"><span class="invoice-state ${voided || settled ? "voided" : review ? "review" : paid ? "paid" : overdue ? "overdue" : "unpaid"}">${label}</span>${!voided && invoice.payment.hasVoidedPayment ? '<span class="invoice-state review">Payment voided</span>' : ""}<span>${escape(due)}</span></div>
    ${!review && invoice.payment.outstandingPence > 0 ? `<p class="invoice-balance">${partial ? "Remaining balance" : "Outstanding"} <strong>${money(invoice.payment.outstandingPence)}</strong></p>` : ""}
    ${checked ? `<p class="invoice-checked">Payment status checked ${escape(checked)}</p>` : ""}
    ${changed ? '<p class="history-summary">Current balance from QuickBooks. The PDF contains the original issued details.</p>' : ""}
    <a class="button button-outline invoice-pdf" data-invoice-pdf href="${href}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/></svg>View invoice PDF <span class="sr-only">(opens in a new tab)</span></a>
    <details class="invoice-details" ${expanded.has(String(invoice.id)) ? "open" : ""}><summary>${voided || changed || review || settled ? "Original invoice details" : "Invoice details and payment instructions"}</summary>
      <div class="invoice-detail-body">
        <p class="invoice-postal"><b>Billed to</b><br>${escape([invoice.billTo.name, invoice.billTo.address, invoice.billTo.postcode].filter(Boolean).join("\n"))}</p>
        ${!voided && !changed && !review && !settled ? `<p class="invoice-detail-note">${escape(invoice.paymentTerms.label)}${invoice.paymentTerms.note ? " · " + escape(invoice.paymentTerms.note) : ""}</p>` : ""}
        <p class="invoice-detail-note">${invoice.orderIds?.length > 1 ? invoice.orderIds.length + " orders" : "Order " + escape(invoice.orderId)}${invoice.orderReference ? " · " + escape(invoice.orderReference) : ""}</p>
        <dl class="invoice-amounts"><div><dt>Net subtotal</dt><dd>${money(invoice.totals.netPence)}</dd></div><div><dt>VAT</dt><dd>${money(invoice.totals.vatPence)}</dd></div><div><dt>${voided || changed ? "Original invoice total" : "Invoice total"}</dt><dd>${money(invoice.totals.grossPence)}</dd></div></dl>
        ${!voided && !review && !settled && invoice.paymentInstructions ? `<p class="invoice-postal"><b>How to pay</b><br>${escape(invoice.paymentInstructions)}</p>` : ""}
      </div>
    </details>
  </article>`;
}
async function loadInvoices(append = false) {
  if (invoiceLoading || !invoicesShown()) return;
  invoiceLoading = true;
  const expanded = new Set([...document.querySelectorAll('[data-customer-invoice]:has(details[open])')].map(node => node.dataset.customerInvoice));
  const hasInvoices = customerInvoices.length > 0;
  if (!append && !hasInvoices) $("#customer-invoices-list").replaceChildren(SC.skeleton({ label: "Loading your invoices…" }));
  $("#invoice-count").textContent = append ? "Loading earlier invoices…" : hasInvoices ? "Refreshing invoices…" : "Loading invoices…";
  $("#customer-invoices-list").setAttribute("aria-busy", "true");
  refreshBusy("#refresh-invoices", true); $("#invoice-more").disabled = true;
  try {
    if (!await confirmIdentity()) return;
    const result = await api("/api/wholesale/invoices" + (append && invoiceCursor ? "?cursor=" + encodeURIComponent(invoiceCursor) : ""));
    customerInvoices = append ? [...new Map([...customerInvoices, ...result.invoices].map(invoice => [invoice.id, invoice])).values()] : result.invoices;
    invoiceCursor = result.nextCursor || null; invoiceTotal = result.count;
    const summary = result.summary;
    $("#customer-invoice-summary").innerHTML = `<div><span>Outstanding</span><strong>${money(summary.outstandingPence)}</strong></div><div><span>Overdue</span><strong>${money(summary.overduePence)}</strong></div>${summary.reviewCount ? `<p class="invoice-review-note">${summary.reviewCount} ${summary.reviewCount === 1 ? "invoice has an unconfirmed balance" : "invoices have unconfirmed balances"}. Totals use confirmed balances.</p>` : ""}`;
    $("#history-invoice-note").hidden = !summary.outstandingPence;
    $("#history-invoice-note").textContent = `${money(summary.outstandingPence)} outstanding${summary.overdueCount ? " · " + summary.overdueCount + " overdue" : ""} · View invoices`;
    $("#customer-invoices-list").innerHTML = customerInvoices.length ? customerInvoices.map(invoice => customerInvoiceCard(invoice, expanded)).join("") : '<div class="history-empty"><h3>No invoices yet</h3><p>Your issued invoices will appear here. Contact Strangers if you need an invoice for an order.</p></div>';
    $("#invoice-count").textContent = invoiceTotal ? `Showing ${customerInvoices.length} of ${invoiceTotal} ${invoiceTotal === 1 ? "invoice" : "invoices"}` : "";
    $("#invoice-more").hidden = !invoiceCursor;
  } catch (error) {
    if (error.code === "invoices_unavailable") { session.invoices = false; applyInvoiceSwitch(); return; }
    if (!append && !hasInvoices) $("#customer-invoices-list").innerHTML = '<div class="history-empty"><h3>Couldn’t load invoices</h3><p>Use Refresh invoices to try again.</p></div>';
    $("#invoice-count").textContent = append ? "Couldn’t load earlier invoices. Try again." : hasInvoices ? "Refresh unavailable. Showing the last loaded invoices." : error.message;
  } finally {
    invoiceLoading = false; $("#customer-invoices-list").setAttribute("aria-busy", "false");
    refreshBusy("#refresh-invoices", false); $("#invoice-more").disabled = false;
  }
}
$("#refresh-invoices").addEventListener("click", () => loadInvoices());
$("#invoice-more").addEventListener("click", () => { if (invoiceCursor) loadInvoices(true); });

document.querySelector('[data-clear-coffee]').addEventListener('click', () => {
  $('#reset-filters').click();
  $('#coffee-search').focus({ preventScroll: true });
});
