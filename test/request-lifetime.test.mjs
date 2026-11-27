// A cancelled Cloudflare request must not leave later requests awaiting its I/O.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {timingSafeEqual} from 'node:crypto';
const {build}=createRequire(import.meta.url)('esbuild');
async function load(entry){
 const result=await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',
  plugins:[{name:'cloudflare-worker-stub',setup(plugin){
   plugin.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'test'}));
   plugin.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class DurableObject {}'}));
  }}]});
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const schema=await load('../src/schema.ts'), auth=await load('../src/auth.ts');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
async function promptly(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('A new request is still waiting on an ended request')),500)})])}finally{clearTimeout(timer)}}
function database({firstSchema,firstKey,key='a'.repeat(64)}={}){
 const calls={batch:0,insertKey:0};
 const db={batch(){calls.batch++;return calls.batch===1&&firstSchema?firstSchema.promise:Promise.resolve([])},prepare(sql){return{bind(){return this},run(){if(sql.includes("INSERT OR IGNORE INTO secrets")){calls.insertKey++;if(calls.insertKey===1&&firstKey)return firstKey.promise}return Promise.resolve({success:true,meta:{changes:0}})},all(){return Promise.resolve({results:schema.MIGRATION_LIST().map(({id})=>({id}))})},first(){return Promise.resolve({v:key})}}}};
 return{env:{DB:db},calls};
}
test('an abandoned schema request cannot poison later requests or clear their completed readiness',async()=>{
 const abandoned=deferred(),{env,calls}=database({firstSchema:abandoned});
 const first=schema.ensureSchema(env).catch(e=>e);
 try{
  await promptly(schema.ensureSchema(env));
  assert.equal(calls.batch,2,'each in-flight request owns its initialization work');
 }finally{abandoned.reject(new Error('The original request ended'));await first}
 await promptly(schema.ensureSchema(env));assert.equal(calls.batch,2,'successful readiness survives the earlier request failing');
 const separate=database();await promptly(schema.ensureSchema(separate.env));assert.equal(separate.calls.batch,1,'a different database is initialized independently');
});
test('a failed schema request can retry without caching the failure',async()=>{
 const broken=deferred(),{env,calls}=database({firstSchema:broken});
 const first=schema.ensureSchema(env);broken.reject(new Error('Temporary database failure'));
 await assert.rejects(first,/Temporary database failure/);
 await promptly(schema.ensureSchema(env));await promptly(schema.ensureSchema(env));assert.equal(calls.batch,2);
});
test('a token request can recover while an earlier key lookup belongs to an ended request',async()=>{
 const abandoned=deferred(),{env,calls}=database({firstKey:abandoned});
 const first=auth.signToken(env,'test.',{user:'example'}).catch(e=>e);
 let token;
 try{token=await promptly(auth.signToken(env,'test.',{user:'example'}));assert.equal(calls.insertKey,2)}
 finally{abandoned.reject(new Error('The original request ended'));await first}
 assert.deepEqual(await promptly(auth.readToken(env,'test.',token)),{user:'example'});
 assert.equal(calls.insertKey,2,'only the resolved signing key is cached');
});
test('resolved signing keys remain scoped to their database and preserve token verification',async()=>{
 const a=database({key:'b'.repeat(64)}),b=database({key:'c'.repeat(64)});
 const token=await auth.signToken(a.env,'test.',{user:'example'});
 assert.deepEqual(await auth.readToken(a.env,'test.',token),{user:'example'});
 assert.equal(await auth.readToken(b.env,'test.',token),null,'a different database must not reuse another signing key');
 assert.equal(a.calls.insertKey,1);assert.equal(b.calls.insertKey,1);
});

