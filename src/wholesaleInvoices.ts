// VAT invoices are issued once from saved real orders. Payment recording never moves money.
import { MAX_QUANTITY } from "../public/wholesale/limits.js";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { decode, get, object, text, version, type Row, type Versioned } from "./wholesaleStore";
import type { Customer, OrderingUser } from "./wholesaleAccounts";
import { tidyPostalAddress } from "./wholesaleCustomers";
import { invoicePdf } from "./wholesaleInvoicePdf";
import { billingAddressFor, billingException, billingHistory } from "./quickbooks/billingReviews";
import {withAccounting,accountingSummary,LIVE_ACCOUNTING_JOIN,INVOICE_REVIEW_SQL,PAYMENT_DUE_SQL,OUTSTANDING_BALANCE_SQL} from "./quickbooks/observations";
import { nextSharedNumber, NumberUnavailable, type NumberingCompany } from "./quickbooks/sharedNumber";

export interface VatRate { id: string; label: string; basisPoints: number }
export interface InvoiceSettings {
  seller: { legalName: string; address: string; vatNumber: string; companyNumber: string; email: string; phone: string };
  priceBasis: "inclusive" | "exclusive" | null; vatRates: VatRate[];
  defaultCoffeeRateId: string; deliveryRateId: string; invoicePrefix: string;
  firstInvoiceNumber: number; paymentInstructions: string; confirmed: boolean;
  /** Take the next number in QuickBooks's own series instead of prefix + counter (src/quickbooks/sharedNumber.ts). */
  sharedNumbering?: boolean;
  /** Whether customers see their invoices (My orders → Invoices, invoice PDFs, balances). Absent means on. */
  customersSeeInvoices?: boolean;
}
interface SettingsRow { data: string; version: number; updated_at: number }
export interface InvoiceLine {
  kind: "coffee" | "delivery"; description: string; quantity: number; unitPricePence: number;
  rateId: string; rateLabel: string; vatBasisPoints: number; netPence: number; vatPence: number; grossPence: number;
  packLabel?: string; grindLabel?: string;
  /** The coffee and bag size (invoices issued from 23 Nov 2026), so QuickBooks can use an item per coffee and size. */
  productId?: string; pack?: string;
}
interface Terms { id: string; label: string; note: string }
export interface InvoiceData {
  orderId: string; orderReference: string; customerId: string; invoiceDate: string; supplyDate: string;
  seller: InvoiceSettings["seller"]; billTo: { name: string; address: string; postcode: string; vatNumber: string };
  deliveryLocation: Record<string, any> | null; priceBasis: "inclusive" | "exclusive";
  lines: InvoiceLine[]; totals: { netPence: number; vatPence: number; grossPence: number };
  vatBreakdown: { rateId: string; label: string; basisPoints: number; netPence: number; vatPence: number; grossPence: number }[];
  paymentTerms: Terms; paymentInstructions: string; dueDate: string | null;
  orderVersion: number; settingsVersion: number;
  /** A tab invoice (order "TAB-<tab id>") covers these orders. */
  orderIds?: string[];
}
export interface InvoiceDocument extends InvoiceData {
  id: number | null; number: string | null; issuedAt: number | null; issuedBy: string | null;
  payment: { status: "paid" | "unpaid" | "overdue" | "part-paid" | "review" | "settled" | "voided"; paid: boolean; paidDate: string | null; reference: string; version: number; outstandingPence: number | null;
    paidPence?: number; totalPence?: number; dueDate?: string | null; source?: "quickbooks"; checkedAt?: number | null; hasVoidedPayment?: boolean };
  accounting?: { status: string; checkedAt: number | null; exportId?: number; reason?: string; invoiceChanged?: boolean; invoiceIssue?: string };
  billingHistory?: Awaited<ReturnType<typeof billingHistory>>;
  billingException?: NonNullable<Awaited<ReturnType<typeof billingException>>>;
}
interface InvoiceRow { seq: number; invoice_number: string; order_id: string; customer_id: string; request_key: string; data: string; issued_at: number; issued_by: string; paid: number; paid_date: string | null; paid_at: number | null; payment_reference: string; payment_version: number }
export interface SourceOrder {
  preview?: boolean; deletedAt?: number; business: string; reference?: string; customerId: string | null; status: string; createdAt: number;
  customerSnapshot?: { address?: string; postcode?: string; paymentTerms?: Terms }; locationSnapshot?: Record<string, any>; locationId?: string;
  paymentTerms?: Terms; lines: { title: string; packLabel: string; grindLabel: string; quantity: number; price: number; productId?: string; pack?: string }[];
  deliveryPence?: number; dispatchedAt?: number; delivery?: string; version: number; tab?: unknown; tabClearedId?: string;
}
interface InvoiceRequest {
  orderVersion: number; settingsVersion: number; invoiceDate: string; supplyDate: string;
  billingRevision?: number;
  billTo: { name: string; address: string; postcode: string; vatNumber: string } | null;
  deliveryCharge: { pence: number; description: string; vatRateId: string };
  lineVatRateIds: string[] | null; paymentInstructions: string | null; dueDate: string | null;
}
const missing = () => new ApiError(404, "not_found", "Invoice not found.");
const conflict = (message = "This invoice review changed. Reload and review it before issuing.") => new ApiError(409, "conflict", message);
const dayFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" });
const today = () => dayFormat.format(new Date());
const slug = (value: unknown, label: string, optional = false) => {
  const id = text(value, label, 40, !optional);
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw invalid(`Check ${label}.`);
  return id;
};
function date(value: unknown, label: string): string {
  const out = text(value, label, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out) || !Number.isFinite(Date.parse(out + "T00:00:00Z")) || new Date(out + "T00:00:00Z").toISOString().slice(0, 10) !== out) throw invalid(`Choose a valid ${label}.`);
  return out;
}
function integer(value: unknown, label: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`Check ${label}.`);
  return value as number;
}
const defaults = (): InvoiceSettings => ({ seller: { legalName: "", address: "", vatNumber: "", companyNumber: "", email: "", phone: "" }, priceBasis: null, vatRates: [], defaultCoffeeRateId: "", deliveryRateId: "", invoicePrefix: "", firstInvoiceNumber: 1, paymentInstructions: "", confirmed: false });
function settingsBody(body: Record<string, any>): InvoiceSettings {
  const seller = object(body.seller);
  if (body.priceBasis !== null && body.priceBasis !== "inclusive" && body.priceBasis !== "exclusive") throw invalid("Choose whether saved prices include or exclude VAT.");
  if (!Array.isArray(body.vatRates) || body.vatRates.length > 20) throw invalid("Configure up to 20 VAT rates.");
  const ids = new Set<string>();
  const vatRates = body.vatRates.map((value: unknown) => {
    const rate = object(value), id = slug(rate.id, "VAT rate ID");
    if (ids.has(id)) throw invalid("Each VAT rate needs its own ID."); ids.add(id);
    return { id, label: text(rate.label, "VAT rate label", 80, true), basisPoints: integer(rate.basisPoints, "VAT percentage (basis points)", 0, 10000) };
  });
  const invoicePrefix = text(body.invoicePrefix, "invoice number prefix", 20);
  if (invoicePrefix && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(invoicePrefix)) throw invalid("Use letters, numbers, hyphens or underscores in the invoice prefix.");
  if (typeof body.confirmed !== "boolean") throw invalid("Confirm whether these invoice details have been reviewed.");
  return { seller: { legalName: text(seller.legalName, "supplier legal name", 180), address: text(seller.address, "supplier address", 1000), vatNumber: text(seller.vatNumber, "VAT registration number", 40), companyNumber: text(seller.companyNumber, "company number", 40), email: text(seller.email, "supplier email", 150), phone: text(seller.phone, "supplier phone", 40) }, priceBasis: body.priceBasis, vatRates, defaultCoffeeRateId: slug(body.defaultCoffeeRateId, "default coffee VAT rate", true), deliveryRateId: slug(body.deliveryRateId, "delivery VAT rate", true), invoicePrefix, firstInvoiceNumber: integer(body.firstInvoiceNumber, "first invoice number", 1, 999999999), paymentInstructions: text(body.paymentInstructions, "payment instructions", 2000), confirmed: body.confirmed };
}
function readiness(settings: InvoiceSettings) {
  const reasons = [];
  if (!settings.seller.legalName) reasons.push("Add the supplier's legal business name.");
  if (!settings.seller.address) reasons.push("Add the supplier's full address.");
  if (!settings.seller.vatNumber) reasons.push("Add the VAT registration number.");
  if (!settings.priceBasis) reasons.push("Choose whether saved order prices include or exclude VAT.");
  if (!settings.vatRates.some((rate) => rate.id === settings.defaultCoffeeRateId)) reasons.push("Choose the default coffee VAT rate.");
  if (settings.deliveryRateId && !settings.vatRates.some((rate) => rate.id === settings.deliveryRateId)) reasons.push("Choose a configured delivery VAT rate.");
  if (!settings.invoicePrefix && !settings.sharedNumbering) reasons.push("Choose the invoice number prefix.");
  if (!settings.confirmed) reasons.push("Confirm the supplier, VAT and numbering details before issuing invoices.");
  return { ready: reasons.length === 0, reasons };
}
export async function settings(env: Env) {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_invoice_settings WHERE id = 1").first<SettingsRow>();
  const value: InvoiceSettings = row ? JSON.parse(row.data) : defaults();
  return { settings: value, version: row?.version || 0, updatedAt: row?.updated_at || null, ...readiness(value) };
}
/** Admin's switch for the customer side of invoicing; issuing and payment records in Admin are unaffected. */
export async function customersSeeInvoices(env: Env, customerId?: string) {
  const row = await env.DB.prepare(`SELECT
    (SELECT json_extract(data,'$.customersSeeInvoices') FROM wholesale_invoice_settings WHERE id=1) AS enabled,
    (SELECT json_extract(data,'$.hidePrices') FROM wholesale_preview WHERE kind='customer' AND id=?) AS hidden`)
    .bind(customerId ?? null).first<{ enabled: number | null; hidden: number | null }>();
  return row?.enabled !== 0 && row?.hidden !== 1;
}
const invoicesOff = () => new ApiError(403, "invoices_unavailable", "Invoices aren’t shown here at the moment. Contact Strangers if you need a copy.");
function requestBody(body: Record<string, any>): InvoiceRequest {
  const delivery = body.deliveryCharge === undefined ? {} : object(body.deliveryCharge);
  const billTo = body.billTo === undefined ? null : object(body.billTo);
  const lineVatRateIds = body.lineVatRateIds === undefined ? null : body.lineVatRateIds;
  if (lineVatRateIds !== null && (!Array.isArray(lineVatRateIds) || lineVatRateIds.length > 150)) throw invalid("Check the VAT rates for the saved order lines.");
  const billingRevision = body.billingRevision === undefined ? {} : { billingRevision: integer(body.billingRevision, "reviewed billing address", 0, Number.MAX_SAFE_INTEGER) };
  return { ...billingRevision, orderVersion: integer(body.orderVersion, "reviewed order version", 1, Number.MAX_SAFE_INTEGER), settingsVersion: integer(body.settingsVersion, "reviewed invoice settings version", 0, Number.MAX_SAFE_INTEGER), invoiceDate: date(body.invoiceDate, "invoice date"), supplyDate: date(body.supplyDate, "supply date"), billTo: billTo ? { name: text(billTo.name, "customer billing name", 180), address: text(billTo.address, "customer billing address", 1000), postcode: text(billTo.postcode, "customer billing postcode", 20), vatNumber: text(billTo.vatNumber, "customer VAT number", 40) } : null, deliveryCharge: { pence: delivery.pence === undefined ? 0 : integer(delivery.pence, "delivery charge in pence", 0, 100000000), description: text(delivery.description, "delivery description", 180) || "Delivery", vatRateId: slug(delivery.vatRateId, "delivery VAT rate", true) }, lineVatRateIds: lineVatRateIds?.map((id: unknown) => slug(id, "line VAT rate")) || null, paymentInstructions: body.paymentInstructions === undefined ? null : text(body.paymentInstructions, "payment instructions", 2000), dueDate: body.dueDate === undefined || body.dueDate === null || body.dueDate === "" ? null : date(body.dueDate, "payment due date") };
}
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map((n) => n.toString(16).padStart(2, "0")).join("");
export function invoiceLine(kind: InvoiceLine["kind"], description: string, quantity: number, price: number, rate: VatRate, priceBasis: "inclusive" | "exclusive"): InvoiceLine {
  const amount = integer(quantity, "invoice quantity", 1, MAX_QUANTITY) * integer(price, "saved unit price", 0, 100000000);
  const denominator = priceBasis === "inclusive" ? 10000 + rate.basisPoints : 10000;
  const vatPence = Math.floor((amount * rate.basisPoints + denominator / 2) / denominator);
  const netPence = priceBasis === "inclusive" ? amount - vatPence : amount;
  return { kind, description, quantity, unitPricePence: price, rateId: rate.id, rateLabel: rate.label, vatBasisPoints: rate.basisPoints, netPence, vatPence, grossPence: netPence + vatPence };
}
function document(row: InvoiceRow): InvoiceDocument {
  const data: InvoiceData = JSON.parse(row.data);
  return { ...data, id: row.seq, number: row.invoice_number, issuedAt: row.issued_at, issuedBy: row.issued_by, payment: { status: row.paid ? "paid" : data.dueDate && data.dueDate < today() ? "overdue" : "unpaid", paid: !!row.paid, paidDate: row.paid_date, reference: row.payment_reference, version: row.payment_version, outstandingPence: row.paid ? 0 : data.totals.grossPence } };
}
async function presented(env: Env, row: InvoiceRow, admin = true) {
  const [records, history, exception] = await Promise.all([
    withAccounting(env, [document(row)], admin),
    admin ? billingHistory(env, row.seq) : [],
    admin ? billingException(env, row.seq) : null,
  ]);
  return { ...records[0], ...(history.length ? { billingHistory: history } : {}), ...(exception ? { billingException: exception } : {}) };
}
async function issuedPdf(env: Env, row: InvoiceRow) { return invoicePdf(await presented(env,row,false)); }
export async function issuedInvoice(env: Env, id: number): Promise<InvoiceDocument> {
  const row = await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=?").bind(integer(id, "invoice ID", 1, Number.MAX_SAFE_INTEGER)).first<InvoiceRow>();
  if (!row) throw missing(); return document(row);
}
/** SQL: whether an order is covered by its own, a tab or a consolidated invoice. */
export const INVOICED_SQL = "EXISTS(SELECT 1 FROM wholesale_invoice_coverage WHERE order_id=?)";
async function coveredInvoice(env: Env, orderId: string) {
  return env.DB.prepare("SELECT i.* FROM wholesale_invoice_coverage c JOIN wholesale_invoices i ON i.seq=c.invoice_id WHERE c.order_id=?")
    .bind(orderId).first<InvoiceRow>();
}
async function invoiceByOrder(env: Env, orderId: string) { return env.DB.prepare("SELECT * FROM wholesale_invoices WHERE order_id = ?").bind(orderId).first<InvoiceRow>(); }
const productOf = (line: { productId?: string; pack?: string }) => typeof line.productId === "string" && typeof line.pack === "string" ? { productId: line.productId, pack: line.pack } : {};
const paymentTermsOf = (order: SourceOrder): Terms => order.paymentTerms ?? order.customerSnapshot?.paymentTerms ?? { id: "not-recorded", label: "Payment terms not recorded", note: "" };
function summed(lines: InvoiceLine[]) {
  const vatBreakdown: InvoiceData["vatBreakdown"] = [];
  const totals = { netPence: 0, vatPence: 0, grossPence: 0 };
  for (const line of lines) {
    let group = vatBreakdown.find((item) => item.rateId === line.rateId);
    if (!group) { group = { rateId: line.rateId, label: line.rateLabel, basisPoints: line.vatBasisPoints, netPence: 0, vatPence: 0, grossPence: 0 }; vatBreakdown.push(group); }
    for (const key of ["netPence", "vatPence", "grossPence"] as const) { totals[key] += line[key]; group[key] += line[key]; }
  }
  return { vatBreakdown, totals };
}
/** The due date agreed terms give an invoice: days from the invoice date, the same day for payment before dispatch,
 *  else none (to be agreed or custom terms need a date chosen by hand). */
