import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
import {isPublicCode} from '../src/hosts.ts';
let srv,admin;
before(async()=>{
 srv=await startServer({host:'admin.example.test',vars:{ADMIN_HOST:'admin.example.test'}});
 const r=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Asset Owner',username:'assets.owner',password:'asset-test-password',code:SETUP_CODE})});assert.equal(r.status,200);admin=r.headers.getSetCookie().find(c=>/^sfbb_session=[\w-]/.test(c)).split(';')[0];
});
after(()=>srv?.stop());
test('the entire data-free Admin dependency graph loads after session loss, with correct types and fingerprints',async()=>{
 const page=await fetch(srv.base+'/',{headers:{cookie:admin}});assert.equal(page.status,200);const html=await page.text();
 assert.match(html,/application\/x-sc-script/);assert.match(html,/src="\/admin\/boot.js\?v=/);
 const urls=[...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css)(?:\?[^" ]*)?)"/g)].map(m=>m[1]);assert.ok(urls.length>20);
 for(const url of urls)for(const method of ['GET','HEAD']){
  const response=await fetch(srv.base+url,{method,redirect:'manual'});assert.equal(response.status,200,method+' '+url);assert.match(response.headers.get('content-type'),url.split('?')[0].endsWith('.js')?/javascript/:/text\/css/);assert.equal(response.headers.get('location'),null);
  if(method==='GET')assert.equal(await response.text(),await readFile(new URL('../public'+url.split('?')[0],import.meta.url),'utf8'));
 }
});
test('Admin HTML, APIs, snapshots, uploaded images and non-code files keep authentication',async()=>{
 for(const path of ['/','/admin/','/admin/index.html','/admin/people.json','/wholesale/catalogue.js','/wholesale/images/brazil.webp'])assert.notEqual((await fetch(srv.base+path,{redirect:'manual'})).status,200,path);
 for(const path of ['/api/admin/people','/api/admin/wholesale','/api/rota/leave/admin'])assert.equal((await fetch(srv.base+path,{redirect:'manual'})).status,401,path);
 for(const path of ['/admin/index.html','/admin/data.json','/api/admin/people','/wholesale/catalogue.js'])assert.equal(isPublicCode('admin',path),false,path);
 for(const file of await readdir(new URL('../public/admin/',import.meta.url)))if(/\.(js|css)$/.test(file)){assert.equal(isPublicCode('admin','/admin/'+file),true);assert.equal(isPublicCode('rota','/admin/'+file),false);assert.equal(isPublicCode('preview','/admin/'+file),false);}
});
test('Admin code remains available when the account database is temporarily unavailable',async()=>{
 srv.sql('ALTER TABLE users RENAME TO synthetic_unavailable_users');
 try{for(const path of ['/shared/core.js','/shared/focus.js','/admin/boot.js','/admin/admin.js','/admin/sickness.css','/shared/wholesale-packing.css']){const response=await fetch(srv.base+path,{headers:{cookie:admin},redirect:'manual'});assert.equal(response.status,200,path);assert.match(response.headers.get('content-type'),path.endsWith('.js')?/javascript/:/text\/css/);}}
 finally{srv.sql('ALTER TABLE synthetic_unavailable_users RENAME TO users');}
});
