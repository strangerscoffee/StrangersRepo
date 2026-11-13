// Errors on staff devices reach the admin section: a page that throws reports it (public/errors.js → POST
// /api/errors), it shows under Admin → Activity → Errors with where it happened, and an ordinary visit reports
// nothing. Run with `npm run test:e2e` (needs Playwright).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer, SETUP_CODE } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require("playwright")); } catch { ({ chromium, devices } = await import("playwright")); }

let srv, browser, ADMIN;
const errors = async () => (await (await fetch(srv.base + "/api/admin/activity?kind=errors", { headers: { cookie: ADMIN } })).json()).items;
before(async () => {
  srv = await startServer();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const r = await fetch(srv.base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Will Owner", username: "will", password: "admin-pass-1", code: SETUP_CODE }) });
  ADMIN = r.headers.getSetCookie().find((c) => /^sfbb_session=[\w-]/.test(c)).split(";")[0];
  await fetch(srv.base + "/api/db/set", { method: "POST", headers: { "content-type": "application/json", cookie: ADMIN }, body: JSON.stringify({ path: "settings/main", data: { units: [], opening: [{ id: "o1", t: "Hands washed" }], closing: [], weekly: [], closedDays: [], info: {}, startDate: "2020-01-01", startSet: true } }) });
});
after(async () => { await browser?.close(); await srv?.stop(); });

test('sign-in branding retries once; a persistent logo or favicon failure stays non-blocking and is reported', {timeout:45000}, async()=>{
  for(const asset of ['/mark.svg','/favicon.ico','/wholesale-preview/images/logo.svg']) for(const kind of ['image','icon']) for(const recover of [true,false]){
    const context=await browser.newContext(),page=await context.newPage();let requests=0;const reports=[];
    await page.route('**'+asset+'*',async route=>{if(!new URL(route.request().url()).searchParams.has('brand-test'))return route.continue();requests++;if(recover&&requests>1)await route.continue();else await route.fulfill({status:503,body:'temporarily unavailable'});});
    await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({status:200,contentType:'application/json',body:'{}'});});
    try{
      await page.goto(srv.base+'/signin');await page.locator('#signin').waitFor();
      await page.evaluate(({kind,asset})=>{const node=document.createElement(kind==='image'?'img':'link');node.id='brand-retry-test';if(kind==='image'){node.alt='Strangers';node.src=asset+'?brand-test=1';document.body.append(node)}else{node.rel='icon';let href=location.origin+asset+'?brand-test=1';Object.defineProperty(node,'href',{get:()=>href,set:value=>{href=value}});document.head.append(node)}},{kind,asset});
      if(kind==='icon')await page.evaluate(()=>document.getElementById('brand-retry-test').dispatchEvent(new Event('error'))); // favicon error delivery varies across engines
      await page.waitForFunction(()=>(document.getElementById('brand-retry-test')?.tagName==='IMG'?document.getElementById('brand-retry-test').src:document.getElementById('brand-retry-test')?.href)?.includes('sc-asset-retry=1'));
      if(recover&&kind==='image')await page.waitForFunction(()=>document.getElementById('brand-retry-test').naturalWidth>0);
      if(!recover){
        if(kind==='icon')await page.evaluate(()=>document.getElementById('brand-retry-test').dispatchEvent(new Event('error')));
        for(let attempt=0;attempt<40&&!reports.some(r=>r.message==="Couldn't load "+asset);attempt++)await page.waitForTimeout(25);
      }
      assert.equal(await page.locator('#sc-error').count(),0,'image errors never cover the sign-in form');
      assert.equal(await page.locator('#signin').isVisible(),true);
      if(kind==='image')assert.equal(requests,2,'only one fresh retry');
      if(recover)assert.deepEqual(reports,[],'a recovered logo does not leave an unresolved error');
      else assert.equal(reports.filter(r=>r.message==="Couldn't load "+asset).length,1,'one persistent failure is retained for admins');
    }finally{await context.close()}
  }
});

