import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { chromium } from "playwright";
import { ROOT, SETUP_CODE } from "./harness.mjs";

const listPath = "/api/admin/wholesale/royal-mail/labels";
const shippingPath = id => "/api/admin/wholesale/orders/" + id + "/shipping/label";
const customerId = "3cc5e880-9eba-4167-8f17-63fd048b051f";
const reference = index => "WS-" + index.toString(16).toUpperCase().padStart(32, "0");
const tracking = index => "AB" + String(index).padStart(9, "0") + "GB";
const newest = reference(0);
const historical = reference(1);

async function fixture(pdf, calls) {
  const { outputFiles: [bundle] } = await build({
    absWorkingDir: ROOT, entryPoints: ["src/index.ts"], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
  });
  const name = "label-library-browser";
  const text = value => ({ type: "text", value });
  return new Miniflare({ host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: {
      name, compatibilityDate: "2026-10-01",
      manifest: { modulesRoot: ROOT, mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents: bundle.text } } },
      assets: { directory: ROOT + "/public", runWorkerFirst: true, hasUserWorker: true },
      exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
      env: {
        ASSETS: { type: "assets" }, DB: { type: "d1", name }, FILES: { type: "kv", id: name },
        LIVE: { type: "durable-object", worker: name, exportName: "LiveHub" },
        SETUP_CODE: text(SETUP_CODE), WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: text("fixture-key"),
      },
    },
    dev: { outboundService: { type: "fetcher", handler: req => {
      const url = new URL(req.url);
      calls.push({ method: req.method, url });
      assert.equal(url.origin, "https://api.parcel.royalmail.com");
      assert.equal(req.method, "GET", "the library must only read existing carrier records");
      if (/^\/api\/v1\/orders\/\d+\/label$/.test(url.pathname)) {
        return new WorkerResponse(pdf, { headers: { "Content-Type": "application/pdf" } });
      }
      const match = /^\/api\/v1\/orders\/"(WS-([A-F0-9]{32}))"$/.exec(decodeURIComponent(url.pathname));
      assert.ok(match, "unexpected carrier path " + url.pathname);
      const index = Number.parseInt(match[2], 16);
      return WorkerResponse.json([{ orderReference: match[1], orderIdentifier: 8000 + index,
        trackingNumber: tracking(index), printedOn: "2026-11-24T08:30:00Z" }]);
    } } },
  }] });
}

