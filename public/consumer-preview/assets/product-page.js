import { products } from './products.js';
import { productFromPath, productPath } from './product-paths.js';
import { productContent } from './product-content.js';
import { escapeHtml as html } from './html.js';
import { money } from './store.js';
import { grindLabel, sizeNames } from './checkout.js';

const assets = '/consumer-preview/assets/';
const voucherPages = {
  'in-store-gift-card': {
    name: 'In-store Gift Card',
    description: 'This physical gift card can be used at our Norwich shops and is posted to the address provided at checkout.',
    note: 'It can be redeemed in our shops.',
    image: assets + 'in-store-gift-card.webp',
  },
  'online-gift-card': {
    name: 'Online Gift Card',
    description: 'Give someone a digital voucher to spend on coffee, gifts or accessories. The recipient can redeem their unique code at checkout.',
    note: 'Online gift cards have no expiry date and can be redeemed in our online shop.',
    image: assets + 'online-gift-card.webp',
  },
};
const brewGuidance = {
  Chocolatey: ['Try it as a pour-over', 'Start with a medium grind and bring out the sweeter chocolate and nut flavours with a longer, steady pour.', 'brew-v60.webp', 'V60 coffee brewing'],
  Fruity: ['Bring out the brighter notes', 'A medium-ground filter brew lets the fruit flavours come through. Adjust your grind a little at a time to find your balance.', 'brew-v60.webp', 'V60 coffee brewing'],
  Decaf: ['Make a slower brew', 'Start with a coarse grind for a cafetière and follow the brew guide for a balanced cup.', 'brew-french-press.webp', 'Coffee brewing in a cafetière'],
};

function sizeLabel(product, size) {
  if (product.category === 'flight') return '3 × 100 g';
  return sizeNames[size] ?? size;
}

function galleryMarkup(photos, name, caption) {
  const first = photos[0];
  return `<div class="retail-product-gallery">
    <figure class="retail-product-figure">
      <img src="${html(first.src)}" width="722" height="511" alt="${html(first.label)}" fetchpriority="high" data-gallery-main>
      <figcaption><span>${html(name)}</span><span data-gallery-caption>${html(caption)}</span></figcaption>
    </figure>
    ${photos.length > 1 ? `<div class="retail-product-thumbs" role="group" aria-label="Product photographs">
      ${photos.map((photo, index) => `<button type="button" data-gallery-index="${index}" aria-pressed="${index === 0}" aria-label="${html(photo.label)}">
        <img src="${html(photo.src)}" alt="" width="94" height="66" loading="lazy">
      </button>`).join('')}
    </div>` : ''}
  </div>`;
}

function productPhotos(product, details) {
  const constituents = products.filter(item => product.contents?.includes(item.id));
  const relatedPhotos = constituents.map(item => ({ src: item.image, label: item.name }));
  return [{ src: product.image, label: product.category === 'flight' ? 'Strangers Coffee Roastery' : product.name },
    ...(details.photos ?? []).map((photo, index) => ({ ...photo, label: `${product.name} · ${photo.label} ${index + 1}` })),
    ...relatedPhotos];
}

function breadcrumb(name, gift) {
  return `<nav class="retail-product-crumb" aria-label="Breadcrumb">
    <a href="/coffee/#${gift ? 'gifts' : 'coffee'}">${gift ? 'Gifts &amp; accessories' : 'Shop coffee'}</a>
    <span aria-hidden="true">/</span><span aria-current="page">${html(name)}</span>
  </nav>`;
}

