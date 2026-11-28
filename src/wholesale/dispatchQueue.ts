import "../../public/shared/wholesale-preparation.js";
import { type Env, invalid, json } from "../http";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "../royalMailAppSettings";
import { savedRoyalMailRecipient } from "../royalMailDestination";
import { shippingFingerprint } from "../wholesaleRoyalMail";
import { DISPATCH_QUEUE_BATCH } from "./dispatchQueueCandidates";
import { labelEligibilityClock, labelEligibilityQuery } from "./staffLabelEligibility";

const labels = {
  weigh: "Weigh parcel", print: "Print label", handover: "Awaiting handover",
  attention: "Needs attention", checking: "Checking with Royal Mail",
};
type Stage = keyof typeof labels;
type Role = "staff" | "admin";
type Action = "shipping" | "handover" | "account" | "settings";
type Next = { stage: Stage; action: Action; actionLabel: string; reason: string };
type Candidate = {
  id: string; version: number; sort_day: string; reference: string; destination: string; block_code: string | null;
  state: string | null; requested_at: number | null; provider_id: number | null; review_required: number | null; label_downloaded_at: number | null;
  lookup_refused: number | null; has_problem: number | null;
  recovery_due_at: number | null; order_version: number | null; shipping_fingerprint: string | null;
};

const holdReasons: Record<string, string> = {
  royal_mail_account_on_hold: "The customer account is on hold.",
  royal_mail_account_overdue: "An overdue payment needs review.",
  royal_mail_payment_required: "Payment for this order needs confirmation.",
};
const readSize = 100;

function readParams(url: URL) {
  const stage = url.searchParams.get("stage") ?? "all";
  if (stage !== "all" && !Object.hasOwn(labels, stage)) throw invalid("Choose a dispatch queue stage.");
  const rawLimit = url.searchParams.get("limit") ?? "40";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > 100) throw invalid("Choose between 1 and 100 parcels.");
  const cursor = url.searchParams.get("cursor");
  let after: { day: string; id: string } | undefined;
  if (cursor !== null) {
    const match = /^(all|weigh|print|handover|attention|checking):(\d{4}-\d{2}-\d{2}):(WS-[A-F0-9]{32})$/.exec(cursor);
    if (!match || match[1] !== stage) throw invalid("Reload the dispatch queue before loading more parcels.");
    after = { day: match[2], id: match[3] };
  }
  return { stage, limit, after };
}

// Only ready deliveries are read. One D1 statement gathers all local shipment and finance
// evidence for each slice. Whole orders, recipients and invoice metadata never leave the Worker.
function candidates(env: Env, after: string, clock: (string | number)[]) {
  return env.DB.prepare(`
    WITH batch AS MATERIALIZED (${DISPATCH_QUEUE_BATCH}), eligibility AS (
      ${labelEligibilityQuery("SELECT id,customer FROM batch")}
    )
    SELECT b.id,b.version,b.sort_day,COALESCE(json_extract(b.data,'$.reference'),'') AS reference,e.block_code,
      json_object('business',json_extract(b.data,'$.business'),'customerId',b.customer,
        'locationId',json_extract(b.data,'$.locationId'),'delivery',json_extract(b.data,'$.delivery'),
        'grams',json_extract(b.data,'$.grams'),'locationSnapshot',json_extract(b.data,'$.locationSnapshot'),
        'customerSnapshot',json_extract(b.data,'$.customerSnapshot'),
        'lines',CASE WHEN s.state IS NULL OR s.state='failed' OR (s.shipping_fingerprint IS NOT NULL AND s.order_version<>b.version)
          THEN json_extract(b.data,'$.lines') END) AS destination,
      s.state,s.requested_at,s.provider_id,s.review_required,s.label_downloaded_at,s.recovery_due_at,s.order_version,s.shipping_fingerprint,
      instr(s.problem,'Royal Mail rejected the order-reference lookup.')=1 AS lookup_refused,
      length(s.problem)>0 AS has_problem
    FROM batch b JOIN eligibility e ON e.order_id=b.id
    LEFT JOIN wholesale_royal_mail_shipments s ON s.order_id=b.id
    ORDER BY b.sort_day,b.id`).bind(after, readSize, ...clock).all<Candidate>();
}

