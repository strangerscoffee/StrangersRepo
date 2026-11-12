// Admin → Wholesale → Insights: sales and volumes over time, by coffee and by customer, the forecast for the coming
// weeks and next week's roast plan, from the site's customer orders plus QuickBooks history imported from a report
// (src/insights.ts, src/insightsMath.ts). Charts are plain HTML bars (one hue; the forecast hatched), each with a
// table beside it; every value is escaped by the admin `html` template.
window.WholesaleInsights = function ({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast }) {
  const root = "/api/admin/wholesale/insights";
  const $ = (s) => document.querySelector(s);
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: Math.abs(pence) >= 100000 ? 0 : 2 }).format(pence / 100);
  const kgNum = (grams, digits = 1) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(grams / 1000);
  const kg = (grams, digits = 1) => `${kgNum(grams, digits)} kg`;
  const n = (v) => new Intl.NumberFormat("en-GB").format(Math.round(v));
  const day = (iso, opts = { day: "numeric", month: "short" }) => iso ? new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z")) : "–";
  const longDay = (iso) => day(iso, { day: "numeric", month: "short", year: "numeric" });
  const month = (iso) => day(iso, { month: "short", year: "2-digit" });
  const PERIODS = [["4", "4 weeks"], ["13", "3 months"], ["52", "12 months"], ["all", "All"]];
  let period = "13", measure = "pence", data = null, stock = {}, loadedAt = 0;
  // Switching period or £/kg redraws from what's loaded; anything older than a minute, or changed here, loads afresh.
  async function load(force) { if (force || !data || Date.now() - loadedAt > 60000) { data = await api("GET", root); loadedAt = Date.now(); } return data; }
  const refresh = async () => { loadedAt = 0; await reload(); };

  /* ---------- the selected period ---------- */
  function slice() {
    const weeks = data.weekly, count = period === "all" ? weeks.length : Math.min(weeks.length, Number(period));
    const now = weeks.slice(weeks.length - count), before = period === "all" ? [] : weeks.slice(Math.max(0, weeks.length - 2 * count), weeks.length - count);
    return { now, before, comparable: before.length === count };
  }
  const sum = (rows, key) => rows.reduce((t, r) => t + r[key], 0);
  function change(now, before, ok) {
    if (!ok || !before) return html`<span class="s">${ok ? "nothing in the period before" : period === "all" ? "since the first sale" : "not enough history to compare"}</span>`;
    const p = Math.round(((now - before) / before) * 100);
    return html`<span class="s ins-change ${p > 0 ? "up" : p < 0 ? "down" : ""}">${p > 0 ? "▲ " : p < 0 ? "▼ " : ""}${Math.abs(p)}% on the ${PERIODS.find(([v]) => v === period)[1]} before</span>`;
  }
  function tiles({ now, before, comparable }) {
    const customers = new Set(); // customers ordering in the period: counted from the customer list's last orders
    const from = now[0]?.week;
    for (const c of data.customers) if (from && c.last >= from) customers.add(c.name);
    const t = (label, value, sub) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span>${sub}</div>`;
    return html`<div class="stats ins-tiles" role="group" aria-label="This period at a glance">
      ${t("Sales", money(sum(now, "pence")), change(sum(now, "pence"), sum(before, "pence"), comparable))}
      ${t("Coffee", kg(sum(now, "grams"), 0), change(sum(now, "grams"), sum(before, "grams"), comparable))}
      ${t("Bags", n(sum(now, "bags")), html`<span class="s">${n(sum(now, "quarter"))} × 250 g · ${n(sum(now, "kilo"))} × 1 kg${sum(now, "other") ? ` · ${n(sum(now, "other"))} other` : ""}</span>`)}
      ${t("Orders", n(sum(now, "orders")), html`<span class="s">${customers.size} ${customers.size === 1 ? "customer" : "customers"} ordered</span>`)}</div>`;
  }

  /* ---------- bar chart: weekly up to 6 months, monthly beyond ---------- */
  function buckets(weeks) {
    if (weeks.length <= 26) return weeks.map((w) => ({ label: day(w.week), tip: `Week of ${longDay(w.week)}`, pence: w.pence, grams: w.grams }));
    const by = new Map();
    for (const w of weeks) { const k = w.week.slice(0, 7), b = by.get(k) || { label: month(k + "-01"), tip: day(k + "-01", { month: "long", year: "numeric" }), pence: 0, grams: 0 }; b.pence += w.pence; b.grams += w.grams; by.set(k, b); }
    return [...by.values()];
  }
  const nice = (max) => { if (max <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  function bars(points, fmt, label, forecast = []) {
    const all = [...points.map((p) => p.value), ...forecast.map((p) => p.high)], top = nice(Math.max(...all, 0));
    const every = Math.ceil((points.length + forecast.length) / 8);
    const col = (p, i, kind) => html`<div class="ins-col ${kind}" title="${p.tip}: ${fmt(p.value)}${kind === "fc" ? ` (likely ${fmt(p.low)}–${fmt(p.high)})` : ""}">
      ${kind === "fc" ? html`<span class="ins-range" style="bottom:${(p.low / top) * 100}%;height:${((p.high - p.low) / top) * 100}%"></span>` : ""}
      <span class="ins-bar" style="height:${Math.max(p.value > 0 ? 1.5 : 0, (p.value / top) * 100)}%"></span>
      <span class="ins-x ${i % every ? "hide" : ""}">${p.label}</span></div>`;
    return html`<figure class="ins-chart" aria-label="${label}"><div class="ins-plot">
      ${[1, 0.5].map((f) => html`<div class="ins-grid" style="bottom:${f * 100}%"><span>${fmt(top * f)}</span></div>`)}<div class="ins-grid base" style="bottom:0"><span>0</span></div>
      <div class="ins-cols">${points.map((p, i) => col(p, i, ""))}${forecast.map((p, i) => col(p, points.length + i, "fc"))}</div></div>
      ${forecast.length ? html`<figcaption class="ins-key"><span class="ins-swatch"></span>Sold<span class="ins-swatch fc"></span>Forecast, with its likely range</figcaption>` : ""}</figure>`;
  }
  function overTime({ now }) {
    const pts = buckets(now).map((b) => ({ ...b, value: measure === "pence" ? b.pence : b.grams }));
    const fmt = measure === "pence" ? money : (g) => kg(g, 0);
    return html`<section class="ins-section glass" aria-labelledby="insTime"><header class="ins-head"><h3 id="insTime">${measure === "pence" ? "Sales" : "Coffee sold"} ${now.length <= 26 ? "by week" : "by month"}</h3>
      <div class="seg" role="group" aria-label="Show">${[["pence", "£ sales"], ["grams", "kg coffee"]].map(([v, l]) => html`<button type="button" data-act="wh-ins-measure" data-id="${v}" aria-pressed="${measure === v}">${l}</button>`)}</div></header>
      ${now.length ? bars(pts, fmt, `${measure === "pence" ? "Sales" : "Coffee sold"} over the period`) : html`<p class="hint">No sales in this period.</p>`}</section>`;
  }

  /* ---------- forecast ---------- */
  function forecast() {
    const f = data.forecast, recent = data.weekly.filter((w) => w.week < data.thisWeek).slice(-12);
    if (!recent.length || f.total.basis === "none") return html`<section class="ins-section glass"><h3>Forecast</h3><p class="hint">The forecast starts once there's at least a week of sales.</p></section>`;
    const pts = recent.map((w) => ({ label: day(w.week), tip: `Week of ${longDay(w.week)}`, value: w.grams }));
    const fc = f.total.weeks.map((p) => ({ label: day(p.week), tip: `Week of ${longDay(p.week)} (forecast)`, value: p.grams, low: p.low, high: p.high }));
    const head4 = f.total.weeks.slice(0, 4);
    return html`<section class="ins-section glass" aria-labelledby="insFc"><header class="ins-head"><h3 id="insFc">Forecast: coffee for the next ${f.total.weeks.length} weeks</h3></header>
      <p class="hint">${f.total.basis === "seasonal" ? "From recent weeks, the trend and last year's pattern for the same weeks." : "From recent weeks and the trend. Last year's pattern (Christmas, summer) joins in once there's over a year of history."} An estimate: the shaded range is where most weeks land.</p>
      ${bars(pts, (g) => kg(g, 0), "Coffee sold in recent weeks and forecast for the coming weeks", fc)}
      <div class="ins-table-wrap"><table class="ins-table"><caption class="sr-only">Forecast by coffee, kg</caption><thead><tr><th scope="col">Coffee</th>${head4.map((p) => html`<th scope="col" class="num">w/c ${day(p.week)}</th>`)}<th scope="col" class="num">Recent weekly</th></tr></thead>
      <tbody>${f.byCoffee.map((c) => html`<tr><th scope="row">${swatch(c.key, c.title)}${c.title}</th>${c.weeks.slice(0, 4).map((p) => html`<td class="num" title="Likely ${kg(p.low)}–${kg(p.high)}">${kgNum(p.grams)}</td>`)}<td class="num muted">${kgNum(c.recentWeekly)}</td></tr>`)}</tbody>
      <tfoot><tr><th scope="row">All coffee</th>${head4.map((p) => html`<td class="num"><b>${kgNum(p.grams)}</b></td>`)}<td class="num muted">${kgNum(f.total.recentWeekly)}</td></tr></tfoot></table></div></section>`;
  }
  const swatch = (key, title) => { const style = window.SCWholesalePreparation?.coffeeStyle?.({ productId: key, title }); return style ? html`<span class="w-coffee-swatch ins-sw" style="${style}" aria-hidden="true"></span>` : ""; };

  /* ---------- roast plan ---------- */
  function roastRow(r) {
    const have = Math.max(0, Number(stock[r.key]) || 0) * 1000, need = Math.max(0, r.neededGrams - have), y = data.roast.yieldKg * 1000;
    const batches = Math.ceil(need / y - 1e-9);
    return { ...r, have, need, batches, green: batches * data.roast.batchKg, roasted: batches * data.roast.yieldKg };
  }
  function roast() {
    const rows = data.roast.rows.map(roastRow), totalBatches = rows.reduce((t, r) => t + r.batches, 0), green = rows.reduce((t, r) => t + r.green, 0);
    return html`<section class="ins-section glass ins-roast" aria-labelledby="insRoast"><header class="ins-head"><h3 id="insRoast">Roast plan · week of ${longDay(data.roast.week)}</h3>
      <div class="row"><button class="btn sm soft" type="button" data-act="wh-ins-batch">${svg("pen")}${data.roast.batchKg} kg batches → ${data.roast.yieldKg} kg</button><button class="btn sm soft" type="button" data-act="wh-ins-print-roast" ${rows.length ? "" : raw("disabled")}>${svg("doc")}Print</button></div></header>
      <p class="hint">Coffee already ordered but not yet packed, plus next week's forecast, in whole batches. Add roasted coffee already in stock to take it off.</p>
      ${rows.length ? html`<div class="ins-table-wrap"><table class="ins-table" id="insRoastTable"><thead><tr><th scope="col">Coffee</th><th scope="col" class="num">Ordered, not packed</th><th scope="col" class="num">Expected next week</th><th scope="col" class="num">In stock (kg)</th><th scope="col" class="num">Batches</th><th scope="col" class="num">Green coffee</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-roast="${r.key}"><th scope="row">${swatch(r.key, r.title)}${r.title}</th><td class="num">${kg(r.openGrams)}</td><td class="num">${kg(r.forecastGrams)}</td>
          <td class="num"><input class="ins-stock" type="number" inputmode="decimal" min="0" step="0.5" value="${stock[r.key] || ""}" placeholder="0" data-ins-stock="${r.key}" aria-label="Roasted ${r.title} in stock, kg"></td>
          <td class="num"><b data-batches>${r.batches}</b></td><td class="num" data-green>${r.green} kg</td></tr>`)}</tbody>
        <tfoot><tr><th scope="row">Total</th><td class="num">${kg(rows.reduce((t, r) => t + r.openGrams, 0))}</td><td class="num">${kg(rows.reduce((t, r) => t + r.forecastGrams, 0))}</td><td></td><td class="num"><b id="insBatches">${totalBatches}</b></td><td class="num" id="insGreen">${green} kg</td></tr></tfoot></table></div>`
        : html`<p class="hint">Nothing ordered or expected next week yet.</p>`}</section>`;
  }
  function updateRoast(key, value) {
    stock[key] = value;
    const rows = data.roast.rows.map(roastRow), r = rows.find((x) => x.key === key), tr = document.querySelector(`[data-roast="${CSS.escape(key)}"]`);
    if (tr && r) { tr.querySelector("[data-batches]").textContent = String(r.batches); tr.querySelector("[data-green]").textContent = `${r.green} kg`; }
    const b = $("#insBatches"), g = $("#insGreen");
    if (b) b.textContent = String(rows.reduce((t, x) => t + x.batches, 0));
    if (g) g.textContent = `${rows.reduce((t, x) => t + x.green, 0)} kg`;
  }
  document.addEventListener("input", (e) => { const t = e.target; if (t?.dataset?.insStock !== undefined && data) updateRoast(t.dataset.insStock, t.value); });
  function printRoast() {
    const { el } = SC, rows = data.roast.rows.map(roastRow).filter((r) => r.batches > 0);
    const page = el("article", { class: "wp-page" },
      el("header", { class: "wp-head" }, el("div", {}, el("p", { class: "wp-kicker" }, "Strangers Coffee · Roast plan"), el("h2", {}, `Week of ${longDay(data.roast.week)}`), el("p", { class: "wp-id" }, `${data.roast.batchKg} kg batches, about ${data.roast.yieldKg} kg roasted each`)),
        el("div", { class: "wp-when" }, el("span", {}, "Printed"), el("b", {}, new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date())))),
      el("table", { class: "wp-table" },
        el("thead", {}, el("tr", {}, ...["Coffee", "Ordered, not packed", "Expected", "In stock", "Batches", "Green coffee", "Done"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, ...rows.map((r) => el("tr", {}, el("th", { scope: "row" }, r.title), el("td", {}, kg(r.openGrams)), el("td", {}, kg(r.forecastGrams)), el("td", {}, r.have ? kg(r.have) : "–"), el("td", {}, el("b", {}, String(r.batches))), el("td", {}, `${r.green} kg`), el("td", { class: "wp-tick" }, el("span", { class: "wp-box" }))))),
        el("tfoot", {}, el("tr", {}, el("th", { scope: "row" }, "Total"), el("td"), el("td"), el("td"), el("td", {}, el("b", {}, String(rows.reduce((t, r) => t + r.batches, 0)))), el("td", {}, `${rows.reduce((t, r) => t + r.green, 0)} kg`), el("td")))));
    SCWholesalePacking.print([page]);
  }

  /* ---------- by coffee and by customer ---------- */
  function byCoffee({ now, before, comparable }) {
    const add = (rows) => { const m = new Map(); for (const w of rows) for (const [k, v] of Object.entries(w.byCoffee)) { const e = m.get(k) || [0, 0, 0, 0]; v.forEach((x, i) => (e[i] += x)); m.set(k, e); } return m; };
    const cur = add(now), prev = add(before), total = [...cur.values()].reduce((t, v) => t + v[0], 0) || 1;
    const title = (k) => data.coffees.find((c) => c.key === k)?.title || k;
    const rows = [...cur.entries()].sort((a, b) => b[1][0] - a[1][0]);
    return html`<section class="ins-section glass" aria-labelledby="insCoffee"><header class="ins-head"><h3 id="insCoffee">By coffee</h3></header>
      ${rows.length ? html`<div class="ins-table-wrap"><table class="ins-table"><thead><tr><th scope="col">Coffee</th><th scope="col" class="num">Weight</th><th scope="col" class="num">250 g bags</th><th scope="col" class="num">1 kg bags</th><th scope="col" class="num">Sales</th><th scope="col" class="num">Share</th>${comparable ? html`<th scope="col" class="num">Change</th>` : ""}</tr></thead>
        <tbody>${rows.map(([k, v]) => { const p = prev.get(k)?.[0] || 0, c = p ? Math.round(((v[0] - p) / p) * 100) : null;
          return html`<tr><th scope="row">${swatch(k, title(k))}${title(k)}</th><td class="num">${kg(v[0])}</td><td class="num">${n(v[2])}</td><td class="num">${n(v[3])}</td><td class="num">${money(v[1])}</td>
            <td class="num"><span class="ins-share"><span style="width:${(v[0] / total) * 100}%"></span></span>${Math.round((v[0] / total) * 100)}%</td>${comparable ? html`<td class="num ins-change ${c > 0 ? "up" : c < 0 ? "down" : ""}">${c === null ? "new" : `${c > 0 ? "▲" : c < 0 ? "▼" : ""} ${Math.abs(c)}%`}</td>` : ""}</tr>`; })}</tbody></table></div>`
        : html`<p class="hint">No coffee sold in this period.</p>`}</section>`;
  }
  const STATUS = { due: ["Due now", "warn"], overdue: ["Overdue", "bad"], quiet: ["Gone quiet", "bad"], ok: ["On track", "ok"], new: ["New", ""] };
  function customers() {
    const rows = data.customers;
    return html`<section class="ins-section glass" aria-labelledby="insCust"><header class="ins-head"><h3 id="insCust">Customers</h3></header>
      <p class="hint">Each customer's usual gap between orders, and whether they're due. "Gone quiet" means well past their usual order.</p>
      ${rows.length ? html`<div class="ins-table-wrap"><table class="ins-table"><thead><tr><th scope="col">Customer</th><th scope="col" class="num">Last 3 months</th><th scope="col" class="num">Coffee, 3 months</th><th scope="col" class="num">Orders</th><th scope="col">Last order</th><th scope="col">Usually orders</th><th scope="col">Status</th></tr></thead>
        <tbody>${rows.map((c) => html`<tr><th scope="row">${c.name}<small>${c.top.join(", ")}</small></th><td class="num">${money(c.recentPence)}</td><td class="num">${kg(c.recentGrams)}</td><td class="num">${n(c.orders)}</td><td>${longDay(c.last)}</td><td>${c.usualDays ? `every ${c.usualDays} days` : "–"}${c.nextDue ? html`<small>next ${day(c.nextDue)}</small>` : ""}</td><td><span class="pill ${STATUS[c.status][1]}">${STATUS[c.status][0]}</span></td></tr>`)}</tbody></table></div>`
        : html`<p class="hint">No customers yet.</p>`}</section>`;
  }

  /* ---------- the page ---------- */
  async function view() {
    await load();
    const s = data.sources, cut = slice();
    const sourceText = [s.siteOrders ? `${n(s.siteOrders)} site ${s.siteOrders === 1 ? "order" : "orders"} since ${longDay(s.firstSiteOrder)}` : "no site orders yet", s.historyRows ? `QuickBooks history ${longDay(s.historyFirst)} to ${longDay(s.historyUntil && s.historyUntil <= s.historyLast ? s.historyUntil : s.historyLast)}` : "no QuickBooks history imported"].join(" · ");
    const empty = !data.weekly.length;
    return html`<section class="ins-workspace" aria-labelledby="insTitle"><div class="toolbar"><div><h2 id="insTitle">Insights</h2><p class="hint">${sourceText}</p></div>
      <div class="row"><button class="btn soft" type="button" data-act="wh-ins-import">${svg("plus")}Import QuickBooks history</button>${s.historyRows ? html`<button class="btn soft" type="button" data-act="wh-ins-products">QuickBooks products${s.unreviewedProducts ? html` <span class="badge">${s.unreviewedProducts}</span>` : ""}</button>` : ""}${empty ? "" : html`<button class="btn soft" type="button" data-act="wh-ins-csv">${svg("dl")}Download CSV</button>`}</div></div>
      ${s.unreviewedProducts ? html`<div class="ins-note group"><p><b>${s.unreviewedProducts} QuickBooks ${s.unreviewedProducts === 1 ? "product needs" : "products need"} checking.</b> The site guessed which coffee and bag size each one is; check them so the history counts the right coffee.</p><button class="btn sm soft" type="button" data-act="wh-ins-products">Check products</button></div>` : ""}
      ${empty ? html`<div class="w-empty"><span class="ic mut">${svg("pulse")}</span><h3>No sales to show yet</h3><p>Insights fill in as customer orders arrive. Import your QuickBooks sales history to see past years and a seasonal forecast straight away.</p><button class="btn" type="button" data-act="wh-ins-import">Import QuickBooks history</button></div>` : html`
      <div class="segwrap"><div class="seg" role="group" aria-label="Period">${PERIODS.map(([v, l]) => html`<button type="button" data-act="wh-ins-period" data-id="${v}" aria-pressed="${period === v}">${l}</button>`)}</div></div>
      ${tiles(cut)}${roast()}${overTime(cut)}${forecast()}${byCoffee(cut)}${customers()}`}</section>`;
  }

  /* ---------- CSV ---------- */
  function downloadCsv() {
    const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const title = (k) => data.coffees.find((c) => c.key === k)?.title || k;
    const lines = [["Week starting", "Coffee", "Coffee (kg)", "250 g bags", "1 kg bags", "Sales (£)"]];
    for (const w of data.weekly) for (const [k, v] of Object.entries(w.byCoffee)) lines.push([w.week, title(k), (v[0] / 1000).toFixed(2), v[2], v[3], (v[1] / 100).toFixed(2)]);
    lines.push([], ["Forecast week starting", "Coffee", "Expected (kg)", "Low (kg)", "High (kg)"]);
    for (const c of data.forecast.byCoffee) for (const p of c.weeks) lines.push([p.week, c.title, (p.grams / 1000).toFixed(2), (p.low / 1000).toFixed(2), (p.high / 1000).toFixed(2)]);
    const blob = new Blob([lines.map((l) => l.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `strangers-wholesale-insights-${data.today}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- batch settings ---------- */
  function openBatch() {
    const s = data.settings;
    openSheet(html`<div class="w-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Roasting and history</h2><p class="hint">Used for the roast plan and to stop QuickBooks history overlapping site orders.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <form class="w-form" id="insBatchForm" novalidate>
        <label class="field"><span class="fl">Green coffee per batch (kg)</span><input id="insBatchKg" type="number" inputmode="decimal" min="1" max="500" step="0.5" value="${s.batchKg}"></label>
        <label class="field"><span class="fl">Roasted weight per batch (kg)</span><input id="insYieldKg" type="number" inputmode="decimal" min="0.5" max="500" step="0.1" value="${s.yieldKg}"></label>
        <label class="field"><span class="fl">Use QuickBooks history up to (not including)</span><input id="insUntil" type="date" value="${s.historyUntil || ""}"></label>
        <p class="hint">Leave the date empty to use history until the first site order (${data.sources.firstSiteOrder ? longDay(data.sources.firstSiteOrder) : "none yet"}), so orders exported to QuickBooks from the site aren't counted twice.</p>
        <p class="err" id="insBatchErr" role="alert" hidden></p></form>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="button" data-sheet="save">Save</button></div></div>`,
    async (action) => {
      if (action !== "save") return;
      try {
        await api("PUT", root + "/settings", { ifVersion: s.version, batchKg: Number($("#insBatchKg").value), yieldKg: Number($("#insYieldKg").value), historyUntil: $("#insUntil").value || null });
        closeSheet(); toast("Saved"); await refresh();
      } catch (error) { const e = $("#insBatchErr"); e.textContent = error.message; e.hidden = false; }
    });
  }

  /* ---------- import ---------- */
  function openImport() {
    let parsed = null;
    const intro = html`<ol class="ins-steps"><li>In QuickBooks, open <b>Reports</b> → <b>Sales by Product/Service Detail</b>.</li><li>Set the dates (for example, the last three years) and run the report.</li><li>Choose <b>Export</b> → <b>Export to Excel</b> (or CSV) and pick the file here.</li></ol>
      <p class="hint">Only sales are kept: invoices, sales receipts, credit notes and refunds. Importing the same report again adds nothing twice.</p>`;
    const draw = (body) => put($("#insImportBody"), body);
    openSheet(html`<div class="w-sheet ins-import"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">Import QuickBooks history</h2></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${intro}<label class="btn soft ins-file">${svg("plus")}Choose report file<input id="insFile" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      <div id="insImportBody" aria-live="polite"></div>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="button" data-sheet="import" id="insImportGo" disabled>Import</button></div></div>`,
    async (action) => {
      if (action !== "import" || !parsed) return;
      const go = $("#insImportGo"); go.disabled = true;
      const importId = crypto.randomUUID(); let added = 0, skipped = 0;
      try {
        for (let i = 0; i < parsed.rows.length; i += 500) {
          draw(html`<p class="hint">Importing… ${n(Math.min(i + 500, parsed.rows.length))} of ${n(parsed.rows.length)} lines</p>`);
          const r = await api("POST", root + "/history/rows", { importId, fileName: parsed.fileName, offset: i, rows: parsed.rows.slice(i, i + 500) });
          added += r.added; skipped += r.skipped;
        }
        closeSheet(); toast(added ? `Imported ${n(added)} lines${skipped ? ` (${n(skipped)} already there)` : ""}` : "Nothing new: those lines were already imported");
        await refresh(); if (added) await openProducts(true);
      } catch (error) { draw(html`<p class="err">${error.message} Lines already sent are kept; import the file again to finish.</p>`); go.disabled = false; }
    });
    $("#insFile").addEventListener("change", async (e) => {
      const file = e.target.files?.[0]; parsed = null; $("#insImportGo").disabled = true;
      if (!file) return;
      draw(html`<p class="hint">Reading ${file.name}…</p>`);
      try {
        parsed = await SCSalesImport.parseFile(file);
        if (!parsed.rows.length) throw new Error("No sales lines found in that report. Check it's a sales report with Date, Product/Service, Qty and Amount.");
        const dates = parsed.rows.map((r) => r.date).sort(), products = new Set(parsed.rows.map((r) => r.product)), customers = new Set(parsed.rows.map((r) => r.customer));
        const total = parsed.rows.reduce((t, r) => t + r.pence, 0);
        draw(html`<div class="ins-preview group"><p><b>${n(parsed.rows.length)} sales lines</b> from ${longDay(dates[0])} to ${longDay(dates[dates.length - 1])}</p>
          <p>${n(products.size)} products · ${n(customers.size)} customers · ${money(total)} in total</p>
          ${parsed.skipped ? html`<p class="hint">${n(parsed.skipped)} other rows left out (payments, totals and the like).</p>` : ""}
          ${parsed.columns.customer || parsed.columns.product ? "" : html`<p class="hint">No customer column: customers will show as Unknown.</p>`}</div>`);
        $("#insImportGo").disabled = false;
      } catch (error) { draw(html`<p class="err">${error.message}</p>`); }
    });
  }

  /* ---------- QuickBooks product → coffee and bag size ---------- */
  async function openProducts(afterImport = false) {
    const h = await api("GET", root + "/history"), coffees = h.coffees;
    const choice = (p, i) => { const m = p.mapping || { pack: "ignore" }, other = m.pack !== "ignore" && !m.coffee;
      return html`<tr data-product-row="${i}"><th scope="row">${p.product}<small>${n(p.qty)} sold · ${money(p.pence)} · ${month(p.first)}–${month(p.last)}</small>${p.mapping && !p.mapping.reviewed ? html`<span class="pill warn">Check</span>` : ""}</th>
        <td><select data-map-coffee aria-label="Coffee for ${p.product}"><option value="">Not coffee</option>${coffees.map((c) => html`<option value="${c.id}" ${m.coffee === c.id ? raw("selected") : ""}>${c.title}</option>`)}<option value="other" ${other ? raw("selected") : ""}>Another coffee…</option></select>
          <input data-map-title type="text" maxlength="120" placeholder="Coffee name" value="${other ? m.title : ""}" aria-label="Coffee name for ${p.product}" ${other ? "" : raw("hidden")}></td>
        <td><select data-map-pack aria-label="Bag size for ${p.product}">${[["quarter", "250 g bag"], ["kilo", "1 kg bag"], ["half", "500 g bag"], ["other", "Other weight"]].map(([v, l]) => html`<option value="${v}" ${m.pack === v ? raw("selected") : ""}>${l}</option>`)}</select>
          <input data-map-grams type="number" min="1" max="100000" placeholder="g each" value="${m.pack === "other" ? m.grams : ""}" aria-label="Grams per unit for ${p.product}" ${m.pack === "other" ? "" : raw("hidden")}></td></tr>`; };
    openSheet(html`<div class="w-sheet ins-products"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">QuickBooks products</h2><p class="hint">${afterImport ? "Imported. " : ""}Which coffee and bag size each QuickBooks product is. Anything set to Not coffee (delivery, cups, equipment) is left out of the coffee figures.</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="ins-table-wrap"><table class="ins-table ins-map"><thead><tr><th scope="col">QuickBooks product</th><th scope="col">Coffee</th><th scope="col">Bag</th></tr></thead><tbody>${h.products.map(choice)}</tbody></table></div>
      ${h.imports.length ? html`<details class="ins-imports"><summary>Imported files (${h.imports.length})</summary>${h.imports.map((x) => html`<div class="row"><span>${x.fileName} · ${n(x.rows)} lines · ${longDay(x.firstDate)}–${longDay(x.lastDate)}</span><button class="btn sm soft danger" type="button" data-sheet="remove" data-id="${x.id}">Remove</button></div>`)}</details>` : ""}
      <p class="err" id="insMapErr" role="alert" hidden></p>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="button" data-sheet="save">Save</button></div></div>`,
    async (action, element) => {
      const err = $("#insMapErr"); err.hidden = true;
      if (action === "remove") {
        if (!confirm("Remove this file's history from Insights? You can import it again later.")) return;
        try { await api("DELETE", root + "/history/imports/" + element.dataset.id); closeSheet(); toast("Removed"); await refresh(); } catch (error) { err.textContent = error.message; err.hidden = false; }
        return;
      }
      if (action !== "save") return;
      const mappings = [...document.querySelectorAll("[data-product-row]")].map((tr) => {
        const p = h.products[Number(tr.dataset.productRow)], coffee = tr.querySelector("[data-map-coffee]").value, pack = tr.querySelector("[data-map-pack]").value;
        if (!coffee) return { product: p.product, pack: "ignore" };
        return { product: p.product, coffee: coffee === "other" ? null : coffee, title: coffee === "other" ? tr.querySelector("[data-map-title]").value : coffees.find((c) => c.id === coffee)?.title, pack, grams: pack === "other" ? Number(tr.querySelector("[data-map-grams]").value) : undefined };
      });
      try { await api("PUT", root + "/history/products", { mappings }); closeSheet(); toast("Products saved"); await refresh(); } catch (error) { err.textContent = error.message; err.hidden = false; }
    });
    $("#sheet").addEventListener("change", (e) => {
      const tr = e.target.closest?.("[data-product-row]"); if (!tr) return;
      tr.querySelector("[data-map-title]").hidden = tr.querySelector("[data-map-coffee]").value !== "other";
      tr.querySelector("[data-map-grams]").hidden = tr.querySelector("[data-map-pack]").value !== "other";
      tr.querySelector("[data-map-pack]").disabled = !tr.querySelector("[data-map-coffee]").value;
    });
    document.querySelectorAll("[data-product-row]").forEach((tr) => { tr.querySelector("[data-map-pack]").disabled = !tr.querySelector("[data-map-coffee]").value; });
  }

  return {
    view,
    async act(name, id) {
      if (name === "wh-ins-period" && PERIODS.some(([v]) => v === id)) { period = id; await reload(); }
      if (name === "wh-ins-measure" && ["pence", "grams"].includes(id)) { measure = id; await reload(); }
      if (name === "wh-ins-import") openImport();
      if (name === "wh-ins-products") await openProducts();
      if (name === "wh-ins-csv" && data) downloadCsv();
      if (name === "wh-ins-batch" && data) openBatch();
      if (name === "wh-ins-print-roast" && data) printRoast();
    },
  };
};
