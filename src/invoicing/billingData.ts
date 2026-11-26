import { ukDay } from "../insightsMath";
import { invalid } from "../http";
import { cleanEmail } from "../email/address";
import type { Customer } from "../wholesaleAccounts";

export const day = () => ukDay(Date.now());
export const month = () => day().slice(0, 7);
export const money = (pence: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const zoneOffset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "longOffset" });
function midnight(date: string) {
  const utc = Date.parse(date + "T00:00:00Z");
  const offset = zoneOffset.formatToParts(utc).find(value => value.type === "timeZoneName")?.value;
  const sign = offset?.startsWith("GMT-") ? -1 : 1;
  const [hours, minutes] = (offset?.slice(4) || "0:0").split(":").map(Number);
  return utc - sign * (hours * 60 + (minutes || 0)) * 60000;
}
export function periodOf(value: unknown) {
  if (typeof value !== "string" || !/^(?:19|20|21)\d\d-(0[1-9]|1[0-2])$/.test(value) || value > month()) {
    throw invalid("Choose a current or earlier billing month.");
  }
  const start = value + "-01";
  const next = new Date(Date.parse(start + "T00:00:00Z") + 32 * 86400000).toISOString().slice(0, 7) + "-01";
  return { key: value, start, next, from: midnight(start), until: midnight(next), closed: next <= day() };
}

export function accountsEmail(customer: Customer) {
  return cleanEmail(customer.accountsEmail?.trim() || customer.email || "") || "";
}

export const DISPATCHED = "CAST(json_extract(o.data,'$.dispatchedAt') AS INTEGER)";
export const CUSTOMER = "json_extract(o.data,'$.customerId')";
export const UNBILLED_ORDERS = `FROM wholesale_preview o
  JOIN wholesale_preview c ON c.kind='customer' AND c.id=${CUSTOMER}
  LEFT JOIN wholesale_invoice_accounts a ON a.customer_id=c.id
  WHERE o.kind='order' AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.status')='Dispatched'
    AND json_extract(o.data,'$.deletedAt') IS NULL AND COALESCE(json_extract(c.data,'$.hidePrices'),0)=0 AND COALESCE(json_extract(c.data,'$.noInvoice'),0)=0
    AND NOT EXISTS(SELECT 1 FROM wholesale_billed_orders covered WHERE covered.order_id=o.id)`;
export const OUTSIDE_TAB = "json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL";
