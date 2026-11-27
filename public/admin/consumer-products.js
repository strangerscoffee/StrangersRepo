import { productPath } from '/api/admin/consumer/editor/assets/product-paths.js';

const productsPath = '/api/admin/consumer/products';
const photosPath = '/api/admin/consumer/product-photos';
const stockPath = '/api/admin/consumer/editor/assets/';
const bundledImage = /^\/(?:consumer-preview\/)?assets\/([a-z0-9][a-z0-9-]*\.webp)$/;
const sizes = { '250g': '250 g', '500g': '500 g', '1kg': '1 kg', '300g': '300 g', one: 'One item' };
const categories = { coffee: 'Coffee', flight: 'Tasting flight', accessory: 'Accessory' };
const grinds = ['Whole bean', 'Espresso / Fine', 'Moka Pot / Fine', 'Filter / Medium', 'Cafetiere / Coarse'];
const currency = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

function node(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat().filter(child => child != null));
  return el;
}

const btn = (text, action, kind = 'soft', attrs = {}) => node('button', { type: 'button', class: 'btn ' + kind, onclick: action, ...attrs }, text);
const field = (label, control) => node('label', { class: 'field' }, node('span', { class: 'fl' }, label), control);
const help = text => node('p', { class: 'cp-hint' }, text);
const panel = (title, ...children) => node('section', { class: 'glass group cp-card' }, node('h3', {}, title), ...children);
const textInput = (name, value, maxLength, attrs = {}) => node('input', { name, value, maxlength: maxLength, ...attrs });
function select(name, items, current, attrs = {}) {
  const input = node('select', { name, ...attrs });
  for (const [value, label] of Object.entries(items)) input.add(new Option(label, value));
  input.value = current;
  return input;
}
function slugify(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 100).replace(/^-|-$/g, '');
}
function badge(product, available = product.available) {
  if (product.archived) return node('span', { class: 'pill' }, 'Removed');
  return available ? node('span', { class: 'pill ok' }, 'Available') : node('span', { class: 'pill warn' }, 'Unavailable');
}
function thumb(image) {
  if (/^\/consumer-product-media\/[a-f0-9]{64}$/.test(image)) return photosPath + '/' + image.split('/').pop();
  return stockPath + (bundledImage.exec(image)?.[1] || 'roastery.webp');
}

// Re-encoding strips camera metadata and avoids sending the original photo to the server.
async function preparePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 24 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG or WebP photo under 24 MB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('This photo could not be opened. Choose another image.'); }
    const canvas = document.createElement('canvas');
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    for (const limit of [1200, 900, 640]) {
      const ratio = Math.min(1, limit / longest);
      canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const quality of [.84, .64, .46]) {
        let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob?.type !== 'image/webp') blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 220 * 1024 && ['image/jpeg', 'image/webp'].includes(blob.type)) return blob;
      }
    }
    throw new Error('This photo is too large. Choose a smaller file.');
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPhoto(api, blob) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('This photo could not be read. Choose it again.'));
    reader.readAsDataURL(blob);
  });
  const { image } = await api('POST', photosPath, { type: blob.type, data });
  if (!/^\/consumer-product-media\/[a-f0-9]{64}$/.test(image)) throw new Error('The photo could not be saved. Try again.');
  return image;
}

