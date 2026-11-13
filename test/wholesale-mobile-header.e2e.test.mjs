import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer, SETUP_CODE} from './harness.mjs';
import {openWholesaleAccount, openWholesaleAccountMenu} from './wholesale-ui-helpers.mjs';
const {chromium} = createRequire(import.meta.url)('playwright');
let srv, browser, ADMIN;
const username = 'header.buyer', password = 'header-buyer-password';
const business = 'A long approved wholesale business name that must stay inside the account menu';
const cookieOf = response => (response.headers.getSetCookie().find(value => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || '').split(';')[0];
async function api(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, {method, headers: {'content-type':'application/json', ...(cookie ? {cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json(); assert.ok(response.ok, `${path}: ${response.status}`); return {response, data};
}
before(async () => {
  srv = await startServer({writeLimit:4000});
  ADMIN = cookieOf((await api('POST','/api/auth/setup',{name:'Header Owner',username:'owner',password:'header-owner-password',code:SETUP_CODE},null)).response);
  const customer = (await api('POST','/api/admin/wholesale/customers',{business,contact:'Header Buyer',email:'header@example.test',address:'Test street',postcode:'NR1 1AA',status:'Active'})).data.customer;
  const account = (await api('POST',`/api/admin/wholesale/customers/${customer.id}/account`,{username})).data;
  await api('POST','/api/wholesale/auth/change-password',{username,password:account.temporaryPassword,newPassword:password},null);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const colorScheme of ['light','dark']) test(`compact mobile header ${colorScheme}: navigation, native account menu, resize drafts and sign-out`, {timeout:120000}, async () => {
  for (const width of [320,393]) {
    const cookie = cookieOf((await api('POST','/api/wholesale/auth/login',{username,password},null)).response);
    const context = await browser.newContext({viewport:{width,height:852}, colorScheme});
    const [name,value] = cookie.split('='); await context.addCookies([{name,value,url:srv.base}]);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(srv.base+'/wholesale-preview/'); await page.locator('#products article').first().waitFor();
      const measure = () => page.locator('.site-header').evaluate(node => ({height:node.getBoundingClientRect().height, mainTop:document.querySelector('main').getBoundingClientRect().top+scrollY, overflow:document.documentElement.scrollWidth-innerWidth, targets:[...node.querySelectorAll('a,button')].map(n=>n.getBoundingClientRect()).filter(b=>b.width&&b.height).map(b=>({width:b.width,height:b.height}))}));
      const before = await measure(); assert.equal(before.height,64); assert.equal(before.overflow,0); assert.equal(before.targets.length,5); assert.ok(before.targets.every(target=>target.width>=44&&target.height>=44));
      assert.equal(await page.locator('#signed-in-name').isVisible(),false);
      await openWholesaleAccountMenu(page);
      assert.equal(await page.locator('#signed-in-name').innerText(),business);
      const afterOpen = await measure(); assert.equal(afterOpen.height,64); assert.equal(afterOpen.mainTop,before.mainTop); assert.equal(afterOpen.overflow,0);
      const bounds = await page.locator('#wholesale-account').boundingBox(); assert.ok(bounds.x>=15&&bounds.x+bounds.width<=width-15);
      await page.keyboard.press('Escape'); await page.locator('#wholesale-account:popover-open').waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement===document.getElementById('account-toggle'));
      await openWholesaleAccountMenu(page); await page.locator('main > .page-heading h1').click({position:{x:4,y:4}}); await page.locator('#wholesale-account:popover-open').waitFor({state:'hidden'});
      await openWholesaleAccount(page); await page.locator('#account-dialog[open]').waitFor();
      await page.locator('#account-form [name="contact"]').fill('Draft survives resizing');
      await page.setViewportSize({width:1440,height:900}); await page.waitForFunction(()=>!document.getElementById('wholesale-account').hasAttribute('popover'));
      assert.equal(await page.locator('#account-dialog').isVisible(),true); assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Draft survives resizing');
      await page.setViewportSize({width,height:852}); await page.waitForFunction(()=>document.getElementById('wholesale-account').hasAttribute('popover'));
      assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Draft survives resizing');
      await page.locator('#account-dialog [data-close]').first().click(); await page.locator('#account-dialog').waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement===document.getElementById('account-toggle'));
      await page.locator('#products article button[type="submit"]').first().click(); assert.equal(await page.locator('#basket-count').textContent(),'1');
      await page.locator('.site-header [data-basket]').click(); await page.waitForFunction(()=>scrollY>64); assert.equal((await measure()).height,64);
      await page.locator('#my-orders').click(); await page.locator('#orders-dialog[open]').waitFor(); await page.locator('#orders-dialog [data-close]').first().click();
      await openWholesaleAccountMenu(page);
      if (process.env.HEADER_QA_DIR) { await mkdir(process.env.HEADER_QA_DIR,{recursive:true}); await page.screenshot({path:`${process.env.HEADER_QA_DIR}/header-${width}-${colorScheme}.png`}); }
      await page.locator('#preview-sign-out').click(); await page.waitForURL(/\/wholesale-preview\/signin$/);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  }
});
