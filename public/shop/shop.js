const shop = '/shop/';
const liveSite = 'https://strangerscoffee.com';
const basketKey = 'strangers.retail-preview.basket.v1';
const quantityLimit = 30;
const main = document.querySelector('#main');
const header = document.querySelector('.shop-header');
const basketLink = header.querySelector('#basket-link');
const countBadge = document.querySelector('#basket-count');
const menuToggle = header.querySelector('.menu-toggle');
const navigation = header.querySelector('.shop-nav');
const mobileHeader = matchMedia('(max-width: 700px)');
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

const menuIsOpen = () => menuToggle.getAttribute('aria-expanded') === 'true';

function setMenuOpen(open) {
  menuToggle.setAttribute('aria-expanded', String(open));
  navigation.inert = mobileHeader.matches && !open;
}

function syncHeaderLayout() {
  const focus = document.activeElement;
  // Keep Tab order aligned with the visible controls in both layouts.
  if (mobileHeader.matches) header.append(navigation);
  else basketLink.before(navigation);
  setMenuOpen(false);
  if (focus === menuToggle || navigation.contains(focus)) {
    (mobileHeader.matches ? menuToggle : navigation.querySelector('a')).focus({ preventScroll: true });
  }
}

function closeMenu() {
  if (navigation.contains(document.activeElement)) menuToggle.focus({ preventScroll: true });
  setMenuOpen(false);
}

syncHeaderLayout();
mobileHeader.addEventListener('change', syncHeaderLayout);
menuToggle.addEventListener('click', () => {
  if (menuIsOpen()) closeMenu();
  else setMenuOpen(true);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !menuIsOpen()) return;
  event.preventDefault();
  menuToggle.focus({ preventScroll: true });
  setMenuOpen(false);
});
document.addEventListener('click', event => {
  if (menuIsOpen() && !header.contains(event.target)) closeMenu();
});
header.addEventListener('focusout', event => {
  if (menuIsOpen() && event.relatedTarget && !header.contains(event.relatedTarget)) setMenuOpen(false);
});
window.addEventListener('pageshow', event => {
  if (event.persisted && menuIsOpen()) closeMenu();
});

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
  countBadge.textContent = String(count);
  countBadge.toggleAttribute('data-empty', count === 0);
  basketLink.setAttribute('aria-label', `Basket, ${count} ${count === 1 ? 'item' : 'items'}`);
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
  const titleTag = page === 'coffee' ? 'h2' : 'h3';
  return `<a class="product-card" href="${detailPath(product)}">
    <img class="card-photo" src="${productImage(product)}" alt="" loading="${index < 3 ? 'eager' : 'lazy'}" decoding="async">
    <div class="card-content"><p class="product-meta">${categoryNames[product.category]}</p><${titleTag} class="card-title">${escape(product.title)}</${titleTag}>
      ${product.notes ? `<p class="notes">${escape(product.notes)}</p>` : ''}</div>
    <div class="card-price"><strong>${saleable.length ? `From ${price(lowest)}` : 'Sold out'}</strong><span class="card-arrow">${arrow}</span></div>
  </a>`;
}

