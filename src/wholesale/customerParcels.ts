import { isWholesaleDelivery } from "../../public/wholesale/shipping.js";
import type { Env } from "../http";
import { royalMailScanState } from "../royalMailScanState";
import { shippingFingerprint } from "../wholesaleRoyalMail";

type Order = Parameters<typeof shippingFingerprint>[0] & {
  id: string; version: number; status: string; preview?: boolean; skipped?: unknown; trackingUrl?: string;
};

type ParcelStatus = "handed_over" | "awaiting_scan" | "in_transit" | "exception" | "delivered" | "unknown";
interface CustomerParcel { number: number; count: number; trackingUrl: string | null; status: ParcelStatus }

interface Row {
  order_id: string; box_number: number; box_count: number; fingerprint: string;
  provider_id: number | null; tracking_number: string | null; carrier_status: string | null; carrier_event_at: string | null;
  scan_stage: string | null; scan_at: string | null;
}

function customerStage(row: Row): ParcelStatus {
  // A later manual scan can arrive after the scheduled check. An empty poll
  // supplies no delivery event and cannot erase an earlier carrier observation.
  if (!row.provider_id) return "unknown";
  const manual = royalMailScanState(row.carrier_status);
  const scheduled = row.scan_stage;
  if ((scheduled === "in_transit" || scheduled === "exception" || scheduled === "delivered") &&
      (!row.carrier_event_at || (row.scan_at && Date.parse(row.scan_at) >= Date.parse(row.carrier_event_at)))) return scheduled;
  if (manual === "in_transit" || manual === "exception" || manual === "delivered") return manual;
  if (manual === "awaiting" || scheduled === "awaiting" && !row.carrier_status) return "awaiting_scan";
  return row.carrier_status ? "unknown" : "handed_over";
}

/** Only attach parcel information to a customer's own completed handover. Match
 * the version read for the history page, the booking fingerprint and the scan's
 * booking identity so a stale or unrelated parcel can never supply tracking. */
export async function customerParcelDeliveries(env: Env, customerId: string, orders: Order[]) {
  const eligible = new Map(orders.filter(order => order.customerId === customerId && order.preview === false &&
    order.status === "Dispatched" && !order.skipped && !order.trackingUrl && isWholesaleDelivery(order.delivery)).map(order => [order.id, order]));
  const deliveries = new Map<string, CustomerParcel[]>();
  if (!eligible.size) return deliveries;
  const versions = Object.fromEntries([...eligible].map(([id, order]) => [id, order.version]));
  const { results } = await env.DB.prepare(`SELECT plan.order_id, plan.shipping_fingerprint AS fingerprint,
    box.key + 1 AS box_number, json_array_length(plan.weights) AS box_count, s.provider_id, s.tracking_number,
    s.carrier_status, s.carrier_event_at, sc.outcome AS scan_stage, sc.event_at AS scan_at
    FROM json_each(?) requested JOIN wholesale_preview o ON o.kind='order' AND o.id=requested.key AND o.version=requested.value
    JOIN wholesale_royal_mail_box_plans plan ON plan.order_id=o.id JOIN json_each(plan.weights) box
    LEFT JOIN wholesale_royal_mail_shipments s ON s.order_id=plan.order_id||'-B'||(box.key+1)
      AND s.provider_id>0 AND s.review_required=0 AND s.label_downloaded_at IS NOT NULL AND s.weight_grams=box.value
      AND s.state IN ('labelled','dispatched') AND s.shipping_fingerprint=plan.shipping_fingerprint
    LEFT JOIN wholesale_royal_mail_scan_checks sc ON sc.shipment_id=s.order_id AND sc.booking_operation=s.operation
      AND sc.number=s.tracking_number AND sc.checked_at>0
    WHERE json_extract(o.data,'$.customerId')=? AND json_extract(o.data,'$.status')='Dispatched'
      AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.deletedAt') IS NULL
      AND COALESCE(json_extract(o.data,'$.trackingUrl'),'')=''
    ORDER BY plan.order_id, box.key`).bind(JSON.stringify(versions), customerId).all<Row>();
  const fingerprints = new Map<string, string>();
  for (const row of results) {
    const order = eligible.get(row.order_id);
    if (!order) continue;
    if (!fingerprints.has(order.id)) fingerprints.set(order.id, await shippingFingerprint(order));
    if (row.fingerprint !== fingerprints.get(order.id)) continue;
    const boxes = deliveries.get(order.id) ?? [];
    boxes.push({ number: row.box_number, count: row.box_count,
      trackingUrl: globalThis.SCWholesalePreparation.royalMailTrackingUrl(row.tracking_number),
      status: customerStage(row) });
    deliveries.set(order.id, boxes);
  }
  return deliveries;
}