function dueFor(terms: Terms, invoiceDate: string): string | null {
  const netDays = /^net-(7|14|30|60)$/.exec(terms.id)?.[1];
  if (netDays) return new Date(Date.parse(invoiceDate + "T00:00:00Z") + Number(netDays) * 86400000).toISOString().slice(0, 10);
  return terms.id === "before-dispatch" ? invoiceDate : null;
}
/** A confirmed billing address is independent of a customer's order and delivery addresses. */
async function billingFor(env: Env, order: Pick<SourceOrder, "business" | "customerId" | "customerSnapshot" | "locationId">) {
  const name = order.business, saved = order.customerSnapshot;
  const confirmed = order.customerId ? await billingAddressFor(env, order.customerId) : null;
  const billing = (address: string, postcode: string, revision = 0) => ({ billTo: { name, address, postcode, vatNumber: "" }, revision });
  if (confirmed) return billing(confirmed.address, confirmed.postcode, confirmed.id);
  const savedAddress = tidyPostalAddress(saved?.address || "");
  if (savedAddress) return billing(savedAddress, saved?.postcode || "");
  const customer = order.customerId ? await get<Customer & { locations?: { id: string; address?: string; postcode?: string }[] }>(env, "customer", order.customerId) : null;
  const location = customer?.locations?.find((item) => item.id === order.locationId && tidyPostalAddress(item.address || "")) || customer;
  return billing(tidyPostalAddress(location?.address || ""), location?.postcode || "");
}
const invoiceLocation = (location: SourceOrder["locationSnapshot"]) => location ? {
  ...location, ...(typeof location.address === "string" ? { address: tidyPostalAddress(location.address) } : {}),
} : null;
async function build(env: Env, orderId: string, request: InvoiceRequest): Promise<{ data: InvoiceData; config: InvoiceSettings; billingRevision: number }> {
  const config = await settings(env);
  if (!config.ready) throw new ApiError(409, "invoice_settings_incomplete", config.reasons.join(" "));
  if (config.version !== request.settingsVersion) throw conflict("Invoice settings changed. Review the invoice again.");
  const order = await get<SourceOrder>(env, "order", orderId);
  if (!order || order.deletedAt != null) throw new ApiError(404, "not_found", "Order not found.");
  if (!orderId.startsWith("WS-") || order.preview !== false || !order.customerId) throw invalid("Invoices can only be issued for real customer orders.");
  if (order.status === "Cancelled") throw invalid("An invoice cannot be issued for a cancelled order.");
  if (order.version !== request.orderVersion) throw conflict("The order changed. Review its details before issuing an invoice.");
  if (await coveredInvoice(env, orderId)) throw invalid("This order is covered by an issued invoice. Open that invoice.");
  const value = config.settings;
  const billing = await billingFor(env, order);
  if (request.billingRevision !== undefined && request.billingRevision !== billing.revision) throw conflict("The billing address changed. Reopen the invoice draft to review it.");
  const billTo = request.billTo ? { ...request.billTo, address: tidyPostalAddress(request.billTo.address) } : billing.billTo;
  if (!billTo.name || !billTo.address) throw invalid(request.billTo ? "Add the customer's billing name and full address before issuing an invoice." : "Add an address for this business (Customers → the business → Main location), then press Try again.");
  if (request.lineVatRateIds && request.lineVatRateIds.length !== order.lines.length) throw invalid("Choose one VAT rate for each saved order line.");
  const rate = (id: string) => { const found = value.vatRates.find((item) => item.id === id); if (!found) throw invalid("Choose a configured VAT rate."); return found; };
  const lines = order.lines.map((line, i) => ({ ...invoiceLine("coffee", line.title, line.quantity, line.price, rate(request.lineVatRateIds?.[i] || value.defaultCoffeeRateId), value.priceBasis!), packLabel: line.packLabel, grindLabel: line.grindLabel, ...productOf(line) }));
  if (request.deliveryCharge.pence) lines.push(invoiceLine("delivery", request.deliveryCharge.description, 1, request.deliveryCharge.pence, rate(request.deliveryCharge.vatRateId || value.deliveryRateId), value.priceBasis!) as typeof lines[number]);
  const { vatBreakdown, totals } = summed(lines);
  const paymentTerms = paymentTermsOf(order), agreedDueDate = dueFor(paymentTerms, request.invoiceDate);
  if (agreedDueDate && request.dueDate && request.dueDate !== agreedDueDate) throw invalid("The due date must follow this order's agreed invoice payment terms.");
  const dueDate = agreedDueDate ?? request.dueDate;
  if (dueDate && dueDate < request.invoiceDate) throw invalid("The payment due date cannot be before the invoice date.");
  return { config: value, billingRevision: billing.revision, data: { orderId, orderReference: order.reference || "", customerId: order.customerId, invoiceDate: request.invoiceDate, supplyDate: request.supplyDate, seller: { ...value.seller }, billTo: { ...billTo }, deliveryLocation: invoiceLocation(order.locationSnapshot), priceBasis: value.priceBasis!, lines, totals, vatBreakdown, paymentTerms: { ...paymentTerms }, paymentInstructions: request.paymentInstructions ?? value.paymentInstructions, dueDate, orderVersion: order.version, settingsVersion: config.version } };
}

