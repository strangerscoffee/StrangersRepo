import { startAutoInvoice } from "./autoInvoice";
// The staff orders page (diary host) for accounts an admin has given wholesale orders access. Separate from Admin's
// order payload: no money, invoice documents or employee attribution. Granted staff may read and edit an order's
// status, internal note and tracking link (the same version-checked update as Admin), print orders and bag totals,
// and read customers' contact and delivery details (never payment terms, internal customer notes, the minimum-order
// exemption or login details).
import type {User} from "./auth";
import {ApiError,type Env,invalid,json,readJson} from "./http";
import {customerOrdersUrl,ordersToPrint,takeOrderFor,TAKEN_SOURCES,tellCustomerStandingChange,updateOrderStatus,updatePackingLine} from "./wholesale";
import {dispatchFilter,orderSort,packingTotals} from "./wholesalePacking";
import {wholesaleCustomer} from "./wholesaleAccounts";
import {catalogue,packsOf} from "./wholesaleCatalogue";
import {catalogueFor} from "./wholesaleWhiteLabel";
import {customerLocations} from "./wholesaleCustomers";
import {get,object} from "./wholesaleStore";
import {audit} from "./audit";
import {clearTab,listTabs,setOnTab} from "./wholesaleTabs";
import {amendLines,skipRun} from "./wholesaleStanding";
import {requireStaffOrders} from "./staffOrdersAccess";
import {LIVE_ACCOUNTING_JOIN,UNCONFIRMED_BALANCE_SQL,PAYMENT_DUE_SQL,OUTSTANDING_BALANCE_SQL} from "./quickbooks/observations";

