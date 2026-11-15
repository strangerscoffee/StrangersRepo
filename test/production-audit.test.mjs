// Real HTTP regressions for the production audit, on isolated synthetic D1/KV only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
import {addDays,ukDay} from '../src/insightsMath.ts';
let srv,ADMIN,A,B;
const cookieOf=r=>(r.headers.getSetCookie().find(c=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(c))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,cookie:cookieOf(r),headers:r.headers};}
async function ok(...args){const r=await call(...args);assert.ok(r.status>=200&&r.status<300,`${args[0]} ${args[1]}: ${r.status} ${r.text}`);return r;}
async function customer(username){const c=(await ok('POST','/api/admin/wholesale/customers',{business:'Audit '+username,contact:'Synthetic Buyer',email:username+'@example.invalid',status:'Active',paymentTerms:'net-30'})).data.customer;const a=(await ok('POST',`/api/admin/wholesale/customers/${c.id}/account`,{username})).data;const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username:a.account.username,password:a.temporaryPassword,newPassword:'audit-local-password-2468'},null)).cookie;return{id:c.id,cookie};}
async function product(id){return(await ok('GET','/api/admin/wholesale')).data.products.find(p=>p.id===id);}
async function edit(id,values){const p=await product(id);return(await ok('PUT','/api/admin/wholesale/catalogue/'+id,{ifVersion:p.version,prices:p.prices,active:p.active,inStock:p.inStock,...values})).data.product;}
async function standing(buyer=B){const s=(await ok('GET','/api/wholesale/session',undefined,buyer.cookie)).data,p=await product('campo');const placed=(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),delivery:'Roastery collection',customerVersion:s.customer.version,lines:[{productId:'campo',pack:'kilo',grind:'beans',quantity:6,price:p.prices.kilo}]},buyer.cookie)).data.order;return(await ok('PATCH','/api/admin/wholesale/orders/'+placed.id,{ifVersion:placed.version,status:'New',customerId:buyer.id,note:'',schedule:{dispatchDate:addDays(ukDay(Date.now()),28),every:1}})).data.order;}
async function order(id){return(await ok('GET','/api/admin/wholesale')).data.orders.find(o=>o.id===id);}
before(async()=>{srv=await startServer({writeLimit:6000,scheduled:true});ADMIN=(await ok('POST','/api/auth/setup',{name:'Audit Admin',username:'audit.owner',password:'audit-local-password-1234',code:SETUP_CODE},null)).cookie;A=await customer('audit.buyer.a');B=await customer('audit.buyer.b');});
after(async()=>{await srv?.stop();});

test('legacy catalogue modules and source photos honour current customer allowlists, on both aliases',async()=>{
 const p=await edit('campo',{active:true,inStock:true,customerOnly:true,whiteLabel:[B.id],recipe:[{name:'Private recipe',percent:100}]});
 for(const prefix of ['/wholesale/','/wholesale-preview/']){
  const a=await ok('GET',prefix+'catalogue.js',undefined,A.cookie);assert.ok(!a.text.includes('"id":"campo"'));assert.ok(!a.text.includes('Private recipe'));
  const b=await ok('GET',prefix+'catalogue.js',undefined,B.cookie);assert.ok(b.text.includes('"id":"campo"'));assert.ok(!b.text.includes('Private recipe'));assert.match(b.headers.get('cache-control'),/no-store/);
 }
 for(const image of p.imageUrls.filter(p=>p.startsWith('/wholesale/images/'))){assert.equal((await call('GET',image,undefined,A.cookie)).status,404);const own=await ok('GET',image,undefined,B.cookie);assert.match(own.headers.get('cache-control'),/no-store/);}
 assert.equal((await call('GET','/wholesale/catalogue.js',undefined,null)).status,302);
});

