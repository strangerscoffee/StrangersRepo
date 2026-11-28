import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = "https://admin.staffstrangerscoffee.com";
const diary = "https://staffstrangerscoffee.com";
const number = "AB123456789GB";
const replacement = "UR041761424QI";
const pdf = "%PDF-1.7\nFixture label\n%%EOF\n";
const setupCode = "royal-mail-local-test";
const business = "Example Coffee Bar";
const customerId = "538d867c-7d6e-4813-9e44-eaa2b5d70b3a";
const orderRef = index => "WS-" + index.toString(16).toUpperCase().padStart(32, "0");
const orderPath = id => "/api/admin/wholesale/orders/" + id;
const shipPath = id => orderPath(id) + "/shipping";
const settingsPath = "/api/admin/wholesale/royal-mail";
const binding = value => ({ type: "text", value });
const packageDetails = { ifVersion: 1, weightGrams: 2140, recipient: {
  name: "Example Coffee Bar", line1: "18 Example Lane", city: "Norwich", postcode: "NR1 5AB",
} };

test("wholesale shipping keeps booking, label validity and dispatch consistent across requests", async t => {
  const bundle = await build({ absWorkingDir: root, bundle: true,
    stdin: { resolveDir: root, contents: `
      import app from "./src/index.ts";
      import { recoverRoyalMailBookings } from "./src/royalMailRecovery.ts";
      export { LiveHub } from "./src/index.ts";
      export default { ...app, async fetch(request, env, ctx) {
        if (new URL(request.url).hostname === "recovery.fixture") {
          await recoverRoyalMailBookings(env);
          return new Response("done");
        }
        return app.fetch(request, env, ctx);
      } };
    ` },
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:*"], write: false });
  const records = new Map();
  const missingLookupReplies = new Map();
  const requests = [];
  const emails = [];
  const lostReplies = new Set();
  const unlabelled = new Set();
  let interceptCreate;
  let interceptLabel;
  let interceptLookup;
  const worker = new Miniflare({ host: "127.0.0.1", port: 0, telemetry: { enabled: false }, cf: false, workers: [{
    config: {
      name: "wholesale-royal-mail",
      compatibilityDate: "2026-10-01",
      manifest: { modulesRoot: root, mainModule: "index.js", modules: {
        "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
      } },
      assets: { directory: root + "public", runWorkerFirst: true, hasUserWorker: true },
      exports: { LiveHub: { type: "durable-object", storage: "sqlite" } },
      env: {
        ASSETS: { type: "assets" }, DB: { type: "d1", name: "wholesale-royal-mail-db" },
        FILES: { type: "kv", id: "wholesale-royal-mail-files" },
        LIVE: { type: "durable-object", worker: "wholesale-royal-mail", exportName: "LiveHub" },
        SETUP_CODE: binding(setupCode), ADMIN_HOST: binding("admin.staffstrangerscoffee.com"),
        PREVIEW_HOST: binding("strangerscoffee.trade"), LEGACY_PREVIEW_HOST: binding("preview.staffstrangerscoffee.com"),
        COOKIE_DOMAIN: binding("staffstrangerscoffee.com"), RESEND_API_KEY: binding("fixture-email"),
        WHOLESALE_ROYAL_MAIL_CLICK_DROP_KEY: binding("fixture-click-drop"),
        WHOLESALE_ROYAL_MAIL_SERVICE_CODE: binding("TPS48"),
        WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_ID: binding("fixture-tracking-id"),
        WHOLESALE_ROYAL_MAIL_TRACKING_CLIENT_SECRET: binding("fixture-tracking-secret"),
        WHOLESALE_ROYAL_MAIL_TRACKING_TERMS_ACCEPTED: binding("yes"),
      },
    },
    dev: { outboundService: { type: "fetcher", handler: async request => {
      const url = new URL(request.url);
      requests.push({ method: request.method, host: url.host, path: url.pathname });
      if (url.host === "api.resend.com") {
        emails.push(await request.json());
        return RuntimeResponse.json({ id: "email-" + emails.length });
      }
      if (url.host === "api.royalmail.net") {
        const requested = url.searchParams.get("mailPieceId");
        return RuntimeResponse.json({ mailPieces: [{ mailPieceId: requested, status: "200", summary: {
          statusCategory: "IN_TRANSIT", lastEventName: "Accepted at a Post Office",
          lastEventDateTime: "2026-11-26T10:00:00Z",
        } }] });
      }
      assert.equal(url.host, "api.parcel.royalmail.com");
      assert.equal(request.headers.get("authorization"), "Bearer fixture-click-drop");
      if (url.pathname === "/api/v1/services") {
        assert.equal(request.method, "GET");
        assert.deepEqual(Object.fromEntries(url.searchParams), { destinationCountryCode: "GBR", destinationPostcode: "NR2 1DE", packagingFormat: "Parcel", packageWeight: "2140" });
        return RuntimeResponse.json([{ shippingAccountName: "Local fulfilment", services: [{ serviceCode: "TPS48" }] }]);
      }
      if (url.pathname === "/api/v1/carriers") return RuntimeResponse.json([{ shippingAccountName: "Local fulfilment" }]);
      if (request.method === "POST") {
        const { items: [item] } = await request.json();
        assert.equal(item.packages[0].weightInGrams, 2140);
        const reference = item.orderReference;
        const result = { orderIdentifier: 900 + records.size, orderReference: reference, trackingNumber: number };
        if (!unlabelled.has(reference)) {
          result.label = Buffer.from(pdf).toString("base64");
          result.printedOn = "2026-11-26T09:00:00Z";
        }
        await interceptCreate?.(reference, item);
        records.set(reference, result);
        return lostReplies.has(reference) ? new RuntimeResponse("carrier response lost", { status: 502 })
          : RuntimeResponse.json({ createdOrders: [result], successCount: 1, errorsCount: 0 });
      }
      if (url.pathname.endsWith("/label")) {
        await interceptLabel?.();
        return new RuntimeResponse(pdf, { headers: { "content-type": "application/pdf" } });
      }
      const reference = decodeURIComponent(url.pathname.split("/").at(-1)).replaceAll('"', "");
      await interceptLookup?.(reference);
      if (!records.has(reference) && missingLookupReplies.has(reference)) {
        return RuntimeResponse.json(missingLookupReplies.get(reference), { status: 400 });
      }
      return RuntimeResponse.json(records.has(reference) ? [records.get(reference)] : []);
    } } },
  }] });
  t.after(() => worker.dispose());
  let cookie;
  const call = (path, method = "GET", body, origin = host, session = cookie) => worker.dispatchFetch(origin + path, {
    method, headers: { origin, "content-type": "application/json", ...(session ? { cookie: session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setup = await call("/api/auth/setup", "POST", { code: setupCode, name: "Test Admin", username: "ship.admin", password: "Local test password 2026!" });
  assert.equal(setup.status, 200);
  assert.equal((await call(shipPath(orderRef(1)) + "/label")).status, 401);
  const previewLabel = id => call(shipPath(id) + "/label?preview=1");
  assert.equal((await previewLabel(orderRef(1))).status, 401);
  assert.equal((await call(settingsPath)).status, 401);
  cookie = setup.headers.getSetCookie().find(value => /^sfbb_session=[^;]/.test(value)).split(";")[0];
  const db = await worker.getD1Database("DB");
  const order = { preview: false, customerId, status: "Ready", delivery: "Delivery", business, createdAt: Date.now(),
    grams: 2000, packs: 2, pence: 3600, deliveryPence: 744, totalPence: 4344,
    lines: [{ productId: "brazil", title: "Brazil Fazenda", pack: "kilo", grind: "beans", quantity: 2, grams: 1000 }],
    locationSnapshot: { address: "18 Example Lane\nNorwich", postcode: "NR1 5AB" },
  };
  function seed(id, data = {}) {
    return db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES ('order',?,?,1,?)")
      .bind(id, JSON.stringify({ ...order, ...data }), Date.now()).run();
  }
  await db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES ('customer',?,?,1,?)")
    .bind(customerId, JSON.stringify({ business, email: "orders@example.test" }), Date.now()).run();
  const amend = (id, jsonPath, value) => db.prepare("UPDATE wholesale_preview SET data=json_set(data,?,?),version=version+1 WHERE kind='order' AND id=?")
    .bind(jsonPath, value, id).run();
  const read = async id => (await (await call(shipPath(id))).json()).shipment;
  const create = id => call(shipPath(id), "POST", packageDetails);
  const dispatch = (id, ifVersion, trackingUrl = "") => call(orderPath(id), "PATCH", { ifVersion, status: "Dispatched", customerId, trackingUrl });
  const refresh = id => call(shipPath(id) + "/refresh", "POST", {});
  const releaseRefresh = id => db.prepare("UPDATE wholesale_royal_mail_shipments SET refresh_after=0 WHERE order_id=?").bind(id).run();
  const posts = () => requests.filter(row => row.host === "api.parcel.royalmail.com" && row.method === "POST").length;
  const settings = async () => (await call(settingsPath)).json();
  async function setBookings(enabled) {
    const { version } = await settings();
    const response = await call(settingsPath, "PUT", { ifVersion: version, enabled });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, enabled);
  }

  await t.test("only admins can change the default-off booking switch and the API returns no keys", async () => {
    const id = orderRef(8);
    await seed(id);
    assert.deepEqual(await settings(), {
      enabled: false, version: 0, bookingConfigured: true, trackingConfigured: true, serviceCode: "TPS48",
      credentialSetup: { storageReady: false, bookingSource: "worker", trackingSource: "worker", bookingReadable: true,
        trackingReadable: true, serviceRegisterCode: null, shippingAccountName: null },
    });
    const view = await (await call(shipPath(id))).json();
    assert.equal(view.bookingEnabled, false);
    assert.equal(view.bookingConfigured, true);
    assert.equal(view.canCreate, false);
    const paused = await create(id);
    assert.equal(paused.status, 409);
    assert.equal((await paused.json()).code, "royal_mail_booking_paused");
    assert.equal(requests.length, 0);
    assert.equal(await read(id), null);
    const user = { username: "ship.staff", password: "Temporary staff password 2026!" };
    assert.equal((await call("/api/admin/users", "POST", { ...user, name: "Packing staff", role: "staff" })).status, 200);
    const signIn = await call("/api/auth/change", "POST", { ...user, newPassword: "Staff own password 2026!" }, host, "");
    assert.equal(signIn.status, 200);
    const staff = signIn.headers.getSetCookie().find(value => /^sfbb_session=[^;]/.test(value)).split(";")[0];
    assert.equal((await call(settingsPath, "GET", undefined, host, staff)).status, 403);
    assert.equal((await call(settingsPath, "PUT", { ifVersion: 0, enabled: true }, host, staff)).status, 403);
    assert.equal((await call(settingsPath, "PUT", { ifVersion: 0, enabled: "true" })).status, 400);
    await setBookings(true);
    assert.equal((await call(settingsPath, "PUT", { ifVersion: 0, enabled: false })).status, 409);
    assert.equal((await settings()).enabled, true);
    assert.equal((await (await call(shipPath(id))).json()).canCreate, true);
  });

  await t.test("pausing during preflight prevents the carrier POST even if bookings are turned on again", async () => {
    for (const reenable of [false, true]) {
      const id = orderRef(reenable ? 10 : 9);
      await seed(id);
      const before = posts();
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      interceptLookup = async () => { enter(); await held; };
      const attempt = create(id);
      try {
        const early = await Promise.race([entered.then(() => null), attempt]);
        if (early) assert.fail(await early.text());
        await setBookings(false);
        if (reenable) await setBookings(true);
      } finally {
        release();
        interceptLookup = undefined;
      }
      const result = await attempt;
      assert.equal(result.status, 409);
      assert.equal((await result.json()).code, reenable ? "royal_mail_booking_policy_changed" : "royal_mail_booking_paused");
      assert.equal(posts(), before);
      assert.equal((await read(id)).state, "failed");
      assert.equal((await read(id)).requestedAt, null);
      if (!reenable) {
        assert.equal((await dispatch(id, 1, "https://courier.example/123")).status, 200);
        await setBookings(true);
      }
    }
  });

  await t.test("retrying a blocked lookup purchases one label across concurrent requests, reprints and handover", async () => {
    const id = orderRef(1);
    await seed(id, { locationSnapshot: { address: "16 Example Lane\nNorwich", postcode: "NR1 5AB" } });
    assert.equal((await call(shipPath(id), "GET", undefined, "https://preview.staffstrangerscoffee.com")).status, 404);
    missingLookupReplies.set(id, [{ message: "Shipping account not found" }]);
    const blocked = await create(id);
    assert.equal(blocked.status, 200);
    const stopped = (await blocked.json()).shipment;
    assert.equal(stopped.state, "failed");
    assert.equal(stopped.requestedAt, null);
    assert.equal(stopped.referenceLookupFailure, "before_postage");
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET requested_at=NULL WHERE order_id=?").bind(id).run();
    assert.equal((await read(id)).referenceLookupFailure, "unconfirmed");
    assert.equal(posts(), 0, "an ambiguous lookup never purchases postage");
    missingLookupReplies.set(id, [{ code: "OrderNotFound", message: "Order not found", orderReference: id }]);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    interceptCreate = async () => { enter(); await held; };
    const first = create(id);
    try {
      const early = await Promise.race([entered.then(() => null), first]);
      if (early) assert.fail(await early.text());
      assert.equal((await create(id)).status, 202);
      const disputed = await dispatch(id, 1);
      assert.equal(disputed.status, 409);
      assert.equal((await disputed.json()).code, "royal_mail_handover_review");
      assert.equal(posts(), 1);
      assert.equal(await db.prepare("SELECT 1 FROM wholesale_email_outbox WHERE order_id=?").bind(id).first(), null);
      await setBookings(false);
    } finally {
      release();
      interceptCreate = undefined;
    }
    assert.equal((await first).status, 201);
    const booked = await read(id);
    assert.equal(booked.state, "labelled");
    assert.equal(booked.trackingNumber, number);
    assert.ok(booked.requestedAt > 0);
    const history = await (await call(settingsPath + "/labels?search=" + id)).json();
    assert.equal(history.labels[0].serviceCode, "TPS48");
    assert.equal(history.labels[0].createdAt, booked.requestedAt);
    const beforePreview = requests.length;
    assert.equal((await call(shipPath(id) + "/label?preview=invalid")).status, 400);
    assert.equal((await call(shipPath(id) + "/label?preview=1&preview=0")).status, 400);
    assert.equal(requests.length, beforePreview);
    const preview = await previewLabel(id);
    assert.equal(preview.status, 200);
    assert.equal(await preview.text(), pdf);
    assert.equal(preview.headers.get("content-disposition"), `inline; filename="Royal-Mail-${id}.pdf"`);
    assert.equal(preview.headers.get("content-type"), "application/pdf");
    assert.equal(preview.headers.get("cache-control"), "no-store");
    assert.equal((await read(id)).labelDownloadedAt, null, "a preview must not unlock handover");
    assert.ok(requests.slice(beforePreview).every(request => request.method === "GET"));
    const download = await call(shipPath(id) + "/label");
    assert.equal(download.headers.get("content-disposition"), `attachment; filename="Royal-Mail-${id}.pdf"`);
    assert.equal(await download.text(), pdf);
    const firstDownload = (await read(id)).labelDownloadedAt;
    assert.ok(firstDownload > 0);
    const before = requests.length;
    const replies = await Promise.all(Array.from({ length: 5 }, () => refresh(id)));
    assert.ok(replies.every(response => response.status === 200));
    assert.equal(requests.length - before, 2, "one exact booking check and one tracking scan despite simultaneous refreshes");
    const scan = await read(id);
    assert.equal(scan.carrierStatus, "Accepted at a Post Office");
    assert.ok(scan.checkedAt > 0);
    await amend(id, "$.note", "Packing checked");
    assert.equal((await read(id)).orderChanged, false);
    const sent = await dispatch(id, 2);
    const body = await sent.json();
    assert.equal(sent.status, 200, JSON.stringify(body));
    assert.equal(body.order.trackingUrl, booked.trackingUrl);
    assert.equal((await dispatch(id, 2)).status, 409);
    const events = await db.prepare("SELECT payload FROM wholesale_email_outbox WHERE order_id=?").bind(id).all();
    assert.equal(events.results.length, 1);
    const email = JSON.parse(events.results[0].payload);
    assert.equal(email.to.email, "orders@example.test");
    assert.ok(email.mail.text.includes(booked.trackingUrl));
    assert.match(email.mail.text, /18 Example Lane, Norwich, NR1 5AB/);
    assert.doesNotMatch(email.mail.text, /16 Example Lane/);
    assert.equal(await (await previewLabel(id)).text(), pdf, "an unchanged dispatched order keeps its original label");
    assert.equal((await read(id)).labelDownloadedAt, firstDownload);
    assert.equal((await call(shipPath(id) + "/label")).status, 200);
    assert.equal((await settings()).enabled, false, "old labels, scans and dispatch work while paused");
    await setBookings(true);
  });

  await t.test("Parcelforce references stay pinned through verification, PDF, handover and customer email", async () => {
    const id = orderRef(99), parcel = "PF123456789";
    const expectedLink = "https://www.royalmail.com/track-your-item#/tracking-results/" + parcel;
    await seed(id);
    assert.equal((await create(id)).status, 201);
    records.set(id, { ...records.get(id), trackingNumber: parcel, printedOn: "2026-11-26T09:00:00Z" });
    await refresh(id);
    assert.equal((await read(id)).reviewRequired, true);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal((await call(shipPath(id) + "/verify", "POST", { ifVersion: 1, trackingNumber: parcel, confirmed: true })).status, 200);
    await releaseRefresh(id);
    const start = requests.length;
    assert.equal((await refresh(id)).status, 200);
    assert.equal(requests.length, start + 1, "exact Click & Drop lookup only");
    assert.equal((await read(id)).trackingUrl, expectedLink);
    assert.equal((await call(shipPath(id) + "/label")).status, 200);
    const matched = records.get(id);
    records.set(id, { ...matched, trackingNumber: null });
    await releaseRefresh(id);
    await refresh(id);
    assert.equal((await read(id)).reviewRequired, true, "temporarily missing carrier reference must not release the pinned label");
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    records.set(id, matched);
    assert.equal((await call(shipPath(id) + "/verify", "POST", { ifVersion: 1, trackingNumber: parcel, confirmed: true })).status, 200);
    assert.equal((await dispatch(id, 1, "https://www.parcelforce.com/track-trace?trackNumber=wrong")).status, 409);
    assert.equal((await dispatch(id, 1, "https://www.parcelforce.com/track-trace?trackNumber=" + parcel + "&next=https://example.test")).status, 409);
    const result = await dispatch(id, 1, "http://www.parcelforce.com/portal/pw/track?trackNumber=" + parcel);
    assert.equal((await result.json()).order.trackingUrl, expectedLink);
    const email = await db.prepare("SELECT payload FROM wholesale_email_outbox WHERE order_id=?").bind(id).first();
    assert.ok(JSON.parse(email.payload).mail.text.includes(expectedLink));
  });

  await t.test("carrier conflicts require exact verification and cannot send stale tracking", async () => {
    const id = orderRef(2);
    await seed(id);
    assert.equal((await create(id)).status, 201);
    assert.equal((await call(shipPath(id) + "/label")).status, 200);
    const released = () => db.prepare("SELECT label_downloaded_at AS at FROM wholesale_royal_mail_shipments WHERE order_id=?").bind(id).first("at");
    assert.ok(await released());
    const original = records.get(id);
    const booked = await read(id);
    records.set(id, { ...original, orderIdentifier: original.orderIdentifier + 40 });
    await refresh(id);
    assert.equal((await read(id)).orderId, original.orderIdentifier);
    assert.equal((await read(id)).reviewRequired, true);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal((await dispatch(id, 1, booked.trackingUrl)).status, 409);
    const verify = trackingNumber => call(shipPath(id) + "/verify", "POST", { ifVersion: 1, trackingNumber, confirmed: true });
    assert.equal((await verify(number)).status, 409);
    records.set(id, { ...original, trackingNumber: replacement });
    await releaseRefresh(id);
    await refresh(id);
    assert.equal((await read(id)).trackingNumber, number, "the original number stays pinned");
    assert.equal((await verify(number)).status, 409);
    assert.equal((await verify(replacement)).status, 200);
    assert.equal(await released(), null, "a replacement tracking number requires the replacement label to be downloaded");
    assert.equal((await read(id)).reviewRequired, false);
    assert.equal((await read(id)).trackingNumber, replacement);
    assert.equal((await dispatch(id, 1, booked.trackingUrl)).status, 409);
    records.delete(id);
    await releaseRefresh(id);
    await refresh(id);
    assert.equal((await read(id)).reviewRequired, true, "missing carrier record pauses label and tracking");
    const override = "https://other-courier.example/track/123";
    const other = await dispatch(id, 1, override);
    assert.equal(other.status, 200);
    assert.equal((await other.json()).order.trackingUrl, override);
  });

  await t.test("amendment, cancellation during download and labelled-state guards", async () => {
    const id = orderRef(3);
    await seed(id);
    assert.equal((await create(id)).status, 201);
    interceptLabel = () => db.prepare("UPDATE wholesale_royal_mail_shipments SET review_required=1 WHERE order_id=?").bind(id).run();
    try { assert.equal((await previewLabel(id)).status, 409, "a review raised during fetch blocks the private preview bytes"); }
    finally { interceptLabel = undefined; }
    assert.equal((await read(id)).labelDownloadedAt, null);
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET review_required=0 WHERE order_id=?").bind(id).run();
    interceptLabel = () => amend(id, "$.status", "Cancelled");
    try { assert.equal((await call(shipPath(id) + "/label")).status, 409); }
    finally { interceptLabel = undefined; }
    await amend(id, "$.status", "Ready");
    await amend(id, "$.lines[0].grind", "filter");
    assert.equal((await read(id)).orderChanged, true);
    assert.equal((await previewLabel(id)).status, 409);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal((await dispatch(id, 4)).status, 409);
    const unfinished = orderRef(4);
    await seed(unfinished);
    unlabelled.add(unfinished);
    assert.equal((await create(unfinished)).status, 201);
    assert.equal((await read(unfinished)).state, "created");
    const before = requests.length;
    assert.equal((await previewLabel(unfinished)).status, 409);
    assert.equal((await call(shipPath(unfinished) + "/label")).status, 409);
    assert.equal(requests.length, before, "a staff label download cannot generate unconfirmed postage");
  });

  await t.test("lost replies reconcile without a second create and pre-send reservations can recover", async () => {
    const id = orderRef(5);
    await seed(id);
    lostReplies.add(id);
    const before = posts();
    assert.equal((await create(id)).status, 202);
    assert.equal((await read(id)).state, "review");
    assert.equal((await create(id)).status, 202);
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await read(id)).state, "labelled");
    assert.equal(posts() - before, 1);
    const unstarted = orderRef(6);
    await seed(unstarted);
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at,requested_at) VALUES (?,'booking','interrupted',1,2140,0,0)`)
      .bind(unstarted).run();
    assert.equal((await refresh(unstarted)).status, 200);
    assert.equal((await read(unstarted)).state, "failed");
    assert.equal((await create(unstarted)).status, 201);
  });

  await t.test("recovery bounds lookups, escalates missing bookings and accepts late carrier evidence", async () => {
    const id = orderRef(81);
    await seed(id);
    lostReplies.add(id);
    const before = posts();
    assert.equal((await create(id)).status, 202);
    const carrier = records.get(id);
    records.delete(id); // Click & Drop accepted the POST but its lookup has not indexed the reference yet.
    missingLookupReplies.set(id, [{ code: "OrderNotFound", message: "Order not found", orderReference: id }]);
    const recover = async () => {
      const response = await worker.dispatchFetch("https://recovery.fixture/run");
      assert.equal(response.status, 200);
      await response.text();
    };
    const expire = () => db.prepare("UPDATE wholesale_royal_mail_shipments SET recovery_due_at=1,refresh_after=0 WHERE order_id=?").bind(id).run();
    const lookups = () => requests.filter(req => req.method === "GET" && decodeURIComponent(req.path).endsWith('"' + id + '"')).length;
    await setBookings(false);
    await recover();
    assert.equal((await read(id)).recovery.attempts, 0, "a new booking has a grace period");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expire();
      const prior = lookups();
      await Promise.all([recover(), recover()]);
      assert.equal(lookups() - prior, 1, "concurrent recovery runs use one lookup");
      const { recovery } = await read(id);
      assert.equal(recovery.attempts, attempt);
      assert.equal(recovery.status, attempt === 4 ? "needs_admin" : "checking");
      assert.ok(recovery.lastCheckedAt);
      if (attempt < 4) assert.ok(recovery.nextCheckAt > Date.now());
      else assert.equal(recovery.nextCheckAt, null);
      await recover();
      assert.equal(lookups() - prior, 1, "no lookup while waiting or escalated");
      assert.equal((await create(id)).status, 202, "retrying the booking cannot purchase again");
    }
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET refresh_after=0 WHERE order_id=?").bind(id).run();
    records.set(id, carrier);
    assert.equal((await refresh(id)).status, 200);
    const recovered = await read(id);
    assert.equal(recovered.state, "labelled");
    assert.equal(recovered.recovery, null);
    assert.equal(recovered.reviewRequired, false);
    assert.equal(await (await call(shipPath(id) + "/label")).text(), pdf);
    assert.equal(posts() - before, 1, "there was only the original purchase");
    const { results: events } = await db.prepare("SELECT text FROM audit_log WHERE kind='wholesale_royal_mail' AND text LIKE ? ORDER BY at").bind("%" + id + "%").all();
    assert.deepEqual(events.map(event => event.text), [
      `Royal Mail booking for ${id} needs Admin review in Click & Drop.`, `Royal Mail booking recovered for ${id}.`,
    ]);
    await setBookings(true);
  });

  await t.test("old uncertain requests remain blocked and recovered unpinned labels require verification", async () => {
    const id = orderRef(82);
    await seed(id);
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at) VALUES (?,'review','legacy',1,2140,0)`).bind(id).run();
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await read(id)).state, "review", "a missing legacy marker is not proof that a request was never sent");
    const before = posts();
    assert.equal((await create(id)).status, 202);
    records.set(id, { orderIdentifier: 1782, orderReference: id, trackingNumber: number, printedOn: "2026-11-26T09:00:00Z" });
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET refresh_after=0 WHERE order_id=?").bind(id).run();
    await refresh(id);
    assert.equal((await read(id)).reviewRequired, true);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal(posts(), before);
  });

  await t.test("an expired last lease escalates without another lookup, and an outbound marker fences a stale result", async () => {
    const last = orderRef(83), racing = orderRef(84);
    await seed(last);
    await seed(racing);
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at,requested_at,recovery_attempts,recovery_due_at)
      VALUES (?,'review','interrupted-check',1,2140,0,1,4,1)`).bind(last).run();
    const before = requests.length;
    await (await worker.dispatchFetch("https://recovery.fixture/run")).text();
    assert.equal((await read(last)).recovery.status, "needs_admin");
    assert.equal(requests.length, before, "an interrupted last check cannot cause an extra carrier request");
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at,requested_at)
      VALUES (?,'booking','race',1,2140,0,0)`).bind(racing).run();
    interceptLookup = async reference => {
      if (reference === racing) await db.prepare("UPDATE wholesale_royal_mail_shipments SET requested_at=? WHERE order_id=?")
        .bind(Date.now(), racing).run();
    };
    try { assert.equal((await refresh(racing)).status, 200); }
    finally { interceptLookup = undefined; }
    assert.equal((await read(racing)).state, "booking", "a lookup that began before transmission cannot release this reservation");
    assert.equal((await create(racing)).status, 202);
  });

  await t.test("an existing Click & Drop label cannot use an unsubmitted recipient draft", async () => {
    const id = orderRef(7);
    await seed(id, { locationSnapshot: { address: "16 Example Lane, Norwich", postcode: "NR1 5AB" } });
    records.set(id, { orderIdentifier: 1907, orderReference: id, trackingNumber: number, printedOn: "2026-11-26T09:00:00Z" });
    const before = posts();
    assert.equal((await create(id)).status, 201);
    const shipment = await read(id);
    assert.equal(shipment.reviewRequired, true);
    assert.equal(shipment.requestedAt, null);
    assert.equal(posts(), before);
    const [adopted] = (await (await call(settingsPath + "/labels?search=" + id)).json()).labels;
    assert.equal(adopted.serviceCode, null, "An adopted booking cannot infer the active service code");
    assert.equal(adopted.dateSource, "order");
    const verify = await call(shipPath(id) + "/verify", "POST", { ifVersion: 1, trackingNumber: number, confirmed: true });
    assert.equal(verify.status, 200);
    assert.equal((await dispatch(id, 1)).status, 200);
    const event = await db.prepare("SELECT payload FROM wholesale_email_outbox WHERE order_id=?").bind(id).first();
    const email = JSON.parse(event.payload);
    assert.match(email.mail.text, /16 Example Lane, Norwich, NR1 5AB/);
    assert.doesNotMatch(email.mail.text, /18 Example Lane/);
  });

  await t.test("admin parcel corrections and selectively saved future locations have separate lifetimes", async () => {
    const id = orderRef(92), locationId = "ca350624-18ec-4a05-a57d-84da862782d0";
    const address = "10 Dove Street, Norwich, Norfolk";
    const location = { id: locationId, name: "Roastery", contact: "Original Contact", address, postcode: "NR2 1DE", phone: "01603 000000", deliveryNotes: "Side door" };
    const customer = crypto.randomUUID(), snapshot = { ...location, contact: null };
    await db.prepare("INSERT INTO wholesale_preview(kind,id,data,version,updated_at) VALUES ('customer',?,?,1,?)")
      .bind(customer, JSON.stringify({ business, address: "Old primary", email: "receipts@example.test", locations: [location] }), Date.now()).run();
    await seed(id, { customerId: customer, locationId, locationSnapshot: snapshot, customerSnapshot: { email: "original-order@example.test" } });
    const path = shipPath(id), locationPath = path + "/location";
    const reviewed = await (await call(path)).json();
    const original = reviewed.recipient;
    const serviceCheck = path + "/service-check";
    const parcel = { ifVersion: reviewed.orderVersion, bookingVersion: reviewed.bookingVersion, postcode: "nr21de", weightGrams: 2140 };
    const beforeCheck = requests.length;
    assert.equal((await call(serviceCheck)).status, 405);
    assert.equal((await call(serviceCheck, "POST", { ...parcel, bookingVersion: parcel.bookingVersion + 1 })).status, 409);
    assert.equal((await call(serviceCheck, "POST", { ...parcel, ifVersion: 0 })).status, 409);
    assert.equal((await call(serviceCheck, "POST", { ...parcel, weightGrams: 30001 })).status, 400);
    assert.equal((await call(serviceCheck, "POST", { ...parcel, postcode: "BT1 1AA" })).status, 400);
    assert.equal(requests.length, beforeCheck, "invalid parcel checks never reach Royal Mail");
    const checked = await call(serviceCheck, "POST", parcel);
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).available, true);
    assert.deepEqual(requests.slice(beforeCheck).map(({ method, path }) => [method, path]), [["GET", "/api/v1/services"], ["GET", "/api/v1/carriers"]]);
    assert.equal(await read(id), null, "checking service cannot reserve a booking");
    assert.deepEqual(original, { name: business, line1: "10 Dove Street", line2: "", city: "Norwich", county: "Norfolk", postcode: "NR2 1DE" });
    const corrected = { ...original, line1: "12 Dove Street", name: "Parcel recipient", county: "Norfolk", postcode: "nr21de" };
    const pinned = { ...packageDetails, recipient: corrected, bookingService: reviewed.bookingService, bookingVersion: reviewed.bookingVersion };
    await setBookings(false);
    await setBookings(true);
    assert.equal((await (await call(path, "POST", pinned)).json()).code, "royal_mail_booking_policy_changed");
    assert.equal(await read(id), null);
    const latestPolicy = await (await call(path)).json();
    let carrierRecipient;
    interceptCreate = (reference, item) => { if (reference === id) carrierRecipient = item.recipient; };
    try {
      assert.equal((await call(path, "POST", { ...pinned, bookingVersion: latestPolicy.bookingVersion })).status, 201);
    } finally { interceptCreate = undefined; }
    const carrierAddress = carrierRecipient.address;
    assert.deepEqual([carrierAddress.addressLine1, carrierAddress.city, carrierAddress.county, carrierAddress.postcode],
      ["12 Dove Street", "Norwich", "Norfolk", "NR2 1DE"]);
    assert.equal(carrierRecipient.emailAddress, "original-order@example.test");
    assert.equal(carrierRecipient.phoneNumber, undefined);
    assert.deepEqual((await read(id)).destination, { address: "12 Dove Street, Norwich, Norfolk", postcode: "NR2 1DE" });
    const before = await (await call(locationPath)).json();
    assert.equal(before.address, address, "booking does not change the address book");
    const request = { customerId: customer, locationId, orderVersion: 1, ifVersion: before.version, recipient: corrected };
    assert.equal((await call(locationPath, "PUT", { ...request, locationId: "primary" })).status, 409);
    const result = await call(locationPath, "PUT", request);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).address, "12 Dove Street\nNorwich\nNorfolk");
    assert.equal((await call(locationPath, "PUT", { ...request, recipient: original })).status, 409);
    const stored = JSON.parse((await db.prepare("SELECT data FROM wholesale_preview WHERE kind='customer' AND id=?").bind(customer).first()).data);
    const addressBook = stored.locations.find(item => item.id === locationId);
    assert.equal(addressBook.contact, location.contact);
    assert.equal(addressBook.phone, location.phone);
    assert.equal(addressBook.deliveryNotes, location.deliveryNotes);
    assert.equal(stored.address, "Old primary");
    assert.deepEqual((await (await call(path)).json()).recipient, original, "existing order keeps its snapshot");
    assert.equal((await (await call(locationPath)).json()).postcode, "NR2 1DE");
  });

  await t.test("authorised staff use the saved destination and service, with payment and access checked before purchase", async () => {
    const staffPath = id => "/api/staff-orders/orders/" + id + "/shipping";
    const userResponse = await call("/api/admin/users", "POST", { name: "Staff Label Tester", username: "packing.staff",
      role: "staff", password: "Temporary Packing Password!" });
    const userResult = await userResponse.json();
    assert.equal(userResponse.status, 200, JSON.stringify(userResult));
    const { user } = userResult;
    const signedIn = await call("/api/auth/change", "POST", { username: "packing.staff", password: "Temporary Packing Password!",
      newPassword: "Staff Packing Password!" }, diary, null);
    assert.equal(signedIn.status, 200);
    const staffCookie = signedIn.headers.getSetCookie().find(value => /^sfbb_session=[^;]/.test(value)).split(";")[0];
    const staff = (id, method = "GET", body, suffix = "") => call(staffPath(id) + suffix, method, body, diary, staffCookie);
    const access = "/api/admin/users/" + user.id + "/orders-access";
    const grant = (enabled, ifVersion) => call(access, "PUT", { enabled, ifVersion });
    const billed = orderRef(41), racing = orderRef(42), paid = orderRef(43), collection = orderRef(44), incomplete = orderRef(45);
    const thirdParty = orderRef(46), wrongPostcode = orderRef(47);
    const net30 = { paymentTerms: { id: "net-30" } };
    const accountStatus = status => db.prepare("UPDATE wholesale_preview SET data=json_set(data,'$.status',?) WHERE kind='customer' AND id=?")
      .bind(status, customerId).run();
    await accountStatus("Active");
    await seed(billed, { paymentTerms: { id: "before-dispatch" } });
    await seed(racing, net30);
    await seed(paid, { ...net30, customerSnapshot: { email: "delivery@example.test", phone: "01603 000099" },
      locationSnapshot: { contact: "Shipping contact", phone: "01603 000011", address: "18 Example Lane, Unit 2\nNorwich, Norfolk NR1 5AB\nUnited Kingdom", postcode: "NR1 5AB" } });
    await seed(collection, { ...net30, delivery: "Roastery collection" });
    await seed(incomplete, { ...net30, locationSnapshot: { address: "18 Example Lane, Norfolk", postcode: "NR1 5AB" } });
    await seed(thirdParty, net30);
    await seed(wrongPostcode, { ...net30, locationSnapshot: { address: "18 Example Lane, Norwich\nNR1 6AB", postcode: "NR1 5AB" } });
    assert.equal((await staff(paid)).status, 403);
    assert.equal((await staff(paid, "GET", undefined, "/label")).status, 403);
    assert.equal((await grant(true, 0)).status, 200);
    assert.equal((await staff(paid, "GET", undefined, "/label?preview=1")).status, 403);
    assert.equal((await call(shipPath(paid) + "/label?preview=1", "GET", undefined, host, staffCookie)).status, 403);
    assert.equal((await call(staffPath(paid))).status, 404);
    assert.equal((await call(shipPath(paid), "POST", packageDetails, host, staffCookie)).status, 403);
    assert.equal((await call(settingsPath, "GET", undefined, host, staffCookie)).status, 403);
    assert.equal((await staff(collection)).status, 404);
    const ready = await (await staff(paid)).json();
    const payload = { ifVersion: ready.orderVersion, bookingVersion: ready.bookingVersion, bookingService: ready.bookingService, weightGrams: 2140 };
    assert.equal(ready.canCreate, true);
    assert.deepEqual(ready.eligibility, { eligible: true });
    assert.equal(ready.bookingService, "TPS48");
    assert.deepEqual((await (await call(shipPath(paid))).json()).recipient, ready.recipient);
    assert.equal((await staff(paid, "GET", undefined, "/location")).status, 403);
    assert.equal((await staff(paid, "PUT", {}, "/location")).status, 403);
    assert.equal((await staff(paid, "POST", {}, "/service-check")).status, 403);
    const ambiguous = await (await call(shipPath(incomplete))).json();
    assert.equal(ambiguous.recipient, null);
    assert.deepEqual(ambiguous.recipientDraft, { name: business, line1: "18 Example Lane", line2: "", city: "", county: "Norfolk", postcode: "NR1 5AB" });
    assert.equal((await (await staff(incomplete)).json()).recipientDraft, undefined);
    assert.deepEqual(ready.recipient, { name: "Shipping contact", line1: "18 Example Lane", line2: "Unit 2", city: "Norwich", postcode: "NR1 5AB", county: "Norfolk" });
    assert.doesNotMatch(JSON.stringify(ready), /fixture-click-drop|fixture-tracking|grossPence|shippingAccountName/);
    const initialRequests = requests.length;
    assert.equal((await staff(paid, "POST", {}, "/verify")).status, 403);
    assert.equal((await staff(paid, "POST", { ...payload, recipient: { postcode: "W1 1AA" } })).status, 400);
    assert.equal((await staff(paid, "POST", { ...payload, serviceCode: "OTHER" })).status, 400);
    assert.equal((await staff(paid, "POST", { ...payload, bookingService: "OTHER" })).status, 409);
    assert.equal((await staff(paid, "POST", { ...payload, bookingVersion: payload.bookingVersion - 1 })).status, 409);
    assert.equal((await staff(paid, "POST", { ...payload, weightGrams: 1999 })).status, 400);
    assert.equal((await (await staff(incomplete, "POST", payload)).json()).code, "royal_mail_address_review");
    assert.equal((await (await staff(wrongPostcode, "POST", payload)).json()).code, "royal_mail_address_review");
    const payment = await staff(billed, "POST", payload);
    assert.equal(payment.status, 409);
    assert.equal((await payment.json()).code, "royal_mail_payment_required");
    await db.prepare(`INSERT INTO wholesale_invoices
      (seq,invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by,paid)
      VALUES (6501,'PRIVATE-6501',?,?,'staff-label-due',?,1,'Private',0)`)
      .bind(billed, customerId, JSON.stringify({ dueDate: "2020-01-01", totals: { grossPence: 1234 } })).run();
    const overdue = await (await staff(paid)).json();
    assert.equal(overdue.canCreate, false);
    assert.equal(overdue.eligibility.code, "royal_mail_account_overdue");
    assert.doesNotMatch(JSON.stringify(overdue), /PRIVATE-6501|1234/);
    assert.equal((await (await staff(paid, "POST", payload)).json()).code, "royal_mail_account_overdue");
    assert.equal(requests.length, initialRequests, "refused operations make no carrier requests");
    await db.prepare("UPDATE wholesale_invoices SET paid=1 WHERE seq=6501").run();
    assert.equal((await (await staff(billed)).json()).canCreate, true);

    interceptLookup = async reference => { if (reference === racing) await accountStatus("On hold"); };
    const beforePosts = posts();
    try {
      const held = await staff(racing, "POST", payload);
      assert.equal(held.status, 409);
      assert.equal((await held.json()).code, "royal_mail_account_on_hold");
    } finally {
      interceptLookup = undefined;
      await accountStatus("Active");
    }
    assert.equal(posts(), beforePosts, "account hold during carrier lookup prevents the purchase");
    assert.equal((await read(racing)).state, "failed");

    let sent;
    interceptCreate = (reference, item) => { if (reference === paid) sent = item; };
    try {
      assert.equal((await staff(paid, "POST", payload)).status, 201);
    } finally {
      interceptCreate = undefined;
    }
    assert.equal(sent.postageDetails.serviceCode, "TPS48");
    assert.equal(sent.label.includeLabelInResponse, true);
    assert.equal(sent.recipient.emailAddress, "delivery@example.test");
    assert.equal(sent.recipient.phoneNumber, undefined);
    assert.equal(sent.recipient.address.fullName, "Shipping contact");
    assert.equal(sent.recipient.address.addressLine1, "18 Example Lane");
    assert.equal(sent.recipient.address.city, "Norwich");
    assert.equal(sent.recipient.address.county, "Norfolk");
    assert.equal(sent.recipient.address.postcode, "NR1 5AB");
    assert.equal((await staff(paid, "POST", payload)).status, 200);
    const label = await staff(paid, "GET", undefined, "/label");
    assert.equal(label.status, 200);
    assert.equal(label.headers.get("cache-control"), "no-store");
    assert.equal(await label.text(), pdf);
    assert.equal(posts(), beforePosts + 1, "repeat booking and label download do not buy again");
    await accountStatus("On hold");
    const heldShipment = await (await staff(paid)).json();
    assert.equal(heldShipment.canDownloadLabel, false);
    assert.equal(heldShipment.shipment.trackingNumber, null);
    assert.equal(heldShipment.shipment.trackingUrl, null);
    assert.equal((await staff(paid, "GET", undefined, "/label")).status, 409);
    const handover = (id, trackingUrl = "") => call("/api/staff-orders/orders/" + id, "PATCH",
      { ifVersion: 1, status: "Dispatched", trackingUrl }, diary, staffCookie);
    assert.equal((await (await handover(paid)).json()).code, "royal_mail_account_on_hold");
    assert.equal((await (await handover(thirdParty, "https://www.royalmail.com/track-your-item#/tracking-results/" + number)).json()).code,
      "royal_mail_account_on_hold");
    assert.equal((await (await handover(thirdParty, "https://tracking.royalmail.net./" + number)).json()).code, "royal_mail_account_on_hold");
    assert.equal((await (await handover(thirdParty, "https://www.parcelforce.com/track-trace?trackNumber=123456789")).json()).code, "royal_mail_account_on_hold");
    assert.equal(await db.prepare("SELECT state FROM wholesale_email_outbox WHERE order_id=?").bind(paid).first(), null);
    assert.equal((await handover(thirdParty, "https://example.test/other-courier")).status, 200);
    await accountStatus("Active");
    assert.equal((await handover(paid)).status, 200);
    await accountStatus("On hold");
    assert.equal((await staff(paid, "GET", undefined, "/label")).status, 409);
    assert.equal((await call(shipPath(paid) + "/label")).status, 200);
    await accountStatus("Active");
    interceptLabel = async () => { assert.equal((await grant(false, 1)).status, 200); };
    try {
      const revoked = await staff(paid, "GET", undefined, "/label");
      assert.equal(revoked.status, 403);
      assert.equal((await revoked.json()).code, "permission_denied");
    } finally {
      interceptLabel = undefined;
    }
  });
});
