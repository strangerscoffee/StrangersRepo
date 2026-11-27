import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startEditorFixture, openLocalBrowser, admin, retail, wholesale, editorPath } from "./editor-integration-fixture.mjs";

let fixture, browser;
before(async () => {
  fixture = await startEditorFixture();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await fixture?.stop(); });

const localBrowser = (viewport, signedIn) => openLocalBrowser(fixture, browser, viewport, signedIn);

async function change(action, body, method = "POST") {
  const response = await fixture.request(admin, editorPath + action, method, body, fixture.cookie);
  assert.ok(response.ok, action + " returned " + response.status + (response.ok ? "" : " " + await response.text()));
  return response.json();
}

test("a retail visitor sees only the published design, and the checkout and product controls survive publishing and restoring", {timeout: 90000}, async () => {
  const initial = await change("", undefined, "GET");
  const bytes = await readFile(new URL("../public/consumer-preview/assets/roastery.webp", import.meta.url));
  const {media} = await change("/media", {name:"Roastery photo.webp", type:"image/webp", data:bytes.toString("base64")});
  const imagePath = "/consumer-media/" + media.id;
  const customPath = "/pages/roastery-visit/";
  const customKey = "custom:roastery-visit";
  const first = structuredClone(initial.draft);
  first.pages.home = {
    theme: "sage", sections: ["w-feature", "hero"],
    widgets: [{id: "w-feature", type: "callout", heading: "Inside the Norwich roastery", body: "Speciality coffee roasted on Dove Street.",
      image:"media:" + media.id, alt:"Coffee roaster"}],
  };
  first.pages[customKey] = {title:"Roastery visit", inNavigation:true, sections:["w-visit"],
    widgets:[{id:"w-visit",type:"callout",heading:"Tasting at Dove Street",body:"Visit the roastery."}]};
  const saved = await change("", {revision: initial.revision, document: first}, "PUT");
  const context = await localBrowser({width: 393, height: 852});
  try {
    const page = await context.newPage();
    await page.goto(retail);
    const feature = page.getByRole("heading", {name: "Inside the Norwich roastery", exact: true});
    assert.equal(await feature.count(), 0);
    assert.equal((await fixture.request(retail, imagePath)).status, 404);
    assert.equal((await fixture.request(retail, customPath)).status, 404);
    for (const origin of [wholesale, retail]) {
      const privateRead = await fixture.request(origin, editorPath, "GET", undefined, fixture.cookie);
      assert.equal(privateRead.status, 404);
    }
    const published = await change("/publish", {revision: saved.revision});
    assert.equal((await fixture.request(retail, imagePath, "HEAD")).status, 200);
    await page.reload();
    await feature.waitFor();
    await page.getByRole("link", {name:"Roastery visit", exact:true}).click();
    await page.getByRole("heading", {name:"Tasting at Dove Street"}).waitFor();
    await page.goto(retail);
    await page.locator("[data-find]:visible").first().click();
    await page.locator("#finder-form").waitFor();
    assert.equal(await page.locator("#finder-form button[type=submit]").isDisabled(), true);
    await page.goto(retail + "/coffee/p/brazil-fazenda-bom-jesus-natural/");
    await page.locator("main h1").filter({hasText: "Bom Jesus"}).waitFor();
    assert.equal(await feature.count(), 0);
    await page.evaluate(() => localStorage.setItem("strangers-coffee-proposal.cart.v1", JSON.stringify([
      {id: "house-blend", size: "250g", grind: "Whole bean", qty: 1},
    ])));
    await page.goto(retail + "/checkout/");
    await page.locator("#retail-checkout-form").waitFor();
    await page.locator('[name="name"]').fill("An example buyer");
    assert.equal(await page.locator('[name="name"]').inputValue(), "An example buyer");
    const next = structuredClone(first);
    next.pages.home.widgets[0].heading = "Second release";
    delete next.pages.home.widgets[0].image;
    delete next.pages[customKey];
    const edited = await change("", {revision: published.revision, document: next}, "PUT");
    assert.equal((await fixture.request(retail, customPath, "HEAD")).status, 200);
    const replaced = await change("/publish", {revision: edited.revision});
    assert.equal((await fixture.request(retail, customPath, "HEAD")).status, 404);
    assert.equal((await fixture.request(retail, imagePath, "HEAD")).status, 404);
    const restored = await change("/restore", {revision: replaced.revision, version: published.publishedRevision});
    await page.goto(retail);
    await page.getByRole("heading", {name: "Second release", exact: true}).waitFor();
    await change("/publish", {revision: restored.revision});
    assert.equal((await fixture.request(retail, customPath, "HEAD")).status, 200);
    assert.equal((await fixture.request(retail, imagePath, "HEAD")).status, 200);
    await page.reload();
    await feature.waitFor();
    assert.equal(await page.getByRole("heading", {name: "Second release", exact: true}).count(), 0);
  } finally {
    await context.close();
  }
});