test('amendments reject unavailable additions and merged increases, while safe reductions retain old prices',async()=>{
 const run=await standing(),base={productId:'campo',pack:'kilo',grind:'beans',quantity:6};
 await edit('rosalina',{active:true,inStock:false});
 const add=await call('PUT',`/api/wholesale/orders/${run.id}/lines`,{ifVersion:run.version,scope:'once',lines:[base,{productId:'rosalina',pack:'kilo',grind:'beans',quantity:1}]},B.cookie);assert.equal(add.status,409);assert.equal(add.data.code,'out_of_stock');
 await edit('campo',{inStock:false});
 const split=await call('PUT',`/api/wholesale/orders/${run.id}/lines`,{ifVersion:run.version,lines:[{...base,quantity:4},{...base,quantity:3}]},B.cookie);assert.equal(split.status,409);
 const reduced=(await ok('PUT',`/api/wholesale/orders/${run.id}/lines`,{ifVersion:run.version,lines:[{...base,quantity:5}]},B.cookie)).data.order;assert.equal(reduced.lines[0].price,run.lines[0].price);
 await edit('campo',{inStock:true});const p=await product('rosalina');await edit('rosalina',{inStock:true,grindOptions:p.grindOptions.map(g=>({...g,enabled:g.id!=='beans'}))});
 const disabled=await call('PUT',`/api/wholesale/orders/${run.id}/lines`,{ifVersion:reduced.version,lines:[base,{productId:'rosalina',pack:'kilo',grind:'beans',quantity:1}]},B.cookie);assert.equal(disabled.status,400);
 await edit('rosalina',{grindOptions:p.grindOptions});
});

test('standing rollover insertion failures roll back the claim; retries and cron repair create one next delivery',async()=>{
 const run=await standing();
 srv.sql(`CREATE TRIGGER audit_fail_next BEFORE INSERT ON wholesale_preview WHEN NEW.kind='order' AND json_extract(NEW.data,'$.previousRunId')='${run.id}' BEGIN SELECT RAISE(ABORT,'audit insertion failure'); END`);
 const failed=await call('PATCH',`/api/admin/wholesale/orders/${run.id}`,{ifVersion:run.version,status:'Dispatched',customerId:B.id,note:''});assert.equal(failed.status,500);
 const closed=await order(run.id);assert.equal(closed.status,'Dispatched');assert.equal(closed.nextRunId,undefined,'claim rolls back with insertion');srv.sql('DROP TRIGGER audit_fail_next');
 const retry=(await ok('PATCH',`/api/admin/wholesale/orders/${run.id}`,{ifVersion:closed.version,status:'Dispatched',customerId:B.id,note:''})).data.order;assert.ok(await order(retry.nextRunId));
 const claimed='WS-'+crypto.randomUUID().replaceAll('-','').toUpperCase();
 srv.sql(`DELETE FROM wholesale_preview WHERE kind='order' AND id='${retry.nextRunId}';UPDATE wholesale_preview SET data=json_set(data,'$.nextRunId','${claimed}'),version=version+1 WHERE kind='order' AND id='${run.id}'`);
 await fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'));
 let recovered;for(let i=0;i<40;i++){recovered=await order(claimed);if(recovered)break;await new Promise(r=>setTimeout(r,100));}assert.ok(recovered,'older dangling claims are repaired');
 await fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'));
 assert.equal(srv.sql(`SELECT id FROM wholesale_preview WHERE kind='order' AND json_extract(data,'$.previousRunId')='${run.id}'`).length,1);
});

test('later dispatches stay out of next-week roasting and generated future runs do not become sales early',async()=>{
 const before=(await ok('GET','/api/admin/wholesale/insights')).data;
 const run=await standing();const added=(await ok('GET','/api/admin/wholesale/insights')).data;
 const open=data=>data.roast.rows.find(r=>r.key==='campo')?.openGrams||0;
 assert.equal(open(added),open(before));assert.ok(added.roast.laterGrams>=6000);
 const grams=data=>data.weekly.reduce((n,w)=>n+w.grams,0);
 await ok('PATCH',`/api/admin/wholesale/orders/${run.id}`,{ifVersion:run.version,status:'Dispatched',customerId:B.id,note:''});
 const rolled=(await ok('GET','/api/admin/wholesale/insights')).data;assert.equal(grams(rolled),grams(added));
});

