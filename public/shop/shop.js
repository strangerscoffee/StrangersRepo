const shop = '/shop/';
const liveSite = 'https://strangerscoffee.com';
const basketKey = 'strangers.retail-preview.basket.v1';
const quantityLimit = 30;
const main = document.querySelector('#main');
const header = document.querySelector('.shop-header');
const countBadge = document.querySelector('#basket-count');
const toast = document.querySelector('.shop-toast');
const currency = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const price = pence => currency.format(pence / 100);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const photo = name => `${shop}photos/${encodeURIComponent(name)}.webp`;
const detailPath = product => `${shop}coffee/p/${encodeURIComponent(product.slug)}/`;
const productImage = (product, index = 0) => photo(product.photos[index]);
const previewPath = path => path === '/' ? shop : `${shop}${path.replace(/^\/+|\/+$/g, '')}/`;
const arrow = '<span aria-hidden="true">↗</span>';
const categories = new Map([
  ['all', 'All'], ['single-origin', 'Single origins'], ['blends', 'Blends'], ['decaf', 'Decaf'], ['gifts', 'Gift cards'],
]);
const categoryNames = { 'single-origin': 'Single origin', blends: 'Blend', decaf: 'Decaf', gifts: 'Gift card' };
const bestSellers = ['brazil-fazenda-bom-jesus-natural', 'ethiopia-rocko-mountain-natural', 'colombia-campo-santo-washed', 'decaf-colombia-san-lorenzo'];
const socialPosts = [
  ['DfmZDCpKJOb', 'Christmas Blend coffee'], ['DecIAsLKnVU', 'Brazil Bom Jesus coffee'],
  ['Dc-3i8gK3Qu', 'Ethiopian coffee on the café table'], ['DclGVm4KhB9', 'Latte outside the café'],
  ['DcjHgInqXxQ', 'Coffee brewing setup'], ['DcRE83wikpV', 'Barista recruitment post'],
];
const locations = [
  { name: 'Strangers Coffee Roasters', address: '10 Dove Street', postcode: 'NR2 1DE', image: 'dove-street', service: 'Takeaway · On-site roastery', hours: [['Mon–Sat', '8.30 am–4.30 pm'], ['Sunday', '10.30 am–3.30 pm']] },
  { name: 'Strangers Coffee House', address: '21 Pottergate', postcode: 'NR2 1DS', image: 'pottergate', service: 'Indoor and outdoor seating · Takeaway', hours: [['Mon–Sat', '8.30 am–4.30 pm'], ['Sunday', '9 am–3 pm']] },
  { name: 'Strangers All Saints Green', address: '14 All Saints Green', postcode: 'NR1 3NA', image: 'all-saints-green', service: 'Takeaway', hours: [['Mon–Fri', '8 am–4 pm'], ['Saturday', '8.30 am–4.30 pm'], ['Sunday', '10.30 am–3.30 pm']] },
];
let products = [];
let siteContent;
let basket = [];
let toastTimer;
const [requestedPage = '', ...segments] = location.pathname.slice(shop.length).split('/').filter(Boolean);
const aliases = { home: '', location: 'locations', brewguides: 'brew-guides', cart: 'basket' };
const page = aliases[requestedPage] ?? requestedPage;
const slug = segments[0] === 'p' ? segments[1] : segments[0];

