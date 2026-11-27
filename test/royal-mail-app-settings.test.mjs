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

async function fixture(t, secret = encryptionKey) {
  const requests = [];
  const records = new Map();
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
          WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: binding(existing.booking.key),
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
          return RuntimeResponse.json({ createdOrders: [order], successCount: 1, errorsCount: 0 });
        }
        assert.equal(request.method, "GET");
        requests.push({ method: request.method, carrier: "booking", authorization });
        await onLookup?.();
        const reference = decodeURIComponent(url.pathname.split("/").at(-1)).replaceAll('"', "");
        return RuntimeResponse.json(records.has(reference) ? [records.get(reference)] : []);
      } } },
    }],
  });
  t.after(() => worker.dispose());
  let cookie;
  const call = (path, method = "GET", body, options = {}) => worker.dispatchFetch(host + path, {
    method, redirect: "manual", headers: {
      "content-type": "application/json", origin: host,
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
  return { call, db, interceptLookup, policy, requests, save, seedOrder, sessionCookie, settings };
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
    const { path } = await seedOrder(2);
    await expectJson(await call(path, "POST", packageDetails), 201);
    const view = await expectJson(await call(path + "/refresh", "POST", {}));
    assert.equal(view.shipment.carrierStatus, "Accepted at a Post Office");
    const fresh = requests.slice(start);
    assert.ok(fresh.filter(r => r.carrier === "booking").every(r => r.authorization === "Bearer " + savedBooking.key));
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
