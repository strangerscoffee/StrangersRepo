import type { Env } from "../http";
import { LIVE_ACCOUNTING_JOIN, OUTSTANDING_BALANCE_SQL, PAYMENT_DUE_SQL, UNCONFIRMED_BALANCE_SQL } from "../quickbooks/observations";

const messages = {
  royal_mail_account_on_hold: "This account is on hold. Ask an admin to review it before requesting a label.",
  royal_mail_account_overdue: "This account has an overdue payment. Ask an admin to review it before requesting a label.",
  royal_mail_payment_required: "Payment for this order must be confirmed before requesting a label.",
  royal_mail_payment_review: "Payment eligibility could not be confirmed. Ask an admin to review it before requesting a label.",
} as const;

type BlockCode = keyof typeof messages;
export type StaffLabelEligibility = { eligible: true } | { eligible: false; code: BlockCode; message: string };
type OrderAccount = { id: string; customerId?: string | null };
const MAX_CURRENT_PAYMENT_AGE = 24 * 60 * 60 * 1000;
const ukDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

// Both the atomic booking guard and the queue use this decision. The queue supplies
// multiple orders at once; invoice observations are evaluated once per active customer.
export function labelEligibilityQuery(ordersSql: string) {
  return `
  WITH input(order_id,customer_id) AS (${ordersSql}),
  clock(today,fresh_since) AS (VALUES (?,?)),
  customers AS (SELECT DISTINCT customer_id FROM input),
  pending_states(state) AS (VALUES ('queued'),('processing'),('review'),('paused')),
  invoices AS MATERIALIZED (
    SELECT i.seq,i.customer_id,e.environment,e.realm_id,e.remote_id,
      ${PAYMENT_DUE_SQL} AS due, ${OUTSTANDING_BALANCE_SQL} AS outstanding,
      o.status IS 'voided' AS voided,
      (e.id IS NOT NULL AND COALESCE(o.read_started_at,0)<clock.fresh_since) AS stale,
      CASE WHEN e.id IS NULL THEN i.paid=1 OR json_extract(i.data,'$.totals.grossPence') IS 0
        ELSE o.status IN ('paid','settled') AND o.outstanding_pence=0 END AS settled,
      (${UNCONFIRMED_BALANCE_SQL}
        OR (e.id IS NOT NULL AND (
          o.status IS NULL OR o.status NOT IN ('paid','settled','voided','unpaid','part-paid')
          OR o.reason<>'' OR o.invoice_issue<>''
          OR NOT EXISTS (
            SELECT 1 FROM quickbooks_connections c
            WHERE c.environment=e.environment AND c.realm_id=e.realm_id AND c.status='connected'
          )
          OR typeof(o.outstanding_pence)<>'integer'
          OR (o.status IN ('paid','settled','voided') AND o.outstanding_pence<>0)
          OR (o.status IN ('unpaid','part-paid') AND o.outstanding_pence<=0)
          OR EXISTS (
            SELECT 1 FROM quickbooks_payment_links p JOIN quickbooks_payment_voids v
              ON v.environment=e.environment AND v.realm_id=e.realm_id AND v.payment_id=p.payment_id
            WHERE p.export_id=e.id AND v.confirmed_at>o.read_started_at
          )
          OR EXISTS (
            SELECT 1 FROM pending_states CROSS JOIN quickbooks_events q
            WHERE q.state=pending_states.state AND q.environment=e.environment AND q.realm_id=e.realm_id
              AND q.created_at>=o.read_started_at
              AND (
                (q.entity='Invoice' AND q.entity_id=e.remote_id AND
                  (q.operation IN ('create','update','delete','void') OR q.event_key GLOB 'cdc:*' OR q.event_key GLOB 'payment:*'))
                OR (q.entity='Payment' AND q.operation IN ('create','update','delete','void') AND EXISTS(
                  SELECT 1 FROM quickbooks_payment_links p WHERE p.export_id=e.id AND p.payment_id=q.entity_id
                ))
              )
          )
        ))
        OR EXISTS (
          SELECT 1 FROM quickbooks_exports pending
          WHERE pending.invoice_id=i.seq AND pending.environment='production' AND pending.state<>'linked'
            AND (pending.write_started_at>0 OR pending.remote_id<>'' OR pending.state='uncertain')
        )
        OR (e.id IS NULL AND i.paid=0 AND
          (json_type(i.data,'$.totals.grossPence') IS NOT 'integer' OR json_extract(i.data,'$.totals.grossPence')<0))
      ) AS review
    FROM customers JOIN wholesale_invoices i ON i.customer_id=customers.customer_id CROSS JOIN clock
    ${LIVE_ACCOUNTING_JOIN}
  ),
  balances AS (
    SELECT *, COALESCE(date(due,'+0 days')=due,0) AS known_due FROM invoices
  ),
  account_flags AS (
    SELECT customer_id, MAX(review IS NOT 1 AND voided=0 AND outstanding>0 AND known_due=1 AND due<clock.today) AS overdue,
      MAX(review=1 OR (outstanding>0 AND known_due=0)) AS needs_review
    FROM balances CROSS JOIN clock GROUP BY customer_id
  ),
  covered AS (
    SELECT input.order_id,i.seq,i.voided,i.settled,i.stale FROM input
      JOIN wholesale_invoice_coverage co ON co.order_id=input.order_id
      JOIN invoices i ON i.seq=co.invoice_id AND i.customer_id=input.customer_id
    UNION
    SELECT input.order_id,i.seq,i.voided,i.settled,i.stale FROM input
      JOIN wholesale_invoiced_elsewhere x ON x.order_id=input.order_id AND x.customer_id=input.customer_id
      JOIN invoices i ON i.customer_id=input.customer_id AND i.environment=x.environment
        AND i.realm_id=x.realm_id AND i.remote_id=x.remote_id
  ),
  order_flags AS (
    SELECT order_id,COUNT(*) AS invoice_count,MAX(voided) AS voided,MAX(settled AND stale=0) AS paid,
      MAX(settled AND stale=1) AS stale_payment FROM covered GROUP BY order_id
  ),
  unresolved_accounts AS (
    SELECT DISTINCT x.customer_id FROM customers
    JOIN wholesale_invoiced_elsewhere x ON x.customer_id=customers.customer_id
    WHERE x.environment='production' AND x.total_pence>0 AND NOT EXISTS (
      SELECT 1 FROM invoices i WHERE i.customer_id=x.customer_id AND i.environment=x.environment
        AND i.realm_id=x.realm_id AND i.remote_id=x.remote_id
    )
  )
  SELECT input.order_id,CASE
    WHEN json_extract(c.data,'$.status')='On hold' THEN 'royal_mail_account_on_hold'
    WHEN json_extract(c.data,'$.status') IS NOT 'Active' OR w.id IS NULL THEN 'royal_mail_payment_review'
    WHEN af.overdue THEN 'royal_mail_account_overdue'
    WHEN af.needs_review OR of.voided OR of.invoice_count>1 OR ua.customer_id IS NOT NULL OR EXISTS(
      SELECT 1 FROM wholesale_invoice_coverage co JOIN wholesale_invoices i ON i.seq=co.invoice_id
      WHERE co.order_id=input.order_id AND i.customer_id<>input.customer_id
    ) OR EXISTS(
      SELECT 1 FROM wholesale_invoiced_elsewhere x WHERE x.order_id=input.order_id AND x.environment='production'
        AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.customer_id=input.customer_id AND x.customer_id=input.customer_id
          AND i.environment=x.environment AND i.realm_id=x.realm_id AND i.remote_id=x.remote_id)
    ) THEN 'royal_mail_payment_review'
    WHEN COALESCE(json_extract(w.data,'$.paymentTerms.id'),json_extract(w.data,'$.customerSnapshot.paymentTerms.id'))
      IN ('net-7','net-14','net-30','net-60') THEN NULL
    WHEN of.paid THEN NULL
    WHEN of.stale_payment THEN 'royal_mail_payment_review'
    WHEN COALESCE(json_extract(w.data,'$.paymentTerms.id'),json_extract(w.data,'$.customerSnapshot.paymentTerms.id'))
      ='before-dispatch' THEN 'royal_mail_payment_required'
    ELSE 'royal_mail_payment_review'
  END AS block_code FROM input
  LEFT JOIN wholesale_preview w ON w.kind='order' AND w.id=input.order_id AND json_extract(w.data,'$.customerId')=input.customer_id
  LEFT JOIN wholesale_preview c ON c.kind='customer' AND c.id=input.customer_id AND w.id IS NOT NULL
  LEFT JOIN account_flags af ON af.customer_id=input.customer_id
  LEFT JOIN order_flags of ON of.order_id=input.order_id
  LEFT JOIN unresolved_accounts ua ON ua.customer_id=input.customer_id`;
}

const financialDecision = `SELECT block_code FROM (${labelEligibilityQuery("VALUES (?,?)")})`;
export function labelEligibilityClock(now = new Date()) {
  return [ukDay.format(now), now.getTime() - MAX_CURRENT_PAYMENT_AGE];
}
function args(order: OrderAccount) {
  return [order.id, order.customerId ?? null, ...labelEligibilityClock()];
}

export async function staffLabelEligibility(env: Env, order: OrderAccount): Promise<StaffLabelEligibility> {
  const code = await env.DB.prepare(financialDecision).bind(...args(order)).first<BlockCode>("block_code");
  return code ? { eligible: false, code, message: messages[code] } : { eligible: true };
}

export function staffLabelEligibilityGuard(order: OrderAccount) {
  return { sql: ` AND (${financialDecision}) IS NULL`, args: args(order) };
}
