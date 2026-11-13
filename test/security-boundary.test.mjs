import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
import {trustedOrigin} from '../src/requestOrigins.ts';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');
const httpSource=ts.transpileModule(readFileSync(new URL('../src/http.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {readJson}=await import('data:text/javascript;base64,'+Buffer.from(httpSource).toString('base64'));
let srv,admin,staff,manager,staffId,a,b;
const cookieOf=r=>(r.headers.getSetCookie().find(v=>/^sf(?:bb|_wholesale)_session=[\w-]/.test(v))||'').split(';')[0];
async function call(method,path,body,cookie=admin,extra={}){const r=await fetch(srv.base+path,{method,redirect:'manual',headers:{...(cookie?{cookie}:{}),'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{}return{status:r.status,headers:r.headers,data,text,cookie:cookieOf(r)}}
async function ok(...args){const r=await call(...args);assert.ok(r.status>=200&&r.status<300,JSON.stringify({status:r.status,path:args[1],body:r.data}));return r}
async function business(name){const customer=(await ok('POST','/api/admin/wholesale/customers',{business:name,contact:'Private '+name,email:name+'@example.test',address:'Private address '+name,postcode:'NR1 1AA',status:'Active'})).data.customer;const account=(await ok('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username:name})).data;const cookie=(await ok('POST','/api/wholesale/auth/change-password',{username:name,password:account.temporaryPassword,newPassword:name+'-own-password'},null)).cookie;return{customer,cookie,user:(await ok('GET','/api/wholesale/session',undefined,cookie)).data.me}}
before(async()=>{srv=await startServer({writeLimit:4000,vars:{ADMIN_HOST:"admin.staffstrangerscoffee.com"}});admin=(await ok('POST','/api/auth/setup',{name:'Security Owner',username:'security.owner',password:'security-owner-password',code:SETUP_CODE},null)).cookie;for(const role of ['staff','manager']){const u=(await ok('POST','/api/admin/users',{name:'Security '+role,username:'security.'+role,role,password:'temporary-password'})).data.user;const cookie=(await ok('POST','/api/auth/change',{username:'security.'+role,password:'temporary-password',newPassword:'security-'+role+'-password'},null)).cookie;if(role==='staff'){staff=cookie;staffId=u.id}else manager=cookie}a=await business('security.alpha');b=await business('security.beta')});
after(()=>srv?.stop());
test('origin trust requires an exact configured app origin, including scheme and port',()=>{
 const env={COOKIE_DOMAIN:'staffstrangerscoffee.com',ADMIN_HOST:'admin.staffstrangerscoffee.com',ROTA_HOST:'rota.staffstrangerscoffee.com',LEGACY_PREVIEW_HOST:'preview.staffstrangerscoffee.com'},url=new URL('https://staffstrangerscoffee.com/api/db/set');
 for(const origin of ['https://staffstrangerscoffee.com','https://admin.staffstrangerscoffee.com','https://rota.staffstrangerscoffee.com','https://preview.staffstrangerscoffee.com'])assert.equal(trustedOrigin(origin,url,env),true,origin);
 for(const origin of [null,'null','https://outside.example','https://unused.staffstrangerscoffee.com','http://staffstrangerscoffee.com','https://staffstrangerscoffee.com:444','https://user@staffstrangerscoffee.com','https://staffstrangerscoffee.com/path','https://staffstrangerscoffee.com.evil.example'])assert.equal(trustedOrigin(origin,url,env),false,origin);
 assert.equal(trustedOrigin('http://localhost:8787',new URL('http://localhost:8787/api/db/set'),env),true);
 assert.equal(trustedOrigin('https://admin.staffstrangerscoffee.com',new URL('https://strangerscoffee.trade/api/wholesale/orders'),env),false);
});
test('anonymous and forged identities cannot access employee, customer, accounting or backup APIs',async()=>{
 const paths=['/api/admin/users','/api/admin/backups','/api/admin/people','/api/admin/export/people.csv','/api/admin/wholesale','/api/admin/wholesale/invoices','/api/admin/wholesale/quickbooks/app-settings','/api/admin/wholesale/insights','/api/staff-orders/orders','/api/staff-orders/customers','/api/staff-orders/tabs','/api/rota/me','/api/rota/hours','/api/db/get','/_blob/'+'0'.repeat(32)];
 for(const cookie of [null,'sfbb_session=forged.invalid','sf_wholesale_session='+'0'.repeat(64)])for(const path of paths){const r=await call('GET',path,undefined,cookie);assert.equal(r.status,401,path);assert.doesNotMatch(r.text,/Private address|Private security|password_hash|pin_hash/);assert.equal(r.headers.get('access-control-allow-origin'),null);assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin')}
 for(const cookie of [staff,manager,a.cookie])for(const path of ['/api/admin/users','/api/admin/backups','/api/admin/wholesale/quickbooks/app-settings'])assert.equal((await call('GET',path,undefined,cookie)).status,cookie===a.cookie?401:403,path);
});
test('untrusted sibling, wrong-scheme and alternate-port origins cannot write using a valid cookie',async()=>{
 for(const Origin of ['https://unused.staffstrangerscoffee.com','http://staffstrangerscoffee.com','https://staffstrangerscoffee.com:444','https://outside.example','null'])assert.equal((await call('POST','/api/db/set',{path:'suppliers/security',data:{name:'SHOULD_NOT_SAVE'}},admin,{Origin})).status,403,Origin);
 assert.equal((await ok('POST','/api/db/get',{path:'suppliers/security'})).data.exists,false);
 for(const Origin of ['https://staffstrangerscoffee.com','https://admin.staffstrangerscoffee.com','https://rota.staffstrangerscoffee.com'])assert.equal((await call('POST','/api/db/set',{path:'suppliers/security',data:{name:'Approved origin'}},admin,{Origin})).status,200,Origin);
});
test('private employee records remain owner-scoped through direct reads and polls',async()=>{
 const path='staff/security-private';await ok('POST','/api/db/set',{path,data:{name:'Security staff',ownerUserId:staffId,note:'OWNER_ONLY_TRAINING'}});
 assert.equal((await ok('POST','/api/db/get',{path},staff)).data.data.note,'OWNER_ONLY_TRAINING');
 for(const cookie of [manager,b.cookie,null]){const r=await call('POST','/api/db/get',{path},cookie);if(cookie===manager){assert.equal(r.status,200);assert.equal(r.data.exists,false);assert.ok(!r.text.includes('OWNER_ONLY_TRAINING'))}else assert.equal(r.status,401)}
});
test('ordering identity mismatch cannot read or alter another business or sign it out',async()=>{
 const headers={'x-expected-ordering-id':a.user.id,'x-expected-ordering-role':'wholesale'};
 for(const[method,path,body]of[['GET','/api/wholesale/catalogue'],['GET','/api/wholesale/orders'],['GET','/api/wholesale/invoices'],['PUT','/api/wholesale/account',{ifVersion:b.customer.version,contact:'WRONG_ACCOUNT'}],['POST','/api/wholesale/auth/logout',{}]]){const r=await call(method,path,body,b.cookie,headers);assert.equal(r.status,409,path);assert.equal(r.data.code,'session_changed');assert.ok(!r.text.includes('Private security.beta'))}
 const current=(await ok('GET','/api/wholesale/session',undefined,b.cookie)).data;assert.equal(current.customer.contact,'Private security.beta');
 const proof=await call('GET','/api/wholesale/session',undefined,a.cookie,{'x-sc-session-check':'1'});assert.equal(proof.status,200);assert.deepEqual(proof.data,{user:{id:a.user.id,role:'wholesale'}});assert.equal(proof.headers.get('set-cookie'),null);assert.match(proof.headers.get('cache-control'),/no-store/);
});
test('protected PDF responses cannot be cached or fetched through arbitrary KV keys',async()=>{
 const upload=await fetch(srv.base+'/api/assets',{method:'POST',headers:{cookie:admin,'content-type':'application/pdf'},body:'%PDF-1.4\n%%EOF'});assert.equal(upload.status,200);const file=await upload.json();
 const r=await fetch(srv.base+file.url,{headers:{cookie:staff}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');
 for(const path of [file.url,'/_blob/backup:2026-11-13','/_blob/wholesale-image:abc'])assert.equal((await call('GET',path,undefined,null)).status,401,path);
 assert.equal((await call('GET','/_blob/backup:2026-11-13',undefined,staff)).status,404);
});

test('chunked public JSON bodies are stopped at the byte limit and split UTF-8 remains valid',async()=>{
 let cancelled=false,pulls=0;
 const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024));},cancel(){cancelled=true}});
 await assert.rejects(readJson(new Request('http://localhost/api/auth/login',{method:'POST',body:stream,duplex:'half'}),2048),error=>error.status===413);
 assert.equal(cancelled,true);assert.ok(pulls<10,'do not buffer the rest of an oversized request');
 const bytes=new TextEncoder().encode(JSON.stringify({name:'Café'}));
 const small=new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close()}});
 assert.deepEqual(await readJson(new Request('http://localhost/api/auth/login',{method:'POST',body:small,duplex:'half'}),100),{name:'Café'});
});
