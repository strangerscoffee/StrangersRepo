// Invoice PDF fields, immutable output and real text geometry, without a browser or external PDF service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderWholesaleInvoicePdf, invoicePdf } from "../src/wholesaleInvoicePdf.ts";
import { wholesaleInvoiceLogo } from "../src/wholesaleInvoiceLogo.js";

function fixture() {
  return {
    id: 42, number: "INV-2026-000042", orderId: "WS-11111111111111111111111111111111", customerId: "buyer-a",
    orderReference: "PO-COFFEE-42", invoiceDate: "2026-11-09", supplyDate: "2026-11-08", issuedAt: Date.UTC(2026, 10, 9, 14, 25, 17), issuedBy: "Internal Admin Name",
    seller: { legalName: "Strangers Example Coffee Limited", address: "10 Example Street\nNorwich\nNR1 1AA", vatNumber: "GB123456789", companyNumber: "01234567", email: "accounts@example.test", phone: "01603 000000" },
    billTo: { name: "Example Customer Limited", address: "20 Buyer Street\nNorwich", postcode: "NR2 2BB", vatNumber: "GB987654321" },
    deliveryLocation: { id: "primary", name: "Riverside café", address: "30 Riverside Road", postcode: "NR3 3CC" },
    priceBasis: "inclusive",
    lines: [
      { kind: "coffee", description: "Brazil Natural", quantity: 2, unitPricePence: 3700, rateId: "standard", rateLabel: "Standard rate", vatBasisPoints: 2000, netPence: 6167, vatPence: 1233, grossPence: 7400, packLabel: "1 kg bag", grindLabel: "Beans" },
      { kind: "delivery", description: "Delivery", quantity: 1, unitPricePence: 600, rateId: "zero", rateLabel: "Zero rate", vatBasisPoints: 0, netPence: 600, vatPence: 0, grossPence: 600 },
    ],
    totals: { netPence: 6767, vatPence: 1233, grossPence: 8000 },
    vatBreakdown: [
      { rateId: "standard", label: "Standard rate", basisPoints: 2000, netPence: 6167, vatPence: 1233, grossPence: 7400 },
      { rateId: "zero", label: "Zero rate", basisPoints: 0, netPence: 600, vatPence: 0, grossPence: 600 },
    ],
    paymentTerms: { id: "net-14", label: "14 days from invoice", note: "Use the invoice number as your payment reference." },
    paymentInstructions: "Example Bank\nAccount name: Strangers Example Coffee Limited\nSort code: 00-00-00\nAccount number: 00000000\nReference: invoice number",
    dueDate: "2026-11-23", orderVersion: 3, settingsVersion: 2,
    payment: { status: "unpaid", paid: false, paidDate: null, reference: "", version: 0, outstandingPence: 8000 },
  };
}

function pdfText(bytes) {
  const raw = Buffer.from(bytes).toString("latin1"), decoder = new TextDecoder("windows-1252");
  const strings = [...raw.matchAll(/<([0-9a-f]+)>\s*Tj/g)].map((match) => decoder.decode(Buffer.from(match[1], "hex")));
  return { raw, text: strings.join("\n"), strings };
}

function capture(invoice, options) {
  const api = globalThis.DiaryPDF, original = api.Doc.prototype.text, originalSvg = api.Doc.prototype.svg, boxes = [], vectors = [];
  api.Doc.prototype.text = function (value, x, y, style = {}) {
    const size = style.size || 10, width = api.width(value, size, !!style.bold);
    if (String(value).trim()) {
      const left = style.align === "right" ? x - width : style.align === "center" ? x - width / 2 : x;
      boxes.push({ page: this.pages.indexOf(this.ops), left, right: left + width, top: y - size * .75, bottom: y + size * .2, W: this.W, H: this.H, text: String(value) });
    }
    return original.call(this, value, x, y, style);
  };
  api.Doc.prototype.svg = function (path, x, y, scale, style) {
    vectors.push({ path, x, y, scale, page: this.pages.indexOf(this.ops), style });
    return originalSvg.call(this, path, x, y, scale, style);
  };
  try { return { bytes: renderWholesaleInvoicePdf(invoice, options), boxes, vectors }; }
  finally { api.Doc.prototype.text = original; api.Doc.prototype.svg = originalSvg; }
}

function geometryProblems(boxes) {
  const problems = [];
  for (const box of boxes) {
    if (box.left < 24 || box.right > box.W - 24 || box.top < 24 || box.bottom > box.H - 24) problems.push(`Off page ${box.page + 1}: ${box.text}`);
  }
  const pages = new Set(boxes.map((box) => box.page));
  for (const page of pages) {
    const row = boxes.filter((box) => box.page === page);
    for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) {
      const a = row[i], b = row[j];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) problems.push(`Overlap page ${page + 1}: ${a.text} / ${b.text}`);
    }
  }
  return problems;
}

