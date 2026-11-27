import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright';
import {admin, retail, editorPath, clickBackground, openLocalBrowser, startEditorFixture} from './editor-integration-fixture.mjs';
import {emptyDocument} from '../public/consumer-preview/assets/editor-model.js';

let browser, fixture;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

async function state(path='', method='GET', data) {
  const response = await fixture.request(admin,editorPath+path,method,data,fixture.cookie);
  assert.equal(response.status,200);
  return response.json();
}
async function seed(document) {
  const {revision} = await state();
  const saved = await state('','PUT',{revision,document});
  await state('/publish','POST',{revision:saved.revision});
}
async function editor(viewport, hasTouch=false) {
  const context = await openLocalBrowser(fixture,browser,viewport,true,{hasTouch});
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(admin+'/#consumer/editor');
  const frame = page.frameLocator('iframe[title^="Editable storefront preview"]');
  const hero = frame.locator('#top[data-consumer-editable]');
  await hero.waitFor();
  const panel = page.locator('.ce-direct[role=dialog]');
  return {context,page,hero,panel,scope:page.getByRole('combobox',{name:'Apply layout to'}),frame};
}
const settings = item => item.evaluate(node => {
  const css = node.ownerDocument.defaultView.getComputedStyle.bind(node.ownerDocument.defaultView);
  const photo = node.querySelector('.home-hero-image'), copy = node.querySelector('.home-hero-copy');
  const image = photo.getBoundingClientRect(), text = copy.getBoundingClientRect();
  return {gap:css(node).marginBottom, align:css(copy).textAlign, aspect:css(photo).aspectRatio,
    photoFirst:image.bottom <= text.top+1, columns:css(node).gridTemplateColumns};
});
async function saved(page) {
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Draft saved. You can return to it before publishing.',{exact:true}).waitFor();
}

test('mobile section styles inherit, reset independently and publish without changing the desktop layout', {timeout:90000}, async () => {
  const design = emptyDocument();
  design.pages.home = {sectionStyles:{hero:{align:'end'}}};
  await seed(design);
  const {context,page,hero,panel,scope} = await editor({width:1440,height:960});
  try {
    assert.equal(await scope.inputValue(),'all');
    const desktop = await settings(hero);
    assert.equal(desktop.align,'end');
    await scope.selectOption('mobile');
    const device = page.getByRole('group',{name:'Preview size'});
    assert.equal(await device.getByRole('button',{name:'Mobile'}).getAttribute('aria-pressed'),'true');
    assert.equal(await hero.evaluate(n => n.ownerDocument.documentElement.clientWidth),390);
    await clickBackground(page,hero);
    const select = name => panel.getByRole('combobox',{name,exact:true});
    const align = select('Text alignment');
    assert.equal(await align.inputValue(),'');
    assert.match(await align.locator('option:checked').textContent(),/All sizes.*End/);
    await align.selectOption('center');
    await select('Spacing').selectOption('tight');
    await select('Photo crop').selectOption('square');
    await select('Photo position').selectOption('image-first');
    let mobile = await settings(hero);
    assert.equal(mobile.align,'center');
    assert.equal(mobile.aspect,'1 / 1');
    assert.equal(mobile.photoFirst,true);
    assert.notEqual(mobile.gap,desktop.gap);
    await align.selectOption('');
    assert.equal((await settings(hero)).align,'end');
    await panel.getByRole('button',{name:'Done',exact:true}).click();
    await saved(page);
    const config = (await state()).draft.pages.home;
    assert.deepEqual(config.sectionStyles,{hero:{align:'end'}});
    assert.deepEqual(config.mobile.sectionStyles.hero,{spacing:'tight',crop:'square',stack:'image-first'});

    await device.getByRole('button',{name:'Desktop'}).click();
    assert.equal(await scope.inputValue(),'all');
    assert.deepEqual(await settings(hero),desktop);
    await device.getByRole('button',{name:'Mobile'}).click();
    assert.equal(await scope.inputValue(),'mobile');
    await scope.selectOption('all');
    assert.equal(await device.getByRole('button',{name:'Mobile'}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'Publish',exact:true}).click();
    await page.locator('#sheet').getByRole('button',{name:'Publish storefront',exact:true}).click();
    await page.getByText('Published to the consumer storefront.',{exact:true}).waitFor();
    const shopper = await context.newPage();
    await shopper.setViewportSize({width:1180,height:850});
    await shopper.goto(retail+'/');
    const published = shopper.locator('#top');
    await published.locator('.home-hero-image img').waitFor();
    assert.equal((await settings(published)).align,'end');
    assert.equal((await settings(published)).photoFirst,false);
    await shopper.setViewportSize({width:390,height:844});
    mobile = await settings(published);
    assert.equal(mobile.align,'end');
    assert.equal(mobile.aspect,'1 / 1');
    assert.equal(mobile.photoFirst,true);
  } finally {await context.close();}
});