interface AutoIssuance { since: number; leaseOwner: string }
export interface ReviewedBatchInvoice {
  invoice: InvoiceData;
  billingRevision: number;
  accountVersion: number;
  customerVersion: number;
  orders: Record<string, number>;
}
interface BatchIssuance extends Pick<ReviewedBatchInvoice, "accountVersion" | "customerVersion" | "orders"> {
  itemId: number; owner: string; actorId: string;
}
interface InvoiceIssuance {
  billingRevision: number;
  automatic?: AutoIssuance;
  tabVersions?: Record<string, number>;
  batch?: BatchIssuance;
  numberingCompany?: NumberingCompany;
}

/** Issue with the configured numbering: prefix + counter, or the next number in QuickBooks's series (asked afresh each
 *  time; if another invoice takes it first, the unique number refuses this one and the next is asked for). */
async function insertNumbered(req: Request, env: Env, data: InvoiceData, config: InvoiceSettings, requestKey: string, actor: string, issuance: InvoiceIssuance) {
  if (!config.sharedNumbering) return insertInvoice(env, data, config, requestKey, actor, issuance);
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextSharedNumber(req, env, issuance.numberingCompany);
    try { return await insertInvoice(env, data, config, requestKey, actor, issuance, number); }
    catch (error) { if (!/UNIQUE constraint failed: wholesale_invoices\.invoice_number/.test(String((error as Error)?.message))) throw error; }
  }
  throw new NumberUnavailable("Another invoice kept taking the next number. It will be tried again.");
}

