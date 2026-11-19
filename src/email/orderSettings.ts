import type { Env } from "../http";
import { slackReady } from "../slackOrders";
import { get } from "../wholesaleStore";
import { cleanEmail } from "./address";
import { emailReady } from "./send";
import { orderSender } from "./sender";

export const DEFAULT_ORDER_EMAIL = "sales@strangerscoffee.com";

interface OrderEmailSettings { enabled: boolean; to: string[]; confirmCustomers?: boolean }

export async function orderEmailSettings(env: Env) {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_order_emails WHERE id = 1").first<{ data: string; version: number; updated_at: number }>();
  let saved: Partial<OrderEmailSettings> = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch {}
  return {
    enabled: saved.enabled !== false, confirmCustomers: saved.confirmCustomers !== false,
    to: Array.isArray(saved.to) && saved.to.length ? saved.to : [DEFAULT_ORDER_EMAIL],
    version: row?.version || 0, updatedAt: row?.updated_at || null, sending: emailReady(env),
    from: orderSender(env).replace(/^.*<|>$/g, ""), slack: slackReady(env),
  };
}

/** Shipping details are frozen on an order. Email goes to the current main contact for its business. */
export async function orderEmailAddress(env: Env, customerId?: string | null) {
  const customer = customerId ? await get<{ email?: string }>(env, "customer", customerId) : null;
  return cleanEmail(customer?.email);
}
