import {photo} from './editor-photo-url.js';

function widgetElement(doc, widget, preview, design, commerce) {
  const section = doc.createElement('article');
  section.className = 'consumer-widget consumer-widget-' + widget.type;
  section.dataset.consumerWidget = widget.id;
  section.dataset.widgetLayout = widget.layout || 'stack';
  function text(parent, tag, value) {
    if (!value) return;
    const node = doc.createElement(tag);
    node.textContent = value;
    parent.append(node);
  }
  if (widget.type === 'divider') {
    section.append(doc.createElement('hr'));
    return section;
  }
  const src = photo(widget.image, preview);
  if (src) {
    const image = doc.createElement('img');
    image.alt = widget.alt || '';
    image.loading = 'lazy';
    image.src = src;
    section.append(image);
  }
  const copy = doc.createElement('div');
  copy.className = 'consumer-widget-copy';
  text(copy, 'h2', widget.heading);
  text(copy, 'p', widget.body);
  if (widget.href && widget.label) {
    const link = doc.createElement('a');
    link.className = 'button';
    link.href = widget.href;
    link.textContent = widget.label;
    copy.append(link);
  }
  if (copy.childElementCount) section.append(copy);
  if (['coffee-shelf','locations-list'].includes(widget.type)) {
    const content = commerce?.createRetailWidget(doc, widget, design, {preview});
    if (content) section.append(content);
  }
  return section;
}

function customNavigation(doc, design) {
  const nav = doc.querySelector('.site-footer nav[aria-labelledby="footer-explore"]');
  if (!nav) return;
  const links = design.navigation || Object.entries(design.pages)
    .filter(([key, page]) => key.startsWith('custom:') && page.inNavigation)
    .map(([key, page]) => ({href: '/pages/' + key.slice(7) + '/', title: page.title}));
  const existing = new Map(Array.from(nav.querySelectorAll('[data-consumer-page-link]'), a => [a.getAttribute('href'), a]));
  for (const {href, title} of links) {
    if (!href || !title) continue;
    const link = existing.get(href) || doc.createElement('a');
    link.setAttribute('href', href);
    link.dataset.consumerPageLink = '';
    if (link.textContent !== title) link.textContent = title;
    if (!link.parentNode) nav.append(link);
    existing.delete(href);
  }
  existing.forEach(link => link.remove());
}

/** Reduce generic product and specific coffee edits to a single, reversible page presentation. */
function productPresentation(generic, specific) {
  if (!generic) return specific || {};
  if (!specific) return generic;
  const widgets = new Map((generic.widgets || []).map(widget => [widget.id, widget]));
  for (const widget of specific.widgets || []) widgets.set(widget.id, widget);
  return {...generic, ...specific, widgets:[...widgets.values()],
    meta:{...generic.meta,...specific.meta}, fields:{...generic.fields, ...specific.fields}, sectionLayouts:{...generic.sectionLayouts, ...specific.sectionLayouts}};
}

