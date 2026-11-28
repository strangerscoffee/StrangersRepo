import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { unseal } from "../src/quickbooks/crypto.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = "https://admin.staffstrangerscoffee.com";
const settingsPath = "/api/admin/wholesale/royal-mail";
const credentialsPath = settingsPath + "/credentials";
const setupCode = "fixture-royal-mail-settings-setup";
const encryptionKey = Buffer.alloc(32, 43).toString("base64url");
const purpose = "strangers/wholesale/royal-mail/credentials/v1";
const trackingNumber = "AB123456789GB";
const customerId = "538d867c-7d6e-4813-9e44-eaa2b5d70b3a";
const existing = {
  booking: { key: "fixture-worker-click-drop-key", serviceCode: "TPS48" },
  tracking: { clientId: "fixture-worker-tracking-id", clientSecret: "fixture-worker-tracking-secret" },
};
const savedBooking = {
  kind: "booking", key: "fixture-admin-click-drop-key", serviceCode: "TPS24",
  serviceRegisterCode: "02", shippingAccountName: "Fixture account",
};
const savedTracking = {
  kind: "tracking", clientId: "fixture-admin-tracking-id", clientSecret: "fixture-admin-tracking-secret", acceptTerms: true,
};
const replacements = ["fixture-concurrent-click-drop-first", "fixture-concurrent-click-drop-second"];
const sensitive = [
  encryptionKey, existing.booking.key, existing.tracking.clientId, existing.tracking.clientSecret,
  savedBooking.key, savedTracking.clientId, savedTracking.clientSecret, ...replacements,
];
const packageDetails = {
  ifVersion: 1, weightGrams: 2140, recipient: {
    name: "Example Coffee Bar", line1: "18 Example Lane", city: "Norwich", postcode: "NR1 5AB",
  },
};

function assertNoCredentials(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const credential of sensitive) assert.equal(text.includes(credential), false, "credential exposed");
}