function sqliteBinding(t, beforeStatement=()=>{}) {
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 function statement(sql, args=[]) {
  return {
   bind(...values){return statement(sql,values);},
   async first(){await beforeStatement(sql);return sqlite.prepare(sql).get(...args)??null;},
   async all(){await beforeStatement(sql);return {results:sqlite.prepare(sql).all(...args)};},
   async run(){
    await beforeStatement(sql);
    const prepared=sqlite.prepare(sql);
    return /\bRETURNING\b/i.test(sql)?{results:prepared.all(...args)}:{meta:prepared.run(...args)};
   },
  };
 }
 const DB={prepare:statement,async batch(statements){
  sqlite.exec('BEGIN');
  try {
   const results=[];
   for(const stmt of statements)results.push(await stmt.run());
   sqlite.exec('COMMIT');
   return results;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}
 }};
 return {sqlite,env:{DB,SETUP_CODE:'test-setup-code'}};
}

const request=(path,body,cookie)=>new Request('https://staff.example'+path,{
 method:body===undefined?'GET':'POST',
 headers:{'content-type':'application/json',...(cookie?{cookie}:{})},
 body:body===undefined?undefined:JSON.stringify(body),
});
const cookieOf=response=>response.headers.getSetCookie().find(cookie=>cookie.startsWith('sfbb_session=')).split(';')[0];
async function setupAccount(env) {
 await schema.ensureSchema(env);
 return auth.handleAuth(request('/api/auth/setup',{
  code:env.SETUP_CODE,username:'admin',name:'Test Admin',password:'original-password',
 }),env,'setup',null);
}
function workerCrypto(t) {
 Object.defineProperty(crypto.subtle,'timingSafeEqual',{
  value:(left,right)=>timingSafeEqual(new Uint8Array(left),new Uint8Array(right)),configurable:true,
 });
 t.after(()=>delete crypto.subtle.timingSafeEqual);
}

test('password change and recovery reject a stale credential or account and issue the committed session',async t=>{
 workerCrypto(t);
 let race;
 const {env,sqlite}=sqliteBinding(t,sql=>{
  if(sql.includes('RETURNING id, name, role, username, session_ver'))race?.();
 });
 const original=await setupAccount(env);
 assert.equal(original.status,200);
 sqlite.exec(`INSERT INTO staff_passkeys
   (id,user_id,rp_id,credential_id,public_key,counter,transports,device_type,backed_up,name,created_at)
   SELECT 'old-passkey',id,'staff.example','credential','public-key',0,'[]','singleDevice',0,'Personal device',0 FROM users`);
 const reset=await auth.hashPassword('newer-temporary-password');
 race=()=>sqlite.prepare('UPDATE users SET pin_hash=?, pin_salt=?, must_change=1, session_ver=session_ver+1 WHERE username=?')
  .run(reset.hash,reset.salt,'admin');
 await assert.rejects(auth.handleAuth(request('/api/auth/change',{
  username:'admin',password:'original-password',newPassword:'stale-password',
 }),env,'change',null),{status:409,code:'conflict'});
 assert.equal(sqlite.prepare('SELECT pin_hash FROM users').get().pin_hash,reset.hash);

 race=()=>sqlite.exec("UPDATE users SET role='staff'");
 const recover=()=>auth.handleAuth(request('/api/auth/recover',{
  username:'admin',code:env.SETUP_CODE,password:'recovered-password',
 }),env,'recover',null);
 await assert.rejects(recover(),{status:409,code:'conflict'});
 assert.equal(sqlite.prepare('SELECT pin_hash FROM users').get().pin_hash,reset.hash);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM staff_passkeys').get().n,1);

 sqlite.exec("UPDATE users SET role='admin'");
 race=undefined;
 const recovered=await recover();
 const current=await auth.sessionUser(request('/api/auth/me',undefined,cookieOf(recovered)),env);
 assert.equal(current?.role,'admin');
 assert.equal(await auth.sessionUser(request('/api/auth/me',undefined,cookieOf(original)),env),null);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM staff_passkeys').get().n,0);
});

