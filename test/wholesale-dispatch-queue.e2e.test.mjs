import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { chromium } from "playwright";
import { ROOT, SETUP_CODE } from "./harness.mjs";

const id = "WS-" + "D".repeat(32);
const business = "Dove Street Café";
const tracking = "AB123456789GB";
const pdf = "%PDF-1.7\nLocally generated test label\n%%EOF\n";

// Run the production Worker, D1, assets and scheduled handler. Only the carrier is a stand-in.
async function startFixture(record) {
  const bundled = await build({
    absWorkingDir: ROOT, bundle: true, write: false, platform: "browser", format: "esm",
    external: ["cloudflare:*"],
    stdin: { resolveDir: ROOT, contents: `
      import site from "./src/index.ts";
      export { LiveHub } from "./src/index.ts";
      export default { ...site, async fetch(request, env, ctx) {
        if (new URL(request.url).pathname !== "/__fixture/scheduled") return site.fetch(request, env, ctx);
        const jobs = [];
        await site.scheduled({cron: "*/5 * * * *"}, env, {waitUntil: job => jobs.push(job)});
        await Promise.all(jobs);
        return new Response(null, { status: 204 });
      }};
    ` },
  });
  const text = value => ({ type: "text", value });
  return new Miniflare({ host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: {
      name: "dispatch-test", compatibilityDate: "2026-10-01",
      manifest: { modulesRoot: ROOT, mainModule: "fixture.mjs", modules: { "fixture.mjs": { type: "esm", contents: bundled.outputFiles[0].text } } },
      assets: { directory: ROOT + "/public", runWorkerFirst: true, hasUserWorker: true },
      exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
      env: {
        ASSETS: { type: "assets" }, DB: { type: "d1", name: "dispatch-test" }, FILES: { type: "kv", id: "dispatch-test" },
        LIVE: { type: "durable-object", worker: "dispatch-test", exportName: "LiveHub" }, SETUP_CODE: text(SETUP_CODE),
        WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: text("fixture-booking-key"), WHOLESALE_ROYAL_MAIL_SERVICE_CODE: text("TPS48"),
      },
    },
    dev: { outboundService: { type: "fetcher", handler: async req => {
      const url = new URL(req.url);
      assert.equal(url.hostname, "api.parcel.royalmail.com", "only the carrier fixture is reachable");
      if (req.method === "POST") {
        const { items: [item] } = await req.json();
        record.purchases.push(item);
        // Royal Mail accepted the purchase, but the response never reached Strangers.
        return new WorkerResponse("temporary gateway error", { status: 502 });
      }
      if (url.pathname.endsWith("/label")) return new WorkerResponse(pdf, { headers: { "content-type": "application/pdf" } });
      const ref = decodeURIComponent(url.pathname.split("/").at(-1)).replaceAll('"', "");
      assert.equal(ref, id);
      return WorkerResponse.json(record.purchases.length ? [{
        orderReference: id, orderIdentifier: 8101, trackingNumber: tracking, printedOn: "2026-11-26T10:00:00Z",
      }] : []);
    } } },
  }] });
}

