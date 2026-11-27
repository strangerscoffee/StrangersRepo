import { orderImagePath } from './account-store.js';
import { escapeHtml as html } from './html.js';
import { money } from './store.js';
import { tampingMarkup } from './checkout-motion.js';

export const sizeNames = { '250g': '250 g', '500g': '500 g', '1kg': '1 kg', '300g': '300 g', one: 'One size' };
export const grindLabel = grind => grind === 'Whole bean' ? 'Beans' : grind === 'N/A' ? '' : grind;
export const orderStatusLabels = {
  placed: 'Order placed', preparing: 'Preparing', ready: 'Ready', dispatched: 'Dispatched',
  completed: 'Complete', cancelled: 'Cancelled',
};

export function lineOptions(line) {
  return [sizeNames[line.size] ?? line.size, grindLabel(line.grind)].filter(Boolean).join(' · ');
}

export function orderTotals({ subtotal, shipping, total }, method) {
  return `<dl class="totals">
    <div><dt>Subtotal</dt><dd>${money(subtotal)}</dd></div>
    <div><dt>${method === 'collection' ? 'Collection' : 'Royal Mail Tracked 48'}</dt><dd>${shipping ? money(shipping) : 'Free'}</dd></div>
    <div class="grand-total"><dt>Total</dt><dd>${money(total)}</dd></div>
  </dl>`;
}

export function progress(step) {
  const names = ['Details', 'Review', 'Confirmation'];
  return `<ol class="retail-checkout-progress" aria-label="Checkout progress">
    ${names.map((name, index) => `<li ${step === index ? 'aria-current="step"' : step > index ? 'class="is-complete"' : ''}><span class="retail-step-number">${index + 1}</span><span data-step-caption>${name}</span></li>`).join('')}
  </ol>`;
}

function lineItems(lines) {
  return `<ul class="retail-checkout-lines">${lines.map(line => `<li>
    <img src="${html(orderImagePath(line.product?.image) || '/consumer-preview/assets/mark.svg')}" alt="" width="54" height="54">
    <div><strong>${html(line.product?.name ?? line.id)}</strong><small>${html(lineOptions(line))} · Qty ${html(line.qty)}</small></div>
    <b>${money(line.qty * line.unitPrice)}</b>
  </li>`).join('')}</ul>`;
}

export function summary(lines, pricing, method, action = '') {
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  return `<aside class="retail-checkout-summary" aria-labelledby="retail-summary-heading">
    <div class="retail-checkout-summary-title"><h2 id="retail-summary-heading">Order summary</h2><span>${count} ${count === 1 ? 'item' : 'items'}</span></div>
    <button type="button" class="retail-checkout-summary-mobile" data-toggle-summary aria-controls="retail-checkout-summary-body" aria-expanded="false"><span>Order summary</span><strong>${money(pricing.total)}<span aria-hidden="true">⌄</span></strong></button>
    <div class="retail-checkout-summary-body" id="retail-checkout-summary-body">
      ${lineItems(lines)}
      ${orderTotals(pricing, method)}
      <p class="retail-checkout-delivery-note" data-method="${method}">${method === 'collection' ? 'Collect from your chosen location once it’s ready' : 'Estimated delivery 2–3 working days from dispatch'}</p>
    </div>
    ${action}
  </aside>`;
}

function field(name, label, value, attributes, className = '') {
  return `<div class="field ${className}"><label for="retail-checkout-${name}">${label}</label><input id="retail-checkout-${name}" name="${name}" value="${html(value)}" ${attributes}></div>`;
}

function methodChoice(value, label, detail, method) {
  return `<label class="retail-checkout-method">
    <input type="radio" name="method" value="${value}"${method === value ? ' checked' : ''}>
    <span><strong>${label}</strong><small>${detail}</small></span>
  </label>`;
}

