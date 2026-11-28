// Audit regressions for streaming limits and transactional backup invariants.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
const root=fileURLToPath(new URL('..',import.meta.url)),bundle=await mkdtemp(join(tmpdir(),'audit-regressions-'));
for(const file of ['assets','backup','http'])await build({entryPoints:[join(root,'src',file+'.ts')],bundle:true,platform:'node',format:'esm',outfile:join(bundle,file+'.mjs'),logLevel:'silent'});
const {uploadAsset}=await import(join(bundle,'assets.mjs')),{makeBackup,handleBackups}=await import(join(bundle,'backup.mjs')),{readBytes}=await import(join(bundle,'http.mjs'));
after(()=>rm(bundle,{recursive:true,force:true}));

for(const [name,limit,upload] of [['PDF',20,(req,env)=>uploadAsset(req,env,'Synthetic Audit')],['photo',5,(req)=>readBytes(req,5*1024*1024,'Photos can be up to 5 MB.')]]){
 test(`${name}: unknown-length oversized stream is cancelled at the limit without storing it`,async()=>{
  let consumed=0,cancelled=false,writes=0;
  const stream=new ReadableStream({pull(controller){if(consumed===limit+10){controller.close();return;}const bytes=new Uint8Array(1024*1024);if(!consumed)bytes.set(new TextEncoder().encode('%PDF-1.7\n'));consumed++;controller.enqueue(bytes);},cancel(){cancelled=true;}});
  const request=new Request('http://synthetic.invalid/upload',{method:'POST',headers:{'content-type':'application/pdf'},body:stream,duplex:'half'});
  assert.equal(request.headers.get('content-length'),null);
  await assert.rejects(upload(request,{FILES:{put:async()=>writes++}}),e=>e.status===413);
  assert.ok(consumed<=limit+2,`consumed ${consumed} MiB`);assert.equal(cancelled,true);assert.equal(writes,0);
 });
}
test('binary size guard accepts an exact-limit stream and rejects an oversized declared length before reading',async()=>{
 assert.deepEqual(await readBytes(new Request('http://synthetic.invalid',{method:'POST',body:new Uint8Array([1,2,3])}),3,'limit'),new Uint8Array([1,2,3]));
 let consumed=false;const body=new ReadableStream({pull(c){consumed=true;c.close();}},{highWaterMark:0});
 await assert.rejects(readBytes(new Request('http://synthetic.invalid',{method:'POST',headers:{'content-length':'4'},body,duplex:'half'}),3,'limit'),e=>e.status===413);assert.equal(consumed,false);
});

test('backup reads one transaction: concurrent leave and invoice commits cannot split related records',async()=>{
 const shipments=[
  {order_id:'synthetic-booked-order',state:'labelled',operation:'booked-operation',provider_id:351,tracking_number:'AB123456789GB'},
  {order_id:'synthetic-pending-order',state:'booking',operation:'pending-operation',provider_id:null,tracking_number:null},
  {order_id:'synthetic-retired-order',state:'review',operation:'historical-operation',retired_operation:'historical-operation',provider_id:null,tracking_number:null},
 ];
 const shippingSettings={enabled:0,version:3,updated_at:1};
 const boxPlans=[{order_id:'WS-TEST',revision:'sealed',weights:'[18000,18000]',contents:'{"quantities":[[18],[18]],"goodsPence":[32400,32400]}',shipping_fingerprint:'recorded'}];
 const before={sequence:7,timeOff:[],days:[],invoices:[]},committed={sequence:8,timeOff:[{id:'synthetic-leave',user_id:'synthetic-person',status:'approved',kind:'annual'}],days:[{time_off_id:'synthetic-leave',day:'2026-11-16',units:100,unit:'days'}],invoices:[{seq:8,order_id:'synthetic-order',data:'{}'}]};
 let state=structuredClone(before),gz,batches=0;
 const rows=(sql,snapshot)=>{
  if(/FROM rota_time_off\b/.test(sql))return snapshot.timeOff;
  if(/FROM rota_leave_days\b/.test(sql))return snapshot.days;
  if(/FROM sqlite_sequence\b/.test(sql))return[{seq:snapshot.sequence}];
  if(/FROM wholesale_invoices\b/.test(sql))return snapshot.invoices;
  if(/FROM wholesale_royal_mail_shipments\b/.test(sql)){assert.match(sql,/\bretired_operation\b/);return shipments;}
  if(/FROM wholesale_royal_mail_box_plans\b/.test(sql))return boxPlans;
  if(/FROM wholesale_royal_mail_settings\b/.test(sql))return [shippingSettings];
  if(/FROM meta\b/.test(sql))return[{v:10}];
  if(/FROM docs\b/.test(sql))return[{path:'sites/cafe/staff/owned',data:'{"ownerUserId":"stable-owner"}',seq:10,employee_privacy_version:1,updated_at:1,updated_by:'Synthetic'}];
  return[];
 };
 const DB={prepare(sql){return{sql,bind(){return this;},async all(){if(/FROM rota_leave_days\b|FROM wholesale_invoices\b/.test(sql))state=structuredClone(committed);return{results:structuredClone(rows(sql,state))};},async first(){return(await this.all()).results[0]||null;}};},async batch(statements){batches++;const snapshot=structuredClone(state);return statements.map(statement=>{if(/FROM rota_leave_days\b|FROM wholesale_invoices\b/.test(statement.sql))state=structuredClone(committed);return{success:true,results:structuredClone(rows(statement.sql,snapshot))};});}};
 const FILES={async put(id,bytes){gz=bytes;},async list(){return{keys:[],list_complete:true};}};
 await makeBackup({DB,FILES},'Synthetic Audit');const saved=await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
 assert.equal(batches,1);assert.equal(saved.rota.rota_time_off.length,saved.rota.rota_leave_days.length);assert.ok(saved.wholesaleInvoices.sequence>=Math.max(0,...saved.wholesaleInvoices.invoices.map(i=>i.seq)));
 assert.deepEqual(saved.royalMailShipments,shipments);
 assert.deepEqual(saved.royalMailBoxPlans,boxPlans);
 assert.deepEqual(saved.royalMailSettings,shippingSettings);
 assert.equal(state.invoices.length,1,'concurrent commit happened');assert.equal(saved.docs[0].employee_privacy_version,1);assert.equal(saved.docs[0].data.ownerUserId,'stable-owner');assert.ok(saved.documentSequence>=saved.docs[0].seq);
});

test('simultaneous backups retain separate content and older backup URLs still download', async t => {
 t.mock.method(Date,'now',()=>Date.parse('2026-10-27T03:17:00.123Z'));
 const files=new Map(),env={
  DB:{prepare:sql=>sql,batch:async reads=>reads.map(()=>({success:true,results:[]}))},
  FILES:{put:async(key,bytes)=>files.set(key,bytes),list:async()=>({keys:[],list_complete:true}),get:async key=>files.has(key)?new Blob([files.get(key)]).stream():null},
 };
 const [nightly,manual]=await Promise.all([makeBackup(env,'daily'),makeBackup(env,'Test administrator')]);
 assert.notEqual(nightly.id,manual.id);
 const read=async id=>(await handleBackups(new Request('https://synthetic.invalid/backup'),env,id,'Test administrator')).json();
 assert.equal((await read(nightly.id)).by,'daily');
 assert.equal((await read(manual.id)).by,'Test administrator');
 const legacy='2026-10-27T03-17-00Z';
 files.set('backup:'+legacy,files.get('backup:'+nightly.id));
 assert.equal((await read(legacy)).by,'daily');
});
