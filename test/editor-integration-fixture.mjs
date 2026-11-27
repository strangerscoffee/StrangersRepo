import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { ROOT, SETUP_CODE } from "./harness.mjs";
import { products } from "../public/consumer-preview/assets/products.js";

export const admin = "https://admin.staffstrangerscoffee.com";
export const retail = "https://preview.staffstrangerscoffee.com";
export const wholesale = "https://strangerscoffee.trade";
const diary = "https://staffstrangerscoffee.com";
export const editorPath = "/api/admin/consumer/editor";
const plain = value => ({ type: "text", value });

// All three production hostnames are dispatched inside one temporary Worker, so
// they share the editor binding. No request reaches the deployed sites.
export async function startEditorFixture({ retailWorker, assetsDirectory = ROOT + "/public" } = {}) {
  const { outputFiles: [bundle] } = await build({
    absWorkingDir: ROOT, entryPoints: ["src/index.ts"], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
  });
  const name = "consumer-editor-integration";
  const runtime = new Miniflare({
    host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
    workers: [{
      config: {
        name, compatibilityDate: "2026-10-01",
        manifest: { modulesRoot: ROOT, mainModule: "editor-fixture.mjs", modules: { "editor-fixture.mjs": { type: "esm", contents: bundle.text } } },
        assets: { directory: assetsDirectory, runWorkerFirst: true, hasUserWorker: true },
        exports: {
          LiveHub: { type: "durable-object", storage: "sqlite" },
          ConsumerEditorStore: { type: "durable-object", storage: "sqlite" },
        },
        env: {
          DB: { type: "d1", name: "editor-fixture-db" }, FILES: { type: "kv", id: "editor-fixture-files" },
          ASSETS: { type: "assets" }, LIVE: { type: "durable-object", worker: name, exportName: "LiveHub" },
          CONSUMER_EDITOR: { type: "durable-object", worker: name, exportName: "ConsumerEditorStore" },
          ADMIN_HOST: plain(new URL(admin).host), PREVIEW_HOST: plain(new URL(wholesale).host),
          LEGACY_PREVIEW_HOST: plain(new URL(retail).host), COOKIE_DOMAIN: plain(new URL(diary).host),
          SETUP_CODE: plain(SETUP_CODE),
        },
      },
      // Stub optional account and stock reads. Catch any attempt to place an
      // order or contact an integration in the editor preview.
      dev: { outboundService: retailWorker ? { type: "worker", worker: retailWorker.config.name } : { type: "fetcher", handler: request => {
        if (new URL(request.url).pathname === "/consumer-bridge/catalogue" && request.method === "GET") {
          return WorkerResponse.json({ products: products.map(product => ({...product, available:true})) });
        }
        if (new URL(request.url).pathname === "/consumer-bridge/availability" && request.method === "GET") {
          return WorkerResponse.json({ unavailable: [] });
        }
        return WorkerResponse.json({ message: "Local fixture" }, {status: 503});
      } } },
    }, ...(retailWorker ? [retailWorker] : [])],
  });
  const request = (origin, path, method = "GET", body, cookie, headers = {}) => runtime.dispatchFetch(origin + path, {
    method, redirect: "manual", headers: {
      ...(body === undefined ? {} : {"content-type": "application/json", origin}),
      ...(cookie ? {cookie} : {}), ...headers,
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  try {
    const setup = await request(diary, "/api/auth/setup", "POST", {
      name: "Editor Reviewer", username: "editor.reviewer", password: "fixture-editor-password", code: SETUP_CODE,
    });
    const cookie = setup.headers.getSetCookie().find(value => /^sfbb_session=[\w-]/.test(value))?.split(";")[0];
    if (!setup.ok || !cookie) throw new Error("Could not create local reviewer: " + setup.status);
    return { runtime, request, cookie, stop: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function openLocalBrowser(fixture, browser, viewport, signedIn = false) {
  const context = await browser.newContext({viewport, serviceWorkers: "block"});
  if (signedIn) {
    const [name, value] = fixture.cookie.split("=");
    await context.addCookies([{name, value, url: admin, httpOnly: true, secure: true, sameSite: "Lax"}]);
  }
  await context.routeWebSocket("**/*", route => route.close());
  await context.route("**/*", async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== retail && !(signedIn && url.origin === admin)) return route.abort("blockedbyclient");
    const response = await fixture.runtime.dispatchFetch(url.href, {
      method: req.method(), headers: await req.allHeaders(),
      ...(req.postDataBuffer() ? {body: req.postDataBuffer()} : {}), redirect: "manual",
    });
    const headers = Object.fromEntries(response.headers);
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({status: response.status, headers, body: Buffer.from(await response.arrayBuffer())});
  });
  return context;
}
