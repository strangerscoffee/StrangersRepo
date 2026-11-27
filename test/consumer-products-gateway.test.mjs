import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { admin, retail, wholesale, startEditorFixture } from './editor-integration-fixture.mjs';

const diary = 'https://staffstrangerscoffee.com';
const control = '/api/admin/consumer/products';
const photos = '/api/admin/consumer/product-photos';
const digest = 'a'.repeat(64);
const imagePath = '/consumer-product-media/' + digest;
let fixture;

// Runs as a second, local Worker. Echoing the request lets the tests assert exactly what was signed.
const serviceCode = `
export default {async fetch(req) {
  const url = new URL(req.url);
  if (url.origin !== "https://strangers-coffee-retail-demo.magicloom512.chatgpt.site" ||
      !req.headers.get('x-strangers-service-signature') || req.headers.has('cookie') || req.headers.has('authorization')) {
    return new Response(null, {status:403});
  }
  if (url.pathname === '/consumer-bridge/catalogue') return Response.json({products:[
    {id:'coffee', name:'Coffee', image:'/assets/roastery.webp', available:false, version:8, administrativeNote:'private'},
    {id:'retired', name:'Retired', available:true, archived:true},
  ]});
  if (url.pathname.endsWith('/product-photos/' + 'a'.repeat(64))) {
    return new Response(new Uint8Array([0xff,0xd8,0xff,0xd9]), {headers:{'content-type':'image/jpeg','set-cookie':'hidden=upstream'}});
  }
  if (url.pathname.endsWith('/product-photos/' + 'b'.repeat(64))) return Response.redirect('https://example.com/');
  if (url.pathname.includes('/product-photos/')) return new Response(null,{status:404});
  if (url.pathname === '/api/control/consumer/product-photos') return Response.json(await req.json(), {status:201});
  if (/^\\/api\\/control\\/consumer\\/products(?:\\/coffee)?$/.test(url.pathname)) {
    const input = req.body ? await req.json() : undefined;
    if (input?.ifVersion === 0) return Response.json({error:'conflict'}, {status:409});
    return Response.json({path:url.pathname + url.search, method:req.method, input});
  }
  return new Response(null,{status:404});
}};
`;
before(async () => {
  fixture = await startEditorFixture({retailWorker: {config: {
    name:'local-products-service', compatibilityDate:'2026-10-01',
    manifest:{mainModule:'service.mjs', modules:{'service.mjs':{type:'esm',contents:serviceCode}}},
  }}});
});
after(async () => fixture?.stop());

test('retail products and private photo administration require an admin session and same-site writes', async () => {
  const {request,cookie} = fixture;
  assert.equal((await request(admin,control)).status,401);
  assert.equal((await request(retail,control,'GET',undefined,cookie)).status,404);
  assert.equal((await request(diary,control,'GET',undefined,cookie)).status,404);
  assert.equal((await request(admin,photos+'/'+digest)).status,401);
  const account = {name:'Shop Reviewer', username:'fixture.shop.staff', role:'staff', password:'temporary-password'};
  assert.equal((await request(admin,'/api/admin/users','POST',account,cookie)).status,200);
  const change = await request(diary,'/api/auth/change','POST',{...account,newPassword:'my-staff-password'});
  assert.equal(change.status,200);
  const staff = change.headers.getSetCookie().find(value=>/^sfbb_session=[\w-]/.test(value))?.split(';')[0];
  assert.ok(staff);
  assert.equal((await request(admin,control,'GET',undefined,staff)).status,403);
  assert.equal((await request(admin,photos+'/'+digest,'GET',undefined,staff)).status,403);
  for (const origin of [diary, retail]) {
    assert.equal((await request(admin,control,'POST',{id:'coffee'},cookie,{origin})).status,403);
  }
  assert.equal((await request(admin,control,'POST',{id:'coffee'},cookie,{'content-type':'text/plain'})).status,415);
  assert.equal((await request(admin,control,'POST',{story:'x'.repeat(32768)},cookie)).status,413);
  assert.equal((await request(admin,control,'POST',[],cookie)).status,400);
});

