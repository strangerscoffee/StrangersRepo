// Production audit regressions. Every account, database and provider here is local and synthetic.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startServer,SETUP_CODE} from './harness.mjs';
let srv,provider,browser,ADMIN,STAFF,A,B,emailFail=false,emailAttempts=[],slackAttempts=0;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=ADMIN){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,cookie:cookieOf(r)};}
async function ok(...args){const r=await call(...args);assert.ok(r.status>=200&&r.status<300,`${args[0]} ${args[1]}: ${r.status} ${r.text} ${r.status>=500?srv.log().slice(-3500):''}`);return r;}
async function customer(username){const c=(await ok('POST','/api/admin/wholesale/customers',{business:'Synthetic '+username,contact:'Audit Buyer',email:username+'@example.invalid',address:'1 Synthetic Street',postcode:'NR1 1AA',status:'Active'})).data.customer;const invite=(await ok('POST',`/api/admin/wholesale/customers/${c.id}/account`,{username})).data;const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username:invite.account.username,password:invite.temporaryPassword,newPassword:'audit-local-password-2468'},null)).cookie;return{id:c.id,cookie};}
const allOrders=async()=>(await ok('GET','/api/admin/wholesale')).data.orders;
const order=async id=>(await allOrders()).find(o=>o.id===id);
async function place(productId='brazil',buyer=A){const s=(await ok('GET','/api/wholesale/session',undefined,buyer.cookie)).data;return(await ok('POST','/api/wholesale/orders',{requestId:crypto.randomUUID(),customerVersion:s.customer.version,delivery:'Roastery collection',reference:'Synthetic audit',lines:[{productId,pack:'kilo',grind:'beans',quantity:6,price:1800}]},buyer.cookie)).data.order;}
async function editProduct(id,values){const p=(await ok('GET','/api/admin/wholesale')).data.products.find(p=>p.id===id);return(await ok('PUT','/api/admin/wholesale/catalogue/'+id,{ifVersion:p.version,prices:p.prices,active:p.active,inStock:p.inStock,...values})).data.product;}
async function emailSettings(confirmCustomers){const s=(await ok('GET','/api/admin/wholesale/order-emails')).data;await ok('PUT','/api/admin/wholesale/order-emails',{ifVersion:s.version,enabled:false,to:['audit@example.invalid'],confirmCustomers});}
async function waitFor(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Synthetic condition did not settle');}
async function contextForStaff(){const ctx=await browser.newContext({viewport:{width:393,height:852}});const[name,value]=STAFF.split('=');await ctx.addCookies([{name,value,url:srv.base}]);return ctx;}
async function selectOnly(page,ids){await page.goto(srv.base+'/orders');await page.locator('#statusFilters button',{hasText:'All orders'}).click();for(const id of ids)await page.locator(`[data-order-id="${id}"]`).waitFor();await page.getByRole('button',{name:'Select orders',exact:true}).click();for(const id of ids)await page.locator(`[data-order-id="${id}"]`).click();}
async function setup({withBrowser=false}={}){
 provider=createServer((req,res)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{if(req.url==='/emails'){const mail=JSON.parse(raw);emailAttempts.push({subject:mail.subject,accepted:!emailFail,key:req.headers['idempotency-key'],mail});res.writeHead(emailFail?503:200,{'content-type':'application/json'}).end(emailFail?'temporary synthetic provider failure':'{"id":"synthetic"}');}else{slackAttempts++;res.writeHead(200).end('ok');}});});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 srv=await startServer({writeLimit:10000,scheduled:true,vars:{RESEND_API_KEY:'re_synthetic_audit_key',RESEND_API_URL:`http://127.0.0.1:${provider.address().port}/emails`,SLACK_TEST_HOOKS:'1',SLACK_ORDERS_WEBHOOK_URL:`http://127.0.0.1:${provider.address().port}/slack`}});
 ADMIN=(await ok('POST','/api/auth/setup',{name:'Synthetic Audit Admin',username:'audit.owner',password:'audit-local-password-1234',code:SETUP_CODE},null)).cookie;await emailSettings(false);A=await customer('audit.a');B=await customer('audit.b');
 const u=(await ok('POST','/api/admin/users',{name:'Synthetic Packer',username:'audit.packer',role:'staff',password:'audit-temp-password-5555'})).data.user;await ok('PUT',`/api/admin/users/${u.id}/orders-access`,{ifVersion:0,enabled:true});STAFF=(await ok('POST','/api/auth/change',{username:'audit.packer',password:'audit-temp-password-5555',newPassword:'audit-packer-own-password'},null)).cookie;
}
async function teardown(){await browser?.close();await srv?.stop();await new Promise(r=>provider?.close(r));}


