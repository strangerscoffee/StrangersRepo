// The staff orders page (diary host) for accounts an admin has given wholesale orders access. Separate from Admin's
// order payload: no money, invoice documents or employee attribution. Granted staff may read and edit an order's
// status, internal note and tracking link (the same version-checked update as Admin), print orders and bag totals,
// and read customers' contact and delivery details (never payment terms, internal customer notes, the minimum-order
// exemption or login details).
import type {User} from "./auth";
import {ApiError,type Env,invalid,json,readJson} from "./http";
import {customerOrdersUrl,ordersToPrint,updateOrderStatus} from "./wholesale";
import {customerLocations} from "./wholesaleCustomers";
import {object} from "./wholesaleStore";
import {requireStaffOrders} from "./staffOrdersAccess";

const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
async function paymentFlags(env:Env,customerIds:string[]){
  const result=new Map<string,{overdue:boolean;review:boolean}>(),ids=[...new Set(customerIds)];
  for(let start=0;start<ids.length;start+=50){
    const group=ids.slice(start,start+50);
    const rows=await env.DB.prepare(`SELECT i.customer_id,
      MAX(CASE WHEN json_extract(i.data,'$.dueDate')<? AND (
        (e.id IS NULL AND i.paid=0 AND json_extract(i.data,'$.totals.grossPence')>0) OR
        (e.id IS NOT NULL AND o.status IN ('unpaid','part-paid') AND o.outstanding_pence>0)
      ) THEN 1 ELSE 0 END) AS overdue,
      MAX(CASE WHEN e.id IS NOT NULL AND (o.status IS NULL OR o.status='review') THEN 1 ELSE 0 END) AS review
      FROM wholesale_invoices i
      LEFT JOIN quickbooks_exports e ON e.invoice_id=i.seq AND e.environment='production' AND e.state='linked'
      LEFT JOIN quickbooks_observations o ON o.export_id=e.id
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
    deliveryNotes:o.locationSnapshot?.deliveryNotes??o.deliveryNotes??'',customerNote:o.customerNote||'',note:o.note||'',trackingUrl:o.trackingUrl||'',packs:o.packs,grams:o.grams,
    lines:o.lines.map((l:any)=>({productId:l.productId,title:l.title,pack:l.pack,packLabel:l.packLabel,grind:l.grind,grindLabel:l.grindLabel,grindHint:l.grindHint,decaf:l.decaf,quantity:l.quantity,grams:l.grams})),
    account:account||{overdue:false,review:false},
  };
}
/** A customer's contact and delivery details, read-only for staff with orders access. */
function staffCustomer(row:{id:string;data:string}){
  const c=JSON.parse(row.data);
  return {id:row.id,business:c.business,contact:c.contact||'',email:c.email||'',phone:c.phone||'',status:c.status==='On hold'?'On hold':'Active',
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
export async function handleStaffOrders(req:Request,env:Env,route:string,user:User,links:{preview?:string}={},ctx?:ExecutionContext):Promise<Response>{
  await requireStaffOrders(env,user);
  const orderMatch=/^orders\/((?:PREVIEW|WS)-[A-F0-9]{32})$/.exec(route);
  if(orderMatch){
    if(req.method!=="PATCH")return json({code:"method_not_allowed",message:"Use PATCH to change an order."},405,{Allow:"PATCH"});
    const body=object(await readJson(req,8192));
    const updated=await updateOrderStatus(env,orderMatch[1],{ifVersion:body.ifVersion,status:body.status,note:body.note,trackingUrl:body.trackingUrl},user.name,{customerOnly:true,notify:{ctx,ordersUrl:customerOrdersUrl(env,links,req)}});
    await requireStaffOrders(env,user);
    return json({order:staffView(updated)});
  }
  if(req.method!=="GET")return json({code:"method_not_allowed",message:"Only order status and notes can be changed here."},405,{Allow:"GET"});
  if(route==="print"){
    const orders=(await ordersToPrint(env,new URL(req.url).searchParams,{customerOnly:true})).map(o=>staffView(o));
    await requireStaffOrders(env,user);
    return json({orders,printedAt:Date.now()});
  }
  if(route==="customers"){const result=await customers(req,env);await requireStaffOrders(env,user);return json(result);}
  if(route!=="orders")throw new ApiError(404,"not_found","Not available on the staff orders dashboard.");
  const query=new URL(req.url).searchParams,q=(query.get('q')||'').trim(),status=query.get('status')||'open';
  if(q.length>120)throw invalid("Search can be up to 120 characters.");
  if(!['open','all','New','Preparing','Ready','Dispatched','Cancelled'].includes(status))throw invalid("Choose a listed order status.");
  const where=["kind='order'","json_extract(data,'$.preview')=0","json_extract(data,'$.deletedAt') IS NULL"],values:(number|string)[]=[];
  if(status==='open')where.push("json_extract(data,'$.status') IN ('New','Preparing','Ready')");
  else if(status!=='all'){where.push("json_extract(data,'$.status')=?");values.push(status)}
  if(q){const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(id LIKE ? ESCAPE '\\' OR json_extract(data,'$.business') LIKE ? ESCAPE '\\' OR json_extract(data,'$.reference') LIKE ? ESCAPE '\\')");values.push(pattern,pattern,pattern)}
  const base=where.join(' AND '),cursor=query.get('cursor');
  if(cursor){const match=/^(\d{1,16}):([a-zA-Z0-9-]{1,80})$/.exec(cursor);if(!match||!Number.isSafeInteger(Number(match[1])))throw invalid("Reload orders before loading more.");where.push('(updated_at<? OR (updated_at=? AND id>?))');values.push(Number(match[1]),Number(match[1]),match[2])}
  const [rows,total]=await Promise.all([
    env.DB.prepare(`SELECT id,data,version,updated_at FROM wholesale_preview WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id LIMIT 101`).bind(...values).all<{id:string;data:string;updated_at:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_preview WHERE ${base}`).bind(...values.slice(0,cursor?-3:undefined)).first<{n:number}>(),
  ]);
  const records=rows.results.slice(0,100).map(row=>({...row,order:{...JSON.parse(row.data),version:(row as any).version}}));
  const flags=await paymentFlags(env,records.map(r=>r.order.customerId).filter((id):id is string=>typeof id==='string'&&!!id));
  const orders=records.map(({id,order:o})=>staffView({...o,id},flags.get(o.customerId)));
  // Recheck before releasing the response if access was revoked while the list/observations were read.
  await requireStaffOrders(env,user);
  const last=records.at(-1);
  return json({orders,count:total?.n||0,nextCursor:rows.results.length>100&&last?`${last.updated_at}:${last.id}`:null});
}