test('concurrent recovery guesses reserve the last shared IP attempt before comparison',async t=>{
 workerCrypto(t);
 const {env,sqlite}=sqliteBinding(t);
 await setupAccount(env);
 sqlite.exec('UPDATE rate_limits SET n=29');
 const guesses=await Promise.allSettled(Array.from({length:4},()=>auth.handleAuth(request('/api/auth/recover',{
  username:'admin',code:'incorrect',password:'unused-password',
 }),env,'recover',null)));
 assert.deepEqual(guesses.map(guess=>guess.reason.code).sort(),
  ['rate_limited','rate_limited','rate_limited','wrong_setup_code']);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind='signin_failed'").get().n,1);
});

test('the fifth wrong password still starts a finite lock during global sign-out',async t=>{
 workerCrypto(t);
 let revoke=false;
 const {env,sqlite}=sqliteBinding(t,sql=>{
  if(revoke && sql.startsWith('UPDATE users SET failed = 0, locked_until = ?')){
   revoke=false;
   sqlite.exec('UPDATE users SET session_ver=session_ver+1');
  }
 });
 await setupAccount(env);
 sqlite.exec('UPDATE users SET failed=4');
 const login=password=>auth.handleAuth(request('/api/auth/login',{username:'admin',password}),env,'login',null);
 revoke=true;
 await assert.rejects(login('wrong-password'),{status:423,code:'locked'});
 const locked=sqlite.prepare('SELECT failed, locked_until, session_ver FROM users').get();
 assert.equal(locked.session_ver,2);
 assert.equal(locked.failed,0);
 assert.ok(locked.locked_until>Date.now());
 sqlite.prepare('UPDATE users SET locked_until=?').run(Date.now()-1);
 const response=await login('original-password');
 assert.equal(response.status,200);
 assert.equal((await auth.sessionUser(request('/api/auth/me',undefined,cookieOf(response)),env))?.role,'admin');
});

test('PIN enrollment uses the exact authorized session and stale fifth guesses preserve replacement credentials',async t=>{
 workerCrypto(t);
 const worker=(await load('../src/index.ts')).default;
 let interleave;
 const {env,sqlite}=sqliteBinding(t,sql=>interleave?.(sql));
 const ctx={waitUntil(){}};
 const initial=await setupAccount(env);
 const cookie=cookieOf(initial);
 const device=initial.headers.getSetCookie().find(value=>value.startsWith('sfbb_device=')).split(';')[0];
 const id=sqlite.prepare('SELECT id FROM users').get().id;
 sqlite.exec("UPDATE users SET role='staff'");
 const pin=(value,session=cookie)=>worker.fetch(request('/api/auth/pin',{pin:value},session),env,ctx);
 assert.equal((await pin('5862')).status,200);
 const fresh=await auth.handleAuth(request('/api/auth/login',{username:'admin',password:'original-password'}),env,'login',null);
 const newest=cookieOf(fresh), session=await auth.staffSessionForWrite(request('/api/auth/me',undefined,newest),env);
 const before=sqlite.prepare('SELECT quick_hash FROM users').get().quick_hash;
 interleave=sql=>{
  if(!sql.startsWith('UPDATE users SET quick_hash = ?, quick_salt = ?')) return;
  interleave=undefined;
  sqlite.prepare('INSERT INTO revoked_sessions VALUES (?, ?)').run(session.sid,session.exp);
 };
 const revoked=await pin('5782',cookie+'; '+newest);
 assert.equal(revoked.status,409,await revoked.clone().text());
 assert.equal(sqlite.prepare('SELECT quick_hash FROM users').get().quick_hash,before);

 interleave=sql=>{
  if(!sql.startsWith('UPDATE users SET quick_hash = ?, quick_salt = ?')) return;
  interleave=undefined;
  sqlite.exec("UPDATE users SET role='admin'");
 };
 assert.equal((await pin('5782')).status,409);
 assert.equal(sqlite.prepare('SELECT quick_hash FROM users').get().quick_hash,before);
 sqlite.exec("UPDATE users SET role='staff'");

 let forceDbNow;
 sqlite.function('julianday',_=>2440587.5+(forceDbNow??Date.now())/86400000);
 interleave=sql=>{
  if(!sql.startsWith('UPDATE users SET quick_hash = ?, quick_salt = ?')) return;
  interleave=undefined;
  forceDbNow=session.exp+10000;
 };
 assert.equal((await pin('5782')).status,409);
 assert.equal(sqlite.prepare('SELECT quick_hash FROM users').get().quick_hash,before);
 forceDbNow=undefined;

 const switchWith=value=>worker.fetch(request('/api/auth/switch',{id,pin:value},device),env,ctx);
 sqlite.exec('UPDATE users SET failed=4');
 interleave=async sql=>{
  if(!sql.startsWith('UPDATE users SET failed = 0, locked_until = ?, quick_hash = NULL')) return;
  interleave=undefined;
  assert.equal((await pin('5782')).status,200);
 };
 const staleGuess=await switchWith('4859');
 assert.equal(staleGuess.status,409,await staleGuess.clone().text());
 assert.deepEqual({...sqlite.prepare('SELECT failed,locked_until FROM users').get()},{failed:0,locked_until:0});
 assert.equal((await switchWith('5782')).status,200);

 const reset=await auth.hashPassword('temporary-replacement');
 interleave=sql=>{
  if(!sql.startsWith('UPDATE users SET quick_hash = ?, quick_salt = ?')) return;
  interleave=undefined;
  sqlite.prepare('UPDATE users SET pin_hash=?,pin_salt=?,must_change=1,session_ver=session_ver+1,quick_hash=NULL,quick_salt=NULL')
   .run(reset.hash,reset.salt);
 };
 assert.equal((await pin('5862')).status,409);
 assert.equal(sqlite.prepare('SELECT quick_hash FROM users').get().quick_hash,null);
});