export function mountConsumerProducts(host, { api, confirmSheet }) {
  host.classList.add('consumer-products');
  let products = [], artwork = [], search = '', status = 'active', listScroll = 0, active = true, busy = false;
  let form, original = '', fileUrl = '', photoSequence = 0, photoBusy = false, pendingPhoto, uploadedPhoto;
  let call = 0, alertBox, publishedPages;
  const events = new AbortController();
  const missingCoffees = ids => (ids || []).filter(id => !products.some(p => p.id === id && p.available && !p.archived));
  const orderable = p => p.available && !missingCoffees(p.contents).length;
  const listRows = () => products.filter(p => {
    if (status === 'removed' ? !p.archived : p.archived) return false;
    if (status === 'available' && !orderable(p) || status === 'unavailable' && orderable(p)) return false;
    const query = search.toLocaleLowerCase('en-GB').trim();
    return !query || [p.name, p.id, p.country, categories[p.category || 'coffee'], ...(p.notes || [])].some(value => String(value || '').toLocaleLowerCase('en-GB').includes(query));
  });
  const formState = () => JSON.stringify([...new FormData(form)].filter(([key]) => key !== 'photoFile' && key !== 'newSize'));
  const isDirty = () => Boolean(form && (pendingPhoto || photoBusy || formState() !== original));
  function clearForm() {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = ''; pendingPhoto = uploadedPhoto = null; photoBusy = false; photoSequence++; form = null; original = '';
  }
  function notice(text) {
    alertBox.replaceChildren(document.createTextNode(text));
    alertBox.hidden = !text;
  }
  async function canLeave() {
    if (busy || photoBusy) { notice('Wait for the current change to finish.'); return false; }
    return !isDirty() || await confirmSheet({ title: 'Discard product changes?', text: 'Your edits to this product have not been saved.', confirm: 'Discard changes', danger: true });
  }
  function list(message = '', focusId) {
    clearForm();
    const searchInput = node('input', { type: 'search', value: search, placeholder: 'Name or origin', 'aria-label': 'Search products' });
    const filter = select('status', { active: 'Active', available: 'Available', unavailable: 'Unavailable', removed: 'Removed' }, status, { 'aria-label': 'Product status' });
    const results = node('ul', { class: 'cp-list' });
    const count = node('span', { class: 'cp-count', role: 'status' });
    const empty = node('div', { class: 'cp-empty' });
    const add = btn('Add product', () => openForm(null), '', { 'data-product-add': '' });
    function draw() {
      const rows = listRows();
      count.textContent = rows.length + (rows.length === 1 ? ' product' : ' products');
      results.replaceChildren(...rows.map(product => {
        const prices = Object.values(product.prices || {}).filter(Number.isInteger);
        const meta = [categories[product.category || 'coffee'], product.country].filter(Boolean).join(' · ');
        const price = prices.length ? (new Set(prices).size > 1 ? 'From ' : '') + currency.format(Math.min(...prices) / 100) : '—';
        const row = node('button', { class: 'cp-row', type: 'button', 'data-product-id': product.id,
          'aria-label': (product.archived ? 'View ' : 'Edit ') + product.name, onclick: () => openForm(product) },
          node('img', { alt: '', loading: 'lazy', decoding: 'async', width: 56, height: 56, src: thumb(product.image) }),
          node('span', { class: 'cp-row-name' }, node('strong', {}, product.name), node('small', {}, meta)),
          node('span', { class: 'cp-row-price' }, price), badge(product, orderable(product)), node('span', { class: 'cp-arrow', 'aria-hidden': true }, '›'));
        return node('li', {}, row);
      }));
      empty.hidden = rows.length > 0;
      empty.replaceChildren(node('strong', {}, search.trim() ? 'No matching products' : status === 'removed' ? 'No removed products' : 'No products here yet'));
      if (search.trim() || status !== 'active') empty.append(btn('Clear filters', () => {
        search = searchInput.value = ''; status = filter.value = 'active'; draw(); searchInput.focus();
      }));
    }
    searchInput.addEventListener('input', () => { search = searchInput.value; draw(); });
    filter.addEventListener('change', () => { status = filter.value; draw(); });
    alertBox = node('p', { class: 'consumer-message', role: 'status', hidden: !message }, message);
    host.replaceChildren(alertBox, node('section', { class: 'glass group cp-shelf', 'aria-label': 'Product catalogue' },
      node('header', { class: 'cp-shelf-head' }, node('div', {}, node('h2', {}, 'Catalogue'), count), add),
      node('div', { class: 'cp-tools' }, field('Search products', searchInput), field('Product status', filter)), results, empty));
    draw();
    if (focusId !== undefined) {
      const row = [...results.querySelectorAll('button')].find(el => el.dataset.productId === focusId);
      (row || add).focus({ preventScroll: true });
      window.scrollTo(0, listScroll);
    }
  }
  async function load() {
    const seq = ++call;
    clearForm();
    host.replaceChildren(node('p', { class: 'consumer-message', role: 'status' }, 'Loading products…'));
    try {
      const response = await api('GET', productsPath);
      if (!active || seq !== call) return;
      if (!Array.isArray(response.products)) throw new Error('The catalogue could not be read.');
      products = response.products;
      artwork = [...new Set(['/assets/roastery.webp', ...(response.artwork || products.map(p => p.image))].flatMap(path => {
        const filename = bundledImage.exec(path)?.[1];
        return filename ? [filename] : [];
      }))].sort();
      list();
    } catch (error) {
      if (!active || seq !== call) return;
      host.replaceChildren(node('div', { class: 'glass group cp-card', role: 'alert' }, node('h2', {}, 'Products unavailable'), help(error.message), btn('Try again', load)));
    }
  }
  function openForm(product) {
    const creating = !product, archived = Boolean(product?.archived);
    listScroll = window.scrollY;
    clearForm();
    const item = product || { name: '', category: 'coffee', available: true, prices: { '250g': null }, grinds, image: '/assets/roastery.webp' };
    const previous = async () => { if (await canLeave() && active) list('', product?.id || ''); };
    const back = btn('Back to products', previous);
    const save = node('button', { type: 'submit', class: 'btn' }, creating ? 'Create product' : 'Save changes');
    const name = textInput('name', item.name, 120, { required: true, autocomplete: 'off' });
    const slug = textInput('id', item.id || '', 100, { required: true, pattern: '[a-z0-9]+(?:-[a-z0-9]+)*', autocapitalize: 'none', spellcheck: 'false', readonly: !creating });
    let autoSlug = creating;
    slug.addEventListener('input', () => { autoSlug = slug.value === ''; });
    name.addEventListener('input', () => { if (autoSlug) slug.value = slugify(name.value); });
    const type = select('category', categories, item.category || 'coffee');
    const shortCopy = node('textarea', { name: 'shortCopy', maxlength: 320, rows: 2 }, item.shortCopy || '');
    const story = node('textarea', { name: 'story', maxlength: 3000, rows: 4 }, item.story || '');
    const country = textInput('country', item.country || '', 160);
    const region = textInput('region', item.region || '', 160);
    const process = textInput('process', item.process || '', 160);
    const profile = select('profile', { '': 'Choose a profile', Chocolatey: 'Chocolatey', Fruity: 'Fruity', Decaf: 'Decaf' }, item.profile || '');
    const notes = textInput('notes', (item.notes || []).join(', '), 744, { placeholder: 'Chocolate, hazelnut, praline' });
    const weight = textInput('shippingWeightGrams', item.shippingWeightGrams || '', 5, { type: 'number', step: 1, min: 1, max: 30000, placeholder: 'Use pack size' });
    const available = node('input', { type: 'checkbox', role: 'switch', class: 'switch', name: 'available', checked: item.available });
    const grindNames = [...new Set([...grinds, 'N/A', ...(item.grinds || [])])];
    const grindBox = node('fieldset', { class: 'cp-choices' }, node('legend', {}, 'Grind options'), grindNames.map(option =>
      node('label', { class: 'checkrow' }, node('input', { type: 'checkbox', name: 'grind', value: option, checked: item.grinds?.includes(option) }), option)));
    const contentChoices = products.filter(p => !p.archived && (!p.category || p.category === 'coffee') || item.contents?.includes(p.id));
    const contents = node('fieldset', { class: 'cp-choices cp-contents' }, node('legend', {}, 'Coffees in this flight'),
      contentChoices.map(p => node('label', { class: 'checkrow' }, node('input', { type: 'checkbox', name: 'contents', value: p.id, checked: item.contents?.includes(p.id) }), p.name)));
    const coffeeFields = panel('Coffee details', node('div', { class: 'cp-pair' }, field('Origin', country), field('Region', region)), node('div', { class: 'cp-pair' }, field('Process', process), field('Flavour profile', profile)), field('Tasting notes', notes), help('Separate tasting notes with commas.'), contents);

    const priceRows = node('div', { class: 'cp-prices' });
    const sizeMenu = select('newSize', {}, '', { 'aria-label': 'Choose another size' });
    const addSize = btn('Add size', () => {
      const input = addPrice(sizeMenu.value, null); input.focus();
    });
    const addRow = node('div', { class: 'cp-add-size' }, field('Another size', sizeMenu), addSize);
    function refreshSizes() {
      const used = [...priceRows.children].map(el => el.dataset.size);
      const remaining = Object.keys(sizes).filter(size => !used.includes(size));
      sizeMenu.replaceChildren(...remaining.map(size => new Option(sizes[size], size)));
      addRow.hidden = remaining.length === 0;
    }
    function addPrice(size, pence) {
      const amount = textInput('price-' + size, Number.isInteger(pence) ? (pence / 100).toFixed(2) : '', 9, {
        inputmode: 'decimal', 'aria-label': 'Price for ' + size, placeholder: '0.00', required: true,
      });
      const remove = btn('Remove', () => { row.remove(); refreshSizes(); (addRow.hidden ? save : sizeMenu).focus(); }, 'soft sm', { 'aria-label': 'Remove size ' + sizes[size] });
      const row = node('div', { class: 'cp-price-row', 'data-size': size }, node('strong', {}, sizes[size]),
        node('label', { class: 'field cp-price' }, node('span', { 'aria-hidden': true }, '£'), amount), remove);
      priceRows.append(row); refreshSizes(); return amount;
    }
    for (const [size, price] of Object.entries(item.prices || {})) if (sizes[size]) addPrice(size, price);
    function updateKind(userChange) {
      const coffee = type.value === 'coffee', flight = type.value === 'flight';
      coffeeFields.hidden = type.value === 'accessory'; contents.hidden = !flight; contents.disabled = !flight;
      if (userChange && creating) {
        const untouchedPrice = priceRows.children.length === 1 && !priceRows.querySelector('input').value;
        if (untouchedPrice) { priceRows.replaceChildren(); addPrice(coffee ? '250g' : flight ? '300g' : 'one', null); }
        for (const input of grindBox.querySelectorAll('input')) input.checked = coffee ? grinds.includes(input.value) : flight ? input.value === 'Whole bean' : input.value === 'N/A';
      }
    }
    type.addEventListener('change', () => updateKind(true));
    updateKind(false);

    const currentImage = item.image || '/assets/roastery.webp';
    const choices = Object.fromEntries(artwork.map(filename => ['/assets/' + filename, filename.replace(/\.webp$/, '').replaceAll('-', ' ')]));
    const savedPhoto = /^\/consumer-product-media\/[a-f0-9]{64}$/.test(currentImage);
    if (savedPhoto) choices[currentImage] = 'Current uploaded photo';
    const picture = select('image', choices, savedPhoto ? currentImage : '/assets/' + currentImage.split('/').pop());
    if (!picture.value) picture.value = '/assets/roastery.webp';
    const img = node('img', { class: 'cp-preview', src: thumb(picture.value), alt: 'Selected storefront product photo', width: 240, height: 150 });
    const file = node('input', { type: 'file', name: 'photoFile', accept: 'image/jpeg,image/png,image/webp' });
    const photoNote = node('span', { class: 'cp-hint', role: 'status' });
    const restorePicture = () => {
      photoSequence++; photoBusy = false; pendingPhoto = uploadedPhoto = null;
      if (fileUrl) URL.revokeObjectURL(fileUrl);
      fileUrl = ''; file.value = ''; photoNote.textContent = ''; img.src = thumb(picture.value);
      save.disabled = busy;
    };
    picture.addEventListener('change', restorePicture);
    file.addEventListener('change', async () => {
      const candidate = file.files[0];
      restorePicture();
      if (!candidate) return;
      const sequence = photoSequence;
      photoBusy = true; save.disabled = true; photoNote.textContent = 'Preparing photo…';
      try {
        const blob = await preparePhoto(candidate);
        if (!active || sequence !== photoSequence) return;
        pendingPhoto = blob; fileUrl = URL.createObjectURL(blob); img.src = fileUrl; photoNote.textContent = candidate.name + ' is ready to save.';
      } catch (error) { if (active && sequence === photoSequence) photoNote.textContent = error.message; }
      finally { if (active && sequence === photoSequence) { photoBusy = false; save.disabled = busy; } }
    });
    const resetPhoto = btn('Use selected artwork', restorePicture, 'soft sm');
    const imageCard = panel('Product photo', img, field('Storefront artwork', picture), field('Upload product photo', file), photoNote, resetPhoto);

    const flightStock = help('');
    const explainStock = () => {
      const selected = [...contents.querySelectorAll(':checked')].map(el => el.value);
      const missing = type.value === 'flight' ? missingCoffees(selected) : [];
      flightStock.hidden = !missing.length;
      flightStock.textContent = missing.length ? 'This flight is unavailable while these coffees are off sale: ' + missing.map(id => products.find(p => p.id === id)?.name || id).join(', ') + '.' : '';
    };
    for (const input of [contents, type]) input.addEventListener('change', explainStock);
    explainStock();
    const publication = panel('Availability', node('label', { class: 'cp-toggle' }, node('span', {}, 'Available to order'), available), flightStock);
    const remove = product ? btn('Remove product', () => changeArchive(true), 'bad') : null;
    const actions = node('div', { class: 'glass cp-form-actions' }, back, archived ? null : save);
    const details = panel('Product details', field('Product name', name),
      creating ? field('Product URL', slug) : node('div', { class: 'cp-storefront' },
        node('span', { class: 'cp-location' }, productPath(item)),
        node('a', { class: 'link', href: 'https://preview.staffstrangerscoffee.com' + productPath(item), target: '_blank', rel: 'noopener noreferrer' }, 'View in shop')),
      field('Product type', type), field('Short description', shortCopy), field('Product story', story));
    if (product && !archived) {
      publishedPages ||= api('GET', '/api/admin/consumer/editor/published').then(data => data.document?.pages).catch(() => null);
      publishedPages.then(pages => {
        const overrides = pages?.['product:' + item.id]?.fields;
        if (!active || !details.isConnected || !overrides) return;
        const labels = [
          ['Product name', ['product-title']], ['Product photo', ['product-image']], ['Photo description', ['product-image-alt']],
          ['Short description', ['product-description']], ['Tasting notes', ['note-1', 'note-2', 'note-3']],
        ].filter(([, keys]) => keys.some(key => Object.hasOwn(overrides, key))).map(([label]) => label);
        if (!labels.length) return;
        details.querySelector('h3').after(node('aside', { class: 'cp-overrides', 'aria-label': 'Published storefront overrides' },
          node('strong', {}, 'Set in the site editor'), node('p', {}, labels.join(' · ')),
          help('These storefront fields use the published design. Orders use the catalogue values.')));
      });
    }
    const pricing = panel('Sizes and prices', priceRows, addRow, field('Shipping weight override (g)', weight), help('Optional. A weight here applies to every size of this product.'), grindBox);
    const controls = node('fieldset', { class: 'cp-controls' },
      node('div', { class: 'cp-form-grid' },
        node('div', { class: 'cp-column' }, details, pricing, coffeeFields),
        node('div', { class: 'cp-column' }, publication, imageCard)),
      remove ? node('div', { class: 'cp-form-footer' }, remove) : null);
    alertBox = node('div', { class: 'consumer-message cp-error', role: 'alert', tabindex: '-1', hidden: true });
    const heading = node('h2', { tabindex: '-1' }, creating ? 'Add product' : item.name);
    const header = node('header', { class: 'cp-form-head' }, heading, product ? badge(product, orderable(product)) : null);
    form = node('form', { class: 'cp-form' }, actions, controls);
    const currentForm = form;
    function updateProduct(saved) {
      const match = products.findIndex(p => p.id === saved.id);
      if (match === -1) products.unshift(saved); else products[match] = saved;
    }
    function errorNotice(error, allowReload) {
      notice(error.message || 'This change could not be saved. Try again.');
      if (allowReload && error.status === 409) {
        alertBox.append(btn('Reload product', async () => {
          if (!await canLeave() || !active) return;
          busy = true;
          try {
            const latest = await api('GET', productsPath);
            if (!active) return;
            products = latest.products;
            const updated = products.find(p => p.id === item.id);
            if (updated) openForm(updated); else list('This product is no longer available.', '');
          } catch (failure) { if (active) notice(failure.message); }
          finally { busy = false; }
        }));
      }
      alertBox.focus(); alertBox.scrollIntoView({ block: 'nearest' });
    }
    async function changeArchive(removing) {
      if (busy || photoBusy) return;
      const confirmed = await confirmSheet(removing
        ? { title: 'Remove ' + item.name + '?', text: 'This removes the product from the consumer shop. Previous orders keep their original details. You can restore it from Removed products.' + (isDirty() ? ' Any unsaved edits will be discarded.' : ''), confirm: 'Remove product', danger: true }
        : { title: 'Restore ' + item.name + '?', text: 'The product will return to the consumer catalogue.', confirm: 'Restore product' });
      if (!confirmed || !active || form !== currentForm || busy) return;
      busy = true; controls.disabled = true; back.disabled = save.disabled = true;
      try {
        const { product: saved } = await api(removing ? 'DELETE' : 'PATCH', productsPath + '/' + encodeURIComponent(item.id),
          removing ? { ifVersion: item.version } : { ifVersion: item.version, archived: false });
        if (!active) return;
        updateProduct(saved);
        status = removing ? 'removed' : 'active'; search = ''; list(item.name + (removing ? ' removed.' : ' restored.'), saved.id);
      } catch (error) { if (active) errorNotice(error, true); }
      finally { busy = false; controls.disabled = false; back.disabled = save.disabled = false; }
    }
    form.addEventListener('input', e => e.target.setCustomValidity?.(''));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (busy || photoBusy || archived) return;
      const text = control => control.value.trim();
      const fail = (field, message) => { field.setCustomValidity(message); field.reportValidity(); };
      if (!text(name)) return fail(name, 'Enter a product name.');
      if (!priceRows.children.length) { notice('Add at least one size and price.'); sizeMenu.focus(); return; }
      const prices = {};
      for (const row of priceRows.children) {
        const input = row.querySelector('input');
        const match = /^(\d{1,5})(?:[.,](\d{1,2}))?$/.exec(text(input));
        const pence = match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : 0;
        if (pence < 1 || pence > 1000000) return fail(input, 'Enter a price from £0.01 to £10,000.00 with up to two decimal places.');
        prices[row.dataset.size] = pence;
      }
      const checked = box => [...box.querySelectorAll(':checked')].map(input => input.value);
      const selectedGrinds = checked(grindBox);
      if (!selectedGrinds.length) { notice('Choose at least one grind option.'); grindBox.querySelector('input').focus(); return; }
      const selectedNotes = text(notes).split(',').map(s => s.trim()).filter(Boolean);
      if (selectedNotes.length > 12 || selectedNotes.some(s => s.length > 60)) return fail(notes, 'Enter up to 12 notes with 60 characters each.');
      const flightContents = type.value === 'flight' ? checked(contents) : [];
      if (type.value === 'flight' && (!flightContents.length || flightContents.length > 12)) {
        notice('Choose between 1 and 12 coffees for this flight.'); contents.querySelector('input')?.focus(); return;
      }
      const values = { name: text(name), category: type.value, available: available.checked, image: picture.value, prices, grinds: selectedGrinds,
        shortCopy: text(shortCopy), story: text(story), notes: selectedNotes, profile: profile.value, country: text(country), region: text(region), process: text(process), contents: flightContents,
        shippingWeightGrams: weight.value ? Number(weight.value) : null };
      const initial = { shortCopy: '', story: '', notes: [], profile: '', country: '', region: '', process: '', contents: [], shippingWeightGrams: null, ...item,
        category: item.category || 'coffee', image: savedPhoto ? currentImage : '/assets/' + currentImage.split('/').pop() };
      // Keep the chosen ordering of an existing flight or grind list when someone edits its title or price.
      for (const key of ['grinds', 'contents']) {
        const previous = initial[key] || [], next = values[key];
        values[key] = [...previous.filter(value => next.includes(value)), ...next.filter(value => !previous.includes(value))];
      }
      busy = true; controls.disabled = true; back.disabled = save.disabled = true; notice(''); save.textContent = 'Saving…';
      try {
        if (pendingPhoto) { uploadedPhoto ||= await uploadPhoto(api, pendingPhoto); values.image = uploadedPhoto; }
        const patch = creating ? { ...values, id: text(slug) } : Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(initial[key]) !== JSON.stringify(value)));
        if (!creating && !Object.keys(patch).length) { list('No changes to save.', item.id); return; }
        if (!creating) patch.ifVersion = item.version;
        const { product: saved } = await api(creating ? 'POST' : 'PATCH', creating ? productsPath : productsPath + '/' + encodeURIComponent(item.id), patch);
        if (!active) return;
        updateProduct(saved);
        status = 'active'; search = ''; list(saved.name + (creating ? ' created.' : ' updated.'), saved.id);
      } catch (error) { if (active) errorNotice(error, !creating); }
      finally { busy = false; controls.disabled = false; back.disabled = save.disabled = false; save.textContent = creating ? 'Create product' : 'Save changes'; }
    });
    host.replaceChildren(header, alertBox);
    if (archived) {
      const restore = btn('Restore product', () => changeArchive(false));
      controls.replaceChildren(node('section', { class: 'glass group cp-card cp-removed' }, node('h3', {}, 'Removed from the shop'), help('Restore this product to edit its details and availability.'), restore));
    }
    host.append(form); original = formState();
    heading.focus({ preventScroll: true }); host.scrollIntoView({ block: 'start' });
  }
  window.addEventListener('beforeunload', event => {
    if (!busy && !isDirty()) return;
    event.preventDefault(); event.returnValue = '';
  }, { signal: events.signal });
  load();
  return { isDirty, canLeave, destroy() { active = false; call++; clearForm(); events.abort(); host.replaceChildren(); host.classList.remove('consumer-products'); } };
}
