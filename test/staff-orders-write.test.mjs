import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
let srv,ADMIN,STAFF,MANAGER,staffId,managerId,A,B,grantVersion=0;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN,headers={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{}return{status:r.status,body:data,text,cookie:cookieOf(r),headers:r.headers}}
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

// Staff with wholesale orders access change status, internal note and tracking (version-checked, like Admin), print
// orders and bag totals, and read customers' contact and delivery details. Never prices, payment terms, internal
// customer notes, the minimum-order exemption, logins, previews, or anything without the grant.
test('granted staff change an order\'s status and internal note, version-checked; others cannot',async()=>{
 await grant(true);
 let row=(await ok('GET','/api/staff-orders/orders',undefined,STAFF)).body.orders.find(o=>o.id===A.order.id);
 assert.equal(row.status,'New');assert.ok(Number.isInteger(row.version));
 const path='/api/staff-orders/orders/'+A.order.id;
 const changed=await ok('PATCH',path,{ifVersion:row.version,status:'Preparing',note:'Packed shelf 3'},STAFF);
 assert.equal(changed.body.order.status,'Preparing');assert.equal(changed.body.order.note,'Packed shelf 3');assert.equal(changed.body.order.version,row.version+1);
 for(const hidden of ['"pence"','"price"','customerSnapshot','createdBy','PRIVATE_ACCOUNT_NOTE'])assert.ok(!changed.text.includes(hidden),hidden);
 assert.equal((await call('PATCH',path,{ifVersion:row.version,status:'Ready'},STAFF)).status,409,'a stale version is refused');
 assert.equal((await call('PATCH',path,{ifVersion:changed.body.order.version,status:'Lost'},STAFF)).status,400);
 assert.equal((await call('PATCH',path,{ifVersion:changed.body.order.version,status:'Dispatched',trackingUrl:'javascript:alert(1)'},STAFF)).status,400);
 const shipped=await ok('PATCH',path,{ifVersion:changed.body.order.version,status:'Dispatched',trackingUrl:'https://track.example/123',customerId:B.customer.id},STAFF);
 assert.equal(shipped.body.order.trackingUrl,'https://track.example/123');
 const adminView=(await ok('GET','/api/admin/wholesale')).body.orders.find(o=>o.id===A.order.id);
 assert.deepEqual([adminView.status,adminView.note,adminView.customerId],['Dispatched','Packed shelf 3',A.customer.id],'staff can\'t relink an order to another business');
 assert.equal((await call('PATCH',path,{ifVersion:shipped.body.order.version,status:'Ready'},MANAGER)).status,403,'no grant, no changes');
 assert.equal((await call('DELETE',path,{ifVersion:shipped.body.order.version},STAFF)).status,405,'deleting stays admin-only');
 const preview=(await ok('GET','/api/admin/wholesale')).body.orders.find(o=>o.preview!==false);
 assert.equal((await call('PATCH','/api/staff-orders/orders/'+preview.id,{ifVersion:preview.version,status:'Ready'},STAFF)).status,404,'staff previews aren\'t on this page');
 assert.equal((await call('PATCH',path,{ifVersion:shipped.body.order.version,status:'Ready'},STAFF,{origin:'https://evil.example'})).status,403,'writes from another site are refused');
 await grant(false);
 assert.equal((await call('PATCH',path,{ifVersion:shipped.body.order.version,status:'Ready'},STAFF)).status,403,'revoked access stops changes');
 await grant(true);
});

test('granted staff print orders and bag totals without prices; previews and other people never',async()=>{
 const fresh=await ok('GET','/api/staff-orders/print?status=New,Preparing,Ready,Dispatched',undefined,STAFF);
 assert.ok(fresh.body.orders.length>=1&&fresh.body.orders.every(o=>Array.isArray(o.lines)&&o.lines.every(l=>l.pack&&l.quantity)));
 for(const hidden of ['"pence"','"price"','STAFF_PREVIEW_MUST_NOT_LEAK','customerSnapshot','createdBy','@example.test'])assert.ok(!fresh.text.includes(hidden),hidden);
 const preview=(await ok('GET','/api/admin/wholesale')).body.orders.find(o=>o.preview!==false);
 const picked=await ok('GET',`/api/staff-orders/print?ids=${preview.id},${A.order.id}`,undefined,STAFF);
 assert.deepEqual(picked.body.orders.map(o=>o.id),[A.order.id],'picked previews are left out');
 for(const bad of ['','?status=Lost','?ids=nope'])assert.equal((await call('GET','/api/staff-orders/print'+bad,undefined,STAFF)).status,400,bad);
 assert.equal((await call('GET','/api/staff-orders/print?status=New',undefined,MANAGER)).status,403);
});

test('granted staff read customers\' contact and delivery details only',async()=>{
 const r=await ok('GET','/api/staff-orders/customers',undefined,STAFF);
 const a=r.body.customers.find(c=>c.id===A.customer.id);
 assert.deepEqual([a.business,a.contact,a.email,a.status,a.locations[0].address,a.locations[0].postcode],['orders.a','Private customer contact','orders.a@example.test','Active','10 Example Street','NR1 1AA']);
 for(const hidden of ['PRIVATE_ACCOUNT_NOTE','paymentTerms','paymentNote','noMinimumOrder','username','approvalStatus','"note"'])assert.ok(!r.text.includes(hidden),hidden);
 assert.deepEqual((await ok('GET','/api/staff-orders/customers?q=orders.b',undefined,STAFF)).body.customers.map(c=>c.id),[B.customer.id]);
 assert.equal((await call('GET','/api/staff-orders/customers?q='+'x'.repeat(121),undefined,STAFF)).status,400);
 for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal((await call(method,'/api/staff-orders/customers',{},STAFF)).status,405);
 assert.equal((await call('GET','/api/staff-orders/customers',undefined,MANAGER)).status,403);
 await grant(false);assert.equal((await call('GET','/api/staff-orders/customers',undefined,STAFF)).status,403);await grant(true);
});