for (const [size, viewport] of [["desktop", {width: 1440, height: 1000}], ["mobile", {width: 393, height: 852}]]) {
  test(`admin editor can select and edit the actual canvas, save it and protect unsaved changes on ${size}`, {timeout: 90000}, async () => {
    const context = await localBrowser(viewport, true);
    const page = await context.newPage();
    try {
      page.setDefaultTimeout(12000);
      await page.goto(admin + "/#consumer/editor");
      const scopes = page.getByRole("combobox", {name: "Storefront page or surface"});
      await scopes.selectOption("about");
      const canvas = page.frameLocator('iframe[title^="Editable storefront preview"]');
      const heading = canvas.locator("main h1").first();
      await heading.click();
      const selected = page.getByRole("combobox", {name:"Page content", exact:true});
      const fieldText = await selected.locator("option:checked").textContent();
      assert.notEqual(await selected.inputValue(), "");
      const editor = page.getByRole("textbox", {name: fieldText, exact: true});
      const value = size === "desktop" ? "Roasting in Norwich" : "Our Norwich roastery";
      await editor.fill(value);
      await heading.filter({hasText: value}).waitFor();
      assert.equal(await page.locator('iframe[title^="Editable storefront preview"]').getAttribute("sandbox"), "allow-same-origin");
      assert.equal(await canvas.locator("script").count(), 0);
      const switcher = page.locator("#consumerSection");
      if (await switcher.isVisible()) await switcher.selectOption("orders");
      else await page.locator('#consumerTabs [data-id="orders"]').click();
      const confirmation = page.locator("#sheet");
      await confirmation.getByRole("button", {name: "Cancel", exact: true}).click();
      assert.equal(await editor.inputValue(), value);
      await page.getByRole("button", {name:"Save draft", exact: true}).click();
      await page.getByText("Draft saved. You can return to it before publishing.", {exact:true}).waitFor();
      const shopper = await context.newPage();
      await shopper.goto(retail + "/about/");
      assert.notEqual(await shopper.locator("main h1").first().textContent(), value);
      await page.bringToFront();
      await page.getByRole("button", {name:"Publish", exact: true}).click();
      await Promise.all([
        page.waitForResponse(response => response.url() === admin + editorPath + "/publish" && response.status() === 200),
        confirmation.getByRole("button", {name: "Publish storefront", exact: true}).click(),
      ]);
      await shopper.reload();
      await shopper.getByRole("heading", {name:value, exact:true}).waitFor();
      await page.bringToFront();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, "Editor overflows the " + size + " viewport by " + overflow + " px");
      if (process.env.CONSUMER_SCREENSHOT_DIR) {
        await scopes.selectOption("home");
        await canvas.locator("main h1").waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
        await mkdir(process.env.CONSUMER_SCREENSHOT_DIR, {recursive:true});
        await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR + "/site-editor-" + size + ".png"});
        if (size === "mobile") {
          await page.getByRole("button", {name:"Design", exact:true}).click();
          const tools = page.getByRole("region", {name:"Page inspector"});
          await tools.evaluate(el => el.scrollIntoView({block:"start", behavior:"instant"}));
          await page.screenshot({path:process.env.CONSUMER_SCREENSHOT_DIR + "/site-editor-mobile-design.png"});
        }
      }
    } finally {
      await context.close();
    }
  });
}

