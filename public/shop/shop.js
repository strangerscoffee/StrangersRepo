const shop = '/shop/';
const liveSite = 'https://strangerscoffee.com';
const basketKey = 'strangers.retail-preview.basket.v1';
const quantityLimit = 30;
const main = document.querySelector('#main');
const countBadge = document.querySelector('#basket-count');
const toast = document.querySelector('.shop-toast');
const currency = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const price = pence => currency.format(pence / 100);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const photo = name => `${shop}photos/${encodeURIComponent(name)}.webp`;
const detailPath = product => `${shop}coffee/${encodeURIComponent(product.slug)}/`;
const productImage = (product, index = 0) => photo(product.photos[index]);
const arrow = '<span aria-hidden="true">↗</span>';
const categories = new Map([
  ['all', 'All'], ['single-origin', 'Single origins'], ['blends', 'Blends'], ['decaf', 'Decaf'], ['gifts', 'Gift cards'],
]);
const categoryNames = { 'single-origin': 'Single origin', blends: 'Blend', decaf: 'Decaf', gifts: 'Gift card' };
const locations = [
  { name: 'Strangers Coffee Roasters', address: '10 Dove Street', postcode: 'NR2 1DE', image: 'dove-street', service: 'Takeaway · On-site roastery', hours: [['Mon–Sat', '8.30 am–4.30 pm'], ['Sunday', '10.30 am–3.30 pm']] },
  { name: 'Strangers Coffee House', address: '21 Pottergate', postcode: 'NR2 1DS', image: 'pottergate', service: 'Indoor and outdoor seating · Takeaway', hours: [['Mon–Sat', '8.30 am–4.30 pm'], ['Sunday', '9 am–3 pm']] },
  { name: 'Strangers All Saints Green', address: '14 All Saints Green', postcode: 'NR1 3NA', image: 'all-saints-green', service: 'Takeaway', hours: [['Mon–Fri', '8 am–4 pm'], ['Saturday', '8.30 am–4.30 pm'], ['Sunday', '10.30 am–3.30 pm']] },
];
const guides = [
  { name: 'AeroPress', image: 'aeropress', recipe: '12 g coffee · 200 g water · 2:30', steps: [
    'Grind the coffee medium. Rinse the paper filter with hot water and warm the cup.',
    'Start the timer and pour 30 g of water over the grounds. Stir three times.',
    'At 30 seconds, add the remaining 170 g of water.',
    'At two minutes, stir three times. Press gently for 30 seconds and stop when you hear air escape.',
  ] },
  { name: 'V60 & drip filter', image: 'filter', recipe: '18 g coffee · 300 g water · 2:45', steps: [
    'Grind the coffee medium and rinse the paper filter with hot water.',
    'Start the timer, pour 50 g of water, and gently stir to wet all the grounds.',
    'At 30 seconds, add 125 g of water evenly. At 1:30, add the final 125 g and swirl the brewer once.',
    'Let the water drain. Aim to finish between 2:30 and 2:45.',
  ] },
  { name: 'French press', image: 'french-press', recipe: '30 g coffee · 500 g water · 10 min', steps: [
    'Grind medium-coarse. Warm the press with hot water, then empty it.',
    'Start the timer, add the coffee and pour over 500 g of filtered water.',
    'At four minutes, stir three times to break the crust and skim off any foam.',
    'Push the plunger down just to the surface. At ten minutes, pour into mugs.',
  ] },
  { name: 'Espresso', image: 'espresso', recipe: 'Home espresso basics', steps: [] },
];
let products = [];
let basket = [];
let toastTimer;
const [page = '', slug = ''] = location.pathname.slice(shop.length).split('/');

function announce(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toastTimer = setTimeout(() => { toast.textContent = ''; }, 4200);
}

function linesFor(entries) {
  return entries.flatMap(entry => {
    const product = products.find(item => item.slug === entry?.slug);
    const variant = product?.variants.find(option => option.id === entry?.variant && option.available);
    const quantity = entry?.quantity;
    return variant && Number.isInteger(quantity) && quantity > 0 && quantity <= quantityLimit
      ? [{ slug: product.slug, variant: variant.id, quantity, product, option: variant }] : [];
  });
}

