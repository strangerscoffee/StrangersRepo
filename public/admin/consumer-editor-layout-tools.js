// Drop boundaries are expressed relative to a stable section ID, so the same
// move works in a scaled frame, a filtered outline and either device order.
export function movedSections(order, source, target, after, locked) {
  if (source === target || !order.includes(source) || !order.includes(target) || locked(source)) return null;
  const next = order.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  if (next.every((id, index) => id === order[index])) return null;
  if (order.some((id, index) => locked(id) && next[index] !== id)) return null;
  return next;
}

export function defaultWidget(type, types) {
  const widget = {type};
  if (type !== 'image' && type !== 'divider') widget.heading = types[type];
  if (['hero', 'image', 'cards'].includes(type)) {
    widget.image = 'asset:roastery.webp';
    widget.alt = 'Strangers Coffee roastery';
  }
  return widget;
}

// An editorial can become an independent widget only when all its content
// fits the widget schema. Never copy storefront markup, IDs or controls.
export function editorialCopy(node, assets, checkLink) {
  if (!node || node.querySelector('form,button,details,dialog,nav,select,textarea,input,iframe,video,audio,svg,ul,ol,table,[data-catalogue-id]')) return null;
  const headings = node.querySelectorAll('h1,h2,h3,h4,h5,h6'), links = node.querySelectorAll('a'), images = node.querySelectorAll('img');
  if (headings.length > 1 || images.length > 1 || links.length > 1) return null;
  const paragraphs = [...node.querySelectorAll('p')];
  const content = [...headings,...paragraphs,...links];
  if (content.some(a => content.some(b => a !== b && a.contains(b)))) return null;
  const walker = node.ownerDocument.createTreeWalker(node, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.textContent.trim() && !content.some(el => el.contains(text))) return null;
  }
  const title = headings[0]?.textContent.trim(), body = paragraphs.map(p => p.textContent.trim()).filter(Boolean).join('\n\n');
  if ((!title && !body && !images.length) || title?.length > 240 || body.length > 8000) return null;
  const widget = {type:images.length ? 'hero' : 'text'};
  if (title) widget.heading = title;
  if (body) widget.body = body;
  if (links.length) {
    widget.label = links[0].textContent.trim();
    if (!widget.label || widget.label.length > 160) return null;
    try { widget.href = checkLink(links[0].getAttribute('href')); }
    catch { return null; }
    if (!widget.href) return null;
  }
  if (images.length) {
    const src = images[0].getAttribute('src') || '';
    const media = /^\/(?:api\/admin\/consumer\/editor\/media|consumer-media)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(src);
    const file = /^\/(?:api\/admin\/consumer\/editor|consumer-preview)\/assets\/([^/]+)$/.exec(src);
    if (media) widget.image = 'media:' + media[1];
    else if (file && assets.includes(file[1])) widget.image = 'asset:' + file[1];
    else return null;
    widget.alt = images[0].alt;
    if (widget.alt.length > 500) return null;
    widget.layout = (title || body) ? 'split' : 'stack';
  }
  return widget;
}

