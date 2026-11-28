import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { chromium } from "playwright";
import { ROOT, SETUP_CODE } from "./harness.mjs";

const settingsPath = "/api/admin/wholesale/royal-mail";
const checksPath = settingsPath + "/checks";

// Exercise the deployed entry points with real D1, sessions and assets. Only the carrier is simulated.
async function startRuntime(carrier) {
  const { outputFiles: [bundle] } = await build({
    absWorkingDir: ROOT, entryPoints: ["src/index.ts"], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
  });
  const name = "royal-mail-checklist";
  const text = value => ({ type: "text", value });
  const account = { carrierGuid: "1c57313e-8395-4a59-9023-51133c4eeda3", shippingAccountName: "Test shipping account" };
  return new Miniflare({ host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: {
      name, compatibilityDate: "2026-10-01",
      manifest: { modulesRoot: ROOT, mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents: bundle.text } } },
      assets: { directory: ROOT + "/public", runWorkerFirst: true, hasUserWorker: true },
      exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
      env: {
        ASSETS: { type: "assets" }, DB: { type: "d1", name }, FILES: { type: "kv", id: name },
        LIVE: { type: "durable-object", worker: name, exportName: "LiveHub" }, SETUP_CODE: text(SETUP_CODE),
        WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: text("fixture-read-only-key"), WHOLESALE_ROYAL_MAIL_SERVICE_CODE: text("NDB"),
      },
    },
    dev: { outboundService: { type: "fetcher", handler: request => {
      const url = new URL(request.url);
      carrier.calls.push({ method: request.method, url });
      assert.equal(request.method, "GET");
      assert.equal(url.origin, "https://api.parcel.royalmail.com");
      if (url.pathname.endsWith("/carriers")) return WorkerResponse.json(carrier.multipleAccounts
        ? [account, { carrierGuid: "56970f77-4ffd-4ccb-82e5-e8296f797b5a", shippingAccountName: "Other account" }] : [account]);
      if (url.pathname.endsWith("/services")) return WorkerResponse.json([{ ...account, services: [{
        carrierServiceGuid: "91a1a71d-893a-475d-93a0-fe6bd64223c6", serviceCode: "NDB", serviceName: "Parcelforce express24",
      }] }]);
      return new WorkerResponse(null, { status: 405 });
    } } },
  }] });
}