function readBasket() {
  try {
    const value = JSON.parse(localStorage.getItem(basketKey) || '[]');
    return Array.isArray(value) ? linesFor(value) : [];
  } catch {
    return [];
  }
}

function updateBadge() {
  const count = basket.reduce((total, line) => total + line.quantity, 0);
  countBadge.textContent = count ? String(count) : '';
  countBadge.hidden = !count;
  const link = document.querySelector('#basket-link');
  link.setAttribute('aria-label', count ? `Basket, ${count} ${count === 1 ? 'item' : 'items'}` : 'Basket');
}

function saveBasket(entries) {
  const clean = linesFor(entries);
  try {
    localStorage.setItem(basketKey, JSON.stringify(clean.map(({ slug, variant, quantity }) => ({ slug, variant, quantity }))));
  } catch {
    announce('This browser could not save your preview basket.');
    return false;
  }
  basket = clean;
  updateBadge();
  return true;
}

function addToBasket(product, option, quantity) {
  const existing = basket.find(line => line.variant === option.id);
  const current = existing?.quantity ?? 0;
  if (current + quantity > quantityLimit) {
    announce(`The preview basket allows up to ${quantityLimit} of each option.`);
    return;
  }
  const next = existing
    ? basket.map(line => line === existing ? { ...line, quantity: current + quantity } : line)
    : [...basket, { slug: product.slug, variant: option.id, quantity }];
  if (saveBasket(next)) announce(`${quantity} × ${product.title} added to basket`);
}

function heading(title, copy = '') {
  return `<div class="page-heading"><h1>${escape(title)}</h1>${copy ? `<p>${escape(copy)}</p>` : ''}</div>`;
}

function card(product, index) {
  const saleable = product.variants.filter(variant => variant.available);
  const lowest = saleable.reduce((min, variant) => Math.min(min, variant.pence), Infinity);
  return `<a class="product-card glass" href="${detailPath(product)}">
    <img class="card-photo" src="${productImage(product)}" alt="" loading="${index < 3 ? 'eager' : 'lazy'}" decoding="async">
    <div class="card-content"><p class="product-meta">${categoryNames[product.category]}</p><h3>${escape(product.title)}</h3>
      ${product.notes ? `<p class="notes">${escape(product.notes)}</p>` : ''}</div>
    <div class="card-price"><strong>${saleable.length ? `From ${price(lowest)}` : 'Sold out'}</strong><span class="card-arrow">${arrow}</span></div>
  </a>`;
}

function home() {
  const links = [
    ['locations/', 'Visit us', 'Find our roastery and coffee shops in Norwich.'],
    ['brew-guides/', 'Brew at home', 'Recipes for AeroPress, filter and French press.'],
    ['coffee/?category=gifts', 'Coffee gift cards', 'Choose an online or in-store voucher.'],
  ];
  return `<section class="hero glass">
    <div class="hero-copy"><p class="eyebrow">Independent since 2009</p><h1>Coffee from the heart of Norwich.</h1>
      <p>Explore single origins, house blends and decaf, roasted at our Dove Street roastery.</p>
      <a class="shop-button" href="${shop}coffee/">Shop coffee <span aria-hidden="true">→</span></a></div>
    <div class="hero-visual"><img src="${photo('roastery')}" width="1000" height="750" fetchpriority="high" alt="Inside the Strangers Coffee roastery">
      <span class="hero-caption">Dove Street roastery, Norwich</span></div>
  </section>
  <section class="home-section" aria-labelledby="featured-heading"><div class="section-head"><h2 id="featured-heading">On the coffee shelf</h2><a href="${shop}coffee/">View all coffee <span aria-hidden="true">→</span></a></div>
    <div class="product-grid">${products.slice(0, 3).map(card).join('')}</div></section>
  <nav class="feature-links" aria-label="Explore Strangers">${links.map(([url, title, copy]) => `<a class="feature-link glass" href="${shop + url}"><h3>${title}</h3><p class="muted">${copy}</p><span class="link-text">Explore ${arrow}</span></a>`).join('')}</nav>`;
}