before(()=>setup());after(teardown);

test('standing rollover checks the current private assignment before copying prices, and can be recovered',async()=>{
 await editProduct('campo',{active:true,inStock:true,customerOnly:true,whiteLabel:[A.id]});const placed=await place('campo');
 const tomorrow=new Date(Date.now()+864e5).toISOString().slice(0,10);const run=(await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'New',customerId:A.id,note:'',schedule:{dispatchDate:tomorrow,every:1}})).data.order;
 await editProduct('campo',{customerOnly:true,whiteLabel:[B.id],inStock:false,prices:{quarter:2501,kilo:9999}});
 assert.equal((await ok('GET','/api/wholesale/catalogue',undefined,A.cookie)).data.products.some(p=>p.id==='campo'),false);
 const skipped=(await ok('POST',`/api/wholesale/orders/${run.id}/skip`,{ifVersion:run.version},A.cookie)).data.order;
 assert.equal(skipped.status,'Cancelled');assert.ok(skipped.standingIssue);assert.equal(skipped.nextRunId,undefined);
 const history=(await ok('GET','/api/wholesale/orders',undefined,A.cookie)).data;assert.doesNotMatch(JSON.stringify(history),/9999/);
 assert.ok((await ok('GET','/api/admin/wholesale')).data.standingIssues.some(r=>r.id===run.id));
 await editProduct('campo',{customerOnly:true,whiteLabel:[A.id],inStock:true});
 const recovered=(await ok('PATCH',`/api/admin/wholesale/orders/${skipped.id}`,{ifVersion:skipped.version,status:'Cancelled',customerId:A.id,note:''})).data.order;
 assert.ok(recovered.nextRunId);assert.equal(recovered.standingIssue,undefined);assert.equal((await order(recovered.nextRunId)).lines[0].price,9999);
});

test('stock, active status, offered packs and enabled grinds each block the next standing delivery',async()=>{
 const original=(await ok('GET','/api/admin/wholesale')).data.products.find(p=>p.id==='brazil');
 for(const change of [{inStock:false},{active:false},{packs:['quarter']},{grindOptions:original.grindOptions.map(g=>({...g,enabled:g.id!=='beans'}))}]){
  await editProduct('brazil',{active:true,inStock:true,packs:original.packs||['quarter','kilo'],grindOptions:original.grindOptions});
  const placed=await place(),day=new Date(Date.now()+864e5).toISOString().slice(0,10);
  const run=(await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'New',customerId:A.id,note:'',schedule:{dispatchDate:day,every:1}})).data.order;
  await editProduct('brazil',change);
  const cancelled=(await ok('PATCH',`/api/admin/wholesale/orders/${run.id}`,{ifVersion:run.version,status:'Cancelled',customerId:A.id,note:''})).data.order;
  assert.ok(cancelled.standingIssue,JSON.stringify(change));assert.equal(cancelled.nextRunId,undefined);
  const stopped=(await ok('PATCH',`/api/admin/wholesale/orders/${cancelled.id}`,{ifVersion:cancelled.version,status:'Cancelled',customerId:A.id,note:'',schedule:{dispatchDate:day,every:0}})).data.order;assert.equal(stopped.standingIssue,undefined);assert.equal(stopped.standing,undefined);
 }
 await editProduct('brazil',{active:true,inStock:true,packs:original.packs||['quarter','kilo'],grindOptions:original.grindOptions});
});

test('a provider refusal persists an unsent dispatch event; retry uses the same event key and sends only once',async()=>{
 const placed=await place();await emailSettings(true);emailAttempts=[];emailFail=true;
 const dispatched=(await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''})).data.order;
 const row=()=>srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0];
 await waitFor(()=>row()?.state==='retry');assert.equal(dispatched.dispatchEmailedAt,undefined);assert.equal(row().sent_at,null);
 assert.equal(emailAttempts.filter(m=>m.accepted).length,0);assert.equal(emailAttempts.at(-1).key,'dispatch:'+placed.id);
 emailFail=false;await ok('POST','/api/admin/wholesale/order-emails/email-retry',{});await waitFor(()=>row().state==='sent');
 assert.equal(emailAttempts.filter(m=>m.accepted).length,1);assert.equal(emailAttempts.at(-1).key,'dispatch:'+placed.id);assert.ok(row().sent_at);
 for(const status of ['Preparing','Dispatched']){const current=await order(placed.id);await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:current.version,status,customerId:A.id,note:''});}
 assert.equal(emailAttempts.filter(m=>m.accepted).length,1);await emailSettings(false);
});