test("an admin can build a custom page from a template, reopen its draft and remove the page in the editor", {timeout: 90000}, async () => {
  const context = await localBrowser({width:1440, height:1000}, true);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(admin + "/#consumer/editor");
    const selector = page.getByRole("combobox", {name:"Storefront page or surface"});
    const canvas = page.frameLocator('iframe[title^="Editable storefront preview"]');
    await page.getByRole("button", {name:"Add page", exact:true}).click();
    await page.getByLabel("Page name", {exact:true}).fill("Weekend roastery");
    await page.getByLabel("Include in the storefront footer").check();
    await page.getByRole("button", {name:"Create page", exact:true}).click();
    await canvas.getByRole("heading", {name:"Weekend roastery", exact:true}).waitFor();
    assert.equal(await selector.inputValue(), "custom:weekend-roastery");
    await page.getByRole("button", {name:"Design", exact:true}).click();
    await page.getByRole("combobox", {name:/^Page theme/}).selectOption("espresso");
    await page.getByRole("combobox", {name:/^Template/}).selectOption("visit");
    await page.getByRole("button", {name:"Insert template", exact:true}).click();
    await canvas.getByRole("heading", {name:"Come in for a coffee"}).waitFor();
    await page.getByRole("button", {name:"Photos", exact:true}).click();
    const bytes = await readFile(new URL("../public/consumer-preview/assets/pottergate.webp", import.meta.url));
    const [upload] = await Promise.all([
      page.waitForResponse(response => response.url() === admin + editorPath + "/media" && response.request().method() === "POST"),
      page.getByLabel("Upload a photo", {exact:true}).setInputFiles({name:"Pottergate morning.webp", mimeType:"image/webp", buffer:bytes}),
    ]);
    const {media} = await upload.json();
    await page.getByRole("button", {name:"Use photo · " + media.name, exact:true}).click();
    await canvas.locator('img[src$="/media/' + media.id + '"]').waitFor();
    await page.getByRole("button", {name:"Save draft", exact:true}).click();
    await page.getByText("Draft saved. You can return to it before publishing.", {exact:true}).waitFor();
    assert.equal((await fixture.request(retail, "/pages/weekend-roastery/")).status, 404);
    await page.reload();
    await selector.selectOption("custom:weekend-roastery");
    await canvas.getByRole("heading", {name:"Come in for a coffee"}).waitFor();
    await canvas.locator('img[src$="/media/' + media.id + '"]').waitFor();
    assert.equal(await canvas.locator("html").getAttribute("data-consumer-theme"), "espresso");
    await page.getByRole("button", {name:"Remove page", exact:true}).click();
    await page.locator("#sheet").getByRole("button", {name:"Remove page", exact:true}).click();
    assert.equal(await selector.inputValue(), "home");
    await page.getByRole("button", {name:"Save draft", exact:true}).click();
    await page.getByText("Draft saved. You can return to it before publishing.", {exact:true}).waitFor();
    await page.reload();
    await selector.waitFor();
    assert.equal(await selector.locator('option[value="custom:weekend-roastery"]').count(), 0);
    await page.getByRole("button", {name:"Photos", exact:true}).click();
    await page.getByRole("button", {name:"Delete " + media.name, exact:true}).click();
    await page.locator("#sheet").getByRole("button", {name:"Delete photo", exact:true}).click();
    await page.getByText("Photo deleted from the library.", {exact:true}).waitFor();
  } finally {
    await context.close();
  }
});

test("published product merchandising follows a coffee from its shoppable shelf to the real cart", {timeout: 60000}, async () => {
  const initial = await change("", undefined, "GET");
  const draft = structuredClone(initial.draft);
  const title = "Bom Jesus from Alta Mogiana";
  const productTitle = "Bom Jesus | The Norwich roastery";
  const description = "Discover how we roast and brew our coffees in Norwich.";
  draft.pages.product = {meta:{description}};
  draft.pages["product:bom-jesus"] = {meta:{title: productTitle}, fields:{"product-title":title, "product-image-alt":"Our Bom Jesus coffee", "note-1":"Cocoa"}};
  draft.pages.home = {sections:["w-coffees", "hero"], widgets:[
    {id:"w-coffees", type:"coffee-shelf", heading:"Roastery favourites", items:["rocko", "bom-jesus"]},
  ]};
  const saved = await change("", {revision:initial.revision, document:draft}, "PUT");
  await change("/publish", {revision:saved.revision});
  const context = await localBrowser({width:393, height:852});
  try {
    const page = await context.newPage();
    await page.goto(retail);
    const cards = page.locator('[data-consumer-widget="w-coffees"] .consumer-retail-card');
    await cards.nth(1).waitFor();
    assert.match(await cards.nth(0).textContent(), /Rocko/);
    assert.match(await cards.nth(1).textContent(), /Cocoa.*£10.50/);
    assert.equal(await cards.nth(1).getByRole("heading").textContent(), title);
    await cards.nth(1).click();
    await page.getByRole("heading", {name:title, level:1}).waitFor();
    assert.equal(await page.title(), productTitle);
    assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), description);
    await page.locator('#retail-product-grind').selectOption("Filter / Medium");
    await page.getByRole("button", {name:"Add to cart", exact:true}).click();
    await page.locator(".cart-line").getByText(title, {exact:true}).waitFor();
    const lines = await page.evaluate(() => JSON.parse(localStorage.getItem("strangers-coffee-proposal.cart.v1")));
    assert.deepEqual(lines, [{id:"bom-jesus", size:"250g", grind:"Filter / Medium", qty:1}]);
  } finally {
    await context.close();
  }
});

