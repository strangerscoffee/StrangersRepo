// Staff and Admin supply their own authenticated loader and order actions.
(() => {
  'use strict';
  const stages = new Map([
    ['all', 'All parcels'], ['weigh', 'Weigh'], ['print', 'Print label'],
    ['handover', 'Awaiting handover'], ['checking', 'Checking with Royal Mail'], ['attention', 'Needs attention'],
  ]);
  const empty = {
    all: 'No parcels are waiting for dispatch.', weigh: 'No parcels are waiting to be weighed.',
    print: 'No labels are waiting to be printed.', handover: 'No parcels are waiting for handover.',
    checking: 'No bookings are waiting for confirmation.', attention: 'No parcels need attention.',
  };
  const dates = new Intl.DateTimeFormat('en-GB', {weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});

  function mount(host, { load, onAction, initialStage = 'all' }) {
    const { el } = window.SC;
    let stage = stages.has(initialStage) ? initialStage : 'all';
    let generation = 0, active = true, loading = false, opening = false;
    let cursor = null, recoveryTimer, counts = null, rows = [];

    const region = el('section', {class:'dq', 'aria-label':'Dispatch queue'});
    const heading = el('h2', {}, 'Dispatch queue');
    const reload = el('button', {class:'btn soft dq-refresh',type:'button',onclick:() => { if (!loading) request(); }}, 'Refresh');
    const group = el('div', {class:'dq-stages',role:'group','aria-label':'Filter parcels by stage'});
    const select = el('select', {'aria-label':'Filter parcels by stage',onchange:() => selectStage(select.value)});
    const compact = el('label', {class:'dq-compact'}, el('span', {}, 'Stage'), select);
    const list = el('ul', {class:'dq-list','aria-label':'Parcels'});
    const message = el('p', {class:'dq-message',role:'status'});
    const more = el('button', {type:'button',class:'btn soft dq-more',onclick:() => request(true)}, 'Show more parcels');
    const stageButtons = new Map();
    for (const [key, label] of stages) {
      const badge = el('span', {class:'dq-count','aria-hidden':'true'});
      const button = el('button', {type:'button','data-queue-stage':key,onclick:() => selectStage(key)}, label, badge);
      const option = el('option', {value:key}, label);
      group.append(button);
      select.append(option);
      stageButtons.set(key, {button,badge,option});
    }
    region.append(el('header', {class:'dq-head'}, heading, reload), group, compact, list, message, more);
    host.replaceChildren(region);

    function filters() {
      const total = counts && [...stages.keys()].reduce((n,key) => key === 'all' ? n : n + counts[key], 0);
      for (const [key, {button,badge,option}] of stageButtons) {
        const count = key === 'all' ? total : counts?.[key];
        const label = stages.get(key);
        badge.hidden = count == null;
        badge.textContent = count == null ? '' : String(count);
        button.setAttribute('aria-pressed', String(key === stage));
        const accessible = count == null ? label : label + ' (' + count + ')';
        button.setAttribute('aria-label', accessible);
        option.textContent = accessible;
      }
      select.value = stage;
    }

    function selectStage(key) {
      if (stage === key || !stages.has(key)) return;
      stage = key;
      rows = [];
      cursor = null;
      list.replaceChildren();
      filters();
      request();
    }

    function scheduleRecoveryCheck() {
      clearTimeout(recoveryTimer);
      if (!active || !counts?.checking || rows.length > 40 || !host.isConnected) return;
      recoveryTimer = setTimeout(() => {
        if (!active || !host.isConnected) return;
        if (!loading && !opening && !document.hidden && region.getClientRects().length && !document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')) {
          request(false, true);
        } else {
          scheduleRecoveryCheck();
        }
      }, 60000);
    }

    async function openRow(row, button) {
      if (opening || loading || !active) return;
      opening = true;
      button.setAttribute('aria-busy', 'true');
      try {
        await onAction(row);
      } catch (error) {
        if (active) showMessage(error?.message || 'Could not open this parcel.', true);
      } finally {
        opening = false;
        button.removeAttribute('aria-busy');
      }
    }

    function renderRows() {
      const focused = list.contains(document.activeElement) && document.activeElement.closest('[data-queue-order]')?.dataset.queueOrder;
      const elements = rows.map(row => {
        const title = row.business || row.reference || row.id;
        const details = [];
        if (row.reference && row.reference !== title) details.push(row.reference);
        if (/^\d{4}-\d{2}-\d{2}$/.test(row.dispatchDate)) {
          const day = new Date(row.dispatchDate + 'T12:00:00Z');
          if (Number.isFinite(day.getTime())) details.push('Dispatch ' + dates.format(day));
        }
        const action = el('button', {type:'button',class:'btn soft dq-action',onclick:() => openRow(row, action)}, row.actionLabel);
        const summary = el('div', {class:'dq-summary'}, el('h3', {}, title),
          details.length ? el('p', {class:'dq-meta'}, details.join(' · ')) : null);
        const state = el('div', {class:'dq-state'},
          el('span', {class:'dq-badge'}, row.stageLabel || stages.get(row.stage)),
          row.reason ? el('p', {}, row.reason) : null);
        return el('li', {class:'dq-row','data-queue-order':row.id,'data-stage':row.stage}, summary, state, action);
      });
      list.replaceChildren(...elements);
      if (focused) {
        const restored = elements.find(item => item.dataset.queueOrder === focused);
        (restored?.querySelector('button') || reload).focus({preventScroll:true});
      }
    }

    function showMessage(text, error = false) {
      message.hidden = !text;
      message.textContent = text;
      message.classList.toggle('dq-error', error);
    }

    async function request(append = false, quiet = false) {
      if (!active || (append && (loading || !cursor))) return;
      const ticket = ++generation;
      const previousRows = rows.length;
      const fromMore = append && document.activeElement === more;
      loading = true;
      clearTimeout(recoveryTimer);
      // Returning from a parcel should keep an expanded queue open at the same depth.
      const target = append ? 40 : Math.max(previousRows, 40);
      const params = new URLSearchParams({stage,limit:String(Math.min(target, 100))});
      if (append) params.set('cursor',cursor);
      region.setAttribute('aria-busy','true');
      more.disabled = true;
      more.hidden = !cursor;
      reload.setAttribute('aria-disabled','true');
      if (!quiet) showMessage(append ? 'Loading more parcels…' : 'Loading parcels…');
      try {
        const incoming = [];
        let data;
        do {
          data = await load(params);
          if (!active || ticket !== generation) return;
          if (!Array.isArray(data?.orders) || !data.counts || [...stages.keys()].some(key =>
            key !== 'all' && (!Number.isSafeInteger(data.counts[key]) || data.counts[key] < 0))) {
            throw new Error('Could not read the dispatch queue. Refresh to try again.');
          }
          incoming.push(...data.orders);
          if (append || incoming.length >= target || !data.nextCursor) break;
          if (!data.orders.length || data.nextCursor === params.get('cursor')) throw new Error('Could not load the next parcels.');
          params.set('cursor',data.nextCursor);
          params.set('limit',String(Math.min(100,target - incoming.length)));
        } while (active && ticket === generation);
        counts = data.counts;
        rows = [...new Map([...(append ? rows : []), ...incoming].map(row => [row.id,row])).values()];
        cursor = data.nextCursor || null;
        filters();
        renderRows();
        showMessage(rows.length ? '' : empty[stage]);
        if (fromMore && (document.activeElement === more || document.activeElement === document.body)) {
          (list.children[previousRows]?.querySelector('button') || reload).focus({preventScroll:true});
        }
      } catch (error) {
        if (!active || ticket !== generation) return;
        // A rejected access/session check also removes any rows cached in this view.
        rows = [];
        counts = null;
        cursor = null;
        list.replaceChildren();
        filters();
        showMessage(error?.message || 'Could not load the dispatch queue. Refresh to try again.', true);
      } finally {
        if (active && ticket === generation) {
          loading = false;
          region.removeAttribute('aria-busy');
          reload.removeAttribute('aria-disabled');
          more.disabled = false;
          more.hidden = !cursor;
          scheduleRecoveryCheck();
        }
      }
    }

    filters();
    request();
    return {
      get stage() { return stage; },
      refresh: () => request(),
      destroy() {
        active = false;
        generation++;
        clearTimeout(recoveryTimer);
        rows = [];
        region.remove();
      },
    };
  }

  window.SCDispatchQueue = Object.freeze({mount});
})();
