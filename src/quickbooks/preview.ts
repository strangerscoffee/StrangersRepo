// Pure invoice review and reconciliation. No network, writes or accounting side effects.
import type { InvoiceDocument, InvoiceLine } from "../wholesaleInvoices";

export type Environment = "sandbox" | "production";
export interface CompanyScope { environment: Environment; realmId: string }
export interface ScopedReference extends CompanyScope { id: string; active: boolean }
export interface QuickBooksMappings extends CompanyScope {
  installationId: string;
  company: { country: string; currency: string; vatNumber: string; reviewed: boolean; customNumbers?:boolean; serviceDates?:boolean };
  customer?: ScopedReference & { localCustomerId: string };
  items: Partial<Record<InvoiceLine["kind"], ScopedReference>>;
  termRef?: ScopedReference;
  taxCodes: Record<string, ScopedReference & { basisPoints: number; sales: boolean; reviewed: boolean; taxRateRef?:string|null; taxable?:boolean }>;
}
export interface Issue { code: string; message: string }
export interface InvoiceCandidate {
  localInvoiceId: number; number: string; localCustomerId: string; customerRef: string | null;
  invoiceDate: string; supplyDate: string; dueDate: string | null;
  supplierVat:string;
  currency: "GBP"; priceBasis: "inclusive" | "exclusive";
  billTo: InvoiceDocument["billTo"]; paymentTerms: InvoiceDocument["paymentTerms"]; paymentInstructions: string;
  shipping: {name:string;address:string;postcode:string}; termRef:string|null;
  lines: { kind:InvoiceLine["kind"]; taxRateRef:string|null; taxable:boolean; description: string; quantity: number; unitPricePence: number; itemRef: string | null; taxCodeRef: string | null; localRateId: string; vatBasisPoints: number; netPence: number; vatPence: number; grossPence: number }[];
  totals: InvoiceDocument["totals"];
}
export interface ExportPreview {
  mode: "preview-only"; canTransmit: false; state: "blocked" | "ready-for-sandbox-review" | "ready-for-live-review";
  scope: CompanyScope; requestId: string | null; fingerprint: string; blockers: Issue[]; notes: string[];
  candidate: InvoiceCandidate | null;
}
const amountFields = ["netPence", "vatPence", "grossPence"] as const;
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,32}$/.test(value);
const money = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
const installationId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const vatNumber = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").replace(/^GB/i, "").toUpperCase();
const hash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(value => value.toString(16).padStart(2, "0")).join("");
const reference = (value: ScopedReference | undefined, scope: CompanyScope) => value && value.active === true && validId(value.id) && value.realmId === scope.realmId && value.environment === scope.environment ? value.id : null;

