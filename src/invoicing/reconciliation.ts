import { audit } from "../audit";
import type { User } from "../auth";
import { ApiError, type Env, invalid, json, readJson } from "../http";
import {
  accountingSummary, INVOICE_REVIEW_SQL, LIVE_ACCOUNTING_JOIN, OUTSTANDING_BALANCE_SQL, PAYMENT_DUE_SQL, UNCONFIRMED_BALANCE_SQL,
} from "../quickbooks/observations";
import { digest } from "../quickbooks/crypto";
import { object, text } from "../wholesaleStore";
import { day, DISPATCHED, month, OUTSIDE_TAB, periodOf, UNBILLED_ORDERS } from "./billingData";

const issuedOn = "json_extract(i.data,'$.invoiceDate')";
const checklist = ["dispatches", "monthly", "posting", "verification", "overdue"];
const revisions = (counts: object, due: object, unbilled: object, exceptions: unknown[]) =>
  digest(JSON.stringify([counts, due, unbilled, exceptions]));

async function reviewQueue(env: Env, before?: string) {
  const { results } = await env.DB.prepare(`SELECT i.seq AS id,i.invoice_number AS number,json_extract(i.data,'$.billTo.name') AS business,
      COALESCE(NULLIF(o.invoice_issue,''),NULLIF(o.reason,''),
        (SELECT NULLIF(p.last_error,'') FROM quickbooks_exports p WHERE p.invoice_id=i.seq AND p.state='review' ORDER BY p.id DESC LIMIT 1),
        'QuickBooks balance needs a check') AS reason
    FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN} WHERE ${INVOICE_REVIEW_SQL}
      ${before ? "AND " + issuedOn + "<?" : ""} ORDER BY i.seq DESC LIMIT 8`).bind(...(before ? [before] : [])).all();
  return results;
}

export async function todayWorkspace(env: Env) {
  const period = periodOf(month());
  const [summary, issues, dues, dispatches] = await Promise.all([
    accountingSummary(env),
    reviewQueue(env),
    env.DB.prepare(`SELECT i.seq AS id,i.invoice_number AS number,json_extract(i.data,'$.billTo.name') AS business,
        ${PAYMENT_DUE_SQL} AS due,${OUTSTANDING_BALANCE_SQL} AS balancePence,CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS linked
      FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN}
      WHERE ${PAYMENT_DUE_SQL}<? AND ${OUTSTANDING_BALANCE_SQL}>0 ORDER BY due,i.seq LIMIT 5`).bind(day()).all(),
    env.DB.prepare(`SELECT COUNT(*) AS count ${UNBILLED_ORDERS}
      AND ${OUTSIDE_TAB} AND ${DISPATCHED}>=? AND ${DISPATCHED}<? AND COALESCE(a.cadence,'dispatch')='dispatch'`)
      .bind(period.from, period.until).first<{ count: number }>(),
  ]);
  return { summary, issues, overdue: dues.results, dispatched: dispatches?.count || 0 };
}

const emptyTotals = {
  issued: 0, issuedPence: 0, posted: 0, postedPence: 0, awaiting: 0, appliedPence: 0, unconfirmed: 0, adjustments: 0,
};
const emptyDue = { outstandingPence: 0, overduePence: 0, overdue: 0, age30: 0, age60: 0, ageOlder: 0 };
const emptyOrders = { unbilled: 0, tabs: 0, monthly: 0, accruing: 0 };

