import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {productRoutes} from '../public/consumer-preview/assets/product-paths.js';
import {resolvePageSeo} from '../public/consumer-preview/assets/editor-seo.js';
import {PAGES, TEMPLATES, COFFEE_CHOICES, cataloguePageForKey, customPageForKey, emptyDocument, imageUrl,
  pageForPath, referencedMedia, validateDocument} from '../public/consumer-preview/assets/editor-model.js';

const uuid='fb323423-a3a4-48fb-95b0-16b087a3f4e6';
const doc=pages=>({...emptyDocument(),pages});

test('all consumer routes have editable content and the generated inventory matches the storefront',()=>{
  execFileSync('python3',['scripts/consumer-editor-inventory.py','--check']);
  for (const key of ['shared','home','shop','about','contact','guides','locations','shipping','privacy','terms','account','checkout','product','cart','finder']) {
    assert.ok(PAGES[key]?.fields.length, key);
  }
  for (const [slug,{id}] of Object.entries(productRoutes)) {
    assert.equal(pageForPath('/coffee/p/'+slug+'/?grind=beans'), 'product:'+id);
    assert.ok(PAGES['product:'+id].fields.find(f=>f.id==='product-image'));
  }
  for (const page of Object.values(PAGES)) {
    const names=page.fields.map(f=>f.id);
    assert.equal(new Set(names).size,names.length,page.label);
  }
  assert.equal(pageForPath('/wholesale/'),null);
  assert.equal(pageForPath('/api/admin/'),null);
});

test('catalogue additions keep editable product titles, photos and button labels under their permanent ID', () => {
  const key = 'product:new-single-origin';
  const product = {id:'new-single-origin',name:'Seasonal release',shortCopy:'Cocoa and dates.'};
  const page = cataloguePageForKey(key, product);
  assert.equal(pageForPath(page.path), key);
  assert.equal(page.fields.find(field => field.id === 'product-title').default, product.name);
  const revision = doc({[key]:{fields:{
    'product-title':'Spring release', 'product-image':'media:'+uuid, 'product-image-alt':'New packaging', 'add-to-cart':'Add a bag',
  }}});
  assert.deepEqual(validateDocument(revision), revision);
  assert.deepEqual(referencedMedia(revision), [uuid]);
  assert.equal(cataloguePageForKey('product:../bad'), null);
  assert.throws(() => validateDocument(doc({[key]:{fields:{price:'£0.01'}}})), TypeError);
});

test('validate linked custom page, structured stock widgets, section ordering, and selected media references',()=>{
  const design=doc({'custom:summer':{title:'Summer coffees',inNavigation:true,widgets:[
    {id:'w-shelf',type:'coffee-shelf',items:COFFEE_CHOICES.slice(0,2).map(p=>p.id)},
  ]},home:{theme:'oat',meta:{title:'Norwich coffees',description:'Our coffee shop'},layout:'wide',sectionLayouts:{hero:'wide'},fields:{'hero-title':'Norwich coffee'},
    sections:['w-visit','hero'],hidden:['social'],widgets:[{id:'w-visit',type:'hero',href:'/pages/summer/',image:'media:'+uuid,body:'A seasonal flight'}]}});
  assert.deepEqual(validateDocument(design),design);
  assert.deepEqual(referencedMedia(design),[uuid]);
  assert.equal(pageForPath('/pages/summer/?a=b#top'),'custom:summer');
  assert.equal(customPageForKey('custom:summer','Summer coffees').path,'/pages/summer/');
  assert.equal(imageUrl('media:'+uuid,true),'/api/admin/consumer/editor/media/'+uuid);
  assert.equal(imageUrl('media:'+uuid),'/consumer-media/'+uuid);
  assert.equal(imageUrl('asset:not-on-disk.webp'),'');
  for (const template of Object.values(TEMPLATES)) {
    assert.doesNotThrow(()=>validateDocument(doc({home:{widgets:template.widgets.map((w,i)=>({...w,id:'w-'+i}))}})));
  }
});