test("invoice PDF: full supplier/buyer VAT fields, net unit prices, captured terms and integer totals are present", () => {
  const invoice = fixture(), original = structuredClone(invoice), { bytes, boxes, vectors } = capture(invoice);
  const { raw, text, strings } = pdfText(bytes);
  assert.match(raw, /^%PDF-1\.4/);
  assert.match(raw, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 1\b/, "an ordinary two-line/two-rate invoice with full payment details fits one A4 page");
  const sourceLogo = readFileSync(new URL("../public/logo.svg", import.meta.url), "utf8");
  assert.equal(wholesaleInvoiceLogo.path, sourceLogo.match(/\sd="([^"]+)"/)[1], "the generated vector is the actual website logo");
  const drawnLogo = vectors.find((vector) => vector.path === wholesaleInvoiceLogo.path);
  assert.ok(drawnLogo && drawnLogo.x === 36 && drawnLogo.y === 36 && drawnLogo.scale * wholesaleInvoiceLogo.width === 88, "the actual logo is drawn in the invoice header");
  assert.match(raw, /0 0\.38 0\.8 rg/, "the invoice uses the website's blue accent");
  const xref = Number(raw.match(/startxref\n(\d+)\n%%EOF/)[1]);
  assert.equal(raw.slice(xref, xref + 4), "xref", "PDF offsets refer to a valid cross-reference table");
  for (const expected of ["VAT INVOICE", invoice.number, invoice.seller.legalName, invoice.seller.vatNumber, invoice.seller.companyNumber, invoice.billTo.name, invoice.billTo.vatNumber, invoice.orderReference, "9 Nov 2026", "8 Nov 2026", "23 Nov 2026", "Riverside café", "Brazil Natural", "1 kg bag", "Beans", "20%", "0%", "14 days from invoice", "Account number: 00000000"]) assert.ok(text.includes(expected), `PDF includes ${expected}`);
  assert.ok(strings.includes("£30.8333"), "VAT-inclusive £37 unit is displayed exclusive of20% VAT to four decimal places");
  for (const amount of ["£61.67", "£12.33", "£67.67", "£80.00"]) assert.ok(strings.includes(amount), `server-calculated amount ${amount} is retained`);
  assert.doesNotMatch(text, /Internal Admin Name|Outstanding|Payment received/);
  assert.deepEqual(geometryProblems(boxes), []);
  assert.deepEqual(invoice, original, "rendering cannot mutate the saved document");
  const longNumber = fixture();
  longNumber.number = "W".repeat(40) + "-000042";
  assert.ok(pdfText(renderWholesaleInvoicePdf(longNumber)).strings.includes(longNumber.number), "an unusually long invoice number is retained in full even when the running header shortens it");
});

test("invoice PDF: long addresses, 150 lines and long instructions paginate without overlap or loss", () => {
  const invoice = fixture();
  invoice.seller.legalName = "Strangers Example Coffee Company With A Very Long Registered Legal Trading Name Limited";
  invoice.seller.address = Array.from({ length: 14 }, (_, i) => `Supplier address line ${i + 1}, Norwich`).join("\n");
  invoice.billTo.name = "An exceptionally long customer company name serving multiple café delivery locations Limited";
  invoice.billTo.address = "BuyerAddressWithoutAnyWordBreaks".repeat(16) + "\n20 Buyer Street\nNorwich";
  invoice.paymentTerms.note = "Agreed payment details. ".repeat(22);
  invoice.paymentInstructions = Array.from({ length: 90 }, (_, i) => `Payment instruction ${i + 1}: use the saved invoice reference.`).join("\n") + "\nFINAL PAYMENT INSTRUCTION";
  invoice.lines = Array.from({ length: 150 }, (_, i) => ({ ...invoice.lines[0], description: i === 0 ? "ExceptionallyLongUnbrokenCoffeeName".repeat(160) : `Coffee ${i + 1}: ${"Long coffee description ".repeat(9)}`, quantity: 99 }));
  const { bytes, boxes } = capture(invoice), { text, raw } = pdfText(bytes);
  const pages = Number(raw.match(/\/Type \/Pages \/Kids \[[\s\S]*?\] \/Count (\d+)/)[1]);
  assert.ok(pages > 8, `long document paginated across ${pages} pages`);
  assert.ok(text.includes("Coffee 150:"), "the final coffee line is retained");
  assert.ok(text.includes("FINAL PAYMENT INSTRUCTION"), "payment instructions finish after page breaks");
  assert.equal((text.match(/Page \d+ of \d+/g) || []).length, pages, "every page has a footer");
  assert.ok((text.match(/Description/g) || []).length > 1, "item column labels repeat on continuation pages");
  assert.deepEqual(geometryProblems(boxes).slice(0, 12), []);
});

