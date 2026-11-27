import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright';
import {admin, retail, wholesale, editorPath, openLocalBrowser, startEditorFixture} from './editor-integration-fixture.mjs';
import {PAGES, emptyDocument} from '../public/consumer-preview/assets/editor-model.js';

let fixture, browser;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

async function adminRequest(action = '', method = 'GET', body) {
  const response = await fixture.request(admin, editorPath + action, method, body, fixture.cookie);
  assert.ok(response.ok, method + ' ' + action + ' returned ' + response.status);
  return response.json();
}

test('published comparison requires an admin session on the admin host', async () => {
  assert.equal((await fixture.request(admin, editorPath + '/published')).status, 401);
  for (const origin of [retail, wholesale]) assert.equal((await fixture.request(origin, editorPath + '/published', 'GET', undefined, fixture.cookie)).status, 404);
  const original = await adminRequest('/published');
  assert.deepEqual(original, {revision:0, document:emptyDocument()});
});

for (const [name, viewport] of [['desktop', {width:1440,height:960}], ['mobile', {width:393,height:852}]]) {
  test('publication review compares saved and unsaved changes and cancels without writing on ' + name, {timeout:90000}, async () => {
    const initial = await adminRequest();
    const hero = PAGES.home.fields.find(f => f.id === 'hero-title');
    const photo = PAGES.home.fields.find(f => f.kind === 'image');
    const original = {...emptyDocument(),pages:{home:{fields:{[hero.id]:'Fresh from the roastery'}}}};
    const seed = await adminRequest('', 'PUT', {revision:initial.revision,document:original});
    const release = await adminRequest('/publish','POST',{revision:seed.revision});
    const edited = structuredClone(original);
    edited.pages.home.fields[photo.id] = 'asset:roastery.webp';
    const saved = await adminRequest('', 'PUT', {revision:release.revision, document:edited});
    const context = await openLocalBrowser(fixture, browser, viewport, true);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      await page.goto(admin + '/#consumer/editor');
      await page.getByRole('combobox', {name:'Page content',exact:true}).selectOption(hero.id);
      const field = page.getByRole('textbox', {name:hero.label, exact:true});
      const newTitle = 'Find your next Norwich roast';
      await field.fill(newTitle);
      const publish = page.getByRole('button', {name:'Publish',exact:true});
      await publish.click();
      const sheet = page.locator('#sheet');
      const review = sheet.getByRole('region', {name:'Publication changes'});
      await review.getByText(newTitle,{exact:true}).waitFor().catch(async error => {
        throw new Error(error.message + '\nSheet: ' + await sheet.textContent() + '\nEditor: ' + await page.locator('.ce-message').textContent());
      });
      assert.equal(await review.getByText(original.pages.home.fields[hero.id],{exact:true}).count(), 1);
      assert.equal(await review.getByText('roastery.webp',{exact:true}).count(), 1);
      const pictures = review.locator('img');
      assert.equal(await pictures.count(), 2);
      await pictures.last().scrollIntoViewIfNeeded();
      await pictures.evaluateAll(images => Promise.all(images.map(img => img.decode())));
      assert.equal(await review.evaluate(el => el.scrollWidth - el.clientWidth), 0);
      if (process.env.CONSUMER_SCREENSHOT_DIR) {
        await mkdir(process.env.CONSUMER_SCREENSHOT_DIR, {recursive:true});
        await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR + '/publication-review-' + name + '.png'});
      }
      await sheet.getByRole('button', {name:'Cancel',exact:true}).click();
      assert.equal((await adminRequest()).revision, saved.revision);
      assert.deepEqual((await adminRequest('/published')).document,original);
      assert.equal(await field.inputValue(),newTitle);
      await publish.click();
      await sheet.getByRole('button', {name:'Publish storefront',exact:true}).click();
      await page.getByText('Published to the consumer storefront.', {exact:true}).waitFor();
      edited.pages.home.fields[hero.id] = newTitle;
      assert.deepEqual((await adminRequest('/published')).document, edited);

      await field.fill('An edit after publishing');
      await publish.click();
      await review.getByText('An edit after publishing', {exact:true}).waitFor();
      const latest = await adminRequest(), concurrent = structuredClone(latest.draft);
      concurrent.pages.home.layout = 'wide';
      await adminRequest('', 'PUT', {revision:latest.revision, document:concurrent});
      await sheet.getByRole('button', {name:'Publish storefront',exact:true}).click();
      await page.getByRole('button', {name:'Recover my edits'}).waitFor();
      assert.equal(await field.inputValue(),'An edit after publishing');
      assert.deepEqual((await adminRequest('/published')).document, edited);
    } finally { await context.close(); }
  });
}