test('session database failures retry safe reads and return unavailable without clearing cookies',async t=>{
 workerCrypto(t);
 t.mock.method(console,'error',()=>{});
 const worker=(await load('../src/index.ts')).default;
 let fail;
 const {env}=sqliteBinding(t,sql=>fail?.(sql));
 const admin=cookieOf(await setupAccount(env));
 const jobs=[], ctx={waitUntil(promise){jobs.push(promise);}};
 const send=(path,body,cookie=admin)=>worker.fetch(request(path,body,cookie),env,ctx);
 let tries=0;
 fail=sql=>{
  if(sql==="SELECT v FROM secrets WHERE k = 'session_key'"&&++tries===1)throw new Error('D1_ERROR: internal');
 };
 assert.equal((await send('/api/admin/status')).status,200);
 assert.equal(tries,2);
 tries=0;
 fail=sql=>{
  if(sql.includes('AS revoked FROM users')){
   ++tries;
   throw new Error('D1_ERROR: internal');
  }
 };
 const read=await send('/api/auth/me');
 assert.equal(read.status,503);
 assert.equal((await read.json()).code,'session_unavailable');
 assert.equal(tries,2);
 const write=await send('/api/auth/logout',{});
 assert.equal(write.status,503);
 assert.equal(tries,3);
 assert.deepEqual(write.headers.getSetCookie(),[]);
 const forged=admin.split('.')[0]+'.'+Buffer.alloc(32).toString('base64url');
 const unauthenticated=await send('/api/auth/me',undefined,forged);
 assert.equal(unauthenticated.status,200);
 assert.equal((await unauthenticated.json()).user,null);
 fail=undefined;
 assert.equal((await (await send('/api/auth/me')).json()).user.role,'admin');
 await Promise.all(jobs);
});

