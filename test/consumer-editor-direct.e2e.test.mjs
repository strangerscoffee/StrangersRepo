import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {before, after, test} from 'node:test';
import {chromium} from 'playwright';
import {admin, retail, editorPath, clickBackground, openLocalBrowser, startEditorFixture} from './editor-integration-fixture.mjs';
import {emptyDocument} from '../public/consumer-preview/assets/editor-model.js';

let fixture, browser;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

async function adminRequest(path = '', method = 'GET', body) {
  const response = await fixture.request(admin, editorPath + path, method, body, fixture.cookie);
  assert.equal(response.status, 200, method + ' ' + path);
  return response.json();
}

async function setLiveDesign(document) {
  const state = await adminRequest();
  const saved = await adminRequest('', 'PUT', {revision:state.revision, document});
  return adminRequest('/publish', 'POST', {revision:saved.revision});
}

async function openEditor(viewport, touch = false) {
  const context = await openLocalBrowser(fixture, browser, viewport, true, {hasTouch:touch});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(admin + '/#consumer/editor');
  const canvas = page.frameLocator('iframe[title^="Editable storefront preview"]');
  await canvas.locator('#hero-title[data-consumer-editable]').waitFor();
  return {context, page, canvas, panel:page.locator('.ce-direct[role=dialog]')};
}

async function save(page) {
  await page.getByRole('button', {name:'Save draft', exact:true}).click();
  await page.getByText('Draft saved. You can return to it before publishing.', {exact:true}).waitFor();
}

async function publish(page) {
  await page.getByRole('button', {name:'Publish', exact:true}).click();
  await page.locator('#sheet').getByRole('button', {name:'Publish storefront', exact:true}).click();
  await page.getByText('Published to the consumer storefront.', {exact:true}).waitFor();
}

async function screenshot(page, name) {
  if (!process.env.CONSUMER_SCREENSHOT_DIR) return;
  await mkdir(process.env.CONSUMER_SCREENSHOT_DIR, {recursive:true});
  await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR + '/direct-edit-' + name + '.png', animations:'disabled'});
}

const fieldValue = field => field.evaluate(control => control.value ?? control.textContent);

