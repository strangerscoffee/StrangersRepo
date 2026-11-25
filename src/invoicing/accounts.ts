import { audit } from "../audit";
import { readToken, signToken, type User } from "../auth";
import { ApiError, type Env, invalid, json, readJson } from "../http";
import { billingAddressFor } from "../quickbooks/billingReviews";
import { digest } from "../quickbooks/crypto";
import { LIVE_ACCOUNTING_JOIN, OUTSTANDING_BALANCE_SQL, PAYMENT_DUE_SQL, UNCONFIRMED_BALANCE_SQL } from "../quickbooks/observations";
import { paymentTermsFor, type Customer } from "../wholesaleAccounts";
import { settings } from "../wholesaleInvoices";
import { accountStatementPdf } from "../wholesaleInvoicePdf";
import { get, object, text, version } from "../wholesaleStore";
import { tidyPostalAddress } from "../wholesaleCustomers";
import { accountsEmail, day, DISPATCHED, month, UNBILLED_ORDERS } from "./billingData";

type Schedule = { cadence: "dispatch" | "monthly"; version: number };
export interface StatementLine {
  id: number; number: string; invoiceDate: string; dueDate: string | null; totalPence: number; balancePence: number | null;
  appliedPence: number | null; source: "QuickBooks" | "Strangers"; checkedAt: number | null; voided: number; orderId: string;
}
export interface AccountStatement {
  business: string; address: string; postcode: string; recipient: string; seller: string; asAt: number;
  periodStart: string; balancePence: number; unconfirmed: number; lines: StatementLine[];
}
const selectLedger = `SELECT i.seq AS id,i.invoice_number AS number,i.order_id AS orderId,json_extract(i.data,'$.invoiceDate') AS invoiceDate,
  ${PAYMENT_DUE_SQL} AS dueDate,
  CASE WHEN o.status='voided' THEN 0
    WHEN e.id IS NOT NULL AND o.paid_pence IS NOT NULL AND o.outstanding_pence IS NOT NULL THEN o.paid_pence+o.outstanding_pence
    ELSE COALESCE(json_extract(i.data,'$.totals.grossPence'),0) END AS totalPence,
  CASE WHEN ${UNCONFIRMED_BALANCE_SQL} THEN NULL ELSE ${OUTSTANDING_BALANCE_SQL} END AS balancePence,
  CASE WHEN e.id IS NULL THEN 'Strangers' ELSE 'QuickBooks' END AS source,
  o.observed_at AS checkedAt,CASE WHEN o.status='voided' THEN 1 ELSE 0 END AS voided
  FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN}`;
async function ledger(env: Env, customerId: string, statement: boolean) {
  const scope = statement ? `AND (${UNCONFIRMED_BALANCE_SQL} OR ${OUTSTANDING_BALANCE_SQL}>0 OR json_extract(i.data,'$.invoiceDate')>=?)` : "";
  const { results } = await env.DB.prepare(selectLedger + " WHERE i.customer_id=? " + scope + " ORDER BY i.seq DESC" + (statement ? "" : " LIMIT 30"))
    .bind(customerId, ...(statement ? [month() + "-01"] : [])).all<Omit<StatementLine, "appliedPence">>();
  return results.map(line => ({ ...line, appliedPence: line.balancePence === null ? null : line.totalPence - line.balancePence }));
}
async function customerAccount(env: Env, id: string) {
  const customer = await get<Customer>(env, "customer", id);
  if (!customer || customer.hidePrices) throw new ApiError(404, "not_found", "Billing account not found.");
  return customer;
}
async function accountDetails(env: Env, id: string) {
  const customer = await customerAccount(env, id);
  const [address, cadence] = await Promise.all([
    billingAddressFor(env, id),
    env.DB.prepare("SELECT cadence,version FROM wholesale_invoice_accounts WHERE customer_id=?").bind(id).first<Schedule>(),
  ]);
  return { id, business: customer.business, contact: customer.contact, recipient: accountsEmail(customer),
    recipientKind: customer.accountsEmail ? "Accounts email" : "Order email", terms: paymentTermsFor(customer),
    address: address?.address || tidyPostalAddress(customer.address || ""), postcode: address?.postcode || customer.postcode || "",
    confirmed: !!address, schedule: cadence || { cadence: "dispatch", version: 0 } satisfies Schedule };
}

async function accounts(req: Request, env: Env) {
  const params = new URL(req.url).searchParams, q = text(params.get("q") || "", "search", 120).toLowerCase();
  const after = text(params.get("after") || "", "next page", 400);
  const { results } = await env.DB.prepare(`SELECT c.id,json_extract(c.data,'$.business') AS business,
    COALESCE(a.cadence,'dispatch') AS cadence,lower(COALESCE(json_extract(c.data,'$.business'),''))||'|'||c.id AS cursor
    FROM wholesale_preview c LEFT JOIN wholesale_invoice_accounts a ON a.customer_id=c.id
    WHERE c.kind='customer' AND COALESCE(json_extract(c.data,'$.hidePrices'),0)=0
      AND (instr(lower(COALESCE(json_extract(c.data,'$.business'),'')||' '||COALESCE(json_extract(c.data,'$.accountsEmail'),'')||' '||
        COALESCE(json_extract(c.data,'$.email'),'')||' '||COALESCE(json_extract(c.data,'$.postcode'),'')),?)>0 OR ?='')
      AND (lower(COALESCE(json_extract(c.data,'$.business'),''))||'|'||c.id)>?
    ORDER BY cursor LIMIT 41`).bind(q, q, after).all<{ id: string; business: string; cadence: Schedule["cadence"]; cursor: string }>();
  const rows = results.slice(0, 40);
  return { accounts: rows.map(({ cursor, ...item }) => item), next: results.length > 40 ? rows.at(-1)!.cursor : null };
}

