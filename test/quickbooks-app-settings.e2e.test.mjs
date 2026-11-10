import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
import {quickBooksVars,startQuickBooksProvider} from './quickbooks-provider.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const root='/api/admin/wholesale/quickbooks';
let srv,provider,browser,ADMIN;
before(async()=>{
 provider=await startQuickBooksProvider();srv=await startServer({writeLimit:5000,vars:({base})=>({...quickBooksVars(provider.origin),QUICKBOOKS_CLIENT_ID:'',QUICKBOOKS_CLIENT_SECRET:'',QUICKBOOKS_PRODUCTION_CLIENT_ID:'',QUICKBOOKS_PRODUCTION_CLIENT_SECRET:'',QUICKBOOKS_REDIRECT_URI:base+root+'/callback'})});
 const response=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'App settings owner',username:'owner',password:'owner-password',code:SETUP_CODE})});assert.equal(response.status,200);ADMIN=response.headers.getSetCookie().find(v=>/^sfbb_session=[\w-]/.test(v)).split(';')[0];
 browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
});
after(async()=>{await browser?.close();await srv?.stop();await provider?.stop();});
for(const [device,viewport] of [['phone',{width:393,height:852}],['iPad',{width:820,height:1180}],['desktop',{width:1440,height:1000}]])for(const colorScheme of ['light','dark']){
 test(`QuickBooks app setup ${device} ${colorScheme}: editable environment settings, hidden saved secrets and copyable URLs`,async()=>{
  const context=await browser.newContext({viewport,colorScheme});const [name,value]=ADMIN.split('=');await context.addCookies([{name,value,url:srv.base}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function open(){await page.goto(srv.base+'/admin#wholesale');await page.locator('[data-act="wh-tab"][data-id="invoices"]').click();await page.locator('[data-act="wh-invoice-quickbooks"]').click();await page.locator('#qbConnectionForm').waitFor();}
  try{
   await open();
   for(const [scope,label]of [['sandbox','Sandbox'],['production','Live']]){
    if(scope==='production'){await page.locator('[data-sheet="qb-scope"]').click();await page.locator('#qbConnectionForm h3',{hasText:'Live connection'}).waitFor();}
    await page.locator('[data-sheet="qb-app-settings"]').click();await page.locator('#qbAppSettingsForm').waitFor();
    assert.match(await page.locator('#sheetTitle').textContent(),new RegExp(label+' app settings'));
    assert.equal(await page.locator('#qbAppClientSecret').inputValue(),'');assert.equal(await page.locator('#qbAppWebhookToken').inputValue(),'');
    const id=`test-${scope}-client-${device.toLowerCase()}-${colorScheme}`,secret=`ui-${scope}-client-secret-${device}-${colorScheme}`,verifier=`ui-${scope}-verifier-token-${device}-${colorScheme}`;
    await page.locator('#qbAppClientId').fill(id);await page.locator('#qbAppClientSecret').fill(secret);await page.locator('#qbAppWebhookToken').fill(verifier);
    assert.equal(await page.locator('#qbAppClientSecret').getAttribute('type'),'password');assert.equal(await page.locator('#qbAppWebhookToken').getAttribute('type'),'password');
    assert.equal(await page.locator('#qbAppCallback').inputValue(),srv.base+root+'/callback');assert.equal(await page.locator('#qbAppWebhookUrl').inputValue(),srv.base+'/api/quickbooks/webhook/'+scope);
    assert.equal(await page.locator('#qbAppCallback').getAttribute('readonly'),'');
    if(scope==='sandbox'){
     await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard unavailable');}}}));
     await page.locator('[data-sheet="qb-copy-setup"][data-key="qbAppCallback"]').click();
     assert.equal(await page.locator('#qbAppCallback').evaluate(input=>input.selectionEnd-input.selectionStart===input.value.length),true,'copy fallback selects the full readonly address');
    }
    await page.locator('#qbAppReview').check();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(process.env.WHOLESALE_SCREENSHOT_DIR){await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/qb-app-${device}-${colorScheme}-${scope}.png`});}
    await page.locator('#qbAppSettingsForm button[type="submit"]').click();await page.locator('#qbConnectionForm').waitFor();assert.equal(await page.locator('[data-sheet="qb-connect"]').count(),1);
    await page.locator('[data-sheet="qb-app-settings"]').click();await page.locator('#qbAppSettingsForm').waitFor();assert.equal(await page.locator('#qbAppClientId').inputValue(),id);assert.equal(await page.locator('#qbAppClientSecret').inputValue(),'');assert.equal(await page.locator('#qbAppWebhookToken').inputValue(),'');
    assert.equal((await page.locator('#qbAppSettingsForm').textContent()).includes(secret),false);assert.equal((await page.locator('#qbAppSettingsForm').textContent()).includes(verifier),false);
    const response=await page.evaluate(async path=>(await fetch(path)).text(),root+'/app-settings?environment='+scope);assert.equal(response.includes(secret),false);assert.equal(response.includes(verifier),false);
    const stored=await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]));assert.equal(stored.includes(secret),false);assert.equal(stored.includes(verifier),false);
    await page.locator('#qbAppSettingsForm [data-sheet="wi-back"]').last().click();await page.locator('#qbConnectionForm').waitFor();
   }
   await page.locator('#qbConnectionForm [data-sheet="wi-back"]').last().click();await page.locator('#qbConnectionForm').waitFor({state:'hidden'});
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 });
}
