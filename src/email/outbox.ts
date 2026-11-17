// Dispatch events are committed with the order, then delivered with bounded attempts and recoverable leases.
// No credentials are stored here. Payloads freeze the customer-facing mail at the time it was dispatched.
import { audit } from "../audit";
import { ApiError, type Env } from "../http";
import { emailReady, sendOutcome, type Outgoing } from "./send";

const LEASE = 2 * 60000, MAX_ATTEMPTS = 8, SAFE_REPLAY = 23 * 3600000;
interface Row { event_key: string; order_id: string; payload: string; state: string; attempts: number; attempted_at: number | null; lease_until: number | null; uncertain: number }

/** Insert BEFORE the guarded order update in the same D1 batch. A failed update cannot strand an event. */
export function dispatchEvent(env: Env, id: string, reviewedVersion: number, outgoing: Outgoing) {
  const now = Date.now();
  return env.DB.prepare("INSERT OR IGNORE INTO wholesale_email_outbox(event_key,order_id,payload,state,attempts,created_at,next_attempt_at) SELECT ?,?,?,'queued',0,?,? WHERE EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.deletedAt') IS NULL)")
    .bind("dispatch:" + id, id, JSON.stringify(outgoing), now, now, id, reviewedVersion);
}

async function reviewExpiredDispatchClaims(env: Env) {
  const now = Date.now();
  // An interrupted attempt older than the provider's idempotency window needs an explicit human review.
  const uncertain = await env.DB.prepare("UPDATE wholesale_email_outbox SET state='unknown',claim_token=NULL,lease_until=NULL,last_error='Delivery could not be verified. Review before retrying.' WHERE sent_at IS NULL AND uncertain=1 AND (COALESCE(first_attempt_at,attempted_at)<? OR (state='sending' AND attempts>=?)) AND state IN ('queued','sending','retry','failed') AND COALESCE(lease_until,0)<=? RETURNING event_key")
    .bind(now - SAFE_REPLAY, MAX_ATTEMPTS, now).all<{ event_key: string }>();
  for (const row of uncertain.results) await audit(env, "email_failed", null, `Dispatch email ${row.event_key} needs delivery review.`).catch(() => {});
}

export async function deliverDispatchEmails(env: Env, eventKey?: string) {
  await reviewExpiredDispatchClaims(env);
  if (!emailReady(env)) return;
  const now = Date.now();
  const rows = await env.DB.prepare("SELECT event_key,order_id,payload,state,attempts,attempted_at,lease_until,uncertain FROM wholesale_email_outbox WHERE sent_at IS NULL AND attempts<? AND state IN ('queued','retry','sending') AND next_attempt_at<=? AND COALESCE(lease_until,0)<=? AND (? IS NULL OR event_key=?) ORDER BY next_attempt_at,event_key LIMIT 10")
    .bind(MAX_ATTEMPTS, now, now, eventKey || null, eventKey || null).all<Row>();
  for (const row of rows.results) {
    const token = crypto.randomUUID(), at = Date.now();
    const claimed = await env.DB.prepare("UPDATE wholesale_email_outbox SET state='sending',attempts=attempts+1,attempted_at=?,first_attempt_at=COALESCE(first_attempt_at,?),lease_until=?,claim_token=?,uncertain=1 WHERE event_key=? AND sent_at IS NULL AND attempts=? AND state IN ('queued','retry','sending') AND COALESCE(lease_until,0)<=?")
      .bind(at, at, at + LEASE, token, row.event_key, row.attempts, at).run();
    if (!claimed.meta.changes) continue;
    let outcome: Awaited<ReturnType<typeof sendOutcome>>;
    try {
      const payload = JSON.parse(row.payload) as Outgoing;
      if (!payload?.mail?.subject || !payload.to?.email) throw new Error("Invalid stored notification.");
      outcome = await sendOutcome(env, payload, row.event_key);
    } catch {
      // Retain the claim as uncertain if a send or its acknowledgement could have started.
      outcome = { status: "failed", uncertain: true };
    }
    if (outcome.status === "sent") {
      await env.DB.prepare("UPDATE wholesale_email_outbox SET state='sent',sent_at=?,lease_until=NULL,claim_token=NULL,uncertain=0,last_error=NULL WHERE event_key=? AND claim_token=?")
        .bind(Date.now(), row.event_key, token).run();
    } else {
      const failed = !!outcome.permanent || row.attempts + 1 >= MAX_ATTEMPTS, uncertain = !!outcome.uncertain || !!row.uncertain;
      await env.DB.prepare("UPDATE wholesale_email_outbox SET state=?,next_attempt_at=?,lease_until=NULL,claim_token=NULL,uncertain=?,last_error=? WHERE event_key=? AND claim_token=?")
        .bind(failed ? (uncertain ? "unknown" : "failed") : "retry", Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts), uncertain ? 1 : 0, outcome.status === "limit" ? "Daily email limit reached." : outcome.status === "off" ? "Email is not configured." : "Provider delivery was not confirmed.", row.event_key, token).run();
    }
  }
}

export async function retryDispatchEmails(env: Env, actor: string, acknowledgeUnknown = false) {
  await reviewExpiredDispatchClaims(env);
  const rows = await env.DB.prepare("SELECT event_key,state FROM wholesale_email_outbox WHERE sent_at IS NULL AND ((?=0 AND state IN ('retry','failed')) OR (?=1 AND state='unknown')) AND COALESCE(lease_until,0)<=? ORDER BY created_at LIMIT 25")
    .bind(acknowledgeUnknown ? 1 : 0, acknowledgeUnknown ? 1 : 0, Date.now()).all<{ event_key: string; state: string }>();
  if (!acknowledgeUnknown && !rows.results.length) {
    const unknown = await env.DB.prepare("SELECT 1 FROM wholesale_email_outbox WHERE state='unknown' LIMIT 1").first();
    if (unknown) throw new ApiError(409, "delivery_unknown", "Check delivery first, then explicitly confirm the retry. It may duplicate a previously delivered email.");
  }
  let queued = 0;
  for (const row of rows.results) {
    const r = await env.DB.prepare("UPDATE wholesale_email_outbox SET state='queued',attempts=0,next_attempt_at=?,first_attempt_at=CASE WHEN state='unknown' THEN NULL ELSE first_attempt_at END,claim_token=NULL,lease_until=NULL,uncertain=CASE WHEN state='unknown' THEN 0 ELSE uncertain END,last_error=NULL WHERE event_key=? AND state=? AND sent_at IS NULL AND COALESCE(lease_until,0)<=?")
      .bind(Date.now(), row.event_key, row.state, Date.now()).run();
    queued += r.meta.changes;
  }
  if (queued) await audit(env, "wholesale_email_retry", actor, `${actor} queued ${queued} dispatch emails for retry${acknowledgeUnknown ? " after reviewing uncertain delivery" : ""}.`);
  return queued;
}