/** Inputs are authoritative local invoice snapshots and separately reviewed company mappings, never customer POST data. */
export async function previewInvoice(invoice: InvoiceDocument, mappings: QuickBooksMappings): Promise<ExportPreview> {
  const blockers: Issue[] = [], add = (code: string, message: string) => blockers.push({ code, message });
  const scope = { environment: mappings.environment, realmId: mappings.realmId };
  if (!["sandbox", "production"].includes(scope.environment) || !validId(scope.realmId)) add("company_scope", "Choose a valid QuickBooks company and environment.");
  if (!installationId(mappings.installationId)) add("installation_id", "Use a stable installation ID retained with integration backups.");
  if (mappings.company.reviewed !== true || mappings.company.country !== "GB" || mappings.company.currency !== "GBP") add("company_review", "Verify the QuickBooks company is the intended UK business using GBP.");
  if(mappings.company.customNumbers===false)add("invoice_numbering","Enable custom transaction numbers in QuickBooks to preserve your issued invoice numbers.");
  if(mappings.company.serviceDates===false)add("supply_dates","Enable service dates in QuickBooks to preserve invoice supply dates.");
  if (!mappings.company.vatNumber || !invoice.seller.vatNumber || vatNumber(mappings.company.vatNumber) !== vatNumber(invoice.seller.vatNumber)) add("supplier_vat", "The QuickBooks company's VAT registration must match the issued invoice supplier.");
  if (!Number.isSafeInteger(invoice.id) || !invoice.id || invoice.id < 1 || !invoice.number || !money(invoice.issuedAt) || !invoice.issuedAt) add("issued_invoice", "Only a permanently issued invoice can be considered for export.");
  if (!invoice.number || invoice.number.length > 21 || /[\u0000-\u001f\u007f]/.test(invoice.number)) add("invoice_number", "Preserve the issued number exactly; QuickBooks DocNumber supports up to 21 characters. Do not truncate it.");
  if (!day(invoice.invoiceDate) || !day(invoice.supplyDate) || !day(invoice.dueDate)) add("invoice_dates", "Review valid invoice, supply and explicit due dates before exporting.");
  if (invoice.dueDate && day(invoice.invoiceDate) && invoice.dueDate < invoice.invoiceDate) add("due_date", "Review a due date earlier than the invoice date.");
  if (!["inclusive", "exclusive"].includes(invoice.priceBasis)) add("price_basis", "Use the price basis saved on the issued invoice.");
  const customerRef = mappings.customer?.localCustomerId === invoice.customerId ? reference(mappings.customer, scope) : null;
  if (!customerRef) add("customer_mapping", "Link this exact wholesale business to an active customer in the selected QuickBooks company.");
  if (!Array.isArray(invoice.lines) || !invoice.lines.length || invoice.lines.length > 201) add("invoice_lines", "Review the saved invoice lines.");
  const sums = { netPence: 0, vatPence: 0, grossPence: 0 }, groups = new Map<string, { basisPoints: number; netPence: number; vatPence: number; grossPence: number }>();
  const lines = (Array.isArray(invoice.lines) ? invoice.lines : []).map((line, index) => {
    const itemRef = reference(mappings.items[line.kind], scope), tax = Object.hasOwn(mappings.taxCodes, line.rateId) ? mappings.taxCodes[line.rateId] : undefined;
    const taxCodeRef = tax?.reviewed === true && tax.sales === true && tax.basisPoints === line.vatBasisPoints ? reference(tax, scope) : null;
    if (!itemRef) add("item_mapping", `Line ${index + 1} needs an active ${line.kind} item mapping for this company.`);
    if (!taxCodeRef) add("vat_mapping", `Line ${index + 1} needs a reviewed sales VAT code for ${line.rateId} at ${line.vatBasisPoints / 100}%. Zero-rated and exempt codes must be reviewed separately.`);
    const valid = [line.unitPricePence, line.netPence, line.vatPence, line.grossPence].every(money) && Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= 99 && Number.isSafeInteger(line.vatBasisPoints) && line.vatBasisPoints >= 0 && line.vatBasisPoints <= 10000;
    const base = line.quantity * line.unitPricePence;
    const denominator = invoice.priceBasis === "inclusive" ? 10000 + line.vatBasisPoints : 10000;
    const expectedVat = Math.floor((base * line.vatBasisPoints + denominator / 2) / denominator);
    if (!valid || !Number.isSafeInteger(base) || !Number.isSafeInteger(base * line.vatBasisPoints) || line.netPence + line.vatPence !== line.grossPence || (invoice.priceBasis === "inclusive" ? line.grossPence : line.netPence) !== base || line.vatPence !== expectedVat) add("line_totals", `Line ${index + 1} does not match its immutable price and VAT snapshot.`);
    for (const key of amountFields) sums[key] += line[key];
    const group = groups.get(line.rateId) || { basisPoints: line.vatBasisPoints, netPence: 0, vatPence: 0, grossPence: 0 };
    if (group.basisPoints !== line.vatBasisPoints) add("vat_breakdown", "A saved VAT rate has inconsistent percentages.");
    for (const key of amountFields) group[key] += line[key];
    groups.set(line.rateId, group);
    return { kind:line.kind,taxRateRef:tax?.taxRateRef||null,taxable:tax?.taxable!==false,description: [line.description, line.packLabel, line.grindLabel].filter(Boolean).join(" · "), quantity: line.quantity, unitPricePence: line.unitPricePence, itemRef, taxCodeRef, localRateId: line.rateId, vatBasisPoints: line.vatBasisPoints, netPence: line.netPence, vatPence: line.vatPence, grossPence: line.grossPence };
  });
  if (amountFields.some(key => !money(invoice.totals[key]) || !money(sums[key]) || sums[key] !== invoice.totals[key])) add("invoice_totals", "Saved line totals must exactly match the issued invoice totals.");
  const breakdown = Array.isArray(invoice.vatBreakdown) ? invoice.vatBreakdown : [];
  if (breakdown.length !== groups.size || new Set(breakdown.map(row => row.rateId)).size !== breakdown.length || breakdown.some(row => { const group = groups.get(row.rateId); return !group || group.basisPoints !== row.basisPoints || amountFields.some(key => row[key] !== group[key]); })) add("vat_breakdown", "Saved VAT breakdown must exactly match the issued lines.");
  const candidate: InvoiceCandidate = { localInvoiceId: invoice.id!, number: invoice.number!, localCustomerId: invoice.customerId, customerRef, invoiceDate: invoice.invoiceDate, supplyDate: invoice.supplyDate, dueDate: invoice.dueDate, supplierVat:invoice.seller.vatNumber,currency: "GBP", priceBasis: invoice.priceBasis, billTo: { ...invoice.billTo }, shipping:{name:String(invoice.deliveryLocation?.name||invoice.billTo.name),address:String(invoice.deliveryLocation?.address||invoice.billTo.address),postcode:String(invoice.deliveryLocation?.postcode||invoice.billTo.postcode)},termRef:reference(mappings.termRef,scope),paymentTerms: { ...invoice.paymentTerms }, paymentInstructions: invoice.paymentInstructions, lines, totals: { ...invoice.totals } };
  // Fingerprint only the export content. Payment/employee metadata is not part of a create operation.
  const fingerprint = await hash(candidate);
  const requestId = Number.isSafeInteger(invoice.id) && invoice.id! > 0 && validId(scope.realmId) && installationId(mappings.installationId) ? "sc-inv-" + (await hash([mappings.installationId, scope.environment, scope.realmId, invoice.id])).slice(0, 40) : null;
  return { mode: "preview-only", canTransmit: false, state: blockers.length ? "blocked" : scope.environment==="sandbox"?"ready-for-sandbox-review":"ready-for-live-review", scope, requestId, fingerprint, blockers, candidate: blockers.length ? null : candidate, notes: ["This review is built from the issued invoice snapshot.", "Live export requires reviewed production settings and successful sandbox evidence.", "Manual paid status is not proof of a QuickBooks payment; no payment transaction is generated.", "Supply date, agreed terms and payment instructions must be preserved in the reviewed API mapping."] };
}

