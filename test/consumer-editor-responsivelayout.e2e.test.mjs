import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright';
import {admin, retail, editorPath, startEditorFixture, openLocalBrowser, clickBackground} from './editor-integration-fixture.mjs';

let fixture, browser;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

async function documentRequest(method = 'GET', path = '', body) {
  const response = await fixture.request(admin,editorPath + path,method,body,fixture.cookie);
  assert.equal(response.status,200,method+' '+path);
  return response.json();
}

async function editor(viewport, touch = false) {
  const context = await openLocalBrowser(fixture,browser,viewport,true,{hasTouch:touch});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(admin + '/#consumer/editor');
  const canvas = page.frameLocator('iframe[title^="Editable storefront preview"]');
  await canvas.locator('#hero-title[data-consumer-editable]').waitFor();
  return {context, page, canvas, controls:page.locator('.ce-direct[role="dialog"]')};
}

const first = 'w-cupping', second = 'w-origin';
const natives = ['hero','featured','visit','social'];

function widget(frame,id) {
  return frame.locator('[data-consumer-widget="'+id+'"]');
}

async function order(root) {
  return root.locator('main > [data-consumer-layout-id]').evaluateAll(nodes => nodes.map(node => node.dataset.consumerLayoutId));
}

async function waitForOrder(root,expected) {
  // The shopper reorders existing DOM nodes in response to the media query.
  // Waiting on DOM order also catches an implementation that only reorders CSS.
  const selector = expected.map(id => '[data-consumer-layout-id="'+id+'"]').join(' ~ ');
  await root.locator('main > '+selector).waitFor({state:'attached'});
  assert.deepEqual(await order(root),expected);
}

async function save(page) {
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved. You can return to it before publishing.',{exact:true}).waitFor();
}

test('section insertion, duplication, dragging and a mobile-only order survive draft and publish', {timeout:120000}, async () => {
  const current = await documentRequest();
  const seeded = structuredClone(current.draft);
  seeded.pages.home = {
    sections:[first,second,...natives],
    widgets:[
      {id:first,type:'callout',heading:'Saturday cupping',body:'Join us at the roastery.'},
      {id:second,type:'callout',heading:'Meet the producer',body:'Coffee from Alta Mogiana.'},
    ],
  };
  const saved = await documentRequest('PUT','',{revision:current.revision,document:seeded});
  await documentRequest('POST','/publish',{revision:saved.revision});

  const desktop = await editor({width:1440,height:960});
  let mobile, shopper;
  try {
    const {page,canvas,controls} = desktop;
    await waitForOrder(canvas,[first,second,...natives]);
    await clickBackground(page,canvas.locator('#top'));
    await controls.getByRole('button',{name:'Add here',exact:true}).click();
    await controls.getByRole('combobox',{name:'Insert after section',exact:true}).selectOption('widget:callout');
    await controls.getByRole('button',{name:'Insert',exact:true}).click();
    const added = canvas.locator('.consumer-widget').filter({has:canvas.getByRole('heading',{name:'Call to action',exact:true})});
    await added.first().waitFor();
    const newId = await added.first().getAttribute('data-consumer-widget');
    assert.ok(newId && ![first,second].includes(newId));
    const sharedTail = ['hero',newId,'featured','visit','social'];
    await waitForOrder(canvas,[first,second,...sharedTail]);

    await clickBackground(page,added.first());
    await controls.getByRole('button',{name:'Duplicate widget',exact:true}).click();
    await added.nth(1).waitFor();
    const copyId = await added.nth(1).getAttribute('data-consumer-widget');
    assert.notEqual(copyId,newId);
    await waitForOrder(canvas,[first,second,'hero',newId,copyId,'featured','visit','social']);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await waitForOrder(canvas,[first,second,...sharedTail]);
    assert.equal(await widget(canvas,copyId).count(),0);

    const source = widget(canvas,second), target = widget(canvas,first);
    await clickBackground(page,source);
    const handle = controls.getByRole('button',{name:'Drag to move',exact:true});
    const handleBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    assert.ok(handleBox && targetBox);
    await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x+targetBox.width/2,targetBox.y+targetBox.height*.35,{steps:12});
    await page.locator('[data-layout-drop-marker]').waitFor();
    await page.mouse.up();
    const desktopOrder = [second,first,...sharedTail];
    await waitForOrder(canvas,desktopOrder);
    if (process.env.CONSUMER_SCREENSHOT_DIR) {
      await clickBackground(page,widget(canvas,second));
      await page.evaluate(() => scrollTo({top:0,behavior:'instant'}));
      await controls.getByRole('button',{name:'Drag to move'}).waitFor();
      await mkdir(process.env.CONSUMER_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR+'/desktop-section-tools.png',animations:'disabled'});
    }
    await save(page);

    mobile = await editor({width:393,height:852},true);
    assert.equal(await mobile.page.getByRole('combobox',{name:'Apply layout to'}).inputValue(),'mobile');
    await waitForOrder(mobile.canvas,desktopOrder);
    await clickBackground(mobile.page,widget(mobile.canvas,first),{touch:true});
    await mobile.controls.getByRole('button',{name:'Move up',exact:true}).tap();
    const mobileOrder = [first,second,...sharedTail];
    await waitForOrder(mobile.canvas,mobileOrder);
    await mobile.controls.getByRole('button',{name:'Use inherited order',exact:true}).tap();
    await waitForOrder(mobile.canvas,desktopOrder);
    await mobile.page.getByRole('button',{name:'Undo',exact:true}).tap();
    await waitForOrder(mobile.canvas,mobileOrder);
    await save(mobile.page);
    const doc = (await documentRequest()).draft.pages.home;
    assert.deepEqual(doc.sections,desktopOrder);
    assert.deepEqual(doc.mobile.sections,mobileOrder);

    shopper = await openLocalBrowser(fixture,browser,{width:393,height:852},false,{hasTouch:true});
    const shop = await shopper.newPage();
    await shop.goto(retail);
    await waitForOrder(shop,[first,second,...natives]);

    await mobile.page.getByRole('button',{name:'Publish',exact:true}).tap();
    await mobile.page.locator('#sheet').getByRole('button',{name:'Publish storefront',exact:true}).tap();
    await mobile.page.getByText('Published to the consumer storefront.',{exact:true}).waitFor();
    await shop.reload();
    await waitForOrder(shop,mobileOrder);
    const nativeHero = await shop.locator('#top').elementHandle();
    const liveCard = await widget(shop,first).elementHandle();
    await shop.setViewportSize({width:1280,height:900});
    await waitForOrder(shop,desktopOrder);
    await shop.setViewportSize({width:375,height:812});
    await waitForOrder(shop,mobileOrder);
    assert.ok(await nativeHero.evaluate(node => node === document.querySelector('#top')));
    assert.ok(await liveCard.evaluate(node => node.isConnected));
    await shop.locator('#top [data-find]').click();
    await shop.locator('#finder-form').waitFor();

    await page.getByRole('combobox',{name:'Storefront page or surface'}).selectOption('checkout');
    const protectedForm = canvas.locator('#retail-checkout');
    await protectedForm.locator('#retail-checkout-form').waitFor();
    await clickBackground(page,protectedForm);
    assert.equal(await controls.getByRole('group',{name:'Arrange section'}).count(),0);
    assert.equal(await protectedForm.locator('form').count(),1);
  } finally {
    await Promise.allSettled([desktop.context.close(),mobile?.context.close(),shopper?.close()]);
  }
});

