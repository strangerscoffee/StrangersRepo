// A Slack post for every new customer wholesale order, in the channel the SLACK_ORDERS_WEBHOOK_URL secret belongs to
// (a Slack "incoming webhook", made for that one channel; the host adds it in Cloudflare). Business name, a short
// summary of what was ordered and a link to the staff Wholesale orders page; no prices or contact details.
//
// Orders placed in business hours (UK time: 07:45 to 16:45, Sunday 10:00 to 15:30) are posted straight away; the rest
// wait until the hours next start (07:50, Sunday 10:00), so nothing arrives overnight and gets missed. Every post goes
// in slack_order_posts first (migration 20) and the 5-minute cron delivers any that are due, so a post held for the
// morning, or one Slack refused, still goes out. Staff previews and retries of an order already placed post nothing.
import { audit } from "./audit";
import { ApiError, Env } from "./http";
import { buildSlackChange, buildSlackOrder, SlackChange, SlackOrder, slackPostTime } from "./slackOrderText";

export const slackReady = (env: Env) => /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(env.SLACK_ORDERS_WEBHOOK_URL || "")
  || (env.SLACK_TEST_HOOKS === "1" && /^http:\/\/127\.0\.0\.1:\d+\//.test(env.SLACK_ORDERS_WEBHOOK_URL || ""));

const MAX_ATTEMPTS = 6;

async function post(env: Env, body: unknown) {
  const res = await fetch(env.SLACK_ORDERS_WEBHOOK_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
}

/** Sends one queued post if it's still unsent, claiming it first so two runs can't both send it. */
async function deliver(env: Env, row: { order_id: string; payload: string; attempts: number }) {
  const now = Date.now(), token = crypto.randomUUID();
  const claim = await env.DB.batch([
    env.DB.prepare("INSERT INTO slack_order_delivery(order_id,state,claim_token,lease_until,attempted_at,updated_at) SELECT ?,'sending',?,?,?,? WHERE EXISTS(SELECT 1 FROM slack_order_posts WHERE order_id=? AND sent_at IS NULL AND attempts=?) ON CONFLICT(order_id) DO UPDATE SET state='sending',claim_token=excluded.claim_token,lease_until=excluded.lease_until,attempted_at=excluded.attempted_at,updated_at=excluded.updated_at WHERE slack_order_delivery.state='queued' AND EXISTS(SELECT 1 FROM slack_order_posts WHERE order_id=? AND sent_at IS NULL AND attempts=?)")
      .bind(row.order_id, token, now + 120000, now, now, row.order_id, row.attempts, row.order_id, row.attempts),
    env.DB.prepare("UPDATE slack_order_posts SET attempts=attempts+1 WHERE order_id=? AND sent_at IS NULL AND attempts=? AND EXISTS(SELECT 1 FROM slack_order_delivery WHERE order_id=? AND claim_token=?)")
      .bind(row.order_id, row.attempts, row.order_id, token),
  ]);
  if (!claim[1].meta.changes) return;
  let started = false, rejected = false;
  try {
    const body = JSON.parse(row.payload); started = true;
    const response = await fetch(env.SLACK_ORDERS_WEBHOOK_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!response.ok) { rejected = true; throw new Error(`Slack answered ${response.status}: ${(await response.text()).slice(0, 120)}`); }
    await env.DB.batch([
      env.DB.prepare("UPDATE slack_order_posts SET sent_at=?,last_error=NULL WHERE order_id=? AND EXISTS(SELECT 1 FROM slack_order_delivery WHERE order_id=? AND claim_token=?)").bind(Date.now(), row.order_id, row.order_id, token),
      env.DB.prepare("UPDATE slack_order_delivery SET state='sent',claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE order_id=? AND claim_token=?").bind(Date.now(), row.order_id, token),
    ]);
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 200), unknown = started && !rejected;
    const state = unknown ? "unknown" : row.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "queued";
    await env.DB.batch([
      env.DB.prepare("UPDATE slack_order_posts SET last_error=? WHERE order_id=? AND EXISTS(SELECT 1 FROM slack_order_delivery WHERE order_id=? AND claim_token=?)").bind(message, row.order_id, row.order_id, token),
      env.DB.prepare("UPDATE slack_order_delivery SET state=?,claim_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE order_id=? AND claim_token=?").bind(state, message, Date.now(), row.order_id, token),
    ]);
    if (state !== "queued") await audit(env, "slack_failed", null, `Wholesale notification ${row.order_id.split(":")[0]} ${unknown ? "needs delivery review" : "could not be posted"}: ${message}`).catch(() => {});
  }
}

/** A crashed/terminated sender is unknown, never silently marked sent or blindly duplicated. */
export async function reviewExpiredSlackClaims(env: Env) {
  const expired = await env.DB.prepare("UPDATE slack_order_delivery SET state='unknown',claim_token=NULL,lease_until=NULL,last_error='Sending was interrupted. Check the channel before retrying.',updated_at=? WHERE state='sending' AND lease_until<=? RETURNING order_id").bind(Date.now(), Date.now()).all<{ order_id: string }>();
  for (const row of expired.results) await audit(env, "slack_failed", null, `Wholesale notification ${row.order_id.split(":")[0]} needs delivery review after an interrupted send.`).catch(() => {});
}

export async function retrySlackPosts(env: Env, actor: string, acknowledgeUnknown = false) {
  await reviewExpiredSlackClaims(env);
  const rows = await env.DB.prepare("SELECT d.order_id,d.state,d.updated_at FROM slack_order_delivery d JOIN slack_order_posts p ON p.order_id=d.order_id WHERE p.sent_at IS NULL AND ((?=0 AND d.state='failed') OR (?=1 AND d.state='unknown')) ORDER BY d.updated_at LIMIT 25")
    .bind(acknowledgeUnknown ? 1 : 0, acknowledgeUnknown ? 1 : 0).all<{order_id:string;state:string;updated_at:number}>();
  if (!acknowledgeUnknown && !rows.results.length && await env.DB.prepare("SELECT 1 FROM slack_order_delivery WHERE state='unknown' LIMIT 1").first()) throw new ApiError(409, "delivery_unknown", "Check the Slack channel, then explicitly confirm the retry. It may duplicate a post.");
  let queued = 0;
  for (const row of rows.results) {
    const now = Date.now();
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE slack_order_posts SET attempts=0,send_after=?,last_error=NULL WHERE order_id=? AND sent_at IS NULL AND EXISTS(SELECT 1 FROM slack_order_delivery WHERE order_id=? AND state=? AND updated_at=?)").bind(now, row.order_id, row.order_id, row.state, row.updated_at),
      env.DB.prepare("UPDATE slack_order_delivery SET state='queued',claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE order_id=? AND state=? AND updated_at=?").bind(now, row.order_id, row.state, row.updated_at),
    ]);
    queued += result[0].meta.changes;
  }
  if (queued) await audit(env, "wholesale_slack_retry", actor, `${actor} queued ${queued} Slack posts for retry${acknowledgeUnknown ? " after checking the channel" : ""}.`);
  return queued;
}

