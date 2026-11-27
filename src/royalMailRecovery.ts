import { audit } from "./audit";
import type { Env } from "./http";
import { findRoyalMailOrder, type RoyalMailOrder } from "./royalMail";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "./royalMailAppSettings";

export const REFRESH_INTERVAL = 30_000;
const BOOKING_GRACE = 60_000;
// The five-minute job rounds these delays up to its next tick.
const RETRY_DELAYS = [5, 15, 60].map(minutes => minutes * 60_000);
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
const UNCONFIRMED = "provider_id IS NULL AND state IN ('booking','review')";
const DUE_AT = "COALESCE(recovery_due_at, updated_at + 60000)";

interface PendingBooking {
  order_id: string;
  operation: string;
  requested_at: number | null;
  booking_connection: string | null;
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
  const claimable = `order_id = ? AND operation = ? AND ${UNCONFIRMED}
    AND COALESCE(refresh_after, 0) <= ? AND (state = 'review' OR updated_at <= ?)${due}`;
  const claimed = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET refresh_after = ?,
    recovery_attempts = recovery_attempts + ?, recovery_due_at = CASE WHEN ? THEN ? ELSE recovery_due_at END
    WHERE ${claimable}${automatic ? " AND recovery_attempts < ?" : ""}
    RETURNING order_id, operation, requested_at, booking_connection, updated_at, recovery_attempts, recovery_due_at`)
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
  const owned = `order_id = ? AND operation = ? AND refresh_after = ? AND requested_at IS ? AND ${UNCONFIRMED}`;
  const owner = [id, operation, lease, claimed.requested_at];
  let carrier: RoyalMailOrder | null = null;
  let warning: string | undefined;
  if (key) {
    try { carrier = await findRoyalMailOrder(key, id); }
    catch { warning = "Royal Mail could not confirm this booking. Check the original order reference in Click & Drop."; }
  } else {
    warning = "Restore the Click & Drop connection to check the original booking.";
  }
  const checkedAt = Date.now();
  if (carrier && key) {
    // A match on a different account, an old unpinned connection or an unsubmitted draft needs an admin.
    const needsReview = !claimed.requested_at || claimed.booking_connection !== await bookingConnection(key);
    const recorded = await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = ?, provider_id = ?, tracking_number = ?,
      review_required = MAX(review_required, ?), checked_at = ?, updated_at = ?, recovery_due_at = NULL, problem = NULL
      WHERE ${owned}`).bind(carrier.providerState, carrier.orderId, carrier.trackingNumber, Number(needsReview), checkedAt, checkedAt, ...owner).run();
    if (recorded.meta.changes) await audit(env, "wholesale_royal_mail", null, `Royal Mail booking recovered for ${id}.${needsReview ? " Verify the existing label in Click & Drop." : ""}`);
  } else if (!warning && claimed.requested_at === 0) {
    // The outbound marker is committed before POST; the ownership check also fences an in-flight sender.
    await env.DB.prepare(`UPDATE wholesale_royal_mail_shipments SET state = 'failed', checked_at = ?, updated_at = ?,
      recovery_due_at = NULL, problem = 'No label request was sent. You can review the parcel and try again.'
      WHERE ${owned}`).bind(checkedAt, checkedAt, ...owner).run();
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
