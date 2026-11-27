import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {admin,retail,editorPath,openLocalBrowser,startEditorFixture} from './editor-integration-fixture.mjs';

let browser,fixture;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

async function show(viewport) {
  const context = await openLocalBrowser(fixture,browser,viewport,true,{hasTouch:viewport.width < 500});
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(admin + '/#consumer/editor');
  const seoTab = page.getByRole('button',{name:'SEO',exact:true});
  await seoTab.click();
  return {context,page,seoTab,panel:page.getByRole('region',{name:'Page SEO'}),pages:page.getByLabel('Storefront page or surface')};
}
async function capture(page,name) {
  if (!process.env.CONSUMER_SCREENSHOT_DIR) return;
  await mkdir(process.env.CONSUMER_SCREENSHOT_DIR,{recursive:true});
  await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR + '/seo-' + name + '.png',animations:'disabled'});
}
test('search and sharing edits update the correct preview, save privately and publish to the consumer head', {timeout:90000}, async () => {
  const {context,page,panel,pages} = await show({width:1440,height:960});
  try {
    const title = panel.getByLabel('Search title',{exact:true});
    assert.match(await title.getAttribute('placeholder'),/Norwich/);
    await title.fill('Coffee roasted in Norwich | Strangers');
    await panel.getByLabel('Search description',{exact:true}).fill('Find a single origin for your morning brew, roasted at our Norwich roastery.');
    assert.equal(await panel.locator('.ce-seo-search-card strong').textContent(),'Coffee roasted in Norwich | Strangers');
    await capture(page,'desktop-search');
    await panel.getByRole('button',{name:'Sharing',exact:true}).click();
    assert.equal(await panel.locator('.ce-seo-social-card strong').textContent(),'Coffee roasted in Norwich | Strangers');
    await panel.getByLabel('Sharing title',{exact:true}).fill('At the Norwich roastery');
    await panel.getByLabel('Sharing image',{exact:true}).selectOption('asset:pottergate.webp');
    await panel.getByLabel('Image description',{exact:true}).fill('The Pottergate café in Norwich');
    assert.match(await panel.locator('.ce-seo-social-card img').getAttribute('src'),/^\/api\/admin\/consumer\/editor\/assets\/pottergate\.webp$/);
    await panel.getByRole('button',{name:'Indexing',exact:true}).click();
    const canonical = panel.getByLabel('Canonical address',{exact:true});
    await canonical.fill('https://outside.example/');
    assert.equal(await canonical.getAttribute('aria-invalid'),'true');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    const current = await fixture.request(admin,editorPath,'GET',undefined,fixture.cookie).then(res => res.json());
    assert.equal(current.draft.pages.home?.meta?.title,undefined);
    await canonical.fill('/about/');
    await panel.getByLabel('Search visibility at launch',{exact:true}).selectOption('noindex');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.getByText('Draft saved. You can return to it before publishing.').waitFor();
    const shopper = await context.newPage();
    await shopper.goto(retail);
    assert.doesNotMatch(await shopper.title(), /Coffee roasted in Norwich \| Strangers$/);
    await page.getByRole('button',{name:'Publish',exact:true}).click();
    await page.locator('#sheet').getByText('Sharing image',{exact:true}).waitFor();
    await page.locator('#sheet').getByRole('button',{name:'Publish storefront'}).click();
    await page.getByText('Published to the consumer storefront.').waitFor();
    await shopper.reload();
    assert.equal(await shopper.title(),'Coffee roasted in Norwich | Strangers');
    assert.equal(await shopper.locator('meta[property="og:title"]').getAttribute('content'),'At the Norwich roastery');
    assert.equal(await shopper.locator('link[rel=canonical]').getAttribute('href'),retail+'/about/');
    assert.match(await shopper.locator('meta[name=robots]').getAttribute('content'),/noindex/);

    await pages.selectOption('checkout');
    assert.equal(await panel.getByLabel('Browser title',{exact:true}).count(),1);
    assert.equal(await panel.getByRole('button',{name:'Indexing'}).count(),0);
    await pages.selectOption('finder');
    assert.equal(await page.getByRole('button',{name:'SEO',exact:true}).count(),0);
  } finally { await context.close(); }
});

