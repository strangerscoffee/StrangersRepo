// Native wholesale invoice settings, previews and manual payment recording.
window.WholesaleInvoices = function ({ api, html, raw, svg, put, openSheet, closeSheet, reload, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const root = "/api/admin/wholesale";
  const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((pence || 0) / 100);
  const date = (value) => value ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date(value + "T12:00:00Z")) : "Not set";
  const today = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/London" }).format(new Date());
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const percent = (basisPoints) => new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(basisPoints / 100) + "%";
  const field = (label, control) => html`<label class="field"><span class="fl">${label}</span>${control}</label>`;
  const textInput = (id, value, max = 180, type = "text", extra = "") => html`<input id="${id}" type="${type}" value="${value || ""}" maxlength="${max}" ${extra}>`;
  const textarea = (id, value, max) => html`<textarea id="${id}" maxlength="${max}">${value || ""}</textarea>`;
  const paymentLabel = (invoice) => invoice.accounting?.status === "review" ? "Check payment status" : invoice.payment?.paid ? "Paid" : invoice.payment?.status === "part-paid" ? "Part paid" : invoice.payment?.status === "overdue" ? "Overdue" : "Unpaid";
  const status = (invoice) => html`<span class="pill ${invoice.accounting?.status === "review" ? "warn" : invoice.payment?.paid ? "ok" : invoice.payment?.status === "overdue" ? "bad" : "warn"}">${paymentLabel(invoice)}</span>`;
  const checked = (value) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value)) : "Not checked yet";
  const title = (heading, subtitle = "") => html`<header class="wi-head"><div><h2 id="sheetTitle" tabindex="-1">${heading}</h2>${subtitle ? html`<p>${subtitle}</p>` : ""}</div><button class="btn soft wi-close" type="button" data-sheet="wi-back" aria-label="Close invoice window">×</button></header>`;
  const footer = (submit, back = "Cancel") => html`<footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="wi-back">${back}</button>${submit ? html`<button class="btn" type="submit">${submit}</button>` : ""}</div></footer>`;
  let invoices = [], count = 0, cursor = null, listPages = 1, loadingMore = false, configCache = null;
  const pendingReviews = new Map();
  const quickbooks = window.WholesaleQuickBooks({api,html,raw,svg,show,title,footer,field,busy,closeSheet,reload,toast});

  // Each nested picker has one parent draft; gestures restore it instead of discarding edits.
  function show(content, handler, back) {
    let cleanup = () => {};
    openSheet(content, async (action, element) => {
      const form = element.closest(".wi-sheet");
      if (form?.dataset.wiBusy) return;
      if (action === "wi-back") { await busy(form, back); return; }
      await handler(action, element, form);
    });
    const form = $("#sheet .wi-sheet"), controller = new AbortController(), scrim = $("#scrim");
    const observer = new MutationObserver(() => { if (!form?.isConnected) cleanup(); });
    cleanup = () => { controller.abort(); observer.disconnect(); };
    observer.observe($("#sheet"), { childList: true });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !form?.isConnected) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!form.dataset.wiBusy) busy(form, back);
    }, { capture: true, signal: controller.signal });
    scrim.addEventListener("click", (event) => {
      if (event.target !== scrim || !form?.isConnected) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!form.dataset.wiBusy) busy(form, back);
    }, { capture: true, signal: controller.signal });
    $("#sheetTitle")?.focus({ preventScroll: true });
    $("#sheet").scrollTop = 0;
    return form;
  }
  async function busy(form, work) {
    if (!form?.isConnected || form.dataset.wiBusy) return;
    form.dataset.wiBusy = "1"; form.setAttribute("aria-busy", "true");
    const controls = [...form.querySelectorAll("button,input,textarea,select")].map((control) => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    const error = form.querySelector("#wiError"); if (error) error.textContent = "";
    try { await work(); }
    catch (problem) { if (form.isConnected && error) { error.textContent = problem.message; error.scrollIntoView({ block: "nearest" }); } else toast(problem.message); }
    finally {
      delete form.dataset.wiBusy; form.removeAttribute("aria-busy");
      controls.forEach(([control, wasDisabled]) => { if (control.isConnected) control.disabled = wasDisabled; });
    }
  }
  function choose(heading, choices, selected, apply, back) {
    show(html`<div class="wi-sheet wi-choice">${title(heading)}<div class="wi-body"><div class="group" id="wiChoiceList">${choices.map((choice) => html`<button class="item" type="button" data-sheet="wi-choice" data-value="${choice.id}" aria-pressed="${choice.id === selected}"><span class="tx"><b>${choice.label}</b>${choice.note ? html`<span>${choice.note}</span>` : ""}</span><span class="end">${choice.id === selected ? svg("ok") : ""}</span></button>`)}</div></div>${footer(null, "Keep current choice")}</div>`, (action, element) => { if (action === "wi-choice") apply(element.dataset.value); }, back);
  }
  function summary(data) {
    return html`<div class="stats wi-stats">${[["Invoices", data.count], ["Outstanding", money(data.outstandingPence)], ["Overdue", money(data.overduePence)]].map(([label, value]) => html`<div class="stat glass"><span class="k">${label}</span><span class="v">${value}</span></div>`)}</div>${data.reviewCount ? html`<p class="wi-reasons">${data.reviewCount} ${data.reviewCount === 1 ? "invoice needs" : "invoices need"} a payment check. Totals include the saved balance until accounting is reconciled.</p>` : ""}`;
  }
  function invoiceRow(invoice) {
    return html`<button class="item wi-invoice-row" type="button" data-act="wh-invoice-open" data-id="${invoice.id}"><span class="ic acc">${svg("dl")}</span><span class="tx"><b>${invoice.number} · ${invoice.billTo.name}</b><span>${date(invoice.invoiceDate)}${invoice.deliveryLocation?.name ? " · " + invoice.deliveryLocation.name : ""}</span><span>${invoice.dueDate ? "Due " + date(invoice.dueDate) : invoice.paymentTerms.label}</span></span><span class="end"><b class="num">${money(invoice.totals.grossPence)}</b>${status(invoice)}<span class="chev">${svg("chev")}</span></span></button>`;
  }
  async function view() {
    const [config, first] = await Promise.all([api("GET", root + "/invoice-settings"), api("GET", root + "/invoices")]);
    configCache = config; invoices = first.invoices; cursor = first.nextCursor; count = first.count;
    for (let page = 1; page < listPages && cursor; page++) {
      const next = await api("GET", root + "/invoices?cursor=" + encodeURIComponent(cursor));
      invoices = [...new Map([...invoices, ...next.invoices].map((invoice) => [invoice.id, invoice])).values()]; cursor = next.nextCursor; count = next.count;
    }
    return html`<section class="wi-workspace" aria-labelledby="wiTitle"><div class="toolbar"><div><h2 id="wiTitle">Invoices</h2><p class="hint">VAT invoices and payment records.</p></div><div class="row"><button class="btn soft" type="button" data-act="wh-invoice-quickbooks">QuickBooks</button><button class="btn soft" type="button" data-act="wh-invoice-settings">Invoice settings</button></div></div>${summary(first.summary)}${!config.ready ? html`<div class="wi-setup group"><h3>Complete your invoice settings</h3><p>Add your legal business details, VAT rates and invoice numbering before issuing an invoice.</p><button class="btn soft" type="button" data-act="wh-invoice-settings">Set up invoicing</button></div>` : ""}<section class="wi-records" aria-labelledby="wiListTitle"><div class="label" id="wiListTitle">Issued invoices <span class="count">${invoices.length} of ${count}</span></div><div class="group glass">${invoices.length ? invoices.map(invoiceRow) : html`<div class="w-empty"><span class="ic mut">${svg("dl")}</span><h3>No invoices yet</h3><p>Open a customer order to review and issue its invoice.</p></div>`}</div>${cursor ? html`<div class="w-more"><button class="btn soft" type="button" data-act="wh-invoice-more">Load earlier invoices</button></div>` : ""}<p class="hint">Recording payment updates the invoice status. It does not transfer money.</p></section></section>`;
  }
  function settingsDraft(form, state) {
    const value = (id) => form.querySelector("#" + id).value.trim();
    return { ...clone(state), seller: { legalName: value("wiLegalName"), address: value("wiSellerAddress"), vatNumber: value("wiVatNumber"), companyNumber: value("wiCompanyNumber"), email: value("wiSellerEmail"), phone: value("wiSellerPhone") }, invoicePrefix: value("wiPrefix"), firstInvoiceNumber: Number(value("wiFirstNumber")), paymentInstructions: value("wiPaymentInstructions"), confirmed: form.querySelector("#wiConfirmed").checked, scrollTop: form.querySelector(".wi-body").scrollTop };
  }
  async function openSettings(back = () => { closeSheet(); reload(); }, draft = null, received = null) {
    const [config, listed] = received || await Promise.all([api("GET", root + "/invoice-settings"), api("GET", root + "/invoices")]);
    configCache = config;
    const state = draft || clone(config.settings), rates = state.vatRates, rateLabel = (id) => rates.find((rate) => rate.id === id)?.label || "Choose a rate";
    const form = show(html`<form id="wiSettingsForm" class="wi-sheet wi-wide">${title("Invoice settings", "Your business details and VAT configuration")}<div class="wi-body"><div class="wi-settings-grid"><section class="wi-section"><h3>Supplier details</h3>${field("Legal business name", textInput("wiLegalName", state.seller.legalName))}${field("Registered business address", textarea("wiSellerAddress", state.seller.address, 1000))}${field("VAT registration number", textInput("wiVatNumber", state.seller.vatNumber, 40))}${field("Company number (optional)", textInput("wiCompanyNumber", state.seller.companyNumber, 40))}${field("Invoice email (optional)", textInput("wiSellerEmail", state.seller.email, 150, "email"))}${field("Phone (optional)", textInput("wiSellerPhone", state.seller.phone, 40))}</section><section class="wi-section"><h3>VAT and numbering</h3><div class="field"><span class="fl">Saved order prices</span><button class="wi-picker" type="button" data-sheet="wi-settings-choice" data-key="priceBasis">${state.priceBasis === "inclusive" ? "Include VAT" : state.priceBasis === "exclusive" ? "Exclude VAT" : "Choose price basis"}${svg("chev")}</button></div><div class="wi-section-heading"><h4>VAT rates</h4><button class="btn sm soft" type="button" data-sheet="wi-rate-add">${svg("plus")}Add rate</button></div><div class="group wi-rate-list">${rates.length ? rates.map((rate, index) => html`<button class="item" type="button" data-sheet="wi-rate-edit" data-index="${index}"><span class="tx"><b>${rate.label}</b><span>${percent(rate.basisPoints)}</span></span><span class="chev">${svg("chev")}</span></button>`) : html`<p class="hint">Add the VAT rates your business uses. Rates are not selected automatically.</p>`}</div>${[["defaultCoffeeRateId", "Default coffee VAT rate"], ["deliveryRateId", "Default delivery VAT rate"]].map(([key, label]) => html`<div class="field"><span class="fl">${label}</span><button class="wi-picker" type="button" data-sheet="wi-settings-choice" data-key="${key}">${rateLabel(state[key])}${svg("chev")}</button></div>`)}${field("Invoice number prefix", textInput("wiPrefix", state.invoicePrefix, 20))}${field("First invoice number", html`<input id="wiFirstNumber" type="number" min="1" max="999999999" step="1" value="${state.firstInvoiceNumber}" ${listed.count ? raw("disabled") : ""}>`)}<p class="hint">Use a prefix and starting number that do not duplicate an existing invoice series. The starting number is fixed after the first invoice.</p></section><section class="wi-section wi-full"><h3>Payment details</h3>${field("Payment instructions shown on invoices", textarea("wiPaymentInstructions", state.paymentInstructions, 2000))}<p class="hint">Include the bank or payment details you want customers to use. Each invoice also keeps the payment terms agreed with its order.</p><label class="wi-check"><input id="wiConfirmed" type="checkbox" ${state.confirmed ? raw("checked") : ""}><span>I’ve checked the supplier details, VAT configuration and invoice numbering.</span></label><div class="wi-reasons" id="wiSetupStatus" ${config.ready ? raw("hidden") : ""}><p>Saved setup still needs</p><ul>${config.reasons.map((reason) => html`<li>${reason}</li>`)}</ul></div></section></div></div>${footer("Save invoice settings")}</form>`, async (action, element, current) => {
      if (action === "submit") {
        await busy(current, async () => { const value = settingsDraft(current, state); delete value.scrollTop; const saved = await api("PUT", root + "/invoice-settings", { ...value, ifVersion: config.version }); configCache = saved; toast(saved.ready ? "Invoice settings saved." : "Settings saved. Complete the remaining details before issuing."); back(); }); return;
      }
      if (action === "wi-settings-choice") {
        const value = settingsDraft(current, state), key = element.dataset.key;
        const choices = key === "priceBasis" ? [{ id: "inclusive", label: "Prices include VAT", note: "VAT is extracted from the saved price." }, { id: "exclusive", label: "Prices exclude VAT", note: "VAT is added to the saved price." }] : [{ id: "", label: key === "deliveryRateId" ? "No default delivery rate" : "Choose later" }, ...rates.map((rate) => ({ id: rate.id, label: rate.label + " · " + percent(rate.basisPoints) }))];
        choose(key === "priceBasis" ? "Price basis" : "Default VAT rate", choices, value[key], (selected) => { value[key] = selected; openSettings(back, value, [config, listed]); }, () => openSettings(back, value, [config, listed])); return;
      }
      if (action === "wi-rate-add" || action === "wi-rate-edit") { editRate(settingsDraft(current, state), action === "wi-rate-add" ? -1 : Number(element.dataset.index), config, listed, back); }
    }, back);
    const updateSetupStatus = () => {
      const value = settingsDraft(form, state); delete value.scrollTop;
      const saved = clone(config.settings);
      const changed = JSON.stringify(value) !== JSON.stringify(saved), status = form.querySelector("#wiSetupStatus");
      status.hidden = !changed && config.ready;
      put(status, changed ? html`<p>Unsaved invoice settings</p><span>Save invoice settings to check the updated supplier, VAT and numbering details.</span>` : html`<p>Saved setup still needs</p><ul>${config.reasons.map(reason => html`<li>${reason}</li>`)}</ul>`);
    };
    form.addEventListener("input", updateSetupStatus); form.addEventListener("change", updateSetupStatus);
    updateSetupStatus();
    if (state.scrollTop) form.querySelector(".wi-body").scrollTop = state.scrollTop;
  }
  function editRate(draft, index, config, listed, back) {
    const old = draft.vatRates[index], rate = old || { id: "rate-" + crypto.randomUUID().replaceAll("-", ""), label: "", basisPoints: 0 };
    const returnToSettings = () => openSettings(back, draft, [config, listed]);
    show(html`<form id="wiRateForm" class="wi-sheet wi-choice">${title(old ? "Edit VAT rate" : "Add VAT rate")}<div class="wi-body wi-section">${field("Rate label", html`<input id="wiRateLabel" maxlength="80" value="${rate.label}" required>`)}${field("VAT percentage", html`<input id="wiRatePercent" type="number" min="0" max="100" step="0.01" value="${rate.basisPoints / 100}" required>`)}<p class="hint">Enter the percentage that applies to these goods or services, including 0 for zero-rated supplies.</p>${old ? html`<button class="btn bad" type="button" data-sheet="wi-rate-remove">Remove rate from settings</button><p class="hint">Existing invoices keep their saved VAT breakdown.</p>` : ""}</div>${footer("Apply VAT rate", "Keep settings")}</form>`, (action, element, form) => {
      if (action === "wi-rate-remove") { draft.vatRates.splice(index, 1); if (draft.defaultCoffeeRateId === rate.id) draft.defaultCoffeeRateId = ""; if (draft.deliveryRateId === rate.id) draft.deliveryRateId = ""; returnToSettings(); return; }
      if (action !== "submit") return;
      const label = form.querySelector("#wiRateLabel").value.trim(), value = form.querySelector("#wiRatePercent").value;
      if (!label || !/^\d{1,3}(?:\.\d{1,2})?$/.test(value) || Number(value) > 100) { form.querySelector("#wiError").textContent = "Enter a label and a VAT percentage from 0 to 100, with at most two decimal places."; return; }
      const updated = { id: rate.id, label, basisPoints: Math.round(Number(value) * 100) };
      if (index < 0) { if (draft.vatRates.length >= 20) { form.querySelector("#wiError").textContent = "Keep up to 20 VAT rates."; return; } draft.vatRates.push(updated); }
      else draft.vatRates[index] = updated;
      returnToSettings();
    }, returnToSettings);
  }
  function invoiceLines(invoice) {
    return html`<div class="wi-table-wrap" tabindex="0" role="region" aria-label="Invoice line items"><table class="wi-table"><thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Net</th><th scope="col">VAT</th><th scope="col">Total</th></tr></thead><tbody>${invoice.lines.map((line) => html`<tr><td><b>${line.description}</b>${line.packLabel || line.grindLabel ? html`<span>${[line.packLabel, line.grindLabel].filter(Boolean).join(" · ")}</span>` : ""}</td><td>${line.quantity}</td><td>${money(line.netPence)}</td><td>${percent(line.vatBasisPoints)}<span>${money(line.vatPence)}</span></td><td>${money(line.grossPence)}</td></tr>`)}</tbody></table></div>`;
  }
  function totals(invoice) {
    return html`<dl class="wi-totals"><div><dt>Net subtotal</dt><dd>${money(invoice.totals.netPence)}</dd></div><div><dt>VAT</dt><dd>${money(invoice.totals.vatPence)}</dd></div><div class="wi-total"><dt>Invoice total</dt><dd>${money(invoice.totals.grossPence)}</dd></div></dl>`;
  }
  function details(invoice) {
    return html`<div class="wi-invoice-meta"><section><h3>Bill to</h3><p class="wi-address">${[invoice.billTo.name, invoice.billTo.address, invoice.billTo.postcode].filter(Boolean).join("\n")}</p>${invoice.billTo.vatNumber ? html`<p>Customer VAT no. ${invoice.billTo.vatNumber}</p>` : ""}</section><section><h3>Dates and terms</h3><p>Invoice date: ${date(invoice.invoiceDate)}</p><p>Supply date: ${date(invoice.supplyDate)}</p><p>${invoice.paymentTerms.label}</p>${invoice.paymentTerms.note ? html`<p>${invoice.paymentTerms.note}</p>` : ""}<p>${invoice.dueDate ? "Payment due: " + date(invoice.dueDate) : "No calendar due date recorded"}</p>${invoice.deliveryLocation?.name ? html`<p>Location: ${invoice.deliveryLocation.name}</p>` : ""}</section></div>${invoiceLines(invoice)}${totals(invoice)}<section class="wi-section"><h3>VAT breakdown</h3><div class="kvs">${invoice.vatBreakdown.map((rate) => html`<div class="kv"><span>${rate.label} · ${percent(rate.basisPoints)}</span><span>${money(rate.netPence)} net · ${money(rate.vatPence)} VAT</span></div>`)}</div></section>${invoice.paymentInstructions ? html`<section class="wi-section"><h3>How to pay</h3><p class="wi-address">${invoice.paymentInstructions}</p></section>` : ""}`;
  }
  function draftPayload(form, row, config, state) {
    const value = (id) => form.querySelector("#" + id).value.trim();
    const amount = value("wiDeliveryPounds");
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error("Enter the delivery charge in pounds and pence.");
    return { orderVersion: row.version, settingsVersion: config.version, invoiceDate: value("wiInvoiceDate"), supplyDate: value("wiSupplyDate"), billTo: { name: value("wiBillName"), address: value("wiBillAddress"), postcode: value("wiBillPostcode"), vatNumber: value("wiBillVat") }, deliveryCharge: { pence: Math.round(Number(amount) * 100), description: value("wiDeliveryDescription"), vatRateId: state.deliveryVatRateId || "" }, lineVatRateIds: state.lineVatRateIds, paymentInstructions: value("wiInvoiceInstructions"), ...(!/^net-(7|14|30|60)$/.test(row.paymentTerms?.id || "") && value("wiDueDate") ? { dueDate: value("wiDueDate") } : {}) };
  }
  function captureInvoice(form, state) {
    return { ...clone(state), invoiceDate: form.querySelector("#wiInvoiceDate").value, supplyDate: form.querySelector("#wiSupplyDate").value, billTo: { name: form.querySelector("#wiBillName").value, address: form.querySelector("#wiBillAddress").value, postcode: form.querySelector("#wiBillPostcode").value, vatNumber: form.querySelector("#wiBillVat").value }, deliveryPounds: form.querySelector("#wiDeliveryPounds").value, deliveryDescription: form.querySelector("#wiDeliveryDescription").value, paymentInstructions: form.querySelector("#wiInvoiceInstructions").value, dueDate: form.querySelector("#wiDueDate")?.value || "", scrollTop: form.querySelector(".wi-body").scrollTop };
  }
  // The delivery charge the order was placed with (including VAT), as the invoice's price basis needs it: when
  // saved prices exclude VAT it's the amount before VAT at the default delivery rate.
  function orderDeliveryPounds(row, config) {
    const gross = Number.isSafeInteger(row.deliveryPence) ? row.deliveryPence : 0;
    if (!gross) return "0.00";
    const rate = config.settings.vatRates.find((item) => item.id === config.settings.deliveryRateId);
    const pence = config.settings.priceBasis === "exclusive" && rate ? Math.round(gross * 10000 / (10000 + rate.basisPoints)) : gross;
    return (pence / 100).toFixed(2);
  }
  function invoiceForm(row, config, back, restored = null) {
    const state = restored || { invoiceDate: today(), supplyDate: today(), billTo: { name: row.business || row.customerSnapshot?.business || "", address: row.customerSnapshot?.address || "", postcode: row.customerSnapshot?.postcode || "", vatNumber: "" }, deliveryPounds: orderDeliveryPounds(row, config), deliveryDescription: row.delivery === "Delivery" ? "Delivery" : "Roastery collection", deliveryVatRateId: config.settings.deliveryRateId, lineVatRateIds: row.lines.map(() => config.settings.defaultCoffeeRateId), paymentInstructions: config.settings.paymentInstructions, dueDate: "" };
    const rateLabel = (id) => config.settings.vatRates.find((rate) => rate.id === id)?.label || "Choose a VAT rate";
    const netTerms = /^net-(7|14|30|60)$/.test(row.paymentTerms?.id || "");
    const form = show(html`<form id="wiInvoiceForm" class="wi-sheet wi-wide">${title("Review invoice details", row.business)}<div class="wi-body"><div class="wi-settings-grid"><section class="wi-section"><h3>Invoice and supply dates</h3>${field("Invoice date", html`<input id="wiInvoiceDate" type="date" value="${state.invoiceDate}" required>`)}${field("Supply date / tax point", html`<input id="wiSupplyDate" type="date" value="${state.supplyDate}" required>`)}<p class="payment-terms">${row.paymentTerms?.label || "To be agreed"}${row.paymentTerms?.note ? " · " + row.paymentTerms.note : ""}</p>${netTerms ? html`<p class="hint">The due date is calculated from the agreed invoice terms.</p><input id="wiDueDate" type="hidden" value="">` : field("Payment due date (optional)", html`<input id="wiDueDate" type="date" value="${state.dueDate}">`)}</section><section class="wi-section"><h3>Billing details</h3>${field("Billing business name", html`<input id="wiBillName" maxlength="180" value="${state.billTo.name}" required>`)}${field("Billing address", html`<textarea id="wiBillAddress" maxlength="1000" required>${state.billTo.address}</textarea>`)}${field("Postcode", textInput("wiBillPostcode", state.billTo.postcode, 20))}${field("Customer VAT number (optional)", textInput("wiBillVat", state.billTo.vatNumber, 40))}</section><section class="wi-section wi-full"><h3>Saved order lines</h3><p class="hint">Descriptions, quantities and prices come from the saved order. Choose the VAT rate for each line.</p><div class="group">${row.lines.map((line, index) => html`<div class="item wi-line-rate"><span class="tx"><b>${line.quantity} × ${line.title}</b><span>${line.packLabel} · ${line.grindLabel} · ${money(line.price)} per bag</span></span><button class="btn soft" type="button" data-sheet="wi-line-rate" data-index="${index}">${rateLabel(state.lineVatRateIds[index])}</button></div>`)}</div></section><section class="wi-section"><h3>Delivery charge</h3>${field("Charge (£)", html`<input id="wiDeliveryPounds" inputmode="decimal" value="${state.deliveryPounds}" required>`)}${field("Description", textInput("wiDeliveryDescription", state.deliveryDescription))}<div class="field"><span class="fl">Delivery VAT rate</span><button class="wi-picker" type="button" data-sheet="wi-delivery-rate">${rateLabel(state.deliveryVatRateId)}${svg("chev")}</button></div><p class="hint">No delivery VAT rate is needed when the charge is £0.00.</p></section><section class="wi-section"><h3>Payment instructions</h3>${field("Shown on this invoice", textarea("wiInvoiceInstructions", state.paymentInstructions, 2000))}<p class="hint">The invoice keeps the payment terms agreed with this order.</p></section></div></div>${footer("Preview invoice", "Back to order")}</form>`, async (action, element, current) => {
      if (action === "submit") {
        await busy(current, async () => {
          const payload = clone(draftPayload(current, row, config, state)), draft = captureInvoice(current, state);
          const response = await api("POST", root + `/orders/${row.id}/invoice/preview`, payload);
          if (response.issued) { showIssued(response.invoice, back); return; }
          previewInvoice(response.invoice, payload, async () => {
            try {
              const [currentOrders, currentConfig] = await Promise.all([api("GET", root + "/orders?q=" + encodeURIComponent(row.id)), api("GET", root + "/invoice-settings")]);
              const currentOrder = currentOrders.orders.find(order => order.id === row.id);
              if (!currentOrder) throw new Error("The order is no longer available. Reload the order list.");
              if (!currentConfig.ready) { openSettings(() => openOrder(currentOrder, back)); return; }
              invoiceForm(currentOrder, currentConfig, back, draft);
            } catch (problem) { toast(problem.message); back(); }
          }, back);
        }); return;
      }
      if (action === "wi-line-rate" || action === "wi-delivery-rate") {
        const draft = captureInvoice(current, state), index = Number(element.dataset.index);
        const selected = action === "wi-line-rate" ? draft.lineVatRateIds[index] : draft.deliveryVatRateId;
        choose("VAT rate", config.settings.vatRates.map((rate) => ({ id: rate.id, label: rate.label + " · " + percent(rate.basisPoints) })), selected, (id) => { if (action === "wi-line-rate") draft.lineVatRateIds[index] = id; else draft.deliveryVatRateId = id; invoiceForm(row, config, back, draft); }, () => invoiceForm(row, config, back, draft));
      }
    }, back);
    if (state.scrollTop) form.querySelector(".wi-body").scrollTop = state.scrollTop;
  }
  function previewInvoice(invoice, payload, edit, back) {
    let uncertain = pendingReviews.has(invoice.orderId);
    show(html`<form id="wiPreviewForm" class="wi-sheet wi-wide">${title("Invoice preview", uncertain ? "Submission awaiting confirmation" : "Draft · no invoice number has been issued")}<div class="wi-body"><div class="wi-draft-banner"><strong>${uncertain ? "Invoice confirmation pending" : "Draft invoice"}</strong><span>${uncertain ? "Check or retry the same reviewed invoice to recover its result." : "Check the billing details, VAT and payment terms before issuing."}</span></div>${details(invoice)}<p class="hint">Issuing allocates a permanent invoice number. The issued financial details cannot be edited or deleted.</p></div><footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="wi-back">${uncertain ? "Close review" : "Edit draft"}</button><button class="btn" id="wiIssueInvoice" type="submit">${uncertain ? "Check / retry same invoice" : "Issue VAT invoice"}</button></div></footer></form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        if (uncertain) { const existing = await api("GET", root + `/orders/${invoice.orderId}/invoice`); if (existing.invoice) { showIssued(existing.invoice, back, invoice.orderId); pendingReviews.delete(invoice.orderId); return; } }
        uncertain = true; pendingReviews.set(invoice.orderId, { invoice, payload, edit });
        try { const issued = await api("POST", root + `/orders/${invoice.orderId}/invoice`, payload); showIssued(issued.invoice, back, invoice.orderId); pendingReviews.delete(invoice.orderId); toast("VAT invoice issued."); }
        catch (problem) {
          try { const found = await api("GET", root + `/orders/${invoice.orderId}/invoice`); if (found.invoice) { showIssued(found.invoice, back, invoice.orderId); pendingReviews.delete(invoice.orderId); toast("The issued invoice was recovered."); return; } } catch {}
          if (problem.status >= 400 && problem.status < 500 && problem.status !== 401) { uncertain = false; pendingReviews.delete(invoice.orderId); form.querySelector(".wi-foot [data-sheet=wi-back]").textContent = "Edit draft"; throw new Error(problem.message + " Return to the draft to review the details again."); }
          const error = new Error(problem.message + " Check the saved invoice or retry this same review before changing the draft.");
          const button = form.querySelector("#wiIssueInvoice"); if (button) button.textContent = "Check / retry same invoice";
          form.querySelector(".wi-head p").textContent = "Submission awaiting confirmation";
          form.querySelector(".wi-draft-banner strong").textContent = "Invoice confirmation pending";
          form.querySelector(".wi-draft-banner span").textContent = "Check or retry the same reviewed invoice to recover its result.";
          form.querySelector(".wi-foot [data-sheet=wi-back]").textContent = "Close review";
          throw error;
        }
      });
    }, () => { if (uncertain) { back(); return; } edit(); });
  }
  function showIssued(invoice, back = () => { closeSheet(); reload(); }, expectedOrderId = null) {
    if (!invoice || !Number.isSafeInteger(invoice.id) || invoice.id < 1 || typeof invoice.number !== "string" || !invoice.number || !Array.isArray(invoice.lines) || !invoice.lines.length || !invoice.billTo || !invoice.payment || !invoice.totals || ["netPence", "vatPence", "grossPence"].some(key => !Number.isSafeInteger(invoice.totals[key]) || invoice.totals[key] < 0) || (expectedOrderId && invoice.orderId !== expectedOrderId)) throw new Error("The invoice response was incomplete. Check the saved invoice before changing this review.");
    const managed = invoice.payment.source === "quickbooks", review = invoice.accounting?.status === "review";
    show(html`<div id="wiIssuedInvoice" class="wi-sheet wi-wide">${title(invoice.number, invoice.billTo.name)}<div class="wi-body"><div class="wi-issued-heading">${status(invoice)}<a class="btn soft" id="wiDownloadPdf" href="${root}/invoices/${invoice.id}/pdf" target="_blank" rel="noopener">Download PDF</a></div>${details(invoice)}<section class="wi-section"><h3>QuickBooks Online</h3><button class="btn soft" type="button" data-sheet="wi-quickbooks">Open QuickBooks</button></section><section class="wi-section"><h3>Payment record</h3>
      ${review ? html`<p class="wi-reasons">Payment status needs review. ${invoice.accounting.reason || "Check the linked invoice in QuickBooks."}</p>` : html`<p>${invoice.payment.paid ? (invoice.payment.paidDate ? "Paid on " + date(invoice.payment.paidDate) : "Paid in QuickBooks") : "Outstanding: " + money(invoice.payment.outstandingPence)}</p>`}
      ${managed ? html`<p class="hint">Checked ${checked(invoice.payment.checkedAt)}. Record or correct payments in QuickBooks, then check the linked invoice here.</p>` : html`${invoice.payment.reference ? html`<p>Reference: ${invoice.payment.reference}</p>` : ""}<button class="btn soft" type="button" data-sheet="wi-payment">${invoice.payment.paid ? "Correct payment record" : "Record payment received"}</button><p class="hint">This records payment only. It does not collect or refund money.</p>`}
      </section></div>${footer(null, "Done")}</div>`, async (action) => {
      if (action === "wi-payment" && !managed) paymentForm(invoice, () => showIssued(invoice, back), back);
      if (action === "wi-quickbooks") await busy($("#wiIssuedInvoice"), () => quickbooks.openInvoice(invoice, async () => { const fresh = await api("GET", root + "/invoices/" + invoice.id); showIssued(fresh.invoice, back); }));
    }, back);
  }
  function paymentForm(invoice, cancel, back) {
    show(html`<form id="wiPaymentForm" class="wi-sheet wi-choice">${title("Payment record", invoice.number)}<div class="wi-body wi-section"><label class="wi-check"><input id="wiPaymentPaid" type="checkbox" ${invoice.payment.paid ? raw("checked") : ""}><span>Payment has been received in full</span></label>${field("Payment date", html`<input id="wiPaymentDate" type="date" value="${invoice.payment.paidDate || today()}">`)}${field("Payment reference (optional)", textInput("wiPaymentReference", invoice.payment.reference, 180))}<p class="hint">Uncheck payment received to correct a mistaken record. The invoice amounts and original document remain unchanged.</p></div>${footer("Save payment record", "Keep invoice")}</form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        const paid = form.querySelector("#wiPaymentPaid").checked;
        const result = await api("PATCH", root + `/invoices/${invoice.id}/payment`, { ifVersion: invoice.payment.version, paid, ...(paid ? { paidDate: form.querySelector("#wiPaymentDate").value } : {}), reference: form.querySelector("#wiPaymentReference").value.trim() });
        showIssued(result.invoice, back); toast(paid ? "Payment recorded." : "Invoice marked unpaid.");
      });
    }, cancel);
  }
  async function openOrder(row, back = () => { closeSheet(); reload(); }) {
    if (row.preview !== false) { toast("Staff preview orders do not issue VAT invoices."); return; }
    const [existing, config] = await Promise.all([api("GET", root + `/orders/${row.id}/invoice`), api("GET", root + "/invoice-settings")]);
    if (existing.invoice) { showIssued(existing.invoice, back, row.id); pendingReviews.delete(row.id); return; }
    const pending = pendingReviews.get(row.id);
    if (pending) { previewInvoice(pending.invoice, pending.payload, pending.edit, back); return; }
    if (!config.ready) {
      show(html`<div id="wiSetupRequired" class="wi-sheet wi-choice">${title("Set up invoicing first")}<div class="wi-body wi-section"><p>Complete your business details, VAT configuration and numbering before reviewing an invoice.</p><ul>${config.reasons.map((reason) => html`<li>${reason}</li>`)}</ul><button class="btn" type="button" data-sheet="wi-setup">Open invoice settings</button></div>${footer(null, "Back to order")}</div>`, (action) => { if (action === "wi-setup") openSettings(() => openOrder(row, back)); }, back); return;
    }
    invoiceForm(row, config, back);
  }
  function orderPanel(row) {
    if (row.preview !== false) return html``;
    return html`<section class="w-order-section" aria-labelledby="wiOrderTitle"><h3 id="wiOrderTitle">Invoice</h3><p class="hint">Review VAT, billing details and the agreed payment terms, or open the invoice already issued for this order.</p><button class="btn soft" type="button" data-sheet="invoice-open">Open invoice</button></section>`;
  }
  return {
    view, orderPanel, openOrder, openSettings,
    async act(name, id) {
      if (name === "wh-invoice-quickbooks") { await quickbooks.open(); return true; }
      if (name === "wh-invoice-settings") { await openSettings(); return true; }
      if (name === "wh-invoice-open") { const result = await api("GET", root + "/invoices/" + encodeURIComponent(id)); showIssued(result.invoice); return true; }
      if (name === "wh-invoice-more" && cursor && !loadingMore) { loadingMore = true; try { listPages++; await reload(); } finally { loadingMore = false; } return true; }
      return false;
    },
  };
};