async function reviewMonth(env: Env, period: ReturnType<typeof periodOf>) {
  const today = day();
  const [totals, due, unbilled, issues, accounts] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS issued,COALESCE(SUM(json_extract(i.data,'$.totals.grossPence')),0) AS issuedPence,
      COUNT(e.id) AS posted,COUNT(*) FILTER(WHERE e.id IS NULL) AS awaiting,
      COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND NOT ${UNCONFIRMED_BALANCE_SQL} AND o.status<>'voided' THEN o.paid_pence+o.outstanding_pence ELSE 0 END),0) AS postedPence,
      COALESCE(SUM(CASE WHEN e.id IS NOT NULL AND NOT ${UNCONFIRMED_BALANCE_SQL} THEN o.paid_pence ELSE 0 END),0) AS appliedPence,
      COUNT(*) FILTER(WHERE ${UNCONFIRMED_BALANCE_SQL}) AS unconfirmed,
      COUNT(*) FILTER(WHERE ${INVOICE_REVIEW_SQL}) AS adjustments
      FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN} WHERE ${issuedOn}>=? AND ${issuedOn}<?`).bind(period.start, period.next).first<typeof emptyTotals>(),
    env.DB.prepare(`WITH amounts AS (SELECT ${OUTSTANDING_BALANCE_SQL} AS balance,
      julianday(?1)-julianday(${PAYMENT_DUE_SQL}) AS days FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN} WHERE ${issuedOn}<?2)
      SELECT COALESCE(SUM(balance),0) AS outstandingPence,COALESCE(SUM(balance) FILTER(WHERE days>0),0) AS overduePence,
        COUNT(*) FILTER(WHERE balance>0 AND days>0) AS overdue,
        COALESCE(SUM(balance) FILTER(WHERE days BETWEEN 1 AND 30),0) AS age30,
        COALESCE(SUM(balance) FILTER(WHERE days BETWEEN 31 AND 60),0) AS age60,
        COALESCE(SUM(balance) FILTER(WHERE days>60),0) AS ageOlder FROM amounts`).bind(today, period.next).first<typeof emptyDue>(),
    env.DB.prepare(`SELECT COUNT(*) AS unbilled,COUNT(*) FILTER(WHERE NOT (${OUTSIDE_TAB})) AS tabs,
      COUNT(DISTINCT c.id) FILTER(WHERE a.cadence='monthly' AND ${OUTSIDE_TAB} AND ${DISPATCHED}>=?1) AS monthly,
      COUNT(*) FILTER(WHERE a.cadence='monthly' AND ${OUTSIDE_TAB}) AS accruing
      ${UNBILLED_ORDERS} AND ${DISPATCHED}>0 AND ${DISPATCHED}<?2`).bind(period.from, period.until).first<typeof emptyOrders>(),
    reviewQueue(env, period.next),
    env.DB.prepare(`SELECT i.customer_id AS id,COALESCE(json_extract(c.data,'$.business'),json_extract(i.data,'$.billTo.name')) AS business,
      SUM(${OUTSTANDING_BALANCE_SQL}) AS amountPence,COUNT(*) AS invoices
      FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN} LEFT JOIN wholesale_preview c ON c.kind='customer' AND c.id=i.customer_id
      WHERE ${issuedOn}<? AND ${PAYMENT_DUE_SQL}<? AND ${OUTSTANDING_BALANCE_SQL}>0
      GROUP BY i.customer_id ORDER BY amountPence DESC,id LIMIT 12`).bind(period.next, today).all(),
  ]);
  const count = totals || emptyTotals, balances = due || emptyDue, orders = unbilled || emptyOrders;
  const revision = await revisions(count, balances, orders, [...issues, ...accounts.results]);
  return { period: period.key, closed: period.closed, asOf: today, totals: count, balances, orders, issues, accounts: accounts.results, revision };
}

async function snapshots(env: Env, period: string) {
  const { results } = await env.DB.prepare(`SELECT id,data,by_name AS by,created_at AS at FROM wholesale_invoice_closes
    WHERE period=? ORDER BY id DESC LIMIT 6`).bind(period).all<{ id: number; data: string; by: string; at: number }>();
  return results.map(row => ({ id: row.id, by: row.by, at: row.at, ...JSON.parse(row.data) as Record<string, unknown> }));
}

export async function handleReconciliation(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  if (route === "today" && req.method === "GET") return json(await todayWorkspace(env));
  if (route !== "reconciliation") return null;
  const period = periodOf(new URL(req.url).searchParams.get("period") || month());
  if (req.method === "GET") {
    const [review, previous] = await Promise.all([reviewMonth(env, period), snapshots(env, period.key)]);
    return json({ ...review, snapshots: previous });
  }
  if (req.method === "POST") {
    const body = object(await readJson(req, 4096));
    if (!Array.isArray(body.checked) || body.checked.length > checklist.length || !body.checked.every((key: string) => checklist.includes(key))) {
      throw invalid("Choose the checklist items you reviewed.");
    }
    const note = text(body.note || "", "close notes", 500);
    const review = await reviewMonth(env, period);
    if (body.revision !== review.revision) throw new ApiError(409, "invoice_close_changed", "The figures changed. Review the latest figures before saving a snapshot.");
    const at = Date.now();
    const snapshot = { checked: [...new Set(body.checked)], note, asOf: review.asOf, totals: review.totals, balances: review.balances, orders: review.orders,
      accounts: review.accounts, issues: review.issues };
    const saved = await env.DB.prepare(`INSERT INTO wholesale_invoice_closes(period,data,by_name,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1) RETURNING id`)
      .bind(period.key, JSON.stringify(snapshot), user.name, at, user.id).first<{ id: number }>();
    if (!saved) throw new ApiError(403, "permission_denied", "A current admin must save the reconciliation snapshot.");
    await audit(env, "wholesale_invoice_close", user.name, "Saved an invoicing reconciliation snapshot for " + period.key + ".");
    return json({ id: saved.id, ...snapshot, by: user.name, at }, 201);
  }
  return null;
}
