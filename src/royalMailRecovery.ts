import { audit } from "./audit";
import { HELD_FAILED_SHIPMENT } from "./royalMailBookingState";
import type { Env } from "./http";
import { findRoyalMailOrder, findRoyalMailOrderById, type RoyalMailOrder } from "./royalMail";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "./royalMailAppSettings";

export const REFRESH_INTERVAL = 30_000;
const BOOKING_GRACE = 60_000;
// The five-minute job rounds these delays up to its next tick.
const RETRY_DELAYS = [5, 15, 60].map(minutes => minutes * 60_000);
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
export const REFERENCE_REFUSAL = "Royal Mail rejected the order-reference lookup.";
const UNCONFIRMED = "provider_id IS NULL AND state IN ('booking','review')";
const DUE_AT = "COALESCE(recovery_due_at, updated_at + 60000)";

interface PendingBooking {
  review_required: number;
  tracking_number: string | null;
  label_downloaded_at: number | null;
  carrier_status: string | null;
  carrier_event_at: string | null;
  booking_account_scope: string | null;
  state: string;
  order_id: string;
  operation: string;
  requested_at: number | null;
  booking_connection: string | null;
  candidate_provider_id: number | null;
  updated_at: number;
  recovery_attempts: number;
  recovery_due_at: number | null;
}

