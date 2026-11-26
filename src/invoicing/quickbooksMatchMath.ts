// How unbilled orders are paired with invoices raised by hand in QuickBooks (src/invoicing/quickbooksMatches.ts). Import-free
// so the rules can be tested on their own.
const DAY = 86400000;
const nameKey = (value: unknown) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const ukDay = (at: number) => new Date(at).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
export const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") + days * DAY).toISOString().slice(0, 10);

export interface OrderRow {
  id: string; version: number; customerId: string; business: string; quickbooksName: string | null;
  totalPence: number; createdAt: number; dispatchedAt: number | null; onTab: number;
}
export interface Remote { id: string; number: string; date: string; totalPence: number; customerId: string; customerName: string; balancePence: number }
export interface Suggestion {
  orderId: string; version: number; customerId: string; business: string; totalPence: number; createdAt: number;
  dispatchedAt: number | null; onTab: boolean; match: "exact" | "amount" | "none"; invoice: Remote | null;
}

/** Pairs each unbilled order with at most one QuickBooks invoice, each invoice used once: exact totals first (earliest
 * invoice dated from the day before the order to two weeks after it went out), then the nearest by date with a
 * different total, offered unticked for an admin to check. */
export function pairUp(orders: OrderRow[], invoices: Remote[], links: Record<string, string>, used: Set<string>, today: string): Suggestion[] {
  const taken = new Set(used);
  const byDate = [...invoices].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const belongs = (order: OrderRow, invoice: Remote) => {
    const names = new Set([nameKey(order.quickbooksName), nameKey(order.business)].filter(Boolean));
    return (!!links[order.customerId] && links[order.customerId] === invoice.customerId) || names.has(nameKey(invoice.customerName));
  };
  const inWindow = (order: OrderRow, invoice: Remote) => invoice.date >= shift(ukDay(order.createdAt), -1)
    && invoice.date <= shift(order.dispatchedAt ? ukDay(order.dispatchedAt) : today, 14);
  const chosen = new Map<string, { match: "exact" | "amount"; invoice: Remote }>();
  for (const exact of [true, false]) {
    for (const order of orders) {
      if (chosen.has(order.id)) continue;
      const invoice = byDate.find(candidate => !taken.has(candidate.id) && candidate.totalPence > 0 && belongs(order, candidate) && inWindow(order, candidate)
        && (exact ? candidate.totalPence === order.totalPence : true));
      if (invoice) { taken.add(invoice.id); chosen.set(order.id, { match: exact ? "exact" : "amount", invoice }); }
    }
  }
  return orders.map(order => {
    const pick = chosen.get(order.id);
    return { orderId: order.id, version: order.version, customerId: order.customerId, business: order.business, totalPence: order.totalPence,
      createdAt: order.createdAt, dispatchedAt: order.dispatchedAt || null, onTab: !!order.onTab, match: pick?.match || "none", invoice: pick?.invoice || null };
  });
}

