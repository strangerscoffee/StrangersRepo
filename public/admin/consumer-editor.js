import {
  cataloguePageForKey, COFFEE_CHOICES, THEMES, LAYOUTS, WIDGET_TYPES, ASSETS, TEMPLATES, emptyDocument, imageUrl, referencedMedia, safeLink, validateDocument,
} from '/api/admin/consumer/editor/assets/editor-model.js';
import { availability, products } from '/api/admin/consumer/editor/assets/products.js';
import { hasPageSeo, seoInspector } from './consumer-editor-seo.js';
import { mountEditorCanvas } from '/api/admin/consumer/editor/assets/editor-render.js';

import { editorPages, mountEditorPages } from './consumer-editor-pages.js';
import { buildPublishReview, renderPublishReview } from './consumer-editor-review.js';
import { mountDirectEditor } from './consumer-editor-direct.js';
import { defaultWidget, editorialCopy, movedSections, renderLayoutTools } from './consumer-editor-layout-tools.js';
import { orderedSections, effectiveStyle, SECTION_STYLES } from '/api/admin/consumer/editor/assets/editor-layout.js';
import { responsiveFields } from './consumer-editor-responsive.js';

const previewStates = {
  finder: [['brew','Brew method'], ['taste','Taste'], ['match','Coffee match']],
  cart: [['items','Cart with coffee'], ['empty','Empty cart']],
  checkout: [['delivery','Delivery details'], ['collection','Collection details'], ['review','Review order'], ['processing','Processing'], ['confirmation','Confirmation'], ['empty','Empty cart']],
  account: [['login','Sign in'], ['register','Create account'], ['forgot','Request password reset'], ['reset','Choose password'], ['setup','Finish registration'], ['orders','Order history'], ['details','Account details']],
};
const endpoint = '/api/admin/consumer/editor';
const uploadLimit = 1536 * 1024;
const tabs = { content: 'Content', design: 'Design', seo: 'SEO', media: 'Photos', history: 'Versions' };
const sizes = { desktop: 1180, mobile: 390 };
const textLimit = 16000;
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = JSON.stringify;
const date = value => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' }).format(new Date(value));

function combineEdits(base, local, remote, path, conflicts) {
  if (snapshot(local) === snapshot(base)) return remote;
  if (snapshot(remote) === snapshot(base) || snapshot(local) === snapshot(remote)) return local;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  if ((base === undefined || record(base)) && record(local) && record(remote)) {
    const merged = {};
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = combineEdits(base?.[key],local[key],remote[key],[...path,key],conflicts);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  conflicts.push(path);
  return local;
}

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'checked') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children.flat().filter(value => value !== undefined && value !== null));
  return node;
}

function button(text, onClick, style = 'soft', attrs = {}) {
  return element('button', { type: 'button', class: 'btn ' + style, onclick: onClick, ...attrs }, text);
}
function field(label, control) {
  if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
  return element('label', { class: 'ce-field' }, element('span', {}, label), control);
}
function title(text) { return element('h4', {}, text); }
function help(text) { return element('p', { class: 'ce-help' }, text); }
function group(...children) { return element('div', { class: 'ce-controls' }, ...children); }
function select(items, value, onChange, attrs = {}) {
  const input = element('select', { ...attrs, onchange: () => onChange(input.value) });
  for (const [key, label] of items) input.add(new Option(label, key));
  input.value = value;
  return input;
}
function listOfPages(pages) {
  const input = element('select', { 'aria-label': 'Storefront page or surface' });
  const groups = {
    pages: element('optgroup', { label: 'Storefront pages' }),
    shared: element('optgroup', { label: 'Shared elements and shopping tools' }),
    products: element('optgroup', { label: 'Individual products' }),
  };
  for (const [id, page] of Object.entries(pages)) {
    const target = id.startsWith('product:') ? 'products' : ['shared', 'finder', 'cart', 'product'].includes(id) ? 'shared' : 'pages';
    groups[target].append(new Option(page.label, id));
  }
  input.append(...Object.values(groups));
  return input;
}
function widgetId() { return 'w-' + crypto.randomUUID().slice(0, 12); }
function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('The photo could not be read. Choose the file again.'));
    reader.readAsDataURL(file);
  });
}

// Scale large camera uploads on this device. Decoding via an image honours the file's orientation.
async function preparePhoto(file) {
  if (file.size <= uploadLimit) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const ratio = Math.min(1, 2000 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.84, .68, .48]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
      if (blob && blob.size <= uploadLimit && ['image/webp','image/jpeg','image/png'].includes(blob.type)) {
        const suffix = { 'image/webp':'webp', 'image/jpeg':'jpg', 'image/png':'png' }[blob.type];
        return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.' + suffix, {type:blob.type});
      }
    }
    throw new Error();
  } catch { throw new Error('This photo could not be resized. Choose a smaller JPEG, PNG or WebP.'); }
  finally { URL.revokeObjectURL(url); }
}

