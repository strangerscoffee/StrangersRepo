// All messages and webhook signatures are synthetic; no external mail provider is contacted.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {startServer,SETUP_CODE} from './harness.mjs';
let srv,provider,admin,staff,manager,received=[];
const secret='whsec_'+Buffer.alloc(24,7).toString('base64'),cookieOf=r=>(r.headers.getSetCookie().find(c=>/^sfbb_session=[\w-]/.test(c))||'').split(';')[0];
async function call(method,path,body,cookie=admin,headers={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return{status:r.status,data,text,cookie:cookieOf(r)};}
async function ok(...args){const r=await call(...args);assert.ok(r.status>=200&&r.status<300,`${args[0]} ${args[1]} ${r.status} ${r.text}`);return r;}
async function member(role){const username='delivery.'+role;await ok('POST','/api/admin/users',{name:'Synthetic '+role,username,role,password:'temporary-test-password'});return(await ok('POST','/api/auth/change',{username,password:'temporary-test-password',newPassword:'chosen-test-password'},null)).cookie;}
async function send(){const before=received.length;await ok('POST','/api/admin/wholesale/order-emails/test',{});assert.equal(received.length,before+1);return received.at(-1);}
async function feedback(type,email,{id='msg_'+randomUUID().replaceAll('-',''),at=Date.now(),timestamp=Math.floor(Date.now()/1000),data={},signature,raw,headers={}}={}){
 const payload={type,created_at:new Date(at).toISOString(),data:{email_id:email?.id,from:email?.body.from,to:email?.body.to,subject:email?.body.subject,...data}},body=raw??JSON.stringify(payload),sig=signature??'v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(id+'.'+timestamp+'.'+body).digest('base64');
 const response=await fetch(srv.base+'/api/email/resend-webhook',{method:'POST',headers:{'svix-id':id,'svix-timestamp':String(timestamp),'svix-signature':sig,...headers},body});const text=await response.text();let result;try{result=JSON.parse(text);}catch{}return{status:response.status,data:result,id,payload};
}
const health=async()=>(await ok('GET','/api/admin/wholesale/order-emails/delivery')).data;
const status=async id=>(await health()).messages.find(m=>m.id===srv.sql(`SELECT id FROM email_delivery_messages WHERE provider_id='${id}'`)[0]?.id)?.status;
before(async()=>{
 provider=createServer((req,res)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{const id=randomUUID();received.push({id,body:JSON.parse(raw)});res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id}));});});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 srv=await startServer({writeLimit:10000,vars:{RESEND_API_KEY:'re_synthetic',RESEND_API_URL:`http://127.0.0.1:${provider.address().port}/emails`,RESEND_WEBHOOK_SECRET:secret}});
 admin=(await ok('POST','/api/auth/setup',{name:'Delivery Admin',username:'delivery.owner',password:'delivery-owner-password',code:SETUP_CODE},null)).cookie;
 staff=await member('staff');manager=await member('manager');const settings=(await ok('GET','/api/admin/wholesale/order-emails')).data;await ok('PUT','/api/admin/wholesale/order-emails',{ifVersion:settings.version,enabled:true,to:['delivery@example.invalid']});
});
after(async()=>{await srv?.stop();await new Promise(r=>provider?.close(r));});
test('accepted metadata contains no email body, password link or secret; all nonadmins are denied',async()=>{
 const email=await send(),h=await health();assert.ok(h.webhookConfigured);assert.equal(await status(email.id),'accepted');assert.ok(email.body.from.startsWith('Strangers Wholesale <'));assert.ok(email.body.html&&email.body.text);
 assert.doesNotMatch(JSON.stringify(h),/whsec_|re_synthetic|DOCTYPE|<html|Bearer/);
 for(const cookie of [null,staff,manager])assert.ok([401,403].includes((await call('GET','/api/admin/wholesale/order-emails/delivery',undefined,cookie)).status));
 assert.equal(h.setup.reportTo,'sales@strangerscoffee.com');assert.deepEqual(h.setup.records.map(r=>r.name),['_dmarc.staffstrangerscoffee.com','staffstrangerscoffee.com._report._dmarc.strangerscoffee.com']);
});
test('verified delivery and delayed events are idempotent and cannot downgrade a delivered message',async()=>{
 const email=await send();const delivered=await feedback('email.delivered',email);assert.equal(delivered.status,200);assert.equal(await status(email.id),'delivered');
 const duplicate=await feedback('email.delivered',email,{id:delivered.id});assert.equal(duplicate.data.duplicate,true);assert.equal(srv.sql(`SELECT count(*) AS n FROM email_delivery_events WHERE id='${delivered.id}'`)[0].n,1);
 await feedback('email.delivery_delayed',email,{at:Date.now()-10000});assert.equal(await status(email.id),'delivered');
});
test('forged, stale, future, tampered and oversized webhooks change no delivery state',async()=>{
 const email=await send(),before=srv.sql('SELECT count(*) AS n FROM email_delivery_events')[0].n;
 for(const options of [{signature:'v1,invalid'},{timestamp:Math.floor(Date.now()/1000)-301},{timestamp:Math.floor(Date.now()/1000)+301},{raw:'not JSON'}])assert.equal((await feedback('email.delivered',email,options)).status,400);
 const payload=JSON.stringify({type:'email.delivered'}),id='msg_'+randomUUID();const wrong=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(id+'.'+Math.floor(Date.now()/1000)+'.'+payload).digest('base64');assert.equal((await feedback('email.delivered',email,{id,signature:'v1,'+wrong})).status,400);
 assert.equal((await feedback('email.delivered',email,{raw:' '.repeat(65537)})).status,413);
 assert.equal(srv.sql('SELECT count(*) AS n FROM email_delivery_events')[0].n,before);assert.equal(await status(email.id),'accepted');
});
test('a valid rotated signature and UTF-8 raw body verify; an unrelated sender is ignored',async()=>{
 const email=await send(),id='msg_'+randomUUID(),timestamp=Math.floor(Date.now()/1000),raw=JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:email.id,from:email.body.from,to:email.body.to,subject:'Café ☕'}});const valid=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(id+'.'+timestamp+'.'+raw).digest('base64');
 assert.equal((await feedback('email.delivered',email,{id,timestamp,raw,signature:'v1,invalid v1,'+valid})).status,200);assert.equal(await status(email.id),'delivered');
 const before=srv.sql('SELECT count(*) AS n FROM email_delivery_events')[0].n;assert.equal((await feedback('email.bounced',email,{data:{from:'Other <sender@unrelated.invalid>'}})).status,204);assert.equal(srv.sql('SELECT count(*) AS n FROM email_delivery_events')[0].n,before);
});
test('hard bounce blocks future sends; an older or replayed removal cannot silently clear it',async()=>{
 const email=await send(),at=Date.now(),bounce=await feedback('email.bounced',email,{at,data:{bounce:{message:'Mailbox unavailable',type:'Permanent'}}});assert.equal(bounce.status,200);assert.equal(await status(email.id),'bounced');
 let h=await health();assert.equal(h.suppressed[0].email,'delivery@example.invalid');const before=received.length;assert.equal((await call('POST','/api/admin/wholesale/order-emails/test',{})).status,502);assert.equal(received.length,before);
 assert.equal((await feedback('suppression.removed',null,{at:at-1000,data:{email:'delivery@example.invalid'}})).status,200);assert.equal((await health()).suppressed.length,1);
 assert.equal((await feedback('suppression.removed',null,{id:bounce.id,at:at+1000,data:{email:'delivery@example.invalid'}})).data.duplicate,true);assert.equal((await health()).suppressed.length,1);
 assert.equal((await feedback('suppression.removed',null,{at:at+2000,data:{email:'delivery@example.invalid'}})).status,200);assert.equal((await health()).suppressed.length,0);await send();
});
test('complaints take precedence over delivery and suppression events cannot expose other recipients',async()=>{
 const email=await send(),at=Date.now()+3000;await feedback('email.delivered',email,{at:at-1000});await feedback('email.complained',email,{at});assert.equal(await status(email.id),'complained');
 const before=srv.sql('SELECT count(*) AS n FROM email_suppressions')[0].n;assert.equal((await feedback('suppression.added',null,{data:{email:'unrelated@example.invalid',origin:'manual'}})).status,204);assert.equal(srv.sql('SELECT count(*) AS n FROM email_suppressions')[0].n,before);
 await feedback('suppression.removed',null,{at:at+1000,data:{email:'delivery@example.invalid'}});assert.equal((await health()).suppressed.length,0);
});
test('event feedback can arrive before the send acknowledgement is recorded',async()=>{
 const id=randomUUID(),email={id,body:{from:'Strangers Wholesale <orders@staffstrangerscoffee.com>',to:['early@example.invalid'],subject:'Synthetic early callback'}};
 assert.equal((await feedback('email.delivered',email)).status,200);srv.sql(`INSERT INTO email_delivery_messages(id,provider_id,recipient,recipient_name,subject,stream,about,accepted_at) VALUES('early','${id}','early@example.invalid','Early','Synthetic','wholesale','Synthetic',${Date.now()})`);assert.equal(await status(id),'delivered');
});
test('backups keep feedback and suppression state, without the webhook signing secret',async()=>{
 const info=(await ok('POST','/api/admin/backups',{})).data.backup,data=(await ok('GET','/api/admin/backups/'+info.id)).data;assert.ok(data.emailDelivery.messages.length);assert.ok(data.emailDelivery.events.length);assert.doesNotMatch(JSON.stringify(data),/whsec_|re_synthetic/);
});
