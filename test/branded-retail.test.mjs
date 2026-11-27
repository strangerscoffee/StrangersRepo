import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { ROOT } from "./harness.mjs";
import { startEditorFixture } from "./editor-integration-fixture.mjs";

const brandedHost = "preview.staffstrangerscoffee.com";
const brandedOrigin = `https://${brandedHost}`;
const wholesaleHost = "strangerscoffee.trade";
const sitesOrigin = "https://strangers-coffee-retail-demo.magicloom512.chatgpt.site";
const retailCookie = "__Host-strangers_consumer_session";
const retailToken = Buffer.alloc(32, 19).toString("base64url");
const staffCookies = "sfbb_session=fixture-staff; sf_wholesale_session=fixture-wholesale";
const hosts = {
  PREVIEW_HOST: wholesaleHost,
  LEGACY_PREVIEW_HOST: brandedHost,
  ADMIN_HOST: "admin.staffstrangerscoffee.com",
};

function cookieFrom(response, name) {
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
  assert.ok(cookie, `missing ${name} cookie`);
  return cookie;
}

function assertHostOnlyCookie(cookie) {
  assert.match(cookie, /(?:^|;\s*)Path=\//i);
  assert.match(cookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.doesNotMatch(cookie, /(?:^|;\s*)Domain=/i);
}

describe("branded retail routes on the Worker", () => {
  let fixture;
  const branded = {base: brandedOrigin}, wholesale = {base: "https://" + wholesaleHost}, diary = {base:"https://staffstrangerscoffee.com"};
  const request = (base, path, init = {}) => fixture.runtime.dispatchFetch(base + path, {redirect:"manual", ...init});
  before(async () => { fixture = await startEditorFixture(); });
  after(async () => { await fixture?.stop(); });

  test("the branded hostname serves the new retail pages and their same-origin assets", async () => {
    let appPath;
    for (const path of ["/", "/account/", "/coffee/", "/coffee/p/ethiopia-rocko-mountain-natural/", "/checkout/", "/location/", "/about/", "/brewguides/", "/contact/", "/shipping/", "/privacy-policy/", "/terms-conditions/"]) {
      const page = await request(branded.base, path);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get("content-type"), /text\/html/, path);
      assert.match(page.headers.get("cache-control"), /no-store/, path);
      const policy = page.headers.get("content-security-policy");
      if (path === "/brewguides/") assert.match(policy, /frame-src https:\/\/www\.youtube-nocookie\.com(?:;|$)/);
      else assert.doesNotMatch(policy, /youtube-nocookie\.com/);
      const text = await page.text();
      assert.match(text, /Strangers Coffee/i, path);
      assert.match(text, /\/consumer-preview\/assets\//, path);
      if (path === "/account/") {
        assert.match(text, /My account/i);
        assert.doesNotMatch(text, /<body[^>]*\bdata-retail-signed-in/);
        appPath = text.match(/src="([^"\s]*\/consumer-preview\/assets\/app\.js[^"\s]*)"/)?.[1];
      }
    }

    const page = await request(branded.base, "/account/", { method: "HEAD" });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "");
    assert.ok(appPath, "the account loads its branded app module");
    for (const path of new Set([appPath, "/consumer-preview/assets/app.js"])) {
      const script = await request(branded.base, path);
      assert.equal(script.status, 200, path);
      assert.match(script.headers.get("content-type"), /javascript/, path);
      assert.doesNotMatch(await script.text(), /<!doctype html>/i, path);
      assert.equal((await request(wholesale.base, path)).status, 404, path);
      assert.equal((await request(diary.base, path)).status, 404, path);
    }
  });

  test("retail product links and write routes stay confined to the branded host", async () => {
    const redirect = await request(branded.base, "/coffee/p/ethiopia-rocko-mountain-natural?grind=filter");
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/coffee/p/ethiopia-rocko-mountain-natural/?grind=filter");
    assert.equal((await request(branded.base, "/coffee/p/no-such-coffee/")).status, 404);
    for (const path of ["/api/retail/orders", "/api/retail/orders/SC-0123ABCD", "/api/retail/support"]) {
      assert.equal((await request(branded.base, path)).status, 405);
      const init = { method: "POST", headers: { origin: `https://${wholesaleHost}`, "content-type": "application/json" }, body: "{}" };
      assert.equal((await request(branded.base, path, init)).status, 403);
      assert.equal((await request(wholesale.base, path, init)).status, 404);
      assert.equal((await request(diary.base, path, init)).status, 404);
    }
  });

  test("private assets, account endpoints, and branded documents stay in their own routes", async () => {
    for (const path of ["/consumer-preview/", "/consumer-preview/account/", "/consumer-preview/assets/not-present.js"]) {
      assert.equal((await request(branded.base, path)).status, 404, path);
    }
    for (const path of ["/consumer-preview/assets/app.js", "/api/account", "/consumer-auth/availability", "/signin-with-chatgpt"]) {
      assert.equal((await request(wholesale.base, path)).status, 404, path);
    }
    for (const path of ["/account/", "/coffee/"]) {
      const response = await request(wholesale.base, path);
      assert.ok([302, 404].includes(response.status), path);
      if (response.status === 302) assert.equal(response.headers.get("location"), "/signin", path);
      assert.doesNotMatch(await response.text(), /\/consumer-preview\/assets\//, path);
    }
    for (const cookie of [undefined, staffCookies]) {
      const response = await request(branded.base, "/api/account", { headers: cookie ? { cookie } : {} });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  });

  test("the retail hostname excludes wholesale and staff regardless of cookies or archived asset paths", async () => {
    const signin = await request(branded.base, "/signin?order=WS-example");
    assert.equal(signin.status, 302);
    assert.equal(signin.headers.get("location"), "/account/");
    const oldOrderLink = await request(branded.base, "/?order=WS-example");
    assert.equal(oldOrderLink.status, 200);
    assert.match(await oldOrderLink.text(), /\/consumer-preview\/assets\//);

    const unavailable = [
      ["GET", "/wholesale/"], ["GET", "/wholesale/signin"], ["GET", "/wholesale-preview/signin"],
      ["GET", "/wholesale/signin.js?v=existing"], ["GET", "/_releases/ffffffffffffffffffff/wholesale/signin.js"],
      ["GET", "/api/wholesale/catalogue"], ["POST", "/api/wholesale/auth/login"],
      ["GET", "/admin/"], ["GET", "/api/admin/consumer"], ["GET", "/api/auth/me"],
      ["POST", "/api/email/resend-webhook"], ["POST", "/api/quickbooks/webhook/live"],
    ];
    for (const cookie of [undefined, staffCookies]) {
      for (const [method, path] of unavailable) {
        const response = await request(branded.base, path, { method, headers: cookie ? { cookie } : {} });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.get("location"), null, path);
        assert.deepEqual(response.headers.getSetCookie(), [], path);
      }
    }

    const root = await request(wholesale.base, "/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/signin");
    const staff = await request(wholesale.base, "/wholesale/staff-signin");
    const staffLocation = new URL(staff.headers.get("location"));
    assert.equal(staffLocation.origin, "https://staffstrangerscoffee.com");
    assert.equal(staffLocation.searchParams.get("next"), "https://staffstrangerscoffee.com/wholesale/");
  });

  test("retail sign-in stays on the branded account page without provider redirects", async () => {
    const response = await request(branded.base, "/signin?return_to=https%3A%2F%2Foutside.example%2F");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/account/");
    assert.deepEqual(response.headers.getSetCookie(), []);
    for (const path of ["/signin-with-chatgpt", "/signout-with-chatgpt", "/consumer-auth/callback?state=old&code=old"]) {
      const retired = await request(branded.base, path);
      assert.equal(retired.status, 404, path);
      assert.equal(retired.headers.get("location"), null, path);
    }
  });
});

let gatewayModule;
async function callGateway(path, init = {}) {
  gatewayModule ??= build({
    absWorkingDir: ROOT,
    entryPoints: ["src/brandedRetail.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  }).then(({ outputFiles: [file] }) => import(`data:text/javascript;base64,${Buffer.from(file.contents).toString("base64")}`));
  const { handleBrandedRetail } = await gatewayModule;
  const req = new Request(brandedOrigin + path, init);
  try {
    return await handleBrandedRetail(req, hosts, new URL(req.url));
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error;
    return Response.json({ code: error.code }, { status: error.status });
  }
}

function useSitesBridge(t, fetchResponse) {
  return t.mock.method(globalThis, "fetch", async (input, init) => {
    const outgoing = new Request(input, init);
    const target = new URL(outgoing.url);
    assert.equal(target.origin, sitesOrigin, "the Worker only calls the fixed Sites origin");
    assert.equal(outgoing.redirect, "manual", "the Worker cannot follow an upstream redirect with account credentials");
    assert.equal(outgoing.headers.get("cookie"), null, "browser cookies stay on the branded hostname");
    assert.notEqual(outgoing.redirect, "follow", "the upstream cannot redirect with attached credentials");
    return fetchResponse(outgoing, target.pathname);
  });
}

test("account requests use only the retail cookie and accept writes only from the branded origin", async (t) => {
  const account = { profile: { name: "Sample Buyer" }, orders: [] };
  const order = { reference: "SC-0000000A", lines: [{ id: "bom-jesus", size: "250g", grind: "Whole bean", qty: 1 }] };
  const upstream = useSitesBridge(t, async (outgoing, path) => {
    assert.equal(outgoing.headers.get("authorization"), `Bearer ${retailToken}`);
    if (path.endsWith("/orders")) {
      assert.equal(outgoing.method, "POST");
      assert.equal(outgoing.headers.get("origin"), brandedOrigin);
      assert.deepEqual(await outgoing.json(), order);
      return Response.json({ order }, { status: 201 });
    }
    assert.equal(path, "/api/account");
    if (outgoing.method === "PUT") {
      assert.equal(outgoing.headers.get("origin"), brandedOrigin);
      assert.deepEqual(await outgoing.json(), account.profile);
    } else assert.equal(outgoing.method, "GET");
    return Response.json(account, { headers: { "set-cookie": "upstream-test=private; Path=/" } });
  });
  const cookie = `${retailCookie}=${retailToken}; ${staffCookies}`;

  for (const origin of [undefined, "null", "https://staffstrangerscoffee.com", "https://outside.example"]) {
    const response = await callGateway("/api/account", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(account.profile),
    });
    assert.equal(response.status, 403, origin ?? "missing origin");
  }

  for (const [body, contentType, status] of [
    [JSON.stringify(account.profile), "text/plain", 415],
    [new Uint8Array([0xc3, 0x28]), "application/json", 400],
    [JSON.stringify({ name: "x".repeat(24 * 1024) }), "application/json", 413],
  ]) {
    const invalidBody = await callGateway("/api/account", {
      method: "PUT",
      headers: { cookie, origin: brandedOrigin, "content-type": contentType },
      body,
    });
    assert.equal(invalidBody.status, status);
  }
  assert.equal(upstream.mock.callCount(), 0);

  const read = await callGateway("/api/account", { headers: { cookie, authorization: "Bearer fixture-staff" } });
  assert.equal(read.status, 200);
  const { profileSession, ...details } = await read.json();
  assert.deepEqual(details, account);
  assert.match(profileSession, /^[0-9a-f]{64}$/);
  assert.equal(read.headers.get("set-cookie"), null);
  assert.match(read.headers.get("cache-control"), /no-store/);

  const laterCookie = `${retailCookie}=${Buffer.alloc(32, 42).toString("base64url")}`;
  for (const headers of [
    { cookie },
    { cookie: laterCookie, "x-retail-profile-session": profileSession },
  ]) {
    const stale = await callGateway("/api/account", {
      method: "PUT",
      headers: { ...headers, origin: brandedOrigin, "content-type": "application/json" },
      body: JSON.stringify(account.profile),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "account_changed");
  }
  assert.equal(upstream.mock.callCount(), 1);
  const update = await callGateway("/api/account", {
    method: "PUT",
    headers: { cookie, origin: brandedOrigin, "content-type": "application/json", "x-retail-profile-session": profileSession },
    body: JSON.stringify(account.profile),
  });
  assert.equal(update.status, 200);
  const result = await update.text();
  assert.deepEqual(JSON.parse(result), account);
  assert.ok(!result.includes(retailToken));

  const recorded = await callGateway("/api/account/orders", {
    method: "POST",
    headers: { cookie, origin: brandedOrigin, "content-type": "application/json", "x-retail-profile-session": profileSession },
    body: JSON.stringify(order),
  });
  assert.equal(recorded.status, 201);
  assert.deepEqual(await recorded.json(), { order });
  assert.equal(upstream.mock.callCount(), 3);
});

test("availability exposes only valid unavailable product identifiers", async (t) => {
  const upstream = useSitesBridge(t, (outgoing, path) => {
    assert.equal(path, "/consumer-bridge/availability");
    assert.equal(outgoing.method, "GET");
    assert.equal(outgoing.headers.get("authorization"), null);
    return Response.json({ unavailable: ["bom-jesus", "rocko", "Not a product id", 12], token: retailToken, internal: true });
  });
  const availability = await callGateway("/consumer-auth/availability", { headers: { cookie: `${retailCookie}=${retailToken}; ${staffCookies}` } });
  assert.equal(availability.status, 200);
  assert.deepEqual(await availability.json(), { unavailable: ["bom-jesus", "rocko"] });
  assert.equal(upstream.mock.callCount(), 1);
});

test("upstream redirects never leave the fixed preview service", async (t) => {
  const upstream = useSitesBridge(t, () => Response.json(
    { error: "redirect" },
    { status: 307, headers: { location: "https://outside.example/collect" } },
  ));
  const response = await callGateway("/api/account", { headers: { cookie: `${retailCookie}=${retailToken}` } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.equal(upstream.mock.callCount(), 1);
});

describe("first-party retail authentication through the actual local Worker", () => {
  let runtime, publicKey, serviceCalls = [], mailCalls = [], responder;
  const approvedEmail = "shopper@example.test";
  const linkToken = Buffer.alloc(32, 31).toString("base64url");
  const fixtures = {
    register: { email: approvedEmail },
    setup: { token: linkToken, name: "Fixture Shopper", password: "fixture password 123" },
    login: { email: approvedEmail, password: "fixture password 123" },
    forgot: { email: approvedEmail },
    reset: { token: linkToken, password: "replacement password 123" },
    logout: {},
  };
  const plain = value => ({ type: "text", value });
  const send = (action, body = fixtures[action], headers = {}) => runtime.dispatchFetch(brandedOrigin + "/consumer-auth/" + action, {
    method: "POST", redirect: "manual",
    headers: { origin: brandedOrigin, "content-type": "application/json", ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const sessionResult = () => RuntimeResponse.json({ session: { token: retailToken, expiresIn: 14400 }, internal: "never expose", mail: { token: linkToken } }, { headers: { "set-cookie": "upstream-private=hidden; Path=/" } });

  before(async () => {
    const { outputFiles: [bundle] } = await build({ absWorkingDir: ROOT, entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"] });
    runtime = new Miniflare({
      host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
      workers: [{
        config: {
          name: "first-party-retail-auth", compatibilityDate: "2026-10-01",
          manifest: { modulesRoot: ROOT, mainModule: "retail-auth-fixture.mjs", modules: { "retail-auth-fixture.mjs": { type: "esm", contents: bundle.text } } },
          assets: { directory: ROOT + "/public", runWorkerFirst: true, hasUserWorker: true },
          exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
          env: {
            DB: { type: "d1", name: "first-party-retail-diary" }, FILES: { type: "kv", id: "first-party-retail-files" },
            LIVE: { type: "durable-object", worker: "first-party-retail-auth", exportName: "LiveHub" }, ASSETS: { type: "assets" },
            ...Object.fromEntries(Object.entries(hosts).map(([name, value]) => [name, plain(value)])),
            COOKIE_DOMAIN: plain("staffstrangerscoffee.com"),
            RESEND_API_KEY: plain("local-fixture-key-not-a-production-key"), RESEND_API_URL: plain("https://mail.example.test/emails"),
          },
        },
        dev: { outboundService: { type: "fetcher", handler: async outgoing => {
          try {
          const target = new URL(outgoing.url), body = await outgoing.text();
          // Miniflare reconstructs the fetcher Request; redirect safety is checked by a real redirect response below.
          assert.equal(outgoing.headers.get("cookie"), null, "staff, wholesale and retail browser cookies never leave the branded host");
          if (target.origin === "https://mail.example.test") {
            assert.equal(target.pathname, "/emails"); assert.equal(outgoing.method, "POST");
            assert.equal(outgoing.headers.get("authorization"), "Bearer local-fixture-key-not-a-production-key");
            const message = JSON.parse(body);
            assert.deepEqual(message.to, [approvedEmail], "the mock provider accepts only the approved fixture recipient");
            assert.match(outgoing.headers.get("idempotency-key"), /^retail-account-[a-f0-9]{64}$/);
            mailCalls.push(message);
            return RuntimeResponse.json({ id: "fixture-retail-mail" });
          }
          assert.equal(target.origin, sitesOrigin, "retail auth calls only the designated account service");
          const record = { path: target.pathname, method: outgoing.method, headers: new Headers(outgoing.headers), body };
          assert.equal(record.headers.get("origin"), brandedOrigin);
          assert.equal(record.headers.get("x-expected-user-id"), null);
          assert.equal(record.headers.get("x-expected-ordering-id"), null);
          assert.equal(record.headers.get("cf-connecting-ip"), null);
          for (const name of ["nonce", "client", "digest", "signature"]) assert.match(record.headers.get("x-strangers-service-" + name), /^[A-Za-z0-9_-]+$/);
          assert.notEqual(record.headers.get("x-strangers-service-client"), "forged-client");
          const digest = createHash("sha256").update(body).digest("base64url");
          assert.equal(record.headers.get("x-strangers-service-digest"), digest);
          const bearer = record.headers.get("authorization")?.replace(/^Bearer /, "") || "";
          const signed = ["STRANGERS-RETAIL-SERVICE-V1", record.method, sitesOrigin, target.pathname + target.search,
            record.headers.get("x-strangers-service-time"), record.headers.get("x-strangers-service-nonce"), record.headers.get("x-strangers-service-client"), bearer, brandedOrigin, digest].join("\n");
          assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey,
            Buffer.from(record.headers.get("x-strangers-service-signature"), "base64url"), Buffer.from(signed)), true, "the actual Worker signs the exact method, destination, body and retail session");
          serviceCalls.push(record);
          return await responder(record);
          } catch (error) {
            return RuntimeResponse.json({ error: "fixture_assertion", message: error.message }, { status: 502 });
          }
        } } },
      }],
    });
    const keyResponse = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/service-key");
    assert.equal(keyResponse.status, 200);
    publicKey = await crypto.subtle.importKey("jwk", (await keyResponse.json()).key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  });
  after(async () => { await runtime?.dispose(); });

  test("first order submission is bound to the reviewed account or an explicit guest", async () => {
    const body = '{"fixture":"order"}';
    const cookie = `${retailCookie}=${retailToken}`;
    const replacement = `${retailCookie}=${Buffer.alloc(32, 42).toString("base64url")}`;
    const binding = createHash("sha256").update("retail-profile:" + retailToken).digest("hex");
    const initialCalls = serviceCalls.length;
    const place = headers => runtime.dispatchFetch(brandedOrigin + "/api/retail/orders", {
      method: "POST", headers: { origin: brandedOrigin, "content-type": "application/json", ...headers }, body,
    });
    for (const headers of [
      { "x-retail-profile-session": binding },
      { cookie: replacement, "x-retail-profile-session": binding },
      { cookie },
    ]) {
      const response = await place(headers);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "checkout_session_unverified");
    }
    assert.equal(serviceCalls.length, initialCalls, "the stale order never reaches placement");
    responder = record => {
      assert.equal(record.path, "/consumer-orders-service/orders");
      assert.equal(record.body, body);
      return RuntimeResponse.json({ placed: true });
    };
    const signedIn = await place({ cookie, "x-retail-profile-session": binding });
    assert.equal(signedIn.status, 200);
    assert.equal(serviceCalls.at(-1).headers.get("authorization"), "Bearer " + retailToken);
    const guest = await place({ cookie: replacement, "x-retail-profile-session": "guest" });
    assert.equal(guest.status, 200);
    assert.equal(serviceCalls.at(-1).headers.get("authorization"), null);
  });

  test("the public service key persists and exposes no private signing material", async () => {
    const first = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/service-key");
    const second = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/service-key");
    const value = await first.json();
    assert.deepEqual(value, await second.json());
    assert.deepEqual(Object.keys(value), ["key"]);
    assert.deepEqual(Object.keys(value.key).sort(), ["crv", "kty", "x", "y"]);
    assert.equal(value.key.kty, "EC"); assert.equal(value.key.crv, "P-256");
    assert.match(value.key.x, /^[A-Za-z0-9_-]{43}$/); assert.match(value.key.y, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.headers.get("cache-control"), /no-store/);
    assert.equal(first.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(first.headers.getSetCookie(), []);
    const key = await (await runtime.getD1Database("DB")).prepare("SELECT v FROM secrets WHERE k = 'retail_service_v1'").first();
    assert.ok(JSON.parse(key.v).privateKey.d, "the real Worker persists its signing key in its own D1");
    const refused = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/service-key", { method: "POST" });
    assert.equal(refused.status, 405); assert.equal(refused.headers.get("allow"), "GET");
  });

  test("every auth mutation requires the exact branded Origin and bounded JSON before contacting Sites", async () => {
    serviceCalls = []; mailCalls = []; responder = () => { throw new Error("rejected request reached the service"); };
    for (const action of Object.keys(fixtures)) {
      for (const origin of [undefined, "null", "http://preview.staffstrangerscoffee.com", brandedOrigin + "/", "https://staffstrangerscoffee.com", "https://strangerscoffee.trade", "https://outside.example"]) {
        const headers = { "content-type": "application/json", cookie: `${retailCookie}=${retailToken}; ${staffCookies}` };
        if (origin) headers.origin = origin;
        const response = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/" + action, { method: "POST", headers, body: JSON.stringify(fixtures[action]) });
        assert.equal(response.status, 403, `${action}: ${origin || "missing Origin"}`);
        assert.equal((await response.json()).error, "bad_origin");
        assert.deepEqual(response.headers.getSetCookie(), []);
      }
      const wrongMethod = await runtime.dispatchFetch(brandedOrigin + "/consumer-auth/" + action);
      assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "POST");
      assert.equal((await send(action, fixtures[action], { "content-type": "text/plain" })).status, 415);
      assert.equal((await send(action, new Uint8Array([0xc3, 0x28]))).status, 400);
      assert.equal((await send(action, JSON.stringify({ payload: "x".repeat(2048) }))).status, 413);
    }
    assert.equal(serviceCalls.length, 0); assert.equal(mailCalls.length, 0);
  });

  test("setup, login and reset issue only a secure retail cookie through signed service requests", async () => {
    for (const action of ["setup", "login", "reset"]) {
      serviceCalls = []; responder = record => {
        assert.equal(record.path, "/consumer-auth-service/" + action); assert.equal(record.method, "POST");
        assert.equal(record.headers.get("authorization"), null, "a browser Authorization header cannot supply the retail session");
        assert.deepEqual(JSON.parse(record.body), fixtures[action]);
        return sessionResult();
      };
      const response = await send(action, fixtures[action], { cookie: staffCookies, authorization: "Bearer fixture-staff", "x-expected-user-id": "fixture-staff", "x-strangers-service-client": "forged-client", "x-strangers-service-signature": "forged-signature" });
      assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { signedIn: true });
      assert.equal(response.headers.get("location"), null); assert.equal(response.headers.get("access-control-allow-origin"), null);
      const cookie = cookieFrom(response, retailCookie); assertHostOnlyCookie(cookie); assert.match(cookie, /Max-Age=14400/);
      assert.equal(cookie.split(";")[0], `${retailCookie}=${retailToken}`);
      assert.equal(response.headers.getSetCookie().length, 1, "no staff, wholesale or upstream cookie is copied");
      assert.equal(serviceCalls.length, 1);
    }
  });

  test("verification and reset links are mailed only to the approved fixture recipient and withheld from browser JSON", async () => {
    serviceCalls = []; mailCalls = [];
    for (const action of ["register", "forgot"]) {
      const kind = action === "register" ? "verify" : "reset";
      responder = record => {
        assert.equal(record.path, "/consumer-auth-service/" + action);
        assert.equal(record.headers.get("authorization"), null);
        return RuntimeResponse.json({ accepted: true, mail: { kind, email: approvedEmail, token: linkToken }, internal: "never expose" }, { status: 202 });
      };
      const response = await send(action, fixtures[action], { cookie: staffCookies });
      assert.equal(response.status, 202, await response.clone().text()); assert.deepEqual(await response.json(), { accepted: true });
      assert.deepEqual(response.headers.getSetCookie(), []); assert.equal(response.headers.get("location"), null);
      const target = action === "register" ? 1 : 2, deadline = Date.now() + 3000;
      while (mailCalls.length < target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(mailCalls.length, target);
      const mail = mailCalls.at(-1), link = new URL(mail.text.match(/https:\/\/\S+/)[0]);
      assert.equal(link.origin, brandedOrigin); assert.equal(link.pathname, "/account/");
      assert.equal(link.searchParams.get("mode"), action === "register" ? "setup" : "reset");
      assert.equal(link.searchParams.has("token"), false); assert.equal(link.hash, "#token=" + linkToken);
      assert.doesNotMatch(mail.text, /chatgpt\.site|signin-with-chatgpt/);
    }
    responder = () => RuntimeResponse.json({ accepted: true }, { status: 202 });
    assert.deepEqual(await (await send("forgot")).json(), { accepted: true });
    assert.equal(mailCalls.length, 2, "an unrecognized email does not cause the gateway to invent a link");
  });

  test("unconfirmed or redirected session results fail closed without exposing service payloads", async () => {
    for (const upstream of [
      () => RuntimeResponse.json({ session: { token: "bad", expiresIn: 14400 } }),
      () => RuntimeResponse.json({ session: { token: retailToken, expiresIn: 14401 } }),
      () => RuntimeResponse.json({ session: { token: retailToken, expiresIn: 1.5 } }),
      () => RuntimeResponse.json({ session: { token: retailToken, expiresIn: 14400 } }, { status: 307, headers: { location: "https://outside.example/collect" } }),
    ]) {
      responder = upstream;
      const result = await send("login");
      assert.equal(result.status, 503); assert.equal(result.headers.get("location"), null);
      assert.deepEqual(result.headers.getSetCookie(), []); assert.equal((await result.json()).error, "retail_unavailable");
    }
    responder = () => RuntimeResponse.json({ error: "invalid_credentials", message: "Check your email and password.", mail: { token: linkToken }, internal: "never expose" }, { status: 429, headers: { "retry-after": "30" } });
    const refused = await send("login");
    assert.equal(refused.status, 429); assert.equal(refused.headers.get("retry-after"), "30");
    assert.deepEqual(await refused.json(), { error: "invalid_credentials", message: "Check your email and password." });
  });

  test("logout revokes only a valid retail session and clears only the host-only retail cookie", async () => {
    serviceCalls = []; responder = record => {
      assert.equal(record.path, "/consumer-auth-service/logout");
      assert.equal(record.headers.get("authorization"), "Bearer " + retailToken);
      assert.deepEqual(JSON.parse(record.body), {});
      return RuntimeResponse.json({ signedIn: false });
    };
    const response = await send("logout", {}, { cookie: `${retailCookie}=${retailToken}; ${staffCookies}`, authorization: "Bearer fixture-staff" });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { signedIn: false });
    const cleared = cookieFrom(response, retailCookie); assertHostOnlyCookie(cleared); assert.match(cleared, /Max-Age=0/);
    assert.equal(response.headers.getSetCookie().length, 1); assert.equal(serviceCalls.length, 1);
    const missing = await send("logout", {}, { cookie: staffCookies });
    assert.equal(missing.status, 200); assert.deepEqual(await missing.json(), { signedIn: false });
    assert.equal(serviceCalls.length, 1, "staff/wholesale cookies never authorize a retail revoke");
    responder = () => { throw new Error("fixture service is unavailable"); };
    const offline = await send("logout", {}, { cookie: `${retailCookie}=${retailToken}` });
    assert.equal(offline.status, 200); assert.match(cookieFrom(offline, retailCookie), /Max-Age=0/);
  });
});
