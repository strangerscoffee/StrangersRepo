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
  // What a white-label coffee or blend is made from (snapshotted on the order line: "60% Campo Santo · 40% Bom Jesus").
  const recipeOf = (line) => line.recipe ? el("small", { class: "wp-recipe" }, `Made from ${line.recipe}`) : null;
  const parts = (recipe) => String(recipe || "").split(" · ").map((part) => /^(\d{1,3})% (.+)$/.exec(part)).filter(Boolean).map((m) => ({ percent: Number(m[1]), name: m[2] }));
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
      el("tbody", {}, ...t.coffees.map((c) => el("tr", {}, el("th", { scope: "row" }, swatch(c.line), c.title, recipeOf(c.line)), el("td", {}, String(c.quarter || "–")), el("td", {}, String(c.kilo || "–")), t.half ? el("td", {}, String(c.half || "–")) : null, el("td", {}, el("b", {}, String(c.bags))), el("td", {}, kg(c.grams))))),
      el("tfoot", {}, el("tr", {}, el("th", { scope: "row" }, "Total"), el("td", {}, String(t.sum.quarter)), el("td", {}, String(t.sum.kilo)), t.half ? el("td", {}, String(t.sum.half)) : null, el("td", {}, el("b", {}, String(t.sum.bags))), el("td", {}, kg(t.sum.grams)))));
    const toPack = el("table", { class: "wp-table" }, el("caption", {}, "To pack: by coffee, size and grind"),
      el("thead", {}, el("tr", {}, th("Coffee"), th("Size"), th("Grind"), th("Bags"))),
      el("tbody", {}, ...t.packs.map((p) => el("tr", {}, el("th", { scope: "row" }, swatch(p.line), p.title, decafTag(p.decaf), recipeOf(p.line)), el("td", {}, packName[p.pack]), grindCell(p.grind, p.hint), el("td", {}, el("b", {}, String(p.bags)))))));
    // Blends and white labels: how much of each coffee goes into them.
    const needed = new Map();
    for (const c of t.coffees) for (const part of parts(c.line.recipe)) needed.set(part.name, (needed.get(part.name) || 0) + c.grams * part.percent / 100);
    const madeFrom = needed.size ? el("table", { class: "wp-table" }, el("caption", {}, "Coffee for blends and white labels"),
      el("thead", {}, el("tr", {}, th("Coffee"), th("Weight"))),
      el("tbody", {}, ...[...needed].sort((a, b) => b[1] - a[1]).map(([name, grams]) => el("tr", {}, el("th", { scope: "row" }, name), el("td", {}, kg(Math.round(grams))))))) : null;
    return [byCoffee, toPack, madeFrom];
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
        el("tbody", {}, ...(order.lines || []).map((line) => el("tr", {}, el("td", { class: "wp-tick" }, el("span", { class: "wp-box", "aria-hidden": "true" })), el("td", {}, el("b", {}, String(line.quantity))), el("th", { scope: "row" }, swatch(line), line.title, decafTag(line.decaf), recipeOf(line)), el("td", {}, packName[line.pack] || line.packLabel || ""), grindCell(line.grindLabel, line.grindHint))))),
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

  const stages = ["New", "Preparing", "Ready", "Dispatched"];
  function stageTrack(status) {
    const current = stages.indexOf(status);
    if (current < 0) return null;
    return el("ol", { class: "wp-stages", "aria-label": "Fulfilment stages" },
      ...stages.map((stage, index) => el("li", {
        class: index < current ? "done" : "",
        ...(index === current ? { "aria-current": "step" } : {})
      }, index === 0 ? "Received" : stage)));
  }

  // Instant ticks (the owner's report, 26 Nov 2026: ticks took seconds to show). A tick shows at once; the ticks wanted
  // for each order are saved in the background as one set, one request at a time, each against the version the last
  // one returned, so quick ticks are merged into the next save instead of waiting for each other. A refused save puts
  // the order back as the server has it and shows the problem.
  function packQueue({ get, send, saved, failed, redraw }) {
    const wanted = new Map(), running = new Map();
    const same = (a, b) => [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
    async function pump(id) {
      try {
        for (;;) {
          const order = get(id), lines = wanted.get(id);
          if (!order || !lines || order.status !== "Preparing" || same(lines, order.packedLines || [])) { wanted.delete(id); return; }
          const sent = [...lines].sort((a, b) => a - b);
          const result = await send(order, sent);
          if (!result || result.id !== id || !Number.isSafeInteger(result.version) || result.version < order.version || !same(result.packedLines || [], sent)) throw new Error("The packing update could not be confirmed.");
          saved(result);
        }
      } catch (error) {
        wanted.delete(id);
        if (!error?.quiet) failed(id, error);
      } finally { running.delete(id); redraw(id); }
    }
    return {
      /** The order as it should look now: saved ticks plus any still being saved. */
      view(order) { const lines = wanted.get(order.id); return lines ? { ...order, packedLines: [...lines] } : order; },
      saving: (id) => running.has(id) || wanted.has(id),
      set(order, lines) {
        wanted.set(order.id, new Set(lines)); redraw(order.id);
        if (!running.has(order.id)) running.set(order.id, pump(order.id));
      },
      tick(order, line, packed) { const lines = new Set(this.view(order).packedLines || []); packed ? lines.add(line) : lines.delete(line); this.set(order, lines); },
      /** Waits for every tick on this order to be saved; true when they were. */
      async settle(id) { while (running.has(id)) await running.get(id); return !wanted.has(id); },
      forget(id) { wanted.delete(id); }
    };
  }

  const BACK = { Preparing: "New", Ready: "Preparing", Dispatched: "Ready" };
  const stageName = (status) => status === "New" ? "Received" : status;

  function checklist(order, { change, all, advance, back, refresh, busy = false, saving = false, problem = "" }) {
    const checked = new Set(order.packedLines || []);
    const finished = order.status === "Ready" || order.status === "Dispatched";
    const packed = order.lines.reduce((sum, line, i) => sum + (finished || checked.has(i) ? line.quantity : 0), 0);
    const allPacked = order.lines.length > 0 && order.lines.every((_, i) => checked.has(i));
    const next = { New: "Start preparing", Preparing: "Mark ready", Ready: order.delivery === "Delivery" ? "Review dispatch" : "Review collection" }[order.status];
    const previous = BACK[order.status], packing = order.status === "Preparing";
    return el("div", { class: "wp-checklist", "aria-busy": String(busy) },
      el("div", { class: "wp-check-head" }, el("h3", {}, "Pack by coffee"), el("small", {}, `${order.lines.length} ${order.lines.length === 1 ? "line" : "lines"}`)),
      packing && all && order.lines.length > 1 ? el("button", { type: "button", class: "btn soft sm wp-check-all", "data-pack-all": "", disabled: busy || !!problem || allPacked,
        onclick: () => all(order.lines.map((_, i) => i)) }, allPacked ? "All coffees bagged" : "Mark all coffees as bagged") : null,
      el("ul", { class: "wp-check-lines" }, ...order.lines.map((line, i) => {
        const grind = grindFor(line), done = finished || checked.has(i);
        return el("li", {}, el("label", { class: "wp-check-line", style: coffeeStyle(line) },
          el("input", { type: "checkbox", checked: done, disabled: busy || !!problem || !packing, "data-pack-line": i,
            "aria-label": `Pack ${bags(line.quantity)} of ${line.title}, ${line.packLabel}, ${grind.label}`, onchange: event => change(i, event.target.checked) }),
          el("span", { class: "wp-check-product" }, el("b", {}, line.title, decafTag(!!line.decaf)),
            el("small", {}, `${line.packLabel} · ${grind.label}${done ? " · Packed" : ""}`), recipeOf(line)),
          el("strong", { class: "wp-check-qty" }, "× ", String(line.quantity))));
      })),
      el("div", { class: "wp-check-foot" },
        el("div", { class: "wp-progress" }, el("p", {}, el("b", {}, `${packed} of ${order.packs}`), " bags packed", saving ? el("span", { class: "wp-saving" }, " · Saving…") : null),
          el("progress", { "aria-label": "Bags packed", max: Math.max(order.packs || 0, 1), value: packed })),
        next ? el("button", { type: "button", class: "btn sm", "data-pack-next": "", disabled: busy || !!problem || (packing && !allPacked), onclick: advance }, busy ? "Saving…" : next) : null),
      previous && back ? el("div", { class: "wp-check-back" },
        el("button", { type: "button", class: "btn soft sm", "data-pack-back": "", disabled: busy || !!problem, onclick: () => back(previous) }, `Back to ${stageName(previous)}`),
        el("small", {}, { Preparing: "Started by mistake? Moves it back to Received and clears the ticks.", Ready: "Moves it back to Preparing; the ticks are kept.", Dispatched: "Not gone yet? Moves it back to Ready. The customer has already been emailed." }[order.status])) : null,
      problem ? el("div", { class: "wp-pack-problem", role: "alert" }, el("p", {}, problem),
        el("button", { type: "button", class: "btn soft sm", onclick: refresh }, "Reload order")) : null);
  }

  /** Asks before moving an order back a stage, saying what happens. */
  function confirmBack(order, to) {
    const name = order.business || "this order";
    if (to === "New") return !(order.packedLines || []).length || confirm(`Move ${name} back to Received? The ${order.packedLines.length === 1 ? "tick" : "ticks"} on its coffees will be cleared.`);
    if (to === "Ready" && order.status === "Dispatched") return confirm(`Move ${name} back to Ready? The customer has already been emailed that it's ${order.delivery === "Delivery" ? "shipped" : "collected"}, and any invoice already made stays as it is.`);
    return true;
  }

  window.SCWholesalePacking = Object.freeze({ totals, summaryBody, sheet, print, printOrders, stageTrack, checklist, packQueue, confirmBack, BACK });
})();