function home() {
  const links = [
    ['locations/', 'Visit us in Norwich', 'Find our roastery and coffee shops in Norwich.', 'pottergate'],
    ['brew-guides/', 'Brew guides', 'Recipes for AeroPress, filter and French press.', 'filter'],
  ];
  const approach = [
    ['From green beans to final roast', 'We sample every coffee before buying it, then develop a roast profile around its flavour. Every roasted batch is checked before it goes on sale.'],
    ['Quality and traceability', 'We share where each coffee comes from and how it was grown and processed, so you can follow its journey from farm to roastery.'],
    ['A changing coffee shelf', 'Our single origins follow the harvests. Familiar favourites stay on the shelf alongside seasonal coffees.'],
  ];
  return `<section class="retail-hero" aria-labelledby="retail-hero-title">
    <div class="hero-title">
      <p class="eyebrow">Independent coffee roasters · Est. 2009</p>
      <h1 id="retail-hero-title"><span class="hero-line"><span>Coffee from the</span></span>
        <span class="hero-line"><span>heart of <em>Norwich.</em></span></span></h1>
    </div>
    <div class="hero-visual" aria-hidden="true">
      <div class="orb-field">
        <div class="orb-drift">
          <div class="orb-lettering"></div>
          <div class="orb-disc"><div class="orb-static"></div><canvas class="orb-canvas"></canvas></div>
        </div>
      </div>
    </div>
    <div class="hero-copy">
      <p>100% arabica coffee, roasted on Dove Street and delivered across the UK.</p>
      <div class="hero-actions"><a class="shop-button" href="${shop}coffee/">Shop coffee <span aria-hidden="true">→</span></a>
        <a class="editorial-link" href="${shop}locations/">Our locations <span aria-hidden="true">↗</span></a></div>
    </div>
    <button class="orb-motion" type="button" hidden>
      <span class="orb-motion-icon" aria-hidden="true"></span><span class="orb-motion-label">Pause motion</span>
    </button>
  </section>
  <section class="home-section editorial-shelf" aria-labelledby="featured-heading">
    <div class="section-head"><h2 id="featured-heading">On the coffee shelf</h2>
      <div class="shelf-actions"><a class="editorial-link" href="${shop}coffee/">View all coffee <span aria-hidden="true">↗</span></a>
        <div class="shelf-controls" role="group" aria-label="Browse featured coffees" hidden>
          <button type="button" data-slide="-1" aria-label="Previous coffee" aria-controls="featured-rail">←</button>
          <button type="button" data-slide="1" aria-label="Next coffee" aria-controls="featured-rail">→</button>
        </div>
      </div>
    </div>
    <div class="product-grid editorial-rail" id="featured-rail">${products.slice(0, 3).map(card).join('')}</div>
    <details class="directory featured-more"><summary>More from the coffee shelf</summary><div class="product-grid">${products.slice(3, 10).map(card).join('')}</div></details>
  </section>
  <section class="home-section editorial-roastery" aria-labelledby="approach-heading">
    <div class="editorial-roastery-photo"><img src="${photo('dove-street')}" width="750" height="646" alt="Coffee pouring from the Probat roaster on Dove Street" loading="lazy" decoding="async"></div>
    <div class="editorial-roastery-copy">
      <p class="eyebrow">Dove Street roastery</p>
      <h2 id="approach-heading">From green beans to final roast.</h2>
      <p>${approach[0][1]}</p>
      <a class="editorial-link" href="${shop}about/">About Strangers <span aria-hidden="true">↗</span></a>
      <dl>${approach.slice(1).map(([title, description]) => `<div><dt>${title}</dt><dd>${description}</dd></div>`).join('')}</dl>
    </div>
  </section>
  <section class="home-section editorial-bestsellers" aria-labelledby="best-sellers-heading"><div class="section-head best-sellers-head">
    <div><h2 id="best-sellers-heading">Best selling coffees</h2><p class="muted">Choose from 250 g, 500 g or 1 kg bags, whole bean or ground to suit your brew.</p></div>
    <a class="editorial-link" href="${shop}coffee/">Shop all <span aria-hidden="true">↗</span></a></div>
    <div class="quick-grid">${bestSellers.map(slug => products.find(product => product.slug === slug)).filter(Boolean).map(quickCard).join('')}</div>
  </section>
  <nav class="feature-links editorial-discovery" aria-label="Explore Strangers">${links.map(([url, title, copy, image]) => `<a class="feature-link" href="${shop + url}">
    <div class="editorial-discovery-photo"><img src="${photo(image)}" alt="" loading="lazy" decoding="async"></div>
    <div class="editorial-discovery-copy"><div><h3>${title}</h3><p class="muted">${copy}</p></div><span class="card-arrow">${arrow}</span></div></a>`).join('')}</nav>
  <section class="partner"><div><h2>Become a wholesale partner</h2><p class="muted">Speciality coffee for cafés, shops and other businesses.</p></div><a class="shop-button soft" href="${shop}wholesale/">Explore wholesale ${arrow}</a></section>
  <section class="home-section" aria-labelledby="social-heading"><div class="section-head"><h2 id="social-heading">From our Instagram</h2><a href="https://www.instagram.com/strangerscoffee/">@strangerscoffee ${arrow}</a></div>
    <div class="social-grid" id="instagram-posts">${socialPosts.map(([code, title]) => `<a href="https://www.instagram.com/p/${code}/" aria-label="${title} on Instagram"><img src="${photo(`social-${code.toLowerCase()}`)}" alt="" loading="lazy"></a>`).join('')}</div>
  </section>`;
}