async function screen(page, filename) {
  if (!process.env.WHOLESALE_SCREENSHOT_DIR) return;
  await mkdir(process.env.WHOLESALE_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.WHOLESALE_SCREENSHOT_DIR}/${filename}.png`, animations: "disabled" });
}

test("an admin can check a parcel service on a phone and review the same evidence on desktop without booking postage", async t => {
  const carrier = { calls: [], multipleAccounts: false };
  const { calls } = carrier;
  const runtime = await startRuntime(carrier);
  t.after(() => runtime.dispose());
  const base = (await runtime.ready).origin;
  const setup = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ name: "Dispatch Admin", username: "dispatch.admin", password: "local-dispatch-password", code: SETUP_CODE }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.getSetCookie().find(value => /^sfbb_session=[^;]+;/.test(value))?.split(";")[0];
  assert.ok(cookie);
  const [name, value] = cookie.split("=");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  t.after(() => browser.close());
  async function open(options, viaSettings) {
    const context = await browser.newContext(options);
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(base + "/admin#wholesale/royal-mail");
    if (viaSettings) await page.getByRole("button", { name: "Shipping settings", exact: true }).click();
    await page.getByRole("button", { name: "Setup checks", exact: true }).click();
    const panel = page.locator("#wRoyalMailChecks");
    await panel.locator('[data-check-id="returnAddress"]').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    return { page, panel };
  }
  const mobile = await open({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, false);
  assert.deepEqual(calls, [], "opening the checklist only reads stored results");
  const manualIds = ["returnAddress", "printer", "collection", "manifest", "register", "parcelLimits"];
  for (const id of manualIds) assert.equal(await mobile.panel.locator(`[data-check-id="${id}"]`).count(), 1, id);

  await mobile.panel.getByText("Check a packed box", { exact: true }).click();
  const dimensions = mobile.panel.locator(".w-rm-box-form");
  await dimensions.getByLabel("Sealed weight (g)").fill("2610");
  await dimensions.getByLabel("Length (cm)").fill("151");
  await dimensions.getByLabel("Width (cm)").fill("25");
  await dimensions.getByLabel("Height (cm)").fill("20");
  await dimensions.getByRole("button", { name: "Check dimensions" }).click();
  assert.match(await dimensions.getByRole("status").innerText(), /surcharge/);
  assert.equal(calls.length, 0, "checking a box uses local measurements");
  await mobile.panel.getByText("Check a packed box", { exact: true }).click();

  await mobile.panel.getByText("Use a sample parcel", { exact: true }).click();
  await mobile.panel.getByLabel(/postcode/i).fill("NR2 3HX");
  await mobile.panel.getByLabel(/packed weight/i).fill("2610");
  await mobile.panel.getByText("Check a packed box", { exact: true }).click();
  await dimensions.getByLabel("Sealed weight (g)").fill("5400");
  await mobile.panel.getByText("Check a packed box", { exact: true }).click();
  const responseTo = (page, method) => page.waitForResponse(r => new URL(r.url()).pathname === checksPath && r.request().method() === method);
  const result = responseTo(mobile.page, "POST");
  await mobile.panel.getByRole("button", { name: "Run carrier checks", exact: true }).click();
  const run = await result;
  assert.equal(run.status(), 200);
  const { automated } = await run.json();
  await mobile.panel.getByText(/3 of 3 account and service checks verified/).waitFor();
  await mobile.panel.getByText(/Admin and Staff share one postage record per order/).waitFor();

  const statuses = Object.fromEntries(automated.checks.map(check => [check.id, check.status]));
  assert.deepEqual(statuses, { authentication: "passed", shippingAccount: "passed", service: "passed", labelPdf: "unverified", tracking: "unverified" });
  assert.deepEqual(calls.map(({ method, url }) => [method, url.pathname.split("/").at(-1)]).sort(), [["GET", "carriers"], ["GET", "services"]]);
  const sample = calls.find(({ url }) => url.pathname.endsWith("/services")).url.searchParams;
  assert.equal(sample.get("destinationPostcode"), "NR2 3HX");
  assert.equal(sample.get("packageWeight"), "2610");

  await mobile.panel.locator('[data-check-id="returnAddress"]').click();
  const form = mobile.page.locator("#wRoyalMailEvidence");
  await form.waitFor();
  assert.equal(await form.locator('[name="verified"]').isChecked(), false, "manual evidence starts unconfirmed");
  await form.locator('[name="verified"]').check();
  const saved = responseTo(mobile.page, "PUT");
  await mobile.page.getByRole("button", { name: "Save confirmation", exact: true }).click();
  assert.equal(((await (await saved).json()).manual.returnAddress).confirmedBy, "Dispatch Admin");
  await form.waitFor({ state: "hidden" });
  await mobile.page.evaluate(() => scrollTo(0, 0));
  await screen(mobile.page, "royal-mail-setup-phone");

  await mobile.panel.locator('[data-check-id="manifest"]').click();
  await form.getByLabel("Handover site").selectOption("warehouse");
  await form.getByLabel("Responsible role").selectOption("dispatchLead");
  await form.getByLabel("Evidence retained").selectOption("collectionReceipt");
  await form.locator('[name="verified"]').check();
  assert.ok(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await screen(mobile.page, "royal-mail-handover-phone");
  const recorded = responseTo(mobile.page, "PUT");
  await form.getByRole("button", { name: "Save confirmation", exact: true }).click();
  assert.deepEqual((await (await recorded).json()).manual.manifest.evidence, {
    site: "warehouse", owner: "dispatchLead", proof: "collectionReceipt",
  });
  await form.waitFor({ state: "hidden" });

  const desktop = await open({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }, true);
  assert.match(await desktop.panel.innerText(), /Dispatch Admin/);
  await screen(desktop.page, "royal-mail-setup-desktop");
  await desktop.panel.getByRole("heading", { name: "Team confirmations" }).evaluate(node => node.scrollIntoView({ block: "start" }));
  await screen(desktop.page, "royal-mail-confirmations-desktop");
  await desktop.panel.locator('[data-check-id="returnAddress"]').click();
  const removed = responseTo(desktop.page, "PUT");
  await desktop.page.getByRole("button", { name: "Remove confirmation", exact: true }).click();
  assert.equal((await (await removed).json()).manual.returnAddress, undefined);
  const settings = await (await fetch(base + settingsPath, { headers: { cookie } })).json();
  assert.equal(settings.enabled, false);
  assert.equal(settings.version, 0, "checking an account preserves its booking policy and credentials");
  assert.equal(calls.length, 2, "reopening the checklist and editing manual evidence does not contact the carrier");

  carrier.multipleAccounts = true;
  const rerun = responseTo(desktop.page, "POST");
  await desktop.panel.getByRole("button", { name: "Run carrier checks", exact: true }).click();
  const report = (await (await rerun).json()).automated;
  const account = report.checks.find(item => item.id === "shippingAccount");
  assert.equal(account.status, "attention");
  await desktop.panel.getByText(account.detail, { exact: true }).waitFor();
  assert.equal(report.checks.find(item => item.id === "service").status, "unverified");
  assert.deepEqual(calls.slice(2).map(({ method, url }) => [method, url.pathname.split("/").at(-1)]), [["GET", "carriers"]]);

  // A handover sheet left open across midnight cannot confirm the following day's collection.
  await mobile.panel.locator('[data-check-id="manifest"]').click();
  await form.locator('[name="verified"]').check();
  const writes = [];
  mobile.page.on("request", request => {
    if (new URL(request.url()).pathname === checksPath && request.method() === "PUT") writes.push(request);
  });
  await mobile.page.clock.setFixedTime(new Date(Date.now() + 86_400_000));
  await form.getByRole("button", { name: "Save confirmation", exact: true }).click();
  await mobile.panel.getByText(/A new UK day has started/).waitFor();
  assert.equal(writes.length, 0);
});
