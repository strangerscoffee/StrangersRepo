import { audit } from "../audit";
import type { Env } from "../http";
import { policy } from "../rota/leave/model";
import { loadCtx } from "../rota/load";
import { canOfferOpenShift } from "../rota/problems";
import { londonToday } from "../rota/util";
import { cleanEmail, emailReady, recipients, sendOutcome, wants, weeklySitesOf, type Outgoing } from "./send";
import { rotaSender } from "./sender";

const LEASE_MS = 2 * 60000;
const SAFE_REPLAY_MS = 23 * 3600000;
const DELIVERY_WINDOW_MS = 3 * 86400000;

export interface StaffEmail {
  outgoing: Outgoing;
  role?: string;
  notice?: { yearFrom: string; stage: string };
  open?: { week: string; shiftIds: string[] };
}

interface Row {
  event_key: string; user_id: string; payload: string; attempts: number;
  first_attempt_at: number | null; uncertain: number; expires_at: number;
}
type Payload = StaffEmail & { deliveryKey?: string };
type State = "sent" | "retry" | "failed" | "unknown" | "skipped";

/** The preceding statement must commit the publication or scheduled run. */
export function enqueueStaffEmails(env: Env, batchKey: string, jobs: StaffEmail[], scope = batchKey) {
  const now = Date.now();
  return env.DB.prepare(`INSERT INTO staff_email_outbox
    (event_key,batch_key,scope,user_id,kind,payload,created_at,next_attempt_at,expires_at)
    SELECT ? || ':' || key, ?, ?, json_extract(value,'$.outgoing.to.id'), json_extract(value,'$.outgoing.kind'), value, ?, ?, ?
    FROM json_each(?) WHERE changes() = 1`)
    .bind(batchKey, batchKey, scope, now, now, now + DELIVERY_WINDOW_MS, JSON.stringify(jobs));
}

async function finish(env: Env, row: Row, token: string, job: Payload, state: State, detail: string, uncertain: boolean, next = Date.now()) {
  const at = Date.now(), sent = state === "sent";
  const updates = [env.DB.prepare(`UPDATE staff_email_outbox SET state=?,last_error=?,next_attempt_at=?,sent_at=?,uncertain=?,
    lease_until=NULL,claim_token=NULL,payload=CASE WHEN ?='retry' THEN payload ELSE '{}' END WHERE event_key=? AND claim_token=?`)
    .bind(state, detail || null, next, sent ? at : null, uncertain ? 1 : 0, state, row.event_key, token)];
  if (job.notice) {
    const status = sent ? "accepted" : state === "retry" ? "retrying" : state;
    updates.push(env.DB.prepare(`UPDATE rota_leave_notices SET data=json_set(data,'$.emailed',?,'$.emailAt',?)
      WHERE user_id=? AND year_from=? AND stage=? AND changes()=1`)
      .bind(status, at, row.user_id, job.notice.yearFrom, job.notice.stage));
  }
  await env.DB.batch(updates);
}