function productOptions(product, initialGrind) {
  const sizes = Object.keys(product.prices);
  const accessory = product.category === 'accessory';
  const firstSize = sizes[0];
  return `<form class="retail-product-form" id="retail-product-options">
    ${accessory ? `<input type="hidden" name="size" value="${html(firstSize)}">` : `
      <fieldset>
        <legend>${product.category === 'flight' ? 'Pack size' : 'Bag size'}</legend>
        <div class="retail-product-sizes">
          ${sizes.map((size, index) => `<label><input type="radio" name="size" value="${html(size)}"${index === 0 ? ' checked' : ''}><span><b>${html(sizeLabel(product, size))}</b><small>${money(product.prices[size])}</small></span></label>`).join('')}
        </div>
      </fieldset>`}
    <div class="retail-product-fields">
      ${product.grinds.length > 1 ? `<div class="field"><label for="retail-product-grind">Grind</label><select name="grind" id="retail-product-grind">
        ${product.grinds.map(grind => `<option value="${html(grind)}"${grind === initialGrind ? ' selected' : ''}>${html(grindLabel(grind))}</option>`).join('')}
      </select></div>` : `<input type="hidden" name="grind" value="${html(initialGrind)}">${product.category === 'flight' ? '<p class="retail-product-fixed-grind">Whole bean</p>' : ''}`}
      <div class="field retail-product-quantity"><label for="retail-product-quantity">Quantity</label>
        <input type="number" inputmode="numeric" min="1" max="99" step="1" required name="quantity" id="retail-product-quantity" value="1">
      </div>
    </div>
    <div class="retail-product-purchase">
      <output aria-live="polite" for="retail-product-quantity" data-product-total>${money(product.prices[firstSize])}</output>
      <button class="button primary" type="submit">Add to cart</button>
    </div>
    <p class="form-error retail-product-error" role="alert" hidden></p>
  </form>`;
}

function productStory(product, details) {
  if (product.category === 'flight') {
    const coffees = (product.contents ?? []).map(id => products.find(item => item.id === id)).filter(Boolean);
    return `<section class="retail-product-section">
      <h2>In the flight</h2>
      <div class="retail-product-related">${coffees.map(relatedMarkup).join('')}</div>
    </section>`;
  }
  if (product.category === 'accessory') return '';
  const provenance = details.provenance?.length ? details.provenance
    : [['Region', product.region], ['Process', product.process]].filter(([, value]) => value);
  const [intro, ...paragraphs] = details.story?.length ? details.story : [product.story];
  const [title, description, image, alt] = brewGuidance[product.profile] ?? brewGuidance.Chocolatey;
  const hasStory = intro || provenance.length;
  return `<div class="retail-product-stories${hasStory ? '' : ' retail-product-stories-single'}" id="producer">
    ${hasStory ? `<section class="retail-product-origin">
      <p class="eyebrow">From the producer</p>
      <h2>Meet the coffee</h2>
      ${intro ? `<p>${html(intro)}</p>` : ''}
      ${provenance.length ? `<dl>${provenance.map(([label, value]) => `<div><dt>${html(label)}</dt><dd>${html(value)}</dd></div>`).join('')}</dl>` : ''}
      ${paragraphs.length ? `<details><summary>Read the producer story</summary>${paragraphs.map(paragraph => `<p>${html(paragraph)}</p>`).join('')}</details>` : ''}
    </section>` : ''}
    <section class="retail-product-brew">
      <img src="${assets + image}" alt="${html(alt)}" width="760" height="760" loading="lazy">
      <div><p class="eyebrow">Brew at home</p><h2>${title}</h2><p>${description}</p><a href="/brewguides/">Read our brew guides</a></div>
    </section>
  </div>`;
}

function relatedMarkup(product) {
  return `<a class="retail-related-card" href="${productPath(product)}">
    <img src="${html(product.image)}" alt="" width="420" height="298" loading="lazy">
    <span><strong>${html(product.name)}</strong><span>${html(product.shortCopy)}</span></span>
  </a>`;
}

function relatedProducts(product) {
  const coffees = products.filter(item => !item.category && item.available !== false && item.id !== product.id);
  const sameProfile = coffees.filter(item => item.profile === product.profile);
  const differentProfile = coffees.filter(item => item.profile !== product.profile);
  return [...sameProfile, ...differentProfile].slice(0, 3);
}

function voucherMarkup(id, voucher) {
  return `${breadcrumb(voucher.name, true)}
    <div class="retail-product-intro">
      ${galleryMarkup([{ src: voucher.image, label: voucher.name }], voucher.name, 'Strangers Coffee')}
      <div class="retail-product-copy">
        <p class="eyebrow">Gift vouchers</p><h1>${html(voucher.name)}</h1>
        <p class="retail-product-lede">${html(voucher.description)}</p>
        <p class="retail-product-lede">${html(voucher.note)}</p>
        <p class="retail-voucher-price">From £10.00</p>
        <div class="retail-voucher-actions">
          <a class="button primary" href="https://strangerscoffee.com/coffee/p/${id}">Buy on the Strangers shop</a>
          <a href="/terms-conditions/">Gift voucher terms</a>
        </div>
      </div>
    </div>`;
}

