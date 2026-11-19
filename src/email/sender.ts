import type { Env } from "../http";
export const DEFAULT_ORDER_SENDER = "Strangers Wholesale <orders@staffstrangerscoffee.com>";
export function orderSender(env: Env) { return env.ORDER_EMAIL_FROM || DEFAULT_ORDER_SENDER; }
export function rotaSender(env: Env) { return env.EMAIL_FROM || "Strangers Rota <rota@staffstrangerscoffee.com>"; }
export function isWholesaleEmail(message: { kind: string; from?: string }) {
  return message.kind === "order" || (message.kind === "test" && !!message.from);
}