test('clicking the storefront text, nested controls and photo opens the matching editor and respects publication', {timeout:90000}, async () => {
  await setLiveDesign(emptyDocument());
  const {context,page,canvas,panel} = await openEditor({width:1440,height:960});
  try {
    const title = canvas.locator('#hero-title');
    const original = await title.textContent();
    const directText = panel.locator('[data-direct-kind=text]');
    const shop = canvas.locator('.home-hero-shop');
    const emphasis = title.locator('em');
    await emphasis.scrollIntoViewIfNeeded();
    const click = await emphasis.evaluate(element => {
      const doc = element.ownerDocument;
      const range = doc.createRange();
      const text = element.firstChild, start = text.data.indexOf('Norwich');
      range.setStart(text,start);
      range.setEnd(text,start+1);
      const letter = range.getBoundingClientRect();
      const frame = doc.defaultView.frameElement, frameBox = frame.getBoundingClientRect();
      return {x:frameBox.left + (letter.left+letter.width/4)*frameBox.width/frame.offsetWidth,
        y:frameBox.top + (letter.top+letter.height/2)*frameBox.height/frame.offsetHeight};
    });
    await page.mouse.click(click.x,click.y);
    await directText.waitFor();
    assert.equal(await fieldValue(directText), original);
    const caret = await directText.evaluate(input => {
      if ('selectionStart' in input) return [input.selectionStart,input.selectionEnd];
      const selected = input.ownerDocument.getSelection().getRangeAt(0);
      const prefix = selected.cloneRange();
      prefix.selectNodeContents(input);
      prefix.setEnd(selected.startContainer,selected.startOffset);
      return [prefix.toString().length,prefix.toString().length + selected.toString().length];
    });
    assert.equal(caret[0],caret[1]);
    assert.ok(Math.abs(caret[0] - original.indexOf('Norwich')) <= 1,'the caret starts at the letter that was clicked');
    assert.equal(await directText.locator('em').textContent(), 'roasted in Norwich.');
    const clicked = await title.boundingBox();
    const input = await directText.boundingBox();
    assert.ok(input.x < clicked.x + clicked.width && input.x + input.width > clicked.x &&
      input.y < clicked.y + clicked.height && input.y + input.height > clicked.y, 'text can be edited on its canvas element');
    await title.evaluate(node => node.ownerDocument.defaultView.scrollBy(0, 20));
    const scrolled = await title.boundingBox();
    await page.waitForFunction(({before,delta}) => {
      const field = document.querySelector('.ce-direct [data-direct-kind=text]');
      return field && Math.abs(field.getBoundingClientRect().top - before - delta) < 3;
    }, {before:input.y,delta:scrolled.y-clicked.y});

    await directText.fill('A cancelled headline');
    await directText.press('Escape');
    await panel.waitFor({state:'hidden'});
    assert.equal(await title.textContent(), original);
    await title.click();
    const heading = 'Seasonal coffee roasted in Norwich.';
    await directText.fill(heading);
    assert.equal(await directText.locator('em').textContent(),'roasted in Norwich.');
    await screenshot(page,'desktop-title');
    await panel.locator('[data-direct-action=done]').click();
    await title.filter({hasText:heading}).waitFor();
    assert.equal(await title.locator('em').textContent(),'roasted in Norwich.');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await title.locator('em').waitFor();
    assert.equal(await title.textContent(), original);
    await page.getByRole('button',{name:'Redo',exact:true}).click();
    await title.filter({hasText:heading}).waitFor();

    await shop.click();
    await directText.fill('Explore the roastery');
    const destination = panel.locator('[data-direct-kind=link]');
    await destination.fill('/about/');
    await screenshot(page,'desktop-button');
    await panel.locator('[data-direct-action=done]').click();
    assert.equal(await shop.getAttribute('href'), '/about/');
    assert.equal(await shop.textContent(),'Explore the roastery');
    assert.equal(await canvas.locator('main #hero-title').count(), 1);

    // The cart control contains a count and an icon as well as its text.
    // Clicking the nested label must preserve the action and its counter.
    const cart = canvas.locator('[data-bag]');
    await cart.locator('.bag-label').click();
    await directText.fill('Basket');
    assert.equal(await panel.locator('[data-direct-kind=link]').count(), 0);
    await panel.locator('[data-direct-action=done]').click();
    await cart.locator('.bag-label').filter({hasText:'Basket'}).waitFor();
    assert.equal(await cart.locator('#bag-count').count(),1);
    assert.equal(await cart.locator('svg').count(),1);

    const photo = canvas.locator('.home-hero-image img');
    await photo.click();
    await panel.locator('[data-direct-action=replace]').click();
    await panel.locator('[data-direct-photo="asset:roastery.webp"]').click();
    await panel.locator('[data-direct-kind=alt]').fill('The roaster at Dove Street');
    await panel.locator('[data-direct-action=done]').click();
    assert.equal(await photo.getAttribute('alt'), 'The roaster at Dove Street');
    assert.match(await photo.getAttribute('src'), /\/assets\/roastery\.webp$/);

    const shopper = await context.newPage();
    await save(page);
    await shopper.goto(retail);
    assert.equal(await shopper.locator('#hero-title').textContent(), original);
    await publish(page);
    await shopper.reload();
    const liveHeading = shopper.getByRole('heading', {name:heading,exact:true});
    await liveHeading.waitFor();
    assert.equal(await liveHeading.locator('em').textContent(),'roasted in Norwich.');
    assert.equal(await shopper.locator('.home-hero-shop').getAttribute('href'), '/about/');
    assert.equal(await shopper.locator('.home-hero-shop').textContent(), 'Explore the roastery');
    assert.equal(await shopper.locator('.home-hero-image img').getAttribute('alt'), 'The roaster at Dove Street');
    await shopper.locator('[data-bag]').click();
    await shopper.locator('#dialog[open]').waitFor();
    assert.equal(await shopper.locator('.ce-direct, [data-consumer-editable]').count(),0);
  } finally { await context.close(); }
});

