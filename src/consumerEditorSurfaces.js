// Only the authenticated editor canvas calls these presenters. Preview carts, account details
// and receipts exist solely for this request and never call a shopper or fulfilment service.
import { authField, authModes, modeLabels, orderMarkup } from "../public/consumer-preview/assets/account.js";
import { detailsStage, emptyCheckoutMarkup, priceAction, processingMarkup, receiptMarkup, reviewStage, summary } from "../public/consumer-preview/assets/checkout.js";
import { finderMarkup } from "../public/consumer-preview/assets/finder.js";
import { productPageView } from "../public/consumer-preview/assets/product-page.js";
import { cafes, products } from "../public/consumer-preview/assets/products.js";
import { createStore } from "../public/consumer-preview/assets/store.js";
import { cartView, shelfProducts } from "../public/consumer-preview/assets/storefront-views.js";

const sampleContact = {
  name: "Jamie Reed", email: "jamie@example.com", phone: "",
  address: "12 Example Lane", town: "Norwich", postcode: "NR2 1AA",
};
const blankContact = { name: "", email: "", phone: "", address: "", town: "", postcode: "" };

function sampleCart() {
  const store = createStore(products, null);
  store.add("bom-jesus", "250g", "Whole bean", 2);
  return store;
}

function sampleOrder(store) {
  return {
    reference: "SC-00000000", createdAt: "2026-11-25T10:00:00Z", status: "placed",
    paymentMode: "test", method: "delivery", contact: sampleContact,
    lines: store.cart(), pricing: store.totals("delivery"),
  };
}

function contents(rewriter, selector, value, html = false) {
  rewriter.on(selector, { element(element) { element.setInnerContent(value, { html }); } });
}
function attribute(rewriter, selector, name, value) {
  rewriter.on(selector, { element(element) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  } });
}

function accountSurface(rewriter, state) {
  if (state === "orders" || state === "details") {
    attribute(rewriter, "#account-access", "hidden", "");
    attribute(rewriter, "#account-session, #account-dashboard, #account-avatar, #account-hero-label", "hidden", null);
    contents(rewriter, "#account-title", "Welcome back, Jamie.");
    contents(rewriter, "#account-avatar", "J");
    attribute(rewriter, "#account-profile fieldset, #account-profile button", "disabled", null);
    for (const [key, value] of Object.entries(sampleContact)) attribute(rewriter, "#account-" + key, "value", value);
    if (state === "details") {
      attribute(rewriter, "#account-overview", "hidden", "");
      attribute(rewriter, "#account-details", "hidden", null);
      attribute(rewriter, '[data-account-tab="orders"]', "aria-pressed", "false");
      attribute(rewriter, '[data-account-tab="details"]', "aria-pressed", "true");
    } else {
      contents(rewriter, "#account-order-history", '<ul class="account-order-list">' +
        orderMarkup(sampleOrder(sampleCart()), { latest: true, open: true }) + '</ul>', true);
      attribute(rewriter, "#account-saved-address", "hidden", null);
      contents(rewriter, "#account-saved-address", [sampleContact.address, sampleContact.town, sampleContact.postcode].join("\n"));
      attribute(rewriter, "#account-no-address", "hidden", "");
      contents(rewriter, "#account-edit-address", "Edit address");
    }
    return;
  }
  const mode = Object.hasOwn(authModes, state) ? state : "login";
  const config = authModes[mode];
  contents(rewriter, "#account-access-title", config.heading);
  contents(rewriter, "#account-access-copy", config.copy);
  contents(rewriter, "#account-access-status", "");
  attribute(rewriter, "#account-auth, #account-auth-form", "hidden", null);
  attribute(rewriter, "#account-auth-fields, #account-auth-submit", "disabled", null);
  attribute(rewriter, "#account-auth-form", "data-auth-mode", mode);
  contents(rewriter, "#account-auth-fields", config.fields.map(name => authField(name, mode)).join(""), true);
  contents(rewriter, "#account-auth-submit", config.submit);
  contents(rewriter, "#account-auth-links", config.links.map(link =>
    `<a href="/account/?mode=${link}">${modeLabels[link]}</a>`).join(""), true);
}

function checkoutSurface(rewriter, state) {
  const store = sampleCart();
  const collection = state === "collection";
  const method = collection ? "collection" : "delivery";
  const lines = store.cart();
  const pricing = store.totals(method);
  const kind = state === "review" ? "review" : "details";
  const totals = summary(lines, pricing, method, priceAction(kind, pricing));
  let markup;
  switch (state) {
    case "empty": markup = emptyCheckoutMarkup; break;
    case "processing": markup = processingMarkup(); break;
    case "confirmation":
      contents(rewriter, "#retail-checkout-heading", "Order confirmation");
      markup = receiptMarkup(sampleOrder(store), { confirmed: true, guest: false });
      break;
    case "review": markup = reviewStage({ contact: sampleContact, method, cafe: null }, totals); break;
    default:
      markup = detailsStage({ cafes, method, cafe: cafes[0].id, contact: blankContact, signedIn: false }, "", totals);
      break;
  }
  contents(rewriter, "#retail-checkout", markup, true);
  contents(rewriter, "#bag-count", state === "empty" || state === "confirmation" ? "0" : String(pricing.count));
}

function drawerSurface(rewriter, scope, state) {
  const finder = scope === "finder";
  const step = ["taste", "match"].includes(state) ? state : "brew";
  const store = state === "empty" ? createStore(products, null) : sampleCart();
  const answers = { brew: step === "brew" ? "" : "Filter / Medium", taste: step === "match" ? "Chocolatey" : "", caffeine: "regular" };
  const content = finder ? finderMarkup(step, products, answers) : cartView(store, false);
  contents(rewriter, "#panel-body", content, true);
  contents(rewriter, "#dialog-title", finder ? "Find my coffee" : "Your cart");
  if (!finder) contents(rewriter, "#bag-count", String(store.totals().count));
  attribute(rewriter, "#dialog", "open", "");
  attribute(rewriter, "#dialog", "data-view", finder ? "finder" : "bag");
  // Non-scripted <dialog open> has no top layer or ::backdrop; the real modal uses showModal().
  rewriter.on("head", { element(element) {
    element.append('<style>dialog[open]{z-index:100;box-shadow:0 0 0 100vmax #0d2418a3,0 20px 80px #061d2d3d}</style>', { html: true });
  } });
}

export function applyEditorPreviewSurfaces(rewriter, scope, state) {
  if (scope === "product" || scope.startsWith("product:")) {
    const view = productPageView(scope === "product" ? "bom-jesus" : scope.slice(8), null, true);
    if (view) {
      contents(rewriter, "[data-retail-product]", view.markup, true);
      attribute(rewriter, "[data-retail-product]", "aria-busy", null);
    }
  } else if (scope === "shop") {
    const coffees = products.filter(product => !product.category);
    contents(rewriter, "#products", shelfProducts(coffees, true), true);
    contents(rewriter, "#shelf-status", `${coffees.length} coffees`);
  } else if (scope === "account") accountSurface(rewriter, state);
  else if (scope === "checkout") checkoutSurface(rewriter, state);
  else if (scope === "cart" || scope === "finder") drawerSurface(rewriter, scope, state);
  return rewriter;
}
