import {
  COFFEE_CHOICES, THEMES, LAYOUTS, WIDGET_TYPES, ASSETS, TEMPLATES, emptyDocument, imageUrl, referencedMedia, validateDocument,
} from '/api/admin/consumer/editor/assets/editor-model.js';
import { availability } from '/api/admin/consumer/editor/assets/products.js';
import { mountEditorCanvas } from '/api/admin/consumer/editor/assets/editor-render.js';

import { editorPages, mountEditorPages } from './consumer-editor-pages.js';
import { buildPublishReview, renderPublishReview } from './consumer-editor-review.js';

const previewStates = {
  finder: [['brew','Brew method'], ['taste','Taste'], ['match','Coffee match']],
  cart: [['items','Cart with coffee'], ['empty','Empty cart']],
  checkout: [['delivery','Delivery details'], ['collection','Collection details'], ['review','Review order'], ['processing','Processing'], ['confirmation','Confirmation'], ['empty','Empty cart']],
  account: [['login','Sign in'], ['register','Create account'], ['forgot','Request password reset'], ['reset','Choose password'], ['setup','Finish registration'], ['orders','Order history'], ['details','Account details']],
};
const endpoint = '/api/admin/consumer/editor';
const uploadLimit = 1536 * 1024;
const tabs = { content: 'Content', design: 'Design', media: 'Photos', history: 'Versions' };
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

