import type { Env } from '../http';
import type { CompanyScope } from './preview';
import type { ExportOperation } from './operationTypes';

function transactionIds(links: unknown, kind: 'Invoice' | 'Payment'): string[] {
  if (!Array.isArray(links)) return [];
  return links.flatMap(link => {
    if (link?.TxnType !== kind) return [];
    const id = typeof link.TxnId === 'string' || Number.isSafeInteger(link.TxnId) ? String(link.TxnId) : '';
    return /^\d{1,32}$/.test(id) ? [id] : [];
  });
}

export function invoicePaymentIds(invoice: { LinkedTxn?: unknown }): string[] {
  return [...new Set(transactionIds(invoice.LinkedTxn, 'Payment'))];
}

export function paymentInvoiceIds(payment: { Line?: unknown }): string[] {
  return Array.isArray(payment.Line) ? [...new Set(payment.Line.flatMap(line => transactionIds(line?.LinkedTxn, 'Invoice')))] : [];
}

// QuickBooks can clear links when it voids a payment. Retain the relationships seen on either authoritative record.
export async function rememberInvoicePayments(env: Env, exported: ExportOperation, paymentIds: string[]) {
  if (!paymentIds.length) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO quickbooks_payment_links(export_id,payment_id)
    SELECT ?,value FROM json_each(?)`).bind(exported.id,JSON.stringify(paymentIds)).run();
}

export async function rememberPaymentInvoices(env: Env, scope: CompanyScope, paymentId: string, invoiceIds: string[]) {
  if (!invoiceIds.length) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO quickbooks_payment_links(export_id,payment_id)
    SELECT id,? FROM quickbooks_exports WHERE environment=? AND realm_id=? AND state='linked'
      AND remote_id IN (SELECT value FROM json_each(?))`)
    .bind(paymentId,scope.environment,scope.realmId,JSON.stringify(invoiceIds)).run();
}

export async function confirmPaymentVoid(env: Env, scope: CompanyScope, paymentId: string): Promise<string[]> {
  await env.DB.prepare(`INSERT OR IGNORE INTO quickbooks_payment_voids(environment,realm_id,payment_id,confirmed_at)
    VALUES(?,?,?,?)`).bind(scope.environment,scope.realmId,paymentId,Date.now()).run();
  const linked = await env.DB.prepare(`SELECT e.remote_id FROM quickbooks_payment_links p JOIN quickbooks_exports e ON e.id=p.export_id
    WHERE p.payment_id=? AND e.environment=? AND e.realm_id=? AND e.state='linked'`)
    .bind(paymentId,scope.environment,scope.realmId).all<{ remote_id: string }>();
  return linked.results.map(row => row.remote_id);
}

export async function hasVoidedPayment(env: Env, exported: ExportOperation, readStartedAt: number): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT 1 FROM quickbooks_payment_links p JOIN quickbooks_payment_voids v ON v.payment_id=p.payment_id
    WHERE p.export_id=? AND v.environment=? AND v.realm_id=? AND v.confirmed_at<=? LIMIT 1`)
    .bind(exported.id,exported.environment,exported.realm_id,readStartedAt).first();
}

// When an invoice's balance goes back up, look up missing payments even if QuickBooks never sent the void webhook.
export async function checkMissingPayments(env: Env, exported: ExportOperation, currentIds: string[], readStartedAt: number) {
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO quickbooks_events(event_key,environment,realm_id,entity,entity_id,operation,event_at,created_at)
    SELECT ?||':'||p.payment_id,?,?,'Payment',p.payment_id,'check',?,? FROM quickbooks_payment_links p
    WHERE p.export_id=? AND p.payment_id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM quickbooks_payment_voids v WHERE v.environment=? AND v.realm_id=? AND v.payment_id=p.payment_id)
      AND NOT EXISTS(SELECT 1 FROM quickbooks_events q WHERE q.environment=? AND q.realm_id=? AND q.entity='Payment'
        AND q.entity_id=p.payment_id AND q.state IN ('queued','processing'))`)
    .bind('payment-check:'+exported.id+':'+readStartedAt,exported.environment,exported.realm_id,now,now,exported.id,JSON.stringify(currentIds),
      exported.environment,exported.realm_id,exported.environment,exported.realm_id).run();
}
