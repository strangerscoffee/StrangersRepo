import { authChangeKey } from './account.js';
import { clearOrderAttempt, loadRetailOrder, orderReferencePattern, orderTokenPattern, pendingOrderAttempt, placeRetailOrder, prepareOrderAttempt, trackingPath } from './beta-orders.js';
import { detailsForm, processingMarkup, progress, receiptMarkup, reviewDetails, summary } from './checkout.js';
import { escapeHtml as html } from './html.js';
import { money } from './store.js';

const draftKey = 'strangers-coffee-retail.checkout-return.v1';
const contactFields = ['name', 'email', 'phone', 'address', 'town', 'postcode'];
const maxDraftAge = 30 * 60 * 1000;
const sampleContact = { name: 'Jamie Reed', email: 'jamie@example.com', phone: '', address: '12 Example Lane', town: 'Norwich', postcode: 'NR2 1AA' };

function readReturnDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null');
    sessionStorage.removeItem(draftKey);
    if (draft?.contact && Date.now() - draft.at < maxDraftAge) return draft;
  } catch {}
  return null;
}

function saveReturnDraft(draft) {
  try { sessionStorage.setItem(draftKey, JSON.stringify({ ...draft, at: Date.now() })); } catch {}
}

function lineSelections(lines) {
  return lines.map(({ id, size, grind, qty }) => ({ id, size, grind, qty }));
}

function sameSelection(first, second) {
  return first.length === second.length && first.every(line =>
    second.some(other => line.id === other.id && line.size === other.size && line.grind === other.grind && line.qty === other.qty));
}

function focusHeading(root) {
  const heading = root.querySelector('[data-checkout-focus], .retail-checkout-message h2, #retail-receipt-title');
  if (!heading) return;
  heading.focus({ preventScroll: true });
  if (heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: 'nearest' });
}