function mountHomeShelf() {
  const rail = main.querySelector('#featured-rail');
  const controls = main.querySelector('.shelf-controls');
  const previous = controls.querySelector('[data-slide="-1"]');
  const next = controls.querySelector('[data-slide="1"]');
  const noMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function syncControls() {
    const end = rail.scrollWidth - rail.clientWidth;
    controls.hidden = end < 2;
    previous.disabled = rail.scrollLeft < 2;
    next.disabled = rail.scrollLeft >= end - 2;
  }

  for (const button of [previous, next]) button.addEventListener('click', () => {
    const edge = rail.getBoundingClientRect().left + (parseFloat(getComputedStyle(rail).scrollPaddingLeft) || 0);
    const offsets = [...rail.children].map(card => card.getBoundingClientRect().left - edge);
    const offset = button === next ? offsets.find(left => left > 2) : offsets.findLast(left => left < -2);
    if (offset !== undefined) rail.scrollBy({ left: offset, behavior: noMotion.matches ? 'instant' : 'smooth' });
  });
  rail.addEventListener('scroll', syncControls, { passive: true });
  new ResizeObserver(syncControls).observe(rail);
  syncControls();
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
  main.innerHTML = `${collection ? `<a class="editorial-link breadcrumb" href="${shop}coffee/">← All coffee</a>` : ''}
    ${heading(collection?.title || 'Shop coffee', collection ? '' : 'Single origins, blends and gift cards from Strangers Coffee Company.')}
    <div class="catalogue-tools">
      ${collection ? '' : `<div class="filters" role="group" aria-label="Categories">${[...categories].map(([id, name]) => `<button type="button" data-filter="${id}" aria-pressed="${id === category}">${name}</button>`).join('')}</div>`}
      <label class="shop-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="Search coffee" placeholder="Search coffee" maxlength="100"></label>
    </div>
    <details class="directory"><summary>Browse shop categories</summary><nav aria-label="All shop categories">${Object.entries(siteContent.categories).map(([id, entry]) => `<a href="${shop}coffee/${id}/"${slug === id ? ' aria-current="page"' : ''}>${escape(entry.title)}</a>`).join('')}</nav></details>
    <p class="result-count" role="status"></p>
    <div class="product-grid" id="products"></div>`;
  const input = main.querySelector('input');
  const filters = [...main.querySelectorAll('[data-filter]')];
  input.value = (search.get('q') || '').slice(0, 100);
  function filter() {
    const q = input.value.trim().toLowerCase();
    const shown = collectionProducts.filter(product => (category === 'all' || product.category === category)
      && `${product.title} ${product.notes} ${categoryNames[product.category]}`.toLowerCase().includes(q));
    main.querySelector('.result-count').textContent = `${shown.length} ${shown.length === 1 ? 'product' : 'products'}`;
    main.querySelector('#products').innerHTML = shown.length ? shown.map(card).join('') : collectionProducts.length
      ? '<p class="listing-empty shop-panel">No products match. Try another search or category.</p>'
      : `<p class="listing-empty shop-panel">There are no products in this category right now. <a class="link-text" href="${shop}coffee/">Browse all coffee</a>.</p>`;
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
  return `<article class="quick-card" data-quick-product="${escape(product.slug)}">
    <a class="quick-link" href="${detailPath(product)}"><img class="card-photo" src="${productImage(product)}" alt="" loading="lazy"><h3>${escape(product.title)}</h3></a>
    ${productForm(product)}</article>`;
}

function productPage(product, details) {
  main.innerHTML = `<a class="editorial-link breadcrumb" href="${shop}coffee/">← Shop coffee</a>
    <div class="detail-grid">
      <div class="detail-title">
        <p class="product-meta">${categoryNames[product.category]}</p>
        <h1>${escape(product.title)}</h1>
        ${product.notes ? `<p class="detail-notes">${escape(product.notes)}</p>` : ''}
      </div>
      <section class="gallery" aria-label="Product photos">
        <img class="detail-photo" src="${productImage(product)}" alt="${escape(product.title)}" fetchpriority="high">
        ${product.photos.length > 1 ? `<div class="thumbnails">${product.photos.map((name, index) => `<button type="button" data-photo="${index}" aria-label="Photo ${index + 1}" aria-pressed="${!index}"><img src="${photo(name)}" alt=""></button>`).join('')}</div>` : ''}
      </section>
      <div class="detail-purchase">
        ${product.description ? `<p class="muted">${escape(product.description)}</p>` : ''}
        ${productForm(product)}
        <ul class="detail-links" aria-label="Buying this product">
          <li>${product.digital ? 'Digital gift card' : 'UK delivery'}</li>
          <li><a class="link-text" href="${shop}shipping/">Delivery &amp; returns</a></li>
          <li><a class="link-text" href="${escape(product.url)}">Buy on the live shop ${arrow}</a></li>
        </ul>
      </div>
    </div>
    ${details ? `<section class="article-content product-story" aria-label="More about this product">${details}</section>` : ''}`;
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
  return `${heading(title)}<section class="state-panel shop-panel"><h2>Your basket is empty</h2><a class="shop-button" href="${shop}coffee/">Shop coffee</a></section>`;
}

function basketPage() {
  if (!basket.length) { main.innerHTML = emptyBasket('Basket'); return; }
  main.innerHTML = `${heading('Basket')}
    <div class="basket-grid">
      <section class="basket-list" aria-label="Basket items">${basket.map(line => `<article class="basket-line" data-line="${escape(line.variant)}">
        <img src="${productImage(line.product)}" alt="" loading="lazy">
        <div class="line-copy"><h2><a href="${detailPath(line.product)}">${escape(line.product.title)}</a></h2><p class="mini-detail">${escape(line.option.choices.join(' · '))}</p></div>
        <strong class="line-price" data-line-price>${price(line.option.pence * line.quantity)}</strong>
        <div class="line-actions">${quantityControl(line.quantity, `Quantity for ${line.product.title}`)}<button class="link-button" type="button" data-remove aria-label="Remove ${escape(line.product.title)}">Remove</button></div>
      </article>`).join('')}</section>
      <section class="summary shop-panel" aria-label="Basket summary">
        <h2>Order summary</h2><div id="totals">${totalsPanel()}</div>
        <a class="shop-button" href="${shop}checkout/">Preview checkout</a>
        <a class="editorial-link" href="${shop}coffee/">Continue shopping</a>
      </section>
    </div>`;
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
  const { posted } = totals();
  main.innerHTML = `<a class="editorial-link breadcrumb" href="${shop}basket/">← Back to basket</a>
    ${heading('Preview checkout', 'Try the checkout flow without placing a real order or entering payment details.')}
    <div class="basket-grid checkout-grid">
      <section class="delivery-panel"><h2>${posted ? 'UK delivery' : 'Email delivery'}</h2>
        <p>${posted ? 'Royal Mail Tracked 48 is the standard delivery option. Your final postage is confirmed at checkout on the live shop.' : 'Online gift cards are delivered by email on the live shop.'}</p>
      </section>
      <section class="summary shop-panel" aria-label="Order review"><h2>Review your basket</h2>
        <ul class="checkout-lines">${basket.map(line => `<li><span>${line.quantity} × ${escape(line.product.title)}<br><small class="muted">${escape(line.option.choices.join(' · '))}</small></span><strong>${price(line.option.pence * line.quantity)}</strong></li>`).join('')}</ul>
        ${totalsPanel()}
        <button class="shop-button" type="button" id="finish-preview">Complete preview checkout</button>
      </section>
    </div>`;
  main.querySelector('#finish-preview').addEventListener('click', () => {
    if (!saveBasket([])) return;
    main.innerHTML = `${heading('Preview checkout complete')}
      <section class="state-panel shop-panel"><p>No order was sent and no payment was taken. To buy coffee, visit the live Strangers shop.</p>
      <div class="article-actions"><a class="shop-button" href="${liveSite}/coffee">Visit the live shop ${arrow}</a><a class="editorial-link" href="${shop}coffee/">Continue exploring the preview</a></div></section>`;
    document.title = 'Preview checkout complete · Strangers Coffee Company';
    main.focus();
  });
}

function visit() {
  return `${heading('Visit us in Norwich', 'Three places to stop for a coffee or pick up a freshly roasted bag.')}
    <div class="info-grid">${locations.map(place => `<article class="info-card"><img src="${photo(place.image)}" alt="" loading="lazy" decoding="async">
      <div class="info-copy"><h2>${place.name}</h2><p class="muted">${place.service}</p><address>${place.address}<br>Norwich ${place.postcode}</address>
      <dl>${place.hours.map(([days, times]) => `<div><dt>${days}</dt><dd>${times}</dd></div>`).join('')}</dl>
      <a class="editorial-link" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(`${place.address}, Norwich ${place.postcode}`)}">Get directions ${arrow}</a></div></article>`).join('')}</div>`;
}