test('reject unrecognized document controls, unsafe files/links, protected sections, collisions and unregistered landing pages',()=>{
  const invalidPage = p => assert.throws(()=>validateDocument(doc(p)),TypeError);
  invalidPage({account:{hidden:['access']}});
  invalidPage({account:{hidden:['hero']}});
  invalidPage({checkout:{hidden:['checkout']}});
  invalidPage({shared:{widgets:[{id:'w-x',type:'text'}]}});
  invalidPage({home:{fields:{'constructor':'bad'}}});
  invalidPage({shared:{meta:{title:'Drawer'}}});
  invalidPage({home:{meta:{title:'a'.repeat(151)}}});
  invalidPage({home:{meta:{description:''}}});
  invalidPage({home:{sections:['hero','hero']}});
  invalidPage({home:{sectionLayouts:{unknown:'wide'}}});
  invalidPage({home:{fields:{'hero-title':{html:'<strong>anything</strong>'}}}});
  invalidPage({home:{widgets:[{id:'w-a',type:'text',html:'<u>no</u>'}]}});
  invalidPage({home:{widgets:[{id:'w-a',type:'text'},{id:'w-a',type:'text'}]}});
  invalidPage({home:{widgets:[{id:'w-a',type:'image',image:'asset:../../admin.js'}]}});
  invalidPage({home:{widgets:[{id:'w-a',type:'coffee-shelf',items:['online-gift-card']}]}});
  invalidPage({home:{widgets:[{id:'w-a',type:'coffee-shelf',items:['../../shop']}]}});
  const newCoffee = doc({home:{widgets:[{id:'w-a',type:'coffee-shelf',items:['new-single-origin']}]}});
  assert.deepEqual(validateDocument(newCoffee).pages.home.widgets[0].items, ['new-single-origin']);
  invalidPage({home:{widgets:[{id:'w-a',type:'text',items:['rocko']}]}});
  invalidPage({'custom:../admin':{title:'Admin'}});
  invalidPage({'custom:sale':{title:' '}});
  invalidPage({'custom:sale':{title:'Sale',inNavigation:1}});
  const widgetHref=href=>doc({home:{widgets:[{id:'w-link',type:'callout',href}]}});
  for (const path of ['javascript:alert(1)','data:text/html,Hi','//evil.test','/api/admin/consumer/editor',
      '/wholesale/','/pages/missing/','https://user:password@example.com','/coffee/%2F../api','   ']) {
    assert.throws(()=>validateDocument(widgetHref(path)),TypeError,path);
  }
  for (const path of ['/','/coffee/#gifts','/coffee/p/house-blend/', 'https://strangerscoffee.com/','mailto:hello@example.com']) {
    assert.doesNotThrow(()=>validateDocument(widgetHref(path)),path);
  }
  assert.throws(()=>validateDocument(JSON.parse('{"schema":1,"theme":"heritage","pages":{"__proto__":{"fields":{}}}}')));
  const repeated='a'.repeat(7000);
  const manyWidgets=Object.fromEntries(['about','home'].map(k=>[k,{widgets:Array.from({length:36},(_,i)=>({id:'w-'+i,type:'text',body:repeated}))}]));
  assert.throws(()=>validateDocument(doc(manyWidgets)),/384 KiB/);
});

test('release media enumeration excludes free text and returns each referenced asset just once',()=>{
  const design=doc({home:{fields:{'hero-title':'media:'+uuid},widgets:[{id:'w-bio',type:'text',body:'media:'+uuid}]}});
  assert.deepEqual(referencedMedia(validateDocument(design)),[]);
  const image=PAGES.home.fields.find(f=>f.kind==='image');
  design.pages.home.fields[image.id]='media:'+uuid;
  design.pages.home.widgets.push({id:'w-image',type:'image',image:'media:'+uuid});
  assert.deepEqual(referencedMedia(validateDocument(design)),[uuid]);
});

test('SEO tags validate public canonical destinations, sharing photos and protected page settings',()=>{
  const fields = {socialTitle:'From the roastery',socialImage:'media:'+uuid,socialImageAlt:'Freshly roasted coffee',robots:'noindex',
    canonical:'https://preview.staffstrangerscoffee.com/location'};
  const saved = validateDocument(doc({home:{meta:fields}}));
  assert.equal(saved.pages.home.meta.canonical,'/location/');
  assert.deepEqual(referencedMedia(saved),[uuid]);
  for (const canonical of ['/account/','/checkout/','/api/account','/pages/absent/','/coffee/?grind=1',
    '//elsewhere.test','/location/#visit','https://strangerscoffee.trade/','/coffee/../location/']) {
    assert.throws(()=>validateDocument(doc({home:{meta:{canonical}}})),TypeError,canonical);
  }
  for (const pages of [{product:{meta:{canonical:'/coffee/'}}},{account:{meta:{socialTitle:'Private'}}},
    {checkout:{meta:{robots:'index'}}},{home:{meta:{socialImage:'asset:mark.svg'}}}]) {
    assert.throws(()=>validateDocument(doc(pages)),TypeError);
  }
});