export function setupRetailCheckout(root, { cafes, store, cartChanged, getServerAccount, availability }) {
  const header = document.getElementById('retail-checkout-heading');
  const cafeById = new Map(cafes.map(cafe => [cafe.id, cafe]));
  const defaultCafe = cafeById.has('dove-street') ? 'dove-street' : cafes[0]?.id;
  const returnDraft = readReturnDraft();
  const previous = pendingOrderAttempt();
  const resumed = returnDraft;
  const contact = Object.fromEntries(contactFields.map(name => [name, String(resumed?.contact?.[name] ?? '')]));
  const dirty = new Set(contactFields.filter(name => contact[name]));
  let method = resumed?.method === 'collection' ? 'collection' : 'delivery';
  let cafe = cafeById.has(resumed?.cafe) ? resumed.cafe : defaultCafe;
  let auth = document.body.hasAttribute('data-retail-signed-in') || previous && previous.identity !== 'guest' ? 'loading' : 'guest';
  let accountIdentity;
  let receiptIdentity;
  let sessionSequence = 0;
  let phase = '';
  let reviewed = null;
  let posting = false;
  let trackingSequence = 0;
  let receipt = null;
  let trackingToken = '';
  let receiptReference;
  let summaryOpen = false;

  function formNow() {
    return root.querySelector('#retail-checkout-form');
  }

  function collectForm(form) {
    if (!form) return;
    for (const name of contactFields) contact[name] = form.elements[name].value.trim();
    method = form.elements.method.value;
    cafe = form.elements.cafe.value;
  }

  function priceAction(kind, price, unready = false) {
    const button = kind === 'details'
      ? 'type="submit" form="retail-checkout-form"'
      : 'type="button" data-place-retail-order';
    return `<div class="retail-checkout-action">
      <span class="retail-checkout-action-total"><small>Total</small><strong>${money(price.total)}</strong></span>
      <button class="button" ${button}${unready ? ' disabled' : ''}>${kind === 'details' ? 'Review order' : 'Place test order'}</button>
    </div>`;
  }

  function paintSummary(lines, pricing, kind, unready = false) {
    const slot = root.querySelector('[data-checkout-summary]');
    if (!slot) return;
    slot.innerHTML = summary(lines, pricing, method, priceAction(kind, pricing, unready));
    const toggle = slot.querySelector('[data-toggle-summary]');
    if (summaryOpen) {
      toggle.setAttribute('aria-expanded', 'true');
      toggle.closest('aside').classList.add('is-summary-open');
    }
  }

  function rememberContact(snapshot) {
    for (const name of contactFields) {
      if (!dirty.has(name) && !contact[name] && snapshot[name]) contact[name] = snapshot[name];
    }
    const form = formNow();
    if (!form) return;
    for (const name of contactFields) {
      const input = form.elements[name];
      if (!dirty.has(name) && !input.value && contact[name]) input.value = contact[name];
    }
  }

  function updateProfileHint() {
    const hint = root.querySelector('[data-saved-details]');
    if (!hint) return;
    const states = {
      loading: 'Checking your saved details…',
      ready: 'Your saved details are filled in. You can change them for this order.',
      guest: 'You can enter details and continue as a guest.',
    };
    hint.textContent = states[auth];
    if (auth === 'guest') {
      const signIn = document.createElement('a');
      signIn.href = '/account/?return_to=%2Fcheckout%2F';
      signIn.dataset.checkoutSignin = '';
      signIn.textContent = 'Sign in';
      hint.append(' ', signIn);
    }
  }

  function updateFulfilment(form) {
    const collect = method === 'collection';
    const address = root.querySelector('#retail-checkout-delivery');
    const collection = root.querySelector('#retail-checkout-collection');
    address.hidden = address.disabled = collect;
    collection.hidden = collection.disabled = !collect;
    const collectionAddress = root.querySelector('[data-collection-address]');
    collectionAddress.textContent = cafeById.get(cafe)?.address ?? '';
    collectionAddress.id = 'retail-collection-address';
    form.elements.cafe.setAttribute('aria-describedby', collectionAddress.id);
  }

  function updateDetails() {
    if (phase !== 'details') return;
    const form = formNow();
    const lines = store.cart();
    if (!lines.length) {
      renderDetails(false);
      return;
    }
    if (!form) {
      renderDetails(false);
      return;
    }
    collectForm(form);
    updateFulfilment(form);
    const unavailable = lines.some(line => line.product.available === false);
    const notice = root.querySelector('[data-cart-message]');
    notice.hidden = !unavailable;
    paintSummary(lines, store.totals(method), 'details', !availability.known || unavailable);
  }

  function renderDetails(focus = false, failure = '') {
    phase = 'details';
    header.textContent = 'Checkout';
    const lines = store.cart();
    if (!lines.length) {
      root.innerHTML = `<div class="retail-checkout-message"><h2 tabindex="-1">Your cart is empty</h2>
        <p>Choose a coffee to begin.</p><a class="button" href="/coffee/">Shop coffee</a></div>`;
      if (focus) focusHeading(root);
      return;
    }
    root.innerHTML = `${progress(0)}<section class="retail-checkout-stage" aria-labelledby="retail-checkout-stage-title">
      <div class="retail-checkout-stage-head">
        <div><h2 id="retail-checkout-stage-title" data-checkout-focus tabindex="-1">Delivery and contact</h2><p>Test checkout. Use sample details.</p></div>
        <button type="button" class="text-button" data-checkout-sample>Fill sample details</button>
      </div>
      <p class="retail-checkout-error" role="alert"${failure ? '' : ' hidden'}>${html(failure)}</p>
      <p class="retail-checkout-error" data-cart-message hidden>A coffee in your cart is unavailable. Remove it before continuing.</p>
      <div class="retail-checkout-layout">
        <div>${detailsForm({ cafes, method, cafe, contact, signedIn: auth !== 'guest' })}</div>
        <div data-checkout-summary></div>
      </div>
      <button type="button" class="text-button retail-checkout-cart" data-bag>Back to cart</button>
    </section>`;
    updateProfileHint();
    updateDetails();
    if (focus) focusHeading(root);
  }

  function clearContact() {
    for (const name of contactFields) contact[name] = '';
    dirty.clear();
    reviewed = null;
    method = 'delivery';
    cafe = defaultCafe;
  }

  function renderSessionGate(message) {
    phase = 'session';
    header.textContent = 'Checkout';
    root.hidden = false;
    root.innerHTML = `<div class="retail-checkout-message"><h2 tabindex="-1">Check your checkout session</h2><p>${html(message)}</p>
      <div class="retail-checkout-receipt-actions"><button class="button outline" type="button" data-checkout-recheck>Check again</button>
      <a class="button" href="/account/?mode=login&amp;return_to=%2Fcheckout%2F">Sign in</a>
      <button class="button outline" type="button" data-checkout-guest>Continue as a guest</button></div></div>`;
  }

  function renderReview() {
    phase = 'review';
    const { payload, lines, pricing } = reviewed;
    const selectCafe = payload.method === 'collection' ? cafeById.get(payload.cafe) : null;
    root.innerHTML = `${progress(1)}<section class="retail-checkout-stage" aria-labelledby="retail-review-title">
      <div class="retail-checkout-stage-head"><div><h2 id="retail-review-title" tabindex="-1" data-checkout-focus>Review your order</h2><p>Check your details before placing the test order.</p></div></div>
      <div class="retail-checkout-layout">${reviewDetails({ contact: payload.contact, method: payload.method, cafe: selectCafe })}<div data-checkout-summary></div></div>
    </section>`;
    paintSummary(lines, pricing, 'review');
    focusHeading(root);
  }

  function renderRecovery(message = 'Try again to confirm the same test order. You won’t create a duplicate from this attempt.', signIn = false) {
    phase = 'recovery';
    header.textContent = 'Checkout';
    root.innerHTML = `${progress(1)}<section class="retail-checkout-message" aria-labelledby="retail-recover-heading">
      <h2 id="retail-recover-heading" tabindex="-1">Confirm your test order</h2>
      <p>${html(message)}</p>
      ${signIn ? '<a class="button" href="/account/?mode=login&amp;return_to=%2Fcheckout%2F">Sign in to continue</a> <button type="button" class="button outline" data-checkout-recheck>Check again</button>' : '<button type="button" class="button" data-retry-retail-order>Confirm order</button>'}
    </section>`;
    focusHeading(root);
  }

  function renderReceipt(confirmed, focus = false) {
    phase = 'receipt';
    header.textContent = confirmed ? 'Order confirmation' : 'Track your order';
    const link = new URL(trackingPath(receipt.reference, trackingToken), window.location.origin).href;
    root.innerHTML = receiptMarkup(receipt, { confirmed, trackingLink: link, guest: Boolean(trackingToken) });
    if (focus) focusHeading(root);
  }

  function renderTrackingFailure(message) {
    receipt = null;
    phase = 'tracking';
    root.hidden = false;
    header.textContent = 'Track your order';
    root.innerHTML = `<div class="retail-checkout-message"><h2 tabindex="-1">Order unavailable</h2><p>${html(message)}</p>
      <div class="retail-checkout-receipt-actions"><button type="button" class="button" data-retry-retail-tracking>Try again</button>
      <a class="button outline" href="/account/#orders">My account</a></div></div>`;
    focusHeading(root);
  }

  async function loadReceipt(reference, token, refreshing = false, identity) {
    const request = ++trackingSequence, session = sessionSequence;
    const current = () => request === trackingSequence && session === sessionSequence;
    phase = 'tracking';
    root.hidden = false;
    header.textContent = 'Track your order';
    root.innerHTML = '<p class="retail-checkout-message" role="status">Opening your order…</p>';
    try {
      const result = await loadRetailOrder(reference, token, identity?.session);
      if (!current()) return;
      receipt = result.order;
      receiptReference = reference;
      receiptIdentity = identity?.email;
      trackingToken = token;
      renderReceipt(false, !refreshing);
      if (refreshing) root.querySelector('[data-track-feedback]').textContent = 'Order status refreshed.';
    } catch (error) {
      if (!current()) return;
      renderTrackingFailure([401, 403, 404, 409].includes(error.status)
        ? 'We couldn’t open this order. Check your tracking link or open it from My account.'
        : 'We couldn’t load this order right now. Try again.');
    }
  }

  function renderLegacyRecovery() {
    phase = 'recovery';
    root.hidden = false;
    root.innerHTML = `<div class="retail-checkout-message"><h2 tabindex="-1">Check for your test order</h2>
      <p>Open your order history under the account that started this checkout. If the order is absent, you can start a new checkout.</p>
      <div class="retail-checkout-receipt-actions"><a class="button" href="/account/#orders">My account</a>
      <button class="button outline" type="button" data-checkout-reset-attempt>Start a new checkout</button></div></div>`;
  }

  async function submit(currentAttempt, firstSubmission = false) {
    if (!currentAttempt || posting) return;
    const guest = currentAttempt.identity === 'guest';
    const expectedSession = guest ? 'guest' : accountIdentity?.session;
    if (!guest && (auth !== 'ready' || currentAttempt.identity?.email !== accountIdentity?.email)) {
      renderRecovery('Sign in to the Strangers account that started this order to confirm the same attempt.', true);
      return;
    }
    posting = true;
    phase = 'processing';
    root.innerHTML = processingMarkup();
    focusHeading(root);
    const animation = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 860));
    try {
      const result = await placeRetailOrder(currentAttempt, expectedSession);
      receipt = result.order;
      receiptReference = result.order.reference;
      receiptIdentity = guest ? null : currentAttempt.identity.email;
      trackingToken = orderTokenPattern.test(result.claimToken ?? '') ? result.claimToken : '';
      store.consume(currentAttempt.payload.lines);
      clearOrderAttempt();
      cartChanged();
      await animation;
      if (receiptIdentity && auth === 'ready' && receiptIdentity !== accountIdentity?.email) {
        receipt = null;
        receiptReference = null;
        clearContact();
        renderDetails(true, 'Your account changed. Open My account to view orders for the current account.');
      } else if (receiptIdentity && auth === 'unavailable') {
        receipt = null;
        receiptReference = null;
        clearContact();
        renderSessionGate('Sign in to view orders from your account.');
      } else {
        if (!receiptIdentity || auth === 'ready') history.replaceState(history.state, '', trackingPath(receipt.reference, trackingToken));
        renderReceipt(true, true);
      }
    } catch (error) {
      if (!guest && (error.status === 401 || ['checkout_session_changed', 'checkout_session_unverified'].includes(error.code))) {
        // The gateway rejects this first submission before forwarding it. An earlier uncertain retry must keep its key.
        if (firstSubmission && error.code === 'checkout_session_unverified') clearOrderAttempt();
        void verifySession();
        return;
      }
      if ([400, 409, 422].includes(error.status) && error.code !== 'idempotency_conflict') {
        clearOrderAttempt();
        store.refresh();
        renderDetails(true, error.message);
        return;
      }
      renderRecovery(error.status === 429 ? 'Checkout is busy. Wait a moment and try the same order again.'
        : 'We couldn’t confirm your order. Try again to check the same test order.');
    } finally {
      posting = false;
    }
  }

  root.addEventListener('change', event => {
    if (phase !== 'details' || !event.target.form) return;
    dirty.add(event.target.name);
    if (['method', 'cafe'].includes(event.target.name)) updateDetails();
  });
  root.addEventListener('input', event => {
    if (phase === 'details' && event.target.form) dirty.add(event.target.name);
  });

  root.addEventListener('submit', event => {
    const form = formNow();
    if (event.target !== form || phase !== 'details') return;
    event.preventDefault();
    if (auth !== 'ready' && auth !== 'guest') return;
    collectForm(form);
    for (const name of contactFields) form.elements[name].value = contact[name];
    if (!form.reportValidity()) return;
    if (method === 'delivery') {
      const postcode = contact.postcode.toUpperCase().replace(/ /g, '');
      contact.postcode = postcode.slice(0, -3) + ' ' + postcode.slice(-3);
    }
    store.refresh();
    const lines = store.cart();
    if (!availability.known || !lines.length || lines.some(line => line.product.available === false)) {
      cartChanged();
      return;
    }
    reviewed = {
      lines,
      identity: auth === 'guest' ? 'guest' : accountIdentity,
      pricing: store.totals(method),
      payload: {
        method,
        cafe: method === 'collection' ? cafe : null,
        deliveryService: method === 'delivery' ? 'royal-mail-tracked-48' : null,
        contact: { ...contact, ...(method === 'collection' ? { address: '', town: '', postcode: '' } : {}) },
        lines: lineSelections(lines),
      },
    };
    renderReview();
  });

  root.addEventListener('click', async event => {
    const control = event.target.closest('button,a');
    if (!control || !root.contains(control)) return;
    if (control.hasAttribute('data-toggle-summary')) {
      summaryOpen = control.closest('aside').classList.toggle('is-summary-open');
      control.setAttribute('aria-expanded', String(summaryOpen));
    }
    if (control.hasAttribute('data-checkout-signin')) {
      collectForm(formNow());
      saveReturnDraft({ contact, method, cafe });
    }
    if (control.hasAttribute('data-checkout-sample')) {
      const form = formNow();
      for (const [name, value] of Object.entries(sampleContact)) {
        form.elements[name].value = value;
        dirty.add(name);
      }
      collectForm(form);
      form.elements.name.focus({ preventScroll: true });
    }
    if (control.hasAttribute('data-checkout-edit')) renderDetails(true);
    if (control.hasAttribute('data-checkout-recheck')) void verifySession();
    if (control.hasAttribute('data-checkout-reset-attempt') && pendingOrderAttempt()?.identity === 'account') {
      clearOrderAttempt();
      clearContact();
      void verifySession();
    }
    if (control.hasAttribute('data-checkout-guest')) {
      ++sessionSequence;
      auth = 'guest';
      accountIdentity = null;
      clearContact();
      renderDetails(true);
    }
    if (control.hasAttribute('data-place-retail-order') && phase === 'review') {
      store.refresh();
      if (!sameSelection(reviewed.payload.lines, store.cart())) {
        cartChanged();
        renderDetails(true, 'Your cart changed. Review your order again.');
        return;
      }
      if (!reviewed || reviewed.identity !== (auth === 'guest' ? 'guest' : accountIdentity) || auth === 'loading') return;
      const existingAttempt = pendingOrderAttempt();
      void submit(prepareOrderAttempt(reviewed.payload, reviewed.identity), !existingAttempt);
    }
    if (control.hasAttribute('data-retry-retail-order')) void submit(pendingOrderAttempt());
    if (control.hasAttribute('data-checkout-refresh') || control.hasAttribute('data-retry-retail-tracking')) {
      const reference = receiptReference || requestedOrder;
      const token = trackingToken || requestedToken;
      if (reference && token) await loadReceipt(reference, token, true);
      else if (reference) await verifySession(true);
    }
    if (control.hasAttribute('data-copy-tracking')) {
      const fallback = root.querySelector('[data-tracking-fallback]');
      const input = fallback.querySelector('input');
      try {
        await navigator.clipboard.writeText(input.value);
        root.querySelector('[data-tracking-copied]').textContent = 'Tracking link copied.';
      } catch {
        fallback.hidden = false;
        input.focus();
        input.select();
      }
    }
  });

  const url = new URL(window.location.href);
  const requestedOrder = url.searchParams.get('order');
  const token = url.hash.slice(1);
  const requestedToken = orderTokenPattern.test(token) ? token : '';

  function suspendSession() {
    if (auth === 'guest') return;
    ++sessionSequence;
    root.hidden = true;
    auth = 'loading';
  }

  async function verifySession(refreshingReceipt = false) {
    if (auth === 'guest') return;
    suspendSession();
    const sequence = sessionSequence;
    let account;
    try { account = await getServerAccount(); } catch {}
    if (sequence !== sessionSequence) return;
    const email = account?.identity?.email, session = account?.profileSession;
    const active = pendingOrderAttempt();
    const signedReceipt = !trackingToken && (requestedOrder || (['receipt', 'tracking'].includes(phase) && receiptReference));
    root.hidden = false;
    if (active?.identity === 'account' && !signedReceipt) {
      renderLegacyRecovery();
      return;
    }
    if (!email || !/^[a-f0-9]{64}$/.test(session ?? '')) {
      auth = 'unavailable';
      accountIdentity = null;
      receipt = null;
      clearContact();
      if (signedReceipt) {
        renderTrackingFailure('Sign in to the account for this order or use its tracking link.');
      } else if (active && active.identity !== 'guest') {
        renderRecovery('Sign in to the Strangers account that started this order to confirm the same attempt.', true);
      } else {
        renderSessionGate('Sign in to use your saved details, or continue as a guest with new details.');
      }
      return;
    }

    auth = 'ready';
    const unchanged = accountIdentity?.session === session;
    const changed = !!accountIdentity && !unchanged;
    if (!unchanged) accountIdentity = { session, email };
    if (signedReceipt) {
      if (receiptIdentity && receiptIdentity !== email) {
        renderTrackingFailure('Open this order from the Strangers account that placed it.');
        return;
      }
      await loadReceipt(signedReceipt, '', refreshingReceipt, accountIdentity);
      if (sequence === sessionSequence && receipt && !requestedOrder) {
        history.replaceState(history.state, '', trackingPath(receipt.reference));
      }
      return;
    }
    if (changed) clearContact();
    if (active && !posting) {
      const sameAccount = active.identity === 'guest' || active.identity?.email === email;
      renderRecovery(sameAccount ? undefined : 'Sign in to the Strangers account that started this order to confirm the same attempt.', !sameAccount);
      return;
    }
    if (posting && phase === 'processing') return;
    if ((phase === 'receipt' || phase === 'review') && !changed) return;
    if (phase !== 'details' || changed) renderDetails(false, changed ? 'Your account changed. Review your new checkout details.' : '');
    const profile = { ...account.profile, email };
    const form = formNow();
    if (form && (!resumed || changed) && !dirty.has('method') && !dirty.has('cafe')) {
      form.elements.method.value = method = profile.method === 'collection' ? 'collection' : 'delivery';
      form.elements.cafe.value = cafe = cafeById.has(profile.cafe) ? profile.cafe : defaultCafe;
    }
    rememberContact(profile);
    updateDetails();
    updateProfileHint();
  }

  function resumeSession() {
    if (auth !== 'guest') void verifySession();
  }

  if (requestedOrder && !orderReferencePattern.test(requestedOrder)) {
    header.textContent = 'Track your order';
    root.innerHTML = '<div class="retail-checkout-message"><h2 tabindex="-1">Invalid tracking link</h2><p>Check the link or open your order from My account.</p><a class="button" href="/account/#orders">My account</a></div>';
    return updateDetails;
  }

  if (requestedOrder && requestedToken) {
    auth = 'guest';
    void loadReceipt(requestedOrder, requestedToken);
  } else if (requestedOrder) {
    auth = 'loading';
    void verifySession();
  } else if (previous?.identity === 'account') {
    renderLegacyRecovery();
  } else if (previous?.identity === 'guest') {
    auth = 'guest';
    renderRecovery();
  } else if (auth === 'guest') {
    renderDetails();
  } else {
    root.innerHTML = '<p role="status">Checking your checkout session…</p>';
    void verifySession();
  }
  window.addEventListener('pagehide', suspendSession);
  window.addEventListener('pageshow', event => { if (event.persisted) resumeSession(); });
  window.addEventListener('blur', suspendSession);
  window.addEventListener('focus', resumeSession);
  window.addEventListener('popstate', resumeSession);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspendSession();
    else resumeSession();
  });
  window.addEventListener('storage', event => {
    if (event.key !== authChangeKey || auth === 'guest') return;
    if (document.hidden) suspendSession();
    else resumeSession();
  });
  return updateDetails;
}