const contentPages = {
  'brew-guides': { source: 'brewguides', title: 'Brew guides', action: 'Watch the espresso guide' },
  about: { title: 'About Strangers', featurePhoto: true },
  contact: { title: 'Contact us', action: 'Open the contact form' },
  shipping: { title: 'Delivery & returns' },
  'privacy-policy': { title: 'Privacy policy' },
  'terms-conditions': { title: 'Terms & conditions' },
  wholesale: { title: 'Wholesale coffee', action: 'Get in touch about wholesale', featurePhoto: true },
  'norwich-racing-team': { title: 'Norwich Racing Team', featurePhoto: true },
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
  const { source = name, title, action, featurePhoto } = contentPages[name];
  let body = await articleContent(siteContent.pages[source]?.key);
  let leadPhoto = '';
  if (featurePhoto) {
    const template = document.createElement('template');
    template.innerHTML = body;
    const image = [...template.content.children].find(child => child.tagName === 'IMG');
    if (image) {
      if (name === 'about') {
        image.src = photo('roastery');
        image.alt = 'Coffee roasting on the Probat at the Dove Street roastery';
      }
      image.loading = 'eager';
      image.remove();
      leadPhoto = image.outerHTML;
      body = template.innerHTML;
    }
  }
  const link = action ? `<a class="shop-button" href="${liveSite}/${source}">${action} ${arrow}</a>` : '';
  const extra = name === 'wholesale' ? '<a class="editorial-link" href="https://strangerscoffee.trade/">Trade customer sign-in</a>'
    : name === 'contact' ? '<a class="editorial-link" href="mailto:sales@strangerscoffee.com">sales@strangerscoffee.com</a>' : '';
  const style = { 'brew-guides': ' brewing-guide', contact: ' shop-panel' }[name] || '';
  const article = `<article class="article-content${style}">
    ${body}${link || extra ? `<div class="article-actions">${link}${extra}</div>` : ''}</article>`;
  main.innerHTML = `${heading(title)}${leadPhoto ? `<div class="story-grid"><div class="story-media">${leadPhoto}</div>${article}</div>` : article}`;
}