test('the Worker retries a failed read without replaying a one-use callback or a committed write',async t=>{
 workerCrypto(t);
 t.mock.method(console,'error',()=>{});
 const worker=(await load('../src/index.ts')).default;
 const tracked=[];
 let fail;
 const transient=()=>new Error('D1_ERROR: internal');
 const {env,sqlite}=sqliteBinding(t,sql=>fail?.(sql));
 const ctx={waitUntil(promise){tracked.push(promise);}};
 const admin=cookieOf(await setupAccount(env));
 const send=(path,body)=>worker.fetch(request(path,body,admin),env,ctx);

 let tries=0;
 fail=sql=>{
  if(sql.startsWith('SELECT COUNT(*) AS n FROM docs')&&++tries===1)throw transient();
 };
 assert.equal((await send('/api/admin/status')).status,200);
 assert.equal(tries,2);

 const state='a'.repeat(64);
 const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(state))).toString('hex');
 sqlite.prepare('INSERT INTO quickbooks_auth_states VALUES (?,?,?,?,?,?)')
  .run(digest,'sandbox',sqlite.prepare('SELECT id FROM users').get().id,'unused',1,Date.now()+60000);
 tries=0;
 fail=sql=>{
  if(sql.startsWith('DELETE FROM quickbooks_auth_states WHERE state_hash=')){
   ++tries;
   sqlite.prepare('DELETE FROM quickbooks_auth_states WHERE state_hash=?').run(digest);
   throw transient();
  }
 };
 assert.equal((await send('/api/admin/wholesale/quickbooks/callback?state='+state)).status,500);
 assert.equal(tries,1);

 tries=0;
 fail=sql=>{
  if(sql.startsWith('UPDATE meta SET v = v + 1 WHERE k IN')&&++tries===1)throw transient();
 };
 const updated=await send('/api/admin/users',{name:'Staff',username:'staff',role:'staff',password:'staff-password'});
 assert.equal(updated.status,200,await updated.clone().text());
 await Promise.all(tracked);
 assert.equal(tries,2);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE username='staff'").get().n,1);
 assert.equal(sqlite.prepare("SELECT v FROM meta WHERE k='accounts'").get().v,1);

 fail=sql=>{
  if(sql.startsWith('UPDATE meta SET v = v + 1 WHERE k IN'))throw new Error('Unexpected notification error');
 };
 const rota=await worker.fetch(new Request('https://staff.example/api/rota/me/emails',{
  method:'PUT',headers:{cookie:admin},body:JSON.stringify({prefs:{published:false}}),
 }),env,ctx);
 assert.equal(rota.status,200,await rota.clone().text());
 await Promise.all(tracked);
 assert.equal(JSON.parse(sqlite.prepare("SELECT email_prefs FROM users WHERE username='admin'").get().email_prefs).published,false);
 assert.equal(sqlite.prepare("SELECT page FROM errors WHERE message LIKE 'Change counters failed%'").get().page,'/api/rota/me/emails');
});

test('the staff gateway signs and forwards only the support search and cursor for admins',async t=>{
 workerCrypto(t);
 const worker=(await load('../src/index.ts')).default;
 const {env,sqlite}=sqliteBinding(t);
 const admin=cookieOf(await setupAccount(env));
 const ctx={waitUntil(){}};
 const query='?q=Older+%25_&cursor=dGVzdA';
 let calls=0;
 t.mock.method(globalThis,'fetch',async (url,{headers,method})=>{
  calls++;
  assert.equal(url.pathname+url.search,'/api/control/consumer/support'+query);
  const {privateKey:{kty,crv,x,y}}=JSON.parse(sqlite.prepare("SELECT v FROM secrets WHERE k='retail_service_v1'").get().v);
  const key=await crypto.subtle.importKey('jwk',{kty,crv,x,y},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const header=name=>headers.get('x-strangers-service-'+name);
  const input=['STRANGERS-RETAIL-SERVICE-V1',method,url.origin,url.pathname+url.search,
   header('time'),header('nonce'),header('client'),'','',header('digest')].join('\n');
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,
   Buffer.from(header('signature'),'base64url'),new TextEncoder().encode(input)),true);
  return Response.json({messages:[],count:0,nextCursor:null,query:{search:'Older %_',cursor:'dGVzdA'}});
 });
 const path='/api/admin/consumer/support'+query+'&ignored=1';
 assert.equal((await worker.fetch(request(path),env,ctx)).status,401);
 const result=await worker.fetch(request(path,undefined,admin),env,ctx);
 assert.equal(result.status,200,await result.clone().text());
 assert.deepEqual(await result.json(),{messages:[],count:0,nextCursor:null,query:{search:'Older %_',cursor:'dGVzdA'},supportGateway:1});
 assert.equal(calls,1);
});

