import { audit } from './audit';
import { readToken, signToken, type User } from './auth';
import { recipientSuppressed } from './email/delivery';
import { orderSender } from './email/sender';
import { cleanEmail, emailReady, sendOutcome, type Outgoing } from './email/send';
import { esc } from './email/templates';
import { ApiError, type Env, invalid, json, readJson } from './http';
import { ukDay } from './insightsMath';
import { connection } from './quickbooks/connection';
import { digest } from './quickbooks/crypto';
import { refreshObservation } from './quickbooks/observations';
import type { ExportOperation } from './quickbooks/operationTypes';
import type { Customer } from './wholesaleAccounts';
import { issuedInvoice, type InvoiceDocument } from './wholesaleInvoices';
import { object, text, version } from './wholesaleStore';

const PREFIX = 'invoice-reminder:';
const PREVIEW_MS = 10 * 60000;
const SENDING_MS = 2 * 60000;
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const block = (code: string, message: string) => new ApiError(409, code, message);
const changed = () => block('reminder_changed', 'The balance, recipient or reminder history changed. Check QuickBooks again to review the latest email.');
type Status = 'sending' | 'accepted' | 'failed' | 'unknown';
interface Hold { reason: string; version: number; actor: string; updated_at: number }
interface Reminder {
  id: number; review_key: string; invoice_id: number; recipient: string; amount_pence: number;
  due_date: string; actor: string; status: Status; created_at: number; updated_at: number;
}
interface PreviewToken { key: string; invoice: number; user: string; until: number; fingerprint: string; lastId: number; holdVersion: number }
const result = (row: Reminder) => ({ id: row.id, to: row.recipient, amountPence: row.amount_pence,
  dueDate: row.due_date, by: row.actor, status: row.status, at: row.updated_at });

async function collection(env: Env, invoiceId: number) {
  const at = Date.now();
  // Recover provider acceptance if a request stopped after the mail provider responded.
  await env.DB.prepare(`UPDATE wholesale_invoice_reminders AS r
    SET status='accepted',updated_at=(SELECT accepted_at FROM email_delivery_messages WHERE id=r.review_key)
    WHERE invoice_id=? AND status IN ('sending','unknown') AND EXISTS(SELECT 1 FROM email_delivery_messages WHERE id=r.review_key)`).bind(invoiceId).run();
  await env.DB.prepare(`UPDATE wholesale_invoice_reminders SET status='unknown',updated_at=?
    WHERE invoice_id=? AND status='sending' AND created_at<=?`).bind(at, invoiceId, at - SENDING_MS).run();
  const [hold, history] = await Promise.all([
    env.DB.prepare('SELECT reason,version,actor,updated_at FROM wholesale_invoice_reminder_holds WHERE invoice_id=?').bind(invoiceId).first<Hold>(),
    env.DB.prepare('SELECT * FROM wholesale_invoice_reminders WHERE invoice_id=? ORDER BY id DESC LIMIT 10').bind(invoiceId).all<Reminder>(),
  ]);
  return {
    hold: { reason: hold?.reason || '', version: hold?.version || 0, by: hold?.actor || '', at: hold?.updated_at || null },
    history: history.results.map(result),
  };
}