test('responsive layout validates presets, product inheritance and both fixed-position boundaries', async () => {
  const {orderedSections,effectiveStyle} = await import('../public/consumer-preview/assets/editor-layout.js');
  const {validateLayoutChanges} = await import('../public/consumer-preview/assets/editor-model.js');
  const template = {widgets:[{id:'w-card',type:'hero',heading:'Coffee'}],
    sections:['crumb','intro','producer','w-card','related'],
    sectionStyles:{'w-card':{align:'center'}}, mobile:{sectionStyles:{'w-card':{spacing:'airy'}}}};
  const sku = {sections:['crumb','intro','related','producer','w-card'],
    mobile:{sections:['crumb','intro','w-card','related','producer'],sectionStyles:{'w-card':{crop:'square'}}}};
  const document = doc({'product:bom-jesus':sku,product:template});
  assert.deepEqual(validateDocument(document),document);
  assert.deepEqual(orderedSections(PAGES.product,sku,template,true),sku.mobile.sections);
  assert.deepEqual(effectiveStyle(sku,template,'w-card',true),{align:'center',spacing:'airy',crop:'square'});
  assert.deepEqual(effectiveStyle(sku,template,'w-card'),{align:'center'});
  const invalid = page => assert.throws(()=>validateDocument(doc({shop:page})),TypeError);
  invalid({mobile:{sections:['information','catalogue','hero']}});
  invalid({mobile:{sectionStyles:{catalogue:{spacing:'airy'}}}});
  invalid({sectionStyles:{hero:{spacing:'url(data:style)'}}});
  invalid({sectionStyles:{noSuchSection:{width:'wide'}}});
  invalid({sectionStyles:{hero:{arrangement:'split'}}});
  invalid({widgets:[{id:'w-local',type:'cards'}],sectionStyles:{'w-local':{arrangement:'reverse'}}});
  const arr = {'w-card':{arrangement:'split'}};
  assert.doesNotThrow(()=>validateDocument(doc({product:template,'product:bom-jesus':{sectionStyles:arr}})));
  assert.throws(()=>validateDocument(doc({product:template,'product:bom-jesus':{mobile:{sectionStyles:arr}}})),/inherited product widget/);
  const previous = doc({shop:{sections:['hero','catalogue','information']}});
  const crossing = doc({shop:{sections:['information','catalogue','hero']}});
  assert.throws(()=>validateLayoutChanges(previous,crossing),/fixed position/);
  // Existing historical designs remain readable, editable and restorable.
  assert.deepEqual(validateDocument(crossing),crossing);
  assert.doesNotThrow(()=>validateLayoutChanges(crossing,crossing));
  const inserted = doc({shop:{widgets:[{id:'w-story',type:'text'}], sections:['w-story','hero','catalogue','information']}});
  assert.doesNotThrow(()=>validateLayoutChanges(previous,inserted));
  assert.throws(()=>validateLayoutChanges(inserted,doc({shop:{...inserted.pages.shop,sections:['hero','catalogue','w-story','information']}})),/fixed position/);
});

test('new catalogue products resolve their own metadata, protected media and inherited sharing defaults',()=>{
  const id = 'winter-filter', digest = 'c'.repeat(64);
  const product = {id,name:'Winter Filter',notes:['Fig','Cocoa'],image:'/consumer-product-media/' + digest};
  const key = 'product:' + id;
  const pages = {product:{meta:{socialTitle:'{product}, brewed in Norwich',robots:'noindex'}},
    [key]:{fields:{'product-title':'Winter filter roast'},meta:{socialImageAlt:'The winter release'}}};
  const seo = resolvePageSeo(key,{pages,product});
  assert.equal(seo.title,'Winter filter roast | Strangers Coffee');
  assert.equal(seo.description,'Tasting notes of Fig, Cocoa.');
  assert.equal(seo.socialImage,'https://preview.staffstrangerscoffee.com/consumer-product-media/' + digest);
  assert.equal(seo.socialTitle,'Winter filter roast, brewed in Norwich');
  assert.equal(resolvePageSeo('product',{pages,product}).socialTitle,'Winter Filter, brewed in Norwich');
  const skuMeta = pages[key].meta;
  skuMeta.socialTitle = 'Literal {product} for the winter range';
  assert.equal(resolvePageSeo(key,{pages,product}).socialTitle,skuMeta.socialTitle);
  assert.equal(seo.socialImageAlt,'The winter release');
  assert.equal(seo.canonical,'https://preview.staffstrangerscoffee.com/coffee/p/winter-filter/');
  assert.equal(seo.product.sku,id);
  product.image = 'https://unrelated.example/product.jpg';
  assert.match(resolvePageSeo(key,{pages,product}).socialImage,/\/consumer-preview\/assets\/roastery\.webp$/);
});

test('search visibility honours page and template settings only on an explicitly enabled public host',()=>{
  const pages = {product:{meta:{robots:'noindex'}},'product:rocko':{meta:{robots:'index'}}};
  const enabled = {pages,origin:'https://strangerscoffee.com',allowIndexing:true};
  assert.equal(resolvePageSeo('home',enabled).robots,'index, follow');
  assert.equal(resolvePageSeo('product:bom-jesus',enabled).robots,'noindex, follow');
  assert.equal(resolvePageSeo('product:rocko',enabled).robots,'index, follow');
  assert.equal(resolvePageSeo('account',enabled).robots,'noindex, nofollow');
  assert.equal(resolvePageSeo('checkout',enabled).robots,'noindex, nofollow');
  assert.equal(resolvePageSeo('home',{...enabled,allowIndexing:false}).robots,'noindex, nofollow');
  assert.equal(resolvePageSeo('home',{pages,allowIndexing:true}).robots,'noindex, nofollow');
  const preview = resolvePageSeo('product:bom-jesus',{pages});
  assert.equal(preview.launchRobots,'noindex, follow');
  assert.equal(preview.robots,'noindex, nofollow');
});