/** Check order versions, invoice coverage and automation permission in the same write as number allocation. */
async function insertInvoice(env: Env, data: InvoiceData, config: InvoiceSettings, requestKey: string, actor: string, { billingRevision, automatic, tabVersions, batch }: InvoiceIssuance, number?: string) {
  const { orderId, customerId, orderVersion, settingsVersion } = data;
  const tab = orderId.startsWith("TAB-");
  const tabId = tab ? orderId.slice(4) : "";
  const guard = batch ? `EXISTS(SELECT 1 FROM wholesale_invoice_batch_items WHERE id=? AND state='working' AND lease_owner=? AND lease_until>?)
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND role='admin' AND active=1)
    AND EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=? AND version=? AND COALESCE(json_extract(data,'$.hidePrices'),0)=0)
    AND COALESCE((SELECT version FROM wholesale_invoice_accounts WHERE customer_id=?),0)=?
    AND NOT EXISTS(
      SELECT 1 FROM json_each(?) reviewed
      LEFT JOIN wholesale_preview o ON o.kind='order' AND o.id=reviewed.key AND o.version=reviewed.value
        AND json_extract(o.data,'$.customerId')=? AND json_extract(o.data,'$.status')='Dispatched'
        AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.deletedAt') IS NULL
        AND json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL
      WHERE o.id IS NULL OR EXISTS(SELECT 1 FROM wholesale_invoice_coverage WHERE order_id=o.id)
    )` : tab ? `EXISTS(SELECT 1 FROM wholesale_tabs WHERE id=? AND customer_id=? AND cleared_at>=?)
    AND NOT EXISTS(
      SELECT 1 FROM json_each(?) reviewed
      LEFT JOIN wholesale_preview o ON o.kind='order' AND o.id=reviewed.key AND o.version=reviewed.value
        AND json_extract(o.data,'$.tabClearedId')=? AND json_extract(o.data,'$.customerId')=?
      WHERE o.id IS NULL OR EXISTS(SELECT 1 FROM wholesale_invoice_coverage WHERE order_id=o.id)
    )` : `EXISTS(
      SELECT 1 FROM wholesale_preview o WHERE o.kind='order' AND o.id=? AND o.version=?
      AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.deletedAt') IS NULL AND json_extract(o.data,'$.status')<>'Cancelled'
      AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_coverage WHERE order_id=o.id)
      ${automatic ? `AND json_extract(o.data,'$.status')='Dispatched' AND json_extract(o.data,'$.dispatchedAt')>=?
        AND json_extract(o.data,'$.tab') IS NULL AND json_extract(o.data,'$.tabClearedId') IS NULL` : ""}
    )`;
  const automationGuard = automatic ? `
    AND EXISTS(SELECT 1 FROM wholesale_auto_invoicing WHERE id=1
      AND json_extract(data,'$.issue')=1 AND json_extract(data,'$.since')=?)
    AND EXISTS(SELECT 1 FROM wholesale_auto_invoices WHERE source=? AND lease_owner=? AND lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='customer' AND id=? AND json_extract(data,'$.hidePrices')=1)
    ${tab ? "" : "AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_accounts WHERE customer_id=? AND cadence='monthly')"}` : "";
  const at = Date.now();
  const inserted = await env.DB.prepare(`INSERT INTO wholesale_invoices(seq,invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by)
    SELECT next_seq, ${number ? "?" : "? || printf('%06d', ? + next_seq - 1)"}, ?,?,?,?,?,?
    FROM (SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='wholesale_invoices'),0)+1 AS next_seq)
    WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoices WHERE order_id=?)
      AND EXISTS(SELECT 1 FROM wholesale_invoice_settings WHERE id=1 AND version=?)
      AND COALESCE((SELECT MAX(id) FROM wholesale_invoice_billing_reviews WHERE customer_id=? AND environment='production'),0)=?
      AND ${guard}${automationGuard} RETURNING *`)
    .bind(...(number ? [number] : [config.invoicePrefix, config.firstInvoiceNumber]), orderId, customerId, requestKey, JSON.stringify(data), at, actor, orderId, settingsVersion, customerId, billingRevision,
      ...(batch ? [batch.itemId, batch.owner, at, batch.actorId, customerId, batch.customerVersion, customerId, batch.accountVersion, JSON.stringify(batch.orders), customerId]
        : tab ? [tabId, customerId, automatic?.since ?? 0, JSON.stringify(tabVersions), tabId, customerId] : [orderId, orderVersion, ...(automatic ? [automatic.since] : [])]),
      ...(automatic ? [automatic.since, tab ? "tab:" + tabId : "order:" + orderId, automatic.leaseOwner, at, customerId, ...(tab ? [] : [customerId])] : []))
    .first<InvoiceRow>();
  if (inserted) await audit(env, "wholesale_invoice_issued", actor, `${actor} issued invoice ${inserted.invoice_number} for ${data.orderIds?.length ? `${data.orderIds.length} orders` : orderId}.`);
  return inserted;
}

/** The delivery charge an order was placed with (including VAT), as the invoice's price basis needs it: when saved
 *  prices exclude VAT it's the amount before VAT at the delivery rate (as the Admin invoice form fills it in). */