export function detailsForm({ cafes, method, cafe, contact, signedIn }) {
  const collecting = method === 'collection';
  return `<form id="retail-checkout-form" class="retail-checkout-fields">
    <fieldset class="retail-checkout-card">
      <legend>How would you like your coffee?</legend>
      <div class="retail-checkout-options">
        ${methodChoice('delivery', 'UK delivery', 'Royal Mail Tracked 48', method)}
        ${methodChoice('collection', 'Collect in Norwich', 'Free café collection', method)}
      </div>
    </fieldset>
    <fieldset class="retail-checkout-card">
      <legend>Contact details</legend>
      ${signedIn ? '<p class="retail-checkout-hint" data-saved-details>Checking your saved details…</p>' : `<div class="retail-checkout-guest"><p>Continue as a guest.</p><a class="text-button" href="/account/?return_to=%2Fcheckout%2F" data-checkout-signin>Sign in</a></div>`}
      <div class="retail-checkout-field-grid">
        ${field('name', 'Full name', contact.name, 'required maxlength="120" autocomplete="name"')}
        ${field('email', 'Email address', contact.email, 'required type="email" inputmode="email" maxlength="254" autocomplete="email" autocapitalize="none"')}
        ${field('phone', '<span>Phone</span> <small>Optional</small>', contact.phone, 'type="tel" inputmode="tel" maxlength="32" autocomplete="tel"', 'retail-checkout-span')}
      </div>
    </fieldset>
    <fieldset class="retail-checkout-card" id="retail-checkout-delivery"${collecting ? ' hidden disabled' : ''}>
      <legend>Delivery address</legend>
      <div class="retail-checkout-field-grid">
        ${field('address', 'Street address', contact.address, 'required maxlength="160" autocomplete="address-line1"', 'retail-checkout-span')}
        ${field('town', 'Town or city', contact.town, 'required maxlength="80" autocomplete="address-level2"')}
        ${field('postcode', 'UK postcode', contact.postcode, 'required maxlength="8" autocapitalize="characters" autocomplete="postal-code" pattern="(?:[Gg][Ii][Rr]|[A-Za-z]{1,2}[0-9][0-9A-Za-z]?)[ ]?[0-9][A-Za-z]{2}"')}
      </div>
    </fieldset>
    <fieldset class="retail-checkout-card" id="retail-checkout-collection"${collecting ? '' : ' hidden disabled'}>
      <legend>Collection location</legend>
      <div class="field"><label for="retail-checkout-cafe">Choose a café</label>
        <select name="cafe" id="retail-checkout-cafe">${cafes.map(place => `<option value="${html(place.id)}"${place.id === cafe ? ' selected' : ''}>${html(place.name)}</option>`).join('')}</select>
      </div>
      <p class="retail-checkout-hint" data-collection-address></p>
    </fieldset>
  </form>`;
}

export function reviewDetails({ contact, method, cafe }) {
  const destination = cafe ? [cafe.name, cafe.address] : [contact.address, contact.town, contact.postcode];
  return `<div class="retail-checkout-fields">
    <section class="retail-checkout-card retail-review-card">
      <h2 data-review-method="${method}">${method === 'collection' ? 'Norwich collection' : 'UK delivery'}</h2>
      <address>${destination.map(html).join('<br>')}</address>
    </section>
    <section class="retail-checkout-card retail-review-card">
      <h2 data-contact-heading>Contact details</h2>
      <p>${html(contact.name)}<br>${html(contact.email)}${contact.phone ? '<br>' + html(contact.phone) : ''}</p>
    </section>
    <section class="retail-checkout-card retail-review-card retail-checkout-test">
      <div class="retail-test-card" aria-hidden="true"><span></span><b>••••</b></div>
      <div><h2>Test payment</h2><p>No card details are needed. No payment will be taken.</p></div>
    </section>
    <button type="button" class="text-button" data-checkout-edit>Edit details</button>
  </div>`;
}

export function processingMarkup() {
  return `<div class="retail-checkout-message retail-checkout-processing" role="status">
    ${tampingMarkup()}
    <h2 tabindex="-1">Preparing your receipt</h2>
    <p>We’re saving your test order.</p>
  </div>`;
}

const date = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' });

function timeline(order) {
  const events = Array.isArray(order.timeline) && order.timeline.length ? order.timeline : [{ status: order.status, at: order.createdAt }];
  return `<ol class="retail-checkout-timeline">${events.map(({ status, at }) => {
    const timestamp = new Date(at).getTime();
    const label = status === 'ready' && order.method === 'collection' ? 'Ready to collect' : orderStatusLabels[status] ?? 'Order updated';
    return `<li><strong>${label}</strong>${Number.isFinite(timestamp) ? `<time datetime="${html(at)}">${date.format(timestamp)}</time>` : ''}</li>`;
  }).join('')}</ol>`;
}

function carrierUrl(tracking) {
  if (!tracking?.url || !tracking.number) return '';
  try {
    const link = new URL(tracking.url);
    if (link.protocol === 'https:' && ['royalmail.com', 'www.royalmail.com'].includes(link.hostname)) return link.href;
  } catch {}
  return '';
}

