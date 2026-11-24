// Automatic invoicing's QuickBooks steps (src/autoInvoice.ts): link the business and coffees (autoLinks.ts), then queue
// the issued invoice as a normal frozen export (the same preview, payload, Live checks and recovery as an admin's), in
// the name of the admin who switched automatic sending on, and once it's linked have QuickBooks email it.
import { ApiError, type Env } from '../http';
import { audit } from '../audit';
import { cleanEmail } from '../email/address';
import { issuedInvoice, type InvoiceDocument } from '../wholesaleInvoices';
import { connection, ProviderError, resourceReader } from './connection';
import { verifiedMapping } from './mappings';
import { buildPayload, invoiceDetails, matchesInvoice, profileKeys } from './payload';
import { previewInvoice, type Environment, type ExportPreview } from './preview';
import { requireExportMode, settings } from './settings';
import { digest } from './crypto';
import { sourceHash, type ExportOperation } from './operationTypes';
import { ensureCustomer, ensureItems } from './autoLinks';
import { automaticAllowed } from './autoPolicy';

/** Not sent (yet): what's needed, said so an admin can fix it. Tried again later. */
export class ExportHold extends ApiError { constructor(message: string) { super(409, 'quickbooks_held', message); } }

function requirePreview(preview: ExportPreview) {
  if (!preview.candidate || !preview.requestId) throw new ExportHold([...new Set(preview.blockers.map(b => b.message))].join(' '));
  return { candidate: preview.candidate, requestId: preview.requestId };
}

/** Resume the original automatic export, even after an environment switch. */
export async function queueAutomaticExport(req: Request, env: Env, invoiceId: number, enabledBy: string, source: string, owner: string): Promise<ExportOperation | null> {
  const state = await settings(env), mode: Environment = state.active_environment, company = await connection(env, mode);
  const existing = await env.DB.prepare(`SELECT * FROM quickbooks_exports WHERE invoice_id=? AND (auto=1 OR environment=?)
    ORDER BY auto DESC,id LIMIT 1`).bind(invoiceId, mode).first<ExportOperation>();
  if (existing) {
    if (existing.environment !== mode || existing.realm_id !== company.realm_id) {
      throw new ExportHold('This invoice already has a saved export for another company or environment. Open its original export in QuickBooks.');
    }
    return existing;
  }
  if (company.status !== 'connected') return null;
  const invoice = await issuedInvoice(env, invoiceId);
  if (invoice.payment.paid) throw new ExportHold('This invoice is recorded paid on the website. Review the payment before exporting by hand.');
  const allowed = automaticAllowed('?', '?');
  const sourceLease = 'EXISTS(SELECT 1 FROM wholesale_auto_invoices WHERE source=? AND invoice_id=? AND lease_owner=? AND lease_until>?)';
  const scope = "EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment=? AND version=?) AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND realm_id=? AND generation=? AND version=? AND status='connected')";
  const adminActive = "EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1)";
  const unpaid = 'EXISTS(SELECT 1 FROM wholesale_invoices WHERE seq=? AND paid=0)';
  const permit = `${allowed} AND ${sourceLease} AND ${scope} AND ${adminActive} AND ${unpaid}`;
  const permissionArgs = () => [invoiceId, enabledBy, source, invoiceId, owner, Date.now(), mode, state.version, mode, company.realm_id, company.generation, company.version, enabledBy, invoiceId];
  const checkPermission = async () => {
    if (!await env.DB.prepare(`SELECT 1 WHERE ${permit}`).bind(...permissionArgs()).first()) {
      throw new ExportHold('Automatic export permission, payment or accounting settings changed. Review this invoice before sending.');
    }
  };
  const admin = await env.DB.prepare("SELECT name FROM users WHERE id=? AND role='admin' AND active=1").bind(enabledBy).first<{ name: string }>();
  if (!admin) throw new ExportHold('The admin who switched on automatic sending is no longer an admin. Switch it off and on again.');
  await checkPermission();
  await requireExportMode(req, env, company, [], state.version);
  const initial = await verifiedMapping(req, env, mode, invoice, company);
  const preflight = requirePreview(await previewInvoice(invoice, initial.mappings, true));
  invoiceDetails(preflight.candidate, preflight.requestId, true);
  const profiles = profileKeys(preflight.candidate);
  const checkReadiness = () => requireExportMode(req, env, company, profiles, state.version);
  await checkReadiness();
  const resources = {
    ...initial.resources,
    write: (path: string, body: unknown) => initial.resources.write(path, body, 'application/json', async () => {
      await checkReadiness();
      await checkPermission();
    }),
  };
  await ensureCustomer(env, mode, company, resources, invoice.customerId);
  await ensureItems(env, mode, company, resources, invoice);
  const verified = await verifiedMapping(req, env, mode, invoice, company), preview = await previewInvoice(invoice, verified.mappings);
  requirePreview(preview);
  const built = buildPayload(preview);
  await requireExportMode(req, env, company, built.profiles, state.version);
  await verified.resources.check();
  const payload = JSON.stringify(built.payload), at = Date.now();
  const saved = await env.DB.prepare(`INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,created_at,updated_at,auto)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1 WHERE ${permit}
      AND EXISTS(SELECT 1 FROM quickbooks_environment_mappings WHERE environment=? AND realm_id=? AND version=?)
      AND NOT EXISTS(SELECT 1 FROM quickbooks_exports WHERE invoice_id=? AND auto=1)
    ON CONFLICT DO NOTHING RETURNING *`)
    .bind(mode, company.realm_id, company.company_name, company.vat_number, invoiceId, preview.requestId, preview.fingerprint, payload, await digest(payload), await sourceHash(invoice), enabledBy, JSON.stringify(preview), JSON.stringify(built.profiles), company.generation, verified.mappingVersion, at, at,
      ...permissionArgs(), mode, company.realm_id, verified.mappingVersion, invoiceId).first<ExportOperation>();
  const row = saved || await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE environment=? AND realm_id=? AND invoice_id=?').bind(mode, company.realm_id, invoiceId).first<ExportOperation>();
  if (!row) throw new ApiError(409, 'quickbooks_changed', 'The QuickBooks connection changed while the invoice was being queued. It will be tried again.');
  if (saved) await audit(env, 'quickbooks_export_queued', 'Automatic invoicing', `Invoice ${invoice.number} queued automatically for QuickBooks ${mode === 'production' ? 'Live' : 'Sandbox'} (switched on by ${admin.name}).`);
  return row;
}

