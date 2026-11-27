function restoreCaret(input, anchor, focus = anchor) {
  if (input.tagName === 'TEXTAREA') { input.setSelectionRange(anchor,focus); return; }
  const doc = input.ownerDocument;
  function point(offset) {
    const walker = doc.createTreeWalker(input,NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (offset <= n.length) return [n,offset];
      offset -= n.length;
    }
    return [input,input.childNodes.length];
  }
  doc.getSelection().setBaseAndExtent(...point(anchor),...point(focus));
}

// Copy only inline typography, never storefront HTML, attributes or handlers.
function mirrorEmphasis(input, source, value) {
  const doc = input.ownerDocument;
  const fragment = doc.createDocumentFragment();
  function copyChildren(node, parent) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) parent.append(child.data);
      else if (child.nodeType === 1) {
        const tag = child.localName;
        if (['em','strong','i','b'].includes(tag)) {
          const run = doc.createElement(tag);
          const style = child.ownerDocument.defaultView.getComputedStyle(child);
          Object.assign(run.style,{color:style.color,fontWeight:style.fontWeight,fontStyle:style.fontStyle});
          copyChildren(child,run);
          parent.append(run);
        } else copyChildren(child,parent);
      }
    }
  }
  if (source?.textContent === value) copyChildren(source,fragment);
  else fragment.append(value);
  if (input.childNodes.length === fragment.childNodes.length &&
      Array.from(input.childNodes).every((node,i) => node.isEqualNode(fragment.childNodes[i]))) return;

  const selection = doc.getSelection();
  function offset(node, index) {
    const range = doc.createRange();
    range.selectNodeContents(input);
    range.setEnd(node,index);
    return Math.min(value.length, range.toString().length);
  }
  const caret = input.contains(selection.anchorNode) && input.contains(selection.focusNode)
    ? [offset(selection.anchorNode,selection.anchorOffset),offset(selection.focusNode,selection.focusOffset)] : null;
  input.replaceChildren(fragment);
  if (caret) restoreCaret(input,...caret);
}

