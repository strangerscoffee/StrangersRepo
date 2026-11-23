// Automatic invoicing's QuickBooks steps (src/autoInvoice.ts): link the business and coffees (autoLinks.ts), then queue
// the issued invoice as a normal frozen export (the same preview, payload, Live checks and recovery as an admin's), in
// the name of the admin who switched automatic sending on, and once it's linked have QuickBooks email it.
import { ApiError, type Env } from '../http';
import { audit } from '../audit';
import { issuedInvoice, type InvoiceDocument } from '../wholesaleInvoices';
import { connection, ProviderError, resourceReader } from './connection';
import { verifiedMapping } from './mappings';
import { buildPayload } from './payload';
import { previewInvoice, type Environment } from './preview';
import { requireExportMode, settings } from './settings';
import { digest } from './crypto';
import { sourceHash, type ExportOperation } from './operationTypes';
import { processExport } from './ledger';
import { ensureCustomer, ensureItems } from './autoLinks';

/** Not sent (yet): what's needed, said so an admin can fix it. Tried again later. */
export class ExportHold extends ApiError { constructor(message: string) { super(409, 'quickbooks_held', message); } }

/** The existing export of this invoice in the active environment, or a new automatic one. Null when QuickBooks isn't
 *  connected there. Throws ExportHold when something needs setting up first. */
export async function queueAutomaticExport(req: Request, env: Env, invoiceId: number, enabledBy: string, emailTo: string): Promise<ExportOperation | null> {
  const state = await settings(env), mode: Environment = state.active_environment, company = await connection(env, mode);
  const existing = await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE environment=? AND invoice_id=? ORDER BY id DESC LIMIT 1').bind(mode, invoiceId).first<ExportOperation>();
  if (existing) return existing;
  if (company.status !== 'connected') return null;
  const admin = await env.DB.prepare("SELECT name FROM users WHERE id=? AND role='admin' AND active=1").bind(enabledBy).first<{ name: string }>();
  if (!admin) throw new ExportHold('The admin who switched on automatic sending is no longer an admin. Switch it off and on again.');
  const invoice = await issuedInvoice(env, invoiceId);
  const resources = await resourceReader(req, env, company);
  await ensureCustomer(env, mode, company, resources, invoice.customerId);
  await ensureItems(env, mode, company, resources, invoice);
  const verified = await verifiedMapping(req, env, mode, invoice, company), preview = await previewInvoice(invoice, verified.mappings);
  if (preview.state === 'blocked') throw new ExportHold(preview.blockers.map((b) => b.message).filter((m, i, all) => all.indexOf(m) === i).join(' '));
  const built = buildPayload(preview);
  try { await requireExportMode(req, env, company, built.profiles, state.version); }
  catch (error) { if (error instanceof ApiError && error.status < 500) throw new ExportHold(error.message); throw error; }
  await verified.resources.check();
  const payload = JSON.stringify(built.payload), at = Date.now();
  const saved = await env.DB.prepare(`INSERT INTO quickbooks_exports(environment,realm_id,company_name,company_vat,invoice_id,request_id,fingerprint,payload,payload_hash,source_hash,created_by,preview,profiles,connection_generation,mapping_version,created_at,updated_at,auto,email_to)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment=? AND generation=? AND version=? AND status='connected') AND EXISTS(SELECT 1 FROM quickbooks_settings WHERE id=1 AND active_environment=? AND version=?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1) ON CONFLICT DO NOTHING RETURNING *`)
    .bind(mode, company.realm_id, company.company_name, company.vat_number, invoiceId, preview.requestId, preview.fingerprint, payload, await digest(payload), await sourceHash(invoice), enabledBy, JSON.stringify(preview), JSON.stringify(built.profiles), company.generation, verified.mappingVersion, at, at, emailTo, mode, company.generation, company.version, mode, state.version, enabledBy).first<ExportOperation>();
  const row = saved || await env.DB.prepare('SELECT * FROM quickbooks_exports WHERE environment=? AND realm_id=? AND invoice_id=?').bind(mode, company.realm_id, invoiceId).first<ExportOperation>();
  if (!row) throw new ApiError(409, 'quickbooks_changed', 'The QuickBooks connection changed while the invoice was being queued. It will be tried again.');
  if (saved) await audit(env, 'quickbooks_export_queued', 'Automatic invoicing', `Invoice ${invoice.number} queued automatically for QuickBooks ${mode === 'production' ? 'Live' : 'Sandbox'} (switched on by ${admin.name}).`);
  return row;
}