document.addEventListener('focusin', ({ target }) => {
  if (!target.matches(':focus-visible') || !target.closest('main, footer')) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== target || getComputedStyle(header).position !== 'sticky') return;
    const clearTop = header.getBoundingClientRect().bottom + 8;
    const targetTop = target.getBoundingClientRect().top;
    if (targetTop < clearTop) window.scrollBy({ top: targetTop - clearTop, behavior: 'instant' });
  });
});

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
    ['coffee/', 'Shop coffee', 'Single origins, blends and decaf.', 'brazil-fazenda-bom-jesus-natural'],
    ['locations/', 'Our locations', 'Find our roastery and coffee shops in Norwich.', 'dove-street'],
    ['brew-guides/', 'Brew guides', 'Recipes for AeroPress, filter and French press.', 'filter'],
  ];
  const approach = [
    ['From green beans to final roast', 'We sample every coffee before buying it, then develop a roast profile around its flavour. Every roasted batch is checked before it goes on sale.'],
    ['Quality and traceability', 'We share where each coffee comes from and how it was grown and processed, so you can follow its journey from farm to roastery.'],
    ['A changing coffee shelf', 'Our single origins follow the harvests. Familiar favourites stay on the shelf alongside seasonal coffees.'],
  ];
  return `<section class="hero glass">
    <div class="hero-copy"><p class="eyebrow">Independent since 2009</p><h1>Coffee from the heart of Norwich.</h1>
      <p>Speciality coffee made with 100% arabica beans, roasted at our Dove Street roastery and delivered across the UK.</p>
      <a class="shop-button" href="${shop}coffee/">Shop coffee <span aria-hidden="true">→</span></a></div>
    <div class="hero-visual"><img src="${photo('roastery')}" width="1000" height="750" fetchpriority="high" alt="Inside the Strangers Coffee roastery">
      <span class="hero-caption">Dove Street roastery, Norwich</span></div>
  </section>
  <section class="home-section" aria-labelledby="featured-heading"><div class="section-head"><h2 id="featured-heading">On the coffee shelf</h2><a href="${shop}coffee/">View all coffee <span aria-hidden="true">→</span></a></div>
    <div class="product-grid">${products.slice(0, 3).map(card).join('')}</div>
    <details class="directory featured-more glass"><summary>More from the coffee shelf</summary><div class="product-grid">${products.slice(3, 10).map(card).join('')}</div></details>
  </section>
  <section class="home-section" aria-labelledby="best-sellers-heading"><div class="section-head best-sellers-head">
    <div><h2 id="best-sellers-heading">Best selling coffees</h2><p class="muted">Choose from 250 g, 500 g or 1 kg bags, whole bean or ground to suit your brew.</p></div>
    <a href="${shop}coffee/">Shop all <span aria-hidden="true">→</span></a></div>
    <div class="quick-grid">${bestSellers.map(slug => products.find(product => product.slug === slug)).filter(Boolean).map(quickCard).join('')}</div>
  </section>
  <nav class="feature-links" aria-label="Explore Strangers">${links.map(([url, title, copy, image]) => `<a class="feature-link glass" href="${shop + url}"><img src="${photo(image)}" alt="" loading="lazy"><h3>${title}</h3><p class="muted">${copy}</p></a>`).join('')}</nav>
  <section class="home-section" aria-labelledby="approach-heading"><div class="section-head"><h2 id="approach-heading">How we source and roast</h2><a href="${shop}about/">About Strangers <span aria-hidden="true">→</span></a></div>
    <div class="feature-links">${approach.map(([title, description]) => `<article class="feature-link glass"><h3>${title}</h3><p class="muted">${description}</p></article>`).join('')}</div>
  </section>
  <section class="partner glass"><div><h2>Become a wholesale partner</h2><p class="muted">Speciality coffee for cafés, shops and other businesses.</p></div><a class="shop-button soft" href="${shop}wholesale/">Explore wholesale ${arrow}</a></section>
  <section class="home-section" aria-labelledby="social-heading"><div class="section-head"><h2 id="social-heading">From our Instagram</h2><a href="https://www.instagram.com/strangerscoffee/">@strangerscoffee ${arrow}</a></div>
    <div class="social-grid" id="instagram-posts">${socialPosts.map(([code, title]) => `<a href="https://www.instagram.com/p/${code}/" aria-label="${title} on Instagram"><img src="${photo(`social-${code.toLowerCase()}`)}" alt="" loading="lazy"></a>`).join('')}</div>
  </section>`;
}

async function refreshInstagram() {
  const grid = document.querySelector('#instagram-posts');
  try {
    const { posts } = await loadJson(`${shop}instagram.json`);
    if (!posts.length || grid.contains(document.activeElement)) return;
    const fallback = grid.innerHTML;
    grid.innerHTML = posts.map(post => {
      const cached = socialPosts.some(([code]) => code === post.code);
      const image = cached ? photo(`social-${post.code.toLowerCase()}`) : `${shop}instagram-photo/${encodeURIComponent(post.code)}`;
      return `<a href="${escape(post.href)}" aria-label="${escape(post.label)} · Instagram"><img src="${image}" alt="" loading="lazy"></a>`;
    }).join('');
    for (const image of grid.querySelectorAll('img')) image.addEventListener('error', () => {
      image.closest('a').remove();
      if (!grid.childElementCount) grid.innerHTML = fallback;
    }, { once: true });
  } catch {
    // The locally stored gallery is available if the feed cannot be refreshed.
  }
}