test('a phone tap edits the custom page title and exact widget part within the visible canvas', {timeout:90000}, async () => {
  const design = emptyDocument();
  const path = '/pages/roastery-weekends/';
  const widget = {id:'w-weekend',type:'cards',heading:'Saturday at Dove Street',body:'Drop in for a freshly roasted coffee.',
    image:'asset:roastery.webp',alt:'Coffee roastery',label:'Plan a visit',href:'/location/'};
  design.pages['custom:roastery-weekends'] = {title:'Open roastery',inNavigation:true,sections:[widget.id],widgets:[widget]};
  await setLiveDesign(design);
  const {context,page,canvas,panel} = await openEditor({width:393,height:852},true);
  try {
    const choices = page.getByRole('combobox', {name:'Storefront page or surface'});
    await choices.selectOption('custom:roastery-weekends');
    const title = canvas.getByRole('heading',{name:'Open roastery',exact:true});
    await title.scrollIntoViewIfNeeded();
    const start = await page.evaluate(() => window.scrollY);
    await title.tap();
    const text = panel.locator('[data-direct-kind=text]');
    await text.waitFor();
    assert.equal(await fieldValue(text),'Open roastery');
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - start) < 100, 'tapping a title keeps the preview in view');
    const renamed = 'Visit the roastery';
    await text.fill(renamed);
    await panel.locator('[data-direct-action=done]').tap();
    await canvas.getByRole('heading',{name:renamed,exact:true}).waitFor();
    assert.equal(await choices.inputValue(),'custom:roastery-weekends');

    const card = canvas.locator('[data-consumer-widget="w-weekend"]');
    await page.getByRole('combobox',{name:'Apply layout to'}).selectOption('all');
    await clickBackground(page,card,{touch:true});
    const arrangement = panel.getByRole('combobox',{name:'Widget arrangement',exact:true});
    await arrangement.selectOption('text-first');
    assert.equal(await card.locator(':scope > img').evaluate(photo => getComputedStyle(photo).order),'1');
    await arrangement.selectOption('reverse');
    assert.equal(await card.getAttribute('data-widget-layout'),'reverse');
    assert.equal(await card.locator(':scope > img').evaluate(photo => getComputedStyle(photo).order),'0');
    await panel.locator('[data-direct-action=cancel]').tap();
    assert.equal(await card.getAttribute('data-widget-layout'),'stack');
    await card.locator('h2').tap();
    assert.equal(await fieldValue(text),widget.heading);
    await text.fill('Coffee on ');
    await text.pressSequentially('Saturdays');
    await panel.locator('[data-direct-action=done]').tap();
    await card.locator('p').tap();
    assert.equal(await fieldValue(text),widget.body);
    await text.fill('Join us for a filter coffee on Saturdays.');
    await panel.locator('[data-direct-action=done]').tap();

    const photo = card.locator('img');
    await photo.tap();
    await panel.locator('[data-direct-action=replace]').tap();
    const samples = panel.locator('[data-direct-photo]');
    await samples.first().waitFor();
    assert.ok(await samples.evaluateAll(items => items.slice(0, 6).every(button => {
      const bottom = button.getBoundingClientRect().bottom;
      return [...button.children].every(child => child.getBoundingClientRect().bottom <= bottom);
    })), 'each photo and its caption fit inside their own tappable tile');
    const searchPhotos = panel.getByRole('searchbox', {name:'Search photos'});
    await searchPhotos.fill('brew');
    await panel.locator('[data-direct-photo] img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await screenshot(page,'mobile-photo-library');
    await searchPhotos.fill('pottergate');
    await panel.locator('[data-direct-photo="asset:pottergate.webp"]').tap();
    const alt = panel.locator('[data-direct-kind=alt]');
    await alt.fill('Our Pottergate café');
    await screenshot(page,'mobile-photo');
    const box = await panel.locator('.ce-direct-panel').boundingBox();
    assert.ok(box.width > 120 && box.x >= -1 && box.x + box.width <= 394 && box.y >= -1 && box.y + box.height <= 853,
      'photo editor remains within the phone viewport');
    await panel.locator('[data-direct-action=done]').tap();
    assert.equal(await photo.getAttribute('alt'),'Our Pottergate café');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    const link = card.locator('a.button');
    await link.tap();
    assert.equal(await fieldValue(text),widget.label);
    const dest = panel.locator('[data-direct-kind=link]');
    assert.equal(await dest.inputValue(),widget.href);
    await text.fill('Meet Strangers');
    await dest.fill('/about/');
    await screenshot(page,'mobile-button');
    await panel.locator('[data-direct-action=done]').tap();
    await save(page);
    const stored = (await adminRequest()).draft.pages['custom:roastery-weekends'];
    assert.equal(stored.title,renamed);
    assert.deepEqual(stored.widgets[0],{...widget, heading:'Coffee on Saturdays',body:'Join us for a filter coffee on Saturdays.',
      image:'asset:pottergate.webp',alt:'Our Pottergate café',label:'Meet Strangers',href:'/about/'});
    const shopper = await context.newPage();
    await shopper.goto(retail+path);
    await shopper.getByRole('heading',{name:'Open roastery',exact:true}).waitFor();
    await publish(page);
    await shopper.reload();
    await shopper.getByRole('heading',{name:renamed,exact:true}).waitFor();
    await shopper.getByRole('link',{name:'Meet Strangers',exact:true}).click();
    await shopper.waitForURL(retail+'/about/');
  } finally { await context.close(); }
});