test("an ordinary visit reports nothing; a page that throws reports it, and admins see where", async () => {
  const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  const page = await ctx.newPage();
  for (const path of ["/", "/rota/#mine", "/admin"]) {
    await page.goto(srv.base + path); await page.waitForTimeout(1500);
    assert.equal(await page.locator("#sc-error").count(), 0, "no error card on " + path);
  }
  assert.deepEqual(await errors(), [], "no false alarms from normal pages");

  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor();
  await page.evaluate(() => setTimeout(() => { throw new Error("Test: something broke on Today"); }, 0));
  await page.evaluate(() => { Promise.reject(new Error("Test: a save that nobody caught")); });
  // The person sees a card with the error's code, what and where, to screenshot.
  const card = page.locator("#sc-error");
  await card.waitFor();
  const shown = (await card.textContent()) || "";
  const code = (shown.match(/E-[0-9A-Z]{6}/) || [])[0];
  assert.ok(code, shown);
  assert.match(shown, /Something went wrong/);
  assert.match(shown, /Test: something broke on Today/);
  assert.match(shown, /Take a screenshot of this/);
  assert.match(shown, /and 1 more error on this page/, "the second error adds to the same card");
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/error-card-phone.png" });
  let list = [];
  for (let i = 0; i < 20 && list.length < 2; i++) { await page.waitForTimeout(250); list = await errors(); }
  const thrown = list.find((e) => /Test: something broke on Today/.test(e.text));
  assert.ok(thrown, JSON.stringify(list));
  assert.match(thrown.where, /Kitchen Diary · \/ · Will Owner · iPhone · Safari/);
  assert.equal(thrown.code, code, "the code on the screen is the one the admin section lists");
  await card.locator("button", { hasText: "Hide" }).click();
  assert.equal(await card.count(), 0);
  assert.ok(list.some((e) => e.text === "Unhandled: Test: a save that nobody caught"));

  // The admin section's Errors tab lists it, with its details folded.
  const a = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await a.addCookies([{ name, value, url: srv.base }]);
  const ap = await a.newPage();
  await ap.goto(srv.base + "/admin#overview");
  await ap.locator(".item, .row", { hasText: /errors? on the site in the last day/ }).first().waitFor();
  await ap.locator("button", { hasText: "See errors" }).click();
  await ap.locator(".item", { hasText: "Test: something broke on Today" }).waitFor();
  const item = ap.locator(".item", { hasText: "Test: something broke on Today" });
  await item.locator("summary", { hasText: "Report" }).click();
  const rep = (await item.locator("pre").textContent()) || "";
  assert.match(rep, new RegExp(`^Strangers Coffee error ${code}\nWhat: {3}Error: Test: something broke on Today|^Strangers Coffee error ${code}\nWhat: {3}Uncaught Error: Test`));
  assert.match(rep, /Who: {4}Will Owner · iPhone · Safari/);
  await item.locator("button", { hasText: "Copy report" }).waitFor();
  // Searching for the code finds it.
  await ap.fill("#fq", code);
  await ap.locator(".item", { hasText: "Test: something broke on Today" }).waitFor();
  if (process.env.SHOTS) await ap.screenshot({ path: process.env.SHOTS + "/error-report-ipad.png", fullPage: true });
  await ctx.close(); await a.close();
});

test("only the site's own errors count; a dropped signal is noted but not shown; the diary opens when it returns", async () => {
  const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
  const [name, value] = ADMIN.split("=");
  await ctx.addCookies([{ name, value, url: srv.base }]);
  // The first "who's signed in?" doesn't get through, as when 4G drops just as the diary opens.
  let failed = 0;
  await ctx.route("**/api/auth/me", (r) => (failed++ === 0 ? r.abort("internetdisconnected") : r.continue()));
  const page = await ctx.newPage();
  const before = (await errors()).length;
  await page.goto(srv.base + "/");
  await page.locator("#openList label", { hasText: "Hands washed" }).waitFor({ timeout: 15000 });
  assert.ok(failed >= 2, "it asked again");

  // Another site's script that's blocked or fails (like Cloudflare's analytics beacon), another site's "Script error.",
  // and an error thrown from a file elsewhere: none reported, no card.
  await page.evaluate(() => {
    const s = document.createElement("script"); s.src = "https://static.example.invalid/beacon.min.js"; document.head.append(s);
    dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "moz-extension://abc/content.js", lineno: 1, colno: 1 }));
  });
  // A request nothing caught when the signal dropped: noted for the admin section, but no card on the screen.
  await page.evaluate(() => { Promise.reject(new TypeError("Load failed")); });
  let list = [];
  for (let i = 0; i < 20 && !list.some((e) => e.text === "Unhandled: Load failed"); i++) { await page.waitForTimeout(250); list = await errors(); }
  assert.ok(list.some((e) => e.text === "Unhandled: Load failed"), JSON.stringify(list.map((e) => e.text)));
  assert.deepEqual(list.slice(0, list.length - before).map((e) => e.text).filter((t) => /beacon|Script error|boom/.test(t)), [], "nothing from elsewhere");
  assert.equal(await page.locator("#sc-error").count(), 0, "no card for any of them");
  await ctx.close();
});


test('unattributed browser autofill noise is ignored while the same message with an app frame is retained',async()=>{
 const context=await browser.newContext(),page=await context.newPage(),reports=[];
 await page.route('**/api/errors',async route=>{reports.push(route.request().postDataJSON());await route.fulfill({status:200,contentType:'application/json',body:'{}'})});
 try{
  await page.goto(srv.base+'/signin');await page.locator('#signin').waitFor();
  await page.evaluate(()=>{
   const reason={message:'Could not find identifiable element',stack:'resolveElement@user-script:1:1'};
   dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{promise:Promise.resolve(),reason}));
   dispatchEvent(new ErrorEvent('error',{message:reason.message,error:reason}));
  });
  await page.waitForTimeout(100);assert.deepEqual(reports,[]);assert.equal(await page.locator('#sc-error').count(),0);
  await page.evaluate(()=>{const reason={message:'Could not find identifiable element',stack:'findElement@'+location.origin+'/diary/today.js:12:3'};dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{promise:Promise.resolve(),reason}))});
  await page.locator('#sc-error').waitFor();await page.waitForFunction(()=>document.querySelector('#sc-error').textContent.includes('/diary/today.js:12:3'));
  for(let attempt=0;attempt<40&&reports.length<1;attempt++)await page.waitForTimeout(25);
  assert.equal(reports.length,1);assert.match(reports[0].message,/Could not find identifiable element/);
 }finally{await context.close()}
});