type Destination = Parameters<typeof shippingFingerprint>[0];
type Booking = { enabled: boolean; configured: boolean; hasKey: boolean };
async function nextAction(
  row: Candidate, order: Destination, role: Role, booking: Booking,
): Promise<Next> {
  const attention = (reason: string, adminAction: Action = "shipping", adminLabel = "Review shipment"): Next => ({
    stage: "attention", action: role === "admin" ? adminAction : "shipping",
    actionLabel: role === "admin" ? adminLabel : "View details", reason,
  });
  if (!row.provider_id && (row.state === "booking" || row.state === "review")) {
    if (row.recovery_due_at === 0) return attention("Royal Mail has not confirmed the booking. Admin needs to check the original reference.");
    return { stage: "checking", action: "shipping", actionLabel: "View request", reason: "Checking the original booking before another label can be requested." };
  }
  if (row.block_code) return attention(holdReasons[row.block_code] ?? "Payment eligibility needs review.", "account", "Review account");
  if (row.state && row.state !== "failed") {
    if (row.review_required || !row.provider_id) return attention("The original shipment needs verification in Click & Drop.");
    if (row.order_version !== row.version && (!row.shipping_fingerprint || await shippingFingerprint(order) !== row.shipping_fingerprint)) {
      return attention("The order changed after booking. Check the label before handover.");
    }
    if (row.state === "created" && row.has_problem) return attention("Royal Mail booked the order. Review the label problem in Click & Drop.", "shipping", "Review label");
    if (row.state !== "labelled" && row.state !== "dispatched") return attention("Royal Mail has the booking. Complete or check the label in Click & Drop.");
    if (row.label_downloaded_at) return { stage: "handover", action: "handover", actionLabel: "Review handover", reason: "Label downloaded. Confirm once the parcel has been handed over." };
    if (!booking.hasKey) return attention("The Click & Drop connection is unavailable.", "settings", "Review settings");
    return { stage: "print", action: "shipping", actionLabel: "Open label", reason: "The label is ready to download and print." };
  }
  if (row.state === "failed" && !row.provider_id && !row.requested_at && row.lookup_refused) {
    if (row.requested_at === null) {
      return { stage: "attention", action: "shipping", actionLabel: "Check label request", reason: "The original postage outcome is unconfirmed. Check the earlier label request." };
    }
    return attention("The order-reference check failed. Find the original reference in Click & Drop.", "shipping", "Review booking");
  }
  if (row.state === "failed" && row.requested_at) return attention("Royal Mail declined this booking. Review the parcel details before retrying.");
  if (!savedRoyalMailRecipient(order)) return attention("The saved delivery address needs review.", "shipping", "Review address");
  if (!Number.isSafeInteger(order.grams)) return attention("The order needs a parcel weight review before postage can be booked.");
  if (globalThis.SCWholesalePreparation.tooHeavyForOneParcel(order)) {
    return attention("The estimated packed weight exceeds 30 kg. Split the order into boxes in Click & Drop.", "shipping", "Review parcel");
  }
  if (!booking.configured || !booking.enabled) return attention(booking.configured ? "New Royal Mail bookings are paused." : "Royal Mail booking setup is incomplete.", "settings", "Review settings");
  return { stage: "weigh", action: "shipping", actionLabel: "Review parcel", reason: row.state === "failed" ? "The last booking failed. Review the parcel before trying again." : "Confirm the sealed parcel weight and destination." };
}

export async function dispatchQueue(req: Request, env: Env, role: Role) {
  if (req.method !== "GET") {
    return json({ code: "method_not_allowed", message: "Use GET to read the dispatch queue." }, 405, { Allow: "GET" });
  }
  const { stage, limit, after } = readParams(new URL(req.url));
  const policy = await readRoyalMailPolicy(env);
  const connections = await loadRoyalMailConnections(env, policy);
  const booking = { configured: connections.bookingConfigured, enabled: policy.enabled === 1, hasKey: !!connections.booking.key };
  const clock = labelEligibilityClock();
  const counts: Record<Stage, number> = { weigh: 0, print: 0, handover: 0, attention: 0, checking: 0 };
  const orders = [];
  let sliceEnd = "";
  let pageEnd: string | null = null;
  let hasMore = false;
  // Counts apply to the entire live queue, including stages filtered out on this page.
  // Hold only one bounded slice and the requested visible page in memory.
  for (;;) {
    const { results } = await candidates(env, sliceEnd, clock);
    for (const row of results) {
      const order: Destination = JSON.parse(row.destination);
      const next = await nextAction(row, order, role, booking);
      counts[next.stage]++;
      if (stage !== "all" && next.stage !== stage) continue;
      if (after && (row.sort_day < after.day || row.sort_day === after.day && row.id <= after.id)) continue;
      if (orders.length >= limit) {
        hasMore = true;
        continue;
      }
      orders.push({
        id: row.id, version: row.version, business: order.business, reference: row.reference,
        dispatchDate: row.sort_day === "9999-12-31" ? "" : row.sort_day, ...next, stageLabel: labels[next.stage],
        ...(role === "admin" ? { customerId: order.customerId } : {}),
      });
      pageEnd = `${stage}:${row.sort_day}:${row.id}`;
    }
    if (results.length < readSize) break;
    const last = results[results.length - 1];
    sliceEnd = last.sort_day + ":" + last.id;
  }
  return json({ orders, counts, nextCursor: hasMore ? pageEnd : null });
}