test('arranging a template widget on one product leaves its template and sibling products intact', {timeout:90000}, async () => {
  const current = await documentRequest();
  const template = {widgets:[
    {id:'w-template-a',type:'text',heading:'Roastery notes'},
    {id:'w-template-b',type:'hero',heading:'Meet the producer',image:'asset:roastery.webp',layout:'split'},
  ]};
  const sibling = {fields:{'product-title':'Our Rocko coffee'}};
  const seeded = {...current.draft,pages:{product:template,'product:rocko':sibling}};
  await documentRequest('PUT','',{revision:current.revision,document:seeded});

  const {context,page,canvas,controls} = await editor({width:393,height:852},true);
  try {
    const pages = page.getByRole('combobox',{name:'Storefront page or surface'});
    const saveButton = page.getByRole('button',{name:'Save draft',exact:true});
    await pages.selectOption('product:bom-jesus');
    const inherited = widget(canvas,'w-template-b');
    await inherited.waitFor();
    const before = await order(canvas);
    await clickBackground(page,inherited,{touch:true});
    await controls.getByRole('button',{name:'Done',exact:true}).tap();
    assert.equal(await saveButton.isDisabled(),true,'selecting the inherited widget is read-only');

    await clickBackground(page,inherited,{touch:true});
    await controls.getByRole('combobox',{name:'Spacing',exact:true}).selectOption('tight');
    await controls.getByRole('button',{name:'Move up',exact:true}).tap();
    const moved = [...before];
    const at = moved.indexOf('w-template-b');
    assert.ok(at > 0 && moved[at-1] === 'w-template-a');
    [moved[at-1], moved[at]] = [moved[at],moved[at-1]];
    await waitForOrder(canvas,moved);
    await controls.getByRole('button',{name:'Duplicate widget',exact:true}).tap();
    await controls.getByRole('button',{name:'Add here',exact:true}).tap();
    await controls.getByRole('combobox',{name:'Insert after section'}).selectOption('widget:text');
    await controls.getByRole('button',{name:'Insert',exact:true}).tap();
    await controls.getByRole('button',{name:'Done',exact:true}).tap();
    await save(page);

    const stored = (await documentRequest()).draft.pages;
    assert.deepEqual(stored.product,template);
    assert.deepEqual(stored['product:rocko'],sibling);
    const local = stored['product:bom-jesus'];
    assert.deepEqual(local.mobile.sectionStyles['w-template-b'],{spacing:'tight'});
    assert.equal(local.widgets.length,2);
    assert.ok(local.widgets.every(w => !template.widgets.some(t => t.id === w.id)));
    assert.deepEqual(local.mobile.sections.filter(id => id.startsWith('w-')),
      ['w-template-b',local.widgets[0].id,local.widgets[1].id,'w-template-a']);
    await pages.selectOption('product:rocko');
    await widget(canvas,'w-template-b').waitFor();
    assert.deepEqual((await order(canvas)).filter(id => id.startsWith('w-')),['w-template-a','w-template-b']);
  } finally { await context.close(); }
});