function catalogue() {
  const search = new URLSearchParams(location.search);
  let category = categories.has(search.get('category')) ? search.get('category') : 'all';
  main.innerHTML = `${heading('Shop coffee', 'Single origins, blends and gift cards from Strangers Coffee Company.')}
    <div class="catalogue-tools glass">
      <div class="filters" role="group" aria-label="Categories">${[...categories].map(([id, name]) => `<button type="button" data-filter="${id}" aria-pressed="${id === category}">${name}</button>`).join('')}</div>
      <label class="shop-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="Search coffee" placeholder="Search coffee" maxlength="100"></label>
    </div>
    <p class="result-count" role="status"></p><div class="product-grid" id="products"></div>`;
  const input = main.querySelector('input');
  const filters = [...main.querySelectorAll('[data-filter]')];
  input.value = (search.get('q') || '').slice(0, 100);
  function filter() {
    const q = input.value.trim().toLowerCase();
    const shown = products.filter(product => (category === 'all' || product.category === category)
      && `${product.title} ${product.notes} ${categoryNames[product.category]}`.toLowerCase().includes(q));
    main.querySelector('.result-count').textContent = `${shown.length} ${shown.length === 1 ? 'product' : 'products'}`;
    main.querySelector('#products').innerHTML = shown.length ? shown.map(card).join('') : '<p class="muted">No products match. Try another search or category.</p>';
  }
  function saveFilters() {
    const url = new URL(location.href);
    if (category === 'all') url.searchParams.delete('category');
    else url.searchParams.set('category', category);
    if (input.value) url.searchParams.set('q', input.value);
    else url.searchParams.delete('q');
    history.replaceState(history.state, '', url);
    filter();
  }
  input.addEventListener('input', saveFilters);
  for (const button of filters) button.addEventListener('click', () => {
    category = button.dataset.filter;
    for (const option of filters) option.setAttribute('aria-pressed', String(option === button));
    saveFilters();
  });
  filter();
}

const quantityControl = (quantity, label) => `<div class="quantity" role="group" aria-label="${escape(label)}">
  <button type="button" aria-label="Decrease quantity" data-step="-1" ${quantity <= 1 ? 'disabled' : ''}>−</button>
  <output aria-label="Quantity">${quantity}</output>
  <button type="button" aria-label="Increase quantity" data-step="1" ${quantity >= quantityLimit ? 'disabled' : ''}>+</button>
</div>`;

function displayQuantity(control, quantity) {
  control.querySelector('output').value = String(quantity);
  control.querySelector('[data-step="-1"]').disabled = quantity <= 1;
  control.querySelector('[data-step="1"]').disabled = quantity >= quantityLimit;
}

