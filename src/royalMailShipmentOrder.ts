// A conventional label uses the wholesale order ID. Multi-box postage uses a separate
// carrier reference per box; only references present in that order's plan are visible.
export const boxNumberSql = "CAST(substr(s.order_id,38) AS INTEGER)";
export const shipmentOrderJoin = `CROSS JOIN wholesale_preview o ON o.kind='order' AND o.id=substr(s.order_id,1,35)
  LEFT JOIN wholesale_royal_mail_box_plans p ON length(s.order_id)>35 AND p.order_id=o.id`;
export const belongsToOrder = `(s.order_id=o.id OR (${boxNumberSql} BETWEEN 1 AND json_array_length(p.weights)
  AND s.order_id=o.id||'-B'||${boxNumberSql}))`;

// A well-formed row can still refer to a different revision/weight. Keep it visible
// for review without offering the PDF or using it as proof in setup checks.
export const matchesPlannedBox = `CASE WHEN s.order_id=o.id THEN 1 ELSE
  p.shipping_fingerprint=s.shipping_fingerprint AND s.weight_grams=json_extract(p.weights,'$['||MAX(0,${boxNumberSql}-1)||']') END`;
