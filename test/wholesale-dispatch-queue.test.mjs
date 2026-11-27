import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { DISPATCH_QUEUE_BATCH } from "../src/wholesale/dispatchQueueCandidates.ts";

const root = fileURLToPath(new URL("../",import.meta.url));
const id = n => "WS-" + n.toString(16).toUpperCase().padStart(32,"0");
const base = {status:"Ready",preview:false,business:"Norwich Coffee",delivery:"Delivery",customerId:"account",
  grams:1000,pence:98765,lines:[],dispatchDate:"2026-12-01",paymentTerms:{id:"net-30"},
  locationSnapshot:{address:"10 Dove Street, Norwich, Norfolk",postcode:"NR2 1DE",contact:"Private recipient"},
};
const binding = value => ({type:"text",value});

test("Staff and Admin dispatch queue share accurate role-limited stages, paging and handover guards", async t => {
  const bundle = await build({stdin:{resolveDir:root,contents:`
    import { ensureSchema } from "./src/schema";
    import { handleStaffOrders } from "./src/staffOrders";
    import { handleWholesaleAdmin } from "./src/wholesale";
    import { errorResponse } from "./src/http";
    export default { async fetch(req,env) {
      await ensureSchema(env);
      const user={role:req.headers.get("role"),name:"Queue tester",id:"tester"};
      const [workspace,...parts]=new URL(req.url).pathname.slice(1).split("/");
      try {
        return workspace==="admin" ? await handleWholesaleAdmin(req,env,parts.join("/"),user,{})
          : await handleStaffOrders(req,env,parts.join("/"),user);
      } catch(error) { if(error.status) return errorResponse(error); throw error; }
    }};
  `}, format:"esm",platform:"browser",target:"es2022",bundle:true,write:false,external:["cloudflare:*"]});
  const worker = new Miniflare({host:"127.0.0.1",port:0,telemetry:{enabled:false},cf:false,workers:[{config:{
    name:"queue-test",compatibilityDate:"2026-10-01",manifest:{modulesRoot:root,mainModule:"index.js",
      modules:{"index.js":{type:"esm",contents:bundle.outputFiles[0].text}}},
    env:{DB:{type:"d1",name:"queue-db"},WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY:binding("test-click-drop"),
      WHOLESALE_ROYAL_MAIL_SERVICE_CODE:binding("TPS48")},
  },dev:{outboundService:{type:"fetcher",handler(){throw new Error("The queue attempted a provider operation.");}}}}]});
  t.after(()=>worker.dispose());
  function req(role="admin",space=role,path="dispatch-queue",method="GET",body) {
    return worker.dispatchFetch("https://example.com/"+space+"/"+path,{method,headers:{role,"content-type":"application/json"},
      ...(body&&{body:JSON.stringify(body)})});
  }
  async function queue(role="staff",query="") {
    const result = await req(role,role,"dispatch-queue"+query);
    assert.equal(result.status,200,await result.clone().text());
    assert.match(result.headers.get("cache-control"),/no-store/);
    return result.json();
  }
  assert.equal((await req("staff","admin")).status,403);
  assert.equal((await req("staff")).status,403);
  const db=await worker.getD1Database("DB");
  const query=(sql,...args)=>db.prepare(sql).bind(...args);
  await db.batch([
    query("INSERT INTO users(id,name,name_key,role,pin_hash,pin_salt,created_at,updated_at) VALUES('tester','Tester','tester','staff','x','x',0,0)"),
    query("INSERT INTO staff_order_access(user_id,enabled,updated_at,updated_by) VALUES('tester',1,0,'fixture')"),
    query("INSERT INTO wholesale_preview(kind,id,data,updated_at) VALUES('customer','account',?,0)",JSON.stringify({status:"Active"})),
    query("INSERT INTO wholesale_preview(kind,id,data,updated_at) VALUES('customer','held',?,0)",JSON.stringify({status:"On hold"})),
    query("UPDATE wholesale_royal_mail_settings SET enabled=1"),
  ]);
  const seed=(n,changes={})=>query("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',?,?,1,0)",id(n),JSON.stringify({...base,...changes}));
  const shipment=(n,state,provider=null,download=null,due=null,requested=1)=>query(
    "INSERT INTO wholesale_royal_mail_shipments(order_id,state,operation,order_version,provider_id,weight_grams,updated_at,label_downloaded_at,recovery_due_at,requested_at) VALUES(?,?,?,1,?,1200,1,?,?,?)",
    id(n),state,"op-"+n,provider,download,due,requested);
  await db.batch([
    seed(1),seed(2),seed(3),seed(4),seed(5),seed(6,{customerId:"held"}),seed(7,{locationSnapshot:{address:"UNKNOWN",postcode:"??"}}),
    seed(8),seed(9),seed(10),seed(11,{status:"Dispatched"}),seed(12,{skipped:true}),seed(13,{delivery:"Collection"}),
    seed(14,{deletedAt:1}),seed(15,{preview:true}),seed(16,{delivery:" courier "}),
    shipment(2,"labelled",2),shipment(3,"labelled",3,123),shipment(4,"review",null,null,Date.now()+1000),
    shipment(5,"review",null,null,0),shipment(8,"created",8),shipment(9,"failed"),shipment(10,"failed",null,null,null,0),
  ]);
  const plan=await query("EXPLAIN QUERY PLAN "+DISPATCH_QUEUE_BATCH,"",100).all();
  assert.ok(plan.results.some(row=>row.detail.startsWith("SEARCH ") && row.detail.includes("wholesale_dispatch_queue_orders")),JSON.stringify(plan.results));
  assert.ok(plan.results.every(row=>!row.detail.includes("TEMP B-TREE")),JSON.stringify(plan.results));
  const expected={weigh:3,print:1,handover:1,attention:5,checking:1};
  const staff=await queue();
  assert.deepEqual(staff.counts,expected);
  assert.equal(staff.orders.length,11);
  assert.doesNotMatch(JSON.stringify(staff), /Private recipient|98765|10 Dove Street|customerId|TPS48/);
  const admin=await queue("admin");
  assert.deepEqual(admin.counts,expected);
  assert.deepEqual(admin.orders.map(o=>[o.id,o.stage]),staff.orders.map(o=>[o.id,o.stage]));
  assert.equal(admin.orders.find(o=>o.id===id(6)).action,"account");
  assert.equal(staff.orders.find(o=>o.id===id(6)).action,"shipping");
  assert.equal(staff.orders.find(o=>o.id===id(9)).stage,"attention");
  assert.equal(staff.orders.find(o=>o.id===id(10)).stage,"weigh");

  // Keyset pages cross DB slices and keep global filtered counts even when the next action changes.
  const many=Array.from({length:110},(_,i)=>seed(100+i,{dispatchDate:i<2?"2026-11-01":null}));
  for(let i=0;i<many.length;i+=40) await db.batch(many.slice(i,i+40));
  const first=await queue("staff","?stage=weigh&limit=99");
  const second=await queue("staff","?stage=weigh&cursor="+encodeURIComponent(first.nextCursor));
  assert.equal(first.orders[0].id,id(100));
  assert.equal(first.orders.length,99);
  assert.equal(second.orders.length,14);
  assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.orders,...second.orders].map(o=>o.id)).size,113);
  assert.deepEqual(first.counts,second.counts);
  for(const query of ["?limit=101","?stage=unknown","?stage=all&cursor="+encodeURIComponent(first.nextCursor)]) {
    assert.equal((await req("staff","staff","dispatch-queue"+query)).status,400);
  }
  assert.equal((await req("staff","staff","dispatch-queue","POST",{})).status,405);

  // Changing an unrelated order field does not invalidate the label; changing its address does.
  const fingerprint=createHash("sha256").update(JSON.stringify([base.customerId,null,base.business,base.delivery,
    base.locationSnapshot.address,base.locationSnapshot.postcode,base.locationSnapshot.contact,base.grams,[]])).digest("base64");
  await query("UPDATE wholesale_royal_mail_shipments SET shipping_fingerprint=? WHERE order_id=?",fingerprint,id(2)).run();
  await query("UPDATE wholesale_preview SET data=json_set(data,'$.note','Private note'),version=2 WHERE id=?",id(2)).run();
  assert.equal((await queue("staff","?stage=print")).orders[0].id,id(2));
  await query("UPDATE wholesale_preview SET data=json_set(data,'$.locationSnapshot.address','52 Another Road, Norwich'),version=3 WHERE id=?",id(2)).run();
  assert.equal((await queue("staff","?stage=print")).orders.length,0);
  assert.match((await queue("admin","?stage=attention")).orders.find(o=>o.id===id(2)).reason,/order changed/i);
  await query("UPDATE wholesale_preview SET data=?,version=1 WHERE id=?",JSON.stringify(base),id(2)).run();

  // Coffee below 30 kg can exceed the one-parcel limit once the bags, overfill and box are added.
  const kilos=quantity=>({grams:quantity*1000,lines:[{productId:"beans",pack:"kilo",grams:1000,quantity}]});
  await db.batch([seed(280,kilos(28)),seed(270,kilos(27)),seed(290,{grams:29500}),seed(291,{grams:29501}),
    seed(292,kilos(28)),shipment(292,"labelled",292,123)]);
  const attention=await queue("admin","?stage=attention");
  for(const n of [280,291]) assert.match(attention.orders.find(o=>o.id===id(n)).reason,/exceeds 30 kg.*Click & Drop/);
  assert.equal(attention.orders.some(o=>o.id===id(270)||o.id===id(290)),false);
  assert.equal((await queue("staff","?stage=handover")).orders.some(o=>o.id===id(292)),true);

  // A previously loaded handover row loses its authority when payment eligibility, label or delivery changes.
  const confirm=(n,space,extra={})=>req(space,space,"orders/"+id(n),"PATCH",{ifVersion:1,status:"Dispatched",customerId:"account",queueHandover:true,...extra});
  const noDownload=await confirm(2,"admin");
  assert.equal(noDownload.status,409,await noDownload.clone().text());
  assert.equal((await noDownload.json()).code,"royal_mail_handover_review");
  await query("UPDATE wholesale_preview SET data=json_set(data,'$.status','On hold') WHERE id='account'").run();
  for(const role of ["admin","staff"]) {
    const response=await confirm(3,role);
    assert.equal(response.status,409,await response.clone().text());
    assert.equal((await response.json()).code,"royal_mail_account_on_hold");
  }
  assert.equal((await queue("staff","?stage=handover")).orders.length,0);
  assert.equal(await query("SELECT json_extract(data,'$.status') AS status FROM wholesale_preview WHERE id=?",id(3)).first("status"),"Ready");
  await query("UPDATE staff_order_access SET enabled=0 WHERE user_id='tester'").run();
  assert.equal((await req("staff")).status,403);
});
