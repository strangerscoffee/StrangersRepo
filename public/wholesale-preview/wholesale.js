import { products, setCatalogue, isAvailable, packs, grinds, MAX_QUANTITY, money, weight, productFor, lineKey, unitPrice, validQuantity, sanitiseBasket, addToBasket, totals } from "./order.js";

let STORAGE_KEY = null;
let session = null;
let ready = false;
let requestId = null;
let saving = false;
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
let storageAvailable = true;
let basket = [];
let currentFilter = "all";
let orderVisible = false;
let toastTimer;
let history = [];
const photoIndexes = new Map();
const canOrder = () => session?.customer?.status !== "On hold";
const goSignIn = () => location.replace(location.pathname.startsWith("/wholesale-preview/") ? "/wholesale-preview/signin" : "/signin");

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
    <div class="product-info"><p class="product-origin">${escape(product.origin)}</p><h3 class="product-name" id="name-${product.id}">${product.sourceUrl ? `<a href="${escape(product.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escape(`View ${product.title} on Strangers Coffee`)}">${escape(product.name)}</a>` : escape(product.name)}</h3><p class="product-process">${escape(product.process)}</p><p class="tasting-notes">${escape(product.notes)}</p><p class="product-stock ${product.inStock ? "" : "out"}">${product.inStock ? "In stock" : "Out of stock"}</p></div>
    <form class="product-config" data-product="${product.id}">
      <fieldset class="pack-options"><legend>Pack size <span class="sr-only">for ${escape(product.name)}</span></legend>${Object.entries(packs).map(([id, pack]) => `<label class="pack-choice"><input type="radio" name="pack" value="${id}" ${id === "kilo" ? "checked" : ""}><span>${escape(pack.short)} bag</span></label>`).join("")}</fieldset>
      <label class="grind-label">Grind <span class="sr-only">for ${escape(product.name)}</span><select name="grind">${Object.entries(grinds).map(([id, grind]) => `<option value="${id}">${escape(grind)}</option>`).join("")}</select></label>
      <div class="product-price"><strong data-price>${money(product.price)}</strong><span data-price-unit>per 1 kg bag</span></div>
      <div class="add-row">${stepper(`qty-${product.id}`, 1, product.name, `error-${product.id}`)}<button class="button button-dark" type="submit" aria-label="Add ${escape(product.name)} to order" ${isAvailable(product) ? "" : "disabled"}>${product.inStock ? 'Add to order <span aria-hidden="true">+</span>' : "Out of stock"}</button></div>
      <p class="quantity-error" id="error-${product.id}" hidden role="status">Choose a whole number of packs, from 1 to 99.</p>
    </form>
  </article>`).join("");
}

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
  $("#order-count").textContent = String(sum.packs).padStart(2, "0");
  $(".basket-link").setAttribute("aria-label", `View your order, ${packText}`);
  $("#order-items").innerHTML = basket.length ? basket.map((line, index) => {
    const product = productFor(line.productId);
    return `<div class="order-item" data-line="${lineKey(line)}">
      ${product.imageUrls?.length ? `<img src="${escape(product.imageUrls[0])}" alt="" width="42" height="48">` : '<span class="basket-photo-placeholder" aria-hidden="true">—</span>'}
      <div><h3>${escape(product.name)}</h3><p class="line-variant">${escape(packs[line.pack].label)} · ${escape(grinds[line.grind])}<br>${money(unitPrice(product, line.pack))} per pack${!isAvailable(product) ? "<br>Unavailable — remove to continue." : ""}</p>
      <div class="line-actions">${stepper(`line-qty-${index}`, line.quantity, `${product.name}, ${packs[line.pack].label}, ${grinds[line.grind]}`, `line-error-${index}`)}<strong class="line-price">${money(unitPrice(product, line.pack) * line.quantity)}</strong></div>
      <p class="quantity-error" id="line-error-${index}" role="status" hidden>Choose a whole number from 1 to 99.</p>
      <button class="remove-button" type="button" data-remove aria-label="Remove ${escape(`${product.name}, ${packs[line.pack].label}, ${grinds[line.grind]}`)}">Remove</button></div>
    </div>`;
  }).join("") : `<div class="empty-basket"><svg viewBox="0 0 80 80" aria-hidden="true"><path d="M18 30h38v20c0 12-8 18-19 18s-19-6-19-18V30Zm38 4h5a10 10 0 0 1 0 20h-6M12 72h50M29 21c-7-8 6-8 0-16M40 21c-7-8 6-8 0-16M50 21c-7-8 6-8 0-16"/></svg><h3>Room for something good.</h3><p>Choose your coffee and add a few favourites. We’ll keep count.</p></div>`;
  $("#order-totals").hidden = !basket.length;
  $("#total-weight").textContent = weight(sum.grams);
  $("#subtotal").textContent = money(sum.pence);
  $("#review-order").disabled = !canOrder() || !basket.length || basket.some((line) => !isAvailable(productFor(line.productId)));
  $("#basket-storage-note").textContent = storageAvailable ? "Your basket stays on this browser." : "Basket is temporary: browser storage is unavailable.";
  $("#mobile-packs").textContent = packText;
  $("#mobile-total").textContent = money(sum.pence);
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
    const pack = form.elements.pack.value;
    const product = productFor(form.dataset.product);
    form.querySelector("[data-price]").textContent = money(unitPrice(product, pack));
    form.querySelector("[data-price-unit]").textContent = `per ${packs[pack].label}`;
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

$("#review-order").addEventListener("click", async () => {
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
  $("#review-form").elements.business.value = session.customer?.business || "";
  $("#review-form").elements.business.readOnly = !!session.customer;
  $("#delivery-summary").textContent = session.customer ? [session.customer.address, session.customer.postcode, session.customer.deliveryNotes].filter(Boolean).join(" · ") || "Add delivery details in My account, or choose roastery collection." : "";
  $("#review-account").hidden = !session.customer;
  $("#review-payment-terms").textContent = session.customer ? `Payment terms: ${session.customer.paymentTerms.label}${session.customer.paymentTerms.note ? " · " + session.customer.paymentTerms.note : ""}` : "";
  requestId = crypto.randomUUID();
  $("#preview-submit-error").hidden = true;
  $("#review-content").hidden = false;
  $("#preview-complete").hidden = true;
  $("#review-dialog").setAttribute("aria-labelledby", "review-title");
  $("#review-dialog").showModal();
});

$("#review-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !ready || !basket.length) return;
  saving = true;
  const button = $("#submit-preview-order");
  button.disabled = true;
  $("#preview-submit-error").hidden = true;
  try {
    const form = $("#review-form");
    const result = await api("/api/wholesale/orders", {
      requestId,
      lines: basket.map((line) => ({ ...line, price: unitPrice(productFor(line.productId), line.pack) })),
      delivery: form.elements.delivery.value === "collection" ? "Roastery collection" : "Delivery",
      reference: form.elements.reference.value, business: form.elements.business.value,
      ...(session.customer ? { customerVersion: session.customer.version } : {}),
    });
    $("#complete-message").textContent = result.preview ? `${result.order.id} was saved as a staff preview order.` : `${result.order.id} has been received by Strangers. Follow its progress in My orders.`;
    $("#complete-dashboard-link").hidden = session.me.role !== "admin";
    $("#complete-dashboard-link").href = session.links.admin + "#wholesale";
    $("#complete-total").textContent = money(result.order.pence);
    $("#complete-payment-terms").textContent = result.order.paymentTerms ? `Payment terms: ${result.order.paymentTerms.label}${result.order.paymentTerms.note ? " · " + result.order.paymentTerms.note : ""}` : "";
    basket = []; changedBasket();
    $("#review-content").hidden = true;
    $("#preview-complete").hidden = false;
    $("#review-dialog").setAttribute("aria-labelledby", "complete-title");
    $("#review-dialog").scrollTop = 0;
    $("#preview-complete [data-close]").focus({ preventScroll: true });
    form.reset();
  } catch (error) {
    $("#preview-submit-error").textContent = error.message;
    $("#preview-submit-error").hidden = false;
  } finally { saving = false; button.disabled = false; }
});

document.querySelectorAll("[data-help]").forEach((button) => button.addEventListener("click", () => $("#help-dialog").showModal()));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { if (dialog.id === "review-dialog") $("#review-form").reset(); });
});

async function api(path, body, method) {
  let response;
  try { response = await fetch(path, { method: method || (body ? "POST" : "GET"), cache: "no-store", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error("Couldn’t reach the site. Check your connection and try again."); }
  if (response.status === 401 && !path.startsWith("/api/wholesale/auth/")) { goSignIn(); throw new Error("Sign in to continue."); }
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
  } else { basket = sanitiseBasket(basket); saveBasket(); }
  $("#signed-in-name").textContent = session.customer?.business || session.me.name;
  $("#preview-home").href = session.links.preview;
  $("#admin-wholesale-link").hidden = session.me.role !== "admin";
  if (session.me.role === "admin") $("#admin-wholesale-link").href = session.links.admin + "#wholesale";
  $("#my-account").hidden = !session.customer;
  $("#staff-preview-notice").hidden = !session.preview;
  $("#submit-preview-order").textContent = session.preview ? "Save preview order" : "Place order";
  $("#account-hold").hidden = canOrder();
  showPaymentTerms();
  ready = true;
  renderProducts(); filterProducts(); renderBasket();
}
async function start() {
  $("#refresh-catalogue").disabled = true;
  $("#retry-catalogue").hidden = true;
  $("#catalogue-status").hidden = false;
  $("#catalogue-status").textContent = "Loading the signed-in catalogue…";
  try {
    applyCatalogue(await api("/api/wholesale/catalogue"), true);
    $("#catalogue-status").hidden = true;
  } catch (error) {
    $("#catalogue-status").textContent = error.message;
    $("#retry-catalogue").hidden = false;
  } finally { $("#refresh-catalogue").disabled = false; }
}
$("#preview-sign-out").addEventListener("click", async () => {
  if (session?.me.role !== "wholesale") return SC.signOut();
  try { await api("/api/wholesale/auth/logout", {}); goSignIn(); }
  catch (error) { toast(error.message); }
});
$("#retry-catalogue").addEventListener("click", start);
$("#refresh-catalogue").addEventListener("click", start);
window.addEventListener("pageshow", (event) => { if (event.persisted) api("/api/wholesale/session").then((fresh) => { if (session && session.me.id !== fresh.me.id) location.reload(); }).catch(() => {}); });

async function openAccount() {
  try {
    const current = await api("/api/wholesale/session");
    session.customer = current.customer;
    if (!session.customer) return;
    showPaymentTerms();
    for (const key of ["business", "contact", "email", "phone", "address", "postcode", "deliveryNotes"]) $("#account-form").elements[key].value = session.customer[key] || "";
    $("#account-error").hidden = $("#password-error").hidden = true;
    $("#account-dialog").showModal();
  } catch (error) { toast(error.message); }
}
$("#my-account").addEventListener("click", openAccount);
$("#review-account").addEventListener("click", () => { $("#review-dialog").close(); openAccount(); });
$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('[type="submit"]');
  button.disabled = true;
  $("#account-error").hidden = true;
  try {
    const fields = Object.fromEntries(["business", "contact", "email", "phone", "address", "postcode", "deliveryNotes"].map((key) => [key, form.elements[key].value]));
    const result = await api("/api/wholesale/account", { ...fields, ifVersion: session.customer.version }, "PUT");
    session.customer = result.customer;
    showPaymentTerms();
    $("#signed-in-name").textContent = session.customer.business;
    $("#account-dialog").close(); toast("Business details saved.");
  } catch (error) { $("#account-error").textContent = error.message; $("#account-error").hidden = false; }
  finally { button.disabled = false; }
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

async function loadOrders() {
  $("#order-history").textContent = "Loading your orders…";
  try {
    history = (await api("/api/wholesale/orders")).orders;
    $("#order-history").innerHTML = history.length ? history.map((order) => `<article class="history-card"><p class="history-id">${escape(order.id)}</p><h3>${new Date(order.createdAt).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" })} · ${money(order.pence)}</h3><span class="order-state">${escape(order.status)}</span><p>${order.packs} bags · ${escape(order.delivery)}${order.reference ? ` · ${escape(order.reference)}` : ""}</p>${order.paymentTerms ? `<p class="payment-terms">Payment terms: ${escape(order.paymentTerms.label)}${order.paymentTerms.note ? `<br>${escape(order.paymentTerms.note)}` : ""}</p>` : ""}${order.lines.map((line) => `<p>${line.quantity} × ${escape(line.title)} · ${escape(line.packLabel)} · ${escape(line.grindLabel)}</p>`).join("")}<button class="button button-outline" type="button" data-reorder="${escape(order.id)}">Order again</button></article>`).join("") : '<p class="dialog-intro">Your orders will appear here once you place one.</p>';
  } catch (error) { $("#order-history").textContent = error.message; }
}
$("#my-orders").addEventListener("click", () => { $("#orders-dialog").showModal(); loadOrders(); });
$("#order-history").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reorder]");
  if (!button || !ready) return;
  const order = history.find((row) => row.id === button.dataset.reorder);
  if (!order) return;
  let added = 0;
  for (const line of order.lines) {
    const product = productFor(line.productId);
    if (!isAvailable(product)) continue;
    const result = addToBasket(basket, line, line.quantity);
    basket = result.basket; added += result.added;
  }
  changedBasket(); $("#orders-dialog").close();
  toast(added ? `${added} bags added at current prices. Review your basket before placing the order.` : "These coffees are unavailable or already at the basket limit.");
});
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => { orderVisible = entry.isIntersecting; updateMobileBasket(); }, { threshold: 0 }).observe($("#your-order"));
}
start();