// The editable text and controls live in Admin. The storefront frame supplies
// geometry and visual styles but never receives editable HTML or executes input.
export function mountDirectEditor(host) {
  const doc = host.ownerDocument;
  const view = doc.defaultView;
  let session = null;
  const make = (tag, type, text) => {
    const el = doc.createElement(tag);
    if (type) el.className = type;
    if (text) el.textContent = text;
    return el;
  };
  function button(label, action, click) {
    const el = make('button', 'ce-direct-button', label);
    el.type = 'button';
    el.dataset.directAction = action;
    el.addEventListener('click', click);
    return el;
  }
  function tell(s, message) {
    s.message.textContent = message;
    s.message.hidden = !message;
    s.schedule();
  }
  function write(s, field, value, input) {
    if (s !== session) return false;
    try {
      s.model.onChange(field.id, value);
      s.values.set(field.id, value);
      s.errors.delete(field.id);
      input?.removeAttribute('aria-invalid');
      tell(s, s.errors.values().next().value?.message || '');
      return true;
    } catch (error) {
      const message = error?.message || 'Check this value.';
      s.errors.set(field.id, {input, message});
      input?.setAttribute('aria-invalid', 'true');
      tell(s, message);
      return false;
    }
  }
  function canClose() {
    if (!session) return true;
    session.finishComposition?.();
    if (session.uploading) {
      tell(session, 'The photo is uploading. Wait for it to finish or cancel this edit.');
      return false;
    }
    const invalid = session.errors.values().next().value;
    if (invalid) {
      tell(session, invalid.message);
      invalid.input?.focus({preventScroll:true});
      return false;
    }
    return true;
  }
  function close({restoreFocus = false, force = false, cancel = false} = {}) {
    const s = session;
    if (!s) return true;
    if (!force && !cancel && !canClose()) return false;
    session = null;
    s.listeners.abort();
    s.observer.disconnect();
    s.resize.disconnect();
    if (s.tick) view.cancelAnimationFrame(s.tick);
    s.root.remove();
    if (cancel) s.model.onCancel?.();
    s.model.onFinish?.();
    if (restoreFocus && s.model.frame.isConnected) {
      // Keep keyboard focus at the canvas without switching active windows to
      // the sandboxed child (Admin verifies the session on window changes).
      const canvas = s.model.returnFocus?.isConnected ? s.model.returnFocus : s.model.frame.closest('.ce-canvas') || host;
      if (!canvas.hasAttribute('tabindex') && canvas.tabIndex < 0) canvas.tabIndex = -1;
      canvas.focus({preventScroll:true});
    }
    return true;
  }
  function open(model) {
    if (!close() || !model.fields.length || !model.frame?.contentDocument) return false;
    const original = model.getTarget();
    if (!original?.isConnected) return false;
    const root = make('section','ce-direct');
    root.setAttribute('role','dialog');
    root.setAttribute('aria-label','Edit ' + model.label);
    const panel = make('div','ce-direct-panel');
    const head = make('header','ce-direct-head');
    const heading = make('strong','ce-direct-heading',model.label);
    const cancel = button('Cancel','cancel',()=>close({cancel:true,restoreFocus:true}));
    const done = button('Done','done',()=>close({restoreFocus:true}));
    const actions = make('div','ce-direct-actions');
    actions.append(cancel, done);
    head.append(heading, actions);
    const body = make('div','ce-direct-body');
    const message = make('p','ce-direct-error');
    message.setAttribute('role','status');
    message.hidden = true;
    panel.append(head, body, message);
    root.append(panel);
    doc.body.append(root);
    const standaloneText = model.inlineText !== false && model.fields.length === 1 && model.fields[0].kind === 'text';
    let inlineInput, firstControl;
    const s = session = {
      model, root, panel, message, errors:new Map(), values:new Map(model.fields.map(f => [f.id,f.value || ''])),
      listeners:new AbortController(), tick:0, uploading:false, schedule,
    };
    const initialHeight = view.visualViewport?.height || view.innerHeight;
    const options = {signal:s.listeners.signal};
    const finish = () => close({restoreFocus:true});
    function textInput(field, inline) {
      const text = field.kind === 'text';
      const multiline = text && (field.multiline ?? (original.matches('p,blockquote,li,figcaption,dd,address') || field.value?.includes('\n')));
      let rich = inline && original.matches('h1,h2,h3,h4,h5,h6') && original.querySelector('em,strong,i,b');
      let el;
      if (rich) {
        el = make('div','ce-direct-inline');
        el.setAttribute('contenteditable','plaintext-only');
        rich = el.contentEditable === 'plaintext-only';
      }
      if (!rich) el = make(inline || multiline ? 'textarea' : 'input', inline ? 'ce-direct-inline' : 'ce-direct-input');
      el.dataset.directKind = field.kind;
      el.setAttribute('aria-label',field.label);
      if (rich) {
        el.setAttribute('role','textbox');
        el.setAttribute('aria-multiline','false');
        mirrorEmphasis(el,original,s.values.get(field.id));
      } else {
        if (el.tagName === 'INPUT') el.type = 'text';
        else el.rows = multiline ? 3 : 1;
        if (field.maxLength) el.maxLength = field.maxLength;
        el.value = s.values.get(field.id);
      }
      if (field.kind === 'link') { el.inputMode = 'url'; el.autocapitalize = 'none'; el.spellcheck = false; }
      // Wait for IME composition before validating and rendering a new draft.
      let composing = false;
      const changed = () => {
        if (s !== session) return;
        if (!composing) {
          // A native plaintext editor can end pasted text with a placeholder
          // break. Headings occupy one paragraph even when their words wrap.
          const value = rich ? el.innerText.replace(/\r?\n$/,'').replace(/\r?\n/g,' ').slice(0,field.maxLength || 16000) : el.value;
          if (s.values.get(field.id) !== value || s.errors.has(field.id)) write(s,field,value,el);
          if (rich) mirrorEmphasis(el,model.getTarget(),value);
        }
        if (inline) schedule();
      };
      function finishComposition() {
        s.finishComposition = null;
        s.composing = composing = false;
        changed();
      }
      el.addEventListener('compositionstart',()=>{
        s.composing = composing = true;
        s.finishComposition = finishComposition;
      });
      el.addEventListener('compositionend',finishComposition);
      el.addEventListener('input',changed);
      el.addEventListener('keydown',event=>{
        if (event.key === 'Enter' && !event.isComposing && !composing && (!event.shiftKey || rich) && (!multiline || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finish();
        }
      });
      if (inline) {
        inlineInput = el;
        // Use the storefront's own ink and paper on flat surfaces. For text
        // on a photograph the neutral Admin surface keeps the caret legible.
        const frameView = original.ownerDocument.defaultView;
        for (let node = original; node; node = node.parentElement) {
          const style = frameView.getComputedStyle(node);
          if (style.backgroundImage !== 'none') break;
          if (style.backgroundColor.startsWith('rgb(')) {
            el.style.backgroundColor = style.backgroundColor;
            el.style.color = frameView.getComputedStyle(original).color;
            break;
          }
        }
        root.prepend(el);
      } else {
        const label = make('label','ce-direct-field');
        label.append(make('span','',field.label),el);
        body.append(label);
      }
      return el;
    }

    function photoInput(field) {
      const photoBox = make('div','ce-direct-photo');
      const row = make('div','ce-direct-photo-row');
      const current = make('img','ce-direct-current');
      current.alt = '';
      const gallery = make('div','ce-direct-library');
      const choices = [...(model.photos || [])];
      const replace = button('Replace photo','replace',event=>{
        showLibrary(gallery.hidden);
        if (!gallery.hidden && (!event.detail || view.matchMedia('(pointer: fine)').matches)) search.focus({preventScroll:true});
      });
      replace.setAttribute('aria-expanded','false');
      function showLibrary(shown) {
        gallery.hidden = !shown;
        replace.setAttribute('aria-expanded',String(shown));
        replace.textContent = shown ? 'Close library' : 'Replace photo';
        schedule();
      }
      const originalSrc = original.tagName === 'IMG' && original.getAttribute('src') ? original.currentSrc || original.src : '';
      function currentPhoto(initial = false) {
        const item = choices.find(p=>p.value === s.values.get(field.id));
        if (item?.src) current.src = item.src;
        else if (initial && originalSrc) current.src = originalSrc;
        else current.removeAttribute('src');
        current.hidden = !current.getAttribute('src');
      }
      function use(value) {
        if (!write(s,field,value,replace)) return;
        populated = false;
        currentPhoto(); showLibrary(false); replace.focus({preventScroll:true});
      }
      currentPhoto(true);
      row.append(current,replace);
      gallery.hidden = true;
      const search = make('input','ce-direct-input'); search.type = 'search'; search.placeholder = 'Search photos'; search.setAttribute('aria-label','Search photos');
      const grid = make('div','ce-direct-photo-grid');
      grid.setAttribute('role','group'); grid.setAttribute('aria-label','Photos');
      function draw() {
        const searchText = search.value.trim().toLocaleLowerCase();
        const matches = choices.filter(p=>p.value && p.label.toLocaleLowerCase().includes(searchText));
        grid.replaceChildren();
        for (const p of matches) {
          const choice = button('', 'choose-photo',()=>use(p.value));
          choice.dataset.directPhoto = p.value;
          choice.setAttribute('aria-label','Use ' + p.label);
          choice.setAttribute('aria-pressed',String(p.value === s.values.get(field.id)));
          const img = make('img'); img.alt = ''; img.src = p.src; img.loading = 'lazy'; img.decoding = 'async';
          choice.append(img,make('span','',p.label));
          grid.append(choice);
        }
        if (!matches.length) grid.append(make('p','ce-direct-empty','No matching photos.'));
      }
      let populated = false;
      replace.addEventListener('click',()=>{if (!gallery.hidden && !populated) {draw(); populated = true;}});
      search.addEventListener('input',draw);
      const file = make('input','ce-direct-file'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp'; file.dataset.directAction = 'upload';
      file.setAttribute('aria-label','Upload photo');
      const upload = button('Upload photo','choose-file',()=>file.click());
      file.addEventListener('change',async()=>{
        const selected = file.files[0];
        file.value = '';
        if (!selected || s.uploading || session !== s) return;
        s.uploading = true;
        upload.disabled = true; done.disabled = true; grid.inert = true; clear.disabled = true;
        tell(s,'Uploading photo…');
        try {
          const p = await model.upload(selected);
          if (s !== session) return;
          if (!p?.value) throw new Error('The photo could not be uploaded.');
          if (!choices.some(item=>item.value === p.value)) choices.unshift(p);
          use(p.value);
          populated = false;
        } catch (error) { if (s === session) tell(s,error?.message || 'The photo could not be uploaded.'); }
        finally {
          s.uploading = false;
          if (s === session) {upload.disabled = false; done.disabled = false; grid.inert = false; clear.disabled = false;}
        }
      });
      const clear = button('Remove photo','remove-photo',()=>use(''));
      const tools = make('div','ce-direct-library-tools');
      if (model.upload) tools.append(upload,file);
      tools.append(clear);
      gallery.append(search,tools,grid); photoBox.append(row,gallery); body.append(photoBox);
      return replace;
    }
    function choiceInput(field) {
      const select = make('select','ce-direct-input');
      select.dataset.directKind = 'choice';
      for (const [value,caption] of field.choices) {
        const option = make('option','',caption);
        option.value = value;
        select.append(option);
      }
      select.value = s.values.get(field.id);
      select.addEventListener('change',()=>write(s,field,select.value,select));
      const label = make('label','ce-direct-field');
      label.append(make('span','',field.label),select);
      body.append(label);
      return select;
    }
    for (const field of model.fields) {
      let control;
      if (field.kind === 'image') control = photoInput(field);
      else if (field.kind === 'choice') control = choiceInput(field);
      else control = textInput(field,standaloneText);
      firstControl ||= control;
    }
    if (standaloneText) { root.dataset.mode = 'inline'; body.hidden = true; }
    let anchorNode, pendingRect;
    function layout() {
      s.tick = 0;
      if (session !== s) return;
      if (!host.isConnected || !model.frame.isConnected) {close({force:true}); return;}
      const frame = model.frame, fr = frame.getBoundingClientRect();
      const target = model.getTarget();
      if (target?.isConnected) {
        if (target !== anchorNode) {
          if (anchorNode) s.resize.unobserve(anchorNode);
          s.resize.observe(target);
          anchorNode = target;
        }
        const rect = target.getBoundingClientRect();
        if (rect.width && rect.height) pendingRect = rect;
      }
      if (!pendingRect || !fr.width || !fr.height) return;
      const sx = fr.width / frame.offsetWidth, sy = fr.height / frame.offsetHeight;
      const rect = pendingRect;
      const viewport = view.visualViewport, vx = viewport?.offsetLeft || 0, vy = viewport?.offsetTop || 0;
      const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
      let top = vy + 8, bottom = vy + height - 8;
      const left = vx + 8, right = vx + width - 8;
      const header = doc.querySelector('.topbar')?.getBoundingClientRect();
      if (header?.height && header.top <= top && header.bottom < bottom - 80) top = Math.max(top,header.bottom + 4);
      const nav = doc.querySelector('.tabbar')?.getBoundingClientRect();
      if (nav?.height && nav.bottom >= bottom - 24 && nav.top > top + 80) bottom = Math.min(bottom,nav.top - 5);
      const ax = fr.left + rect.left * sx, ay = fr.top + rect.top * sy;
      const bx = ax + rect.width * sx, by = ay + rect.height * sy;
      const axVisible = Math.max(ax,fr.left,left), ayVisible = Math.max(ay,fr.top,top);
      const bxVisible = Math.min(bx,fr.right,right), byVisible = Math.min(by,fr.bottom,bottom);
      const keyboard = root.contains(doc.activeElement) && height < Math.max(view.innerHeight,initialHeight) * .82;
      if ((bxVisible <= axVisible || byVisible <= ayVisible) && !keyboard && !s.errors.size && !s.uploading) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const clamp = (n, min, max) => Math.max(min,Math.min(n,max));
      panel.style.maxWidth = (right - left) + 'px';
      panel.style.maxHeight = Math.max(1,bottom - top) + 'px';
      const panelWidth = panel.offsetWidth, panelHeight = panel.offsetHeight;
      let targetTop = ayVisible, targetBottom = byVisible;
      if (inlineInput) {
        const style = anchorNode.ownerDocument.defaultView.getComputedStyle(anchorNode);
        const mobile = width <= 720;
        const fontSize = Math.max(mobile ? 16 : 13, parseFloat(style.fontSize) * sy);
        const intrinsicLine = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        const lineHeight = Math.max(fontSize * .8, intrinsicLine * sy);
        const inputWidth = clamp(bxVisible - axVisible, Math.min(100,right - left),right - left);
        Object.assign(inlineInput.style,{
          width:inputWidth+'px', fontFamily:style.fontFamily.replace(/\bInstrument\b/g,'CeDirectInstrument'), fontStyle:style.fontStyle,
          fontWeight:style.fontWeight, fontSize:fontSize+'px', lineHeight:lineHeight+'px',
          letterSpacing:((parseFloat(style.letterSpacing) || 0)*sx)+'px', wordSpacing:((parseFloat(style.wordSpacing) || 0)*sx)+'px',
          textAlign:style.textAlign, textTransform:style.textTransform, direction:style.direction,
          paddingInlineStart:Math.max(0,parseFloat(style.paddingInlineStart)*sx)+'px',
          paddingInlineEnd:Math.max(0,parseFloat(style.paddingInlineEnd)*sx)+'px',
        });
        // A solid editing surface keeps the caret and selection legible over
        // both photographs and flat backgrounds without altering the source node.
        inlineInput.style.height = '1px';
        const maxHeight = Math.max(24,Math.min((bottom - top) * .65,bottom - top - panelHeight - 6));
        const inputHeight = clamp(Math.max(inlineInput.scrollHeight,rect.height*sy),Math.min(33,maxHeight),maxHeight);
        let y = clamp(ayVisible,top,bottom-inputHeight);
        if (y - top < panelHeight + 6 && bottom - y - inputHeight < panelHeight + 6) {
          y = ayVisible - top > bottom - byVisible ? top + panelHeight + 6 : bottom - panelHeight - 6 - inputHeight;
        }
        inlineInput.style.left = clamp(axVisible,left,right-inputWidth) + 'px';
        inlineInput.style.top = y + 'px'; inlineInput.style.height = inputHeight + 'px';
        targetTop = y;
        targetBottom = y + inputHeight;
      }
      const below = bottom - targetBottom - 6, above = targetTop - top - 6;
      let y;
      if (standaloneText && above >= panelHeight) y = targetTop - panelHeight - 6;
      else if (below >= panelHeight) y = targetBottom + 6;
      else if (above >= panelHeight) y = targetTop - panelHeight - 6;
      else y = clamp(standaloneText ? targetBottom + 6 : targetTop + 8,top,bottom-panelHeight);
      panel.style.left = clamp(axVisible,left,right-panelWidth) + 'px';
      panel.style.top = clamp(y,top,bottom-panelHeight) + 'px';
    }
    function schedule() {if (session === s && !s.tick) s.tick = view.requestAnimationFrame(layout);}
    s.resize = new ResizeObserver(schedule);
    s.resize.observe(model.frame); s.resize.observe(panel);
    s.observer = new MutationObserver(schedule);
    s.observer.observe(model.frame.contentDocument.body,{subtree:true,childList:true,characterData:true});
    const scroll = {capture:true,passive:true,signal:s.listeners.signal};
    doc.addEventListener('scroll',schedule,scroll);
    model.frame.contentDocument.addEventListener('scroll',schedule,scroll);
    view.addEventListener('resize',schedule,options);
    view.visualViewport?.addEventListener('resize',schedule,options);
    view.visualViewport?.addEventListener('scroll',schedule,options);
    doc.fonts?.ready.then(schedule);
    root.addEventListener('keydown',event=>{
      if (event.key === 'Escape' && !event.isComposing && !s.composing) {event.preventDefault();event.stopPropagation();close({cancel:true,restoreFocus:true});}
    },options);
    doc.addEventListener('pointerdown',event=>{
      if (!root.contains(event.target)) close({restoreFocus:false});
    },{...options,capture:true});
    layout();
    firstControl.focus({preventScroll:true});
    if (inlineInput) {
      const length = (inlineInput.value ?? inlineInput.textContent).length;
      const offset = Number.isInteger(model.caretOffset) ? Math.max(0,Math.min(model.caretOffset,length)) : length;
      restoreCaret(inlineInput,offset);
    } else if (firstControl.matches('input,textarea')) firstControl.select();
    return true;
  }
  return {open, close, canClose, destroy:()=>close({force:true})};
}
