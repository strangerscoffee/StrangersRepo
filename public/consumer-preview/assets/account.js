import { orderImagePath } from './account-store.js';
import { grindLabel, sizeNames } from './checkout.js';
import { escapeHtml as html } from './html.js';
import { products } from './products.js';
import { money } from './store.js';

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Europe/London' });
const profileFields = ['name', 'phone', 'address', 'town', 'postcode', 'method', 'cafe'];
export const authChangeKey = 'strangers-retail.account-changed';
const fallbackImage = '/consumer-preview/assets/mark.svg';
const orderReference = /^SC-[A-F0-9]{8}$/;

const statusLabels = {
  placed: 'Confirmed', preparing: 'Preparing', ready: 'Ready', dispatched: 'On its way', completed: 'Completed', cancelled: 'Cancelled',
};
const productsById = new Map(products.map(product => [product.id, product]));

function dateMarkup(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}">${dateFormat.format(date)}</time>` : '';
}

function orderStatus(order) {
  return Object.hasOwn(statusLabels, order.status) ? order.status : 'placed';
}

function isTestOrder(order) {
  return order.paymentMode === 'test' || order.paymentStatus === 'test' || order.preview === true;
}

function trackingLink(order) {
  const { carrier, number } = order.tracking ?? {};
  if (order.method !== 'delivery' || carrier !== 'royal-mail' || typeof number !== 'string' || !/^[A-Z0-9]{8,30}$/i.test(number)) return '';
  return `https://www.royalmail.com/track-your-item#/tracking-results/${number.toUpperCase()}`;
}

function orderTimeline(order, status) {
  const collection = order.method === 'collection';
  const stages = [
    ['placed', 'Order confirmed'], ['preparing', 'Preparing your coffee'],
    ['ready', collection ? 'Ready to collect' : 'Packed at the roastery'],
    ...(collection ? [] : [['dispatched', 'Dispatched']]),
    ['completed', collection ? 'Collected' : 'Delivered'],
  ];
  const times = new Map([['placed', order.createdAt]]);
  if (order.tracking?.shippedAt) times.set('dispatched', order.tracking.shippedAt);
  if (Array.isArray(order.timeline)) {
    for (const event of order.timeline) {
      if (event?.at && Object.hasOwn(statusLabels, event.status)) times.set(event.status, event.at);
    }
  }
  const cancelled = status === 'cancelled';
  const steps = cancelled ? [...stages.filter(([id]) => times.has(id)), ['cancelled', 'Cancelled']] : stages;
  const active = steps.findIndex(([id]) => id === status);
  const tracking = trackingLink(order);
  return `<section class="account-delivery-progress" aria-label="Order progress">
    <div class="account-delivery-heading">
      <div><h3>${collection ? 'Collection progress' : 'Delivery progress'}</h3>${order.deliveryService ? `<p>${html(order.deliveryService)}</p>` : ''}</div>
      ${tracking ? `<a class="button outline" href="${tracking}" target="_blank" rel="noopener noreferrer" aria-label="Track parcel with Royal Mail (opens in a new tab)">Track parcel</a>` : ''}
    </div>
    <ol class="account-timeline">
      ${steps.map(([id, label], index) => `<li${index <= active ? ' data-reached' : ''}${id === status ? ' aria-current="step"' : ''}>
        <strong>${label}</strong>${index <= active ? dateMarkup(times.get(id)) : ''}
      </li>`).join('')}
    </ol>
  </section>`;
}

function hasVariant(product, line) {
  return product && product.available !== false && Object.hasOwn(product.prices, line.size) && product.grinds.includes(line.grind);
}

function lineVariantLabel(line) {
  return [sizeNames[line.size] ?? line.size, grindLabel(line.grind)].filter(Boolean).join(' · ');
}

