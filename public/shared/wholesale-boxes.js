// Shared booking review and the multi-box packing desk for wholesale Admin and Staff.
(() => {
  'use strict';
  const {el} = SC;
  const maxWeight = 30000;
  const maxBoxes = 50;
  const addressFields = {name:'Addressee', line1:'Address line 1', line2:'Address line 2 (optional)', city:'Town or city', county:'County (optional)', postcode:'UK postcode'};
  const billingSources = {confirmed:'Confirmed billing address',delivery:'Same as delivery address',override:'Billing address for this booking'};
  const grams = amount => Number(amount).toLocaleString('en-GB') + ' g';
  const button = (text, click, primary = false, disabled = false) =>
    el('button',{type:'button',class:primary ? 'btn' : 'btn soft',disabled,onclick:click}, text);
  function checkReview(result) {
    if (!result || typeof result.ready !== 'boolean' || !Array.isArray(result.issues) ||
        !Number.isSafeInteger(result.billingRevision) || result.billingRevision < 0 ||
        !Object.hasOwn(billingSources,result.billingSource) ||
        !result.issues.every(issue => typeof issue?.field === 'string' && typeof issue.message === 'string') ||
        result.ready && result.issues.length) throw new Error('The booking details could not be checked. Review them again.');
    return result;
  }
  function issues(result, admin) {
    if (!result || result.ready) return null;
    return el('div',{class:'box-check-issues',role:'alert'},el('strong',{},'Check these booking details'),
      el('ul',{},result.issues.map(issue => el('li',{},issue.message))),
      !admin && result.issues.some(issue => /^(billing|recipient)\./.test(issue.field)) ? el('p',{},'Ask an admin to correct the address, then review the label again.') : null);
  }
  function addressEditor(title, draft, changed) {
    return el('fieldset',{class:'box-address-editor'},el('legend',{},title),
      Object.entries(addressFields).map(([key,label]) => el('label',{class:'field'},
        el('span',{},label), el('input',{type:'text',value:draft[key] || '',maxlength:key === 'postcode' ? 12 : 100,
          'data-address-field':key,autocomplete:'off',oninput:event=>{draft[key]=event.target.value; changed?.();}}))));
  }
  function addressText(address) {
    return address ? Object.keys(addressFields).map(key => address[key]).filter(Boolean).join(', ') : '';
  }
  function preflightSummary(result, admin) {
    if (!result) return null;
    return el('section',{class:'box-billing-summary','aria-label':'Billing address'},
      el('strong',{},'Billing address'),el('span',{},billingSources[result.billingSource]),
      admin && addressText(result.billingDraft) ? el('small',{},addressText(result.billingDraft)) : null);
  }

  function mount(host,{row,shipping,admin,recipient,request,pdfUrl,current,changed,exit,boxNumber,dispatchOther,denied}) {
    let plan = null, weights = [], contents = [], goodsValues = [], editing = false, busy = false, error = '', note = '';
    let selected = null, review = null, posted = null, billing = null, addressOpen = false;
    let needsRead = false, pendingLabel = '', recovery = null, confirmAt = 0;
    host.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
    });
    const destination = {...recipient};
    const live = () => host.isConnected && current();
    const focus = selector => host.querySelector(selector)?.focus({preventScroll:true});
    function clearReview() { review = null; posted = null; confirmAt = 0; recovery = null; }
    function checkedPlan(value) {
      if (!value || value.orderVersion !== row.version || !Array.isArray(value.boxes) ||
          value.boxes.length > maxBoxes || value.boxes.some((box,i) => box.number !== i+1 ||
            !Number.isInteger(box.weightGrams) || box.weightGrams < 1 || box.weightGrams > maxWeight) ||
          value.boxes.length && (value.boxes.length < 2 || typeof value.planVersion !== 'string' || !value.planVersion)) {
        throw new Error('The box plan changed or could not be verified. Reopen the order to review its current details.');
      }
      return value;
    }
    const packingLines = () => Array.isArray(plan?.packingLines) ? plan.packingLines : row.lines || [];
    function resetEdits() {
      const lines = packingLines();
      weights = plan.boxes.length ? plan.boxes.map(box=>String(box.weightGrams)) :
        Array(Math.max(2,Math.min(maxBoxes,Math.ceil(row.grams/maxWeight)))).fill('');
      contents = weights.map((_,i) => lines.map((line,j)=>String(plan.boxes[i]?.contents?.[j] ?? 0)));
      goodsValues = weights.map((_,i) => Number.isSafeInteger(plan.boxes[i]?.goodsPence) ? (plan.boxes[i].goodsPence/100).toFixed(2) : '');
    }
    async function load() {
      plan = checkedPlan(await request('GET','/boxes'));
      if (!live()) return;
      needsRead = false;
      editing = !plan.boxes.length && plan.canChangePlan;
      resetEdits();
      changed?.(plan);
    }
    async function run(action, focusAfter, pending = 'Updating box details…') {
      if (!live() || busy) return;
      busy = true; pendingLabel=pending; error = ''; note = ''; draw();
      try { await action(); }
      catch (err) { if (live()) error = err.message || 'The request could not be completed.'; }
      finally {
        if (live()) {
          busy = false; pendingLabel=''; draw();
          if (error) focus('[data-box-error]');
          else if (focusAfter) focus(focusAfter);
        }
      }
    }
    function editor() {
      const lines = packingLines();
      const total = el('p',{class:'box-packed-total'});
      const lineLabels = lines.map(line => [line.title,line.packLabel,line.grindLabel].filter(Boolean).join(' · '));
      const remaining = lines.map(() => el('small',{class:'hint'}));
      const updateTotal = () => {
        const sum = weights.reduce((acc,w)=>acc + (Number.isSafeInteger(Number(w)) ? Number(w) : 0),0);
        total.textContent = 'Packed total ' + grams(sum) + ' · Coffee ' + grams(row.grams);
        lines.forEach((line,j) => {
          const left = line.quantity - contents.reduce((n,box)=>n + Number(box[j] || 0),0);
          remaining[j].textContent = lineLabels[j]+' · '+(left===0?'All packed':left<0?Math.abs(left)+' too many':left+' to pack');
        });
      };
      updateTotal();
      if (!admin && plan.manualGoodsValuesRequired) return el('p',{class:'box-check-issues',role:'status'},
        'Ask an admin to allocate the goods values and save the box plan. Once saved, you can review each box for postage.');
      const remove = i => {weights.splice(i,1);contents.splice(i,1);goodsValues.splice(i,1);draw();};
      return el('section',{class:'box-group','aria-label':'Box weights'},el('h4',{},'Pack and weigh each box'),
        el('p',{class:'hint'},'Each sealed box can weigh up to 30 kg. Royal Mail books and charges postage separately for each box.'),
        weights.map((w,i) => el('section',{class:'box-card','aria-label':'Packing box '+(i+1)},
          el('div',{class:'box-card-head'},el('h4',{},'Box '+(i+1)),
            weights.length>2 ? button('Remove box '+(i+1),()=>remove(i),false,busy) : null),
          lines.map((line,j)=>el('label',{class:'box-line-qty'},el('span',{},lineLabels[j]),
            el('input',{type:'number',inputmode:'numeric',step:1,min:0,max:line.quantity,value:contents[i][j],
              'data-box-allocation':(i+1)+':'+j,'aria-label':'Box '+(i+1)+' · '+lineLabels[j]+' quantity',
              disabled:busy,oninput:event=>{contents[i][j]=event.target.value;updateTotal();}}))),
          el('label',{class:'field'},el('span',{},'Box '+(i+1)+' packed weight (g)'),
            el('input',{type:'number',inputmode:'numeric',step:1,min:1,max:maxWeight,value:w,required:true,
              'data-box-weight':i+1,disabled:busy,oninput:event=>{weights[i]=event.target.value;updateTotal();}})),
          admin && plan.manualGoodsValuesRequired ? el('label',{class:'field'},el('span',{},'Box '+(i+1)+' goods value (£)'),
            el('input',{type:'number',inputmode:'decimal',min:0,step:'.01',value:goodsValues[i],required:true,
              disabled:busy,oninput:event=>{goodsValues[i]=event.target.value;}})) : null)),
        el('div',{class:'box-allocation-summary'},el('strong',{},'Packing check'),remaining,total),
        admin && plan.manualGoodsValuesRequired && Number.isSafeInteger(plan.orderGoodsPence) ?
          el('p',{class:'hint'},'Allocate the recorded goods total of £'+(plan.orderGoodsPence/100).toFixed(2)+' across these boxes.') : null,
        el('div',{class:'box-actions'},
          weights.length<maxBoxes ? button('Add box',()=>{weights.push('');contents.push(lines.map(()=>'0'));goodsValues.push('');draw();focus('[data-box-weight="'+weights.length+'"]');},false,busy) : null,
          button('Save box plan',savePlan,true,busy),
          plan.boxes.length ? button('Cancel edits',()=>{resetEdits();editing=false;draw();},false,busy) : null));
    }
    function savePlan() {
      const inputs = host.querySelectorAll('input[type=number]');
      for (const input of inputs) if (!input.reportValidity()) return;
      const lines=packingLines(), quantities=contents.map(box=>box.map(Number));
      const fieldIssue = (message,selector) => {error=message;draw();focus(selector);};
      for (let j=0;j<lines.length;j++) {
        if (quantities.reduce((n,box)=>n+box[j],0)!==lines[j].quantity)
          return fieldIssue('Allocate all '+lines[j].quantity+' bags of '+lines[j].title+' across the boxes.','[data-box-allocation="1:'+j+'"]');
      }
      for (let i=0;i<quantities.length;i++) {
        if (!quantities[i].some(n=>n>0)) return fieldIssue('Add at least one item to box '+(i+1)+'.','[data-box-allocation="'+(i+1)+':0"]');
        const coffee=quantities[i].reduce((n,qty,j)=>n+qty*lines[j].grams,0);
        if (coffee>Number(weights[i])) return fieldIssue('Box '+(i+1)+' must weigh at least '+grams(coffee)+' for its contents.','[data-box-weight="'+(i+1)+'"]');
      }
      const money=admin && plan.manualGoodsValuesRequired ? goodsValues.map(value=>Math.round(Number(value)*100)) : null;
      if (money && money.reduce((n,v)=>n+v,0)!==plan.orderGoodsPence)
        return fieldIssue('The box values must add up to the order goods total.','[data-box-error]');
      run(async () => {
        needsRead = true;
        await request('PUT','/boxes',{ifVersion:row.version,planVersion:plan.planVersion,weights:weights.map(Number),contents:quantities,...(money ? {goodsPence:money} : {})});
        await load();note='Box plan saved. Review each box before requesting its label.';
      },'[data-box-number="1"]');
    }
    function bookingBody(box) {
      return {ifVersion:row.version,planVersion:plan.planVersion,bookingVersion:plan.bookingVersion,bookingService:plan.bookingService,
        weightGrams:box.weightGrams,...(admin?{recipient:{...destination}}:{}),...(admin && billing ? {billing:{...billing}}: {})};
    }
    function checkBox(box) {
      selected=box.number; clearReview();addressOpen=false;
      const body=bookingBody(box);
      run(async()=>{
        review=checkReview(await request('POST','/boxes/'+box.number+'/preflight',body));
        if (review.ready) {
          posted={...body,billingRevision:review.billingRevision};
          confirmAt=performance.now()+440;
          setTimeout(()=>{if(live() && posted && !busy)host.querySelector('[data-buy-box]')?.removeAttribute('disabled');},460);
        }
        else if (admin && review.issues.some(issue=>issue.field.startsWith('billing.'))) {
          billing={...(billing || review.billingDraft || destination)};
        }
      },'[data-box-review]','Checking booking details…');
    }
    function buy(box) {
      if (!review?.ready || !posted || selected !== box.number || performance.now()<confirmAt) return;
      const payload=posted;clearReview();selected=null;
      run(async()=>{
        needsRead=true;
        try { await request('POST','/boxes/'+box.number+'/book',payload); }
        finally { await load(); }
      },'[data-box-number="'+box.number+'"]');
    }
    async function download(box) {
      const response=await fetch(pdfUrl('/boxes/'+box.number+'/label'),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
      if (!response.ok) {
        const issue=await response.json().catch(()=>({}));
        if (live() && response.status===403 && issue.code!=='account_on_hold') denied?.();
        throw new Error(issue.message || 'This label could not be downloaded.');
      }
      const pdf=await response.blob();
      if (pdf.type.split(';')[0]!=='application/pdf'||!pdf.size||pdf.size>10*1024*1024||await pdf.slice(0,5).text()!=='%PDF-') {
        throw new Error('The carrier did not return a valid label PDF.');
      }
      if (!live()) return;
      const url=URL.createObjectURL(pdf);
      const link=el('a',{href:url,download:'Royal-Mail-'+row.id+'-Box-'+box.number+'.pdf'});
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
      await load();note='Label downloaded for box '+box.number+'.';
    }
    function openRecovery(box) {
      clearReview();selected=null;
      run(async()=>{
        const detail=await request('GET','/boxes/'+box.number);
        if (!detail || detail.orderVersion !== row.version) throw new Error('The order changed. Reopen it before reviewing postage.');
        if (detail.canLinkOrder && typeof detail.linkOperation==='string') recovery={number:box.number,mode:'link',operation:detail.linkOperation};
        else if (detail.shipment?.orderId && detail.shipment.reviewRequired && !detail.shipment.orderChanged) recovery={number:box.number,mode:'verify'};
        else throw new Error('This box has no booking available to link or verify. Check its current status.');
      },'[data-box-recovery]','Checking the saved booking…');
    }
    function recoveryForm(box) {
      const link=recovery.mode==='link';
      const number=el('input',{type:'text',inputmode:link?'numeric':'text',maxlength:link?16:40,autocomplete:'off',disabled:busy});
      const checked=el('input',{type:'checkbox',disabled:busy});
      const submit=()=>{
        const value=number.value.trim();
        const valid=link ? /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) : !!SCWholesalePreparation.royalMailTrackingNumber(value);
        if (!valid || !checked.checked) {
          error=valid?'Confirm you checked the reference, recipient and weight for this box.':'Check the number entered for this box.';
          const alert=host.querySelector('[data-box-recovery-error]');alert.textContent=error;
          if(valid)checked.focus();else number.focus();return;
        }
        const input = link ? {operation:recovery.operation,orderNumber:value,bookingVersion:plan.bookingVersion} :
          {trackingNumber:SCWholesalePreparation.royalMailTrackingNumber(value),confirmed:true};
        run(async()=>{
          needsRead=true;
          try {await request('POST','/boxes/'+box.number+(link?'/link-order':'/verify'),{...input,ifVersion:row.version,planVersion:plan.planVersion});}
          finally {recovery=null;await load();}
        },'[data-box-number="'+box.number+'"]');
      };
      return el('section',{class:'box-review',tabindex:'-1','data-box-recovery':''},
        el('h4',{},link?'Link an existing booking':'Verify the existing label'),
        el('p',{},'Compare the reference, recipient and packed weight for this box in Click & Drop.'),el('code',{},box.reference),
        el('a',{class:'btn soft',href:'https://business.parcel.royalmail.com/',target:'_blank',rel:'noopener noreferrer'},'Open Click & Drop'),
        el('label',{class:'field'},el('span',{},link?'Royal Mail order number':'Tracking number on the checked label'),number),
        el('label',{},checked,' I checked that this booking belongs to box '+box.number+'.'),
        el('p',{class:'err',role:'alert','data-box-recovery-error':''}),
        el('div',{class:'box-actions'},button(link?'Check and link booking':'Verify label',submit,true,busy),
          button('Cancel',()=>{recovery=null;draw();},false,busy)));
    }
    function inspect(box) {
      const s=box.shipment;
      const states={booking:'Request sent',review:'Booking unconfirmed',failed:'Booking needs attention',created:'Booked · label pending',labelled:'Label ready',dispatched:'Dispatched'};
      const label=s?.orderChanged||s?.reviewRequired?'Needs review':s?.labelDownloadedAt?'Label downloaded':states[s?.state] || 'Awaiting label';
      const heading='Box '+box.number+' of '+plan.boxes.length;
      const reviewing=selected===box.number&&!!review;
      const recovering=recovery?.number===box.number;
      const buyButton=reviewing&&posted ? button('Request label for box '+box.number,()=>buy(box),true,busy||performance.now()<confirmAt) : null;
      buyButton?.setAttribute('data-buy-box','');
      const tracking=(!s?.reviewRequired&&!s?.orderChanged) && SCWholesalePreparation.royalMailTrackingUrl(s?.trackingNumber);
      return el('section',{class:'box-card','data-box-number':box.number,tabindex:'-1','aria-label':heading},
        el('div',{class:'box-card-head'},el('h4',{},heading),el('strong',{},grams(box.weightGrams))),
        el('p',{class:'box-state'},label),
        Array.isArray(box.contents) ? el('ul',{class:'box-content-list'},packingLines().flatMap((line,j)=>box.contents[j]>0 ?
          [el('li',{},box.contents[j]+' × '+[line.title,line.packLabel,line.grindLabel].filter(Boolean).join(' · '))] : [])) : null,
        s?.destination ? el('p',{class:'hint'},[s.destination.address,s.destination.postcode].filter(Boolean).join(', ')) : null,
        s?.carrierStatus ? el('p',{},s.carrierStatus) : null,
        s?.requestProblem || s?.problem ? el('p',{class:'hint'},s.requestProblem || s.problem) : null,
        reviewing ? el('div',{class:'box-review',tabindex:'-1','data-box-review':''},el('h4',{},'Review box '+box.number),
          el('p',{},[plan.bookingService,grams(box.weightGrams),addressText(destination)].filter(Boolean).join(' · ')),
          posted ? el('p',{class:'hint'},'This requests and charges postage for this box only.') : null,
          preflightSummary(review,admin),issues(review,admin),
          admin && billing && !posted ? addressEditor('Billing address for this booking',billing) : null,
          admin && (!billing || posted) ? button('Edit billing address',()=>{billing={...(review.billingDraft || destination)};posted=null;draw();focus('[data-address-field]');},false,busy) : null,
          el('div',{class:'box-actions'},posted ? buyButton :
            button('Recheck box '+box.number,()=>checkBox(box),true,busy),
            admin && billing ? button('Use saved billing details',()=>{billing=null;checkBox(box);},false,busy) : null,
            button('Cancel review',()=>{selected=null;clearReview();draw();},false,busy))) : null,
        recovering ? recoveryForm(box) : null,
        !reviewing && !recovering ? el('div',{class:'box-actions'},box.canCreate ? button('Review box '+box.number,()=>checkBox(box),true,busy) : null,
          box.canDownloadLabel ? button('Download label for box '+box.number,()=>run(()=>download(box),'[data-box-number="'+box.number+'"]'),true,busy) : null,
          s ? button('Check box '+box.number,()=>run(async()=>{
            await request('POST','/boxes/'+box.number+'/refresh',{});await load();
          },'[data-box-number="'+box.number+'"]'),false,busy) : null,
          admin && !plan.planChanged && !s?.orderChanged && (!s?.orderId || s.reviewRequired) ?
            button(s?.orderId?'Verify label for box '+box.number:'Link existing booking for box '+box.number,()=>openRecovery(box),false,busy) : null,
          tracking ? el('a',{class:'btn soft',href:tracking,target:'_blank',rel:'noopener noreferrer'},'Track box '+box.number) : null) : null);
    }
    function draw() {
      if (!live()) return;
      host.setAttribute('aria-busy',String(busy));
      host.replaceChildren(...SC.kids(el('div',{class:'box-header'},el('h3',{tabindex:'-1'},'Multiple boxes'),el('p',{},row.business || row.reference || row.id)),
        error ? el('p',{class:'box-check-issues',role:'alert',tabindex:'-1','data-box-error':''},error) : null,
        pendingLabel || note ? el('p',{class:'hint',role:'status'},pendingLabel || note) : null,
        needsRead || !plan ? (busy ? null : button('Reload box plan',()=>run(load),false,busy)) :
          editing ? editor() : el('div',{class:'box-list'},
            plan.planChanged ? el('p',{class:'box-check-issues',role:'alert'},'The order changed. Review the existing labels before dispatch.') : null,
            admin && plan.boxes.some(b=>b.canCreate) ? el('div',{class:'box-group'},
              button(addressOpen?'Done editing address':'Edit delivery address for postage',()=>{clearReview();selected=null;addressOpen=!addressOpen;draw();},false,busy),
              addressOpen ? addressEditor('Delivery address',destination) : null) : null,
            admin && plan.canDispatchWithOtherCourier && dispatchOther ? el('section',{class:'box-group'},
              el('h4',{},'Dispatch with a different courier'),el('p',{class:'hint'},'If these amended boxes went with another courier, review any existing Royal Mail postage and record the actual handover using that courier’s tracking link.'),
              button('Record another courier’s handover',dispatchOther,false,busy)) : null,
            plan.boxes.map(inspect),
            plan.canChangePlan && plan.boxes.length ? el('div',{class:'box-actions'},
              button('Edit box weights',()=>{clearReview();editing=true;draw();},false,busy),
              button('Return to one parcel',()=>run(async()=>{
                needsRead=true;await request('PUT','/boxes',{ifVersion:row.version,planVersion:plan.planVersion,weights:[]});await load(); if(live()) await exit();
              }),false,busy)) : null,
            !plan.boxes.length ? el('p',{class:'hint'},'A box plan cannot be added to this order.') : null),
        button('Back to shipping',()=>{if(!busy)void exit();},false,busy)));
    }
    void run(load,boxNumber ? '[data-box-number="'+Number(boxNumber)+'"]' : 'h3');
  }
  window.SCWholesaleBoxes=Object.freeze({mount,checkReview,preflightSummary,issues,addressEditor});
})();
