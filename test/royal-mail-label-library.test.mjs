import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const id = n => 'WS-' + n.toString(16).toUpperCase().padStart(32, '0');
const sample = { preview: false, business: 'Workshop Café', reference: 'Buyer-77%', customerId: 'customer', status: 'Ready',
  delivery: 'Delivery', grams: 1000, lines: [], createdAt: 100, note: 'PRIVATE ADMIN NOTE',
  customerSnapshot: { address: 'Private street', postcode: 'NR1 1AA', contact: 'Private recipient', email: 'private@example.test' } };

test('generated label archive pages genuine shipments, keeps historical holds and performs no carrier operations', async t => {
  const bundle = await build({stdin:{resolveDir:root,contents:`
    import { applySchema, ensureSchema } from "./src/schema";
    import { handleWholesaleAdmin } from "./src/wholesale";
    import { errorResponse } from "./src/http";
    export default {async fetch(req,env) {
      try {
        if (new URL(req.url).pathname==='/schema') {await applySchema(env); return new Response('ok');}
        await ensureSchema(env);
        return await handleWholesaleAdmin(req,env,"royal-mail/labels",{id:"local",name:"Fixture",role:req.headers.get("role")},{});
      } catch(error){if(error.status) return errorResponse(error); throw error;}
    }};
  `},format:'esm',platform:'browser',target:'es2022',bundle:true,write:false,external:['cloudflare:*']});
  const worker=new Miniflare({host:'127.0.0.1',port:0,telemetry:{enabled:false},cf:false,workers:[{config:{
    name:'label-library',compatibilityDate:'2026-10-01',manifest:{modulesRoot:root,mainModule:'index.js',modules:{
      'index.js':{type:'esm',contents:bundle.outputFiles[0].text}}},
    env:{DB:{type:'d1',name:'label-library-db'},WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY:{type:'text',value:'fixture-key'},
      WHOLESALE_ROYAL_MAIL_SERVICE_CODE:{type:'text',value:'CURRENT-SERVICE'}},
  },dev:{outboundService:{type:'fetcher',handler(){throw new Error('A history request touched the carrier.');}}}}]});
  t.after(()=>worker.dispose());
  const request=(search='',role='admin',method='GET')=>worker.dispatchFetch('https://fixture.test/labels'+search,{method,headers:{role}});
  const archive=async search=>{const res=await request(search);assert.equal(res.status,200,await res.clone().text());
    assert.match(res.headers.get('cache-control'),/no-store/);return res.json();};
  assert.deepEqual(await archive(),{labels:[],nextCursor:null,total:0,outstandingCount:0});
  for(const role of ['staff','manager','wholesale']) assert.equal((await request('',role)).status,403);
  const post=await request('','admin','POST');assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');

  const db=await worker.getD1Database('DB');
  const insert=(n,order={})=>db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',?,?,1,100)")
    .bind(id(n),JSON.stringify({...sample,...order}));
  const ship=(n,{state='labelled',provider=n,requested=1000,downloaded=null,review=0,tracking=null,service=null}={})=>db.prepare(
    "INSERT INTO wholesale_royal_mail_shipments(order_id,state,operation,order_version,provider_id,weight_grams,updated_at,requested_at,label_downloaded_at,review_required,tracking_number,service_code) VALUES(?,?,?,1,?,1550,9999,?,?,?,?,?)")
    .bind(id(n),state,'private-operation-'+n,provider,requested,downloaded,review,tracking,service);
  await db.batch([
    insert(1),ship(1,{tracking:'AB987654321GB',service:'NDA'}),
    insert(2,{reference:'Second'}),ship(2,{downloaded:1111}),
    insert(3,{status:'Dispatched',business:'Meadow House',reference:'DISPATCH-10'}),ship(3,{state:'dispatched',requested:555}),
    insert(4,{delivery:' courier ',createdAt:23}),ship(4,{requested:null,review:1}),
    insert(5,{createdAt:undefined}),ship(5,{requested:0}),
    insert(6,{reference:'Amended order'}),ship(6,{requested:333}),
    insert(10,{preview:true}),ship(10),insert(11,{deletedAt:234}),ship(11),
    insert(12,{skipped:{at:333}}),ship(12),insert(13,{delivery:'Roastery collection'}),ship(13),
    insert(14,{customerId:null}),ship(14),insert(15,{preview:undefined}),ship(15),
    insert(16),ship(16,{state:'created'}),insert(17),ship(17,{state:'review',provider:null}),
    insert(18),ship(18,{state:'failed'}),insert(19),ship(19,{provider:0}),
    insert(20,{status:'Cancelled'}),ship(20),ship(21),insert(22),
    insert(23),ship(23,{state:'review',provider:null}),
    db.prepare('UPDATE wholesale_royal_mail_shipments SET retired_operation=operation WHERE order_id IN (?,?)').bind(id(1),id(23)),
    db.prepare('UPDATE wholesale_royal_mail_shipments SET retired_operation=? WHERE order_id=?').bind('earlier-operation',id(17)),
  ]);
  const requestPage = await archive('?view=requests&limit=2');
  assert.equal(requestPage.total,3);
  assert.deepEqual(requestPage.requests.map(row=>[row.id,row.status]),[[id(18),'needs_attention'],[id(17),'unconfirmed']]);
  const remaining = await archive('?view=requests&cursor='+encodeURIComponent(requestPage.nextCursor));
  assert.deepEqual(remaining.requests.map(row=>[row.id,row.status]),[[id(16),'awaiting_label']]);
  assert.equal(remaining.nextCursor,null);
  assert.equal((await request('?cursor='+encodeURIComponent(requestPage.nextCursor))).status,400);
  assert.equal((await request('?view=requests&status=downloaded')).status,400);
  for (const role of ['manager','staff','wholesale']) assert.equal((await request('?view=requests',role)).status,403);
  assert.doesNotMatch(JSON.stringify(requestPage),/private-operation|private@example|Private street|canPreview|provider_id|recipient/i);
  const pendingMatch=await archive('?search='+id(17));
  assert.equal(pendingMatch.total,0);
  assert.equal(pendingMatch.outstandingCount,1);
  assert.equal((await archive('?search='+id(23))).outstandingCount,0);
  assert.deepEqual(await archive('?view=requests&search='+id(23)),{requests:[],total:0,nextCursor:null});
  // Re-run migration 56 against pre-feature shipment rows: request time wins, then actual order time, otherwise unknown.
  await db.prepare('DELETE FROM schema_migrations WHERE id=56').run();
  assert.equal((await worker.dispatchFetch('https://fixture.test/schema')).status,200);
  const fingerprint=createHash('sha256').update(JSON.stringify([
    sample.customerId,null,sample.business,sample.delivery,'Private street','NR1 1AA','Private recipient',1000,[],
  ])).digest('base64');
  await db.prepare('UPDATE wholesale_royal_mail_shipments SET shipping_fingerprint=? WHERE order_id=?').bind(fingerprint,id(6)).run();
  await db.prepare("UPDATE wholesale_preview SET version=2,data=json_set(data,'$.note','Another private note') WHERE id=?").bind(id(6)).run();
  const all=await archive();
  assert.equal(all.total,6);assert.equal(all.outstandingCount,3);
  assert.deepEqual(all.labels.map(row=>row.id), [2,1,3,6,4,5].map(id));assert.equal(all.nextCursor,null);
  assert.doesNotMatch(JSON.stringify(all),/Private street|private@example|Private recipient|private-operation|private note|CURRENT-SERVICE|customerSnapshot|fingerprint|destination_address/i);
  assert.deepEqual(all.labels[1],{id:id(1),business:sample.business,reference:'Buyer-77%',trackingNumber:'AB987654321GB',
    weightGrams:1550,serviceCode:'NDA',createdAt:1000,dateSource:'booking',labelDownloadedAt:null,status:'ready',needsReview:false,canPreview:true});
  assert.deepEqual(all.labels.map(r=>[r.status,r.canPreview,r.dateSource,r.createdAt]),[
    ['downloaded',true,'booking',1000],['ready',true,'booking',1000],['dispatched',true,'booking',555],
    ['ready',true,'booking',333],['ready',false,'order',23],['ready',true,'unknown',null],
  ]);
  assert.equal(all.labels[4].serviceCode,null);
  await db.prepare("UPDATE wholesale_preview SET version=3,data=json_set(data,'$.customerSnapshot.address','Another private address') WHERE id=?").bind(id(6)).run();
  const changed=(await archive('?search=Amended')).labels[0];assert.ok(changed.needsReview);assert.equal(changed.canPreview,false);

  const first=await archive('?limit=1');assert.equal(first.total,6);
  const next=await archive('?limit=2&cursor='+encodeURIComponent(first.nextCursor));assert.deepEqual(next.labels.map(r=>r.id),[id(1),id(3)]);
  assert.equal(next.total,6);
  const last=await archive('?cursor='+encodeURIComponent(next.nextCursor));assert.equal(last.nextCursor,null);assert.deepEqual(last.labels.map(r=>r.id),[id(6),id(4),id(5)]);
  for(const [q,expected] of [['dispatch-10',[3]],['meadow',[3]],['ab987',[1]],['%',[1,4,5]],[id(2).toLowerCase(),[2]],["' OR 1=1 --",[]],['_',[]]]) {
    assert.deepEqual((await archive('?search='+encodeURIComponent(q))).labels.map(r=>r.id).sort(),expected.map(id).sort());
  }
  for(const [status,count] of [['ready',4],['downloaded',1],['dispatched',1]]) assert.equal((await archive('?status='+status)).total,count);
  for(const q of ['?status=paid','?cursor=1','?limit=0','?limit=101','?search='+'x'.repeat(121),'?search=%00','?cursor='+encodeURIComponent(first.nextCursor)+'&status=downloaded']) {
    assert.equal((await request(q)).status,400,q);
  }
  // The carrier ID identifies one PDF; the parent ID opens the underlying wholesale order.
  const parent = id(80);
  const boxContents = JSON.stringify({ basis: JSON.stringify([5004,0,null,[]]), quantities: [[],[],[]], goodsPence: [1668, 1668, 1668] });
  const piece = (suffix, state, provider) => db.prepare(`INSERT INTO wholesale_royal_mail_shipments
    (order_id,state,operation,order_version,provider_id,weight_grams,updated_at,requested_at,shipping_fingerprint)
    VALUES(?,?,'box',1,?,1400,2000,2000,?)`).bind(parent+suffix,state,provider,fingerprint);
  await db.batch([insert(80,{pence:5004}), db.prepare("INSERT INTO wholesale_royal_mail_box_plans(order_id,revision,weights,shipping_fingerprint,contents) VALUES(?,?,?,?,?)")
    .bind(parent,"plan","[1400,1400,1400]",fingerprint,boxContents),
    piece("-B1","labelled",801),piece("-B2","labelled",802),piece("-B3","review",null),
    piece("-B9","labelled",809),piece("-B01","labelled",810),piece("-X1","labelled",811)]);
  const boxes = await archive("?search="+parent+"&limit=1");
  assert.equal(boxes.total,2);
  assert.equal(boxes.outstandingCount,1);
  assert.equal(boxes.labels[0].canPreview,true);
  assert.deepEqual(boxes.labels.map(({id,parentId,boxNumber,boxCount})=>[id,parentId,boxNumber,boxCount]),
    [[parent+"-B2",parent,2,3]]);
  const nextBox = await archive("?search="+parent+"&cursor="+encodeURIComponent(boxes.nextCursor));
  assert.equal(nextBox.labels[0].id,parent+"-B1");
  assert.equal(nextBox.nextCursor,null);
  const waiting = await archive("?search="+parent+"&view=requests");
  assert.equal(waiting.total,1);
  assert.equal(waiting.requests[0].id,parent+"-B3");
  assert.equal(waiting.requests[0].parentId,parent);
  assert.equal(waiting.requests[0].boxNumber,3);
  await db.prepare("UPDATE wholesale_royal_mail_shipments SET weight_grams=2800 WHERE order_id=?").bind(parent+"-B2").run();
  assert.equal((await archive("?search="+parent+"-B2")).labels[0].canPreview,false);
  await db.prepare("UPDATE wholesale_preview SET data=json_set(data,'$.pence',5400),version=2 WHERE id=?").bind(parent).run();
  assert.equal((await archive("?search="+parent+"-B1")).labels[0].canPreview,false,"changed goods values require review even when destination and weight agree");
  await db.prepare("UPDATE wholesale_royal_mail_settings SET booking_config='unreadable-override' WHERE id=1").run();
  const disconnected=await archive('?search=ab987');assert.equal(disconnected.total,1);assert.equal(disconnected.labels[0].canPreview,false);
  await db.prepare('UPDATE wholesale_royal_mail_shipments SET candidate_provider_id=230 WHERE order_id=?').bind(id(23)).run();
  const resurfaced = await archive('?view=requests&search='+id(23));
  assert.deepEqual(resurfaced.requests.map(row=>row.id),[id(23)],'new carrier evidence restores an archived operation to the requests list');
});