function reorderOptions(lines) {
  const unavailable = lines.filter(line => !hasVariant(productsById.get(line.id), line));
  return {
    available: lines.length - unavailable.length,
    unavailable: unavailable.map(line => {
      const profile = productsById.get(line.id)?.profile ?? line.product.profile;
      const similar = profile && products.find(product => product.id !== line.id && product.profile === profile && hasVariant(product, line));
      return { line, similar };
    }),
  };
}

function orderMarkup(order, { latest, open }) {
  const { reference, createdAt, method, cafe, pricing, lines } = order;
  const label = method === 'collection' ? 'Collection' : 'UK delivery';
  const status = orderStatus(order);
  const statusLabel = method === 'collection' && status === 'ready' ? 'Ready to collect' : statusLabels[status];
  const contactAddress = method === 'delivery' && order.contact?.address
    ? [order.contact.address, order.contact.town, order.contact.postcode].filter(Boolean) : [];
  const { available, unavailable } = reorderOptions(lines);
  return `<li class="account-order">
    <details class="account-order-record${latest ? ' account-order-latest' : ''}" data-order-reference="${html(reference)}"${open ? ' open' : ''}>
      <summary class="account-order-summary">
        <span class="account-order-copy">
          ${latest ? '<small class="account-eyebrow">Latest order</small>' : ''}
          <strong>Order ${html(reference)}</strong>
          <small>${dateMarkup(createdAt)} · ${label}${isTestOrder(order) ? ' · Test order' : ''}</small>
        </span>
        <span class="account-order-price"><span class="account-order-status" data-status="${status}">${statusLabel}</span><strong>${money(pricing.total)}</strong></span>
      </summary>
      <div class="account-order-body">
        ${cafe ? `<p class="account-order-destination">Collection at ${html(cafe.name)}<br>${html(cafe.address)}</p>` : ''}
        ${contactAddress.length ? `<p class="account-order-destination">Delivery address · ${contactAddress.map(html).join(', ')}</p>` : ''}
        <ul class="account-order-lines">${lines.map(line => `<li>
          <img src="${html(orderImagePath(line.product.image) || fallbackImage)}" data-product-image="${html(line.id)}" alt="" width="48" height="48" loading="lazy">
          <div><strong>${html(line.product.name)}</strong><small>${html(lineVariantLabel(line))} · Qty ${html(line.qty)}</small></div>
          <span>${money(line.unitPrice * line.qty)}</span>
        </li>`).join('')}</ul>
        ${orderTimeline(order, status)}
        ${unavailable.length ? `<div class="account-reorder-options">
          <h3>Some items are unavailable</h3>
          <ul>${unavailable.map(({ line, similar }) => `<li><span>${html(line.product.name)} · ${html(lineVariantLabel(line))}</span>
            ${similar ? `<button type="button" class="text-button" data-product="${html(similar.id)}">Try ${html(similar.name)}</button>` : '<a class="text-button" href="/coffee/">Browse coffees</a>'}</li>`).join('')}</ul>
        </div>` : ''}
        <div class="account-order-actions">
          <button type="button" class="button outline" data-account-receipt="${html(reference)}" aria-label="Download receipt ${html(reference)}">Download receipt</button>
          ${available ? `<button type="button" class="button" data-account-reorder="${html(reference)}" aria-label="Add ${unavailable.length ? 'available ' : ''}coffees from ${html(reference)} to cart">${unavailable.length ? 'Reorder available items' : 'Order again'}</button>` : ''}
          ${orderReference.test(reference) ? `<a class="button outline" href="/contact/?order=${encodeURIComponent(reference)}" aria-label="Get order help for ${html(reference)}">Get order help</a>` : ''}
        </div>
        <p class="account-notice" role="status"></p>
      </div>
    </details>
  </li>`;
}