async function verifiedDraft(req: Request, env: Env, invoice: InvoiceDocument) {
  const invoiceId = invoice.id!;
  const [state, exported, contact, company] = await Promise.all([
    collection(env, invoiceId),
    env.DB.prepare("SELECT * FROM quickbooks_exports WHERE invoice_id=? AND environment='production' AND state='linked'").bind(invoiceId).first<ExportOperation>(),
    env.DB.prepare("SELECT data,version FROM wholesale_preview WHERE kind='customer' AND id=?").bind(invoice.customerId).first<{ data: string; version: number }>(),
    connection(env, 'production'),
  ]);
  if (state.hold.reason) throw block('reminder_held', 'Payment reminders are on hold for this invoice.');
  if (state.history.some(record => record.status === 'unknown' || record.status === 'sending')) {
    throw block('reminder_unconfirmed', 'Confirm the previous reminder’s outcome before preparing another.');
  }
  if (!exported) throw block('reminder_unlinked', 'Link this invoice to QuickBooks Live before preparing a payment reminder.');
  if (!emailReady(env)) throw block('email_off', 'Payment reminder emails need the site’s email service to be set up.');
  const customer = contact ? JSON.parse(contact.data) as Customer : null;
  const accounts = customer?.accountsEmail?.trim();
  const recipient = cleanEmail(accounts || customer?.email || '');
  if (!contact || !customer || customer.hidePrices || !recipient) {
    throw block('reminder_recipient', 'Add a valid accounts or order email to this customer before preparing a reminder.');
  }
  if (await recipientSuppressed(env, recipient)) {
    throw block('reminder_suppressed', 'This recipient has a delivery issue. Review the address in Email health before sending.');
  }

  const started = Date.now();
  const checked = await refreshObservation(req, env, exported).catch((error) => {
    if (error instanceof ApiError) throw block('reminder_balance_unconfirmed', 'QuickBooks could not confirm the balance. ' + error.message);
    throw error;
  });
  if (!checked || checked.read_started_at < started || checked.status === 'review' || checked.outstanding_pence === null || checked.reason) {
    throw block('reminder_balance_unconfirmed', 'QuickBooks could not confirm the balance. Open the invoice to review its payment status.');
  }
  if (checked.status === 'voided') throw block('reminder_voided', 'QuickBooks shows this invoice as voided.');
  if (checked.outstanding_pence <= 0) throw block('reminder_settled', 'QuickBooks shows £0.00 outstanding. This invoice does not need a reminder.');
  if (!checked.due_date || checked.due_date >= ukDay(Date.now())) {
    throw block('reminder_not_due', 'QuickBooks has not confirmed an overdue balance. Check the invoice due date.');
  }

  const balance = money.format(checked.outstanding_pence / 100);
  const due = date.format(new Date(checked.due_date + 'T00:00:00Z'));
  const paragraphs = [
    `Hello ${customer.business},`,
    `QuickBooks shows ${balance} outstanding on invoice ${invoice.number}, due on ${due}.`,
    `Please use ${invoice.number} as your payment reference. If you’ve already paid or have a question, please reply to this email.`,
    'Strangers Coffee Accounts',
  ];
  const mail = {
    subject: `Payment reminder · ${invoice.number}`,
    text: paragraphs.join('\n\n'),
    html: paragraphs.map(paragraph => '<p>' + esc(paragraph) + '</p>').join(''),
  };
  const outgoing: Outgoing = {
    to: { id: invoice.customerId, name: customer.business, email: recipient, email_prefs: '{}', active: 1 },
    kind: 'order', mail, about: 'Payment reminder for ' + invoice.number, from: orderSender(env),
    replyTo: cleanEmail(invoice.seller.email) || undefined,
  };
  const preview = { to: recipient, recipientLabel: accounts ? 'Accounts email' : 'Order contact', amountPence: checked.outstanding_pence,
    dueDate: checked.due_date, checkedAt: checked.observed_at, paymentVoided: Boolean(checked.payment_voided), subject: mail.subject, text: mail.text };
  const fingerprint = await digest(JSON.stringify([
    outgoing, preview.amountPence, preview.dueDate, preview.paymentVoided, exported.id, exported.realm_id, exported.remote_id, company.generation,
  ]));
  return { state, exported, company, contactVersion: contact.version, checked, outgoing, preview, fingerprint };
}

async function sendReminder(req: Request, env: Env, invoice: InvoiceDocument, user: User, body: Record<string, unknown>) {
  const approved: PreviewToken | null = await readToken(env, PREFIX, body.token);
  if (!approved || approved.invoice !== invoice.id || approved.user !== user.id) throw changed();
  const saved = () => env.DB.prepare('SELECT * FROM wholesale_invoice_reminders WHERE review_key=? AND invoice_id=?')
    .bind(approved.key, invoice.id).first<Reminder>();
  const previous = await saved();
  if (previous) {
    const state = await collection(env, invoice.id!);
    return { reminder: state.history.find(item => item.id === previous.id) ?? result(previous) };
  }
  if (approved.until < Date.now()) throw changed();
  const draft = await verifiedDraft(req, env, invoice);
  const { state, exported, checked, company, preview } = draft;
  if (draft.fingerprint !== approved.fingerprint || state.hold.version !== approved.holdVersion || (state.history[0]?.id ?? 0) !== approved.lastId) {
    throw changed();
  }
  let claimed: Reminder | null = null, claimFailed = false;
  const outcome = await sendOutcome(env, draft.outgoing, approved.key, async () => {
    const at = Date.now();
    if (approved.until < at) { claimFailed = true; throw changed(); }
    claimed = await env.DB.prepare(`INSERT INTO wholesale_invoice_reminders
      (review_key,invoice_id,recipient,amount_pence,due_date,actor,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,'sending',?,?
      WHERE EXISTS(SELECT 1 FROM quickbooks_exports e JOIN quickbooks_observations o ON o.export_id=e.id
        WHERE e.id=? AND e.invoice_id=? AND e.environment='production' AND e.state='linked' AND e.remote_id=? AND o.version=?)
        AND EXISTS(SELECT 1 FROM quickbooks_connections WHERE environment='production' AND realm_id=? AND version=? AND generation=? AND status='connected')
        AND EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=? AND version=?)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1)
        AND COALESCE((SELECT version FROM wholesale_invoice_reminder_holds WHERE invoice_id=?),0)=?
        AND COALESCE((SELECT MAX(id) FROM wholesale_invoice_reminders WHERE invoice_id=?),0)=?
        AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_reminders WHERE invoice_id=? AND status IN ('sending','unknown'))
      ON CONFLICT(review_key) DO NOTHING RETURNING *`)
      .bind(approved.key, invoice.id, preview.to, preview.amountPence, preview.dueDate, user.name, at, at,
        exported.id, invoice.id, exported.remote_id, checked.version, exported.realm_id, company.version, company.generation,
        invoice.customerId, draft.contactVersion, user.id, invoice.id, approved.holdVersion, invoice.id, approved.lastId, invoice.id)
      .first<Reminder>();
    if (!claimed) { claimFailed = true; throw changed(); }
  });
  if (!claimed) {
    const concurrent = await saved();
    if (concurrent) return { reminder: result(concurrent) };
    if (claimFailed) throw changed();
    if (outcome.status === 'limit') throw block('reminder_limit', 'The site’s daily email limit has been reached. Check the balance again before trying later.');
    throw block('reminder_email_unavailable', 'The email service could not accept this reminder. Check Email health and try again.');
  }
  const status = outcome.status === 'sent' ? 'accepted' : (outcome.uncertain || (outcome.providerStatus ?? 0) >= 500) ? 'unknown' : 'failed';
  const savedOutcome = await env.DB.prepare("UPDATE wholesale_invoice_reminders SET status=?,updated_at=? WHERE review_key=? AND status='sending' RETURNING *")
    .bind(status, Date.now(), approved.key).first<Reminder>();
  if (status === 'accepted') await audit(env, 'wholesale_invoice_reminder', user.name,
    `${user.name} sent the payment reminder for invoice ${invoice.number} to the customer’s ${preview.recipientLabel.toLowerCase()}.`);
  return { reminder: result(savedOutcome ?? (await saved()) ?? claimed) };
}