export async function sendQueuedExport(req: Request, env: Env, row: ExportOperation) {
  if (['queued', 'uncertain', 'sending'].includes(row.state)) return processExport(req, env, row.id);
  return row;
}

/** Who QuickBooks emails: the business's accounts email, else its order email. In Sandbox, never a customer: the
 *  supplier email in the invoice settings, so the email can be checked. */
export async function emailFor(env: Env, invoice: InvoiceDocument, mode: Environment): Promise<string> {
  if (mode === 'sandbox') return (invoice.seller.email || '').trim();
  const customer = await env.DB.prepare("SELECT json_extract(data,'$.accountsEmail') AS accounts, json_extract(data,'$.email') AS email FROM wholesale_preview WHERE kind='customer' AND id=?").bind(invoice.customerId).first<{ accounts: string | null; email: string | null }>();
  return (customer?.accounts || customer?.email || '').trim();
}

/** Once an automatic export is linked: QuickBooks emails the invoice (once; if a reply was lost, the invoice's own
 *  EmailStatus says whether it went). Returns the export's email state. */
export async function emailLinkedInvoice(req: Request, env: Env, row: ExportOperation): Promise<string> {
  if (!row.auto || row.state !== 'linked' || row.email_state === 'sent' || row.email_state === 'skipped') return row.email_state;
  if (!row.email_to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email_to)) {
    await env.DB.prepare("UPDATE quickbooks_exports SET email_state='skipped',email_error=? WHERE id=? AND email_state<>'sent'").bind(row.environment === 'sandbox' ? 'Sandbox: add a supplier email in the invoice settings to receive test emails.' : 'This business has no email address.', row.id).run();
    return 'skipped';
  }
  const owner = crypto.randomUUID();
  const claimed = await env.DB.prepare("UPDATE quickbooks_exports SET email_state='sending',email_error=?,email_at=? WHERE id=? AND state='linked' AND (email_state IN ('','failed') OR (email_state='sending' AND email_at<?)) RETURNING *").bind(owner, Date.now(), row.id, Date.now() - 120000).first<ExportOperation>();
  if (!claimed) return row.email_state;
  try {
    const company = await connection(env, row.environment);
    if (company.status !== 'connected' || company.realm_id !== row.realm_id) throw new ApiError(409, 'quickbooks_reconnect', 'Reconnect QuickBooks to send the invoice email.');
    const resources = await resourceReader(req, env, company);
    const remote = (await resources.read('/invoice/' + row.remote_id + '?minorversion=75')).Invoice;
    if (remote?.EmailStatus !== 'EmailSent') await resources.write('/invoice/' + row.remote_id + '/send?minorversion=75&sendTo=' + encodeURIComponent(row.email_to), '', 'application/octet-stream');
    await env.DB.prepare("UPDATE quickbooks_exports SET email_state='sent',email_error='',email_at=? WHERE id=? AND email_error=?").bind(Date.now(), row.id, owner).run();
    const number = (JSON.parse(row.preview) as { candidate?: { number?: string } }).candidate?.number || '';
    await audit(env, 'quickbooks_invoice_emailed', 'Automatic invoicing', `QuickBooks ${row.environment === 'production' ? 'Live' : 'Sandbox'} emailed invoice ${number} to the ${row.environment === 'production' ? 'customer' : 'supplier (test) address'}.`);
    return 'sent';
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : error instanceof ApiError ? error.message : 'QuickBooks could not send the invoice email.';
    await env.DB.prepare("UPDATE quickbooks_exports SET email_state='failed',email_error=?,email_at=? WHERE id=? AND email_error=?").bind(message.slice(0, 300), Date.now(), row.id, owner).run();
    return 'failed';
  }
}