function deliveryLineFor(order: SourceOrder, config: InvoiceSettings): InvoiceLine | null {
  const gross = Number.isSafeInteger(order.deliveryPence) ? order.deliveryPence! : 0;
  if (!gross) return null;
  const rate = config.vatRates.find((item) => item.id === config.deliveryRateId);
  if (!rate) throw new InvoiceHold("Choose a delivery VAT rate in Invoice settings.");
  const price = config.priceBasis === "exclusive" ? Math.round(gross * 10000 / (10000 + rate.basisPoints)) : gross;
  const line = invoiceLine("delivery", "Delivery", 1, price, rate, config.priceBasis!);
  if (line.grossPence !== gross) throw new InvoiceHold("The saved delivery charge cannot be reproduced exactly with the configured VAT rate. Review the delivery charge by hand.");
  return line;
}
const ukDay = (at: number) => dayFormat.format(new Date(at));
export class InvoiceHold extends ApiError { constructor(message: string) { super(409, "invoice_held", message); } }
/** Automatic invoicing waits (and tries again) when the shared number can't be chosen. */
async function held<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) { if (error instanceof NumberUnavailable) throw new InvoiceHold(error.message); throw error; }
}

/** Automatic invoicing: an invoice for a dispatched customer order, dated today with the supply date the day it went out,
 *  the order's own delivery charge and the default VAT rates, as an admin issuing it with nothing changed would. */
export async function issueForOrder(req: Request, env: Env, orderId: string, actor: string, automatic: AutoIssuance): Promise<InvoiceDocument | null> {
  const order = await get<SourceOrder>(env, "order", orderId);
  if (!order || order.deletedAt != null || order.status === "Cancelled") throw new InvoiceHold("The order was deleted or cancelled.");
  if (order.tab || order.tabClearedId) return null;
  if (order.customerId && await env.DB.prepare("SELECT 1 FROM wholesale_invoice_accounts WHERE customer_id=? AND cadence='monthly'").bind(order.customerId).first()) return null;
  if (order.status !== "Dispatched" || (order.dispatchedAt || 0) < automatic.since) throw new InvoiceHold("Waiting for an eligible dispatch.");
  if (order.customerId && (await get<Customer>(env, "customer", order.customerId))?.hidePrices) return null;
  const existing = await coveredInvoice(env, orderId);
  if (existing) return existing.request_key.startsWith("batch:") ? null : document(existing);
  const config = await settings(env);
  if (!config.ready) throw new InvoiceHold("Invoice settings aren't finished: " + config.reasons.join(" "));
  const invoiceDate = today(), sent = order.dispatchedAt ? ukDay(order.dispatchedAt) : invoiceDate;
  const delivery = deliveryLineFor(order, config.settings);
  const request: InvoiceRequest = { orderVersion: order.version, settingsVersion: config.version, invoiceDate, supplyDate: sent > invoiceDate ? invoiceDate : sent, billTo: null, deliveryCharge: { pence: delivery?.unitPricePence ?? 0, description: delivery?.description ?? "Delivery", vatRateId: delivery?.rateId ?? "" }, lineVatRateIds: null, paymentInstructions: null, dueDate: null };
  let built;
  try { built = await build(env, orderId, request); }
  catch (error) { if (error instanceof ApiError && error.status < 500) throw new InvoiceHold(error.message); throw error; }
  const key = await digest(request);
  const inserted = await held(() => insertNumbered(req, env, built.data, built.config, key, actor, { billingRevision: built.billingRevision, automatic }));
  if (inserted) return document(inserted);
  const raced = await invoiceByOrder(env, orderId);
  if (raced) return raced.request_key.startsWith("batch:") ? null : document(raced);
  throw new ApiError(409, "conflict", "The order changed while it was being invoiced. It will be tried again.");
}

/** Automatic invoicing for a cleared tab: one invoice covering its orders (not cancelled or deleted, and not already
 *  invoiced on their own), their bags merged by coffee, size, grind and price, and their delivery charges. */
export async function issueForTab(req: Request, env: Env, tabId: string, actor: string, automatic: AutoIssuance): Promise<InvoiceDocument | null> {
  const id = "TAB-" + tabId, existing = await invoiceByOrder(env, id);
  if (existing) return document(existing);
  const config = await settings(env);
  if (!config.ready) throw new InvoiceHold("Invoice settings aren't finished: " + config.reasons.join(" "));
  const tab = await env.DB.prepare("SELECT customer_id, data, cleared_at FROM wholesale_tabs WHERE id=?").bind(tabId).first<{ customer_id: string; data: string; cleared_at: number }>();
  if (!tab) throw new InvoiceHold("The tab record wasn't found.");
  if (tab.cleared_at < automatic.since || (await get<Customer>(env, "customer", tab.customer_id))?.hidePrices) return null;
  const record = JSON.parse(tab.data) as { orderIds: string[] };
  const loaded = await env.DB.prepare(`SELECT o.id,o.data,o.version,o.updated_at FROM json_each(?) member
    JOIN wholesale_preview o ON o.kind='order' AND o.id=member.value
    WHERE json_extract(o.data,'$.tabClearedId')=? AND json_extract(o.data,'$.customerId')=?
      AND json_extract(o.data,'$.preview')=0 AND json_extract(o.data,'$.deletedAt') IS NULL
      AND json_extract(o.data,'$.status')<>'Cancelled' AND NOT EXISTS(SELECT 1 FROM wholesale_invoice_coverage WHERE order_id=o.id)
    ORDER BY member.key`).bind(JSON.stringify(record.orderIds), tabId, tab.customer_id).all<Row>();
  const orders = loaded.results.map(decode<SourceOrder>);
  if (!orders.length) return null;
  const latest = orders.reduce((newest, order) => order.createdAt > newest.createdAt ? order : newest);
  const paymentTerms = paymentTermsOf(latest);
  if (orders.some(order => {
    const terms = paymentTermsOf(order);
    return terms.id !== paymentTerms.id || (terms.note || "") !== (paymentTerms.note || "");
  })) throw new InvoiceHold("The orders on this tab have different payment terms. Open the individual orders to invoice them on their agreed terms.");
  const value = config.settings, rate = (rateId: string) => value.vatRates.find((r) => r.id === rateId)!;
  const merged = new Map<string, { line: SourceOrder["lines"][number]; quantity: number }>();
  for (const order of orders) for (const line of order.lines) {
    const key = JSON.stringify([line.productId, line.pack, line.title, line.packLabel, line.grindLabel, line.price]);
    const found = merged.get(key); if (found) found.quantity += line.quantity; else merged.set(key, { line, quantity: line.quantity });
  }
  const lines: InvoiceLine[] = [];
  for (const { line, quantity } of merged.values()) {
    for (let left = quantity; left > 0; left -= MAX_QUANTITY)
      lines.push({ ...invoiceLine("coffee", line.title, Math.min(left, MAX_QUANTITY), line.price, rate(value.defaultCoffeeRateId), value.priceBasis!), packLabel: line.packLabel, grindLabel: line.grindLabel, ...productOf(line) });
  }
  const byPrice = new Map<number, InvoiceLine[]>();
  for (const order of orders) {
    const charge = deliveryLineFor(order, value);
    if (!charge) continue;
    const group = byPrice.get(charge.unitPricePence);
    if (group) group.push(charge);
    else byPrice.set(charge.unitPricePence, [charge]);
  }
  for (const [pence, group] of byPrice) {
    const combined = invoiceLine("delivery", "Delivery", group.length, pence, rate(value.deliveryRateId), value.priceBasis!);
    // Keep each order's delivery and VAT pence if rounding the combined charge would change them.
    if (combined.vatPence === group[0].vatPence * group.length) lines.push(combined);
    else lines.push(...group);
  }
  if (lines.length > 150) throw new InvoiceHold("This tab has too many different lines for one invoice. Invoice it by hand.");
  const { billTo, revision } = await billingFor(env, latest);
  if (!billTo.name || !billTo.address) throw new InvoiceHold("Add the customer's billing address before this tab can be invoiced.");
  const invoiceDate = today(), sentDays = orders.map((o) => o.dispatchedAt).filter((at): at is number => !!at).map(ukDay).sort();
  const supplyDate = sentDays.length && sentDays.at(-1)! <= invoiceDate ? sentDays.at(-1)! : invoiceDate;
  const { vatBreakdown, totals } = summed(lines);
  const data: InvoiceData = { orderId: id, orderReference: `Tab: ${orders.length} ${orders.length === 1 ? "order" : "orders"}`, customerId: tab.customer_id, invoiceDate, supplyDate, seller: { ...value.seller }, billTo, deliveryLocation: invoiceLocation(latest.locationSnapshot), priceBasis: value.priceBasis!, lines, totals, vatBreakdown, paymentTerms: { ...paymentTerms }, paymentInstructions: value.paymentInstructions, dueDate: dueFor(paymentTerms, invoiceDate), orderVersion: 0, settingsVersion: config.version, orderIds: orders.map((o) => o.id) };
  const versions = Object.fromEntries(orders.map(o => [o.id, o.version]));
  const key = await digest({ tab: tabId, orderIds: data.orderIds, settingsVersion: config.version });
  const inserted = await held(() => insertNumbered(req, env, data, value, key, actor, { billingRevision: revision, automatic, tabVersions: versions }));
  if (inserted) return document(inserted);
  const raced = await invoiceByOrder(env, id);
  if (raced) return document(raced);
  throw new ApiError(409, "conflict", "The tab's orders changed while it was being invoiced. It will be tried again.");
}

