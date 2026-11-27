import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [new URL("../src/royalMailProviderChecks.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "browser", format: "esm",
});
const { runRoyalMailProviderChecks } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
const key = "fixture-private-account-key";
const connection = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).toString("base64");
const account = "Fixture account";
const accountScope = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key + "\u0000" + account))).toString("base64");
const orderId = "WS-" + "B".repeat(32);
const tracking = "AB123456789GB";
const sample = { postcode: "nr12ab", weightGrams: 1520 };
const order = { preview: false, status: "Ready", delivery: "Delivery", customerId: "private-customer", business: "Private business" };
const pdf = "%PDF-1.7\nFixture label\n%%EOF\n";

function harness(t, overrides = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE wholesale_preview (kind TEXT, id TEXT, data TEXT, version INTEGER);
    CREATE TABLE wholesale_royal_mail_shipments (order_id TEXT, state TEXT, booking_connection TEXT, provider_id INTEGER, tracking_number TEXT,
      review_required INTEGER, destination_postcode TEXT, weight_grams INTEGER, order_version INTEGER, shipping_fingerprint TEXT, updated_at INTEGER,
      label_downloaded_at INTEGER, booking_account_scope TEXT);`);
  const env = { DB: { prepare(sql) {
    assert.match(sql, /^SELECT /);
    return { bind(...args) {
      return { all: async () => ({ results: db.prepare(sql).all(...args) }) };
    } };
  } } };
  const connections = {
    booking: { key, serviceCode: "NDB", serviceRegisterCode: "01", ...overrides.booking },
    tracking: overrides.tracking === undefined ? { clientId: "private-client", clientSecret: "private-secret", acceptTerms: true } : overrides.tracking,
  };
  const state = {
    accounts: [account], services: [{ serviceCode: "NDB" }], providerId: 123,
    providerState: "labelled", providerTracking: tracking, methods: [], paths: [], ...overrides.state,
  };
  function insert({ orderRecord = order, scope = connection, number = tracking, changed = false, review = 0, accountTag = null } = {}) {
    db.prepare("INSERT INTO wholesale_preview VALUES ('order',?,?,?)").run(orderId, JSON.stringify(orderRecord), changed ? 2 : 1);
    db.prepare("INSERT INTO wholesale_royal_mail_shipments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(orderId, "labelled", scope, 123, number, review, "NR2 2AB", 2820, 1, null, 100, null, accountTag);
  }
  async function fetcher(input, init) {
    state.methods.push(init.method);
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    const url = new URL(input);
    state.paths.push(url);
    if (url.pathname.endsWith("/carriers")) return state.carriersResponse?.() ?? Response.json(state.accounts.map(shippingAccountName => ({ shippingAccountName })));
    if (url.pathname.endsWith("/services")) return state.serviceResponse?.() ?? Response.json([{ shippingAccountName: account, services: state.services }]);
    if (url.pathname.endsWith("/summary")) {
      assert.equal(url.searchParams.get("mailPieceId"), tracking);
      assert.equal(init.headers.get("Authorization"), null);
      return state.trackingResponse?.() ?? Response.json({ mailPieces: [{ mailPieceId: tracking, status: "200", summary: { statusCategory: "Delivered", lastEventCode: "EV" } }] });
    }
    assert.equal(init.headers.get("Authorization"), "Bearer " + key);
    if (url.pathname.endsWith("/123/label")) return state.pdfResponse?.() ?? new Response(pdf, { headers: { "content-type": "application/pdf" } });
    assert.equal(decodeURIComponent(url.pathname), '/api/v1/orders/"' + orderId + '"');
    return Response.json([{ orderIdentifier: state.providerId, orderReference: orderId, trackingNumber: state.providerTracking,
      ...(state.providerState === "labelled" ? { printedOn: "2026-11-27T15:20:22Z" } : {}) }]);
  }
  async function run(parcel) {
    const rows = await runRoyalMailProviderChecks(env, connections, parcel, fetcher);
    assert.equal(rows.length, 5);
    assert.doesNotMatch(JSON.stringify(rows), /fixture-private|private-client|private-secret|Fixture account|Private business|NR[12] ?2AB|AB123456789GB|WS-B{10}/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM wholesale_royal_mail_shipments WHERE label_downloaded_at IS NOT NULL").get().count, 0);
    return Object.fromEntries(rows.map(row => [row.id, row]));
  }
  return { state, insert, run };
}

test("a single unnamed account can check scoped service, validated existing PDF and linked real scan, using only GETs", async t => {
  const { state, insert, run } = harness(t);
  insert();
  const rows = await run(null);
  assert.deepEqual(Object.values(rows).map(r => r.status), Array(5).fill("passed"));
  const services = state.paths.find(url => url.pathname.endsWith("/services")).searchParams;
  assert.deepEqual(Object.fromEntries(services), {
    destinationCountryCode: "GBR", destinationPostcode: "NR2 2AB", packagingFormat: "Parcel", packageWeight: "2820", shippingAccountName: account,
  });
  assert.match(rows.service.detail, /NDB · 2,820 g parcel · NR2 district/);
  assert.equal(state.paths.length, 5);
});

test("multiple accounts require exactly one matching name, allowing an explicit sample without any shipment", async t => {
  for (const badName of [undefined, "fixture account", "unknown"]) {
    const { state, run } = harness(t, { booking: { shippingAccountName: badName }, state: { accounts: [account, "Second account"] } });
    const rows = await run(sample);
    assert.equal(rows.authentication.status, "passed");
    assert.equal(rows.shippingAccount.status, "attention");
    assert.equal(rows.service.status, "unverified");
    assert.equal(state.paths.length, 1);
  }
  const { state, run } = harness(t, { booking: { shippingAccountName: account }, state: { accounts: [account, "Second account"] } });
  const rows = await run(sample);
  assert.equal(rows.service.status, "passed");
  assert.equal(rows.labelPdf.status, "unverified");
  assert.equal(rows.tracking.status, "unverified");
  assert.equal(state.paths.at(-1).searchParams.get("destinationPostcode"), "NR1 2AB");
  assert.equal(state.paths.at(-1).searchParams.get("packageWeight"), "1520");
  assert.match(rows.service.detail, /NDB · 1,520 g parcel · NR1 district/);
});

test("previews, collections, skipped, stale and held shipments and shipments on different credentials never supply private evidence", async t => {
  for (const record of [{ scope: "unrelated" }, { review: 1 }, { changed: true }, { orderRecord: { ...order, preview: true } },
    { orderRecord: { ...order, skipped: true } }, { orderRecord: { ...order, delivery: "Collection" } }]) {
    const { state, run, insert } = harness(t);
    insert(record);
    const rows = await run(null);
    assert.equal(rows.labelPdf.status, "unverified");
    assert.equal(state.paths.length, 1);
  }
});

test("a reset or reassigned order cannot prove label or tracking permissions", async t => {
  for (const mismatch of [{ providerId: 124 }, { providerTracking: "AC123456789GB" }, { providerState: "created" }]) {
    const { state, insert, run } = harness(t, { state: mismatch });
    insert();
    const rows = await run(null);
    assert.equal(rows.labelPdf.status, "unverified");
    assert.equal(rows.tracking.status, "unverified");
    assert(!state.paths.some(url => /\/label$|\/summary$/.test(url.pathname)));
  }
});

test("entitlement refusals, invalid PDFs, outages, service mismatches and no scan stay distinct", async t => {
  const { state, run, insert } = harness(t, { state: { services: [], pdfResponse: () => new Response(null, { status: 403 }),
    trackingResponse: () => Response.json({ mailPieces: [{ mailPieceId: tracking, status: "404" }] }) } });
  insert();
  let rows = await run(sample);
  assert.equal(rows.labelPdf.status, "attention");
  assert.match(rows.labelPdf.detail, /Online Business Account/);
  assert.equal(rows.tracking.status, "unverified");
  assert.match(rows.tracking.detail, /no tracking scan/);
  assert.equal(rows.service.status, "attention");
  state.pdfResponse = () => new Response("this is not a PDF", { headers: { "content-type": "application/pdf" } });
  rows = await run(sample);
  assert.equal(rows.labelPdf.status, "unverified");
  assert.match(rows.labelPdf.detail, /unexpected/);
  state.carriersResponse = () => new Response("private diagnostics", { status: 429 });
  rows = await run(sample);
  assert.equal(rows.authentication.status, "unverified");
  assert.match(rows.authentication.detail, /request limit/);
  state.carriersResponse = () => new Response(null, { status: 401 });
  rows = await run(sample);
  assert.equal(rows.authentication.status, "attention");
});


test("multi-account keys only use evidence from a confirmed create on the exact selected billing account", async t => {
  for (const tag of [null, "different-account-scope", accountScope]) {
    const { state, insert, run } = harness(t, { booking: { shippingAccountName: account }, state: { accounts: [account, "Other"] } });
    insert({ accountTag: tag });
    const rows = await run(sample);
    assert.equal(rows.shippingAccount.status, "passed");
    const proven = tag === accountScope;
    assert.equal(rows.labelPdf.status, proven ? "passed" : "unverified");
    assert.equal(rows.tracking.status, proven ? "passed" : "unverified");
    assert.equal(state.paths.some(url => url.pathname.endsWith("/label")), proven);
  }
});


test("a matching 200 tracking record with no event confirms access while explaining the pending scan", async t => {
  const { insert, run } = harness(t, { state: {
    trackingResponse: () => Response.json({ mailPieces: [{ mailPieceId: tracking, status: "200", summary: {} }] }),
  } });
  insert();
  const rows = await run(null);
  assert.equal(rows.tracking.status, "passed");
  assert.match(rows.tracking.detail, /has not returned any scan details/);
});