const dateLabel = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const blogDate = date => dateLabel.format(new Date(`${date}T12:00:00Z`));

function blogCard(article) {
  const excerpt = article.excerpt.length > 170 ? `${article.excerpt.slice(0, 166).replace(/\s+\S*$/, '')}…` : article.excerpt;
  return `<a class="product-card archive-card" href="${previewPath(article.path)}">
    ${article.photo ? `<img class="card-photo" src="${photo(article.photo)}" alt="" loading="lazy" decoding="async">` : ''}
    <div class="card-content"><time datetime="${article.date}" class="eyebrow">${blogDate(article.date)}</time><h2>${escape(article.title)}</h2>
    ${excerpt ? `<p class="notes">${escape(excerpt)}</p>` : ''}</div>
    <div class="card-price"><span>Read article</span><span class="card-arrow">${arrow}</span></div></a>`;
}

async function blog() {
  if (segments[0] && segments[0] !== 'tag') {
    const original = `/blog/${segments.join('/')}`;
    const article = siteContent.posts.find(post => post.path === original);
    if (!article) { missing('Article not found', 'blog/'); return; }
    const body = await articleContent(article.key);
    const articleBody = `<article class="article-content">${body}<div class="article-actions"><a class="editorial-link" href="${liveSite + article.path}">View original post ${arrow}</a></div></article>`;
    const cover = article.photo && !body.includes(article.photo)
      ? `<div class="story-media article-cover"><img src="${photo(article.photo)}" alt="" fetchpriority="high"></div>` : '';
    main.innerHTML = `<a class="editorial-link breadcrumb" href="${shop}blog/">← Blog</a>${heading(article.title, blogDate(article.date))}
      ${cover ? `<div class="story-grid">${cover}${articleBody}</div>` : articleBody}`;
    return;
  }
  const key = segments[1];
  const topic = key ? siteContent.tags[key] || siteContent.tags[key.replaceAll('%20', '+')] : null;
  if (key && !topic) { missing('Topic not found', 'blog/'); return; }
  const entries = topic ? siteContent.posts.filter(post => topic.articles.includes(post.path)) : siteContent.posts;
  main.innerHTML = `${heading(topic ? `Blog · ${topic.title}` : 'Blog', 'Coffee releases, roastery stories and updates from Strangers.')}
    <details class="directory"><summary>Browse topics</summary><nav aria-label="Blog topics"><a href="${shop}blog/">All posts</a>
      ${Object.entries(siteContent.tags).map(([id, tag]) => `<a href="${shop}blog/tag/${id}/"${topic === tag ? ' aria-current="page"' : ''}>${escape(tag.title)}</a>`).join('')}</nav></details>
    <div class="product-grid archive-grid">${entries.length ? entries.map(blogCard).join('') : '<p class="listing-empty shop-panel">There are no posts under this topic.</p>'}</div>`;
}

