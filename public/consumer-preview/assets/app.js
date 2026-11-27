import { cartView, quantityMarkup, shelfProducts, giftProducts } from './storefront-views.js';
import { products, cafes, availability } from './products.js';
import { productPath } from './product-paths.js';
import { getServerAccount, setupAccount } from './account.js';
import { escapeHtml as html } from './html.js';
import { availableTastingFlight, finderMarkup, finderVariant, tastingFlightId, updateFinderAnswers } from './finder.js';
import { createStore, money, CART_KEY } from './store.js';
import { grindLabel, sizeNames } from './checkout.js';

const store = createStore(products);
const retailCheckout = document.querySelector('#retail-checkout');
const shelf = document.querySelector('#products');
const currentProduct = id => products.find(product => product.id === id);
const home = document.querySelector('.retail-home');
const cafeById = new Map(cafes.map(cafe => [cafe.id, cafe]));
const dialog = document.querySelector('#dialog');
const title = document.querySelector('#dialog-title');
const body = document.querySelector('#panel-body');
const dock = document.querySelector('#panel-actions');
const closeButton = document.querySelector('#close-dialog');
const siteMenu = document.querySelector('#mobile-menu');
const menuButton = document.querySelector('#menu-button');
const search = document.querySelector('#search');
const tasteFilter = document.querySelector('#shelf-taste');
const shortCafeNames = { pottergate: 'Pottergate', 'dove-street': 'Dove Street', 'all-saints-green': 'All Saints Green' };
let filter = 'All';
let activeCafe = 'pottergate';
let returnFocus;
let menuCloseSequence = 0;
let dialogCloseSequence = 0;
let productQty = 1;
const finder = { brew: '', taste: '', caffeine: 'regular' };
let refreshCheckoutCart;
let renderProductPage;
let stockNotice;

function bagCount() {
  const count = store.totals().count;
  document.querySelector('#bag-count').textContent = count;
  document.querySelector('[data-bag]').setAttribute('aria-label', `Cart, ${count} ${count === 1 ? 'item' : 'items'}`);
  refreshCheckoutCart?.();
}

function renderShelf() {
  tasteFilter.value = filter;
  const query = search.value.trim().toLocaleLowerCase('en-GB');
  const coffees = document.querySelector('[data-full-catalogue]') ? products.filter(product => !product.category)
    : products.filter(product => Number.isInteger(product.shelfOrder)).sort((a, b) => a.shelfOrder - b.shelfOrder);
  const shown = coffees.filter(product =>
    (filter === 'All' || product.profile === filter) &&
    [product.name, product.country, product.region, ...product.notes].join(' ').toLocaleLowerCase('en-GB').includes(query),
  );
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
  const grid = shelf;
  if (!shown.length) {
    grid.replaceChildren(document.querySelector('#empty-shelf').content.cloneNode(true));
  } else {
    grid.innerHTML = shelfProducts(shown, availability.known);
  }
  document.querySelector('#shelf-status').textContent = `${shown.length} ${shown.length === 1 ? 'coffee' : 'coffees'}`;
}

function renderCafes() {
  const tabs = document.querySelector('#cafe-switch');
  if (!tabs.children.length) {
    tabs.innerHTML = cafes.map(cafe => `<button type="button" data-cafe="${cafe.id}">${shortCafeNames[cafe.id]}</button>`).join('');
  }
  tabs.querySelectorAll('[data-cafe]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.cafe === activeCafe));
  });
  const cafe = cafeById.get(activeCafe);
  document.querySelector('#cafe-detail').innerHTML = `<img class="cafe-image" src="${cafe.image}" alt="${cafe.name}" loading="lazy" width="740" height="470">
    <div class="cafe-copy"><h3>${cafe.name}</h3><p>${cafe.address}</p><p>${cafe.description}</p>
    <div class="cafe-hours"><strong>Opening hours</strong><ul>${cafe.hours.map(time => `<li>${time}</li>`).join('')}</ul></div>
    <a class="button outline" href="${cafe.map}" target="_blank" rel="noopener noreferrer">Get directions</a></div>`;
}