test('a touch editor opens mobile settings in context and can discard an independent mobile change', {timeout:60000}, async () => {
  await seed(emptyDocument());
  const {context,page,hero,panel,scope} = await editor({width:393,height:852},true);
  try {
    assert.equal(await scope.inputValue(),'mobile');
    await clickBackground(page,hero,{touch:true});
    await panel.getByRole('combobox',{name:'Photo position'}).selectOption('image-first');
    await panel.getByRole('combobox',{name:'Spacing'}).selectOption('tight');
    await panel.getByRole('combobox',{name:'Photo crop'}).selectOption('landscape');
    assert.match(await panel.locator('.ce-direct-heading').textContent(),/Mobile only/);
    const panelBox = await panel.locator('.ce-direct-panel').boundingBox();
    assert.ok(panelBox.x >= 0 && panelBox.x+panelBox.width <= 394);
    assert.ok(panelBox.y >= 0 && panelBox.y+panelBox.height <= 853);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
    if (process.env.CONSUMER_SCREENSHOT_DIR) {
      await hero.evaluate(node => {
        const win = node.ownerDocument.defaultView;
        win.scrollTo({top:node.getBoundingClientRect().top + win.scrollY - 4,behavior:'instant'});
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await mkdir(process.env.CONSUMER_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR+'/mobile-layout-settings.png',animations:'disabled'});
    }
    await panel.getByRole('button',{name:'Cancel',exact:true}).tap();
    assert.equal(await page.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),true);
  } finally {await context.close();}
});

test('a single coffee can override and restore an inherited widget arrangement without copying its template', {timeout:90000}, async () => {
  const id = 'w-roast-note', widget = {id,type:'cards',heading:'Roasting notes',body:'Meet the roaster.',
    image:'asset:roastery.webp',alt:'The roaster',layout:'stack'};
  const design = emptyDocument();
  design.pages.product = {widgets:[widget],sectionStyles:{[id]:{stack:'text-first'}}};
  await seed(design);
  const {context,page,frame,panel} = await editor({width:1440,height:960});
  try {
    const pages = page.getByRole('combobox',{name:'Storefront page or surface'});
    const slug = 'product:bom-jesus';
    const tile = frame.locator('[data-consumer-widget="' + id + '"]');
    const arrangement = panel.getByRole('combobox',{name:'Widget arrangement',exact:true});
    const cols = node => getComputedStyle(node).gridTemplateColumns.split(' ').length;
    await pages.selectOption(slug);
    await tile.waitFor();
    await clickBackground(page,tile);
    assert.equal(await arrangement.inputValue(),'');
    await arrangement.selectOption('split');
    assert.equal(await tile.evaluate(cols),2);
    await panel.getByRole('button',{name:'Done',exact:true}).click();
    await saved(page);
    let doc = (await state()).draft;
    assert.deepEqual(doc.pages.product,design.pages.product);
    assert.deepEqual(doc.pages[slug],{sectionStyles:{[id]:{arrangement:'split'}}});
    await pages.selectOption('product:rocko');
    await tile.waitFor();
    assert.equal(await tile.evaluate(cols),1);
    await pages.selectOption(slug);
    await tile.waitFor();
    await clickBackground(page,tile);
    await arrangement.selectOption('');
    assert.equal(await tile.evaluate(cols),1);
    await panel.getByRole('button',{name:'Done',exact:true}).click();
    await saved(page);
    doc = (await state()).draft;
    assert.equal(doc.pages[slug],undefined);
    assert.deepEqual(doc.pages.product,design.pages.product);
  } finally {await context.close();}
});
