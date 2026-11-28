import assert from 'node:assert/strict';
import {test} from 'node:test';
import {royalMailScanState} from '../src/royalMailScanState.ts';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,Response as CarrierResponse} from 'miniflare';
const root=fileURLToPath(new URL('../',import.meta.url));
const id=n=>'WS-'+String(n).padStart(32,'0');
const num=n=>'AB'+String(n).padStart(9,'0')+'GB';

test('delivery issues follow verified booking, cutoff and tracking evidence per parcel',async t=>{
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {applySchema} from './src/schema';
    import {handleWholesaleAdmin} from './src/wholesale';
    import {refreshDeliveryScans} from './src/wholesale/deliveryAttention';
    import {errorResponse} from './src/http';
    export default {async fetch(req,env){try{
      const u=new URL(req.url);
      if (u.pathname==='/schema') await applySchema(env);
      else if(u.pathname==='/tick') await refreshDeliveryScans(env,Number(u.searchParams.get('time')));
      else return await handleWholesaleAdmin(req,env,'royal-mail/'+u.pathname.slice(1),{id:'local',name:'Fixture',role:req.headers.get('role')},{});
      return new Response('ok');
    }catch(e){if(e.status)return errorResponse(e);throw e;}}};
  `},format:'esm',platform:'browser',target:'es2022',bundle:true,write:false,external:['cloudflare:*']});
  const calls=[];
  const responses=new Map();
  let outage=false;
  const text=value=>({type:'text',value});
  const runtime=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},workers:[{config:{
    name:'attention',compatibilityDate:'2026-10-01',manifest:{modulesRoot:root,mainModule:'index.js',modules:{'index.js':{type:'esm',contents:bundle.outputFiles[0].text}}},
    env:{DB:{type:'d1',name:'delivery-issues'},WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY:text('fixture-key'),WHOLESALE_ROYAL_MAIL_SERVICE_CODE:text('NDA'),
      WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_ID:text('fixture-id'),WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_SECRET:text('fixture-secret'),WHOLESALE_ROYAL_MAIL_TRACKING_TERMS_ACCEPTED:text('yes')}
  },dev:{outboundService:{type:'fetcher',handler:req=>{
    const url=new URL(req.url);
    assert.equal(url.host,'api.royalmail.net');assert.equal(req.method,'GET');
    const refs=url.searchParams.get('mailPieceId').split(',');
    calls.push(refs);
    if (outage) return new CarrierResponse('Unavailable',{status:503});
    return CarrierResponse.json({mailPieces:refs.map(n=>({mailPieceId:n,...(responses.get(n)||{status:'404'})}))});
  }}}}]});
  t.after(()=>runtime.dispose());
  const call=(path,method='GET',body,role='admin')=>runtime.dispatchFetch('https://fixture.test'+path,{method,
    headers:{role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  async function data(path) {
    const res=await call(path);assert.equal(res.status,200,await res.clone().text());return res.json();
  }
  assert.equal((await call('/schema')).status,200);
  assert.equal((await call('/attention','GET',null,'staff')).status,403);
  assert.equal((await call('/attention','POST')).status,405);
  assert.equal((await call('/attention?cursor=invalid')).status,400);
  const {version,scope}=await data('/checks');
  const cutoff=await call('/checks','PUT',{ifVersion:version,scope,id:'collection',confirmed:true,
    evidence:{carrier:'royalMail',site:'roastery',cutoff:'13:30',owner:'dispatchLead'}});
  assert.equal(cutoff.status,200,await cutoff.clone().text());
  const db=await runtime.getD1Database('DB');
  const now=Date.now(), ago=now-2*864e5;
  const connection=createHash('sha256').update('fixture-key').digest('base64');
  for(const [n,state,status,extra={},box=''] of [
    [1,'review','Ready'],[2,'labelled','Ready'],[3,'labelled','Dispatched'],[4,'dispatched','Dispatched',{},'-B2'],
    [5,'labelled','Dispatched',{dispatchedAt:now-60_000}],[6,'review','Ready',{preview:true}],
    [7,'labelled','Ready',{dispatchDate:'2099-01-01'}],[8,'labelled','Dispatched'],[9,'labelled','Dispatched'],[10,'labelled','Dispatched',{trackingUrl:'https://other-courier.example/parcel'}],[11,'failed','Ready'],
  ]){
    const order={business:'Café '+n,customerId:'customer',status,dispatchedAt:status==='Dispatched'?ago:null,delivery:'Delivery',
      trackingUrl:box ? '' : 'https://www.royalmail.com/track-your-item#/tracking-results/'+num(n),preview:false,customerNote:'Private recipient',...extra};
    await db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',?,?,1,?)").bind(id(n),JSON.stringify(order),now).run();
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments(order_id,state,operation,order_version,provider_id,weight_grams,
      updated_at,requested_at,booking_connection,tracking_number,label_downloaded_at) VALUES(?,?,?,1,?,1400,?,?,?,?,?)`)
      .bind(id(n)+box,state,'claimed'+n,state==='review'?null:n,ago,ago,connection,n===9?'123456789':num(n),state==='review'?null:ago).run();
  }
  await db.prepare('INSERT INTO wholesale_royal_mail_box_plans(order_id,revision,weights,shipping_fingerprint) VALUES(?,?,?,?)').bind(id(4),'plan','[1400,1400]','parcel-fingerprint').run();
  await db.prepare('UPDATE wholesale_royal_mail_shipments SET shipping_fingerprint=? WHERE order_id=?').bind('parcel-fingerprint',id(4)+'-B2').run();
  await db.prepare("UPDATE wholesale_royal_mail_shipments SET provider_id=NULL,tracking_number=NULL,label_downloaded_at=NULL,problem=? WHERE order_id=?")
    .bind('Postage request declined. Royal Mail rejected the label request. Check the delivery postcode.',id(11)).run();
  const read=()=>data('/attention');
  assert.deepEqual((await read()).orders.map(r=>r.kind),['booking','collection','booking']);
  assert.equal(calls.length,0);
  const eventTime=new Date(now-1800_000).toISOString();
  responses.set(num(4),{status:'200',summary:{statusCategory:'EXCEPTION',lastEventName:'Delivery attempted',lastEventDateTime:eventTime}});
  responses.set(num(8),{status:'200',summary:{statusCategory:'DELIVERED',lastEventName:'Delivered',lastEventDateTime:eventTime}});
  outage=true;
  assert.ok((await call('/tick?time='+now)).status>=500);
  assert.deepEqual((await read()).orders.map(r=>r.kind),['booking','collection','booking'],'a carrier outage cannot create a missing-scan alert');
  outage=false;calls.length=0;
  const firstPoll=now+31*60_000;
  for (const res of await Promise.all([call('/tick?time='+firstPoll),call('/tick?time='+firstPoll)])) assert.equal(res.status,200,await res.text());
  assert.equal(calls.length,1,'concurrent ticks share one carrier read');assert.deepEqual(calls[0].sort(),[3,4,5,8].map(num));
  const page=await read();
  assert.equal(page.cutoff,'13:30');assert.equal(page.trackingEnabled,true);
  assert.deepEqual(page.orders.map(r=>[r.id,r.kind,r.box]),[[id(1),'booking',null],[id(2),'collection',null],[id(3),'no_scan',null],[id(4),'exception',2],[id(11),'booking',null]]);
  assert.match(page.orders[4].evidence,/rejected.*postcode/);
  assert.equal(page.orders[3].trackingUrl,'https://www.royalmail.com/track-your-item#/tracking-results/'+num(4));
  assert.equal((await data('/attention?kind=no_scan')).orders.length,1);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE|Private recipient|claimed|fixture-secret|fixture-key/);
  const first=await data('/attention?limit=2');
  assert.deepEqual((await data('/attention?limit=2&cursor='+encodeURIComponent(first.nextCursor))).orders.map(r=>r.kind),['no_scan','exception']);
  assert.equal((await call('/attention?kind=no_scan&cursor='+encodeURIComponent(first.nextCursor))).status,400);
  responses.set(num(3),{status:'200',summary:{statusCategory:'IN_TRANSIT',lastEventName:'Received at depot',lastEventDateTime:new Date(now+3000).toISOString()}});
  responses.set(num(4),{status:'200',summary:{statusCategory:'DELIVERED',lastEventName:'Delivered',lastEventDateTime:new Date(now+4000).toISOString()}});
  assert.equal((await call('/tick?time='+(now+3*3600_000))).status,200);
  assert.deepEqual((await read()).orders.map(r=>r.kind),['booking','collection','booking']);
  assert.ok(!calls[1].includes(num(8)),'terminal parcels stop polling');
  await db.prepare("UPDATE wholesale_royal_mail_setup_checks SET scope='retired'").run();
  assert.equal((await read()).cutoff,null);
  assert.deepEqual((await read()).orders.map(r=>r.kind),['booking','booking']);
});

test('physical delivery, sender advice and delivery attempts have independent meanings',()=>{
  assert.equal(royalMailScanState('Delivered to sender','DELIVERED'),'exception');
  assert.equal(royalMailScanState('Delivered back to sender','DELIVERED'),'exception');
  assert.equal(royalMailScanState('We tried to deliver','IN_TRANSIT'),'exception');
  assert.equal(royalMailScanState('Not yet delivered','DELIVERED'),'exception');
  assert.equal(royalMailScanState('Sender has despatched item','IN_TRANSIT'),'awaiting');
  assert.equal(royalMailScanState('Delivered to neighbour','DELIVERED'),'delivered');
  assert.equal(royalMailScanState('Delivered to local office',null),'unknown');
  assert.equal(royalMailScanState(null,null),'unknown');
});