function menuOpen(open, restoreFocus = false) {
  const sequence = ++menuCloseSequence;
  siteMenu.classList.remove('is-closing');
  siteMenu.inert = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  if (open) {
    siteMenu.hidden = false;
    return;
  }
  if (!siteMenu.hidden) {
    siteMenu.classList.add('is-closing');
    setTimeout(() => {
      if (sequence === menuCloseSequence) {
        siteMenu.hidden = true;
        siteMenu.classList.remove('is-closing');
      }
    }, 190);
  }
  if (restoreFocus) menuButton.focus();
}

function showPanel(view, label, markup, opener, actions = '') {
  dialogCloseSequence += 1;
  dialog.classList.remove('is-closing');
  if (!dialog.open) returnFocus = opener ?? document.activeElement;
  if (!siteMenu.inert) {
    returnFocus = menuButton;
    menuOpen(false);
  }
  dialog.dataset.view = view;
  title.textContent = label;
  body.innerHTML = markup;
  dock.innerHTML = actions;
  dock.hidden = !actions;
  body.scrollTop = 0;
  if (!dialog.open) dialog.showModal();
  const focusTarget = body.querySelector('[data-panel-focus], .finder-heading') ?? closeButton;
  focusTarget.focus({ preventScroll: true });
}

function closePanel() {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  const sequence = ++dialogCloseSequence;
  const finish = () => {
    if (sequence !== dialogCloseSequence) return;
    dialog.classList.remove('is-closing');
    dialog.close();
    body.replaceChildren();
    dock.replaceChildren();
    dock.hidden = true;
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    else document.querySelector('[data-bag]').focus({ preventScroll: true });
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
  } else {
    dialog.classList.add('is-closing');
    setTimeout(finish, 190);
  }
}

function resizeQty(group, qty) {
  group.querySelector('output').value = qty;
  const decrease = group.querySelector('[data-qty="-1"]');
  const increase = group.querySelector('[data-qty="1"]');
  decrease.disabled = qty === 1;
  increase.disabled = qty === 99;
  if (document.activeElement === document.body) {
    (qty === 1 ? increase : decrease).focus({ preventScroll: true });
  }
}

function showProduct(id, opener, { grind: suggestedGrind = 'Whole bean', fromFinder = false } = {}) {
  if (!availability.known) {
    void checkDrawerStock(opener, () => showProduct(id, undefined, { grind: suggestedGrind, fromFinder }));
    return;
  }
  const product = currentProduct(id);
  if (!product) return;
  productQty = 1;
  const details = [product.region, product.process].filter(Boolean).map(html);
  const firstSize = Object.keys(product.prices)[0];
  showPanel('product', product.name, `<div class="product-detail">
    <div class="detail-media"><img src="${html(product.image)}" width="580" height="580" alt="${html(product.name)} packaging artwork"></div>
    <div class="detail-copy">${fromFinder ? '<button class="text-button finder-product-back" type="button" data-finder-back="match">Back to my match</button>' : ''}<p class="eyebrow">${[product.country, product.profile].filter(Boolean).map(html).join(' · ')}</p>
    <p class="detail-notes">${html(product.shortCopy)}</p>
    <p class="detail-story">${product.story ? `${html(product.story)} ` : ''}<a href="${productPath(product)}${fromFinder ? `?grind=${encodeURIComponent(suggestedGrind)}` : ''}">View the coffee</a></p>
    ${details.length ? `<p class="detail-origin">${details.join(' · ')}</p>` : ''}
    ${product.available === false ? '<p class="detail-origin">This coffee is currently unavailable.</p>' : ''}
    <form class="detail-form" id="product-form" data-id="${html(id)}"${product.available === false ? ' hidden' : ''}>
      <fieldset><legend>Weight</legend><div class="choices">${Object.entries(product.prices).map(([size]) =>
        `<label class="choice"><input type="radio" name="size" value="${html(size)}" ${size === firstSize ? 'checked' : ''}>${html(sizeNames[size] ?? size)}</label>`).join('')}</div></fieldset>
      <div class="field"><label for="grind">Grind</label><select id="grind" name="grind">${product.grinds.map(grind =>
        `<option value="${html(grind)}" ${grind === suggestedGrind ? 'selected' : ''}>${html(grindLabel(grind))}</option>`).join('')}</select></div>
      <div class="form-submit">${quantityMarkup(productQty, product.name)}<button class="button" id="add-to-bag" type="submit">Add to cart · ${money(product.prices[firstSize])}</button></div>
      <p class="form-error" id="product-error" role="alert" hidden>You can add up to 99 bags of each size and grind.</p>
    </form></div></div>`, opener);
}

