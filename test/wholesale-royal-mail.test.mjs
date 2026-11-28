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
  const listedOnly = new Map();
  let nextProviderId = 900;
  const missingLookupReplies = new Map();
  const requests = [];
  const emails = [];
  const lostReplies = new Set();
  const unlabelled = new Set();
  const labelErrors = new Map();
  let interceptNumeric;
  let interceptCreate;
  let interceptLabel;
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
        const reference = item.orderReference;
        const box = /-B(\d+)$/.exec(reference);
        if (!box) assert.equal(item.packages[0].weightInGrams, 2140);
        const result = { orderIdentifier: nextProviderId++, orderReference: reference, trackingNumber: box ? "AB" + box[1].padStart(9,"0") + "GB" : number };
        if (!unlabelled.has(reference)) {
          result.label = Buffer.from(pdf).toString("base64");
          result.printedOn = "2026-11-26T09:00:00Z";
        }
        if (labelErrors.has(reference)) result.labelErrors = labelErrors.get(reference);
        const intercepted = await interceptCreate?.(reference, item);
        if (intercepted instanceof RuntimeResponse) return intercepted;
        records.set(reference, result);
        return lostReplies.has(reference) ? new RuntimeResponse("carrier response lost", { status: 502 })
          : RuntimeResponse.json({ createdOrders: [result], successCount: 1, errorsCount: 0 });
      }
      if (url.pathname === "/api/v1/orders" && request.method === "GET") {
        const start = Date.parse(url.searchParams.get("startDateTime") ?? "");
        const end = Date.parse(url.searchParams.get("endDateTime") ?? "");
        const orders = [...listedOnly.values()].filter(row => Date.parse(row.createdOn) >= start && Date.parse(row.createdOn) <= end);
        return RuntimeResponse.json({ orders });
      }
      if (url.pathname.endsWith("/label")) {
        await interceptLabel?.();
        return new RuntimeResponse(pdf, { headers: { "content-type": "application/pdf" } });
      }
      const selector = decodeURIComponent(url.pathname.split("/").at(-1));
      if (/^\d+$/.test(selector)) {
        await interceptNumeric?.(selector);
        const pinned = [...records.values(), ...listedOnly.values()].find(row => row.orderIdentifier === Number(selector));
        return RuntimeResponse.json(pinned ? [pinned] : []);
      }
      const reference = selector.replaceAll('"', "");
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
  const historicalFailure = (id, marker = null) => db.prepare(`INSERT INTO wholesale_royal_mail_shipments
    (order_id,state,operation,order_version,weight_grams,updated_at,requested_at,booking_connection,problem)
    VALUES (?,'failed','old-operation',1,2140,1,?,'previous-connection','Royal Mail rejected the order-reference lookup. Check the reference in Click & Drop.')`)
    .bind(id, marker).run();
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

  await t.test("an earlier parcel review cannot purchase after pausing and re-enabling bookings", async () => {
    const id = orderRef(9);
    await seed(id);
    const review = await (await call(shipPath(id))).json();
    await setBookings(false);
    await setBookings(true);
    const before = requests.length;
    const stale = await call(shipPath(id), "POST", { ...packageDetails,
      bookingVersion: review.bookingVersion, bookingService: review.bookingService });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "royal_mail_booking_policy_changed");
    assert.equal(requests.length, before);
  });

  await t.test("a recorded pre-postage reference failure can purchase once across concurrent requests, reprints and handover", async () => {
    const id = orderRef(1);
    await seed(id, { locationSnapshot: { address: "16 Example Lane\nNorwich", postcode: "NR1 5AB" } });
    assert.equal((await call(shipPath(id), "GET", undefined, "https://preview.staffstrangerscoffee.com")).status, 404);
    await historicalFailure(id, 0);
    const beforeBooking = requests.length;
    const diagnostic = await call(shipPath(id) + "/reference-check", "POST", {
      ifVersion: 1, bookingVersion: (await settings()).version,
    });
    assert.equal((await diagnostic.json()).outcome, "not_sent");
    assert.equal(requests.length, beforeBooking);
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
      assert.deepEqual(requests.slice(beforeBooking).map(r => [r.method, r.path]), [["POST", "/api/v1/orders"]]);
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
    const beforeDownload = requests.length;
    const download = await call(shipPath(id) + "/label");
    assert.equal(download.headers.get("content-disposition"), `attachment; filename="Royal-Mail-${id}.pdf"`);
    assert.equal(await download.text(), pdf);
    const firstDownload = (await read(id)).labelDownloadedAt;
    assert.ok(firstDownload > 0);
    assert.deepEqual(requests.slice(beforeDownload).map(row => row.path), [
      "/api/v1/orders/" + booked.orderId, "/api/v1/orders/" + booked.orderId + "/label",
    ]);
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

  await t.test("an archived test stays in order history and a subsequent carrier match becomes visible", async () => {
    const id = orderRef(9011);
    await seed(id);
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,retired_operation,order_version,weight_grams,updated_at,requested_at,recovery_due_at)
      VALUES (?,'review','historical-test','historical-test',1,2140,100,100,0)`).bind(id).run();
    const archived = await (await call(shipPath(id))).json();
    assert.equal(archived.shipment.retiredTest, true);
    assert.equal(archived.shipment.recovery, null);
    assert.equal(archived.canCreate, false);
    assert.equal(archived.canLinkOrder, true);
    const before = requests.length;
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await create(id)).status, 202);
    assert.equal(requests.length, before);
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET candidate_provider_id=123 WHERE order_id=?").bind(id).run();
    const candidate = await read(id);
    assert.equal(Object.hasOwn(candidate, "retiredTest"), false);
    assert.ok(candidate.recovery);
  });

  await t.test("historical reference failures are read-only across a changed connection and concurrent attempts", async () => {
    const id = orderRef(106);
    await seed(id);
    await historicalFailure(id);
    const before = posts();
    const seen = requests.length;
    assert.equal((await (await call(shipPath(id))).json()).canCreate, false);
    const blocked = await Promise.all([create(id), create(id)]);
    assert.deepEqual(blocked.map(reply => reply.status), [202, 202]);
    assert.equal(requests.length, seen);
    const diagnostic = await call(shipPath(id) + "/reference-check", "POST", {
      ifVersion: 1, bookingVersion: (await settings()).version,
    });
    assert.equal(diagnostic.status, 200);
    assert.equal((await diagnostic.json()).outcome, "missing");
    const refreshStart = requests.length;
    const results = await Promise.all([refresh(id), refresh(id)]);
    assert.ok(results.every(reply => reply.status === 200));
    assert.equal(requests.length - refreshStart, 1, "a single read-only reconciliation lease");
    assert.equal((await read(id)).referenceLookupFailure, "unconfirmed");
    assert.equal((await dispatch(id, 1)).status, 409);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    const marker = () => db.prepare("SELECT operation,requested_at,booking_connection FROM wholesale_royal_mail_shipments WHERE order_id=?").bind(id).first();
    const original = { operation: "old-operation", requested_at: null, booking_connection: "previous-connection" };
    assert.deepEqual(await marker(), original);

    missingLookupReplies.set(id, [{ orderReference: orderRef(107), code: "OrderNotFound" }]);
    await releaseRefresh(id);
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await read(id)).referenceLookupFailure, "unconfirmed");
    assert.deepEqual(await marker(), original);

    records.set(id, { orderIdentifier: 8801, orderReference: id, trackingNumber: number, printedOn: "2026-11-28T12:00:00Z" });
    await releaseRefresh(id);
    assert.equal((await refresh(id)).status, 200);
    const found = await read(id);
    assert.equal(found.orderId, 8801);
    assert.equal(found.reviewRequired, true);
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal((await create(id)).status, 200);
    assert.deepEqual(await marker(), original);
    assert.equal(posts(), before);
  });

  await t.test("the database cannot reserve a replacement if an unknown marker appears during a permitted retry", async () => {
    const id = orderRef(108);
    await seed(id);
    await historicalFailure(id, 0);
    assert.equal((await (await call(shipPath(id))).json()).canCreate, true);
    await db.prepare(`CREATE TRIGGER simulate_legacy_marker BEFORE INSERT ON wholesale_royal_mail_shipments
      WHEN NEW.order_id='${id}' BEGIN UPDATE wholesale_royal_mail_shipments SET requested_at=NULL WHERE order_id=NEW.order_id; END`).run();
    const before = requests.length;
    try {
      assert.equal((await create(id)).status, 202);
      assert.equal((await read(id)).referenceLookupFailure, "unconfirmed");
      assert.equal(requests.length, before);
    } finally {
      await db.prepare("DROP TRIGGER simulate_legacy_marker").run();
    }
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

  await t.test("a pinned provider ID reassigned to another wholesale reference blocks PDF and handover", async () => {
    const id = orderRef(103);
    await seed(id);
    assert.equal((await create(id)).status, 201);
    const saved = records.get(id);
    saved.orderReference = orderRef(104);
    const before = requests.length;
    assert.equal((await call(shipPath(id) + "/label")).status, 409);
    assert.equal((await read(id)).reviewRequired, true);
    assert.deepEqual(requests.slice(before).map(row => row.path), ["/api/v1/orders/" + saved.orderIdentifier]);
    assert.equal((await dispatch(id, 1)).status, 409);
    assert.equal((await call(shipPath(id) + "/verify", "POST", { ifVersion: 1, trackingNumber: number, confirmed: true })).status, 409);
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
    const purchasesBefore = posts();
    labelErrors.set(unfinished, [{ code: "LabelFailed", message: "Invalid service code, private@example.test" }]);
    unlabelled.add(unfinished);
    assert.equal((await create(unfinished)).status, 201);
    const incomplete = await read(unfinished);
    assert.equal(incomplete.state, "created");
    assert.ok(incomplete.orderId);
    assert.ok(incomplete.problem);
    assert.doesNotMatch(incomplete.problem, /private@example/);
    const before = requests.length;
    assert.equal((await previewLabel(unfinished)).status, 409);
    assert.equal((await call(shipPath(unfinished) + "/label")).status, 409);
    assert.equal(requests.length, before, "a staff label download cannot generate unconfirmed postage");
    assert.equal((await create(unfinished)).status, 200);
    const pending = records.get(unfinished);
    delete pending.labelErrors; // GET /orders normally has no label generation diagnostics.
    await refresh(unfinished);
    assert.equal((await read(unfinished)).problem, incomplete.problem);
    pending.printedOn = "2026-11-28T12:00:00Z";
    await releaseRefresh(unfinished);
    await refresh(unfinished);
    const ready = await read(unfinished);
    assert.equal(ready.state, "labelled");
    assert.equal(ready.problem, null);
    assert.equal(await (await call(shipPath(unfinished) + "/label")).text(), pdf);
    assert.equal(posts() - purchasesBefore, 1);
  });

  await t.test("a rejected creation can echo the entire submitted order including its label options", async () => {
    const id = orderRef(210);
    await seed(id);
    const before = requests.length;
    const beforePosts = posts();
    interceptCreate = (reference, item) => {
      assert.equal(reference, id);
      assert.deepEqual(item.label, { includeLabelInResponse: true, includeReturnsLabel: false, includeCN: false });
      return RuntimeResponse.json({
        successCount: 0, errorsCount: 1, createdOrders: [],
        failedOrders: [{ order: item, errors: [{ errorCode: 61,
          errorMessage: "Invalid postcode", fields: [{ fieldName: "recipient.address.postcode", value: item.recipient.address.postcode }] }] }],
      });
    };
    try {
      const result = await create(id);
      assert.equal(result.status, 200);
      const view = await result.json();
      assert.equal(view.canCreate, true);
      assert.equal(view.shipment.state, "failed");
      assert.equal(view.shipment.orderId, null);
      assert.equal(view.shipment.recovery, null);
      assert.match(view.shipment.problem, /postcode/i);
      assert.doesNotMatch(view.shipment.problem, /NR1 5AB|Example Coffee Bar|Example Lane|includeLabelInResponse/);
      assert.deepEqual(requests.slice(before).map(row => row.method), ["POST"]);
    } finally {
      interceptCreate = undefined;
    }
    const corrected = { ...packageDetails, recipient: { ...packageDetails.recipient, postcode: "NR1 1AA" } };
    assert.equal((await call(shipPath(id), "POST", corrected)).status, 201);
    assert.equal((await call(shipPath(id), "POST", corrected)).status, 200);
    assert.equal((await read(id)).state, "labelled");
    assert.equal(posts() - beforePosts, 2, "one definitive rejection and one reviewed purchase");
  });

  await t.test("preflight checks the actual Click & Drop billing payload and a changed review cannot buy postage", async () => {
    const id = orderRef(301), buyer = "separate-billing-customer";
    await seed(id, { customerId: buyer });
    const check = (details = packageDetails) => call(shipPath(id) + "/preflight", "POST", details);
    const before = requests.length;
    const initial = await (await check()).json();
    assert.equal(initial.ready, true);
    assert.equal(initial.billingSource, "delivery");
    assert.equal(initial.billingRevision, 0);
    assert.equal(initial.billingDraft.postcode, packageDetails.recipient.postcode);
    const invoice = await db.prepare(`INSERT INTO wholesale_invoices(invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by)
      VALUES ('BILLING-301',?,?,'billing-301','{}',1,'Test Admin') RETURNING seq`).bind(id, buyer).first();
    const exp = await db.prepare(`INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,
      payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,state,created_at,updated_at)
      VALUES ('production','billing-301','','',?,'billing-301','','{}','','','','','','',0,'linked',1,1) RETURNING id`).bind(invoice.seq).first();
    const review = await db.prepare(`INSERT INTO wholesale_invoice_billing_reviews
      (review_key,invoice_id,export_id,customer_id,environment,remote_id,remote_address_hash,choice,address,postcode,actor,created_at)
      VALUES ('billing-301',?,?,?,'production','x','x','quickbooks','10 Accounts Lane, London','SW1A 1AA','Test Admin',1) RETURNING id`)
      .bind(invoice.seq, exp.id, buyer).first();
    const stale = await call(shipPath(id), "POST", { ...packageDetails, billingRevision: initial.billingRevision });
    assert.equal(stale.status, 409);
    const checked = await (await check()).json();
    assert.equal(checked.ready, true);
    assert.equal(checked.billingSource, "confirmed");
    assert.equal(checked.billingRevision, review.id);
    assert.equal(checked.billingDraft.city, "London");
    const bad = { ...packageDetails, billing: { ...checked.billingDraft, city: "", postcode: "??" } };
    const invalid = await (await check(bad)).json();
    assert.equal(invalid.ready, false);
    assert.deepEqual(invalid.issues.map(issue => issue.field), ["billing.city", "billing.postcode"]);
    assert.equal((await call(shipPath(id), "POST", bad)).status, 400);
    assert.equal(await read(id), null, "invalid payload never claimed a booking");
    assert.equal(requests.length, before, "local preflight never contacts the carrier");

    let booking;
    interceptCreate = (ref, item) => {
      booking = item;
      if (!item.billing?.address?.fullName || !item.billing?.address?.city || !item.billing?.address?.addressLine1) {
        return RuntimeResponse.json({ successCount: 0, errorsCount: 1, failedOrders: [{ order: item, errors: [{ errorCode: 15,
          errorMessage: "Missing billing city", fields: [{ fieldName: "Billing.Address.City" }] }] }] });
      }
    };
    try {
      assert.equal((await call(shipPath(id), "POST", { ...packageDetails, billingRevision: checked.billingRevision })).status, 201);
      assert.equal(booking.billing.address.city, "London");
      assert.equal(booking.billing.address.addressLine1, "10 Accounts Lane");
      assert.equal(booking.billing.address.postcode, "SW1A 1AA");
      assert.equal(booking.recipient.address.city, packageDetails.recipient.city);
      assert.equal((await check()).status, 409);
      assert.equal(requests.slice(before).filter(row => row.method === "POST").length, 1);
    } finally { interceptCreate = undefined; }
  });

  await t.test("a conflicting HTTP 200 receipt stays in review with a redacted receipt diagnostic", async () => {
    const id = orderRef(214);
    await seed(id);
    const before = requests.length;
    interceptCreate = (reference, item) => {
      assert.equal(reference, id);
      return RuntimeResponse.json({
        successCount: 0, errorsCount: 1,
        createdOrders: [{ orderReference: id, orderIdentifier: 24680 }],
        failedOrders: [{ order: item, errors: [{ errorCode: 61,
          errorMessage: "Private receipt message", fields: [{ fieldName: "recipient.address.postcode", value: item.recipient.address.postcode }] }] }],
        "private@example.test": "Private receipt metadata",
      });
    };
    try {
      const response = await create(id);
      assert.equal(response.status, 202);
      const { canCreate, shipment } = await response.json();
      assert.equal(canCreate, false);
      assert.equal(shipment.state, "review");
      assert.equal(shipment.orderId, null);
      assert.match(shipment.requestProblem, /HTTP 200/);
      assert.match(shipment.requestProblem, /success count 0, error count 1, created entries 1, failed entries 1/);
      assert.match(shipment.requestProblem, /matches this reference/);
      assert.match(shipment.requestProblem, /Carrier code 61/);
      assert.match(shipment.requestProblem, /Reported field recipient\.address\.postcode/);
      assert.doesNotMatch(shipment.requestProblem, /private@example\.test|Private receipt|NR1 5AB|Example Lane|24680/);
      assert.ok(!shipment.requestProblem.includes(id));
      assert.deepEqual(requests.slice(before).map(row => row.method), ["POST"]);

      assert.equal((await refresh(id)).status, 200);
      const checked = await read(id);
      assert.equal(checked.state, "review");
      assert.equal(checked.requestProblem, shipment.requestProblem);
      assert.equal((await create(id)).status, 202);
      assert.ok(requests.slice(before + 1).some(row => row.method === "GET"));
      assert.equal(requests.slice(before).filter(row => row.method === "POST").length, 1);
    } finally {
      interceptCreate = undefined;
    }
  });

  await t.test("a null failed-order collection needs numeric confirmation and purchases once", async () => {
    const id = orderRef(215), orderIdentifier = 24681;
    await seed(id);
    const before = requests.length;
    interceptCreate = reference => {
      assert.equal(reference, id);
      const created = { orderReference: id, orderIdentifier, trackingNumber: number, printedOn: "2026-11-26T09:00:00Z" };
      records.set(id, created);
      return RuntimeResponse.json({ successCount: 1, errorsCount: 0, createdOrders: [created], failedOrders: null });
    };
    try {
      const first = await create(id);
      assert.equal(first.status, 201);
      assert.equal((await first.json()).shipment.orderId, orderIdentifier);
      const repeated = await create(id);
      assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).shipment.orderId, orderIdentifier);
      assert.deepEqual(requests.slice(before).map(row => [row.method, row.path]), [
        ["POST", "/api/v1/orders"], ["GET", "/api/v1/orders/" + orderIdentifier],
      ]);
    } finally {
      interceptCreate = undefined;
    }
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
    const originalProblem = (await read(id)).requestProblem;
    assert.match(originalProblem, /502/, "retain the status of the unconfirmed purchase");
    assert.doesNotMatch(originalProblem, /carrier response lost|Example Lane|NR1 5AB/);
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
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await read(id)).requestProblem, originalProblem, "a manual lookup leaves the original purchase diagnostic visible");
    await recover();
    assert.equal((await read(id)).recovery.attempts, 0, "a new booking has a grace period");
    await expire();
    assert.equal((await refresh(id)).status, 200);
    const afterManual = (await read(id)).recovery;
    assert.equal(afterManual.nextCheckAt, 1, "a manual check keeps the original queue eligibility");
    assert.equal(afterManual.attempts, 0, "it does not consume a scheduled attempt");
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expire();
      const prior = lookups();
      await Promise.all([recover(), recover()]);
      assert.equal(lookups() - prior, 1, "concurrent recovery runs use one lookup");
      const { recovery, requestProblem } = await read(id);
      assert.equal(requestProblem, originalProblem, "scheduled checks retain the original purchase diagnostic");
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

  await t.test("a historic submitted order with no stored response is recovered from a verified numeric match without buying postage", async () => {
    const id = orderRef(211), at = Date.now() - 11 * 60_000;
    await seed(id, { createdAt: at - 2 * 60 * 60_000 });
    const connection = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fixture-click-drop"))).toString("base64");
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,requested_at,updated_at,booking_connection,label_order_created_at,recovery_due_at)
      VALUES (?,'review','submitted',1,2140,?,?,?,?,0)`)
      .bind(id, at, at, connection, at - 2 * 60 * 60_000).run();
    missingLookupReplies.set(id, [{ code: "InvalidOrderIdentifier" }]);
    assert.equal((await read(id)).requestProblem, null, "an old booking has no saved response to diagnose");
    const start = requests.length;
    assert.equal((await refresh(id)).status, 200);
    assert.equal((await read(id)).state, "review");
    assert.equal((await create(id)).status, 202);
    const carrier = { orderIdentifier: 2211, orderReference: id, createdOn: new Date(at).toISOString(),
      printedOn: new Date(at).toISOString(), trackingNumber: number };
    listedOnly.set(id, carrier);
    try {
      await releaseRefresh(id);
      assert.equal((await refresh(id)).status, 200);
      const stored = await read(id);
      assert.equal(stored.orderId, carrier.orderIdentifier);
      assert.equal(stored.state, "labelled");
      assert.equal(stored.recovery, null);
      assert.equal((await create(id)).status, 200);
      assert.ok(requests.slice(start).some(row => row.path === "/api/v1/orders/" + carrier.orderIdentifier));
      assert.ok(requests.slice(start).every(row => row.method === "GET"), "confirmation and retries never repurchase a submitted order");
    } finally {
      listedOnly.delete(id);
      missingLookupReplies.delete(id);
    }
  });

  await t.test("recovery cannot attach a carrier order number already linked to another wholesale shipment", async () => {
    const booked = orderRef(212), unresolved = orderRef(213);
    await seed(booked);
    await seed(unresolved);
    assert.equal((await create(booked)).status, 201);
    const original = await read(booked);
    const sentAt = Date.now() - 10 * 60_000;
    await db.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,requested_at,updated_at,booking_connection)
      SELECT ?,'review','submitted',1,2140,?,?,booking_connection FROM wholesale_royal_mail_shipments WHERE order_id=?`)
      .bind(unresolved, sentAt, sentAt, booked).run();
    records.set(unresolved, { ...records.get(booked), orderReference: unresolved });
    const firstRead = requests.length;
    assert.equal((await refresh(unresolved)).status, 200);
    const held = await read(unresolved);
    assert.equal(held.state, "review");
    assert.equal(held.orderId, null);
    assert.equal(held.recovery.status, "needs_admin");
    assert.match(held.problem, /another wholesale|different wholesale/i);
    assert.equal((await create(unresolved)).status, 202);
    assert.equal((await read(booked)).orderId, original.orderId);
    const owners = await db.prepare("SELECT order_id FROM wholesale_royal_mail_shipments WHERE provider_id=?")
      .bind(original.orderId).all();
    assert.deepEqual(owners.results, [{ order_id: booked }]);
    assert.ok(requests.slice(firstRead).every(row => row.method === "GET"));
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
    // Simulate the sending Worker setting the durable marker just after recovery read the old zero.
    await db.prepare(`CREATE TRIGGER mark_outbound_during_recovery AFTER UPDATE OF refresh_after ON wholesale_royal_mail_shipments
      WHEN NEW.order_id='${racing}' AND NEW.refresh_after>0 AND NEW.requested_at=0
      BEGIN UPDATE wholesale_royal_mail_shipments SET requested_at=1 WHERE order_id=NEW.order_id; END`).run();
    try { assert.equal((await refresh(racing)).status, 200); }
    finally { await db.prepare("DROP TRIGGER mark_outbound_during_recovery").run(); }
    assert.equal((await read(racing)).state, "booking", "recovery cannot release a reservation once transmission starts");
    assert.equal(requests.length, before, "proven-unsent recovery does not need a carrier lookup");
    assert.equal((await create(racing)).status, 202);
  });

  await t.test("an existing Click & Drop label cannot use an unsubmitted recipient draft", async () => {
    const id = orderRef(7);
    await seed(id, { locationSnapshot: { address: "16 Example Lane, Norwich", postcode: "NR1 5AB" } });
    records.set(id, { orderIdentifier: 1907, orderReference: id, trackingNumber: number, printedOn: "2026-11-26T09:00:00Z" });
    const before = posts();
    const view = await (await call(shipPath(id))).json();
    assert.equal(view.canLinkOrder, true);
    assert.equal(view.linkOperation, "new");
    const start = requests.length;
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    interceptNumeric = async () => { enter(); await held; };
    const linking = call(shipPath(id) + "/link-order", "POST", { ifVersion: 1,
      bookingVersion: view.bookingVersion, operation: view.linkOperation, orderNumber: 1907 });
    try {
      const early = await Promise.race([entered.then(() => null), linking]);
      if (early) assert.fail(await early.text());
      await create(id);
      assert.deepEqual(requests.slice(start).map(r => [r.method, r.path]), [["GET", "/api/v1/orders/1907"]]);
    } finally {
      release();
      interceptNumeric = undefined;
    }
    assert.equal((await linking).status, 200);
    assert.equal((await create(id)).status, 200);
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

  await t.test("only proven-unsent orders can link on a changed connection and reporting external postage fences purchases", async () => {
    const id = orderRef(201);
    await seed(id);
    await historicalFailure(id, 0);
    const current = await (await call(shipPath(id))).json();
    assert.equal(current.canCreate, true);
    assert.equal(current.canLinkOrder, true);
    const link = (id, view, orderNumber) => call(shipPath(id) + "/link-order", "POST",
      { ifVersion: view.orderVersion, bookingVersion: view.bookingVersion, operation: view.linkOperation, orderNumber });
    const start = requests.length;
    const before = posts();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    interceptNumeric = async () => { enter(); await held; };
    const missing = link(id, current, 9200);
    try {
      const early = await Promise.race([entered.then(() => null), missing]);
      if (early) assert.fail(await early.text());
      assert.equal((await create(id)).status, 202);
    } finally {
      release();
      interceptNumeric = undefined;
    }
    assert.equal((await missing).status, 409);
    const reported = await (await call(shipPath(id))).json();
    assert.equal(reported.canCreate, false, "a failed link cannot release a reported external purchase");
    assert.equal((await create(id)).status, 202);
    records.set(id, { orderIdentifier: 9201, orderReference: id, trackingNumber: number, printedOn: "2026-11-26T09:00:00Z" });
    assert.equal((await link(id, reported, 9201)).status, 200);
    const linked = await read(id);
    assert.equal(linked.orderId, 9201);
    assert.equal(linked.reviewRequired, true);
    assert.equal((await create(id)).status, 200);
    assert.deepEqual(requests.slice(start).map(r => [r.method, r.path]),
      [["GET", "/api/v1/orders/9200"], ["GET", "/api/v1/orders/9201"]]);
    for (const [index, marker] of [[202, null], [203, 1]]) {
      const other = orderRef(index);
      await seed(other);
      await historicalFailure(other, marker);
      const view = await (await call(shipPath(other))).json();
      const oldStart = requests.length;
      const refused = await link(other, view, 9201);
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).code, "royal_mail_connection_changed");
      assert.equal((await create(other)).status, 202);
      assert.equal(requests.length, oldStart);
    }
    assert.equal(posts(), before);
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
    const staffPlanId = orderRef(320);
    await seed(staffPlanId,{...net30,grams:2000,pence:4100,lines:[
      {...order.lines[0],quantity:1}, {...order.lines[0],productId:"special",quantity:1},
    ]});
    const planBody = {ifVersion:1,planVersion:null,weights:[1050,1050],contents:[[1,0],[0,1]]};
    const manual = await call(shipPath(staffPlanId)+"/boxes","PUT",{...planBody,goodsPence:[1800,2300]});
    assert.equal(manual.status,200);
    const staffBoxes = await (await staff(staffPlanId,"GET",undefined,"/boxes")).json();
    assert.equal(staffBoxes.manualGoodsValuesRequired,true);
    assert.equal(staffBoxes.orderGoodsPence,undefined);
    assert.deepEqual(staffBoxes.boxes.map(box=>box.contents),planBody.contents);
    assert.doesNotMatch(JSON.stringify(staffBoxes),/goodsPence|"price"|totalPence|subtotalPence/i);
    assert.equal((await staff(staffPlanId,"PUT",{...planBody,planVersion:staffBoxes.planVersion,goodsPence:[1800,2300]},"/boxes")).status,400);

    const staffBefore = requests.length;
    const check = await staff(paid, "POST", payload, "/preflight");
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), { ready: true, issues: [], billingSource: "delivery", billingRevision: 0 });
    assert.equal((await staff(paid, "POST", { ...payload, billing: packageDetails.recipient }, "/preflight")).status, 400);
    assert.equal(requests.length, staffBefore);
    assert.equal(ready.canCreate, true);
    assert.deepEqual(ready.eligibility, { eligible: true });
    assert.equal(ready.bookingService, "TPS48");
    assert.deepEqual((await (await call(shipPath(paid))).json()).recipient, ready.recipient);
    assert.equal((await staff(paid, "GET", undefined, "/location")).status, 403);
    assert.equal((await staff(paid, "PUT", {}, "/location")).status, 403);
    assert.equal((await staff(paid, "POST", {}, "/service-check")).status, 403);
    assert.equal((await staff(paid, "POST", {}, "/reference-check")).status, 403);
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
    const historic = orderRef(109);
    await seed(historic);
    await historicalFailure(historic);
    const originalPosts = posts();
    assert.equal((await (await staff(historic)).json()).canCreate, false);
    assert.equal((await staff(historic, "POST", {})).status, 202);
    await releaseRefresh(historic);
    assert.equal((await staff(historic, "POST", {}, "/refresh")).status, 200);
    assert.equal((await read(historic)).referenceLookupFailure, "unconfirmed");
    assert.equal(posts(), originalPosts);
    await db.prepare("UPDATE wholesale_invoices SET paid=1 WHERE seq=6501").run();
    assert.equal((await (await staff(billed)).json()).canCreate, true);

    const beforePosts = posts();
    // The account becomes ineligible while the reviewed parcel is being reserved.
    await db.prepare(`CREATE TRIGGER hold_during_reservation AFTER INSERT ON wholesale_royal_mail_shipments
      WHEN NEW.order_id='${racing}' BEGIN UPDATE wholesale_preview SET data=json_set(data,'$.status','On hold')
      WHERE kind='customer' AND id='${customerId}'; END`).run();
    const beforeHold = requests.length;
    try {
      const held = await staff(racing, "POST", payload);
      assert.equal(held.status, 409);
      assert.equal((await held.json()).code, "royal_mail_account_on_hold");
      assert.equal(requests.length, beforeHold);
    } finally {
      await db.prepare("DROP TRIGGER hold_during_reservation").run();
      await accountStatus("Active");
    }
    let sent, enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const bookingStart = requests.length;
    interceptCreate = async (reference, item) => {
      assert.equal(reference, paid);
      sent = item;
      enter();
      await held;
    };
    const purchase = staff(paid, "POST", payload);
    try {
      const early = await Promise.race([entered.then(() => null), purchase]);
      if (early) assert.fail(await early.text());
      const contenders = await Promise.all([create(paid), staff(paid, "POST", payload)]);
      assert.deepEqual(contenders.map(result => result.status), [202, 202]);
      assert.deepEqual(requests.slice(bookingStart).map(r => [r.method, r.path]), [["POST", "/api/v1/orders"]]);
    } finally {
      release();
      interceptCreate = undefined;
    }
    assert.equal((await purchase).status, 201);
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
  await t.test("sealed boxes book independently, allocate one order value, and hand over once every label is downloaded", async () => {
    const id = orderRef(315), base = shipPath(id), path = base + "/boxes";
    await seed(id, { grams:36_000, pence:38016, deliveryPence:745, totalPence:38784, packs:36,
      lines:[{...order.lines[0], quantity:18, price:1001},
        {...order.lines[0], productId:"ethiopia",title:"Ethiopia",quantity:18,price:1111}] });
    const save = (weights,planVersion=null) => call(path,"PUT",{ifVersion:1,planVersion,weights,contents:[[18,0],[0,18]]});
    assert.equal((await save([17000,17000])).status,400);
    assert.equal((await save([35000,1000])).status,400);
    const saved = await save([18000,19000]);
    assert.equal(saved.status,200,await saved.clone().text());
    const plan = await saved.json();
    assert.equal(plan.boxCount,2);
    assert.equal((await save([18500,19000])).status,409);
    assert.equal((await call(base,"POST",packageDetails)).status,409);
    const start = posts();
    const body = index => ({...packageDetails,planVersion:plan.planVersion,weightGrams:plan.boxes[index-1].weightGrams,
      bookingVersion:plan.bookingVersion,bookingService:plan.bookingService});
    const payloads = [];
    interceptCreate = (_id,item) => {payloads.push(item);};
    try {
      const check = await call(path+"/1/preflight","POST",body(1));
      assert.equal(check.status,200,await check.clone().text());
      assert.equal((await check.json()).ready,true);
      assert.equal(posts(),start);
      assert.equal((await call(path+"/1","POST",body(1))).status,405);
      assert.equal((await call(path+"/1/book")).status,405);
      assert.equal((await call(path+"/1/book","POST",{...body(1),planVersion:"stale"})).status,409);
      const first = await Promise.all([call(path+"/1/book","POST",body(1)),call(path+"/1/book","POST",body(1))]);
      assert.ok(first.some(r=>r.status===201),await Promise.all(first.map(r=>r.clone().text())));
      assert.equal(posts(),start+1);
      assert.equal((await save([19000,19000],plan.planVersion)).status,409);
      const earlier = await dispatch(id,1);
      assert.equal(earlier.status,409);
      const different = {...body(2),recipient:{...packageDetails.recipient,postcode:"NR1 1AA"}};
      const checkedAddress = await (await call(path+"/2/preflight","POST",different)).json();
      assert.equal(checkedAddress.ready, false);
      assert.match(checkedAddress.issues[0].message, /same delivery address as the other booked boxes/);
      const rejectedAddress = await call(path+"/2/book","POST",different);
      assert.ok([400,409].includes(rejectedAddress.status));
      assert.equal(posts(),start+1);
      const second = await call(path+"/2/book","POST",{...body(2),recipient:{...packageDetails.recipient,line1:packageDetails.recipient.line1.toUpperCase()}});
      // Both boxes have the same physical address, entered with different case.
      assert.equal(second.status,201,await second.clone().text());
      assert.equal(posts(),start+2);
      assert.deepEqual(payloads.map(item=>item.orderReference),[id+"-B1",id+"-B2"]);
      assert.deepEqual(payloads.map(p=>Math.round(p.subtotal*100)),[18018,19998], "the goods in each box determine its declared value");
      for (const [field,pence] of [["subtotal",38016],["shippingCostCharged",745],["orderTax",23],["total",38784]]) {
        assert.equal(payloads.reduce((n,p)=>n+Math.round(p[field]*100),0),pence);
      }
      assert.deepEqual(payloads.map(item=>item.packages[0].weightInGrams),[18000,19000]);
      assert.equal((await call(path+"/1/label?preview=1")).status,200);
      assert.equal((await call(path+"/2/label")).status,200);
      assert.equal((await (await call(base)).json()).readyForHandover,false);
      assert.equal((await dispatch(id,1)).status,409);
      assert.equal((await call(path+"/1/label")).status,200);
      assert.equal((await (await call(base)).json()).readyForHandover,true);
      const handed = await dispatch(id,1);
      assert.equal(handed.status,200,await handed.clone().text());
      assert.equal(posts(),start+2);
      const payload = await db.prepare("SELECT data FROM wholesale_preview WHERE kind='order' AND id=?").bind(id).first();
      assert.equal(JSON.parse(payload.data).status,"Dispatched");
      assert.ok(!JSON.parse(payload.data).trackingUrl);
    } finally {interceptCreate=undefined;}
  });

  await t.test("each box has the physical bag quantities and legacy goods values must reconcile", async () => {
    const id = orderRef(318), path = shipPath(id) + "/boxes";
    await seed(id, { grams:4000, pence:7100, lines:[{ ...order.lines[0], quantity:2 },
      { ...order.lines[0], productId:"ethiopia", title:"Ethiopia", quantity:2 }] });
    const initial = await (await call(path)).json();
    assert.equal(initial.manualGoodsValuesRequired, true);
    assert.equal(initial.orderGoodsPence, 7100);
    const put = (contents, goodsPence, weights=[2500,2500]) =>
      call(path,"PUT",{ifVersion:1,planVersion:null,weights,contents,goodsPence});
    for (const invalid of [
      [[[2,0],[0,2]], undefined],                        // Ambiguous legacy prices require Admin confirmation.
      [[[2,0],[0,2]], [2500,4601]],                      // The declared value cannot exceed the original sale.
      [[[1,0],[0,2]], [2500,4600]],                      // A missing bag cannot be shipped.
      [[[3,0],[0,1]], [2500,4600]],                      // Nor can a surplus bag.
      [[[2,0],[0,2]], [2500,4600],[3100,1900]],           // The two bags won't fit the second box by weight.
    ]) assert.equal((await put(...invalid)).status,400);
    const saved = await put([[2,0],[0,2]], [2500,4600]);
    assert.equal(saved.status,200,await saved.clone().text());
    const plan = await saved.json();
    assert.deepEqual(plan.boxes.map(box=>box.contents),[[2,0],[0,2]]);
    assert.deepEqual(plan.boxes.map(box=>box.goodsPence),[2500,4600]);
    await amend(id, "$.lines[0].price", 1700);
    const changed = await (await call(path)).json();
    assert.equal(changed.planChanged, true);
    const stale = await call(path+"/1/preflight","POST",{...packageDetails,ifVersion:2,planVersion:plan.planVersion,weightGrams:2500});
    assert.equal(stale.status,409);

    const uniform = orderRef(319), uniformPath = shipPath(uniform) + "/boxes";
    await seed(uniform,{pence:8000,grams:4000,lines:[{...order.lines[0],quantity:4,price:2000}]});
    assert.equal((await call(uniformPath, "PUT",{ifVersion:1,planVersion:null,weights:[3200,3200]})).status,400);
    const exact = await call(uniformPath,"PUT",{ifVersion:1,planVersion:null,weights:[1200,3200]});
    assert.equal(exact.status, 200);
    assert.deepEqual((await exact.json()).boxes.map(box=>box.goodsPence),[2000,6000]);
  });

  await t.test("a settings change during a PDF download fences release until the current connection is reviewed", async () => {
    const id = orderRef(422);
    await seed(id);
    assert.equal((await create(id)).status,201);
    interceptLabel = async () => { await setBookings(false); };
    try {
      const blocked = await call(shipPath(id)+"/label");
      assert.equal(blocked.status,409,await blocked.clone().text());
      assert.equal((await read(id)).labelDownloadedAt,null);
    } finally {
      interceptLabel = undefined;
    }
    // Pausing money operations still permits an existing PDF under the freshly read policy.
    const pdfResponse = await call(shipPath(id)+"/label");
    assert.equal(pdfResponse.status,200,await pdfResponse.clone().text());
    assert.equal(await pdfResponse.text(),pdf);
    await setBookings(true);
  });

  await t.test("Admin can record an amended split's actual alternative courier after in-flight postage is settled", async () => {
    const id = orderRef(421);
    await seed(id);
    const path = shipPath(id)+"/boxes";
    const response = await call(path,"PUT",{ifVersion:1,planVersion:null,weights:[1100,1200],contents:[[1],[1]]});
    assert.equal(response.status,200,await response.clone().text());
    const plan = await response.json();
    const createBox = await call(path+"/1/book","POST",{...packageDetails,weightGrams:1100,
      bookingVersion:plan.bookingVersion,bookingService:plan.bookingService,planVersion:plan.planVersion});
    assert.equal(createBox.status,201,await createBox.clone().text());
    await amend(id,"$.locationSnapshot.postcode","NR1 1AA");
    assert.equal((await call(path+"/1/label")).status,409);
    const view = await (await call(shipPath(id))).json();
    assert.equal(view.canDispatchWithOtherCourier,true);
    assert.equal((await dispatch(id,2)).status,409);
    assert.equal((await dispatch(id,2,"https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB")).status,409);
    const external="https://example.test/actual-shipment";
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET state='booking' WHERE order_id=?").bind(id+"-B1").run();
    assert.equal((await dispatch(id,2,external)).status,409);
    await db.prepare("UPDATE wholesale_royal_mail_shipments SET state='labelled' WHERE order_id=?").bind(id+"-B1").run();
    const handed=await dispatch(id,2,external);
    assert.equal(handed.status,200,await handed.clone().text());
    const saved=await db.prepare("SELECT data FROM wholesale_preview WHERE kind='order' AND id=?").bind(id).first();
    assert.equal(JSON.parse(saved.data).trackingUrl,external);
  });

  await t.test("a plan and a concurrent single-box booking cannot both acquire the order", async () => {
    const id = orderRef(316);
    await seed(id);
    const start = posts();
    const [book,plan] = await Promise.all([create(id),call(shipPath(id)+"/boxes","PUT",{ifVersion:1,planVersion:null,weights:[1100,1200],contents:[[1],[1]]})]);
    assert.ok(book.status===201 && plan.status===409 || book.status===409 && plan.status===200,
      JSON.stringify({book:book.status,plan:plan.status}));
    assert.equal(posts()-start,book.status===201?1:0);
  });

});
