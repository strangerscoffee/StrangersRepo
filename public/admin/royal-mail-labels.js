// Admin's generated-label history. Only the selected label is fetched from Click & Drop.
(() => {
  'use strict';

  const source = new URL(document.currentScript.src, location.href);
  const statuses = {ready:'Ready to print', downloaded:'Downloaded', dispatched:'Dispatched'};
  const ukDate = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London', day:'numeric', month:'long', year:'numeric'});
  const ukTime = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London', hour:'2-digit', minute:'2-digit'});
  const iconPaths = {
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    file:'<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h5"/>',
    right:'<path d="m9 5 7 7-7 7"/>', down:'<path d="m6 9 6 6 6-6"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 6v6l4 2"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    print:'<path d="M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7zM16 11h1"/>',
    download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
  };
  function icon(name) {
    const image = window.SC.svgi(iconPaths[name]);
    image.classList.add('lp-ico');
    image.setAttribute('fill','none');
    image.setAttribute('stroke','currentColor');
    image.setAttribute('stroke-width','1.7');
    image.setAttribute('stroke-linecap','round');
    image.setAttribute('stroke-linejoin','round');
    return image;
  }

  function validLabelId(row) {
    if (!row || typeof row.id !== 'string') return false;
    if (row.boxNumber == null) return /^WS-[A-F0-9]{32}$/i.test(row.id) && row.parentId == null;
    return /^WS-[A-F0-9]{32}$/.test(row.parentId) && Number.isInteger(row.boxNumber) && row.boxNumber >= 1 &&
      Number.isInteger(row.boxCount) && row.boxNumber <= row.boxCount && row.boxCount <= 50 &&
      row.id === row.parentId + '-B' + row.boxNumber;
  }
  function boxCaption(row) {
    return row.boxNumber ? 'Box ' + row.boxNumber + ' of ' + row.boxCount : '';
  }

  async function labelFile(row, preview, signal) {
    const path = '/api/admin/wholesale/orders/' + encodeURIComponent(row.parentId || row.id) + '/shipping/' +
      (row.boxNumber ? 'boxes/' + row.boxNumber + '/' : '') + 'label';
    const response = await fetch(path + (preview ? '?preview=1' : ''), {signal, cache:'no-store', credentials:'same-origin'});
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      const error = new Error(problem.message || 'The label could not be retrieved from Royal Mail.');
      error.status = response.status;
      throw error;
    }
    const pdf = await response.blob();
    if (pdf.type.split(';')[0] !== 'application/pdf' || !pdf.size || pdf.size > 10 * 1024 * 1024 || await pdf.slice(0,5).text() !== '%PDF-') {
      throw new Error('Royal Mail did not return a valid PDF label.');
    }
    return pdf;
  }

  async function openPdf(blob, signal) {
    const [library, bytes] = await Promise.all([import(new URL('label-pdfjs.js', source).href), blob.arrayBuffer()]);
    signal.throwIfAborted();
    library.GlobalWorkerOptions.workerSrc = new URL('label-pdf-worker.js', source).href;
    const task = library.getDocument({
      data:new Uint8Array(bytes), wasmUrl:new URL('.', source).href, useWasm:false, useWorkerFetch:true,
      useSystemFonts:true, isEvalSupported:false, enableXfa:false, stopAtErrors:true
    });
    const discard = () => { void task.destroy().catch(() => {}); };
    signal.addEventListener('abort', discard, {once:true});
    return task.promise;
  }

  async function paintPage(page, scale, signal) {
    signal.throwIfAborted();
    const viewport = page.getViewport({scale});
    if (![viewport.width,viewport.height].every(n => Number.isFinite(n) && n >= 1 && n <= 8192) ||
        viewport.width * viewport.height > 12e6) throw new Error('Open the original PDF to view this page at full size.');
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d', {alpha:false});
    if (!ctx) throw new Error('The preview is unavailable in this browser.');
    const render = page.render({canvasContext:ctx, canvas, viewport, background:'#ffffff'});
    const cancel = () => render.cancel();
    signal.addEventListener('abort', cancel, {once:true});
    try { await render.promise; } finally { signal.removeEventListener('abort', cancel); }
    signal.throwIfAborted();
    return canvas;
  }

  // Print the complete released PDF in its own print document. Large/unusual documents
  // retain the original download and native PDF-viewer fallback, never a partial label.
  async function printPages(blob, signal) {
    const lifetime = new AbortController();
    const stop = () => lifetime.abort();
    signal.addEventListener('abort', stop, {once:true});
    let frame;
    try {
      signal.throwIfAborted();
      const pdf = await openPdf(blob, lifetime.signal);
      if (pdf.numPages > 16) throw new Error('Open the original PDF to print the full document.');
      frame = document.createElement('iframe');
      frame.setAttribute('title','Print Royal Mail label');
      frame.setAttribute('aria-hidden','true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
      document.body.append(frame);
      const doc = frame.contentDocument;
      doc.title = 'Royal Mail label';
      const style = doc.createElement('style');
      style.textContent = 'html,body{margin:0;padding:0}canvas{display:block;break-inside:avoid}canvas:not(:last-child){break-after:page}';
      doc.head.append(style);
      let pixels = 0;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const {width,height} = page.getViewport({scale:1});
        pixels += width * height * (300 / 72) ** 2;
        if (pixels > 26e6) throw new Error('Open the original PDF to print all of its pages.');
        const canvas = await paintPage(page, 300 / 72, lifetime.signal);
        const size = width + 'pt ' + height + 'pt';
        style.sheet.insertRule('@page label' + n + ' {size:' + size + ';margin:0}');
        if (n === 1) style.sheet.insertRule('@page {size:' + size + ';margin:0}');
        canvas.style.cssText = 'width:' + width + 'pt;height:' + height + 'pt;page:label' + n;
        doc.body.append(canvas);
        page.cleanup();
      }
      signal.throwIfAborted();
      const printed = frame;
      const tidy = () => { clearTimeout(timeout); printed.remove(); };
      const timeout = setTimeout(tidy, 5 * 60 * 1000);
      printed.contentWindow.addEventListener('afterprint', tidy, {once:true});
      signal.addEventListener('abort', tidy, {once:true});
      printed.contentWindow.focus();
      printed.contentWindow.print();
      frame = null;
    } finally {
      frame?.remove();
      stop();
      signal.removeEventListener('abort',stop);
    }
  }

  function outstandingRequests(el,load,onOpen) {
    const stages = {unconfirmed:'Postage unconfirmed', preparing:'Preparing request',
      awaiting_label:'Awaiting label', needs_attention:'Needs attention'};
    let controller, cursor, term = '', loading = false, ids = new Set(), opening = false;
    const title = el('span',{});
    const summary = el('summary',{},icon('clock'),title,icon('down'));
    const list = el('ul',{class:'lp-request-rows','aria-label':'Outstanding postage requests'});
    const feedback = el('p',{class:'lp-request-feedback',role:'status',hidden:true});
    const more = el('button',{type:'button',class:'btn soft sm',hidden:true,onclick:()=>loadPage(!!cursor)},'Show more requests');
    const details = el('details',{class:'lp-outstanding',hidden:true},summary,list,feedback,more);
    function tell(text) { feedback.textContent=text; feedback.hidden=!text; }
    function reset() {
      controller?.abort();controller=null;loading=false;cursor=null;ids.clear();
      more.hidden=true;list.replaceChildren();tell('');
    }
    async function open(row,button) {
      if (opening) return;
      opening=true;button.setAttribute('aria-busy','true');
      try { await onOpen(row,button); }
      catch(error) { if (button.isConnected) tell(error.message || 'Could not open this shipment.'); }
      finally { opening=false;button.removeAttribute('aria-busy'); }
    }
    async function loadPage(append) {
      if (loading || details.hidden || !details.open) return;
      const work=new AbortController();controller=work;loading=true;more.disabled=true;tell('Loading requests…');
      const params=new URLSearchParams({view:'requests',limit:'8'});
      if(term)params.set('search',term);
      if(append)params.set('cursor',cursor);
      try{
        const result=await load(params,work.signal);
        if(work.signal.aborted || !details.isConnected)return;
        if(!Array.isArray(result?.requests) || !Number.isSafeInteger(result.total) || result.total<0 ||
           result.requests.some(row=>!validLabelId(row) || !Number.isSafeInteger(row.version) || !Object.hasOwn(stages,row.status)) ||
           (result.nextCursor!=null && (typeof result.nextCursor!=='string' || !result.requests.length || result.nextCursor===params.get('cursor')))){
          throw new Error('The outstanding requests could not be read.');
        }
        title.textContent='Outstanding postage requests ('+result.total+')';
        let first;
        for(const row of result.requests){
          if(ids.has(row.id))continue;
          ids.add(row.id);
          const customer=row.business || 'Wholesale order';
          const requested=row.requestedAt>0 ? ukDate.format(row.requestedAt)+' at '+ukTime.format(row.requestedAt)+' (UK)' : '';
          const button=el('button',{type:'button',class:'lp-request-row','data-request-id':row.id,
            'aria-label':['Open shipping for '+customer,boxCaption(row),row.id].filter(Boolean).join(', '),onclick:e=>open(row,e.currentTarget)},
            el('span',{class:'lp-row-text'},el('b',{},customer),el('span',{},[row.reference || row.parentId || row.id,boxCaption(row)].filter(Boolean).join(' · ')),
              requested ? el('time',{datetime:new Date(row.requestedAt).toISOString()},'Requested '+requested) : null),
            el('span',{class:'lp-status review'},stages[row.status]),icon('right'));
          first ||= button;
          list.append(el('li',{},button));
        }
        if(append && first && document.activeElement===more)first.focus({preventScroll:true});
        cursor=result.nextCursor;more.hidden=!cursor;more.textContent='Show more requests';
        tell(ids.size ? '' : 'No outstanding requests.');
      }catch(error){
        if(work.signal.aborted || !details.isConnected)return;
        tell(error.message || 'Could not load outstanding requests.');
        more.textContent='Try again';more.hidden=false;
      }finally{
        if(controller===work){loading=false;more.disabled=false;}
      }
    }
    details.addEventListener('toggle',()=>{
      if(details.open && !details.hidden && !ids.size)loadPage(false);
      else if(!details.open)reset();
    });
    return {details, clear(){reset();details.hidden=true;}, show(count,search,expand){
      reset();term=search;details.hidden=!(count>0);
      if(details.hidden)return;
      title.textContent='Outstanding postage requests ('+count+')';
      if(expand)details.open=true;
      if(details.open)loadPage(false);
    }};
  }

  function mount(host, {load,onOpenShipping,initialState = {}}) {
    const {el} = window.SC;
    const small = matchMedia('(max-width:819px)');
    let active = true, next = null, items = [], count = 0, timer, listing, viewing, selected = initialState?.selected || null;
    let current = null, opener = null, fetchGeneration = 0;
    const region = el('section', {class:'lp','aria-label':'Generated shipping labels'});
    const search = el('input',{type:'search','aria-label':'Search customer, order or tracking number',placeholder:'Search customer, order or tracking',maxlength:100});
    const status = el('select',{'aria-label':'Filter labels by status'},
      ...Object.entries({all:'All statuses', ...statuses, ready:'Not downloaded'}).map(([id,name]) => el('option',{value:id},name)));
    search.value = initialState?.search || '';
    status.value = Object.hasOwn(statuses,initialState?.status) ? initialState.status : 'all';
    const list = el('div',{class:'lp-rows'});
    const total = el('span',{id:'lpCount'});
    const message = el('p',{class:'lp-message',role:'status',hidden:true});
    const retry = el('button',{type:'button',class:'btn soft lp-retry',hidden:true,onclick:()=>request(false)},'Try again');
    const more = el('button',{type:'button',class:'btn soft lp-more',hidden:true,onclick:()=>request(true)},'Show more labels');
    const outstanding=outstandingRequests(el,load,onOpenShipping);
    const desktop = el('aside',{class:'lp-card lp-preview','aria-label':'Selected label'});
    const sheet = el('dialog',{class:'lp-sheet','aria-label':'Label preview'});
    const heading = el('div',{class:'lp-list-head'},
      el('div',{class:'lp-title-line'},el('h2',{},'Generated labels'),total),
      el('label',{class:'lp-search'},icon('search'),search),
      el('div',{class:'lp-filter-row'},el('label',{class:'lp-filter'},'Status',status,icon('down')),
        el('span',{class:'lp-sort'},icon('clock'),'Newest first')));
    region.append(el('div',{class:'lp-layout'},el('section',{class:'lp-card lp-list'},heading,outstanding.details,list,message,retry,more),desktop));
    host.replaceChildren(region);
    document.body.append(sheet);

    const live = () => active && host.isConnected;
    const state = () => ({search:search.value,status:status.value,selected});
    function badge(row) {
      const unavailable = row.status==='ready' && !row.canPreview;
      const tone = row.needsReview ? 'review' : unavailable ? 'unavailable' : row.status;
      return el('span',{class:'lp-status '+tone},el('i',{}),row.needsReview ? 'Needs review' : unavailable ? 'Not downloaded' : statuses[row.status]);
    }
    function info(text) { return el('p',{class:'lp-pdf-status',role:'status'},text); }
    function notice(text) {message.textContent=text;message.hidden=!text;}
    function clearPreview() {
      viewing?.abort(); viewing = null; current = null;
      desktop.replaceChildren(); sheet.replaceChildren();
    }

    function renderRows() {
      const rows = [];
      let lastDay;
      for (const row of items) {
        const day = row.createdAt ? ukDate.format(row.createdAt) : 'Date unavailable';
        if (lastDay !== day) { rows.push(el('h3',{class:'lp-day'},day)); lastDay=day; }
        const customer = row.business || 'Wholesale order';
        const btn = el('button',{type:'button',class:'lp-row','data-preview':row.id,'aria-label':['Preview label for '+customer,boxCaption(row),row.id].filter(Boolean).join(', '),
          'aria-current':row.id===selected?'true':null,onclick:e=>choose(row,e.currentTarget)},
          el('span',{class:'lp-file'},icon('file')),
          el('span',{class:'lp-row-text'},el('b',{},customer),el('span',{},[row.reference || row.parentId || row.id,boxCaption(row),row.serviceCode].filter(Boolean).join(' · '))),
          el('span',{class:'lp-row-extra'},badge(row),row.createdAt ? el('time',{datetime:new Date(row.createdAt).toISOString(),title:row.dateSource==='order'?'Order time':'Booking time'},ukTime.format(row.createdAt)) : null),
          el('span',{class:'lp-chevron'},icon('right')));
        rows.push(btn);
      }
      list.replaceChildren(...rows);
      total.textContent = count + (count===1?' label':' labels');
    }
    function rowButton(id) {
      return Array.from(list.querySelectorAll('.lp-row')).find(button=>button.dataset.preview===id);
    }
    function recordRelease(row) {
      if(row.status!=='ready')return;
      row.status='downloaded';
      const index=items.findIndex(item=>item.id===row.id);
      if(index===-1)return;
      items[index].status='downloaded';
      if(status.value!=='ready') {
        rowButton(row.id)?.querySelector('.lp-status')?.replaceWith(badge(row));
        return;
      }
      // The selected document can remain open for the native print dialog or a
      // reprint. Remove it from the work list immediately without making a carrier call.
      items.splice(index,1);count=Math.max(0,count-1);renderRows();
      opener=rowButton(items[index]?.id || items[index-1]?.id) || (next ? more : search);
      if(!items.length)notice(next?'Show more labels to continue.':'No labels are ready to print.');
    }
    function choose(row, button) {
      selected=row.id;opener=button;
      list.querySelectorAll('[aria-current]').forEach(b=>b.removeAttribute('aria-current'));
      button.setAttribute('aria-current','true');
      if (small.matches && !sheet.open) {
        show(row);
        sheet.showModal();
        sheet.querySelector('.lp-x')?.focus({preventScroll:true});
      } else if (current?.id !== row.id) show(row);
    }
    function show(row) {
      clearPreview();
      if (!row || (small.matches && !sheet.open && !opener)) return;
      const dest = small.matches ? sheet : desktop;
      const controller = new AbortController();
      viewing=controller;
      const signal=controller.signal;
      const valid=()=>live() && !signal.aborted && selected===row.id;
      const stage = el('div',{class:'lp-stage'});
      const actions = el('footer',{class:'lp-preview-actions'});
      const actionStatus = el('p',{class:'lp-action-status',role:'status',hidden:true});
      const pages = el('div',{class:'lp-pages',hidden:true});
      const metadata = el('div',{class:'lp-preview-meta'},el('div',{},el('span',{},'Tracking number'),el('strong',{},row.trackingNumber||'Unavailable')));
      const title = el('header',{class:'lp-detail-head'},
        el('div',{class:'lp-detail-eyebrow'},icon('file'),'Label preview'),
        el('div',{class:'lp-title-line'},el('h3',{},row.business || 'Wholesale order'),badge(row)),
        el('p',{},[boxCaption(row),row.id,row.serviceCode,row.weightGrams ? Number((row.weightGrams/1000).toFixed(3))+' kg':null].filter(Boolean).join(' · ')),
        row.dateSource==='order' && row.createdAt ? el('p',{},'Order date '+ukDate.format(row.createdAt)) : null,
        small.matches?el('button',{type:'button',class:'lp-x','aria-label':'Close label preview',onclick:()=>sheet.close()},icon('close')):null);
      dest.replaceChildren(title,stage,pages,metadata,actions,actionStatus);
      current=row;
      if (!row.canPreview || row.needsReview) {
        stage.append(info(row.needsReview?'This label needs review in the order’s Royal Mail shipping details.':'Connect Click & Drop in Shipping settings to access this label.'));
        actions.hidden=true;
        return;
      }
      let pdf = null, pageNo = 1, pageRequest = 0, busy = false;
      const print = el('button',{type:'button',class:'lp-btn primary',onclick:()=>release(true)},icon('print'),'Print label');
      const download = el('button',{type:'button',class:'lp-btn soft',onclick:()=>release(false)},icon('download'),'Download PDF');
      actions.append(print,download);
      function original(blob,caption) {
        const url = URL.createObjectURL(blob);
        signal.addEventListener('abort',()=>URL.revokeObjectURL(url),{once:true});
        return el('a',{class:'lp-view-pdf',href:url,target:'_blank',rel:'noopener noreferrer'},caption);
      }
      function explanation(error) {
        if (error.status===401 || error.status===403 || error.status===409 || error.status===404) {
          signal.throwIfAborted();
          clearPreview();
          notice(error.message);
          retry.hidden=false;
          if (sheet.open) sheet.close();
          if (error.status===401 || error.status===403) {items=[];count=0;next=null;selected=null;more.hidden=true;renderRows();}
          return true;
        }
        return false;
      }
      async function release(forPrint) {
        if (busy || !valid()) return;
        busy=true;print.disabled=download.disabled=true;
        actionStatus.hidden=false;actionStatus.textContent=forPrint?'Preparing the label for printing…':'Downloading label…';
        try {
          const blob = await labelFile(row,false,signal);
          if (!valid()) return;
          recordRelease(row);
          title.querySelector('.lp-status').replaceWith(badge(row));
          if (forPrint) {
            try {
              await printPages(blob,signal);
            } catch (error) {
              if (valid()) actionStatus.replaceChildren('Use the PDF viewer to print this label. ',original(blob,'Open printable PDF'));
              return;
            }
          } else {
            const url=URL.createObjectURL(blob);
            const link=el('a',{href:url,download:'Royal-Mail-'+row.id+'.pdf'});
            link.click();
            setTimeout(()=>URL.revokeObjectURL(url),10000);
          }
          if(valid() && forPrint) actionStatus.replaceChildren('Print dialog requested. ',original(blob,'Open printable PDF'));
          else if(valid()) actionStatus.textContent='Label downloaded.';
        } catch(error) {
          if (valid() && !explanation(error)) actionStatus.textContent=error.message || 'Could not retrieve the original label.';
        } finally {
          if(valid()){busy=false;print.disabled=download.disabled=false;}
        }
      }
      const paper = el('div',{class:'lp-paper'});
      const sizeText = el('strong',{});
      const viewSize = el('div',{},el('span',{},'Label size'),sizeText);
      const previous=el('button',{type:'button',class:'lp-page-step',onclick:()=>renderPage(pageNo-1)},'Previous page');
      const nextPage=el('button',{type:'button',class:'lp-page-step',onclick:()=>renderPage(pageNo+1)},'Next page');
      const position=el('span',{role:'status'});
      pages.append(previous,position,nextPage);
      let nativeLink;
      async function renderPage(number) {
        if (!pdf || number<1 || number>pdf.numPages || !valid()) return;
        const ticket=++pageRequest;pageNo=number;
        position.textContent='Page '+number+' of '+pdf.numPages;
        previous.disabled=number===1;nextPage.disabled=number===pdf.numPages;pages.hidden=pdf.numPages===1;
        stage.replaceChildren(info('Loading label preview…'));
        try {
          const page=await pdf.getPage(number);
          const view=page.getViewport({scale:1});
          const canvas=await paintPage(page,Math.min(2.5,1000/Math.max(view.width,view.height)),signal);
          if (!valid() || ticket!==pageRequest) return;
          canvas.setAttribute('role','img');canvas.setAttribute('aria-label',['Shipping label for '+(row.business||row.id),boxCaption(row),'page '+number+' of '+pdf.numPages].filter(Boolean).join(', '));
          sizeText.textContent=Number((view.width/72).toFixed(2))+' × '+Number((view.height/72).toFixed(2))+' in';
          if(!viewSize.isConnected)metadata.append(viewSize);
          paper.replaceChildren(canvas);stage.replaceChildren(paper);
        } catch(error) {
          if (valid() && ticket===pageRequest) stage.replaceChildren(info('Your browser could not display this page.'),nativeLink);
        }
      }
      async function preview() {
        stage.replaceChildren(info('Loading label preview…'));
        try {
          const blob = await labelFile(row,true,signal);
          if (!valid()) return;
          nativeLink = original(blob,'Open original PDF');
          try {
            pdf=await openPdf(blob,signal);
            if(valid()) await renderPage(1);
          } catch(error) {
            if(valid()) stage.replaceChildren(info('Your browser could not display this label.'),nativeLink);
          }
        } catch(error) {
          if (valid() && !explanation(error)) stage.replaceChildren(info(error.message || 'Label preview unavailable.'),
            el('button',{type:'button',class:'btn soft',onclick:()=>show(row)},'Retry preview'));
        }
      }
      preview();
    }

    async function request(append) {
      if(!live() || (append && (!next || listing))) return;
      clearTimeout(timer);listing?.abort();
      const controller=new AbortController();
      const ticket=++fetchGeneration;listing=controller;
      const oldLength=items.length;
      const advanceFocus=append && document.activeElement===more;
      const restoreRow=!append && list.contains(document.activeElement) ? document.activeElement.closest('.lp-row')?.dataset.preview : null;
      if(!append) {
        outstanding.clear();
        clearPreview();opener=null;if(sheet.open)sheet.close();
        items=[];count=0;next=null;renderRows();more.hidden=true;
      }
      retry.hidden=true;more.disabled=true;notice(append?'Loading more labels…':'Loading labels…');
      const params=new URLSearchParams({status:status.value,limit:'40'});
      if(search.value.trim())params.set('search',search.value.trim());
      if(append)params.set('cursor',next);
      try{
        const result=await load(params,controller.signal);
        if(!live() || ticket!==fetchGeneration)return;
        if(!Array.isArray(result?.labels) || !Number.isSafeInteger(result.total) || result.total<0 ||
            result.labels.some(row=>!validLabelId(row) || !Object.hasOwn(statuses,row.status)) ||
            (result.nextCursor!=null && (typeof result.nextCursor!=='string' || !result.labels.length || result.nextCursor===params.get('cursor')))) {
          throw new Error('The label list could not be read. Try again.');
        }
        items=[...new Map([...(append?items:[]),...result.labels].map(row=>[row.id,row])).values()];
        count=result.total;next=result.nextCursor;
        if(!append && status.value==='all')outstanding.show(result.outstandingCount,search.value.trim(),!count);
        const row=items.find(r=>r.id===selected)||items[0];
        selected=row?.id || null;
        renderRows();
        notice(items.length ? '' : result.outstandingCount>0 ? 'Confirmed labels will appear here when they are ready to print.' :
          search.value.trim() || status.value!=='all' ? 'No labels match your search or status.' : 'No generated Royal Mail labels yet.');
        if(!small.matches && row && (!append || current?.id!==row.id))show(row);
        if(!row)desktop.replaceChildren(info('Select a generated label to preview it.'));
        if(advanceFocus)list.querySelectorAll('.lp-row')[oldLength]?.focus({preventScroll:true});
        if(restoreRow && document.activeElement===document.body)(rowButton(restoreRow) || search).focus({preventScroll:true});
      }catch(error){
        if(!live() || ticket!==fetchGeneration)return;
        clearPreview();items=[];next=null;count=0;selected=null;renderRows();notice(error.message||'Could not load labels.');retry.hidden=false;
      }finally{
        if(ticket===fetchGeneration){listing=null;more.disabled=false;more.hidden=!next;}
      }
    }
    search.addEventListener('input',()=>{
      outstanding.clear();
      clearTimeout(timer);++fetchGeneration;listing?.abort();listing=null;
      clearPreview();items=[];count=0;next=null;renderRows();more.hidden=retry.hidden=true;notice('Searching labels…');
      timer=setTimeout(()=>request(false),220);
    });
    status.addEventListener('change',()=>request(false));
    sheet.addEventListener('close',()=>{
      if(!small.matches || !live())return;
      clearPreview();
      if(opener)(opener.isConnected ? opener : rowButton(selected) || search).focus({preventScroll:true});
      opener=null;
    });
    function resized(){
      if(!live())return;
      opener=null;
      if(sheet.open)sheet.close();
      const row=items.find(r=>r.id===selected);
      if(!small.matches && row)show(row);else clearPreview();
    }
    function suspend(){
      outstanding.clear();
      ++fetchGeneration;listing?.abort();listing=null;clearTimeout(timer);clearPreview();
      items=[];next=null;count=0;selected=null;opener=null;
      if(sheet.open)sheet.close();
      renderRows();more.hidden=retry.hidden=true;notice('');
    }
    const restored=e=>{if(e.persisted && live())request(false);};
    small.addEventListener('change',resized);
    window.addEventListener('pagehide',suspend);
    window.addEventListener('pageshow',restored);
    window.addEventListener('sc:session-invalid',suspend);
    request(false);
    return {get state(){return state();}, refresh:()=>request(false), destroy(){
      active=false;suspend();
      small.removeEventListener('change',resized);
      window.removeEventListener('pagehide',suspend);window.removeEventListener('pageshow',restored);
      window.removeEventListener('sc:session-invalid',suspend);
      sheet.remove();region.remove();
    }};
  }
  window.SCRoyalMailLabels=Object.freeze({mount});
})();