async function expectJson(response, status = 200) {
  const text = await response.text();
  assertNoCredentials(text);
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

function binding(value) {
  return { type: "text", value };
}

function shipPath(index) {
  const id = "WS-" + index.toString(16).toUpperCase().padStart(32, "0");
  return { id, path: "/api/admin/wholesale/orders/" + id + "/shipping" };
}

const bundle = await build({
  absWorkingDir: root, entryPoints: ["src/index.ts"], bundle: true, write: false,
  format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"],
});

async function fixture(t, secret = encryptionKey, workerBookingKey = existing.booking.key) {
  const requests = [];
  const records = new Map();
  let onCreate;
  let onLookup;
  const worker = new Miniflare({
    host: "127.0.0.1", port: 0, telemetry: { enabled: false }, cf: false,
    workers: [{
      config: {
        name: "royal-mail-app-settings", compatibilityDate: "2026-10-01",
        manifest: { modulesRoot: root, mainModule: "index.js", modules: {
          "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
        } },
        assets: { directory: root + "public", runWorkerFirst: true, hasUserWorker: true },
        exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
        env: {
          ASSETS: { type: "assets" }, DB: { type: "d1", name: "royal-mail-settings-db" },
          FILES: { type: "kv", id: "royal-mail-settings-files" },
          LIVE: { type: "durable-object", worker: "royal-mail-app-settings", exportName: "LiveHub" },
          SETUP_CODE: binding(setupCode), ADMIN_HOST: binding("admin.staffstrangerscoffee.com"),
          COOKIE_DOMAIN: binding("staffstrangerscoffee.com"), QUICKBOOKS_TOKEN_KEY: binding(secret),
          WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: binding(workerBookingKey),
          WHOLESALE_ROYAL_MAIL_SERVICE_CODE: binding(existing.booking.serviceCode),
          WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_ID: binding(existing.tracking.clientId),
          WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_SECRET: binding(existing.tracking.clientSecret),
          WHOLESALE_ROYAL_MAIL_TRACKING_TERMS_ACCEPTED: binding("yes"),
        },
      },
      dev: { outboundService: { type: "fetcher", handler: async request => {
        const url = new URL(request.url);
        if (url.host === "api.royalmail.net") {
          requests.push({ method: request.method, carrier: "tracking", clientId: request.headers.get("x-ibm-client-id"),
            clientSecret: request.headers.get("x-ibm-client-secret"), terms: request.headers.get("x-accept-rmg-terms") });
          return RuntimeResponse.json({ mailPieces: [{
            mailPieceId: url.searchParams.get("mailPieceId"), status: "200",
            summary: { lastEventName: "Accepted at a Post Office", lastEventDateTime: "2026-11-26T10:00:00Z" },
          }] });
        }
        assert.equal(url.host, "api.parcel.royalmail.com");
        const authorization = request.headers.get("authorization");
        if (request.method === "POST") {
          const { items: [item] } = await request.json();
          requests.push({ method: request.method, carrier: "booking", authorization, postage: item.postageDetails });
          const order = {
            orderIdentifier: 900 + records.size, orderReference: item.orderReference, trackingNumber,
            printedOn: "2026-11-26T09:00:00Z",
          };
          records.set(item.orderReference, order);
          return RuntimeResponse.json({ createdOrders: [onCreate?.(order) ?? order], successCount: 1, errorsCount: 0 });
        }
        assert.equal(request.method, "GET");
        const path = decodeURIComponent(url.pathname);
        requests.push({ method: request.method, carrier: "booking", authorization, path });
        const numeric = path.match(/^\/api\/v1\/orders\/(\d+)$/);
        const quoted = path.match(/^\/api\/v1\/orders\/"(WS-[0-9A-F]{32})"$/);
        const order = numeric
          ? [...records.values()].find(row => row.orderIdentifier === Number(numeric[1]))
          : records.get(quoted?.[1]);
        const reply = await onLookup?.(path, order);
        if (reply instanceof RuntimeResponse) return reply;
        return RuntimeResponse.json(order ? [order] : []);
      } } },
    }],
  });
  t.after(() => worker.dispose());
  let cookie;
  const call = (path, method = "GET", body, options = {}) => worker.dispatchFetch((options.host ?? host) + path, {
    method, redirect: "manual", headers: {
      "content-type": "application/json", origin: options.host ?? host,
      ...((options.cookie ?? cookie) ? { cookie: options.cookie ?? cookie } : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sessionCookie = response => response.headers.getSetCookie()
    .find(value => /^sfbb_session=[^;]/.test(value))?.split(";")[0];
  const admin = await call("/api/auth/setup", "POST", {
    username: "settings.admin", password: "Fixture settings password 123!",
    code: setupCode, name: "Settings Admin",
  });
  await expectJson(admin);
  cookie = sessionCookie(admin);
  assert.ok(cookie);
  const db = await worker.getD1Database("DB");
  async function seedOrder(index) {
    const { id, path } = shipPath(index);
    const order = {
      preview: false, customerId, status: "Ready", delivery: "Delivery", business: "Example Coffee Bar",
      createdAt: Date.now(), grams: 2000, packs: 2, pence: 3500, deliveryPence: 500, totalPence: 4000,
      lines: [{ productId: "brazil", title: "Brazil", pack: "kilo", grind: "beans", quantity: 2, grams: 1000 }],
      locationSnapshot: { address: "18 Example Lane\nNorwich", postcode: "NR1 5AB" },
    };
    await db.prepare("INSERT INTO wholesale_preview(kind, id, data, version, updated_at) VALUES ('order', ?, ?, 1, ?)")
      .bind(id, JSON.stringify(order), Date.now()).run();
    return { id, path };
  }
  const settings = async () => expectJson(await call(settingsPath));
  const save = async (data, status = 200) => expectJson(await call(credentialsPath, "PUT", {
    ifVersion: (await settings()).version, ...data,
  }), status);
  const policy = () => db.prepare("SELECT * FROM wholesale_royal_mail_settings WHERE id = 1").first();
  function interceptLookup(handler) {
    onLookup = handler;
  }
  function interceptCreate(handler) {
    onCreate = handler;
  }
  return { call, db, interceptLookup, interceptCreate, policy, requests, save, seedOrder, sessionCookie, settings };
}

test("Royal Mail credential settings protect booking and tracking secrets", async t => {
  const { call, db, interceptLookup, policy, requests, save, seedOrder, sessionCookie, settings } = await fixture(t);

  await t.test("admin-only writes guard origin, identity and the unchanged Worker setup", async () => {
    const first = await call(settingsPath);
    assert.match(first.headers.get("cache-control") ?? "", /no-store/);
    const state = await expectJson(first);
    assert.equal(state.version, 0);
    assert.equal(state.enabled, false);
    assert.equal(state.serviceCode, existing.booking.serviceCode);
    assert.equal(state.bookingConfigured, true);
    assert.equal(state.trackingConfigured, true);
    assert.equal(state.credentialSetup.storageReady, true);
    assert.equal(state.credentialSetup.bookingSource, "worker");
    assert.equal(state.credentialSetup.trackingSource, "worker");
    const attempt = { ifVersion: state.version, ...savedBooking };
    assert.equal((await call(credentialsPath, "PUT", attempt, { cookie: "" })).status, 401);
    assert.equal((await call(credentialsPath, "PUT", attempt, { headers: { origin: "https://other.example.test" } })).status, 403);
    assert.equal((await call(credentialsPath, "PUT", attempt, { headers: { "x-expected-user-id": "other-admin" } })).status, 409);
    const staff = { username: "settings.staff", password: "Fixture settings temp password 123!" };
    await expectJson(await call("/api/admin/users", "POST", { ...staff, name: "Settings Staff", role: "staff" }));
    const signedIn = await call("/api/auth/change", "POST", { ...staff, newPassword: "Own settings password 123!" }, { cookie: "" });
    assert.equal(signedIn.status, 200);
    const cookie = sessionCookie(signedIn);
    assert.ok(cookie);
    assert.equal((await call(settingsPath, "GET", undefined, { cookie })).status, 403);
    assert.equal((await call(credentialsPath, "PUT", attempt, { cookie })).status, 403);
    assert.equal((await save({ ...savedBooking, key: "" }, 400)).code, "invalid_argument");
    assert.equal((await policy()).booking_config, null);
    assert.equal(requests.length, 0);
    assert.equal((await settings()).version, state.version);
  });

  await t.test("configured Worker values still book and track without an Admin override", async () => {
    const state = await settings();
    assert.equal((await expectJson(await call(settingsPath, "PUT", { ifVersion: state.version, enabled: true }))).enabled, true);
    const { path } = await seedOrder(1);
    await expectJson(await call(path, "POST", packageDetails), 201);
    await expectJson(await call(path + "/refresh", "POST", {}));
    const posted = requests.find(request => request.carrier === "booking" && request.method === "POST");
    const scan = requests.find(request => request.carrier === "tracking");
    assert.equal(posted.authorization, "Bearer " + existing.booking.key);
    assert.equal(posted.postage.serviceCode, existing.booking.serviceCode);
    assert.deepEqual(scan, { carrier: "tracking", method: "GET", ...existing.tracking, terms: "yes" });
  });

  await t.test("saved settings stay private and drive the real booking, lookup and tracking paths", async () => {
    assert.equal((await save({ ...savedTracking, acceptTerms: false }, 400)).code, "invalid_argument");
    const booking = await save(savedBooking);
    assert.equal(booking.enabled, true);
    assert.equal(booking.serviceCode, savedBooking.serviceCode);
    assert.deepEqual(booking.credentialSetup, {
      storageReady: true, bookingSource: "admin", trackingSource: "worker",
      bookingReadable: true, trackingReadable: true, serviceRegisterCode: "02", shippingAccountName: "Fixture account",
    });
    const tracking = await save(savedTracking);
    assert.equal(tracking.enabled, true);
    assert.equal(tracking.credentialSetup.trackingSource, "admin");
    assert.equal(tracking.version, booking.version + 1);
    assert.equal((await save({ ...savedTracking, clientId: "fixture-new-client-id", clientSecret: "" }, 400)).code, "invalid_argument");
    assert.equal((await settings()).version, tracking.version);
    const row = await policy();
    assert.ok(row.booking_config && row.tracking_config);
    assert.notEqual(row.booking_config, row.tracking_config);
    assertNoCredentials(row);
    const sealed = JSON.parse(row.booking_config);
    await assert.rejects(unseal(sealed.data, encryptionKey, "booking", sealed.generation, purpose));
    const scoped = Buffer.from(hkdfSync("sha256", Buffer.from(encryptionKey, "base64url"), Buffer.alloc(32),
      Buffer.from(purpose), 32)).toString("base64url");
    assert.equal((await unseal(sealed.data, scoped, "booking", sealed.generation, purpose)).key, savedBooking.key);
    const retained = await save({ ...savedBooking, key: "", serviceCode: "TPS48" });
    assert.equal(retained.serviceCode, "TPS48");
    assert.equal(retained.credentialSetup.bookingSource, "admin");
    assert.equal((await save({ kind: "tracking", clientId: "", clientSecret: "", acceptTerms: true })).trackingConfigured, true);
    const start = requests.length;
    const { id, path } = await seedOrder(2);
    await expectJson(await call(path, "POST", packageDetails), 201);
    const expectedScope = Buffer.from(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(savedBooking.key + "\u0000" + savedBooking.shippingAccountName))).toString("base64");
    const shipment = await db.prepare("SELECT booking_account_scope FROM wholesale_royal_mail_shipments WHERE order_id = ?").bind(id).first();
    assert.equal(shipment.booking_account_scope, expectedScope, "confirmed create binds setup evidence to the chosen billing account");
    const view = await expectJson(await call(path + "/refresh", "POST", {}));
    assert.equal(view.shipment.carrierStatus, "Accepted at a Post Office");
    const fresh = requests.slice(start);
    assert.ok(fresh.filter(r => r.carrier === "booking").every(r => r.authorization === "Bearer " + savedBooking.key));
    assert.deepEqual(fresh.filter(r => r.carrier === "booking" && r.method === "GET").map(r => r.path),
      [`/api/v1/orders/"${id}"`, "/api/v1/orders/901"]);
    assert.deepEqual(fresh.find(r => r.carrier === "booking" && r.method === "POST")?.postage, {
      serviceCode: "TPS48", serviceRegisterCode: "02", shippingAccountName: "Fixture account",
    });
    const track = fresh.find(r => r.carrier === "tracking");
    assert.equal(track?.clientId, savedTracking.clientId);
    assert.equal(track?.clientSecret, savedTracking.clientSecret);
    assert.equal(track?.terms, "yes");
  });

  await t.test("concurrent edits compare and update the same setup version atomically", async () => {
    const { version } = await settings();
    const updates = await Promise.all(replacements.map(key =>
      call(credentialsPath, "PUT", { ...savedBooking, key, ifVersion: version })));
    assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
    for (const response of updates) assertNoCredentials(await response.text());
    const after = await settings();
    assert.equal(after.version, version + 1);
    assert.equal(after.enabled, true);
    assert.equal((await expectJson(await call(settingsPath, "PUT", { ifVersion: version, enabled: false }), 409)).code, "conflict");
  });

  await t.test("credential rotation during carrier lookup prevents a booking with stale credentials", async () => {
    const { id, path } = await seedOrder(6);
    const start = requests.length;
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    interceptLookup(async () => { enter(); await held; });
    const first = call(path, "POST", packageDetails);
    try {
      const early = await Promise.race([entered.then(() => null), first]);
      if (early) assert.fail(await early.text());
      await save(savedBooking);
    } finally {
      release();
      interceptLookup(undefined);
    }
    assert.equal((await expectJson(await first, 409)).code, "royal_mail_booking_policy_changed");
    assert.equal(requests.slice(start).some(r => r.method === "POST"), false);
    const row = await db.prepare("SELECT requested_at FROM wholesale_royal_mail_shipments WHERE order_id = ?").bind(id).first();
    assert.equal(row.requested_at, 0);
  });

  await t.test("unreadable Admin overrides block only their own carrier calls and require a full replacement", async () => {
    const row = await policy();
    await db.prepare("UPDATE wholesale_royal_mail_settings SET booking_config = ? WHERE id = 1")
      .bind("damaged-encrypted-envelope").run();
    const damaged = await settings();
    assert.equal(damaged.credentialSetup.bookingSource, "admin");
    assert.equal(damaged.credentialSetup.bookingReadable, false);
    assert.equal(damaged.bookingConfigured, false);
    assert.equal(damaged.trackingConfigured, true);
    assert.equal((await save({ ...savedBooking, key: "" }, 400)).code, "invalid_argument");
    const { path } = await seedOrder(3);
    const start = requests.length;
    assert.ok([409, 503].includes((await call(path, "POST", packageDetails)).status));
    assert.equal(requests.length, start, "a broken saved key must not fall back to the Worker key");
    assert.equal((await save(savedBooking)).bookingConfigured, true);
    await db.prepare("UPDATE wholesale_royal_mail_settings SET tracking_config = ? WHERE id = 1").bind(row.booking_config).run();
    const crossKind = await settings();
    assert.equal(crossKind.credentialSetup.trackingSource, "admin");
    assert.equal(crossKind.credentialSetup.trackingReadable, false);
    assert.equal(crossKind.trackingConfigured, false);
    assert.equal(crossKind.bookingConfigured, true);
    const next = await seedOrder(4);
    await expectJson(await call(next.path, "POST", packageDetails), 201);
    const refresh = requests.length;
    await expectJson(await call(next.path + "/refresh", "POST", {}));
    assert.deepEqual(requests.slice(refresh).map(r => r.carrier), ["booking"]);
    assert.equal((await save(savedTracking)).trackingConfigured, true);
  });

  await t.test("credential changes appear in the audit trail and backups exclude even encrypted credentials", async () => {
    const audit = (await db.prepare("SELECT * FROM audit_log").all()).results;
    const events = audit.filter(row => row.kind === "wholesale_royal_mail").map(row => row.text);
    assert.ok(events.includes("Royal Mail Click & Drop credentials saved."));
    assert.ok(events.includes("Royal Mail tracking credentials saved."));
    assertNoCredentials(audit);
    const { backup } = await expectJson(await call("/api/admin/backups", "POST", {}));
    const downloaded = await expectJson(await call("/api/admin/backups/" + backup.id));
    assert.equal(downloaded.royalMailSettings.enabled, 1);
    assert.equal(downloaded.royalMailSettings.version, (await settings()).version);
    const text = JSON.stringify(downloaded);
    const row = await policy();
    assert.doesNotMatch(text, /booking_config|tracking_config|booking_connection/);
    assert.equal(text.includes(row.booking_config), false);
    assert.equal(text.includes(row.tracking_config), false);
    for (const encrypted of [row.booking_config, row.tracking_config]) {
      assert.equal(text.includes(JSON.parse(JSON.parse(encrypted).data).cipher), false);
    }
  });
});

test("a timed-out confirmation of an accepted order recovers only its exact numeric ID under the original credential", async t => {
  const { call, db, interceptCreate, interceptLookup, requests, save, seedOrder } = await fixture(t);
  const original = await save(savedBooking);
  await expectJson(await call(settingsPath, "PUT", { ifVersion: original.version, enabled: true }));
  const { id, path } = await seedOrder(10);
  const numericPath = "/api/v1/orders/900";
  const stored = () => db.prepare("SELECT provider_id,candidate_provider_id FROM wholesale_royal_mail_shipments WHERE order_id=?").bind(id).first();
  const retry = async () => {
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET refresh_after=0 WHERE order_id=?").bind(id).run();
    return expectJson(await call(path + "/refresh", "POST", {}));
  };
  const assertHeld = async view => {
    assert.equal(view.shipment.state, "review");
    assert.equal(view.shipment.orderId, null);
    assert.equal(view.shipment.trackingNumber, null);
    assert.equal(view.canCreate, false);
    assert.doesNotMatch(JSON.stringify(view), /candidate/i);
    assert.deepEqual(await stored(), { provider_id: null, candidate_provider_id: 900 });
    assert.equal((await call(path + "/label")).status, 409);
  };
  interceptCreate(order => ({ orderIdentifier: order.orderIdentifier, createdOn: "2026-11-28T13:40:00Z" }));
  interceptLookup(lookup => lookup === numericPath ? new RuntimeResponse(null, { status: 504 }) : undefined);
  await assertHeld(await expectJson(await call(path, "POST", packageDetails), 202));
  assert.deepEqual(requests.map(r => [r.method, r.path]), [
    ["GET", `/api/v1/orders/"${id}"`], ["POST", undefined], ["GET", numericPath],
  ]);

  await save({ ...savedBooking, key: replacements[0] });
  const beforeRotationCheck = requests.length;
  await assertHeld(await retry());
  await assertHeld(await expectJson(await call(path, "POST", packageDetails), 202));
  assert.equal(requests.length, beforeRotationCheck, "the new key cannot query the candidate or buy postage");

  await save(savedBooking);
  for (const results of [[], [{ orderIdentifier: 901, orderReference: id }],
    [{ orderIdentifier: 900, orderReference: shipPath(11).id }],
    [{ orderIdentifier: 900, orderReference: id }, { orderIdentifier: 900, orderReference: id }]]) {
    interceptLookup(() => RuntimeResponse.json(results));
    const start = requests.length;
    await assertHeld(await retry());
    assert.deepEqual(requests.slice(start).map(r => [r.path, r.authorization]), [[numericPath, "Bearer " + savedBooking.key]]);
  }
  interceptLookup(undefined);
  const recovered = await retry();
  assert.equal(recovered.shipment.state, "labelled");
  assert.deepEqual(await stored(), { provider_id: 900, candidate_provider_id: null });
  assert.equal(recovered.shipment.orderId, 900);
  assert.equal((await expectJson(await call(path, "POST", packageDetails))).shipment.orderId, 900);
  assert.equal(requests.filter(r => r.method === "POST").length, 1, "recovery never sends another purchase");
});

test("Admin links only a verified Click & Drop order, fenced against purchases, settings changes and duplicate attachments", async t => {
  const { call, db, interceptLookup, requests, save, seedOrder, sessionCookie, settings } = await fixture(t);
  await save(savedBooking);
  async function hold(index, state = "failed", requestedAt = 0) {
    const { id, path } = await seedOrder(index);
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at,requested_at,problem)
      VALUES (?, ?, ?, 1, 2140, 1, ?, 'Royal Mail rejected the order-reference lookup.')`)
      .bind(id, state, "existing-" + index, requestedAt).run();
    const initial = await expectJson(await call(path));
    assert.equal(initial.canLinkOrder, true);
    return { id, path, data: { ifVersion: initial.orderVersion, bookingVersion: initial.bookingVersion,
      operation: initial.linkOperation, orderNumber: String(8000 + index) } };
  }
  const link = (order, overrides = {}, options = {}) => call(order.path + "/link-order", "POST", { ...order.data, ...overrides }, options);
  const carrierOrder = order => ({ orderReference: order.id, orderIdentifier: Number(order.data.orderNumber),
    trackingNumber, printedOn: "2026-11-28T09:00:00Z" });
  const keyFingerprint = async value => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("base64");
  const row = order => db.prepare("SELECT state,provider_id,review_required,refresh_after FROM wholesale_royal_mail_shipments WHERE order_id=?")
    .bind(order.id).first();

  const legacy = await hold(50, "failed", null);
  assert.equal((await call(legacy.path + "/link-order")).status, 405);
  assert.equal((await link(legacy, {}, { cookie: "" })).status, 401);
  const staff = { username: "link.staff", password: "Temporary Linker 123!" };
  await expectJson(await call("/api/admin/users", "POST", { ...staff, name: "Packing staff", role: "staff" }));
  const signedIn = await call("/api/auth/change", "POST", { ...staff, newPassword: "Own packing password 123!" }, { cookie: "" });
  assert.equal((await link(legacy, {}, { cookie: sessionCookie(signedIn) })).status, 403);
  assert.equal((await call(legacy.path.replace("/api/admin/wholesale/", "/api/staff-orders/") + "/link-order", "POST", legacy.data,
    { host: "https://staffstrangerscoffee.com" })).status, 403, "even an Admin using the staff workspace cannot link");
  assert.equal((await link(legacy, { orderNumber: trackingNumber })).status, 400);
  assert.equal((await link(legacy, { operation: "obsolete" })).status, 409);
  assert.equal((await link(legacy, { ifVersion: 0 })).status, 409);
  assert.equal((await link(legacy, { bookingVersion: 0 })).status, 409);
  assert.equal(requests.length, 0);

  const foreign = { ...carrierOrder(legacy), orderReference: "WS-PRIVATE-OTHER", trackingNumber: "ZZ123456789GB" };
  for (const reply of [[], [foreign], [{ ...carrierOrder(legacy), orderIdentifier: 99 }], [carrierOrder(legacy), carrierOrder(legacy)]]) {
    interceptLookup(() => RuntimeResponse.json(reply));
    const error = await expectJson(await link(legacy), 409);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE-OTHER|ZZ123456789GB/);
    assert.equal((await row(legacy)).provider_id, null);
    assert.equal((await row(legacy)).refresh_after, null, "a rejected check releases its lease");
  }
  interceptLookup(() => new RuntimeResponse(null, { status: 502 }));
  await expectJson(await link(legacy), 503);
  assert.equal((await row(legacy)).state, "failed");
  interceptLookup(() => RuntimeResponse.json([carrierOrder(legacy)]));
  const linked = await expectJson(await link(legacy));
  assert.equal(linked.bookingEnabled, false, "a read-only link works when new bookings are paused");
  assert.equal(linked.shipment.orderId, 8050);
  assert.equal(linked.shipment.state, "labelled");
  assert.equal(linked.shipment.reviewRequired, true);
  assert.equal(linked.shipment.trackingUrl, null);
  assert.equal(linked.shipment.requestedAt, null, "linking retains the historical unknown marker");
  assert.equal((await call(legacy.path + "/label")).status, 409);
  assert.equal((await link(legacy)).status, 409);
  assert.ok(requests.every(request => request.method === "GET" && request.path === "/api/v1/orders/8050"));

  const scope = await hold(51, "review", 1000);
  await db.prepare("UPDATE wholesale_royal_mail_shipments SET candidate_provider_id=?, booking_connection=?, booking_account_scope=? WHERE order_id=?")
    .bind(8051, await keyFingerprint(savedBooking.key), await keyFingerprint(savedBooking.key + "\0" + savedBooking.shippingAccountName), scope.id).run();
  const before = requests.length;
  await expectJson(await link(scope, { orderNumber: "8151" }), 409);
  scope.data.bookingVersion = (await save({ ...savedBooking, key: replacements[0] })).version;
  await expectJson(await link(scope), 409);
  scope.data.bookingVersion = (await save({ ...savedBooking, shippingAccountName: "Different fixture account" })).version;
  await expectJson(await link(scope), 409);
  assert.equal(requests.length, before);
  scope.data.bookingVersion = (await save(savedBooking)).version;
  interceptLookup(() => RuntimeResponse.json([carrierOrder(scope)]));
  assert.equal((await expectJson(await link(scope))).shipment.reviewRequired, true);
  const duplicate = await hold(52);
  duplicate.data.orderNumber = scope.data.orderNumber;
  interceptLookup(() => RuntimeResponse.json([carrierOrder(duplicate)]));
  await expectJson(await link(duplicate), 409);
  assert.equal((await row(duplicate)).provider_id, null);

  await expectJson(await call(settingsPath, "PUT", { ifVersion: (await settings()).version, enabled: true }));
  const racing = await hold(53);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  interceptLookup(async () => { enter(); await delayed; return RuntimeResponse.json([carrierOrder(racing)]); });
  const inFlight = link(racing);
  try {
    await entered;
    assert.equal((await call(racing.path, "POST", packageDetails)).status, 202, "new postage waits for the existing-order check");
    assert.equal((await link(racing)).status, 409);
    await db.prepare("UPDATE wholesale_preview SET version=version+1 WHERE kind='order' AND id=?").bind(racing.id).run();
  } finally { release(); }
  await expectJson(await inFlight, 409);
  assert.equal((await row(racing)).provider_id, null, "a stale carrier result cannot attach after an order edit");
  const changedCandidate = await hold(54, "review", 2000);
  interceptLookup(async () => {
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET candidate_provider_id=? WHERE order_id=?")
      .bind(8154, changedCandidate.id).run();
    return RuntimeResponse.json([carrierOrder(changedCandidate)]);
  });
  await expectJson(await link(changedCandidate), 409);
  assert.equal((await row(changedCandidate)).provider_id, null);
  const beforeUnpinned = requests.length;
  await expectJson(await link(changedCandidate, { orderNumber: 8154 }), 409);
  assert.equal(requests.length, beforeUnpinned, "a candidate without an original connection cannot be queried by number");
  const revoked = await hold(55);
  interceptLookup(async () => {
    await db.prepare("UPDATE users SET role='staff' WHERE username='settings.admin'").run();
    return RuntimeResponse.json([carrierOrder(revoked)]);
  });
  await expectJson(await link(revoked), 409);
  assert.equal((await row(revoked)).provider_id, null, "losing Admin rights during the carrier read prevents linking");
  assert.equal(requests.filter(r => r.method === "POST").length, 0);
});

test("a missing encryption key prevents saves and never activates Worker credentials over an Admin override", async t => {
  const saved = await fixture(t);
  await saved.save(savedBooking);
  const encrypted = (await saved.policy()).booking_config;
  assert.ok(encrypted);
  const { call, db, policy, requests, save, seedOrder, settings } = await fixture(t, "");
  const initial = await settings();
  assert.equal(initial.credentialSetup.storageReady, false);
  assert.equal(initial.credentialSetup.bookingSource, "worker");
  assert.equal(initial.bookingConfigured, true);
  assert.equal((await save(savedBooking, 409)).code, "royal_mail_encryption_required");
  assert.equal((await policy()).booking_config, null);
  await db.prepare("UPDATE wholesale_royal_mail_settings SET booking_config = ?, enabled = 1 WHERE id = 1")
    .bind(encrypted).run();
  const blocked = await settings();
  assert.equal(blocked.credentialSetup.bookingSource, "admin");
  assert.equal(blocked.credentialSetup.bookingReadable, false);
  assert.equal(blocked.bookingConfigured, false);
  assert.equal(blocked.trackingConfigured, true);
  const { path } = await seedOrder(5);
  assert.ok([409, 503].includes((await call(path, "POST", packageDetails)).status));
  assert.equal(requests.length, 0);
});

test("setup checks record carrier evidence and dated Admin confirmations without purchasing postage", async t => {
  const { call, db, interceptLookup, requests, save, sessionCookie } = await fixture(t);
  const path = settingsPath + "/checks";
  const get = () => call(path).then(r => expectJson(r));
  const write = (state, method, data) => call(path, method, { ifVersion: state.version, scope: state.scope, ...data });
  const request = async (method, data, status = 200) => expectJson(await write(await get(), method, data), status);
  const confirm = (id, evidence, status) => request("PUT", { id, evidence, confirmed: true }, status);
  const initial = await get();
  assert.deepEqual(initial, { version: 0, scope: initial.scope, serviceCode: existing.booking.serviceCode, serviceRegisterCode: null, automated: null, manual: {} });
  assert.match(initial.scope, /^[a-f0-9]{64}$/);
  const secretsInDb = await db.prepare("SELECT scope_key FROM wholesale_royal_mail_setup_checks").first();
  assert.ok(!JSON.stringify(initial).includes(secretsInDb.scope_key));
  assert.equal(requests.length, 0);

  await t.test("only Admin can view, check and confirm; state changes require the site origin and current settings", async () => {
    const staff = { username: "setupchecks.staff", password: "Fixture test temp password 123!" };
    await expectJson(await call("/api/admin/users", "POST", { ...staff, name: "Checks Staff", role: "staff" }));
    const signedIn = await call("/api/auth/change", "POST", { ...staff, newPassword: "Own checks password 123!" }, { cookie: "" });
    const cookie = sessionCookie(signedIn);
    assert.ok(cookie);
    for (const method of ["GET", "POST", "PUT"]) {
      const payload = method === "GET" ? undefined : { ifVersion: 0, scope: initial.scope };
      assert.equal((await call(path, method, payload, { cookie })).status, 403);
      assert.equal((await call(path, method, payload, { cookie: "" })).status, 401);
      if (method === "GET") continue;
      assert.equal((await call(path, method, payload, { headers: { origin: "https://other.example.test" } })).status, 403);
      assert.equal((await call(path, method, payload, { headers: { "x-expected-user-id": "another-user" } })).status, 409);
    }
    assert.equal((await call(path, "DELETE")).status, 405);
    assert.equal((await call(path, "POST", { ifVersion: 0, scope: "stale" })).status, 409);
    assert.equal((await call(path, "PUT", { ifVersion: 0 })).status, 409);
    assert.equal(requests.length, 0);
  });

  await t.test("manual evidence is limited to structured fields, can be edited or removed, and changes are attributed to the Admin", async () => {
    await confirm("printer", { format: "a4", document: existing.booking.key }, 400);
    await confirm("returnAddress", { address: "18 Example Lane" }, 400);
    await confirm("register", { requirement: "configured" }, 400);
    await confirm("collection", { carrier: "parcelforce", site: "warehouse", cutoff: "24:00", owner: "shiftSupervisor" }, 400);
    await confirm("parcelLimits", { maxWeightGrams: 30001, maxLengthCm: 150 }, 400);
    await confirm("parcelLimits", { maxWeightGrams: 30000, maxLengthCm: 150, maxLengthPlusGirthCm: 50 }, 400);
    await confirm("__proto__", {}, 400);
    assert.deepEqual((await get()).manual, {});

    await confirm("returnAddress", {});
    const start = await get();
    const updates = await Promise.all(["a4", "thermal4x6"].map(format => write(start, "PUT", { id: "printer", evidence: { format }, confirmed: true })));
    assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
    const result = await confirm("printer", { format: "thermal4x6" });
    assert.deepEqual(result.manual.printer.evidence, { format: "thermal4x6" });
    assert.equal(result.manual.printer.confirmedBy, "Settings Admin");
    assert.ok(result.manual.printer.confirmedAt > 0);
    assert.deepEqual((await get()).manual, result.manual);
    await confirm("register", { requirement: "notRequired" });
    await confirm("collection", { carrier: "parcelforce", site: "warehouse", cutoff: "16:30", owner: "shiftSupervisor" });
    await confirm("parcelLimits", { maxWeightGrams: 20000, maxLengthCm: 120, maxLengthPlusGirthCm: 190 });
    const state = await request("PUT", { id: "returnAddress", confirmed: false });
    assert.equal(state.manual.returnAddress, undefined);
    assert.ok(state.manual.printer, "removing one check preserves the others");
    assert.equal(requests.length, 0);
    assert.equal(state.automated, null);
    assert.equal((await db.prepare("SELECT enabled FROM wholesale_royal_mail_settings").first()).enabled, 0);
  });

  await t.test("the end-of-day manifest only counts on its handover date in London", async () => {
    const evidence = { owner: "dispatchLead", site: "warehouse", proof: "signedManifest" };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    await request("PUT", { id: "manifest", confirmed: true, evidence }, 409);
    const invalidDate = await request("PUT", { id: "manifest", confirmed: true, evidence, manifestDay: "2000-01-01" }, 409);
    assert.equal(invalidDate.code, "conflict");
    const state = await request("PUT", { id: "manifest", confirmed: true, evidence, manifestDay: today });
    assert.deepEqual(state.manual.manifest.evidence, evidence);
    await db.prepare("UPDATE wholesale_royal_mail_setup_checks SET manual = json_set(manual, '$.manifest.confirmedAt', ?) WHERE id = 1")
      .bind(Date.now() - 48 * 60 * 60 * 1000).run();
    const expired = await get();
    assert.equal(expired.manual.manifest, undefined);
    assert.ok(expired.manual.collection);
    assert.ok((await request("PUT", { id: "manifest", confirmed: true, evidence, manifestDay: today })).manual.manifest.confirmedAt > Date.now() - 60_000);
  });

  await t.test("sample addresses are transient; running and opening checks never buys postage, downloads on behalf of packers or touches orders", async () => {
    const sample = { weightGrams: 2610, postcode: "NR33 7EX" };
    const before = requests.length;
    for (const invalid of [{ postcode: "BT1 1AA", weightGrams: 1000 }, { ...sample, weightGrams: 0 }, { ...sample, name: "Example Coffee Bar" }]) {
      await request("POST", { sample: invalid }, 400);
    }
    assert.equal(requests.length, before);
    const state = await request("POST", { sample });
    assert.equal(state.automated.checkedBy, "Settings Admin");
    assert.ok(state.automated.checkedAt > 0 && state.automated.checks.length >= 4);
    assert.ok(state.automated.checks.some(row => row.status !== "passed"));
    assert.ok(requests.length > before);
    assert.ok(requests.slice(before).every(row => row.method === "GET"));
    const settled = requests.length;
    assert.deepEqual(await get(), state);
    assert.equal(requests.length, settled, "opening the page is local only");
    assert.deepEqual((await db.prepare("SELECT order_id FROM wholesale_royal_mail_shipments").all()).results, []);
    const saved = await db.prepare("SELECT * FROM wholesale_royal_mail_setup_checks").first();
    const trail = (await db.prepare("SELECT text FROM audit_log WHERE kind = 'wholesale_royal_mail'").all()).results;
    for (const content of [state, saved, trail]) {
      const encoded = JSON.stringify(content);
      assertNoCredentials(encoded);
      assert.ok(!encoded.includes(sample.postcode));
      assert.ok(!encoded.includes("Example Coffee Bar"));
    }
    assert.ok(trail.some(e => e.text.includes("confirmed in Royal Mail setup")));
  });

  await t.test("a Worker credential change invalidates evidence even when the saved settings version stays the same", async () => {
    const saved = await db.prepare("SELECT * FROM wholesale_royal_mail_setup_checks").first();
    const rotated = await fixture(t, encryptionKey, "fixture-rotated-worker-booking-key");
    await rotated.db.prepare("UPDATE wholesale_royal_mail_setup_checks SET scope_key=?, version=?, scope=?, automated=?, manual=? WHERE id=1")
      .bind(saved.scope_key, saved.version, saved.scope, saved.automated, saved.manual).run();
    const current = await expectJson(await rotated.call(path));
    assert.equal((await rotated.settings()).version, 0);
    assert.notEqual(current.scope, saved.scope);
    assert.equal(current.automated, null);
    assert.deepEqual(current.manual, {});
    assert.equal(rotated.requests.length, 0);
    await rotated.db.prepare("UPDATE wholesale_royal_mail_settings SET booking_config = 'unreadable' WHERE id = 1").run();
    const missing = await expectJson(await rotated.call(path));
    assert.equal(missing.serviceCode, null);
    assert.equal(missing.serviceRegisterCode, null);
    for (const [id, evidence] of [["register", { requirement: "notRequired" }], ["parcelLimits", { maxWeightGrams: 5000, maxLengthCm: 100 }]]) {
      const denied = await expectJson(await rotated.call(path, "PUT", { ifVersion: missing.version, scope: missing.scope, id, evidence, confirmed: true }), 400);
      assert.match(denied.message, /save a valid booking service/i);
    }
  });

  await t.test("credential rotation during provider checks discards the in-flight result and invalidates previous evidence", async () => {
    const previous = await get();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    interceptLookup(async () => { enter(); await held; });
    const checking = write(previous, "POST", { sample: { postcode: "NR1 4AA", weightGrams: 300 } });
    try {
      const early = await Promise.race([entered.then(() => null), checking]);
      if (early) assert.fail(await early.text());
      await save({ ...savedBooking, serviceCode: "NDB" });
    } finally { release(); interceptLookup(undefined); }
    assert.equal((await expectJson(await checking, 409)).code, "conflict");
    const changed = await get();
    assert.notEqual(changed.scope, previous.scope);
    assert.equal(changed.serviceCode, "NDB");
    assert.equal(changed.serviceRegisterCode, savedBooking.serviceRegisterCode);
    assert.equal(changed.automated, null);
    assert.deepEqual(changed.manual, {});
    assert.equal((await write(previous, "PUT", { id: "printer", confirmed: true, evidence: { format: "a4" } })).status, 409);
    const limits = { maxWeightGrams: 30000, maxLengthCm: 150, maxVolumeLitres: 220 };
    const oversizeContract = { ...limits, maxLengthCm: 175, maxVolumeLitres: 250 };
    assert.deepEqual((await confirm("parcelLimits", oversizeContract)).manual.parcelLimits.evidence, oversizeContract,
      "the agreement can allow parcels above express24's standard surcharge thresholds");
    await confirm("parcelLimits", { ...limits, maxVolumeLitres: undefined }, 400);
    await confirm("register", { requirement: "notRequired" }, 400);
    assert.deepEqual((await confirm("parcelLimits", limits)).manual.parcelLimits.evidence, limits);
    const valid = await confirm("register", { requirement: "configured" });
    await expectJson(await call(settingsPath, "PUT", { ifVersion: (await expectJson(await call(settingsPath))).version, enabled: true }));
    assert.deepEqual(await get(), valid, "turning bookings on preserves preparatory checks for the same connection");
  });
});