test("published buyer-flow wording preserves finder choices, checkout identity, pricing and order payload", {timeout:60000}, async () => {
  const initial = await change("", undefined, "GET");
  const draft = {schema:1, theme:"heritage", pages:{
    finder:{fields:{"brew-filter-medium-label":"My pour-over","taste-chocolatey-label":"Cocoa and nuts","add-label":"Choose bag"}},
    cart:{fields:{checkout:"Go to delivery", subtotal:"Coffee subtotal", total:"Cart total"}},
    checkout:{fields:{"name-label":"Name for delivery","delivery-option":"Post to my door","collection-option":"Pick up in Norwich",
      "review-action":"Check my order","edit-action":"Change delivery details","place-action":"Confirm this test order",
      "processing-heading":"Preparing the order summary","confirmed-heading":"Your preview order is ready to view"}},
  }};
  const saved = await change("", {revision:initial.revision,document:draft},"PUT");
  await change("/publish", {revision:saved.revision});
  const context = await localBrowser({width:393,height:852});
  let respond;
  try {
    const arrived = new Promise(resolve => {
      context.route("**/api/retail/orders", route => {
        const request = route.request();
        resolve({body:request.postDataJSON(),session:request.headers()["x-retail-profile-session"]});
        return new Promise(finish => {
          respond = async () => {
            await route.fulfill({json:{order:{reference:"SC-ABCDEF12",method:"delivery",createdAt:"2026-11-25T10:00:00Z",
              status:"placed",lines:[{id:"bom-jesus",size:"250g",grind:"Filter / Medium",qty:1,unitPrice:1050}],
              pricing:{subtotal:1050,shipping:300,total:1350}}}});
            finish();
          };
        });
      });
    });
    const page=await context.newPage();
    await page.goto(retail);
    await page.locator("[data-find]:visible").first().click();
    await page.getByRole("radio",{name:/My pour-over/}).check();
    assert.equal(await page.locator('input[name="brew"]:checked').inputValue(),"Filter / Medium");
    await page.getByRole("button",{name:"Continue to taste"}).click();
    await page.getByRole("radio",{name:/Cocoa and nuts/}).check();
    await page.getByRole("button",{name:"Find my match"}).click();
    await page.locator(".finder-result-head").getByText("My pour-over",{exact:true}).waitFor();
    const bag=page.locator(".finder-best").getByRole("button",{name:/Choose bag.*250 g.*£10\.50/});
    await bag.click();
    assert.equal(await page.getByText("Coffee subtotal",{exact:true}).locator("..").locator("dd").textContent(),"£10.50");
    assert.equal(await page.getByText("Cart total",{exact:true}).locator("..").locator("dd").textContent(),"£13.50");
    await page.getByRole("link",{name:"Go to delivery"}).click();
    await page.getByRole("radio",{name:/Pick up in Norwich/}).check();
    assert.equal(await page.locator('input[name="method"]:checked').inputValue(),"collection");
    await page.getByRole("radio",{name:/Post to my door/}).check();
    await page.getByRole("button",{name:"Fill sample details"}).click();
    await page.getByLabel("Name for delivery",{exact:true}).fill("Sample Customer");
    await page.getByRole("button",{name:"Check my order"}).click();
    await page.getByRole("button",{name:"Change delivery details"}).click();
    assert.equal(await page.getByLabel("Name for delivery",{exact:true}).inputValue(),"Sample Customer");
    await page.getByRole("button",{name:"Check my order"}).click();
    await page.getByRole("button",{name:"Confirm this test order"}).click();
    const {body,session}=await arrived;
    assert.equal(session,"guest");
    assert.equal(body.method,"delivery");
    assert.equal(body.deliveryService,"royal-mail-tracked-48");
    assert.equal(body.contact.name,"Sample Customer");
    assert.deepEqual(body.lines,[{id:"bom-jesus",size:"250g",grind:"Filter / Medium",qty:1,expectedUnitPrice:1050}]);
    await page.getByRole("heading",{name:"Preparing the order summary"}).waitFor();
    await respond(); respond=null;
    await page.getByRole("heading",{name:"Your preview order is ready to view"}).waitFor();
    assert.equal(await page.locator(".retail-checkout-reference").textContent(),"SC-ABCDEF12");
    assert.equal(await page.locator(".grand-total dd").textContent(),"£13.50");
    await page.getByText("No payment was taken and no coffee will be sent.").waitFor();
  } finally {
    if (respond) await respond();
    await context.close();
  }
});
