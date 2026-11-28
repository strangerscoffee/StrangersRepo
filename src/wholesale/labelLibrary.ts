import { type Env, invalid, json } from "../http";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "../royalMailAppSettings";
import { royalMailOrderChanged } from "../wholesaleRoyalMail";
import { decode, type Row } from "../wholesaleStore";

type Status = "ready" | "downloaded" | "dispatched";
type Order = Parameters<typeof royalMailOrderChanged>[1] & { reference?: string };
interface LabelRow extends Row {
  order_version: number; shipping_fingerprint: string | null; review_required: number;
  tracking_number: string | null; weight_grams: number; service_code: string | null;
  label_downloaded_at: number | null; requested_at: number | null;
  archive_at: number; status: Status;
}

// The sort expression and the partial predicate match the history index in migration 56.
const bookedAt = "COALESCE(NULLIF(requested_at,0), label_order_created_at, 0)";
const generated = "provider_id > 0 AND state IN ('labelled','dispatched')";
const stage = `CASE WHEN json_extract(o.data,'$.status')='Dispatched' THEN 'dispatched'
  WHEN label_downloaded_at > 0 THEN 'downloaded' ELSE 'ready' END`;
const orders = `FROM wholesale_royal_mail_shipments s INDEXED BY wholesale_royal_mail_label_history
  CROSS JOIN wholesale_preview o ON o.kind='order' AND o.id=s.order_id
  WHERE ${generated} AND json_type(o.data,'$.preview')='false' AND json_extract(o.data,'$.deletedAt') IS NULL
  AND COALESCE(json_extract(o.data,'$.skipped'),0)=0 AND COALESCE(json_extract(o.data,'$.customerId'),'')<>''
  AND json_extract(o.data,'$.status') IN ('Ready','Dispatched')
  AND lower(trim(json_extract(o.data,'$.delivery'))) IN ('delivery','courier')`;

// Bind cursors to their search/filter without duplicating those values in the cursor itself.
async function scopeKey(status: string, search: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([status, search])));
  return Array.from(new Uint8Array(digest, 0, 8), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function listRoyalMailLabels(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") {
    return json({ code: "method_not_allowed", message: "Use GET to read generated labels." }, 405, { Allow: "GET" });
  }
  const params = new URL(req.url).searchParams;
  const search = (params.get("search") || "").trim().toLowerCase();
  if (search.length > 120 || /[\u0000-\u001f\u007f]/.test(search)) throw invalid("Enter a search of up to 120 characters.");
  const status = params.get("status") || "all";
  if (!["all", "ready", "downloaded", "dispatched"].includes(status)) throw invalid("Choose a label status.");
  const rawLimit = params.get("limit") ?? "30";
  if (!/^\d{1,3}$/.test(rawLimit) || +rawLimit < 1 || +rawLimit > 100) throw invalid("Choose between 1 and 100 labels.");
  const limit = Number(rawLimit);
  const scope = await scopeKey(status, search);
  const cursor = params.get("cursor");
  const after = cursor === null ? null : /^(\d{1,16}):(WS-[A-F0-9]{32}):([a-f0-9]{16})$/.exec(cursor);
  if (cursor !== null && (!after || !Number.isSafeInteger(Number(after[1])) || after[3] !== scope)) {
    throw invalid("Reload the label list before loading more orders.");
  }

  let predicate = orders;
  const args: string[] = [];
  if (status !== "all") { predicate += ` AND ${stage}=?`; args.push(status); }
  if (search) {
    predicate += ` AND (instr(lower(s.order_id),?)>0 OR instr(lower(json_extract(o.data,'$.business')),?)>0
      OR instr(lower(json_extract(o.data,'$.reference')),?)>0 OR instr(lower(s.tracking_number),?)>0)`;
    args.push(search, search, search, search);
  }
  const pageSql = `SELECT s.order_id AS id,o.version,o.data,o.updated_at,s.order_version,s.shipping_fingerprint,s.review_required,
    s.tracking_number,s.weight_grams,s.service_code,s.label_downloaded_at,s.requested_at,${bookedAt} AS archive_at,${stage} AS status
    ${predicate} ${after ? `AND (${bookedAt},s.order_id)<(?,?)` : ""}
    ORDER BY ${bookedAt} DESC,s.order_id DESC LIMIT ?`;
  const [[count, page], connections] = await Promise.all([
    env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS total " + predicate).bind(...args),
      env.DB.prepare(pageSql).bind(...args, ...(after ? [Number(after[1]), after[2]] : []), limit + 1),
    ]),
    readRoyalMailPolicy(env).then(policy => loadRoyalMailConnections(env, policy)),
  ]);
  const result = page.results as unknown as LabelRow[];
  const visible = result.slice(0, limit);
  const labels = await Promise.all(visible.map(async row => {
    const order = decode<Order>(row);
    const needsReview = !!row.review_required || await royalMailOrderChanged(row, order);
    return {
      id: row.id, business: order.business, reference: order.reference || "", trackingNumber: row.tracking_number,
      weightGrams: row.weight_grams, serviceCode: row.service_code, createdAt: row.archive_at || null,
      dateSource: row.requested_at && row.requested_at > 0 ? "booking" : row.archive_at ? "order" : "unknown",
      labelDownloadedAt: row.label_downloaded_at || null, status: row.status, needsReview,
      canPreview: !needsReview && !!connections.booking.key,
    };
  }));
  const last = visible.at(-1);
  const nextCursor = result.length > limit && last ? `${last.archive_at}:${last.id}:${scope}` : null;
  return json({ labels, total: (count.results[0] as { total: number }).total, nextCursor });
}
