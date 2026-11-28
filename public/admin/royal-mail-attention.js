// Admin's delivery issues are backed by recorded parcel, handover and carrier evidence.
(() => {
  'use strict';
  const kinds = {all:'All issues', booking:'Booking needs review', collection:'Collection cutoff passed',
    no_scan:'No first scan', exception:'Carrier exception'};
  const date = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'});
  function mount(host,{load,open}) {
    const {el} = window.SC;
    let controller, cursor = null, disposed = false, busy = false;
    const keys = new Set();
    const filter = el('select',{'aria-label':'Filter delivery issues'},...Object.entries(kinds).map(([value,label]) => el('option',{value},label)));
    const reload = el('button',{type:'button',class:'btn soft sm'},'Refresh');
    const feedback = el('p',{class:'hint',role:'status'});
    const setup = el('p',{class:'hint',hidden:true});
    const list = el('ul',{class:'rm-issues-list','aria-label':'Delivery issues'});
    const more = el('button',{type:'button',class:'btn soft sm',hidden:true},'Show more');
    host.replaceChildren(el('section',{class:'group glass w-rm-card rm-delivery-issues'},el('div',{class:'w-rm-card-head'},el('h2',{},'Delivery issues'),reload),
      el('div',{class:'rm-issues-filter'},filter),setup,feedback,list,more));
    function row(entry) {
      const key = entry.id + ':' + (entry.box || 0);
      const attrs = {'data-issue-key':key,class:'btn soft sm'};
      const href = entry.trackingUrl;
      let action;
      if (['no_scan','exception'].includes(entry.kind) && typeof href==='string' && /^https:\/\/www\.royalmail\.com\/track-your-item#\/tracking-results\/[A-Z0-9]{5,35}$/.test(href)) {
        action = el('a',{...attrs,href,target:'_blank',rel:'noopener noreferrer'},'Track parcel');
      } else {
        action = el('button',{...attrs,type:'button',onclick:async () => {
          if (action.disabled) return;
          action.disabled = true;
          try { await open(entry); }
          catch { if (!disposed) feedback.textContent = 'Could not open this delivery. Refresh and try again.'; }
          finally { action.disabled=false; }
        }},entry.actionLabel);
      }
      return el('li',{},el('div',{},el('strong',{},entry.business),el('small',{class:'hint rm-issue-ref'},entry.id + (entry.box ? ' · Box ' + entry.box : ''))),
        el('p',{class:'rm-issue-kind'},kinds[entry.kind]),el('p',{},entry.evidence),
        el('small',{class:'hint'},(entry.kind==='collection' ? 'Label downloaded ' : entry.kind==='no_scan' ? 'Handed over ' : entry.kind==='booking' ? 'Postage request ' : '') + date.format(entry.at) + ' (UK)'),
        ...(entry.checkedAt ? [el('small',{class:'hint'},(entry.kind==='booking' ? 'Booking checked ' : 'Tracking checked ') + date.format(entry.checkedAt) + ' (UK)')] : []),
        action);
    }
    async function read(append=false) {
      controller?.abort();
      const request = controller = new AbortController();
      if (!append) { cursor=null; keys.clear(); list.replaceChildren(); setup.hidden=true; }
      more.hidden=true; more.disabled=true;
      busy=true; list.setAttribute('aria-busy','true'); feedback.textContent='Checking delivery issues…';
      const p = new URLSearchParams({kind:filter.value,limit:'40'});
      if (append && cursor) p.set('cursor',cursor);
      try {
        const page = await load(p,request.signal);
        if (disposed || request!==controller) return;
        const notes = [];
        if (!page.trackingEnabled) notes.push('Carrier scan alerts require a connected Tracking API.');
        if (!page.cutoff) notes.push('Confirm the collection cutoff in Setup checks to see missed collections.');
        setup.textContent=notes.join(' '); setup.hidden=!notes.length;
        for (const item of page.orders) {
          const key=item.id + ':' + (item.box || 0);
          if (!keys.has(key)) { list.append(row(item)); keys.add(key); }
        }
        cursor=page.nextCursor;
        feedback.textContent=keys.size ? keys.size + (keys.size===1 ? ' delivery issue' : ' delivery issues') + (cursor ? ' shown.' : '.') : 'No delivery issues match this view.';
        more.hidden=!cursor;
      } catch {
        if (disposed || request!==controller) return;
        feedback.textContent='Could not load delivery issues. Try again.';
        more.hidden=!append || !cursor;
      } finally {
        if (!disposed && request===controller) { busy=false; more.disabled=false; list.setAttribute('aria-busy','false'); }
      }
    }
    reload.onclick=()=>read();
    filter.onchange=()=>read();
    more.onclick=()=>{ if (!busy && cursor) return read(true); };
    void read();
    return { refresh:()=>read(), destroy(){ disposed=true; controller?.abort(); } };
  }
  window.SCRoyalMailAttention=Object.freeze({mount});
})();
