import { productPath } from './product-paths.js';
import { escapeHtml as html } from './html.js';
import { money, FREE_SHIPPING } from './store.js';
import { lineOptions, orderTotals } from './checkout.js';

export function shelfProducts(shown, known) {
  return shown.map(product => `<article class="product">
      <div class="product-image"><img src="${html(product.image)}" width="580" height="410" alt="" loading="lazy">
      ${!known || product.available === false ? '' : `<button class="product-quick-view" type="button" data-product="${html(product.id)}" aria-label="Quick view ${html(product.name)}">Quick view</button>`}</div>
      <div class="product-info"><p class="origin">${html(product.country)} · ${html(product.profile)}</p><h3>${html(product.name)}</h3><p class="notes">${html(product.shortCopy)}</p>
      <div class="product-actions"><span>${product.available === false ? 'Unavailable' : `From ${money(Math.min(...Object.values(product.prices)))}`}</span><a class="button outline product-open" href="${productPath(product)}" aria-label="View ${html(product.name)}"><span class="product-open-full">View coffee</span><span class="product-open-short">View</span></a></div></div>
    </article>`).join('');
}

export function quantityMarkup(qty, label, key) {
  const line = key === undefined ? '' : ` data-line="${html(key)}"`;
  return `<div class="qty" role="group" aria-label="Quantity for ${html(label)}">
    <button type="button" data-qty="-1"${line} aria-label="Decrease quantity for ${html(label)}" ${qty === 1 ? 'disabled' : ''}>−</button>
    <output aria-live="polite">${qty}</output><button type="button" data-qty="1"${line} aria-label="Increase quantity for ${html(label)}" ${qty === 99 ? 'disabled' : ''}>+</button></div>`;
}

export function cartView(store, retailCheckout, message) {
  const cart = store.cart();
  const notice = [message, store.notice].filter(Boolean).map(text => `<p role="status" class="checkout-note">${html(text)}</p>`).join('');
  if (!cart.length) {
    return `<div class="empty-bag"><h3>Your cart is empty.</h3>${notice}<p>Start with one of the coffees on the shelf.</p>
      <div class="drawer-actions"><button type="button" class="button" data-keep-shopping>Browse coffee</button></div></div>`;
  }
  const totals = store.totals('delivery');
  const { subtotal, shipping } = totals;
  const remaining = Math.max(0, FREE_SHIPPING - subtotal);
  const progress = shipping
    ? remaining ? `Spend over ${money(remaining)} more for free UK delivery.` : 'Add another coffee for free UK delivery.'
    : 'You’ve unlocked free UK delivery.';
  return `<div class="drawer-content">
    ${notice}
    <div class="shipping-progress" aria-live="polite"><span>${progress}</span><progress aria-label="Progress towards free UK delivery" max="${FREE_SHIPPING + 1}" value="${Math.min(subtotal, FREE_SHIPPING + 1)}"></progress></div>
    <ul>${cart.map(line => `<li class="cart-line" data-catalogue-id="${html(line.id)}"><img src="${html(line.product.image)}" alt="" width="64" height="64">
      <div><h3>${html(line.product.name)}</h3><p>${html(lineOptions(line))}</p>
      <div class="cart-controls">${quantityMarkup(line.qty, [line.product.name, lineOptions(line)].join(', '), line.key)}<button type="button" class="remove" data-remove="${html(line.key)}"><span data-cart-remove-label>Remove</span><span class="sr-only"> ${html(line.product.name)}, ${html(lineOptions(line))}</span></button><span class="line-price">${money(line.unitPrice * line.qty)}</span></div></div></li>`).join('')}</ul>
    <div aria-live="polite">${orderTotals(totals, 'delivery')}</div>
    <div class="drawer-actions">${retailCheckout ? '<button class="button" type="button" data-checkout data-return-checkout>Resume checkout</button>' : '<a class="button" href="/checkout/" data-checkout>Checkout</a>'}
      <button class="button outline" type="button" data-keep-shopping>Keep shopping</button></div>
  </div>`;
}

export function giftProducts(gifts) {
  return gifts.map(product => `<article class="shop-gift" data-catalogue-id="${html(product.id)}">
    <img src="${html(product.image)}" alt="${html(product.name)}" width="640" height="480" loading="lazy">
    <div class="shop-gift-copy"><h3>${html(product.name)}</h3>
      <p class="gift-price">${product.available === false ? 'Unavailable' : money(Math.min(...Object.values(product.prices)))}</p>
      <div class="shop-gift-description"><p>${html(product.shortCopy || product.story)}</p></div>
      <a class="button outline" href="${html(productPath(product))}" aria-label="View ${html(product.name)}">View details</a>
    </div></article>`).join('');
}
