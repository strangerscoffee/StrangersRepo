import { audit } from "./audit";
import type { User } from "./auth";
import { ApiError, invalid, readJson, type Env } from "./http";
import { findRoyalMailOrderById, RoyalMailError, type RoyalMailOrder } from "./royalMail";
import { HELD_FAILED_SHIPMENT } from "./royalMailBookingState";
import { bookingAccountScope, bookingConnection, REFRESH_INTERVAL } from "./royalMailRecovery";
import { object, version } from "./wholesaleStore";

interface UnlinkedShipment {
  state: string;
  operation: string;
  provider_id: number | null;
  candidate_provider_id: number | null;
  requested_at: number | null;
  booking_connection: string | null;
  booking_account_scope: string | null;
}

export function canLinkRoyalMailOrder(row: UnlinkedShipment | null): row is UnlinkedShipment {
  return !!row && row.provider_id === null && (row.state === "failed" || row.state === "review");
}

function changed() {
  return new ApiError(409, "conflict", "The order, booking or Royal Mail settings changed. Reopen the shipment and check again.");
}

function wrongOrder() {
  return new ApiError(409, "royal_mail_link_unconfirmed", "No single Click & Drop order matched both the order number and this wholesale reference. Check them in Click & Drop.");
}

/** Attach an independently verified existing order. All carrier traffic here is a single, authenticated GET. */
export async function linkRoyalMailOrder(req: Request, env: Env, id: string, orderVersion: number, bookingVersion: number,
  shipment: UnlinkedShipment | null, key: string, accountName: string | undefined, actor: User,
  fresh?: { fingerprint: string; createdAt: number }) {
  const body = object(await readJson(req, 1024));
  if (Object.keys(body).some(field => !["ifVersion", "bookingVersion", "operation", "orderNumber"].includes(field))) {
    throw invalid("Enter the Click & Drop order number shown in Orders.");
  }
  if (version(body.ifVersion) !== orderVersion || version(body.bookingVersion) !== bookingVersion || body.operation !== (shipment?.operation ?? "new")) throw changed();
  const raw = typeof body.orderNumber === "string" ? body.orderNumber.trim() : body.orderNumber;
  const number = typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : raw;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw invalid("Enter the numeric Click & Drop order number shown in Orders.");
  }
  const connection = await bookingConnection(key);
  if (!shipment) {
    if (!fresh) throw changed();
    // The admin has reported postage bought elsewhere. Reserve this order before the
    // read-only verification so a concurrent Staff or Admin request cannot buy a second label.
    const claimed = await env.DB.prepare(`INSERT INTO wholesale_royal_mail_shipments
      (order_id,state,operation,order_version,weight_grams,updated_at,requested_at,booking_connection,
       shipping_fingerprint,review_required,label_order_created_at,problem)
      SELECT ?, 'failed', ?, ?, 0, ?, NULL, ?, ?, 1, ?, 'Postage was reported in Click & Drop. Link the existing booking.'
      WHERE EXISTS (SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)
      AND EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id=1 AND version=?)
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change=0)
      ON CONFLICT(order_id) DO NOTHING
      RETURNING state,operation,provider_id,candidate_provider_id,requested_at,booking_connection,booking_account_scope`)
      .bind(id, crypto.randomUUID(), orderVersion, Date.now(), connection, fresh.fingerprint, fresh.createdAt,
        id, orderVersion, bookingVersion, actor.id).first<UnlinkedShipment>();
    if (!claimed) throw changed();
    shipment = claimed;
  }
  if (shipment.candidate_provider_id !== null && shipment.candidate_provider_id !== number) throw wrongOrder();
  if (shipment.requested_at === 0 && shipment.booking_connection && shipment.booking_connection !== connection) {
    // An obsolete preflight key on a proven-unsent row never owned postage.
    // Move that row to the current account and hold it before checking the reported booking.
    const rebound = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET booking_connection=?,review_required=1
      WHERE order_id=? AND operation=? AND state='failed' AND requested_at=0 AND booking_connection=? AND NOT ${HELD_FAILED_SHIPMENT}
      AND COALESCE(refresh_after,0)<=? AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=?)
      AND EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id=1 AND version=?)
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1 AND must_change=0)`)
      .bind(connection,id,shipment.operation,shipment.booking_connection,Date.now(),id,orderVersion,bookingVersion,actor.id).run();
    if (rebound.meta.changes) shipment = { ...shipment, booking_connection: connection };
  }
  const pinnedConnection = shipment.booking_connection !== null || shipment.candidate_provider_id !== null;
  if ((pinnedConnection && shipment.booking_connection !== connection) ||
      (shipment.booking_account_scope !== null && (!accountName || shipment.booking_account_scope !== await bookingAccountScope(key, accountName)))) {
    throw new ApiError(409, "royal_mail_connection_changed", "Restore the original Click & Drop connection and shipping account before linking this order.");
  }

  const now = Date.now(), lease = now + REFRESH_INTERVAL;
  const guard = `order_id = ? AND operation = ? AND state = ? AND requested_at IS ? AND provider_id IS NULL
    AND candidate_provider_id IS ? AND booking_connection IS ? AND booking_account_scope IS ?
    AND EXISTS (SELECT 1 FROM wholesale_preview WHERE kind = 'order' AND id = ? AND version = ?)
    AND EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id = 1 AND version = ?)
    AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND active = 1 AND must_change = 0)`;
  const args = [id, shipment.operation, shipment.state, shipment.requested_at, shipment.candidate_provider_id,
    shipment.booking_connection, shipment.booking_account_scope, id, orderVersion, bookingVersion, actor.id];
  // The purchase reservation and automatic reconciliation respect this lease. A stopped Worker cannot strand it.
  const claimed = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = ?,
    review_required = CASE WHEN state='failed' THEN 1 ELSE review_required END
    WHERE ${guard} AND COALESCE(refresh_after, 0) <= ?`).bind(lease, ...args, now).run();
  if (!claimed.meta.changes) throw new ApiError(409, "royal_mail_link_busy", "The shipment changed or another check is in progress. Reopen it and try again shortly.");

  let linked = false;
  try {
    let carrier: RoyalMailOrder | null;
    try { carrier = await findRoyalMailOrderById(key, number, id); }
    catch (error) {
      if (error instanceof RoyalMailError && ["royal_mail_order_mismatch", "royal_mail_invalid_response", "royal_mail_rejected"].includes(error.code)) throw wrongOrder();
      throw new ApiError(503, "royal_mail_link_unavailable", "Click & Drop could not verify the order number. Check the connection and try again.");
    }
    if (!carrier) throw wrongOrder();
    const checked = Date.now();
    const saved = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = ?, provider_id = ?, tracking_number = ?,
      review_required = 1, booking_connection = ?, candidate_provider_id = NULL, checked_at = ?, updated_at = ?,
      service_code = CASE WHEN candidate_provider_id = ? THEN service_code END, recovery_due_at = NULL, refresh_after = NULL,
      label_downloaded_at = NULL, carrier_status = NULL, carrier_event_at = NULL, problem = NULL
      WHERE ${guard} AND refresh_after = ? AND NOT EXISTS (
        SELECT 1 FROM wholesale_royal_mail_shipments other WHERE other.order_id <> ? AND
        (other.provider_id = ? OR other.candidate_provider_id = ?) AND (other.booking_connection IS NULL OR other.booking_connection = ?))`)
      .bind(carrier.providerState, number, carrier.trackingNumber, connection, checked, checked, number, ...args,
        lease, id, number, number, connection).run();
    if (!saved.meta.changes) throw changed();
    linked = true;
    await audit(env, "wholesale_royal_mail", actor.name, `Linked an existing Click & Drop order to ${id}. Verify the parcel before using its label.`);
  } finally {
    if (!linked) {
      await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = NULL
        WHERE order_id = ? AND operation = ? AND refresh_after = ? AND provider_id IS NULL`).bind(id, shipment.operation, lease).run();
    }
  }
}
