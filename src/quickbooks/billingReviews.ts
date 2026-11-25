import type { User } from '../auth';
import { audit } from '../audit';
import { ApiError, type Env } from '../http';
import type { InvoiceDocument } from '../wholesaleInvoices';
import { connection, resourceReader } from './connection';
import { digest } from './crypto';
import { invoiceAddressDifference, billingAddressIdentity, quickBooksBillingAddress, type BillingAddress } from './invoiceAddresses';
import { sourceHash, type ExportOperation } from './operationTypes';
import type { ExportPreview, InvoiceCandidate } from './preview';

export const BILLING_EXPORT_HOLD = 'The QuickBooks customer billing address differs. Review the billing address before exporting.';
export const BILLING_ISSUES = [
  BILLING_EXPORT_HOLD,
  'The QuickBooks billing address differs from the issued invoice.',
  'The QuickBooks billing postcode differs from the issued invoice.',
];
export const isBillingIssue = (message: string) => BILLING_ISSUES.includes(message);

interface Review {
  id: number;
  choice: 'strangers' | 'quickbooks';
  address: string;
  postcode: string;
  actor: string;
  created_at: number;
  remote_id: string;
  remote_address_hash: string;
}

export async function billingAddressFor(env: Env, customerId: string) {
  return env.DB.prepare(`SELECT id, address, postcode FROM wholesale_invoice_billing_reviews
    WHERE customer_id=? AND environment='production' ORDER BY id DESC LIMIT 1`)
    .bind(customerId).first<BillingAddress & { id: number }>();
}

export async function billingHistory(env: Env, invoiceId: number) {
  const { results } = await env.DB.prepare(`SELECT choice,address,postcode,actor,created_at,environment FROM wholesale_invoice_billing_reviews
    WHERE invoice_id=? ORDER BY id DESC LIMIT 10`).bind(invoiceId)
    .all<Pick<Review, 'choice' | 'address' | 'postcode' | 'actor' | 'created_at'> & { environment: string }>();
  return results.map(({ actor, created_at: at, ...value }) => ({ ...value, by: actor, at }));
}

export async function billingException(env: Env, invoiceId: number) {
  return env.DB.prepare(`SELECT id AS exportId,environment,last_error AS reason FROM quickbooks_exports
    WHERE invoice_id=? AND state='review' AND last_error IN (?,?,?)
    ORDER BY environment='production' DESC,id DESC LIMIT 1`).bind(invoiceId, ...BILLING_ISSUES)
    .first<{ exportId: number; environment: string; reason: string }>();
}

async function lastReview(env: Env, exportId: number) {
  return env.DB.prepare('SELECT * FROM wholesale_invoice_billing_reviews WHERE export_id=? ORDER BY id DESC LIMIT 1')
    .bind(exportId).first<Review>();
}
const addressHash = (address: BillingAddress) => digest(JSON.stringify(billingAddressIdentity(address)));

/** A review applies only to the billing address and exact remote document the administrator saw. */
export async function reviewedAddress(env: Env, row: ExportOperation, address: BillingAddress | null, remoteId = row.remote_id) {
  if (!address) return null;
  const saved = await lastReview(env, row.id);
  return saved?.remote_id === remoteId && saved.remote_address_hash === await addressHash(address) ? saved : null;
}

/** Reuse an account decision while the approved address, company and QuickBooks customer still match. */
export async function reviewedAccountAddress(env: Env, row: ExportOperation, invoice: InvoiceCandidate, address: BillingAddress) {
  if (row.environment !== 'production') return false;
  const last = await env.DB.prepare(`SELECT r.address,r.postcode,r.remote_address_hash,e.realm_id,
      json_extract(e.preview,'$.candidate.customerRef') AS customer_ref
    FROM wholesale_invoice_billing_reviews r JOIN quickbooks_exports e ON e.id=r.export_id
    WHERE r.customer_id=? AND r.environment='production' ORDER BY r.id DESC LIMIT 1`).bind(invoice.localCustomerId)
    .first<BillingAddress & { remote_address_hash: string; realm_id: string; customer_ref: string }>();
  return !!last && last.realm_id === row.realm_id && last.customer_ref === invoice.customerRef
    && await addressHash(last) === await addressHash(invoice.billTo) && last.remote_address_hash === await addressHash(address);
}

export function billingCandidate(row: ExportOperation) {
  const preview = JSON.parse(row.preview) as ExportPreview;
  if (!preview.candidate?.customerRef) throw new ApiError(409, 'quickbooks_integrity', 'The saved QuickBooks invoice needs review.');
  return { preview, candidate: preview.candidate };
}

export async function billingMatchApproved(env: Env, row: ExportOperation, remote: any, name: string) {
  if (row.environment !== 'production' || remote?.Id !== row.remote_id) return false;
  return !!await reviewedAddress(env, row, quickBooksBillingAddress(remote.BillAddr, name, remote.CustomerRef?.name));
}

