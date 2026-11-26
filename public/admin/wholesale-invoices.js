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
  function status(invoice) {
    const state = invoice.payment?.status;
    const labels = { voided: "Voided", review: "Balance unconfirmed", settled: "No payment due", paid: "Paid", "part-paid": "Part paid", overdue: "Overdue" };
    const tone = state === "voided" || state === "settled" ? "" : state === "paid" ? "ok" : state === "overdue" ? "bad" : "warn";
    return html`<span class="pill ${tone}">${labels[state] || "Unpaid"}</span>${state !== "voided" && invoice.payment?.hasVoidedPayment ? html`<span class="pill warn">Payment voided</span>` : ""}`;
  }
  const checked = (value) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value)) : "Not checked yet";
  const title = (heading, subtitle = "", returnToRegister = false) => html`<header class="wi-head">
    ${returnToRegister ? html`<button class="btn soft wi-register-back" type="button" data-sheet="wi-back">${svg("chev")}Back to invoices</button>` : ""}
    <div><h2 id="sheetTitle" tabindex="-1">${heading}</h2>${subtitle ? html`<p>${subtitle}</p>` : ""}</div>
    <button class="btn soft wi-close" type="button" data-sheet="wi-back" aria-label="Close invoice window">${svg("x")}</button>
  </header>`;
  const footer = (submit, back = "Cancel") => html`<footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row"><button class="btn soft" type="button" data-sheet="wi-back">${back}</button>${submit ? html`<button class="btn" type="submit">${submit}</button>` : ""}</div></footer>`;
  let invoices = [], count = 0, cursor = null, listPages = 1, loadingMore = false, configCache = null, autoCache = null;
  let queue = "all", query = "", selectedInvoiceId = "", searchTimer, generation = 0, invoiceOpenRequest = 0, savingPreference = false;
  const pendingReviews = new Map();
  function setFilter(value) {
    queue = value; listPages = 1; selectedInvoiceId = "";
    workspace.select(value === "overdue" || value === "soon" ? "collections" : "invoices");
  }
  function listUrl(filter, after) {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("queue", filter);
    if (query.trim()) params.set("q", query.trim());
    if (after) params.set("cursor", after);
    return root + "/invoices" + (params.size ? "?" + params : "");
  }
  function search(value) {
    query = value; listPages = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!$("#wiSearch")) return;
      await reload();
      $("#wiSearch")?.focus({ preventScroll: true });
    }, 220);
  }
  const workflows = window.WholesaleInvoiceWorkflows({ api, html, title, footer, field, show, busy, money, date, checked });
  const quickbooks = window.WholesaleQuickBooks({api,html,raw,svg,show,title,footer,field,busy,closeSheet,reload,toast,workflows});
  const workspace = window.WholesaleInvoiceWorkspace({api,html,raw,svg,show,title,footer,field,busy,closeSheet,reload,toast,money,date,today,checked,openInvoice,openReminder,openBillingReview});

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
    const focus = form.contains(document.activeElement) ? document.activeElement : null;
    const controls = [...form.querySelectorAll("button,input,textarea,select")].map((control) => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    const error = form.querySelector("#wiError"); if (error) error.textContent = "";
    try { await work(); }
    catch (problem) { if (form.isConnected && error) { error.textContent = problem.message; error.scrollIntoView({ block: "nearest" }); } else toast(problem.message); }
    finally {
      delete form.dataset.wiBusy; form.removeAttribute("aria-busy");
      controls.forEach(([control, wasDisabled]) => { if (control.isConnected) control.disabled = wasDisabled; });
      if (focus?.isConnected && document.activeElement === document.body) focus.focus({ preventScroll: true });
    }
  }
  function choose(heading, choices, selected, apply, back) {
    show(html`<div class="wi-sheet wi-choice">${title(heading)}<div class="wi-body"><div class="group" id="wiChoiceList">${choices.map((choice) => html`<button class="item" type="button" data-sheet="wi-choice" data-value="${choice.id}" aria-pressed="${String(choice.id === selected)}"><span class="tx"><b>${choice.label}</b>${choice.note ? html`<span>${choice.note}</span>` : ""}</span><span class="end">${choice.id === selected ? svg("ok") : ""}</span></button>`)}</div></div>${footer(null, "Keep current choice")}</div>`, (action, element) => { if (action === "wi-choice") apply(element.dataset.value); }, back);
  }
  function summary(data) {
    return html`<section class="glass group iw-panel iw-register-summary"><header><h3>Ledger totals</h3></header><dl class="iw-pairs">
      ${[["Issued invoices", data.count], ["Outstanding", money(data.outstandingPence)], ["Overdue", money(data.overduePence)]].map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}
      </dl>${data.reviewCount ? html`<p class="hint iw-note"><span class="num">${data.reviewCount}</span> ${data.reviewCount === 1 ? "invoice needs" : "invoices need"} review. Totals use verified balances.</p>` : ""}</section>`;
  }
  function balanceText(payment) {
    if (payment.status === "review" || payment.outstandingPence == null) return "Balance unconfirmed";
    if (payment.status === "voided") return "Voided in QuickBooks · £0.00 due";
    return payment.outstandingPence ? money(payment.outstandingPence) + " outstanding" : "£0.00 due";
  }
  function registerPreview(invoice) {
    const { payment } = invoice;
    const due = payment.dueDate ?? invoice.dueDate;
    const total = payment.totalPence ?? invoice.totals.grossPence;
    const issue = invoice.accounting?.invoiceIssue || invoice.billingException?.reason || invoice.accounting?.reason;
    return html`<section class="glass group iw-panel iw-register-preview" aria-label="Selected invoice">
      <div class="iw-panel-body">
        <div class="wi-issued-status">${status(invoice)}</div>
        <div class="iw-preview-title"><h3><span class="num">${invoice.billTo.name}</span></h3><p class="hint"><span class="num">${invoice.number}</span> · ${date(invoice.invoiceDate)}</p></div>
        <dl class="iw-pairs">
          <div><dt>Invoice total</dt><dd>${money(total)}</dd></div>
          <div><dt>Payment balance</dt><dd>${balanceText(payment)}</dd></div>
          ${due && payment.outstandingPence > 0 ? html`<div><dt>Payment due</dt><dd>${date(due)}</dd></div>` : ""}
          ${payment.checkedAt ? html`<div><dt>Last checked</dt><dd>${checked(payment.checkedAt)}</dd></div>` : ""}
        </dl>
        ${issue ? html`<p class="wi-workflow-note">${issue}</p>` : ""}
        <div class="wi-workflow-actions">
          <button class="btn soft sm" type="button" data-act="wh-invoice-document" data-id="${invoice.id}">Open invoice</button>
          <a class="btn soft sm" href="${root}/invoices/${invoice.id}/pdf" target="_blank" rel="noopener">${svg("dl")}PDF</a>
        </div>
      </div>
    </section>`;
  }
  function invoiceRow(invoice, collections) {
    const { payment } = invoice;
    const closed = payment.status === "voided" || payment.status === "settled";
    const dueDate = payment.dueDate ?? invoice.dueDate;
    const due = closed || payment.paid || payment.status === "review" ? "" : dueDate ? "Due " + date(dueDate) : invoice.paymentTerms.label;
    const amount = closed ? money(0) : collections && payment.outstandingPence !== null ? money(payment.outstandingPence) : money(payment.totalPence ?? invoice.totals.grossPence);
    const tone = payment.status === "paid" ? "ok" : payment.status === "overdue" ? "bad" : payment.status === "review" ? "warn" : closed ? "mut" : "acc";
    const icon = tone === "ok" ? "ok" : tone === "warn" ? "warn" : "doc";
    const location = invoice.deliveryLocation?.name;
    return html`<button class="item wi-invoice-row" type="button" data-act="wh-invoice-open" data-id="${invoice.id}" data-selected="${String(String(invoice.id) === selectedInvoiceId)}" aria-haspopup="dialog">
      <span class="ic ${tone}">${svg(icon)}</span>
      <span class="tx"><b>${invoice.billTo.name}</b>${location && location !== invoice.billTo.name ? html`<span class="num iw-register-origin">${location}</span>` : ""}
        <span class="iw-register-meta"><span class="num">${invoice.number}</span><span aria-hidden="true">·</span><span class="num">${due || date(invoice.invoiceDate)}</span></span></span>
      <span class="iw-register-money"><b class="num">${amount}</b><span>${closed || collections ? "Due" : "Invoice total"}</span></span>
      <span class="wi-issued-status">${status(invoice)}</span>
      <span class="chev">${svg("chev")}</span>
    </button>`;
  }
  async function view() {
    const started = ++generation;
    const active = workspace.current(), collections = active === "collections";
    const configFetch = api("GET", root + "/invoice-settings");
    if (active !== "invoices" && !collections) {
      const [config, content, automatic] = await Promise.all([
        configFetch,
        active === "accounts" ? workspace.accountsView() : active === "reconciliation" ? workspace.reconciliationView() : workspace.todayView(),
        active === "today" ? api("GET", root + "/auto-invoicing").catch(() => null) : null,
      ]);
      if (started !== generation) return html``;
      configCache = config; autoCache = automatic;
      return html`<section class="wi-workspace iw-workspace" aria-label="Invoicing">
        ${workspace.nav()}${!config.ready ? setupPanel() : ""}${content}
        ${automatic ? autoPanel(automatic, config) : ""}${active === "today" ? html`${customerSwitch(config)}${numberingSwitch(config)}` : ""}
      </section>`;
    }
    const filter = collections ? (queue === "soon" ? "soon" : "overdue") : (queue === "review" ? "review" : "all");
    const [config, first] = await Promise.all([configFetch, api("GET", listUrl(filter))]);
    if (started !== generation) return html``;
    configCache = config; invoices = first.invoices; cursor = first.nextCursor; count = first.count;
    for (let page = 1; page < listPages && cursor; page++) {
      const next = await api("GET", listUrl(filter, cursor));
      if (started !== generation) return html``;
      invoices = [...new Map([...invoices, ...next.invoices].map((invoice) => [invoice.id, invoice])).values()]; cursor = next.nextCursor; count = next.count;
    }
    const filters = collections ? [["overdue", "Overdue"], ["soon", "Due in 7 days"]] : [["all", "All invoices"], ["review", "Needs review"]];
    const selected = invoices.find(invoice => String(invoice.id) === selectedInvoiceId) || invoices[0];
    selectedInvoiceId = selected ? String(selected.id) : "";
    return html`<section class="wi-workspace iw-workspace" aria-label="Invoicing">${workspace.nav()}
      ${collections ? workspace.heading("Collections", "Outstanding balances and payment reminders.") : ""}
      ${!config.ready ? setupPanel() : ""}
      <div class="iw-register">
      <section class="wi-records group glass iw-panel" aria-labelledby="wiListTitle"><header>
        <div class="iw-records-heading"><h3 id="wiListTitle">${collections ? filter === "overdue" ? "Overdue invoices" : "Due in 7 days" : "Issued invoices"}</h3>
          <span class="hint" aria-live="polite">${invoices.length} of ${count}</span></div>
        ${collections ? "" : html`<button class="btn sm" type="button" data-act="wh-invoice-batch">Create batch</button>`}
      </header>
        <div class="iw-list-tools"><label class="search">${svg("search")}<input id="wiSearch" type="search" aria-label="Search invoices" placeholder="Search invoice number or business" maxlength="120" value="${query}"></label>
          <div class="w-queue-controls" role="group" aria-label="Invoice queues">${filters.map(([id,label]) => html`<button class="btn sm soft" type="button" data-act="wh-invoice-queue" data-id="${id}" aria-pressed="${String(filter === id)}">${label}</button>`)}</div>
        </div>
        <div class="iw-list">${invoices.length ? invoices.map(invoice => html`<div class="iw-register-row">${invoiceRow(invoice, collections)}
          ${collections && filter === "overdue" && invoice.payment.source === "quickbooks" ? html`<div class="iw-register-actions"><button class="btn soft sm" type="button" data-act="wh-invoice-reminder" data-id="${invoice.id}">${svg("mail")}Preview reminder</button></div>` : ""}
        </div>`) : html`<div class="w-empty"><span class="ic mut">${svg("dl")}</span><h3>${filter !== "all" || query.trim() ? "No matching invoices" : "No invoices yet"}</h3></div>`}</div>
        ${cursor ? html`<div class="w-more"><button class="btn soft" type="button" data-act="wh-invoice-more">Load earlier invoices</button></div>` : ""}
      </section>
      <div class="iw-stack iw-register-context"><div id="iwRegisterPreview">${selected ? registerPreview(selected) : ""}</div>${summary(first.summary)}</div>
      </div></section>`;
  }
  function setupPanel() {
    return html`<div class="wi-setup group"><h3>Complete your invoice settings</h3><p>Add your legal business details, VAT rates and invoice numbering before issuing an invoice.</p><button class="btn soft" type="button" data-act="wh-invoice-settings">Set up invoicing</button></div>`;
  }
  const invoiceSwitch = (titleId, action, on, enabled = true, id = "") => html`<button class="wi-switch" type="button" role="switch" aria-checked="${String(on)}" aria-labelledby="${titleId}" data-act="wh-invoice-${action}" data-id="${id}" ${enabled ? "" : raw("disabled")}>
    <span class="wi-switch-track" aria-hidden="true"><span class="wi-switch-thumb"></span></span><span class="wi-switch-label">${on ? "On" : "Off"}</span>
  </button>`;
  async function savePreference(save) {
    if (savingPreference) return;
    savingPreference = true;
    const controls = [...document.querySelectorAll(".iw-workspace .wi-switch")];
    controls.forEach(control => control.setAttribute("aria-disabled", "true"));
    try { await save(); }
    finally {
      savingPreference = false;
      controls.forEach(control => control.removeAttribute("aria-disabled"));
    }
  }
  function confirmPreference(heading, detail, label, action) {
    show(html`<form id="wiConfirmPreference" class="wi-sheet wi-choice">${title(heading)}
      <div class="wi-body"><p>${detail}</p></div>${footer(label, "Cancel")}</form>`, async (name, _element, form) => {
      if (name === "submit") await busy(form, async () => { await action(); closeSheet(); });
    }, closeSheet);
  }
  // One number series with QuickBooks (src/quickbooks/sharedNumber.ts; the owner's request, 25 Nov 2026).
  function numberingSwitch(config) {
    const on = !!config.settings.sharedNumbering;
    return html`<div class="wi-customer-switch group glass"><div><h3 id="wiNumberingTitle">Use QuickBooks invoice numbers</h3><p class="hint">${on ? "New invoices use the next number in QuickBooks. Automatic invoices and batches wait when the company is unavailable." : `New invoices use the site's own series, with the prefix ${config.settings.invoicePrefix || "from Invoice settings"}.`}</p></div>${invoiceSwitch("wiNumberingTitle", "numbering", on)}</div>`;
  }
  // Admin's switch for what customers see: My orders → Invoices, invoice PDFs and balances. Issuing here is unaffected.
  function customerSwitch(config) {
    const on = config.settings.customersSeeInvoices !== false;
    return html`<div class="wi-customer-switch group glass"><div><h3 id="wiCustomersTitle">Invoices for customers</h3><p class="hint">${on ? "Customers can see their invoices, balances and PDFs in Orders & invoices." : "Invoices are visible to Admin only."}</p></div>${invoiceSwitch("wiCustomersTitle", "customers", on)}</div>`;
  }
  // Automatic invoicing (src/autoInvoice.ts): three switches, each needing the one before, and what's waiting or recent.
  const AUTO_STATES = { pending: "Waiting", issued: "Invoiced, not sent yet", exporting: "Sending to QuickBooks", held: "Needs attention", done: "Done", skipped: "Left to do by hand" };
  function autoSwitch(id, heading, hint, on, enabled) {
    return html`<div class="wi-auto-row"><h4 id="wiAuto-${id}">${heading}</h4><p class="hint">${hint}</p>${invoiceSwitch("wiAuto-" + id, "auto", on, enabled, id)}</div>`;
  }
  function autoItem(item) {
    const qb = item.quickbooks, where = qb ? (qb.environment === "production" ? "QuickBooks" : "QuickBooks Sandbox") : "";
    const detail = [item.invoiceNumber ? "Invoice " + item.invoiceNumber : "", qb ? `${where}: ${qb.state === "linked" ? "sent" : qb.state}` : "", qb?.email === "sent" ? "emailed" : ""].filter(Boolean).join(" · ");
    const open = ["pending", "issued", "exporting", "held"].includes(item.state);
    return html`<div class="wi-auto-item" data-state="${item.state}"><div class="tx"><b>${item.business || "Customer"}${item.kind === "tab" ? " · tab" : ""}</b><span class="wi-auto-state">${AUTO_STATES[item.state] || item.state}${detail ? " · " + detail : ""}</span>${item.reason ? html`<span class="hint">${item.reason}</span>` : ""}</div>${open ? html`<div class="row">${qb?.billingReview ? html`<button class="btn sm soft" type="button" data-act="wh-invoice-billing-review" data-id="${item.source}">Review billing address</button>` : html`<button class="btn sm soft" type="button" data-act="wh-invoice-auto-retry" data-id="${item.source}">Try again</button>`}<button class="btn sm soft" type="button" data-act="wh-invoice-auto-skip" data-id="${item.source}">Do by hand</button></div>` : ""}</div>`;
  }
  function autoPanel(auto, config) {
    const s = auto.settings, waiting = auto.items.filter((item) => ["pending", "issued", "exporting", "held"].includes(item.state)), recent = auto.items.filter((item) => !waiting.includes(item)).slice(0, 20);
    const since = s.since ? new Date(s.since).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }) : "";
    return html`<section class="wi-auto group glass" aria-labelledby="wiAutoTitle"><div class="wi-auto-head"><h3 id="wiAutoTitle">Automatic invoicing</h3></div>
      ${!config.ready ? html`<p class="wi-reasons">Finish the invoice settings first: automatic invoices use them.</p>` : ""}
      ${autoSwitch("issue", "Invoice dispatched orders", `On-dispatch accounts are invoiced when orders go out. Monthly accounts are reviewed in a batch. Tabs invoice when cleared.${since ? ` On since ${since}.` : ""}`, s.issue, config.ready || s.issue)}
      ${autoSwitch("quickbooks", "Send to QuickBooks", `Adds any missing customers and coffees to QuickBooks.${s.quickbooks && s.enabledByName ? ` Sent as ${s.enabledByName}.` : ""}`, s.quickbooks, s.issue)}
      ${autoSwitch("email", "Email from QuickBooks", "To the customer's accounts email, or order email. On Sandbox, to your own invoice email.", s.email, s.quickbooks)}
      ${waiting.length ? html`<div class="label">Waiting or needs attention <span class="count">${waiting.length}</span></div><div class="wi-auto-list">${waiting.map(autoItem)}</div>` : ""}
      ${recent.length ? html`<details class="wi-auto-recent"><summary>${svg("chev")}Recent automatic invoices</summary><div class="wi-auto-list">${recent.map(autoItem)}</div></details>` : ""}
    </section>`;
  }
  async function autoToggle(id) {
    if (!autoCache || savingPreference) return;
    const s = autoCache.settings, next = { issue: s.issue, quickbooks: s.quickbooks, email: s.email };
    next[id] = !s[id];
    if (!next.issue) { next.quickbooks = false; next.email = false; }
    if (!next.quickbooks) next.email = false;
    const save = () => savePreference(async () => {
      try { autoCache = await api("PUT", root + "/auto-invoicing", { ifVersion: autoCache.version, ...next }); toast(next[id] ? "Switched on" : "Switched off"); }
      finally { await reload(); }
    });
    if (id === "quickbooks" && next.quickbooks) {
      confirmPreference("Send automatic invoices to QuickBooks", "New automatic invoices will post to the active company. QuickBooks may add missing customers and coffee items.", "Enable automatic posting", save);
    } else if (id === "email" && next.email) {
      confirmPreference("Email automatic invoices", "Live invoices go to the customer’s billing email. In Sandbox, invoice emails go to your test inbox.", "Enable automatic email", save);
    } else await save();
  }
  function settingsDraft(form, state) {
    const value = (id) => form.querySelector("#" + id).value.trim();
    return { ...clone(state), seller: { legalName: value("wiLegalName"), address: value("wiSellerAddress"), vatNumber: value("wiVatNumber"), companyNumber: value("wiCompanyNumber"), email: value("wiSellerEmail"), phone: value("wiSellerPhone") }, invoicePrefix: value("wiPrefix"), firstInvoiceNumber: Number(value("wiFirstNumber")), paymentInstructions: value("wiPaymentInstructions"), confirmed: form.querySelector("#wiConfirmed").checked, scrollTop: form.querySelector(".wi-body").scrollTop };
  }
  async function openSettings(back = () => { closeSheet(); reload(); }, draft = null, received = null) {
    const [config, listed] = received || await Promise.all([api("GET", root + "/invoice-settings"), api("GET", root + "/invoices")]);
    configCache = config;
    const state = draft || clone(config.settings), rates = state.vatRates, rateLabel = (id) => rates.find((rate) => rate.id === id)?.label || "Choose a rate";
    const form = show(html`<form id="wiSettingsForm" class="wi-sheet wi-wide">
      ${title("Invoice settings", "Supplier details, VAT and payment instructions")}
      <div class="wi-body">
        <div class="wi-settings-grid wi-editor-grid">
          <section class="wi-section wi-form-section">
            <h3>Supplier details</h3>
            ${field("Legal business name", textInput("wiLegalName", state.seller.legalName))}
            ${field("Registered business address", textarea("wiSellerAddress", state.seller.address, 1000))}
            <div class="wi-field-row">
              ${field("VAT registration number", textInput("wiVatNumber", state.seller.vatNumber, 40))}
              ${field("Company number (optional)", textInput("wiCompanyNumber", state.seller.companyNumber, 40))}
            </div>
            ${field("Invoice email (optional)", textInput("wiSellerEmail", state.seller.email, 150, "email"))}
            ${field("Phone (optional)", textInput("wiSellerPhone", state.seller.phone, 40, "tel"))}
          </section>
          <div class="wi-form-stack">
            <section class="wi-section wi-form-section">
              <h3>VAT</h3>
              <div class="field"><span class="fl">Saved order prices</span><button class="wi-picker" type="button" data-sheet="wi-settings-choice" data-key="priceBasis">${state.priceBasis === "inclusive" ? "Include VAT" : state.priceBasis === "exclusive" ? "Exclude VAT" : "Choose price basis"}${svg("chev")}</button></div>
              <div class="wi-section-heading"><h4>VAT rates</h4><button class="btn sm soft" type="button" data-sheet="wi-rate-add">${svg("plus")}Add rate</button></div>
              <div class="group wi-rate-list">${rates.length ? rates.map((rate, index) => html`<button class="item" type="button" data-sheet="wi-rate-edit" data-index="${index}"><span class="tx"><b>${rate.label}</b></span><span class="end"><span class="pill">${percent(rate.basisPoints)}</span><span class="chev">${svg("chev")}</span></span></button>`) : html`<p class="hint iw-note">Add your VAT rates.</p>`}</div>
              <div class="wi-field-row">${[["defaultCoffeeRateId", "Default coffee VAT rate"], ["deliveryRateId", "Default delivery VAT rate"]].map(([key, label]) => html`<div class="field"><span class="fl">${label}</span><button class="wi-picker" type="button" data-sheet="wi-settings-choice" data-key="${key}">${rateLabel(state[key])}${svg("chev")}</button></div>`)}</div>
            </section>
            <section class="wi-section wi-form-section">
              <div class="wi-section-heading"><h3>Invoice numbering</h3>${state.sharedNumbering ? html`<span class="pill acc">QuickBooks series active</span>` : ""}</div>
              <div class="wi-field-row">
                ${field("Invoice number prefix", textInput("wiPrefix", state.invoicePrefix, 20))}
                ${field("First invoice number", html`<input id="wiFirstNumber" type="number" min="1" max="999999999" step="1" value="${state.firstInvoiceNumber}" ${listed.count ? raw("disabled") : ""}>`)}
              </div>
              <p class="hint">${listed.count ? "The starting number is fixed after the first issue." : "Choose a starting number and a prefix unique to this invoice series."}</p>
            </section>
          </div>
          <section class="wi-section wi-form-section wi-full">
            <h3>Payment instructions</h3>
            ${field("Shown on invoices", textarea("wiPaymentInstructions", state.paymentInstructions, 2000))}
            <label class="wi-check"><input id="wiConfirmed" type="checkbox" ${state.confirmed ? raw("checked") : ""}><span>I’ve checked the supplier details, VAT configuration and invoice numbering.</span></label>
            <div class="wi-reasons" id="wiSetupStatus" ${config.ready ? raw("hidden") : ""}><p>Saved setup still needs</p><ul>${config.reasons.map((reason) => html`<li>${reason}</li>`)}</ul></div>
          </section>
        </div>
      </div>${footer("Save invoice settings")}</form>`, async (action, element, current) => {
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
    return html`<section class="wi-section">
      <h3>Line items</h3>
      <div class="wi-table-wrap" role="region" aria-label="Invoice line items">
        <table class="wi-table" role="table" aria-label="Invoice prices">
          <thead role="rowgroup"><tr role="row"><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Net</th><th scope="col">VAT</th><th scope="col">Total</th></tr></thead>
          <tbody role="rowgroup">${invoice.lines.map((line) => html`<tr role="row">
            <td role="cell"><b>${line.description}</b>${line.packLabel || line.grindLabel ? html`<span>${[line.packLabel, line.grindLabel].filter(Boolean).join(" · ")}</span>` : ""}</td>
            <td role="cell" data-label="Qty">${line.quantity}</td><td role="cell" data-label="Net">${money(line.netPence)}</td>
            <td role="cell" data-label="VAT">${money(line.vatPence)}<span>${percent(line.vatBasisPoints)}</span></td>
            <td role="cell" data-label="Total"><b>${money(line.grossPence)}</b></td>
          </tr>`)}</tbody>
        </table>
      </div>
    </section>`;
  }
  function totals(invoice) {
    return html`<dl class="wi-totals"><div><dt>Net subtotal</dt><dd>${money(invoice.totals.netPence)}</dd></div><div><dt>VAT</dt><dd>${money(invoice.totals.vatPence)}</dd></div><div class="wi-total"><dt>${invoice.payment?.status === "voided" || invoice.accounting?.invoiceChanged ? "Original invoice total" : "Invoice total"}</dt><dd>${money(invoice.totals.grossPence)}</dd></div></dl>`;
  }
  function details(invoice, accountAction = "") {
    const voided = invoice.payment?.status === "voided";
    const facts = [["Invoice date", date(invoice.invoiceDate)], ["Supply date", date(invoice.supplyDate)]];
    if (!voided) facts.push(["Payment terms", invoice.paymentTerms.label], ["Payment due", invoice.dueDate ? date(invoice.dueDate) : "No due date recorded"]);
    if (invoice.deliveryLocation?.name) facts.push(["Location", invoice.deliveryLocation.name]);
    return html`
      <div class="wi-invoice-meta">
        <section class="wi-section wi-document-meta"><div class="wi-section-heading"><h3>Bill to</h3>${accountAction}</div>
          <strong>${invoice.billTo.name}</strong><p class="wi-address">${[invoice.billTo.address, invoice.billTo.postcode].filter(Boolean).join("\n")}</p>
          ${invoice.billTo.vatNumber ? html`<p class="hint">Customer VAT no. ${invoice.billTo.vatNumber}</p>` : ""}
        </section>
        <section class="wi-section wi-document-meta"><h3>${voided ? "Dates" : "Dates and terms"}</h3>
          <dl class="iw-pairs">${facts.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>
          ${!voided && invoice.paymentTerms.note ? html`<p class="hint">${invoice.paymentTerms.note}</p>` : ""}
        </section>
      </div>
      ${invoiceLines(invoice)}
      <div class="wi-document-totals">
        <section class="wi-section"><h3>VAT breakdown</h3><dl class="iw-pairs">${invoice.vatBreakdown.map(rate => html`<div><dt>${rate.label} · ${percent(rate.basisPoints)}</dt><dd>${money(rate.netPence)} net · ${money(rate.vatPence)} VAT</dd></div>`)}</dl></section>
        ${totals(invoice)}
      </div>
      ${!voided && invoice.paymentInstructions ? html`<section class="wi-section wi-document-meta"><h3>How to pay</h3><p class="wi-address">${invoice.paymentInstructions}</p></section>` : ""}`;
  }
  function draftPayload(form, row, config, state) {
    const value = (id) => form.querySelector("#" + id).value.trim();
    const amount = value("wiDeliveryPounds");
    const dueDate = form.querySelector("#wiDueDate")?.value;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error("Enter the delivery charge in pounds and pence.");
    return { orderVersion: row.version, settingsVersion: config.version, billingRevision: state.billingRevision, invoiceDate: value("wiInvoiceDate"), supplyDate: value("wiSupplyDate"), billTo: { name: value("wiBillName"), address: value("wiBillAddress"), postcode: value("wiBillPostcode"), vatNumber: value("wiBillVat") }, deliveryCharge: { pence: Math.round(Number(amount) * 100), description: value("wiDeliveryDescription"), vatRateId: state.deliveryVatRateId || "" }, lineVatRateIds: state.lineVatRateIds, paymentInstructions: value("wiInvoiceInstructions"), ...(dueDate ? { dueDate } : {}) };
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
    const state = restored || { invoiceDate: today(), supplyDate: today(), billingRevision: row.billing?.revision, billTo: row.billing?.billTo || { name: row.business || row.customerSnapshot?.business || "", address: row.customerSnapshot?.address || "", postcode: row.customerSnapshot?.postcode || "", vatNumber: "" }, deliveryPounds: orderDeliveryPounds(row, config), deliveryDescription: row.delivery === "Delivery" ? "Delivery" : "Roastery collection", deliveryVatRateId: config.settings.deliveryRateId, lineVatRateIds: row.lines.map(() => config.settings.defaultCoffeeRateId), paymentInstructions: config.settings.paymentInstructions, dueDate: "" };
    const rateLabel = (id) => config.settings.vatRates.find((rate) => rate.id === id)?.label || "Choose a VAT rate";
    const paymentTerms = row.paymentTerms ?? row.customerSnapshot?.paymentTerms;
    const beforeDispatch = paymentTerms?.id === "before-dispatch";
    const fixedDueDate = beforeDispatch || /^net-(7|14|30|60)$/.test(paymentTerms?.id || "");
    const dueDateField = fixedDueDate
      ? html`<p class="hint">${beforeDispatch ? "Payment is due on the invoice date, before dispatch." : "The due date is calculated from the agreed invoice terms."}</p>`
      : field("Payment due date (optional)", html`<input id="wiDueDate" type="date" value="${state.dueDate}">`);
    const form = show(html`<form id="wiInvoiceForm" class="wi-sheet wi-wide">
      ${title("Prepare VAT invoice", row.business + " · " + (row.reference || row.id))}
      <div class="wi-body"><div class="wi-settings-grid wi-editor-grid">
        <section class="wi-section wi-form-section">
          <h3>Billing details</h3>
          ${field("Billing business name", html`<input id="wiBillName" maxlength="180" value="${state.billTo.name}" required>`)}
          ${field("Billing address", html`<textarea id="wiBillAddress" maxlength="1000" required>${state.billTo.address}</textarea>`)}
          <div class="wi-field-row">${field("Postcode", textInput("wiBillPostcode", state.billTo.postcode, 20))}
            ${field("Customer VAT number (optional)", textInput("wiBillVat", state.billTo.vatNumber, 40))}</div>
        </section>
        <section class="wi-section wi-form-section">
          <h3>Dates and terms</h3>
          <div class="wi-field-row">${field("Invoice date", html`<input id="wiInvoiceDate" type="date" value="${state.invoiceDate}" required>`)}
            ${field("Supply date / tax point", html`<input id="wiSupplyDate" type="date" value="${state.supplyDate}" required>`)}</div>
          <p class="wi-workflow-note">${paymentTerms?.label || "To be agreed"}${paymentTerms?.note ? " · " + paymentTerms.note : ""}</p>
          ${dueDateField}
        </section>
        <section class="wi-section wi-form-section wi-full">
          <h3>Saved order lines</h3><p class="hint">Choose the VAT rate for each line.</p>
          <div class="group wi-rate-list">${row.lines.map((line, index) => html`<div class="item wi-line-rate"><span class="tx"><b>${line.quantity} × ${line.title}</b><span>${line.packLabel} · ${line.grindLabel} · ${money(line.price)} per bag</span></span><button class="btn soft" type="button" data-sheet="wi-line-rate" data-index="${index}">${rateLabel(state.lineVatRateIds[index])}</button></div>`)}</div>
        </section>
        <section class="wi-section wi-form-section">
          <h3>Delivery charge</h3>
          <div class="wi-field-row wi-delivery-fields">${field("Charge (£)", html`<input id="wiDeliveryPounds" inputmode="decimal" value="${state.deliveryPounds}" required>`)}
            ${field("Description", textInput("wiDeliveryDescription", state.deliveryDescription))}</div>
          <div class="field"><span class="fl">Delivery VAT rate</span><button class="wi-picker" type="button" data-sheet="wi-delivery-rate">${rateLabel(state.deliveryVatRateId)}${svg("chev")}</button></div>
        </section>
        <section class="wi-section wi-form-section">
          <h3>Payment instructions</h3>
          ${field("Shown on this invoice", textarea("wiInvoiceInstructions", state.paymentInstructions, 2000))}
          <p class="hint">The invoice keeps the payment terms agreed with this order.</p>
        </section>
      </div></div>${footer("Preview invoice", "Back to order")}</form>`, async (action, element, current) => {
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
  function linkedBalance(invoice) {
    const { payment, accounting } = invoice;
    const updatedTotal = Number.isSafeInteger(payment.totalPence) && payment.totalPence !== invoice.totals.grossPence;
    return html`<section class="wi-linked-balance wi-section" aria-label="QuickBooks balance"><div class="wi-section-heading">
      <div><h3>QuickBooks balance</h3><strong class="wi-current-amount num">${balanceText(payment)}</strong></div>
      <button class="btn soft sm" type="button" data-sheet="wi-refresh-balance">Refresh balance</button></div>
      ${updatedTotal ? html`<p class="hint">QuickBooks total ${money(payment.totalPence)}</p>` : ""}
      ${payment.outstandingPence > 0 && payment.dueDate ? html`<p class="hint">Due in QuickBooks ${date(payment.dueDate)}</p>` : ""}
      ${accounting?.invoiceIssue ? html`<p class="hint">${accounting.invoiceIssue}</p>` : ""}
      ${accounting?.reason ? html`<p class="hint">${accounting.reason}</p>` : payment.status === "review" ? html`<p class="hint">Waiting for a verified QuickBooks balance.</p>` : ""}
      <p class="hint" data-balance-feedback role="status">${payment.checkedAt ? "Last checked " + checked(payment.checkedAt) : ""}</p>
      <div class="wi-workflow-actions">
        ${workflows.billingIssue(accounting?.invoiceIssue) ? html`<button class="btn soft sm" type="button" data-sheet="wi-billing-review">Review billing address</button>` : ""}
        <button class="btn soft sm" type="button" data-sheet="wi-reminders">Payment reminders</button>
      </div>
    </section>`;
  }
  async function refreshLinkedBalance(form, invoice, reopen) {
    const control = '[data-sheet="wi-refresh-balance"]';
    const button = form.querySelector(control);
    const feedback = form.querySelector('[data-balance-feedback]');
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    feedback.textContent = "Checking QuickBooks…";
    const stillOpen = () => form.isConnected && !$("#scrim").hidden;
    try {
      await api("POST", root + "/quickbooks/exports/" + invoice.accounting.exportId + "/refresh?environment=production", {});
      if (!stillOpen()) return;
      const updated = await api("GET", root + "/invoices/" + invoice.id);
      if (!stillOpen()) return;
      if (form.dataset.wiBusy) { feedback.textContent = "Balance refreshed. Reopen the invoice to see the latest status."; return; }
      const scroll = form.querySelector(".wi-body").scrollTop;
      const focused = document.activeElement === button;
      const refreshed = reopen(updated.invoice);
      refreshed.querySelector(".wi-body").scrollTop = scroll;
      if (focused) refreshed.querySelector(control)?.focus({ preventScroll: true });
    } catch (error) {
      if (stillOpen()) feedback.textContent = error.message;
    } finally { button.removeAttribute("aria-disabled"); }
  }
  function showIssued(invoice, back = () => { closeSheet(); reload(); }, expectedOrderId = null, checkOnOpen = true, returnToRegister = false) {
    const coversOrder = !expectedOrderId || invoice?.orderId === expectedOrderId || invoice?.orderIds?.includes(expectedOrderId);
    if (!invoice || !coversOrder || !Number.isSafeInteger(invoice.id) || invoice.id < 1 || typeof invoice.number !== "string" || !invoice.number || !Array.isArray(invoice.lines) || !invoice.lines.length || !invoice.billTo || !invoice.payment || !invoice.totals || ["netPence", "vatPence", "grossPence"].some(key => !Number.isSafeInteger(invoice.totals[key]) || invoice.totals[key] < 0)) throw new Error("The invoice response was incomplete. Check the saved invoice before changing this review.");
    const managed = invoice.payment.source === "quickbooks" && Number.isSafeInteger(invoice.accounting?.exportId);
    const reopen = (fresh) => showIssued(fresh, back, expectedOrderId, false, returnToRegister);
    const refreshInvoice = async () => { const fresh = await api("GET", root + "/invoices/" + invoice.id); reopen(fresh.invoice); };
    const exception = invoice.billingException;
    const accountAction = invoice.customerId ? html`<button class="btn soft sm" type="button" data-sheet="wi-billing-account">Billing account</button>` : "";
    const panel = show(html`<div id="wiIssuedInvoice" class="wi-sheet wi-wide w-sensitive ${returnToRegister ? "wi-register-document" : ""}">${title(invoice.number, invoice.billTo.name, returnToRegister)}<div class="wi-body"><div class="wi-issued-heading wi-document-toolbar">
      <div class="wi-issued-status">${status(invoice)}</div><div class="wi-document-actions">
        <a class="btn" id="wiDownloadPdf" href="${root}/invoices/${invoice.id}/pdf" target="_blank" rel="noopener">${svg("dl")}Download PDF</a>
        <button class="btn soft" type="button" data-sheet="wi-quickbooks">${svg("db")}Open QuickBooks</button>
      </div></div>
      ${managed ? linkedBalance(invoice) : ""}
      ${exception && !managed ? html`<section class="wi-linked-balance wi-section"><div class="wi-section-heading"><h3>Billing address needs review</h3><span class="pill warn">Export held</span></div><p>${exception.reason}</p><button class="btn soft" type="button" data-sheet="wi-billing-review">Review billing address</button></section>` : ""}
      ${managed ? "" : html`<section class="wi-section wi-linked-balance" aria-label="Payment record">
        <div class="wi-section-heading"><div><h3>Payment record</h3><strong class="wi-current-amount num">${invoice.payment.paid && invoice.payment.paidDate ? "Paid on " + date(invoice.payment.paidDate) : balanceText(invoice.payment)}</strong></div>
        <button class="btn soft sm" type="button" data-sheet="wi-payment">${invoice.payment.paid ? "Correct payment record" : "Record payment received"}</button></div>
        ${invoice.payment.reference ? html`<p class="hint">Reference ${invoice.payment.reference}</p>` : ""}
      </section>`}
      ${details(invoice, accountAction)}
      ${invoice.billingHistory?.length ? workflows.billingActivity(invoice.billingHistory) : ""}
      </div>${footer(null, "Done")}</div>`, async (action, element, current) => {
      if (action === "wi-payment" && !managed) paymentForm(invoice, reopen);
      if (action === "wi-quickbooks") await busy(current, () => quickbooks.openInvoice(invoice, refreshInvoice));
      if (action === "wi-billing-account") await busy(current, () => workspace.openAccount(invoice.customerId, refreshInvoice));
      if (action === "wi-billing-review") await busy(current, () => workflows.openBilling(managed ? invoice.accounting.exportId : exception.exportId, managed ? "production" : exception.environment, refreshInvoice));
      if (action === "wi-reminders" && managed) await busy(current, () => workflows.openReminders(invoice, refreshInvoice));
      if (action === "wi-refresh-balance") await refreshLinkedBalance(current, invoice, reopen);
    }, back);
    if (managed && checkOnOpen && invoice.payment.status === "review") void refreshLinkedBalance(panel, invoice, reopen);
    return panel;
  }
  function paymentForm(invoice, reopen) {
    show(html`<form id="wiPaymentForm" class="wi-sheet wi-choice">${title("Payment record", invoice.number)}<div class="wi-body wi-section"><label class="wi-check"><input id="wiPaymentPaid" type="checkbox" ${invoice.payment.paid ? raw("checked") : ""}><span>Payment has been received in full</span></label>${field("Payment date", html`<input id="wiPaymentDate" type="date" value="${invoice.payment.paidDate || today()}">`)}${field("Payment reference (optional)", textInput("wiPaymentReference", invoice.payment.reference, 180))}<p class="hint">Uncheck payment received to correct a mistaken record. The invoice amounts and original document remain unchanged.</p></div>${footer("Save payment record", "Keep invoice")}</form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        const paid = form.querySelector("#wiPaymentPaid").checked;
        const result = await api("PATCH", root + `/invoices/${invoice.id}/payment`, { ifVersion: invoice.payment.version, paid, ...(paid ? { paidDate: form.querySelector("#wiPaymentDate").value } : {}), reference: form.querySelector("#wiPaymentReference").value.trim() });
        reopen(result.invoice); toast(paid ? "Payment recorded." : "Invoice marked unpaid.");
      });
    }, () => reopen(invoice));
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
    invoiceForm({ ...row, billing: existing.billing }, config, back);
  }
  function orderPanel(row) {
    if (row.preview !== false) return html``;
    return html`<section class="w-order-section" aria-labelledby="wiOrderTitle"><h3 id="wiOrderTitle">Invoice</h3><p class="hint">Review VAT, billing details and agreed payment terms.</p>
      <div class="wi-workflow-actions"><button class="btn soft" type="button" data-sheet="invoice-open">Open invoice</button>
      ${row.customerId ? html`<button class="btn soft" type="button" data-sheet="invoice-account">Billing account</button>` : ""}</div></section>`;
  }
  async function openInvoice(id, back, returnToRegister = false) {
    const opened = ++invoiceOpenRequest;
    const route = location.hash, view = workspace.current();
    const result = await api("GET", root + "/invoices/" + encodeURIComponent(id));
    if (opened !== invoiceOpenRequest || (returnToRegister && (route !== location.hash || view !== workspace.current()))) return;
    return showIssued(result.invoice, back, null, true, returnToRegister);
  }
  async function openBillingReview(id) {
    const { invoice } = await api("GET", root + "/invoices/" + encodeURIComponent(id));
    const exception = invoice.billingException;
    const linked = workflows.billingIssue(invoice.accounting?.invoiceIssue) && invoice.accounting?.exportId;
    if (linked || exception) {
      await workflows.openBilling(linked || exception.exportId, linked ? "production" : exception.environment, () => openInvoice(id));
    } else showIssued(invoice);
  }
  async function openReminder(id) {
    const path = root + "/invoices/" + encodeURIComponent(id);
    const { invoice } = await api("GET", path);
    return workflows.openReminders(invoice, async () => { await openInvoice(id); });
  }
  return {
    view, orderPanel, openOrder, openSettings, search, setFilter, openBillingAccount: workspace.openAccount,
    workspaceChange: workspace.change, accountsSearch: workspace.searchAccounts,
    state: () => ({ queue, query, listPages, selectedInvoiceId, workspace: workspace.state() }),
    restore(saved) { if (saved) { ({ queue, query, listPages, selectedInvoiceId = "" } = saved); workspace.restore(saved.workspace); } },
    resetList() { clearTimeout(searchTimer); queue = "all"; query = selectedInvoiceId = ""; listPages = 1; },
    clear() { generation++; invoiceOpenRequest++; clearTimeout(searchTimer); queue = "all"; query = selectedInvoiceId = ""; listPages = 1; configCache = null; invoices = []; pendingReviews.clear(); workspace.clear(); },
    async act(name, id) {
      if (name === "wh-invoice-queue") { setFilter(id); await reload(); return true; }
      if (name === "wh-invoice-quickbooks") { await quickbooks.open(); return true; }
      if (name === "wh-invoice-settings") { await openSettings(); return true; }
      if (name === "wh-invoice-billing-review") {
        const item = autoCache?.items.find((entry) => entry.source === id)?.quickbooks;
        if (item?.billingReview) await workflows.openBilling(item.id, item.environment, async () => { closeSheet(); await reload(); });
        return true;
      }
      if (name === "wh-invoice-customers" && configCache) {
        const on = configCache.settings.customersSeeInvoices !== false;
        await savePreference(async () => {
          try { configCache = await api("PUT", root + "/invoice-settings/customers", { ifVersion: configCache.version, enabled: !on }); toast(on ? "Invoices hidden from customers" : "Invoices shown to customers"); }
          finally { await reload(); }
        });
        return true;
      }
      if (name === "wh-invoice-numbering" && configCache) {
        const on = !!configCache.settings.sharedNumbering;
        const save = () => savePreference(async () => {
          try { configCache = await api("PUT", root + "/invoice-settings/numbering", { ifVersion: configCache.version, shared: !on }); toast(on ? "Using the site’s invoice numbers" : `QuickBooks series enabled. Next invoice ${configCache.nextNumber}.`); }
          finally { await reload(); }
        });
        if (!on) confirmPreference("Use QuickBooks invoice numbers", "New invoices will take the next number in the active QuickBooks company.", "Use QuickBooks numbers", save);
        else await save();
        return true;
      }
      if (name === "wh-invoice-auto") { await autoToggle(id); return true; }
      if (name === "wh-invoice-auto-retry" || name === "wh-invoice-auto-skip") {
        const skip = name.endsWith("skip");
        const save = async () => {
          try { autoCache = await api("POST", root + "/auto-invoicing/" + id + (skip ? "/skip" : "/retry"), {}); toast(skip ? "Left to do by hand" : "Retry requested"); }
          finally { await reload(); }
        };
        if (skip) confirmPreference("Leave this invoice to do by hand", "This removes the item from automatic processing. You can handle it from the order or the issued invoice.", "Do by hand", save);
        else await save();
        return true;
      }
      if (name === "wh-invoice-open" || name === "wh-invoice-document") {
        const preview = $("#iwRegisterPreview");
        const selected = preview && invoices.find(invoice => String(invoice.id) === id);
        if (selected && selectedInvoiceId !== id) {
          selectedInvoiceId = id;
          for (const row of document.querySelectorAll(".wi-invoice-row")) row.dataset.selected = String(row.dataset.id === id);
          put(preview, registerPreview(selected));
        }
        await openInvoice(id, undefined, !!selected);
        return true;
      }
      if (name === "wh-invoice-more" && cursor && !loadingMore) { loadingMore = true; try { listPages++; await reload(); } finally { loadingMore = false; } return true; }
      return workspace.act(name.slice("wh-invoice-".length), id);
    },
  };
};
