// How unbilled orders are paired with invoices raised by hand in QuickBooks (src/invoicing/quickbooksMatches.ts). Import-free
// so the rules can be tested on their own.
const DAY = 86400000;
const nameKey = (value: unknown) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const londonDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });
export const ukDay = (at: number) => londonDate.format(at);
export const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") + days * DAY).toISOString().slice(0, 10);

export interface OrderRow {
  id: string; version: number; customerId: string; customerVersion?: number; business: string; quickbooksName: string | null;
  totalPence: number; createdAt: number; dispatchedAt: number | null; onTab: number;
}
export interface Remote { id: string; number: string; date: string; totalPence: number; customerId: string; customerName: string; balancePence: number | null; currency?: string }
export interface Suggestion {
  orderId: string; version: number; customerId: string; business: string; totalPence: number; createdAt: number;
  dispatchedAt: number | null; onTab: boolean; match: "exact" | "amount" | "none"; invoice: Remote | null;
}
export const orderWindow = (order: OrderRow, today: string) => ({ from: shift(ukDay(order.createdAt), -1),
  to: shift(order.dispatchedAt ? ukDay(order.dispatchedAt) : today, 14) });

type CustomerName = Pick<OrderRow, "customerId" | "quickbooksName" | "business">;
const namesOf = (customer: CustomerName) => [...new Set([nameKey(customer.quickbooksName), nameKey(customer.business)].filter(Boolean))];

function addOwner(owners: Map<string, Set<string>>, name: string, id: string) {
  if (!name || !id) return;
  if (!owners.has(name)) owners.set(name, new Set());
  owners.get(name)!.add(id);
}

function firstDate(invoices: Remote[], from: string) {
  let low = 0, high = invoices.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (invoices[middle].date < from) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Exact totals take priority. A different total is offered for manual review. */
export function pairUp(orders: OrderRow[], invoices: Remote[], links: Record<string, string>, used: Set<string>, today: string, customers: CustomerName[] = orders): Suggestion[] {
  const taken = new Set(used);
  const localOwners = new Map<string, Set<string>>(), remoteOwners = new Map<string, Set<string>>();
  for (const customer of customers) for (const name of namesOf(customer)) addOwner(localOwners, name, customer.customerId);
  const linked = new Set(Object.values(links));
  const byCustomer = new Map<string, Remote[]>();
  const remoteNames = new Map<string, string>();
  for (const invoice of [...invoices].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const name = nameKey(invoice.customerName);
    remoteNames.set(invoice.id, name);
    addOwner(remoteOwners, name, invoice.customerId);
    if (!invoice.customerId || !Number.isSafeInteger(invoice.totalPence) || invoice.totalPence <= 0 || (invoice.currency !== undefined && invoice.currency !== "GBP")) continue;
    if (!byCustomer.has(invoice.customerId)) byCustomer.set(invoice.customerId, []);
    byCustomer.get(invoice.customerId)!.push(invoice);
  }
  const fallbackOwners = new Map<string, Set<string>>();
  for (const [name, ids] of remoteOwners) {
    for (const id of ids) for (const local of localOwners.get(name) ?? []) addOwner(fallbackOwners, id, local);
  }
  const prepared = orders.map(order => {
    let customerId = links[order.customerId];
    let acceptedNames: Set<string> | null = null;
    if (!customerId) {
      const names = namesOf(order);
      const owners = new Set(names.flatMap(name => [...(remoteOwners.get(name) || [])]));
      if (owners.size === 1 && names.every(name => localOwners.get(name)?.size === 1)) {
        const [owner] = owners;
        if (!linked.has(owner) && fallbackOwners.get(owner)?.size === 1) {
          customerId = owner;
          acceptedNames = new Set(names);
        }
      }
    }
    const candidates = byCustomer.get(customerId) || [];
    const { from, to } = orderWindow(order, today);
    return { order, candidates, acceptedNames, first: firstDate(candidates, from), to };
  });
  const chosen = new Map<string, { match: "exact" | "amount"; invoice: Remote }>();
  for (const exact of [true, false]) {
    for (const { order, candidates, acceptedNames, first, to } of prepared) {
      if (chosen.has(order.id)) continue;
      for (let i = first; i < candidates.length && candidates[i].date <= to; i++) {
        const invoice = candidates[i];
        if (taken.has(invoice.id) || (acceptedNames && !acceptedNames.has(remoteNames.get(invoice.id)!)) ||
          (exact && invoice.totalPence !== order.totalPence)) continue;
        taken.add(invoice.id);
        chosen.set(order.id, { match: exact ? "exact" : "amount", invoice });
        break;
      }
    }
  }
  return orders.map(order => {
    const pick = chosen.get(order.id);
    return { orderId: order.id, version: order.version, customerId: order.customerId, business: order.business, totalPence: order.totalPence,
      createdAt: order.createdAt, dispatchedAt: order.dispatchedAt || null, onTab: !!order.onTab, match: pick?.match || "none", invoice: pick?.invoice || null };
  });
}