test('a phone editor previews product template inheritance and clears a single product SEO override', {timeout:90000}, async () => {
  const {context,page,panel,pages} = await show({width:393,height:852});
  try {
    await pages.selectOption('product');
    await panel.getByLabel('Search title',{exact:true}).fill('Coffee from our roastery');
    await panel.getByRole('button',{name:'Indexing',exact:true}).click();
    assert.equal(await panel.getByLabel('Canonical address',{exact:true}).count(),0);
    await pages.selectOption('product:bom-jesus');
    await panel.getByRole('button',{name:'Search',exact:true}).click();
    const title = panel.getByLabel('Search title',{exact:true});
    assert.equal(await title.getAttribute('placeholder'),'Coffee from our roastery');
    await title.fill('Brazil Fazenda Bom Jesus | Strangers');
    await panel.getByRole('button',{name:'Use automatic search title'}).click();
    assert.equal(await title.inputValue(),'');
    assert.equal(await panel.locator('.ce-seo-search-card strong').textContent(),'Coffee from our roastery');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await title.inputValue(),'Brazil Fazenda Bom Jesus | Strangers');
    await panel.getByRole('button',{name:'Sharing',exact:true}).click();
    await panel.locator('.ce-seo-social-card img').waitFor();
    await page.locator('.ce-inspector').evaluate(el => el.scrollIntoView({block:'start'}));
    await capture(page,'mobile-product');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    for (const width of [320,393,880,1024,1440]) {
      await page.setViewportSize({width,height:852});
      const tabsFit = await page.locator('.ce-inspector-tabs button:visible').evaluateAll(buttons => buttons.every(b => {
        const glyphs = document.createRange();
        glyphs.selectNodeContents(b);
        return glyphs.getClientRects().length === 1 && b.clientHeight >= 40 && b.scrollWidth <= b.clientWidth + 1;
      }));
      assert.ok(tabsFit, 'Inspector tool names fit their buttons at ' + width + 'px');
    }
  } finally { await context.close(); }
});

test('an admin can edit a custom subpage and a canonical reference identifies the source before removal', {timeout:90000}, async () => {
  const current = await fixture.request(admin,editorPath,'GET',undefined,fixture.cookie).then(res => res.json());
  current.draft.pages['custom:roaster-notes'] = {title:'Roaster notes'};
  current.draft.pages.about = {...current.draft.pages.about,meta:{canonical:'/pages/roaster-notes/'}};
  const saved = await fixture.request(admin,editorPath,'PUT',{revision:current.revision,document:current.draft},fixture.cookie);
  assert.equal(saved.status,200);
  const {context,page,panel,pages} = await show({width:1280,height:900});
  try {
    await pages.selectOption('custom:roaster-notes');
    await panel.getByLabel('Search title',{exact:true}).fill('From our roaster');
    await panel.getByRole('button',{name:'Indexing',exact:true}).click();
    assert.equal(await panel.getByLabel('Canonical address',{exact:true}).getAttribute('placeholder'),'/pages/roaster-notes/');
    await page.getByRole('button',{name:'Remove page',exact:true}).click();
    await page.getByText(/Remove the link to this page from About/i).waitFor();
    await page.getByRole('button',{name:'Publish',exact:true}).click();
    await page.locator('#sheet').getByRole('button',{name:'Publish storefront'}).click();
    await page.getByText('Published to the consumer storefront.').waitFor();
    const shopper = await context.newPage();
    await shopper.goto(retail+'/pages/roaster-notes/');
    assert.equal(await shopper.title(),'From our roaster');
    await shopper.goto(retail+'/about/');
    assert.equal(await shopper.locator('link[rel=canonical]').getAttribute('href'),retail+'/pages/roaster-notes/');
  } finally { await context.close(); }
});
