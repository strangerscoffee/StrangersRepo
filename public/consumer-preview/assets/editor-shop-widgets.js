import {photo} from './editor-photo-url.js';
import {productFromPath, productPath} from './product-paths.js';
import {availability, cafes, products} from './products.js';
import {money} from './store.js';

export { availability };
const usualShelf = ['bom-jesus', 'rocko', 'anserma'];

function productFields(design, id) {
  const key = 'product:' + id;
  return design.pages?.[key]?.fields || design.productFields?.[key]?.fields || {};
}

function appendText(parent, tag, value) {
  if (!value) return;
  const el = parent.ownerDocument.createElement(tag);
  el.textContent = value;
  parent.append(el);
}

// Every card points at a canonical consumer product or location. The destination handles availability,
// options and checkout. This widget never handles or estimates a price independently of the catalogue.
export function createRetailWidget(doc, widget, design, {preview = false} = {}) {
  const shelf = widget.type === 'coffee-shelf';
  if (!shelf && widget.type !== 'locations-list') return null;
  const grid = doc.createElement('ul');
  grid.className = 'consumer-retail-grid';
  const selected = shelf ? (widget.items || usualShelf).map(id => products.find(item => item.id === id && !item.category)).filter(Boolean) : cafes;
  if (shelf && !preview && !availability.known) return grid;
  for (const item of selected) {
    const fields = shelf ? productFields(design, item.id) : {};
    const li = doc.createElement('li');
    const card = doc.createElement('a');
    card.className = 'consumer-retail-card';
    card.href = shelf ? productPath(item) : '/location/#' + item.id;
    let src = item.image;
    if (preview && src) src = src.startsWith('/consumer-product-media/')
      ? src.replace('/consumer-product-media/', '/api/admin/consumer/product-photos/')
      : photo('asset:' + src.split('/').pop(), true);
    if (Object.hasOwn(fields, 'product-image')) src = photo(fields['product-image'], preview);
    if (src) {
      const image = doc.createElement('img');
      image.src = src;
      image.alt = fields['product-image-alt'] || '';
      image.loading = 'lazy';
      image.width = 580;
      image.height = 410;
      card.append(image);
    }
    const copy = doc.createElement('div');
    appendText(copy, 'h3', fields['product-title'] ?? item.name);
    if (shelf) {
      appendText(copy, 'p', item.notes.map((note, i) => fields['note-' + (i + 1)] ?? note).filter(Boolean).join(' · '));
      appendText(copy, 'small', 'From ' + money(Math.min(...Object.values(item.prices))));
    } else {
      appendText(copy, 'p', item.address);
      appendText(copy, 'small', 'Opening hours and directions');
    }
    card.append(copy);
    li.append(card);
    grid.append(li);
  }
  return grid;
}

// List pages and finder results use shorter native names until the merchant explicitly changes the
// individual coffee. Add presentation overrides to the renderer’s reversible map so undo also
// restores the original short label, accessible name, image attributes and source.
export function applyLinkedProductFields(doc, design, {preview = false, desired}) {
  if (!desired) return;
  const overrides = design.productFields || design.pages || {};
  if (!Object.keys(overrides).some(key => key.startsWith('product:'))) return;
  const cards = [
    ['.product', '.product-info h3', '.product-image img'],
    ['.home-coffee', 'h3', 'figure img'],
    ['.shop-gift', 'h3', 'img'],
    ['.retail-related-card', 'strong', 'img'],
    ['.finder-best', '.finder-best-copy h4', '.finder-best-photo img'],
    ['.finder-alternative', 'h5 a', 'img'],
    ['.cart-line[data-catalogue-id]', 'h3', 'img'],
    ['#dialog[data-view="product"]', '#dialog-title', '.detail-media img'],
  ];
  function set(node, key, value) {
    if (!node) return;
    if (!desired.has(node)) desired.set(node, new Map());
    desired.get(node).set(key, value);
  }
  for (const [selector, title, imageSelector] of cards) {
    for (const card of doc.querySelectorAll(selector)) {
      const link = card.matches('a') ? card : card.querySelector('a[href^="/coffee/p/"]');
      const route = productFromPath(link?.getAttribute('href')?.split(/[?#]/, 1)[0] || '', products);
      const id = route?.id || card.dataset.catalogueId;
      if (!id) continue;
      const fields = productFields(design, id);
      if (Object.hasOwn(fields, 'product-title')) {
        set(card.querySelector(title), 'text', fields['product-title']);
        for (const action of card.querySelectorAll('.product-open,.shop-gift-copy a[aria-label],.home-coffee-actions a[aria-label]')) {
          set(action, 'aria-label', 'View ' + fields['product-title']);
        }
        set(card.querySelector('.product-quick-view'), 'aria-label', 'Quick view ' + fields['product-title']);
        if (card.classList.contains('cart-line')) {
          const options = card.querySelector('h3 + p')?.textContent;
          const name = [fields['product-title'], options].filter(Boolean).join(', ');
          set(card.querySelector('.qty'), 'aria-label', 'Quantity for ' + name);
          set(card.querySelector('[data-qty="-1"]'), 'aria-label', 'Decrease quantity for ' + name);
          set(card.querySelector('[data-qty="1"]'), 'aria-label', 'Increase quantity for ' + name);
          set(card.querySelector('[data-remove]'), 'aria-label', 'Remove ' + name);
        }
      }
      const image = card.querySelector(imageSelector);
      if (Object.hasOwn(fields, 'product-image')) {
        const source = photo(fields['product-image'], preview);
        set(image, 'data-consumer-image-hidden', source ? null : '');
        if (source) {
          set(image, 'src', source);
          set(image, 'srcset', null);
        }
      }
      if (Object.hasOwn(fields, 'product-image-alt')) set(image, 'alt', fields['product-image-alt']);
    }
  }
}
