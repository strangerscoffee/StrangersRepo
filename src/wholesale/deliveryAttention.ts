import { type Env, invalid, json } from "../http";
import { addDays, ukDay } from "../insightsMath";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "../royalMailAppSettings";
import { DECLINED_POSTAGE, HELD_FAILED_SHIPMENT } from "../royalMailBookingState";
import { bookingConnection } from "../royalMailRecovery";
import { royalMailCollectionCutoff } from "../royalMailSetupChecks";
import { fetchRoyalMailTracking } from "../royalMail";
import { royalMailScanState } from "../royalMailScanState";

const DAY = 86_400_000;
const clock = new Intl.DateTimeFormat("en-GB", { timeZone:"Europe/London", hour:"2-digit", minute:"2-digit", hourCycle:"h23" });
const kinds = ["booking","collection","no_scan","exception"] as const;
type Kind = typeof kinds[number];
const parent = "substr(s.order_id,1,35)";
const joinOrder = `JOIN wholesale_preview o ON o.kind='order' AND o.id=${parent}`;
const realDelivery = `json_type(o.data,'$.preview')='false' AND json_extract(o.data,'$.deletedAt') IS NULL
  AND COALESCE(json_extract(o.data,'$.skipped'),0)=0 AND COALESCE(json_extract(o.data,'$.customerId'),'')<>''
  AND lower(trim(json_extract(o.data,'$.delivery'))) IN ('delivery','courier')`;
const status = "json_extract(o.data,'$.status')";
const handover = "json_extract(o.data,'$.dispatchedAt')";
const dispatchDay = "json_extract(o.data,'$.dispatchDate')";
const joinChecks = `LEFT JOIN wholesale_royal_mail_scan_checks c ON c.shipment_id=s.order_id AND c.booking_operation=s.operation
  AND c.number=s.tracking_number AND c.connection_scope=?`;
const supportedNumber = `((length(s.tracking_number)=13 AND substr(s.tracking_number,1,2) NOT GLOB '*[^A-Z]*' AND substr(s.tracking_number,3,9) NOT GLOB '*[^0-9]*' AND substr(s.tracking_number,12,2) NOT GLOB '*[^A-Z]*')
  OR (length(s.tracking_number)=21 AND s.tracking_number NOT GLOB '*[^0-9A-F]*'))`;
const confirmed = "s.provider_id>0 AND s.review_required=0 AND s.state IN ('labelled','dispatched')";
// An Admin can deliberately dispatch through another courier after printing our label.
const handedToRoyalMail = `((s.order_id=o.id AND json_extract(o.data,'$.trackingUrl')=
    'https://www.royalmail.com/track-your-item#/tracking-results/'||s.tracking_number)
  OR (substr(s.order_id,36,2)='-B' AND coalesce(json_extract(o.data,'$.trackingUrl'),'')=''
    AND EXISTS(SELECT 1 FROM wholesale_royal_mail_box_plans p WHERE p.order_id=o.id
      AND s.shipping_fingerprint=p.shipping_fingerprint
      AND cast(substr(s.order_id,38) AS INTEGER) BETWEEN 1 AND json_array_length(p.weights))))`;
type Connections = Awaited<ReturnType<typeof loadRoyalMailConnections>>;
async function scanScope(connections: Connections) {
  if (!connections.booking.key || !connections.tracking) return null;
  return bookingConnection(JSON.stringify([connections.booking.key, connections.tracking.clientId, connections.tracking.clientSecret]));
}

function elapsedCutoff(cutoff: string, now: number) {
  const today = ukDay(now);
  const day = clock.format(now) >= cutoff ? today : addDays(today,-1);
  const winter = Date.parse(day + "T" + cutoff + ":00Z");
  // Use the later occurrence when clocks repeat and the first available minute if the local hour was skipped.
  const at = clock.format(winter) === cutoff ? winter : clock.format(winter - 3600_000) === cutoff
    ? winter - 3600_000 : Date.parse(day + "T01:00:00Z");
  return {day, at};
}

