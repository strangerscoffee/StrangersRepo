import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PAGES} from '../public/consumer-preview/assets/editor-model.js';
import {startEditorFixture, admin, retail, editorPath} from './editor-integration-fixture.mjs';

test('the initial retail HTML includes published policy edits, native photos and ordered custom content', async () => {
  const fixture = await startEditorFixture();
  try {
    const current = await fixture.request(admin, editorPath, 'GET', undefined, fixture.cookie).then(r => r.json());
    const field = (scope, kind, selector) => {
      const item = PAGES[scope].fields.find(x => x.kind === kind && x.selector === selector);
      assert.ok(item, scope + ': ' + selector);
      return item.id;
    };
    current.draft.pages = {
      privacy:{fields:{[field('privacy','text','.support-policy-layout > .support-policy-copy > div:nth-of-type(1) > p')]:'We handle <coffee> data.'}},
      shipping:{fields:{
        [field('shipping','text','.support-policy-heading > h1')]:'Delivery from our roastery',
        [field('shipping','link','.support-quick-links > a:nth-of-type(1)')]:'/contact/',
      }},
      home:{fields:{'hero-title':'Seasonal coffee roasted in Norwich.',[field('home','image','#top > .home-hero-image > img')]:'asset:roastery.webp'},
        mobile:{sectionStyles:{hero:{stack:'image-first',crop:'square'}}}},
      shared:{fields:{'header-shop':'Shop beans'}},
      'custom:coffee-club':{title:'Coffee & company',inNavigation:true,sections:['w-photo','w-story'],widgets:[
        {id:'w-story',type:'text',heading:'Roast <notes>',body:'Pick a morning delivery.',label:'Visit us',href:'/location/'},
        {id:'w-photo',type:'image',image:'asset:roastery.webp',alt:'Our roasting room'},
      ]},
    };
    const saved = await fixture.request(admin, editorPath, 'PUT', {revision:current.revision,document:current.draft}, fixture.cookie);
    assert.equal(saved.status,200);
    const release = await fixture.request(admin, editorPath + '/publish','POST',{revision:(await saved.json()).revision},fixture.cookie);
    assert.equal(release.status,200);
    const read = async path => {
      const reply = await fixture.request(retail,path);
      assert.equal(reply.status,200,path);
      // Removing bootstrap data proves that the published values were emitted as actual elements.
      return (await reply.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    };
    assert.match(await read('/privacy-policy/'),/<p>We handle &lt;coffee&gt; data\.<\/p>/);
    const shipping = await read('/shipping/');
    assert.match(shipping,/<h1[^>]*>Delivery from our roastery<\/h1>/);
    assert.match(shipping,/<(?:div|nav) class="support-quick-links"[^>]*>\s*<a[^>]*href="\/contact\/"/);
    assert.match(shipping,/<a[^>]*href="\/coffee\/"[^>]*>Shop beans<\/a>/);
    const home = await read('/');
    assert.match(home, /<style id="consumer-section-styles">@media \(max-width: 760px\)/);
    assert.match(home, /<section [^>]*id="top"[^>]*data-consumer-layout-id="hero"/);
    assert.match(home, /aspect-ratio:1 \/ 1!important/);
    assert.match(home,/<figure class="home-hero-image">\s*<img[^>]+src="\/consumer-preview\/assets\/roastery.webp"/);
    assert.match(home,/<a data-consumer-page-link href="\/pages\/coffee-club\/">Coffee &amp; company<\/a>/);
    assert.match(home, /<h1 id="hero-title">Seasonal coffee <em>roasted in Norwich\.<\/em><\/h1>/);
    const custom = await read('/pages/coffee-club/');
    assert.match(custom,/<h1 class="consumer-page-title">Coffee &amp; company<\/h1>/);
    assert.match(custom,/<img loading="lazy" src="\/consumer-preview\/assets\/roastery.webp" alt="Our roasting room">/);
    assert.match(custom,/<h2>Roast &lt;notes&gt;<\/h2><p>Pick a morning delivery\.<\/p><a class="button" href="\/location\/">Visit us<\/a>/);
    assert.ok(custom.indexOf('data-consumer-widget="w-photo"') < custom.indexOf('data-consumer-widget="w-story"'));
  } finally {await fixture.stop();}
});

test('page and product search and sharing tags arrive in the first HTML and stay off private routes', async () => {
  const fixture = await startEditorFixture();
  try {
    async function head(path) {
      const response = await fixture.request(retail,path);
      assert.equal(response.status,200,path);
      assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
      const html = await response.text();
      return html.slice(0,html.indexOf('</head>'));
    }
    const base = await head('/about/?utm_source=coffee');
    assert.match(base,/<link rel="canonical" href="https:\/\/preview\.staffstrangerscoffee\.com\/about\/">/);
    assert.match(base,/<meta property="og:title" content="About \| Strangers Coffee">/);
    assert.doesNotMatch(base,/utm_source\/|utm_source=/);

    const current = await fixture.request(admin,editorPath,'GET',undefined,fixture.cookie).then(r => r.json());
    const draft = current.draft;
    draft.pages = {
      product:{meta:{socialDescription:'From the Norwich roastery'}},
      'product:bom-jesus':{meta:{title:'Brazil <tasting> notes',description:'Brazilian coffee.',socialTitle:'Coffee & chocolate',
        socialImage:'asset:roastery.webp',socialImageAlt:'The coffee roastery',robots:'index'},fields:{'product-title':'Coffee & samples'}},
      'custom:roastery-news':{title:'Roastery news',widgets:[{id:'w-report',type:'text',body:'News from our Norwich roastery.'}],
        meta:{canonical:'/about/'}},
      account:{meta:{title:'Your coffee account'}},
    };
    const saved = await fixture.request(admin,editorPath,'PUT',{revision:current.revision,document:draft},fixture.cookie);
    assert.equal(saved.status,200);
    const sku = '/coffee/p/brazil-fazenda-bom-jesus-natural/';
    assert.doesNotMatch(await head(sku),/Coffee &amp; chocolate/,'an unpublished share card never leaks');
    const revision = (await saved.json()).revision;
    assert.equal((await fixture.request(admin,editorPath+'/publish','POST',{revision},fixture.cookie)).status,200);
    const product = await head(sku + '?grind=Filter');
    assert.match(product,/<title>Brazil &lt;tasting&gt; notes<\/title>/);
    assert.match(product,/<meta name="description" content="Brazilian coffee\.">/);
    assert.match(product,/<meta property="og:title" content="Coffee &amp; chocolate">/);
    assert.match(product,/<meta name="twitter:description" content="From the Norwich roastery">/);
    assert.match(product,/<meta property="og:image" content="https:\/\/preview\.staffstrangerscoffee\.com\/consumer-preview\/assets\/roastery.webp">/);
    assert.match(product,/<meta property="og:image:alt" content="The coffee roastery">/);
    assert.match(product,/<meta name="robots" content="noindex, nofollow">/);
    assert.equal((product.match(/rel="canonical"/g)||[]).length,1);
    const structured = JSON.parse(product.match(/<script type="application\/ld\+json">(.+?)<\/script>/)[1]);
    assert.equal(structured.sku,'bom-jesus');
    assert.equal(structured.name,'Coffee & samples');
    assert.equal(structured.url,retail + sku);
    assert.equal(structured.offers,undefined);
    const custom = await head('/pages/roastery-news/');
    assert.ok(custom.includes('rel="canonical" href="' + retail + '/about/"'));
    assert.match(custom,/<meta property="og:description" content="News from our Norwich roastery\.">/);
    for (const route of ['/account/?reset=local-fixture','/checkout/?order=test']) {
      const privateHead = await head(route);
      assert.doesNotMatch(privateHead,/rel="canonical"|property="og:|application\/ld\+json|local-fixture/);
    }
  } finally { await fixture.stop(); }
});
