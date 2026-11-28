import { audit } from "./audit";
import { packingBasis, packingView } from "./royalMailBoxContents";
import { bookingPlanGuard, boxPlanConflict, changeRoyalMailBoxPlan, checkBoxReview, parcelValue, readRoyalMailBoxPlan, royalMailBoxes, shippingAccessGuard, type RoyalMailBoxPlan } from "./royalMailBoxes";
import { BILLING_REVISION_GUARD, prepareRoyalMailBooking } from "./royalMailBookingDetails";
import { isWholesaleDelivery } from "../public/wholesale/shipping.js";
import { ApiError, type Env, invalid, json, readJson, SQL_NOW_MS } from "./http";
import { checkRoyalMailParcelService, createRoyalMailOrder, fetchRoyalMailLabel, fetchRoyalMailTracking, findRoyalMailOrder, findRoyalMailOrderById, RoyalMailError, royalMailTrackingNumber, royalMailTrackingV2Number } from "./royalMail";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "./royalMailAppSettings";
import { bookingAccountScope, bookingConnection, bookingRecovery, checkUnconfirmedBooking, REFERENCE_REFUSAL, REFRESH_INTERVAL } from "./royalMailRecovery";
import { requireStaffOrders } from "./staffOrdersAccess";
import { canLinkRoyalMailOrder, linkRoyalMailOrder } from "./royalMailLinkOrder";
import { staffLabelEligibility, staffLabelEligibilityGuard } from "./wholesale/staffLabelEligibility";
import type { User } from "./auth";
import { canRequestRoyalMailPostage, DECLINED_POSTAGE, HELD_FAILED_SHIPMENT } from "./royalMailBookingState";
import { get, object, version, type Versioned } from "./wholesaleStore";
import { royalMailAddressBook, royalMailPostcode, royalMailRecipientDraft, savedRoyalMailRecipient } from "./royalMailDestination";
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
  lines?: Array<{ productId: string; title?: string; pack: string; packLabel?: string; grind?: string; grindLabel?: string; price?:number; quantity: number; grams: number }>;
}

interface Shipment {
  state: "booking" | "review" | "created" | "labelled" | "dispatched" | "failed";
  operation: string;
  candidate_provider_id: number | null;
  booking_connection: string | null;
  booking_account_scope: string | null;
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
  request_problem: string | null;
  requested_at: number | null;
  checked_at: number | null;
  recovery_due_at: number | null;
  recovery_attempts: number;
  destination_address: string | null;
  destination_postcode: string | null;
}

type ShippingOrder = Order & Versioned;
export type ShippingGuard = { sql: string; args: (string | number | null)[] };
interface HandoverResult {
  trackingUrl: string;
  guard: ShippingGuard;
  staffRoyalMail?: boolean;
  destination?: { address: string; postcode: string };
  deliveryParcels?: Array<{ number: number; count: number; trackingNumber: string | null; trackingUrl: string | null }>;
}
const BOOKING_ALLOWED = "EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id = 1 AND enabled = 1 AND version = ?)";
export const ROYAL_MAIL_ORDER_ROUTE = /^orders\/(WS-[A-F0-9]{32})\/shipping(?:\/(label|refresh|verify|location|preflight|service-check|reference-check|link-order|boxes(?:\/[1-9][0-9]?(?:\/(?:book|refresh|label|verify|link-order|preflight|service-check))?)?))?$/;

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
  if (row?.state !== "failed") return null;
  if (!canRequestRoyalMailPostage(row)) return "unconfirmed";
  return row.requested_at === 0 && row.problem?.startsWith(REFERENCE_REFUSAL) ? "before_postage" : null;
}

async function shipmentView(row: Shipment | null, order: ShippingOrder, fingerprint?: string) {
  if (!row) return null;
  const changed = fingerprint && row.shipping_fingerprint ? !canUseShipment(order) || row.shipping_fingerprint !== fingerprint : await royalMailOrderChanged(row, order);
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
    requestProblem: row.request_problem,
    problem: row.problem?.startsWith(DECLINED_POSTAGE) ? row.problem.slice(DECLINED_POSTAGE.length) : row.problem,
  };
}

async function getShipment(env: Env, id: string) {
  return env.DB.prepare(`SELECT state, operation, order_version, provider_id, candidate_provider_id, booking_connection, booking_account_scope, tracking_number, carrier_status, carrier_event_at,
    label_downloaded_at, weight_grams, updated_at, shipping_fingerprint, review_required, problem, request_problem, requested_at, checked_at,
    recovery_due_at, recovery_attempts, destination_address, destination_postcode
    FROM wholesale_royal_mail_shipments WHERE order_id = ?`).bind(id).first<Shipment>();
}

