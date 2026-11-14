// A cancelled Cloudflare request must not leave later requests awaiting its I/O.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
async function load(entry){
 const result=await build({entryPoints:[fileURLToPath(new URL(entry,import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',logLevel:'silent'});
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
