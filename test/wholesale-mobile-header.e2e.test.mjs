import { fillWholesaleSearch, openWholesaleOrders, openWholesaleAccount, openWholesaleAccountMenu } from './wholesale-ui-helpers.mjs';
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {startServer, SETUP_CODE} from './harness.mjs';
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
  for (const width of [320,393,430]) {
    const cookie = cookieOf((await api('POST','/api/wholesale/auth/login',{username,password},null)).response);
    const context = await browser.newContext({viewport:{width,height:852}, colorScheme});
    const [name,value] = cookie.split('='); await context.addCookies([{name,value,url:srv.base}]);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(srv.base+'/wholesale/'); await page.locator('#products article').first().waitFor();
      const measure = () => page.locator('.site-header').evaluate(node => ({box:node.getBoundingClientRect().toJSON(), height:node.getBoundingClientRect().height, mainTop:document.querySelector('main').getBoundingClientRect().top+scrollY, overflow:document.documentElement.scrollWidth-innerWidth, targets:[...node.querySelectorAll('a,button')].map(n=>n.getBoundingClientRect()).filter(b=>b.width&&b.height).map(b=>b.toJSON())}));
      const before = await measure(); assert.equal(before.height,64, 'header stays in one compact row'); assert.equal(before.overflow,0); assert.equal(before.targets.length,3); assert.ok(before.targets.every(target=>target.width>=44&&target.height>=44));
      assert.ok(before.targets.every(target=>target.top>=before.box.top&&target.bottom<=before.box.bottom&&target.left>=before.box.left&&target.right<=before.box.right), 'brand, cart and account stay inside the header');
      assert.ok(before.targets.slice(1).every((target,index)=>target.left>=before.targets[index].right), 'header controls do not overlap');
      assert.equal(await page.locator('.orders-shortcut').isVisible(),false, 'mobile orders remain in the account menu');
      assert.equal(await page.locator('.brand-name').innerText(),'Strangers Wholesale');
      assert.equal(await page.locator('.brand-name').isVisible(),true, 'the full brand stays visible even on small phones');
      assert.equal(await page.locator('.bag-size-label').isVisible(),false);
      const toolbar = await page.locator('.catalogue').evaluate(node => {
        const box = selector => node.querySelector(selector).getBoundingClientRect().toJSON();
        return {heading:box('.section-heading'), search:box('.search-field'), categories:box('.coffee-categories'), firstCard:box('.product-card'), size:box('.bag-size'), sort:box('#sort-coffee'), targets:[...node.querySelectorAll('[data-bag-size], [data-filter], #sort-coffee')].map(n=>n.getBoundingClientRect().toJSON())};
      });
      assert.ok(toolbar.heading.bottom <= toolbar.search.top && toolbar.search.bottom <= toolbar.categories.top && toolbar.categories.bottom < toolbar.firstCard.top, 'three compact rows above the first coffee');
      assert.ok(toolbar.heading.top>=before.box.bottom+12, 'catalogue heading and controls clear the header');
      assert.ok(toolbar.firstCard.top < 360, 'products start near the top of the phone');
      assert.ok(toolbar.size.y >= toolbar.heading.y && toolbar.size.bottom <= toolbar.heading.bottom && toolbar.sort.right <= width-12, 'size and sort stay in the heading row');
      assert.ok(toolbar.targets.every(target=>target.width>=44&&target.height>=44), 'catalogue controls retain touch targets');
      await page.locator('[data-bag-size="quarter"]').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.bagSize),'kilo');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.id),'sort-coffee');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.id),'coffee-search');
      await fillWholesaleSearch(page, 'Brazil');
      await page.setViewportSize({width:1440,height:900});
      await page.locator('.catalogue-actions > .bag-size').waitFor();
      assert.equal(await page.locator('.brand-name').innerText(),'Strangers Wholesale');
      assert.equal(await page.locator('.orders-shortcut').isVisible(),false, 'desktop orders stay in the account menu too');
      assert.equal(await page.locator('#coffee-search').inputValue(),'Brazil');
      assert.equal(await page.locator('.catalogue-actions > .bag-size').count(),1, 'desktop restores the original toolbar');
      await page.setViewportSize({width,height:852});
      await page.waitForFunction(()=>document.getElementById('wholesale-account').hasAttribute('popover') && !!document.querySelector('.mobile-catalogue-actions > .bag-size'));
      assert.equal(await page.evaluate(()=>document.activeElement.id),'coffee-search', 'focused search survives the breakpoint');
      assert.equal(await page.locator('#coffee-search').inputValue(),'Brazil');
      await fillWholesaleSearch(page, '');
      await page.locator('#signed-in-name').waitFor({state:'hidden'});
      assert.equal(await page.locator('#signed-in-name').isVisible(),false);
      await openWholesaleAccountMenu(page);
      assert.equal(await page.locator('#signed-in-name').innerText(),business);
      const afterOpen = await measure(); assert.equal(afterOpen.height,before.height); assert.equal(afterOpen.mainTop,before.mainTop); assert.equal(afterOpen.overflow,0);
      const bounds = await page.locator('#wholesale-account').boundingBox(); assert.ok(bounds.x>=12&&bounds.x+bounds.width<=width-12);
      await page.keyboard.press('Escape'); await page.locator('#wholesale-account:popover-open').waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement===document.getElementById('account-toggle'));
      await openWholesaleAccountMenu(page); await page.mouse.click(4,400); await page.locator('#wholesale-account:popover-open').waitFor({state:'hidden'});
      await openWholesaleAccount(page); await page.locator('#account-dialog[open]').waitFor();
      await page.locator('#account-form [name="contact"]').fill('Draft survives resizing');
      await page.setViewportSize({width:1440,height:900}); await page.waitForFunction(()=>innerWidth===1440);
      assert.equal(await page.locator('#account-dialog').isVisible(),true); assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Draft survives resizing');
      await page.setViewportSize({width,height:852}); await page.waitForFunction(()=>innerWidth<=700);
      assert.equal(await page.locator('#account-form [name="contact"]').inputValue(),'Draft survives resizing');
      await page.locator('#account-dialog [data-close]').first().click(); await page.locator('#account-dialog').waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement===document.getElementById('account-toggle'));
      await page.locator('#products article button[type="submit"]').first().click(); assert.equal(await page.locator('#basket-count').textContent(),'1');
      await page.locator('.site-header [data-basket]').click(); await page.locator('#basket-dialog[open]').waitFor(); assert.equal((await measure()).height,before.height);
      await openWholesaleOrders(page); await page.locator('#orders-dialog[open]').waitFor(); await page.locator('#orders-dialog [data-close]').first().click();
      await openWholesaleAccountMenu(page);
      if (process.env.HEADER_QA_DIR) { await mkdir(process.env.HEADER_QA_DIR,{recursive:true}); await page.screenshot({path:`${process.env.HEADER_QA_DIR}/header-${width}-${colorScheme}.png`}); }
      await page.locator('#preview-sign-out').click(); await page.waitForURL(/\/wholesale\/signin$/);
      assert.deepEqual(errors,[]);
    } finally { await context.close(); }
  }
});