function attachDrag(handle, model, signal) {
  const doc = handle.ownerDocument, win = doc.defaultView;
  handle.addEventListener('pointerdown', start, {signal});
  function start(event) {
    if (event.button !== 0 || event.pointerType === 'touch' || signal.aborted) return;
    event.preventDefault();
    const frame = model.frame, panel = handle.closest('.ce-direct-panel');
    const marker = doc.createElement('div'), drag = new AbortController();
    marker.dataset.layoutDropMarker = '';
    marker.className = 'ce-layout-drop-marker';
    marker.setAttribute('aria-hidden','true');
    marker.hidden = true;
    doc.body.append(marker);
    const origin = {x:event.clientX, y:event.clientY}, id = event.pointerId;
    let pointer = origin, candidate, tick = 0, engaged = false;
    const opts = {signal:drag.signal};
    handle.setPointerCapture(id);
    function stop() {
      if (drag.signal.aborted) return;
      drag.abort();
      signal.removeEventListener('abort',stop);
      win.cancelAnimationFrame(tick);
      marker.remove();
      panel.classList.remove('ce-layout-dragging');
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    }
    function locate(scroll) {
      candidate = null;
      marker.hidden = true;
      if (!engaged) return;
      const box = frame.getBoundingClientRect();
      const top = Math.max(box.top,0), bottom = Math.min(box.bottom,win.innerHeight);
      if (pointer.x < box.left || pointer.x > box.right || pointer.y < top || pointer.y > bottom) return;
      const sy = box.height / frame.offsetHeight;
      const targets = model.targets().map(item => {
        const rect = item.node.getBoundingClientRect();
        return {id:item.id, top:box.top + rect.top * sy, bottom:box.top + rect.bottom * sy};
      });
      if (!targets.length) return;
      const target = targets.find(item => pointer.y < (item.top + item.bottom) / 2) || targets.at(-1);
      const after = target === targets.at(-1) && pointer.y >= (target.top + target.bottom) / 2;
      if (model.canDrop(target.id,after)) {
        candidate = {id:target.id,after};
        marker.hidden = false;
        marker.style.top = Math.max(top,Math.min(bottom-3,after ? target.bottom : target.top)) + 'px';
        marker.style.left = Math.max(0,box.left) + 'px';
        marker.style.width = Math.max(0,Math.min(box.right,win.innerWidth)-Math.max(0,box.left)) + 'px';
      }
      if (!scroll) return;
      const edge = Math.min(55,(bottom-top)/5);
      const dist = pointer.y < top+edge ? pointer.y - top - edge : Math.max(0,pointer.y - bottom + edge);
      if (!dist) return;
      const previous = frame.contentWindow.scrollY;
      frame.contentWindow.scrollBy(0, Math.sign(dist) * Math.ceil(Math.abs(dist) / (2 * sy)));
      if (frame.contentWindow.scrollY !== previous) tick = win.requestAnimationFrame(() => locate(true));
    }
    handle.addEventListener('pointermove', e => {
      if (e.pointerId !== id) return;
      pointer = {x:e.clientX,y:e.clientY};
      if (Math.hypot(pointer.x-origin.x,pointer.y-origin.y) > 3) engaged = true;
      panel.classList.toggle('ce-layout-dragging',engaged);
      win.cancelAnimationFrame(tick);
      locate(true);
    },opts);
    handle.addEventListener('pointerup', e => {
      if (e.pointerId !== id) return;
      pointer = {x:e.clientX,y:e.clientY};
      locate(false);
      const drop = candidate;
      stop();
      if (drop) model.drop(drop.id,drop.after);
    },opts);
    handle.addEventListener('lostpointercapture',stop,opts);
    handle.addEventListener('pointercancel',stop,opts);
    win.addEventListener('blur',stop,opts);
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape') {e.preventDefault();e.stopImmediatePropagation();stop();}
    },{...opts,capture:true});
    signal.addEventListener('abort',stop,{once:true});
  }
}

export function renderLayoutTools(container, model, signal) {
  const doc = container.ownerDocument;
  const bar = doc.createElement('div');
  bar.className = 'ce-layout-toolbar';
  bar.setAttribute('role','group');
  bar.setAttribute('aria-label','Arrange section');
  container.append(bar);
  function button(label, handler, parent = bar) {
    const el = doc.createElement('button');
    el.className = 'ce-direct-button'; el.type = 'button'; el.textContent = label;
    if (handler) el.addEventListener('click',handler);
    parent.append(el);
    return el;
  }
  if (model.canUp || model.canDown) {
    const handle = button('Drag to move');
    handle.classList.add('ce-layout-handle');
    handle.tabIndex = -1; // Move up and Move down provide the keyboard equivalent.
    attachDrag(handle,model,signal);
  }
  button('Move up',()=>model.move(-1)).disabled = !model.canUp;
  button('Move down',()=>model.move(1)).disabled = !model.canDown;
  if (model.resetOrder) button('Use inherited order',model.resetOrder);
  if (model.duplicate) button(model.widget ? 'Duplicate widget' : 'Copy as widget',model.duplicate);
  if (model.insert) {
    const add = button('Add here',()=>{
      picker.hidden = !picker.hidden;
      add.setAttribute('aria-expanded',String(!picker.hidden));
      if (!picker.hidden) choose.focus({preventScroll:true});
    });
    add.setAttribute('aria-expanded','false');
    const picker = doc.createElement('div'), choose = doc.createElement('select');
    picker.className = 'ce-layout-insert'; picker.hidden = true;
    choose.className = 'ce-direct-input'; choose.setAttribute('aria-label','Insert after section');
    for (const [name, entries] of model.groups) {
      const group = doc.createElement('optgroup'); group.label = name;
      for (const [key,value] of entries) {
        const opt = doc.createElement('option'); opt.value = key; opt.textContent = value; group.append(opt);
      }
      choose.append(group);
    }
    picker.append(choose);
    button('Insert',()=>model.insert(choose.value),picker);
    container.append(picker);
  }
  if (model.mobile && (model.duplicate || model.insert)) {
    const note = doc.createElement('p'); note.className = 'ce-layout-note';
    note.textContent = 'New sections and copies appear on all screen sizes.'; container.append(note);
  }
  return bar.querySelector('button:not([disabled]):not([tabindex="-1"])');
}
