import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPublishReview} from '../public/admin/consumer-editor-review.js';
import {PAGES, COFFEE_CHOICES, LAYOUTS, THEMES, WIDGET_TYPES, customPageForKey, emptyDocument, validateDocument}
  from '../public/consumer-preview/assets/editor-model.js';

import * as layoutTools from '../public/consumer-preview/assets/editor-layout.js';

const media = [{id:'2245a643-5577-42f7-aa48-c7149eb87d03', name:'Autumn roast.jpg'}];
const data = (pages, theme = 'heritage') => validateDocument({...emptyDocument(), theme, pages});
function review(a, b) {
  const pages = {...PAGES};
  for (const doc of [a,b]) for (const [id, page] of Object.entries(doc.pages)) {
    if (id.startsWith('custom:')) pages[id] = customPageForKey(id, page.title);
  }
  return buildPublishReview(a, b, {pages, themes: THEMES, layouts: LAYOUTS, widgetTypes: WIDGET_TYPES, coffees: COFFEE_CHOICES, media, layoutTools});
}

test('review compares the published and local documents using field defaults, actual photo names and page labels', () => {
  const field = PAGES.home.fields.find(item => item.kind === 'image');
  const doc = data({home:{fields:{'hero-title':'What is roasting', [field.id]:'media:' + media[0].id}, sectionLayouts:{hero:'wide'}, hidden:['social']}}, 'oat');
  const [site, home] = review(emptyDocument(), doc);
  assert.deepEqual(site.changes, [{label:'Storefront theme',before:'Strangers green',after:'Oat'}]);
  assert.equal(home.label, PAGES.home.label);
  assert.equal(home.changes.find(c => c.after === 'What is roasting').before, PAGES.home.fields.find(f => f.id === 'hero-title').default);
  assert.equal(home.changes.find(c => c.after === media[0].name).beforeImage, field.default);
  assert.ok(home.changes.some(c => c.before === 'Standard' && c.after === 'Wide'));
  assert.ok(home.changes.some(c => c.before === 'Shown' && c.after === 'Hidden'));
  assert.deepEqual(review(doc, doc), []);
});

test('review explains widget placement, shelf changes and page creation or removal', () => {
  const slug = 'custom:events', a = data({}), b = data({[slug]:{title:'Events',inNavigation:true, widgets:[
    {id:'w-buy',type:'coffee-shelf',heading:'Pick a coffee',items:['rocko','bom-jesus']},
    {id:'w-meet',type:'text',body:'Meet our roasters'}, ], sections:['w-meet','w-buy']}});
  const [group] = review(a,b);
  assert.equal(group.label, 'Events');
  assert.ok(group.changes.some(c => c.label === 'Page' && c.after === '/pages/events/'));
  assert.ok(group.changes.some(c => c.label === 'Section order' && c.after === '1. Text section\n2. Shoppable coffees · Pick a coffee'));
  assert.ok(group.changes.some(c => c.after === 'Meet our roasters'));
  assert.ok(group.changes.some(c => c.label.endsWith('Coffees in display order') && c.after.includes(COFFEE_CHOICES.find(c => c.id === 'rocko').name)));
  assert.ok(review(b,a)[0].changes.some(c => c.before === '/pages/events/' && c.after === 'No page'));
});

test('review ignores differing key order and uses inherited product settings when an override is cleared', () => {
  const product = 'product:bom-jesus';
  const a = data({product:{fields:{'related-title':'Discover more'}},[product]:{fields:{'related-title':'Other coffees'}}});
  const b = data({[product]:{},product:{fields:{'related-title':'Discover more'}}});
  assert.deepEqual(review(a,b).map(group => group.changes), [[{
    label:'Related coffees heading',before:'Other coffees',after:'Discover more',
  }]]);
  const x = data({home:{fields:{'hero-title':'Home'},layout:'wide'},about:{theme:'oat'}});
  const y = data({about:{theme:'oat'},home:{layout:'wide',fields:{'hero-title':'Home'}}});
  assert.deepEqual(review(x,y), []);
});

test('removing product overrides shows the actual visibility and content inherited from the product template', () => {
  const id = 'product:bom-jesus', widget = {id:'w-roast',type:'text',heading:'In the roastery'};
  const base = {hidden:['producer'], widgets:[widget]};
  const live = data({product:base,[id]:{hidden:[],widgets:[{...widget,heading:'This roast'}]}});
  const draft = data({product:base,[id]:{}});
  const [group] = review(live,draft);
  assert.ok(group.changes.some(c => c.label.includes('Visibility') && c.before === 'Shown' && c.after === 'Hidden'));
  assert.ok(group.changes.some(c => c.before === 'This roast' && c.after === 'In the roastery'));
  assert.ok(group.changes.every(c => c.after !== 'No widget'));
});

test('two identically named widgets can be distinguished when they exchange positions', () => {
  const widgets = ['w-first','w-second'].map(id => ({id, type:'divider'}));
  const a = data({'custom:tasting':{title:'Tasting', widgets}});
  const b = data({'custom:tasting':{title:'Tasting', widgets, sections:['w-second','w-first']}});
  const [order] = review(a,b)[0].changes;
  assert.deepEqual(order, {label:'Section order',before:'1. Divider (1)\n2. Divider (2)',after:'1. Divider (2)\n2. Divider (1)'});
});

test('publication review labels mobile-only overrides and resolves restored shared settings', () => {
  const old = data({home:{sectionStyles:{hero:{spacing:'airy'}},mobile:{
    sectionStyles:{hero:{spacing:'tight'}}, sections:['hero','visit','featured','social']}}});
  const next = data({home:{sectionStyles:{hero:{spacing:'airy'}}}});
  const [home] = review(old,next);
  const spacing = home.changes.find(change => change.label.startsWith('Mobile only · ') && change.label.endsWith(' · Spacing'));
  assert.deepEqual([spacing.before,spacing.after],['Tight','Airy']);
  const order = home.changes.find(change => change.label === 'Mobile only · Section order');
  assert.match(order.after,/^Use all sizes\n/);
  assert.notEqual(order.before.split('\n')[1], order.after.split('\n')[2]);
  assert.equal(review(old,old).length,0);
});

test('clearing a single product layout override names its inherited widget arrangement', () => {
  const product = {widgets:[{id:'w-story',type:'hero',heading:'At the roastery',image:'asset:roastery.webp',layout:'split'}]};
  const old = data({product, 'product:bom-jesus':{sectionStyles:{'w-story':{arrangement:'reverse'}}}});
  const next = data({product});
  const [group] = review(old,next);
  assert.equal(group.scope,'product:bom-jesus');
  const change = group.changes.find(item => item.label.endsWith(' · Widget arrangement'));
  assert.deepEqual([change.before,change.after],['Image right','Image left']);
});