function productPage(product) {
  document.title = `${product.title} · Strangers Coffee Company`;
  const initial = product.variants.find(variant => variant.available) || product.variants[0];
  const valuesFor = (index, variants = product.variants) => [...new Set(variants.map(option => option.choices[index]))];
  const optionsFor = choices => choices.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
  main.innerHTML = `<p class="breadcrumb"><a class="link-text" href="${shop}coffee/">← Shop coffee</a></p>
    <div class="detail-grid"><section class="gallery glass" aria-label="Product photos">
      <img class="detail-photo" src="${productImage(product)}" alt="${escape(product.title)}" fetchpriority="high">
      ${product.photos.length > 1 ? `<div class="thumbnails">${product.photos.map((name, index) => `<button type="button" data-photo="${index}" aria-label="Photo ${index + 1}" aria-pressed="${!index}"><img src="${photo(name)}" alt=""></button>`).join('')}</div>` : ''}
    </section><div class="detail-panel glass"><p class="product-meta">${categoryNames[product.category]}</p><h1>${escape(product.title)}</h1>
      ${product.notes ? `<p class="detail-notes">${escape(product.notes)}</p>` : ''}
      ${product.description ? `<p class="muted">${escape(product.description)}</p>` : ''}
      <form class="product-form">
        <div class="variant-fields">${product.options.map((name, index) => `<label class="retail-field">${name}<select>${optionsFor(valuesFor(index))}</select></label>`).join('')}</div>
        <div class="purchase-row"><strong class="detail-price" aria-live="polite"></strong>${quantityControl(1, 'Order quantity')}<button class="shop-button" type="submit">Add to basket</button></div>
      </form>
      <p class="mini-detail">${product.digital ? 'Digital gift card' : 'UK delivery'} · <a class="link-text" href="${shop}shipping/">Delivery &amp; returns</a> · <a class="link-text" href="${escape(product.url)}">Buy on the live shop ${arrow}</a></p>
    </div></div>`;
  const form = main.querySelector('form');
  const [primary, secondary] = form.querySelectorAll('select');
  const amount = form.querySelector('.detail-price');
  const add = form.querySelector('button[type=submit]');
  const thumbnails = [...main.querySelectorAll('[data-photo]')];
  const image = main.querySelector('.detail-photo');
  const control = form.querySelector('.quantity');
  let quantity = 1;
  let selected;
  primary.value = initial.choices[0];
  if (secondary) secondary.value = initial.choices[1];
  function update() {
    const group = product.variants.filter(option => option.choices[0] === primary.value);
    if (secondary) {
      const current = secondary.value;
      const values = valuesFor(1, group);
      secondary.innerHTML = optionsFor(values);
      secondary.value = values.includes(current) ? current : values[0];
    }
    selected = group.find(option => !secondary || option.choices[1] === secondary.value);
    add.disabled = !selected?.available;
    add.textContent = add.disabled ? 'Sold out' : 'Add to basket';
    amount.textContent = selected ? price(selected.pence) : '';
  }
  primary.addEventListener('change', update);
  secondary?.addEventListener('change', update);
  for (const button of control.querySelectorAll('[data-step]')) button.addEventListener('click', () => {
    quantity += Number(button.dataset.step);
    displayQuantity(control, quantity);
    if (button.disabled) control.querySelector('button:not(:disabled)')?.focus();
  });
  for (const button of thumbnails) button.addEventListener('click', () => {
    for (const option of thumbnails) option.setAttribute('aria-pressed', String(option === button));
    image.src = productImage(product, Number(button.dataset.photo));
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (selected?.available) addToBasket(product, selected, quantity);
  });
  update();
}

function totals() {
  const subtotal = basket.reduce((sum, line) => sum + line.option.pence * line.quantity, 0);
  const grams = basket.reduce((sum, line) => sum + line.option.grams * line.quantity, 0);
  const posted = basket.some(line => !line.product.digital);
  const postage = !posted || subtotal > 4500 ? 0 : grams < 499 ? 300 : 350;
  return { subtotal, postage, posted };
}

function totalsPanel() {
  const { subtotal, postage, posted } = totals();
  return `<dl><div><dt>Subtotal</dt><dd>${price(subtotal)}</dd></div>
    <div><dt>${posted ? 'Estimated UK delivery' : 'Delivery'}</dt><dd>${postage ? price(postage) : 'Free'}</dd></div>
    <div class="summary-total"><dt>Estimated total</dt><dd>${price(subtotal + postage)}</dd></div></dl>`;
}

function emptyBasket(title) {
  return `${heading(title)}<section class="prose-panel glass"><h2>Your basket is empty</h2><a class="shop-button" href="${shop}coffee/">Shop coffee</a></section>`;
}

