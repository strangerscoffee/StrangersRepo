// Upgrade the deployed singleton storage without losing its authenticated Sandbox context.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,SETUP_CODE} from './harness.mjs';
import {migrateQuickBooks} from '../src/quickbooks/schema.ts';
import {seal,unseal} from '../src/quickbooks/crypto.ts';
import {quickBooksVars} from './quickbooks-provider.mjs';
const vars=quickBooksVars('http://127.0.0.1:9'),realm='1234567890',generation='legacy-test-generation';
const tokens={access:'legacy-fake-access',refresh:'legacy-fake-refresh',expiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+86400000};
let srv,cipher;
const quote=value=>"'"+value.replaceAll("'","''")+"'";
before(async()=>{
 const statements=[];await migrateQuickBooks({DB:{prepare:sql=>{statements.push(sql);return{};},batch:async()=>[]}});
 const key=await crypto.subtle.importKey('raw',Buffer.from(vars.QUICKBOOKS_TOKEN_KEY,'base64'),'AES-GCM',false,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12)),aad=new TextEncoder().encode(JSON.stringify(['quickbooks-sandbox-v1',realm,generation]));
 const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,new TextEncoder().encode(JSON.stringify(tokens)));
 cipher=JSON.stringify({v:1,iv:Buffer.from(iv).toString('base64'),cipher:Buffer.from(encrypted).toString('base64')});
 const preSql=statements.join(';')+`;CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL);INSERT INTO schema_migrations VALUES(15,'QuickBooks sandbox',1);UPDATE quickbooks_connection SET status='connected',generation=${quote(generation)},realm_id=${quote(realm)},company_name='Legacy sandbox',country='GB',currency='GBP',vat_number='GB123456789',token_data=${quote(cipher)},token_version=7,version=4,lease_owner='retired-lease',lease_until=9999999999999;INSERT INTO quickbooks_oauth_states VALUES('retired-nonce','old-admin','old-session',4,9999999999999);INSERT INTO quickbooks_mappings VALUES(${quote(realm)},'{"customerLinks":{},"coffeeItemId":"50","deliveryItemId":"","taxMappings":[]}',3,1);UPDATE quickbooks_installation SET namespace='0123456789abcdef0123456789abcdef';`;
 srv=await startServer({preSql,vars:({base})=>({...vars,QUICKBOOKS_REDIRECT_URI:base+'/api/admin/wholesale/quickbooks/callback'})});
 // Trigger the normal migration pipeline through an ordinary request.
 const setup=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Migration owner',username:'owner',password:'owner-password',code:SETUP_CODE})});assert.equal(setup.status,200,await setup.text());
});
after(async()=>{await srv?.stop();});
test('Migration 16 preserves legacy Sandbox tokens/mappings and namespace, clears retired access, and leaves Live disconnected',async()=>{
 const rows=srv.sql('SELECT * FROM quickbooks_connections ORDER BY environment'),live=rows.find(row=>row.environment==='production'),sandbox=rows.find(row=>row.environment==='sandbox');
 assert.equal(sandbox.status,'connected');assert.equal(sandbox.version,4);assert.equal(sandbox.generation,generation);assert.equal(sandbox.token_data,cipher);assert.equal(sandbox.token_version,7);assert.equal(sandbox.lease_owner,null);assert.equal(sandbox.lease_until,0);assert.deepEqual(await unseal(sandbox.token_data,vars.QUICKBOOKS_TOKEN_KEY,realm,generation,'sandbox'),tokens);
 assert.equal(live.status,'disconnected');assert.equal(live.token_data,null);assert.equal(live.realm_id,'');
 assert.deepEqual(srv.sql('SELECT status,token_data FROM quickbooks_connection')[0],{status:'disconnected',token_data:null});assert.equal(srv.sql('SELECT COUNT(*) AS n FROM quickbooks_oauth_states')[0].n,0);
 const mappings=srv.sql('SELECT * FROM quickbooks_environment_mappings');assert.equal(mappings.length,1);assert.equal(mappings[0].environment,'sandbox');assert.equal(mappings[0].version,3);assert.equal(JSON.parse(mappings[0].data).coffeeItemId,'50');assert.equal(srv.sql('SELECT namespace FROM quickbooks_installation')[0].namespace,'0123456789abcdef0123456789abcdef');assert.equal(srv.sql('SELECT active_environment,live_approval FROM quickbooks_settings')[0].active_environment,'sandbox');
});
test('Legacy ciphertext is never accepted for Live; v2 encryption binds identical realm IDs to separate environments',async()=>{
 await assert.rejects(()=>unseal(cipher,vars.QUICKBOOKS_TOKEN_KEY,realm,generation,'production'));
 const current=await seal(tokens,vars.QUICKBOOKS_TOKEN_KEY,realm,generation,'production');assert.deepEqual(await unseal(current,vars.QUICKBOOKS_TOKEN_KEY,realm,generation,'production'),tokens);
 await assert.rejects(()=>unseal(current,vars.QUICKBOOKS_TOKEN_KEY,realm,generation,'sandbox'));await assert.rejects(()=>unseal(current,vars.QUICKBOOKS_TOKEN_KEY,realm,'another-generation','production'));
});
