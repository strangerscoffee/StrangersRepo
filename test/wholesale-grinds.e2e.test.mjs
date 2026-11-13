import { openWholesaleBasket } from './wholesale-ui-helpers.mjs';
// Customer sorting retains configured coffee and refresh controls recover after failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { startServer, SETUP_CODE } from './harness.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
let srv, browser, cookie, adminCookie;
async function api(path, body, auth = cookie) {
  const r = await fetch(srv.base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json(); assert.ok(r.ok, path + ': ' + JSON.stringify(data));
  return { data, cookie: (r.headers.getSetCookie().find(v => /^sf(?:bb|_wholesale)_session=[\w-]/.test(v)) || '').split(';')[0] };
}
before(async () => {
  srv = await startServer({ writeLimit: 3000 });
  cookie = (await api('/api/auth/setup', { name: 'UI Owner', username: 'uiowner', password: 'ui-owner-password', code: SETUP_CODE })).cookie;
  adminCookie = cookie;
  const customer = (await api('/api/admin/wholesale/customers', { business: 'UI Coffee', contact: 'Buyer', email: 'buyer@example.test', address: '10 Coffee Street', postcode: 'NR1 1AA', status: 'Active' })).data.customer;
  const account = (await api(`/api/admin/wholesale/customers/${customer.id}/account`, { username: 'uicoffee' })).data;
  cookie = (await api('/api/wholesale/auth/change-password', { username: 'uicoffee', password: account.temporaryPassword, newPassword: 'ui-buyer-password' }, null)).cookie;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await srv?.stop(); });
for (const [device, viewport] of [['phone',{width:393,height:852}],['ipad',{width:820,height:1180}],['desktop',{width:1440,height:1000}]]) for (const colorScheme of ['light','dark']) {
  test(`grind management ${device} ${colorScheme}: admin edits choices, buyer selects custom and unavailable baskets survive`, {timeout:120000}, async () => {
    const adminContext=await browser.newContext({viewport,colorScheme}), buyerContext=await browser.newContext({viewport,colorScheme});
    for (const [context,auth] of [[adminContext,adminCookie],[buyerContext,cookie]]) {const [name,value]=auth.split('='); await context.addCookies([{name,value,url:srv.base}]);}
    try {
      const product=(await api('/api/admin/wholesale/catalogue',{title:`Grinds ${device} ${colorScheme}`,name:`Grinds ${device} ${colorScheme}`,categories:['blend'],prices:{quarter:1000,half:2000,kilo:3700},active:true},adminCookie)).data.product;
      const admin=await adminContext.newPage(), buyer=await buyerContext.newPage(), errors=[];
      for (const page of [admin,buyer]) page.on('pageerror',e=>errors.push(e.message));
      await admin.goto(srv.base+'/admin#wholesale'); await admin.locator('[data-act="wh-tab"][data-id="catalogue"]').click();
      async function edit() {await admin.locator(`[data-act="wh-coffee"][data-id="${product.id}"]`).click(); await admin.locator('#wCoffeeForm').waitFor();}
      async function save() {await admin.locator('#wCoffeeForm button[type="submit"]').click(); await admin.locator('#scrim').waitFor({state:'hidden'});}
      await edit();
      await admin.locator('[data-grind-id="beans"] [data-grind-label]').fill('Whole beans');
      await admin.locator('[data-grind-id="espresso"] [data-grind-enabled]').uncheck();
      await admin.locator('[data-grind-id="filter"] [data-sheet="grind-remove"]').click();
      await admin.locator('[data-sheet="grind-add"]').click();
      const added=admin.locator('#wGrindOptions [data-grind-id]').last(), customId=await added.getAttribute('data-grind-id');
      await added.locator('[data-grind-label]').fill('Turkish / Extra fine');
      if (process.env.WHOLESALE_SCREENSHOT_DIR) {await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR,{recursive:true}); await admin.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/grinds-${device}-${colorScheme}-admin.png`});}
      await save();
      await buyer.goto(srv.base+'/wholesale-preview/');
      const card=buyer.locator(`article[data-product="${product.id}"]`);
      await card.locator('[data-grind-open]').click();
      assert.deepEqual(await buyer.locator('#coffee-choice-menu button strong').allTextContents(),['Whole beans','Coarse','Turkish / Extra fine']);
      await buyer.locator(`#coffee-choice-menu [data-choice="${customId}"]`).click();
      await card.locator('button[type="submit"]').click();
      assert.match(await buyer.locator('#order-items').textContent(),/Turkish \/ Extra fine/);
      await edit(); await admin.locator(`[data-grind-id="${customId}"] [data-grind-enabled]`).uncheck(); await save();
      await openWholesaleBasket(buyer); await buyer.locator('#review-order').click();
      await buyer.locator('#order-items').getByText(/Unavailable — remove to continue/).waitFor();
      await buyer.locator('#review-order:disabled').waitFor();
      assert.match(await buyer.locator('#order-items').textContent(),/Unavailable/);
      assert.equal(await buyer.locator('#review-dialog').isVisible(),false);
      assert.equal(await buyer.locator('#order-items .order-item').count(),1,'unavailable custom selection remains for review/removal');
      await edit(); await admin.locator(`[data-grind-id="${customId}"] [data-grind-enabled]`).check(); await save();
      await buyer.reload(); await buyer.locator('#products[aria-busy="false"]').waitFor(); await openWholesaleBasket(buyer); await buyer.locator('#review-order:not(:disabled)').waitFor(); await buyer.locator('#basket-dialog [data-close]').click();
      await card.locator('[data-grind-open]').click();
      if(process.env.WHOLESALE_SCREENSHOT_DIR) await buyer.screenshot({path:`${process.env.WHOLESALE_SCREENSHOT_DIR}/grinds-${device}-${colorScheme}-customer.png`});
      assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      assert.equal(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true); assert.deepEqual(errors,[]);
    } finally {await adminContext.close(); await buyerContext.close();}
  });
}
