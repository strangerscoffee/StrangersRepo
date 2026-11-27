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

test('canvas keeps the exact repeated photo selected across repaint and supports keyboard and icon hits', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<header class="site-header"><button data-bag><svg width="20" height="20"></svg><span class="bag-label" hidden>Cart</span></button>
      <button data-find hidden>Find my coffee</button></header>
      <div class="notice"><a href="#shipping">Delivery</a></div>
      <main><section id="top"><h1 id="hero-title" tabindex="-1">Coffee from <em>Norwich</em></h1>
      <figure class="home-hero-image"><img width="50" height="50" alt="First"><img width="50" height="50" alt="Second"></figure>
      <input type="checkbox"></section></main><dialog data-view="bag" id="dialog"><h2 id="dialog-title">Your cart</h2></dialog>`);
    await page.addScriptTag({content:bundle});
    const result = await page.evaluate(() => {
      const design = {schema:1,theme:'heritage',pages:{}};
      const picks = [];
      const view = Editor.mountEditorCanvas(document,{scope:'home',document:design,onSelect:(pick,hit) => {
        picks.push({pick, properties:hit.fields.map(field => field.kind), tag:hit.node.tagName, caret:hit.caretOffset});
      }});
      const title = document.querySelector('#hero-title');
      const second = document.querySelector('img[alt=Second]');
      second.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));
      const hovered = [...document.querySelectorAll('[data-consumer-hovered]')].map(node => node.getAttribute('alt'));
      second.click();
      const sameBefore = view.getTarget().node === second;
      view.update(design);
      const sameAfter = view.getTarget().node === second;
      const list = view.targetList();
      const photos = list.filter(row => row.hit.fields.some(field => field.kind === 'image'));
      function selectExact({selection,hit}) {
        view.select(selection,{scroll:false,node:hit.node});
        return view.getTarget().node === hit.node;
      }
      const exactTargets = photos.every(selectExact) && selectExact(list.find(row => row.selection.field === 'bag-label'));
      const initialFields = list.map(row => row.selection.field);
      document.querySelector('dialog').open = true;
      const dialogTargets = view.targetList().map(row => row.selection.scope);
      document.querySelector('dialog').open = false;
      document.querySelector('.notice a').click();
      const icon = document.querySelector('svg');
      icon.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      title.focus();
      title.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      const firstLetter = document.createRange();
      firstLetter.setStart(title.querySelector('em').firstChild,0);
      firstLetter.setEnd(title.querySelector('em').firstChild,1);
      const letter = firstLetter.getBoundingClientRect();
      title.querySelector('em').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,
        clientX:letter.left+1,clientY:letter.top+letter.height/2}));
      const beforeCheckbox = picks.slice();
      const checkbox = document.querySelector('input');
      checkbox.click();
      view.destroy();
      return {picks:beforeCheckbox, hovered, sameBefore, sameAfter, exactTargets, initialFields,dialogTargets, photoTargets:photos.length,
        changedHash:!!location.hash,checked:checkbox.checked,
        previousTabIndex:title.getAttribute('tabindex'),photoTabIndex:second.getAttribute('tabindex'),
        leftover:document.querySelectorAll('[data-consumer-editable],[data-consumer-selected],[data-consumer-hovered]').length};
    });
    assert.deepEqual(result.picks.map(hit => hit.properties), [['image','alt'],['text','link'],['text'],['text'],['text']]);
    assert.deepEqual(result.picks.map(hit => hit.pick.scope), ['home','shared','shared','home','home']);
    assert.equal(result.picks[2].pick.field,'bag-label');
    assert.equal(result.picks[2].tag,'BUTTON');
    assert.equal(result.picks[3].pick.field,'hero-title');
    assert.equal(result.picks[3].caret,undefined);
    assert.equal(result.picks[4].caret,'Coffee from '.length);
    assert.deepEqual(result.hovered,['Second']);
    assert.ok(result.sameBefore && result.sameAfter);
    assert.ok(result.exactTargets);
    assert.equal(result.photoTargets,2);
    assert.deepEqual(result.dialogTargets,['cart']);
    assert.ok(!result.initialFields.includes('find-label') && !result.initialFields.includes('title'));
    assert.equal(result.changedHash,false);
    assert.equal(result.checked,false);
    assert.equal(result.previousTabIndex,'-1');
    assert.equal(result.photoTabIndex,null);
    assert.equal(result.leftover,0);
  } finally {await page.close();}
});