async function emailFor(env: Env, invoice: InvoiceDocument, mode: Environment) {
  if (mode === 'sandbox') {
    const supplier = await env.DB.prepare("SELECT json_extract(data,'$.seller.email') AS email,version FROM wholesale_invoice_settings WHERE id=1").first<{ email: string | null; version: number }>();
    return { address: cleanEmail(supplier?.email ?? ''), version: supplier?.version ?? 0 };
  }
  const customer = await env.DB.prepare("SELECT json_extract(data,'$.accountsEmail') AS accounts,json_extract(data,'$.email') AS email,version FROM wholesale_preview WHERE kind='customer' AND id=?").bind(invoice.customerId).first<{ accounts: string | null; email: string | null; version: number }>();
  return { address: cleanEmail(customer?.accounts?.trim() || customer?.email || ''), version: customer?.version ?? 0 };
}

/** Read back ambiguous attempts without sending again. "failed" is legacy and may have reached Intuit. */
export async function emailLinkedInvoice(req: Request, env: Env, row: ExportOperation, source: string, owner: string) {
  if (row.email_state === 'sent') return 'sent';
  const ambiguous = ['sending', 'unknown', 'failed'].includes(row.email_state);
  if (row.email_state === 'sending' && row.email_at > Date.now() - 120000) return 'sending';
  let revision = row.version;
  const persist = async (state: string, message = '', to = row.email_to) => {
    const saved = await env.DB.prepare(`UPDATE quickbooks_exports SET email_state=?,email_error=?,email_to=?,email_at=?,version=version+1
      WHERE id=? AND version=? RETURNING email_state`).bind(state, message.slice(0, 300), to, Date.now(), row.id, revision).first<{ email_state: string }>();
    return saved?.email_state ?? 'sending';
  };
  const preview = JSON.parse(row.preview) as ExportPreview;
  const markSent = async (address: string) => {
    const saved = await persist('sent', '', address);
    if (saved === 'sent') await audit(env, 'quickbooks_invoice_emailed', 'Automatic invoicing', `QuickBooks ${row.environment === 'production' ? 'Live' : 'Sandbox'} confirmed the email for invoice ${preview.candidate?.number} to the ${row.environment === 'production' ? 'customer' : 'supplier (test) address'}.`);
    return saved;
  };
  let attempted = false, address = '';
  try {
    const company = await connection(env, row.environment);
    if (company.status !== 'connected' || company.realm_id !== row.realm_id) throw new ApiError(409, 'quickbooks_reconnect', 'Reconnect QuickBooks to send the invoice email.');
    const state = await requireExportMode(req, env, company, JSON.parse(row.profiles));
    const invoice = await issuedInvoice(env, row.invoice_id);
    if (await sourceHash(invoice) !== row.source_hash || await digest(row.payload) !== row.payload_hash ||
      !preview.candidate || await digest(JSON.stringify(preview.candidate)) !== row.fingerprint) {
      throw new ExportHold('The saved invoice changed. Review it in QuickBooks before emailing.');
    }
    const resources = await resourceReader(req, env, company);
    const remote = (await resources.read('/invoice/' + row.remote_id + '?minorversion=75')).Invoice;
    const payload = JSON.parse(row.payload);
    const match = matchesInvoice(preview, payload, remote, true);
    if (!match.matches || remote?.Id !== row.remote_id) throw new ExportHold(match.reason || 'The QuickBooks invoice identity differs.');
    const recipient = await emailFor(env, invoice, row.environment);
    address = (ambiguous ? cleanEmail(row.email_to) : recipient.address) || '';
    const confirmed = (value: any) => address && value?.Id === row.remote_id && value.EmailStatus === 'EmailSent' && cleanEmail(value.BillEmail?.Address) === address;
    await resources.check();
    if (remote.EmailStatus === 'EmailSent') {
      if (confirmed(remote) && address === recipient.address) return await markSent(address);
      throw new ExportHold('QuickBooks reports that this invoice was already emailed to a different or unconfirmed address. Review the sent email in QuickBooks.');
    }
    if (ambiguous) throw new ExportHold('QuickBooks has not confirmed the earlier email attempt. Check the invoice in QuickBooks before sending it by hand.');
    if (!address) throw new ExportHold(row.environment === 'sandbox' ? 'Sandbox: add a valid supplier email in Invoice settings to receive tests.' : 'Add a valid accounts or order email for this business.');
    const remoteMemo = typeof remote.CustomerMemo?.value === 'string' ? remote.CustomerMemo.value.replace(/\r\n/g, '\n').trim() : '';
    if (preview.candidate.paymentInstructions && (!preview.customerPaymentInstructions ||
      remoteMemo !== payload.CustomerMemo.value.replace(/\r\n/g, '\n').trim())) {
      throw new ExportHold('The QuickBooks invoice does not show the saved payment instructions. Review it before emailing by hand.');
    }
    const sent = (await resources.write('/invoice/' + row.remote_id + '/send?minorversion=75&sendTo=' + encodeURIComponent(address), '', 'application/octet-stream', async () => {
      const sameRecipient = row.environment === 'sandbox'
        ? "EXISTS(SELECT 1 FROM wholesale_invoice_settings WHERE id=1 AND version=?)"
        : "EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=? AND version=?)";
      const at = Date.now();
      const claimed = await env.DB.prepare(`UPDATE quickbooks_exports SET email_state='sending',email_to=?,email_error='',email_at=?,version=version+1
        WHERE id=? AND version=? AND state='linked' AND auto=1 AND manual_retry=0 AND created_remote=1
          AND email_state IN ('','retryable','skipped') AND remote_id=?
          AND ${automaticAllowed('quickbooks_exports.invoice_id', 'quickbooks_exports.created_by', true)}
          AND EXISTS(SELECT 1 FROM wholesale_auto_invoices WHERE source=? AND invoice_id=quickbooks_exports.invoice_id AND lease_owner=? AND lease_until>?)
          AND EXISTS(SELECT 1 FROM users WHERE id=quickbooks_exports.created_by AND role='admin' AND active=1)
          AND EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment=? AND version=?)
          AND ${sameRecipient} RETURNING version`)
        .bind(address, at, row.id, revision, row.remote_id, source, owner, at, row.environment, state.version,
          ...(row.environment === 'sandbox' ? [recipient.version] : [invoice.customerId, recipient.version])).first<{ version: number }>();
      if (!claimed) throw new ExportHold('Email permission, the recipient or accounting settings changed before sending.');
      revision = claimed.version;
      attempted = true;
    })).Invoice;
    if (!confirmed(sent)) throw new ExportHold('QuickBooks did not confirm the invoice email and recipient. Check the invoice before sending it by hand.');
    return await markSent(address);
  } catch (error) {
    const rejected = error instanceof ProviderError && [400, 401, 403, 404, 422, 429].includes(error.providerStatus);
    const uncertain = ambiguous || (attempted && !rejected);
    const message = error instanceof ApiError && !uncertain ? error.message
      : error instanceof ExportHold ? error.message
      : uncertain ? 'The email attempt was not confirmed. Check the invoice in QuickBooks before sending it by hand.'
      : 'QuickBooks could not check the invoice email. It will be tried again.';
    return persist(uncertain ? 'unknown' : 'retryable', message, attempted ? address : row.email_to);
  }
}
