import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
let srv,ADMIN,STAFF,MANAGER,staffId,managerId,A,B,grantVersion=0;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
// SQL fixture setup blocks the event loop long enough to expire Wrangler keep-alive sockets.
async function call(method,path,body,cookie=ADMIN,headers={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{connection:'close','content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{}return{status:r.status,body:data,text,cookie:cookieOf(r),headers:r.headers}}
async function ok(method,path,body,cookie=ADMIN){const r=await call(method,path,body,cookie);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status} ${r.text}`);return r}
async function customer(username){const c=(await ok('POST','/api/admin/wholesale/customers',{business:username,contact:'Private customer contact',email:username+'@example.test',address:'10 Example Street',postcode:'NR1 1AA',note:'PRIVATE_ACCOUNT_NOTE',status:'Active'})).body.customer;const account=(await ok('POST',`/api/admin/wholesale/customers/${c.id}/account`,{username})).body;const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username,password:account.temporaryPassword,newPassword:username+'-own-password'},null)).cookie;const order=(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),delivery:'Delivery',reference:'STAFF-'+username,customerVersion:c.version,lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:2,price:1800}],customerNote:'Keep these bags together.'},cookie)).body.order;return{customer:c,cookie,order}}
const access=(id=staffId)=>'/api/admin/users/'+id+'/orders-access';
async function grant(enabled,id=staffId,expected=grantVersion){const r=await ok('PUT',access(id),{ifVersion:expected,enabled});if(id===staffId)grantVersion=r.body.version;return r}
before(async()=>{
 srv=await startServer({writeLimit:4000});ADMIN=(await ok('POST','/api/auth/setup',{name:'Orders Owner',username:'owner',password:'orders-owner-password',code:SETUP_CODE},null)).cookie;
 for(const role of ['staff','manager']){const u=(await ok('POST','/api/admin/users',{name:role,username:role,role,password:'temporary-password'})).body.user;const auth=await ok('POST','/api/auth/change',{username:role,password:'temporary-password',newPassword:role+'-own-password'},null);if(role==='staff'){staffId=u.id;STAFF=auth.cookie}else{managerId=u.id;MANAGER=auth.cookie}}
 A=await customer('orders.a');B=await customer('orders.b');
 await ok('PATCH','/api/admin/wholesale/orders/'+A.order.id,{ifVersion:A.order.version,customerId:A.customer.id,status:'New',note:'PRIVATE_ORDER_NOTE'});
 await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),business:'STAFF_PREVIEW_MUST_NOT_LEAK',delivery:'Roastery collection',lines:[{productId:'brazil',pack:'kilo',grind:'beans',quantity:1,price:1800}]});
});
after(async()=>{await srv?.stop()});
test('staff order access is default-deny, admin-granted and versioned; it does not grant Admin',async()=>{
 for(const cookie of [null,STAFF,MANAGER,A.cookie]){const r=await call('GET','/api/staff-orders/orders',undefined,cookie);assert.equal(r.status,cookie===STAFF||cookie===MANAGER?403:401);}
 assert.equal((await ok('GET',access())).body.enabled,false);
 for(const cookie of [STAFF,MANAGER]){assert.equal((await call('PUT',access(),{enabled:true,ifVersion:0},cookie)).status,403);assert.equal((await call('GET',access(),undefined,cookie)).status,403)}
 assert.equal((await call('PUT',access(),{enabled:true,ifVersion:0},ADMIN,{Origin:'https://foreign.example'})).status,403);
 await grant(true);
 assert.equal((await call('PUT',access(),{enabled:false,ifVersion:0})).status,409);
 const me=(await ok('GET','/api/auth/me',undefined,STAFF)).body;assert.equal(me.capabilities.staffOrders,true);
 const proof=(await call('GET','/api/auth/me',undefined,STAFF,{'x-sc-session-check':'1'})).body;assert.deepEqual(Object.keys(proof).sort(),['cookieDomain','user']);
 for(const path of ['/api/admin/users','/api/admin/people','/api/admin/wholesale'])assert.equal((await call('GET',path,undefined,STAFF)).status,403);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await call(method,'/api/staff-orders/orders',{},STAFF)).status,405);
 assert.equal((await call('GET','/api/staff-orders/orders',undefined,STAFF,{'x-expected-user-id':managerId,'x-expected-user-role':'manager'})).status,409);
});
test('staff order projection excludes previews, personal/internal and financial fields, while retaining fulfilment details',async()=>{
 const r=await ok('GET','/api/staff-orders/orders',undefined,STAFF);assert.equal(r.body.count,2);assert.equal(r.body.orders.length,2);
 assert.match(r.headers.get('cache-control'),/no-store/);
 const a=r.body.orders.find(o=>o.id===A.order.id);assert.equal(a.address,'10 Example Street');assert.equal(a.customerNote,'Keep these bags together.');assert.equal(a.lines[0].grindLabel,'Beans');
 assert.equal(a.note,'PRIVATE_ORDER_NOTE','granted staff read and edit the internal order note');
 for(const forbidden of ['PRIVATE_ACCOUNT_NOTE','Private customer contact','STAFF_PREVIEW_MUST_NOT_LEAK','@example.test','issuedBy','customerSnapshot','paymentInstructions','createdBy','"price"','"pence"'])assert.ok(!r.text.includes(forbidden),forbidden);
 assert.equal((await call('GET','/orders',undefined,MANAGER)).status,403);assert.equal((await call('GET','/orders',undefined,STAFF)).status,200);
 await grant(false);assert.equal((await call('GET','/api/staff-orders/orders',undefined,STAFF)).status,403);assert.equal((await ok('GET','/api/auth/me',undefined,STAFF)).body.capabilities.staffOrders,false);await grant(true);
});
test('overdue warnings distinguish manual payments, live partial balances and uncertain accounting without exposing invoice details',async()=>{
 const seed=(id,customer,order,paid,due,gross)=>srv.sql(`INSERT INTO wholesale_invoices(seq,invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by,paid) VALUES(${id},'STAFF-${id}','${order}','${customer}','request-${id}','${JSON.stringify({dueDate:due,totals:{grossPence:gross}})}',1,'PRIVATE_INVOICE_ACTOR',${paid})`);
 seed(5001,A.customer.id,A.order.id,0,'2020-01-01',10000);seed(5002,B.customer.id,B.order.id,1,'2020-01-01',12000);
 let rows=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders;assert.deepEqual(rows.find(o=>o.id===A.order.id).account,{overdue:true,review:false});assert.deepEqual(rows.find(o=>o.id===B.order.id).account,{overdue:false,review:false});
 srv.sql('UPDATE wholesale_invoices SET paid=1 WHERE seq=5001');rows=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders;assert.equal(rows.find(o=>o.id===A.order.id).account.overdue,false);
 // A real Live link with a partial observation is due; a missing/review observation is explicitly uncertain.
 srv.sql(`INSERT INTO quickbooks_exports(id,environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,state,created_at,updated_at) VALUES(7001,'production','test-realm','Test','','5002','staff-request','hash','{}','hash','hash','owner','{}','{}',0,0,'linked',1,1)`);
 rows=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders;assert.deepEqual(rows.find(o=>o.id===B.order.id).account,{overdue:false,review:true});
 srv.sql("INSERT INTO quickbooks_observations(export_id,status,outstanding_pence,paid_pence,read_started_at,observed_at) VALUES(7001,'part-paid',2000,10000,1,1)");
 rows=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders;assert.deepEqual(rows.find(o=>o.id===B.order.id).account,{overdue:true,review:false});
 srv.sql("UPDATE quickbooks_observations SET status='review',outstanding_pence=NULL,paid_pence=NULL WHERE export_id=7001");
 rows=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders;assert.deepEqual(rows.find(o=>o.id===B.order.id).account,{overdue:false,review:true});
 srv.sql("UPDATE quickbooks_observations SET status='paid',outstanding_pence=0,paid_pence=12000 WHERE export_id=7001");
 const paid=await ok('GET','/api/staff-orders/orders',undefined,STAFF);assert.deepEqual(paid.body.orders.find(o=>o.id===B.order.id).account,{overdue:false,review:false});assert.ok(!paid.text.includes('PRIVATE_INVOICE_ACTOR'));
});
test('read filters and cursor validation cannot reveal staff previews or modify orders',async()=>{
 const found=await ok('GET','/api/staff-orders/orders?q=orders.a',undefined,STAFF);assert.equal(found.body.count,1);assert.equal(found.body.orders[0].id,A.order.id);
 assert.equal((await ok('GET','/api/staff-orders/orders?q=STAFF_PREVIEW_MUST_NOT_LEAK',undefined,STAFF)).body.count,0);
 for(const query of ['cursor=bad','status=not-a-status'])assert.equal((await call('GET','/api/staff-orders/orders?'+query,undefined,STAFF)).status,400);
 assert.equal((await ok('GET','/api/admin/wholesale')).body.orders.find(o=>o.id===A.order.id).note,'PRIVATE_ORDER_NOTE');
});
test('HTML conditional requests cannot keep old sign-in or Admin script fingerprints after deploy',async()=>{
 for(const path of ['/signin','/admin','/'])for(const headers of [{'If-None-Match':'*'},{'If-Modified-Since':'Wed, 01 Jan 2099 00:00:00 GMT'}]){
  const r=await call('GET',path,undefined,path==='/signin'?null:ADMIN,headers);assert.equal(r.status,200,path);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('etag'),null);assert.match(r.text,/\/errors.js\?v=/);
 }
});

test('staff paging applies exclusions and literal search before limits, with stable tie-breaks and full counts',async()=>{
 const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
 const statements=[];
 for(let n=0;n<207;n++){
  const id='WS-PAGING-'+String(n).padStart(4,'0'),preview=n>=205,deletedAt=n===204?1:undefined;
  const order={...A.order,id,business:n===0?'Literal 50%_ café':'Paged café',reference:'PAGING-TEST',status:'New',preview,deletedAt};
  statements.push(`INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',${quote(id)},${quote(JSON.stringify(order))},1,12345)`);
 }
 for(let n=0;n<statements.length;n+=40)srv.sql(statements.slice(n,n+40).join(';'));
 const first=(await ok('GET','/api/staff-orders/orders?q=PAGING-TEST',undefined,STAFF)).body;
 assert.equal(first.count,204);assert.equal(first.orders.length,100);assert.ok(first.nextCursor);
 const second=(await ok('GET','/api/staff-orders/orders?q=PAGING-TEST&cursor='+encodeURIComponent(first.nextCursor),undefined,STAFF)).body;
 const third=(await ok('GET','/api/staff-orders/orders?q=PAGING-TEST&cursor='+encodeURIComponent(second.nextCursor),undefined,STAFF)).body;
 assert.equal(second.count,204);assert.equal(third.count,204);assert.equal(third.orders.length,4);assert.equal(third.nextCursor,null);
 assert.equal(new Set([...first.orders,...second.orders,...third.orders].map(o=>o.id)).size,204);
 assert.equal((await ok('GET','/api/staff-orders/orders?q='+encodeURIComponent('50%_'),undefined,STAFF)).body.count,1);
 assert.equal((await ok('GET','/api/staff-orders/orders?q='+encodeURIComponent('50__'),undefined,STAFF)).body.count,0);
 srv.sql("DELETE FROM wholesale_preview WHERE id LIKE 'WS-PAGING-%'");
});

test('access metadata is included only in admin backups and inactive accounts lose all order-page aliases',async()=>{
 const made=(await ok('POST','/api/admin/backups',{})).body.backup;
 const backup=(await ok('GET','/api/admin/backups/'+made.id)).body;
 assert.equal(backup.staffOrderAccess.find(a=>a.user_id===staffId).enabled,1);
 for(const path of ['/orders','/orders/','/orders/index','/orders/index.html'])assert.equal((await call('GET',path,undefined,MANAGER)).status,403,path);
 await ok('PATCH','/api/admin/users/'+staffId,{active:false});
 assert.equal((await call('GET','/api/staff-orders/orders',undefined,STAFF)).status,401);
 assert.equal((await call('GET','/orders',undefined,STAFF)).status,302);
});