export function presentation(doc, scope, initial, description, onPick, commerce) {
  const preview = typeof onPick === 'function';
  const baseScope = ['shared','finder','cart'].includes(scope) ? 'home' : scope;
  let design = initial;
  let loadingCommerce = false;
  let picked;
  let targets = new WeakMap();
  let activeNodes = new Map();
  let layoutRoot;
  let endMarker;
  const anchors = new Map();
  const widgets = new Map();
  let observer;
  let pending = false;
  let dead = false;

  function mark(node, key, detail) {
    if (!preview) return;
    const selection = targets.get(node) || {scope:key};
    if (selection.scope !== key) {
      targets.set(node, {scope:key,...detail});
    } else {
      Object.assign(selection, detail);
      targets.set(node, selection);
    }
    node.dataset.consumerEditable = '';
  }
  function applyFields(desired) {
    // Save native values while an override is in effect. When the app changes the underlying view
    // (e.g. a different finder step), release the old override without clobbering the new title.
    for (const [node, entries] of activeNodes) for (const [property, entry] of entries) {
      if (desired.get(node)?.has(property)) continue;
      const actual = property === 'text' ? node.textContent : node.getAttribute(property);
      if (node.isConnected && actual === entry.value) {
        if (property === 'text') node.replaceChildren(...entry.original);
        else if (entry.original === null) node.removeAttribute(property);
        else node.setAttribute(property, entry.original);
      }
      entries.delete(property);
    }
    for (const [node, attrs] of desired) {
      const entries = activeNodes.get(node) || new Map();
      for (const [property, value] of attrs) {
        const actual = property === 'text' ? node.textContent : node.getAttribute(property);
        const prev = entries.get(property);
        if (!prev || prev.value !== actual) {
          entries.set(property, {original:property === 'text' ? [...node.childNodes] : actual, value});
        } else prev.value = value;
        if (actual === value) continue;
        if (property === 'text') node.textContent = value;
        else if (value === null) node.removeAttribute(property);
        else node.setAttribute(property, value);
      }
      activeNodes.set(node, entries);
    }
    for (const [node, entries] of activeNodes) if (!entries.size || !node.isConnected) activeNodes.delete(node);
  }
  function markFields(key, settings, desired) {
    const meta = description(key, design);
    if (!meta) return;
    for (const field of meta.fields) {
      const overridden = Object.hasOwn(settings.fields || {}, field.id);
      if (!overridden && !preview) continue;
      for (const node of doc.querySelectorAll(field.selector)) {
        // Text, rather than alt text or URL, is the primary selection for a linked label.
        if (!targets.get(node)?.field || ['image','text'].includes(field.kind)) mark(node, key, {field:field.id});
        if (!overridden) continue;
        const value = settings.fields[field.id];
        const attrs = desired.get(node) || new Map();
        if (field.kind === 'image') {
          const src = photo(value, preview);
          attrs.set('data-consumer-image-hidden', src ? null : '');
          if (src) {
            attrs.set('src', src);
            attrs.set('srcset', null);
          }
        } else {
          attrs.set(field.kind === 'link' ? 'href' : field.kind, value);
        }
        desired.set(node, attrs);
      }
    }
  }

  // Preserve every native element, its form listeners and unrelated siblings. Original slots
  // stay in the DOM so Undo can restore layout without re-creating account/checkout controls.
  function setSections(key, meta, settings) {
    const root = doc.querySelector(meta.root || 'main');
    if (!root) return;
    if (layoutRoot !== root) {
      layoutRoot = root; anchors.clear(); widgets.clear(); endMarker = null;
    }
    const natives = new Map();
    for (const section of meta.sections) {
      const node = root.querySelector(section.selector);
      if (!node || node.parentNode !== root) continue;
      natives.set(section.id, node);
      mark(node, key, {section:section.id});
      if (!section.locked && settings.hidden?.includes(section.id)) node.dataset.consumerSectionHidden = '';
      else node.removeAttribute('data-consumer-section-hidden');
      const layout = settings.sectionLayouts?.[section.id];
      if (layout) node.dataset.consumerSectionLayout = layout;
      else node.removeAttribute('data-consumer-section-layout');
    }
    if (!settings.sections?.length && !settings.widgets?.length && !anchors.size && !widgets.size) return;
    // A dynamic product render can replace the entire contents of its root at any time.
    for (const [id, anchor] of anchors) if (anchor.parentNode !== root || !natives.has(id)) {
      anchor.remove(); anchors.delete(id);
    }
    for (const [id, node] of natives) if (!anchors.has(id)) {
      const slot = doc.createComment('native section');
      node.before(slot);
      anchors.set(id, slot);
    }
    if (!endMarker || endMarker.parentNode !== root) {
      endMarker = doc.createComment('added sections');
      root.append(endMarker);
    }
    const configured = new Map((settings.widgets || []).map(item => [item.id,item]));
    for (const [id, value] of widgets) if (!configured.has(id)) {value.node.remove(); widgets.delete(id);}
    for (const [id, item] of configured) {
      const signature = JSON.stringify(item) + Boolean(commerce) + (item.type === 'coffee-shelf' ? commerce?.availability.revision ?? 0 : '') + (item.type === 'coffee-shelf'
        ? JSON.stringify(design.productFields || Object.fromEntries(Object.entries(design.pages).filter(([id]) => id.startsWith('product:')))) : '');
      let entry = widgets.get(id);
      if (!entry || entry.signature !== signature) {
        // Custom pages arrive with readable editorial HTML. Adopt the server-rendered article
        // so the first client pass keeps it in place. Catalogue widgets add their live card grid.
        const rendered = !preview && !entry && [...root.children].find(child => child.getAttribute('data-consumer-rendered-widget') === id);
        const editorial = !['coffee-shelf','locations-list'].includes(item.type);
        const node = rendered && editorial ? rendered : widgetElement(doc, item, preview, design, commerce);
        if (rendered && rendered !== node) rendered.replaceWith(node);
        node.removeAttribute('data-consumer-rendered-widget');
        entry?.node.replaceWith(node);
        entry = {signature, node};
        widgets.set(id, entry);
      }
      mark(entry.node, key, {widget:id});
    }
    const order = [...new Set([...(settings.sections || []), ...natives.keys(), ...widgets.keys()])];
    const ordered = order.map(id => natives.get(id) || widgets.get(id)?.node).filter(Boolean);
    const slots = [...root.childNodes].filter(node => node.nodeType === 8 && [...anchors.values()].includes(node));
    // Place each entry after its slot, then any extras immediately before the tail marker.
    for (let i = 0; i < ordered.length; i++) {
      const node = ordered[i];
      if (i < slots.length) {
        if (slots[i].nextSibling !== node) slots[i].after(node);
      } else {
        const tail = ordered.slice(i);
        if (!tail.every((entry, j) => entry.parentNode === root && entry.nextSibling === (tail[j + 1] || endMarker))) {
          for (const entry of tail) root.insertBefore(entry, endMarker);
        }
        break;
      }
    }
  }

  function paintSelection(scroll = false) {
    if (!preview) return;
    for (const element of doc.querySelectorAll('[data-consumer-selected]')) element.removeAttribute('data-consumer-selected');
    if (!picked) return;
    const key = picked.field ? 'field' : picked.widget ? 'widget' : 'section';
    let match;
    if (key === 'field') {
      const field = description(picked.scope,design)?.fields.find(item => item.id === picked.field);
      if (field) {
        const nodes = [...doc.querySelectorAll(field.selector)];
        match = nodes.find(node => node.getClientRects().length) || nodes[0];
      }
    } else {
      match = Array.from(doc.querySelectorAll('[data-consumer-editable]')).find(node => {
        const item = targets.get(node);
        return item && item.scope === picked.scope && item[key] === picked[key];
      });
    }
    if (!match) return;
    match.dataset.consumerSelected = '';
    if (scroll) match.scrollIntoView?.({block:'nearest', behavior:'instant'});
  }

  function paint() {
    if (dead) return;
    observer?.disconnect();
    try {
      if (preview) {
        targets = new WeakMap();
        for (const node of doc.querySelectorAll('[data-consumer-editable]')) node.removeAttribute('data-consumer-editable');
      }
      const specific = baseScope.startsWith('product:');
      const settings = specific ? productPresentation(design.pages.product, design.pages[baseScope]) : design.pages[baseScope] || {};
      const shared = design.pages.shared || {};
      if (settings.meta?.title && doc.title !== settings.meta.title) doc.title = settings.meta.title;
      const summary = doc.querySelector('meta[name="description"]');
      if (settings.meta?.description && summary?.content !== settings.meta.description) summary?.setAttribute('content', settings.meta.description);
      doc.documentElement.dataset.consumerTheme = settings.theme || design.theme || 'heritage';
      for (const node of doc.querySelectorAll('.notice, .site-header, .site-footer')) {
        if (shared.theme) node.dataset.consumerTheme = shared.theme;
        else node.removeAttribute('data-consumer-theme');
      }
      doc.documentElement.dataset.consumerLayout = settings.layout || 'standard';
      const hasMerchandising = Object.keys(design.productFields || {}).length ||
        settings.widgets?.some(widget => ['coffee-shelf','locations-list'].includes(widget.type));
      if (hasMerchandising && !commerce && !loadingCommerce) {
        loadingCommerce = true;
        import('./editor-shop-widgets.js').then(async module => {
          commerce = module;
          if (!preview && settings.widgets?.some(widget => widget.type === 'coffee-shelf')) await module.availability.refresh();
          schedule();
        }).catch(() => {
          // Native catalogue and checkout continue to work if an optional display module fails to load.
          loadingCommerce = false;
        });
      }
      const desired = new Map();
      commerce?.applyLinkedProductFields(doc, design, {preview, desired});
      markFields('shared', shared, desired);
      const meta = description(baseScope,design);
      if (meta) {
        setSections(baseScope,meta,settings);
        if (specific) markFields('product', design.pages.product || {}, desired);
        markFields(baseScope,settings,desired);
      }
      const title = doc.querySelector('.consumer-page-title');
      if (title && settings.title && title.textContent !== settings.title) title.textContent = settings.title;
      customNavigation(doc, design);
      const dialog = doc.querySelector('#dialog');
      const dialogueScope = ({bag:'cart',finder:'finder'})[dialog?.dataset.view];
      if (dialog && dialogueScope) {
        const overlay = design.pages[dialogueScope] || {};
        if (overlay.theme) dialog.dataset.consumerTheme = overlay.theme;
        else dialog.removeAttribute('data-consumer-theme');
        markFields(dialogueScope,overlay,desired);
      } else dialog?.removeAttribute('data-consumer-theme');
      applyFields(desired);
      paintSelection();
    } finally {
      if (observer && !dead) observer.observe(doc.body, {subtree:true, childList:true, characterData:true, attributes:true,
        attributeFilter:['src','srcset','alt','data-view','open','aria-pressed','data-gallery-current','data-auth-mode','hidden']});
    }
  }
  function schedule() {
    if (pending || dead) return;
    pending = true;
    queueMicrotask(() => {pending = false; paint();});
  }
  function pick(event) {
    // The canvas is display-only. This also guards links/buttons inserted by native templates.
    event.preventDefault();
    event.stopImmediatePropagation();
    let element = event.target;
    while (element && !targets.has(element)) element = element.parentElement;
    if (element) onPick({...targets.get(element)});
  }
  const prevent = event => {event.preventDefault(); event.stopImmediatePropagation();};
  if (preview) {
    doc.documentElement.dataset.consumerCanvas = '';
    doc.addEventListener('mousedown', prevent, true);
    doc.addEventListener('click', pick, true);
    doc.addEventListener('auxclick', prevent, true);
    doc.addEventListener('submit', prevent, true);
    doc.addEventListener('dragstart', prevent, true);
  }
  doc.addEventListener('retail-catalogue-updated', schedule);
  const Observer = doc.defaultView?.MutationObserver;
  if (Observer) observer = new Observer(schedule);
  paint();
  return {
    update(next) {design = next; paint();},
    select(selection) {picked = selection; paintSelection(true);},
    destroy() {
      dead = true;
      doc.removeEventListener('retail-catalogue-updated',schedule);
      observer?.disconnect(); activeNodes.clear(); widgets.clear(); anchors.clear();
      doc.removeEventListener('mousedown',prevent,true); doc.removeEventListener('click',pick,true); doc.removeEventListener('auxclick',prevent,true);
      doc.removeEventListener('submit',prevent,true); doc.removeEventListener('dragstart',prevent,true);
    },
  };
}

if (typeof document !== 'undefined') {
  const data = document.getElementById('consumer-design');
  if (data) {
    const design = JSON.parse(data.textContent);
    presentation(document, design.scope, design, key => design.definitions[key]);
  }
}