test("checkout rechecks customer, catalogue and sign-in state at insertion and preserves successful retries", async (t) => {
  const { handleWholesale } = await load("../src/wholesale.ts");
  let changeBeforeInsert;
  const { env, sqlite } = sqliteBinding(t, (sql) => {
    if (/INSERT INTO wholesale_preview/.test(sql) && changeBeforeInsert) {
      const change = changeBeforeInsert;
      changeBeforeInsert = undefined;
      sqlite.exec(change);
    }
  });
  await schema.ensureSchema(env);
  const token = "a".repeat(64);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
  const customer = { business: "Test Business", contact: "Buyer", status: "Active", address: "1 Market Place", postcode: "NR2 1AA" };
  sqlite.prepare("INSERT INTO wholesale_preview VALUES ('customer','shop',?,1,1)").run(JSON.stringify(customer));
  sqlite.exec("INSERT INTO wholesale_accounts (id,customer_id,username,password_hash,password_salt,must_change,created_at,updated_at) VALUES ('buyer','shop','buyer','','',0,1,1)");
  sqlite.prepare("INSERT INTO wholesale_sessions VALUES (?,'buyer',1,?)").run(digest, Date.now() + 60_000);
  const user = { role: "wholesale", accountId: "buyer", id: "wholesale:buyer", customerId: "shop", name: "Buyer", username: "buyer" };
  const order = { requestId: crypto.randomUUID(), customerVersion: 1, delivery: "Delivery",
    lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, price: 1800 }] };
  const place = (body = order, cookie = token) => handleWholesale(request("/api/wholesale/orders", body, "sf_wholesale_session=" + cookie), env, "orders", user, { admin: "", diary: "/" });
  const count = () => sqlite.prepare("SELECT COUNT(*) AS n FROM wholesale_preview WHERE kind='order'").get().n;

  changeBeforeInsert = "UPDATE wholesale_preview SET data=json_set(data,'$.status','On hold','$.address',''),version=2 WHERE kind='customer'";
  await assert.rejects(place(), { status: 409, code: "conflict" });
  sqlite.prepare("UPDATE wholesale_preview SET data=?,version=3 WHERE kind='customer'").run(JSON.stringify(customer));
  order.customerVersion = 3;

  changeBeforeInsert = `INSERT INTO wholesale_preview VALUES ('catalogue','campo','{"active":true,"inStock":false,"prices":{"quarter":500,"kilo":1900}}',1,1)`;
  await assert.rejects(place(), { status: 409, code: "conflict" });
  sqlite.exec("DELETE FROM wholesale_preview WHERE kind='catalogue'");

  changeBeforeInsert = "UPDATE wholesale_accounts SET session_ver=2 WHERE id='buyer'";
  await assert.rejects(place(), { status: 409, code: "conflict" });
  assert.equal(count(), 0);
  const freshToken = "b".repeat(64);
  const freshDigest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(freshToken))).toString("hex");
  sqlite.prepare("INSERT INTO wholesale_sessions VALUES (?,'buyer',2,?)").run(freshDigest, Date.now() + 60_000);
  await assert.rejects(place(), { status: 409, code: "conflict" });

  const attempts = await Promise.all([place(order, freshToken), place(order, freshToken)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 201]);
  assert.equal(count(), 1);
  sqlite.exec("UPDATE wholesale_preview SET data=json_set(data,'$.status','On hold','$.address',''),version=4 WHERE kind='customer'");
  const replay = await place(order, freshToken);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).order.locationSnapshot.address, customer.address);
  assert.equal(count(), 1);
});

