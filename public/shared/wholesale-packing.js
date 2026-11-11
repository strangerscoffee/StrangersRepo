// Wholesale packing, shared by Admin and the staff orders page: bags to process (250 g, 1 kg and all bags, by coffee
// and by coffee/size/grind) and printed packing sheets. Built with SC.el, so every value is text, never HTML. Printing
// uses the browser's own dialog (which can also save a PDF). No prices: these are for packing.
(() => {
  "use strict";
  const { el } = SC, { grindFor, coffeeStyle } = SCWholesalePreparation;
  const packOrder = ["quarter", "kilo", "half"];
  const packName = { quarter: "250 g", kilo: "1 kg", half: "500 g" };
  const london = (at) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(at));
  const kg = (grams) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(grams / 1000)} kg`;
  const bags = (n) => `${n} ${n === 1 ? "bag" : "bags"}`;

  function totals(orders) {
    const coffees = new Map(), packs = new Map(), sum = { quarter: 0, kilo: 0, half: 0, bags: 0, grams: 0 };
    for (const order of orders) for (const line of order.lines || []) {
      const key = line.productId || line.title, pack = packOrder.includes(line.pack) ? line.pack : "half";
      const coffee = coffees.get(key) || { line, title: line.title, quarter: 0, kilo: 0, half: 0, bags: 0, grams: 0 };
      coffee[pack] += line.quantity; coffee.bags += line.quantity; coffee.grams += line.grams * line.quantity; coffees.set(key, coffee);
      sum[pack] += line.quantity; sum.bags += line.quantity; sum.grams += line.grams * line.quantity;
      const grind = grindFor(line), packKey = `${key}|${pack}|${grind.key}|${line.grindLabel}`;
      const entry = packs.get(packKey) || { line, title: line.title, pack, grind: line.grindLabel || grind.label, hint: line.grindHint || "", decaf: !!line.decaf, bags: 0 };
      entry.bags += line.quantity; packs.set(packKey, entry);
    }
    const order = (a, b) => a.title.localeCompare(b.title, "en-GB") || packOrder.indexOf(a.pack) - packOrder.indexOf(b.pack) || String(a.grind).localeCompare(String(b.grind), "en-GB");
    return { coffees: [...coffees.values()].sort(order), packs: [...packs.values()].sort(order), sum, half: sum.half > 0 };
  }

  const swatch = (line) => el("span", { class: "w-coffee-swatch", style: coffeeStyle(line), "aria-hidden": "true" });
  const decafTag = (decaf) => decaf ? [" ", el("span", { class: "wp-tag" }, "Decaf")] : null;
  const grindCell = (label, hint) => el("td", {}, label || "", hint ? el("small", {}, hint) : null);
  const th = (text, attrs = { scope: "col" }) => el("th", attrs, text);

  function tiles(sum) {
    return el("div", { class: "wp-tiles" },
      el("div", { class: "wp-tile" }, el("span", {}, "250 g bags"), el("strong", {}, String(sum.quarter))),
      el("div", { class: "wp-tile" }, el("span", {}, "1 kg bags"), el("strong", {}, String(sum.kilo))),
      el("div", { class: "wp-tile wp-tile-total" }, el("span", {}, "All bags"), el("strong", {}, String(sum.bags)), el("small", {}, `${kg(sum.grams)} of coffee`)));
  }
  function tables(t) {
    const byCoffee = el("table", { class: "wp-table" }, el("caption", {}, "By coffee"),
      el("thead", {}, el("tr", {}, th("Coffee"), th("250 g bags"), th("1 kg bags"), t.half ? th("500 g bags") : null, th("All bags"), th("Weight"))),
      el("tbody", {}, ...t.coffees.map((c) => el("tr", {}, el("th", { scope: "row" }, swatch(c.line), c.title), el("td", {}, String(c.quarter || "–")), el("td", {}, String(c.kilo || "–")), t.half ? el("td", {}, String(c.half || "–")) : null, el("td", {}, el("b", {}, String(c.bags))), el("td", {}, kg(c.grams))))),
      el("tfoot", {}, el("tr", {}, el("th", { scope: "row" }, "Total"), el("td", {}, String(t.sum.quarter)), el("td", {}, String(t.sum.kilo)), t.half ? el("td", {}, String(t.sum.half)) : null, el("td", {}, el("b", {}, String(t.sum.bags))), el("td", {}, kg(t.sum.grams)))));
    const toPack = el("table", { class: "wp-table" }, el("caption", {}, "To pack: by coffee, size and grind"),
      el("thead", {}, el("tr", {}, th("Coffee"), th("Size"), th("Grind"), th("Bags"))),
      el("tbody", {}, ...t.packs.map((p) => el("tr", {}, el("th", { scope: "row" }, swatch(p.line), p.title, decafTag(p.decaf)), el("td", {}, packName[p.pack]), grindCell(p.grind, p.hint), el("td", {}, el("b", {}, String(p.bags)))))));
    return [byCoffee, toPack];
  }
  /** The bags to process for these orders, for a screen or a printed page. */
  function summaryBody(orders, label) {
    if (!orders.length) return el("div", { class: "wp-summary-body" }, el("p", { class: "wp-empty" }, `No ${label.toLowerCase()} to process.`));
    const t = totals(orders);
    return el("div", { class: "wp-summary-body" }, tiles(t.sum), el("p", { class: "wp-meta" }, `${orders.length} ${orders.length === 1 ? "order" : "orders"}: ${label.toLowerCase()}`), ...tables(t));
  }
  const head = (kicker, title, id, whenLabel, at) => el("header", { class: "wp-head" },
    el("div", {}, el("p", { class: "wp-kicker" }, kicker), el("h2", {}, title), el("p", { class: "wp-id" }, id)),
    el("div", { class: "wp-when" }, el("span", {}, whenLabel), el("b", {}, london(at))));
  const summaryPage = (orders, label, printedAt) => el("article", { class: "wp-page wp-summary" }, head("Strangers Coffee · Wholesale", "Bags to process", label, "Printed", printedAt), summaryBody(orders, label));

  /** One packing sheet per order. Works with Admin's order view and the staff orders page's. */
  function sheet(order) {
    const t = totals([order]);
    const place = order.locationSnapshot || order.customerSnapshot || { name: order.locationName, address: order.address, postcode: order.postcode, deliveryNotes: order.deliveryNotes };
    const address = [place.name && place.name !== "Main location" ? place.name : "", place.address, place.postcode].filter(Boolean).join("\n");
    const notes = place.deliveryNotes || order.deliveryNotes || "";
    const contact = [place.contact, place.phone].filter(Boolean).join(" · ");
    return el("article", { class: "wp-page wp-order" },
      head(`Wholesale order · ${order.status}`, order.business || order.customerSnapshot?.business || "Wholesale order", order.id, "Placed", order.createdAt),
      el("div", { class: "wp-details" },
        el("div", {}, el("h3", {}, order.delivery === "Delivery" ? "Delivery to" : "Collection"), el("p", { class: "wp-address" }, order.delivery === "Delivery" ? address || "No address saved" : "Roastery collection", notes ? [el("br"), el("small", {}, notes)] : null)),
        el("div", {}, contact ? [el("h3", {}, "Contact"), el("p", {}, contact)] : null, order.reference ? [el("h3", {}, "Reference"), el("p", {}, order.reference)] : null)),
      order.customerNote ? el("div", { class: "wp-note" }, el("h3", {}, "Customer comments"), el("p", {}, order.customerNote)) : null,
      order.note ? el("div", { class: "wp-note wp-internal" }, el("h3", {}, "Internal note"), el("p", {}, order.note)) : null,
      el("table", { class: "wp-table wp-lines" },
        el("thead", {}, el("tr", {}, el("th", { scope: "col", class: "wp-tick" }, el("span", { class: "sr-only" }, "Packed")), th("Bags"), th("Coffee"), th("Size"), th("Grind"))),
        el("tbody", {}, ...(order.lines || []).map((line) => el("tr", {}, el("td", { class: "wp-tick" }, el("span", { class: "wp-box", "aria-hidden": "true" })), el("td", {}, el("b", {}, String(line.quantity))), el("th", { scope: "row" }, swatch(line), line.title, decafTag(line.decaf)), el("td", {}, packName[line.pack] || line.packLabel || ""), grindCell(line.grindLabel, line.grindHint))))),
      el("p", { class: "wp-order-total" }, `${t.sum.quarter} × 250 g · ${t.sum.kilo} × 1 kg${t.half ? ` · ${t.sum.half} × 500 g` : ""} · `, el("b", {}, bags(t.sum.bags)), ` · ${kg(t.sum.grams)}`),
      el("footer", { class: "wp-sign" }, el("span", {}, "Packed by"), el("span", {}, "Checked by"), el("span", {}, "Date")));
  }

  /** Puts the pages in #wPrintArea (outside everything else) and opens the browser's print dialog. */
  function print(pages) {
    document.getElementById("wPrintArea")?.remove();
    const area = el("section", { id: "wPrintArea", class: "wp-print", "aria-hidden": "true" }, ...pages);
    document.body.append(area);
    const done = () => { area.remove(); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    window.print();
  }
  /** The summary page, then (unless onlyTotals) one packing sheet per order. */
  const printOrders = (orders, label, printedAt, { onlyTotals = false } = {}) => print([summaryPage(orders, label, printedAt), ...(onlyTotals ? [] : orders.map(sheet))]);

  window.SCWholesalePacking = Object.freeze({ totals, summaryBody, sheet, print, printOrders });
})();
