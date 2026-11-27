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

// The preview and atomic booking claim use the same decision. The order's saved terms
// determine credit, while the current account and all invoices apply account-wide holds.
// Visit each pending state through the queue index so completed events stay out of the scan.
const financialDecision = `
  WITH input(order_id,customer_id,today,fresh_since) AS (VALUES (?,?,?,?)),
  pending_states(state) AS (VALUES ('queued'),('processing'),('review'),('paused')),
  account AS (
    SELECT json_extract(c.data,'$.status') AS status,
      COALESCE(json_extract(w.data,'$.paymentTerms.id'),json_extract(w.data,'$.customerSnapshot.paymentTerms.id')) AS terms
    FROM input
    JOIN wholesale_preview w ON w.kind='order' AND w.id=input.order_id AND json_extract(w.data,'$.customerId')=input.customer_id
    JOIN wholesale_preview c ON c.kind='customer' AND c.id=input.customer_id
  ),
  invoices AS (
    SELECT (co.order_id IS NOT NULL OR EXISTS(
        SELECT 1 FROM wholesale_invoiced_elsewhere x WHERE x.order_id=input.order_id AND x.customer_id=input.customer_id
          AND x.environment=e.environment AND x.realm_id=e.realm_id AND x.remote_id=e.remote_id
      )) AS covers_order,
      ${PAYMENT_DUE_SQL} AS due, ${OUTSTANDING_BALANCE_SQL} AS outstanding,
      o.status IS 'voided' AS voided,
      (e.id IS NOT NULL AND COALESCE(o.read_started_at,0)<input.fresh_since) AS stale,
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
    FROM input JOIN wholesale_invoices i ON i.customer_id=input.customer_id
    ${LIVE_ACCOUNTING_JOIN}
    LEFT JOIN wholesale_invoice_coverage co ON co.invoice_id=i.seq AND co.order_id=input.order_id
  ),
  balances AS (
    SELECT *, COALESCE(date(due,'+0 days')=due,0) AS known_due FROM invoices
  )
  SELECT CASE
    WHEN (SELECT status FROM account)='On hold' THEN 'royal_mail_account_on_hold'
    WHEN (SELECT status FROM account) IS NOT 'Active' THEN 'royal_mail_payment_review'
    WHEN EXISTS(SELECT 1 FROM balances,input WHERE review IS NOT 1 AND voided=0 AND outstanding>0 AND known_due=1 AND due<input.today)
      THEN 'royal_mail_account_overdue'
    WHEN EXISTS(SELECT 1 FROM balances WHERE review=1 OR (covers_order AND voided) OR (outstanding>0 AND known_due=0))
      THEN 'royal_mail_payment_review'
    WHEN (SELECT COUNT(*) FROM balances WHERE covers_order)>1 OR EXISTS(
      SELECT 1 FROM wholesale_invoice_coverage co JOIN wholesale_invoices i ON i.seq=co.invoice_id
      JOIN input ON co.order_id=input.order_id WHERE i.customer_id<>input.customer_id
    ) OR EXISTS(
      SELECT 1 FROM wholesale_invoiced_elsewhere x JOIN input ON
        x.order_id=input.order_id OR (x.customer_id=input.customer_id AND x.total_pence>0)
      WHERE x.environment='production' AND NOT EXISTS(
        SELECT 1 FROM quickbooks_exports e JOIN wholesale_invoices i ON i.seq=e.invoice_id
        WHERE e.environment=x.environment AND e.realm_id=x.realm_id AND e.remote_id=x.remote_id
          AND e.state='linked' AND i.customer_id=input.customer_id AND x.customer_id=input.customer_id
      )
    ) THEN 'royal_mail_payment_review'
    WHEN (SELECT terms FROM account) IN ('net-7','net-14','net-30','net-60') THEN NULL
    WHEN EXISTS(SELECT 1 FROM balances WHERE covers_order AND settled AND stale=0) THEN NULL
    WHEN EXISTS(SELECT 1 FROM balances WHERE covers_order AND settled AND stale=1) THEN 'royal_mail_payment_review'
    WHEN (SELECT terms FROM account)='before-dispatch' THEN 'royal_mail_payment_required'
    ELSE 'royal_mail_payment_review'
  END AS block_code
`;

function args(order: OrderAccount) {
  const now = new Date();
  return [order.id, order.customerId ?? null, ukDay.format(now), now.getTime() - MAX_CURRENT_PAYMENT_AGE];
}

export async function staffLabelEligibility(env: Env, order: OrderAccount): Promise<StaffLabelEligibility> {
  const code = await env.DB.prepare(financialDecision).bind(...args(order)).first<BlockCode>("block_code");
  return code ? { eligible: false, code, message: messages[code] } : { eligible: true };
}

export function staffLabelEligibilityGuard(order: OrderAccount) {
  return { sql: ` AND (${financialDecision}) IS NULL`, args: args(order) };
}
