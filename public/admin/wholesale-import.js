// Reads the customer list exported from QuickBooks (Sales → Customers → Export, or the Customer Contact List report;
// CSV or Excel) into plain business rows for Admin → Wholesale → Customers → Import from QuickBooks
// (src/wholesaleImport.ts). It finds the header row, takes the company name (or the customer name), contact, email,
// phone and the delivery address (shipping if given, else billing) with its UK postcode. Nothing in the file is run or
// shown as HTML.
window.SCCustomerImport = (() => {
  "use strict";
  const H = {
    name: /^(customer|name|customer name|customer full name|display name( as)?)$/i,
    company: /^(company|company name|business( name)?)$/i,
    email: /^(e-?mail( address)?|main email)$/i,
    phone: /^(phone|phone numbers?|telephone|main phone|work phone)$/i,
    mobile: /^(mobile|mobile phone|cell)$/i,
    contact: /^(full name|contact( name)?|primary contact)$/i,
    first: /^(first name|given name)$/i, last: /^(last name|family name|surname)$/i,
    bill: /^(billing address|bill(ing)? to|address|street address|billing street|billing address line 1|address line 1)$/i,
    bill2: /^(billing address line 2|address line 2)$/i,
    city: /^(city|town|billing city|town\/city)$/i, county: /^(county|state|county\/state|billing state|region)$/i,
    postcode: /^(post ?code|postal code|zip|zip code|billing (zip|post ?code)|post code\/zip)$/i,
    ship: /^(shipping address|ship(ping)? to|delivery address|shipping street|shipping address line 1)$/i,
    shipCity: /^(shipping city)$/i, shipPostcode: /^(shipping (zip|post ?code))$/i,
  };
  const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
  const tidy = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  function rowsFrom(table) {
    const headAt = table.findIndex((r, i) => i < 40 && r.some((c) => H.name.test(tidy(c)) || H.company.test(tidy(c))) && r.some((c) => H.email.test(tidy(c)) || H.phone.test(tidy(c)) || H.bill.test(tidy(c))));
    if (headAt < 0) throw new Error("Couldn't find the customer columns. Export the customer list from QuickBooks (Sales → Customers → Export to Excel) and try again.");
    const head = table[headAt].map(tidy), col = {};
    for (const [k, re] of Object.entries(H)) col[k] = head.findIndex((h) => re.test(h));
    const out = [], seen = new Set();
    for (const r of table.slice(headAt + 1)) {
      const cell = (k) => (col[k] >= 0 ? String(r[col[k]] ?? "").trim() : "");
      const qbName = tidy(cell("name")), business = tidy(cell("company")) || qbName;
      if (!business || /^total/i.test(business)) continue;
      const key = (qbName || business).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const join = (...parts) => parts.map((p) => String(p || "").replace(/\r/g, "").split("\n").map(tidy).filter(Boolean).join(", ")).filter(Boolean).join(", ");
      let address = cell("ship") ? join(cell("ship"), cell("shipCity")) : join(cell("bill"), cell("bill2"), cell("city"), cell("county"));
      let postcode = tidy(cell("shipPostcode") || (cell("ship") ? "" : cell("postcode")));
      const found = address.match(POSTCODE);
      if (!postcode && found) postcode = `${found[1]} ${found[2]}`.toUpperCase();
      if (postcode) address = address.replace(new RegExp(`,?\\s*${postcode.replace(/\s+/g, "\\s*")}\\b`, "i"), "").replace(/,\s*(UK|United Kingdom|GB)$/i, "").trim();
      const email = (cell("email").split(/[\s,;]+/).find((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) || "").toLowerCase();
      const contact = tidy(cell("contact") || [cell("first"), cell("last")].filter(Boolean).join(" "));
      const phone = tidy(cell("phone") || cell("mobile")).replace(/^(phone|mobile|tel)\s*:\s*/i, "").slice(0, 40);
      // For Accounts emails: the company name exactly as written (spaces tidied) and every address in the email cell.
      const company = tidy(cell("company")).slice(0, 200), emails = [...new Set(cell("email").split(/[\s,;]+/).map((e) => e.toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 10);
      out.push({ company, emails, business: business.slice(0, 120), quickbooksName: (qbName || business).slice(0, 200), contact: contact.slice(0, 120), email, phone, address: address.slice(0, 500), postcode: postcode.toUpperCase().slice(0, 20) });
    }
    return out;
  }
  async function parseFile(file) {
    const table = await window.SCSalesImport.readTable(file);
    const rows = rowsFrom(table);
    if (!rows.length) throw new Error("No customers found in that file.");
    return { fileName: file.name, rows };
  }
  return Object.freeze({ parseFile, rowsFrom });
})();