export async function bookingConnection(key: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Bind evidence to the exact named shipping account without storing its name on the shipment. */
export function bookingAccountScope(key: string, accountName: string) {
  return bookingConnection(key + "\u0000" + accountName);
}

export function bookingRecovery(row: {
  state: string; provider_id: number | null; updated_at: number; checked_at: number | null;
  recovery_attempts: number; recovery_due_at: number | null;
}) {
  if (row.provider_id || (row.state !== "booking" && row.state !== "review")) return null;
  const escalated = row.recovery_due_at === 0;
  return {
    status: escalated ? "needs_admin" : "checking", attempts: row.recovery_attempts,
    nextCheckAt: escalated ? null : row.recovery_due_at ?? row.updated_at + BOOKING_GRACE,
    lastCheckedAt: row.checked_at,
  };
}

/** Reconcile one original reference strictly by GET. Never infer a failed purchase from an empty carrier search. */
export async function checkUnconfirmedBooking(env: Env, id: string, operation: string, key: string | null, automatic: boolean) {
  const now = Date.now();
  // Use the same throttle as the human refresh button. The lease outlives the carrier's request timeout.
  const lease = now + REFRESH_INTERVAL;
  const due = automatic ? ` AND recovery_due_at IS NOT 0 AND ${DUE_AT} <= ?` : "";
  const args = [id, operation, now, now - BOOKING_GRACE, ...(automatic ? [now] : [])];
  const unresolved = automatic ? UNCONFIRMED : `(${UNCONFIRMED} OR (provider_id IS NULL AND ${HELD_FAILED_SHIPMENT}))`;
  const claimable = `order_id = ? AND operation = ? AND ${unresolved}
    AND COALESCE(refresh_after, 0) <= ? AND (state <> 'booking' OR updated_at <= ?)${due}`;
  const claimed = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = ?,
    recovery_attempts = recovery_attempts + ?, recovery_due_at = CASE WHEN ? THEN ? ELSE recovery_due_at END
    WHERE ${claimable}${automatic ? " AND recovery_attempts < ?" : ""}
    RETURNING state, order_id, operation, requested_at, booking_connection, candidate_provider_id, updated_at, recovery_attempts, recovery_due_at, review_required, tracking_number, label_downloaded_at, carrier_status, carrier_event_at, booking_account_scope`)
    .bind(lease, Number(automatic), Number(automatic), lease, ...args, ...(automatic ? [MAX_ATTEMPTS] : [])).first<PendingBooking>();
  if (!claimed) {
    // A final lookup can be interrupted after it claimed its last attempt. Escalate when that lease expires.
    if (automatic) {
      const escalated = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET recovery_due_at = 0, state = 'review',
      problem = 'Automatic checks ended. Verify the original order reference in Click & Drop.'
      WHERE ${claimable} AND recovery_attempts >= ?`).bind(...args, MAX_ATTEMPTS).run();
      if (escalated.meta.changes) await audit(env, "wholesale_royal_mail", null, `Royal Mail booking for ${id} needs Admin review in Click & Drop.`);
    }
    return;
  }
  // A stopped local reservation is safe to release only while its outbound marker is
  // still zero. Whichever of this update and the sender's update wins fences the other.
  if (claimed.state === "booking" && claimed.requested_at === 0 && claimed.candidate_provider_id === null &&
      !claimed.review_required && claimed.tracking_number === null && claimed.label_downloaded_at === null &&
      claimed.carrier_status === null && claimed.carrier_event_at === null && claimed.booking_account_scope === null) {
    await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state='failed', checked_at=?, updated_at=?,
      recovery_due_at=NULL, refresh_after=NULL, problem='No label request was sent. You can review the parcel and try again.'
      WHERE order_id=? AND operation=? AND state='booking' AND requested_at=0 AND provider_id IS NULL
      AND candidate_provider_id IS NULL AND review_required=0 AND tracking_number IS NULL AND label_downloaded_at IS NULL
      AND carrier_status IS NULL AND carrier_event_at IS NULL AND booking_account_scope IS NULL
      AND refresh_after=?`).bind(now, now, id, operation, lease).run();
    return;
  }
  const held = claimed.state === "failed";
  const owned = `order_id = ? AND operation = ? AND refresh_after = ? AND requested_at IS ? AND candidate_provider_id IS ?
    AND booking_connection IS ? AND ${held ? HELD_FAILED_SHIPMENT : UNCONFIRMED}`;
  const owner = [id, operation, lease, claimed.requested_at, claimed.candidate_provider_id, claimed.booking_connection];
  let carrier: RoyalMailOrder | null = null;
  let warning: string | undefined;
  const sameConnection = !!key && claimed.booking_connection === await bookingConnection(key);
  if (!key) {
    warning = "Restore the Click & Drop connection to check the original booking.";
  } else if (claimed.candidate_provider_id !== null && (!sameConnection || !claimed.requested_at)) {
    warning = "Check the original booking in the Click & Drop account that received the postage request.";
  } else {
    try {
      if (claimed.candidate_provider_id !== null) {
        carrier = await findRoyalMailOrderById(key, claimed.candidate_provider_id, id);
        if (!carrier) warning = "Royal Mail has not yet confirmed this booking. Check the existing order in Click & Drop.";
      } else {
        carrier = await findRoyalMailOrder(key, id);
      }
    } catch { warning = "Royal Mail could not confirm this booking. Check the original order reference in Click & Drop."; }
  }
  const checkedAt = Date.now();
  if (carrier && key) {
    // A match on a different account, an old unpinned connection or an unsubmitted draft needs an admin.
    const needsReview = held || !claimed.requested_at || !sameConnection;
    const recorded = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = ?, provider_id = ?, candidate_provider_id = NULL, tracking_number = ?,
      review_required = MAX(review_required, ?), checked_at = ?, updated_at = ?, recovery_due_at = NULL, problem = ?
      WHERE ${owned}`).bind(carrier.providerState, carrier.orderId, carrier.trackingNumber, Number(needsReview), checkedAt, checkedAt, carrier.labelProblem ?? null, ...owner).run();
    if (recorded.meta.changes) await audit(env, "wholesale_royal_mail", null, `Royal Mail booking recovered for ${id}.${needsReview ? " Verify the existing label in Click & Drop." : ""}`);
  } else if (held) {
    // A different key or a missing carrier result cannot prove that this older order was never submitted.
    await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET checked_at = ? WHERE ${owned}`).bind(checkedAt, ...owner).run();
    warning ??= "Royal Mail did not find the original booking. The earlier postage request remains unconfirmed.";
  } else {
    const exhausted = !key || claimed.recovery_attempts >= MAX_ATTEMPTS || claimed.recovery_due_at === 0;
    const pending = automatic ? checkedAt + (RETRY_DELAYS[claimed.recovery_attempts - 1] ?? 0) : claimed.recovery_due_at ?? claimed.updated_at + BOOKING_GRACE;
    const problem = exhausted ? warning || "Royal Mail has not confirmed the booking. Verify the original order reference in Click & Drop." : null;
    const result = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = 'review', checked_at = ?, updated_at = ?,
      recovery_due_at = ?, problem = ? WHERE ${owned}`).bind(checkedAt, checkedAt, exhausted ? 0 : pending, problem, ...owner).run();
    if (result.meta.changes && exhausted && claimed.recovery_due_at !== 0) {
      await audit(env, "wholesale_royal_mail", null, `Royal Mail booking for ${id} needs Admin review in Click & Drop.`);
    }
  }
  return warning;
}

export async function recoverRoyalMailBookings(env: Env) {
  const now = Date.now();
  // The partial due-date index keeps completed shipments out of the scheduled scan.
  const { results } = await env.DB.prepare(`SELECT order_id, operation FROM wholesale_royal_mail_shipments
    WHERE ${UNCONFIRMED} AND recovery_due_at IS NOT 0 AND ${DUE_AT} <= ?
    AND COALESCE(refresh_after, 0) <= ? AND (state = 'review' OR updated_at <= ?)
    ORDER BY ${DUE_AT}, order_id LIMIT 4`).bind(now, now, now - BOOKING_GRACE).all<Pick<PendingBooking, "order_id" | "operation">>();
  if (!results.length) return;
  const { booking } = await loadRoyalMailConnections(env, await readRoyalMailPolicy(env));
  for (const row of results) await checkUnconfirmedBooking(env, row.order_id, row.operation, booking.key, true);
}
