// The new-order Slack post's timing and text (src/slackOrders.ts sends it). No imports, so tests load it directly.
const OPEN = 7 * 60 + 45, CLOSE = 16 * 60 + 45, POST_AT = 7 * 60 + 50; // minutes after midnight, UK time

/** UK date and minutes past midnight of a moment. */
function london(at: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
/** The moment it is `minutes` past midnight, UK time, on a UK date (handles GMT and BST). */
function londonMoment(date: string, minutes: number) {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
  for (const offset of [0, 60, -60]) {
    const at = guess - offset * 60000, seen = london(at);
    if (seen.date === date && seen.minutes === minutes) return at;
  }
  return guess - 60 * 60000;
}
const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** When an order placed at `at` should reach Slack: now within 07:45–16:45 UK time, otherwise 07:50 next morning. */
export function slackPostTime(at: number): number {
  const { date, minutes } = london(at);
  if (minutes >= OPEN && minutes <= CLOSE) return at;
  return londonMoment(minutes < OPEN ? date : nextDay(date), POST_AT);
}

interface Line { title: string; pack: string; packLabel?: string; grindLabel?: string; quantity: number; decaf?: boolean }
export interface SlackOrder {
  id: string; business?: string; createdAt: number; delivery: string; reference?: string; customerNote?: string; grams: number; lines: Line[];
  locationSnapshot?: { name?: string; postcode?: string } | null; customerSnapshot?: { postcode?: string } | null;
}
// Slack's own escaping for message text: everything else is shown as typed.
const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const packName: Record<string, string> = { quarter: "250 g", kilo: "1 kg", half: "500 g" };
const kg = (grams: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
const placed = (at: number) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(at));

export function buildSlackOrder(order: SlackOrder, ordersUrl: string, held: boolean) {
  const business = order.business || "A customer";
  const bags = { quarter: 0, kilo: 0, all: 0 };
  for (const l of order.lines) { if (l.pack === "quarter" || l.pack === "kilo") bags[l.pack] += l.quantity; bags.all += l.quantity; }
  const place = order.locationSnapshot?.name && order.locationSnapshot.name !== "Main location" ? order.locationSnapshot.name : "";
  const postcode = order.locationSnapshot?.postcode || order.customerSnapshot?.postcode || "";
  const fulfil = order.delivery === "Delivery" ? `Delivery${[place, postcode].filter(Boolean).length ? ` to ${[place, postcode].filter(Boolean).join(", ")}` : ""}` : "Roastery collection";
  const sizes = [bags.quarter ? `${bags.quarter} × 250 g` : "", bags.kilo ? `${bags.kilo} × 1 kg` : ""].filter(Boolean).join(" + ");
  const lines = order.lines.map((l) => `• *${l.quantity}* × ${esc(l.title)} · ${esc(packName[l.pack] || l.packLabel || l.pack)} · ${esc(l.grindLabel || "Beans")}${l.decaf ? " · decaf" : ""}`);
  const note = order.customerNote ? `\n>${esc(order.customerNote).replace(/\n/g, "\n>")}` : "";
  const text = [
    `:coffee: *New wholesale order: ${esc(business)}*`,
    `${esc(order.id)} · placed ${esc(placed(order.createdAt))}${held ? " (overnight, posted this morning)" : ""}${order.reference ? ` · ref ${esc(order.reference)}` : ""}`,
    `*${bags.all} ${bags.all === 1 ? "bag" : "bags"}* (${sizes || "no bags"}) · ${kg(order.grams)} · ${esc(fulfil)}`,
    ...lines,
  ].join("\n") + note + `\n<${ordersUrl}|Open wholesale orders>`;
  return { text, unfurl_links: false, unfurl_media: false };
}