async function boxShipments(env: Env, orderId: string) {
  const {results} = await env.DB.prepare("SELECT * FROM wholesale_royal_mail_shipments WHERE order_id GLOB ?")
    .bind(orderId + "-B*").all<Shipment & {order_id:string}>();
  return new Map(results.map(row => [row.order_id, row]));
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
export async function resolveWholesaleHandover(env: Env, order: ShippingOrder, link: string, staff = false, fromQueue = false): Promise<HandoverResult> {
  const plan = await readRoyalMailBoxPlan(env, order.id);
  if (plan) return resolveBoxHandover(env, order, plan, staff || fromQueue, link);
  const row = await getShipment(env, order.id);
  const royalMailLink = isRoyalMailLink(link);
  if (fromQueue && (!row?.label_downloaded_at || !row.provider_id || (link && !royalMailLink))) throw handoverReview();
  const staffRoyalMail = fromQueue || staff && (royalMailLink || (!link && !!row && row.state !== "failed"));
  if (staffRoyalMail) await requireStaffLabelEligibility(env, order);
  const combine = (shipment: ShippingGuard): ShippingGuard => {
    const guard = bookingPlanGuard(order.id, null);
    const eligibility = staffRoyalMail ? staffLabelEligibilityGuard(order) : {sql:"",args:[]};
    return { sql: shipment.sql + guard.sql + eligibility.sql, args: [...shipment.args, ...guard.args, ...eligibility.args] };
  };
  const exclude = (condition: string): ShippingGuard => ({
    sql: ` AND NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id = ? AND ${condition})`,
    args: [order.id],
  });
  if (link && !royalMailLink) {
    if (row?.state === "booking") throw handoverReview();
    return { trackingUrl: link, guard: combine(exclude("state = 'booking'")) };
  }
  if (referenceLookupFailure(row) === "unconfirmed") throw handoverReview();
  if (!row || row.state === "failed") {
    return { trackingUrl: trackingLink(numberFromRoyalMailLink(link)) || link, guard: combine(exclude(`(state <> 'failed' OR ${HELD_FAILED_SHIPMENT})`)), staffRoyalMail };
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

async function resolveBoxHandover(env: Env, order: ShippingOrder, plan: RoyalMailBoxPlan, staffRoyalMail: boolean, link: string) {
  if (!canUseShipment(order)) throw handoverReview();
  const amended = plan.fingerprint !== await shippingFingerprint(order) || plan.packed?.basis !== packingBasis(order);
  if (amended && !staffRoyalMail && link && !isRoyalMailLink(link)) {
    // An explicitly recorded shipment by another courier supersedes the amended plan.
    // Keep the obsolete Royal Mail bookings for audit and only send the actual link.
    const guard = {
      sql: ` AND EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?)
        AND NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id GLOB ? AND state='booking')`,
      args: [order.id, plan.revision, order.id + "-B*"],
    };
    const clear = await env.DB.prepare("SELECT 1 WHERE 1" + guard.sql).bind(...guard.args).first();
    if (!clear) throw handoverReview();
    return { trackingUrl:link, guard, staffRoyalMail:false };
  }
  if (amended || link) throw handoverReview();
  if (staffRoyalMail) await requireStaffLabelEligibility(env, order);
  const shipments = await boxShipments(env, order.id);
  const boxes = royalMailBoxes(order.id, plan);
  const evidence = boxes.map(box => {
    const row = shipments.get(box.reference);
    if (!row || !row.provider_id || !labelReady(row) || !row.label_downloaded_at || row.review_required ||
        row.shipping_fingerprint !== plan.fingerprint || row.weight_grams !== box.weightGrams) throw handoverReview();
    return { reference: box.reference, operation: row.operation, provider: row.provider_id, tracking: row.tracking_number };
  });
  if (new Set(evidence.map(item => item.provider)).size !== boxes.length) throw handoverReview();
  const first = shipments.get(boxes[0].reference)!;
  const numbers = evidence.flatMap(item => item.tracking ? [item.tracking] : []);
  if (new Set(numbers).size !== numbers.length) throw handoverReview();
  const destination = first.destination_address && first.destination_postcode
    ? {address:first.destination_address, postcode:first.destination_postcode} : undefined;
  const eligibility = staffRoyalMail ? staffLabelEligibilityGuard(order) : {sql:"",args:[]};
  const guard: ShippingGuard = {
    sql: ` AND EXISTS (SELECT 1 FROM wholesale_royal_mail_box_plans WHERE order_id=? AND revision=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) e LEFT JOIN wholesale_royal_mail_shipments s
        ON s.order_id=json_extract(e.value,'$.reference') WHERE s.order_id IS NULL OR s.operation<>json_extract(e.value,'$.operation')
        OR s.provider_id IS NOT json_extract(e.value,'$.provider') OR s.tracking_number IS NOT json_extract(e.value,'$.tracking')
        OR s.state NOT IN ('labelled','dispatched') OR s.review_required<>0 OR s.label_downloaded_at IS NULL
        OR s.shipping_fingerprint IS NOT ? OR lower(trim(s.destination_address)) IS NOT lower(trim(?)) OR s.destination_postcode IS NOT ?)` + eligibility.sql,
    args: [order.id, plan.revision, JSON.stringify(evidence), plan.fingerprint, first.destination_address, first.destination_postcode, ...eligibility.args],
  };
  const deliveryParcels = boxes.map((box,i) => ({ number:box.number, count:box.count, trackingNumber:evidence[i].tracking,
    trackingUrl:trackingLink(evidence[i].tracking) }));
  return { trackingUrl:"", deliveryParcels, destination, guard, staffRoyalMail };
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
    AND (tracking_number IS NULL OR tracking_number = ? OR ? = 1)
    AND (provider_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments other
      WHERE other.order_id<>? AND (other.provider_id=? OR other.candidate_provider_id=?)
      AND (other.booking_connection IS NULL OR other.booking_connection=wholesale_royal_mail_shipments.booking_connection)))`)
    .bind(carrier.providerState, carrier.providerState, carrier.orderId,
      carrier.trackingNumber, carrier.trackingNumber,
      carrier.trackingNumber, carrier.trackingNumber, carrier.trackingNumber, carrier.trackingNumber,
      Number(requireReview), carrier.providerState, carrier.labelProblem ?? null, accountScope, carrier.trackingNumber, Date.now(), id, operation, carrier.orderId,
      carrier.trackingNumber, Number(replaceTracking), id, carrier.orderId, carrier.orderId).run();
  if (result.meta.changes) return true;
  await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET review_required = 1, updated_at = ?
    WHERE order_id = ? AND operation = ? AND
    (provider_id <> ? OR (tracking_number IS NOT NULL AND tracking_number IS NOT ?))`)
    .bind(Date.now(), id, operation, carrier.orderId, carrier.trackingNumber).run();
  return false;
}

export async function handleWholesaleRoyalMail(req: Request, env: Env, orderId: string, action: string | undefined, actor: User, entry: "admin" | "staff" = "admin"): Promise<Response> {
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
  const plan = await readRoyalMailBoxPlan(env, orderId);
  const pieceRoute = action?.startsWith("boxes/") ? action.split("/") : null;
  const box = pieceRoute && plan ? royalMailBoxes(orderId,plan)[Number(pieceRoute[1])-1] ?? null : null;
  if (pieceRoute && !box) throw new ApiError(404,"not_found","This box is no longer in the order's packing plan.");
  if (pieceRoute) {
    if (!pieceRoute[2] && req.method !== "GET" || pieceRoute[2] === "book" && req.method !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Open the box or explicitly request its postage.");
    }
    action = pieceRoute[2] === "book" ? undefined : pieceRoute[2];
  }
  const id = box?.reference ?? orderId;
  const planGuard = bookingPlanGuard(orderId,box);
  if (action === "verify" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Verify Royal Mail shipments from the Admin wholesale dashboard.");
  }
  if (action === "service-check" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Check the configured parcel service from Admin.");
  }
  if (action === "reference-check" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Check a refused order reference from Admin.");
  }
  if (action === "link-order" && (staff || actor.role !== "admin")) {
    throw new ApiError(403, "permission_denied", "Link existing Click & Drop orders from Admin.");
  }
  const order = await get<Order>(env, "order", orderId);
  if (!eligibleOrder(order)) {
    throw new ApiError(404, "not_found", "Royal Mail shipping is available on wholesale delivery orders.");
  }
  if (action === "location") {
    if (staff || actor.role !== "admin") throw new ApiError(403, "permission_denied", "Only Admin can change a saved delivery location.");
    return royalMailAddressBook(req, env, order, actor.name);
  }
  if (plan && !box && action !== "boxes" && req.method !== "GET") throw boxPlanConflict();
  const planChanged = !!plan && (plan.fingerprint !== await shippingFingerprint(order) || plan.packed?.basis !== packingBasis(order));
  if (box && planChanged && action !== "refresh" && (action || req.method !== "GET")) throw boxPlanConflict();
  const policy = await readRoyalMailPolicy(env);
  const connections = await loadRoyalMailConnections(env, policy);
  const { booking: settings, tracking } = connections;
  if (action === "boxes" && req.method === "PUT") {
    if ((!staff && actor.role !== "admin") || !canUseShipment(order) || order.status !== "Ready") throw boxPlanConflict();
    await checkEligibility(order);
    const body = object(await readJson(req, 64 * 1024));
    const eligibility = staff ? staffLabelEligibilityGuard(order) : {sql:"",args:[]};
    await changeRoyalMailBoxPlan(env, order, await shippingFingerprint(order), body, eligibility, actor, staff);
  }
  if (action === "reference-check") {
    if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "Submit the reference check from the order.");
    const body = object(await readJson(req, 1024));
    const changed = () => new ApiError(409, "conflict", "The order or Royal Mail setup changed. Reopen the shipment to check its current status.");
    if (version(body.ifVersion) !== order.version || version(body.bookingVersion) !== policy.version) throw changed();
    const previous = await getShipment(env, id);
    const failure = referenceLookupFailure(previous);
    if (!failure || !previous) throw changed();
    // Older Admin tabs can ask about a failed preflight. A definitive local zero
    // answers that question without starting a carrier check alongside a new request.
    if (previous.provider_id !== null) {
      return json({ outcome: "found", message: "Strangers already has a Royal Mail order number for this parcel. Refresh the shipment to verify its status." });
    }
    if (failure === "before_postage") {
      return json({ outcome: "not_sent", message: "Strangers recorded no postage request for this order. Review the parcel before requesting its label." });
    }
    if (!settings.key) throw new ApiError(503, "royal_mail_not_configured", "Configure the Click & Drop key first.");
    let outcome: "found" | "missing" | "inconclusive", message: string;
    try {
      const match = await findRoyalMailOrder(settings.key, id);
      outcome = match ? "found" : "missing";
      message = match ? "Click & Drop found an existing booking. Compare its destination and parcel before using its label."

        : "Click & Drop found no booking for this reference. The earlier postage request is unconfirmed. Check it in Click & Drop before requesting another label.";
    } catch (error) {
      outcome = "inconclusive";
      message = error instanceof RoyalMailError ? error.message : "The reference check could not be completed. Check the order in Click & Drop.";
    }
    const [latestOrder, latestShipment, latestPolicy] = await Promise.all([
      get<Order>(env, "order", orderId), getShipment(env, id), readRoyalMailPolicy(env),
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
      royalMailPostcode(body.postcode), checkedPackedWeight(body.weightGrams, box?.weightGrams ?? order.grams));
    const [latest, current] = await Promise.all([get<Order>(env, "order", orderId), readRoyalMailPolicy(env)]);
    if (!latest || latest.version !== ifVersion || current.version !== bookingVersion) throw changed();
    return json(result);
  }
  const getView = async (status = 200, trackingWarning?: string) => {
    const [latest, shipment, latestPolicy, latestPlan] = await Promise.all([
      get<Order>(env, "order", orderId), getShipment(env, id), readRoyalMailPolicy(env), readRoyalMailBoxPlan(env,orderId),
    ]);
    if (!eligibleOrder(latest)) throw new ApiError(404, "not_found", "This order is no longer available.");
    const current = latestPolicy.version === policy.version ? connections : await loadRoyalMailConnections(env, latestPolicy);
    const eligibility = staff ? await staffLabelEligibility(env, latest) : null;
    const recipient = savedRoyalMailRecipient(latest);
    const latestFingerprint = latestPlan ? await shippingFingerprint(latest) : undefined;
    const view = await shipmentView(shipment, latest, latestFingerprint);
    const allowed = latest.status === "Ready" && !latest.skipped && (staff ? eligibility?.eligible === true : actor.role === "admin");
    const canBook = allowed && !!current.bookingConfigured && latestPolicy.enabled === 1 && (!staff || !!recipient);
    const planChanged = !!latestPlan && (latestPlan.fingerprint !== latestFingerprint || latestPlan.packed?.basis !== packingBasis(latest));
    const boxRows = latestPlan ? await boxShipments(env,orderId) : new Map<string,Shipment>();
    const boxes = await Promise.all((latestPlan ? royalMailBoxes(orderId,latestPlan) : []).map(async piece => {
      const row = boxRows.get(piece.reference) ?? null;
      const item = await shipmentView(row,latest,latestFingerprint);
      if (item && row && (row.weight_grams !== piece.weightGrams || row.shipping_fingerprint !== latestPlan?.fingerprint)) {
        item.orderChanged = true;
        item.trackingUrl = null;
      }
      if (staff && item && (item.orderChanged || item.reviewRequired || !eligibility?.eligible)) { item.trackingNumber=null; item.trackingUrl=null; }
      return { number:piece.number, count:piece.count, weightGrams:piece.weightGrams, contents:piece.contents,
        ...(!staff ? { goodsPence:piece.goodsPence } : {}), reference:piece.reference, shipment:item,
        canCreate:canBook && !planChanged && canRequestRoyalMailPostage(row),
        canDownloadLabel:!!(row?.provider_id && labelReady(row) && !row.review_required && !item?.orderChanged && !planChanged &&
          current.booking.key && (!staff || eligibility?.eligible)) };
    }));
    const boxesReadyForHandover = boxes.filter(piece => piece.canDownloadLabel && piece.shipment?.labelDownloadedAt).length;
    const canDispatchWithOtherCourier = !!latestPlan && !staff && actor.role === "admin" && latest.status === "Ready" &&
      !latest.skipped && planChanged && ![...boxRows.values()].some(row => row.state === "booking");
    const summary = { multiBox:!!latestPlan, boxCount:boxes.length, boxesReadyForHandover, planChanged, canDispatchWithOtherCourier,
      readyForHandover: boxes.length > 0 && boxesReadyForHandover === boxes.length};
    if (action === "boxes") {
      return json({ ...summary, ...packingView(latest,staff), boxes, planVersion:latestPlan?.revision ?? null,
        canChangePlan:allowed && canRequestRoyalMailPostage(shipment) && [...boxRows.values()].every(canRequestRoyalMailPostage),
        orderVersion:latest.version,bookingVersion:latestPolicy.version,bookingService:current.booking.serviceCode },status);
    }
    const canLink = (!latestPlan || !!box && !planChanged) && !staff && actor.role === "admin" && !!current.booking.key && canUseShipment(latest) &&
      (!shipment || view?.orderChanged === false && canLinkRoyalMailOrder(shipment));
    if (staff && view && (view.reviewRequired || view.orderChanged || (!eligibility?.eligible && latest.status === "Ready"))) {
      view.trackingNumber = null;
      view.trackingUrl = null;
    }
    return json({ ...summary, enabled: !!current.booking.key,
      bookingEnabled: latestPolicy.enabled === 1,
      bookingConfigured: current.bookingConfigured,
      canCreate: (!latestPlan || !!box && !planChanged) && current.bookingConfigured && latestPolicy.enabled === 1 &&
        (staff ? !!recipient && eligibility?.eligible === true : actor.role === "admin") &&
        latest.status === "Ready" && !latest.skipped && canRequestRoyalMailPostage(shipment),
      orderVersion: latest.version, shipment: view, trackingEnabled: !!current.tracking,
      ...(canLink ? { canLinkOrder: true, linkOperation: shipment?.operation ?? "new" } : {}),
      recipient, bookingService: current.booking.serviceCode, bookingVersion: latestPolicy.version,
      ...(!staff && !recipient ? { recipientDraft: royalMailRecipientDraft(latest) } : {}),
      ...(staff ? {
        eligibility,
        ...(!recipient ? { recipientWarning: savedAddressWarning } : {}),
        canDownloadLabel: !!current.booking.key && !!shipment?.provider_id && labelReady(shipment) &&
          (!box || !planChanged && box.weightGrams === shipment.weight_grams) && !view?.orderChanged && !view?.reviewRequired && eligibility?.eligible === true,
      } : {}),
      ...(trackingWarning ? { trackingWarning } : {}),
    }, status);
  };
  if (action === "boxes") {
    if (req.method !== "GET" && req.method !== "PUT") throw new ApiError(405,"method_not_allowed","Open or save this box plan.");
    return getView();
  }
  if (!action && req.method === "GET") return getView();
  if (req.method !== (action === "label" ? "GET" : "POST")) {
    throw new ApiError(405, "method_not_allowed", "This shipping action is unavailable.");
  }
  if (!settings.key) throw new ApiError(503, "royal_mail_not_configured", "Configure a valid Royal Mail Click & Drop key.");

  if ((!action || action === "preflight") && !staff && actor.role !== "admin") throw new ApiError(403, "permission_denied", "An admin must create Royal Mail shipments.");
  const existing = await getShipment(env, id);
  if (box && existing && (existing.weight_grams !== box.weightGrams || existing.shipping_fingerprint !== plan!.fingerprint) &&
      ["link-order","label","verify"].includes(action ?? "")) throw boxPlanConflict();
  if (action === "link-order") {
    if (!canUseShipment(order) || existing && (!canLinkRoyalMailOrder(existing) || await royalMailOrderChanged(existing, order))) {
      throw new ApiError(409, "royal_mail_link_unavailable", "This shipment cannot be linked. Reopen the order to see its current status.");
    }
    const savedRecipient = savedRoyalMailRecipient(order);
    if (box && !existing && !savedRecipient) throw invalid("Check the saved destination before linking postage for this box.");
    await linkRoyalMailOrder(req, env, id, order.version, policy.version, existing, settings.key, settings.shippingAccountName, actor,
      existing ? undefined : { fingerprint: await shippingFingerprint(order), createdAt: order.createdAt,
        destination: box && savedRecipient ? [savedRecipient.line1,savedRecipient.line2,savedRecipient.city,savedRecipient.county].filter(Boolean).join(", ") : undefined,
        postcode: box && savedRecipient ? savedRecipient.postcode : undefined },orderId,box);
    return getView();
  }
  if (action === "refresh" && existing && !existing.provider_id && referenceLookupFailure(existing) === "unconfirmed") {
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
    const [latest, shipment] = await Promise.all([get<Order>(env, "order", orderId), getShipment(env, id)]);
    if (!latest || !shipment || shipment.operation !== existing.operation || shipment.provider_id !== existing.provider_id ||
        shipment.tracking_number !== existing.tracking_number || !labelReady(shipment) || shipment.review_required || await royalMailOrderChanged(shipment, latest)) {
      throw review();
    }
    if (staff) await checkStaffLabel(latest);
    const eligible = staff ? staffLabelEligibilityGuard(latest) : { sql: "", args: [] };
    const access = shippingAccessGuard(actor, staff);
    const guard = `WHERE order_id=? AND operation=? AND provider_id=? AND tracking_number IS ? AND review_required=0
        AND state IN ('labelled','dispatched') AND EXISTS (
          SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)
        AND EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id=1 AND version=?)${eligible.sql}${access.sql}${planGuard.sql}`;
    const args = [id, shipment.operation, shipment.provider_id, shipment.tracking_number, orderId, latest.version, policy.version, ...eligible.args, ...access.args, ...planGuard.args];
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
    if (box && body.planVersion !== box.planVersion) throw boxPlanConflict();
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
      AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind = 'order' AND id = ? AND version = ?)${planGuard.sql}`)
      .bind(checkedAt, checkedAt, id, existing.operation, existing.provider_id, number, orderId, order.version, ...planGuard.args).run();
    if (!verified.meta.changes) throw handoverReview();
    await audit(env, "wholesale_royal_mail", actor.name, `Royal Mail shipment verified for ${id}.`);
    return getView();
  }
  if (action === "refresh") {
    if (!existing || existing.state === "failed" && !existing.provider_id) return getView();
    if (!existing.provider_id && (existing.state === "booking" || existing.state === "review")) {
      await checkStaffAccess();
      const warning = await checkUnconfirmedBooking(env, id, existing.operation, settings.key, false);
      return getView(200, warning);
    }
    const now = Date.now();
    const claimed = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = ?
      WHERE order_id = ? AND operation = ? AND provider_id IS NOT NULL AND COALESCE(refresh_after, 0) <= ?`)
      .bind(now + REFRESH_INTERVAL, id, existing.operation, now).run();
    if (!claimed.meta.changes) return getView();
    await checkStaffAccess();
    try {
      const carrier = await findLinkedShipment(env, settings.key, id, existing);
      const checkedAt = Date.now();
      await env.DB.prepare("UPDATE wholesale_royal_mail_shipments SET checked_at = ? WHERE order_id = ? AND operation = ?")
        .bind(checkedAt, id, existing.operation).run();
      if (carrier) {
        if (!await recordCarrier(env, id, existing.operation, carrier, existing.requested_at === 0 || existing.state === "failed")) {
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

  if (existing && !canRequestRoyalMailPostage(existing)) {
    if (action === "preflight") throw new ApiError(409, "royal_mail_already_requested", "Postage has already been requested. Reopen the shipment for its latest status.");
    return getView(existing.provider_id ? 200 : 202);
  }
  const { key, serviceCode, serviceRegisterCode, shippingAccountName } = settings;
  if (!serviceCode) throw new ApiError(503, "royal_mail_not_configured", "Configure the Royal Mail Click & Drop service before creating postage.");
  checkBookingPolicy(policy);
  if (order.status !== "Ready" || order.skipped) throw new ApiError(409, "order_not_ready", "Pack the order and mark it Ready before creating postage.");

  const body = object(await readJson(req, 4096));
  if (version(body.ifVersion) !== order.version) throw new ApiError(409, "conflict", "Review the latest order before creating postage.");
  checkBoxReview(box, body);
  if (staff) {
    if (Object.keys(body).some(key => !["ifVersion", "bookingVersion", "bookingService", "weightGrams", "billingRevision", ...(box ? ["planVersion"] : [])].includes(key))) {
      throw invalid("Use the saved address and configured Royal Mail service.");
    }
  }
  // Older Admin tabs predate the service preview. New reviews pin the displayed service and settings version.
  if (staff || box || body.bookingVersion !== undefined || body.bookingService !== undefined) {
    checkBookingPolicy(policy, version(body.bookingVersion));
    if (body.bookingService !== serviceCode) {
      throw new ApiError(409, "royal_mail_booking_policy_changed", "Royal Mail setup changed. Review the parcel and request the label again.");
    }
  }
  if (staff) await checkEligibility(order);
  const shipping = order.deliveryPence ?? 0, total = order.totalPence ?? order.pence + shipping;
  const subtotalPence = box ? box.goodsPence : order.pence, shippingPence = parcelValue(shipping, box);
  const taxPence = parcelValue(total - order.pence - shipping, box);
  const prepared = await prepareRoyalMailBooking(env, order, { serviceCode, serviceRegisterCode, shippingAccountName },
    { subtotalPence, shippingPence, taxPence, totalPence: subtotalPence + shippingPence + taxPence },
    id, body, box ? 1 : order.grams, staff);
  const { recipient: address, parcel: { weightInGrams: weight } } = prepared.input;
  const destination = [address.addressLine1, address.addressLine2, address.city, address.county].filter(Boolean).join(", ");
  const siblingGuard = box ? {
    sql: ` AND NOT EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id GLOB ? AND order_id<>?
      AND (state<>'failed' OR ${HELD_FAILED_SHIPMENT})
      AND (lower(trim(destination_address)) IS NOT lower(trim(?)) OR destination_postcode IS NOT ?))`,
    args: [orderId + "-B*", id, destination, address.postcode],
  } : { sql: "", args: [] };
  const sameDestination = () => env.DB.prepare("SELECT 1 WHERE 1" + siblingGuard.sql).bind(...siblingGuard.args).first();
  const differingDestination = "Use the same delivery address as the other booked boxes on this order.";
  if (action === "preflight") {
    if (box && prepared.review.ready && !await sameDestination()) {
      prepared.review.ready = false;
      prepared.review.issues.push({ field: "recipient.line1", message: differingDestination });
    }
    return json(prepared.review);
  }
  if (!prepared.review.ready) {
    const issue = prepared.review.issues[0];
    if (staff && issue.field.startsWith("recipient.")) throw new ApiError(409, "royal_mail_address_review", savedAddressWarning);
    throw new ApiError(400, "invalid_argument", issue.message, { issues: prepared.review.issues });
  }
  const eligibilityGuard = staff ? staffLabelEligibilityGuard(order) : { sql: "", args: [] };
  const accessGuard = shippingAccessGuard(actor,staff);
  const operation = crypto.randomUUID();
  const fingerprint = await shippingFingerprint(order);
  const connection = await bookingConnection(key);
  const originalAttempt = existing ? {
    sql: "operation=? AND state='failed' AND requested_at IS ? AND problem IS ? AND booking_connection IS ?",
    args: [existing.operation, existing.requested_at, existing.problem, existing.booking_connection],
  } : { sql: "0", args: [] };
  const reserved = await env.DB.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id, state, operation, order_version, shipping_fingerprint, weight_grams, updated_at, requested_at,
      destination_address, destination_postcode, booking_connection, label_order_created_at)
    SELECT ?, 'booking', ?, ?, ?, ?, ?, 0, ?, ?, ?, ? WHERE EXISTS (
      SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.status')='Ready'
    ) AND ${BOOKING_ALLOWED}${eligibilityGuard.sql}${accessGuard.sql}${planGuard.sql}${siblingGuard.sql}
      ${existing ? "AND EXISTS (SELECT 1 FROM wholesale_royal_mail_shipments WHERE order_id=? AND operation=?)" : ""}
    ON CONFLICT(order_id) DO UPDATE SET state=excluded.state, operation=excluded.operation,
      order_version=excluded.order_version, shipping_fingerprint=excluded.shipping_fingerprint,
      weight_grams=excluded.weight_grams, updated_at=excluded.updated_at, requested_at=0, checked_at=NULL, refresh_after=NULL, problem=NULL, request_problem=NULL,
      recovery_attempts=0, recovery_due_at=NULL, label_downloaded_at=NULL, candidate_provider_id=NULL, booking_connection=excluded.booking_connection, booking_account_scope=NULL,
      service_code=NULL, label_order_created_at=excluded.label_order_created_at,
      destination_address=excluded.destination_address, destination_postcode=excluded.destination_postcode
    WHERE ${originalAttempt.sql} AND NOT ${HELD_FAILED_SHIPMENT}
      AND COALESCE(wholesale_royal_mail_shipments.refresh_after,0) <= ${SQL_NOW_MS}
      RETURNING operation`)
    .bind(id, operation, order.version, fingerprint, weight, Date.now(),
      destination, address.postcode, connection, order.createdAt || null,
      orderId, order.version, policy.version, ...eligibilityGuard.args, ...accessGuard.args, ...planGuard.args, ...siblingGuard.args, ...(existing ? [id, existing.operation] : []), ...originalAttempt.args).first();
  if (!reserved) {
    await checkStaffAccess();
    checkBookingPolicy(await readRoyalMailPolicy(env), policy.version);
    await checkEligibility(order);
    if (box && !await sameDestination()) throw new ApiError(409, "royal_mail_box_destination", differingDestination);
    if (await getShipment(env, id)) return getView(202);
    throw new ApiError(409, "conflict", "The order changed. Review it before creating postage.");
  }

  let outcome: "reserved" | "requested" | "known" = "reserved";
  let acceptedOrderId: number | null = null;
  try {
    // All callers share one reservation. Commit the send marker only while this
    // operation still owns the eligible parcel and service.
    const at = Date.now();
    const sending = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET requested_at=?, updated_at=?, service_code=?
      WHERE order_id=? AND operation=? AND state='booking' AND requested_at=0
      AND provider_id IS NULL AND candidate_provider_id IS NULL AND review_required=0 AND tracking_number IS NULL AND label_downloaded_at IS NULL
      AND carrier_status IS NULL AND carrier_event_at IS NULL AND booking_account_scope IS NULL
      AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)
      AND ${BOOKING_ALLOWED}${eligibilityGuard.sql}${accessGuard.sql}${planGuard.sql}${BILLING_REVISION_GUARD}`)
      .bind(at, at, serviceCode, id, operation, orderId, order.version, policy.version, ...eligibilityGuard.args, ...accessGuard.args, ...planGuard.args,
        order.customerId, prepared.billingRevision).run();
    if (!sending.meta.changes) {
      await checkStaffAccess();
      checkBookingPolicy(await readRoyalMailPolicy(env), policy.version);
      await checkEligibility(order);
      if (!await env.DB.prepare("SELECT 1 WHERE 1" + BILLING_REVISION_GUARD).bind(order.customerId, prepared.billingRevision).first()) {
        throw new ApiError(409, "royal_mail_billing_changed", "The confirmed billing address changed. Review the booking again.");
      }
      throw new ApiError(409, "conflict", "The order or booking changed. Review it before creating postage.");
    }
    outcome = "requested";
    const carrier = await createRoyalMailOrder(key, prepared.input);
    outcome = "known";
    acceptedOrderId = carrier.orderId;
    const latest = await get<Order>(env, "order", orderId);
    const latestChanged = !latest || !canUseShipment(latest) || await shippingFingerprint(latest) !== fingerprint;
    // Only a confirmed create with an explicitly named account proves which account owns this shipment.
    const accountScope = shippingAccountName ? await bookingAccountScope(key, shippingAccountName) : null;
    const saved = await recordCarrier(env, id, operation, carrier, latestChanged, false, accountScope);
    if (!saved) throw new Error("The recorded shipment changed while saving the confirmed booking.");
  } catch (error) {
    const carrierError = error instanceof RoyalMailError ? error : null;
    const noSend = outcome === "reserved" || outcome === "requested" && carrierError &&
      ["royal_mail_invalid_shipment", "royal_mail_configuration"].includes(carrierError.code);
    const declined = outcome === "requested" && carrierError && !carrierError.uncertain &&
      ["royal_mail_rejected", "royal_mail_auth", "royal_mail_denied"].includes(carrierError.code);
    const state = noSend || declined ? "failed" : "review";
    const message = error instanceof RoyalMailError || error instanceof ApiError ? error.message : "The postage request could not be confirmed.";
    const candidate = acceptedOrderId ?? (outcome === "requested" && carrierError?.uncertain ? carrierError.candidateId ?? null : null);
    // Retain only adapter-authored diagnostics. An upstream body can contain the customer's address or credentials.
    const status = carrierError?.status;
    const requestProblem = state !== "review" ? null : outcome === "known"
      ? "Click & Drop returned an order number. The dashboard could not finish saving its booking details."
      : carrierError ? carrierError.message + (status && !carrierError.message.includes("HTTP " + status) ? " (HTTP " + status + ")" : "")
      : "The dashboard did not receive a usable confirmation for the postage request.";
    await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state=?, problem=?, request_problem=?, updated_at=?,
      requested_at=CASE WHEN ? THEN 0 ELSE requested_at END, candidate_provider_id=COALESCE(candidate_provider_id,?)
      WHERE order_id=? AND operation=? AND state='booking' AND provider_id IS NULL
      AND (? IS NULL OR (requested_at>0 AND booking_connection=?))`)
      .bind(state, declined ? DECLINED_POSTAGE + message : state === "failed" ? message : null, requestProblem, Date.now(), Number(!!noSend),
        candidate, id, operation, candidate, connection).run();
    if (error instanceof ApiError) throw error;
    return getView(state === "review" ? 202 : 200);
  }
  await audit(env, "wholesale_royal_mail", actor.name, `Royal Mail shipment recorded for ${id}.`);
  return getView(201);
}