export function setupProductPage(page, { store, onAdd, stockKnown }) {
  const route = productFromPath(location.pathname);
  const product = products.find(item => item.id === route?.id);
  const voucher = route && Object.hasOwn(voucherPages, route.id) ? voucherPages[route.id] : null;
  page.removeAttribute('aria-busy');
  if (!product && !voucher) {
    page.innerHTML = '<h1>Coffee not found</h1><p>This coffee may have rotated out of the range.</p><a href="/coffee/">Shop our current coffees</a>';
    return;
  }
  document.title = `${route.name} | Strangers Coffee`;
  const description = document.querySelector('meta[name="description"]');
  if (voucher) {
    description?.setAttribute('content', voucher.description);
    page.innerHTML = voucherMarkup(route.id, voucher);
    return;
  }

  const details = Object.hasOwn(productContent, product.id) ? productContent[product.id] : {};
  const photos = productPhotos(product, details);
  const gift = product.category === 'accessory' || product.category === 'flight';
  const origin = gift ? (product.category === 'flight' ? 'Coffee tasting flight' : 'Gifts & accessories')
    : [product.country, product.process].filter(Boolean).join(' · ');
  const intro = details.description || (product.notes.length ? `Tasting notes of ${product.notes.join(', ')}.` : product.shortCopy);
  const suggestedGrind = new URLSearchParams(location.search).get('grind');
  const initialGrind = product.grinds.includes(suggestedGrind) ? suggestedGrind : product.grinds[0];
  const related = relatedProducts(product);
  description?.setAttribute('content', intro);
  document.body.classList.toggle('has-retail-purchase', stockKnown && product.available !== false);
  page.innerHTML = `${breadcrumb(product.name, gift)}
    <article class="retail-product-intro">
      ${galleryMarkup(photos, product.name, product.region || product.country || 'Strangers Coffee')}
      <div class="retail-product-copy">
        <p class="eyebrow">${html(origin)}</p><h1>${html(product.name)}</h1>
        <p class="retail-product-lede">${html(intro)}</p>
        ${product.notes.length ? `<ul class="retail-product-notes" aria-label="Tasting notes">${product.notes.map(note => `<li>${html(note)}</li>`).join('')}</ul>` : ''}
        ${!stockKnown ? '' : product.available === false ? '<p class="retail-product-unavailable" role="status">Currently unavailable.</p>' : productOptions(product, initialGrind)}
        <p class="retail-product-delivery"><a href="/shipping/">UK delivery and returns</a><span aria-hidden="true">·</span><a href="/location/">Norwich collection</a></p>
      </div>
    </article>
    ${productStory(product, details)}
    ${related.length ? `<section class="retail-product-section"><h2>You might also like</h2><div class="retail-product-related">${related.map(relatedMarkup).join('')}</div></section>` : ''}`;

  const mainPhoto = page.querySelector('[data-gallery-main]');
  const caption = page.querySelector('[data-gallery-caption]');
  const choices = page.querySelectorAll('[data-gallery-index]');
  choices.forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.galleryIndex);
    const photo = photos[index];
    choices.forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
    mainPhoto.src = photo.src;
    mainPhoto.alt = photo.label;
    caption.textContent = index === 0 ? product.region || product.country || 'Strangers Coffee' : photo.label;
  }));

  const form = page.querySelector('#retail-product-options');
  if (!form) return;
  const error = form.querySelector('.retail-product-error');
  form.addEventListener('input', () => {
    const qty = Number(form.elements.quantity.value);
    const size = form.elements.size.value;
    if (Number.isInteger(qty) && qty >= 1 && qty <= 99) {
      form.querySelector('[data-product-total]').value = money(product.prices[size] * qty);
    }
    error.hidden = true;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const { size, grind, quantity } = form.elements;
    if (store.add(product.id, size.value, grind.value, Number(quantity.value))) {
      onAdd(product, event.submitter);
      return;
    }
    error.textContent = 'You can add up to 99 of each item and option.';
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest' });
  });
}
