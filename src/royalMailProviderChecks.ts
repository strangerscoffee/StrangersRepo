import { belongsToOrder, matchesPlannedBox, shipmentOrderJoin } from "./royalMailShipmentOrder";
import { packingBasis } from "./royalMailBoxContents";
import type { Env } from "./http";
import {
  fetchRoyalMailLabel, fetchRoyalMailTracking, findRoyalMailOrderById, listRoyalMailParcelServices, listRoyalMailShippingAccounts,
  RoyalMailError, royalMailTrackingV2Number, type RoyalMailTrackingCredentials,
} from "./royalMail";
import type { loadRoyalMailConnections } from "./royalMailAppSettings";
import { royalMailPostcode } from "./royalMailDestination";
import { bookingAccountScope, bookingConnection } from "./royalMailRecovery";
import { royalMailOrderChanged } from "./wholesaleRoyalMail";

const titles = {
  authentication: "Click & Drop connection", shippingAccount: "Shipping account",
  service: "Service for a sample parcel", labelPdf: "Postage label PDF", tracking: "Tracking API",
};
type CheckId = keyof typeof titles;
export interface ProviderCheck {
  id: CheckId;
  status: "passed" | "attention" | "unverified";
  title: string;
  detail: string;
}
type Connections = Awaited<ReturnType<typeof loadRoyalMailConnections>>;
type Parcel = { postcode: string; weightGrams: number };
type Shipment = {
  order_id: string; provider_id: number; tracking_number: string | null; destination_postcode: string | null;
  weight_grams: number; packing_basis: string | null; order_version: number; shipping_fingerprint: string | null; data: string; version: number;
};

function check(id: CheckId, status: ProviderCheck["status"], detail: string): ProviderCheck {
  return { id, title: titles[id], status, detail };
}

function providerFailure(id: CheckId, error: unknown): ProviderCheck {
  if (!(error instanceof RoyalMailError)) throw error;
  if (error.code === "royal_mail_auth" || error.code === "royal_mail_denied") {
    const detail = id === "labelPdf" && error.status === 403
      ? "Click & Drop refused this PDF. Confirm Online Business Account label access with Royal Mail."
      : id === "tracking" ? "Royal Mail rejected Tracking API access. Check the Tracking API credentials and approval."
      : "Click & Drop refused the request. Check the saved API key and its permissions.";
    return check(id, "attention", detail);
  }
  if (error.code === "royal_mail_order_mismatch") return check(id, "unverified", "The returned order does not match the saved wholesale booking. Review the original shipment in Click & Drop.");
  if (error.code === "royal_mail_rate_limited") return check(id, "unverified", "Royal Mail reached its request limit. Run the check again later.");
  if (error.code === "royal_mail_invalid_response") return check(id, "unverified", "Royal Mail returned an unexpected response. Run the check again later.");
  if (error.code === "royal_mail_label_unavailable") return check(id, "unverified", "The existing shipment’s label is unavailable. Check it in Click & Drop.");
  if (error.code === "royal_mail_rejected") return check(id, "attention", "Royal Mail rejected the details for this check. Review the setup in Click & Drop.");
  return check(id, "unverified", "Royal Mail could not complete this check. Try again later.");
}

function validatedParcel(postcode: unknown, grams: number): Parcel | null {
  if (!Number.isSafeInteger(grams) || grams < 1 || grams > 30_000) return null;
  try { return { postcode: royalMailPostcode(postcode), weightGrams: grams }; }
  catch { return null; }
}