/** Deliver due mail from a publication or scheduled run. Expired leases are picked up by the next run. */
export async function deliverStaffEmails(env: Env, batchKey?: string): Promise<number> {
  const now = Date.now();
  const rows = await env.DB.prepare(`SELECT event_key,user_id,payload,attempts,first_attempt_at,uncertain,expires_at
    FROM staff_email_outbox WHERE state IN ('queued','retry','sending') AND next_attempt_at<=? AND COALESCE(lease_until,0)<=?
    AND (? IS NULL OR batch_key=?) ORDER BY next_attempt_at,created_at,event_key LIMIT 25`)
    .bind(now, now, batchKey || null, batchKey || null).all<Row>();
  let accepted = 0;
  for (const row of rows.results) {
    const token = crypto.randomUUID(), at = Date.now();
    const claimed = await env.DB.prepare(`UPDATE staff_email_outbox SET state='sending',attempts=attempts+1,claim_token=?,lease_until=?
      WHERE event_key=? AND attempts=? AND state IN ('queued','retry','sending') AND COALESCE(lease_until,0)<=?`)
      .bind(token, at + LEASE_MS, row.event_key, row.attempts, at).run();
    if (!claimed.meta.changes) continue;
    const job = JSON.parse(row.payload) as Payload;
    const outgoing = job.outgoing, key = job.deliveryKey || row.event_key;
    if (row.first_attempt_at && await env.DB.prepare("SELECT 1 FROM email_delivery_messages WHERE id=?").bind(key).first()) {
      await finish(env, row, token, job, "sent", "", false);
      accepted++;
      continue;
    }
    const recipient = (await recipients(env, [row.user_id])).get(row.user_id);
    const email = cleanEmail(recipient?.email);
    const kind = outgoing.kind;
    const enabled = kind !== "test" && kind !== "order" && (job.notice?.stage === "final" || wants(recipient, kind));
    let reason = "";
    let state: "failed" | "unknown" | "skipped" = "skipped";
    if (row.uncertain && row.first_attempt_at && (at - row.first_attempt_at > SAFE_REPLAY_MS || outgoing.to.email !== email)) {
      state = "unknown";
      reason = "A previous attempt could not be confirmed. Check Email health before sending again.";
    } else if (row.expires_at <= at) {
      state = row.uncertain ? "unknown" : "failed";
      reason = "The delivery window expired.";
    } else if (!recipient?.active || !email || !enabled || (job.role && recipient.role !== job.role)) {
      reason = "The recipient or their email preferences changed.";
    } else if (kind === "weekly" && weeklySitesOf(recipient.email_prefs).join() !== weeklySitesOf(outgoing.to.email_prefs).join()) {
      reason = "The recipient changed their summary sites.";
    } else if ((job.notice || (kind === "holiday" && job.role)) && (await policy(env)).settings.reminders === false) {
      reason = "Holiday reminders were switched off.";
    } else if (job.open) {
      const ctx = await loadCtx(env, job.open.week), person = ctx.people.get(row.user_id), today = londonToday();
      const available = new Set(person ? ctx.shifts.filter(shift => shift.day >= today && canOfferOpenShift(ctx, person, shift)).map(shift => shift.id) : []);
      if (!job.open.shiftIds.every(id => available.has(id))) reason = "The open shifts or the recipient's availability changed.";
    }
    if (reason) {
      await finish(env, row, token, job, state, reason, !!row.uncertain);
      await audit(env, state === "skipped" ? "email_skipped" : "email_failed", null, `${outgoing.about} for ${outgoing.to.name}. ${reason}`);
      continue;
    }
    if (!emailReady(env) || !email) {
      await finish(env, row, token, job, "retry", "Email is temporarily unavailable.", !!row.uncertain, at + 30 * 60000);
      continue;
    }
    if (outgoing.to.email !== email) {
      outgoing.to.email = email;
      job.deliveryKey = `${row.event_key}:${crypto.randomUUID()}`;
    }
    outgoing.from ||= rotaSender(env);
    // Persist the exact envelope and key before making an external request. An interrupted attempt can be retried safely.
    const deliveryKey = job.deliveryKey || row.event_key;
    const started = await env.DB.prepare(`UPDATE staff_email_outbox SET payload=?,uncertain=1,first_attempt_at=?
      WHERE event_key=? AND claim_token=?`)
      .bind(JSON.stringify(job), deliveryKey === key ? row.first_attempt_at ?? at : at, row.event_key, token).run();
    if (!started.meta.changes) continue;
    const outcome = await sendOutcome(env, outgoing, deliveryKey);
    if (outcome.status === "sent") {
      await finish(env, row, token, job, "sent", "", false);
      accepted++;
    } else {
      const uncertain = !!outcome.uncertain || !!row.uncertain;
      const next = at + (outcome.status === "limit" ? 30 : Math.min(60, 2 ** row.attempts)) * 60000;
      await finish(env, row, token, job, outcome.permanent ? uncertain ? "unknown" : "failed" : "retry",
        outcome.status === "limit" ? "Daily email limit reached." : "Provider acceptance could not be confirmed.", uncertain, next);
    }
  }
  return accepted;
}