test("invoice PDF: draft has no allocated number, and issued bytes ignore later payment metadata", () => {
  const invoice = fixture();
  const { text: draft } = pdfText(renderWholesaleInvoicePdf(invoice, { draft: true }));
  assert.match(draft, /DRAFT - VAT INVOICE/);
  assert.match(draft, /not been issued/);
  assert.match(draft, /Not allocated - draft/);
  assert.doesNotMatch(draft, new RegExp(invoice.number));
  const original = renderWholesaleInvoicePdf(invoice);
  invoice.payment = { status: "paid", paid: true, paidDate: "2026-11-20", reference: "PRIVATE BANK RECORD", version: 1, outstandingPence: 0 };
  const paid = renderWholesaleInvoicePdf(invoice);
  assert.deepEqual(paid, original, "stored issue timestamp and financial fields make the PDF immutable after payment recording");
  assert.match(Buffer.from(paid).toString("latin1"), /CreationDate \(D:20261109142517Z\)/);
  assert.doesNotMatch(pdfText(paid).text, /PRIVATE BANK RECORD/);
  invoice.id = null; invoice.number = null; invoice.issuedAt = null;
  assert.match(pdfText(renderWholesaleInvoicePdf(invoice)).text, /DRAFT - VAT INVOICE/);
});

test("invoice PDF: safe private response and exclusive-price unit display", async () => {
  const invoice = fixture();
  invoice.priceBasis = "exclusive";
  const response = invoicePdf(invoice);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="invoice-INV-2026-000042.pdf"');
  const { text } = pdfText(new Uint8Array(await response.arrayBuffer()));
  assert.ok(text.includes("£37.00"));
  assert.doesNotMatch(text, /converted from the saved VAT-inclusive/);
  invoice.number = 'unsafe/number"\r\n';
  assert.match(invoicePdf(invoice).headers.get("content-disposition"), /^inline; filename="invoice-[a-zA-Z0-9_-]+\.pdf"$/);
});

test("native PDF wrapping: binary prefix search preserves old wrapping with bounded long-token work", () => {
  const pdf = globalThis.DiaryPDF;
  // The previous backwards scan is a compatibility oracle for the shared browser reports.
  function previousWrap(value, available, size, bold) {
    const lines = [];
    for (const para of String(value == null ? "" : value).split(/\r?\n/)) {
      let line = "";
      for (let word of para.split(/ +/)) {
        const candidate = line ? line + " " + word : word;
        if (pdf.width(candidate, size, bold) <= available) { line = candidate; continue; }
        if (line) lines.push(line);
        while (pdf.width(word, size, bold) > available && word.length > 1) {
          let end = word.length - 1;
          while (end > 1 && pdf.width(word.slice(0, end), size, bold) > available) end--;
          lines.push(word.slice(0, end)); word = word.slice(end);
        }
        line = word;
      }
      lines.push(line);
    }
    return lines;
  }
  const examples = ["", "one  two   three", "Line one\n\nLine two\r\nLast line", "Café £37.00 × 99 – paid", "Žluťoučký kůň", "Unicode😀😀 ending", "W".repeat(180), "prefix " + "é£😀".repeat(30) + " suffix", "a\tlong\tvalue", "zero\u200bwidth\u00a0space"];
  for (const value of examples) for (const width of [1, 16, 48, 120, 300]) for (const size of [7, 12]) for (const bold of [false, true]) {
    assert.deepEqual(pdf.wrap(value, width, size, bold), previousWrap(value, width, size, bold), `${JSON.stringify(value.slice(0, 30))}, ${width}/${size}/${bold}`);
  }
  const nativeIterator = String.prototype[Symbol.iterator];
  let visits = 0;
  String.prototype[Symbol.iterator] = function* () {
    for (const value of nativeIterator.call(this)) { visits++; yield value; }
  };
  let lines;
  try { lines = pdf.wrap("W".repeat(1200), 210, 8, false); }
  finally { String.prototype[Symbol.iterator] = nativeIterator; }
  assert.equal(lines.join(""), "W".repeat(1200));
  assert.ok(lines.every((line) => pdf.width(line, 8, false) <= 210));
  assert.ok(visits < 500000, `long-token prefix measuring used ${visits} character visits, without the backwards scan's cubic work`);
});
