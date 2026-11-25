import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {csvCell} from '../public/shared/csv.js';
test('shared CSV formatter prevents formulas after whitespace while preserving real numeric credits',()=>{
 for(const text of ['=1+1','+1','-2','@SUM(A1)','\t=1','\r=1',' \t+1','\ufeff=1'])assert.ok(csvCell(text).startsWith("'")||csvCell(text).startsWith('"\''),JSON.stringify(text));
 assert.equal(csvCell(-2),'-2');assert.equal(csvCell(0), '0');assert.equal(csvCell(null),'');assert.equal(csvCell('Cafe, Norwich'),'"Cafe, Norwich"');assert.equal(csvCell('a"b'),'"a""b"');assert.equal(csvCell('normal',true),'"normal"');
});
async function invoiceModule() {
 const {build}=createRequire(import.meta.url)('esbuild');
 const source=await build({entryPoints:[fileURLToPath(new URL('../src/wholesaleInvoices.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
 return import('data:text/javascript;base64,'+Buffer.from(source.outputFiles[0].text+'\n//# sourceURL=invoice-test-module.js').toString('base64'));
}
function invoiceFixture() {
 const db=new DatabaseSync(':memory:');
 db.exec(`
   CREATE TABLE wholesale_preview(kind TEXT,id TEXT,data TEXT,version INTEGER,updated_at INTEGER,PRIMARY KEY(kind,id));
   CREATE TABLE wholesale_invoice_settings(id INTEGER,data TEXT,version INTEGER,updated_at INTEGER);
   CREATE TABLE wholesale_invoices(seq INTEGER PRIMARY KEY AUTOINCREMENT,invoice_number TEXT UNIQUE,order_id TEXT UNIQUE,
     customer_id TEXT,request_key TEXT,data TEXT,issued_at INTEGER,issued_by TEXT,paid INTEGER DEFAULT 0,
     paid_date TEXT,paid_at INTEGER,payment_reference TEXT DEFAULT '',payment_version INTEGER DEFAULT 1);
   CREATE TABLE wholesale_tabs(id TEXT PRIMARY KEY,customer_id TEXT,cleared_at INTEGER,data TEXT);
   CREATE TABLE wholesale_auto_invoicing(id INTEGER PRIMARY KEY,data TEXT);
   CREATE TABLE wholesale_auto_invoices(source TEXT PRIMARY KEY,lease_owner TEXT,lease_until INTEGER);
   CREATE TABLE quickbooks_exports(id INTEGER PRIMARY KEY,invoice_id INTEGER,environment TEXT,state TEXT,write_started_at INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE quickbooks_observations(export_id INTEGER,status TEXT,outstanding_pence INTEGER,paid_pence INTEGER,reason TEXT,observed_at INTEGER,payment_voided INTEGER NOT NULL DEFAULT 0,due_date TEXT,invoice_issue TEXT NOT NULL DEFAULT '');
   CREATE TABLE audit_log(at INTEGER,kind TEXT,actor TEXT,text TEXT);
 `);
 const config={seller:{legalName:'Test Supplier',address:'Supplier Street',vatNumber:'123'},priceBasis:'inclusive',
   vatRates:[{id:'zero',label:'Zero',basisPoints:0}],defaultCoffeeRateId:'zero',invoicePrefix:'INV-',firstInvoiceNumber:1,confirmed:true};
 db.prepare('INSERT INTO wholesale_invoice_settings VALUES(1,?,1,1)').run(JSON.stringify(config));
 const order={preview:false,status:'New',customerId:'synthetic',business:'Synthetic buyer',createdAt:1,customerSnapshot:{address:'Test Street'},
   lines:[{title:'Coffee',packLabel:'1 kg',grindLabel:'Whole bean',quantity:6,price:2000}]};
 let beforeWrite;
 const env={DB:{prepare(sql){const bind=(...args)=>({
   async first(){if(beforeWrite && /^(INSERT INTO wholesale_invoices|UPDATE wholesale_invoices SET paid)/.test(sql)){
     const race=beforeWrite;beforeWrite=null;await race();
   }return db.prepare(sql).get(...args)??null;},
   async all(){return{results:db.prepare(sql).all(...args)};},
   async run(){return{meta:db.prepare(sql).run(...args)};},
 });return {...bind(),bind};}}};
 const request=body=>new Request('http://localhost/invoice',{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}});
 const review={orderVersion:1,settingsVersion:1,invoiceDate:'2026-11-23',supplyDate:'2026-11-23'};
 const addOrder=(id,value=order)=>db.prepare("INSERT INTO wholesale_preview VALUES('order',?,?,1,1)").run(id,JSON.stringify(value));
 return {db,env,order,addOrder,request,review,race(fn){beforeWrite=fn;}};
}
test('production issuance and amendment cannot both win either invoice/order race',async()=>{
 const {handleInvoiceAdmin}=await invoiceModule();
 const changeSource=await readFile(new URL('../src/wholesaleStanding.ts',import.meta.url),'utf8');
 const amend=changeSource.match(/prepare\("(UPDATE wholesale_preview SET data=\?,version=version\+1,updated_at=\? WHERE kind='order' AND id=\? AND version=\? AND json_extract[^"\n]+)"\)/)[1];
 const {db,env,order,addOrder,request,review}=invoiceFixture();
 try{
  const changed={...order,lines:[{...order.lines[0],quantity:8}]};
  for(const [index,invoiceFirst] of [true,false].entries()){
   const id='WS-'+String(index).repeat(32);addOrder(id);
   const insert=()=>handleInvoiceAdmin(request(review),env,'orders/'+id+'/invoice','Audit');
   const update=()=>db.prepare(amend).run(JSON.stringify(changed),3,id,1,null,null,id,'',id).changes;
   if(invoiceFirst){assert.equal((await insert()).status,201);assert.equal(update(),0);}
   else{assert.equal(update(),1);await assert.rejects(insert(),error=>error.status===409);}
  }
 }finally{db.close();}
});

test('Payment before dispatch has a fixed due date in the invoice preview',async()=>{
 const {handleInvoiceAdmin}=await invoiceModule();
 const {db,env,order,addOrder,request,review}=invoiceFixture();
 try{
  const id='WS-'+'E'.repeat(32);
  addOrder(id,{...order,customerSnapshot:{...order.customerSnapshot,paymentTerms:{id:'before-dispatch',label:'Payment before dispatch',note:''}}});
  const preview=body=>handleInvoiceAdmin(request(body),env,'orders/'+id+'/invoice/preview','Audit');
  const response=await preview(review);
  assert.equal(response.status,200);
  assert.equal((await response.json()).invoice.dueDate,review.invoiceDate);
  await assert.rejects(preview({...review,dueDate:'2026-11-30'}),error=>error.status===400&&/agreed invoice payment terms/.test(error.message));
 }finally{db.close();}
});

test('tab and individual invoices cannot both bill a member even if both reviews completed',async()=>{
 const {handleInvoiceAdmin,issueForTab}=await invoiceModule();
 for(const tabFirst of [true,false]){
  const {db,env,order,addOrder,request,review,race}=invoiceFixture();
  try{
   const id='WS-'+'A'.repeat(32),tabId='test-tab',owner='lease';
   addOrder(id,{...order,tabClearedId:tabId});
   db.prepare('INSERT INTO wholesale_tabs VALUES(?,?,?,?)').run(tabId,'synthetic',2,JSON.stringify({orderIds:[id]}));
   db.prepare('INSERT INTO wholesale_auto_invoicing VALUES(1,?)').run(JSON.stringify({issue:true,since:1}));
   db.prepare('INSERT INTO wholesale_auto_invoices VALUES(?,?,?)').run('tab:'+tabId,owner,Date.now()+60000);
   const single=()=>handleInvoiceAdmin(request(review),env,'orders/'+id+'/invoice','Audit');
   const tab=()=>issueForTab(new Request('https://admin.example.test/'),env,tabId,'Automation',{since:1,leaseOwner:owner});
   if(tabFirst){race(tab);await assert.rejects(single(),error=>error.status===409);}
   else{race(single);await assert.rejects(tab(),error=>error.status===409);}
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wholesale_invoices').get().n,1);
  }finally{db.close();}
 }
});

test('automatic issuance checks current order eligibility and reviewed tab versions at commit',async()=>{
 const {issueForOrder,issueForTab}=await invoiceModule();
 for(const tab of [true,false]){
  const {db,env,order,addOrder,race}=invoiceFixture();
  try{
   const id='WS-'+'B'.repeat(32),tabId='test-tab',owner='lease';
   addOrder(id,{...order,status:'Dispatched',dispatchedAt:2,...(tab?{tabClearedId:tabId}:{})});
   db.prepare('INSERT INTO wholesale_tabs VALUES(?,?,?,?)').run(tabId,'synthetic',2,JSON.stringify({orderIds:[id]}));
   db.prepare('INSERT INTO wholesale_auto_invoicing VALUES(1,?)').run(JSON.stringify({issue:true,since:1}));
   db.prepare('INSERT INTO wholesale_auto_invoices VALUES(?,?,?)').run(tab?'tab:'+tabId:'order:'+id,owner,Date.now()+60000);
   race(()=>tab?db.prepare("UPDATE wholesale_preview SET version=2 WHERE id=?").run(id)
     :db.prepare("UPDATE wholesale_auto_invoicing SET data=json_set(data,'$.issue',0)").run());
   await assert.rejects(tab?issueForTab(new Request('https://admin.example.test/'),env,tabId,'Automation',{since:1,leaseOwner:owner})
     :issueForOrder(new Request('https://admin.example.test/'),env,id,'Automation',{since:1,leaseOwner:owner}),error=>error.status===409);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wholesale_invoices').get().n,0);
  }finally{db.close();}
 }
});

test('a Live link created during manual payment review prevents the stale payment write',async()=>{
 const {handleInvoiceAdmin}=await invoiceModule();
 const {db,env,addOrder,request,review,race}=invoiceFixture();
 try{
  const id='WS-'+'C'.repeat(32);
  addOrder(id);
  const {invoice}=await (await handleInvoiceAdmin(request(review),env,'orders/'+id+'/invoice','Audit')).json();
  race(()=>db.prepare("INSERT INTO quickbooks_exports (id,invoice_id,environment,state) VALUES(1,?,'production','linked')").run(invoice.id));
  const payment=new Request('http://localhost/payment',{method:'PATCH',body:JSON.stringify({ifVersion:invoice.payment.version,paid:true})});
  await assert.rejects(handleInvoiceAdmin(payment,env,'invoices/'+invoice.id+'/payment','Audit'),error=>error.code==='quickbooks_managed_payment');
  assert.equal(db.prepare('SELECT paid FROM wholesale_invoices WHERE seq=?').get(invoice.id).paid,0);
 }finally{db.close();}
});

test('Payment totals exclude unconfirmed balances and keep confirmed balances with invoice differences',async()=>{
 const {handleInvoiceAdmin}=await invoiceModule();
 const {db,env,order,addOrder,request,review}=invoiceFixture();
 try{
  const id='WS-'+'D'.repeat(32);
  addOrder(id,{...order,paymentTerms:{id:'net-30',label:'30 days',note:''}});
  const {invoice}=await (await handleInvoiceAdmin(request({...review,invoiceDate:'2020-01-01',supplyDate:'2020-01-01'}),env,'orders/'+id+'/invoice','Audit')).json();
  db.prepare("INSERT INTO quickbooks_exports (id,invoice_id,environment,state) VALUES(1,?,'production','linked')").run(invoice.id);
  const list=async queue=>(await handleInvoiceAdmin(new Request('http://localhost/invoices?queue='+queue),env,'invoices','Audit')).json();
  const {summary,invoices}=await list('all');
  assert.equal(summary.outstandingPence,0);
  assert.equal(invoices[0].payment.outstandingPence,null);
  assert.equal(summary.reviewCount,1);assert.equal(summary.overdueCount,0);assert.equal(summary.overduePence,0);
  assert.equal((await list('overdue')).count,0);assert.equal((await list('review')).count,1);
  db.prepare("INSERT INTO quickbooks_observations(export_id,status,outstanding_pence,paid_pence,due_date,invoice_issue) VALUES(1,'part-paid',1700,10300,'2020-03-01','QuickBooks billing address differs.')").run();
  const confirmed=await list('overdue');
  assert.equal(confirmed.count,1);
  assert.equal(confirmed.invoices[0].payment.dueDate,'2020-03-01');
  assert.equal(confirmed.invoices[0].accounting.invoiceChanged,true);
  assert.equal(confirmed.summary.outstandingPence,1700);
  assert.equal(confirmed.summary.overduePence,1700);
  assert.equal((await list('review')).count,1);
 }finally{db.close();}
});

test('QuickBooks product numbers are allocated and read atomically without renumbering existing coffees', async () => {
 const {build}=createRequire(import.meta.url)('esbuild');
 const source=await build({entryPoints:[fileURLToPath(new URL('../src/quickbooks/autoLinks.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
 const {productNumber}=await import('data:text/javascript;base64,'+Buffer.from(source.outputFiles[0].text).toString('base64'));
 const db=new DatabaseSync(':memory:');
 try {
  db.exec("CREATE TABLE wholesale_product_numbers(product_id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,created_at INTEGER NOT NULL); INSERT INTO wholesale_product_numbers VALUES('existing',1032,7);");
  const DB={
   prepare(sql){return {bind(...args){return {sql,args};}};},
   async batch(statements){
    db.exec('BEGIN IMMEDIATE');
    try {
     const results=statements.map(({sql,args})=>({results:db.prepare(sql).all(...args)}));
     db.exec('COMMIT');return results;
    } catch(error){db.exec('ROLLBACK');throw error;}
   },
  };
  const coffees=['existing','fresh-a','fresh-b','fresh-a','existing'];
  assert.deepEqual(await Promise.all(coffees.map(coffee=>productNumber({DB},coffee))),[1032,1033,1034,1033,1032]);
  assert.equal(db.prepare("SELECT created_at FROM wholesale_product_numbers WHERE product_id='existing'").get().created_at,7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wholesale_product_numbers').get().n,3);
 } finally {db.close();}
});

test('an order arriving or changing after a tab review cannot commit a partial clear', async () => {
 const {build} = createRequire(import.meta.url)('esbuild');
 const source = await build({entryPoints:[fileURLToPath(new URL('../src/wholesaleTabs.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
 const {clearTab} = await import('data:text/javascript;base64,' + Buffer.from(source.outputFiles[0].text).toString('base64'));
 const db = new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE wholesale_preview(kind TEXT,id TEXT,data TEXT,version INTEGER,updated_at INTEGER,PRIMARY KEY(kind,id)); CREATE TABLE wholesale_tabs(id TEXT PRIMARY KEY,customer_id TEXT,cleared_at INTEGER,data TEXT);');
  const data = JSON.stringify({preview:false,status:'New',customerId:'buyer',tab:{at:1},grams:1000,packs:1,pence:1000});
  const order = id => db.prepare("INSERT INTO wholesale_preview VALUES('order',?,?,1,1)").run(id,data);
  const changes = [() => order('arrived'), () => db.exec("UPDATE wholesale_preview SET version=2,data=json_set(data,'$.note','Saved elsewhere') WHERE id='kept'")];
  for (const change of changes) {
   db.exec('DELETE FROM wholesale_preview');
   order('selected'); order('kept');
   const DB = {
    prepare(sql) {
     return {bind(...args) { const statement = db.prepare(sql); return {
      all:async () => ({results:statement.all(...args)}), first:async () => statement.get(...args),
      run:() => ({meta:{changes:statement.run(...args).changes}}),
     }; }};
    },
    async batch(statements) {
     change();
     db.exec('BEGIN');
     try { const results = statements.map(statement => statement.run()); db.exec('COMMIT'); return results; }
     catch (error) { db.exec('ROLLBACK'); throw error; }
    },
   };
   await assert.rejects(clearTab({DB},'buyer',{orderIds:['selected'],seen:['selected','kept']},'Test operator'),error => error.status === 409);
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wholesale_tabs').get().n,0);
   assert.equal(db.prepare("SELECT version FROM wholesale_preview WHERE id='selected'").get().version,1);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wholesale_preview WHERE json_extract(data,'$.tabClearedId') IS NOT NULL").get().n,0);
  }
 } finally { db.close(); }
});
