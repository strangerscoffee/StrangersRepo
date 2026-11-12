// Reads a QuickBooks sales report exported as CSV or Excel (.xlsx) into plain sales rows for Admin → Wholesale →
// Insights. Best with "Sales by Product/Service Detail" or "Sales by Customer Detail": it finds the header row (Date
// and Amount), follows the report's group rows (a product or customer name above its lines; "Total for …" rows are
// skipped), and keeps invoices, sales receipts, credit notes and refunds. Excel files are unzipped here with the
// browser's own DecompressionStream; nothing in the file is ever run or shown as HTML.
window.SCSalesImport = (() => {
  "use strict";
  const SALES = /^(invoice|sales receipt|credit note|credit memo|refund receipt|refund)$/i;
  const HEAD = {
    date: /^(transaction )?date$/i, type: /^(transaction )?type$/i, num: /^(num|no\.?|number|doc(ument)? ?(no\.?|number)?|invoice (no\.?|number)|ref(erence)?( no\.?)?)$/i,
    customer: /^(customer( full name| name)?|name|customer\/supplier)$/i, product: /^(product\/service( full name| name)?|product|item|item name)$/i,
    qty: /^(qty|quantity)$/i, amount: /^(amount|net amount|sales amount|amount \(gbp\)|line amount)$/i,
  };

  /* ---------- CSV ---------- */
  function csv(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
      if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ---------- XLSX (a zip of XML files): the first worksheet, with shared strings ---------- */
  async function unzip(buffer) {
    const view = new DataView(buffer), bytes = new Uint8Array(buffer), files = new Map();
    let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("That doesn't look like an Excel file. Export the report as CSV or Excel (.xlsx).");
    let p = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true), names = new TextDecoder();
    for (let n = 0; n < count && view.getUint32(p, true) === 0x02014b50; n++) {
      const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true), nameLen = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
      files.set(names.decode(bytes.subarray(p + 46, p + 46 + nameLen)), { method, size, local });
      p += 46 + nameLen + extra + comment;
    }
    return async (name) => {
      const f = files.get(name); if (!f) return null;
      const start = f.local + 30 + view.getUint16(f.local + 26, true) + view.getUint16(f.local + 28, true), data = bytes.subarray(start, start + f.size);
      if (f.method === 0) return new TextDecoder().decode(data);
      if (f.method !== 8) throw new Error("This Excel file uses a compression the site can't read. Export it as CSV instead.");
      return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    };
  }
  const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  async function xlsx(buffer) {
    const read = await unzip(buffer), xml = (text) => new DOMParser().parseFromString(text, "application/xml");
    const strings = [];
    const shared = await read("xl/sharedStrings.xml");
    if (shared) for (const si of xml(shared).getElementsByTagName("si")) strings.push([...si.getElementsByTagName("t")].map((t) => t.textContent).join(""));
    let sheetPath = "xl/worksheets/sheet1.xml";
    const book = await read("xl/workbook.xml"), rels = await read("xl/_rels/workbook.xml.rels");
    if (book && rels) {
      const first = xml(book).getElementsByTagName("sheet")[0], rid = first?.getAttribute("r:id") || first?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const target = [...xml(rels).getElementsByTagName("Relationship")].find((r) => r.getAttribute("Id") === rid)?.getAttribute("Target");
      if (target) sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.?\//, "");
    }
    const sheet = await read(sheetPath);
    if (!sheet) throw new Error("Couldn't find a worksheet in that Excel file.");
    const rows = [];
    for (const r of xml(sheet).getElementsByTagName("row")) {
      const row = [];
      for (const c of r.getElementsByTagName("c")) {
        const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        row[colIndex(c.getAttribute("r") || "A")] = t === "s" ? strings[Number(v)] ?? "" : t === "inlineStr" ? [...c.getElementsByTagName("t")].map((x) => x.textContent).join("") : v;
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    return rows;
  }

  /* ---------- values ---------- */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const iso = (y, m, d) => { if (y < 100) y += 2000; const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; const t = Date.parse(s + "T12:00:00Z"); return t && new Date(t).toISOString().slice(0, 10) === s ? s : null; };
  function date(value) {
    const v = String(value).trim(); let m;
    if (/^\d{5}(\.\d+)?$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 864e5).toISOString().slice(0, 10); // Excel serial
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) return iso(+m[3], +m[2], +m[1]); // UK: day first
    if ((m = v.match(/^(\d{1,2})[ -]([a-z]{3})[a-z]*[ -,]+(\d{2,4})$/i)) && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    return null;
  }
  function number(value) {
    let v = String(value).trim().replace(/[£,\s]/g, ""); if (!v || v === "-") return null;
    const negative = /^\(.*\)$/.test(v) || v.startsWith("-"); v = v.replace(/[()-]/g, "");
    const n = Number(v); return Number.isFinite(n) ? (negative ? -n : n) : null;
  }

  /** The report's rows → sales rows: {date, type, num, customer, product, qty, pence, n}. */
  function rowsFrom(table) {
    const headAt = table.findIndex((r, i) => i < 40 && r.some((c) => HEAD.date.test(String(c).trim())) && r.some((c) => HEAD.amount.test(String(c).trim())));
    if (headAt < 0) throw new Error("Couldn't find the report's columns. Use a QuickBooks report with Date and Amount columns, such as Sales by Product/Service Detail.");
    const head = table[headAt].map((c) => String(c).trim()), col = {};
    for (const [key, re] of Object.entries(HEAD)) col[key] = head.findIndex((h) => re.test(h));
    if (col.product < 0 && col.customer < 0) col.groupIs = "product";
    const out = [], counts = new Map(); let group = "", skipped = 0;
    for (const r of table.slice(headAt + 1)) {
      const cell = (i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
      const first = r.map((c) => String(c ?? "").trim()).find(Boolean) || "";
      const d = cell(col.date), day = d ? date(d) : null, filled = r.filter((c) => String(c ?? "").trim()).length;
      // A group row (the product or customer the next lines belong to) has one filled cell and no date; in some
      // reports it sits in the Date column itself. "Total for …" rows and the report's footer are skipped.
      if (!day) { if (filled === 1 && !/^total/i.test(first)) group = first; else if (filled > 1 && !/^total/i.test(first)) skipped++; continue; }
      const type = cell(col.type) || "Invoice";
      if (!SALES.test(type)) { skipped++; continue; }
      const product = cell(col.product) || (col.product < 0 ? group : ""), customer = cell(col.customer) || (col.customer < 0 && col.product >= 0 ? group : "");
      const amount = number(cell(col.amount)), qty = number(cell(col.qty)) ?? 0;
      if (!product || amount === null) { skipped++; continue; }
      let pence = Math.round(amount * 100), q = qty;
      if (/credit|refund/i.test(type)) { pence = -Math.abs(pence); q = -Math.abs(q); }
      const row = { date: day, type: type.replace(/\s+/g, " "), num: cell(col.num).slice(0, 40), customer: (customer || "Unknown").slice(0, 200), product: product.slice(0, 200), qty: q, pence };
      const key = JSON.stringify(row), n = (counts.get(key) || 0) + 1; counts.set(key, n);
      out.push({ ...row, n });
    }
    return { rows: out, skipped, columns: Object.fromEntries(Object.entries(col).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, v >= 0 ? head[v] : null])) };
  }

  async function parseFile(file) {
    if (file.size > 25 * 1024 * 1024) throw new Error("That file is over 25 MB. Export a shorter date range and import it in parts.");
    const isXlsx = /\.xlsx$/i.test(file.name) || /spreadsheetml/.test(file.type);
    if (/\.xls$/i.test(file.name)) throw new Error("Old .xls files can't be read here. Export the report as CSV or Excel (.xlsx).");
    const table = isXlsx ? await xlsx(await file.arrayBuffer()) : csv(await file.text());
    return { fileName: file.name, ...rowsFrom(table) };
  }
  return Object.freeze({ parseFile, rowsFrom, csv });
})();