function downloadReceipt(order) {
  const { reference, createdAt, method, lines, pricing } = order;
  if (!orderReference.test(reference)) return;
  const shippingLabel = method === 'collection' ? 'Collection' : order.deliveryService || 'Delivery';
  const content = `<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Strangers Coffee receipt ${html(reference)}</title>
    <style>body{font:16px/1.5 system-ui,sans-serif;color:#17372c;max-width:44rem;margin:3rem auto;padding:0 1.2rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.6rem .25rem;border-bottom:1px solid #cbd4c1}th:last-child,td:last-child{text-align:right}dt,dd{display:inline;margin:0 .5rem 0 0}dd:after{content:'';display:block}</style>
    <main><h1>Strangers Coffee</h1><h2>${isTestOrder(order) ? 'Test order receipt' : 'Order receipt'} ${html(reference)}</h2>
    <p>${dateMarkup(createdAt)} · ${method === 'collection' ? 'Collection' : 'UK delivery'}</p>
    ${isTestOrder(order) ? '<p>No payment was taken for this test order.</p>' : ''}
    <table><thead><tr><th scope="col">Coffee</th><th scope="col">Bags</th><th scope="col">Amount</th></tr></thead><tbody>
    ${lines.map(line => `<tr><td>${html(line.product.name)}<br>${html(lineVariantLabel(line))}</td><td>${html(line.qty)}</td><td>${money(line.unitPrice * line.qty)}</td></tr>`).join('')}</tbody></table>
    <dl><div><dt>Subtotal</dt><dd>${money(pricing.subtotal)}</dd></div>
    <div><dt>${html(shippingLabel)}</dt><dd>${money(pricing.shipping)}</dd></div>
    <div><dt><strong>Total</strong></dt><dd><strong>${money(pricing.total)}</strong></dd></div></dl></main></html>`;
  const href = URL.createObjectURL(new Blob([content], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `strangers-receipt-${reference}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

async function accountRequest(options = {}) {
  let response;
  try {
    response = await fetch('/api/account', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10000),
      ...options,
      headers: { Accept: 'application/json', ...(options.headers ?? {}) },
    });
  } catch {
    throw new Error('We couldn’t reach your account. Try again.');
  }
  if (response.status === 401) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw Object.assign(new Error(typeof body?.message === 'string' ? body.message : 'Your account is temporarily unavailable. Try again.'), { code: body?.error });
  }
  return body;
}

export function getServerAccount() {
  return accountRequest();
}


const passwordMin = 12;
const authModes = {
  login: {
    heading: 'Sign in to My account',
    copy: 'Use your email and password to view orders and saved details.',
    fields: ['email', 'password'],
    submit: 'Sign in',
    links: ['register', 'forgot'],
  },
  register: {
    heading: 'Create your account',
    copy: 'Enter your email and we’ll send a link to set up your Strangers account.',
    fields: ['email'],
    submit: 'Send setup link',
    links: ['login'],
  },
  forgot: {
    heading: 'Reset your password',
    copy: 'Enter the email you use for your Strangers account.',
    fields: ['email'],
    submit: 'Send reset link',
    links: ['login'],
  },
  setup: {
    heading: 'Set up your account',
    copy: 'Add your name and choose a password for your Strangers account.',
    fields: ['name', 'password'],
    submit: 'Set up account',
    links: ['register', 'login'],
  },
  reset: {
    heading: 'Choose a new password',
    copy: 'Enter the new password you’d like to use for your Strangers account.',
    fields: ['password'],
    submit: 'Save password',
    links: ['forgot', 'login'],
  },
};
const modeLabels = { login: 'Back to sign in', register: 'Create an account', forgot: 'Forgot password?' };

function authField(name, mode) {
  if (name === 'email') {
    return '<div class="field"><label for="account-auth-email">Email address</label><input id="account-auth-email" name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" maxlength="254" required></div>';
  }
  if (name === 'name') {
    return '<div class="field"><label for="account-auth-name">Full name</label><input id="account-auth-name" name="name" autocomplete="name" maxlength="120" required></div>';
  }
  const newPassword = mode === 'setup' || mode === 'reset';
  return `<div class="field">
    <label for="account-auth-password">${newPassword ? 'New password' : 'Password'}</label>
    <div class="account-password-field">
      <input id="account-auth-password" name="password" type="password" autocomplete="${newPassword ? 'new-password' : 'current-password'}" maxlength="128"${newPassword ? ` minlength="${passwordMin}" aria-describedby="account-password-hint"` : ''} required>
      <button type="button" data-account-show-password aria-label="Show password" aria-pressed="false">Show</button>
    </div>
    ${newPassword ? `<p class="account-password-hint" id="account-password-hint">Use at least ${passwordMin} characters.</p>` : ''}
  </div>`;
}

async function authRequest(action, values) {
  let response;
  try {
    response = await fetch('/consumer-auth/' + action, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(values),
    });
  } catch {
    throw new Error('We couldn’t reach your account. Try again.');
  }

  const body = await response.json().catch(() => null);
  const accepted = action === 'register' || action === 'forgot'
    ? body?.accepted === true
    : body?.signedIn === (action !== 'logout');
  if (!response.ok || !accepted) {
    throw new Error(body?.message || 'We couldn’t complete that request. Try again.');
  }
}

function announceAuthChange() {
  try { localStorage.setItem(authChangeKey, crypto.randomUUID()); } catch {}
}

export function setupAccount(root, reorder) {
  const access = root.querySelector('#account-access');
  const accessTitle = root.querySelector('#account-access-title');
  const accessCopy = root.querySelector('#account-access-copy');
  const accessStatus = root.querySelector('#account-access-status');
  const retry = root.querySelector('#account-retry');
  const authPanel = root.querySelector('#account-auth');
  const authForm = root.querySelector('#account-auth-form');
  const authFields = root.querySelector('#account-auth-fields');
  const authSubmit = root.querySelector('#account-auth-submit');
  const authStatus = root.querySelector('#account-auth-status');
  const authLinks = root.querySelector('#account-auth-links');
  const dashboard = root.querySelector('#account-dashboard');
  const dashboardStatus = root.querySelector('#account-dashboard-status');
  const session = root.querySelector('#account-session');
  const heroTitle = root.querySelector('#account-title');
  const heroLabel = root.querySelector('#account-hero-label');
  const avatar = root.querySelector('#account-avatar');
  const signOut = root.querySelector('#account-sign-out');
  const orderHistory = root.querySelector('#account-order-history');
  const form = root.querySelector('#account-profile');
  const controls = [...form.querySelectorAll('fieldset, button[type=submit]')];
  const saveStatus = root.querySelector('#account-save-status');
  const cafeField = root.querySelector('#account-cafe-field');
  const details = root.querySelector('#account-details');
  const overview = root.querySelector('#account-overview');
  const savedAddress = root.querySelector('#account-saved-address');
  const noAddress = root.querySelector('#account-no-address');
  const editAddress = root.querySelector('#account-edit-address');
  const tabs = [...root.querySelectorAll('[data-account-tab]')];
  const url = new URL(window.location.href);
  const requestedMode = url.searchParams.get('mode');
  const requestedReturn = url.searchParams.get('return_to');
  const returnPath = ['/coffee/', '/checkout/'].includes(requestedReturn) ? requestedReturn : '/account/';
  let token;
  if (requestedMode === 'setup' || requestedMode === 'reset') {
    token = window.takeStrangersAccountLink?.() ?? new URLSearchParams(url.hash.slice(1)).get('token');
    if (url.hash) window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }

  let currentOrders = [];
  let currentSession = null;
  let accountVisible = false;
  let loadSequence = 0;
  let saving = false;
  let authPending = false;
  let authMode = null;

  function setAuthLinks(modes) {
    authLinks.replaceChildren(...modes.map(mode => {
      const link = document.createElement('a');
      const query = new URLSearchParams({ mode });
      if (returnPath !== '/account/') query.set('return_to', returnPath);
      link.href = '/account/?' + query;
      link.textContent = modeLabels[mode];
      return link;
    }));
  }

  function concealAccount() {
    accountVisible = false;
    dashboard.hidden = true;
    session.hidden = true;
    updateGreeting('');
  }

  function showAccess() {
    concealAccount();
    currentSession = null;
    authMode = null;
    currentOrders = [];
    orderHistory.replaceChildren();
    form.reset();
    saveStatus.textContent = '';
    dashboardStatus.textContent = '';
    controls.forEach(control => { control.disabled = true; });
    updateSavedAddress({});
    access.hidden = false;
    authPanel.hidden = true;
    retry.hidden = true;
  }

  function showAuth(mode, message = '') {
    showAccess();
    authMode = mode;
    const config = authModes[mode];
    const linked = mode === 'setup' || mode === 'reset';
    const missingToken = linked && !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token ?? '');

    authPanel.hidden = false;
    accessTitle.textContent = missingToken ? 'Request a new link' : config.heading;
    accessCopy.textContent = missingToken ? 'This email link is incomplete or has already been opened.' : config.copy;
    accessStatus.textContent = message;
    authStatus.textContent = '';
    authStatus.classList.remove('account-save-error');
    authForm.hidden = missingToken;
    authForm.action = '/consumer-auth/' + mode;
    authFields.innerHTML = missingToken ? '' : config.fields.map(name => authField(name, mode)).join('');
    authFields.disabled = false;
    authSubmit.disabled = false;
    authSubmit.textContent = config.submit;
    setAuthLinks(missingToken ? [mode === 'setup' ? 'register' : 'forgot', 'login'] : config.links);
  }

  function showMailNotice(mode) {
    authFields.replaceChildren();
    authForm.hidden = true;
    accessTitle.textContent = 'Check your email';
    accessCopy.textContent = mode === 'register'
      ? 'If this address can be used to create an account, we’ll send a setup link.'
      : 'If there’s an account for this address, we’ll send a reset link.';
    accessStatus.textContent = '';
    setAuthLinks(['login']);
    accessTitle.focus({ preventScroll: true });
  }

  authForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (authPending || authForm.hidden || !authMode) return;
    const mode = authMode;
    const values = Object.fromEntries(authModes[mode].fields.map(name => {
      const value = authForm.elements[name].value;
      return [name, name === 'password' ? value : value.trim()];
    }));
    if (mode === 'setup' || mode === 'reset') values.token = token;

    authPending = true;
    authFields.disabled = true;
    authSubmit.disabled = true;
    authStatus.classList.remove('account-save-error');
    authStatus.textContent = mode === 'register' || mode === 'forgot' ? 'Sending your link…' : 'Please wait…';
    let navigating = false;
    try {
      await authRequest(mode, values);
      authForm.reset();
      if (mode === 'register' || mode === 'forgot') {
        showMailNotice(mode);
        return;
      }
      token = null;
      announceAuthChange();
      window.location.replace(returnPath);
      navigating = true;
    } catch (error) {
      authStatus.textContent = error.message;
      authStatus.classList.add('account-save-error');
    } finally {
      if (!navigating) {
        authPending = false;
        authFields.disabled = false;
        authSubmit.disabled = false;
      }
    }
  });

  authForm.addEventListener('click', event => {
    const toggle = event.target.closest('[data-account-show-password]');
    if (!toggle) return;
    const password = authForm.elements.password;
    const visible = password.type === 'password';
    password.type = visible ? 'text' : 'password';
    toggle.textContent = visible ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(visible));
  });

  function syncCafeField() {
    cafeField.hidden = form.elements.method.value !== 'collection';
    form.elements.cafe.disabled = cafeField.hidden;
  }

  function fillProfile(profile, email) {
    for (const name of profileFields) form.elements[name].value = profile[name] ?? '';
    form.elements.email.value = email;
    if (!form.elements.method.value) form.elements.method.value = 'delivery';
    if (!form.elements.cafe.value) form.elements.cafe.selectedIndex = 0;
    syncCafeField();
    updateSavedAddress(profile);
  }

  function updateSavedAddress(profile) {
    savedAddress.textContent = [profile.address, profile.town, profile.postcode].filter(Boolean).join('\n');
    savedAddress.hidden = !savedAddress.textContent;
    noAddress.hidden = !savedAddress.hidden;
    editAddress.textContent = savedAddress.hidden ? 'Add address' : 'Edit address';
  }

  function updateGreeting(name) {
    const firstName = typeof name === 'string' ? name.trim().split(/\s+/)[0] : '';
    heroTitle.textContent = firstName ? `Welcome back, ${firstName}.` : 'My account';
    heroLabel.hidden = avatar.hidden = !firstName;
    avatar.textContent = firstName ? Array.from(firstName)[0].toUpperCase() : '';
  }

  function showDashboard(name) {
    accountVisible = true;
    authMode = null;
    updateGreeting(name);
    dashboardStatus.textContent = '';
    const previous = new Map([...orderHistory.querySelectorAll('[data-order-reference]')]
      .map(record => [record.dataset.orderReference, record.open]));
    orderHistory.innerHTML = currentOrders.length
      ? `<ul class="account-order-list">${currentOrders.map((order, index) => orderMarkup(order, {
        latest: index === 0,
        open: previous.get(order.reference) ?? (index === 0),
      })).join('')}</ul>`
      : '<div class="account-empty"><h3>No orders yet</h3><p>Your coffee orders will appear here after checkout.</p><a href="/coffee/" class="button">Shop coffee</a></div>';
    controls.forEach(control => { control.disabled = saving; });
    access.hidden = true;
    dashboard.hidden = false;
    session.hidden = false;
  }

  async function refreshOrders() {
    const sequence = ++loadSequence;
    concealAccount();
    try {
      const account = await getServerAccount();
      if (sequence !== loadSequence) return;
      if (!account) {
        if (authMode !== 'login') showAuth('login');
        return;
      }
      if (!account.identity?.email || !/^[a-f0-9]{64}$/.test(account.profileSession) || !account.profile || !Array.isArray(account.orders)) {
        throw new Error('Your account is temporarily unavailable. Try again.');
      }
      const email = account.identity.email;
      if (currentSession !== account.profileSession) {
        showAccess();
        fillProfile(account.profile, email);
      }
      currentSession = account.profileSession;
      currentOrders = account.orders;
      showDashboard(account.profile.name || account.identity.name || '');
    } catch (error) {
      if (sequence !== loadSequence) return;
      showAccess();
      accessTitle.textContent = 'Your Strangers account';
      accessStatus.textContent = error.message;
      retry.hidden = false;
    }
  }

  function switchTab(tab) {
    const showingDetails = tab === 'details';
    details.hidden = !showingDetails;
    overview.hidden = showingDetails;
    for (const button of tabs) {
      button.setAttribute('aria-pressed', String(button.dataset.accountTab === tab));
    }
  }

  function syncTab() {
    switchTab(window.location.hash === '#details' ? 'details' : 'orders');
  }

  function openTab(tab) {
    if (window.location.hash !== `#${tab}`) window.history.pushState(null, '', `#${tab}`);
    switchTab(tab);
  }

  for (const button of tabs) {
    button.addEventListener('click', () => openTab(button.dataset.accountTab));
  }
  editAddress.addEventListener('click', () => {
    openTab('details');
    form.elements.address.focus();
  });
  window.addEventListener('popstate', () => {
    syncTab();
    resumeAccount();
  });
  window.addEventListener('hashchange', syncTab);
  syncTab();

  retry.addEventListener('click', () => {
    showAccess();
    accessStatus.textContent = 'Loading your account…';
    void refreshOrders();
  });

  signOut.addEventListener('click', async () => {
    if (signOut.disabled) return;
    signOut.disabled = true;
    loadSequence += 1;
    concealAccount();
    try {
      await authRequest('logout', {});
      announceAuthChange();
      showAuth('login');
      window.location.replace('/account/');
    } catch (error) {
      signOut.disabled = false;
      await refreshOrders();
      (accountVisible ? dashboardStatus : accessStatus).textContent = error.message;
    }
  });

  form.elements.method.addEventListener('change', syncCafeField);
  form.addEventListener('input', event => {
    saveStatus.textContent = '';
    if (event.target === form.elements.phone) form.elements.phone.setCustomValidity('');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !accountVisible || !currentSession) return;
    const profileSession = currentSession;
    const email = form.elements.email.value;
    const values = Object.fromEntries(profileFields.map(name => [name, form.elements[name].value.trim()]));
    if (values.phone && (!/^\+?[0-9 ().-]+$/.test(values.phone) || !/^\d{7,15}$/.test(values.phone.replace(/\D/g, '')))) {
      form.elements.phone.setCustomValidity('Enter a phone number with 7 to 15 digits.');
      form.elements.phone.reportValidity();
      return;
    }
    const postcode = values.postcode.toUpperCase().replace(/ /g, '');
    values.postcode = postcode ? `${postcode.slice(0, -3)} ${postcode.slice(-3)}` : '';
    saving = true;
    saveStatus.textContent = 'Saving details…';
    saveStatus.classList.remove('account-save-error');
    controls.forEach(control => { control.disabled = true; });

    try {
      const result = await accountRequest({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Retail-Profile-Session': profileSession },
        body: JSON.stringify(values),
      });
      if (currentSession !== profileSession) return;
      if (!result) {
        showAuth('login', 'Sign in again to update your account details.');
        accessTitle.focus({ preventScroll: true });
        return;
      }
      if (!result.profile) throw new Error('Your details couldn’t be saved. Try again.');
      fillProfile(result.profile, email);
      if (accountVisible) updateGreeting(result.profile.name || '');
      saveStatus.textContent = 'Account details saved.';
    } catch (error) {
      if (currentSession === profileSession && error.code === 'account_changed') {
        showAccess();
        void refreshOrders();
      } else if (currentSession === profileSession) {
        saveStatus.textContent = error.message;
        saveStatus.classList.add('account-save-error');
      }
    } finally {
      saving = false;
      if (accountVisible) controls.forEach(control => { control.disabled = false; });
    }
  });

  orderHistory.addEventListener('error', event => {
    const image = event.target;
    if (!image.matches('img[data-product-image]') || image.getAttribute('src') === fallbackImage) return;
    const current = orderImagePath(productsById.get(image.dataset.productImage)?.image);
    image.src = current && image.getAttribute('src') !== current ? current : fallbackImage;
  }, true);

  orderHistory.addEventListener('click', event => {
    const button = event.target.closest('[data-account-reorder], [data-account-receipt]');
    if (!button || !accountVisible) return;
    const receipt = button.dataset.accountReceipt;
    const order = currentOrders.find(record => record.reference === (receipt ?? button.dataset.accountReorder));
    if (!order) return;
    if (receipt) return downloadReceipt(order);
    const lines = order.lines.filter(line => hasVariant(productsById.get(line.id), line));
    const added = reorder({ ...order, lines }, button);
    button.closest('.account-order-body').querySelector('.account-notice').textContent =
      added === 0 ? 'These coffees or quantities are unavailable to add to your cart.' : '';
  });

  if (Object.hasOwn(authModes, requestedMode)) {
    showAuth(requestedMode);
    accessTitle.focus({ preventScroll: true });
  } else {
    void refreshOrders();
  }
  function suspendAccount() {
    loadSequence += 1;
    concealAccount();
  }

  function resumeAccount() {
    if (!authPending && !signOut.disabled && (!authMode || authMode === 'login')) void refreshOrders();
  }

  window.addEventListener('pagehide', suspendAccount);
  window.addEventListener('blur', suspendAccount);
  window.addEventListener('focus', resumeAccount);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspendAccount();
    else resumeAccount();
  });
  window.addEventListener('storage', event => {
    if (event.key !== authChangeKey) return;
    suspendAccount();
    if (!authPending && !signOut.disabled && (!authMode || authMode === 'login')) {
      showAccess();
      if (!document.hidden) resumeAccount();
    }
  });
  return resumeAccount;
}
