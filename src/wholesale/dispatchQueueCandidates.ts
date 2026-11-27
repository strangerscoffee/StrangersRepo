// Keep the predicate identical in the queue query and its partial index.
export const DISPATCH_QUEUE_ORDERS = `kind='order'
  AND json_extract(data,'$.status')='Ready'
  AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL
  AND COALESCE(json_extract(data,'$.skipped'),0)=0
  AND COALESCE(json_extract(data,'$.customerId'),'')<>''
  AND LOWER(TRIM(json_extract(data,'$.delivery'))) IN ('delivery','courier')`;
export const DISPATCH_QUEUE_DATE = "CASE WHEN json_extract(data,'$.dispatchDate') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN json_extract(data,'$.dispatchDate') ELSE '9999-12-31' END";

export const DISPATCH_QUEUE_KEY = `(${DISPATCH_QUEUE_DATE} || ':' || id)`;

// SQLite may otherwise choose the general customer-order index in a recently initialized
// database and sort all orders. The queue index contains exactly this active subset.
export const DISPATCH_QUEUE_BATCH = `SELECT id,version,data,${DISPATCH_QUEUE_DATE} AS sort_day, json_extract(data,'$.customerId') AS customer
  FROM wholesale_preview INDEXED BY wholesale_dispatch_queue_orders
  WHERE ${DISPATCH_QUEUE_ORDERS} AND ${DISPATCH_QUEUE_KEY}>?
  ORDER BY ${DISPATCH_QUEUE_KEY} LIMIT ?`;