export async function loadBillingReview(req: Request, env: Env, row: ExportOperation, invoice: InvoiceDocument) {
  const { candidate } = billingCandidate(row);
  if (await sourceHash(invoice) !== row.source_hash) {
    throw new ApiError(409, 'quickbooks_integrity', 'The issued invoice differs from the saved export.');
  }
  const company = await connection(env, row.environment);
  if (company.realm_id !== row.realm_id || company.status !== 'connected') {
    throw new ApiError(409, 'quickbooks_company_changed', 'Reconnect the original QuickBooks company to review its billing address.');
  }
  const resources = await resourceReader(req, env, company);
  let address, remoteName;
  if (row.remote_id) {
    const { Invoice } = await resources.read('/invoice/' + row.remote_id + '?minorversion=75');
    if (Invoice?.Id !== row.remote_id || Invoice.DocNumber !== candidate.number || Invoice.CustomerRef?.value !== candidate.customerRef || Invoice.CurrencyRef?.value !== 'GBP') {
      throw new ApiError(409, 'quickbooks_invoice_mismatch', 'QuickBooks could not verify this invoice and its customer.');
    }
    address = Invoice.BillAddr;
    remoteName = Invoice.CustomerRef?.name;
  } else {
    const { Customer } = await resources.read('/customer/' + candidate.customerRef + '?minorversion=75');
    if (Customer?.Id !== candidate.customerRef || Customer.Active !== true || (Customer.CurrencyRef?.value && Customer.CurrencyRef.value !== 'GBP')) {
      throw new ApiError(409, 'quickbooks_invoice_mismatch', 'QuickBooks could not verify this billing customer.');
    }
    address = Customer.BillAddr;
    remoteName = Customer.DisplayName;
  }
  await resources.check();
  const quickbooks = quickBooksBillingAddress(address, candidate.billTo.name, remoteName);
  if (!quickbooks) throw new ApiError(409, 'billing_address_unavailable', 'QuickBooks does not have a complete billing address to compare.');
  const strangers = { address: invoice.billTo.address, postcode: invoice.billTo.postcode };
  const remoteHash = await addressHash(quickbooks);
  const accountRevision = (await billingAddressFor(env, invoice.customerId))?.id ?? 0;
  const latest = await lastReview(env, row.id);
  const token = await digest(JSON.stringify([row.id, row.version, row.remote_id, company.version, company.generation,
    accountRevision, latest?.id ?? 0, remoteHash, row.source_hash]));
  const beforeWrite = row.write_started_at === 0 && !row.remote_id;
  const retry = row.state === 'review' && isBillingIssue(row.last_error)
    && (beforeWrite || Boolean(row.remote_id) && row.environment === 'production');
  return {
    company, row, invoice, latest: latest?.id ?? 0, accountRevision, remoteHash,
    public: {
      token, strangers, quickbooks, retry,
      number: invoice.number, business: invoice.billTo.name, company: row.company_name,
      environment: row.environment, posted: Boolean(row.remote_id),
      difference: invoiceAddressDifference(JSON.parse(row.payload).BillAddr, address, candidate.billTo.name, remoteName),
      history: await billingHistory(env, row.invoice_id),
    },
  };
}

export async function saveBillingReview(
  env: Env, review: Awaited<ReturnType<typeof loadBillingReview>>, user: User, choice: 'strangers' | 'quickbooks',
) {
  const { row, company, remoteHash, accountRevision, latest, invoice } = review;
  const picked = review.public[choice];
  if (!picked.address) throw new ApiError(409, 'billing_address_unavailable', 'Choose a complete billing address.');
  const at = Date.now();
  const result = await env.DB.prepare(`INSERT INTO wholesale_invoice_billing_reviews
    (review_key,invoice_id,export_id,customer_id,environment,remote_id,remote_address_hash,choice,address,postcode,actor,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM quickbooks_exports WHERE id=? AND version=? AND lease_until<=?)
      AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND realm_id=? AND generation=? AND version=? AND status='connected')
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1)
      AND EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=?)
      AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_billing_reviews WHERE environment='production' AND customer_id=? AND id>?)
      AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_billing_reviews WHERE export_id=? AND id>?)
    ON CONFLICT(review_key) DO NOTHING RETURNING id`)
    .bind(review.public.token, row.invoice_id, row.id, invoice.customerId, row.environment, row.remote_id, remoteHash, choice,
      picked.address, picked.postcode, user.name, at, row.id, row.version, at,
      row.environment, row.realm_id, company.generation, company.version, user.id,
      invoice.customerId, invoice.customerId, accountRevision, row.id, latest).first<{ id: number }>();
  if (!result) throw new ApiError(409, 'billing_review_changed', 'The invoice or billing account changed. Open the latest comparison.');
  const source = choice === 'quickbooks' ? 'QuickBooks' : 'Strangers';
  await audit(env, 'wholesale_invoice_billing_review', user.name,
    `${user.name} confirmed the ${source} billing address for invoice ${invoice.number}${row.environment === "sandbox" ? " (Sandbox)" : ""}.`);
  return { address: picked.address, postcode: picked.postcode, at, by: user.name };
}
