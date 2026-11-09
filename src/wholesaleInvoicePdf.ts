// Uses the same small native PDF writer as the diary, without a browser or outside service.
import "../public/pdf.js";
import type { InvoiceDocument, InvoiceLine } from "./wholesaleInvoices";
import { wholesaleInvoiceLogo } from "./wholesaleInvoiceLogo.js";

interface PdfDoc {
  W: number; H: number; pageCount: number;
  text(value: string, x: number, y: number, options?: { size?: number; bold?: boolean; color?: string; align?: string }): PdfDoc;
  line(x1: number, y1: number, x2: number, y2: number, options?: { color?: string; lw?: number }): PdfDoc;
  rect(x: number, y: number, width: number, height: number, options?: { fill?: string; stroke?: string; lw?: number }): PdfDoc;
  svg(path: string, x: number, y: number, scale: number, options?: { fill?: string }): PdfDoc;
}
interface PdfFlow {
  doc: PdfDoc; y: number; m: number; width: number;
  need(height: number): boolean;
  gap(height?: number): PdfFlow;
  heading(value: string, options?: Record<string, unknown>): PdfFlow;
  para(value: string, options?: Record<string, unknown>): PdfFlow;
  facts(pairs: (string | null | undefined)[][], options?: Record<string, unknown>): PdfFlow;
  table(columns: Record<string, unknown>[], rows: unknown[][], options?: Record<string, unknown>): PdfFlow;
  finish(): Uint8Array;
}
interface PdfApi {
  create(options: { title: string; author: string; createdAt: number }): PdfDoc;
  Flow: new (doc: PdfDoc, options: { margin: number; header: (doc: PdfDoc, margin: number, first: boolean) => number; footer: string }) => PdfFlow;
  fit(value: string, width: number, size: number, bold?: boolean): string;
  wrap(value: string, width: number, size: number, bold?: boolean): string[];
}
const pdf = (globalThis as unknown as { DiaryPDF: PdfApi }).DiaryPDF;
const money = (pence: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const rate = (basisPoints: number) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(basisPoints / 100)}%`;
const calendarDate = (value: string) => {
  const [year, month, day] = value.split("-");
  return `${Number(day)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${year}`;
};

// Unit net is a display value to four decimal places. The server's integer line totals remain authoritative.
function unitNet(line: InvoiceLine, priceBasis: InvoiceDocument["priceBasis"]): string {
  const numerator = BigInt(line.unitPricePence) * 100n * (priceBasis === "inclusive" ? 10000n : 1n);
  const denominator = priceBasis === "inclusive" ? BigInt(10000 + line.vatBasisPoints) : 1n;
  const tenThousandths = (numerator + denominator / 2n) / denominator;
  const whole = (tenThousandths / 10000n).toLocaleString("en-GB");
  const fraction = String(tenThousandths % 10000n).padStart(4, "0").replace(/0{1,2}$/, "");
  return `£${whole}.${fraction}`;
}

const colours = { ink: "#0b1220", muted: "#545f70", blue: "#0062cc", pale: "#edf5ff", line: "#d7e2ef" };

function roundedPanel(doc: PdfDoc, x: number, y: number, width: number, height: number, fill: string) {
  const radius = 11, curve = radius * .55228475;
  doc.svg(`M${radius} 0L${width - radius} 0C${width - radius + curve} 0 ${width} ${radius - curve} ${width} ${radius}L${width} ${height - radius}C${width} ${height - radius + curve} ${width - radius + curve} ${height} ${width - radius} ${height}L${radius} ${height}C${radius - curve} ${height} 0 ${height - radius + curve} 0 ${height - radius}L0 ${radius}C0 ${radius - curve} ${radius - curve} 0 ${radius} 0Z`, x, y, 1, { fill });
}

// Keep ordinary invoices compact while allowing long terms/instructions to flow past the totals card onto later pages.
function paymentAndTotals(flow: PdfFlow, invoice: InvoiceDocument) {
  flow.need(132);
  const start = flow.y, cardWidth = 211, cardHeight = 123, cardX = flow.doc.W - flow.m - cardWidth;
  const cardPage = flow.doc.pageCount, cardBottom = start + cardHeight, innerRight = cardX + cardWidth - 15;
  roundedPanel(flow.doc, cardX, start, cardWidth, cardHeight, colours.blue);
  flow.doc.text("Total excluding VAT", cardX + 15, start + 24, { size: 9, color: "#e2efff" });
  flow.doc.text(money(invoice.totals.netPence), innerRight, start + 24, { size: 9, color: "#ffffff", align: "right" });
  flow.doc.text("VAT", cardX + 15, start + 43, { size: 9, color: "#e2efff" });
  flow.doc.text(money(invoice.totals.vatPence), innerRight, start + 43, { size: 9, color: "#ffffff", align: "right" });
  flow.doc.line(cardX + 15, start + 57, innerRight, start + 57, { color: "#8ebcf0" });
  flow.doc.text("INVOICE TOTAL", cardX + 15, start + 79, { size: 8.5, bold: true, color: "#e2efff" });
  flow.doc.text(money(invoice.totals.grossPence), innerRight, start + 106, { size: 19, bold: true, color: "#ffffff", align: "right" });
  const available = () => flow.doc.pageCount === cardPage && flow.y < cardBottom + 7 ? cardX - flow.m - 24 : flow.width;
  function heading(value: string) {
    flow.need(31); flow.y += 12;
    flow.doc.text(value, flow.m, flow.y, { size: 11, bold: true, color: colours.ink });
    flow.y += 10;
  }
  function paragraph(value: string, size = 9) {
    const height = size * 1.35;
    for (const para of value.split(/\r?\n/)) {
      let width = available(), lines = pdf.wrap(para, width, size, false);
      while (lines.length) {
        flow.need(height);
        const nextWidth = available();
        if (nextWidth !== width) { lines = pdf.wrap(lines.join(" "), nextWidth, size, false); width = nextWidth; }
        flow.y += height;
        flow.doc.text(lines.shift()!, flow.m, flow.y - size * .25, { size, color: colours.muted });
      }
    }
  }
  heading("Payment terms");
  paragraph(invoice.paymentTerms.label, 9.5);
  paragraph(invoice.dueDate ? `Payment due: ${calendarDate(invoice.dueDate)}` : "Payment due: as stated in the agreed terms", 9.5);
  if (invoice.paymentTerms.note) { flow.y += 4; paragraph(invoice.paymentTerms.note); }
  if (invoice.paymentInstructions) { flow.y += 8; heading("Payment details"); paragraph(invoice.paymentInstructions); }
  if (flow.doc.pageCount === cardPage) flow.y = Math.max(flow.y, cardBottom + 8);
}

export function renderWholesaleInvoicePdf(invoice: InvoiceDocument, options: { draft?: boolean } = {}): Uint8Array {
  const draft = options.draft ?? (invoice.id === null || invoice.number === null);
  if (!draft && (!invoice.number || invoice.issuedAt === null)) throw new Error("An issued invoice needs its saved number and issue timestamp.");
  const number = draft ? "Not allocated - draft" : invoice.number!;
  const title = draft ? "DRAFT - VAT INVOICE" : "VAT INVOICE";
  const createdAt = invoice.issuedAt ?? Date.parse(invoice.invoiceDate + "T00:00:00Z");
  const doc = pdf.create({ title: `${title} - ${number}`, author: invoice.seller.legalName, createdAt });
  const flow = new pdf.Flow(doc, {
    margin: 36,
    footer: draft ? "DRAFT - not issued; no invoice number allocated" : `${number} · ${invoice.seller.legalName}`,
    header: (page, margin, first) => {
      const logoWidth = first ? 88 : 40;
      page.svg(wholesaleInvoiceLogo.path, margin, margin, logoWidth / wholesaleInvoiceLogo.width, { fill: colours.ink });
      page.text(title, page.W - margin, margin + (first ? 22 : 12), { size: first ? 22 : 12, bold: true, color: colours.blue, align: "right" });
      page.text(pdf.fit(number, first ? 280 : 275, first ? 10 : 9, true), page.W - margin, margin + (first ? 42 : 28), { size: first ? 10 : 9, bold: true, color: colours.ink, align: "right" });
      if (first && draft) page.text("Preview only. This document has not been issued.", page.W - margin, margin + 58, { size: 8, color: "#8b1b14", align: "right" });
      const bottom = margin + (first ? 69 : 38);
      page.rect(margin, bottom, page.W - margin * 2, 2, { fill: colours.blue });
      return bottom + 14;
    },
  });
  flow.table([
    { label: "INVOICE DATE", w: "flex" }, { label: "SUPPLY DATE / TAX POINT", w: "flex" }, { label: "PAYMENT DUE", w: "flex" },
  ], [[calendarDate(invoice.invoiceDate), calendarDate(invoice.supplyDate), invoice.dueDate ? calendarDate(invoice.dueDate) : "See payment terms"]], {
    size: 10, head: 7.5, pad: 7, headFill: colours.pale, headColor: colours.muted, zebra: null,
  });
  const reference = (invoice as InvoiceDocument & { orderReference?: string }).orderReference;
  flow.gap(9).facts([
    ["Invoice number", pdf.fit(number, 280, 10, true) === number ? null : number],
    ["Order", invoice.orderId], ["Purchase reference", reference],
  ], { size: 8.5, labelW: 112 });
  flow.gap(13);
  const seller = [invoice.seller.legalName, invoice.seller.address, `VAT registration: ${invoice.seller.vatNumber}`,
    invoice.seller.companyNumber ? `Company number: ${invoice.seller.companyNumber}` : "", invoice.seller.email, invoice.seller.phone].filter(Boolean).join("\n");
  const buyer = [invoice.billTo.name, invoice.billTo.address, invoice.billTo.postcode,
    invoice.billTo.vatNumber ? `VAT registration: ${invoice.billTo.vatNumber}` : "",
    invoice.deliveryLocation?.name ? `Delivery location: ${invoice.deliveryLocation.name}` : "",
    invoice.deliveryLocation?.address, invoice.deliveryLocation?.postcode].filter(Boolean).join("\n");
  flow.table([{ label: "FROM", w: "flex" }, { label: "BILL TO", w: "flex" }], [[seller, buyer]], {
    size: 9, head: 8, pad: 7, headFill: "#f3f6fa", headColor: colours.muted, zebra: null,
  });
  flow.gap(12).para(`Unit prices below exclude VAT${invoice.priceBasis === "inclusive" ? "; converted from the saved VAT-inclusive prices" : ""}. Currency: GBP.`, { size: 8, color: colours.muted });
  flow.gap(8).table([
    { label: "Description", w: "flex" }, { label: "Qty", w: 28, align: "right" },
    { label: "Unit net", w: 64, align: "right" }, { label: "VAT rate", w: 38, align: "right" },
    { label: "Net", w: 62, align: "right" }, { label: "VAT", w: 54, align: "right" }, { label: "Total", w: 64, align: "right" },
  ], invoice.lines.map(line => [
    [line.description, line.packLabel, line.grindLabel].filter(Boolean).join("\n"), String(line.quantity), unitNet(line, invoice.priceBasis),
    rate(line.vatBasisPoints), money(line.netPence), money(line.vatPence), money(line.grossPence),
  ]), { size: 8, head: 8, pad: 4.5, headFill: colours.blue, headColor: "#ffffff", zebra: "#f3f7fc", lineColor: colours.line });
  flow.gap(14).heading("VAT breakdown", { size: 10, color: colours.ink, keep: 34 }).table([
    { label: "VAT classification", w: "flex" }, { label: "Rate", w: 48, align: "right" },
    { label: "Net", w: 92, align: "right" }, { label: "VAT", w: 92, align: "right" }, { label: "Total", w: 92, align: "right" },
  ], invoice.vatBreakdown.map(item => [item.label, rate(item.basisPoints), money(item.netPence), money(item.vatPence), money(item.grossPence)]), { size: 8.5, head: 8, pad: 5, headFill: colours.pale, headColor: colours.muted, lineColor: colours.line });
  flow.gap(16); paymentAndTotals(flow, invoice);
  return flow.finish();
}

/** The caller must enforce admin/customer ownership before returning an invoice PDF. */
export function invoicePdf(invoice: InvoiceDocument, options: { draft?: boolean } = {}): Response {
  const bytes = renderWholesaleInvoicePdf(invoice, options);
  const draft = options.draft ?? (invoice.id === null || invoice.number === null);
  const name = draft ? "invoice-preview" : `invoice-${invoice.number!.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100)}`;
  return new Response(bytes.buffer as ArrayBuffer, { headers: {
    "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"`, "cache-control": "private, no-store",
  } });
}