function updateProductPrice(form) {
  const product = currentProduct(form.dataset.id);
  document.querySelector('#add-to-bag').textContent = `Add to cart · ${money(product.prices[form.elements.size.value] * productQty)}`;
  document.querySelector('#product-error').hidden = true;
}

async function checkDrawerStock(opener, onSuccess) {
  showPanel('stock', 'Coffee availability', '<p role="status">Checking coffee availability…</p>', opener);
  const sequence = dialogCloseSequence;
  const ok = await availability.refresh();
  if (!dialog.open || dialog.dataset.view !== 'stock' || sequence !== dialogCloseSequence) return;
  if (ok) {
    refreshStockView();
    onSuccess();
  } else {
    showPanel('stock', 'Coffee availability', '<p>We couldn’t check coffee availability.</p><button class="button outline" type="button" data-retry-drawer-stock>Try again</button>');
    body.querySelector('[data-retry-drawer-stock]').addEventListener('click', () => void checkDrawerStock(undefined, onSuccess));
  }
}

function refreshStockView() {
  stockNotice?.remove();
  store.refresh(true);
  if (shelf) {
    renderShelf();
    const gifts = document.querySelector('[data-catalogue-gifts]');
    if (gifts) {
      gifts.querySelectorAll('[data-catalogue-id]').forEach(card => card.remove());
      gifts.insertAdjacentHTML('beforeend', giftProducts(products.filter(item => item.category)));
    }
  }
  if (home) void import('./home.js').then(({ showHighlights }) => showHighlights(products));
  renderProductPage?.();
  syncCart();
}

function showFinder(opener) {
  if (!availability.known) {
    void checkDrawerStock(opener, () => showFinder());
    return;
  }
  showPanel('finder', 'Find my coffee', finderMarkup('brew', products, finder), opener);
}

function moveFinder(step) {
  showPanel('finder', 'Find my coffee', finderMarkup(step, products, finder));
}

function addFinderCoffee(id, control) {
  const product = currentProduct(id);
  const variant = finderVariant(product, finder.brew);
  const available = id !== tastingFlightId || availableTastingFlight(products);
  if (variant && available && store.add(id, variant.size, variant.grind)) {
    bagCount();
    showBag(undefined, `${product.name} added to your cart.`);
    return;
  }
  const message = control.closest('article')?.querySelector('.finder-add-error');
  if (message) {
    message.hidden = false;
    message.textContent = 'This selection couldn’t be added. Check your cart or choose another coffee.';
  }
}

function showBag(opener, message) {
  if (!availability.known) {
    void checkDrawerStock(opener, () => showBag(undefined, message));
    return;
  }
  store.refresh();
  bagCount();
  showPanel('bag', 'Your cart', cartView(store, Boolean(retailCheckout), message), opener);
}

function updateBag(focusSelector) {
  const offset = body.scrollTop;
  body.innerHTML = cartView(store, Boolean(retailCheckout));
  body.scrollTop = offset;
  if (focusSelector === undefined) return;
  const nextFocus = (focusSelector && body.querySelector(focusSelector + ':not(:disabled)')) ?? body.querySelector('[data-checkout],[data-keep-shopping]') ?? closeButton;
  nextFocus.focus({ preventScroll: true });
}

function orderRetryMessage(opener) {
  const notice = opener.closest('.account-order-body')?.querySelector('.account-notice');
  if (notice?.isConnected) notice.textContent = 'Availability checked. Select Buy again to add these coffees.';
}

