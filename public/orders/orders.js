// The staff wholesale orders page, for accounts an admin has given wholesale orders access: orders and packing
// details, status / internal note / tracking changes (version-checked, online only, never queued), printing orders
// and bags to process, and customers' contact and delivery details (read-only). No prices. Nothing is stored
// locally except an identity-bound, frozen pending order used to recover uncertain submissions.
// The tab's remembered view, order status and date scope contain only navigation identifiers.
// Private views are cleared or hidden when the session can't be verified.
(()=>{
 'use strict';
 const {el,svgi}=SC,{grindFor,decafLine,iconPaths,coffeeStyle}=SCWholesalePreparation,packing=SCWholesalePacking;
 const $=id=>document.getElementById(id);
 const wideDesk=matchMedia('(min-width: 1240px)');
 const packProblems=new Map();
 let activeOrder=null,heldOrder=null,mobilePacking=false,deskTotals=null,totalsMode='remaining',dispatchReview=null,totalsSequence=0;
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
 const VIEWS=new Set(['orders','tabs','customers']);
 const NEXT={New:['Preparing','Mark preparing'],Preparing:['Ready','Mark ready'],Ready:['Dispatched','Mark dispatched']};
 let rows=[],cursor=null,total=0,status='open',selected=null,sequence=0,timer=null,searchTimer=null,customerTimer=null,started=false;
 let view='orders',baseView='orders',pendingViewRoute=false,staffLinks,staffName='',workspaceAccess=false,customers=[],customersMore=false,customerRequest=0,picking=false,busy=new Set(),editing=false;
 let ordersKey='';
 const findOrder=id=>rows.find(row=>row.id===id)||(heldOrder?.id===id?heldOrder:null);
 let tabs={open:[],cleared:[],threshold:6000},tabSelected=null,tabConfirm=false;
 const picked=new Set();
 let draft=null; // the order being taken for a customer (in memory only)
 let batch=null; // {status, confirm, running, done} while marking selected orders
 const weight=grams=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(grams/1000)+' kg';
 const date=at=>new Date(at).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const dispatchDay=day=>new Date(day+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
 const pill=value=>el('span',{class:'pill '+String(value).toLowerCase().replaceAll(' ','-')},value);
 const dialogs=['dispatchDialog','orderDialog','customerDialog','totalsDialog','tabDialog','newOrderDialog'].map($);
 function openDialog(dialog){
  dialog.showModal();
  dialog.querySelector('.dialog-body').scrollTop=0;
  const heading=dialog.querySelector('.dialog-head h2');
  heading.tabIndex=-1;
  heading.focus({preventScroll:true});
 }
 function closeDialogs(){for(const dialog of dialogs)if(dialog.open)dialog.close();}
 // At a modal boundary some browsers tab into their chrome and fire the session-protecting blur handler.
 for(const dialog of dialogs)dialog.addEventListener('keydown',event=>{
  if(event.key!=='Tab'||event.defaultPrevented)return;
  const controls=[...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length);
  if(!controls.length)return;
  const index=controls.indexOf(document.activeElement);
  if(event.shiftKey?index>0:index<controls.length-1)return;
  event.preventDefault();
  controls[event.shiftKey?controls.length-1:0].focus();
 });
 function lock(clear=false){
  document.documentElement.setAttribute('data-orders-locked','');closeDialogs();
  if(clear){rows=[];customers=[];customerRequest++;tabs={open:[],cleared:[],threshold:6000};tabSelected=null;$('tabList').replaceChildren();$('clearedList').replaceChildren();$('tabDetail').replaceChildren();selected=null;cursor=null;picked.clear();picking=false;editing=false;batch=null;
   activeOrder=heldOrder=null;mobilePacking=false;deskTotals=null;totalsSequence++;packProblems.clear();dispatchReview=null;
   for(const id of ['orderList','orderDetail','orderEdit','orderDialogAction','mobilePacking','packingDesk','deskBagTotals','deskDispatchBody','customerList','customerDetail','customerActions','customerCount','tabCount','totalsBody','newOrderForm','newOrderFoot'])$(id).replaceChildren();draft=null;
   $('signedIn').textContent='';$('signedInInitials').textContent='';$('signedInInitials').removeAttribute('aria-label');
   $('signedInInitials').hidden=true;$('ordersContent').hidden=true;}
 }
 function renderIdentity(){
  $('signedIn').textContent=staffName;
  $('signedInInitials').textContent=SC.initials(staffName);
  $('signedInInitials').setAttribute('aria-label','Signed in as '+staffName);
  $('signedInInitials').hidden=false;
 }
 function message(text,{retry=false,denied=false}={}){
  if(denied&&workspaceAccess){workspaceAccess=false;SCStaffNavigation.render('orders',staffLinks,false);}
  $('accessStatus').hidden=false;$('accessStatus').replaceChildren(el('p',{},text),retry?el('button',{type:'button',class:'btn',onclick:()=>load({reverify:true})},'Try again'):null,denied?el('a',{href:'/'},'Back to Kitchen Diary'):null);
 }
 const toast=SC.makeToast(3500);
 function warning(account,banner=false){
  const container=el('div',{class:banner?'account-banners':'account-warnings'});
  if(account?.overdue)container.append(el('div',{class:banner?'account-banner':'account-warning'},svg('warn'),el('span',{},banner?'This business has overdue invoices. Ask an admin to check payment before fulfilment.':'Account overdue')));
  if(account?.review)container.append(el('div',{class:(banner?'account-banner':'account-warning')+' review'},svg('info'),el('span',{},banner?'An invoice balance is unconfirmed. Ask an admin to confirm the account.':'Balance unconfirmed')));
  return container;
 }

 // Orders: the list, with a quick next step on each, or ticking orders to print.
 function printBar(){
  return picking
   ?el('div',{class:'print-bar picking',role:'region','aria-label':'Choose orders'},el('span',{class:'picked-count','aria-live':'polite'},picked.size?`${picked.size} selected`:'Tap orders to select them'),
     el('button',{type:'button',class:'btn soft sm',disabled:!!batch?.running,onclick:()=>{if(batch?.running)return;for(const row of rows)picked.add(row.id);draw()}},'Select all shown'),
     el('button',{type:'button',class:'btn soft sm',disabled:!picked.size,onclick:()=>openTotals([...picked])},'Bag totals'),
     el('button',{type:'button',class:'btn sm',disabled:!picked.size,onclick:()=>printScope({ids:[...picked],label:`${picked.size} selected ${picked.size===1?'order':'orders'}`})},svg('doc'),'Print selected'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{if(batch?.running)return;picking=false;picked.clear();batch=null;draw()}},'Done'))
   :el('div',{class:'print-bar'},el('button',{type:'button',class:'btn soft sm',onclick:()=>printScope({status:'New',label:'New orders'})},svg('doc'),'Print new orders'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>{picking=true;picked.clear();batch=null;draw();$('orderList').querySelector('[data-order-id]')?.focus()}},'Select orders'),
     el('button',{type:'button',class:'btn soft sm',onclick:()=>openTotals([])},'Bags to process'));
 }
 // Dispatch day and standing order, set in Admin ("Dispatch Fri 20 Nov · Standing order, every 2 weeks").
 const dispatchText=(row)=>[row.dispatchDate?'Dispatch '+dispatchDay(row.dispatchDate):'',row.standingEvery?`Standing order, every ${row.standingEvery===1?'week':row.standingEvery+' weeks'}`:''].filter(Boolean).join(' · ');
 function orderRow(row){
  const chosen=picked.has(row.id),next=NEXT[row.status],working=busy.has(row.id);
  const bags=`${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)}`;
  const byOrdered=$('orderSort').value.startsWith('ordered'),ordered='Ordered '+new Date(row.createdAt).toLocaleDateString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short'});
  const deskMeta=[byOrdered?ordered:'',row.locationName===row.business?'':row.locationName,row.delivery==='Roastery collection'?'Collection':row.delivery,row.dispatchDate?dispatchDay(row.dispatchDate):'Unscheduled',row.customerNote||row.note?'Note':''].filter(Boolean).join(' · ');
  const main=el('button',{type:'button',class:'order-row'+(picking?' is-picking':''),'data-order-id':row.id,...(picking?{'aria-pressed':String(chosen)}:wideDesk.matches?{'aria-current':row.id===activeOrder?'true':'false'}:{}),onclick:()=>picking?togglePick(row.id):wideDesk.matches?chooseDeskOrder(row.id):openOrder(row.id)},
   picking?el('span',{class:'pick '+(chosen?'on':'off'),'aria-hidden':'true'},chosen?svg('ok'):null):null,
   el('span',{class:'queue-label'},el('b',{},row.business),el('span',{class:'row-desktop-meta'},deskMeta),el('span',{class:'row-meta'},`${row.locationName===row.business?'':row.locationName+' · '}${row.delivery} · ${bags}`),dispatchText(row)?el('span',{class:'row-meta row-dispatch'},dispatchText(row)):null,!dispatchText(row)||byOrdered?el('span',{class:'row-meta'},date(row.createdAt)):null,row.onTab?el('span',{class:'row-meta row-tab'},'On tab'):null,row.note?el('span',{class:'row-meta row-note'},'Note: '+row.note):null,warning(row.account)),
   el('span',{class:'row-end'},pill(row.status),el('span',{class:'row-desktop-meta'},bags),picking?null:svg('chev')));
  return el('div',{class:'order-entry'+(picking?' is-picking':''),'aria-busy':String(working)},main,!picking&&next?el('button',{type:'button',class:'btn soft quick','data-quick':row.id,disabled:working,onclick:()=>quick(row.id)},working?'Saving…':next[1]):null);
 }
 // Batch actions: mark every selected order preparing, ready or dispatched, one at a time against the version on
 // screen (the same save as a single order, so dispatch emails and standing orders work as usual). Orders only move
 // forward; ones already there or further on are left alone. Dispatching asks once more (customers are emailed).
 const FLOW=['New','Preparing','Ready','Dispatched'];
 const BATCH=[['Preparing','Mark preparing'],['Ready','Mark ready'],['Dispatched','Mark dispatched']];
 const movable=(row,to)=>FLOW.includes(row.status)&&FLOW.indexOf(row.status)<FLOW.indexOf(to);
 function batchBar(){
  const bar=$('batchBar');bar.hidden=!picking;if(!picking){bar.replaceChildren();return;}
  const chosen=rows.filter(r=>picked.has(r.id));
  if(batch?.confirm&&!batch.running){
   const n=chosen.filter(r=>movable(r,batch.status)).length;
   bar.replaceChildren(el('span',{class:'batch-label'},`Mark ${n} ${n===1?'order':'orders'} dispatched? Customers are emailed that their order has been shipped or collected.`),
    el('button',{type:'button',class:'btn sm',id:'batchConfirm',onclick:()=>runBatch('Dispatched')},`Dispatch ${n}`),
    el('button',{type:'button',class:'btn soft sm',onclick:()=>{batch=null;batchBar()}},'Cancel'));
   bar.querySelector('#batchConfirm').focus({preventScroll:true});return;
  }
  bar.replaceChildren(el('span',{class:'batch-label'},batch?.running?`Saving ${batch.done} of ${batch.total}…`:'Selected orders:'),
   ...BATCH.map(([to,label])=>{const n=chosen.filter(r=>movable(r,to)).length;return el('button',{type:'button',class:'btn soft sm','data-batch':to,disabled:!n||!!batch?.running,onclick:()=>{if(to==='Dispatched'){batch={status:to,confirm:true};batchBar();}else runBatch(to);}},n?`${label} (${n})`:label);}));
 }
 async function runBatch(to){
  const targets=rows.filter(r=>picked.has(r.id)&&movable(r,to)).map(r=>({...r}));if(!targets.length||batch?.running)return;
  const operation={status:to,running:true,done:0,total:targets.length},owner=orderingIdentity;
  batch=operation;const active=()=>batch===operation&&started&&orderingIdentity===owner;batchBar();
  let saved=0,failed=0,conflict=false,lost=false;
  for(const row of targets){
   if(!active())return;busy.add(row.id);
   try{await patch(row,{status:to});if(!active())return;saved++;picked.delete(row.id);}
   catch(e){if(e.quiet||!active())lost=true;else{failed++;if(e.code==='conflict')conflict=true;}}
   finally{busy.delete(row.id);operation.done++;}
   if(lost||!active())return;
   if(started)draw();
  }
  if(!active())return;batch=null;
  if(failed)await load();else draw();
  const word=to.toLowerCase();
  toast(failed?`${saved} confirmed ${word}. ${failed} need checking${conflict?' (changed elsewhere)':''}; review the refreshed orders before trying again.`:`${saved} ${saved===1?'order':'orders'} marked ${word}.`);
 }
 function togglePick(id){if(batch?.running)return;picked.has(id)?picked.delete(id):picked.add(id);draw();document.querySelector(`[data-order-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
 function draw(){
  const choices=wideDesk.matches?[filters[0],['prepare','To pack'],...filters.slice(1)]:filters;
  if(!findOrder(activeOrder))activeOrder=rows[0]?.id||null;
  const active=document.activeElement;
  const filter=active?.dataset.orderFilter;
  const orderId=active?.dataset.orderId;
  $('orderStatus').value=status;
  $('statusFilters').replaceChildren(...choices.map(([id,label])=>el('button',{type:'button','data-order-filter':id,'aria-pressed':String(status===id),onclick:()=>{status=id;saveNavigation();load()}},label)));
  $('printBar').replaceChildren(printBar());batchBar();
  $('orderCount').textContent=rows.length<total?`${rows.length} of ${total} orders`:`${total} ${total===1?'order':'orders'}`;
  $('orderList').replaceChildren(...rows.map(orderRow));
  if(!rows.length)$('orderList').append(el('div',{class:'empty'},$('search').value.trim()?'No matching orders. Try another search or status.':'No orders in this view.'));
  $('loadMore').hidden=!cursor;
  drawDesk();
  if(filter)$('statusFilters').querySelector(`[data-order-filter="${CSS.escape(filter)}"]`)?.focus({preventScroll:true});
  if(orderId)$('orderList').querySelector(`[data-order-id="${CSS.escape(orderId)}"]`)?.focus({preventScroll:true});
 }
 function chooseDeskOrder(id){
  if(heldOrder?.id!==id)heldOrder=null;
  activeOrder=id;
  for(const button of $('orderList').querySelectorAll('[data-order-id]'))button.setAttribute('aria-current',String(button.dataset.orderId===id));
  drawDesk();
  SC.reveal($('packingDesk').querySelector('.desk-panel-body'));
 }
 // Ticks show at once and save in the background (packQueue in public/shared/wholesale-packing.js).
 const ticks=packing.packQueue({
  get:id=>findOrder(id),
  send:async(order,lines)=>{
   const owner=orderingIdentity;
   const {order:saved}=await staffJson('PATCH','orders/'+encodeURIComponent(order.id)+'/packing',{ifVersion:order.version,packedLines:lines});
   if(owner!==orderingIdentity||!started)throw Object.assign(new Error('The signed-in account changed.'),{quiet:true});
   return saved;
  },
  saved:order=>{
   const index=rows.findIndex(item=>item.id===order.id);
   if(index>=0&&rows[index].version<=order.version)rows[index]=order;
   if(heldOrder?.id===order.id&&heldOrder.version<=order.version)heldOrder=order;
  },
  failed:(id,error)=>packProblems.set(id,(error.message||'Could not save the ticks.')+' Reload the order to see what was saved.'),
  redraw:id=>{if(!started)return;renderPackingProgress(id);if(!ticks.saving(id))loadDeskTotals();}
 });
 async function packAdvance(id){
  if(!(await ticks.settle(id)))return;
  const row=findOrder(id);if(!row)return;
  if(row.status==='Ready')reviewDispatch(row);else saveDeskProgress(row,{status:NEXT[row.status]?.[0]});
 }
 async function packBack(id,to){
  if(!(await ticks.settle(id)))return;
  const row=findOrder(id);if(!row||packing.BACK[row.status]!==to||!packing.confirmBack(row,to))return;
  saveDeskProgress(findOrder(id)||row,{status:to},null,true);
 }
 function packingControls(row){
  return packing.checklist(ticks.view(row),{
   busy:busy.has(row.id),saving:ticks.saving(row.id),problem:packProblems.get(row.id)||'',
   change:(line,packed)=>{const latest=findOrder(row.id);if(latest)ticks.tick(latest,line,packed);},
   all:lines=>{const latest=findOrder(row.id);if(latest)ticks.set(latest,lines);},
   advance:()=>packAdvance(row.id),
   back:to=>packBack(row.id,to),
   refresh:async()=>{ticks.forget(row.id);await load();if(findOrder(row.id)){packProblems.delete(row.id);renderPackingProgress(row.id);}}
  });
 }
 function packingOrderBody(row,mobile=false){
  return el('div',{class:mobile?'mobile-pack-body':'desk-panel-body'},
   el('div',{class:'business-title'},el('h3',mobile?{}:{id:'deskBusiness',tabindex:'-1'},row.business),pill(row.status)),
   el('p',{class:'desk-meta'},[row.reference,row.locationName===row.business?'':row.locationName,`${row.packs} ${row.packs===1?'bag':'bags'}`,weight(row.grams)].filter(Boolean).join(' · ')),
   packing.stageTrack(row.status),warning(row.account,true),
   el('div',{class:'desk-destination'},el('b',{},row.delivery),el('span',{},dispatchText(row)||'No dispatch date set'),
    row.delivery==='Delivery'&&(row.address||row.postcode)?el('span',{},[row.address,row.postcode].filter(Boolean).join(', ')):null),
   ...[['Customer comments',row.customerNote],['Delivery notes',row.deliveryNotes],['Internal note',row.note]].filter(([,note])=>note).map(([label,note])=>el('p',{class:'wp-work-note'},el('b',{},label),note)),
   packingControls(row),
   mobile?null:el('div',{class:'desk-order-actions'},el('button',{type:'button',class:'btn sm soft',onclick:()=>openOrder(row.id)},'Open order'),el('button',{type:'button',class:'btn sm soft',onclick:()=>printOne(row.id)},svg('doc'),'Print order')));
 }
 function drawDesk(){
  if(!wideDesk.matches)return;
  const host=$('packingDesk'),row=findOrder(activeOrder);
  const advance=rows.filter(item=>item.id!==activeOrder&&['New','Preparing'].includes(item.status));
  const next=advance.find(item=>rows.indexOf(item)>rows.indexOf(row))||advance[0];
  const focused=document.activeElement;
  const line=host.contains(focused)?focused.dataset.packLine:undefined;
  const nextFocused=host.contains(focused)&&focused.hasAttribute('data-pack-next');
  host.replaceChildren(el('header',{class:'panel-head'},el('h2',{},'Active order'),next?el('button',{type:'button',class:'btn soft sm',onclick:()=>{chooseDeskOrder(next.id);$('deskBusiness').focus({preventScroll:true});}},'Next to pack'):null));
  if(row)host.append(packingOrderBody(row));
  else host.append(el('p',{class:'empty'},'Choose an order to start packing.'));
  if(line!==undefined)host.querySelector(`[data-pack-line="${line}"]:enabled`)?.focus({preventScroll:true});
  if(nextFocused)host.querySelector('[data-pack-next]:enabled')?.focus({preventScroll:true});
 }
 function drawDeskTotals(){
  if(!wideDesk.matches)return;
  const host=$('deskBagTotals'),current=deskTotals?.[totalsMode]||[];
  const focusedMode=host.contains(document.activeElement)?document.activeElement.dataset.totalsMode:null;
  const toggle=el('div',{class:'filters desk-totals-switch',role:'group','aria-label':'Bag totals status'},...Object.entries({remaining:'To pack',packed:'Packed'}).map(([mode,label])=>el('button',{type:'button','data-totals-mode':mode,'aria-pressed':String(mode===totalsMode),onclick:()=>{totalsMode=mode;drawDeskTotals();}},label)));
  const scope=$('orderDispatchScope').selectedOptions[0].textContent;
  const count=current.reduce((sum,line)=>sum+line.quantity,0);
  host.replaceChildren(el('header',{class:'panel-head'},el('h2',{},'Bag totals')),
   el('div',{class:'desk-panel-body'},toggle,el('p',{class:'desk-meta'},'Open orders · '+scope),
    deskTotals===null?SC.skeleton({label:'Loading bag totals…',rows:2}):
    deskTotals.error?el('div',{class:'desk-totals-empty'},el('p',{},'Bag totals could not be loaded.'),el('button',{type:'button',class:'btn sm soft',onclick:loadDeskTotals},'Retry')):
    el('div',{class:'desk-bag-summary'},el('div',{class:'desk-total-line'},el('p',{class:'desk-total'},el('strong',{},String(count)),count===1?' bag':' bags'),count?el('b',{class:'desk-meta'},weight(current.reduce((sum,line)=>sum+line.grams*line.quantity,0))):null),
     current.length?el('ul',{class:'desk-bag-list'},...current.map(line=>el('li',{},el('span',{},el('b',{},line.title),el('small',{},line.packLabel+' · '+grindFor(line).label)),el('strong',{},'× '+line.quantity)))):el('p',{class:'desk-meta'},totalsMode==='packed'?'No bags packed in open orders.':'No bags left to pack.'))));
  if(focusedMode)toggle.querySelector(`[data-totals-mode="${CSS.escape(focusedMode)}"]`)?.focus({preventScroll:true});
 }
 async function loadDeskTotals(){
  if(!wideDesk.matches||view!=='orders')return;
  const request=++totalsSequence,owner=orderingIdentity,scope=$('orderDispatchScope').value;
  try{
   const result=await staffJson('GET','packing-totals?'+new URLSearchParams({dispatch:scope}));
   if(request!==totalsSequence||owner!==orderingIdentity)return;
   if(!Array.isArray(result.remaining)||!Array.isArray(result.packed))throw new Error('Bag totals could not be verified.');
   deskTotals=result;
  }catch(error){
   if(request!==totalsSequence||owner!==orderingIdentity||error.quiet)return;
   deskTotals={error:true};
  }
  drawDeskTotals();
 }
 function renderPackingProgress(id){
  if(id===activeOrder)drawDesk();
  if(id===selected&&mobilePacking){
   const row=findOrder(id);
   if(row)$('mobilePacking').replaceChildren(packingOrderBody(row,true));
  }
 }
 function setMobilePacking(active){
  mobilePacking=active;
  $('mobilePacking').hidden=!active;
  $('orderDetail').hidden=$('orderEdit').hidden=active;
  $('orderDialogAction').hidden=active;
  $('orderTitle').textContent=active?'Pack order':'Order details';
  $('doneOrder').textContent=active?'Back to details':'Done';
  if(active)renderPackingProgress(selected);
  else $('mobilePacking').replaceChildren();
 }
 async function saveDeskProgress(row,change,report,back=false){
  if(busy.has(row.id)||packProblems.has(row.id)||row.version!==findOrder(row.id)?.version)return false;
  const owner=orderingIdentity;
  const focusHost=mobilePacking&&selected===row.id?$('mobilePacking'):$('packingDesk');
  busy.add(row.id);renderPackingProgress(row.id);
  try{
   if(change.status){
    const order=await patch(row,change.status==='Ready'?{...change,requirePacked:true}:change);
    if(change.status!=='Dispatched'&&(activeOrder===row.id||selected===row.id))heldOrder={...order,account:row.account};
   }
   else{
    const {order}=await staffJson('PATCH','orders/'+encodeURIComponent(row.id)+'/packing',{ifVersion:row.version,...change});
    if(owner!==orderingIdentity||!started)return false;
    if(order?.id!==row.id||order.status!=='Preparing'||!Number.isSafeInteger(order.version)||order.version<row.version||!Array.isArray(order.packedLines)||order.packedLines.includes(change.line)!==change.packed)throw new Error('The packing update could not be confirmed.');
    const index=rows.findIndex(item=>item.id===row.id);
    if(index>=0&&rows[index].version<=order.version)rows[index]=order;
    if(heldOrder?.id===row.id&&heldOrder.version<=order.version)heldOrder=order;
   }
   if(owner!==orderingIdentity||!started)return false;
   if(change.status){
    toast(back?`${row.business}: moved back to ${change.status==='New'?'Received':change.status}`:`${row.business}: ${change.status}`);draw();
    if(change.status==='Dispatched'){heldOrder=null;await load();}
    else if(back)await load();
    else if(selected===row.id&&mobilePacking)renderDetail(findOrder(row.id));
   }
   loadDeskTotals();return true;
  }catch(error){
   if(owner!==orderingIdentity||!started||error.quiet)return false;
   packProblems.set(row.id,error.message||'Could not confirm the update. Reload the order.');
   if(report)report(packProblems.get(row.id));
   return false;
  }finally{
   busy.delete(row.id);
   if(owner===orderingIdentity&&started){
    renderPackingProgress(row.id);
    const selector=change.status?'[data-pack-next]:enabled':`[data-pack-line="${change.line}"]:enabled`;
    const target=focusHost.querySelector(selector)||focusHost.querySelector('.wp-pack-problem button');
    if(document.activeElement===document.body)target?.focus({preventScroll:true});
   }
  }
 }
 function reviewDispatch(row,changes={}){
  if(busy.has(row.id))return;
  const collection=row.delivery==='Roastery collection';
  dispatchReview={row,changes};
  $('deskDispatchTitle').textContent=collection?'Confirm collection':'Confirm dispatch';
  $('confirmDeskDispatch').textContent=collection?'Mark collected':'Mark dispatched';
  $('confirmDeskDispatch').disabled=false;
  const tracking=collection?null:el('label',{class:'field'},el('span',{},'Tracking link (optional)'),el('input',{id:'deskTracking',type:'url',inputmode:'url',maxlength:'500',placeholder:'https://…',value:changes.trackingUrl??row.trackingUrl??''}));
  const destination=[row.address,row.postcode].filter(Boolean).join(', ');
  $('deskDispatchBody').replaceChildren(el('div',{class:'desk-dispatch-details'},el('h3',{},row.business),el('p',{},`${row.locationName} · ${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)}`),
   el('p',{},collection?'Only confirm once the customer has collected the order.':destination||row.delivery),tracking,
   el('p',{class:'hint'},'The customer will be notified where order emails are enabled.'),el('p',{id:'deskDispatchError',class:'edit-error',role:'alert',hidden:true})));
  openDialog($('dispatchDialog'));
 }
 const kv=(label,value)=>el('div',{class:'kv'},el('span',{},label),el('span',{},value||'None supplied'));
 function renderDetail(row){
  $('orderDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},row.business),pill(row.status)),el('p',{class:'detail-id'},row.id),warning(row.account,true),el('div',{class:'details'},kv('Location',row.locationName),kv('Received',date(row.createdAt)),...(dispatchText(row)?[kv('Dispatch',dispatchText(row))]:[]),kv('Reference',row.reference),kv('Delivery preference',row.delivery),...(row.takenSource?[kv('Came in',row.takenSource)]:[]),...(row.changed?[kv('Bags changed',`${row.changed.byCustomer?'By the customer':'By Strangers'}, ${date(row.changed.at)}${row.changed.thisDeliveryOnly?' (this delivery only)':''}`)]:[]),...(row.skipped?[kv('Skipped',`${row.skipped.byCustomer?'By the customer':'By Strangers'}, ${date(row.skipped.at)}`)]:[])),el('h3',{class:'packing-heading'},'Packing list'),el('div',{class:'w-packing-list'},...row.lines.map(line=>{const grind=grindFor(line);return el('div',{class:'item w-packing-line w-grind-tone w-coffee-tone',style:`--w-grind-h:${grind.hue};${coffeeStyle(line)}`},el('span',{class:'w-pack-quantity'},el('b',{},String(line.quantity)),el('span',{},line.quantity===1?'bag':'bags')),el('span',{class:'tx'},el('b',{class:'w-pack-coffee'},el('span',{class:'w-coffee-swatch','aria-hidden':'true'}),line.title,decafLine(line)?el('span',{class:'w-decaf-label'},'Decaf'):null),line.recipe?el('span',{class:'w-recipe'},`Made from ${line.recipe}`):null,el('span',{class:'w-pack-size'},line.packLabel),el('span',{class:'w-grind-details'},el('span',{class:'w-grind-badge'},svg(grind.icon),grind.label),grind.hint?el('span',{class:'w-grind-hint'},grind.hint):null)))})),el('p',{class:'packing-total'},`${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)} total`));
  if(row.delivery==='Delivery'&&(row.address||row.postcode))$('orderDetail').append(el('h3',{class:'packing-heading'},'Delivery address'),el('p',{class:'address'},[row.address,row.postcode].filter(Boolean).join('\n')));
  for(const [label,text]of[['Delivery notes',row.deliveryNotes],['Customer comments',row.customerNote]])if(text)$('orderDetail').append(el('div',{class:'detail-note'},el('b',{},label),text));
  if(row.trackingUrl){try{const url=new URL(row.trackingUrl);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)$('orderDetail').append(el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer',class:'tracking'},'Track delivery ↗'))}catch{}}
  $('orderDialogAction').replaceChildren();
  if(NEXT[row.status])$('orderDialogAction').append(el('button',{type:'button',class:'btn',onclick:()=>{
   setMobilePacking(true);$('mobilePacking').parentElement.scrollTop=0;$('orderTitle').focus({preventScroll:true});
  }},row.status==='Ready'?'Process dispatch':'Pack order'));
  if(!editing)renderEdit(row);
  if(mobilePacking)renderPackingProgress(row.id);
 }
 // Status, internal note and tracking link: saved together, against the version on screen.
 function renderEdit(row){
  const statusSelect=el('select',{id:'editStatus','aria-describedby':'editHint'},...STATUSES.map(s=>el('option',{value:s,...(s===row.status?{selected:true}:{})},s)));
  const tracking=el('input',{id:'editTracking',type:'url',inputmode:'url',maxlength:'500',placeholder:'https://…',autocomplete:'off',value:row.trackingUrl||''});
  const note=el('textarea',{id:'editNote',rows:'3',maxlength:'1000'});note.value=row.note||'';
  // The courier's tracking link, for orders being sent: there from the start, so it can be pasted in while
  // preparing and goes out with the customer's "shipped" email when the order is marked dispatched.
  const sending=row.delivery!=='Roastery collection';
  const trackingField=el('label',{class:'field',id:'trackingField',hidden:!(sending||row.trackingUrl)},el('span',{},'Tracking link (optional)'),tracking,
   row.status!=='Dispatched'?el('small',{class:'field-hint'},'Add it before marking dispatched and it goes in the customer\'s shipped email.'):null);
  for(const input of [statusSelect,tracking,note])input.addEventListener('input',()=>{editing=true;});
  $('orderEdit').replaceChildren(
   el('div',{class:'edit-grid'},el('label',{class:'field'},el('span',{},'Status'),statusSelect),trackingField),
   el('label',{class:'field'},el('span',{},'Internal note'),note,el('small',{id:'editHint'},'For Strangers staff only. Customers never see it.')),
   el('p',{class:'edit-error',id:'editError',role:'alert',hidden:true}),
   el('div',{class:'edit-actions'},
    el('button',{type:'button',class:'btn soft',onclick:()=>printOne(row.id)},svg('doc'),'Print'),
    row.customerId?el('button',{type:'button',class:'btn soft',id:'tabToggle',onclick:()=>toggleTab(row.id)},row.onTab?'Take off tab':'Put on tab'):null,
    row.customerId&&OPEN_STATUSES.includes(row.status)?el('button',{type:'button',class:'btn soft',id:'changeBags',onclick:()=>openAmend(row)},'Change bags'):null,
    row.standingEvery&&OPEN_STATUSES.includes(row.status)?el('button',{type:'button',class:'btn soft',id:'skipDelivery',onclick:()=>askSkip(row)},'Skip this delivery'):null,
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
 function closeAmend(){const row=amend&&findOrder(amend.row.id);amend=null;editing=false;if(row)renderEdit(row);}
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
   if(e.code==='conflict'){amend=null;editing=false;await load();const r=findOrder(row.id);if(r){renderDetail(r);const box=$('editError');if(box){box.textContent='Someone else changed this order. It has been reloaded: check it and change the bags again.';box.hidden=false;}}return;}
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
 function openOrder(id){const row=findOrder(id);if(!row)return;selected=id;editing=false;setMobilePacking(false);renderDetail(row);openDialog($('orderDialog'));}
 async function patch(row,changes){
  const owner=orderingIdentity,expectedStatus=changes.status||row.status;
  const response=await fetch('/api/staff-orders/orders/'+encodeURIComponent(row.id),{method:'PATCH',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({ifVersion:row.version,status:row.status,note:row.note||'',trackingUrl:row.trackingUrl||'',...changes})});
  let data;try{data=await response.json();}catch(e){if(!started||orderingIdentity!==owner)throw Object.assign(e,{quiet:true});throw new Error('The update could not be confirmed. Refresh orders before trying again.');}
  if(!started||orderingIdentity!==owner)throw Object.assign(new Error('The signed-in account changed.'),{quiet:true});
  if(response.status===403){lock(true);message('You no longer have access to wholesale orders.',{denied:true});throw Object.assign(new Error('No access.'),{quiet:true});}
  if(!response.ok)throw Object.assign(new Error(data.message||'The order could not be saved. Check your connection and try again.'),{code:data.code});
  if(data.order?.id!==row.id||data.order.status!==expectedStatus||!Number.isSafeInteger(data.order.version)||data.order.version<=row.version)throw new Error('The update could not be confirmed. Refresh orders before trying again.');
  const index=rows.findIndex(r=>r.id===row.id);if(index>=0&&rows[index].version<=data.order.version)rows[index]={...rows[index],...data.order,account:rows[index].account};
  if(heldOrder?.id===row.id&&heldOrder.version<=data.order.version)heldOrder={...data.order,account:heldOrder.account};
  return data.order;
 }
 async function save(id){
  const row=findOrder(id);if(!row)return;
  if(row.status!=='Dispatched'&&$('editStatus').value==='Dispatched'){reviewDispatch(row,{note:$('editNote').value,trackingUrl:$('editTracking').value.trim()});return;}
  const button=$('saveOrder'),error=$('editError');error.hidden=true;button.disabled=true;button.textContent='Saving…';
  try{
   const order=await patch(row,{status:$('editStatus').value,note:$('editNote').value,trackingUrl:$('editTracking').value.trim()});
   editing=false;draw();renderDetail(findOrder(id)||order);toast(`${order.business}: ${order.status}`);
  }catch(e){
   if(e.quiet)return;
   if(e.code==='conflict'){editing=false;await load();error.textContent='Someone else changed this order. It has been reloaded: check it and save again.';}
   else error.textContent=e.message;
   const box=$('editError');if(box){box.textContent=error.textContent;box.hidden=false;}
  }finally{const b=$('saveOrder');if(b){b.disabled=false;b.textContent='Save';}}
 }
 async function quick(id){
  const row=rows.find(r=>r.id===id),next=row&&NEXT[row.status];if(!next||busy.has(id))return;
  if(next[0]==='Dispatched'){reviewDispatch(row);return;}
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
 function printOne(id){const row=findOrder(id);if(row)printScope({ids:[id],label:row.business});}
 async function openTotals(selectedIds){
  let current=selectedIds.length?'selected':'New',revision=0;
  const dialog=$('totalsDialog'),body=$('totalsBody'),printTotals=$('printTotals'),printSheets=$('printSheets');
  const scopes={New:{status:'New',label:'New orders'},open:{status:'New,Preparing',label:'New and preparing orders'},selected:{ids:selectedIds,label:`${selectedIds.length} selected ${selectedIds.length===1?'order':'orders'}`}};
  const choices=[['New','New'],['open','New & preparing'],...(selectedIds.length?[['selected','Selected']]:[])];
  const segment=el('div',{class:'filters seg',role:'group','aria-label':'Which orders'});
  const options=new Map(choices.map(([key,label])=>[key,el('button',{type:'button','aria-pressed':String(current===key),onclick:()=>drawTotals(key)},label)]));
  segment.append(...options.values());
  async function drawTotals(key){
   current=key;
   const request=++revision,scope=scopes[key];
   const active=()=>dialog.open&&segment.isConnected&&request===revision;
   for(const [id,button] of options)button.setAttribute('aria-pressed',String(key===id));
   printTotals.disabled=printSheets.disabled=true;
   body.setAttribute('aria-busy','true');
   body.replaceChildren(SC.skeleton({label:'Loading bag totals…',rows:2}));
   try{
    const {orders}=await fetchPrint(scope);
    if(!active())return;
    body.replaceChildren(packing.summaryBody(orders,scope.label));
    SC.reveal(body);
    printTotals.disabled=printSheets.disabled=!orders.length;
   }catch(e){
    if(!e.quiet&&active())body.replaceChildren(el('p',{class:'edit-error',role:'alert'},e.message),
     el('button',{type:'button',class:'btn soft',onclick:()=>{options.get(key).focus();drawTotals(key);}},'Retry'));
   }finally{if(active())body.removeAttribute('aria-busy');}
  }
  $('totalsScope').replaceChildren(segment);
  printTotals.onclick=()=>printScope(scopes[current],{onlyTotals:true});
  printSheets.onclick=()=>printScope(scopes[current]);
  openDialog(dialog);await drawTotals(current);
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
  const row=findOrder(id),button=$('tabToggle');if(!row||!button)return;
  button.disabled=true;
  try{const {order}=await tabRequest('PUT','orders/'+encodeURIComponent(id)+'/tab',{ifVersion:row.version,onTab:!row.onTab});
   const i=rows.findIndex(r=>r.id===id);if(i>=0)rows[i]={...rows[i],...order};draw();renderDetail(rows[i]);toast(order.onTab?`${order.business}: on the tab`:`${order.business}: off the tab`);if(view==='tabs')loadTabs();}
  catch(e){if(e.quiet)return;toast(e.code==='conflict'?'That order changed elsewhere. Reloaded: try again.':e.message);if(e.code==='conflict')await load();}
  finally{const b=$('tabToggle');if(b)b.disabled=false;}
 }
 // What's on a tab, itemised by coffee, bag size and grind (no prices), and a shorter version for the cards.
 const itemText=i=>`${i.size} · ${i.grind}${i.decaf?' · Decaf':''}`;
 const tabItemList=items=>el('ul',{class:'tab-items'},...items.map(i=>el('li',{},el('span',{class:'tab-item-n'},`${i.bags} ×`),el('span',{class:'tab-item-t'},el('b',{},i.title),el('span',{class:'row-meta'},itemText(i))),el('span',{class:'tab-item-kg'},weight(i.grams)))));
 const tabItemPeek=items=>{const shown=items.slice(0,3);return el('span',{class:'tab-peek'},...shown.map(i=>el('span',{},`${i.bags} × ${i.title} · ${i.size} · ${i.grind}${i.decaf?' · Decaf':''}`)),items.length>3?el('span',{class:'row-meta'},`and ${items.length-3} more`):null);};
 const orderLineText=o=>(o.lines||[]).map(l=>`${l.bags} × ${l.title} ${l.size} ${l.grind}${l.decaf?' decaf':''}`).join(', ');
 const tabProgress=(t,threshold)=>{const pct=Math.min(100,Math.round(t.grams/threshold*100));return el('div',{class:'tab-progress'+(t.ready?' ready':''),role:'progressbar','aria-valuemin':'0','aria-valuemax':String(threshold/1000),'aria-valuenow':String(t.grams/1000),'aria-label':`${weight(t.grams)} of ${weight(threshold)}`},el('span',{style:`width:${pct}%`}));};
 function drawTabs(){
  const open=tabs.open,ready=open.filter(t=>t.ready).length;
  $('tabCount').textContent=open.length?`${open.length} ${open.length===1?'tab':'tabs'}${ready?` · ${ready} ready to clear`:''}`:'';
  $('tabList').replaceChildren(...open.map(t=>el('button',{type:'button',class:'tab-card'+(t.ready?' ready':''),'data-tab':t.customerId,onclick:()=>openTab(t.customerId)},
   el('span',{class:'tab-head'},el('b',{},t.business),t.ready?el('span',{class:'pill ready'},svg('ok'),'Ready to clear'):t.autoTab?el('span',{class:'pill'},'Automatic'):null),
   el('span',{class:'tab-kg'},el('strong',{},weight(t.grams)),el('span',{},` of ${weight(tabs.threshold)}`)),
   tabProgress(t,tabs.threshold),
   t.items?.length?tabItemPeek(t.items):null,
   el('span',{class:'row-meta'},t.orders.length?`${t.orders.filter(o=>o.counts).length} ${t.orders.filter(o=>o.counts).length===1?'order':'orders'} · ${t.packs} ${t.packs===1?'bag':'bags'}${t.ready?'':` · ${weight(t.toGo)} to go`}`:'Nothing on the tab yet'))));
  if(!open.length)$('tabList').append(el('div',{class:'empty'},'No open tabs. Open an order and choose Put on tab.'));
  // Cleared tabs open to show what was on them.
  $('clearedList').replaceChildren(...tabs.cleared.map(c=>el('button',{type:'button',class:'order-row cleared-row','data-cleared':c.id,onclick:()=>openCleared(c.id)},el('span',{},el('b',{},c.business),el('span',{class:'row-meta'},`${c.kept?.length?'Part cleared':'Cleared'} ${date(c.clearedAt)} by ${c.clearedBy}${c.kept?.length?` · ${c.kept.length} kept on the tab`:''}`)),el('span',{class:'row-end'},el('span',{class:'cleared-kg'},weight(c.grams)),c.kept?.length?pill('Part'):null,c.early?pill('Early'):null,svg('chev')))));
  if(!tabs.cleared.length)$('clearedList').append(el('div',{class:'empty'},'No tabs cleared yet.'));
  if($('tabDialog').open&&tabSelected&&!tabConfirm){const t=open.find(x=>x.customerId===tabSelected);if(t)renderTab(t);else $('tabDialog').close();}
 }
 // Which orders on the open tab are ticked to clear (all of them unless someone unticks some); the rest stay on the tab.
 let tabPick=new Set();
 const ordered=o=>'Ordered '+new Date(o.createdAt).toLocaleDateString('en-GB',{timeZone:'Europe/London',weekday:'short',day:'numeric',month:'short',year:'numeric'});
 const sumOf=list=>{const c=list.filter(o=>o.counts);return{orders:list.length,grams:c.reduce((t,o)=>t+(o.grams||0),0),packs:c.reduce((t,o)=>t+(o.packs||0),0)};};
 function renderTab(t,focusTarget){
  const focused=document.activeElement,orderId=focused?.dataset.tabOrder;
  const actionId=$('tabFoot').contains(focused)?focused.id:null;
  $('tabTitle').textContent=t.business;
  tabPick=new Set([...tabPick].filter(id=>t.orders.some(o=>o.id===id)));
  const picked=t.orders.filter(o=>tabPick.has(o.id)),keep=t.orders.filter(o=>!tabPick.has(o.id)),pick=sumOf(picked),rest=sumOf(keep),all=!keep.length;
  const last=t.lastCleared;
  $('tabDetail').replaceChildren(
   el('div',{class:'tab-summary'+(t.ready?' ready':'')},el('div',{class:'tab-kg big'},el('strong',{},weight(t.grams)),el('span',{},` of ${weight(tabs.threshold)}`)),tabProgress(t,tabs.threshold),
    el('p',{},t.ready?'This tab has reached 6 kg and is ready to clear.':`${weight(t.toGo)} to go before it's ready to clear. You can clear it sooner if needed.`),
    last?el('p',{class:'row-meta tab-last'},`Last cleared ${date(last.clearedAt)} by ${last.clearedBy}: ${weight(last.grams)}${last.partial?' (part of the tab; the rest stayed on it)':''}`):null),
   ...(t.items?.length?[el('h3',{class:'packing-heading'},'On the tab'),tabItemList(t.items)]:[]),
   el('h3',{class:'packing-heading'},'Orders on the tab'),
   t.orders.length>1?el('p',{class:'hint'},'Untick any orders that should stay on the tab. Only the ticked ones are cleared.'):null,
   t.orders.length?tabOrderList(t.orders,true,t):el('p',{class:'hint'},'Nothing on this tab yet. New orders will be added automatically.'),
   el('p',{class:'edit-error',id:'tabError',role:'alert',hidden:true}));
  const label=all?(t.ready?'Clear tab':'Clear tab early'):`Clear ${picked.length} of ${t.orders.length}`;
  const question=all?(t.ready?`Clear ${weight(t.grams)}?`:`Clear early at ${weight(t.grams)}?`):`Clear ${weight(pick.grams)}? ${rest.orders} ${rest.orders===1?'order stays':'orders stay'} on the tab (${weight(rest.grams)}).`;
  $('tabFoot').replaceChildren(...(t.orders.length?(tabConfirm&&picked.length?[el('span',{},question),el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',id:'cancelClear',onclick:()=>{tabConfirm=false;renderTab(t,'clearTab')}},'Cancel'),el('button',{type:'button',class:'btn',id:'confirmClear',onclick:()=>clearTabNow(t)},all?'Clear tab':'Clear these'))]
   :[el('span',{},!picked.length?'Tick the orders to clear':all?(t.ready?'Ready to clear':'Not at 6 kg yet'):`${weight(pick.grams)} to clear · ${weight(rest.grams)} stays`),el('button',{type:'button',class:'btn'+(t.ready||!all?'':' soft'),id:'clearTab',disabled:!picked.length,onclick:()=>{tabConfirm=true;renderTab(t,'cancelClear');SC.reveal($('tabFoot'));}},label)]):[el('span',{}),el('button',{type:'button',class:'btn soft',id:'doneTab',onclick:()=>$('tabDialog').close()},'Done')]));
  const restored=orderId?$('tabDetail').querySelector(`[data-tab-order="${CSS.escape(orderId)}"]`):$(focusTarget||actionId);
  restored?.focus({preventScroll:true});
 }
 function tabOrderList(orders,open,t){
  return el('div',{class:'order-list glass'},...orders.map(o=>{
   const box=open&&t?el('input',{type:'checkbox',class:'tab-pick','data-tab-order':o.id,'aria-label':`Clear the order of ${date(o.createdAt)}`,...(tabPick.has(o.id)?{checked:true}:{}),onchange:e=>{e.target.checked?tabPick.add(o.id):tabPick.delete(o.id);tabConfirm=false;renderTab(t);}}):null;
   const body=el('span',{},el('b',{},ordered(o)+(o.reference?' · '+o.reference:'')),el('span',{class:'row-meta'},`${o.packs} ${o.packs===1?'bag':'bags'} · ${weight(o.grams)}${o.counts?'':' · cancelled, not counted'}`),o.lines?.length?el('span',{class:'row-meta tab-order-lines'},orderLineText(o)):null,open?el('span',{class:'row-meta'},o.addedBy==='Automatically'?'Added automatically':`Added by ${o.addedBy}`):null);
   return el(box?'label':'div',{class:'order-row tab-order'+(o.counts?'':' not-counted')+(box?' pickable':'')+(box&&!tabPick.has(o.id)?' kept':'')},box,body,el('span',{class:'row-end'},box&&!tabPick.has(o.id)?pill('Stays on tab'):null,pill(o.status)));
  }));
 }
 const NOW={'on-tab':'Still on the tab',cleared:'Cleared since','off-tab':'Taken off the tab'};
 // A cleared tab, read only: what was cleared, when each was ordered, and (after a part clear) what stayed on the tab.
 function openCleared(id){
  const c=tabs.cleared.find(x=>x.id===id);if(!c)return;tabSelected=null;tabConfirm=false;
  $('tabTitle').textContent=c.business;
  $('tabDetail').replaceChildren(
   el('div',{class:'tab-summary cleared'},el('div',{class:'tab-kg big'},el('strong',{},weight(c.grams)),el('span',{},` · ${c.packs} ${c.packs===1?'bag':'bags'}`)),el('p',{},`${c.kept?.length?'Part cleared':'Cleared'} ${date(c.clearedAt)} by ${c.clearedBy}${c.early?', before it reached '+weight(tabs.threshold):''}.`)),
   ...(c.items?.length?[el('h3',{class:'packing-heading'},'What was cleared'),tabItemList(c.items)]:[]),
   el('h3',{class:'packing-heading'},'Orders cleared'),
   c.orders?.length?tabOrderList(c.orders,false):el('p',{class:'hint'},'The orders on this tab are no longer available.'),
   ...(c.kept?.length?[el('h3',{class:'packing-heading'},'Kept on the tab'),el('div',{class:'order-list glass'},...c.kept.map(o=>el('div',{class:'order-row tab-order kept'},el('span',{},el('b',{},ordered(o)+(o.reference?' · '+o.reference:'')),el('span',{class:'row-meta'},`${o.packs} ${o.packs===1?'bag':'bags'} · ${weight(o.grams)}`),o.lines?.length?el('span',{class:'row-meta tab-order-lines'},orderLineText(o)):null),el('span',{class:'row-end'},pill(NOW[o.now]||o.now)))))]:[]));
  $('tabFoot').replaceChildren(el('span',{},c.kept?.length?'Part cleared':'Cleared'),el('button',{type:'button',class:'btn soft',onclick:()=>$('tabDialog').close()},'Done'));
  openDialog($('tabDialog'));
 }
 function openTab(customerId){const t=tabs.open.find(x=>x.customerId===customerId);if(!t)return;tabSelected=customerId;tabConfirm=false;tabPick=new Set(t.orders.map(o=>o.id));renderTab(t);openDialog($('tabDialog'));}
 async function clearTabNow(t){
  const button=$('confirmClear');if(!button||button.disabled)return;
  button.disabled=true;button.textContent='Clearing…';
  try{
   const {cleared}=await tabRequest('POST','tabs/'+encodeURIComponent(t.customerId)+'/clear',{
    orderIds:t.orders.filter(o=>tabPick.has(o.id)).map(o=>o.id),seen:t.orders.map(o=>o.id),seenVersions:Object.fromEntries(t.orders.map(o=>[o.id,o.version])),
   });
   if(button.isConnected)$('tabDialog').close();
   toast(cleared.keptIds?.length?`${cleared.business}: ${weight(cleared.grams)} cleared, ${cleared.keptIds.length} ${cleared.keptIds.length===1?'order stays':'orders stay'} on the tab`:`${cleared.business}: tab cleared at ${weight(cleared.grams)}`);await loadTabs();await load();
  }
  catch(e){
   if(e.quiet||!button.isConnected||!$('tabDialog').open)return;
   tabConfirm=false;
   const conflicted=e.code==='conflict',refreshed=conflicted&&await loadTabs();
   if(tabSelected!==t.customerId||!$('tabDialog').open)return;
   if(!refreshed)renderTab(t,'clearTab');
   const box=$('tabError');
   box.textContent=conflicted?(refreshed?'This tab changed. Check the updated orders before clearing.':'This tab changed. Reload Tabs before trying again.'):e.message;
   box.hidden=false;
  }
 }
 async function loadTabs(){
  const current=sequence;
  if(!$('tabList').hasChildNodes())$('tabList').replaceChildren(SC.skeleton({label:'Loading customer tabs…'}));
  $('tabList').setAttribute('aria-busy','true');
  try{const data=await tabRequest('GET','tabs');if(current!==sequence)return false;tabs=data;drawTabs();return true;}
  catch(e){if(!e.quiet&&current===sequence)$('tabList').replaceChildren(el('div',{class:'empty'},'Tabs could not be loaded. Check your connection and try again.'));}
  finally{if(current===sequence)$('tabList').setAttribute('aria-busy','false');}
 }

 // Customers: contact and delivery details, read-only.
 function drawCustomers(){
  $('customerCount').textContent=`${customers.length}${customersMore?'+':''} ${customers.length===1?'customer':'customers'}`;
  $('customerList').replaceChildren(...customers.map(c=>el('button',{type:'button',class:'order-row customer-row','data-customer-id':c.id,onclick:()=>openCustomer(c.id)},
   el('span',{class:'customer-icon','aria-hidden':'true'},svg('user')),
   el('span',{class:'customer-info'},el('b',{},c.business),el('span',{class:'row-meta'},[c.contact,c.phone].filter(Boolean).join(' · ')||'No contact saved'),el('span',{class:'row-meta'},`${c.locations.length} ${c.locations.length===1?'location':'locations'}${c.locations[0]?.postcode?' · '+c.locations[0].postcode:''}`),c.status==='On hold'?pill('On hold'):null),
   svg('chev'))));
  if(!customers.length)$('customerList').append(el('div',{class:'empty'},$('customerSearch').value.trim()?'No matching customers.':'No customers yet.'));
 }
 function openCustomer(id){
  const c=customers.find(c=>c.id===id);if(!c)return;
  const link=(href,text)=>el('a',{href},text);
  $('customerDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},c.business),c.status==='On hold'?pill('On hold'):pill('Active')),
   el('div',{class:'details'},kv('Contact',c.contact),el('div',{class:'kv'},el('span',{},'Email'),c.email?link('mailto:'+c.email,c.email):el('span',{},'None supplied')),c.accountsEmail?el('div',{class:'kv'},el('span',{},'Accounts email'),link('mailto:'+c.accountsEmail,c.accountsEmail)):null,el('div',{class:'kv'},el('span',{},'Phone'),c.phone?link('tel:'+c.phone.replace(/[^\d+]/g,''),c.phone):el('span',{},'None supplied'))),
   el('h3',{class:'packing-heading'},c.locations.length===1?'Delivery location':'Delivery locations'),
   ...c.locations.map(l=>el('div',{class:'detail-note location'},el('b',{},l.name+(l.id===c.defaultLocationId&&c.locations.length>1?' (default)':'')),[l.address,l.postcode].filter(Boolean).join('\n')||'No address saved',(l.contact||l.phone)&&(l.contact!==c.contact||l.phone!==c.phone)?el('span',{class:'row-meta'},[l.contact,l.phone].filter(Boolean).join(' · ')):null,l.deliveryNotes?el('span',{class:'row-meta'},'Delivery notes: '+l.deliveryNotes):null)));
  $('customerActions').replaceChildren(el('button',{type:'button',class:'btn',disabled:c.status==='On hold',onclick:()=>{$('customerDialog').close();newOrder(c)}},c.status==='On hold'?'On hold: no new orders':'New order'));
  openDialog($('customerDialog'));
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
   if(p){draft={customer:{id:p.payload.customerId,business:p.business},pending:{...p,uncertain:true},sending:false,error:''};drawNewOrder();openDialog($('newOrderDialog'));return;}
  }catch(e){draft={blockedRecovery:true,error:e.message||'Browser storage is unavailable. Enable it before placing orders, so an interrupted order can be recovered.',sending:false};drawNewOrder();openDialog($('newOrderDialog'));return;}
  draft={customer:customer||null,catalogue:null,lines:[],source:'Email',onTab:false,delivery:'Roastery collection',locationId:null,reference:'',note:'',emailCustomer:true,requestId:crypto.randomUUID(),sending:false,error:'',search:'',found:[]};
  drawNewOrder();openDialog($('newOrderDialog'));
  if(customer)chooseCustomer(customer);else $('newOrderForm').querySelector('input')?.focus();
 }
 async function findCustomers(q){
  const current=draft;
  if(!current||current.customer||current.search.trim()!==q)return;
  try{
   const data=await staffJson('GET','customers'+(q?'?q='+encodeURIComponent(q):''));
   if(draft!==current||current.customer||current.search.trim()!==q)return;
   current.found=data.customers.slice(0,30);current.error='';drawNewOrder(true);
  }catch(e){if(!e.quiet&&draft===current&&!current.customer&&current.search.trim()===q){current.error=e.message;drawNewOrder(true);}}
 }
 async function chooseCustomer(c){
  const current=draft;
  current.customer=c;current.catalogue=null;current.lines=[];current.error='';current.locationId=c.defaultLocationId||'primary';current.emailCustomer=!!c.email&&current.source==='Email';
  const request=current.requestId=crypto.randomUUID();drawNewOrder();
  try{
   const data=await staffJson('GET','catalogue?customer='+encodeURIComponent(c.id));
   if(draft!==current||current.requestId!==request||current.customer?.id!==c.id)return;
   current.catalogue=data;current.lines=[blankLine()];drawNewOrder();
   $('noCoffee-1')?.focus({preventScroll:true});
  }catch(e){if(!e.quiet&&draft===current&&current.requestId===request){current.error=e.message;drawNewOrder();}}
 }
 function blankLine(st=draft){const p=st.catalogue?.products.find(p=>p.inStock);return {productId:p?.id||'',pack:p?.packs.includes('kilo')?'kilo':p?.packs[0]||'kilo',grind:p?.grinds[0]?.id||'beans',quantity:1};}
 const productOf=(id,st=draft)=>st?.catalogue?.products.find(p=>p.id===id);
 const draftGrams=()=>draft.lines.reduce((sum,l)=>sum+(productOf(l.productId)?(PACK[l.pack]?.grams||0)*(Number(l.quantity)||0):0),0);
 const draftBags=()=>draft.lines.reduce((sum,l)=>sum+(productOf(l.productId)?Number(l.quantity)||0:0),0);
 function lineRow(line,i,st=draft,redraw=drawNewOrder,changed=drawTotals){
  const p=productOf(line.productId,st),taking=st===draft;
  const coffee=el('select',{...(taking?{id:'noCoffee-'+(i+1)}:{}),'aria-label':`Coffee ${i+1}`,onchange:()=>{line.productId=coffee.value;const np=productOf(line.productId,st);if(np){if(!np.packs.includes(line.pack))line.pack=np.packs[0];if(!np.grinds.some(g=>g.id===line.grind))line.grind=np.grinds[0]?.id||'beans';}redraw(true);}},
   ...st.catalogue.products.map(x=>el('option',{value:x.id,disabled:!x.inStock,...(x.id===line.productId?{selected:true}:{})},x.title+(x.yours?' (their coffee)':'')+(x.decaf?' · decaf':'')+(x.inStock?'':' · out of stock'))));
  const size=el('select',{'aria-label':`Bag size for coffee ${i+1}`,onchange:()=>{line.pack=size.value;changed()}},...(p?.packs||['kilo']).map(k=>el('option',{value:k,...(k===line.pack?{selected:true}:{})},PACK[k].label)));
  const grind=el('select',{'aria-label':`Grind for coffee ${i+1}`,onchange:()=>{line.grind=grind.value}},...(p?.grinds||[]).map(g=>el('option',{value:g.id,...(g.id===line.grind?{selected:true}:{}),...(g.hint?{title:g.hint}:{})},g.label)));
  const qty=el('input',{type:'number',min:'1',max:'999',step:'1',inputmode:'numeric',value:String(line.quantity),'aria-label':`Bags of coffee ${i+1}`,oninput:()=>{line.quantity=Math.max(0,Math.min(999,Math.floor(Number(qty.value)||0)));changed()}});
  const coffeeField=el('label',{class:'field no-coffee'},el('span',{},'Coffee'),coffee);
  const bagField=el('label',{class:'field'},el('span',{},'Bag size'),size);
  const grindField=el('label',{class:'field no-grind'},el('span',{},'Grind'),grind);
  const qtyField=el('label',{class:'field no-qty'},el('span',{},'Bags'),qty);
  const remove=st.lines.length>1?el('button',{type:'button',class:'btn soft sm no-remove','aria-label':`Remove coffee ${i+1}`,onclick:()=>{
   st.lines.splice(i,1);redraw();
   if(taking)$('noCoffee-'+Math.min(i+1,st.lines.length))?.focus({preventScroll:true});
  }},'Remove'):null;
  if(!taking)return el('div',{class:'no-line'},coffeeField,bagField,grindField,qtyField,remove);
  return el('div',{class:'no-line no-coffee-card'},
   el('div',{class:'no-line-heading'},el('b',{},`Coffee ${i+1}`),p?.yours?el('span',{class:'pill preparing'},'Customer’s coffee'):null,remove),
   coffeeField,el('div',{class:'no-line-options'},bagField,grindField,qtyField));
 }
 function drawTotals(){
  const box=$('noTotals');if(!box||!draft?.catalogue)return;
  const grams=draftGrams(),bags=draftBags();
  box.replaceChildren(el('b',{},`${bags} ${bags===1?'bag':'bags'} · ${kgText(grams)}`),el('span',{class:'hint'},draft.delivery==='Delivery'?'Delivery':'Roastery collection'));
  const place=$('placeOrder');if(place)place.disabled=draft.sending||!bags;
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
  const form=$('newOrderForm'),c=draft.customer,active=keepFocus?document.activeElement?.id:null,scroll=form.scrollTop;
  const parts=[];
  if(!c){
   const search=el('input',{id:'noSearch',type:'search',maxlength:'120',placeholder:'Business, contact or postcode',value:draft.search,autocomplete:'off','aria-label':'Find the customer',oninput:()=>{
    draft.search=search.value;clearTimeout(draft.timer);draft.timer=setTimeout(()=>findCustomers(search.value.trim()),250);
   }});
   parts.push(el('section',{class:'no-customer-search','aria-labelledby':'noFindTitle'},el('h3',{id:'noFindTitle'},'Find the customer'),search,
    el('div',{class:'order-list glass no-found'},...draft.found.map(x=>el('button',{type:'button',class:'order-row',disabled:x.status==='On hold',onclick:()=>chooseCustomer(x)},el('span',{},el('b',{},x.business),el('span',{class:'row-meta'},[x.contact,x.locations?.[0]?.postcode].filter(Boolean).join(' · '))),el('span',{class:'row-end'},x.status==='On hold'?pill('On hold'):svg('chev')))),
     !draft.found.length?el('div',{class:'empty'},draft.search?'No matching customers.':'Type to find the customer.'):null)));
   if(!draft.found.length&&!draft.search&&!draft.loaded){draft.loaded=true;findCustomers('');}
  }else{
   const locs=c.locations||[],loc=locs.find(l=>l.id===draft.locationId)||locs[0];
   parts.push(el('div',{class:'no-customer'},el('div',{class:'no-customer-name'},el('span',{class:'no-customer-icon','aria-hidden':'true'},svg('user')),el('div',{},el('span',{class:'row-meta'},'Customer'),el('b',{},c.business))),
    el('button',{type:'button',class:'btn soft sm',onclick:()=>{
     draft.customer=null;draft.catalogue=null;draft.lines=[];draft.found=[];draft.loaded=false;draft.error='';drawNewOrder();$('noSearch')?.focus();
    }},'Change customer')));
   if(!draft.catalogue){
    if(!draft.error)parts.push(SC.skeleton({label:'Loading coffees…',rows:2}));
    else parts.push(el('button',{type:'button',class:'btn soft',onclick:()=>chooseCustomer(c)},'Retry catalogue'));
   }else{
    const selectField=(label,id,options,value,set)=>el('label',{class:'field'},el('span',{},label),
     el('select',{id,onchange:event=>{set(event.target.value);drawNewOrder(true)}},...options.map(([key,text])=>el('option',{value:key,selected:key===value},text))));
    const source=selectField('Order source','noSource',['Email','In person','Phone','Other'].map(v=>[v,v]),draft.source,v=>{draft.source=v;draft.emailCustomer=!!c.email&&v==='Email'});
    const method=selectField('Fulfilment','noDelivery',[['Roastery collection','Roastery collection'],['Delivery','Delivery']],draft.delivery,v=>{draft.delivery=v});
    const location=locs.length>1||draft.delivery==='Delivery'?selectField('Location','noLocation',locs.map(l=>[l.id,[l.name,l.postcode].filter(Boolean).join(' · ')]),loc?.id,v=>{draft.locationId=v}):null;
    const address=draft.delivery==='Delivery'?el('p',{class:loc?.address&&loc?.postcode?'no-address':'no-address account-banner review'},loc?.address&&loc?.postcode?[loc.address,loc.postcode].join(', '):'No delivery address saved. Choose collection or ask an admin to add the address.'):null;
    const ref=el('input',{id:'noRef',maxlength:'80',value:draft.reference,oninput:()=>{draft.reference=ref.value}});
    const note=el('textarea',{id:'noNote',rows:'3',maxlength:'1000',oninput:()=>{draft.note=note.value}});note.value=draft.note;
    const mail=el('input',{type:'checkbox',class:'switch',id:'noEmail',disabled:!c.email,checked:!!(draft.emailCustomer&&c.email),onchange:()=>{draft.emailCustomer=mail.checked}});
    const tab=el('input',{type:'checkbox',class:'switch',id:'noTab',disabled:!!draft.catalogue.autoTab,checked:!!(draft.onTab||draft.catalogue.autoTab),onchange:()=>{draft.onTab=tab.checked}});
    parts.push(el('div',{class:'no-workspace'},
     el('section',{class:'no-card','aria-labelledby':'noCoffeeTitle'},
      el('header',{class:'no-card-heading'},el('h3',{id:'noCoffeeTitle'},'Coffee'),el('p',{class:'hint'},'No minimum for staff-entered orders.')),
      el('div',{class:'no-lines'},...draft.lines.map((line,index)=>lineRow(line,index))),
      el('button',{type:'button',class:'btn soft no-add-coffee',onclick:()=>{
       draft.lines.push(blankLine());drawNewOrder();$('noCoffee-'+draft.lines.length)?.focus();
      }},'Add another coffee')),
     el('section',{class:'no-card no-details','aria-labelledby':'noDetailsTitle'},el('h3',{id:'noDetailsTitle'},'Order details'),
      el('div',{class:'no-details-grid'},source,method,location,address),
      el('label',{class:'field'},el('span',{},'Customer reference (optional)'),ref),
      el('label',{class:'field'},el('span',{},'Customer comments (optional)'),note,el('small',{},'Visible to the customer.')),
      el('div',{class:'no-preferences'},el('label',{class:'check'},el('span',{},el('b',{},'Email confirmation'),el('small',{},c.email||'No email saved')),mail),
       el('label',{class:'check'},el('span',{},draft.catalogue.autoTab?'Always goes on the customer’s tab':'Put on the customer’s tab'),tab)))));
   }
  }
  if(draft.error)parts.push(el('p',{class:'edit-error',role:'alert'},draft.error));
  form.replaceChildren(...parts);
  $('newOrderFoot').replaceChildren(c&&draft.catalogue?el('div',{class:'no-totals',id:'noTotals','aria-live':'polite'}):el('span',{}),
   el('div',{class:'edit-actions'},el('button',{type:'button',class:'btn soft',onclick:()=>$('newOrderDialog').close()},'Cancel'),
    c&&draft.catalogue?el('button',{type:'button',class:'btn',id:'placeOrder',onclick:placeNewOrder},draft.sending?'Placing…':'Place order'):null));
  drawTotals();
  if(keepFocus){form.scrollTop=scroll;if(active)$(active)?.focus({preventScroll:true});}
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
   status='open';$('search').value='';if(view!=='orders')showView('orders',{url:true});else saveNavigation();await load();if(rows.some(r=>r.id===order.id))openOrder(order.id);
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
  const current=sequence,request=++customerRequest,q=$('customerSearch').value.trim();
  const isCurrent=()=>current===sequence&&request===customerRequest;
  if(!$('customerList').hasChildNodes())$('customerList').replaceChildren(SC.skeleton({label:'Loading customers…'}));
  $('customerList').setAttribute('aria-busy','true');
  $('refreshCustomers').setAttribute('aria-busy','true');
  $('refreshCustomers').disabled=true;
  try{
   const response=await fetch('/api/staff-orders/customers'+(q?'?q='+encodeURIComponent(q):''),{cache:'no-store'});
   if(!isCurrent())return;
   if(response.status===403){lock(true);message('You do not have access to wholesale orders. Ask an admin to enable it.',{denied:true});return;}
   const data=await response.json();if(!response.ok||!Array.isArray(data.customers))throw new Error();
   if(!isCurrent()||q!==$('customerSearch').value.trim())return;customers=data.customers;customersMore=!!data.more;drawCustomers();
  }catch{if(isCurrent()&&q===$('customerSearch').value.trim())$('customerList').replaceChildren(el('div',{class:'empty'},'Customers could not be loaded. Check your connection and try again.'));}
  finally{if(request===customerRequest){$('customerList').setAttribute('aria-busy','false');$('refreshCustomers').removeAttribute('aria-busy');$('refreshCustomers').disabled=false;}}
 }
 function saveNavigation(){
  SCStaffNavigation.save('orders',orderingIdentity,{view,status,dispatch:$('orderDispatchScope').value,sort:$('orderSort').value});
 }
 function showView(next,{url=false,fetchData=true,animate=true}={}){
  const changed=view!==next;
  view=next;$('ordersView').hidden=view!=='orders';$('customersView').hidden=view!=='customers';$('tabsView').hidden=view!=='tabs';
  for(const button of $('viewTabs').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
  $('sectionNewOrder').hidden=view==='orders';
  $('workspaceTitle').textContent={orders:'Wholesale orders',tabs:'Customer tabs',customers:'Customers'}[view];
  if(url&&changed){history.pushState(null,'','#'+view);saveNavigation();}
  if(changed&&animate)SC.reveal($(view+'View'));
  if(!fetchData)return;
  if(view==='orders')loadDeskTotals();
  else if(view==='customers')loadCustomers();
  else loadTabs();
 }
 function routeView(){
  const hash=location.hash.slice(1);
  return VIEWS.has(hash)?hash:hash?'orders':baseView;
 }
 function restoreNavigation(){
  const saved=SCStaffNavigation.read('orders',orderingIdentity);
  if(VIEWS.has(saved?.view))baseView=saved.view;
  if(filters.some(([value])=>value===saved?.status)||wideDesk.matches&&saved?.status==='prepare')status=saved.status;
  if(Array.from($('orderDispatchScope').options).some(option=>option.value===saved?.dispatch))$('orderDispatchScope').value=saved.dispatch;
  if(Array.from($('orderSort').options).some(option=>option.value===saved?.sort))$('orderSort').value=saved.sort;
  showView(routeView(),{fetchData:false,animate:false});
  if(VIEWS.has(location.hash.slice(1)))saveNavigation();
 }

 // A link to one order (the new-order email's button: /orders#WS-…) opens it, searching all orders if needed.
 async function openFromLink(){
  if(location.hash==='#new'){history.replaceState(null,'',location.pathname+location.search);newOrder(null);return;}
  const link=location.hash,owner=orderingIdentity;
  let id;
  try{id=decodeURIComponent(link.slice(1));}catch{return;}
  if(!/^WS-[A-F0-9]{32}$/.test(id))return;
  if(!findOrder(id)){
   try{
    const lookup=await staffJson('GET','orders?'+new URLSearchParams({status:'all',dispatch:'all',q:id}));
    if(!started||owner!==orderingIdentity||link!==location.hash)return;
    if(document.documentElement.hasAttribute('data-orders-locked')){pendingViewRoute=true;return;}
    heldOrder=lookup.orders?.find(row=>row.id===id)||null;
   }catch(error){if(!error.quiet)toast(error.message||'That order could not be loaded.');return;}
  }
  history.replaceState(null,'',location.pathname+location.search);
  if(findOrder(id))openOrder(id);else toast('That order could not be found.');
 }
 function followViewRoute(){
  if(!started)return;
  pendingViewRoute=document.documentElement.hasAttribute('data-orders-locked');
  if(pendingViewRoute)return;
  showView(routeView());saveNavigation();
  openFromLink();
 }
 async function load({more=false,reverify=false}={}){
  if(!started)return;
  const orderDialog=$('orderDialog');
  const current=++sequence,wasOpen=orderDialog.open,wasSelected=selected;
  if(reverify){lock();$('accessStatus').hidden=false;$('accessStatus').replaceChildren(SC.skeleton({label:'Checking access…'}));}
  // Sort: the usual order (by dispatch date on a wide screen, last changed on a phone; Dispatched newest dispatched first),
  // or by when each order was placed, newest or oldest first, whatever its status (the owner's request, 23 Nov 2026).
  const dispatch=$('orderDispatchScope').value,sort=$('orderSort').value||(wideDesk.matches?'dispatch':'updated');
  const key=[status,$('search').value.trim(),dispatch,sort].join('|'),changed=key!==ordersKey;ordersKey=key;
  if(changed)heldOrder=null;
  if(!more&&changed)$('orderList').replaceChildren(SC.skeleton({label:'Loading orders…'}));
  $('orderList').setAttribute('aria-busy','true');
  $('refresh').disabled=true;$('refresh').setAttribute('aria-busy','true');$('loadMore').disabled=true;
  try{
   if(!(await SC.ensureSession({force:reverify})))return;
   const query=new URLSearchParams({status,dispatch,sort});if($('search').value.trim())query.set('q',$('search').value.trim());if(more&&!changed&&cursor)query.set('cursor',cursor);
   const response=await fetch('/api/staff-orders/orders?'+query,{cache:'no-store'});
   if(current!==sequence)return;
   if(response.status===403){lock(true);message('You do not have access to wholesale orders. Ask an admin to enable it.',{denied:true});return;}
   if(!response.ok)throw new Error('Orders could not be loaded.');
   const data=await response.json();if(current!==sequence)return;
   if(!Array.isArray(data.orders))throw new Error('Orders could not be verified.');
   if(heldOrder&&!data.orders.some(row=>row.id===heldOrder.id)&&!more){
    const id=heldOrder.id;
    const result=await staffJson('GET','orders?status=all&q='+encodeURIComponent(id));
    if(current!==sequence)return;
    if(heldOrder?.id===id)heldOrder=result.orders.find(row=>row.id===id&&(OPEN_STATUSES.includes(row.status)||wasOpen&&wasSelected===id))||null;
   }
   rows=more&&!changed?[...new Map([...rows,...data.orders].map(row=>[row.id,row])).values()]:data.orders;cursor=data.nextCursor;total=data.count;
   if(!workspaceAccess){workspaceAccess=true;SCStaffNavigation.render('orders',staffLinks,true);}
   if($('signedInInitials').hidden)renderIdentity();
   draw();$('accessStatus').hidden=true;$('ordersContent').hidden=false;document.documentElement.removeAttribute('data-orders-locked');if(changed||reverify)SC.reveal($('orderList'));
   loadDeskTotals();
   if(wasOpen&&wasSelected&&(reverify||orderDialog.open&&selected===wasSelected)){
    const row=findOrder(wasSelected);
    if(row){selected=row.id;renderDetail(row);if(!orderDialog.open)openDialog(orderDialog);}
    else{orderDialog.close();selected=null;}
   }
   if(pendingViewRoute)followViewRoute();
   else if(reverify&&view==='customers')loadCustomers();
   else if(view==='tabs')loadTabs();
  }catch(error){if(current===sequence){lock(true);message('Orders could not be verified. Reconnect, then try again.',{retry:true});}}
  finally{if(current===sequence){$('orderList').setAttribute('aria-busy','false');$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');$('loadMore').disabled=false;}}
 }
 $('refresh').onclick=()=>load({reverify:true});$('loadMore').onclick=()=>load({more:true});
 $('orderStatus').replaceChildren(...filters.map(([value,label])=>el('option',{value},label)));
 $('orderStatus').onchange=event=>{status=event.target.value;saveNavigation();load();};
 $('orderDispatchScope').onchange=()=>{saveNavigation();totalsSequence++;deskTotals=null;drawDeskTotals();load();};
 $('orderSort').onchange=()=>{saveNavigation();load();};
 wideDesk.addEventListener('change',()=>{if(!wideDesk.matches&&status==='prepare')status='open';if(started)load();});
 $('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250)};
 $('customerSearch').oninput=()=>{clearTimeout(customerTimer);customerTimer=setTimeout(loadCustomers,250)};
 $('refreshCustomers').onclick=loadCustomers;
 for(const button of $('viewTabs').querySelectorAll('button'))button.onclick=()=>showView(button.dataset.view,{url:true});
 addEventListener('hashchange',followViewRoute);
 $('closeOrder').onclick=()=>$('orderDialog').close();
 $('doneOrder').onclick=()=>{
  if(!mobilePacking){$('orderDialog').close();return;}
  setMobilePacking(false);$('orderDialogAction').querySelector('button')?.focus();
 };
 $('orderDialog').addEventListener('close',()=>{if($('orderDialog').open)return;selected=null;editing=false;amend=null;setMobilePacking(false);$('orderEdit').replaceChildren()});
 $('closeDeskDispatch').onclick=$('cancelDeskDispatch').onclick=()=>$('dispatchDialog').close();
 $('dispatchDialog').addEventListener('close',()=>{if(!$('dispatchDialog').open){dispatchReview=null;$('deskDispatchBody').replaceChildren();}});
 $('deskDispatchForm').onsubmit=async event=>{
  event.preventDefault();const review=dispatchReview;if(!review)return;
  const button=$('confirmDeskDispatch'),error=$('deskDispatchError');
  const report=message=>{if(dispatchReview===review){error.textContent=message;error.hidden=false;}};
  const {row,changes}=review;
  if(findOrder(row.id)?.version!==row.version||packProblems.has(row.id)){
   report('Close this review and reload the order before confirming.');return;
  }
  error.hidden=true;button.disabled=true;
  const saved=await saveDeskProgress(row,{...changes,status:'Dispatched',trackingUrl:$('deskTracking')?.value.trim()||''},report);
  if(dispatchReview!==review)return;
  if(saved){$('dispatchDialog').close();if($('orderDialog').open)$('orderDialog').close();}
  else button.disabled=false;
 };
 $('closeCustomer').onclick=$('doneCustomer').onclick=()=>$('customerDialog').close();
 $('refreshTabs').onclick=()=>load({reverify:true});$('closeTab').onclick=()=>$('tabDialog').close();$('tabDialog').addEventListener('close',()=>{tabSelected=null;tabConfirm=false;});
 $('closeTotals').onclick=()=>$('totalsDialog').close();
 for(const button of document.querySelectorAll('[data-new-order]'))button.onclick=()=>newOrder(null);
 $('closeNewOrder').onclick=()=>$('newOrderDialog').close();
 $('newOrderDialog').addEventListener('close',()=>{if(draft&&!draft.sending)draft=null;});
 $('newOrderForm').addEventListener('submit',e=>e.preventDefault());
 // Printing moves focus to the print dialog: that isn't leaving the page, so it doesn't lock it.
 let printing=false;addEventListener('beforeprint',()=>{printing=true});addEventListener('afterprint',()=>{setTimeout(()=>{printing=false},500)});
 addEventListener('blur',()=>{if(printing)return;sequence++;lock();});addEventListener('pagehide',()=>{sequence++;lock();});
 addEventListener('focus',()=>{if(started&&!printing)load({reverify:true})});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){sequence++;lock()}else if(started)load({reverify:true})});
 addEventListener('pageshow',event=>{if(event.persisted&&started)load({reverify:true})});addEventListener('online',()=>load({reverify:true}));
 SC.recheckOnPageshow();
 (async()=>{
  const me=await SC.startSession({clear:()=>{
   sequence++;started=false;orderingIdentity=null;staffName='';workspaceAccess=false;clearInterval(timer);
   SCStaffNavigation.clear();lock(true);
  }});
  if(!me)return;
  orderingIdentity=me.user.id;staffLinks=me.links;staffName=me.user.name||'';
  workspaceAccess=me.capabilities?.staffOrders===true;
  SCStaffNavigation.render('orders',staffLinks,workspaceAccess);
  restoreNavigation();started=true;await load({reverify:true});
  if(!started)return;
  try{if(savedAttempts().length)newOrder(null);else await openFromLink();}catch{newOrder(null);}
  timer=setInterval(()=>{if(started&&!document.hidden&&!editing&&!busy.size&&!$('dispatchDialog').open)load()},15000);
 })();
})();
