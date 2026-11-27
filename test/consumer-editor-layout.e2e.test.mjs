import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';

let browser, bundle;
before(async () => {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
  const result = await build({entryPoints:['public/consumer-preview/assets/editor-render.js'],bundle:true,
    format:'iife',globalName:'Editor',write:false});
  bundle = result.outputFiles[0].text;
});
after(async () => {await browser?.close();});

test('native layout and artwork can be undone without replacing storefront controls', async () => {
  const page = await browser.newPage();
  try {
    const shell = await readFile(new URL('../public/consumer-preview/index.html',import.meta.url),'utf8');
    await page.route('**/*', route => route.fulfill({body:'', contentType:'text/plain'}));
    await page.setContent(shell);
    await page.addScriptTag({content:bundle});
    const actual = await page.evaluate(async () => {
      const initial = {schema:1,theme:'heritage',pages:{}};
      const changed = {schema:1,theme:'sage',pages:{home:{
        sections:['social','w-coffee','hero','featured','visit'], hidden:['visit'],
        fields:{'hero-title':'Norwich coffee'}, widgets:[{id:'w-coffee',type:'text',heading:'Coffee from Norwich'}],
      },shared:{fields:{'header-logo':''}}}};
      const native = document.querySelector('#top');
      const cta = native.querySelector('[data-find]');
      const expectedTitle = native.querySelector('h1').innerHTML;
      const picks = [];
      const view = Editor.mountEditorCanvas(document,{scope:'home',document:initial,onSelect:pick=>picks.push(pick)});
      const order = () => [...document.querySelector('main').children].map(el =>
        el.dataset.consumerWidget || el.id || (el.classList.contains('home-social-section') ? 'social' : 'other'));
      view.update(changed);
      const editedOrder = order();
      const hidden = document.querySelector('#visit').hasAttribute('data-consumer-section-hidden');
      const logo = document.querySelector('.site-header .brand img');
      const photoHidden = logo.hasAttribute('data-consumer-image-hidden');
      document.querySelector('#hero-title').click();
      view.update(initial);
      const restored = order();
      const survived = cta === native.querySelector('[data-find]') && native === document.querySelector('#top');
      const artwork = logo.getAttribute('src');
      const restoredTitle = native.querySelector('h1').innerHTML;
      view.destroy();
      return {editedOrder,hidden,photoHidden,picks,restored,survived,artwork,restoredTitle,expectedTitle};
    });
    assert.deepEqual(actual.editedOrder,['social','w-coffee','top','coffee','visit']);
    assert.deepEqual(actual.restored,['top','coffee','visit','social']);
    assert.equal(actual.hidden,true); assert.equal(actual.photoHidden,true);
    assert.equal(actual.picks[0].field,'hero-title'); assert.equal(actual.survived,true);
    assert.equal(actual.restoredTitle,actual.expectedTitle);
    assert.equal(actual.artwork,'/consumer-preview/assets/logo.svg');
  } finally {await page.close();}
});