function reorderAccountOrder(order, opener) {
  if (dialog.open) return;
  if (!availability.known) {
    void checkDrawerStock(opener, () => {
      closePanel();
      // Reordering is a fresh action from the account after the stock check.
      orderRetryMessage(opener);
    });
    return 0;
  }
  let added = 0;
  let skipped = false;
  for (const line of order.lines) {
    if (store.add(line.id, line.size, line.grind, line.qty)) added += line.qty;
    else skipped = true;
  }
  if (!added) return 0;
  bagCount();
  const count = `${added} ${added === 1 ? 'bag' : 'bags'} added at current prices.`;
  showBag(opener, skipped ? `${count} Some coffees or quantities were unavailable.` : count);
  return added;
}

menuButton.addEventListener('click', () => menuOpen(siteMenu.inert));
closeButton.addEventListener('click', closePanel);
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  closePanel();
});
let backdropPress = false;
dialog.addEventListener('pointerdown', event => { backdropPress = event.target === dialog; });
dialog.addEventListener('click', event => { if (backdropPress && event.target === dialog) closePanel(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !siteMenu.inert) menuOpen(false, true);
});
search?.addEventListener('input', renderShelf);
tasteFilter?.addEventListener('change', () => {
  filter = tasteFilter.value;
  renderShelf();
});

document.addEventListener('click', event => {
  const control = event.target.closest('button,a');
  if (!control || control.disabled || (dialog.classList.contains('is-closing') && dialog.contains(control))) return;
  const action = control.dataset;
  if (action.find !== undefined) showFinder(control);
  else if (action.bag !== undefined) showBag(control);
  else if (action.filter !== undefined) {
    filter = action.filter;
    renderShelf();
  } else if (action.reset !== undefined) {
    filter = 'All';
    search.value = '';
    renderShelf();
    search.focus();
  } else if (action.cafe) {
    activeCafe = action.cafe;
    renderCafes();
  } else if (action.product) showProduct(action.product, control);
  else if (action.finderBack !== undefined) moveFinder(action.finderBack);
  else if (action.finderAdd) addFinderCoffee(action.finderAdd, control);
  else if (action.finderGuide !== undefined && location.pathname === '/brewguides/') closePanel();
  else if (action.match) showProduct(action.match, control, { grind: finder.brew, fromFinder: true });
  else if (action.returnCheckout !== undefined) closePanel();
  else if (action.keepShopping !== undefined) {
    if (!shelf) {
      window.location.assign('/coffee/#shelf-title');
      return;
    }
    returnFocus = document.querySelector('#shelf-title');
    closePanel();
    document.querySelector('#coffee').scrollIntoView();
  } else if (action.remove !== undefined) {
    const index = store.cart().findIndex(line => line.key === action.remove);
    store.remove(action.remove);
    bagCount();
    const next = store.cart()[Math.min(index, store.cart().length - 1)];
    updateBag(next ? `[data-remove="${CSS.escape(next.key)}"]` : null);
  } else if (action.qty) {
    const delta = Number(action.qty);
    if (action.line === undefined) {
      productQty += delta;
      resizeQty(control.closest('.qty'), productQty);
      updateProductPrice(document.querySelector('#product-form'));
    } else {
      store.adjustQty(action.line, delta);
      bagCount();
      const line = store.cart().find(item => item.key === action.line);
      const nextDelta = line?.qty === 1 ? 1 : line?.qty === 99 ? -1 : delta;
      updateBag(`[data-line="${CSS.escape(action.line)}"][data-qty="${nextDelta}"]`);
    }
  }
  if (siteMenu.contains(control) && control.matches('a')) menuOpen(false, true);
});

body.addEventListener('change', event => {
  const form = event.target.form;
  if (form?.id === 'product-form') updateProductPrice(form);
  if (form?.id === 'finder-form') updateFinderAnswers(form, finder);
});

