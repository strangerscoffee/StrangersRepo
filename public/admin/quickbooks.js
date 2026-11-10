// Native Admin sheets. Credentials stay on the server; drafts stay in this window only.
window.WholesaleQuickBooks = function ({api,html,raw,svg,show,title,footer,field,busy,closeSheet,reload,toast}) {
  const root="/api/admin/wholesale/quickbooks", $=selector=>document.querySelector(selector), clone=value=>JSON.parse(JSON.stringify(value));
  const modeName=mode=>mode==="production"?"Live":"Sandbox";
  const money=value=>new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"}).format(value/100);
  const stamp=value=>value?new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Europe/London"}).format(new Date(value)):"Not checked yet";
  const day=value=>value?new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeZone:"Europe/London"}).format(new Date(value+"T12:00:00Z")):"As agreed";
  const path=(suffix,mode,query="")=>root+suffix+"?environment="+mode+(query?"&"+query:"");
  const done=()=>{closeSheet();reload();};
  const processQueued=async(scope,row)=>{if(["queued","uncertain"].includes(row.state))await api("POST",path("/exports/"+row.id+"/process",scope),{}).catch(()=>notify("Export saved. Scheduled processing will continue if this request cannot finish."));};
  // Keep confirmations in the current native window, away from its action buttons.
  function notify(message){
    const foot=$("#sheet .wi-foot");if(!foot){toast(message);return;}
    let notice=foot.querySelector(".qb-notice");if(!notice){notice=document.createElement("p");notice.className="hint qb-notice";notice.setAttribute("role","status");foot.prepend(notice);}
    notice.textContent=message;
  }
  const params=new URLSearchParams(location.search);
  let callbackScope=params.get("quickbooks")==="review"?(params.get("qbEnvironment")==="production"?"production":"sandbox"):null;
  let cancelled=params.get("quickbooksError")==="cancelled";
  const label={disconnected:"Not connected",pending:"Review company",connected:"Connected","needs-reconnect":"Reconnect required"};
  const states={queued:"Queued",sending:"Sending",uncertain:"Checking confirmation",linked:"Linked",paused:"Paused",review:"Review required"};
  const refreshIcon=()=>raw('<svg class="i qb-refresh" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>');
  const refreshButton=(action,label)=>html`<button class="btn soft qb-icon" type="button" data-sheet="${action}" aria-label="${label}" title="${label}">${refreshIcon()}</button>`;
  const companyDetails=state=>state.connection.name?html`<dl class="qb-meta"><div class="kv"><span>Company</span><strong>${state.connection.name}</strong></div><div class="kv"><span>Company ID</span><span>${state.connection.realmId}</span></div><div class="kv"><span>Country / currency</span><span>${state.connection.country} · ${state.connection.currency}</span></div>${state.connection.vatNumber?html`<div class="kv"><span>VAT registration</span><span>${state.connection.vatNumber}</span></div>`:""}</dl>`:"";
  async function open(back=done,scope=null){
    scope=scope||callbackScope;callbackScope=null;
    let state=await api("GET",path("/status",scope||"sandbox"));
    scope=scope||state.activeEnvironment;
    if(scope!==state.environment)state=await api("GET",path("/status",scope));
    const connection=state.connection;
    const form=show(html`<form id="qbConnectionForm" class="wi-sheet wi-wide">${title("QuickBooks Online",modeName(state.activeEnvironment)+" active for new exports")}
      <div class="wi-body"><section class="wi-section"><div class="qb-modes" role="group" aria-label="Accounting environment">${["sandbox","production"].map(mode=>html`<button class="btn ${mode===state.activeEnvironment?"":"soft"}" type="button" data-sheet="qb-mode" data-mode="${mode}" aria-pressed="${String(mode===state.activeEnvironment)}">${modeName(mode)}${mode===state.activeEnvironment?svg("ok"):""}</button>`)}</div><p class="hint">Switching changes where new invoices are sent. Existing Live invoices continue receiving payment updates.</p></section>
      <div class="wi-settings-grid"><section class="wi-section"><div class="wi-section-heading"><h3>${modeName(scope)} connection</h3><span class="pill ${connection.status==="connected"?"ok":"warn"}">${label[connection.status]||"Not connected"}</span></div>
      ${scope!==state.activeEnvironment?html`<div class="wi-draft-banner"><strong>${modeName(scope)} setup</strong><span>${modeName(state.activeEnvironment)} remains active. Reviewing this connection does not switch environments.</span></div>`:""}${companyDetails(state)}
      ${!state.configured?html`<p>The site owner needs to configure the ${modeName(scope)} app credentials before connecting.</p><a class="btn soft" href="https://github.com/strangerscoffee/StrangersRepo/blob/main/docs/quickbooks-integration.md" target="_blank" rel="noopener">Setup guide ${svg("out")}</a>`:
        connection.status==="pending"?html`${field("Company VAT registration",html`<input id="qbVatNumber" maxlength="40" required autocomplete="off">`)}<label class="wi-check"><input id="qbConfirmCompany" type="checkbox" required><span>I’ve checked this is the intended UK ${modeName(scope)} company and its VAT registration.</span></label>`:
        connection.status==="connected"?html`<div class="group">${[["customer","Customers"],["item","Sales items"],["taxcode","Sales VAT codes"],["term","Payment terms"]].map(([kind,name])=>html`<button class="item" type="button" data-sheet="qb-browse" data-kind="${kind}"><span class="tx"><b>${name}</b></span>${svg("chev")}</button>`)}</div><button class="btn soft" type="button" data-sheet="qb-map-invoice">Review invoice mappings</button>`:
        html`<button class="btn" type="button" data-sheet="qb-connect">Connect QuickBooks ${modeName(scope)}</button>`}
      ${connection.status!=="disconnected"?html`<button class="btn soft" type="button" data-sheet="qb-disconnect">Disconnect ${modeName(scope)}</button>`:""}</section>
      <section class="wi-section"><div class="wi-section-heading"><h3>Accounting activity</h3>${refreshButton("qb-refresh-status","Refresh accounting status")}</div>
      <div class="group"><div class="item"><span class="tx"><b>Pending exports</b></span><strong>${state.health.exports.pending}</strong></div><div class="item"><span class="tx"><b>Exports to review</b></span><strong>${state.health.exports.review}</strong></div><div class="item"><span class="tx"><b>Payment updates queued</b></span><strong>${state.health.events.pending}</strong></div></div>
      <p class="hint">Last payment reconciliation: ${stamp(state.health.sync?.updated_at)}${state.health.sync?.last_error?" · "+state.health.sync.last_error:""}</p>
      <button class="btn soft" type="button" data-sheet="qb-history">Export history</button>
      ${connection.status==="connected"?html`<button class="btn soft" type="button" data-sheet="qb-payments">${refreshIcon()}Check payment updates</button>`:""}
      <button class="btn soft" type="button" data-sheet="qb-readiness">${state.live.ready?"Review Live readiness":"Set up Live"}</button>
      <button class="btn soft" type="button" data-sheet="qb-scope">View ${modeName(scope==="sandbox"?"production":"sandbox")} connection</button>
      <p class="hint">Invoices are sent only after an admin reviews each export. Payments are recorded in QuickBooks; this site does not collect money or send invoice emails.</p></section></div></div>
      ${footer(state.configured&&connection.status==="pending"?"Confirm company":null,"Done")}</form>`,async(action,element,current)=>{
      if(action==="qb-disconnect"){disconnect(state,back,scope);return;}
      if(action==="qb-mode"){if(element.dataset.mode!==state.activeEnvironment)await busy(current,()=>selectMode(element.dataset.mode,back,scope));return;}
      await busy(current,async()=>{
        if(action==="qb-browse")await references(scope,element.dataset.kind,()=>open(back,scope));
        if(action==="qb-history")await history(scope,()=>open(back,scope));
        if(action==="qb-map-invoice")await invoicePicker(scope,()=>open(back,scope));
        if(action==="qb-readiness")await liveReview(()=>open(back,scope));
        if(action==="qb-scope")await open(back,scope==="sandbox"?"production":"sandbox");
        if(action==="qb-refresh-status")await open(back,scope);
        if(action==="qb-payments"){await api("POST",path("/refresh-payments",scope),{});await open(back,scope);notify("Payment reconciliation queued.");}
        if(action==="submit"){
          if(!current.querySelector("#qbConfirmCompany").checked)throw new Error("Check the company before confirming.");
          await api("POST",path("/confirm",scope),{ifVersion:connection.version,vatNumber:current.querySelector("#qbVatNumber").value.trim(),confirmed:true});await open(back,scope);notify("QuickBooks "+modeName(scope)+" confirmed.");
        }
        if(action==="qb-connect"){
          const result=await api("POST",path("/connect",scope),{}),url=new URL(result.authorizeUrl),local=["127.0.0.1","localhost"].includes(location.hostname);
          if(!((url.protocol==="https:"&&url.hostname==="appcenter.intuit.com")||(local&&url.protocol==="http:"&&url.hostname==="127.0.0.1")))throw new Error("QuickBooks returned an unexpected sign-in address.");
          location.assign(url.href);
        }
      });
    },back);
    if(cancelled){cancelled=false;notify("QuickBooks sign-in was cancelled. Your active environment has not changed.");}
    return form;
  }
  function disconnect(state,back,scope){
    show(html`<form id="qbDisconnectForm" class="wi-sheet wi-choice">${title("Disconnect QuickBooks "+modeName(scope))}<div class="wi-body wi-section"><p>Remove this site's access to ${state.connection.name||"this company"}? Saved exports keep their original company and can be checked again after reconnecting it.</p></div>${footer("Disconnect","Keep connected")}</form>`,async(action,element,form)=>{
      if(action==="submit")await busy(form,async()=>{const result=await api("POST",path("/disconnect",scope),{ifVersion:state.connection.version});notify(result.revoked?"QuickBooks disconnected.":"Disconnected locally. Check the app's access in Intuit if needed.");await open(back,scope);});
    },()=>open(back,scope));
  }
  async function selectMode(scope,back,viewScope){
    const state=await api("GET",path("/status",scope));
    if(scope==="production"&&!state.live.ready){await liveReview(()=>open(back,viewScope));return;}
    show(html`<form id="qbModeForm" class="wi-sheet wi-choice">${title("Switch to "+modeName(scope))}<div class="wi-body wi-section">${companyDetails(state)}<p>${scope==="production"?"New exports will create invoices in your Live QuickBooks company.":"New exports will use the test company. Existing Live invoices will continue receiving payment updates."}</p><label class="wi-check"><input id="qbSwitchReview" type="checkbox" required><span>I’ve checked the destination for new invoice exports.</span></label></div>${footer("Use "+modeName(scope),"Keep "+modeName(state.activeEnvironment))}</form>`,async(action,element,form)=>{
      if(action==="submit")await busy(form,async()=>{if(!form.querySelector("#qbSwitchReview").checked)throw new Error("Check the export destination first.");await api("PUT",path("/mode",scope),{environment:scope,ifVersion:state.modeVersion,reviewed:true});await open(back,scope);notify("QuickBooks "+modeName(scope)+" is active for new exports.");});
    },()=>open(back,viewScope));
  }
  async function liveReview(back){
    const state=await api("GET",path("/status","production")),ready=state.live,complete=ready.checks.every(check=>check.ok);
    const checks={company:"This is the correct Live UK company and supplier VAT registration.",vat:"I’ve checked the actual Sandbox invoices, VAT treatments and delivery charges we use.",rounding:"Invoice numbers, dates, terms and pence rounding match the issued invoices.",payments:"Partial and full payments were recorded in Sandbox and checked here.",fees:"Our Intuit app has Production access and we’ve reviewed the applicable subscription and app requirements."};
    show(html`<form id="qbLiveReview" class="wi-sheet wi-wide">${title("Live readiness",ready.ready?"Approved for reviewed exports":"Complete testing before switching")}
      <div class="wi-body"><div class="wi-settings-grid"><section class="wi-section">${companyDetails(state)}<div class="group">${ready.checks.map(check=>html`<div class="item"><span class="ic ${check.ok?"ok":"warn"}">${svg(check.ok?"ok":"clock")}</span><span class="tx"><b>${check.label}</b></span><span class="pill ${check.ok?"ok":"warn"}">${check.ok?"Done":"Needed"}</span></div>`)}</div>
      <button class="btn soft" type="button" data-sheet="qb-live-setup">Open Live connection and mappings</button><p class="hint">Live exports also require a successful Sandbox test for each invoice’s price basis, VAT treatment and delivery profile. New treatments stay blocked until tested.</p></section>
      <section class="wi-section"><h3>Final review</h3>${ready.ready?html`<p>Approved ${stamp(ready.approvedAt)}. Changing the company, VAT or financial mappings requires another review.</p><button class="btn" type="button" data-sheet="qb-activate-live">Use Live for new exports</button>`:html`${Object.entries(checks).map(([key,text])=>html`<label class="wi-check"><input type="checkbox" data-attestation="${key}" required ${!complete?raw("disabled"):""}><span>${text}</span></label>`)}${!complete?html`<p class="hint">Complete the checks before approving. Sandbox evidence is recorded only after an exported invoice and its payments match QuickBooks.</p>`:""}`}
      <p class="hint">Signed payment notifications: ${ready.webhookConfigured?"configured":"not configured; scheduled reconciliation remains available"}.</p></section></div></div>${footer(!ready.ready&&complete?"Approve Live setup":null,"Back")}</form>`,async(action,element,form)=>{
      await busy(form,async()=>{
        if(action==="qb-live-setup")await open(()=>liveReview(back),"production");
        if(action==="qb-activate-live")await selectMode("production",()=>back(),"production");
        if(action==="submit"){
          const attestations=Object.fromEntries([...form.querySelectorAll("[data-attestation]")].map(input=>[input.dataset.attestation,input.checked]));
          if(Object.values(attestations).some(value=>!value))throw new Error("Complete the final review first.");
          await api("POST",path("/approve-live","production"),{ifVersion:state.modeVersion,connectionVersion:ready.connectionVersion,fingerprint:ready.fingerprint,reviewed:true,attestations});await liveReview(back);notify("Live setup approved. Choose Use Live when ready.");
        }
      });
    },back);
  }
  async function references(scope,kind,back,selected=null,apply=null,cursor=null){
    const result=await api("GET",path("/references",scope,"kind="+kind+(cursor?"&cursor="+encodeURIComponent(cursor):""))),names={customer:"QuickBooks customers",item:"QuickBooks sales items",taxcode:"QuickBooks VAT codes",term:"QuickBooks payment terms"};
    const content=item=>html`<span class="tx"><b>${item.name}</b><span>#${item.id}${item.type?" · "+item.type:""}${item.currency?" · "+item.currency:""}${kind==="term"&&item.days!==null?" · "+item.days+" days":""}</span></span>`;
    show(html`<div id="qbReferenceList" class="wi-sheet wi-choice">${title(names[kind],modeName(scope))}<div class="wi-body"><div class="group">${kind==="term"&&apply?html`<button class="item" type="button" data-sheet="qb-clear-term"><span class="tx"><b>Use the invoice’s saved due date</b><span>No QuickBooks term link</span></span></button>`:""}${result.items.length?result.items.map(item=>apply?html`<button class="item qb-reference-row" type="button" data-sheet="qb-pick" data-id="${item.id}" ${kind==="item"&&!["Service","NonInventory"].includes(item.type)?raw("disabled"):""} aria-pressed="${String(selected===item.id)}">${content(item)}${selected===item.id?svg("ok"):""}</button>`:html`<div class="item qb-reference-row">${content(item)}</div>`):html`<p class="hint">No active records on this page.</p>`}</div>${result.nextCursor?html`<button class="btn soft" type="button" data-sheet="qb-next">Next page</button>`:""}${cursor?html`<button class="btn soft" type="button" data-sheet="qb-first">First page</button>`:""}</div>${footer(null,"Back")}</div>`,async(action,element,form)=>{
      if(action==="qb-next")await busy(form,()=>references(scope,kind,back,selected,apply,result.nextCursor));
      if(action==="qb-first")await busy(form,()=>references(scope,kind,back,selected,apply));
      if(action==="qb-clear-term"&&apply)apply({id:"",name:"Use saved due date"});
      if(action==="qb-pick"&&apply){const chosen=result.items.find(item=>item.id===element.dataset.id);if(chosen)apply(chosen);}
    },back);
  }
  async function invoicePicker(scope,back,cursor=null){
    const result=await api("GET","/api/admin/wholesale/invoices"+(cursor?"?cursor="+encodeURIComponent(cursor):""));
    show(html`<div id="qbInvoicePicker" class="wi-sheet wi-choice">${title("Choose an issued invoice",modeName(scope)+" mappings")}<div class="wi-body"><div class="group">${result.invoices.length?result.invoices.map(invoice=>html`<button class="item" type="button" data-sheet="qb-pick-invoice" data-id="${invoice.id}"><span class="tx"><b>${invoice.number}</b><span>${invoice.billTo.name} · ${money(invoice.totals.grossPence)}</span></span>${svg("chev")}</button>`):html`<p class="hint">Issue an invoice from a customer order first.</p>`}</div>${result.nextCursor?html`<button class="btn soft" type="button" data-sheet="qb-next">Earlier invoices</button>`:""}</div>${footer(null,"Back")}</div>`,async(action,element,form)=>{
      await busy(form,async()=>{if(action==="qb-next")await invoicePicker(scope,back,result.nextCursor);if(action==="qb-pick-invoice"){const invoice=result.invoices.find(item=>String(item.id)===element.dataset.id);if(invoice)await openInvoice(invoice,()=>invoicePicker(scope,back,cursor),scope);}});
    },back);
  }
  async function openInvoice(invoice,back,scope=null){
    if(!scope&&invoice.accounting?.exportId){await openOperation("production",invoice.accounting.exportId,back);return;}
    const initial=await api("GET",path("/status",scope||"sandbox"));scope=scope||initial.activeEnvironment;
    const state=initial.environment===scope?initial:await api("GET",path("/status",scope));
    const listed=await api("GET",path("/exports",scope,"invoiceId="+invoice.id));
    const existing=listed.exports.find(item=>item.realmId===state.connection.realmId)||(scope==="production"?listed.exports[0]:null);
    if(existing){await openOperation(scope,existing.id,back);return;}
    if(!state.capabilities.invoicePreview){await open(back,scope);return;}
    const saved=await api("GET",path("/mappings",scope)),rates=[...new Map(invoice.lines.map(line=>[line.rateId+":"+line.vatBasisPoints,{rateId:line.rateId,basisPoints:line.vatBasisPoints,label:line.rateLabel}])).values()];
    const draft={scope,state,saved:clone(saved),customerId:saved.data.customerLinks[invoice.customerId]||"",coffeeItemId:saved.data.coffeeItemId||"",deliveryItemId:saved.data.deliveryItemId||"",termId:saved.data.termLinks[invoice.paymentTerms.id]||"",rates:rates.map(rate=>({...rate,taxCodeId:saved.data.taxMappings.find(item=>item.rateId===rate.rateId&&item.basisPoints===rate.basisPoints)?.taxCodeId||""})),reviewed:false,names:{},scrollTop:0};
    mappings(invoice,draft,back);
  }
  function mappings(invoice,draft,back){
    const scope=draft.scope,picked=(id,placeholder,kind)=>id?(draft.names[kind+":"+id]||"Reference #"+id):placeholder;
    const form=show(html`<form id="qbMappingForm" class="wi-sheet wi-wide">${title("QuickBooks invoice mappings",invoice.number+" · "+modeName(scope)+" · "+draft.state.connection.name)}<div class="wi-body"><p>Link the issued invoice to this company’s records. VAT codes must match the percentage and tax treatment.</p><div class="wi-settings-grid"><section class="wi-section">${[["customerId","QuickBooks customer","customer"],["coffeeItemId","Coffee sales item","item"],["deliveryItemId","Delivery sales item (when used)","item"],["termId","Payment terms · "+invoice.paymentTerms.label,"term"]].map(([key,name,kind])=>html`<div class="field"><span class="fl">${name}</span><button class="wi-picker" type="button" data-sheet="qb-choice" data-key="${key}" data-kind="${kind}">${picked(draft[key],kind==="term"?"Use saved due date":"Choose a record",kind)}${svg("chev")}</button></div>`)}<p class="hint">The saved due date, agreed terms and payment instructions stay on the exported invoice.</p></section><section class="wi-section">${draft.rates.map((rate,index)=>html`<div class="field"><span class="fl">${rate.label} · ${rate.basisPoints/100}% sales VAT</span><button class="wi-picker" type="button" data-sheet="qb-tax" data-index="${index}">${picked(rate.taxCodeId,"Choose the matching VAT code","taxcode")}${svg("chev")}</button></div>`)}<label class="wi-check"><input id="qbMappingReview" type="checkbox" ${draft.reviewed?raw("checked"):""} required><span>I’ve reviewed the business, sales items, payment terms and VAT treatment, including zero-rated or exempt items.</span></label><p class="hint">Saving mappings and previewing do not create an accounting transaction.</p></section></div></div>${footer("Save and preview","Back to invoice")}</form>`,async(action,element,current)=>{
      draft.reviewed=current.querySelector("#qbMappingReview").checked;draft.scrollTop=current.querySelector(".wi-body").scrollTop;
      if(action==="qb-choice"){
        const key=element.dataset.key;await busy(current,()=>references(scope,element.dataset.kind,()=>mappings(invoice,draft,back),draft[key],item=>{draft[key]=item.id;draft.names[element.dataset.kind+":"+item.id]=item.name;draft.reviewed=false;mappings(invoice,draft,back);}));
      }
      if(action==="qb-tax"){
        const index=Number(element.dataset.index);await busy(current,()=>references(scope,"taxcode",()=>mappings(invoice,draft,back),draft.rates[index].taxCodeId,item=>{draft.rates[index].taxCodeId=item.id;draft.names["taxcode:"+item.id]=item.name;draft.reviewed=false;mappings(invoice,draft,back);}));
      }
      if(action==="submit")await busy(current,async()=>{
        if(!draft.customerId||!draft.coffeeItemId||draft.rates.some(rate=>!rate.taxCodeId)||!draft.reviewed)throw new Error("Choose the customer, sales item and each VAT code, then review the mappings.");
        const taxMappings=draft.saved.data.taxMappings.filter(old=>!draft.rates.some(rate=>rate.rateId===old.rateId&&rate.basisPoints===old.basisPoints)).concat(draft.rates.map(({rateId,basisPoints,taxCodeId})=>({rateId,basisPoints,taxCodeId})));
        draft.saved=await api("PUT",path("/mappings",scope),{ifVersion:draft.saved.version,connectionVersion:draft.saved.connectionVersion,customer:{localId:invoice.customerId,quickbooksId:draft.customerId},coffeeItemId:draft.coffeeItemId,deliveryItemId:draft.deliveryItemId,taxMappings,term:{localId:invoice.paymentTerms.id,quickbooksId:draft.termId},reviewed:true});
        const result=await api("GET",path("/invoices/"+invoice.id+"/preview",scope));preview(invoice,result,draft.state,()=>mappings(invoice,draft,back),back);
      });
    },back);
    form.querySelector(".wi-body").scrollTop=draft.scrollTop;
  }
  function financialReview(result){
    const candidate=result.candidate;
    return candidate?html`<div class="group">${candidate.lines.map(line=>html`<div class="item"><span class="tx"><b>${line.description}</b><span>${line.quantity} · ${line.vatBasisPoints/100}% VAT · Item #${line.itemRef} · VAT #${line.taxCodeRef}</span></span><strong>${money(line.grossPence)}</strong></div>`)}</div><dl class="qb-meta"><div class="kv"><span>Customer</span><strong>${candidate.billTo.name} · #${candidate.customerRef}</strong></div><div class="kv"><span>Invoice / supply date</span><span>${day(candidate.invoiceDate)} / ${day(candidate.supplyDate)}</span></div><div class="kv"><span>Payment terms / due</span><span>${candidate.paymentTerms.label} · ${day(candidate.dueDate)}</span></div><div class="kv"><span>Net</span><strong>${money(candidate.totals.netPence)}</strong></div><div class="kv"><span>VAT</span><strong>${money(candidate.totals.vatPence)}</strong></div><div class="kv"><span>Total</span><strong>${money(candidate.totals.grossPence)}</strong></div></dl>`:"";
  }
  function preview(invoice,response,state,edit,back){
    const result=response.preview,scope=result.scope.environment;
    show(html`<form id="qbInvoicePreview" class="wi-sheet wi-wide">${title("QuickBooks "+modeName(scope)+" review",invoice.number+" · "+state.connection.name)}<div class="wi-body wi-section"><div class="wi-draft-banner"><strong>${response.exportReady?"Ready for reviewed export":"Review required"}</strong><span>No invoice has been sent to QuickBooks.</span></div>${response.exportReasons.length?html`<ul>${response.exportReasons.map(reason=>html`<li>${reason}</li>`)}</ul>`:""}${financialReview(result)}<button class="btn soft" type="button" data-sheet="qb-edit">Edit mappings</button>${!response.exportReady?html`<button class="btn soft" type="button" data-sheet="qb-setup">Open connection and readiness</button>`:""}${response.exportReady?html`<label class="wi-check"><input id="qbExportReview" type="checkbox" required><span>I’ve reviewed the ${modeName(scope)} company, invoice number, dates, totals and payment terms. Send this invoice to ${state.connection.name}.</span></label>${invoice.payment.paid?html`<label class="wi-check"><input id="qbPaidInvoiceReview" type="checkbox" required><span>This invoice is already marked paid here. I will reconcile its payment in QuickBooks; no payment is created by this export.</span></label>`:""}`:""}<p class="hint">The saved export keeps its original company, request ID and amounts when retried.</p></div>${footer(response.exportReady?"Send to "+modeName(scope):null,"Back to invoice")}</form>`,async(action,element,form)=>{
      if(action==="qb-edit"){edit();return;}
      if(action==="qb-setup"){await busy(form,()=>open(back,scope));return;}
      if(action==="submit")await busy(form,async()=>{
        if(!form.querySelector("#qbExportReview").checked)throw new Error("Review the export first.");
        const paidInvoiceConfirmed=!!form.querySelector("#qbPaidInvoiceReview")?.checked;
        if(invoice.payment.paid&&!paidInvoiceConfirmed)throw new Error("Review the payment reconciliation before sending.");
        let saved;
        try{saved=(await api("POST",path("/invoices/"+invoice.id+"/export",scope),{fingerprint:result.fingerprint,connectionVersion:response.connectionVersion,mappingVersion:response.mappingVersion,modeVersion:response.modeVersion,reviewed:true,paidInvoiceConfirmed})).export;}
        catch(error){const found=await api("GET",path("/exports",scope,"invoiceId="+invoice.id)).catch(()=>null);saved=found?.exports.find(item=>item.realmId===state.connection.realmId);if(!saved)throw error;}
        await processQueued(scope,saved);await openOperation(scope,saved.id,back);
      });
    },back);
  }
  async function history(scope,back,cursor=null){
    const result=await api("GET",path("/exports",scope,cursor?"cursor="+encodeURIComponent(cursor):""));
    show(html`<div id="qbExportHistory" class="wi-sheet wi-wide">${title(modeName(scope)+" export history","Saved exports retain their original company")}<div class="wi-body"><div class="group">${result.exports.length?result.exports.map(row=>html`<button class="item" type="button" data-sheet="qb-open-export" data-id="${row.id}"><span class="tx"><b>${row.number}</b><span>${row.companyName} · ${stamp(row.createdAt)}</span></span><span class="end"><span class="pill ${row.state==="linked"?"ok":"warn"}">${states[row.state]||row.state}</span>${svg("chev")}</span></button>`):html`<p class="hint">No exports in this environment yet. Open an issued invoice to review and send it.</p>`}</div>${result.nextCursor?html`<button class="btn soft" type="button" data-sheet="qb-next">Earlier exports</button>`:""}</div>${footer(null,"Back")}</div>`,async(action,element,form)=>{
      await busy(form,async()=>{if(action==="qb-next")await history(scope,back,result.nextCursor);if(action==="qb-open-export")await openOperation(scope,Number(element.dataset.id),()=>history(scope,back,cursor));});
    },back);
  }
  async function openOperation(scope,id,back,poll=0,previous=null){
    const [result,state]=await Promise.all([api("GET",path("/exports/"+id+"/review",scope)),api("GET",path("/status",scope))]);
    if(previous&&(!previous.isConnected||$("#scrim")?.hidden||previous.dataset.wiBusy))return;
    const row=result.export,observed=row.observation,active=scope===state.activeEnvironment,sameCompany=row.realmId===state.connection.realmId,linked=row.state==="linked",working=["queued","sending","uncertain"].includes(row.state);
    const form=show(html`<div id="qbExportDetail" class="wi-sheet wi-wide">${title(row.number+" · QuickBooks "+modeName(scope),row.companyName+" · Company #"+row.realmId)}<div class="wi-body wi-section"><div class="wi-section-heading"><span class="pill ${linked?"ok":"warn"}" id="qbExportState">${states[row.state]||row.state}</span>${refreshButton("qb-operation-status","Refresh export status")}</div>
      ${row.lastError?html`<div class="wi-reasons">${row.lastError}</div>`:""}${!sameCompany?html`<p class="wi-reasons">This export belongs to a different company. Reconnect its original ${modeName(scope)} company to continue.</p>`:""}${!active&&!linked?html`<p class="wi-reasons">${modeName(scope)} is inactive. Switch environments before retrying this saved export.</p>`:""}
      <dl class="qb-meta"><div class="kv"><span>Saved</span><span>${stamp(row.createdAt)}</span></div><div class="kv"><span>QuickBooks invoice ID</span><span>${row.remoteId||"Awaiting confirmation"}</span></div><div class="kv"><span>Attempts</span><span>${row.attempts}</span></div>${row.retryAt&&working?html`<div class="kv"><span>Next scheduled attempt</span><span>${stamp(row.retryAt)}</span></div>`:""}</dl>
      ${linked?html`<section class="wi-section"><div class="wi-section-heading"><h3>Payment status</h3>${sameCompany?refreshButton("qb-balance","Check payment in QuickBooks"):""}</div><p><strong>${observed?.status==="paid"?"Paid":observed?.status==="part-paid"?"Part paid":observed?.status==="unpaid"?"Unpaid":"Review required"}</strong>${observed?.status&&observed.status!=="review"?" · "+money(observed.outstanding_pence)+" outstanding":""}</p>${observed?.reason?html`<p class="wi-reasons">${observed.reason}</p>`:""}<p class="hint">Checked ${stamp(observed?.observed_at)}. ${scope==="sandbox"?"Sandbox balances are for testing and are never shown to customers.":"Record payments in QuickBooks. Verified remaining balances appear in the customer’s invoices."}</p></section>`:""}
      <details class="qb-review" ${!linked?raw("open"):""}><summary>Saved invoice review</summary>${financialReview(result.preview)}</details>
      ${!linked&&!working&&active&&sameCompany?html`<div class="row"><button class="btn" type="button" data-sheet="qb-retry">Review and retry original export</button>${row.remoteId?html`<button class="btn soft" type="button" data-sheet="qb-adopt">Link existing invoice</button>`:""}</div>`:""}<p class="hint">An existing export is never moved to another company or given a new request ID.</p></div>${footer(null,"Back")}</div>`,async(action,element,current)=>{
      if(action==="qb-retry"||action==="qb-adopt"){operationConfirmation(action,row,result.preview,state,back);return;}
      await busy(current,async()=>{if(action==="qb-balance"){await api("POST",path("/exports/"+id+"/refresh",scope),{});notify("Payment status checked.");}await openOperation(scope,id,back);});
    },back);
    // Short polling only while this exact window is open; scheduled recovery continues on the server.
    if(working&&poll<8)setTimeout(async()=>{
      if(!form.isConnected||$("#scrim")?.hidden||form.dataset.wiBusy||document.hidden)return;
      try{await openOperation(scope,id,back,poll+1,form);}
      catch(error){if(form.isConnected&&!$("#scrim")?.hidden){const output=form.querySelector("#wiError");if(output)output.textContent=error.message;}}
    },2000);
    return form;
  }
  function operationConfirmation(action,row,review,state,back){
    const adopt=action==="qb-adopt";
    show(html`<form id="qbOperationConfirm" class="wi-sheet wi-wide">${title(adopt?"Link existing QuickBooks invoice":"Retry original export",row.number+" · "+row.companyName)}<div class="wi-body wi-section">${financialReview(review)}<p>${adopt?"The server will compare the existing invoice’s customer, dates, items, VAT and totals before linking it. Linking an existing invoice does not count as a successful Sandbox create test.":"Retry the saved request with its original invoice number, company and amounts. If QuickBooks already received it, the server checks that invoice before doing anything else."}</p><label class="wi-check"><input id="qbOperationReview" type="checkbox" required><span>I’ve reviewed the original company and invoice details.</span></label></div>${footer(adopt?"Check and link invoice":"Retry original export","Keep export")}</form>`,async(pressed,element,form)=>{
      if(pressed==="submit")await busy(form,async()=>{if(!form.querySelector("#qbOperationReview").checked)throw new Error("Review the saved invoice first.");const result=await api("POST",path("/exports/"+row.id+(adopt?"/link-existing":"/retry"),row.environment),{ifVersion:row.version,modeVersion:state.modeVersion,reviewed:true,...(adopt?{remoteId:row.remoteId}:{})});await processQueued(row.environment,result.export);await openOperation(row.environment,row.id,back);});
    },()=>openOperation(row.environment,row.id,back));
  }
  return{open,openInvoice};
};