async function sampleShipment(env: Env, key: string, accountName: string, singleAccount: boolean): Promise<Shipment | null> {
  const { results } = await env.DB.prepare(`SELECT s.order_id, s.provider_id, s.tracking_number, s.destination_postcode,
    s.weight_grams, json_extract(p.contents,'$.basis') AS packing_basis, s.order_version, s.shipping_fingerprint, o.data, o.version
    FROM wholesale_royal_mail_shipments s ${shipmentOrderJoin}
    WHERE ${belongsToOrder} AND ${matchesPlannedBox} AND s.booking_connection = ? AND s.provider_id > 0 AND s.review_required = 0 AND s.state IN ('labelled', 'dispatched')
      AND (s.booking_account_scope = ? OR (? = 1 AND s.booking_account_scope IS NULL))
      AND json_type(o.data, '$.preview') = 'false' AND json_extract(o.data, '$.deletedAt') IS NULL
      AND json_extract(o.data, '$.status') IN ('Ready', 'Dispatched')
      AND lower(trim(json_extract(o.data, '$.delivery'))) IN ('courier','delivery')
    ORDER BY s.tracking_number IS NULL, s.updated_at DESC, s.order_id LIMIT 12`).bind(await bookingConnection(key), await bookingAccountScope(key, accountName), Number(singleAccount)).all<Shipment>();
  let fallback: Shipment | null = null;
  for (const row of results) {
    if (!/^WS-[A-F0-9]{32}(?:-B(?:[1-9]|[1-4]\d|50))?$/.test(row.order_id) || !Number.isSafeInteger(row.provider_id)) continue;
    const order = { ...JSON.parse(row.data), version: row.version };
    if ((row.order_id.length > 35 && row.packing_basis !== packingBasis(order)) || await royalMailOrderChanged(row, order)) continue;
    if (royalMailTrackingV2Number(row.tracking_number)) return row;
    fallback ??= row;
  }
  return fallback;
}

async function parcelService(key: string, account: string, service: string, parcel: Parcel, fetcher: typeof fetch) {
  // The configured service and validated test weight are safe to retain. Only keep the postal district.
  const scope = `${service} · ${parcel.weightGrams.toLocaleString("en-GB")} g parcel · ${parcel.postcode.split(" ")[0]} district.`;
  try {
    const { matches } = await listRoyalMailParcelServices(key, service, account, parcel.postcode, parcel.weightGrams, fetcher);
    if (matches === 1) return check("service", "passed", scope + " Click & Drop lists the service for this shipping account and parcel.");
    if (!matches) return check("service", "attention", scope + " Click & Drop did not list the service for this parcel. Check the contract or try another parcel.");
    return check("service", "unverified", scope + " Click & Drop listed multiple matches. Confirm the correct service and register with Royal Mail.");
  } catch (error) {
    const failure = providerFailure("service", error);
    return { ...failure, detail: scope + " " + failure.detail };
  }
}

async function existingLabel(key: string, id: number, fetcher: typeof fetch) {
  try {
    await fetchRoyalMailLabel(key, id, fetcher);
    return check("labelPdf", "passed", "Click & Drop returned a valid postage label PDF for an existing wholesale shipment on this connection.");
  } catch (error) { return providerFailure("labelPdf", error); }
}

async function existingTracking(credentials: RoyalMailTrackingCredentials, reference: string, fetcher: typeof fetch) {
  try {
    const [record] = await fetchRoyalMailTracking(credentials, [reference], fetcher);
    if (record.status === "not-found") return check("tracking", "unverified", "Royal Mail has no tracking scan for the linked reference yet. Check again after handover.");
    if (!record.lastEventName && !record.lastEventAt && !record.lastEventCode) {
      return check("tracking", "passed", "Tracking API accepted the linked shipment. It has not returned any scan details yet.");
    }
    return check("tracking", "passed", "Tracking API access was confirmed with a carrier event for a linked wholesale shipment.");
  } catch (error) { return providerFailure("tracking", error); }
}