test("taking a wholesale order rechecks staff role and order access at insertion", async (t) => {
  workerCrypto(t);
  const { takeOrderFor } = await load("../src/wholesale.ts");
  let changeBeforeInsert;
  const { env, sqlite } = sqliteBinding(t, (sql) => {
    if (/INSERT INTO wholesale_preview/.test(sql) && changeBeforeInsert) sqlite.exec(changeBeforeInsert);
  });
  const cookie = cookieOf(await setupAccount(env));
  const user = sqlite.prepare("SELECT id,name,role FROM users").get();
  const order = { customerId: "shop", source: "Phone", requestId: crypto.randomUUID(), delivery: "Roastery collection",
    lines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6 }] };
  const place = (staff) => takeOrderFor(request("/api/staff-orders/orders", order, cookie), env, staff, { admin: "", diary: "/" });
  sqlite.exec(`INSERT INTO wholesale_preview VALUES ('customer','shop','{"business":"Test Business","status":"Active"}',1,1)`);
  changeBeforeInsert = "UPDATE users SET role='staff'";
  await assert.rejects(place(user), { status: 409, code: "conflict" });
  sqlite.prepare("INSERT INTO staff_order_access(user_id,enabled,version,updated_at,updated_by) VALUES (?,1,1,1,?)").run(user.id, user.id);
  changeBeforeInsert = "UPDATE staff_order_access SET enabled=0";
  await assert.rejects(place({ ...user, role: "staff" }), { status: 409, code: "conflict" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM wholesale_preview WHERE kind='order'").get().n, 0);
});

test("standing rollover compares catalogue revisions before claiming even a pending next run, then recovery reads current availability and price", async (t) => {
  const { rollStanding, repairStandingRuns } = await load("../src/wholesaleStanding.ts");
  let changeBeforeClaim = true;
  const { env, sqlite } = sqliteBinding(t, (sql) => {
    if (changeBeforeClaim && /UPDATE wholesale_preview SET data=\?,version=version\+1,updated_at=\?/.test(sql)) {
      changeBeforeClaim = false;
      sqlite.exec(`INSERT INTO wholesale_preview VALUES ('catalogue','campo','{"active":true,"inStock":false,"prices":{"quarter":500,"kilo":1900}}',1,1)`);
    }
  });
  await schema.ensureSchema(env);
  const id = "WS-" + "A".repeat(32), nextRunId = "WS-" + "B".repeat(32);
  const parent = { preview: false, status: "Cancelled", customerId: "shop", delivery: "Roastery collection", nextRunId,
    standing: { every: 1, seriesId: id, run: 1 },
    repeatLines: [{ productId: "campo", pack: "kilo", grind: "beans", quantity: 6, grams: 1000, price: 1800 }],
    lines: [{ productId: "brazil", pack: "kilo", grind: "beans", quantity: 6, grams: 1000, price: 1800 }] };
  sqlite.exec(`INSERT INTO wholesale_preview VALUES ('customer','shop','{"business":"Test Business","status":"Active"}',1,1)`);
  sqlite.prepare("INSERT INTO wholesale_preview VALUES ('order',?,?,1,1)").run(id, JSON.stringify(parent));
  const row = (orderId) => sqlite.prepare("SELECT data,version FROM wholesale_preview WHERE kind='order' AND id=?").get(orderId);
  assert.equal(await rollStanding(env, { ...parent, id, version: 1, updatedAt: 1 }, "Admin"), null);
  assert.equal(row(id).version, 1, "the failed guard does not claim the parent");
  assert.equal(row(nextRunId), undefined);
  assert.equal(await repairStandingRuns(env), 0);
  assert.equal(JSON.parse(row(id).data).standingIssue.code, "catalogue_changed");
  assert.equal(row(nextRunId), undefined);
  sqlite.exec("UPDATE wholesale_preview SET data=json_set(data,'$.inStock',json('true')),version=2 WHERE kind='catalogue'");
  sqlite.prepare("UPDATE wholesale_preview SET data=json_set(data,'$.standingRetryAt',0) WHERE kind='order' AND id=?").run(id);
  assert.equal(await repairStandingRuns(env), 1);
  assert.equal(JSON.parse(row(nextRunId).data).lines[0].price, 1900);
  assert.equal(JSON.parse(row(id).data).standingIssue, undefined);
  assert.equal(await repairStandingRuns(env), 0);
});
