import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {csvCell} from '../public/shared/csv.js';
test('shared CSV formatter prevents formulas after whitespace while preserving real numeric credits',()=>{
 for(const text of ['=1+1','+1','-2','@SUM(A1)','\t=1','\r=1',' \t+1','\ufeff=1'])assert.ok(csvCell(text).startsWith("'")||csvCell(text).startsWith('"\''),JSON.stringify(text));
 assert.equal(csvCell(-2),'-2');assert.equal(csvCell(0), '0');assert.equal(csvCell(null),'');assert.equal(csvCell('Cafe, Norwich'),'"Cafe, Norwich"');assert.equal(csvCell('a"b'),'"a""b"');assert.equal(csvCell('normal',true),'"normal"');
});
test('production issuance and amendment SQL cannot both win either invoice/order race',async()=>{
 const issueSource=await readFile(new URL('../src/wholesaleInvoices.ts',import.meta.url),'utf8');
 const changeSource=await readFile(new URL('../src/wholesaleStanding.ts',import.meta.url),'utf8');
 const issue=issueSource.match(/prepare\("(INSERT INTO wholesale_invoices\(seq,invoice_number,order_id[^"\n]+)"\)/)[1];
 const amend=changeSource.match(/prepare\("(UPDATE wholesale_preview SET data=\?,version=version\+1,updated_at=\? WHERE kind='order' AND id=\? AND version=\? AND json_extract[^"\n]+)"\)/)[1];
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE wholesale_preview(kind TEXT,id TEXT,data TEXT,version INTEGER,updated_at INTEGER,PRIMARY KEY(kind,id));CREATE TABLE wholesale_invoice_settings(id INTEGER,data TEXT,version INTEGER);CREATE TABLE wholesale_invoices(seq INTEGER PRIMARY KEY AUTOINCREMENT,invoice_number TEXT UNIQUE,order_id TEXT UNIQUE,customer_id TEXT,request_key TEXT,data TEXT,issued_at INTEGER,issued_by TEXT);');
  db.prepare('INSERT INTO wholesale_invoice_settings VALUES(1,?,1)').run('{}');
  const old={preview:false,status:'New',lines:[{quantity:6}]},changed={...old,lines:[{quantity:8}]};
  for(const [index,invoiceFirst] of [true,false].entries()){
   const id='WS-'+String(index).repeat(32);db.prepare('INSERT INTO wholesale_preview VALUES(?,?,?,?,?)').run('order',id,JSON.stringify(old),1,1);
   const insert=()=>db.prepare(issue).get('INV-',1,id,'synthetic','request-'+index,JSON.stringify(old),2,'Audit',id,id,1,1);
   const update=()=>db.prepare(amend).run(JSON.stringify(changed),3,id,1,null,null,id).changes;
   if(invoiceFirst){assert.ok(insert());assert.equal(update(),0);}else{assert.equal(update(),1);assert.equal(insert(),undefined);}
  }
 }finally{db.close();}
});