test("Staff and Admin share the destination and queue as an uncertain purchase is recovered and its label downloaded", async t => {
  const record = { purchases: [] };
  const runtime = await startFixture(record);
  t.after(() => runtime.dispose());
  const origin = (await runtime.ready).origin;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {});
  t.after(() => browser.close());
  let adminCookie;
  async function api(path, method = "GET", payload, cookie = adminCookie) {
    const response = await fetch(origin + path, {
      method, headers: {origin, "content-type": "application/json", ...(cookie ? {cookie} : {})},
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    assert.ok(response.ok, method + " " + path + " returned " + response.status + (response.ok ? "" : " " + await response.text()));
    return response;
  }
  function session(response) {
    const candidates = response.headers.getSetCookie();
    const cookie = candidates.find(item => /^sfbb_session=[^;]+;/.test(item));
    assert.ok(cookie, JSON.stringify({ url: response.url, contentType: response.headers.get("content-type"), cookies: candidates.map(value => value.split("=")[0]) }));
    return cookie.split(";")[0];
  }
  adminCookie = session(await api("/api/auth/setup", "POST", { name: "Owner", username: "owner", password: "local-owner-password", code: SETUP_CODE }));
  const { user } = await (await api("/api/admin/users", "POST", {name: "Packing staff", username: "packer", role: "staff", password: "temporary-password"})).json();
  await api("/api/admin/users/" + user.id + "/orders-access", "PUT", {enabled: true, ifVersion: 0});
  const staffCookie = session(await api("/api/auth/change", "POST", {username: "packer", password: "temporary-password", newPassword: "local-packing-password"}, ""));
  const setup = await (await api("/api/admin/wholesale/royal-mail")).json();
  await api("/api/admin/wholesale/royal-mail", "PUT", {ifVersion: setup.version, enabled: true});
  const db = await runtime.getD1Database("DB");
  const customerId = crypto.randomUUID();
  const location = { address: "10 Dove Street, Norwich, Norfolk", postcode: "nr21de", contact: "Cafe Manager" };
  const customer = {business, status: "Active", email: "dove@example.test", ...location};
  const order = {
    business, preview: false, customerId, customerSnapshot: customer, locationSnapshot: location, paymentTerms: {id: "net-30"}, status: "Ready", delivery: "Delivery",
    createdAt: Date.now(), grams: 1000, packs: 1, pence: 1800, totalPence: 1800, deliveryPence: 0,
    lines: [{ productId: "brazil", title: "Brazil", pack: "kilo", grind: "beans", quantity: 1, grams: 1000 }],
  };
  const seed = db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES(?,?,?,1,?)");
  await db.batch([seed.bind("customer", customerId, JSON.stringify(customer), Date.now()), seed.bind("order", id, JSON.stringify(order), Date.now())]);
  async function open(path, cookie, options) {
    const context = await browser.newContext(options);
    const [name, value] = cookie.split("=");
    await context.addCookies([{name, value, url: origin}]);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(origin + path);
    return page;
  }
  const staff = await open("/orders#dispatch", staffCookie, { viewport: {width: 375, height: 812}, hasTouch: true, isMobile: true });
  const admin = await open("/admin#wholesale/royal-mail", adminCookie, { viewport: {width: 1280, height: 800} });
  const queue = page => page.getByRole("region", {name: "Dispatch queue"});
  async function rowAt(page, stage) {
    const root = queue(page);
    await root.waitFor();
    const stagePicker = root.getByRole("combobox", {name: "Filter parcels by stage"});
    if (await stagePicker.isVisible()) await stagePicker.selectOption(stage);
    else await root.locator('[data-queue-stage="' + stage + '"]').click();
    const row = root.locator('[data-queue-order="' + id + '"]');
    await row.waitFor();
    assert.ok((await row.innerText()).includes(business));
    assert.ok(await root.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "queue fits viewport");
    return row;
  }
  const staffRow = await rowAt(staff, "weigh");
  const adminRow = await rowAt(admin, "weigh");
  await adminRow.getByRole("button").click();
  const adminSheet = admin.locator("#sheet");
  await admin.waitForFunction(() => document.querySelector('#sheet [name="city"]')?.value === "Norwich");
  assert.equal(await adminSheet.locator('[name="line1"]').inputValue(), "10 Dove Street");
  assert.equal(await adminSheet.locator('[name="county"]').inputValue(), "Norfolk");
  assert.equal(await adminSheet.locator('[name="postcode"]').inputValue(), "NR2 1DE");
  await adminSheet.getByRole("button", {name: "Back to dispatch queue"}).click();
  const adminShipping = "/api/admin/wholesale/orders/" + id + "/shipping";
  const staffShipping = "/api/staff-orders/orders/" + id + "/shipping";
  const adminView = await (await api(adminShipping)).json();
  const staffView = await (await api(staffShipping, "GET", undefined, staffCookie)).json();
  assert.deepEqual(adminView.recipient, staffView.recipient);
  assert.deepEqual([staffView.recipient.line1, staffView.recipient.city, staffView.recipient.county, staffView.recipient.postcode], ["10 Dove Street", "Norwich", "Norfolk", "NR2 1DE"]);

  await staffRow.getByRole("button").click();
  const shipping = staff.getByRole("dialog", { name: "Royal Mail" });
  await shipping.getByRole("spinbutton", {name: "Packed parcel weight (grams)"}).fill("1600");
  await shipping.getByRole("button", {name: "Review label request"}).click();
  assert.match(await shipping.innerText(), /10 Dove Street\s+Norwich\s+Norfolk\s+NR2 1DE/);
  await shipping.getByRole("button", {name: "Request Royal Mail label"}).click();
  await staff.waitForFunction(() => document.querySelector("#shippingBody")?.innerText.includes("Checking with Royal Mail"));
  assert.equal(record.purchases.length, 1);
  assert.equal(record.purchases[0].recipient.address.city, "Norwich");
  assert.equal(record.purchases[0].recipient.address.postcode, "NR2 1DE");
  await admin.reload();
  await rowAt(admin, "checking");
  await db.prepare("UPDATE wholesale_royal_mail_shipments SET updated_at=0,recovery_due_at=1,refresh_after=0 WHERE order_id=?").bind(id).run();
  await api("/__fixture/scheduled");
  const recovered = await (await api(staffShipping, "GET", undefined, staffCookie)).json();
  assert.equal(recovered.canDownloadLabel, true);
  assert.equal(recovered.shipment.trackingNumber, tracking);
  await staff.goto(origin + "/orders#dispatch");
  await staff.reload();
  await rowAt(staff, "print");
  await admin.reload();
  await rowAt(admin, "print");
  const download = await api(staffShipping + "/label", "GET", undefined, staffCookie);
  assert.equal(await download.text(), pdf);
  await staff.reload();
  const handoverRow = await rowAt(staff, "handover");
  await admin.reload();
  await rowAt(admin, "handover");
  assert.equal((await (await api(adminShipping)).json()).orderVersion, 1, "a label download leaves the order awaiting physical handover");
  await handoverRow.getByRole("button").click();
  const dispatch = staff.getByRole("dialog", {name: "Confirm dispatch"});
  const confirm = dispatch.getByRole("button", {name: "Mark dispatched"});
  await staff.waitForFunction(() => !!document.querySelector("#dispatchDialog [type=submit]:enabled"));
  await db.prepare("UPDATE wholesale_preview SET data=json_set(data,'$.status','On hold'),version=version+1 WHERE kind='customer' AND id=?").bind(customerId).run();
  const attemptedHandover = staff.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/api/staff-orders/orders/" + id));
  await confirm.click();
  const blocked = await attemptedHandover;
  assert.equal(blocked.request().postDataJSON().queueHandover, true);
  assert.equal(blocked.status(), 409);
  assert.equal((await blocked.json()).code, "royal_mail_account_on_hold");
  assert.equal((await (await api(adminShipping)).json()).orderVersion, 1, "a hold added during review prevents handover");
  await staff.reload();
  assert.doesNotMatch(await (await rowAt(staff, "attention")).innerText(), /£|API key|invoice ID/);
  await admin.reload();
  const held = await rowAt(admin, "attention");
  assert.match(await held.innerText(), /account|hold/i);
  await held.getByRole("button").click();
  await admin.getByRole("heading", {name: "Billing account"}).waitFor();
  assert.match(await adminSheet.innerText(), /Dove Street Café/);
  await adminSheet.getByRole("button", {name: "Back", exact: true}).click();
  await rowAt(admin, "attention");
  assert.equal(record.purchases.length, 1, "no action during recovery or handover purchases a second label");
});