test('a shelf photo opens its product editor and publishes to the homepage, shop and product gallery', {timeout:90000}, async () => {
  await setLiveDesign(emptyDocument());
  const {context,page,canvas,panel} = await openEditor({width:1440,height:960});
  try {
    const card = canvas.locator('.home-coffee[data-catalogue-id="bom-jesus"]');
    const picture = card.locator('figure img');
    const productPath = await card.locator('figure a').getAttribute('href');
    await picture.click();
    await panel.locator('[data-direct-action=replace]').click();
    await panel.locator('[data-direct-photo="asset:pottergate.webp"]').click();
    await panel.locator('[data-direct-kind=alt]').fill('Bom Jesus coffee at Pottergate');
    await panel.locator('[data-direct-action=done]').click();
    await save(page);
    await publish(page);
    const shopper = await context.newPage();
    for (const [path,selector] of [
      ['/', '.home-coffee[data-catalogue-id="bom-jesus"] figure img'],
      ['/coffee/', '.product[data-catalogue-id="bom-jesus"] .product-image img'],
      [productPath, '[data-gallery-main]'],
    ]) {
      await shopper.goto(retail+path);
      const primary = shopper.locator(selector+'[alt="Bom Jesus coffee at Pottergate"]');
      await primary.waitFor();
      assert.match(await primary.getAttribute('src'),/\/assets\/pottergate\.webp$/);
    }
  } finally {await context.close();}
});

test('a keyboard user can pick an element, cancel its edit and return to the picker', {timeout:45000}, async () => {
  await setLiveDesign(emptyDocument());
  const {context,page,canvas,panel} = await openEditor({width:1440,height:960});
  try {
    const expanded = page.getByRole('button',{name:'Expand preview',exact:true});
    const choose = page.getByRole('button',{name:'Choose an element',exact:true});
    const choices = page.getByRole('combobox',{name:'Preview element',exact:true});
    const isFocused = control => control.evaluate(node => node.ownerDocument.activeElement === node);
    await expanded.focus();
    await page.keyboard.press('Tab');
    assert.ok(await isFocused(choose));
    await page.keyboard.press('Enter');
    assert.ok(await isFocused(choices));
    const index = await choices.locator('option').evaluateAll(options =>
      options.findIndex(option => option.textContent.includes('Speciality coffee roasted in Norwich.')));
    assert.ok(index >= 0);
    await page.keyboard.press('Home');
    for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.ok(await isFocused(page.getByRole('button',{name:'Edit element',exact:true})));
    await page.keyboard.press('Enter');
    const field = panel.locator('[data-direct-kind=text]');
    await field.waitFor();
    assert.ok(await isFocused(field));
    await page.keyboard.press('End');
    await page.keyboard.type(' NEW');
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'hidden'});
    assert.equal(await canvas.locator('#hero-title').textContent(),'Speciality coffee roasted in Norwich.');
    assert.ok(await isFocused(choose));
    await expanded.focus();
    await page.keyboard.press('Tab');
    assert.ok(await isFocused(choose),'the picker remains in the tab order after editing');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.ok(await isFocused(choose));
    assert.equal(await choose.getAttribute('aria-expanded'),'false');
  } finally {await context.close();}
});

test('clicking a section background previews its width and preserves protected purchase layouts', {timeout:60000}, async () => {
  await setLiveDesign(emptyDocument());
  const {context,page,canvas,panel} = await openEditor({width:1440,height:960});
  try {
    const section = canvas.locator('#top');
    const width = panel.getByRole('combobox',{name:'Section width',exact:true});
    await clickBackground(page,section);
    assert.equal(await width.inputValue(),'standard');
    await width.selectOption('compact');
    assert.equal(await section.getAttribute('data-consumer-section-layout'),'compact');
    await panel.locator('[data-direct-action=cancel]').click();
    assert.equal(await section.getAttribute('data-consumer-section-layout'),null);
    await clickBackground(page,section);
    await width.selectOption('wide');
    await panel.locator('[data-direct-action=done]').click();
    assert.equal(await section.getAttribute('data-consumer-section-layout'),'wide');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await section.getAttribute('data-consumer-section-layout'),null);

    await page.getByRole('combobox',{name:'Storefront page or surface'}).selectOption('product:bom-jesus');
    const purchase = canvas.locator('.retail-product-intro');
    await clickBackground(page,purchase);
    assert.equal(await width.count(),0);
    assert.equal(await purchase.getAttribute('data-consumer-section-layout'),null);
    assert.equal(await purchase.locator('form').count(),1);
  } finally {await context.close();}
});