async function seed(db) {
  const now = Date.now();
  await db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('customer',?,?,1,?)")
    .bind(customerId, JSON.stringify({ business: "Test Coffee Group", status: "Active" }), now).run();
  const records = [];
  // Enough orders to exercise the normal page size without adjusting production limits.
  for (let i = 0; i < 105; i++) {
    const id = reference(i), at = now - i * 60000, dispatched = i === 1;
    const business = i === 0 ? "Juniper Coffee" : i === 1 ? "North Quay Coffee" : "Coffee outlet " + i;
    const order = { customerId, business, delivery: "Delivery", status: dispatched ? "Dispatched" : "Ready",
      preview: false, reference: "ORDER-REF-" + i, grams: 1000, packs: 1, lines: [], createdAt: at };
    records.push(db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES('order',?,?,1,?)")
      .bind(id, JSON.stringify(order), at));
    records.push(db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,provider_id,tracking_number,weight_grams,requested_at,updated_at,label_downloaded_at)
      VALUES(?,?,?,1,?,?,1250,?,?,?)`).bind(id, dispatched ? "dispatched" : "labelled", "fixture-" + i, 8000 + i, tracking(i), at, at, dispatched ? at : null));
  }
  while (records.length) await db.batch(records.splice(0, 40));
}

test("Admin labels supports desktop search and reprints, then a mobile sheet with guarded, read-only previews", async t => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  t.after(() => browser.close());
  const artwork = await browser.newPage();
  await artwork.setContent("<html><body><h1>Sample shipping label</h1><p>Fixture only</p></body></html>");
  const pdf = await artwork.pdf({ width: "4in", height: "6in" });
  await artwork.close();
  const carrier = [];
  const runtime = await fixture(pdf, carrier);
  t.after(() => runtime.dispose());
  const origin = (await runtime.ready).origin;
  const auth = await fetch(origin + "/api/auth/setup", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "label.admin", name: "Label Admin", password: "fixture-admin-password", code: SETUP_CODE }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.getSetCookie().find(s => s.startsWith("sfbb_session=")).split(";")[0];
  const [name, value] = cookie.split("=");
  const db = await runtime.getD1Database("DB");
  await seed(db);
  const errors = [];
  const requests = [];
  async function open(viewport, colorScheme, deepLink = false) {
    const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
    t.after(() => context.close());
    await context.addCookies([{ name, value, url: origin }]);
    await context.addInitScript(() => {
      window.print = () => window.top.dispatchEvent(new CustomEvent("fixture:print-label"));
      window.addEventListener("fixture:print-label", () => { window.labelPrintDialogOpened = true; });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/shipping/label")) requests.push({ path: url.pathname, preview: url.searchParams.get("preview") === "1" });
    });
    await page.goto(origin + "/admin#wholesale/royal-mail" + (deepLink ? "/labels" : ""));
    const tab = page.getByRole("navigation", { name: "Royal Mail workspace" }).getByRole("button", { name: "Labels", exact: true });
    if (!deepLink) await tab.click();
    await page.locator(".lp-row").first().waitFor();
    assert.equal(await tab.getAttribute("aria-current"), "page");
    assert.equal(new URL(page.url()).hash, "#wholesale/royal-mail/labels");
    return page;
  }
  async function downloadedAt(id) {
    const shipment = await db.prepare("SELECT label_downloaded_at FROM wholesale_royal_mail_shipments WHERE order_id=?").bind(id).first();
    return shipment.label_downloaded_at;
  }
  async function waitForLabel(page, selector) {
    await page.waitForFunction(selector => {
      const canvas = document.querySelector(selector + " .lp-paper canvas");
      if (!(canvas?.width && canvas.height)) return false;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] === 255 && pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) return true;
      }
      return false;
    }, selector);
  }
  const desktop = await open({ width: 1440, height: 900 }, "dark");
  const rows = desktop.locator(".lp-row");
  const initialCount = await rows.count();
  assert.ok(initialCount > 0 && initialCount < 105);
  const nextPage = desktop.waitForResponse(r => new URL(r.url()).pathname === listPath && !!new URL(r.url()).searchParams.get("cursor"));
  await desktop.getByRole("button", { name: "Show more labels" }).click();
  assert.equal((await nextPage).status(), 200);
  await desktop.waitForFunction(n => document.querySelectorAll(".lp-row").length > n, initialCount);
  assert.equal(new Set(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.preview))).size, await rows.count());

  const search = desktop.getByRole("searchbox");
  const status = desktop.getByRole("combobox", { name: /status/i });
  await search.fill(tracking(1));
  await desktop.waitForFunction(() => document.querySelectorAll(".lp-row").length === 1);
  assert.match(await rows.innerText(), /North Quay Coffee/);
  await status.selectOption("ready");
  await desktop.waitForFunction(() => document.querySelectorAll(".lp-row").length === 0);
  await status.selectOption("dispatched");
  await rows.first().waitFor();
  assert.equal(await rows.first().getAttribute("data-preview"), historical);
  await rows.first().click();
  await desktop.locator(".lp-preview").getByRole("heading", { name: "North Quay Coffee" }).waitFor();
  await waitForLabel(desktop, ".lp-preview");
  const historyReads = requests.filter(r => r.path === shippingPath(historical));
  assert.ok(historyReads.length && historyReads.every(r => r.preview));
  assert.equal(await downloadedAt(newest), null, "previewing the first label preserves the queue's print state");
  const firstDownload = await downloadedAt(historical);
  const printResponse = desktop.waitForResponse(r => new URL(r.url()).pathname === shippingPath(historical) && !new URL(r.url()).searchParams.has("preview"));
  await desktop.getByRole("button", { name: "Print label", exact: true }).click();
  assert.equal((await printResponse).status(), 200);
  await desktop.waitForFunction(() => window.labelPrintDialogOpened === true);
  assert.equal(await downloadedAt(historical), firstDownload, "reprinting a dispatched label keeps its original download time");
  await desktop.goBack();
  await desktop.getByRole("region", { name: "Dispatch queue" }).waitFor();
  assert.equal(await desktop.locator(".lp-preview").count(), 0);
  await desktop.goForward();
  await desktop.locator(".lp-row").first().waitFor();

  const phone = await open({ width: 390, height: 844 }, "light", true);
  const target = phone.locator('.lp-row[data-preview="' + newest + '"]');
  const previewResponse = phone.waitForResponse(r => r.url().includes(shippingPath(newest)) && new URL(r.url()).searchParams.get("preview") === "1");
  await target.click();
  const dialog = phone.getByRole("dialog", { name: "Label preview" });
  await dialog.waitFor();
  assert.equal((await previewResponse).status(), 200);
  await waitForLabel(phone, "dialog.lp-sheet");
  assert.equal(await downloadedAt(newest), null, "a mobile preview does not start handover");
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, "the preview fits the phone");
  const download = phone.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download PDF" }).click();
  const file = await download;
  assert.match(file.suggestedFilename(), /\.pdf$/i);
  assert.deepEqual(await readFile(await file.path()), pdf);
  assert.ok(await downloadedAt(newest));
  await phone.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await target.getByText("Downloaded", { exact: true }).waitFor();
  await phone.waitForFunction(id => document.activeElement?.dataset.preview === id, newest);
  assert.ok(carrier.every(c => c.method === "GET"), "no reprint, download, or preview made a postage purchase");
  assert.deepEqual(errors, []);
});
