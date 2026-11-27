import {photo} from './editor-photo-url.js';
import {formattedText, setFormattedText} from './editor-text.js';

function widgetElement(doc, widget, preview, design, commerce) {
  const section = doc.createElement('article');
  section.className = 'consumer-widget consumer-widget-' + widget.type;
  section.dataset.consumerWidget = widget.id;
  section.dataset.widgetLayout = widget.layout || 'stack';
  function text(parent, tag, value) {
    if (!value && !(preview && value === '')) return;
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
  if ((widget.href && widget.label) || (preview && (widget.href || widget.label))) {
    const link = doc.createElement('a');
    link.className = 'button';
    link.href = widget.href || '#';
    link.textContent = widget.label || '';
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
  let targets = new Map();
  let pickedNode;
  let hoveredNode;
  const addedTabStops = new Set();
  let activeNodes = new Map();
  const textTemplates = new WeakMap();
  let layoutRoot;
  let endMarker;
  const anchors = new Map();
  const widgets = new Map();
  let observer;
  let pending = false;
  let dead = false;

  // A linked image, for example, has separate editable image, alt and URL
  // properties. Retain all of them and resolve the specific instance clicked.
  function mark(node, key, detail, descriptor, sourceNode) {
    if (!preview || !node) return;
    const field = detail.field && (descriptor || description(key,design)?.fields.find(item => item.id === detail.field));
    if (detail.field && !field) return;
    let target = targets.get(node);
    if (!target || target.scope !== key) {
      target = {scope:key, fields:[]};
      targets.set(node,target);
    }
    if (field) {
      if (!target.fields.some(item => item.id === field.id)) target.fields.push(sourceNode ? {...field,node:sourceNode} : field);
      if (!target.field || field.kind === 'text' || field.kind === 'image') target.field = field.id;
    } else Object.assign(target, detail);
    node.dataset.consumerEditable = '';
    if (!node.hasAttribute('tabindex') && !node.matches('a[href],button,input,select,textarea,summary,.sr-only')) {
      node.tabIndex = 0;
      addedTabStops.add(node);
    }
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
        if (property === 'text') {
          const template = textTemplates.get(node);
          if (template) setFormattedText(node, formattedText(template, value));
          else node.textContent = value;
        }
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
      if (key === 'shared' && (field.id === 'account-label' || field.id === 'bag-label')) {
        const account = field.id === 'account-label';
        const control = doc.querySelector(account ? '.site-header .account-link' : '.site-header [data-bag]');
        const caption = doc.querySelector(field.selector);
        if (control && caption && account) mark(control, key, {field:field.id}, field, caption);
        if (control && overridden) {
          const count = doc.querySelector('#bag-count')?.textContent;
          const label = settings.fields[field.id] + (!account && count ? ', ' + count + (count === '1' ? ' item' : ' items') : '');
          const attrs = desired.get(control) || new Map();
          attrs.set('aria-label',label);
          desired.set(control,attrs);
        }
      }
      for (const node of doc.querySelectorAll(field.selector)) {
        mark(node, key, {field:field.id}, field);
        if (!overridden) continue;
        if (field.kind === 'text') {
          if (field.inline) textTemplates.set(node, field.inline);
          else textTemplates.delete(node);
        }
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
      if (preview) {
        const source = key.startsWith('product:') && !design.pages[key]?.widgets?.some(widget => widget.id === id)
          ? 'product' : key;
        mark(entry.node, source, {widget:id});
        const copy = entry.node.querySelector(':scope > .consumer-widget-copy');
        mark(copy?.querySelector('h2'), source, {widget:id,part:'heading'});
        mark(copy?.querySelector('p'), source, {widget:id,part:'body'});
        mark(copy?.querySelector('a'), source, {widget:id,part:'label'});
        mark(entry.node.querySelector(':scope > img'), source, {widget:id,part:'image'});
      }
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

  function selectionOf(node) {
    const target = targets.get(node);
    if (!target) return;
    const {fields, ...selection} = target;
    return selection;
  }
  function visibleAnchor(node) {
    // Icon-only controls can keep their caption visually hidden at phone sizes.
    // Edit that same caption, but place the outline and editor on its button.
    if (node && (node.classList.contains('sr-only') || !node.getClientRects().length)) {
      return node.closest('button,a,label,summary') || node;
    }
    return node;
  }
  function hitAt(node) {
    const target = targets.get(node);
    if (!target) return;
    const fields = target.fields.map(field => ({...field, scope:target.scope, node:field.node || node}));
    const link = node.closest('a');
    const linkTarget = link !== node && targets.get(link);
    if (linkTarget) for (const field of linkTarget.fields) {
      if (field.kind === 'link') fields.push({...field,scope:linkTarget.scope,node:link});
    }
    fields.sort((a,b) => Number(b.id === target.field) - Number(a.id === target.field));
    return {node:visibleAnchor(node),fields};
  }
  function matchesPick(node, selection) {
    const target = targets.get(node);
    if (!target || target.scope !== selection.scope) return false;
    if (selection.field) return target.fields.some(field => field.id === selection.field);
    if (selection.widget) return target.widget === selection.widget && target.part === selection.part;
    if (selection.pageTitle) return target.pageTitle;
    return selection.section && target.section === selection.section;
  }
  function findTarget(selection) {
    if (!preview || !selection) return;
    if (pickedNode?.isConnected && matchesPick(pickedNode,selection)) return pickedNode;
    for (const node of targets.keys()) {
      if (node.isConnected && matchesPick(node,selection) && visibleAnchor(node).getClientRects().length) return node;
    }
  }
  function getTarget(selection = picked) { return hitAt(findTarget(selection)); }
  function targetList() {
    const entries = [];
    if (!preview || dead) return entries;
    const openDialogs = doc.querySelectorAll('dialog[open]');
    const root = openDialogs[openDialogs.length - 1] || doc;
    for (const node of root.querySelectorAll('[data-consumer-editable]')) {
      const selection = selectionOf(node);
      if (!selection || !(selection.field || selection.pageTitle || selection.part)) continue;
      const anchor = visibleAnchor(node);
      if (!anchor.getClientRects().length || anchor.closest('[hidden],[inert]')) continue;
      if (anchor.checkVisibility && !anchor.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
      if (targetFor(anchor) !== node) continue;
      entries.push({selection,hit:hitAt(node)});
    }
    return entries;
  }
  function paintSelection(scroll = false) {
    if (!preview) return;
    pickedNode = findTarget(picked);
    const node = visibleAnchor(pickedNode);
    for (const previous of doc.querySelectorAll('[data-consumer-selected]')) {
      if (previous !== node) previous.removeAttribute('data-consumer-selected');
    }
    if (node) {
      node.dataset.consumerSelected = '';
      if (scroll) node.scrollIntoView?.({block:'nearest', behavior:'instant'});
    }
  }
  function paint() {
    if (dead) return;
    observer?.disconnect();
    try {
      const previousTargets = targets;
      if (preview) targets = new Map();
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
      const meta = description(baseScope,design);
      if (meta) setSections(baseScope,meta,settings);
      commerce?.applyLinkedProductFields(doc, design, {preview, desired, mark:preview ? mark : undefined});
      markFields('shared', shared, desired);
      if (meta) {
        if (specific) markFields('product', design.pages.product || {}, desired);
        markFields(baseScope,settings,desired);
      }
      const title = doc.querySelector('.consumer-page-title');
      if (title && settings.title && title.textContent !== settings.title) title.textContent = settings.title;
      if (title && baseScope.startsWith('custom:')) mark(title,baseScope,{pageTitle:true});
      customNavigation(doc, design);
      if (preview) for (const link of doc.querySelectorAll('[data-consumer-page-link]')) {
        const slug = /^\/pages\/([a-z0-9-]+)\/$/.exec(link.getAttribute('href'))?.[1];
        if (slug) mark(link,'custom:' + slug,{pageTitle:true});
      }
      const dialog = doc.querySelector('#dialog');
      const dialogueScope = ({bag:'cart',finder:'finder'})[dialog?.dataset.view];
      if (dialog && dialogueScope) {
        const overlay = design.pages[dialogueScope] || {};
        if (overlay.theme) dialog.dataset.consumerTheme = overlay.theme;
        else dialog.removeAttribute('data-consumer-theme');
        markFields(dialogueScope,overlay,desired);
      } else dialog?.removeAttribute('data-consumer-theme');
      applyFields(desired);
      if (preview) for (const node of previousTargets.keys()) {
        if (!targets.has(node)) unmark(node);
      }
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
  function unmark(node) {
    node.removeAttribute('data-consumer-editable');
    node.removeAttribute('data-consumer-hovered');
    node.removeAttribute('data-consumer-selected');
    if (addedTabStops.delete(node)) node.removeAttribute('tabindex');
    if (hoveredNode === node) hoveredNode = undefined;
  }
  function targetFor(element) {
    if (!element?.closest) return;
    const nearest = element.closest('[data-consumer-editable]');
    const target = targets.get(nearest);
    const control = element.closest('a,button,label,summary');
    if (control && (!nearest || !control.contains(nearest) || nearest === control && !target?.fields.some(f => f.kind === 'text' || f.kind === 'image'))) {
      // Clicking button padding or its icon should edit its caption as readily
      // as clicking the text itself. A linked photograph remains its own target.
      const candidates = Array.from(control.querySelectorAll('[data-consumer-editable]'));
      const labels = candidates.filter(node => targets.get(node)?.fields.some(f => f.kind === 'text'));
      const label = labels.find(node => node.getClientRects().length && !node.classList.contains('sr-only'));
      const image = candidates.find(node => targets.get(node)?.fields.some(f => f.kind === 'image') && node.getClientRects().length);
      return label || image || labels[0] || nearest;
    }
    return nearest;
  }
  function hover(element) {
    const node = visibleAnchor(targetFor(element));
    if (hoveredNode === node) return;
    hoveredNode?.removeAttribute('data-consumer-hovered');
    if (node) node.dataset.consumerHovered = '';
    hoveredNode = node;
  }
  const over = event => {if (event.pointerType !== 'touch') hover(event.target);};
  const out = event => {if (event.pointerType !== 'touch') hover(event.relatedTarget);};
  const prevent = event => {event.preventDefault(); event.stopImmediatePropagation();};
  function caretAt(event, node, selection, hit) {
    if (event.type !== 'click' || event.detail === 0) return;
    const text = hit.fields.find(field => field.id === selection.field && field.kind === 'text');
    const source = text?.node || ((selection.pageTitle || ['heading','body','label'].includes(selection.part)) && node);
    if (!source || !source.contains(event.target)) return;
    const x = event.clientX, y = event.clientY;
    const position = doc.caretPositionFromPoint?.(x,y);
    const fallback = position ? null : doc.caretRangeFromPoint?.(x,y);
    const textNode = position?.offsetNode || fallback?.startContainer;
    if (textNode?.nodeType !== 3 || !source.contains(textNode)) return;
    const range = doc.createRange();
    range.selectNodeContents(textNode);
    // Some browsers snap a click on button padding to the nearest line of text.
    if (![...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return;
    range.selectNodeContents(source);
    range.setEnd(textNode,position?.offset ?? fallback.startOffset);
    return range.toString().length;
  }
  function pick(event) {
    prevent(event);
    const node = targetFor(event.target);
    const selection = selectionOf(node);
    if (!selection) return;
    picked = selection;
    pickedNode = node;
    paintSelection();
    const hit = hitAt(node);
    hit.caretOffset = caretAt(event,node,selection,hit);
    onPick({...selection},hit);
  }
  function keyboard(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.repeat) prevent(event);
      else pick(event);
    } else if (event.key !== 'Tab' && event.key !== 'Escape' && event.target.matches?.('input,select,textarea')) prevent(event);
  }
  const disabledPointer = event => {
    if (event.button === 0 && event.target.closest?.(':disabled')) pick(event);
  };
  if (preview) {
    doc.documentElement.dataset.consumerCanvas = '';
    doc.addEventListener('pointerover',over,true);
    doc.addEventListener('pointerout',out,true);
    doc.addEventListener('pointerup',disabledPointer,true);
    doc.addEventListener('keydown',keyboard,true);
    doc.addEventListener('mousedown', prevent, true);
    doc.addEventListener('click', pick, true);
    doc.addEventListener('auxclick', prevent, true);
    doc.addEventListener('contextmenu', prevent, true);
    doc.addEventListener('submit', prevent, true);
    doc.addEventListener('dragstart', prevent, true);
  }
  doc.addEventListener('retail-catalogue-updated', schedule);
  const Observer = doc.defaultView?.MutationObserver;
  if (Observer) observer = new Observer(schedule);
  paint();
  return {
    update(next) {design = next; paint();},
    select(selection, {scroll = true, node} = {}) {
      picked = selection;
      if (selection && node?.ownerDocument === doc) {
        const exact = matchesPick(node,selection) ? node : targetFor(node);
        if (matchesPick(exact,selection)) pickedNode = exact;
      }
      paintSelection(scroll);
    },
    getTarget, targetList,
    destroy() {
      dead = true;
      doc.removeEventListener('retail-catalogue-updated',schedule);
      observer?.disconnect(); activeNodes.clear(); widgets.clear(); anchors.clear();
      for (const node of targets.keys()) unmark(node);
      if (preview) for (const node of doc.querySelectorAll('[data-consumer-selected],[data-consumer-hovered]')) unmark(node);
      targets.clear();
      addedTabStops.clear();
      if (preview) doc.documentElement.removeAttribute('data-consumer-canvas');
      doc.removeEventListener('pointerover',over,true); doc.removeEventListener('pointerout',out,true);
      doc.removeEventListener('pointerup',disabledPointer,true); doc.removeEventListener('keydown',keyboard,true);
      doc.removeEventListener('contextmenu',prevent,true);
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