/** Prepare exactly the immutable invoice that an approved batch will issue. */
export function prepareBatchInvoice(
  orders: (SourceOrder & Versioned)[], customer: Customer & Versioned,
  config: Awaited<ReturnType<typeof settings>>, accountVersion: number,
  profile: { address: string; postcode: string; id: number } | null, period: string, monthly: boolean,
): ReviewedBatchInvoice {
  if (!orders.length) throw invalid("Choose dispatched orders to invoice.");
  if (!config.ready) throw new InvoiceHold(config.reasons.join(" "));
  const last = orders.at(-1)!;
  const billTo = {
    name: customer.business || last.business,
    address: tidyPostalAddress(profile?.address || (!monthly && last.customerSnapshot?.address) || customer.address || ""),
    postcode: profile ? profile.postcode : (!monthly && last.customerSnapshot?.address ? last.customerSnapshot.postcode : customer.postcode) || "",
    vatNumber: "",
  };
  if (!billTo.name || !billTo.address) throw new InvoiceHold("Add the customer's billing address before issuing.");
  const paymentTerms = paymentTermsOf(last);
  if (orders.some(order => {
    const terms = paymentTermsOf(order);
    return terms.id !== paymentTerms.id || (terms.note || "") !== (paymentTerms.note || "");
  })) throw new InvoiceHold("These orders have different agreed payment terms. Review them individually.");
  const value = config.settings, priceBasis = value.priceBasis!;
  const rate = value.vatRates.find(item => item.id === value.defaultCoffeeRateId)!;
  const lines = orders.flatMap(order => {
    const coffee: InvoiceLine[] = order.lines.map(line => ({
      ...invoiceLine("coffee", line.title, line.quantity, line.price, rate, priceBasis),
      packLabel: line.packLabel, grindLabel: line.grindLabel, ...productOf(line),
    }));
    const delivery = deliveryLineFor(order, value);
    return delivery ? [...coffee, delivery] : coffee;
  });
  if (!lines.length || lines.length > 150) throw new InvoiceHold("This review needs between 1 and 150 invoice lines. Review the orders individually.");
  const invoiceDate = today(), supplyDate = ukDay(last.dispatchedAt!);
  if (supplyDate > invoiceDate) throw new InvoiceHold("The recorded dispatch date is in the future.");
  const invoice: InvoiceData = {
    orderId: monthly ? "MONTH-" + crypto.randomUUID() : last.id,
    orderReference: monthly ? period + " · " + orders.length + " dispatched orders" : last.reference || "",
    customerId: customer.id, invoiceDate, supplyDate, seller: { ...value.seller }, billTo,
    deliveryLocation: monthly ? null : invoiceLocation(last.locationSnapshot), priceBasis, lines, ...summed(lines),
    paymentTerms: { ...paymentTerms }, paymentInstructions: value.paymentInstructions, dueDate: dueFor(paymentTerms, invoiceDate),
    orderVersion: last.version, settingsVersion: config.version,
    ...(monthly ? { orderIds: orders.map(order => order.id) } : {}),
  };
  return { invoice, accountVersion, billingRevision: profile?.id ?? 0, customerVersion: customer.version,
    orders: Object.fromEntries(orders.map(order => [order.id, order.version])) };
}

export async function issueReviewedBatchInvoice(
  req: Request, env: Env, review: ReviewedBatchInvoice, itemId: number, owner: string,
  actor: { id: string; name: string }, numberingCompany?: NumberingCompany,
) {
  const key = "batch:" + itemId;
  // Recover the number if the request ended after issuing but before updating the batch.
  const existing = await invoiceByOrder(env, review.invoice.orderId);
  if (existing?.request_key === key) return document(existing);
  const config = await settings(env);
  if (!config.ready || config.version !== review.invoice.settingsVersion) throw conflict("Invoice settings changed. Prepare a new batch review.");
  const saved = existing ? null : await insertNumbered(req, env, review.invoice, config.settings, key, actor.name, {
    billingRevision: review.billingRevision, batch: { ...review, itemId, owner, actorId: actor.id }, numberingCompany,
  });
  if (saved) return document(saved);
  throw conflict("An order, billing account or invoice changed. Review the remaining orders again.");
}