interface Issue {
  shipment_id: string; id: string; business: string; version: number; kind: Kind; at: number; checked: number | null;
  tracking_number: string | null; carrier_status: string | null; state: string; problem: string | null;
  dispatch_day: string | null; request_problem:string | null; review_required: number;
}
export async function listDeliveryAttention(req: Request, env: Env) {
  if (req.method !== "GET") return json({code:"method_not_allowed", message:"Use GET to read delivery issues."},405,{Allow:"GET"});
  const params = new URL(req.url).searchParams;
  const kind = params.get("kind") || "all";
  const limit = params.get("limit") ?? "40";
  if (kind !== "all" && !kinds.includes(kind as Kind)) throw invalid("Choose a delivery issue.");
  if (!/^\d{1,2}$/.test(limit) || +limit < 1 || +limit > 80) throw invalid("Choose between 1 and 80 deliveries.");
  const cursor = params.get("cursor");
  const after = cursor && /^(all|booking|collection|no_scan|exception):(WS-[A-F0-9]{32}(?:-B[1-9]\d?)?)$/.exec(cursor);
  if (cursor !== null && (!after || after[1] !== kind)) throw invalid("Reload the delivery issues before loading more.");
  const policy = await readRoyalMailPolicy(env);
  const connections = await loadRoyalMailConnections(env, policy);
  const [cutoff, scope] = await Promise.all([royalMailCollectionCutoff(env,policy,connections), scanScope(connections)]);
  const now = Date.now();
  const due = cutoff && elapsedCutoff(cutoff,now);
  // Keyset by immutable parcel reference. SQL filters before limiting, across both original and box bookings.
  const results = await env.DB.prepare(`WITH issues AS (
    SELECT s.order_id shipment_id,o.id,o.version,json_extract(o.data,'$.business') business,
      s.state,s.review_required,s.problem,s.request_problem,s.tracking_number,s.carrier_status,c.checked_at scan_checked,s.checked_at booking_checked,
      ${dispatchDay} dispatch_day,s.requested_at,s.updated_at,s.label_downloaded_at,${handover} handover,c.event_at,
      CASE
      WHEN s.state='review' OR (s.state='booking' AND s.requested_at>0) OR ${HELD_FAILED_SHIPMENT}
        OR (s.state='failed' AND ${status}='Ready' AND instr(s.problem,?)=1)
        OR s.review_required=1 OR (s.state='created' AND coalesce(s.problem,'')<>'') THEN 'booking'
      WHEN ${confirmed} AND ${status}='Ready' AND s.label_downloaded_at>0 AND ?<>''
        AND (CASE WHEN ${dispatchDay} GLOB '????-??-??' THEN ${dispatchDay}<=? ELSE s.label_downloaded_at<=? END) THEN 'collection'
      WHEN ${confirmed} AND ${status}='Dispatched' AND ${handedToRoyalMail} AND c.outcome='exception'
        AND (s.carrier_event_at IS NULL OR s.carrier_event_at<=c.event_at) THEN 'exception'
      WHEN ${confirmed} AND ${status}='Dispatched' AND ${handedToRoyalMail} AND ${handover}>0 AND c.outcome='awaiting'
        AND c.checked_at>=${handover}+? AND (s.carrier_status IS NULL OR s.carrier_status=c.description)
        AND (s.carrier_event_at IS NULL OR s.carrier_event_at<=c.event_at) THEN 'no_scan' END kind
    FROM wholesale_royal_mail_shipments s ${joinOrder} ${joinChecks}
    WHERE s.order_id>? AND ${realDelivery} AND ${status} IN ('Ready','Dispatched'))
    SELECT *,CASE kind WHEN 'booking' THEN coalesce(nullif(requested_at,0),updated_at)
      WHEN 'collection' THEN label_downloaded_at WHEN 'exception' THEN coalesce(unixepoch(event_at)*1000,scan_checked)
      ELSE handover END at, CASE WHEN kind='booking' THEN booking_checked ELSE scan_checked END checked FROM issues WHERE kind IS NOT NULL AND (?='all' OR kind=?) ORDER BY shipment_id LIMIT ?`)
    .bind(DECLINED_POSTAGE,cutoff || "",due ? due.day : "",due ? due.at : 0,DAY,scope,after ? after[2] : "",kind,kind,+limit+1).all<Issue>();
  const page = results.results.slice(0,+limit);
  const orders = page.map(row => {
    const box = row.shipment_id === row.id ? null : Number(row.shipment_id.slice(37));
    const evidence: Record<Kind,string> = {
      booking: row.state==="failed" && row.problem?.startsWith(DECLINED_POSTAGE) ? row.problem.slice(DECLINED_POSTAGE.length) || "Royal Mail declined the postage request. Review the parcel details." :
        row.review_required ? "The saved shipment needs verification." : row.state === "created" ?
        "Royal Mail accepted the booking and reported a label problem." : row.request_problem || "The original postage request needs confirmation.",
      collection: "Label downloaded. The confirmed " + cutoff + " UK collection cutoff has passed" +
        (row.dispatch_day ? " for the planned dispatch on " + row.dispatch_day : "") + ".",
      no_scan: "Handover recorded. Royal Mail still showed no physical scan at least 24 hours later.",
      exception: row.carrier_status || "Royal Mail reported a delivery exception.",
    };
    return { id:row.id, version:row.version, business:row.business, box, kind:row.kind, at:row.at,
      evidence:evidence[row.kind], checkedAt:row.checked, trackingUrl:["exception","no_scan"].includes(row.kind) ?
        globalThis.SCWholesalePreparation.royalMailTrackingUrl(row.tracking_number) : null,
      actionLabel: row.kind === "collection" ? "Review handover" : row.kind === "booking" ? "Review booking" : "Track parcel" };
  });
  return json({orders,trackingEnabled:!!scope,cutoff,nextCursor:results.results.length>+limit ? kind + ":" + page[page.length-1].shipment_id : null});
}