function missing(title, to) {
  main.innerHTML = `${heading(title)}<div class="state-panel shop-panel"><a class="shop-button" href="${shop + to}">${to === 'coffee/' ? 'Browse the shop' : 'Browse the blog'}</a></div>`;
}

function information() {
  const titles = { locations: 'Locations', blog: 'Blog' };
  const groups = [
    ['Shop help', ['contact', 'shipping', 'privacy-policy', 'terms-conditions']],
    ['Explore Strangers', ['locations', 'about', 'brew-guides', 'blog', 'wholesale', 'norwich-racing-team']],
  ];
  return `${heading('Information')}<nav class="information-grid" aria-label="Shop and company information">
    ${groups.map(([label, entries]) => `<section class="information-group"><h2>${label}</h2>
      <ul>${entries.map(id => `<li><a href="${shop}${id}/">${escape(contentPages[id]?.title ?? titles[id])}<span class="card-arrow">${arrow}</span></a></li>`).join('')}</ul></section>`).join('')}
    </nav>`;
}

async function render() {
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
    mountHomeShelf();
    void import('./home-orb.js').then(({ mountOrb }) => mountOrb(main.querySelector('.retail-hero'))).catch(() => {
      // The static orb remains visible if the motion layer cannot start.
    });
    for (const card of main.querySelectorAll('[data-quick-product]')) {
      const product = products.find(item => item.slug === card.dataset.quickProduct);
      mountProductForm(card.querySelector('form'), product);
    }
    void refreshInstagram();
  }
  const title = main.querySelector('h1')?.textContent;
  if (page && title) document.title = `${title} · Strangers Coffee Company`;
  main.setAttribute('aria-busy', 'false');
}

try {
  [products, siteContent] = await Promise.all([loadJson(`${shop}catalogue.json`), loadJson(`${shop}site-content.json`)]);
  basket = readBasket();
  updateBadge();
  document.querySelector(`[data-nav="${escape(page)}"]`)?.setAttribute('aria-current', 'page');
  if (page === 'basket') basketLink.setAttribute('aria-current', 'page');
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
  main.innerHTML = `${heading('The preview couldn’t load')}<div class="state-panel shop-panel"><a class="shop-button" href="${liveSite}/coffee">Visit the live shop ${arrow}</a></div>`;
  main.setAttribute('aria-busy', 'false');
}