export function mountConsumerEditor(host, { api, confirmSheet, seoProduct }) {
  let active = true, serial = 0, canvas, canvasRequest, resizeObserver;
  const initialProduct = seoProduct && cataloguePageForKey('product:' + seoProduct.id, seoProduct);
  let state, draft, saved = '', scope = initialProduct ? 'product:' + seoProduct.id : 'home', pick = {scope}, tab = initialProduct ? 'seo' : 'content';
  let seoSection = 'search';
  let busy = false, conflict = false, notice = '', problem = false, device = matchMedia('(max-width: 740px)').matches ? 'mobile' : 'desktop';
  let editSize = device === 'mobile' ? 'mobile' : 'all', layoutScopeControl;
  const mobileLayout = () => editSize === 'mobile';
  let viewState = '', outlineOpen = false, expanded = false, expandButton, previewGeneration = 0, lastField = '', previewReady = false;
  let coffees = COFFEE_CHOICES, catalogueUnavailable = false;
  let direct, directSession, picker, pickerToggle;
  const undo = [], redo = [], usable = new AbortController();
  const isDirty = () => Boolean(draft && snapshot(draft) !== saved);
  const shelf = () => draft.pages[pick.scope] || {};
  const pages = () => {
    const definitions = editorPages(draft);
    if (initialProduct) definitions['product:' + seoProduct.id] ||= initialProduct;
    return definitions;
  };
  const details = () => pages()[pick.scope];
  const pageForEdit = () => draft.pages[pick.scope] ||= {};
  const selectedWidget = () => (shelf().widgets || []).find(item => item.id === pick.widget);
  const nativeField = () => details().fields.find(item => item.id === pick.field);
  const nativeSection = () => details().sections.find(item => item.id === pick.section);
  const productTemplate = (key = pick.scope) => key.startsWith('product:') ? draft.pages.product || {} : {};
  const lines = (mobile = mobileLayout()) => orderedSections(details(),shelf(),productTemplate(),mobile);
  const widgetFor = (id,key = pick.scope) => draft.pages[key]?.widgets?.find(item=>item.id===id) || productTemplate(key).widgets?.find(item=>item.id===id);
  let bar, pageSelect, pageTools, statePicker, status, messages, saveButton, publishButton, undoButton, redoButton, canvasArea, stage, frame, frameMessage, inspector, inspectorBody, tabGroup, deviceGroup, actions;

  function setNotice(text = '', error = false) {
    notice = text;
    problem = error;
    renderStatus();
  }
  function renderStatus() {
    if (!active || !state) return;
    const modified = isDirty();
    const statusText = busy ? 'Working…' : conflict ? 'Draft changed elsewhere' : modified ? 'Unsaved changes' : state.hasUnpublishedChanges ? 'Draft saved' : state.publishedRevision ? 'Published' : 'Original storefront';
    if (status.textContent !== statusText) status.textContent = statusText;
    status.dataset.kind = conflict || modified ? 'warn' : 'ok';
    saveButton.disabled = busy || conflict || !modified;
    publishButton.disabled = busy || conflict || (!modified && !state.hasUnpublishedChanges);
    undoButton.disabled = busy || !undo.length;
    redoButton.disabled = busy || !redo.length;
    pageSelect.disabled = busy;
    layoutScopeControl.disabled = busy;
    pageTools.inert = busy;
    inspector.inert = busy;
    canvasArea.inert = busy;
    messages.hidden = !notice && !conflict;
    messages.classList.toggle('ce-error', problem || conflict);
    messages.replaceChildren();
    if (notice) messages.append(element('span', {}, notice));
    if (conflict) messages.append(button('Recover my edits', recoverEdits, 'soft sm'), button('Reload latest draft', reloadConflict, 'soft sm'));
  }

  function remember(key = '') {
    if (!key || lastField !== key || !undo.length) {
      undo.push(snapshot(draft));
      if (undo.length > 40) undo.shift();
    }
    redo.length = 0;
    lastField = key;
  }
  function finishDirect() {
    return !directSession || direct.close({restoreFocus:false}) !== false;
  }
  function change(callback, options = {}) {
    if (busy || !active || (options.direct !== true && !finishDirect())) return;
    remember(options.key);
    callback();
    if (!conflict) { notice = ''; problem = false; }
    if (options.canvas !== false) canvas?.update(draft);
    if (options.panel !== false) renderInspector();
    renderStatus();
  }
  function travel(backward) {
    const from = backward ? undo : redo, to = backward ? redo : undo;
    if (busy || !finishDirect() || !from.length) return;
    to.push(snapshot(draft));
    draft = JSON.parse(from.pop());
    ensureScope();
    lastField = '';
    if (pick.widget && !widgetFor(pick.widget)) pick = { scope: pick.scope };
    notice = '';
    canvas?.update(draft);
    renderInspector();
    renderStatus();
  }
  function applyState(next, preserveUndo = false) {
    state = next;
    draft = clone(next.draft || emptyDocument());
    saved = snapshot(draft);
    ensureScope();
    if (!preserveUndo) undo.length = redo.length = 0;
    lastField = '';
    conflict = false;
    if (pick.widget && !widgetFor(pick.widget)) pick = { scope: pick.scope };
    canvas?.update(draft);
  }
  async function operation(task) {
    if (busy || !active || !finishDirect()) return;
    busy = true;
    renderStatus();
    try { await task(); }
    catch (error) {
      if (!active) return;
      if (error.code === 'editor_conflict' || error.status === 409 && !error.code) {
        conflict = true;
        setNotice('Another admin saved changes. Your edits are still here. Reload to use their draft.', true);
      } else setNotice(error.message || 'The change could not be completed. Try again.', true);
    } finally {
      busy = false;
      if (active) { renderInspector(); renderStatus(); }
    }
  }
  async function saveDraft() {
    return operation(async () => {
      const next = await api('PUT', endpoint, { revision: state.revision, document: validateDocument(draft) });
      if (!active) return;
      applyState(next, true);
      setNotice('Draft saved. You can return to it before publishing.');
    });
  }
  async function publish() {
    await operation(async () => {
      const reviewed = validateDocument(draft);
      const live = await api('GET', endpoint + '/published');
      if (!active) return;
      if (live.revision !== state.publishedRevision) {
        throw Object.assign(new Error('The storefront has changed since this draft was loaded.'), {code: 'editor_conflict'});
      }
      const changes = buildPublishReview(live.document, reviewed, {
        pages: {...editorPages(live.document), ...editorPages(reviewed)},
        themes: THEMES, layouts: LAYOUTS, widgetTypes: WIDGET_TYPES, coffees, media: state.media,
        layoutTools: {orderedSections, effectiveStyle, SECTION_STYLES},
      });
      const approved = await confirmSheet({
        title: 'Publish storefront changes?',
        text: 'Review what customers will see. Publishing includes any unsaved edits in this draft.',
        content: renderPublishReview(changes, ref => imageUrl(ref, true).replace('/consumer-preview/assets/', endpoint + '/assets/')),
        confirm: 'Publish storefront',
      });
      if (!approved || !active) return;
      if (isDirty()) {
        const next = await api('PUT', endpoint, { revision: state.revision, document: reviewed });
        if (!active) return;
        applyState(next, true);
      }
      const published = await api('POST', endpoint + '/publish', { revision: state.revision });
      if (!active) return;
      applyState(published, true);
      setNotice('Published to the consumer storefront.');
    });
    if (active && !publishButton.disabled && document.activeElement === document.body) publishButton.focus();
  }
  async function recoverEdits() {
    return operation(async () => {
      const latest = await api('GET',endpoint);
      if (!active) return;
      const collisions = [];
      const merged = combineEdits(JSON.parse(saved),draft,latest.draft,[],collisions);
      if (collisions.length) {
        const summary = collisions.slice(0,4).map(path=>path.join(' › ')).join(', ');
        const agree = await confirmSheet({title:'Use your overlapping edits?', text:'Both drafts changed '+summary+
          (collisions.length>4?' and other fields':'')+'. Use your values for these fields and keep the other saved changes.', confirm:'Use my edits'});
        if (!agree || !active) return;
      }
      applyState(latest);
      draft = merged;
      ensureScope();
      canvas?.update(draft);
      setNotice(isDirty() ? 'Edits recovered alongside the latest draft. Review and save your changes.' : 'Your changes are already in the saved draft.');
    });
  }
  async function reloadConflict() {
    if (isDirty() && !await confirmSheet({ title: 'Replace local changes?', text: 'Reloading opens the latest saved draft. Your unsaved edits in this tab will be discarded.', confirm: 'Reload draft', danger: true })) return;
    return operation(async () => {
      const next = await api('GET', endpoint);
      if (active) { applyState(next); setNotice('Latest draft loaded.'); }
    });
  }
  async function restore(version) {
    if (!await confirmSheet({ title: 'Restore version ' + version + ' to draft?', text: 'This replaces the working draft and any unsaved edits. Customers will see it only after you publish.', confirm: 'Restore to draft' })) return;
    return operation(async () => {
      const next = await api('POST', endpoint + '/restore', { revision: state.revision, version });
      if (active) { applyState(next); setNotice('Version ' + version + ' restored to draft.'); }
    });
  }

  function fitPreview() {
    if (!canvasArea || !frame) return;
    const width = sizes[device], available = canvasArea.clientWidth;
    if (!available) return;
    const scale = Math.min(1, available / width);
    const height = Math.round(Math.max(370, Math.min(window.innerHeight * .66, 780)) / scale);
    stage.style.width = Math.ceil(width * scale) + 'px';
    stage.style.height = Math.ceil(height * scale) + 'px';
    frame.style.width = width + 'px';
    frame.style.height = height + 'px';
    frame.style.transform = 'scale(' + scale + ')';
  }
  function expandCanvas(value) {
    expanded = value;
    host.classList.toggle('ce-wide-canvas', value);
    expandButton.textContent = value ? 'Show inspector' : 'Expand preview';
    expandButton.setAttribute('aria-expanded',String(value));
    fitPreview();
  }
  function chooseDevice(value, layoutSize = value === 'mobile' ? 'mobile' : 'all') {
    if (busy || !finishDirect()) { layoutScopeControl.value = editSize; return; }
    device = value;
    editSize = layoutSize;
    layoutScopeControl.value = editSize;
    for (const control of deviceGroup.children) control.setAttribute('aria-pressed', String(control.dataset.device === value));
    fitPreview();
    if (state && inspectorBody) renderInspector();
  }
  function refreshPageControls() {
    if (!pageSelect || !pageTools) return;
    const options = listOfPages(pages());
    pageSelect.replaceChildren(...options.children);
    pageSelect.value = scope;
    bar.toggleAttribute('data-custom-page', scope.startsWith('custom:'));
    mountEditorPages(pageTools, { getDocument: () => draft, getPage: () => scope, confirmSheet,
      onChange: (next, target) => {
        if (busy || !active || !finishDirect()) return;
        remember();
        draft = next;
        if (scope === target) {
          refreshPageControls();
          canvas?.update(draft);
          renderInspector();
        } else chooseScope(target);
        renderStatus();
      },
    });
    statePicker.replaceChildren();
    const states = previewStates[scope];
    if (states) statePicker.append(field('Preview state', select(states, viewState || states[0][0], value => {
      if (!finishDirect()) { refreshPageControls(); return; }
      viewState = value;
      pick = { scope };
      renderInspector();
      loadCanvas();
    })));
  }
  function ensureScope() {
    if (!pages()[scope]) { chooseScope('home'); return; }
    if (!pages()[pick.scope]) pick = {scope};
    refreshPageControls();
  }
  function chooseScope(value) {
    if (!Object.hasOwn(pages(), value) || (scope === value && previewReady)) return;
    if (!finishDirect()) { pageSelect.value = scope; return; }
    scope = value;
    if (!problem && !conflict) setNotice('');
    viewState = '';
    refreshPageControls();
    pageSelect.value = value;
    pick = { scope };
    if (tab !== 'seo' || !hasPageSeo(scope)) tab = 'content';
    lastField = '';
    renderInspector();
    loadCanvas();
  }
  async function loadCanvas() {
    direct?.close({force:true, restoreFocus:false});
    canvasRequest?.abort();
    canvasRequest = new AbortController();
    const request = canvasRequest, token = ++previewGeneration;
    canvas?.destroy();
    canvas = undefined;
    previewReady = false;
    pickerToggle.disabled = true;
    hidePicker();
    stage.replaceChildren();
    stage.hidden = true;
    frameMessage.hidden = false;
    frameMessage.replaceChildren('Opening storefront preview…');
    try {
      const query = new URLSearchParams({page: scope});
      if (viewState) query.set('state', viewState);
      const response = await fetch(endpoint + '/canvas?' + query, { signal: request.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error('The storefront preview could not open.');
      const canvasMarkup = await response.text();
      if (!active || token !== previewGeneration) return;
      frame = element('iframe', { title: 'Editable storefront preview · ' + pages()[scope].label, sandbox: 'allow-same-origin', tabindex:'-1', 'aria-describedby':'ce-canvas-hint', referrerpolicy: 'no-referrer' });
      frame.addEventListener('load', () => {
        if (!active || token !== previewGeneration) return;
        try {
          const doc = frame.contentDocument;
          if (!doc || !doc.querySelector('main')) throw new Error('The storefront returned an incomplete preview.');
          canvas = mountEditorCanvas(doc, { scope, document: draft, onSelect: pickOnCanvas });
          previewReady = true;
          pickerToggle.disabled = false;
          frameMessage.hidden = true;
          stage.hidden = false;
          fitPreview();
          canvas.select(pick);
        } catch { showFrameError(); }
      }, { once: true });
      frame.srcdoc = canvasMarkup;
      stage.append(frame);
    } catch { if (active && token === previewGeneration && !request.signal.aborted) showFrameError(); }
  }
  function showFrameError() {
    stage.hidden = true;
    frameMessage.hidden = false;
    frameMessage.replaceChildren('The page preview is unavailable. You can still edit using the inspector.', button('Retry preview', loadCanvas, 'soft sm'));
  }
  function photoChoice(value, label) {
    return {value, label, src:imageUrl(value, true).replace('/consumer-preview/assets/', endpoint + '/assets/')};
  }

  // A layout or content edit may override a product template. Reverting it
  // must restore inheritance, including on pages with no saved settings yet.
  function pageSetting(key, group, id, fallback) {
    const originalPage = draft.pages[key], originalGroup = originalPage?.[group];
    const present = Object.hasOwn(originalGroup || {}, id);
    const inherited = key.startsWith('product:') ? draft.pages.product?.[group]?.[id] : undefined;
    return {
      value:originalGroup?.[id] ?? inherited ?? fallback,
      set:(value, original) => {
        const page = draft.pages[key] ||= {};
        if (!original || present) { (page[group] ||= {})[id] = value; return; }
        delete page[group][id];
        if (!originalGroup && !Object.keys(page[group]).length) delete page[group];
        if (!originalPage && !Object.keys(page).length) delete draft.pages[key];
      },
    };
  }

  function directFields(selection, hit) {
    const source = selection.scope;
    if (selection.pageTitle && source.startsWith('custom:') && draft.pages[source]) {
      return [{id:'title', kind:'text', label:'Page name', value:draft.pages[source].title, maxLength:80,
        set:value => { draft.pages[source].title = value; }}];
    }
    if (selection.section && !selection.field) {
      const section = pages()[source].sections.find(item => item.id === selection.section);
      if (!section || section.locked) return [];
      return layoutProperties(source,section.id,hit.node);
    }
    if (selection.widget) {
      const widget = selection.part ? draft.pages[source]?.widgets?.find(item => item.id === selection.widget) : widgetFor(selection.widget,source);
      if (!widget || widget.type === 'divider') return [];
      if (!selection.part) return layoutProperties(source,widget.id,hit.node,widget);
      const parts = {heading:['text','Heading text',240], body:['text','Body text',8000], label:['text','Button label',160],
        href:['link','Link destination',2048], image:['image','Photo'], alt:['alt','Alternative text',500]};
      if (!Object.hasOwn(parts, selection.part)) return [];
      const keys = [selection.part];
      if (selection.part === 'label') keys.push('href');
      if (selection.part === 'image') keys.push('alt');
      return keys.map(id => {
        const [kind,label,maxLength] = parts[id];
        const present = Object.hasOwn(widget, id);
        return {id, kind, label, maxLength, value:widget[id] ?? '', set:(value, original) => {
          if (original && !present) delete widget[id];
          else widget[id] = value;
        }};
      });
    }

    return (hit.fields || []).map(item => {
      const {scope:key, id, kind, node} = item;
      let initial = item.default ?? '';
      let label = item.label;
      if (kind === 'text') {
        initial = node.textContent.trim();
        label = node.closest('button,a') ? 'Button label' : node.closest('h1,h2,h3,h4,h5,h6') ? 'Heading text' : 'Page text';
      } else if (kind === 'link') {
        initial = node.getAttribute('href') ?? initial;
        label = 'Link destination';
      } else if (kind === 'alt') {
        initial = node.getAttribute('alt') ?? initial;
        label = 'Alternative text';
      } else if (kind === 'image') {
        label = 'Photo';
        const path = node.getAttribute('src') || '';
        const value = /\/(?:consumer-media|api\/admin\/consumer\/editor\/media)\/([^/?#]+)/.exec(path);
        const file = /\/assets\/([^/?#]+)/.exec(path);
        if (value && imageUrl('media:' + value[1])) initial = 'media:' + value[1];
        else if (file && ASSETS.includes(file[1])) initial = 'asset:' + file[1];
      }
      return {id, kind, label, maxLength:kind === 'alt' ? 500 : kind === 'link' ? 2048 : textLimit,
        ...pageSetting(key, 'fields', id, initial)};
    });
  }

  function hidePicker() {
    picker.hidden = true;
    picker.replaceChildren();
    pickerToggle.setAttribute('aria-expanded', 'false');
  }
  function showPicker() {
    if (!picker.hidden) { hidePicker(); return; }
    if (!finishDirect() || !canvas) return;
    const targets = canvas.targetList();
    picker.hidden = false;
    pickerToggle.setAttribute('aria-expanded', 'true');
    if (!targets.length) { picker.replaceChildren(help('There are no editable elements in this view.')); return; }
    const definitions = pages();
    const options = targets.map(({selection, hit}, index) => {
      const field = hit.fields.find(item => item.id === selection.field);
      if (!field && selection.section) {
        const section = definitions[selection.scope].sections.find(item => item.id === selection.section);
        return [String(index), 'Section · ' + section.label];
      }
      if (selection.widget && !selection.part) {
        const widget = widgetFor(selection.widget,selection.scope);
        return [String(index), 'Widget · ' + (widget?.heading || WIDGET_TYPES[widget?.type] || 'Layout')];
      }
      const text = selection.part === 'image' || field?.kind === 'image'
        ? hit.node.getAttribute('alt') || field?.label || 'Widget photo'
        : (field?.node || hit.node).textContent.trim().replace(/\s+/g, ' ') || field?.label || selection.part || 'Page name';
      const kind = selection.pageTitle ? 'Page name' : selection.part || field?.kind || 'Element';
      return [String(index), kind.charAt(0).toUpperCase() + kind.slice(1) + ' · ' + text.slice(0, 100)];
    });
    const chosen = select(options, '0', () => {}, {'aria-label':'Preview element'});
    const edit = button('Edit element', () => {
      const item = targets[Number(chosen.value)];
      if (!item.hit.node.isConnected) { hidePicker(); showPicker(); return; }
      hidePicker();
      item.hit.node.scrollIntoView({block:'center', behavior:'instant'});
      pickOnCanvas(item.selection, item.hit, pickerToggle);
    }, 'soft sm');
    chosen.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); hidePicker(); pickerToggle.focus(); }
    });
    picker.replaceChildren(chosen, edit);
    chosen.focus({preventScroll:true});
  }
  function pickOnCanvas(selection, hit, returnFocus) {
    if (!active || busy || !hit || !pages()[selection.scope]) return;
    if (!finishDirect()) {
      canvas.select(pick, {scroll:false});
      return;
    }
    if (!picker.hidden) hidePicker();
    lastField = '';
    pick = selection;
    tab = 'content';
    renderInspector();
    canvas.select(selection, {scroll:false, node:hit.node});
    const fields = directFields(selection, hit);
    const tools = structureTools(selection, hit);
    if (!fields.length && !tools) return;

    const edits = new Map();
    const start = snapshot(draft), oldUndo = undo.slice(), oldRedo = redo.slice();
    const session = {};
    directSession = session;
    const restore = () => {
      draft = JSON.parse(start);
      undo.splice(0, undo.length, ...oldUndo);
      redo.splice(0, redo.length, ...oldRedo);
      canvas.update(draft);
      if (selection.pageTitle) refreshPageControls();
      renderInspector();
      renderStatus();
    };
    function finish(cancelled) {
      if (directSession !== session) return;
      directSession = null;
      lastField = '';
      if (session.changed && (cancelled || !edits.size)) restore();
      else if (session.changed && selection.pageTitle) refreshPageControls();
    }
    const hasPhoto = fields.some(item => item.kind === 'image');
    const hasLink = fields.some(item => item.kind === 'link');
    let label = selection.pageTitle ? 'Page title' : hasPhoto ? 'Photo' : hasLink || hit.node.closest('a,button') ? 'Button' : fields[0]?.label || 'Widget';
    if (fields.some(item => item.sectionStyle)) {
      const section = pages()[selection.scope].sections.find(item => item.id === selection.section);
      label = (section?.label || 'Widget layout') + ' · ' + (mobileLayout() ? 'Mobile only' : 'All sizes');
    }
    if (selection.scope !== scope) label += ' · ' + pages()[selection.scope].label;
    let caretOffset;
    if (fields.length === 1 && fields[0].kind === 'text' && Number.isInteger(hit.caretOffset)) {
      const text = hit.node.textContent;
      if (fields[0].value === text) caretOffset = hit.caretOffset;
      else if (fields[0].value === text.trim()) {
        caretOffset = Math.max(0, Math.min(fields[0].value.length, hit.caretOffset - (text.length - text.trimStart().length)));
      }
    }
    const opened = direct.open({
      frame, label, fields, tools, caretOffset, returnFocus, getTarget:() => canvas?.getTarget(selection)?.node,
      inlineText:!hit.fields?.some(field => field.kind === 'text' && field.node !== hit.node),
      photos:hasPhoto ? [...state.media.map(item => photoChoice('media:' + item.id, item.name)),
        ...ASSETS.map(name => photoChoice('asset:' + name, name.replace(/\.[^.]+$/, '').replaceAll('-', ' ')))] : [],
      upload:async file => {
        const media = await registerPhoto(file);
        return photoChoice('media:' + media.id, media.name);
      },
      onChange:(id, input) => {
        if (!active || directSession !== session) return;
        const item = fields.find(field => field.id === id);
        if (!item) return;
        if (selection.pageTitle && !input.trim()) throw new Error('Give the page a name.');
        if (item.kind === 'choice' && !item.choices.some(([key]) => key === input)) throw new Error('Choose an available layout.');
        const value = item.kind === 'link' ? safeLink(input, draft.pages) : input;
        if (value === (edits.has(id) ? edits.get(id) : item.value)) return;
        if (value === item.value) edits.delete(id);
        else edits.set(id, value);
        session.changed = true;
        change(() => item.set(value, value === item.value), {key:session, direct:true});
        if (selection.pageTitle) {
          const option = Array.from(pageSelect.options).find(option => option.value === selection.scope);
          if (option) option.textContent = value;
        }
      },
      onFinish:() => finish(false), onCancel:() => finish(true),
    });
    if (opened === false) directSession = null;
  }

  function selectItem(selection) {
    if (!finishDirect()) return;
    lastField = '';
    pick = { scope, ...selection };
    tab = 'content';
    renderInspector();
    canvas?.select(pick);
  }

  function textControl(label, value, setter, options = {}) {
    const multiline = options.multiline ?? false;
    const input = element(multiline ? 'textarea' : 'input', {
      ...(multiline ? { rows: 3 } : { type: 'text' }), maxlength: options.max || textLimit,
    });
    input.value = value || '';
    input.addEventListener('input', () => setter(input.value));
    input.addEventListener('blur', () => { lastField = ''; });
    return field(label, input);
  }

  function picture(value, setter, heading = 'Photo') {
    const choices = [['', 'No photo'], ...state.media.map(item => ['media:' + item.id, item.name]),
      ...ASSETS.map(name => ['asset:' + name, name.replace(/\.(webp|png|jpg|jpeg|svg)$/i, '').replaceAll('-', ' ')])];
    const panel = group(field(heading, select(choices, value || '', setter)));
    const url = value ? imageUrl(value, true).replace('/consumer-preview/assets/', endpoint + '/assets/') : '';
    if (url) panel.append(element('img', { class: 'ce-swatch-photo', src: url, alt: '', loading: 'lazy' }));
    panel.append(button('Open photo library', () => chooseTab('media'), 'soft sm'));
    return panel;
  }
  function editNative(descriptor) {
    const page = shelf(), base = pick.scope.startsWith('product:') ? draft.pages.product?.fields?.[descriptor.id] : undefined;
    const value = page.fields?.[descriptor.id] ?? base ?? descriptor.default ?? '';
    const set = val => change(() => {
      const entry = pageForEdit(); entry.fields ||= {}; entry.fields[descriptor.id] = val;
    }, { key: 'field:' + pick.scope + ':' + descriptor.id, panel: descriptor.kind === 'image' });
    const part = group();
    if (descriptor.kind === 'image') part.append(picture(value, set, descriptor.label));
    else part.append(textControl(descriptor.label, value, set, { multiline: descriptor.kind === 'text', max: descriptor.kind === 'alt' ? 500 : descriptor.kind === 'link' ? 2048 : textLimit }));
    if (descriptor.kind === 'image') {
      const alternative = details().fields.find(item=>item.kind==='alt' && item.selector===descriptor.selector);
      if (alternative) part.append(textControl('Photo description', page.fields?.[alternative.id] ?? alternative.default, val=>change(()=>{
        const local=pageForEdit(); local.fields ||= {}; local.fields[alternative.id]=val;
      },{key:'alt:'+pick.scope+':'+alternative.id,panel:false}), {max:500}));
    }
    part.append(button('Restore original', () => {
      if (Object.hasOwn(shelf().fields || {},descriptor.id)) change(() => { delete pageForEdit().fields[descriptor.id]; });
    }, 'soft sm'));
    return part;
  }

  function lockedSection(id) {
    return Boolean(details().sections.find(item=>item.id===id)?.locked);
  }
  function setOrder(page, rows, mobile) {
    if (mobile) {
      const inherited = {...page, mobile:{...page.mobile}};
      delete inherited.mobile.sections;
      if (snapshot(rows) === snapshot(orderedSections(details(),inherited,productTemplate(),true))) {
        if (page.mobile) {
          delete page.mobile.sections;
          if (!Object.keys(page.mobile).length) delete page.mobile;
        }
        if (!Object.keys(page).length) delete draft.pages[pick.scope];
      } else (page.mobile ||= {}).sections = rows;
    } else page.sections = rows;
  }
  function reorder(id, target, after = lines().indexOf(id) < lines().indexOf(target)) {
    const next = movedSections(lines(),id,target,after,lockedSection);
    if (!next) return;
    change(() => setOrder(pageForEdit(),next,mobileLayout()));
  }
  function resetMobileOrder() {
    if (!mobileLayout() || !shelf().mobile?.sections || !finishDirect()) return;
    change(() => {
      const page = pageForEdit();
      delete page.mobile.sections;
      if (!Object.keys(page.mobile).length) delete page.mobile;
      if (!Object.keys(page).length) delete draft.pages[pick.scope];
    });
  }
  function layerSelection(id) {
    return {scope:pick.scope, [widgetFor(id) ? 'widget' : 'section']:id};
  }
  function revealStructure(selection) {
    const hit = canvas?.getTarget(selection);
    if (!hit) return;
    const node = hit.node, box = node.getBoundingClientRect(), view = node.ownerDocument.defaultView;
    if (box.top < 0 || box.top >= view.innerHeight) view.scrollBy({top:box.top-12,behavior:'instant'});
    pickOnCanvas(selection,hit);
  }
  function structureTools(selection, hit) {
    if (selection.field || selection.part || selection.pageTitle) return;
    const id = selection.widget || selection.section;
    if (!id || lockedSection(id) || !lines().includes(id)) return;
    const currentScope = selection.scope;
    const row = lines(), index = row.indexOf(id);
    const locked = new Set(details().sections.filter(section => section.locked).map(section => section.id));
    const canInsert = details().widgets !== false && (shelf().widgets?.length || 0) < 40;
    const widget = widgetFor(id);
    const copy = widget || (canInsert && editorialCopy(hit.node,ASSETS,value=>safeLink(value,draft.pages)));
    const allowed = (target, after) => Boolean(movedSections(row,id,target,after,key=>locked.has(key)));
    const drop = (target, after) => {
      if (busy || !active || pick.scope !== currentScope || !allowed(target,after) || !finishDirect()) return;
      reorder(id,target,after);
      revealStructure(selection);
    };
    const groups = [
      ['Widgets',Object.entries(WIDGET_TYPES).map(([key,label])=>['widget:'+key,label])],
      ['Templates',Object.entries(TEMPLATES).map(([key,item])=>['template:'+key,item.label])],
    ];
    return (container,signal) => renderLayoutTools(container,{
      frame, groups, mobile:mobileLayout(), widget:Boolean(widget),
      canUp:index > 0 && allowed(row[index-1],false),
      canDown:index + 1 < row.length && allowed(row[index+1],true),
      targets:() => row.map(key=>({id:key,node:canvas.getTarget(layerSelection(key))?.node}))
        .filter(entry=>entry.node?.getBoundingClientRect().height > 0),
      canDrop:allowed, drop,
      move:direction => drop(row[index+direction], direction>0),
      resetOrder:mobileLayout() && shelf().mobile?.sections ? () => {
        resetMobileOrder();
        revealStructure(selection);
      } : null,
      duplicate:canInsert && copy ? () => {
        if (!finishDirect()) return;
        const created = insertWidgets([copy],id,{copyFrom:id});
        if (created) revealStructure(created);
      } : null,
      insert:canInsert ? key => {
        const [group, value] = key.split(':');
        const entries = group === 'template' && Object.hasOwn(TEMPLATES,value) ? TEMPLATES[value].widgets :
          group === 'widget' && Object.hasOwn(WIDGET_TYPES,value) ? [defaultWidget(value,WIDGET_TYPES)] : [];
        if (!entries.length || !finishDirect()) return;
        const created = insertWidgets(entries,id);
        if (created) revealStructure(created);
      } : null,
    },signal);
  }
  function layerOutline(sequence) {
    const disclosure = element('details', {class:'ce-layers'});
    disclosure.open = outlineOpen;
    disclosure.addEventListener('toggle',()=>{ if(disclosure.isConnected)outlineOpen=disclosure.open; });
    disclosure.append(element('summary',{},'Arrange sections'));
    const stack = element('ol', {class:'ce-layer-list', 'aria-label':'Section order'});
    let dragging = '';
    for (const [id,label] of sequence) {
      const locked = lockedSection(id);
      const row = element('li', {'data-layer':id});
      const handle = element('span', {class:'ce-grip','aria-hidden':'true', title:locked ? 'Fixed position' : 'Drag to reorder'}, locked ? '·' : '⠿');
      const focus = element('button', {type:'button', onclick:()=>selectItem(layerSelection(id)), 'aria-label':'Edit '+label}, label);
      row.draggable = !locked;
      row.append(handle,focus);
      row.addEventListener('dragstart', event => {
        if (locked) {event.preventDefault();return;}
        dragging=id;
        event.dataTransfer.effectAllowed='move';
        event.dataTransfer.setData('text/plain',id);
        row.classList.add('ce-dragging');
      });
      row.addEventListener('dragover', event => {
        if (!dragging || locked || dragging===id) return;
        const from=lines().indexOf(dragging), to=lines().indexOf(id);
        if(lines().slice(Math.min(from,to),Math.max(from,to)+1).some(lockedSection))return;
        event.preventDefault();event.dataTransfer.dropEffect='move';row.classList.add('ce-drop');
      });
      row.addEventListener('dragleave',()=>row.classList.remove('ce-drop'));
      row.addEventListener('dragend',()=>{dragging='';for(const item of stack.children)item.classList.remove('ce-drop','ce-dragging');});
      row.addEventListener('drop',event=>{
        if(!dragging || locked)return;
        event.preventDefault();
        const source=dragging;
        dragging='';
        reorder(source,id);
      });
      stack.append(row);
    }
    disclosure.append(stack);
    if (mobileLayout() && shelf().mobile?.sections) {
      disclosure.append(button('Use inherited order',resetMobileOrder,'sm soft'));
    }
    return disclosure;
  }
  function orderSection(id, direction) {
    const rows = lines(), index = rows.indexOf(id), target = index + direction;
    if (index < 0 || target < 0 || target >= rows.length) return;
    reorder(id,rows[target]);
  }
  function positionControls(id, locked = false) {
    const rows = lines(), index = rows.indexOf(id);
    return element('div', { class: 'ce-inline' },
      button('Move up', () => orderSection(id, -1), 'sm soft', { disabled: locked || index <= 0 || lockedSection(rows[index - 1]) }),
      button('Move down', () => orderSection(id, 1), 'sm soft', { disabled: locked || index === rows.length - 1 || lockedSection(rows[index + 1]) }));
  }

  function coffeeChoices(widget) {
    const chosen = widget.items || ['bom-jesus', 'rocko', 'anserma'];
    const box = element('fieldset', {class:'ce-coffees'}, element('legend', {}, 'Coffees in display order'));
    const names = new Map(coffees.map(item => [item.id, item.archived ? item.name + ' (removed)' : item.name]));
    const save = items => change(() => { selectedWidget().items = items; });
    chosen.forEach((id,index) => {
      const name = names.get(id) || id;
      const move = by => { const next = [...chosen]; next.splice(index,1); next.splice(index+by,0,id); save(next); };
      box.append(element('div', {class:'ce-coffee-row'}, element('b', {}, name),
        element('div', {class:'ce-inline'},
          button('Up',()=>move(-1),'soft sm',{disabled:!index, 'aria-label':'Move '+name+' up'}),
          button('Down',()=>move(1),'soft sm',{disabled:index===chosen.length-1, 'aria-label':'Move '+name+' down'}),
          button('Remove',()=>save(chosen.filter(key=>key!==id)),'soft sm',{disabled:chosen.length===1, 'aria-label':'Remove '+name}))));
    });
    if (catalogueUnavailable) box.append(help('The current product list could not be loaded. Reopen the editor to choose another coffee.'));
    if (chosen.length < 6 && !catalogueUnavailable) {
      const remaining = coffees.filter(item=>!item.archived && !chosen.includes(item.id)).map(item=>[item.id,item.name]);
      if (remaining.length) box.append(field('Add a coffee', select([['','Choose coffee'],...remaining], '', id=>{if(id)save([...chosen,id]);})));
    }
    return box;
  }
  function layoutProperties(source,id,node,widget) {
    return responsiveFields({pages:draft.pages, scope:source, id, node, widget, mobile:mobileLayout()});
  }
  function layoutInspector(id,widget) {
    const source = pick.scope;
    const node = canvas?.getTarget({scope:source, [widget ? 'widget' : 'section']:id})?.node;
    const box = element('fieldset', {class:'ce-layout-inspector'},
      element('legend',{},mobileLayout() ? 'Mobile layout' : 'Layout for all sizes'));
    for (const item of layoutProperties(source,id,node,widget)) {
      box.append(field(item.label, select(item.choices,item.value,value => change(() => item.set(value,value === item.value)))));
    }
    return box;
  }
  function widgetControls(widget) {
    const update = (key, val, rerender = false) => change(() => { selectedWidget()[key] = val; }, { key: widget.id + ':' + key, panel: rerender });
    const box = group(title(WIDGET_TYPES[widget.type] || 'Widget'), positionControls(widget.id));
    if (widget.type === 'coffee-shelf') box.append(coffeeChoices(widget));
    if (widget.type !== 'divider') {
      box.append(textControl('Heading', widget.heading, value => update('heading', value), { max: 240 }));
      box.append(textControl('Text', widget.body, value => update('body', value), { multiline: true, max: 8000 }));
      box.append(layoutInspector(widget.id,widget));
      box.append(picture(widget.image, value => update('image', value, true)));
      box.append(textControl('Photo description', widget.alt, value => update('alt', value), { max: 500 }));
      box.append(textControl('Button text', widget.label, value => update('label', value), { max: 160 }));
      box.append(textControl('Button destination', widget.href, value => update('href', value), { max: 2048 }));
    }
    box.append(button('Remove widget', async () => {
      if (!await confirmSheet({ title: 'Remove this widget?', text: 'This removes the widget from every screen size in your draft.', confirm: 'Remove widget', danger: true }) || !active) return;
      change(() => {
        const entry = pageForEdit();
        entry.widgets = entry.widgets.filter(item => item.id !== widget.id);
        const affected = [entry];
        if (pick.scope === 'product') {
          for (const [key, page] of Object.entries(draft.pages)) {
            if (key.startsWith('product:') && !page.widgets?.some(item => item.id === widget.id)) affected.push(page);
          }
        }
        for (const page of affected) for (const settings of [page,page.mobile]) {
          if (!settings) continue;
          if (settings.sections) settings.sections = settings.sections.filter(id => id !== widget.id);
          if (settings.sectionStyles) {
            delete settings.sectionStyles[widget.id];
            if (!Object.keys(settings.sectionStyles).length) delete settings.sectionStyles;
          }
          if (settings === page.mobile && !Object.keys(settings).length) delete page.mobile;
        }
        pick = { scope: pick.scope };
      });
    }, 'soft sm'));
    return box;
  }
  function contents() {
    const inventory = details(), current = shelf(), wrapper = group();
    const sequence = lines().map(id => {
      const section = inventory.sections.find(item => item.id === id);
      const widget = widgetFor(id);
      return [id, (widget ? widget.heading || WIDGET_TYPES[widget.type] : section.label) + ((current.hidden || []).includes(id) ? ' · hidden' : '')];
    });
    const visibleFields = pick.section && !pick.field ? inventory.fields.filter(item => !item.section || item.section === pick.section) : inventory.fields;
    const fieldList = visibleFields.map(item => [item.id, item.label]);
    wrapper.append(help('Select an item on the page or choose it below.'));
    if (pick.scope !== scope) wrapper.append(help('Editing ' + inventory.label + ' on ' + pages()[scope].label + '.'),
      button('Return to page content', () => selectItem({scope}), 'soft sm'));
    if (sequence.length) wrapper.append(layerOutline(sequence), field('Section or widget', select([['', 'Choose a section'], ...sequence], pick.section || pick.widget || '', id => {
      selectItem(id ? layerSelection(id) : { scope: pick.scope });
    })));
    if (fieldList.length) {
      const choices = select([['', 'Choose text or a photo'], ...fieldList], pick.field || '', id => {
        selectItem(id ? { scope: pick.scope, field: id } : { scope: pick.scope });
      });
      if (fieldList.length > 20) {
        const filter = element('input', {type:'search', placeholder:'Find text, links or photos'});
        filter.addEventListener('input', () => {
          const needle = filter.value.toLocaleLowerCase().trim();
          const value = choices.value;
          const matches = fieldList.filter(([id,label]) => id === value || label.toLocaleLowerCase().includes(needle));
          choices.replaceChildren(new Option(needle && !matches.length ? 'No matching fields' : 'Choose text or a photo',''),
            ...matches.map(([id,label])=>new Option(label,id)));
          choices.value = value;
        });
        wrapper.append(field('Filter editable content', filter));
      }
      wrapper.append(field('Page content', choices));
    }
    const descriptor = nativeField(), section = nativeSection(), widget = selectedWidget();
    if (widget) wrapper.append(widgetControls(widget));
    else if (pick.widget && widgetFor(pick.widget)) {
      const inherited = widgetFor(pick.widget);
      wrapper.append(title(inherited.heading || WIDGET_TYPES[inherited.type]),
        help('This product inherits the widget’s content from the product template. Layout changes here apply to this product.'),
        positionControls(inherited.id));
      if (inherited.type !== 'divider') wrapper.append(layoutInspector(inherited.id,inherited));
    }
    else if (descriptor) wrapper.append(editNative(descriptor));
    else if (section) {
      wrapper.append(title(section.label));
      if (!section.locked) wrapper.append(layoutInspector(section.id));
      if (section.locked) wrapper.append(help('This section contains essential storefront controls.'));
      else {
        const hidden = (current.hidden || []).includes(section.id);
        const visibility = (hidden ? 'Show' : 'Hide') + (mobileLayout() ? ' on all sizes' : ' section');
        wrapper.append(positionControls(section.id), button(visibility, () => change(() => {
          const entry = pageForEdit();
          entry.hidden = hidden ? (entry.hidden || []).filter(id => id !== section.id) : [...(entry.hidden || []), section.id];
        }), 'soft sm'));
      }
    }
    return wrapper;
  }

  function insertWidgets(entries, after = pick.widget || pick.section, {copyFrom} = {}) {
    if (!entries.length || details().widgets === false || !finishDirect()) return;
    if ((shelf().widgets?.length || 0) + entries.length > 40) {
      setNotice('A page can contain up to 40 widgets.',true);
      return;
    }
    const newWidgets = entries.map(item => ({ ...clone(item), id: widgetId() }));
    function position(mobile) {
      const order = lines(mobile);
      const at = order.indexOf(after);
      order.splice(at < 0 ? order.length : at+1,0,...newWidgets.map(item=>item.id));
      return order;
    }
    const shared = position(false), mobile = position(true);
    const hadMobileOrder = Boolean(shelf().mobile?.sections || productTemplate().mobile?.sections);
    change(() => {
      const entry = pageForEdit();
      entry.widgets = [...(entry.widgets || []), ...newWidgets];
      setOrder(entry,shared,false);
      if (hadMobileOrder) setOrder(entry,mobile,true);
      if (copyFrom) {
        const id = newWidgets[0].id, template = productTemplate();
        const base = effectiveStyle(entry,template,copyFrom);
        if (base.arrangement) {
          newWidgets[0].layout = base.arrangement === 'text-first' ? 'stack' : base.arrangement;
          delete base.arrangement;
        }
        if (Object.keys(base).length) (entry.sectionStyles ||= {})[id] = base;
        const small = {...template.mobile?.sectionStyles?.[copyFrom],...entry.mobile?.sectionStyles?.[copyFrom]};
        if (Object.keys(small).length) ((entry.mobile ||= {}).sectionStyles ||= {})[id] = small;
      }
      pick = { scope: pick.scope, widget: newWidgets[0].id };
      tab = 'content';
    });
    canvas?.select(pick);
    return pick;
  }
  function design() {
    const current = shelf();
    const controls = group(
      field('Storefront theme', select(Object.entries(THEMES), draft.theme, value => change(() => { draft.theme = value; }))),
      field('Page theme', select([['', pick.scope.startsWith('product:') ? 'Inherit product template theme' : 'Use storefront theme'], ...Object.entries(THEMES)], current.theme || '', value => change(() => {
        if (value) pageForEdit().theme = value;
        else delete pageForEdit().theme;
      }))),
      field('Page width (all sizes)', select(Object.entries(LAYOUTS), current.layout || 'standard', value => change(() => { pageForEdit().layout = value; }))),
    );
    if (details().widgets !== false) {
      let widgetType = Object.keys(WIDGET_TYPES)[0], templateId = Object.keys(TEMPLATES)[0];
      controls.append(title('Add to this page'),
        field('Widget', select(Object.entries(WIDGET_TYPES), widgetType, value => { widgetType = value; })),
        button('Add widget', () => insertWidgets([defaultWidget(widgetType,WIDGET_TYPES)]), 'soft sm'),
        field('Template', select(Object.entries(TEMPLATES).map(([id, value]) => [id, value.label]), templateId, value => { templateId = value; })),
        button('Insert template', () => insertWidgets(TEMPLATES[templateId].widgets), 'soft sm'));
    }
    return controls;
  }
  function imageTarget() {
    const native = nativeField(), widget = selectedWidget();
    if (native?.kind === 'image') return { label: native.label, apply: value => { const page = pageForEdit(); page.fields ||= {}; page.fields[native.id] = value; } };
    if (widget && widget.type !== 'divider') return { label: widget.heading || WIDGET_TYPES[widget.type], apply: value => { selectedWidget().image = value; } };
    return null;
  }
  function applyPhoto(value) {
    const target = imageTarget();
    if (!target) {
      if (details().widgets !== false) insertWidgets([{type:'image',image:value}]);
      return;
    }
    change(() => {
      target.apply(value);
      tab = 'content';
    });
    canvas?.select(pick);
  }
  async function registerPhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file?.type) || file.size <= 0 || file.size > 24 * 1024 * 1024) {
      throw new Error('Choose a JPEG, PNG or WebP photo up to 24 MB.');
    }
    const prepared = await preparePhoto(file);
    const result = await api('POST', endpoint + '/media', { name:prepared.name, type:prepared.type, data:await fileData(prepared) });
    if (active) state.media = [result.media, ...state.media.filter(entry => entry.id !== result.media.id)];
    return result.media;
  }
  async function upload(file) {
    if (!file) return;
    return operation(async () => {
      await registerPhoto(file);
      if (active) setNotice('Photo added to the library.');
    });
  }
  async function removePhoto(entry) {
    if (!await confirmSheet({ title: 'Delete ' + entry.name + '?', text: 'Only unused uploads can be deleted. Photos referenced by saved pages or recent versions are protected.', confirm: 'Delete photo', danger: true })) return;
    return operation(async () => {
      if (referencedMedia(draft).includes(entry.id)) throw new Error('Remove this photo from your working draft before deleting it.');
      await api('DELETE', endpoint + '/media/' + encodeURIComponent(entry.id));
      if (active) {
        state.media = state.media.filter(item => item.id !== entry.id);
        setNotice('Photo deleted from the library.');
      }
    });
  }
  function library() {
    const target = imageTarget();
    const file = element('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Upload a photo' });
    file.addEventListener('change', () => upload(file.files[0]));
    const controls = group(title('Photo library'), field('Upload a photo', file), help('JPEG, PNG or WebP up to 24 MB. Large photos are resized on this device.'));
    const canUsePhoto = !!target || details().widgets !== false;
    const useLabel = target ? 'Use photo' : 'Add to page';
    if (target) controls.append(help('Choose a photo for ' + target.label + '.'));
    else if (canUsePhoto) controls.append(help('Add a photo to this page, or select a picture in the preview to replace it.'));
    else controls.append(help('Choose a photo field in Content to replace its image.'));
    if (!state.media.length) controls.append(help('Your uploaded photos will appear here. Storefront photography is also available in each photo field.'));
    const cards = element('ul', { class: 'ce-media' });
    for (const entry of state.media) {
      cards.append(element('li', {},
        element('img', { src: imageUrl('media:' + entry.id, true), loading: 'lazy', alt: '', width: 72, height: 60 }),
        group(element('strong', {}, entry.name), element('span', { class: 'ce-help' }, Math.max(1, Math.round(entry.bytes / 1024)) + ' KB'),
          element('div', { class: 'ce-inline' },
            canUsePhoto ? button(useLabel, () => applyPhoto('media:' + entry.id), 'soft sm', { 'aria-label': useLabel+' · '+entry.name }) : null,
            button('Delete', () => removePhoto(entry), 'soft sm', { 'aria-label': 'Delete ' + entry.name })))));
    }
    controls.append(cards);
    const stock = element('details', {class:'ce-stock'}, element('summary', {}, 'Storefront photography'));
    const grid = element('div', {class:'ce-photo-grid'});
    stock.addEventListener('toggle', () => {
      if (!stock.open || grid.children.length) return;
      for (const name of ASSETS) {
        const value = 'asset:' + name, label = name.replace(/\.[^.]+$/, '').replaceAll('-', ' ');
        const image = element('img', { src:endpoint+'/assets/'+encodeURIComponent(name), alt:'', loading:'lazy', width:104,height:76 });
        if (canUsePhoto) grid.append(element('button', {type:'button', 'aria-label':useLabel+' · '+label, onclick:()=>applyPhoto(value)}, image, element('span',{},label)));
        else grid.append(element('figure', {}, image, element('figcaption',{},label)));
      }
    });
    stock.append(grid);
    controls.append(stock);
    return controls;
  }
  function history() {
    const controls = group(title('Published versions'), help('Restore a previous release to your draft and review it before publishing.'));
    if (!state.history.length) { controls.append(help('The first version will appear here when you publish.')); return controls; }
    const list = element('ol', { class: 'ce-versions' });
    for (const item of state.history) {
      const note = item.version === state.publishedRevision ? ' · live' : '';
      list.append(element('li', {}, group(element('strong', {}, (item.version === 0 ? 'Original storefront' : 'Version ' + item.version) + note),
        element('time', { datetime: item.publishedAt }, date(item.publishedAt))),
        button('Restore to draft', () => restore(item.version), 'soft sm', { 'aria-label': 'Restore version ' + item.version + ' to draft', disabled: conflict })));
    }
    controls.append(list);
    return controls;
  }
  function seo() {
    const id = scope.startsWith('product:') ? scope.slice(8) : '';
    const currentProduct = id === seoProduct?.id && !availability.known ? seoProduct : products.find(item => item.id === id);
    return seoInspector({
      scope, pages:draft.pages, product:scope === 'product' ? products.find(item => item.id === 'bom-jesus') || products[0] : currentProduct,
      section:seoSection, selectSection(key) {
        seoSection = key;
        renderInspector();
        inspectorBody.querySelector('[data-seo-tab="' + key + '"]')?.focus({preventScroll:true});
      },
      photos:[...state.media.map(item => ['media:' + item.id, item.name]),
        ...ASSETS.filter(name => /\.(?:webp|png|jpe?g)$/i.test(name)).map(name => ['asset:' + name, name.replace(/\.[^.]+$/, '').replaceAll('-', ' ')])],
      finishField() { lastField = ''; },
      change(key, value, groupTyping) {
        const meta = draft.pages[scope]?.meta;
        if ((meta?.[key] || '') === value) return;
        change(() => {
          if (value) ((draft.pages[scope] ||= {}).meta ||= {})[key] = value;
          else {
            delete meta[key];
            if (!Object.keys(meta).length) delete draft.pages[scope].meta;
            if (!Object.keys(draft.pages[scope]).length && !Object.hasOwn(state.draft?.pages || {},scope)) delete draft.pages[scope];
          }
        }, {key:groupTyping ? 'meta:' + scope + ':' + key : undefined, panel:false, canvas:false});
      },
    });
  }
  function chooseTab(value) {
    if (!Object.hasOwn(tabs, value) || !finishDirect()) return;
    lastField = '';
    tab = value;
    renderInspector();
  }
  function renderInspector() {
    if (!active || !state) return;
    for (const btn of tabGroup.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tab === tab));
      if (btn.dataset.tab === 'seo') btn.hidden = !hasPageSeo(scope);
    }
    inspectorBody.replaceChildren(({ content: contents, design, seo, media: library, history })[tab]());
  }
  function build() {
    host.replaceChildren();
    host.classList.add('consumer-editor');
    host.setAttribute('data-consumer-editor', '');
    pageSelect = listOfPages(pages());
    pageSelect.value = scope;
    pageSelect.addEventListener('change', () => chooseScope(pageSelect.value));
    undoButton = button('Undo', () => travel(true), 'soft sm');
    redoButton = button('Redo', () => travel(false), 'soft sm');
    saveButton = button('Save draft', saveDraft, 'soft');
    publishButton = button('Publish', publish);
    publishButton.className = 'btn primary';
    status = element('span', { class: 'ce-status', role: 'status' });
    actions = element('div', { class: 'ce-actions' }, status, undoButton, redoButton, saveButton, publishButton);
    pageTools = element('div', { class: 'ce-page-tools' });
    bar = element('div', { class: 'glass group ce-bar' }, field('Page or shared element', pageSelect), pageTools, actions);
    messages = element('div', { class: 'ce-message', role: 'status', hidden: '' });
    deviceGroup = element('div', { class: 'seg ce-tabs', role: 'group', 'aria-label': 'Preview size' });
    for (const value of Object.keys(sizes)) deviceGroup.append(element('button', {
      type: 'button', 'data-device': value, onclick: () => chooseDevice(value),
    }, value === 'mobile' ? 'Mobile' : 'Desktop'));
    statePicker = element('div', { class: 'ce-state-picker' });
    expandButton = button('Expand preview', () => expandCanvas(!expanded), 'soft sm ce-expand', {'aria-expanded':'false'});
    const canvasHeading = element('header', { class: 'ce-heading' }, title('Page preview'), statePicker, deviceGroup, expandButton);
    stage = element('div', { class: 'ce-stage' });
    frameMessage = element('div', { class: 'ce-frame-message', role: 'status' });
    canvasArea = element('div', { class: 'ce-viewport' }, frameMessage, stage);
    picker = element('div', {id:'ce-canvas-picker', class:'ce-canvas-picker', role:'group', 'aria-label':'Choose an element', hidden:''});
    pickerToggle = button('Choose an element', showPicker, 'soft sm', {'aria-controls':'ce-canvas-picker', 'aria-expanded':'false', disabled:true});
    layoutScopeControl = select([['all','All sizes'], ['mobile','Mobile only']], editSize,
      value => chooseDevice(value === 'mobile' ? 'mobile' : device,value), {'aria-label':'Apply layout to'});
    const layoutScope = element('label', {class:'ce-layout-scope'}, element('span',{},'Apply layout to'), layoutScopeControl);
    const hint = element('div', {class:'ce-canvas-hint'},
      element('span', {id:'ce-canvas-hint'}, 'Select text, a button or a photo to edit it here.'), pickerToggle, layoutScope);
    const canvasPanel = element('section', { class: 'glass group ce-canvas', 'aria-label': 'Page preview' }, canvasHeading, hint, picker, canvasArea);
    tabGroup = element('div', { class: 'seg ce-tabs ce-inspector-tabs', role: 'group', 'aria-label': 'Editor tools' });
    for (const [id, text] of Object.entries(tabs)) tabGroup.append(element('button', { type: 'button', 'data-tab': id, onclick: () => chooseTab(id) }, text));
    inspectorBody = element('div', { class: 'ce-inspector-body' });
    inspector = element('section', { class: 'glass group ce-inspector', 'aria-label': 'Page inspector' }, tabGroup, inspectorBody);
    const toolsJump = button('Edit page', () => { inspector.scrollIntoView({block:'start'}); tabGroup.querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); }, 'soft sm ce-mobile-action');
    toolsJump.setAttribute('aria-label','Jump to page inspector');
    canvasHeading.append(toolsJump);
    const back = button('View page preview', () => { canvasPanel.scrollIntoView({block:'start'}); deviceGroup.querySelector('[aria-pressed=true]')?.focus({preventScroll:true}); }, 'soft sm ce-mobile-action');
    inspector.append(back);
    host.append(bar, messages, element('div', { class: 'ce-workspace' }, canvasPanel, inspector));
    direct = mountDirectEditor(host);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fitPreview); resizeObserver.observe(canvasArea);
    }
    window.addEventListener('resize', fitPreview, { signal: usable.signal });
    refreshPageControls();
    chooseDevice(device,editSize);
    renderStatus();
    loadCanvas();
  }

  async function load() {
    const token = ++serial;
    host.replaceChildren(element('p', { class: 'consumer-message', role: 'status' }, 'Opening storefront editor…'));
    try {
      const result = await api('GET', endpoint);
      if (!active || token !== serial) return;
      applyState(result);
      build();
      // Design editing is available even while the separate retail service is offline.
      void api('GET', '/api/admin/consumer/products').then(result => {
        if (!active || token !== serial || !Array.isArray(result.products)) return;
        coffees = result.products.filter(item => item.category === 'coffee' || !item.category);
        availability.setProducts(result.products.filter(item => !item.archived));
        pageSelect.replaceChildren(...listOfPages(pages()).children);
        pageSelect.value = scope;
        canvas?.update(draft);
        if (selectedWidget()?.type === 'coffee-shelf' || (tab === 'seo' && !inspectorBody.contains(document.activeElement))) renderInspector();
      }).catch(() => {
        if (!active || token !== serial) return;
        catalogueUnavailable = true;
        if (selectedWidget()?.type === 'coffee-shelf') renderInspector();
      });
    } catch (error) {
      if (!active || token !== serial) return;
      host.replaceChildren(element('div', { class: 'group glass ce-start-error', role: 'alert' }, element('h3', {}, 'Storefront editor unavailable'),
        help(error.message || 'Try opening the editor again.'), button('Try again', load)));
    }
  }

  document.addEventListener('keydown', event => {
    if (!host.contains(event.target) && !(directSession && event.target.closest('.ce-direct'))) return;
    if ((!event.metaKey && !event.ctrlKey) || event.altKey || !state || busy || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      if (isDirty() && !conflict) saveDraft();
    }
    if (key === 'z' && !event.target.isContentEditable && !event.target.closest('input,textarea')) {
      event.preventDefault(); travel(!event.shiftKey);
    }
  }, {signal:usable.signal});
  window.addEventListener('beforeunload', event => {
    if (!isDirty() && !busy && (!directSession || direct.canClose())) return;
    event.preventDefault();
    event.returnValue = '';
  }, { signal: usable.signal });
  load();
  return {
    isDirty,
    async canLeave() {
      if (!finishDirect()) return false;
      if (busy) { setNotice('Wait for the current change to finish.'); return false; }
      if (!isDirty()) return true;
      return confirmSheet({ title: 'Leave unsaved edits?', text: 'Save your draft to continue editing it later, or discard the changes in this tab.', confirm: 'Discard and leave', danger: true });
    },
    destroy() {
      active = false;
      direct?.destroy();
      usable.abort();
      canvasRequest?.abort();
      canvas?.destroy();
      resizeObserver?.disconnect();
      host.replaceChildren(); host.classList.remove('consumer-editor','ce-wide-canvas'); host.removeAttribute('data-consumer-editor');
    },
  };
}
