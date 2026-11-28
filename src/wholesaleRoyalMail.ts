import { audit } from "./audit";
import { isWholesaleDelivery } from "../public/wholesale/shipping.js";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { checkRoyalMailParcelService, createRoyalMailOrder, fetchRoyalMailLabel, fetchRoyalMailTracking, findRoyalMailOrder, findRoyalMailOrderById, RoyalMailError, royalMailTrackingNumber, royalMailTrackingV2Number } from "./royalMail";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "./royalMailAppSettings";
import { bookingAccountScope, bookingConnection, bookingRecovery, checkUnconfirmedBooking, LEGACY_REFERENCE_HOLD, REFERENCE_REFUSAL, REFRESH_INTERVAL } from "./royalMailRecovery";
import { requireStaffOrders } from "./staffOrdersAccess";
import { staffLabelEligibility, staffLabelEligibilityGuard } from "./wholesale/staffLabelEligibility";
import type { User } from "./auth";
import { get, object, version, type Versioned } from "./wholesaleStore";
import { checkedRoyalMailRecipient, royalMailAddressBook, royalMailPostcode, royalMailRecipientDraft, savedRoyalMailRecipient } from "./royalMailDestination";
export { savedRoyalMailRecipient } from "./royalMailDestination";
import type { CustomerLocation } from "./wholesaleCustomers";

interface Order {
  preview?: boolean;
  customerId?: string | null;
  deletedAt?: number;
  skipped?: unknown;
  status: string;
  delivery: string;
  business: string;
  createdAt: number;
  grams: number;
  pence: number;
  deliveryPence?: number;
  totalPence?: number;
  locationId?: string;
  locationSnapshot?: CustomerLocation;
  customerSnapshot?: Pick<CustomerLocation, "address" | "postcode" | "contact"> & { email?: string };
  lines?: Array<{ productId: string; pack: string; grind?: string; quantity: number; grams: number }>;
}

interface Shipment {
  state: "booking" | "review" | "created" | "labelled" | "dispatched" | "failed";
  operation: string;
  order_version: number;
  provider_id: number | null;
  tracking_number: string | null;
  carrier_status: string | null;
  carrier_event_at: string | null;
  label_downloaded_at: number | null;
  weight_grams: number;
  updated_at: number;
  shipping_fingerprint: string | null;
  review_required: number;
  problem: string | null;
  requested_at: number | null;
  checked_at: number | null;
  recovery_due_at: number | null;
  recovery_attempts: number;
  destination_address: string | null;
  destination_postcode: string | null;
}

type ShippingOrder = Order & Versioned;
export type ShippingGuard = { sql: string; args: (string | number | null)[] };
const BOOKING_ALLOWED = "EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id = 1 AND enabled = 1 AND version = ?)";
export const ROYAL_MAIL_ORDER_ROUTE = /^orders\/(WS-[A-F0-9]{32})\/shipping(?:\/(label|refresh|verify|location|service-check|reference-check))?$/;

function checkedPackedWeight(value: unknown, coffeeGrams: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(coffeeGrams) || value < Math.max(1, coffeeGrams) || value > 30_000) {
    throw invalid("Enter the packed weight in grams. It must cover all the coffee and be at most 30 kg for one parcel.");
  }
  return value;
}

function checkBookingPolicy(current: { enabled: number; version: number }, reviewedVersion = current.version) {
  if (!current.enabled) {
    throw new ApiError(409, "royal_mail_booking_paused", "New Royal Mail bookings are off. An admin can turn them on in Wholesale → Royal Mail.");
  }
  if (current.version !== reviewedVersion) {
    throw new ApiError(409, "royal_mail_booking_policy_changed", "Royal Mail setup changed. Review the parcel and request the label again.");
  }
}

const savedAddressWarning = "The saved delivery address needs review. Ask an admin to check the destination.";

function eligibleOrder(order: Order | null): order is Order {
  return !!order && order.deletedAt == null && order.preview === false && !!order.customerId && isWholesaleDelivery(order.delivery);
}

function canUseShipment(order: Order) {
  return eligibleOrder(order) && !order.skipped && ["Ready", "Dispatched"].includes(order.status);
}

function labelReady(row: Shipment) {
  return row.state === "labelled" || row.state === "dispatched";
}