test('administrators can list, add, amend, archive and restore through explicit signed service destinations', async () => {
  const {request,cookie} = fixture;
  for (const [method,suffix,input] of [
    ['GET','?unexpected=true',undefined], ['POST','',{id:'coffee',name:'Coffee',prices:{'250g':1200}}],
    ['PATCH','/coffee',{ifVersion:2,prices:{'250g':1350}}], ['DELETE','/coffee',{ifVersion:3}],
    ['PATCH','/coffee',{ifVersion:4,archived:false}], ['PATCH','/coffee',{available:false}],
  ]) {
    const res = await request(admin,control+suffix,method,input,cookie);
    assert.equal(res.status,200,await res.clone().text());
    const echo = await res.json();
    assert.equal(echo.method,method);
    assert.deepEqual(echo.input,input);
    assert.equal(echo.path,'/api/control/consumer/products'+(suffix.startsWith('/')?suffix:''));
  }
  assert.equal((await request(admin,control+'/coffee','PATCH',{ifVersion:0,name:'Old edit'},cookie)).status,409);
});

test('the public catalogue exposes shopper fields on the consumer host and omits archived items', async () => {
  const {request,cookie} = fixture;
  const path = '/api/retail/products';
  for (const origin of [admin,diary,wholesale]) assert.equal((await request(origin,path)).status,404);
  assert.equal((await request(retail,path,'POST',{})).status,405);
  const res = await request(retail,path,'GET',undefined,cookie,{authorization:'Bearer personal'});
  assert.equal(res.status,200);
  assert.equal(res.headers.get('cache-control'),'no-store');
  assert.deepEqual(await res.json(),{products:[{id:'coffee',name:'Coffee',image:'/consumer-preview/assets/roastery.webp',available:false}]});
});

test('product media validates images on upload and restricts upstream binary responses and caching', async () => {
  const {request,cookie} = fixture;
  const original = await readFile(new URL('../public/consumer-preview/assets/hero.webp',import.meta.url));
  const metadata = Buffer.from('Fixture tracking information');
  const chunk = Buffer.alloc(8+metadata.length+(metadata.length%2));
  chunk.write('XMP '); chunk.writeUInt32LE(metadata.length,4); metadata.copy(chunk,8);
  const tagged = Buffer.concat([original,chunk]);
  tagged.writeUInt32LE(tagged.length-8,4);
  const upload = await request(admin,photos,'POST',{type:'image/webp',data:tagged.toString('base64')},cookie);
  assert.equal(upload.status,201,await upload.clone().text());
  const clean = Buffer.from((await upload.json()).data,'base64');
  assert.ok(clean.byteLength>32768,'the dedicated upload route supports real catalogue photos beyond the ordinary service limit');
  assert.equal(clean.includes(metadata),false);
  const invalid = await request(admin,photos,'POST',{type:'image/webp',data:'ZmFrZQ=='},cookie);
  assert.equal(invalid.status,400);
  for (const [origin,path,session,cache] of [[retail,imagePath,undefined,/must-revalidate/],[admin,photos+'/'+digest,cookie,/no-store/]]) {
    const response = await request(origin,path,'GET',undefined,session);
    assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control'),cache);
    assert.equal(response.headers.get('content-type'),'image/jpeg');
    assert.equal(response.headers.get('set-cookie'),null);
    assert.equal((await response.arrayBuffer()).byteLength,4);
    const head = await request(origin,path,'HEAD',undefined,session);
    assert.equal(head.status,200);
    assert.equal((await head.arrayBuffer()).byteLength,0);
  }
  assert.equal((await request(wholesale,imagePath)).status,404);
  assert.equal((await request(retail,'/consumer-product-media/'+'c'.repeat(64))).status,404);
  const badUpstream = await request(retail,'/consumer-product-media/'+'b'.repeat(64));
  assert.equal(badUpstream.status,503);
  assert.equal(badUpstream.headers.get('cache-control'),'no-store');
});