export function mountConsumerEditor(host, { api, confirmSheet }) {
  let active = true, serial = 0, canvas, canvasRequest, resizeObserver;
  let state, draft, saved = '', scope = 'home', pick = { scope: 'home' }, tab = 'content';
  let busy = false, conflict = false, notice = '', problem = false, device = matchMedia('(max-width: 740px)').matches ? 'mobile' : 'desktop';
  let viewState = '', outlineOpen = false, expanded = false, expandButton, previewGeneration = 0, lastField = '', previewReady = false;
  let coffees = COFFEE_CHOICES, catalogueUnavailable = false;
  const undo = [], redo = [], usable = new AbortController();
  const isDirty = () => Boolean(draft && snapshot(draft) !== saved);
  const shelf = () => draft.pages[pick.scope] || {};
  const pages = () => editorPages(draft);
  const details = () => pages()[pick.scope];
  const pageForEdit = () => draft.pages[pick.scope] ||= {};
  const selectedWidget = () => (shelf().widgets || []).find(item => item.id === pick.widget);
  const nativeField = () => details().fields.find(item => item.id === pick.field);
  const nativeSection = () => details().sections.find(item => item.id === pick.section);
  const lines = () => {
    const page = shelf(), inventory = details();
    const all = [...inventory.sections.map(item => item.id), ...(page.widgets || []).map(item => item.id)];
    return [...new Set([...(page.sections || []), ...all])].filter(id => all.includes(id));
  };
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
  function change(callback, options = {}) {
    if (busy || !active) return;
    remember(options.key);
    callback();
    if (!conflict) { notice = ''; problem = false; }
    canvas?.update(draft);
    if (options.panel !== false) renderInspector();
    renderStatus();
  }
  function travel(backward) {
    const from = backward ? undo : redo, to = backward ? redo : undo;
    if (busy || !from.length) return;
    to.push(snapshot(draft));
    draft = JSON.parse(from.pop());
    ensureScope();
    lastField = '';
    if (pick.widget && !selectedWidget()) pick = { scope: pick.scope };
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
    if (pick.widget && !selectedWidget()) pick = { scope: pick.scope };
    canvas?.update(draft);
  }
  async function operation(task) {
    if (busy || !active) return;
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
  function chooseDevice(value) {
    device = value;
    for (const control of deviceGroup.children) control.setAttribute('aria-pressed', String(control.dataset.device === value));
    fitPreview();
  }
  function refreshPageControls() {
    if (!pageSelect || !pageTools) return;
    const options = listOfPages(pages());
    pageSelect.replaceChildren(...options.children);
    pageSelect.value = scope;
    bar.toggleAttribute('data-custom-page', scope.startsWith('custom:'));
    mountEditorPages(pageTools, { getDocument: () => draft, getPage: () => scope, confirmSheet,
      onChange: (next, target) => {
        if (busy || !active) return;
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
    scope = value;
    if (!problem && !conflict) setNotice('');
    viewState = '';
    refreshPageControls();
    pageSelect.value = value;
    pick = { scope };
    tab = 'content';
    lastField = '';
    renderInspector();
    loadCanvas();
  }
  async function loadCanvas() {
    canvasRequest?.abort();
    canvasRequest = new AbortController();
    const request = canvasRequest, token = ++previewGeneration;
    canvas?.destroy();
    canvas = undefined;
    previewReady = false;
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
      frame = element('iframe', { title: 'Editable storefront preview · ' + pages()[scope].label, sandbox: 'allow-same-origin', tabindex:'-1', referrerpolicy: 'no-referrer' });
      frame.addEventListener('load', () => {
        if (!active || token !== previewGeneration) return;
        try {
          const doc = frame.contentDocument;
          if (!doc || !doc.querySelector('main')) throw new Error('The storefront returned an incomplete preview.');
          canvas = mountEditorCanvas(doc, { scope, document: draft, onSelect: selected => {
            if (!active || busy || !selected || !Object.hasOwn(pages(), selected.scope || scope)) return;
            pick = { ...selected, scope: selected.scope || scope };
            if (pick.widget && pick.scope.startsWith('product:') && !selectedWidget() &&
                draft.pages.product?.widgets?.some(item => item.id === pick.widget)) pick.scope = 'product';
            tab = 'content';
            lastField = '';
            if (expanded) expandCanvas(false);
            canvas?.select(pick);
            renderInspector();
            if (matchMedia('(max-width: 820px)').matches) inspector.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          } });
          previewReady = true;
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
  function selectItem(selection) {
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
  function reorder(id, target) {
    const rows = lines(), from = rows.indexOf(id), to = rows.indexOf(target);
    if (from < 0 || to < 0 || from === to || rows.slice(Math.min(from,to),Math.max(from,to)+1).some(lockedSection)) return;
    rows.splice(from,1);
    rows.splice(to,0,id);
    change(() => { pageForEdit().sections = rows; });
  }
  function layerOutline(sequence) {
    const disclosure = element('details', {class:'ce-layers'});
    disclosure.open = outlineOpen;
    disclosure.addEventListener('toggle',()=>{ if(disclosure.isConnected)outlineOpen=disclosure.open; });
    disclosure.append(element('summary',{},'Arrange sections'));
    const stack = element('ol', {class:'ce-layer-list', 'aria-label':'Section order'});
    let dragging = '';
    for (const [id,label] of sequence) {
      const widget = (shelf().widgets || []).some(item => item.id===id);
      const locked = lockedSection(id);
      const row = element('li', {'data-layer':id});
      const handle = element('span', {class:'ce-grip','aria-hidden':'true', title:locked ? 'Fixed position' : 'Drag to reorder'}, locked ? '·' : '⠿');
      const focus = element('button', {type:'button', onclick:()=>selectItem({scope:pick.scope,[widget?'widget':'section']:id}), 'aria-label':'Edit '+label}, label);
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
  function widgetControls(widget) {
    const update = (key, val, rerender = false) => change(() => { selectedWidget()[key] = val; }, { key: widget.id + ':' + key, panel: rerender });
    const box = group(title(WIDGET_TYPES[widget.type] || 'Widget'), positionControls(widget.id));
    if (widget.type === 'coffee-shelf') box.append(coffeeChoices(widget));
    if (widget.type !== 'divider') {
      box.append(textControl('Heading', widget.heading, value => update('heading', value), { max: 240 }));
      box.append(textControl('Text', widget.body, value => update('body', value), { multiline: true, max: 8000 }));
      box.append(field('Arrangement', select([['stack', 'Stacked'], ['split', 'Image left'], ['reverse', 'Image right']], widget.layout || 'stack', value => update('layout', value, true))));
      box.append(picture(widget.image, value => update('image', value, true)));
      box.append(textControl('Photo description', widget.alt, value => update('alt', value), { max: 500 }));
      box.append(textControl('Button text', widget.label, value => update('label', value), { max: 160 }));
      box.append(textControl('Button destination', widget.href, value => update('href', value), { max: 2048 }));
    }
    box.append(button('Remove widget', async () => {
      if (!await confirmSheet({ title: 'Remove this widget?', text: 'The change will be part of your draft.', confirm: 'Remove widget', danger: true }) || !active) return;
      change(() => {
        const entry = pageForEdit();
        entry.widgets = entry.widgets.filter(item => item.id !== widget.id);
        if (entry.sections) entry.sections = entry.sections.filter(id => id !== widget.id);
        pick = { scope: pick.scope };
      });
    }, 'soft sm'));
    return box;
  }
  function contents() {
    const inventory = details(), current = shelf(), wrapper = group();
    const sequence = lines().map(id => {
      const section = inventory.sections.find(item => item.id === id);
      const widget = (current.widgets || []).find(item => item.id === id);
      return [id, (widget ? widget.heading || WIDGET_TYPES[widget.type] : section.label) + ((current.hidden || []).includes(id) ? ' · hidden' : '')];
    });
    const visibleFields = pick.section && !pick.field ? inventory.fields.filter(item => !item.section || item.section === pick.section) : inventory.fields;
    const fieldList = visibleFields.map(item => [item.id, item.label]);
    wrapper.append(help('Select an item on the page or choose it below.'));
    if (pick.scope !== scope) wrapper.append(help('Editing ' + inventory.label + ' on ' + pages()[scope].label + '.'),
      button('Return to page content', () => selectItem({scope}), 'soft sm'));
    if (sequence.length) wrapper.append(layerOutline(sequence), field('Section or widget', select([['', 'Choose a section'], ...sequence], pick.section || pick.widget || '', id => {
      const widget = (shelf().widgets || []).some(item => item.id === id);
      selectItem(id ? { scope: pick.scope, [widget ? 'widget' : 'section']: id } : { scope: pick.scope });
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
    else if (descriptor) wrapper.append(editNative(descriptor));
    else if (section) {
      wrapper.append(title(section.label));
      if (!section.locked) wrapper.append(field('Section width', select(Object.entries(LAYOUTS), current.sectionLayouts?.[section.id] || 'standard', value => change(() => {
        const entry = pageForEdit();
        entry.sectionLayouts ||= {};
        entry.sectionLayouts[section.id] = value;
      }))));
      if (section.locked) wrapper.append(help('This section contains essential storefront controls.'));
      else {
        const hidden = (current.hidden || []).includes(section.id);
        wrapper.append(positionControls(section.id), button(hidden ? 'Show section' : 'Hide section', () => change(() => {
          const entry = pageForEdit();
          entry.hidden = hidden ? (entry.hidden || []).filter(id => id !== section.id) : [...(entry.hidden || []), section.id];
        }), 'soft sm'));
      }
    }
    return wrapper;
  }

  function insertWidgets(entries) {
    const newWidgets = entries.map(item => ({ ...clone(item), id: widgetId() }));
    const position = lines(), after = pick.widget || pick.section;
    const index = after && position.includes(after) ? position.indexOf(after) + 1 : position.length;
    position.splice(index, 0, ...newWidgets.map(item => item.id));
    change(() => {
      const entry = pageForEdit();
      entry.widgets = [...(entry.widgets || []), ...newWidgets];
      entry.sections = position;
      pick = { scope: pick.scope, widget: newWidgets[0].id };
      tab = 'content';
    });
    canvas?.select(pick);
  }
  function design() {
    const current = shelf();
    const controls = group(
      field('Storefront theme', select(Object.entries(THEMES), draft.theme, value => change(() => { draft.theme = value; }))),
      field('Page theme', select([['', pick.scope.startsWith('product:') ? 'Inherit product template theme' : 'Use storefront theme'], ...Object.entries(THEMES)], current.theme || '', value => change(() => {
        if (value) pageForEdit().theme = value;
        else delete pageForEdit().theme;
      }))),
      field('Page width', select(Object.entries(LAYOUTS), current.layout || 'standard', value => change(() => { pageForEdit().layout = value; }))),
    );
    if (!['shared','finder','cart'].includes(pick.scope)) {
      const meta = current.meta || {};
      const update = (key,value) => change(() => {
        const entry = pageForEdit();
        entry.meta ||= {};
        if (value.trim()) entry.meta[key] = value;
        else delete entry.meta[key];
        if (!Object.keys(entry.meta).length) delete entry.meta;
      }, {key:'meta:'+pick.scope+':'+key,panel:false});
      controls.append(element('details', {class:'ce-meta'}, element('summary',{},'Page title and description'), group(
        help('Set the browser title and search description. Leave a field empty to use the original.'),
        textControl('Page title',meta.title,v=>update('title',v),{max:150}),
        textControl('Page description',meta.description,v=>update('description',v),{max:320,multiline:true}))));
    }
    if (details().widgets !== false) {
      let widgetType = Object.keys(WIDGET_TYPES)[0], templateId = Object.keys(TEMPLATES)[0];
      controls.append(title('Add to this page'),
        field('Widget', select(Object.entries(WIDGET_TYPES), widgetType, value => { widgetType = value; })),
        button('Add widget', () => {
          const defaults = { type: widgetType };
          if (!['image', 'divider'].includes(widgetType)) defaults.heading = WIDGET_TYPES[widgetType];
          if (['hero', 'image', 'cards'].includes(widgetType)) { defaults.image = 'asset:roastery.webp'; defaults.alt = 'Strangers Coffee roastery'; }
          insertWidgets([defaults]);
        }, 'soft sm'),
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
  async function upload(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 24 * 1024 * 1024) {
      setNotice('Choose a JPEG, PNG or WebP photo up to 24 MB.', true);
      return;
    }
    return operation(async () => {
      const prepared = await preparePhoto(file);
      const result = await api('POST', endpoint + '/media', { name: prepared.name, type: prepared.type, data: await fileData(prepared) });
      if (!active) return;
      state.media = [result.media, ...state.media.filter(entry => entry.id !== result.media.id)];
      setNotice('Photo added to the library.');
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
  function chooseTab(value) {
    if (!Object.hasOwn(tabs, value)) return;
    lastField = '';
    tab = value;
    renderInspector();
  }
  function renderInspector() {
    if (!active || !state) return;
    for (const btn of tabGroup.children) btn.setAttribute('aria-pressed', String(btn.dataset.tab === tab));
    inspectorBody.replaceChildren(({ content: contents, design, media: library, history })[tab]());
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
    const canvasPanel = element('section', { class: 'glass group ce-canvas', 'aria-label': 'Page preview' }, canvasHeading, canvasArea);
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
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fitPreview); resizeObserver.observe(canvasArea);
    }
    window.addEventListener('resize', fitPreview, { signal: usable.signal });
    refreshPageControls();
    chooseDevice(device);
    renderInspector();
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
        canvas?.update(draft);
        if (selectedWidget()?.type === 'coffee-shelf') renderInspector();
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

  host.addEventListener('keydown', event => {
    if ((!event.metaKey && !event.ctrlKey) || event.altKey || !state || busy || event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      if (isDirty() && !conflict) saveDraft();
    }
    if (key === 'z' && !event.target.closest('input,textarea,[contenteditable=true]')) {
      event.preventDefault(); travel(!event.shiftKey);
    }
  }, {signal:usable.signal});
  window.addEventListener('beforeunload', event => {
    if (!isDirty() && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  }, { signal: usable.signal });
  load();
  return {
    isDirty,
    async canLeave() {
      if (busy) { setNotice('Wait for the current change to finish.'); return false; }
      if (!isDirty()) return true;
      return confirmSheet({ title: 'Leave unsaved edits?', text: 'Save your draft to continue editing it later, or discard the changes in this tab.', confirm: 'Discard and leave', danger: true });
    },
    destroy() {
      active = false;
      usable.abort();
      canvasRequest?.abort();
      canvas?.destroy();
      resizeObserver?.disconnect();
      host.replaceChildren(); host.classList.remove('consumer-editor','ce-wide-canvas'); host.removeAttribute('data-consumer-editor');
    },
  };
}