interface PollCandidate { shipment_id:string; booking_operation:string; number:string }
export async function refreshDeliveryScans(env: Env, now = Date.now()) {
  // Avoid decrypting settings on the five-minute tick when there is nothing to monitor.
  const possible = await env.DB.prepare(`SELECT 1 FROM wholesale_royal_mail_shipments s ${joinOrder} WHERE ${confirmed}
    AND ${supportedNumber} AND ${realDelivery} AND ${status}='Dispatched' AND ${handedToRoyalMail} AND ${handover}>=? LIMIT 1`).bind(now-90*DAY).first();
  if (!possible) return;
  const connections = await loadRoyalMailConnections(env,await readRoyalMailPolicy(env));
  const scope = await scanScope(connections);
  if (!scope || !connections.tracking || !connections.booking.key) return;
  const account = await bookingConnection(connections.booking.key);
  const {results: candidates} = await env.DB.prepare(`SELECT s.order_id shipment_id,s.operation booking_operation,s.tracking_number number
    FROM wholesale_royal_mail_shipments s ${joinOrder} ${joinChecks}
    WHERE ${confirmed} AND s.booking_connection=? AND ${supportedNumber} AND ${realDelivery}
    AND ${status}='Dispatched' AND ${handedToRoyalMail} AND ${handover} BETWEEN ? AND ?
    AND coalesce(c.next_at,0)<=? AND (coalesce(c.outcome,'')<>'delivered' OR s.carrier_event_at>coalesce(c.event_at,''))
    ORDER BY coalesce(c.next_at,0),s.order_id LIMIT 20`).bind(scope,account,now-90*DAY,now,now).all<PollCandidate>();
  if (!candidates.length) return;
  const lease = crypto.randomUUID();
  const claims = await env.DB.batch(candidates.map(c => env.DB.prepare(`INSERT INTO wholesale_royal_mail_scan_checks
    (shipment_id,booking_operation,number,connection_scope,lease,next_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(shipment_id) DO UPDATE SET booking_operation=excluded.booking_operation,number=excluded.number,
      connection_scope=excluded.connection_scope,lease=excluded.lease,next_at=excluded.next_at,
      outcome=CASE WHEN booking_operation=excluded.booking_operation AND number=excluded.number AND connection_scope=excluded.connection_scope THEN outcome END,
      checked_at=CASE WHEN booking_operation=excluded.booking_operation AND number=excluded.number AND connection_scope=excluded.connection_scope THEN checked_at END,
      event_at=CASE WHEN booking_operation=excluded.booking_operation AND number=excluded.number AND connection_scope=excluded.connection_scope THEN event_at END,
      description=CASE WHEN booking_operation=excluded.booking_operation AND number=excluded.number AND connection_scope=excluded.connection_scope THEN description END
    WHERE next_at<=? OR booking_operation<>excluded.booking_operation OR number<>excluded.number OR connection_scope<>excluded.connection_scope`)
    .bind(c.shipment_id,c.booking_operation,c.number,scope,lease,now+1800_000,now)));
  const claimed = candidates.filter((_,i) => claims[i].meta.changes>0);
  if (!claimed.length) return;
  const snapshots = await fetchRoyalMailTracking(connections.tracking, claimed.map(c=>c.number));
  const byNumber = new Map(snapshots.map(s=>[s.trackingNumber,s]));
  const writes: D1PreparedStatement[] = [];
  for (const piece of claimed) {
    const snapshot = byNumber.get(piece.number);
    if (!snapshot) continue;
    const description = snapshot.lastEventName || snapshot.statusCategory;
    const outcome = snapshot.status === "not-found" ? "awaiting" : royalMailScanState(description,snapshot.statusCategory);
    const event = snapshot.lastEventAt;
    const live = `EXISTS(SELECT 1 FROM wholesale_royal_mail_shipments s ${joinOrder}
      WHERE s.order_id=? AND s.operation=? AND s.tracking_number=? AND s.booking_connection=? AND ${confirmed}
      AND ${realDelivery} AND ${status}='Dispatched' AND ${handedToRoyalMail} AND (s.carrier_event_at IS NULL OR s.carrier_event_at<=?))`;
    writes.push(env.DB.prepare(`UPDATE wholesale_royal_mail_scan_checks SET outcome=?,checked_at=?,description=?,event_at=?,next_at=?
      WHERE shipment_id=? AND lease=? AND (event_at IS NULL OR event_at<=?)
      AND (? NOT IN ('awaiting','unknown') OR outcome IS NULL OR outcome IN ('awaiting','unknown')) AND ${live}`).bind(outcome,now,description,event,now+2*3600_000,
        piece.shipment_id,lease,event,outcome,piece.shipment_id,piece.booking_operation,piece.number,account,event));
    if (description && snapshot.status==="available") writes.push(env.DB.prepare(`UPDATE wholesale_royal_mail_shipments
      SET carrier_status=?,carrier_event_at=? WHERE order_id=? AND operation=? AND tracking_number=?
      AND EXISTS(SELECT 1 FROM wholesale_royal_mail_scan_checks WHERE shipment_id=? AND lease=? AND checked_at=? AND outcome=?)`)
      .bind(description,event,piece.shipment_id,piece.booking_operation,piece.number,piece.shipment_id,lease,now,outcome));
  }
  if (writes.length) await env.DB.batch(writes);
}