export async function handleInvoiceAdmin(req: Request, env: Env, route: string, actor: string): Promise<Response | null> {
  if (route === "invoice-settings" && req.method === "GET") return json(await settings(env));
  if (route === "invoice-settings/customers" && req.method === "PUT") {
    const body = object(await readJson(req, 1024)), expected = version(body.ifVersion), at = Date.now();
    if (typeof body.enabled !== "boolean") throw invalid("Choose whether customers see their invoices.");
    const old = await settings(env);
    if (old.version !== expected) throw conflict("Invoice settings changed on another device. Reload and try again.");
    const value = { ...old.settings, customersSeeInvoices: body.enabled };
    const result = expected === 0
      ? await env.DB.prepare("INSERT INTO wholesale_invoice_settings(id,data,version,updated_at) SELECT 1,?,1,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoice_settings WHERE id=1)").bind(JSON.stringify(value), at).run()
      : await env.DB.prepare("UPDATE wholesale_invoice_settings SET data=json_set(data,'$.customersSeeInvoices',json(?)),version=version+1,updated_at=? WHERE id=1 AND version=?").bind(String(body.enabled), at, expected).run();
    if (!result.meta.changes) throw conflict("Invoice settings changed on another device. Reload and try again.");
    await audit(env, "wholesale_invoice_settings", actor, `${actor} turned customer invoices ${body.enabled ? "on" : "off"}.`);
    return json(await settings(env));
  }
  if (route === "invoice-settings/numbering" && req.method === "PUT") {
    const body = object(await readJson(req, 1024)), expected = version(body.ifVersion), at = Date.now();
    if (typeof body.shared !== "boolean") throw invalid("Choose whether invoices use QuickBooks's numbers.");
    const old = await settings(env);
    if (old.version !== expected || expected === 0) throw conflict("Invoice settings changed on another device. Reload and try again.");
    const next = body.shared ? await nextSharedNumber(req, env) : null;
    const result = await env.DB.prepare("UPDATE wholesale_invoice_settings SET data=json_set(data,'$.sharedNumbering',json(?)),version=version+1,updated_at=? WHERE id=1 AND version=?").bind(String(body.shared), at, expected).run();
    if (!result.meta.changes) throw conflict("Invoice settings changed on another device. Reload and try again.");
    await audit(env, "wholesale_invoice_settings", actor, `${actor} switched QuickBooks invoice numbers ${body.shared ? `on (next ${next})` : "off"}.`);
    return json({ ...(await settings(env)), ...(next ? { nextNumber: next } : {}) });
  }
  if (route === "invoice-settings" && req.method === "PUT") {
    const body = object(await readJson(req, 16 * 1024)), expected = version(body.ifVersion), value = settingsBody(body), at = Date.now();
    const old = await settings(env);
    if (old.version !== expected) throw conflict("Invoice settings changed on another device. Reload before saving.");
    if (old.settings.customersSeeInvoices === false) value.customersSeeInvoices = false;
    if (old.settings.sharedNumbering) value.sharedNumbering = true;
    const issued = await env.DB.prepare("SELECT COUNT(*) AS n FROM wholesale_invoices").first<{ n: number }>();
    if (issued?.n && value.firstInvoiceNumber !== old.settings.firstInvoiceNumber) throw invalid("The first invoice number cannot change after an invoice has been issued.");
    const result = expected === 0
      ? await env.DB.prepare("INSERT INTO wholesale_invoice_settings(id,data,version,updated_at) SELECT 1,?,1,? WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoice_settings WHERE id=1)").bind(JSON.stringify(value), at).run()
      : await env.DB.prepare("UPDATE wholesale_invoice_settings SET data=?,version=version+1,updated_at=? WHERE id=1 AND version=? AND (?=json_extract(data,'$.firstInvoiceNumber') OR NOT EXISTS(SELECT 1 FROM wholesale_invoices))").bind(JSON.stringify(value), at, expected, value.firstInvoiceNumber).run();
    if (!result.meta.changes) throw conflict("Invoice settings or numbering changed. Reload before saving.");
    await audit(env, "wholesale_invoice_settings", actor, `${actor} updated wholesale invoice settings.`);
    return json(await settings(env));
  }
  const order = /^orders\/((?:WS|PREVIEW)-[A-F0-9]{32})\/invoice(\/preview)?(\/pdf)?$/.exec(route);
  if (order && req.method === "GET" && !order[2]) {
    let row = await coveredInvoice(env, order[1]);
    let billing;
    if (!row) {
      const saved = await get<SourceOrder>(env, "order", order[1]);
      if (!row && (!saved || saved.deletedAt != null)) throw new ApiError(404, "not_found", "Order not found.");
      if (!order[1].startsWith("WS-") || saved?.preview !== false) throw invalid("Invoices can only be issued for real customer orders.");
      if (!row && saved && !order[3]) billing = await billingFor(env, saved);
    }
    if (order[3]) { if (!row) throw missing(); return issuedPdf(env,row); }
    return json({ invoice: row ? await presented(env,row) : null, ...(billing ? { billing } : {}) });
  }
  if (order && req.method === "POST") {
    if (order[3] && !order[2]) throw new ApiError(404, "not_found", "Preview a draft PDF before issuing the invoice.");
    const request = requestBody(object(await readJson(req, 16 * 1024))), requestKey = await digest(request);
    const existing = await coveredInvoice(env, order[1]);
    if (existing) {
      if (existing.order_id.startsWith("TAB-")) throw invalid("This order was invoiced with its customer's tab. Open the tab's invoice.");
      if (order[2]) return order[3] ? issuedPdf(env,existing) : json({ invoice: await presented(env,existing), issued: true });
      if (existing.request_key !== requestKey) throw conflict("This order already has an issued invoice. Open that invoice; issued invoices cannot be changed.");
      return json({ invoice: await presented(env,existing) });
    }
    const { data, config, billingRevision } = await build(env, order[1], request);
    if (order[2]) {
      const preview: InvoiceDocument = { ...data, id: null, number: null, issuedAt: null, issuedBy: null, payment: { status: data.dueDate && data.dueDate < today() ? "overdue" : "unpaid", paid: false, paidDate: null, reference: "", version: 0, outstandingPence: data.totals.grossPence } };
      return order[3] ? invoicePdf(preview, { draft: true }) : json({ invoice: preview, issued: false });
    }
    const inserted = await insertNumbered(req, env, data, config, requestKey, actor, { billingRevision });
    if (!inserted) {
      const raced = await invoiceByOrder(env, order[1]);
      if (raced?.request_key === requestKey) return json({ invoice: await presented(env,raced) });
      throw conflict("The order, invoice or settings changed. Reload and review before issuing.");
    }
    return json({ invoice: await presented(env,inserted) }, 201);
  }
  const payment = /^invoices\/(\d+)\/payment$/.exec(route);
  if (payment && req.method === "PATCH") {
    const invoiceId=integer(Number(payment[1]),"invoice ID",1,Number.MAX_SAFE_INTEGER);
    const livePaymentLock = "environment='production' AND (state='linked' OR write_started_at>0)";
    const managed = () => env.DB.prepare(`SELECT state FROM quickbooks_exports WHERE invoice_id=? AND ${livePaymentLock}`).bind(invoiceId).first<{ state: string }>();
    const managedPayment = (state: string) => new ApiError(409, "quickbooks_managed_payment", state === "linked"
      ? "Record this invoice payment in QuickBooks, then refresh its payment status."
      : "QuickBooks may already have received this invoice. Check its status in Export history before recording a payment.");
    const exportBefore = await managed();
    if (exportBefore) throw managedPayment(exportBefore.state);
    const body = object(await readJson(req, 4096)), expected = version(body.ifVersion);
    if (typeof body.paid !== "boolean") throw invalid("Choose paid or unpaid.");
    const paidDate = body.paid ? (body.paidDate ? date(body.paidDate, "payment date") : today()) : null;
    if (paidDate && paidDate > today()) throw invalid("The payment date cannot be in the future.");
    const reference = text(body.reference, "payment reference", 180);
    const row = await env.DB.prepare(`UPDATE wholesale_invoices SET paid=?,paid_date=?,paid_at=?,payment_reference=?,payment_version=payment_version+1
      WHERE seq=? AND payment_version=? AND NOT EXISTS(SELECT 1 FROM quickbooks_exports
        WHERE invoice_id=wholesale_invoices.seq AND ${livePaymentLock}) RETURNING *`)
      .bind(body.paid ? 1 : 0, paidDate, body.paid ? Date.now() : null, reference, invoiceId, expected).first<InvoiceRow>();
    if (!row) {
      const exportAfter = await managed();
      if (exportAfter) throw managedPayment(exportAfter.state);
      if (!await env.DB.prepare("SELECT seq FROM wholesale_invoices WHERE seq=?").bind(invoiceId).first()) throw missing();
      throw conflict("This payment record changed. Reload before saving.");
    }
    await audit(env, "wholesale_invoice_payment", actor, `${actor} marked invoice ${row.invoice_number} as ${body.paid ? "paid" : "unpaid"}. No bank transaction was performed.`);
    return json({ invoice: await presented(env,row) });
  }
  if (route === "invoices" && req.method === "GET") return invoiceList(req, env);
  const match = /^invoices\/(\d+)(\/pdf)?$/.exec(route);
  if (match && req.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=?").bind(integer(Number(match[1]), "invoice ID", 1, Number.MAX_SAFE_INTEGER)).first<InvoiceRow>();
    if (!row) throw missing(); return match[2] ? issuedPdf(env,row) : json({ invoice: await presented(env,row) });
  }
  return null;
}