test('dispatch event and order status roll back together if the guarded update fails',async()=>{
 const placed=await place();await emailSettings(true);
 srv.sql(`CREATE TRIGGER synthetic_dispatch_fail BEFORE UPDATE ON wholesale_preview WHEN NEW.id='${placed.id}' AND json_extract(NEW.data,'$.status')='Dispatched' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`);
 try{const response=await call('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''});assert.equal(response.status,500);assert.equal((await order(placed.id)).status,'New');assert.equal(srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`).length,0);}
 finally{srv.sql('DROP TRIGGER synthetic_dispatch_fail');await emailSettings(false);}
});

test('old ambiguous dispatch delivery requires review before it can be retried',async()=>{
 const placed=await place();await emailSettings(true);emailFail=true;
 await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''});
 const row=()=>srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0];await waitFor(()=>row()?.state==='retry');
 srv.sql(`UPDATE wholesale_email_outbox SET state='sending',uncertain=1,attempted_at=${Date.now()-864e5},first_attempt_at=${Date.now()-864e5},lease_until=0 WHERE order_id='${placed.id}'`);
 const refused=await call('POST','/api/admin/wholesale/order-emails/email-retry',{});assert.equal(refused.status,409);assert.equal(refused.data.code,'delivery_unknown');assert.equal(row().state,'unknown');
 emailFail=false;await ok('POST','/api/admin/wholesale/order-emails/email-retry',{acknowledgeUnknown:true});await waitFor(()=>row().state==='sent');await emailSettings(false);
});

test('interrupted Slack sends retain an unknown result until explicitly reviewed; historical sent rows never replay',async()=>{
 const id='WS-SYNTHETIC-INTERRUPTED-CLAIM',old=Date.now()-864e5,payload=JSON.stringify({text:'Synthetic audit only'}).replaceAll("'","''");
 srv.sql(`INSERT INTO slack_order_posts(order_id,payload,send_after,created_at,attempts) VALUES('${id}','${payload}',0,${old},1); INSERT INTO slack_order_delivery(order_id,state,claim_token,lease_until,attempted_at,updated_at) VALUES('${id}','sending','synthetic',0,${old},${old}); INSERT INTO slack_order_posts(order_id,payload,send_after,created_at,sent_at,attempts) VALUES('legacy-sent','${payload}',0,${old},${old},1)`);
 await ok('POST','/api/admin/wholesale/order-emails/slack-retry',{}).then(()=>assert.fail('Unknown send must require review'),e=>{assert.match(e.message,/409/);});
 assert.equal(srv.sql(`SELECT state FROM slack_order_delivery WHERE order_id='${id}'`)[0].state,'unknown');
 const before=slackAttempts;await ok('POST','/api/admin/wholesale/order-emails/slack-retry',{acknowledgeUnknown:true});await waitFor(()=>srv.sql(`SELECT sent_at FROM slack_order_posts WHERE order_id='${id}'`)[0].sent_at!=null);assert.equal(slackAttempts,before+1);
 assert.equal(srv.sql("SELECT sent_at,attempts FROM slack_order_posts WHERE order_id='legacy-sent'")[0].attempts,1);
});

test('concurrent cron runs recover a recent dispatch lease with one idempotent accepted send',async()=>{
 const placed=await place();await emailSettings(true);emailFail=true;
 await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''});
 const row=()=>srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0];await waitFor(()=>row()?.state==='retry');
 srv.sql(`UPDATE wholesale_email_outbox SET state='sending',uncertain=1,lease_until=0,next_attempt_at=0 WHERE order_id='${placed.id}'`);emailFail=false;
 await Promise.all([fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *')),fetch(srv.base+'/__scheduled?cron='+encodeURIComponent('*/5 * * * *'))]);await waitFor(()=>row().state==='sent');
 assert.equal(emailAttempts.filter(m=>m.key==='dispatch:'+placed.id&&m.accepted).length,1);await emailSettings(false);
});