async function accountView(env: Env, id: string) {
  const account = await accountDetails(env, id);
  const [invoices, orders, orderCount, exception, balance] = await Promise.all([
    ledger(env, id, false),
    env.DB.prepare(`SELECT o.id AS id,${DISPATCHED} AS dispatchedAt,json_extract(o.data,'$.reference') AS reference,
      CASE WHEN json_extract(o.data,'$.tab') IS NOT NULL OR json_extract(o.data,'$.tabClearedId') IS NOT NULL THEN 1 ELSE 0 END AS tab
      ${UNBILLED_ORDERS} AND c.id=? ORDER BY dispatchedAt DESC,o.id LIMIT 15`).bind(id).all(),
    env.DB.prepare("SELECT COUNT(*) AS count " + UNBILLED_ORDERS + " AND c.id=?").bind(id).first<{ count: number }>(),
    env.DB.prepare(`SELECT i.seq AS id,i.invoice_number AS number,o.invoice_issue AS reason FROM wholesale_invoices i
      ${LIVE_ACCOUNTING_JOIN} WHERE i.customer_id=? AND o.invoice_issue IN
        ('The QuickBooks billing address differs from the issued invoice.','The QuickBooks billing postcode differs from the issued invoice.')
      ORDER BY i.seq DESC LIMIT 1`).bind(id).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(${OUTSTANDING_BALANCE_SQL}),0) AS balancePence,
      COALESCE(SUM(CASE WHEN ${PAYMENT_DUE_SQL}<? THEN ${OUTSTANDING_BALANCE_SQL} ELSE 0 END),0) AS overduePence,
      COUNT(*) FILTER(WHERE ${UNCONFIRMED_BALANCE_SQL}) AS unconfirmed, COUNT(*) AS invoiceCount
      FROM wholesale_invoices i ${LIVE_ACCOUNTING_JOIN} WHERE i.customer_id=?`).bind(day(), id).first(),
  ]);
  return { ...account, invoices, orders: orders.results, unbilled: orderCount?.count || 0, exception, balance };
}

async function statement(env: Env, id: string): Promise<AccountStatement> {
  const [account, lines, config] = await Promise.all([accountDetails(env, id), ledger(env, id, true), settings(env)]);
  return {
    business: account.business, address: account.address, postcode: account.postcode, recipient: account.recipient,
    seller: config.settings.seller.legalName || "Strangers Coffee Company", asAt: Date.now(), periodStart: month() + "-01",
    balancePence: lines.reduce((sum, line) => sum + (line.balancePence ?? 0), 0),
    unconfirmed: lines.filter(line => line.balancePence === null).length, lines,
  };
}

export async function handleBillingAccounts(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  if (route === "accounts" && req.method === "GET") return json(await accounts(req, env));
  const match = /^accounts\/([A-Za-z0-9_-]{1,100})(?:\/(schedule|statement)(\/pdf)?)?$/.exec(route);
  if (!match) return null;
  const [, id, screen, pdf] = match;
  if (!screen && req.method === "GET") return json(await accountView(env, id));
  if (screen === "statement" && req.method === "GET") {
    const saved = await statement(env, id);
    const fingerprint = await digest(JSON.stringify({ ...saved, asAt: 0 }));
    const purpose = "wholesale-statement:";
    if (pdf) {
      const review = await readToken(env, purpose, new URL(req.url).searchParams.get("review"));
      if (!review || review.account !== id || review.by !== user.id || review.fingerprint !== fingerprint) {
        throw new ApiError(409, "statement_changed", "Open the current account statement before downloading its PDF.");
      }
      return accountStatementPdf({ ...saved, asAt: review.at });
    }
    return json({ ...saved, downloadToken: await signToken(env, purpose, { account: id, by: user.id, at: saved.asAt, fingerprint }) });
  }
  if (screen === "schedule" && !pdf && req.method === "PUT") {
    await customerAccount(env, id);
    const body = object(await readJson(req, 1024)), expected = version(body.ifVersion), at = Date.now();
    if (body.cadence !== "dispatch" && body.cadence !== "monthly") throw invalid("Choose when to invoice this account.");
    const saved = await env.DB.prepare(`INSERT INTO wholesale_invoice_accounts(customer_id,cadence,version,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE COALESCE((SELECT version FROM wholesale_invoice_accounts WHERE customer_id=?),0)=?
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='admin')
      ON CONFLICT(customer_id) DO UPDATE SET cadence=excluded.cadence,version=version+1,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE version=? RETURNING cadence,version`)
      .bind(id, body.cadence, at, user.name, id, expected, user.id, expected).first<Schedule>();
    if (!saved) throw new ApiError(409, "conflict", "The billing schedule changed. Reload the account.");
    await audit(env, "wholesale_invoice_schedule", user.name, "Set " + (saved.cadence === "monthly" ? "monthly" : "on-dispatch") + " invoicing for billing account " + id + ".");
    return json(saved);
  }
  return null;
}