export function receiptMarkup(order, { confirmed, trackingLink, guest }) {
  const { reference, method, lines, pricing, cafe, tracking } = order;
  const destination = cafe ? `${html(cafe.name)}<br>${html(cafe.address)}` : 'Royal Mail Tracked 48';
  const carrier = carrierUrl(tracking);
  return `${confirmed ? progress(2) : ''}
    <section class="retail-checkout-receipt" aria-labelledby="retail-receipt-title">
      <div class="retail-checkout-receipt-head">
        ${confirmed ? '<span class="retail-checkout-receipt-mark" aria-hidden="true">✓</span>' : ''}
        <h2 id="retail-receipt-title" tabindex="-1"${confirmed ? ' data-order-confirmed' : ''}>${confirmed ? 'Your test order is confirmed.' : 'Order ' + html(reference)}</h2>
        <p>No payment was taken and no coffee will be sent.</p>
        <span class="retail-checkout-reference">${html(reference)}</span>
      </div>
      <div class="retail-checkout-layout">
        <div class="retail-checkout-fields">
          <section class="retail-checkout-card retail-review-card">
            <h2 data-updates-heading>Order updates</h2>
            ${timeline(order)}
            ${carrier ? `<a class="button outline" href="${html(carrier)}" target="_blank" rel="noopener noreferrer">Track with Royal Mail</a>` : ''}
            <button type="button" class="text-button" data-checkout-refresh>Refresh order status</button>
            <p role="status" class="retail-checkout-feedback" data-track-feedback></p>
          </section>
          <section class="retail-checkout-card retail-review-card"><h2 data-receipt-method="${cafe ? 'collection' : 'delivery'}">${cafe ? 'Collection location' : 'Delivery service'}</h2><p>${destination}</p></section>
          ${order.contact ? `<section class="retail-checkout-card retail-review-card"><h2 data-contact-heading>Contact details</h2>
            <p>${[order.contact.name, order.contact.email, order.contact.phone].filter(Boolean).map(html).join('<br>')}</p>
            ${method === 'delivery' ? `<address>${[order.contact.address, order.contact.town, order.contact.postcode].filter(Boolean).map(html).join('<br>')}</address>` : ''}
          </section>` : ''}
        </div>
        ${summary(lines, pricing, method)}
      </div>
      <div class="retail-checkout-receipt-actions">
        ${guest ? `<button type="button" class="button" data-copy-tracking>Copy tracking link</button>
          <p>Save your private link to come back to this order.</p>
          <div hidden data-tracking-fallback class="field"><label for="retail-tracking-link">Private tracking link</label><input id="retail-tracking-link" readonly value="${html(trackingLink)}"></div>
          <p role="status" data-tracking-copied class="retail-checkout-feedback"></p>`
          : '<a class="button" href="/account/#orders">View My account</a>'}
        <a class="button outline" href="/coffee/">Continue shopping</a>
      </div>
    </section>`;
}

export const emptyCheckoutMarkup = `<div class="retail-checkout-message"><h2 tabindex="-1">Your cart is empty</h2>
        <p>Choose a coffee to begin.</p><a class="button" href="/coffee/">Shop coffee</a></div>`;

export function priceAction(kind, price, unready = false) {
  const button = kind === 'details'
    ? 'type="submit" form="retail-checkout-form"'
    : 'type="button" data-place-retail-order';
  return `<div class="retail-checkout-action">
    <span class="retail-checkout-action-total"><small>Total</small><strong>${money(price.total)}</strong></span>
    <button class="button" ${button}${unready ? ' disabled' : ''}>${kind === 'details' ? 'Review order' : 'Place test order'}</button>
  </div>`;
}

export function detailsStage(options, failure = '', summaryMarkup = '') {
  return `${progress(0)}<section class="retail-checkout-stage" aria-labelledby="retail-checkout-stage-title">
      <div class="retail-checkout-stage-head">
        <div><h2 id="retail-checkout-stage-title" data-checkout-focus tabindex="-1">Delivery and contact</h2><p>Test checkout. Use sample details.</p></div>
        <button type="button" class="text-button" data-checkout-sample>Fill sample details</button>
      </div>
      <p class="retail-checkout-error" role="alert"${failure ? '' : ' hidden'}>${html(failure)}</p>
      <p class="retail-checkout-error" data-cart-message hidden>A coffee in your cart is unavailable. Remove it before continuing.</p>
      <div class="retail-checkout-layout">
        <div>${detailsForm(options)}</div>
        <div data-checkout-summary>${summaryMarkup}</div>
      </div>
      <button type="button" class="text-button retail-checkout-cart" data-bag>Back to cart</button>
    </section>`;
}

export function reviewStage(options, summaryMarkup = '') {
  return `${progress(1)}<section class="retail-checkout-stage" aria-labelledby="retail-review-title">
      <div class="retail-checkout-stage-head"><div><h2 id="retail-review-title" tabindex="-1" data-checkout-focus>Review your order</h2><p>Check your details before placing the test order.</p></div></div>
      <div class="retail-checkout-layout">${reviewDetails(options)}<div data-checkout-summary>${summaryMarkup}</div></div>
    </section>`;
}