/** Queues the Slack post for a new customer order and sends it now if it's business hours. Never throws. */
export async function notifySlackNewOrder(env: Env, ctx: ExecutionContext | undefined, order: SlackOrder, diaryBase: string) {
  if (!slackReady(env)) return;
  const run = (async () => {
    try {
      const sendAfter = slackPostTime(order.createdAt);
      const payload = JSON.stringify(buildSlackOrder(order, `${diaryBase.replace(/\/$/, "")}/orders`, sendAfter > order.createdAt));
      await env.DB.prepare("INSERT OR IGNORE INTO slack_order_posts (order_id, payload, send_after, created_at, attempts) VALUES (?, ?, ?, ?, 0)").bind(order.id, payload, sendAfter, Date.now()).run();
      if (sendAfter <= Date.now()) await deliver(env, { order_id: order.id, payload, attempts: 0 });
    } catch (error) {
      await audit(env, "slack_failed", null, `Couldn't post wholesale order ${order.id} to Slack: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
    }
  })();
  if (ctx) ctx.waitUntil(run); else await run;
}

/** Queues (and in business hours sends) a post when a customer changes or skips a standing delivery themselves.
 *  Keyed by order, change and version, so each change posts once. Never throws. */
export async function notifySlackChange(env: Env, ctx: ExecutionContext | undefined, order: SlackChange & { version?: number }, change: "skipped" | "once" | "ongoing", diaryBase: string) {
  if (!slackReady(env)) return;
  const key = `${order.id}:${change}:${order.version ?? Date.now()}`;
  const run = (async () => {
    try {
      const now = Date.now(), sendAfter = slackPostTime(now);
      const payload = JSON.stringify(buildSlackChange(order, change, `${diaryBase.replace(/\/$/, "")}/orders#${encodeURIComponent(order.id)}`, now, sendAfter > now));
      await env.DB.prepare("INSERT OR IGNORE INTO slack_order_posts (order_id, payload, send_after, created_at, attempts) VALUES (?, ?, ?, ?, 0)").bind(key, payload, sendAfter, now).run();
      if (sendAfter <= Date.now()) await deliver(env, { order_id: key, payload, attempts: 0 });
    } catch (error) {
      await audit(env, "slack_failed", null, `Couldn't post a standing order change ${order.id} to Slack: ${String((error as Error)?.message || error).slice(0, 160)}`).catch(() => {});
    }
  })();
  if (ctx) ctx.waitUntil(run); else await run;
}

/** The 5-minute cron: posts held for the morning, and retries of any Slack refused. */
export async function deliverSlackPosts(env: Env) {
  if (!slackReady(env)) return;
  await reviewExpiredSlackClaims(env);
  const due = await env.DB.prepare("SELECT p.order_id,p.payload,p.attempts FROM slack_order_posts p LEFT JOIN slack_order_delivery d ON d.order_id=p.order_id WHERE p.sent_at IS NULL AND p.send_after<=? AND p.attempts<? AND COALESCE(d.state,'queued')='queued' ORDER BY p.send_after,p.order_id LIMIT 25")
    .bind(Date.now(), MAX_ATTEMPTS).all<{ order_id: string; payload: string; attempts: number }>();
  for (const row of due.results) await deliver(env, row);
}

/** Admin: a test post to the channel. */
export async function sendSlackTest(env: Env, diaryBase: string) {
  const sample: SlackOrder = { id: "WS-TEST", business: "Test order (no action needed)", createdAt: Date.now(), delivery: "Roastery collection", grams: 1000, customerNote: "This is a test of the new-order Slack post.", lines: [{ title: "Brazil Fazenda Bom Jesus Natural", pack: "kilo", grindLabel: "Beans", quantity: 1 }] };
  await post(env, buildSlackOrder(sample, `${diaryBase.replace(/\/$/, "")}/orders`, false));
}