function basketPage() {
  if (!basket.length) { main.innerHTML = emptyBasket('Basket'); return; }
  main.innerHTML = `${heading('Basket')}
    <div class="basket-grid"><section class="basket-list glass" aria-label="Basket items">${basket.map(line => `<article class="basket-line" data-line="${escape(line.variant)}">
      <img src="${productImage(line.product)}" alt="" loading="lazy"><div><h2><a href="${detailPath(line.product)}">${escape(line.product.title)}</a></h2><p class="mini-detail">${escape(line.option.choices.join(' · '))}</p></div>
      <div class="line-actions"><strong data-line-price>${price(line.option.pence * line.quantity)}</strong>${quantityControl(line.quantity, `Quantity for ${line.product.title}`)}<button class="link-button" type="button" data-remove aria-label="Remove ${escape(line.product.title)}">Remove</button></div></article>`).join('')}
    </section><section class="summary glass" aria-label="Basket summary"><h2>Order summary</h2><div id="totals">${totalsPanel()}</div>
      <a class="shop-button" href="${shop}checkout/">Preview checkout</a><a class="link-text" href="${shop}coffee/">Continue shopping</a></section></div>`;
  main.querySelector('.basket-list').addEventListener('click', event => {
    const button = event.target.closest('[data-step], [data-remove]');
    if (!button) return;
    const row = button.closest('[data-line]');
    const index = basket.findIndex(line => line.variant === row.dataset.line);
    const line = basket[index];
    if (button.hasAttribute('data-remove')) {
      if (!saveBasket(basket.filter(item => item !== line))) return;
      announce(`${line.product.title} removed from basket`);
      if (!basket.length) {
        basketPage();
        main.focus();
      } else {
        const adjacent = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        main.querySelector('#totals').innerHTML = totalsPanel();
        adjacent?.querySelector('[data-remove]').focus();
      }
      return;
    }
    const quantity = line.quantity + Number(button.dataset.step);
    if (!saveBasket(basket.map((item, position) => position === index ? { ...item, quantity } : item))) return;
    const control = row.querySelector('.quantity');
    displayQuantity(control, quantity);
    row.querySelector('[data-line-price]').textContent = price(line.option.pence * quantity);
    main.querySelector('#totals').innerHTML = totalsPanel();
    if (button.disabled) control.querySelector('button:not(:disabled)')?.focus();
  });
}

function checkoutPage() {
  if (!basket.length) { main.innerHTML = emptyBasket('Checkout'); return; }
  main.innerHTML = `${heading('Preview checkout', 'Try the checkout flow without placing a real order or entering payment details.')}
    <div class="basket-grid"><section class="prose-panel glass"><h2>${totals().posted ? 'UK delivery' : 'Email delivery'}</h2>
      <p class="muted">${totals().posted ? 'Royal Mail Tracked 48 is the standard delivery option. Your final postage is confirmed at checkout on the live shop.' : 'Online gift cards are delivered by email on the live shop.'}</p>
      <a href="${shop}basket/" class="link-text">← Back to basket</a></section>
      <section class="summary glass" aria-label="Order review"><h2>Review your basket</h2><ul class="checkout-lines">${basket.map(line => `<li><span>${line.quantity} × ${escape(line.product.title)}<br><small class="muted">${escape(line.option.choices.join(' · '))}</small></span><strong>${price(line.option.pence * line.quantity)}</strong></li>`).join('')}</ul>
      ${totalsPanel()}<button class="shop-button" type="button" id="finish-preview">Complete preview checkout</button></section></div>`;
  main.querySelector('#finish-preview').addEventListener('click', () => {
    if (!saveBasket([])) return;
    main.innerHTML = `${heading('Preview checkout complete')}
      <section class="prose-panel glass"><p>No order was sent and no payment was taken. To buy coffee, visit the live Strangers shop.</p>
      <a class="shop-button" href="${liveSite}/coffee">Visit the live shop ${arrow}</a><a class="link-text" href="${shop}coffee/">Continue exploring the preview</a></section>`;
    main.focus();
  });
}

function visit() {
  return `${heading('Visit us in Norwich', 'Three places to stop for a coffee or pick up a freshly roasted bag.')}
    <div class="info-grid">${locations.map(place => `<article class="info-card glass"><img src="${photo(place.image)}" alt="" loading="lazy">
      <div class="info-copy"><h2>${place.name}</h2><p class="muted">${place.service}</p><address>${place.address}<br>Norwich ${place.postcode}</address>
      <dl>${place.hours.map(([days, times]) => `<div><dt>${days}</dt><dd>${times}</dd></div>`).join('')}</dl>
      <a class="link-text" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(`${place.address}, Norwich ${place.postcode}`)}">Get directions ${arrow}</a></div></article>`).join('')}</div>`;
}