body.addEventListener('submit', event => {
  event.preventDefault();
  if (dialog.classList.contains('is-closing')) return;
  const form = event.target;
  if (form.id === 'finder-form' && updateFinderAnswers(form, finder)) {
    moveFinder(form.dataset.step === 'brew' ? 'taste' : 'match');
  }
  if (form.id === 'product-form') {
    const product = currentProduct(form.dataset.id);
    if (product && availability.known && store.add(product.id, form.elements.size.value, form.elements.grind.value, productQty)) {
      bagCount();
      showBag(undefined, `${product.name} added to your cart.`);
    } else {
      document.querySelector('#product-error').hidden = false;
    }
  }
});

bagCount();
const productPage = document.querySelector('[data-retail-product]');
if (productPage) {
  void import('./product-page.js').then(({ setupProductPage }) => {
    renderProductPage = () => setupProductPage(productPage, {
      store,
      stockKnown: availability.known,
      onAdd(product, opener) {
        bagCount();
        showBag(opener, `${product.name} added to your cart.`);
      },
    });
    renderProductPage();
  });
}
const stockSurface = shelf || productPage || retailCheckout || home && document.querySelector('#home-roasting-grid');
async function checkStock(force = false) {
  if (stockSurface) {
    stockNotice?.remove();
    stockNotice = document.createElement('p');
    stockNotice.className = 'container checkout-note';
    stockNotice.setAttribute('role', 'status');
    stockSurface.before(stockNotice);
    stockNotice.replaceChildren('Checking coffee availability…');
  }
  if (await availability.refresh(force)) {
    refreshStockView();
    return true;
  } else {
    renderProductPage?.();
    shelf?.replaceChildren();
    document.querySelectorAll('[data-catalogue-gifts] [data-catalogue-id]').forEach(card => card.remove());
    if (home) document.querySelector('#home-roasting-grid')?.replaceChildren();
    refreshCheckoutCart?.();
    if (stockNotice) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'text-button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => void checkStock());
      stockNotice.replaceChildren('We couldn’t check coffee availability. ', retry);
    }
  }
  return false;
}
if (stockSurface) void checkStock();
if (home) {
  void import('./home.js').then(({ populateHome }) => populateHome());
}
if (document.querySelector('#cafe-detail')) renderCafes();
const accountPage = document.querySelector('#account-page');
const refreshAccount = accountPage ? setupAccount(accountPage, reorderAccountOrder) : null;
if (retailCheckout) {
  void import('./checkout-page.js').then(({ setupRetailCheckout }) => {
    refreshCheckoutCart = setupRetailCheckout(retailCheckout, { cafes, store, cartChanged: bagCount, getServerAccount, availability, refreshCatalogue: () => checkStock(true) });
  }).catch(() => {
    retailCheckout.innerHTML = '<p role="alert">Checkout couldn’t load. <a href="/checkout/">Try again</a>.</p>';
  });
}
function syncCart() {
  store.refresh();
  bagCount();
  if (dialog.open && dialog.dataset.view === 'bag') {
    const focused = document.activeElement;
    const { line, qty, remove } = focused.dataset;
    const target = line ? `[data-line="${CSS.escape(line)}"][data-qty="${qty}"]`
      : remove ? `[data-remove="${CSS.escape(remove)}"]` : null;
    updateBag(body.contains(focused) ? target : undefined);
  }
}
window.addEventListener('storage', event => {
  if ((event.key === CART_KEY || event.key === null) && event.storageArea === localStorage) syncCart();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    refreshAccount?.();
    if (availability.known && (stockSurface || dialog.open)) void checkStock(true);
    else syncCart();
  }
});

const espressoVideo = document.querySelector('[data-espresso-video]');
if (espressoVideo && /^[A-Za-z0-9_-]{11}$/.test(espressoVideo.dataset.espressoVideo)) {
  const play = espressoVideo.querySelector('[data-play-espresso]');
  play.hidden = false;
  play.addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${espressoVideo.dataset.espressoVideo}?autoplay=1`;
    frame.title = 'Espresso brew guide';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    play.replaceWith(frame);
    frame.focus();
  }, { once: true });
}
