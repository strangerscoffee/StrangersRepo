// VAT invoices are issued once from saved real orders. Payment recording never moves money.
import { MAX_QUANTITY } from "../public/wholesale/limits.js";
import { audit } from "./audit";
import { ApiError, type Env, invalid, json, readJson } from "./http";
import { get, object, text, version } from "./wholesaleStore";
import type { OrderingUser } from "./wholesaleAccounts";
import { invoicePdf } from "./wholesaleInvoicePdf";
import {withAccounting,accountingSummary} from "./quickbooks/observations";

export interface VatRate { id: string; label: string; basisPoints: number }
export interface InvoiceSettings {
  seller: { legalName: string; address: string; vatNumber: string; companyNumber: string; email: string; phone: string };
  priceBasis: "inclusive" | "exclusive" | null; vatRates: VatRate[];
  defaultCoffeeRateId: string; deliveryRateId: string; invoicePrefix: string;
  firstInvoiceNumber: number; paymentInstructions: string; confirmed: boolean;
  /** Whether customers see their invoices (My orders → Invoices, invoice PDFs, balances). Absent means on. */
  customersSeeInvoices?: boolean;
}
interface SettingsRow { data: string; version: number; updated_at: number }
export interface InvoiceLine {
  kind: "coffee" | "delivery"; description: string; quantity: number; unitPricePence: number;
  rateId: string; rateLabel: string; vatBasisPoints: number; netPence: number; vatPence: number; grossPence: number;
  packLabel?: string; grindLabel?: string;
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
}
export interface InvoiceDocument extends InvoiceData {
  id: number | null; number: string | null; issuedAt: number | null; issuedBy: string | null;
  payment: { status: "paid" | "unpaid" | "overdue" | "part-paid" | "review"; paid: boolean; paidDate: string | null; reference: string; version: number; outstandingPence: number;paidPence?:number;source?:"quickbooks";checkedAt?:number|null };
  accounting?:{status:string;checkedAt:number|null;exportId?:number;reason?:string};
}
interface InvoiceRow { seq: number; invoice_number: string; order_id: string; customer_id: string; request_key: string; data: string; issued_at: number; issued_by: string; paid: number; paid_date: string | null; paid_at: number | null; payment_reference: string; payment_version: number }
interface SourceOrder {
  preview?: boolean; deletedAt?: number; business: string; reference?: string; customerId: string | null; status: string; createdAt: number;
  customerSnapshot?: { address?: string; postcode?: string; paymentTerms?: Terms }; locationSnapshot?: Record<string, any>;
  paymentTerms?: Terms; lines: { title: string; packLabel: string; grindLabel: string; quantity: number; price: number }[];
}
interface InvoiceRequest {
  orderVersion: number; settingsVersion: number; invoiceDate: string; supplyDate: string;
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
  if (!settings.invoicePrefix) reasons.push("Choose the invoice number prefix.");
  if (!settings.confirmed) reasons.push("Confirm the supplier, VAT and numbering details before issuing invoices.");
  return { ready: reasons.length === 0, reasons };
}
async function settings(env: Env) {
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM wholesale_invoice_settings WHERE id = 1").first<SettingsRow>();
  const value: InvoiceSettings = row ? JSON.parse(row.data) : defaults();
  return { settings: value, version: row?.version || 0, updatedAt: row?.updated_at || null, ...readiness(value) };
}
/** Admin's switch for the customer side of invoicing; issuing and payment records in Admin are unaffected. */
export async function customersSeeInvoices(env: Env) {
  const row = await env.DB.prepare("SELECT json_extract(data,'$.customersSeeInvoices') AS v FROM wholesale_invoice_settings WHERE id = 1").first<{ v: number | null }>();
  return row?.v !== 0;
}
const invoicesOff = () => new ApiError(403, "invoices_unavailable", "Invoices aren’t shown here at the moment. Contact Strangers if you need a copy.");
function requestBody(body: Record<string, any>): InvoiceRequest {
  const delivery = body.deliveryCharge === undefined ? {} : object(body.deliveryCharge);
  const billTo = body.billTo === undefined ? null : object(body.billTo);
  const lineVatRateIds = body.lineVatRateIds === undefined ? null : body.lineVatRateIds;
  if (lineVatRateIds !== null && (!Array.isArray(lineVatRateIds) || lineVatRateIds.length > 150)) throw invalid("Check the VAT rates for the saved order lines.");
  return { orderVersion: integer(body.orderVersion, "reviewed order version", 1, Number.MAX_SAFE_INTEGER), settingsVersion: integer(body.settingsVersion, "reviewed invoice settings version", 0, Number.MAX_SAFE_INTEGER), invoiceDate: date(body.invoiceDate, "invoice date"), supplyDate: date(body.supplyDate, "supply date"), billTo: billTo ? { name: text(billTo.name, "customer billing name", 180), address: text(billTo.address, "customer billing address", 1000), postcode: text(billTo.postcode, "customer billing postcode", 20), vatNumber: text(billTo.vatNumber, "customer VAT number", 40) } : null, deliveryCharge: { pence: delivery.pence === undefined ? 0 : integer(delivery.pence, "delivery charge in pence", 0, 100000000), description: text(delivery.description, "delivery description", 180) || "Delivery", vatRateId: slug(delivery.vatRateId, "delivery VAT rate", true) }, lineVatRateIds: lineVatRateIds?.map((id: unknown) => slug(id, "line VAT rate")) || null, paymentInstructions: body.paymentInstructions === undefined ? null : text(body.paymentInstructions, "payment instructions", 2000), dueDate: body.dueDate === undefined || body.dueDate === null || body.dueDate === "" ? null : date(body.dueDate, "payment due date") };
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
async function presented(env:Env,row:InvoiceRow,admin=true){return (await withAccounting(env,[document(row)],admin))[0];}
export async function issuedInvoice(env: Env, id: number): Promise<InvoiceDocument> {
  const row = await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=?").bind(integer(id, "invoice ID", 1, Number.MAX_SAFE_INTEGER)).first<InvoiceRow>();
  if (!row) throw missing(); return document(row);
}
async function invoiceByOrder(env: Env, orderId: string) { return env.DB.prepare("SELECT * FROM wholesale_invoices WHERE order_id = ?").bind(orderId).first<InvoiceRow>(); }
async function build(env: Env, orderId: string, request: InvoiceRequest): Promise<{ data: InvoiceData; config: InvoiceSettings }> {
  const config = await settings(env);
  if (!config.ready) throw new ApiError(409, "invoice_settings_incomplete", config.reasons.join(" "));
  if (config.version !== request.settingsVersion) throw conflict("Invoice settings changed. Review the invoice again.");
  const order = await get<SourceOrder>(env, "order", orderId);
  if (!order || order.deletedAt != null) throw new ApiError(404, "not_found", "Order not found.");
  if (!orderId.startsWith("WS-") || order.preview !== false || !order.customerId) throw invalid("Invoices can only be issued for real customer orders.");
  if (order.status === "Cancelled") throw invalid("An invoice cannot be issued for a cancelled order.");
  if (order.version !== request.orderVersion) throw conflict("The order changed. Review its details before issuing an invoice.");
  const value = config.settings;
  const billTo = request.billTo || { name: order.business, address: order.customerSnapshot?.address || "", postcode: order.customerSnapshot?.postcode || "", vatNumber: "" };
  if (!billTo.name || !billTo.address) throw invalid("Add the customer's billing name and full address before issuing an invoice.");
  if (request.lineVatRateIds && request.lineVatRateIds.length !== order.lines.length) throw invalid("Choose one VAT rate for each saved order line.");
  const rate = (id: string) => { const found = value.vatRates.find((item) => item.id === id); if (!found) throw invalid("Choose a configured VAT rate."); return found; };
  const lines = order.lines.map((line, i) => ({ ...invoiceLine("coffee", line.title, line.quantity, line.price, rate(request.lineVatRateIds?.[i] || value.defaultCoffeeRateId), value.priceBasis!), packLabel: line.packLabel, grindLabel: line.grindLabel }));
  if (request.deliveryCharge.pence) lines.push(invoiceLine("delivery", request.deliveryCharge.description, 1, request.deliveryCharge.pence, rate(request.deliveryCharge.vatRateId || value.deliveryRateId), value.priceBasis!) as typeof lines[number]);
  const vatBreakdown: InvoiceData["vatBreakdown"] = [];
  const totals = { netPence: 0, vatPence: 0, grossPence: 0 };
  for (const line of lines) {
    let group = vatBreakdown.find((item) => item.rateId === line.rateId);
    if (!group) { group = { rateId: line.rateId, label: line.rateLabel, basisPoints: line.vatBasisPoints, netPence: 0, vatPence: 0, grossPence: 0 }; vatBreakdown.push(group); }
    for (const key of ["netPence", "vatPence", "grossPence"] as const) { totals[key] += line[key]; group[key] += line[key]; }
  }
  const paymentTerms = order.paymentTerms || order.customerSnapshot?.paymentTerms || { id: "not-recorded", label: "Payment terms not recorded", note: "" };
  const netDays = /^net-(7|14|30|60)$/.exec(paymentTerms.id)?.[1];
  const dueDate = netDays ? new Date(Date.parse(request.invoiceDate + "T00:00:00Z") + Number(netDays) * 86400000).toISOString().slice(0, 10) : request.dueDate;
  if (netDays && request.dueDate && request.dueDate !== dueDate) throw invalid("The due date must follow this order's agreed invoice payment terms.");
  if (dueDate && dueDate < request.invoiceDate) throw invalid("The payment due date cannot be before the invoice date.");
  return { config: value, data: { orderId, orderReference: order.reference || "", customerId: order.customerId, invoiceDate: request.invoiceDate, supplyDate: request.supplyDate, seller: { ...value.seller }, billTo: { ...billTo }, deliveryLocation: order.locationSnapshot ? { ...order.locationSnapshot } : null, priceBasis: value.priceBasis!, lines, totals, vatBreakdown, paymentTerms: { ...paymentTerms }, paymentInstructions: request.paymentInstructions ?? value.paymentInstructions, dueDate, orderVersion: order.version, settingsVersion: config.version } };
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
  if (route === "invoice-settings" && req.method === "PUT") {
    const body = object(await readJson(req, 16 * 1024)), expected = version(body.ifVersion), value = settingsBody(body), at = Date.now();
    const old = await settings(env);
    if (old.version !== expected) throw conflict("Invoice settings changed on another device. Reload before saving.");
    if (old.settings.customersSeeInvoices === false) value.customersSeeInvoices = false;
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
    const row = await invoiceByOrder(env, order[1]);
    if (!row) {
      const saved = await get<SourceOrder>(env, "order", order[1]);
      if (!saved || saved.deletedAt != null) throw new ApiError(404, "not_found", "Order not found.");
      if (!order[1].startsWith("WS-") || saved.preview !== false) throw invalid("Invoices can only be issued for real customer orders.");
    }
    if (order[3]) { if (!row) throw missing(); return invoicePdf(document(row)); }
    return json({ invoice: row ? await presented(env,row) : null });
  }
  if (order && req.method === "POST") {
    if (order[3] && !order[2]) throw new ApiError(404, "not_found", "Preview a draft PDF before issuing the invoice.");
    const request = requestBody(object(await readJson(req, 16 * 1024))), requestKey = await digest(request);
    const existing = await invoiceByOrder(env, order[1]);
    if (existing) {
      if (order[2]) return order[3] ? invoicePdf(document(existing)) : json({ invoice: await presented(env,existing), issued: true });
      if (existing.request_key !== requestKey) throw conflict("This order already has an issued invoice. Open that invoice; issued invoices cannot be changed.");
      return json({ invoice: await presented(env,existing) });
    }
    const { data, config } = await build(env, order[1], request);
    if (order[2]) {
      const preview: InvoiceDocument = { ...data, id: null, number: null, issuedAt: null, issuedBy: null, payment: { status: data.dueDate && data.dueDate < today() ? "overdue" : "unpaid", paid: false, paidDate: null, reference: "", version: 0, outstandingPence: data.totals.grossPence } };
      return order[3] ? invoicePdf(preview, { draft: true }) : json({ invoice: preview, issued: false });
    }
    const at = Date.now();
    const inserted = await env.DB.prepare("INSERT INTO wholesale_invoices(seq,invoice_number,order_id,customer_id,request_key,data,issued_at,issued_by) SELECT next_seq, ? || printf('%06d', ? + next_seq - 1), ?,?,?,?,?,? FROM (SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='wholesale_invoices'),0)+1 AS next_seq) WHERE NOT EXISTS(SELECT 1 FROM wholesale_invoices WHERE order_id=?) AND EXISTS(SELECT 1 FROM wholesale_preview WHERE kind='order' AND id=? AND version=? AND json_extract(data,'$.preview')=0 AND json_extract(data,'$.deletedAt') IS NULL AND json_extract(data,'$.status') <> 'Cancelled') AND EXISTS(SELECT 1 FROM wholesale_invoice_settings WHERE id=1 AND version=?) RETURNING *")
      .bind(config.invoicePrefix, config.firstInvoiceNumber, order[1], data.customerId, requestKey, JSON.stringify(data), at, actor, order[1], order[1], request.orderVersion, request.settingsVersion).first<InvoiceRow>();
    if (!inserted) {
      const raced = await invoiceByOrder(env, order[1]);
      if (raced?.request_key === requestKey) return json({ invoice: await presented(env,raced) });
      throw conflict("The order, invoice or settings changed. Reload and review before issuing.");
    }
    await audit(env, "wholesale_invoice_issued", actor, `${actor} issued invoice ${inserted.invoice_number} for ${order[1]}.`);
    return json({ invoice: await presented(env,inserted) }, 201);
  }
  const payment = /^invoices\/(\d+)\/payment$/.exec(route);
  if (payment && req.method === "PATCH") {
    const invoiceId=integer(Number(payment[1]),"invoice ID",1,Number.MAX_SAFE_INTEGER);
    if(await env.DB.prepare("SELECT id FROM quickbooks_exports WHERE environment='production' AND invoice_id=? AND state='linked'").bind(invoiceId).first())throw new ApiError(409,"quickbooks_managed_payment","Record this invoice payment in QuickBooks, then refresh its payment status.");
    const body = object(await readJson(req, 4096)), expected = version(body.ifVersion);
    if (typeof body.paid !== "boolean") throw invalid("Choose paid or unpaid.");
    const paidDate = body.paid ? (body.paidDate ? date(body.paidDate, "payment date") : today()) : null;
    if (paidDate && paidDate > today()) throw invalid("The payment date cannot be in the future.");
    const reference = text(body.reference, "payment reference", 180);
    const row = await env.DB.prepare("UPDATE wholesale_invoices SET paid=?,paid_date=?,paid_at=?,payment_reference=?,payment_version=payment_version+1 WHERE seq=? AND payment_version=? RETURNING *").bind(body.paid ? 1 : 0, paidDate, body.paid ? Date.now() : null, reference, integer(Number(payment[1]), "invoice ID", 1, Number.MAX_SAFE_INTEGER), expected).first<InvoiceRow>();
    if (!row) { if (!await env.DB.prepare("SELECT seq FROM wholesale_invoices WHERE seq=?").bind(Number(payment[1])).first()) throw missing(); throw conflict("This payment record changed. Reload before saving."); }
    await audit(env, "wholesale_invoice_payment", actor, `${actor} marked invoice ${row.invoice_number} as ${body.paid ? "paid" : "unpaid"}. No bank transaction was performed.`);
    return json({ invoice: await presented(env,row) });
  }
  if (route === "invoices" && req.method === "GET") return invoiceList(req, env);
  const match = /^invoices\/(\d+)(\/pdf)?$/.exec(route);
  if (match && req.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=?").bind(integer(Number(match[1]), "invoice ID", 1, Number.MAX_SAFE_INTEGER)).first<InvoiceRow>();
    if (!row) throw missing(); return match[2] ? invoicePdf(document(row)) : json({ invoice: await presented(env,row) });
  }
  return null;
}

async function invoiceList(req: Request, env: Env, customerId?: string): Promise<Response> {
  const query = new URL(req.url).searchParams, cursor = query.get("cursor");
  const where = customerId ? "customer_id=?" : "1=1", bindings: (string | number)[] = customerId ? [customerId] : [];
  const after = cursor ? " AND seq < ?" : "";
  const values = [...bindings]; if (cursor) values.push(integer(Number(cursor), "invoice page", 1, Number.MAX_SAFE_INTEGER));
  const [rows, summary] = await Promise.all([
    env.DB.prepare(`SELECT * FROM wholesale_invoices WHERE ${where}${after} ORDER BY seq DESC LIMIT 201`).bind(...values).all<InvoiceRow>(),
    accountingSummary(env,customerId),
  ]);
  const records = rows.results.slice(0, 200);
  return json({ invoices: await withAccounting(env,records.map(document),!customerId), count: summary?.count || 0, nextCursor: rows.results.length > 200 ? String(records.at(-1)!.seq) : null, summary: summary || { count: 0, outstandingPence: 0, overduePence: 0, overdueCount: 0 } });
}
export async function handleInvoiceCustomer(req: Request, env: Env, route: string, user: OrderingUser): Promise<Response | null> {
  if (!(route === "invoices" || /^invoices\/\d+(?:\/pdf)?$/.test(route) || /^orders\/WS-[A-F0-9]{32}\/invoice(?:\/pdf)?$/.test(route))) return null;
  if (user.role !== "wholesale") throw new ApiError(403, "permission_denied", "Customer invoices are available only to their wholesale business account.");
  if (req.method !== "GET") throw new ApiError(403, "permission_denied", "Customers can only read their own invoices.");
  if (!(await customersSeeInvoices(env))) throw invoicesOff();
  if (route === "invoices") return invoiceList(req, env, user.customerId);
  const id = /^invoices\/(\d+)(\/pdf)?$/.exec(route);
  const row = id ? await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE seq=? AND customer_id=?").bind(integer(Number(id[1]), "invoice ID", 1, Number.MAX_SAFE_INTEGER), user.customerId).first<InvoiceRow>() : await env.DB.prepare("SELECT * FROM wholesale_invoices WHERE order_id=? AND customer_id=?").bind(route.split("/")[1], user.customerId).first<InvoiceRow>();
  if (!row) throw missing(); return route.endsWith("/pdf") ? invoicePdf(document(row)) : json({ invoice: await presented(env,row,false) });
}

export async function invoiceLinks<T extends { id: string }>(env: Env, orders: T[]) {
  if (!orders.length) return orders;
  const invoices: { seq: number; invoice_number: string; order_id: string }[] = [];
  for (let start = 0; start < orders.length; start += 80) {
    const chunk = orders.slice(start, start + 80);
    const result = await env.DB.prepare(`SELECT seq,invoice_number,order_id FROM wholesale_invoices WHERE order_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk.map((order) => order.id)).all<{ seq: number; invoice_number: string; order_id: string }>();
    invoices.push(...result.results);
  }
  return orders.map((order) => { const invoice = invoices.find((invoice) => invoice.order_id === order.id); return invoice ? { ...order, invoice: { id: invoice.seq, number: invoice.invoice_number } } : order; });
}
