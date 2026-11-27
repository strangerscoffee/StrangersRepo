import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { productRoutes } from '../public/consumer-preview/assets/product-paths.js';

const root = fileURLToPath(new URL('../', import.meta.url));
describe('consumer editor sample canvases', () => {
  let worker;
  before(async () => {
    const bundled = await build({ stdin: { resolveDir: root, contents: `
      import { products } from './public/consumer-preview/assets/products.js';
      import { applyEditorPreviewSurfaces } from './src/consumerEditorSurfaces.js';
      export default { async fetch(req) {
        const { searchParams } = new URL(req.url);
        const html = new Response(await req.text(), {headers:{'content-type':'text/html'}});
        const catalogue = searchParams.get('state') === 'catalogue-addition'
          ? [{...products[0],id:'seasonal-lot',name:'Seasonal lot',category:'coffee',available:true,image:'/assets/roastery.webp'}] : null;
        return applyEditorPreviewSurfaces(new HTMLRewriter(), searchParams.get('page'), searchParams.get('state'), catalogue).transform(html);
      }};
    ` }, bundle: true, write: false, format: 'esm' });
    worker = new Miniflare({
      host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
      workers: [{
        config: {
          name: 'consumer-editor-surfaces', compatibilityDate: '2026-10-01',
          manifest: { modulesRoot: root, mainModule: 'fixture.mjs', modules: { 'fixture.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
        },
        dev: { outboundService: { type: 'fetcher', handler() { throw Error('Canvas rendering must never call a service'); } } },
      }],
    });
  });
  after(async () => { await worker?.dispose(); });

  async function render(page, template, state = '') {
    const source = new URL('../public/consumer-preview/' + (template ? template + '/' : '') + 'index.html', import.meta.url);
    const result = await worker.dispatchFetch('http://editor.test/?' + new URLSearchParams({ page, state }), {
      method: 'POST', body: await readFile(source, 'utf8'),
    });
    assert.equal(result.status, 200);
    return result.text();
  }

  test('the shop, homepage and product canvas show current catalogue additions under the same ID', async () => {
    for (const [scope,template] of [['home',''],['shop','coffee'],['product:seasonal-lot','product']]) {
      const output = await render(scope,template,'catalogue-addition');
      assert.match(output, /Seasonal lot/);
      assert.match(output, /src="\/consumer-preview\/assets\/roastery.webp"/);
      if (scope !== 'product:seasonal-lot') {
        assert.match(output, /data-catalogue-id="seasonal-lot"/);
        assert.match(output, /href="\/coffee\/p\/seasonal-lot\/"/);
      } else assert.match(output, /<h1>Seasonal lot<\/h1>/);
    }
  });

  test('every product and voucher uses its own actual product page', async () => {
    for (const {id, name} of Object.values(productRoutes)) {
      const output = await render('product:' + id, 'product');
      assert.ok(output.includes('<h1>' + name + '</h1>'), id);
      assert.ok(output.includes('data-gallery-main'), id);
      assert.doesNotMatch(output, /data-retail-product aria-busy="true"/);
    }
    const shop = await render('shop', 'coffee');
    assert.match(shop, /class="product-quick-view"/);
    assert.match(shop, /View Brazil Fazenda Bom Jesus Natural/);
  });

  test('finder, cart, and each checkout step use real shopper presenters and local samples', async () => {
    for (const [state, marker] of [['brew', 'How do you brew?'], ['taste', 'What flavours do you enjoy?'], ['match', 'Your coffee match']]) {
      const output = await render('finder', '', state);
      assert.match(output, /<dialog[^>]*open[^>]*data-view="finder"/);
      assert.ok(output.includes(marker));
    }
    assert.match(await render('cart', '', 'items'), /class="cart-line"/);
    assert.match(await render('cart', '', 'empty'), /Your cart is empty/);
    for (const [state, marker] of [['delivery', 'Delivery and contact'], ['collection', 'value="collection" checked'], ['review', 'Review your order'],
      ['processing', 'Preparing your receipt'], ['confirmation', 'Your test order is confirmed.'], ['empty', 'Your cart is empty']]) {
      const output = await render('checkout', 'checkout', state);
      assert.ok(output.includes(marker), state);
      assert.doesNotMatch(output, /Loading your checkout/);
    }
  });

  test('account canvases show the chosen sign-in flow and representative signed-in states', async () => {
    for (const [state, title] of [['login', 'Sign in'], ['register', 'Create your account'], ['forgot', 'Reset your password'],
      ['reset', 'Choose a new password'], ['setup', 'Set up your account']]) {
      const output = await render('account', 'account', state);
      assert.ok(output.includes(title), state);
      assert.match(output, /id="account-auth-fields"><div class="field">/);
      assert.doesNotMatch(output, /Loading your account/);
    }
    const orders = await render('account', 'account', 'orders');
    assert.match(orders, /id="account-dashboard" class="account-layout">/);
    assert.match(orders, /data-order-reference="SC-00000000"/);
    const details = await render('account', 'account', 'details');
    assert.match(details, /id="account-details" aria-labelledby="account-details-title">/);
    assert.match(details, /value="jamie@example.com"/);
    assert.doesNotMatch(await render('account', 'account', 'login'), /jamie@example.com/);
  });
});
