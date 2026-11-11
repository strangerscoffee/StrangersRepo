// Authorized fulfilment reads only. Nothing is stored locally or queued, and no order/payment writes exist here.
(()=>{
 'use strict';
 const {el,svgi}=SC,{grindFor,decafLine,iconPaths,coffeeStyle}=SCWholesalePreparation;
 const $=id=>document.getElementById(id);
 const paths={chev:'<path d="m9 6 6 6-6 6"/>',warn:'<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',coffee:'<path d="M5 8h12v7a6 6 0 0 1-12 0V8ZM17 9h2a3 3 0 0 1 0 6h-2"/>',...iconPaths};
 const svg=key=>svgi(paths[key]||paths.coffee);
 const filters=[['open','Open orders'],['New','New'],['Preparing','Preparing'],['Ready','Ready'],['Dispatched','Dispatched'],['all','All orders']];
 let rows=[],cursor=null,total=0,status='open',selected=null,sequence=0,timer=null,searchTimer=null,started=false;
 const weight=grams=>new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(grams/1000)+' kg';
 const date=at=>new Date(at).toLocaleString('en-GB',{timeZone:'Europe/London',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
 const pill=value=>el('span',{class:'pill '+String(value).toLowerCase()},value);
 function lock(clear=false){document.documentElement.setAttribute('data-orders-locked','');$('orderDialog').close();if(clear){rows=[];selected=null;cursor=null;$('orderList').replaceChildren();$('orderDetail').replaceChildren();$('signedIn').textContent='';$('ordersContent').hidden=true;}}
 function message(text,{retry=false,denied=false}={}){
  $('accessStatus').hidden=false;$('accessStatus').replaceChildren(el('p',{},text),retry?el('button',{type:'button',class:'btn',onclick:()=>load({reverify:true})},'Try again'):null,denied?el('a',{href:'/'},'Back to Kitchen Diary'):null);
 }
 function warning(account,banner=false){
  const container=el('div',{class:banner?'account-banners':'account-warnings'});
  if(account?.overdue)container.append(el('div',{class:banner?'account-banner':'account-warning'},svg('warn'),el('span',{},banner?'This business has overdue invoices. Ask an admin to check payment before fulfilment.':'Account overdue')));
  if(account?.review)container.append(el('div',{class:(banner?'account-banner':'account-warning')+' review'},svg('info'),el('span',{},banner?'Payment status needs checking. Ask an admin to confirm the account.':'Payment status needs checking')));
  return container;
 }
 function draw(){
  $('statusFilters').replaceChildren(...filters.map(([id,label])=>el('button',{type:'button','aria-pressed':String(status===id),onclick:()=>{status=id;load()}},label)));
  $('orderCount').textContent=rows.length<total?`${rows.length} of ${total} orders`:`${total} ${total===1?'order':'orders'}`;
  $('orderList').replaceChildren(...rows.map(row=>el('button',{type:'button',class:'order-row','data-order-id':row.id,onclick:()=>openOrder(row.id)},el('span',{},el('b',{},row.business),el('span',{class:'row-meta'},`${row.locationName} · ${row.delivery} · ${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)}`),el('span',{class:'row-meta'},date(row.createdAt)),warning(row.account)),el('span',{class:'row-end'},pill(row.status),svg('chev')))));
  if(!rows.length)$('orderList').append(el('div',{class:'empty'},$('search').value.trim()?'No matching orders. Try another search or status.':'No orders in this view.'));
  $('loadMore').hidden=!cursor;
 }
 const kv=(label,value)=>el('div',{class:'kv'},el('span',{},label),el('span',{},value||'None supplied'));
 function renderDetail(row){
  $('orderDetail').replaceChildren(el('div',{class:'business-title'},el('h3',{},row.business),pill(row.status)),el('p',{class:'detail-id'},row.id),warning(row.account,true),el('div',{class:'details'},kv('Location',row.locationName),kv('Received',date(row.createdAt)),kv('Reference',row.reference),kv('Delivery preference',row.delivery)),el('h3',{class:'packing-heading'},'Packing list'),el('div',{class:'w-packing-list'},...row.lines.map(line=>{const grind=grindFor(line);return el('div',{class:'item w-packing-line w-grind-tone w-coffee-tone',style:`--w-grind-h:${grind.hue};${coffeeStyle(line)}`},el('span',{class:'w-pack-quantity'},el('b',{},String(line.quantity)),el('span',{},line.quantity===1?'bag':'bags')),el('span',{class:'tx'},el('b',{class:'w-pack-coffee'},el('span',{class:'w-coffee-swatch','aria-hidden':'true'}),line.title,decafLine(line)?el('span',{class:'w-decaf-label'},'Decaf'):null),el('span',{class:'w-pack-size'},line.packLabel),el('span',{class:'w-grind-details'},el('span',{class:'w-grind-badge'},svg(grind.icon),grind.label),grind.hint?el('span',{class:'w-grind-hint'},grind.hint):null)))})),el('p',{class:'packing-total'},`${row.packs} ${row.packs===1?'bag':'bags'} · ${weight(row.grams)} total`));
  if(row.delivery==='Delivery'&&(row.address||row.postcode))$('orderDetail').append(el('h3',{class:'packing-heading'},'Delivery address'),el('p',{class:'address'},[row.address,row.postcode].filter(Boolean).join('\n')));
  for(const [label,text]of[['Delivery notes',row.deliveryNotes],['Customer comments',row.customerNote]])if(text)$('orderDetail').append(el('div',{class:'detail-note'},el('b',{},label),text));
  if(row.trackingUrl){try{const url=new URL(row.trackingUrl);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)$('orderDetail').append(el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer',class:'tracking'},'Track delivery ↗'))}catch{}}
 }
 function openOrder(id){const row=rows.find(row=>row.id===id);if(!row)return;selected=id;renderDetail(row);$('orderDialog').showModal();}
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
  }catch(error){if(current===sequence){lock(true);message('Orders could not be verified. Reconnect, then try again.',{retry:true});}}
  finally{if(current===sequence){$('refresh').disabled=false;$('refresh').setAttribute('aria-busy','false');$('loadMore').disabled=false;}}
 }
 $('refresh').onclick=()=>load({reverify:true});$('loadMore').onclick=()=>load({more:true});
 $('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(),250)};
 $('closeOrder').onclick=$('doneOrder').onclick=()=>{$('orderDialog').close();selected=null};
 $('orderDialog').addEventListener('close',()=>{selected=null});
 addEventListener('blur',()=>{sequence++;lock();});addEventListener('pagehide',()=>{sequence++;lock();});
 addEventListener('focus',()=>{if(started)load({reverify:true})});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){sequence++;lock()}else if(started)load({reverify:true})});
 addEventListener('pageshow',event=>{if(event.persisted&&started)load({reverify:true})});addEventListener('online',()=>load({reverify:true}));
 SC.recheckOnPageshow();
 (async()=>{const me=await SC.startSession({clear:()=>{sequence++;started=false;clearInterval(timer);lock(true)}});if(!me)return;$('signedIn').textContent=me.user.name;started=true;await load({reverify:true});timer=setInterval(()=>{if(started&&!document.hidden)load()},15000)})();
})();
