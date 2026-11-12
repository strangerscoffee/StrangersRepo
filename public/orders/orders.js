// The staff wholesale orders page, for accounts an admin has given wholesale orders access: orders and packing
// details, status / internal note / tracking changes (version-checked, online only, never queued), printing orders
// and bags to process, and customers' contact and delivery details (read-only). No prices. Nothing is stored
// locally, and everything is cleared or hidden when the session can't be verified.
(()=>{
 'use strict';
 const {el,svgi}=SC,{grindFor,decafLine,iconPaths,coffeeStyle}=SCWholesalePreparation,packing=SCWholesalePacking;
 const $=id=>document.getElementById(id);
 const paths={chev:'<path d="m9 6 6 6-6 6"/>',warn:'<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',coffee:'<path d="M5 8h12v7a6 6 0 0 1-12 0V8ZM17 9h2a3 3 0 0 1 0 6h-2"/>',doc:'<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',ok:'<path d="m5 12 5 5 9-10"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',...iconPaths};
 const svg=key=>svgi(paths[key]||paths.coffee);
 const filters=[['open','Open orders'],['New','New'],['Preparing','Preparing'],['Ready','Ready'],['Dispatched','Dispatched'],['all','All orders']];
 const STATUSES=['New','Preparing','Ready','Dispatched','Cancelled'];
 const NEXT={New:['Preparing','Mark preparing'],Preparing:['Ready','Mark ready'],Ready:['Dispatched','Mark dispatched']};
 let rows=[],cursor=null,total=0,status='open',selected=null,sequence=0,timer=null,searchTimer=null,customerTimer=null,started=false;
 let view='orders',customers=[],customersMore=false,picking=false,busy=new Set(),editing=false;
 let tabs={open:[],cleared:[],threshold:6000},tabSelected=null,tabConfirm=false;
 const picked=new Set();
 const weight=grams=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(grams/1000)+' kg';
 const date=at=>new Date(at).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const pill=value=>el('span',{class:'pill '+String(value).toLowerCase()},value);
 function closeDialogs(){for(const id of ['orderDialog','customerDialog','totalsDialog','tabDialog'])if($(id).open)$(id).close();}
 function lock(clear=false){
  document.documentElement.setAttribute('data-orders-locked','');closeDialogs();
  if(clear){rows=[];customers=[];tabs={open:[],cleared:[],threshold:6000};tabSelected=null;$('tabList').replaceChildren();$('clearedList').replaceChildren();$('tabDetail').replaceChildren();selected=null;cursor=null;picked.clear();picking=false;editing=false;
   for(const id of ['orderList','orderDetail','orderEdit','customerList','customerDetail','totalsBody'])$(id).replaceChildren();
   $('signedIn').textContent='';$('ordersContent').hidden=true;}
 }
 function message(text,{retry=false,denied=false}={}){
  $('accessStatus').hidden=false;$('accessStatus').replaceChildren(el('p',{},text),retry?el('button',{type:'button',class:'btn',onclick:()=>load({reverify:true})},'Try again'):null,denied?el('a',{href:'/'},'Back to Kitchen Diary'):null);
 }
 const toast=SC.makeToast(3500);
 function warning(account,banner=false){
  const container=el('div',{class:banner?'account-banners':'account-warnings'});
  if(account?.overdue)container.append(el('div',{class:banner?'account-banner':'account-warning'},svg('warn'),el('span',{},banner?'This business has overdue invoices. Ask an admin to check payment before fulfilment.':'Account overdue')));
  if(account?.review)container.append(el('div',{class:(banner?'account-banner':'account-warning')+' review'},svg('info'),el('span',{},banner?'Payment status needs checking. Ask an admin to confirm the account.':'Payment status needs checking')));
  return container;
 }

 // Orders: the list, with a quick next step on each, or ticking orders to print.
 function printBar(){
  return picking
   ?el('div',{class:'print-bar picking',role:'region','aria-label':'Choose orders to print'},el('span',{class:'picked-count','aria-live':'polite'},picked.size?`${picked.size} selected`:'Tap orders to select them'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{for(const row of rows)picked.add(row.id);draw()}},'Select all shown'),
     el('button',{type:'button',class:'btn soft sm',disabled:!picked.size,onclick:()=>openTotals([...picked])},'Bag totals'),
     el('button',{type:'button',class:'btn sm',disabled:!picked.size,onclick:()=>printScope({ids:[...picked],label:`${picked.size} selected ${picked.size===1?'order':'orders'}`})},svg('doc'),'Print selected'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{picking=false;picked.clear();draw()}},'Done'))
   :el('div',{class:'print-bar'},el('button',{type:'button',class:'btn sm',onclick:()=>printScope({status:'New',label:'New orders'})},svg('doc'),'Print new orders'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{picking=true;picked.clear();draw()}},'Select to print'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>openTotals([])},'Bags to process'));
 }
 // Dispatch day and standing order, set in Admin ("Dispatch Fri 20 Nov · Standing order, every 2 weeks").
 const dispatchText=(row)=>[row.dispatchDate?'Dispatch '+new Date(row.dispatchDate+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}):'',row.standingEvery?`Standing order, every ${row.standingEvery===1?'week':row.standingEvery+' weeks'}`:''].filter(Boolean).join(' · ');
 function orderRow(row){
  const chosen=picked.has(row.id),next=NEXT[row.status],working=busy.has(row.id);
  const main=el('button',{type:'button',class:'order-row'+(picking?' is-picking':''),'data-order-id':row.id,...(picking?{'aria-pressed':String(chosen)}:{}),onclick:()=>picking?togglePick(row.id):openOrder(row.id)},
   picking?el('span',{class:'pick '+(chosen?'on':'off'),'aria-hidden':'true'},chosen?svg('ok'):null):null,
   el('span',{},el('b',{},row.business),el('span',{class:'row-meta'},`${row.locationName} · ${row.delivery} · ${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)}`),el('span',{class:'row-meta'},date(row.createdAt)),dispatchText(row)?el('span',{class:'row-meta row-dispatch'},dispatchText(row)):null,row.onTab?el('span',{class:'row-meta row-tab'},'On tab'):null,row.note?el('span',{class:'row-meta row-note'},'Note: '+row.note):null,warning(row.account)),
   el('span',{class:'row-end'},pill(row.status),picking?null:svg('chev')));
  return el('div',{class:'order-entry'+(picking?' is-picking':''),'aria-busy':String(working)},main,!picking&&next?el('button',{type:'button',class:'btn soft quick','data-quick':row.id,disabled:working,onclick:()=>quick(row.id)},working?'Saving…':next[1]):null);
 }
 function togglePick(id){picked.has(id)?picked.delete(id):picked.add(id);draw();document.querySelector(`[data-order-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
 function draw(){
  $('statusFilters').replaceChildren(...filters.map(([id,label])=>el('button',{type:'button','aria-pressed':String(status===id),onclick:()=>{status=id;load()}},label)));
  $('printBar').replaceChildren(printBar());
  $('orderCount').textContent=rows.length<total?`${rows.length} of ${total} orders`:`${total} ${total===1?'order':'orders'}`;
  $('orderList').replaceChildren(...rows.map(orderRow));
  if(!rows.length)$('orderList').append(el('div',{class:'empty'},$('search').value.trim()?'No matching orders. Try another search or status.':'No orders in this view.'));
  $('loadMore').hidden=!cursor;
 }
 const kv=(label,value)=>el('div',{class:'kv'},el('span',{},label),el('span',{},value||'None supplied'));
 function renderDetail(row){
  $('orderDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},row.business),pill(row.status)),el('p',{class:'detail-id'},row.id),warning(row.account,true),el('div',{class:'details'},kv('Location',row.locationName),kv('Received',date(row.createdAt)),...(dispatchText(row)?[kv('Dispatch',dispatchText(row))]:[]),kv('Reference',row.reference),kv('Delivery preference',row.delivery)),el('h3',{class:'packing-heading'},'Packing list'),el('div',{class:'w-packing-list'},...row.lines.map(line=>{const grind=grindFor(line);return el('div',{class:'item w-packing-line w-grind-tone w-coffee-tone',style:`--w-grind-h:${grind.hue};${coffeeStyle(line)}`},el('span',{class:'w-pack-quantity'},el('b',{},String(line.quantity)),el('span',{},line.quantity===1?'bag':'bags')),el('span',{class:'tx'},el('b',{class:'w-pack-coffee'},el('span',{class:'w-coffee-swatch','aria-hidden':'true'}),line.title,decafLine(line)?el('span',{class:'w-decaf-label'},'Decaf'):null),line.recipe?el('span',{class:'w-recipe'},`Made from ${line.recipe}`):null,el('span',{class:'w-pack-size'},line.packLabel),el('span',{class:'w-grind-details'},el('span',{class:'w-grind-badge'},svg(grind.icon),grind.label),grind.hint?el('span',{class:'w-grind-hint'},grind.hint):null)))})),el('p',{class:'packing-total'},`${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)} total`));
  if(row.delivery==='Delivery'&&(row.address||row.postcode))$('orderDetail').append(el('h3',{class:'packing-heading'},'Delivery address'),el('p',{class:'address'},[row.address,row.postcode].filter(Boolean).join('\n')));
  for(const [label,text]of[['Delivery notes',row.deliveryNotes],['Customer comments',row.customerNote]])if(text)$('orderDetail').append(el('div',{class:'detail-note'},el('b',{},label),text));
  if(row.trackingUrl){try{const url=new URL(row.trackingUrl);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)$('orderDetail').append(el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer',class:'tracking'},'Track delivery ↗'))}catch{}}
  if(!editing)renderEdit(row);
 }
 // Status, internal note and tracking link: saved together, against the version on screen.
 function renderEdit(row){
  const statusSelect=el('select',{id:'editStatus','aria-describedby':'editHint'},...STATUSES.map(s=>el('option',{value:s,...(s===row.status?{selected:true}:{})},s)));
  const tracking=el('input',{id:'editTracking',type:'url',inputmode:'url',maxlength:'500',placeholder:'https://…',autocomplete:'off',value:row.trackingUrl||''});
  const note=el('textarea',{id:'editNote',rows:'3',maxlength:'1000'});note.value=row.note||'';
  const trackingField=el('label',{class:'field',id:'trackingField',hidden:!(row.status==='Dispatched'||row.trackingUrl)},el('span',{},'Tracking link (optional)'),tracking);
  statusSelect.addEventListener('change',()=>{trackingField.hidden=!(statusSelect.value==='Dispatched'||tracking.value);});
  for(const input of [statusSelect,tracking,note])input.addEventListener('input',()=>{editing=true;});
  const next=NEXT[row.status];
  $('orderEdit').replaceChildren(
   el('div',{class:'edit-grid'},el('label',{class:'field'},el('span',{},'Status'),statusSelect),trackingField),
   el('label',{class:'field'},el('span',{},'Internal note'),note,el('small',{id:'editHint'},'For Strangers staff only. Customers never see it.')),
   el('p',{class:'edit-error',id:'editError',role:'alert',hidden:true}),
   el('div',{class:'edit-actions'},
    el('button',{type:'button',class:'btn soft',onclick:()=>printOne(row.id)},svg('doc'),'Print'),
    row.customerId?el('button',{type:'button',class:'btn soft',id:'tabToggle',onclick:()=>toggleTab(row.id)},row.onTab?'Take off tab':'Put on tab'):null,
    next?el('button',{type:'button',class:'btn soft',onclick:()=>{statusSelect.value=next[0];trackingField.hidden=!(next[0]==='Dispatched'||tracking.value);save(row.id)}},next[1]):null,
    el('button',{type:'button',class:'btn',id:'saveOrder',onclick:()=>save(row.id)},'Save')));
 }
 function openOrder(id){const row=rows.find(row=>row.id===id);if(!row)return;selected=id;editing=false;renderDetail(row);$('orderDialog').showModal();}
 async function patch(row,changes){
  const response=await fetch('/api/staff-orders/orders/'+encodeURIComponent(row.id),{method:'PATCH',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({ifVersion:row.version,status:row.status,note:row.note||'',trackingUrl:row.trackingUrl||'',...changes})});
  const data=await response.json().catch(()=>({}));
  if(response.status===403){lock(true);message('You no longer have access to wholesale orders.',{denied:true});throw Object.assign(new Error('No access.'),{quiet:true});}
  if(!response.ok)throw Object.assign(new Error(data.message||'The order could not be saved. Check your connection and try again.'),{code:data.code});
  const index=rows.findIndex(r=>r.id===row.id);if(index>=0)rows[index]={...rows[index],...data.order};
  return data.order;
 }
 async function save(id){
  const row=rows.find(r=>r.id===id);if(!row)return;
  const button=$('saveOrder'),error=$('editError');error.hidden=true;button.disabled=true;button.textContent='Saving…';
  try{
   const order=await patch(row,{status:$('editStatus').value,note:$('editNote').value,trackingUrl:$('editTracking').value.trim()});
   editing=false;draw();renderDetail(rows.find(r=>r.id===id)||order);toast(`${order.business}: ${order.status}`);
  }catch(e){
   if(e.quiet)return;
   if(e.code==='conflict'){editing=false;await load();error.textContent='Someone else changed this order. It has been reloaded: check it and save again.';}
   else error.textContent=e.message;
   const box=$('editError');if(box){box.textContent=error.textContent;box.hidden=false;}
  }finally{const b=$('saveOrder');if(b){b.disabled=false;b.textContent='Save';}}
 }
 async function quick(id){
  const row=rows.find(r=>r.id===id),next=row&&NEXT[row.status];if(!next||busy.has(id))return;
  busy.add(id);draw();
  try{const order=await patch(row,{status:next[0]});toast(`${order.business}: ${order.status}`);}
  catch(e){if(!e.quiet){toast(e.code==='conflict'?'That order was changed elsewhere. Reloaded: try again.':e.message);if(e.code==='conflict')await load();}}
  finally{busy.delete(id);if(started)draw();}
 }

 // Printing and bags to process (shared with Admin: /shared/wholesale-packing.js).
 async function fetchPrint(scope){
  const query=scope.ids?'ids='+encodeURIComponent(scope.ids.join(',')):'status='+encodeURIComponent(scope.status);
  const response=await fetch('/api/staff-orders/print?'+query,{cache:'no-store'});
  if(response.status===403){lock(true);message('You no longer have access to wholesale orders.',{denied:true});throw Object.assign(new Error('No access.'),{quiet:true});}
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!Array.isArray(data.orders))throw new Error(data.message||'Orders could not be loaded for printing.');
  return data;
 }
 async function printScope(scope,options){
  try{const {orders,printedAt}=await fetchPrint(scope);if(!orders.length){toast(scope.ids?'Those orders are no longer available.':`No ${scope.label.toLowerCase()} to print.`);return;}packing.printOrders(orders,scope.label,printedAt,options);}
  catch(e){if(!e.quiet)toast(e.message);}
 }
 function printOne(id){const row=rows.find(r=>r.id===id);if(row)printScope({ids:[id],label:row.business});}
 async function openTotals(selectedIds){
  let current=selectedIds.length?'selected':'New';
  const scopes={New:{status:'New',label:'New orders'},open:{status:'New,Preparing',label:'New and preparing orders'},selected:{ids:selectedIds,label:`${selectedIds.length} selected ${selectedIds.length===1?'order':'orders'}`}};
  const choices=[['New','New'],['open','New & preparing'],...(selectedIds.length?[['selected','Selected']]:[])];
  const segment=el('div',{class:'filters seg',role:'group','aria-label':'Which orders'});
  async function drawTotals(){
   segment.replaceChildren(...choices.map(([key,label])=>el('button',{type:'button','aria-pressed':String(current===key),onclick:()=>{current=key;drawTotals()}},label)));
   $('totalsBody').replaceChildren(el('p',{class:'wp-meta'},'Loading…'));
   try{const {orders}=await fetchPrint(scopes[current]);if(!$('totalsDialog').open)return;$('totalsBody').replaceChildren(packing.summaryBody(orders,scopes[current].label));$('printTotals').disabled=$('printSheets').disabled=!orders.length;}
   catch(e){if(!e.quiet)$('totalsBody').replaceChildren(el('p',{class:'edit-error'},e.message));}
  }
  $('totalsScope').replaceChildren(segment);
  $('printTotals').onclick=()=>printScope(scopes[current],{onlyTotals:true});
  $('printSheets').onclick=()=>printScope(scopes[current]);
  $('totalsDialog').showModal();await drawTotals();
 }

 // Customer tabs: a running tally of each customer's orders until 6 kg, then cleared (or sooner). No money here.
 async function tabRequest(method,path,body){
  const response=await fetch('/api/staff-orders/'+path,{method,cache:'no-store',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>({}));
  if(response.status===403){lock(true);message('You no longer have access to wholesale orders.',{denied:true});throw Object.assign(new Error('No access.'),{quiet:true});}
  if(!response.ok)throw Object.assign(new Error(data.message||'That could not be saved. Check your connection and try again.'),{code:data.code});
  return data;
 }
 async function toggleTab(id){
  const row=rows.find(r=>r.id===id),button=$('tabToggle');if(!row||!button)return;
  button.disabled=true;
  try{const {order}=await tabRequest('PUT','orders/'+encodeURIComponent(id)+'/tab',{ifVersion:row.version,onTab:!row.onTab});
   const i=rows.findIndex(r=>r.id===id);if(i>=0)rows[i]={...rows[i],...order};draw();renderDetail(rows[i]);toast(order.onTab?`${order.business}: on the tab`:`${order.business}: off the tab`);if(view==='tabs')loadTabs();}
  catch(e){if(e.quiet)return;toast(e.code==='conflict'?'That order changed elsewhere. Reloaded: try again.':e.message);if(e.code==='conflict')await load();}
  finally{const b=$('tabToggle');if(b)b.disabled=false;}
 }
 const tabProgress=(t,threshold)=>{const pct=Math.min(100,Math.round(t.grams/threshold*100));return el('div',{class:'tab-progress'+(t.ready?' ready':''),role:'progressbar','aria-valuemin':'0','aria-valuemax':String(threshold/1000),'aria-valuenow':String(t.grams/1000),'aria-label':`${weight(t.grams)} of ${weight(threshold)}`},el('span',{style:`width:${pct}%`}));};
 function drawTabs(){
  const open=tabs.open,ready=open.filter(t=>t.ready).length;
  $('tabCount').textContent=open.length?`${open.length} ${open.length===1?'tab':'tabs'}${ready?` · ${ready} ready to clear`:''}`:'';
  $('tabList').replaceChildren(...open.map(t=>el('button',{type:'button',class:'tab-card glass'+(t.ready?' ready':''),'data-tab':t.customerId,onclick:()=>openTab(t.customerId)},
   el('span',{class:'tab-head'},el('b',{},t.business),t.ready?el('span',{class:'pill ready'},svg('ok'),'Ready to clear'):t.autoTab?el('span',{class:'pill'},'Automatic'):null),
   el('span',{class:'tab-kg'},el('strong',{},weight(t.grams)),el('span',{},` of ${weight(tabs.threshold)}`)),
   tabProgress(t,tabs.threshold),
   el('span',{class:'row-meta'},t.orders.length?`${t.orders.filter(o=>o.counts).length} ${t.orders.filter(o=>o.counts).length===1?'order':'orders'} · ${t.packs} ${t.packs===1?'bag':'bags'}${t.ready?'':` · ${weight(t.toGo)} to go`}`:'Nothing on the tab yet'))));
  if(!open.length)$('tabList').append(el('div',{class:'empty glass tab-empty'},'No open tabs. Open an order and choose Put on tab.'));
  $('clearedList').replaceChildren(...tabs.cleared.map(c=>el('div',{class:'order-row cleared-row'},el('span',{},el('b',{},c.business),el('span',{class:'row-meta'},`Cleared ${date(c.clearedAt)} by ${c.clearedBy}`)),el('span',{class:'row-end'},el('span',{class:'cleared-kg'},weight(c.grams)),c.early?pill('Early'):null))));
  if(!tabs.cleared.length)$('clearedList').append(el('div',{class:'empty'},'No tabs cleared yet.'));
  if($('tabDialog').open&&tabSelected){const t=open.find(x=>x.customerId===tabSelected);if(t)renderTab(t);else $('tabDialog').close();}
 }
 function renderTab(t){
  $('tabTitle').textContent=t.business;
  $('tabDetail').replaceChildren(
   el('div',{class:'tab-summary'+(t.ready?' ready':'')},el('div',{class:'tab-kg big'},el('strong',{},weight(t.grams)),el('span',{},` of ${weight(tabs.threshold)}`)),tabProgress(t,tabs.threshold),
    el('p',{},t.ready?'This tab has reached 6 kg and is ready to clear.':`${weight(t.toGo)} to go before it's ready to clear. You can clear it sooner if needed.`)),
   el('h3',{class:'packing-heading'},'Orders on the tab'),
   t.orders.length?el('div',{class:'order-list glass'},...t.orders.map(o=>el('div',{class:'order-row tab-order'+(o.counts?'':' not-counted')},el('span',{},el('b',{},new Date(o.createdAt).toLocaleDateString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric'})+(o.reference?' · '+o.reference:'')),el('span',{class:'row-meta'},`${o.packs} ${o.packs===1?'bag':'bags'} · ${weight(o.grams)}${o.counts?'':' · cancelled, not counted'}`),el('span',{class:'row-meta'},o.addedBy==='Automatically'?'Added automatically':`Added by ${o.addedBy}`)),el('span',{class:'row-end'},pill(o.status))))):el('p',{class:'hint'},'Nothing on this tab yet. New orders will be added automatically.'),
   el('p',{class:'edit-error',id:'tabError',role:'alert',hidden:true}));
  $('tabFoot').replaceChildren(...(t.orders.length?(tabConfirm?[el('span',{},t.ready?`Clear ${weight(t.grams)}?`:`Clear early at ${weight(t.grams)}?`),el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',onclick:()=>{tabConfirm=false;renderTab(t)}},'Cancel'),el('button',{type:'button',class:'btn',id:'confirmClear',onclick:()=>clearTabNow(t)},'Clear tab'))]
   :[el('span',{},t.ready?'Ready to clear':'Not at 6 kg yet'),el('button',{type:'button',class:'btn'+(t.ready?'':' soft'),id:'clearTab',onclick:()=>{tabConfirm=true;renderTab(t)}},t.ready?'Clear tab':'Clear tab early')]):[el('span',{}),el('button',{type:'button',class:'btn soft',onclick:()=>$('tabDialog').close()},'Done')]));
 }
 function openTab(customerId){const t=tabs.open.find(x=>x.customerId===customerId);if(!t)return;tabSelected=customerId;tabConfirm=false;renderTab(t);$('tabDialog').showModal();}
 async function clearTabNow(t){
  const button=$('confirmClear');if(button){button.disabled=true;button.textContent='Clearing…';}
  try{const {cleared}=await tabRequest('POST','tabs/'+encodeURIComponent(t.customerId)+'/clear',{orderIds:t.orders.map(o=>o.id)});$('tabDialog').close();toast(`${cleared.business}: tab cleared at ${weight(cleared.grams)}`);await loadTabs();await load();}
  catch(e){if(e.quiet)return;tabConfirm=false;if(e.code==='conflict'){await loadTabs();}const box=$('tabError');if(box){box.textContent=e.code==='conflict'?'This tab changed on another device. It has been reloaded: check it and clear again.':e.message;box.hidden=false;}}
 }
 async function loadTabs(){
  const current=sequence;
  try{const data=await tabRequest('GET','tabs');if(current!==sequence)return;tabs=data;drawTabs();}
  catch(e){if(!e.quiet&&current===sequence)$('tabList').replaceChildren(el('div',{class:'empty'},'Tabs could not be loaded. Check your connection and try again.'));}
 }

 // Customers: contact and delivery details, read-only.
 function drawCustomers(){
  $('customerCount').textContent=`${customers.length}${customersMore?'+':''} ${customers.length===1?'customer':'customers'}`;
  $('customerList').replaceChildren(...customers.map(c=>el('button',{type:'button',class:'order-row','data-customer-id':c.id,onclick:()=>openCustomer(c.id)},
   el('span',{},el('b',{},c.business),el('span',{class:'row-meta'},[c.contact,c.phone].filter(Boolean).join(' · ')||'No contact saved'),el('span',{class:'row-meta'},`${c.locations.length} ${c.locations.length===1?'location':'locations'}${c.locations[0]?.postcode?' · '+c.locations[0].postcode:''}`)),
   el('span',{class:'row-end'},c.status==='On hold'?pill('On hold'):null,svg('chev')))));
  if(!customers.length)$('customerList').append(el('div',{class:'empty'},$('customerSearch').value.trim()?'No matching customers.':'No customers yet.'));
 }
 function openCustomer(id){
  const c=customers.find(c=>c.id===id);if(!c)return;
  const link=(href,text)=>el('a',{href},text);
  $('customerDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},c.business),c.status==='On hold'?pill('On hold'):pill('Active')),
   el('div',{class:'details'},kv('Contact',c.contact),el('div',{class:'kv'},el('span',{},'Email'),c.email?link('mailto:'+c.email,c.email):el('span',{},'None supplied')),el('div',{class:'kv'},el('span',{},'Phone'),c.phone?link('tel:'+c.phone.replace(/[^\d+]/g,''),c.phone):el('span',{},'None supplied'))),
   el('h3',{class:'packing-heading'},c.locations.length===1?'Delivery location':'Delivery locations'),
   ...c.locations.map(l=>el('div',{class:'detail-note location'},el('b',{},l.name+(l.id===c.defaultLocationId&&c.locations.length>1?' (default)':'')),[l.address,l.postcode].filter(Boolean).join('\n')||'No address saved',(l.contact||l.phone)&&(l.contact!==c.contact||l.phone!==c.phone)?el('span',{class:'row-meta'},[l.contact,l.phone].filter(Boolean).join(' · ')):null,l.deliveryNotes?el('span',{class:'row-meta'},'Delivery notes: '+l.deliveryNotes):null)));
  $('customerDialog').showModal();
 }
 async function loadCustomers(){
  const current=sequence;
  try{
   const q=$('customerSearch').value.trim(),response=await fetch('/api/staff-orders/customers'+(q?'?q='+encodeURIComponent(q):''),{cache:'no-store'});
   if(current!==sequence)return;
   if(response.status===403){lock(true);message('You do not have access to wholesale orders. Ask an admin to enable it.',{denied:true});return;}
   const data=await response.json();if(!response.ok||!Array.isArray(data.customers))throw new Error();
   if(current!==sequence)return;customers=data.customers;customersMore=!!data.more;drawCustomers();
  }catch{if(current===sequence)$('customerList').replaceChildren(el('div',{class:'empty'},'Customers could not be loaded. Check your connection and try again.'));}
 }
 function showView(next){
  view=next;$('ordersView').hidden=view!=='orders';$('customersView').hidden=view!=='customers';$('tabsView').hidden=view!=='tabs';
  for(const b of $('viewTabs').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
  if(view==='customers')loadCustomers();
  if(view==='tabs')loadTabs();
 }

 // A link to one order (the new-order email's button: /orders#WS-…) opens it, searching all orders if needed.
 async function openFromLink(){
  if(location.hash==='#tabs'){history.replaceState(null,'',location.pathname+location.search);showView('tabs');return;}
  const id=decodeURIComponent(location.hash.slice(1));if(!/^WS-[A-F0-9]{32}$/.test(id))return;
  history.replaceState(null,'',location.pathname+location.search);
  if(!rows.some(r=>r.id===id)){status='all';$('search').value=id;await load();}
  if(rows.some(r=>r.id===id))openOrder(id);else toast('That order could not be found.');
 }
 async function load({more=false,reverify=false}={}){
  if(!started)return;
  const current=++sequence,wasOpen=$('orderDialog').open,wasSelected=selected;
  if(reverify){lock();message('Checking access…');}
  $('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');$('loadMore').disabled=true;
  try{
   if(!(await SC.ensureSession({force:reverify})))return;
   const query=new URLSearchParams({status});if($('search').value.trim())query.set('q',$('search').value.trim());if(more&&cursor)query.set('cursor',cursor);
   const response=await fetch('/api/staff-orders/orders?'+query,{cache:'no-store'});
   if(current!==sequence)return;
   if(response.status===403){lock(true);message('You do not have access to wholesale orders. Ask an admin to enable it.',{denied:true});return;}
   if(!response.ok)throw new Error('Orders could not be loaded.');
   const data=await response.json();if(current!==sequence)return;
   if(!Array.isArray(data.orders))throw new Error('Orders could not be verified.');
   rows=more?[...new Map([...rows,...data.orders].map(row=>[row.id,row])).values()]:data.orders;cursor=data.nextCursor;total=data.count;
   draw();$('accessStatus').hidden=true;$('ordersContent').hidden=false;document.documentElement.removeAttribute('data-orders-locked');
   if(wasOpen&&wasSelected){const row=rows.find(row=>row.id===wasSelected);if(row){selected=row.id;renderDetail(row);if(!$('orderDialog').open)$('orderDialog').showModal()}else{$('orderDialog').close();selected=null;}}
   if(reverify&&view==='customers')loadCustomers();
   if(view==='tabs')loadTabs();
  }catch(error){if(current===sequence){lock(true);message('Orders could not be verified. Reconnect, then try again.',{retry:true});}}
  finally{if(current===sequence){$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');$('loadMore').disabled=false;}}
 }
 $('refresh').onclick=()=>load({reverify:true});$('loadMore').onclick=()=>load({more:true});
 $('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250)};
 $('customerSearch').oninput=()=>{clearTimeout(customerTimer);customerTimer=setTimeout(loadCustomers,250)};
 for(const b of $('viewTabs').querySelectorAll('button'))b.onclick=()=>showView(b.dataset.view);
 $('closeOrder').onclick=$('doneOrder').onclick=()=>{$('orderDialog').close()};
 $('orderDialog').addEventListener('close',()=>{selected=null;editing=false;$('orderEdit').replaceChildren()});
 $('closeCustomer').onclick=$('doneCustomer').onclick=()=>$('customerDialog').close();
 $('refreshTabs').onclick=()=>load({reverify:true});$('closeTab').onclick=()=>$('tabDialog').close();$('tabDialog').addEventListener('close',()=>{tabSelected=null;tabConfirm=false;});
 $('closeTotals').onclick=()=>$('totalsDialog').close();
 // Printing moves focus to the print dialog: that isn't leaving the page, so it doesn't lock it.
 let printing=false;addEventListener('beforeprint',()=>{printing=true});addEventListener('afterprint',()=>{setTimeout(()=>{printing=false},500)});
 addEventListener('blur',()=>{if(printing)return;sequence++;lock();});addEventListener('pagehide',()=>{sequence++;lock();});
 addEventListener('focus',()=>{if(started&&!printing)load({reverify:true})});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){sequence++;lock()}else if(started)load({reverify:true})});
 addEventListener('pageshow',event=>{if(event.persisted&&started)load({reverify:true})});addEventListener('online',()=>load({reverify:true}));
 SC.recheckOnPageshow();
 (async()=>{const me=await SC.startSession({clear:()=>{sequence++;started=false;clearInterval(timer);lock(true)}});if(!me)return;$('signedIn').textContent=me.user.name;started=true;await load({reverify:true});await openFromLink();timer=setInterval(()=>{if(started&&!document.hidden&&!editing&&!busy.size)load()},15000)})();
})();