export async function shippingFingerprint(order: Pick<Order, "locationSnapshot" | "customerSnapshot" | "business" | "customerId" | "locationId" | "delivery" | "lines" | "grams">) {
  const location = order.locationSnapshot;
  const customer = order.customerSnapshot;
  const contents = (order.lines ?? []).map(line => JSON.stringify([line.productId, line.pack, line.grind, line.quantity, line.grams])).sort();
  const details = JSON.stringify([order.customerId, order.locationId, order.business, order.delivery,
    location?.address ?? customer?.address, location?.postcode ?? customer?.postcode,
    location?.contact ?? customer?.contact, order.grams, contents]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(details));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export async function royalMailOrderChanged(row: Pick<Shipment, "shipping_fingerprint" | "order_version">, order: ShippingOrder) {
  if (!canUseShipment(order)) return true;
  return row.shipping_fingerprint ? await shippingFingerprint(order) !== row.shipping_fingerprint : row.order_version !== order.version;
}

const { royalMailTrackingUrl: trackingLink, numberFromRoyalMailLink, isRoyalMailTrackingHost } = globalThis.SCWholesalePreparation;

function referenceLookupFailure(row: Shipment | null) {
  if (row?.state !== "failed" || row.provider_id !== null ||
      !row.problem?.startsWith(REFERENCE_REFUSAL)) return null;
  if (row.requested_at === 0) return "before_postage";
  return row.requested_at === null ? "unconfirmed" : null;
}

async function shipmentView(row: Shipment | null, order: ShippingOrder) {
  if (!row) return null;
  const changed = await royalMailOrderChanged(row, order);
  const reviewRequired = !!row.review_required;
  return {
    state: row.state,
    orderId: row.provider_id,
    trackingNumber: row.tracking_number,
    trackingUrl: !changed && !reviewRequired && labelReady(row) ? trackingLink(row.tracking_number) : null,
    carrierStatus: row.carrier_status,
    carrierEventAt: row.carrier_event_at,
    weightGrams: row.weight_grams,
    updatedAt: row.updated_at,
    labelDownloadedAt: row.label_downloaded_at,
    requestedAt: row.requested_at || null,
    // Older failures have the carrier message but no durable outbound-request marker.
    referenceLookupFailure: referenceLookupFailure(row),
    checkedAt: row.checked_at,
    recovery: bookingRecovery(row),
    orderChanged: changed,
    reviewRequired,
    destination: row.requested_at && row.destination_address && row.destination_postcode
      ? { address: row.destination_address, postcode: row.destination_postcode } : null,
    problem: row.problem,
  };
}

async function getShipment(env: Env, id: string) {
  return env.DB.prepare(`SELECT state, operation, order_version, provider_id, tracking_number, carrier_status, carrier_event_at,
    label_downloaded_at, weight_grams, updated_at, shipping_fingerprint, review_required, problem, requested_at, checked_at,
    recovery_due_at, recovery_attempts, destination_address, destination_postcode
    FROM wholesale_royal_mail_shipments WHERE order_id = ?`).bind(id).first<Shipment>();
}

function handoverReview() {
  return new ApiError(409, "royal_mail_handover_review", "Review the Royal Mail shipment before dispatching. If you used a different courier, enter its tracking link.");
}

function isRoyalMailLink(link: string) {
  try { return isRoyalMailTrackingHost(new URL(link).hostname); }
  catch { return false; }
}

export async function requireStaffLabelEligibility(env: Env, order: ShippingOrder) {
  const eligibility = await staffLabelEligibility(env, order);
  if (!eligibility.eligible) throw new ApiError(409, eligibility.code, eligibility.message);
}

/** Resolve the local label at handover and guard the order and email writes against racing shipment changes. */
export async function resolveWholesaleHandover(env: Env, order: ShippingOrder, link: string, staff = false, fromQueue = false) {
  const row = await getShipment(env, order.id);
  const royalMailLink = isRoyalMailLink(link);
  if (fromQueue && (!row?.label_downloaded_at || !row.provider_id || (link && !royalMailLink))) throw handoverReview();
  const staffRoyalMail = fromQueue || staff && (royalMailLink || (!link && !!row && row.state !== "failed"));
  if (staffRoyalMail) await requireStaffLabelEligibility(env, order);
  const combine = (shipment: ShippingGuard): ShippingGuard => {
    if (!staffRoyalMail) return shipment;
    const eligibility = staffLabelEligibilityGuard(order);
    return { sql: shipment.sql + eligibility.sql, args: [...shipment.args, ...eligibility.args] };
  };
  const exclude = (condition: string): ShippingGuard => ({
    sql: ` AND NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id = ? AND ${condition})`,
    args: [order.id],
  });
  if (link && !royalMailLink) {
    if (row?.state === "booking") throw handoverReview();
    return { trackingUrl: link, guard: exclude("state = 'booking'") };
  }
  if (referenceLookupFailure(row) === "unconfirmed") throw handoverReview();
  if (!row || row.state === "failed") {
    return { trackingUrl: trackingLink(numberFromRoyalMailLink(link)) || link, guard: combine(exclude(`(state <> 'failed' OR ${LEGACY_REFERENCE_HOLD})`)), staffRoyalMail };
  }
  if (!row.provider_id || !labelReady(row) || row.review_required || await royalMailOrderChanged(row, order)) throw handoverReview();
  const canonical = trackingLink(row.tracking_number);
  if (link && (!canonical || numberFromRoyalMailLink(link) !== row.tracking_number)) throw handoverReview();
  const guard: ShippingGuard = {
    sql: ` AND EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id = ? AND operation = ?
      AND provider_id = ? AND tracking_number IS ? AND review_required = 0 AND state IN ('labelled','dispatched')
      ${fromQueue ? "AND label_downloaded_at IS NOT NULL" : ""})`,
    args: [order.id, row.operation, row.provider_id, row.tracking_number],
  };
  const destination = row.requested_at && row.destination_address && row.destination_postcode
    ? { address: row.destination_address, postcode: row.destination_postcode } : undefined;
  return { trackingUrl: canonical || "", guard: combine(guard), destination, staffRoyalMail };
}

/** Only use an existing link when the current Click & Drop account confirms both identifiers. */
async function findLinkedShipment(env: Env, key: string, id: string, shipment: Shipment) {
  if (!shipment.provider_id) throw handoverReview();
  let carrier;
  try {
    carrier = await findRoyalMailOrderById(key, shipment.provider_id, id);
  } catch (error) {
    if (!(error instanceof RoyalMailError) || error.code !== "royal_mail_order_mismatch") throw error;
  }
  if (carrier) return carrier;
  await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET review_required = 1, updated_at = ?
    WHERE order_id = ? AND operation = ? AND provider_id = ?`).bind(Date.now(), id, shipment.operation, shipment.provider_id).run();
  return null;
}

async function recordCarrier(env: Env, id: string, operation: string,
  carrier: Awaited<ReturnType<typeof createRoyalMailOrder>>, requireReview = false, replaceTracking = false, accountScope: string | null = null) {
  const result = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = CASE
    WHEN state = 'dispatched' OR (state = 'labelled' AND ? = 'created') THEN state ELSE ? END, provider_id = ?, candidate_provider_id = NULL,
    label_downloaded_at = CASE WHEN ? IS NOT NULL AND tracking_number IS NOT ? THEN NULL ELSE label_downloaded_at END,
    carrier_status = CASE WHEN ? IS NOT NULL AND tracking_number IS NOT ? THEN NULL ELSE carrier_status END,
    carrier_event_at = CASE WHEN ? IS NOT NULL AND tracking_number IS NOT ? THEN NULL ELSE carrier_event_at END,
    review_required = MAX(review_required, ?),
    problem = CASE WHEN ? = 'created' AND state NOT IN ('labelled','dispatched')
      THEN COALESCE(?, CASE WHEN state = 'created' THEN problem END) END, recovery_due_at = NULL,
    booking_account_scope = COALESCE(?,booking_account_scope), tracking_number = COALESCE(?,tracking_number), updated_at = ? WHERE order_id = ? AND operation = ?
    AND (provider_id IS NULL OR provider_id = ?)
    AND (tracking_number IS NULL OR tracking_number = ? OR ? = 1)`)
    .bind(carrier.providerState, carrier.providerState, carrier.orderId,
      carrier.trackingNumber, carrier.trackingNumber,
      carrier.trackingNumber, carrier.trackingNumber, carrier.trackingNumber, carrier.trackingNumber,
      Number(requireReview), carrier.providerState, carrier.labelProblem ?? null, accountScope, carrier.trackingNumber, Date.now(), id, operation, carrier.orderId,
      carrier.trackingNumber, Number(replaceTracking)).run();
  if (result.meta.changes) return true;
  await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET review_required = 1, updated_at = ?
    WHERE order_id = ? AND operation = ? AND
    (provider_id <> ? OR (tracking_number IS NOT NULL AND tracking_number IS NOT ?))`)
    .bind(Date.now(), id, operation, carrier.orderId, carrier.trackingNumber).run();
  return false;
}

export async function handleWholesaleRoyalMail(req: Request, env: Env, id: string, action: string | undefined, actor: User, entry: "admin" | "staff" = "admin"): Promise<Response> {
  const staff = entry === "staff";
  const checkStaffAccess = async () => {
    if (staff) await requireStaffOrders(env, actor);
  };
  const checkEligibility = async (current: ShippingOrder) => {
    if (staff) await requireStaffLabelEligibility(env, current);
  };
  const checkStaffLabel = async (current: ShippingOrder) => {
    await checkStaffAccess();
    await checkEligibility(current);
  };
  await checkStaffAccess();
  if (action === "verify" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Verify Royal Mail shipments from the Admin wholesale dashboard.");
  }
  if (action === "service-check" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Check the configured parcel service from Admin.");
  }
  if (action === "reference-check" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Check a refused order reference from Admin.");
  }
  const order = await get<Order>(env, "order", id);
  if (!eligibleOrder(order)) {
    throw new ApiError(404, "not_found", "Royal Mail shipping is available on wholesale delivery orders.");
  }
  if (action === "location") {
    if (staff || actor.role !== "admin") throw new ApiError(403, "permission_denied", "Only Admin can change a saved delivery location.");
    return royalMailAddressBook(req, env, order, actor.name);
  }
  const policy = await readRoyalMailPolicy(env);
  const connections = await loadRoyalMailConnections(env, policy);
  const { booking: settings, tracking } = connections;
  if (action === "reference-check") {
    if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Submit the reference check from the order.");
    if (!settings.key) throw new ApiError(503, "royal_mail_not_configured", "Configure the Click & Drop key first.");
    const body = object(await readJson(req, 1024));
    const changed = () => new ApiError(409, "conflict", "The order or Royal Mail setup changed. Reopen the shipment to check its current status.");
    if (version(body.ifVersion) !== order.version || version(body.bookingVersion) !== policy.version) throw changed();
    const previous = await getShipment(env, id);
    const failure = referenceLookupFailure(previous);
    if (!failure || !previous) throw changed();
    // This diagnostic must never progress into the booking or recovery paths.
    let outcome: "found" | "missing" | "inconclusive", message: string;
    try {
      const match = await findRoyalMailOrder(settings.key, id);
      outcome = match ? "found" : "missing";
      message = match ? "Click & Drop found an existing booking. Compare its destination and parcel before using its label."
        : failure === "before_postage" ? "Click & Drop found no booking for this reference. You can review the parcel and request a label."
        : "Click & Drop found no booking for this reference. The earlier postage request is unconfirmed. Check it in Click & Drop before requesting another label.";
    } catch (error) {
      outcome = "inconclusive";
      message = error instanceof RoyalMailError ? error.message : "The reference check could not be completed. Check the order in Click & Drop.";
    }
    const [latestOrder, latestShipment, latestPolicy] = await Promise.all([
      get<Order>(env, "order", id), getShipment(env, id), readRoyalMailPolicy(env),
    ]);
    if (!eligibleOrder(latestOrder) || latestOrder.version !== order.version || latestPolicy.version !== policy.version ||
        latestShipment?.operation !== previous.operation || referenceLookupFailure(latestShipment) !== failure) throw changed();
    return json({ outcome, message });
  }
  if (action === "service-check") {
    if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Send the parcel details for the service check.");
    if (!settings.key || !settings.serviceCode) throw new ApiError(503, "royal_mail_not_configured", "Configure the Click & Drop key and service first.");
    const body = object(await readJson(req, 2048));
    const ifVersion = version(body.ifVersion), bookingVersion = version(body.bookingVersion);
    const changed = () => new ApiError(409, "conflict", "The order or Royal Mail settings changed. Reopen the parcel and check again.");
    if (ifVersion !== order.version || bookingVersion !== policy.version) throw changed();
    const result = await checkRoyalMailParcelService(settings.key, { serviceCode: settings.serviceCode,
      serviceRegisterCode: settings.serviceRegisterCode, shippingAccountName: settings.shippingAccountName },
      royalMailPostcode(body.postcode), checkedPackedWeight(body.weightGrams, order.grams));
    const [latest, current] = await Promise.all([get<Order>(env, "order", id), readRoyalMailPolicy(env)]);
    if (!latest || latest.version !== ifVersion || current.version !== bookingVersion) throw changed();
    return json(result);
  }
  const getView = async (status = 200, trackingWarning?: string) => {
    const [latest, shipment, latestPolicy] = await Promise.all([get<Order>(env, "order", id), getShipment(env, id), readRoyalMailPolicy(env)]);
    if (!eligibleOrder(latest)) throw new ApiError(404, "not_found", "This order is no longer available.");
    const current = latestPolicy.version === policy.version ? connections : await loadRoyalMailConnections(env, latestPolicy);
    const eligibility = staff ? await staffLabelEligibility(env, latest) : null;
    const recipient = savedRoyalMailRecipient(latest);
    const view = await shipmentView(shipment, latest);
    if (staff && view && (view.reviewRequired || view.orderChanged || (!eligibility?.eligible && latest.status === "Ready"))) {
      view.trackingNumber = null;
      view.trackingUrl = null;
    }
    return json({ enabled: !!current.booking.key,
      bookingEnabled: latestPolicy.enabled === 1,
      bookingConfigured: current.bookingConfigured,
      canCreate: current.bookingConfigured && latestPolicy.enabled === 1 &&
        (staff ? !!recipient && eligibility?.eligible === true : actor.role === "admin") &&
        latest.status === "Ready" && !latest.skipped && (!shipment || shipment.state === "failed" && !shipment.provider_id && view?.referenceLookupFailure !== "unconfirmed"),
      orderVersion: latest.version, shipment: view, trackingEnabled: !!current.tracking,
      recipient, bookingService: current.booking.serviceCode, bookingVersion: latestPolicy.version,
      ...(!staff && !recipient ? { recipientDraft: royalMailRecipientDraft(latest) } : {}),
      ...(staff ? {
        eligibility,
        ...(!recipient ? { recipientWarning: savedAddressWarning } : {}),
        canDownloadLabel: !!current.booking.key && !!shipment?.provider_id && labelReady(shipment) &&
          !view?.orderChanged && !view?.reviewRequired && eligibility?.eligible === true,
      } : {}),
      ...(trackingWarning ? { trackingWarning } : {}),
    }, status);
  };
  if (!action && req.method === "GET") return getView();
  if (req.method !== (action === "label" ? "GET" : "POST")) {
    throw new ApiError(405, "method_not_allowed", "This shipping action is unavailable.");
  }
  if (!settings.key) throw new ApiError(503, "royal_mail_not_configured", "Configure a valid Royal Mail Click & Drop key.");

  if (!action && !staff && actor.role !== "admin") throw new ApiError(403, "permission_denied", "An admin must create Royal Mail shipments.");
  const existing = await getShipment(env, id);
  if ((!action || action === "refresh") && existing && referenceLookupFailure(existing) === "unconfirmed") {
    await checkStaffAccess();
    const warning = await checkUnconfirmedBooking(env, id, existing.operation, settings.key, false);
    return getView(200, warning);
  }
  if (action === "label") {
    const previewValues = new URL(req.url).searchParams.getAll("preview");
    const preview = previewValues.length > 0;
    if (preview && (staff || actor.role !== "admin")) throw new ApiError(403, "permission_denied", "Preview shipping labels from Admin.");
    if (preview && (previewValues.length !== 1 || previewValues[0] !== "1")) throw invalid("Choose a valid label preview.");
    if (!existing?.provider_id || !labelReady(existing)) {
      throw new ApiError(409, "label_pending", "Complete the label in Click & Drop, then check the shipment before downloading it.");
    }
    const review = () => new ApiError(409, "label_needs_review", "Check the label in Click & Drop before using it for this order.");
    if (existing.review_required || await royalMailOrderChanged(existing, order)) throw review();
    if (staff) await checkStaffLabel(order);
    let pdf: Uint8Array;
    try {
      // Verify the pinned identifier in the active account before requesting private label bytes.
      const carrier = await findLinkedShipment(env, settings.key, id, existing);
      if (!carrier) throw review();
      if (existing.tracking_number && carrier.trackingNumber !== existing.tracking_number) {
        await env.DB.prepare("UPDATE wholesale_royal_mail_shipments SET review_required = 1 WHERE order_id = ? AND operation = ?")
          .bind(id, existing.operation).run();
        throw review();
      }
      if (staff) await checkStaffLabel(order);
      pdf = await fetchRoyalMailLabel(settings.key, existing.provider_id);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "label_unavailable", "The label is not available. Check its status in Royal Mail Click & Drop.");
    }
    const [latest, shipment] = await Promise.all([get<Order>(env, "order", id), getShipment(env, id)]);
    if (!latest || !shipment || shipment.operation !== existing.operation || shipment.provider_id !== existing.provider_id ||
        shipment.tracking_number !== existing.tracking_number || !labelReady(shipment) || shipment.review_required || await royalMailOrderChanged(shipment, latest)) {
      throw review();
    }
    if (staff) await checkStaffLabel(latest);
    const eligible = staff ? staffLabelEligibilityGuard(latest) : { sql: "", args: [] };
    const access = staff && actor.role !== "admin" ? {
      sql: " AND EXISTS (SELECT 1 FROM staff_order_access WHERE user_id=? AND enabled=1)", args: [actor.id],
    } : { sql: "", args: [] };
    const guard = `WHERE order_id=? AND operation=? AND provider_id=? AND tracking_number IS ? AND review_required=0
        AND state IN ('labelled','dispatched') AND EXISTS (
          SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)${eligible.sql}${access.sql}`;
    const args = [id, shipment.operation, shipment.provider_id, shipment.tracking_number, id, latest.version, ...eligible.args, ...access.args];
    // Opening the preview must not advance the parcel to Awaiting handover. Check the
    // same release conditions in its last database read as a download does in its write.
    const valid = preview
      ? await env.DB.prepare(`SELECT 1 FROM wholesale_royal_mail_shipments ${guard}`).bind(...args).first()
      : (await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET label_downloaded_at=COALESCE(label_downloaded_at,?) ${guard}`)
          .bind(Date.now(), ...args).run()).meta.changes;
    if (!valid) {
      if (staff) await checkStaffLabel(latest);
      throw review();
    }
    return new Response(pdf, { headers: { "content-type": "application/pdf", "cache-control": "no-store",
      "content-disposition": `${preview ? "inline" : "attachment"}; filename="Royal-Mail-${id}.pdf"` } });
  }
  if (action === "verify") {
    const body = object(await readJson(req, 1024));
    if (version(body.ifVersion) !== order.version) throw new ApiError(409, "conflict", "Review the latest order before verifying the shipment.");
    const number = royalMailTrackingNumber(body.trackingNumber);
    if (body.confirmed !== true || !number) throw invalid("Confirm the label details and enter its Royal Mail tracking number.");
    if (!existing?.review_required || !existing.provider_id || await royalMailOrderChanged(existing, order)) throw handoverReview();
    let carrier: Awaited<ReturnType<typeof findLinkedShipment>>;
    try { carrier = await findLinkedShipment(env, settings.key, id, existing); }
    catch { throw new ApiError(503, "royal_mail_unavailable", "Royal Mail could not verify the shipment. Try again shortly."); }
    if (!carrier || carrier.trackingNumber !== number ||
        carrier.providerState === "created" && (!labelReady(existing) || number !== existing.tracking_number)) throw handoverReview();
    if (!await recordCarrier(env, id, existing.operation, carrier, false, true)) throw handoverReview();
    const checkedAt = Date.now();
    const verified = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET review_required = 0, checked_at = ?, updated_at = ?
      WHERE order_id = ? AND operation = ? AND provider_id = ? AND tracking_number = ? AND review_required = 1
      AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind = 'order' AND id = ? AND version = ?)`)
      .bind(checkedAt, checkedAt, id, existing.operation, existing.provider_id, number, id, order.version).run();
    if (!verified.meta.changes) throw handoverReview();
    await audit(env, "wholesale_royal_mail", actor.name, `Royal Mail shipment verified for ${id}.`);
    return getView();
  }
  if (action === "refresh") {
    if (!existing || existing.state === "failed") return getView();
    if (!existing.provider_id && (existing.state === "booking" || existing.state === "review")) {
      await checkStaffAccess();
      const warning = await checkUnconfirmedBooking(env, id, existing.operation, settings.key, false);
      return getView(200, warning);
    }
    const now = Date.now();
    const claimed = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = ?
      WHERE order_id = ? AND operation = ? AND state <> 'failed' AND provider_id IS NOT NULL AND COALESCE(refresh_after, 0) <= ?`)
      .bind(now + REFRESH_INTERVAL, id, existing.operation, now).run();
    if (!claimed.meta.changes) return getView();
    await checkStaffAccess();
    try {
      const carrier = await findLinkedShipment(env, settings.key, id, existing);
      const checkedAt = Date.now();
      await env.DB.prepare("UPDATE wholesale_royal_mail_shipments SET checked_at = ? WHERE order_id = ? AND operation = ?")
        .bind(checkedAt, id, existing.operation).run();
      if (carrier) {
        if (!await recordCarrier(env, id, existing.operation, carrier, existing.requested_at === 0)) {
          return getView(200, "Royal Mail returned different shipment details. Check the label in Click & Drop.");
        }
      } else {
        return getView(200, "Royal Mail could not confirm the saved shipment. Check the original order in Click & Drop.");
      }
      const number = carrier.trackingNumber;
      let warning: string | undefined;
      if (tracking && number && royalMailTrackingV2Number(number)) {
        try {
          const [snapshot] = await fetchRoyalMailTracking(tracking, [number]);
          if (snapshot?.status === "available" && (snapshot.lastEventName || snapshot.statusCategory)) {
            const since = snapshot.lastEventAt;
            const time = since && Number.isFinite(Date.parse(since)) ? new Date(since).toISOString() : null;
            const description = snapshot.lastEventName || snapshot.statusCategory;
            await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET carrier_status = ?, carrier_event_at = ?
              WHERE order_id = ? AND operation = ? AND tracking_number = ?
              AND (carrier_event_at IS NULL OR (? IS NOT NULL AND carrier_event_at <= ?))`)
              .bind(description, time, id, existing.operation, number, time, time).run();
          } else if (snapshot?.status === "not-found") {
            warning = "Royal Mail does not recognise the tracking number yet. Check again after the first parcel scan.";
          }
        } catch {
          warning = "Royal Mail carrier scans could not be refreshed. Try again shortly.";
        }
      }
      return getView(200, warning);
    } catch {
      throw new ApiError(503, "royal_mail_unavailable", "Royal Mail did not return an update. Try again shortly.");
    }
  }

  if (existing && (existing.provider_id || existing.state !== "failed")) return getView(existing.provider_id ? 200 : 202);
  const { key, serviceCode, serviceRegisterCode, shippingAccountName } = settings;
  if (!serviceCode) throw new ApiError(503, "royal_mail_not_configured", "Configure the Royal Mail Click & Drop service before creating postage.");
  checkBookingPolicy(policy);
  if (order.status !== "Ready" || order.skipped) throw new ApiError(409, "order_not_ready", "Pack the order and mark it Ready before creating postage.");

  const body = object(await readJson(req, 4096));
  if (version(body.ifVersion) !== order.version) throw new ApiError(409, "conflict", "Review the latest order before creating postage.");
  if (staff) {
    if (Object.keys(body).some(key => !["ifVersion", "bookingVersion", "bookingService", "weightGrams"].includes(key))) {
      throw invalid("Use the saved address and configured Royal Mail service.");
    }
  }
  // Older Admin tabs predate the service preview. New reviews pin the displayed service and settings version.
  if (staff || body.bookingVersion !== undefined || body.bookingService !== undefined) {
    checkBookingPolicy(policy, version(body.bookingVersion));
    if (body.bookingService !== serviceCode) {
      throw new ApiError(409, "royal_mail_booking_policy_changed", "Royal Mail setup changed. Review the parcel and request the label again.");
    }
  }
  if (staff) await checkEligibility(order);
  const weight = checkedPackedWeight(body.weightGrams, order.grams);
  const recipient = staff ? savedRoyalMailRecipient(order) : checkedRoyalMailRecipient(object(body.recipient));
  if (!recipient) throw new ApiError(409, "royal_mail_address_review", savedAddressWarning);
  const address = { name: recipient.name, companyName: order.business.slice(0, 100), addressLine1: recipient.line1,
    addressLine2: recipient.line2, city: recipient.city, county: recipient.county, postcode: recipient.postcode,
    // The owner uses the business email saved with this order for carrier delivery updates.
    emailAddress: order.customerSnapshot?.email || undefined };

  const eligibilityGuard = staff ? staffLabelEligibilityGuard(order) : { sql: "", args: [] };
  const accessGuard = staff && actor.role !== "admin"
    ? { sql: " AND EXISTS (SELECT 1 FROM staff_order_access WHERE user_id = ? AND enabled = 1)", args: [actor.id] }
    : { sql: "", args: [] };

  const operation = crypto.randomUUID();
  const fingerprint = await shippingFingerprint(order);
  const connection = await bookingConnection(key);
  const reserved = await env.DB.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id, state, operation, order_version, shipping_fingerprint, weight_grams, updated_at, requested_at,
      destination_address, destination_postcode, booking_connection, label_order_created_at)
    SELECT ?, 'booking', ?, ?, ?, ?, ?, 0, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.status')='Ready'
    ) AND ${BOOKING_ALLOWED}${eligibilityGuard.sql}${accessGuard.sql} ON CONFLICT(order_id) DO UPDATE SET state=excluded.state, operation=excluded.operation,
      order_version=excluded.order_version, shipping_fingerprint=excluded.shipping_fingerprint,
      weight_grams=excluded.weight_grams, updated_at=excluded.updated_at, requested_at=0, checked_at=NULL, refresh_after=NULL, problem=NULL,
      recovery_attempts=0, recovery_due_at=NULL, label_downloaded_at=NULL, candidate_provider_id=NULL, booking_connection=excluded.booking_connection, booking_account_scope=NULL,
      service_code=NULL, label_order_created_at=excluded.label_order_created_at,
      destination_address=excluded.destination_address, destination_postcode=excluded.destination_postcode
    WHERE wholesale_royal_mail_shipments.state = 'failed' AND provider_id IS NULL AND candidate_provider_id IS NULL AND NOT ${LEGACY_REFERENCE_HOLD} RETURNING operation`)
    .bind(id, operation, order.version, fingerprint, weight, Date.now(),
      [address.addressLine1, address.addressLine2, address.city, address.county].filter(Boolean).join(", "), address.postcode, connection, order.createdAt || null,
      id, order.version, policy.version, ...eligibilityGuard.args, ...accessGuard.args).first();
  if (!reserved) {
    await checkStaffAccess();
    checkBookingPolicy(await readRoyalMailPolicy(env), policy.version);
    await checkEligibility(order);
    if (await getShipment(env, id)) return getView(202);
    throw new ApiError(409, "conflict", "The order changed. Review it before creating postage.");
  }

  let outcome: "lookup" | "requested" | "known" = "lookup";
  try {
    await checkStaffAccess();
    await checkEligibility(order);
    const prior = await findRoyalMailOrder(key, id);
    if (!prior) {
      // Commit the outbound marker before transmission. A process stopped before this point can release the reservation.
      const at = Date.now();
      const sending = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET requested_at = ?, updated_at = ?, service_code = ?
        WHERE order_id = ? AND operation = ? AND state = 'booking' AND requested_at = 0
        AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind = 'order' AND id = ? AND version = ?)
        AND ${BOOKING_ALLOWED}${eligibilityGuard.sql}${accessGuard.sql}`)
        .bind(at, at, serviceCode, id, operation, id, order.version, policy.version, ...eligibilityGuard.args, ...accessGuard.args).run();
      if (!sending.meta.changes) {
        await checkStaffAccess();
        checkBookingPolicy(await readRoyalMailPolicy(env), policy.version);
        await checkEligibility(order);
        throw new ApiError(409, "conflict", "The order changed while Royal Mail was checked. Review it before creating postage.");
      }
    }
    outcome = prior ? "known" : "requested";
    const carrier = prior ?? await createRoyalMailOrder(key, { reference: id, orderDate: new Date(order.createdAt).toISOString(),
      recipient: address, parcel: { weightInGrams: weight, format: "parcel" }, serviceCode, serviceRegisterCode, shippingAccountName,
      subtotalPence: order.pence, shippingPence: order.deliveryPence ?? 0, totalPence: order.totalPence ?? order.pence + (order.deliveryPence ?? 0),
    });
    outcome = "known";
    const latest = await get<Order>(env, "order", id);
    const latestChanged = !latest || !canUseShipment(latest) || await shippingFingerprint(latest) !== fingerprint;
    // Only a confirmed create with an explicitly named account proves which account owns this shipment.
    const accountScope = !prior && shippingAccountName ? await bookingAccountScope(key, shippingAccountName) : null;
    await recordCarrier(env, id, operation, carrier, !!prior || latestChanged, false, accountScope);
  } catch (error) {
    const state = outcome === "lookup" || (outcome === "requested" && error instanceof RoyalMailError && !error.uncertain) ? "failed" : "review";
    const settingsChanged = error instanceof ApiError && ["royal_mail_booking_paused", "royal_mail_booking_policy_changed"].includes(error.code);
    const problem = settingsChanged ? "The booking setting changed before postage was requested." :
      error instanceof RoyalMailError || error instanceof ApiError ? error.message : "Royal Mail could not be reached. Review the order and try again.";
    const candidate = outcome === "requested" && error instanceof RoyalMailError && error.uncertain ? error.candidateId ?? null : null;
    await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = ?, problem = ?, updated_at = ?,
      candidate_provider_id = COALESCE(candidate_provider_id, ?) WHERE order_id = ? AND operation = ? AND provider_id IS NULL
      AND (? IS NULL OR (requested_at > 0 AND booking_connection = ?))`)
      .bind(state, state === "failed" ? problem : null, Date.now(), candidate, id, operation, candidate, connection).run();
    if (error instanceof ApiError) throw error;
    return getView(state === "review" ? 202 : 200);
  }
  await audit(env, "wholesale_royal_mail", actor.name, `Royal Mail shipment recorded for ${id}.`);
  return getView(201);
}
