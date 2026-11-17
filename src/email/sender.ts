import type { Env } from "../http";
export const DEFAULT_ORDER_SENDER = "Strangers Wholesale <orders@staffstrangerscoffee.com>";
export function orderSender(env: Env) { return env.ORDER_EMAIL_FROM || DEFAULT_ORDER_SENDER; }
