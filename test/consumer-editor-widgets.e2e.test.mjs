import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
let browser, script;
before(async () => {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const bundle = await build({ stdin: {resolveDir: root, contents: `
    import {mountEditorCanvas} from './public/consumer-preview/assets/editor-render.js';
    import {createRetailWidget} from './public/consumer-preview/assets/editor-shop-widgets.js';
    window.demo = {mountEditorCanvas, createRetailWidget};
  `}, bundle: true, write: false, format: 'iife' });
  script = bundle.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

const design = {
  schema: 1, theme: 'heritage', pages: {
    'product:bom-jesus': { fields: {
      'product-title': 'Norwich morning', 'product-image': 'asset:hero.webp', 'note-1': 'Cocoa',
    }},
    home: { widgets: [
      {id: 'w-selection', type: 'coffee-shelf', items: ['rocko', 'bom-jesus'], heading: 'From our roaster'},
      {id: 'w-visit', type: 'locations-list', heading: 'Visit us in Norwich'},
    ]},
  },
};

for (const width of [375, 1280]) test(`curated shopping and café cards render at ${width}px and undo restores native products`, async () => {
  const page = await browser.newPage({viewport: {width, height: 880}});
  try {
    await page.route('**/*', route => route.abort());
    const html = await readFile(new URL('../public/consumer-preview/index.html', import.meta.url), 'utf8');
    await page.setContent(html);
    for (const file of ['style.css','home.css','editor-render.css']) {
      await page.addStyleTag({content: await readFile(new URL('../public/consumer-preview/assets/'+file, import.meta.url), 'utf8')});
    }
    await page.addScriptTag({content: script});
    const original = await page.locator('.home-coffee h3').first().textContent();
    await page.evaluate(doc => {
      window.controller = window.demo.mountEditorCanvas(document, {scope:'home', document:doc});
    }, design);
    const selection = page.locator('[data-consumer-widget="w-selection"]');
    const links = selection.locator('.consumer-retail-card');
    assert.equal(await links.count(), 2);
    assert.match(await links.first().getAttribute('href'), /ethiopia-rocko-mountain-natural/);
    assert.equal(await links.nth(1).locator('h3').textContent(), 'Norwich morning');
    assert.match(await links.nth(1).textContent(), /Cocoa/);
    assert.match(await links.nth(1).locator('img').getAttribute('src'), /^\/api\/admin\/consumer\/editor\/assets\/hero\.webp$/);
    const locations = page.locator('[data-consumer-widget="w-visit"] .consumer-retail-card');
    assert.equal(await locations.count(), 3);
    assert.equal(await locations.first().getAttribute('href'), '/location/#pottergate');
    assert.match(await locations.first().textContent(), /21 Pottergate/);
    assert.ok(await selection.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const height = await links.first().evaluate(el => Math.round(el.getBoundingClientRect().height));
    assert.ok(height >= 44);
    assert.equal(await page.locator('.home-coffee h3').first().textContent(), 'Norwich morning');
    await page.evaluate(() => window.controller.update({schema:1,theme:'heritage',pages:{}}));
    assert.equal(await page.locator('.home-coffee h3').first().textContent(), original);
    assert.equal(await page.locator('[data-consumer-widget]').count(), 0);
  } finally { await page.close(); }
});

test('active cart and linked details reflect names and photos, while a historical purchase keeps its receipt', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main><dialog data-view="bag"><ul><li class="cart-line" data-catalogue-id="bom-jesus">
      <h3>Original</h3><img src="/original.webp"><b>£10.50</b></li></ul></dialog>
      <section class="retail-checkout-receipt"><h3>Original</h3><img src="/receipt.webp"></section></main>`);
    await page.addScriptTag({content:script});
    await page.evaluate(doc => { window.demo.mountEditorCanvas(document, {scope:'cart',document:doc}); }, design);
    assert.equal(await page.locator('.cart-line h3').textContent(), 'Norwich morning');
    assert.equal(await page.locator('.cart-line b').textContent(), '£10.50');
    assert.equal(await page.locator('.cart-line').getAttribute('data-catalogue-id'), 'bom-jesus');
    assert.equal(await page.locator('.retail-checkout-receipt img').getAttribute('src'), '/receipt.webp');
    assert.equal(await page.locator('.retail-checkout-receipt h3').textContent(), 'Original');
  } finally { await page.close(); }
});