async function shipmentChecks(key: string, row: Shipment, credentials: Connections["tracking"], fetcher: typeof fetch, tracking: ProviderCheck) {
  let carrier;
  try { carrier = await findRoyalMailOrderById(key, row.provider_id, row.order_id, fetcher); }
  catch (error) {
    const failure = providerFailure("authentication", error);
    const detail = "The existing shipment could not be verified in Click & Drop. " + failure.detail;
    return [check("labelPdf", failure.status, detail), credentials ? check("tracking", "unverified", detail) : tracking];
  }
  if (!carrier || carrier.providerState === "created" ||
      row.tracking_number && row.tracking_number !== carrier.trackingNumber) {
    const detail = "Click & Drop could not confirm the same labelled shipment. Review the existing shipment and run the check again.";
    return [check("labelPdf", "unverified", detail), credentials ? check("tracking", "unverified", detail) : tracking];
  }
  const trackingNumber = royalMailTrackingV2Number(row.tracking_number);
  if (credentials && row.tracking_number && !trackingNumber) {
    tracking = check("tracking", "unverified", "Use public carrier tracking for this reference. To check in-app tracking, use a linked shipment with a supported Royal Mail barcode.");
  }
  return Promise.all([
    existingLabel(key, carrier.orderId, fetcher),
    credentials && trackingNumber ? existingTracking(credentials, trackingNumber, fetcher) : tracking,
  ]);
}

/** Read-only setup evidence. Only follow an existing shipment linked to this Click & Drop credential. */
export async function runRoyalMailProviderChecks(env: Env, { booking, tracking }: Connections, sample: Parcel | null = null, fetcher = fetch): Promise<ProviderCheck[]> {
  let auth = check("authentication", "attention", "Save a valid Click & Drop API key to check the connection.");
  let account = check("shippingAccount", "unverified", "Connect to Click & Drop to check the shipping accounts.");
  let service = booking.serviceCode ? check("service", "unverified", "Confirm a shipping account and supply a sample parcel to check its service.")
    : check("service", "attention", "Save a valid booking service code in Royal Mail credentials.");
  let label = check("labelPdf", "unverified", "Once the first wholesale label is generated, run these checks again to verify PDF access.");
  let track = tracking ? check("tracking", "unverified", "A verified wholesale shipment with a linked tracking reference is needed to test Tracking API access.")
    : check("tracking", "unverified", "Tracking API access is optional for booking postage. Configure it for carrier scan updates.");
  const key = booking.key;
  if (!key) return [auth, account, service, label, track];
  let names;
  try { names = await listRoyalMailShippingAccounts(key, fetcher); }
  catch (error) { return [providerFailure("authentication", error), account, service, label, track]; }
  auth = check("authentication", "passed", "Click & Drop accepted the saved API key.");
  const name = booking.shippingAccountName ?? (names.length === 1 ? names[0] : undefined);
  if (!name || names.filter(item => item === name).length !== 1) {
    const detail = !names.length ? "Click & Drop returned no shipping accounts. Check the account setup with Royal Mail."
      : booking.shippingAccountName ? "The saved name does not identify exactly one account. Copy the exact shipping account name from Click & Drop."
      : "Click & Drop has several shipping accounts. Save the exact name of the account used for wholesale bookings.";
    return [auth, check("shippingAccount", "attention", detail), service, label, track];
  }
  account = check("shippingAccount", "passed", booking.shippingAccountName
    ? "The saved shipping account name matches exactly one account in Click & Drop."
    : "Click & Drop has one shipping account. The optional account name can stay blank.");
  const shipment = await sampleShipment(env, key, name, names.length === 1);
  if (!shipment && names.length > 1) {
    label = check("labelPdf", "unverified", "A confirmed wholesale label booked under this exact shipping account is needed to test PDF access.");
    if (tracking) track = check("tracking", "unverified", "A tracked wholesale shipment booked under this exact shipping account is needed to test Tracking API access.");
  }
  const parcel = sample ? validatedParcel(sample.postcode, sample.weightGrams) : shipment && validatedParcel(shipment.destination_postcode, shipment.weight_grams);
  if (booking.serviceCode && !parcel) service = check("service", "unverified", "Enter a Great Britain postcode and packed weight to check the saved service for a parcel.");
  const [serviceCheck, shipmentResult] = await Promise.all([
    booking.serviceCode && parcel ? parcelService(key, name, booking.serviceCode, parcel, fetcher) : service,
    shipment ? shipmentChecks(key, shipment, tracking, fetcher, track) : [label, track],
  ]);
  [label, track] = shipmentResult;
  return [auth, account, serviceCheck, label, track];
}
