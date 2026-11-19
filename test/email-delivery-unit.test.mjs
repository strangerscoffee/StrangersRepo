import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
async function load(path){const result=await build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,write:false,platform:'neutral',format:'esm',target:'es2022',logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
const {emailDns,emailSetup}=await load('../src/email/health.ts'),{handleResendWebhook}=await load('../src/email/delivery.ts');
test('DMARC setup uses the confirmed reporting inbox and authorizes external aggregate reports',()=>{
 const setup=emailSetup({ADMIN_HOST:'admin.staffstrangerscoffee.com'},'https://staffstrangerscoffee.com');assert.equal(setup.reportTo,'sales@strangerscoffee.com');assert.equal(setup.webhookUrl,'https://admin.staffstrangerscoffee.com/api/email/resend-webhook');
 assert.deepEqual(setup.records,[{name:'_dmarc.staffstrangerscoffee.com',type:'TXT',value:'v=DMARC1; p=none; rua=mailto:sales@strangerscoffee.com;'},{name:'staffstrangerscoffee.com._report._dmarc.strangerscoffee.com',type:'TXT',value:'v=DMARC1;'}]);
});
test('DNS diagnostics distinguish published records from missing, invalid and unavailable results',async()=>{
 for(const mode of ['published','missing','invalid','unavailable']){
  const calls=[];const fake=async(url)=>{calls.push(url);const name=new URL(url).searchParams.get('name');if(mode==='unavailable')throw new Error('Synthetic resolver outage');const values=mode==='missing'?[]:name.startsWith('_dmarc.')?[mode==='invalid'?'v=DMARC1; p=broken;':'v=DMARC1; p=none; rua=mailto:sales@strangerscoffee.com;']:name.startsWith('resend.')?['p=abc123']:name.includes('._report._dmarc.')?(mode==='published'?['v=DMARC1;']:[]):['v=spf1 include:synthetic.invalid ~all'];return new Response(JSON.stringify({Status:0,Answer:values.map(data=>({type:16,data:JSON.stringify(data)}))}));};
  const result=await emailDns({},'http://local.invalid',fake);assert.equal(result.domains[0].dmarc,mode);assert.ok(calls.every(url=>new URL(url).origin==='https://cloudflare-dns.com'));assert.equal(calls.length,4);
  const reporting = mode==='invalid' ? 'missing' : mode;
  assert.equal(result.domains[0].reportAddress, reporting);
  assert.equal(result.domains[0].reportAuthorization.status, reporting);
  if(mode==='published'){assert.equal(result.domains[0].dkim,'published');assert.equal(result.domains[0].bounceSpf,'published');}
 }
});
test('a published DMARC policy can still be missing external report authorisation', async () => {
  const fake = async url => {
    const name = new URL(url).searchParams.get('name');
    if (name.startsWith('_dmarc.')) return Response.json({ Status: 0, Answer: [{ type: 16, data: '"v=DMARC1; p=none; rua=mailto:sales@strangerscoffee.com;"' }] });
    return Response.json({ Status: 3 });
  };
  const [domain] = (await emailDns({}, 'https://staffstrangerscoffee.com', fake)).domains;
  assert.equal(domain.dmarc, 'published');
  assert.equal(domain.reportAddress, 'published');
  assert.deepEqual(domain.reportAuthorization, { name: 'staffstrangerscoffee.com._report._dmarc.strangerscoffee.com', status: 'missing' });
});
test('unsigned, expired or unconfigured webhooks do not touch the database or initialize schema',async()=>{
 let calls=0;const ready=async()=>{calls++;throw new Error('Untrusted webhook reached storage');},secret='whsec_'+Buffer.alloc(24,7).toString('base64');
 for(const env of [{},{RESEND_WEBHOOK_SECRET:'whsec_invalid'},{RESEND_WEBHOOK_SECRET:secret}]){
  const request=new Request('https://admin.example.invalid/api/email/resend-webhook',{method:'POST',body:'{}'});
  await assert.rejects(handleResendWebhook(request,env,ready),error=>[400,503].includes(error.status));
 }
 assert.equal(calls,0);
 await assert.rejects(handleResendWebhook(new Request('https://customer.example.invalid/api/email/resend-webhook',{method:'POST',body:'{}'}),{ADMIN_HOST:'admin.example.invalid',RESEND_WEBHOOK_SECRET:secret},ready),error=>error.status===404);assert.equal(calls,0);
});
