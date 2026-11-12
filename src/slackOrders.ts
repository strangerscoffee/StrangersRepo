// A Slack post for every new customer wholesale order, in the channel the SLACK_ORDERS_WEBHOOK_URL secret belongs to
// (a Slack "incoming webhook", made for that one channel; the host adds it in Cloudflare). Business name, a short
// summary of what was ordered and a link to the staff Wholesale orders page; no prices or contact details.
//
// Orders placed in business hours (UK time: 07:45 to 16:45, Sunday 10:00 to 15:30) are posted straight away; the rest
// wait until the hours next start (07:50, Sunday 10:00), so nothing arrives overnight and gets missed. Every post goes
// in slack_order_posts first (migration 20) and the 5-minute cron delivers any that are due, so a post held for the
// morning, or one Slack refused, still goes out. Staff previews and retries of an order already placed post nothing.
import { audit } from "./audit";
import { Env } from "./http";
import { buildSlackOrder, SlackOrder, slackPostTime } from "./slackOrderText";

export const slackReady = (env: Env) => /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(env.SLACK_ORDERS_WEBHOOK_URL || "")
  || (env.SLACK_TEST_HOOKS === "1" && /^http:\/\/127\.0\.0\.1:\d+\//.test(env.SLACK_ORDERS_WEBHOOK_URL || ""));

const MAX_ATTEMPTS = 6;

async function post(env: Env, body: unknown) {
  const res = await fetch(env.SLACK_ORDERS_WEBHOOK_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
}

/** Sends one queued post if it's still unsent, claiming it first so two runs can't both send it. */
async function deliver(env: Env, row: { order_id: string; payload: string; attempts: number }) {
  const now = Date.now();
  const claimed = await env.DB.prepare("UPDATE slack_order_posts SET sent_at = ?, attempts = attempts + 1 WHERE order_id = ? AND sent_at IS NULL AND attempts = ?").bind(now, row.order_id, row.attempts).run();
  if (!claimed.meta.changes) return;
  try { await post(env, JSON.parse(row.payload)); }
  catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 200);
    await env.DB.prepare("UPDATE slack_order_posts SET sent_at = NULL, last_error = ? WHERE order_id = ?").bind(message, row.order_id).run();
    if (row.attempts + 1 >= MAX_ATTEMPTS) await audit(env, "slack_failed", null, `Couldn't post wholesale order ${row.order_id} to Slack: ${message}`).catch(() => {});
  }
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

/** The 5-minute cron: posts held for the morning, and retries of any Slack refused. */
export async function deliverSlackPosts(env: Env) {
  if (!slackReady(env)) return;
  const due = await env.DB.prepare("SELECT order_id, payload, attempts FROM slack_order_posts WHERE sent_at IS NULL AND send_after <= ? AND attempts < ? ORDER BY send_after, order_id LIMIT 25")
    .bind(Date.now(), MAX_ATTEMPTS).all<{ order_id: string; payload: string; attempts: number }>();
  for (const row of due.results) await deliver(env, row);
}

/** Admin: a test post to the channel. */
export async function sendSlackTest(env: Env, diaryBase: string) {
  const sample: SlackOrder = { id: "WS-TEST", business: "Test order (no action needed)", createdAt: Date.now(), delivery: "Roastery collection", grams: 1000, customerNote: "This is a test of the new-order Slack post.", lines: [{ title: "Brazil Fazenda Bom Jesus Natural", pack: "kilo", grindLabel: "Beans", quantity: 1 }] };
  await post(env, buildSlackOrder(sample, `${diaryBase.replace(/\/$/, "")}/orders`, false));
}
