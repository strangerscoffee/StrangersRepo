import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer,SETUP_CODE} from './harness.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
let srv,browser,admin,staff,person,today,day,serial=0;
const cookieOf=r=>(r.headers.getSetCookie().find(c=>/^sfbb_session=[\w-]/.test(c))||'').split(';')[0];
const add=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
async function api(method,path,body,cookie=admin){const r=await fetch(srv.base+'/api/'+path,{method,headers:{'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
async function context(viewport,colorScheme,cookie){const c=await browser.newContext({viewport,colorScheme});const [name,value]=cookie.split('=');await c.addCookies([{name,value,url:srv.base}]);const page=await c.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));return {c,page,errors};}
async function fits(page){await page.locator('#sheet').evaluate(s=>Promise.all(s.getAnimations().map(a=>a.finished.catch(()=>{}))));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(await page.locator('#sheet .sfields input,#sheet .sfields select,#sheet .sfields textarea').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).flatMap(n=>{const r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect();return r.width>p.width+1||r.left<p.left-1||r.right>p.right+1?[n.id]:[];})),[]);}
async function screenshot(page,name){if(process.env.SHOT_DIR){await mkdir(process.env.SHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SHOT_DIR+'/'+name+'.png'});}}
async function requested(){const body={kind:'annual',from:add(day,++serial),to:add(day,serial),reason:'Private mobile note <script> — '+('LongNotes'.repeat(12))};const p=await api('POST','rota/leave/preview',body,staff);return (await api('POST','rota/leave/requests',{...body,expectedCharges:p.days,requestKey:crypto.randomUUID()},staff)).absence;}
before(async()=>{
 srv=await startServer({writeLimit:10000});browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{});
 const setup=await fetch(srv.base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Mobile Review Admin',username:'mobile.owner',password:'mobile-admin-password',code:SETUP_CODE})});assert.equal(setup.status,200);admin=cookieOf(setup);
 person=(await api('POST','admin/users',{name:'Alexandra Montgomery-Worthington',username:'mobile.staff',role:'staff',password:'temporary-mobile-password'})).user;
 const login=await fetch(srv.base+'/api/auth/change',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'mobile.staff',password:'temporary-mobile-password',newPassword:'chosen-mobile-password'})});assert.equal(login.status,200);staff=cookieOf(login);
 today=(await api('GET','rota/me')).today;day=add(today,14);const y=Number(today.slice(0,4))-(today.slice(5)<'04-01'?1:0);
 await api('PUT','rota/leave/settings',{enabled:true,yearStart:'04-01',bankHolidayPolicy:'included',limits:{},ifVersion:0});
 await api('PUT','rota/leave/allowances',{userId:person.id,from:y+'-04-01',to:(y+1)+'-03-31',unit:'days',entitlement:60,weekly:[1,1,1,1,1,1,1],changeReason:'Synthetic mobile layout fixture',ifVersion:0});
 // A pending request also puts a Cancel action on the page behind the request sheet.
 await requested();
});
after(async()=>{await browser?.close();await srv?.stop();});
test("leave on a short landscape phone keeps actions in flow and restores its keyboard opener", async () => {
 const {c,page}=await context({width:667,height:375},"dark",staff);
 try {
  await page.goto(srv.base+"/rota/#leave");
  const opener=page.getByRole("button",{name:"Request leave",exact:true});
  await opener.press("Enter");
  const sheet=page.getByRole("dialog",{name:"Request leave"});
  await sheet.waitFor();
  assert.equal(await sheet.locator(".sfoot").evaluate(node=>getComputedStyle(node).position),"static");
  await page.keyboard.press("Escape");
  await sheet.waitFor({state:"hidden"});
  assert.equal(await opener.evaluate(node=>node===document.activeElement),true);
 } finally {await c.close();}
});
for(const [device,viewport] of [['smallphone',{width:320,height:640}],['phone',{width:393,height:650}],['portrait-iPad',{width:820,height:1180}],['iPad',{width:1180,height:820}]])for(const scheme of ['light','dark'])test(`mobile leave ${device} ${scheme}: contained dates, half-day sync and reviewed decisions`,{timeout:90000},async()=>{
 const a=await context(viewport,scheme,staff),b=await context(viewport,scheme,admin);
 try{
  const p=a.page,request=p.locator('#sheet');await p.goto(srv.base+'/rota/#leave');await p.getByRole('button',{name:'Request leave',exact:true}).click();await p.locator('#leave_from').waitFor();await fits(p);
  // The two date boxes never overlap (on phones each has its own line), and the action bar hides what scrolls under it.
  const [f,t]=await Promise.all(['#leave_from','#leave_to'].map(id=>p.locator(id).boundingBox()));assert.ok(f.x+f.width<=t.x+1||f.y+f.height<=t.y+1,JSON.stringify([f,t]));if(viewport.width<=480)assert.ok(t.y>=f.y+f.height,'dates stack on phones');
  assert.equal(await p.locator('.leave-request-body .sfoot').evaluate(n=>getComputedStyle(n).backgroundColor.includes('rgba')&&!getComputedStyle(n).backgroundColor.endsWith(', 1)')),false,'solid action bar');
  const insets=await p.locator('#sheet').evaluate(s=>{const r=s.getBoundingClientRect(),h=s.querySelector('.shead').getBoundingClientRect(),body=s.querySelector('.sbody').getBoundingClientRect();return [h.left-r.left,r.right-h.right,body.left-r.left,r.right-body.right];});assert.ok(insets.every(n=>n>=16),JSON.stringify(insets));
  const action=await p.getByRole('button',{name:'Review request',exact:true}).boundingBox(),sheet=await p.locator('#sheet').boundingBox();assert.ok(action.y+action.height<=sheet.y+sheet.height-12,'the full action stays inside the short sheet');
  assert.ok(await request.getByRole('button',{name:'Cancel',exact:true}).evaluate(button=>button.offsetHeight)>=44);await screenshot(p,`leave-request-${device}-${scheme}`);
  await p.locator('#leave_portion').selectOption('0.5');assert.equal(await p.locator('#leave_to').isVisible(),false);await p.locator('#leave_from').fill(add(day,10));await p.locator('#leave_from_time').fill('09:00');await p.locator('#leave_to_time').fill('13:00');assert.equal(await p.locator('#leave_to').inputValue(),add(day,10));await fits(p);
  await p.getByRole('button',{name:'Review request',exact:true}).click();await p.getByRole('button',{name:'Submit request',exact:true}).waitFor();assert.match(await p.locator('#sheet').innerText(),/0.5 days/);assert.ok((await p.getByRole('button',{name:'Submit request',exact:true}).boundingBox()).width>=viewport.width*0.6||viewport.width>600);
  await p.locator('#leave_reason').fill('Edited after review');assert.equal(await p.getByRole('button',{name:'Submit request',exact:true}).isVisible(),false);await request.getByRole('button',{name:'Cancel',exact:true}).click();
  const absence=await requested(),q=b.page;await q.goto(srv.base+'/rota/#requests');const card=q.locator(`[data-leave-request="${absence.id}"]`);await card.waitFor();assert.match(await card.innerText(),/Annual leave/);assert.match(await card.innerText(),/Alexandra Montgomery-Worthington/);assert.match(await card.innerText(),/Private mobile note <script>/);assert.equal(await card.getByRole('button',{name:'Decline',exact:true}).count(),0);assert.equal(await card.locator('script').count(),0);await fits(q);
  const review=card.getByRole('button',{name:'Review request',exact:true});assert.ok(await review.evaluate(button=>button.offsetHeight)>=44);await screenshot(q,`requests-${device}-${scheme}`);await review.click();await q.locator('#sheetTitle',{hasText:'Review absence'}).waitFor();assert.match(await q.locator('#sheet').innerText(),/Private mobile note/);await fits(q);await q.locator('#sheet').getByRole('button',{name:'Decline',exact:true}).click();await q.locator('#sheet').waitFor({state:'hidden'});await card.waitFor({state:'detached'});
  assert.equal((await api('GET','rota/leave/requests/'+absence.id)).absence.status,'declined');assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
 }finally{await a.c.close();await b.c.close();}
});
test('a preview arriving after dates or notes change cannot enable stale submission',{timeout:60000},async()=>{
 const x=await context({width:393,height:650},'dark',staff);let release,arrived;const seen=new Promise(r=>arrived=r),hold=new Promise(r=>release=r);
 try{
  const p=x.page;await p.goto(srv.base+'/rota/#leave');await p.getByRole('button',{name:'Request leave',exact:true}).click();await p.locator('#leave_from').fill(day);await p.locator('#leave_to').fill(day);
  await p.route('**/api/rota/leave/preview',async route=>{const response=await route.fetch();arrived();await hold;await route.fulfill({response});});
  await p.getByRole('button',{name:'Review request',exact:true}).click();await seen;await p.locator('#leave_reason').fill('Changed while preview was loading');release();await p.getByRole('button',{name:'Review request',exact:true}).waitFor({state:'visible'});await p.waitForFunction(()=>!document.querySelector('.leave-request-body .sfoot button').disabled);
  assert.equal(await p.getByRole('button',{name:'Submit request',exact:true}).isVisible(),false);await p.unroute('**/api/rota/leave/preview');await p.getByRole('button',{name:'Review request',exact:true}).click();await p.getByRole('button',{name:'Submit request',exact:true}).waitFor();assert.equal(await p.locator('#leave_reason').inputValue(),'Changed while preview was loading');assert.deepEqual(x.errors,[]);
 }finally{release?.();await x.c.close();}
});
test('an unconfirmed submission keeps its dates, approval choice and original request key frozen',{timeout:60000},async()=>{
 const x=await context({width:393,height:650},'dark',admin),attempts=[];
 try{
  const p=x.page;await p.goto(srv.base+'/rota/#leave');await p.getByRole('button',{name:'Request leave',exact:true}).click();await p.locator('#leave_kind').selectOption('unpaid');await p.locator('#leave_from').fill(day);await p.locator('#leave_to').fill(day);await p.locator('input[name=leave_approved]').check();
  await p.getByRole('button',{name:'Review request',exact:true}).click();await p.getByRole('button',{name:'Submit request',exact:true}).waitFor();
  const requests='**/api/rota/leave/requests';
  await p.route(requests,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   attempts.push(route.request().postDataJSON());
   await route.fulfill({status:200,json:{saved:true}});
  });
  await p.getByRole('button',{name:'Submit request',exact:true}).click();await p.getByRole('button',{name:'Check request',exact:true}).waitFor();assert.equal(await p.locator('#leave_from').isDisabled(),true);assert.equal(await p.locator('input[name=leave_approved]').isDisabled(),true);
  const retried=p.waitForResponse(response=>response.url().endsWith('/api/rota/leave/requests')&&response.request().method()==='POST');
  await p.getByRole('button',{name:'Check request',exact:true}).click();await retried;
  assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);assert.deepEqual(x.errors,[]);
 }finally{await x.c.close();}
});