test('an exhausted uncertain email cannot bypass delivery review through the normal retry action',async()=>{
 const placed=await place();await emailSettings(true);emailFail=true;
 await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''});
 const row=()=>srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0];await waitFor(()=>row()?.state==='retry');
 srv.sql(`UPDATE wholesale_email_outbox SET state='failed',uncertain=1,attempts=8,first_attempt_at=${Date.now()-864e5},attempted_at=${Date.now()-864e5},lease_until=NULL WHERE order_id='${placed.id}'`);
 const refused=await call('POST','/api/admin/wholesale/order-emails/email-retry',{});assert.equal(refused.status,409);assert.equal(row().state,'unknown');
 emailFail=false;await ok('POST','/api/admin/wholesale/order-emails/email-retry',{acknowledgeUnknown:true});await waitFor(()=>row().state==='sent');await emailSettings(false);
});

test('a historical dispatch failure is listed for explicit recovery without replaying successful legacy mail',async()=>{
 const placed=await place(),at=Date.now()-10000;
 const current=await order(placed.id);const data={...current,status:'Dispatched',dispatchEmailedAt:at};delete data.id;delete data.version;delete data.updatedAt;
 srv.sql(`UPDATE wholesale_preview SET data='${JSON.stringify(data).replaceAll("'","''")}' WHERE kind='order' AND id='${placed.id}'; INSERT INTO audit_log(at,kind,text) VALUES(${at+1},'email_failed','Could not send collected email for ${placed.id} to Synthetic')`);
 const response=await call('GET','/api/admin/wholesale/order-emails');if(response.status!==200)console.error('Synthetic error records',srv.sql('SELECT message,detail FROM errors ORDER BY last_at DESC LIMIT 2'));assert.equal(response.status,200);const settings=response.data;assert.ok(settings.delivery.legacyDispatch.some(o=>o.id===placed.id));
 assert.equal((await call('POST','/api/admin/wholesale/order-emails/legacy-retry',{orderId:placed.id})).status,409);
 await emailSettings(true);await ok('POST','/api/admin/wholesale/order-emails/legacy-retry',{orderId:placed.id,acknowledgeUnknown:true});
 await waitFor(()=>srv.sql(`SELECT state FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0]?.state==='sent');
 assert.equal((await ok('GET','/api/admin/wholesale/order-emails')).data.delivery.legacyDispatch.some(o=>o.id===placed.id),false);
 assert.equal((await call('POST','/api/admin/wholesale/order-emails/legacy-retry',{orderId:placed.id,acknowledgeUnknown:true})).status,409);await emailSettings(false);
});

test('ordinary retries retain the original uncertain replay window; a backup exports pending mail for review',async()=>{
 const placed=await place();await emailSettings(true);emailFail=true;
 await ok('PATCH',`/api/admin/wholesale/orders/${placed.id}`,{ifVersion:placed.version,status:'Dispatched',customerId:A.id,note:''});
 const row=()=>srv.sql(`SELECT * FROM wholesale_email_outbox WHERE order_id='${placed.id}'`)[0];await waitFor(()=>row()?.state==='retry');
 const first=Date.now()-3600000;srv.sql(`UPDATE wholesale_email_outbox SET uncertain=1,first_attempt_at=${first} WHERE order_id='${placed.id}'`);
 await ok('POST','/api/admin/wholesale/order-emails/email-retry',{});await waitFor(()=>row().state==='retry');assert.equal(row().first_attempt_at,first);assert.equal(row().uncertain,1);
 const info=(await ok('POST','/api/admin/backups',{})).data.backup;const backup=(await ok('GET','/api/admin/backups/'+info.id)).data;
 const saved=backup.wholesaleEmailOutbox.find(r=>r.order_id===placed.id);assert.equal(saved.state,'unknown');assert.equal(saved.claim_token,null);assert.equal(saved.lease_until,null);assert.doesNotMatch(JSON.stringify(backup),/re_synthetic_audit_key|sfbb_session/);
 srv.sql(`UPDATE wholesale_email_outbox SET state='queued',first_attempt_at=${Date.now()-864e5} WHERE order_id='${placed.id}'`);assert.equal((await call('POST','/api/admin/wholesale/order-emails/email-retry',{})).status,409);assert.equal(row().state,'unknown');
 emailFail=false;await ok('POST','/api/admin/wholesale/order-emails/email-retry',{acknowledgeUnknown:true});await waitFor(()=>row().state==='sent');await emailSettings(false);
});