function catalogue(collection) {
  const search = new URLSearchParams(location.search);
  let category = !collection && categories.has(search.get('category')) ? search.get('category') : 'all';
  const collectionProducts = collection ? collection.products.map(id => products.find(product => product.slug === id)).filter(Boolean) : products;
  main.innerHTML = `${heading(collection?.title || 'Shop coffee', collection ? '' : 'Single origins, blends and gift cards from Strangers Coffee Company.')}
    <div class="catalogue-tools glass">
      ${collection ? `<a class="link-text all-coffee" href="${shop}coffee/">← All coffee</a>` : `<div class="filters" role="group" aria-label="Categories">${[...categories].map(([id, name]) => `<button type="button" data-filter="${id}" aria-pressed="${id === category}">${name}</button>`).join('')}</div>`}
      <label class="shop-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="Search coffee" placeholder="Search coffee" maxlength="100"></label>
    </div>
    <details class="directory glass"><summary>Browse shop categories</summary><nav aria-label="All shop categories">${Object.entries(siteContent.categories).map(([id, entry]) => `<a href="${shop}coffee/${id}/"${slug === id ? ' aria-current="page"' : ''}>${escape(entry.title)}</a>`).join('')}</nav></details>
    <p class="result-count" role="status"></p><div class="product-grid" id="products"></div>`;
  const input = main.querySelector('input');
  const filters = [...main.querySelectorAll('[data-filter]')];
  input.value = (search.get('q') || '').slice(0, 100);
  function filter() {
    const q = input.value.trim().toLowerCase();
    const shown = collectionProducts.filter(product => (category === 'all' || product.category === category)
      && `${product.title} ${product.notes} ${categoryNames[product.category]}`.toLowerCase().includes(q));
    main.querySelector('.result-count').textContent = `${shown.length} ${shown.length === 1 ? 'product' : 'products'}`;
    main.querySelector('#products').innerHTML = shown.length ? shown.map(card).join('') : collectionProducts.length
      ? '<p class="muted">No products match. Try another search or category.</p>'
      : `<p class="muted">There are no products in this category right now. <a class="link-text" href="${shop}coffee/">Browse all coffee</a>.</p>`;
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

function productForm(product) {
  return `<form class="product-form" aria-label="Buy ${escape(product.title)}">
    <div class="variant-fields">${product.options.map(name => `<label class="retail-field">${escape(name)}<select></select></label>`).join('')}</div>
    <div class="purchase-row"><strong class="detail-price" aria-live="polite"></strong>${quantityControl(1, 'Order quantity')}<button class="shop-button" type="submit">Add to basket</button></div>
  </form>`;
}

function quickCard(product) {
  return `<article class="quick-card glass" data-quick-product="${escape(product.slug)}">
    <a class="quick-link" href="${detailPath(product)}"><img class="card-photo" src="${productImage(product)}" alt="" loading="lazy"><h3>${escape(product.title)}</h3></a>
    ${productForm(product)}</article>`;
}

function productPage(product, details) {
  document.title = `${product.title} · Strangers Coffee Company`;
  main.innerHTML = `<p class="breadcrumb"><a class="link-text" href="${shop}coffee/">← Shop coffee</a></p>
    <div class="detail-grid"><section class="gallery glass" aria-label="Product photos">
      <img class="detail-photo" src="${productImage(product)}" alt="${escape(product.title)}" fetchpriority="high">
      ${product.photos.length > 1 ? `<div class="thumbnails">${product.photos.map((name, index) => `<button type="button" data-photo="${index}" aria-label="Photo ${index + 1}" aria-pressed="${!index}"><img src="${photo(name)}" alt=""></button>`).join('')}</div>` : ''}
    </section><div class="detail-panel glass"><p class="product-meta">${categoryNames[product.category]}</p><h1>${escape(product.title)}</h1>
      ${product.notes ? `<p class="detail-notes">${escape(product.notes)}</p>` : ''}
      ${product.description ? `<p class="muted">${escape(product.description)}</p>` : ''}
      ${productForm(product)}
      <p class="mini-detail">${product.digital ? 'Digital gift card' : 'UK delivery'} · <a class="link-text" href="${shop}shipping/">Delivery &amp; returns</a> · <a class="link-text" href="${escape(product.url)}">Buy on the live shop ${arrow}</a></p>
    </div></div>${details ? `<section class="article-content product-story glass" aria-label="More about this product">${details}</section>` : ''}`;
  const thumbnails = [...main.querySelectorAll('[data-photo]')];
  const image = main.querySelector('.detail-photo');
  for (const button of thumbnails) button.addEventListener('click', () => {
    for (const option of thumbnails) option.setAttribute('aria-pressed', String(option === button));
    image.src = productImage(product, Number(button.dataset.photo));
  });
  mountProductForm(main.querySelector('form'), product);
}

function mountProductForm(form, product) {
  const initial = product.variants.find(variant => variant.available) || product.variants[0];
  const valuesFor = (index, variants = product.variants) => [...new Set(variants.map(option => option.choices[index]))];
  const optionsFor = choices => choices.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('');
  const [primary, secondary] = form.querySelectorAll('select');
  const amount = form.querySelector('.detail-price');
  const add = form.querySelector('button[type=submit]');
  const control = form.querySelector('.quantity');
  let quantity = 1;
  let selected;
  primary.innerHTML = optionsFor(valuesFor(0));
  primary.value = initial.choices[0];
  function update(grind = secondary?.value) {
    const group = product.variants.filter(option => option.choices[0] === primary.value);
    if (secondary) {
      const values = valuesFor(1, group);
      secondary.innerHTML = optionsFor(values);
      secondary.value = values.includes(grind) ? grind : values[0];
    }
    selected = group.find(option => !secondary || option.choices[1] === secondary.value);
    add.disabled = !selected?.available;
    add.textContent = add.disabled ? 'Sold out' : 'Add to basket';
    amount.textContent = selected ? price(selected.pence) : '';
  }
  primary.addEventListener('change', () => update());
  secondary?.addEventListener('change', () => update());
  for (const button of control.querySelectorAll('[data-step]')) button.addEventListener('click', () => {
    quantity += Number(button.dataset.step);
    displayQuantity(control, quantity);
    if (button.disabled) control.querySelector('button:not(:disabled)')?.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (selected?.available) addToBasket(product, selected, quantity);
  });
  update(initial.choices[1]);
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

const contentPages = {
  'brew-guides': ['brewguides', 'Brew guides', 'Watch the espresso guide'],
  about: ['about', 'About Strangers'], contact: ['contact', 'Contact us', 'Open the contact form'],
  shipping: ['shipping', 'Delivery & returns'], 'privacy-policy': ['privacy-policy', 'Privacy policy'],
  'terms-conditions': ['terms-conditions', 'Terms & conditions'],
  wholesale: ['wholesale', 'Wholesale coffee', 'Get in touch about wholesale'],
  'norwich-racing-team': ['norwich-racing-team', 'Norwich Racing Team'],
};

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}`);
  return response.json();
}

async function articleContent(key) {
  if (!key) return '';
  return (await loadJson(`${shop}content/${key}.json`)).html;
}

async function contentPage(name) {
  const [sourcePage, title, action] = contentPages[name];
  const body = await articleContent(siteContent.pages[sourcePage]?.key);
  const link = action ? `<a class="shop-button" href="${liveSite}/${sourcePage}">${action} ${arrow}</a>` : '';
  const extra = name === 'wholesale' ? '<a class="link-text" href="https://strangerscoffee.trade/">Trade customer sign-in</a>'
    : name === 'contact' ? '<a class="link-text" href="mailto:sales@strangerscoffee.com">sales@strangerscoffee.com</a>' : '';
  main.innerHTML = `${heading(title)}<article class="article-content glass">${body}${link || extra ? `<div class="article-actions">${link}${extra}</div>` : ''}</article>`;
}

const dateLabel = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const blogDate = date => dateLabel.format(new Date(`${date}T12:00:00Z`));

function blogCard(article) {
  const excerpt = article.excerpt.length > 170 ? `${article.excerpt.slice(0, 166).replace(/\s+\S*$/, '')}…` : article.excerpt;
  return `<a class="product-card glass archive-card" href="${previewPath(article.path)}">${article.photo ? `<img class="card-photo" src="${photo(article.photo)}" alt="" loading="lazy">` : ''}
    <div class="card-content"><time datetime="${article.date}" class="muted">${blogDate(article.date)}</time><h2>${escape(article.title)}</h2>
    ${excerpt ? `<p class="notes">${escape(excerpt)}</p>` : ''}</div></a>`;
}

async function blog() {
  if (segments[0] && segments[0] !== 'tag') {
    const original = `/blog/${segments.join('/')}`;
    const article = siteContent.posts.find(post => post.path === original);
    if (!article) { missing('Article not found', 'blog/'); return; }
    document.title = `${article.title} · Strangers Coffee Company`;
    const body = await articleContent(article.key);
    main.innerHTML = `<p class="breadcrumb"><a class="link-text" href="${shop}blog/">← Blog</a></p>${heading(article.title, blogDate(article.date))}
      <article class="article-content glass">${body}<div class="article-actions"><a class="link-text" href="${liveSite + article.path}">View original post ${arrow}</a></div></article>`;
    return;
  }
  const key = segments[1];
  const topic = key ? siteContent.tags[key] || siteContent.tags[key.replaceAll('%20', '+')] : null;
  if (key && !topic) { missing('Topic not found', 'blog/'); return; }
  const entries = topic ? siteContent.posts.filter(post => topic.articles.includes(post.path)) : siteContent.posts;
  main.innerHTML = `${heading(topic ? `Blog · ${topic.title}` : 'Blog', 'Coffee releases, roastery stories and updates from Strangers.')}
    <details class="directory glass"><summary>Browse topics</summary><nav aria-label="Blog topics"><a href="${shop}blog/">All posts</a>
      ${Object.entries(siteContent.tags).map(([id, tag]) => `<a href="${shop}blog/tag/${id}/"${topic === tag ? ' aria-current="page"' : ''}>${escape(tag.title)}</a>`).join('')}</nav></details>
    <div class="product-grid">${entries.length ? entries.map(blogCard).join('') : '<p class="muted">There are no posts under this topic.</p>'}</div>`;
}

function missing(title, to) {
  main.innerHTML = `${heading(title)}<a class="shop-button" href="${shop + to}">${to === 'coffee/' ? 'Browse the shop' : 'Browse the blog'}</a>`;
}

function information() {
  const pages = [['locations', 'Locations'], ...Object.entries(contentPages).map(([id, [, title]]) => [id, title]), ['blog', 'Blog']];
  return `${heading('Information')}<nav class="directory glass" aria-label="Shop and company information"><div class="directory-links">${pages.map(([id, title]) => `<a href="${shop}${id}/">${title}</a>`).join('')}</div></nav>`;
}

async function render() {
  document.title = 'Strangers Coffee Company';
  if (page === 'basket') basketPage();
  else if (page === 'checkout') checkoutPage();
  else if (page === 'coffee' && slug) {
    const collection = segments[0] !== 'p' && siteContent.categories[slug];
    if (collection) catalogue(collection);
    else {
      const product = products.find(item => item.slug === slug);
      if (product) productPage(product, await articleContent(siteContent.productDetails[slug]));
      else missing('Coffee not found', 'coffee/');
    }
  } else if (page === 'coffee') catalogue();
  else if (page === 'blog') await blog();
  else if (page === 'locations') main.innerHTML = visit();
  else if (page === 'information') main.innerHTML = information();
  else if (contentPages[page]) await contentPage(page);
  else {
    main.innerHTML = home();
    for (const card of main.querySelectorAll('[data-quick-product]')) {
      const product = products.find(item => item.slug === card.dataset.quickProduct);
      mountProductForm(card.querySelector('form'), product);
    }
    void refreshInstagram();
  }
  const title = contentPages[page]?.[1] ?? ({ coffee: 'Shop coffee', basket: 'Basket', checkout: 'Checkout', locations: 'Locations', blog: 'Blog', information: 'Information' })[page];
  if (title && !slug) document.title = `${title} · Strangers Coffee Company`;
  main.setAttribute('aria-busy', 'false');
}

try {
  [products, siteContent] = await Promise.all([loadJson(`${shop}catalogue.json`), loadJson(`${shop}site-content.json`)]);
  basket = readBasket();
  updateBadge();
  document.querySelector(`[data-nav="${escape(page)}"]`)?.setAttribute('aria-current', 'page');
  await render();
  const syncBasket = () => {
    basket = readBasket();
    updateBadge();
    if (page === 'basket') basketPage();
    if (page === 'checkout') checkoutPage();
  };
  window.addEventListener('pageshow', event => { if (event.persisted) syncBasket(); });
  window.addEventListener('storage', event => { if (event.key === basketKey) syncBasket(); });
} catch {
  main.innerHTML = `${heading('The preview couldn’t load')}<a class="shop-button" href="${liveSite}/coffee">Visit the live shop ${arrow}</a>`;
  main.setAttribute('aria-busy', 'false');
}
