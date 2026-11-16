// A real competing HTTP process must not be mistaken for the fixture Worker.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startServer} from './harness.mjs';

test('fixture startup retries a confirmed port collision and waits for its own Worker',async()=>{
 let competitor,srv,calls=0,stolenPort;
 try{
  srv=await startServer({vars:({port})=>{
   calls++;
   if(calls===1){stolenPort=port;competitor=createServer((req,res)=>res.writeHead(200).end('A different process')).listen(port,'127.0.0.1');}
   return{};
  }});
  assert.equal(calls,2);assert.notEqual(new URL(srv.base).port,String(stolenPort));
  const response=await fetch(srv.base+'/api/auth/me');assert.equal(response.status,200);assert.equal(response.headers.get('content-type').includes('application/json'),true);assert.equal((await response.json()).user,null);
 }finally{await srv?.stop();if(competitor)await new Promise(resolve=>competitor.close(resolve));}
});