async function invoiceList(req: Request, env: Env, customerId?: string): Promise<Response> {
  const query = new URL(req.url).searchParams, cursor = query.get("cursor");
  const conditions: string[] = [], bindings: (string | number)[] = [];
  let joins = "";
  if (customerId) {
    conditions.push("i.customer_id=?");
    bindings.push(customerId);
  } else {
    const search = text(query.get("q") || "", "search", 120).toLowerCase();
    const queue = query.get("queue") || "all";
    if (!["all", "overdue", "soon", "review"].includes(queue)) throw invalid("Choose a listed invoice queue.");
    if (search) {
      conditions.push("(instr(lower(i.invoice_number),?)>0 OR instr(lower(json_extract(i.data,'$.billTo.name')),?)>0)");
      bindings.push(search, search);
    }
    if (queue !== "all") {
      joins = " " + LIVE_ACCOUNTING_JOIN;
      if (queue === "review") conditions.push(INVOICE_REVIEW_SQL);
      else {
        conditions.push(OUTSTANDING_BALANCE_SQL + ">0");
        if (queue === "overdue") { conditions.push(PAYMENT_DUE_SQL + "<?"); bindings.push(today()); }
        else {
          const start = today(), end = new Date(Date.parse(start + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
          conditions.push(PAYMENT_DUE_SQL + " BETWEEN ? AND ?");
          bindings.push(start, end);
        }
      }
    }
  }
  const where = conditions.length ? conditions.join(" AND ") : "1=1";
  const after = cursor ? " AND i.seq < ?" : "";
  const values = [...bindings];
  if (cursor) values.push(integer(Number(cursor), "invoice page", 1, Number.MAX_SAFE_INTEGER));
  const [rows, summary, matching] = await Promise.all([
    env.DB.prepare(`SELECT i.* FROM wholesale_invoices i${joins} WHERE ${where}${after} ORDER BY i.seq DESC LIMIT 201`).bind(...values).all<InvoiceRow>(),
    accountingSummary(env, customerId),
    !customerId && conditions.length ? env.DB.prepare(`SELECT COUNT(*) AS n FROM wholesale_invoices i${joins} WHERE ${where}`).bind(...bindings).first<{n:number}>() : null,
  ]);
  const records = rows.results.slice(0, 200);
  return json({ invoices: await withAccounting(env, records.map(document), !customerId), count: matching?.n ?? summary?.count ?? 0, nextCursor: rows.results.length > 200 ? String(records.at(-1)!.seq) : null, summary: summary || { count: 0, outstandingPence: 0, overduePence: 0, overdueCount: 0 } });
}
export async function handleInvoiceCustomer(req: Request, env: Env, route: string, user: OrderingUser): Promise<Response | null> {
  if (!(route === "invoices" || /^invoices\/\d+(?:\/pdf)?$/.test(route) || /^orders\/WS-[A-F0-9]{32}\/invoice(?:\/pdf)?$/.test(route))) return null;
  if (user.role !== "wholesale") throw new ApiError(403, "permission_denied", "Customer invoices are available only to their wholesale business account.");
  if (req.method !== "GET") throw new ApiError(403, "permission_denied", "Customers can only read their own invoices.");
  if (!(await customersSeeInvoices(env, user.customerId))) throw invoicesOff();
  if (route === "invoices") return invoiceList(req, env, user.customerId);
  const id = /^invoices\/(\d+)(\/pdf)?$/.exec(route);
  const orderId = route.split("/")[1];
  const row = id ? await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=? AND customer_id=?").bind(integer(Number(id[1]), "invoice ID", 1, Number.MAX_SAFE_INTEGER), user.customerId).first<InvoiceRow>()
    : await env.DB.prepare("SELECT i.* FROM wholesale_invoice_coverage c JOIN wholesale_invoices i ON i.seq=c.invoice_id WHERE i.customer_id=? AND c.order_id=?").bind(user.customerId, orderId).first<InvoiceRow>();
  if (!row) throw missing(); return route.endsWith("/pdf") ? issuedPdf(env,row) : json({ invoice: await presented(env,row,false) });
}

export async function invoiceLinks<T extends { id: string; tabClearedId?: string }>(env: Env, orders: T[]) {
  if (!orders.length) return orders;
  const invoices = new Map<string, { id: number; number: string }>();
  const keys = [...new Set(orders.map(order => order.id))];
  for (let start = 0; start < keys.length; start += 80) {
    const chunk = keys.slice(start, start + 80);
    const result = await env.DB.prepare(`SELECT c.order_id,i.seq,i.invoice_number FROM wholesale_invoice_coverage c
      JOIN wholesale_invoices i ON i.seq=c.invoice_id WHERE c.order_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk).all<{ seq: number; invoice_number: string; order_id: string }>();
    for (const row of result.results) invoices.set(row.order_id, { id: row.seq, number: row.invoice_number });
  }
  return orders.map((order) => {
    const invoice = invoices.get(order.id);
    return invoice ? { ...order, invoice } : order;
  });
}