export async function handleInvoiceReminders(req: Request, env: Env, route: string, user: User): Promise<Response | null> {
  const match = /^invoices\/(\d+)\/reminders(?:\/(preview|send|hold|confirm))?$/.exec(route);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid('Choose a valid invoice.');
  const invoice = await issuedInvoice(env, id), action = match[2];
  if (!action && req.method === 'GET') return json(await collection(env, id));
  if (action === 'preview' && req.method === 'POST') {
    await readJson(req, 1024);
    const draft = await verifiedDraft(req, env, invoice);
    const token = await signToken(env, PREFIX, {
      key: PREFIX + crypto.randomUUID(), invoice: id, user: user.id, until: Date.now() + PREVIEW_MS,
      fingerprint: draft.fingerprint, lastId: draft.state.history[0]?.id ?? 0, holdVersion: draft.state.hold.version,
    } satisfies PreviewToken);
    return json({ ...draft.preview, token });
  }
  if (action === 'send' && req.method === 'POST') return json(await sendReminder(req, env, invoice, user, object(await readJson(req, 4096))));
  if (action === 'hold' && req.method === 'PUT') {
    const body = object(await readJson(req, 2048)), expected = version(body.ifVersion);
    if (typeof body.held !== 'boolean') throw invalid('Choose whether to hold reminders.');
    const reason = body.held ? text(body.reason, 'hold reason', 300, true) : '';
    const state = await collection(env, id);
    if (state.hold.version !== expected) throw changed();
    const row = await env.DB.prepare(`INSERT INTO wholesale_invoice_reminder_holds(invoice_id,reason,version,actor,updated_at)
      SELECT ?,?,1,?,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoice_reminders WHERE invoice_id=? AND status='sending')
        AND COALESCE((SELECT version FROM wholesale_invoice_reminder_holds WHERE invoice_id=?),0)=?
      ON CONFLICT(invoice_id) DO UPDATE SET reason=excluded.reason,version=version+1,actor=excluded.actor,updated_at=excluded.updated_at
      WHERE version=? RETURNING version`)
      .bind(id, reason, user.name, Date.now(), id, id, expected, expected).first();
    if (!row) throw block('reminder_busy', 'This reminder changed or is sending. Reopen the invoice to continue.');
    await audit(env, 'wholesale_invoice_reminder_hold', user.name, `${user.name} ${reason ? 'held' : 'resumed'} payment reminders for ${invoice.number}.`);
    return json(await collection(env, id));
  }
  if (action === 'confirm' && req.method === 'POST') {
    const body = object(await readJson(req, 2048));
    if (!Number.isSafeInteger(body.id) || body.id < 1 || typeof body.accepted !== 'boolean' || body.reviewed !== true) {
      throw invalid('Check the email provider and confirm the result of this attempt.');
    }
    await collection(env, id);
    const row = await env.DB.prepare("UPDATE wholesale_invoice_reminders SET status=?,updated_at=? WHERE id=? AND invoice_id=? AND status='unknown' RETURNING id")
      .bind(body.accepted ? 'accepted' : 'failed', Date.now(), body.id, id).first();
    if (!row) throw changed();
    await audit(env, 'wholesale_invoice_reminder_review', user.name,
      `${user.name} confirmed the payment reminder for ${invoice.number} was ${body.accepted ? 'accepted' : 'unsent'}.`);
    return json(await collection(env, id));
  }
  return null;
}