export interface InvoiceLink extends CompanyScope { localInvoiceId: number; remoteInvoiceId: string; customerRef: string; number: string; requestId: string; fingerprint: string }
export function creationDecision(preview: ExportPreview, existing?: InvoiceLink): "blocked" | "review-create" | "already-linked" | "conflict" {
  if (preview.state === "blocked" || !preview.candidate || !preview.requestId) return "blocked";
  if (!existing) return "review-create";
  return validId(existing.remoteInvoiceId) && existing.realmId === preview.scope.realmId && existing.environment === preview.scope.environment && existing.localInvoiceId === preview.candidate.localInvoiceId && existing.customerRef === preview.candidate.customerRef && existing.number === preview.candidate.number && existing.requestId === preview.requestId && existing.fingerprint === preview.fingerprint ? "already-linked" : "conflict";
}

/** Strict GBP parser: reject sub-penny values instead of rounding an accounting discrepancy away. */
export function decimalPence(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value), match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match) return null;
  const pence = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return money(pence) ? pence : null;
}
export interface RemoteInvoice {
  Id?: string; DocNumber?: string; SyncToken?: string; CustomerRef?: { value?: string }; CurrencyRef?: { value?: string };
  TotalAmt?: unknown; Balance?: unknown; TxnTaxDetail?: { TotalTax?: unknown };
}
export type Reconciliation = { status: "review"; reason: string } | { status: "unpaid" | "part-paid" | "paid"; outstandingPence: number; paidPence: number; syncToken: string };
/** A read-only comparison. Caller must authenticate the response's company scope and persist observations with CAS. */
export function reconcileInvoice(preview: ExportPreview, link: InvoiceLink, observedScope: CompanyScope, remote: RemoteInvoice | null): Reconciliation {
  if (creationDecision(preview, link) !== "already-linked" || !preview.candidate) return { status: "review", reason: "The local invoice or accounting link needs review." };
  if (!remote || observedScope.realmId !== link.realmId || observedScope.environment !== link.environment || remote.Id !== link.remoteInvoiceId || remote.DocNumber !== link.number || remote.CustomerRef?.value !== link.customerRef || remote.CurrencyRef?.value !== "GBP" || !/^\d+$/.test(remote.SyncToken || "")) return { status: "review", reason: "Verify the company, invoice identity, customer, currency and current revision." };
  const total = decimalPence(remote.TotalAmt), vat = decimalPence(remote.TxnTaxDetail?.TotalTax), balance = decimalPence(remote.Balance);
  if (total !== preview.candidate.totals.grossPence || vat !== preview.candidate.totals.vatPence || balance === null || balance > total) return { status: "review", reason: "The accounting amounts differ from the saved invoice; do not overwrite its payment state." };
  return { status: balance === 0 ? "paid" : balance === total ? "unpaid" : "part-paid", outstandingPence: balance, paidPence: total - balance, syncToken: remote.SyncToken! };
}
