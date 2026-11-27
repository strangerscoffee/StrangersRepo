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
      home:{fields:{[field('home','image','#top > .home-hero-image > img')]:'asset:roastery.webp'}},
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
    assert.match(home,/<figure class="home-hero-image">\s*<img[^>]+src="\/consumer-preview\/assets\/roastery.webp"/);
    assert.match(home,/<a data-consumer-page-link href="\/pages\/coffee-club\/">Coffee &amp; company<\/a>/);
    const custom = await read('/pages/coffee-club/');
    assert.match(custom,/<h1 class="consumer-page-title">Coffee &amp; company<\/h1>/);
    assert.match(custom,/<img loading="lazy" src="\/consumer-preview\/assets\/roastery.webp" alt="Our roasting room">/);
    assert.match(custom,/<h2>Roast &lt;notes&gt;<\/h2><p>Pick a morning delivery\.<\/p><a class="button" href="\/location\/">Visit us<\/a>/);
    assert.ok(custom.indexOf('data-consumer-widget="w-photo"') < custom.indexOf('data-consumer-widget="w-story"'));
  } finally {await fixture.stop();}
});