function brewing() {
  return `${heading('Brew guides', 'Recipes from the roastery for making Strangers coffee at home.')}
    <div class="info-grid">${guides.map(guide => `<article class="info-card glass"><img src="${photo(guide.image)}" alt="" loading="lazy">
      <div class="info-copy"><h2>${guide.name}</h2><p class="muted">${guide.recipe}</p>${guide.steps.length ? `<details><summary>Show recipe</summary><ol>${guide.steps.map(step => `<li>${step}</li>`).join('')}</ol></details>` : `<a class="link-text" href="${liveSite}/brewguides">Watch on the live site ${arrow}</a>`}</div></article>`).join('')}</div>`;
}

function about() {
  return `${heading('About Strangers')}
    <section class="hero glass"><div class="hero-copy"><h2>Independent coffee in Norwich since 2009.</h2>
      <p>Alex Sargeant and Samuel Maddocks founded Strangers Coffee Company in 2009. William Maddocks joined in 2014. Today we source speciality coffee from producers around the world and roast it at our Dove Street roastery.</p>
      <a href="${shop}locations/" class="shop-button">Find our shops</a></div>
      <div class="hero-visual"><img src="${photo('roastery')}" alt="Inside the Strangers Coffee roastery"></div></section>`;
}

function contact() {
  return `${heading('Contact us')}<section class="prose-panel glass"><h2>Get in touch</h2>
    <p>Ask us about a coffee, an online order or one of our Norwich shops.</p>
    <a class="link-text" href="mailto:sales@strangerscoffee.com">sales@strangerscoffee.com</a>
    <a class="shop-button" href="${liveSite}/contact">Open the contact form ${arrow}</a>
    <a class="link-text" href="${shop}locations/">Find your nearest Strangers</a></section>`;
}

function shipping() {
  return `${heading('Delivery & returns')}<section class="prose-panel glass"><h2>UK delivery</h2>
    <p>Strangers uses Royal Mail Tracked 48 as standard. Postage is £3 for lighter parcels and £3.50 for heavier ones, with free standard delivery on UK orders over £45.</p>
    <h2>Returns and ground coffee</h2><p>Check the live shop’s policy for returns, delivery estimates and custom orders such as ground coffee.</p>
    <a class="shop-button" href="${liveSite}/shipping">Read the full policy ${arrow}</a></section>`;
}

const pages = { locations: ['Locations', visit], 'brew-guides': ['Brew guides', brewing], about: ['About', about], contact: ['Contact', contact], shipping: ['Delivery & returns', shipping] };

function render() {
  document.title = 'Strangers Coffee Company';
  if (page === 'basket') basketPage();
  else if (page === 'checkout') checkoutPage();
  else if (page === 'coffee' && slug) {
    const product = products.find(item => item.slug === slug);
    if (product) productPage(product);
    else main.innerHTML = `${heading('Coffee not found')}<a class="shop-button" href="${shop}coffee/">Browse the shop</a>`;
  } else if (page === 'coffee') catalogue();
  else if (pages[page]) main.innerHTML = pages[page][1]();
  else main.innerHTML = home();
  const title = pages[page]?.[0] ?? ({ coffee: 'Shop coffee', basket: 'Basket', checkout: 'Checkout' })[page];
  if (title && !slug) document.title = `${title} · Strangers Coffee Company`;
  main.setAttribute('aria-busy', 'false');
}

try {
  const response = await fetch(`${shop}catalogue.json`);
  if (!response.ok) throw new Error('Catalogue unavailable');
  products = await response.json();
  basket = readBasket();
  updateBadge();
  document.querySelector(`[data-nav="${escape(page)}"]`)?.setAttribute('aria-current', 'page');
  render();
  const syncBasket = () => {
    basket = readBasket();
    updateBadge();
    if (page === 'basket' || page === 'checkout') render();
  };
  window.addEventListener('pageshow', event => { if (event.persisted) syncBasket(); });
  window.addEventListener('storage', event => { if (event.key === basketKey) syncBasket(); });
} catch {
  main.innerHTML = `${heading('The preview couldn’t load')}<a class="shop-button" href="${liveSite}/coffee">Visit the live shop ${arrow}</a>`;
  main.setAttribute('aria-busy', 'false');
}