const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
async function paymentFlags(env:Env,customerIds:string[]){
  const result=new Map<string,{overdue:boolean;review:boolean}>(),ids=[...new Set(customerIds)];
  for(let start=0;start<ids.length;start+=50){
    const group=ids.slice(start,start+50);
    const rows=await env.DB.prepare(`SELECT i.customer_id,
      MAX(CASE WHEN ${PAYMENT_DUE_SQL}<? AND ${OUTSTANDING_BALANCE_SQL}>0 THEN 1 ELSE 0 END) AS overdue,
      MAX(CASE WHEN ${UNCONFIRMED_BALANCE_SQL} THEN 1 ELSE 0 END) AS review
      FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN}
      WHERE i.customer_id IN (${group.map(()=>'?').join(',')}) GROUP BY i.customer_id`).bind(today(),...group).all<{customer_id:string;overdue:number;review:number}>();
    for(const row of rows.results)result.set(row.customer_id,{overdue:!!row.overdue,review:!!row.review});
  }
  return result;
}
/** What the staff orders page sees of an order: fulfilment details, never prices, invoices or who placed it. */
function staffView(o:any,account?:{overdue:boolean;review:boolean}){
  return {
    id:o.id,version:o.version,business:o.business,reference:o.reference,status:o.status,delivery:o.delivery,createdAt:o.createdAt,
    locationName:o.locationSnapshot?.name||'Main location',
    address:o.locationSnapshot?.address??o.customerSnapshot?.address??'',postcode:o.locationSnapshot?.postcode??o.customerSnapshot?.postcode??'',
    deliveryNotes:o.locationSnapshot?.deliveryNotes??o.deliveryNotes??'',customerNote:o.customerNote||'',note:o.note||'',takenSource:o.takenFor?.source||'',trackingUrl:o.trackingUrl||'',dispatchDate:o.dispatchDate||'',standingEvery:o.standing?.every||0,onTab:!!o.tab&&!o.tabClearedId,customerId:o.customerId||null,packs:o.packs,grams:o.grams,
    lines:o.lines.map((l:any)=>({productId:l.productId,title:l.title,pack:l.pack,packLabel:l.packLabel,grind:l.grind,grindLabel:l.grindLabel,grindHint:l.grindHint,decaf:l.decaf,quantity:l.quantity,grams:l.grams,...(l.recipe?{recipe:l.recipe}:{})})),
    account:account||{overdue:false,review:false},...(Array.isArray(o.packedLines)?{packedLines:o.packedLines}:{}),
    // Changes to the bags and skipped deliveries: whether the customer did it themselves, never which staff member.
    changed:o.amendedAt?{at:o.amendedAt,byCustomer:!!o.amendedByCustomer,thisDeliveryOnly:!!o.repeatLines}:null,
    skipped:o.skipped?{at:o.skipped.at,byCustomer:!!o.skipped.customer}:null,
  };
}
/** A customer's contact and delivery details, read-only for staff with orders access. */
function staffCustomer(row:{id:string;data:string}){
  const c=JSON.parse(row.data);
  return {id:row.id,business:c.business,contact:c.contact||'',email:c.email||'',accountsEmail:c.accountsEmail||'',phone:c.phone||'',status:c.status==='On hold'?'On hold':'Active',
    locations:customerLocations(c).map(l=>({id:l.id,name:l.name,contact:l.contact,phone:l.phone,address:l.address,postcode:l.postcode,deliveryNotes:l.deliveryNotes})),
    defaultLocationId:c.defaultLocationId||'primary'};
}
async function customers(req:Request,env:Env){
  const q=(new URL(req.url).searchParams.get('q')||'').trim();
  if(q.length>120)throw invalid("Search can be up to 120 characters.");
  const where=["kind='customer'"],values:string[]=[];
  if(q){const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(json_extract(data,'$.business') LIKE ? ESCAPE '\\' OR json_extract(data,'$.contact') LIKE ? ESCAPE '\\' OR json_extract(data,'$.postcode') LIKE ? ESCAPE '\\')");values.push(pattern,pattern,pattern)}
  const rows=await env.DB.prepare(`SELECT id,data FROM wholesale_preview WHERE ${where.join(' AND ')} ORDER BY json_extract(data,'$.business') COLLATE NOCASE,id LIMIT 501`).bind(...values).all<{id:string;data:string}>();
  return {customers:rows.results.slice(0,500).map(staffCustomer),more:rows.results.length>500};
}
export async function handleStaffOrders(req:Request,env:Env,route:string,user:User,links:{preview?:string;diary?:string}={},ctx?:ExecutionContext):Promise<Response>{
  await requireStaffOrders(env,user);
  const closeAttempt=/^attempts\/(WS-[A-F0-9]{32})\/close$/.exec(route);
  if(closeAttempt&&req.method==="POST"){
    const body=object(await readJson(req,2048));
    if(typeof body.customerId!=="string"||!/^[a-f0-9-]{36}$/.test(body.customerId))throw invalid("Choose the original customer.");
    const at=Date.now(),id=closeAttempt[1];
    // Competes atomically with the original INSERT. Never cancels an existing
    // order: a saved order wins and is recovered; otherwise a tombstone prevents
    // any delayed original request from arriving after the user starts again.
    const marker={preview:false,customerId:body.customerId,createdBy:user.id,createdName:user.name,takenFor:{source:"Other",at},unplacedAttempt:true,requestKey:"closed-attempt:"+user.id,status:"Cancelled",deletedAt:at,deletedBy:user.name,createdAt:at,date:today(),lines:[],pence:0,grams:0,packs:0};
    const inserted=await env.DB.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',?,?,1,?) ON CONFLICT(kind,id) DO NOTHING").bind(id,JSON.stringify(marker),at).run();
    const order=await get<Record<string,any>>(env,"order",id);
    if(!order||order.createdBy!==user.id||!order.takenFor||order.preview!==false)throw new ApiError(404,"not_found","This request belongs to another account.");
    await requireStaffOrders(env,user);
    if(order.deletedAt==null)return json({closed:false,order:staffView(order)});
    if(inserted.meta.changes)await audit(env,"staff_order_attempt_closed",user.name,`${user.name} closed unplaced wholesale request ${id}. No customer order was cancelled.`);
    return json({closed:true});
  }
  const receipt=/^orders\/(WS-[A-F0-9]{32})\/receipt$/.exec(route);
  if(receipt&&req.method==="GET"){
    const order=await get<Record<string,any>>(env,"order",receipt[1]);
    if(!order||order.createdBy!==user.id||!order.takenFor||order.preview!==false)throw new ApiError(404,"not_found","No submitted order found for this account.");
    if(order.deletedAt!=null)throw new ApiError(410,"order_deleted","This order or request is closed. Acknowledge the outcome before starting another order.");
    await requireStaffOrders(env,user);
    return json({order:staffView(order)});
  }
  const orderMatch=/^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if(orderMatch){
    if(req.method!=="PATCH")return json({code:"method_not_allowed",message:"Use PATCH to change an order."},405,{Allow:"PATCH"});
    const body=object(await readJson(req,8192));
    const updated=await updateOrderStatus(env,orderMatch[1],{ifVersion:body.ifVersion,status:body.status,note:body.note,trackingUrl:body.trackingUrl,requirePacked:body.requirePacked},user.name,{customerOnly:true,notify:{ctx,ordersUrl:customerOrdersUrl(env,links,req)}});
    await requireStaffOrders(env,user);
    return json({order:staffView(updated)});
  }
  const packingOrder=/^orders\/(WS-[A-F0-9]{32})\/packing$/.exec(route);
  if(packingOrder&&req.method==="PATCH"){
    const order=await updatePackingLine(env,packingOrder[1],object(await readJson(req,2048)));
    const flags=await paymentFlags(env,order.customerId?[order.customerId]:[]);
    await requireStaffOrders(env,user);
    return json({order:staffView(order,order.customerId?flags.get(order.customerId):undefined)});
  }
  if(route==="packing-totals"&&req.method==="GET"){
    const totals=await packingTotals(env,new URL(req.url).searchParams);
    await requireStaffOrders(env,user);
    return json(totals);
  }
  // Changing the bags on an order (and, on a standing order, for this delivery only or from now on) and skipping a
  // standing delivery: the same rules as Admin. Bags only here; the server prices them.
  const change=/^orders\/(WS-[A-F0-9]{32})\/(lines|skip)$/.exec(route);
  if(change&&((change[2]==="lines"&&req.method==="PUT")||(change[2]==="skip"&&req.method==="POST"))){
    const body=await readJson(req,32*1024),id=change[1];
    const saved=change[2]==="lines"?await amendLines(env,id,body,user.name):await skipRun(env,id,body,user.name,{},ctx);
    await requireStaffOrders(env,user);
    await tellCustomerStandingChange(env,ctx,saved,change[2] as "lines"|"skip",body,customerOrdersUrl(env,links,req),new URL(links.diary||"/",req.url).href,user.name);
    return json({order:staffView(saved as any)});
  }
  // Customer tabs: kg and bags only here (no money); the same checks as Admin.
  const tabOrder=/^orders\/(WS-[A-F0-9]{32})\/tab$/.exec(route),tabClear=/^tabs\/([a-f0-9-]{36})\/clear$/.exec(route);
  if(tabOrder&&req.method==="PUT"){const saved=await setOnTab(env,tabOrder[1],await readJson(req,4096),user.name);await requireStaffOrders(env,user);return json({order:staffView(saved)});}
  if(tabClear&&req.method==="POST"){const cleared=await clearTab(env,tabClear[1],await readJson(req,64*1024),user.name);await startAutoInvoice(env,"tab:"+cleared.id,ctx);await requireStaffOrders(env,user);return json({cleared});}
  if(route==="tabs"&&req.method==="GET"){const tabs=await listTabs(env);await requireStaffOrders(env,user);return json(tabs);}
  // Taking an order for a customer (by email, phone or at the door): the same checks as the ordering site, at
  // today's catalogue prices, which this page never shows.
  if(route==="orders"&&req.method==="POST"){
    const placed=await takeOrderFor(req,env,{id:user.id,name:user.name},{admin:"",diary:new URL(links.diary||"/",req.url).href,preview:links.preview},ctx);
    await requireStaffOrders(env,user);
    return json({order:staffView(placed.order),created:placed.created},placed.created?201:200);
  }
  if(req.method!=="GET")return json({code:"method_not_allowed",message:"Only order status and notes can be changed here."},405,{Allow:"GET"});
  // What a customer can order: their own coffees first, then the range; sizes and grinds, no prices.
  if(route==="catalogue"){
    const id=new URL(req.url).searchParams.get('customer')||'';
    const customer=/^[a-f0-9-]{36}$/.test(id)?await wholesaleCustomer(env,id):null;
    if(!customer)throw new ApiError(404,"not_found","Choose a customer from the list.");
    const products=catalogueFor((await catalogue(env)).filter(p=>p.active),customer.id).map((p:any)=>({id:p.id,title:p.title,yours:!!p.yours,inStock:!!p.inStock,decaf:(p.categories||[]).includes("decaf"),packs:packsOf(p),
      grinds:p.grindOptions.filter((g:any)=>g.enabled).map((g:any)=>({id:g.id,label:g.label,hint:g.hint||""}))}));
    await requireStaffOrders(env,user);
    return json({products,sources:TAKEN_SOURCES,autoTab:!!customer.autoTab,customer:{id:customer.id,business:customer.business,status:customer.status,email:customer.email||''}});
  }
  if(route==="print"){
    const orders=(await ordersToPrint(env,new URL(req.url).searchParams,{customerOnly:true})).map(o=>staffView(o));
    await requireStaffOrders(env,user);
    return json({orders,printedAt:Date.now()});
  }
  if(route==="customers"){const result=await customers(req,env);await requireStaffOrders(env,user);return json(result);}
  if(route!=="orders")throw new ApiError(404,"not_found","Not available on the staff orders dashboard.");
  const query=new URL(req.url).searchParams,q=(query.get('q')||'').trim(),status=query.get('status')||'open';
  if(q.length>120)throw invalid("Search can be up to 120 characters.");
  if(!['open','all','prepare','New','Preparing','Ready','Dispatched','Cancelled'].includes(status))throw invalid("Choose a listed order status.");
  const where=["kind='order'","json_extract(data,'$.preview')=0","json_extract(data,'$.deletedAt') IS NULL"],values:(number|string)[]=[];
  if(status==='open')where.push("json_extract(data,'$.status') IN ('New','Preparing','Ready')");
  else if(status==='prepare')where.push("json_extract(data,'$.status') IN ('New','Preparing')");
  else if(status!=='all'){where.push("json_extract(data,'$.status')=?");values.push(status)}
  if(q){const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(id LIKE ? ESCAPE '\\' OR json_extract(data,'$.business') LIKE ? ESCAPE '\\' OR json_extract(data,'$.reference') LIKE ? ESCAPE '\\')");values.push(pattern,pattern,pattern)}
  const scope=dispatchFilter(query);
  const base=where.join(' AND ')+scope.sql;
  values.push(...scope.args);
  // Dispatched orders are always newest dispatched first, on every screen.
  if(status==='Dispatched'&&!(query.get('sort')||'').startsWith('ordered'))query.set('sort','dispatched');
  const sort=orderSort(query);
  const [rows,total]=await Promise.all([
    env.DB.prepare(`SELECT id,data,version,${sort.key} AS sort_key FROM wholesale_preview WHERE ${base}${sort.after} ORDER BY sort_key ${sort.direction},id LIMIT 101`).bind(...values,...sort.values).all<{id:string;data:string;version:number;sort_key:string|number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE ${base}`).bind(...values).first<{n:number}>(),
  ]);
  const records=rows.results.slice(0,100).map(row=>({...row,order:{...JSON.parse(row.data),version:row.version}}));
  const flags=await paymentFlags(env,records.map(r=>r.order.customerId).filter((id):id is string=>typeof id==='string'&&!!id));
  const orders=records.map(({id,order:o})=>staffView({...o,id},flags.get(o.customerId)));
  // Recheck before releasing the response if access was revoked while the list/observations were read.
  await requireStaffOrders(env,user);
  const last=records.at(-1);
  return json({orders,count:total?.n||0,nextCursor:rows.results.length>100&&last?`${last.sort_key}:${last.id}`:null});
}
