// The staff wholesale orders page, for accounts an admin has given wholesale orders access: orders and packing
// details, status / internal note / tracking changes (version-checked, online only, never queued), printing orders
// and bags to process, and customers' contact and delivery details (read-only). No prices. Nothing is stored
// locally except an identity-bound, frozen pending order used to recover uncertain submissions.
// Private views are cleared or hidden when the session can't be verified.
(()=>{
 'use strict';
 const {el,svgi}=SC,{grindFor,decafLine,iconPaths,coffeeStyle}=SCWholesalePreparation,packing=SCWholesalePacking;
 const $=id=>document.getElementById(id);
 let orderingIdentity=null;
 const pendingPrefix=()=>orderingIdentity?'sc.staffOrders.pending.'+orderingIdentity+'.':null;
 const pendingKey=p=>pendingPrefix()+p.payload.requestId;
 function savedAttempts(){
  const prefix=pendingPrefix(),found=[];if(!prefix)return found;
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key?.startsWith(prefix))continue;
   const p=JSON.parse(localStorage.getItem(key));
   if(p?.identity!==orderingIdentity||typeof p.business!=='string'||!p.payload||!/^[a-f0-9-]{36}$/i.test(p.payload.requestId)||!Array.isArray(p.payload.lines)||!p.payload.lines.length||key!==prefix+p.payload.requestId)throw new Error('Saved order recovery data needs checking. Ask an admin to check recent orders before placing another.');
   found.push(p);
  }
  return found.sort((a,b)=>(a.at||0)-(b.at||0));
 }
 function retainAttempt(p){localStorage.setItem(pendingKey(p),JSON.stringify(p));}
 function removeAttempt(p){
  if(p.identity!==orderingIdentity)return;
  const key=pendingKey(p),saved=JSON.parse(localStorage.getItem(key)||'null');
  if(saved?.identity===p.identity&&saved.payload?.requestId===p.payload.requestId)localStorage.removeItem(key);
 }
 const paths={chev:'<path d="m9 6 6 6-6 6"/>',warn:'<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',coffee:'<path d="M5 8h12v7a6 6 0 0 1-12 0V8ZM17 9h2a3 3 0 0 1 0 6h-2"/>',doc:'<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',ok:'<path d="m5 12 5 5 9-10"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',...iconPaths};
 const svg=key=>svgi(paths[key]||paths.coffee);
 const filters=[['open','Open orders'],['New','New'],['Preparing','Preparing'],['Ready','Ready'],['Dispatched','Dispatched'],['all','All orders']];
 const STATUSES=['New','Preparing','Ready','Dispatched','Cancelled'];
 const NEXT={New:['Preparing','Mark preparing'],Preparing:['Ready','Mark ready'],Ready:['Dispatched','Mark dispatched']};
 let rows=[],cursor=null,total=0,status='open',selected=null,sequence=0,timer=null,searchTimer=null,customerTimer=null,started=false;
 let view='orders',customers=[],customersMore=false,picking=false,busy=new Set(),editing=false;
 let ordersKey='';
 let tabs={open:[],cleared:[],threshold:6000},tabSelected=null,tabConfirm=false;
 const picked=new Set();
 let draft=null; // the order being taken for a customer (in memory only)
 const weight=grams=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(grams/1000)+' kg';
 const date=at=>new Date(at).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const pill=value=>el('span',{class:'pill '+String(value).toLowerCase()},value);
 function closeDialogs(){for(const id of ['orderDialog','customerDialog','totalsDialog','tabDialog','newOrderDialog'])if($(id).open)$(id).close();}
 function lock(clear=false){
  document.documentElement.setAttribute('data-orders-locked','');closeDialogs();
  if(clear){rows=[];customers=[];tabs={open:[],cleared:[],threshold:6000};tabSelected=null;$('tabList').replaceChildren();$('clearedList').replaceChildren();$('tabDetail').replaceChildren();selected=null;cursor=null;picked.clear();picking=false;editing=false;
   for(const id of ['orderList','orderDetail','orderEdit','customerList','customerDetail','totalsBody','newOrderForm','newOrderFoot'])$(id).replaceChildren();draft=null;
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
  $('orderDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},row.business),pill(row.status)),el('p',{class:'detail-id'},row.id),warning(row.account,true),el('div',{class:'details'},kv('Location',row.locationName),kv('Received',date(row.createdAt)),...(dispatchText(row)?[kv('Dispatch',dispatchText(row))]:[]),kv('Reference',row.reference),kv('Delivery preference',row.delivery),...(row.takenSource?[kv('Came in',row.takenSource)]:[]),...(row.changed?[kv('Bags changed',`${row.changed.byCustomer?'By the customer':'By Strangers'}, ${date(row.changed.at)}${row.changed.thisDeliveryOnly?' (this delivery only)':''}`)]:[]),...(row.skipped?[kv('Skipped',`${row.skipped.byCustomer?'By the customer':'By Strangers'}, ${date(row.skipped.at)}`)]:[])),el('h3',{class:'packing-heading'},'Packing list'),el('div',{class:'w-packing-list'},...row.lines.map(line=>{const grind=grindFor(line);return el('div',{class:'item w-packing-line w-grind-tone w-coffee-tone',style:`--w-grind-h:${grind.hue};${coffeeStyle(line)}`},el('span',{class:'w-pack-quantity'},el('b',{},String(line.quantity)),el('span',{},line.quantity===1?'bag':'bags')),el('span',{class:'tx'},el('b',{class:'w-pack-coffee'},el('span',{class:'w-coffee-swatch','aria-hidden':'true'}),line.title,decafLine(line)?el('span',{class:'w-decaf-label'},'Decaf'):null),line.recipe?el('span',{class:'w-recipe'},`Made from ${line.recipe}`):null,el('span',{class:'w-pack-size'},line.packLabel),el('span',{class:'w-grind-details'},el('span',{class:'w-grind-badge'},svg(grind.icon),grind.label),grind.hint?el('span',{class:'w-grind-hint'},grind.hint):null)))})),el('p',{class:'packing-total'},`${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)} total`));
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
    row.customerId&&OPEN_STATUSES.includes(row.status)?el('button',{type:'button',class:'btn soft',id:'changeBags',onclick:()=>openAmend(row)},'Change bags'):null,
    row.standingEvery&&OPEN_STATUSES.includes(row.status)?el('button',{type:'button',class:'btn soft',id:'skipDelivery',onclick:()=>askSkip(row)},'Skip this delivery'):null,
    next?el('button',{type:'button',class:'btn soft',onclick:()=>{statusSelect.value=next[0];trackingField.hidden=!(next[0]==='Dispatched'||tracking.value);save(row.id)}},next[1]):null,
    el('button',{type:'button',class:'btn',id:'saveOrder',onclick:()=>save(row.id)},'Save')));
 }
 // Changing the bags (until dispatched, no invoice: the server checks) and skipping a standing delivery. Bags only:
 // the server prices them. On a standing order, the change is for this delivery or every one from now on.
 const OPEN_STATUSES=['New','Preparing','Ready'];
 let amend=null;
 async function openAmend(row){
  editing=true;
  amend={row,catalogue:null,lines:row.lines.map(l=>({productId:l.productId,pack:l.pack,grind:l.grind,quantity:l.quantity})),scope:'once',busy:false,error:''};
  drawAmend();
  try{
   const data=await staffJson('GET','catalogue?customer='+encodeURIComponent(row.customerId));
   if(!amend||amend.row.id!==row.id)return;
   // Coffees already on the order stay choosable even if no longer listed (they keep their saved price).
   for(const l of row.lines)if(!data.products.some(p=>p.id===l.productId))data.products.unshift({id:l.productId,title:l.title,packs:[l.pack],grinds:[{id:l.grind,label:l.grindLabel}],inStock:true});
   amend.catalogue=data;drawAmend();
  }catch(e){if(!e.quiet&&amend){amend.error=e.message;drawAmend();}}
 }
 const amendBags=()=>amend.lines.reduce((n,l)=>n+(Number(l.quantity)||0),0);
 const amendGrams=()=>amend.lines.reduce((n,l)=>n+(PACK[l.pack]?.grams||0)*(Number(l.quantity)||0),0);
 function amendTotals(){const box=$('amendTotals');if(box)box.textContent=`${amendBags()} ${amendBags()===1?'bag':'bags'} · ${weight(amendGrams())}`;const b=$('saveAmend');if(b)b.disabled=amend.busy||!amendBags();}
 function drawAmend(){
  if(!amend)return;const row=amend.row;
  const parts=[el('h3',{class:'packing-heading'},'Change bags')];
  if(!amend.catalogue)parts.push(amend.error?null:SC.skeleton({label:'Loading coffees…',rows:2}));
  else{
   parts.push(el('div',{class:'no-lines'},...amend.lines.map((l,i)=>lineRow(l,i,amend,drawAmend,amendTotals))),
    el('button',{type:'button',class:'btn soft sm',onclick:()=>{amend.lines.push(blankLine(amend));drawAmend()}},'Add another coffee'),
    el('p',{class:'no-totals',id:'amendTotals','aria-live':'polite'}));
   if(row.standingEvery)parts.push(el('fieldset',{class:'field no-seg'},el('legend',{},'Change'),el('div',{class:'filters seg',role:'group'},...[['once','Just this delivery'],['ongoing','Every delivery from now on']].map(([v,t])=>el('button',{type:'button','aria-pressed':String(amend.scope===v),onclick:()=>{amend.scope=v;drawAmend()}},t))),
    el('small',{class:'hint'},amend.scope==='once'?'The next delivery goes back to the usual bags.':'These become the usual bags for this standing order.')));
  }
  parts.push(el('p',{class:'edit-error',role:'alert',hidden:!amend.error},amend.error||''),
   el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',onclick:closeAmend},'Cancel'),
    amend.catalogue?el('button',{type:'button',class:'btn',id:'saveAmend',onclick:saveAmend},amend.busy?'Saving…':'Save bags'):null));
  $('orderEdit').replaceChildren(...parts.filter(Boolean));amendTotals();
 }
 function closeAmend(){const row=amend&&rows.find(r=>r.id===amend.row.id);amend=null;editing=false;if(row)renderEdit(row);}
 async function saveAmend(){
  if(!amend||amend.busy)return;
  const row=amend.row,lines=amend.lines.filter(l=>l.productId&&l.quantity>0).map(({productId,pack,grind,quantity})=>({productId,pack,grind,quantity}));
  if(!lines.length){amend.error='Keep at least one bag. To stop this delivery, skip it or cancel the order.';drawAmend();return;}
  amend.busy=true;amend.error='';drawAmend();
  try{
   const {order}=await staffJson('PUT','orders/'+encodeURIComponent(row.id)+'/lines',{ifVersion:row.version,lines,...(row.standingEvery?{scope:amend.scope}:{})});
   const once=row.standingEvery&&amend.scope==='once';
   amend=null;editing=false;const i=rows.findIndex(r=>r.id===row.id);if(i>=0)rows[i]={...rows[i],...order};draw();renderDetail(rows[i]||order);
   toast(`${order.business}: bags changed${once?' for this delivery':''}`);
  }catch(e){
   if(e.quiet||!amend)return;amend.busy=false;
   if(e.code==='conflict'){amend=null;editing=false;await load();const r=rows.find(x=>x.id===row.id);if(r){renderDetail(r);const box=$('editError');if(box){box.textContent='Someone else changed this order. It has been reloaded: check it and change the bags again.';box.hidden=false;}}return;}
   amend.error=e.message;drawAmend();
  }
 }
 function askSkip(row){
  editing=true;
  const day=row.dispatchDate?new Date(row.dispatchDate+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}):'';
  $('orderEdit').replaceChildren(el('div',{class:'detail-note'},el('b',{},'Skip this delivery?'),`Nothing goes out${day?' on '+day:''}. It's marked skipped and the next delivery is made with the usual bags.`),
   el('p',{class:'edit-error',id:'skipError',role:'alert',hidden:true}),
   el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',onclick:()=>{editing=false;renderEdit(row)}},'Keep it'),el('button',{type:'button',class:'btn',id:'confirmSkip',onclick:()=>skipDelivery(row)},'Skip this delivery')));
 }
 async function skipDelivery(row){
  const button=$('confirmSkip');if(button.disabled)return;button.disabled=true;button.textContent='Skipping…';
  try{const {order}=await staffJson('POST','orders/'+encodeURIComponent(row.id)+'/skip',{ifVersion:row.version});editing=false;$('orderDialog').close();toast(`${order.business}: delivery skipped`);await load();}
  catch(e){if(e.quiet)return;const box=$('skipError');if(box){box.textContent=e.code==='conflict'?'Someone else changed this order. Close it and open it again.':e.message;box.hidden=false;}button.disabled=false;button.textContent='Skip this delivery';}
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
   $('totalsBody').replaceChildren(SC.skeleton({label:'Loading bag totals…',rows:2}));
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
  if(!$('tabList').hasChildNodes())$('tabList').replaceChildren(SC.skeleton({label:'Loading customer tabs…'}));
  $('tabList').setAttribute('aria-busy','true');
  try{const data=await tabRequest('GET','tabs');if(current!==sequence)return;tabs=data;drawTabs();}
  catch(e){if(!e.quiet&&current===sequence)$('tabList').replaceChildren(el('div',{class:'empty'},'Tabs could not be loaded. Check your connection and try again.'));}
  finally{if(current===sequence)$('tabList').setAttribute('aria-busy','false');}
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
   el('div',{class:'details'},kv('Contact',c.contact),el('div',{class:'kv'},el('span',{},'Email'),c.email?link('mailto:'+c.email,c.email):el('span',{},'None supplied')),c.accountsEmail?el('div',{class:'kv'},el('span',{},'Accounts email'),link('mailto:'+c.accountsEmail,c.accountsEmail)):null,el('div',{class:'kv'},el('span',{},'Phone'),c.phone?link('tel:'+c.phone.replace(/[^\d+]/g,''),c.phone):el('span',{},'None supplied'))),
   el('h3',{class:'packing-heading'},c.locations.length===1?'Delivery location':'Delivery locations'),
   ...c.locations.map(l=>el('div',{class:'detail-note location'},el('b',{},l.name+(l.id===c.defaultLocationId&&c.locations.length>1?' (default)':'')),[l.address,l.postcode].filter(Boolean).join('\n')||'No address saved',(l.contact||l.phone)&&(l.contact!==c.contact||l.phone!==c.phone)?el('span',{class:'row-meta'},[l.contact,l.phone].filter(Boolean).join(' · ')):null,l.deliveryNotes?el('span',{class:'row-meta'},'Delivery notes: '+l.deliveryNotes):null)));
  $('customerDetail').append(el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn',disabled:c.status==='On hold',onclick:()=>{$('customerDialog').close();newOrder(c)}},c.status==='On hold'?'On hold: no new orders':'New order for '+c.business)));
  $('customerDialog').showModal();
 }

 // Taking an order for a customer who emailed, phoned or came to the door. Bags and grinds only: the catalogue's
 // prices apply, as on the ordering site. One request ID per order, kept if the answer is lost, so a retry can't
 // place it twice.
 const kgText=grams=>weight(grams);
 const PACK={quarter:{label:'250 g',grams:250},kilo:{label:'1 kg',grams:1000}};
 async function staffJson(method,path,body){
  const response=await fetch('/api/staff-orders/'+path,{method,cache:'no-store',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>({}));
  if(response.status===403&&data.code!=='account_on_hold'){lock(true);message('You no longer have access to wholesale orders.',{denied:true});throw Object.assign(new Error('No access.'),{quiet:true});}
  if(!response.ok)throw Object.assign(new Error(data.message||'That could not be done. Check your connection and try again.'),{code:data.code,status:response.status});
  return data;
 }
 function newOrder(customer){
  try{
   const p=savedAttempts()[0];
   if(p){draft={customer:{id:p.payload.customerId,business:p.business},pending:{...p,uncertain:true},sending:false,error:''};drawNewOrder();$('newOrderDialog').showModal();return;}
  }catch(e){draft={blockedRecovery:true,error:e.message||'Browser storage is unavailable. Enable it before placing orders, so an interrupted order can be recovered.',sending:false};drawNewOrder();$('newOrderDialog').showModal();return;}
  draft={customer:customer||null,catalogue:null,lines:[],source:'Email',onTab:false,delivery:'Roastery collection',locationId:null,reference:'',note:'',emailCustomer:true,requestId:crypto.randomUUID(),sending:false,error:'',search:'',found:[]};
  drawNewOrder();$('newOrderDialog').showModal();
  if(customer)chooseCustomer(customer);else $('newOrderForm').querySelector('input')?.focus();
 }
 async function findCustomers(q){
  try{const data=await staffJson('GET','customers'+(q?'?q='+encodeURIComponent(q):''));if(!draft||draft.customer)return;draft.found=data.customers.slice(0,30);drawNewOrder(true);}
  catch(e){if(!e.quiet&&draft){draft.error=e.message;drawNewOrder(true);}}
 }
 async function chooseCustomer(c){
  draft.customer=c;draft.catalogue=null;draft.lines=[];draft.error='';draft.locationId=c.defaultLocationId||'primary';draft.emailCustomer=!!c.email&&draft.source==='Email';
  draft.requestId=crypto.randomUUID();drawNewOrder();
  try{const data=await staffJson('GET','catalogue?customer='+encodeURIComponent(c.id));if(!draft||draft.customer?.id!==c.id)return;draft.catalogue=data;draft.lines=[blankLine()];drawNewOrder();}
  catch(e){if(!e.quiet&&draft){draft.error=e.message;drawNewOrder();}}
 }
 function blankLine(st=draft){const p=st.catalogue?.products.find(p=>p.inStock);return {productId:p?.id||'',pack:p?.packs.includes('kilo')?'kilo':p?.packs[0]||'kilo',grind:p?.grinds[0]?.id||'beans',quantity:1};}
 const productOf=(id,st=draft)=>st?.catalogue?.products.find(p=>p.id===id);
 const draftGrams=()=>draft.lines.reduce((sum,l)=>sum+(productOf(l.productId)?(PACK[l.pack]?.grams||0)*(Number(l.quantity)||0):0),0);
 const draftBags=()=>draft.lines.reduce((sum,l)=>sum+(productOf(l.productId)?Number(l.quantity)||0:0),0);
 function lineRow(line,i,st=draft,redraw=drawNewOrder,changed=drawTotals){
  const p=productOf(line.productId,st);
  const coffee=el('select',{'aria-label':`Coffee ${i+1}`,onchange:()=>{line.productId=coffee.value;const np=productOf(line.productId,st);if(np){if(!np.packs.includes(line.pack))line.pack=np.packs[0];if(!np.grinds.some(g=>g.id===line.grind))line.grind=np.grinds[0]?.id||'beans';}redraw();}},
   ...st.catalogue.products.map(x=>el('option',{value:x.id,disabled:!x.inStock,...(x.id===line.productId?{selected:true}:{})},x.title+(x.yours?' (their coffee)':'')+(x.decaf?' · decaf':'')+(x.inStock?'':' · out of stock'))));
  const size=el('select',{'aria-label':`Bag size for coffee ${i+1}`,onchange:()=>{line.pack=size.value;changed()}},...(p?.packs||['kilo']).map(k=>el('option',{value:k,...(k===line.pack?{selected:true}:{})},PACK[k].label)));
  const grind=el('select',{'aria-label':`Grind for coffee ${i+1}`,onchange:()=>{line.grind=grind.value}},...(p?.grinds||[]).map(g=>el('option',{value:g.id,...(g.id===line.grind?{selected:true}:{}),...(g.hint?{title:g.hint}:{})},g.label)));
  const qty=el('input',{type:'number',min:'1',max:'999',step:'1',inputmode:'numeric',value:String(line.quantity),'aria-label':`Bags of coffee ${i+1}`,oninput:()=>{line.quantity=Math.max(0,Math.min(999,Math.floor(Number(qty.value)||0)));changed()}});
  return el('div',{class:'no-line'},el('label',{class:'field no-coffee'},el('span',{},'Coffee'),coffee),el('label',{class:'field'},el('span',{},'Bag'),size),el('label',{class:'field no-grind'},el('span',{},'Grind'),grind),el('label',{class:'field no-qty'},el('span',{},'Bags'),qty),
   st.lines.length>1?el('button',{type:'button',class:'btn soft sm no-remove','aria-label':`Remove coffee ${i+1}`,onclick:()=>{st.lines.splice(i,1);redraw()}},'Remove'):null);
 }
 function drawTotals(){
  const box=$('noTotals');if(!box||!draft?.catalogue)return;
  const grams=draftGrams();
  box.replaceChildren(el('b',{},`${draftBags()} ${draftBags()===1?'bag':'bags'} · ${kgText(grams)}`),el('span',{class:'hint'},'No minimum for orders you take.'));
  const place=$('placeOrder');if(place)place.disabled=draft.sending||!draftBags();
 }
 function drawNewOrder(keepFocus=false){
  if(!draft)return;
  if(draft.pending||draft.blockedRecovery){
   const p=draft.pending;
   $('newOrderForm').replaceChildren(el('h3',{},p?'Check submitted order':'Order recovery unavailable'),
    p?el('p',{},`${p.business} · ${p.payload.lines.reduce((n,l)=>n+l.quantity,0)} bags`):'',
    el('p',{class:'hint'},p?'The submitted bags and request stay fixed until we confirm the outcome. Check the same order again; closing this window or reloading keeps its recovery details for this account.':'Recovery details could not be verified. Check recent orders before trying to place another.'),
    draft.closePrompt?el('p',{class:'detail-note'},'If this order was already saved, it will be recovered. Otherwise the unplaced request will be closed so a delayed copy cannot arrive later. You can then review a new order.'):'',
    draft.error?el('p',{class:'edit-error',role:'alert'},draft.error):'');
   const actions=[el('button',{type:'button',class:'btn soft',onclick:()=>$('newOrderDialog').close()},'Keep for later')];
   if(p&&!draft.removedConfirmed)actions.push(el('button',{type:'button',class:'btn soft',disabled:draft.sending,onclick:()=>{draft.closePrompt=!draft.closePrompt;drawNewOrder();}},draft.closePrompt?'Keep checking':'Close if unplaced'));
   if(p)actions.push(el('button',{type:'button',class:'btn',id:'placeOrder',disabled:draft.sending,onclick:draft.removedConfirmed?()=>{try{removeAttempt(p);draft=null;$('newOrderDialog').close();toast('Removed order acknowledged. You can start a new order.');}catch{draft.error='Recovery details could not be cleared. Try again.';drawNewOrder();}}:draft.closePrompt?closeUnplacedAttempt:placeNewOrder},draft.removedConfirmed?'Acknowledge removal':draft.sending?'Checking…':draft.closePrompt?'Confirm close if unplaced':'Check submitted order'));
   $('newOrderFoot').replaceChildren(el('span',{}),el('div',{class:'edit-actions'},...actions));
   return;
  }
  const form=$('newOrderForm'),c=draft.customer,active=keepFocus?document.activeElement?.id:null;
  const parts=[];
  if(!c){
   const search=el('input',{id:'noSearch',type:'search',maxlength:'120',placeholder:'Business, contact or postcode',value:draft.search,autocomplete:'off','aria-label':'Find the customer',oninput:()=>{draft.search=search.value;clearTimeout(draft.timer);draft.timer=setTimeout(()=>findCustomers(search.value.trim()),250)}});
   parts.push(el('label',{class:'field'},el('span',{},'Customer'),search),
    el('div',{class:'order-list glass no-found',role:'list'},...draft.found.map(x=>el('button',{type:'button',class:'order-row',role:'listitem',disabled:x.status==='On hold',onclick:()=>chooseCustomer(x)},el('span',{},el('b',{},x.business),el('span',{class:'row-meta'},[x.contact,x.locations?.[0]?.postcode].filter(Boolean).join(' · '))),el('span',{class:'row-end'},x.status==='On hold'?pill('On hold'):svg('chev')))),
     !draft.found.length?el('div',{class:'empty'},draft.search?'No matching customers.':'Type to find the customer.'):null));
   if(!draft.found.length&&!draft.search&&!draft.loaded){draft.loaded=true;findCustomers('');}
  }else{
   const locs=c.locations||[],loc=locs.find(l=>l.id===draft.locationId)||locs[0];
   parts.push(el('div',{class:'no-customer'},el('span',{},el('span',{class:'row-meta'},'Customer'),el('b',{},c.business)),el('button',{type:'button',class:'btn soft sm',onclick:()=>{draft.customer=null;draft.catalogue=null;draft.lines=[];draft.found=[];draft.loaded=false;draft.error='';drawNewOrder()}},'Change')));
   const seg=(label,options,value,set)=>el('fieldset',{class:'field no-seg'},el('legend',{},label),el('div',{class:'filters seg',role:'group'},...options.map(([v,t])=>el('button',{type:'button','aria-pressed':String(value===v),onclick:()=>{set(v);drawNewOrder()}},t))));
   parts.push(seg('How it came in',[['Email','Email'],['In person','In person'],['Phone','Phone'],['Other','Other']],draft.source,v=>{draft.source=v;draft.emailCustomer=!!c.email&&v==='Email'}));
   if(!draft.catalogue)parts.push(SC.skeleton({label:'Loading coffees…',rows:2}));
   else{
    parts.push(el('h3',{class:'packing-heading'},'Coffee'),el('div',{class:'no-lines'},...draft.lines.map((l,i)=>lineRow(l,i))),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{draft.lines.push(blankLine());drawNewOrder()}},'Add another coffee'),
     el('div',{class:'no-totals',id:'noTotals','aria-live':'polite'}));
    parts.push(seg('Delivery',[['Roastery collection','Collection'],['Delivery','Delivery']],draft.delivery,v=>{draft.delivery=v}));
    if(locs.length>1||draft.delivery==='Delivery')parts.push(el('label',{class:'field'},el('span',{},'Location'),el('select',{id:'noLocation',onchange:e=>{draft.locationId=e.target.value;drawNewOrder()}},...locs.map(l=>el('option',{value:l.id,...(l.id===loc?.id?{selected:true}:{})},l.name+(l.postcode?' · '+l.postcode:''))))),
     draft.delivery==='Delivery'?el('p',{class:'hint'},loc&&(loc.address||loc.postcode)?[loc.address,loc.postcode].filter(Boolean).join(', '):'No address saved for this location: choose collection, or ask an admin to add it.'):null);
    const ref=el('input',{id:'noRef',maxlength:'80',value:draft.reference,oninput:()=>{draft.reference=ref.value}});
    const note=el('textarea',{id:'noNote',rows:'3',maxlength:'1000',oninput:()=>{draft.note=note.value}});note.value=draft.note;
    parts.push(el('label',{class:'field'},el('span',{},'Their reference (optional)'),ref),el('label',{class:'field'},el('span',{},'Comments from the customer (optional)'),note,el('small',{},'Shown on the order and to the customer. For notes only staff see, add an internal note after placing it.')));
    const mail=el('input',{type:'checkbox',id:'noEmail',disabled:!c.email,...(draft.emailCustomer&&c.email?{checked:true}:{}),onchange:()=>{draft.emailCustomer=mail.checked}});
    parts.push(el('label',{class:'check'},mail,el('span',{},c.email?`Email ${c.business} a confirmation (${c.email})`:'No email saved, so no confirmation can be sent')));
    const tab=el('input',{type:'checkbox',id:'noTab',disabled:!!draft.catalogue.autoTab,...(draft.onTab||draft.catalogue.autoTab?{checked:true}:{}),onchange:()=>{draft.onTab=tab.checked}});
    parts.push(el('label',{class:'check'},tab,el('span',{},draft.catalogue.autoTab?`Goes on ${c.business}'s tab (their orders always do)`:`Put it on ${c.business}'s tab`)));
   }
  }
  if(draft.error)parts.push(el('p',{class:'edit-error',role:'alert'},draft.error));
  form.replaceChildren(...parts);
  $('newOrderFoot').replaceChildren(el('span',{class:'hint'},c&&draft.catalogue?'Today\'s prices apply. It goes on the Slack orders channel like any order.':''),
   el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',onclick:()=>$('newOrderDialog').close()},'Cancel'),
    c&&draft.catalogue?el('button',{type:'button',class:'btn',id:'placeOrder',onclick:placeNewOrder},draft.sending?'Placing…':'Place order'):null));
  drawTotals();
  if(active)$(active)?.focus();
 }
 async function closeUnplacedAttempt(){
  const current=draft,p=current?.pending;if(!p||current.sending||p.identity!==orderingIdentity)return;
  current.sending=true;current.error='';drawNewOrder();
  try{
   const id='WS-'+p.payload.requestId.replaceAll('-','').toUpperCase();
   const result=await staffJson('POST','attempts/'+id+'/close',{customerId:p.payload.customerId});
   if(!started||p.identity!==orderingIdentity)return;
   if(result.order){current.sending=false;current.closePrompt=false;p.uncertain=true;if(draft?.pending?.payload.requestId===p.payload.requestId)await placeNewOrder();return;}
   if(result.closed!==true)throw new Error('The outcome could not be verified. Check the submitted order again.');
   removeAttempt(p);if(draft?.pending?.payload.requestId===p.payload.requestId){draft=null;$('newOrderDialog').close();toast('Unplaced request closed. You can review a new order.');}
  }catch(e){if(e.quiet||!started||p.identity!==orderingIdentity)return;current.sending=false;current.closePrompt=false;current.error=e.message;if(draft===current)drawNewOrder();}
 }
 async function placeNewOrder(){
  if(!draft?.customer||draft.sending)return;
  const current=draft;
  if(!current.pending){
   const lines=current.lines.filter(l=>productOf(l.productId)&&l.quantity>0).map(l=>({productId:l.productId,pack:l.pack,grind:l.grind,quantity:l.quantity}));
   if(!lines.length){current.error='Add at least one bag.';drawNewOrder();return;}
   try{
    if(savedAttempts().length){newOrder(current.customer);return;}
    current.pending={identity:orderingIdentity,business:current.customer.business,at:Date.now(),uncertain:false,payload:{requestId:current.requestId,customerId:current.customer.id,source:current.source,emailCustomer:current.emailCustomer,onTab:current.onTab,lines,delivery:current.delivery,locationId:current.locationId||'primary',reference:current.reference.trim(),customerNote:current.note.trim()}};
    retainAttempt(current.pending); // Persist before POST. Failure here must never create an order.
   }catch{current.pending=null;current.error='This browser could not save order recovery details. Enable browser storage, then try again.';drawNewOrder();return;}
  }
  const attempt=current.pending,wasUncertain=attempt.uncertain;
  const receiptPath='orders/WS-'+attempt.payload.requestId.replaceAll('-','').toUpperCase()+'/receipt';
  current.sending=true;current.error='';drawNewOrder();
  const finish=async order=>{
   if(!order||order.id!=='WS-'+attempt.payload.requestId.replaceAll('-','').toUpperCase()||order.customerId!==attempt.payload.customerId)throw new Error('The saved order receipt could not be verified. Check the same submitted order again.');
   if(!started||attempt.identity!==orderingIdentity)return;
   try{removeAttempt(attempt);}catch{current.error='Order confirmed, but recovery details could not be cleared. Check the same order again before starting another.';current.sending=false;if(draft===current)drawNewOrder();return;}
   if(draft?.pending?.payload.requestId!==attempt.payload.requestId)return;
   draft=null;$('newOrderDialog').close();toast(`Order placed for ${attempt.business}`);
   status='open';$('search').value='';if(view!=='orders')showView('orders');await load();if(rows.some(r=>r.id===order.id))openOrder(order.id);
  };
  try{
   if(wasUncertain){
    try{const {order}=await staffJson('GET',receiptPath);await finish(order);return;}
    catch(e){if(e.status!==404)throw e;}
   }
   const {order}=await staffJson('POST','orders',attempt.payload);await finish(order);
  }catch(e){
   if(e.quiet||!started||attempt.identity!==orderingIdentity)return;
   current.sending=false;
   if(e.status===410&&e.code==='order_deleted'){current.removedConfirmed=true;current.error=e.message;if(draft===current)drawNewOrder();return;}
   // Even a refused retry cannot exclude an older in-flight POST in another tab.
   // Only an owned receipt or atomic close-if-unplaced resolves the original ID.
   if(e.status&&e.status<500)try{const {order}=await staffJson('GET',receiptPath);await finish(order);return;}catch(check){if(check.quiet)return;if(check.status===410){current.removedConfirmed=true;current.error=check.message;if(draft===current)drawNewOrder();return;}}
   attempt.uncertain=true;try{retainAttempt(attempt);}catch{}
   current.error=e.status?e.message:'The result is not confirmed. Check the submitted order again to recover it, or retry the identical request.';
   if(draft===current)drawNewOrder();
  }
 }
 async function loadCustomers(){
  const current=sequence;
  if(!$('customerList').hasChildNodes())$('customerList').replaceChildren(SC.skeleton({label:'Loading customers…'}));
  $('customerList').setAttribute('aria-busy','true');
  try{
   const q=$('customerSearch').value.trim(),response=await fetch('/api/staff-orders/customers'+(q?'?q='+encodeURIComponent(q):''),{cache:'no-store'});
   if(current!==sequence)return;
   if(response.status===403){lock(true);message('You do not have access to wholesale orders. Ask an admin to enable it.',{denied:true});return;}
   const data=await response.json();if(!response.ok||!Array.isArray(data.customers))throw new Error();
   if(current!==sequence)return;customers=data.customers;customersMore=!!data.more;drawCustomers();
  }catch{if(current===sequence)$('customerList').replaceChildren(el('div',{class:'empty'},'Customers could not be loaded. Check your connection and try again.'));}
  finally{if(current===sequence)$('customerList').setAttribute('aria-busy','false');}
 }
 function showView(next){
  view=next;$('ordersView').hidden=view!=='orders';$('customersView').hidden=view!=='customers';$('tabsView').hidden=view!=='tabs';
  for(const b of $('viewTabs').querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
  SC.reveal($(view+'View'));
  if(view==='customers')loadCustomers();
  if(view==='tabs')loadTabs();
 }

 // A link to one order (the new-order email's button: /orders#WS-…) opens it, searching all orders if needed.
 async function openFromLink(){
  if(location.hash==='#tabs'){history.replaceState(null,'',location.pathname+location.search);showView('tabs');return;}
  if(location.hash==='#new'){history.replaceState(null,'',location.pathname+location.search);newOrder(null);return;}
  const id=decodeURIComponent(location.hash.slice(1));if(!/^WS-[A-F0-9]{32}$/.test(id))return;
  history.replaceState(null,'',location.pathname+location.search);
  if(!rows.some(r=>r.id===id)){status='all';$('search').value=id;await load();}
  if(rows.some(r=>r.id===id))openOrder(id);else toast('That order could not be found.');
 }
 async function load({more=false,reverify=false}={}){
  if(!started)return;
  const current=++sequence,wasOpen=$('orderDialog').open,wasSelected=selected;
  if(reverify){lock();$('accessStatus').hidden=false;$('accessStatus').replaceChildren(SC.skeleton({label:'Checking access…'}));}
  const key=status+'|'+$('search').value.trim(),changed=key!==ordersKey;ordersKey=key;
  if(!more&&changed)$('orderList').replaceChildren(SC.skeleton({label:'Loading orders…'}));
  $('orderList').setAttribute('aria-busy','true');
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
   draw();$('accessStatus').hidden=true;$('ordersContent').hidden=false;document.documentElement.removeAttribute('data-orders-locked');if(changed||reverify)SC.reveal($('orderList'));
   if(wasOpen&&wasSelected){const row=rows.find(row=>row.id===wasSelected);if(row){selected=row.id;renderDetail(row);if(!$('orderDialog').open)$('orderDialog').showModal()}else{$('orderDialog').close();selected=null;}}
   if(reverify&&view==='customers')loadCustomers();
   if(view==='tabs')loadTabs();
  }catch(error){if(current===sequence){lock(true);message('Orders could not be verified. Reconnect, then try again.',{retry:true});}}
  finally{if(current===sequence){$('orderList').setAttribute('aria-busy','false');$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');$('loadMore').disabled=false;}}
 }
 $('refresh').onclick=()=>load({reverify:true});$('loadMore').onclick=()=>load({more:true});
 $('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250)};
 $('customerSearch').oninput=()=>{clearTimeout(customerTimer);customerTimer=setTimeout(loadCustomers,250)};
 for(const b of $('viewTabs').querySelectorAll('button'))b.onclick=()=>showView(b.dataset.view);
 $('closeOrder').onclick=$('doneOrder').onclick=()=>{$('orderDialog').close()};
 $('orderDialog').addEventListener('close',()=>{selected=null;editing=false;amend=null;$('orderEdit').replaceChildren()});
 $('closeCustomer').onclick=$('doneCustomer').onclick=()=>$('customerDialog').close();
 $('refreshTabs').onclick=()=>load({reverify:true});$('closeTab').onclick=()=>$('tabDialog').close();$('tabDialog').addEventListener('close',()=>{tabSelected=null;tabConfirm=false;});
 $('closeTotals').onclick=()=>$('totalsDialog').close();
 $('newOrder').onclick=()=>newOrder(null);$('closeNewOrder').onclick=()=>$('newOrderDialog').close();
 $('newOrderDialog').addEventListener('close',()=>{if(draft&&!draft.sending)draft=null;});
 $('newOrderForm').addEventListener('submit',e=>e.preventDefault());
 // Printing moves focus to the print dialog: that isn't leaving the page, so it doesn't lock it.
 let printing=false;addEventListener('beforeprint',()=>{printing=true});addEventListener('afterprint',()=>{setTimeout(()=>{printing=false},500)});
 addEventListener('blur',()=>{if(printing)return;sequence++;lock();});addEventListener('pagehide',()=>{sequence++;lock();});
 addEventListener('focus',()=>{if(started&&!printing)load({reverify:true})});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){sequence++;lock()}else if(started)load({reverify:true})});
 addEventListener('pageshow',event=>{if(event.persisted&&started)load({reverify:true})});addEventListener('online',()=>load({reverify:true}));
 SC.recheckOnPageshow();
 (async()=>{const me=await SC.startSession({clear:()=>{sequence++;started=false;orderingIdentity=null;clearInterval(timer);lock(true)}});if(!me)return;orderingIdentity=me.user.id;$('signedIn').textContent=me.user.name;started=true;await load({reverify:true});if(started){try{if(savedAttempts().length)newOrder(null);else await openFromLink();}catch{newOrder(null);}}timer=setInterval(()=>{if(started&&!document.hidden&&!editing&&!busy.size)load()},15000)})();
})();