test('payroll conserves basic plus overtime across a month boundary and actual-hour revisions reject stale edits',async()=>{
 const user=(await ok('POST','/api/admin/users',{name:'Payroll Audit',username:'audit.payroll',role:'staff',password:'audit-temp-password-1234'})).data.user;
 await ok('PUT','/api/rota/people/'+user.id,{contractMin:40,contractMax:40,sites:['office'],pattern:{}});
 for(const day of ['2026-10-26','2026-10-27','2026-10-28','2026-10-29'])await ok('POST','/api/rota/shifts',{site:'office',day,start:'06:00',end:'21:00',breakMins:0,job:'',userId:user.id});
 const shift=(await ok('POST','/api/rota/shifts',{site:'office',day:'2026-11-01',start:'08:00',end:'18:00',breakMins:0,job:'',userId:user.id})).data.shift;
 const oct=(await ok('GET','/api/rota/hours?month=2026-10')).data.people.find(p=>p.userId===user.id),nov=(await ok('GET','/api/rota/hours?month=2026-11')).data.people.find(p=>p.userId===user.id);
 assert.equal(oct.hours+nov.hours,70);assert.equal(oct.basicHours+oct.overtime+nov.basicHours+nov.overtime,70);for(const p of [oct,nov])assert.equal(p.basicHours+p.overtime,p.hours);
 const a=(await ok('PUT',`/api/rota/shifts/${shift.id}/actual`,{ifUpdatedAt:shift.updatedAt,start:'08:00',end:'17:00',breakMins:0,note:'First update'})).data.shift;assert.ok(a.updatedAt>shift.updatedAt);
 assert.equal((await call('PUT',`/api/rota/shifts/${shift.id}/actual`,{ifUpdatedAt:shift.updatedAt,start:'09:00',end:'17:00'})).status,409);
 assert.equal((await call('PUT',`/api/rota/shifts/${shift.id}/actual`,{clear:true})).status,409);
 const clear=(await ok('PUT',`/api/rota/shifts/${shift.id}/actual`,{ifUpdatedAt:a.updatedAt,clear:true})).data.shift;assert.ok(clear.updatedAt>a.updatedAt);
});

test('CSV exports neutralise formula-like text values',async()=>{
 const user=(await ok('POST','/api/admin/users',{name:'=1+1',username:'audit.csv',role:'staff',password:'audit-temp-password-2468'})).data.user;
 await ok('POST','/api/rota/shifts',{site:'office',day:'2026-11-04',start:'09:00',end:'10:00',breakMins:0,job:'',userId:user.id});
 const csv=(await ok('GET','/api/rota/hours?month=2026-11&format=csv')).text;assert.match(csv,/(?:\r\n)'=1\+1,/);assert.ok(!csv.includes('"=1+1",'));
});

test('staff recovery receipts are creator-scoped, unpriced and never recreate removed orders',async()=>{
 const requestId=crypto.randomUUID();const body={requestId,customerId:B.id,source:'Phone',emailCustomer:false,lines:[{productId:'campo',pack:'kilo',grind:'beans',quantity:1}],delivery:'Roastery collection'};
 const placed=(await ok('POST','/api/staff-orders/orders',body)).data.order;
 const receipt=await ok('GET',`/api/staff-orders/orders/${placed.id}/receipt`);assert.equal(receipt.data.order.id,placed.id);assert.ok(!/"price"|"pence"/.test(receipt.text));
 const other=(await ok('POST','/api/admin/users',{name:'Other Packer',username:'audit.packer',role:'staff',password:'audit-temp-password-5555'})).data.user;
 await ok('PUT',`/api/admin/users/${other.id}/orders-access`,{ifVersion:0,enabled:true});
 const cookie=(await ok('POST','/api/auth/change',{username:'audit.packer',password:'audit-temp-password-5555',newPassword:'audit-other-own-password'},null)).cookie;
 assert.equal((await call('GET',`/api/staff-orders/orders/${placed.id}/receipt`,undefined,cookie)).status,404);
 assert.equal((await call('GET',`/api/staff-orders/orders/${placed.id}/receipt`,undefined,B.cookie)).status,401);
 await ok('DELETE',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version});
 assert.equal((await call('GET',`/api/staff-orders/orders/${placed.id}/receipt`)).status,410);
 assert.equal((await call('POST','/api/staff-orders/orders',body)).status,410);
});
