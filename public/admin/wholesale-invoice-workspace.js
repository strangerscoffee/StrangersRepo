// The Admin invoicing workspace shares the site's grouped lists, controls and invoice sheets.
window.WholesaleInvoiceWorkspace = function ({ api, html, raw, svg, title, footer, field, show, busy, reload, closeSheet, toast,
  money, date, today, checked, openInvoice, openReminder }) {
  const root = "/api/admin/wholesale/invoicing";
  const tabs = [["today", "Today"], ["accounts", "Billing accounts"], ["invoices", "Invoices"], ["collections", "Collections"], ["reconciliation", "Reconciliation"]];
  const defaultMonth = () => today().slice(0, 7);
  const monthName = (value) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(value + "-15T00:00:00Z"));
  const scheduleLabel = (value) => value === "monthly" ? "Monthly" : "On dispatch";
  const stages = { issue: "Issue invoices", export: "Issue and post to QuickBooks", email: "Issue, post and email" };
  const statementPath = (id) => root + "/accounts/" + encodeURIComponent(id) + "/statement";
  let active = "today", accountId = "", accountSearch = "", directory = null, searchTimer;
  let reviewMonth = "", reviewData = null;
  let picker = null;
  const done = async () => { closeSheet(); await reload(); };
  const accountEndpoint = (id) => root + "/accounts/" + encodeURIComponent(id);
  const batchEndpoint = (id) => root + "/batches/" + encodeURIComponent(id);
  const query = (value) => encodeURIComponent(value || "");
  const countLabel = (number, label) => number + " " + label + (number === 1 ? "" : "s");

  const action = (label, name, id = "", primary = false) => html`<button class="btn ${primary ? "" : "soft"} sm" type="button" data-act="wh-invoice-${name}" data-id="${id}">${label}</button>`;
  const inSheet = (label, name, id = "", primary = false) => html`<button class="btn ${primary ? "" : "soft"} sm" type="button" data-sheet="${name}" data-id="${id}">${label}</button>`;
  const tag = (label, tone = "") => html`<span class="pill ${tone}">${label}</span>`;
  const stat = (label, value, note) => html`<div class="stat glass"><span class="k">${label}</span><span class="v num">${value}</span>${note ? html`<span class="s">${note}</span>` : ""}</div>`;
  const stats = (entries) => html`<div class="stats wi-stats iw-stats">${entries.map(entry => stat(...entry))}</div>`;
  const heading = (name, detail, controls = "") => html`<div class="iw-heading"><div><h2>${name}</h2>${detail ? html`<p class="hint">${detail}</p>` : ""}</div>${controls}</div>`;
  const panel = (name, body, extra = "") => html`<section class="glass group iw-panel"><header><h3>${name}</h3>${extra}</header>${body}</section>`;
  const note = (text) => html`<p class="hint iw-note">${text}</p>`;
  const split = (left, right, css = "") => html`<div class="iw-split ${css}"><div class="iw-stack">${left}</div><div class="iw-stack">${right}</div></div>`;
  const keyValues = (entries) => html`<dl class="iw-pairs">${entries.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
  const item = (name, detail, icon, tone, control) => html`<div class="item has-action iw-item"><span class="ic ${tone}">${svg(icon)}</span><div class="tx"><b>${name}</b><span>${detail}</span></div><div class="iw-item-action">${control}</div></div>`;

  function nav() {
    return html`<div class="iw-navigation">
      <nav class="glass iw-tabs" aria-label="Invoicing workspace">${tabs.map(([id, label]) => html`<button class="btn sm" type="button" aria-pressed="${active === id}" data-act="wh-invoice-view" data-id="${id}">${label}</button>`)}</nav>
      <label class="iw-view-picker field"><span class="fl">Invoicing view</span><select id="iwView" class="wi-picker">${tabs.map(([id, label]) => html`<option value="${id}" ${active === id ? raw("selected") : ""}>${label}</option>`)}</select></label>
      <div class="iw-global-actions">${action("QuickBooks", "quickbooks")}${action("Invoice settings", "settings")}</div>
    </div>`;
  }

  async function todayView() {
    const { summary, issues, overdue, dispatched } = await api("GET", root + "/today");
    const { reviewCount = 0, overdueCount = 0, overduePence = 0, outstandingPence = 0 } = summary || {};
    return html`${heading("Today", date(today()), action("Create batch", "batch", "", true))}
      ${stats([["Needs review", reviewCount, "Billing and balance exceptions"], ["Outstanding", money(outstandingPence)], ["Overdue", money(overduePence), countLabel(overdueCount, "invoice")]])}
      ${split(
        panel("Needs attention", issues.length ? html`<div class="iw-list">${issues.map(invoice => item(invoice.business, invoice.number + " · " + invoice.reason,
          "warn", "warn", action(/billing (?:address|postcode)/.test(invoice.reason) ? "Review billing" : "Review invoice", "open", invoice.id)))}</div>`
          : note("No billing or balance exceptions."), reviewCount > issues.length ? action("View all", "queue", "review") : ""),
        html`${panel("Dispatched orders", html`<div class="iw-panel-body">${keyValues([["Ready this month", dispatched]])}
          ${dispatched ? html`<div>${action("Review batch", "batch")}</div>` : note("No eligible dispatches this month.")}</div>`)}
          ${panel("Overdue follow-up", overdue.length ? html`<div class="iw-list">${overdue.map(invoice => item(invoice.business, money(invoice.balancePence) + " · Due " + date(invoice.due),
            "clock", "warn", invoice.linked ? action("Preview reminder", "reminder", invoice.id) : action("Open invoice", "open", invoice.id)))}</div>`
            : note("No overdue invoices."), overdueCount > overdue.length ? action("Collections", "view", "collections") : "")}`
      )}`;
  }

  function ledgerRows(lines, sheet) {
    return lines.length ? html`<div class="iw-list">${lines.map(line => {
      const detail = [line.number, date(line.invoiceDate), line.dueDate && line.balancePence > 0 ? "Due " + date(line.dueDate) : "", line.source].filter(Boolean).join(" · ");
      const tone = line.voided ? "" : line.balancePence === null ? "warn" : line.balancePence === 0 ? "ok" : "acc";
      const amount = line.voided ? "Voided" : line.balancePence === null ? "Unconfirmed" : money(line.balancePence) + " due";
      const button = sheet ? inSheet("Open invoice", "account-invoice", line.id) : action("Open invoice", "open", line.id);
      return item(line.number, detail.split(" · ").slice(1).join(" · "), "doc", tone, html`${tag(amount, tone)}${button}`);
    })}</div>` : note("No invoices issued for this account.");
  }

  function accountContent(account, sheet = false) {
    const statement = sheet ? inSheet("Preview statement", "account-statement", account.id, true) : action("Preview statement", "statement", account.id, true);
    const schedule = sheet ? inSheet("Billing schedule", "account-schedule", account.id) : action("Billing schedule", "schedule", account.id);
    const open = (id) => sheet ? inSheet("Review billing", "account-invoice", id) : action("Review billing", "open", id);
    return html`
      ${panel("Billing details", html`<div class="iw-panel-body">
        ${keyValues([["Bill to", [account.address, account.postcode].filter(Boolean).join(" · ") || "Add a billing address"],
          ["Recipient", account.recipient || "Add an accounts email"], ["Payment terms", account.terms.label], ["Invoice when", scheduleLabel(account.schedule.cadence)]])}
        ${account.terms.note ? note(account.terms.note) : ""}
        <div class="wi-workflow-actions">${statement}${schedule}</div>
      </div>`, account.confirmed ? tag("Address confirmed", "ok") : "")}
      ${account.exception ? panel("Billing exception", item(account.exception.number, account.exception.reason, "warn", "warn", open(account.exception.id))) : ""}
      ${stats([["Outstanding", money(account.balance?.balancePence || 0)], ["Overdue", money(account.balance?.overduePence || 0)], ["Unbilled orders", account.unbilled]])}
      ${panel("Recent invoices", ledgerRows(account.invoices, sheet))}
      ${panel("Dispatched orders to invoice", account.orders.length ? html`<div class="iw-list">${account.orders.map(order =>
        item(order.reference || order.id, (order.dispatchedAt ? checked(order.dispatchedAt) : "Dispatched") + (order.tab ? " · On tab" : ""), "coffee", "mut", ""))}</div>` : note("All dispatched orders have an invoice."),
        account.unbilled > account.orders.length ? tag("Latest " + account.orders.length) : "")}`;
  }

  async function accountsView() {
    if (!directory) directory = await api("GET", root + "/accounts?q=" + query(accountSearch));
    const entries = directory.accounts;
    const selected = entries.find(value => value.id === accountId) || entries[0];
    accountId = selected?.id || "";
    const account = selected ? await api("GET", accountEndpoint(selected.id)) : null;
    const directoryView = html`<div class="iw-panel-body">
      <label class="search">${svg("search")}<input id="iwAccountSearch" type="search" aria-label="Search billing accounts" placeholder="Search billing accounts" value="${accountSearch}" maxlength="120"></label>
      ${entries.length ? html`<label class="field iw-account-picker"><span class="fl">Billing account</span><select class="wi-picker" id="iwAccount">${entries.map(entry => html`<option value="${entry.id}" ${entry.id === accountId ? raw("selected") : ""}>${entry.business}</option>`)}</select></label>
        <div class="iw-account-list iw-list group">${entries.map(entry => html`<button class="item" type="button" data-act="wh-invoice-account" data-id="${entry.id}" aria-pressed="${entry.id === accountId}"><span class="tx"><b>${entry.business}</b><span>${scheduleLabel(entry.cadence)}</span></span><span class="chev">${svg("chev")}</span></button>`)}</div>`
        : note("No matching billing accounts.")}
      ${directory.next ? action("More accounts", "accounts-more") : ""}
    </div>`;
    return html`${heading("Billing accounts", "")}
      ${split(panel("Accounts", directoryView), account ? html`${heading(html`<span class="num">${account.business}</span>`, account.recipientKind)}
        ${accountContent(account)}` : "", "iw-accounts")}`;
  }

  async function openAccount(id, back) {
    const account = await api("GET", accountEndpoint(id));
    const reopen = () => openAccount(id, back);
    show(html`<div class="wi-sheet wi-workflow w-sensitive">${title("Billing account", account.business)}<div class="wi-body">${accountContent(account, true)}</div>${footer(null, "Back")}</div>`,
      async (name, element, form) => {
        await busy(form, async () => {
          if (name === "account-invoice") await openInvoice(element.dataset.id, reopen);
          if (name === "account-statement") await openStatement(id, reopen);
          if (name === "account-schedule") await editSchedule(id, reopen);
        });
      }, back);
  }

  async function openStatement(id, back = done) {
    const data = await api("GET", statementPath(id));
    show(html`<div id="iwStatement" class="wi-sheet wi-wide w-sensitive">
      ${title("Account statement", data.business)}
      <div class="wi-body">
        ${stats([["Balance recorded", money(data.balancePence)], ["Invoices", data.lines.length], ["Unconfirmed", data.unconfirmed]])}
        <section class="wi-section">
          ${keyValues([["Recipient", data.recipient || "No accounts email saved"], ["Statement date", checked(data.asAt)], ["Billing address", [data.address, data.postcode].filter(Boolean).join(" · ") || "Address required"]])}
          <p class="hint">Open invoices and invoices issued since ${date(data.periodStart)}. Balances reflect the checks shown below.</p>
          ${data.unconfirmed ? html`<p class="wi-reasons">${data.unconfirmed} unconfirmed balances are excluded from the total.</p>` : ""}
        </section>
        ${data.lines.length ? html`<div class="wi-table-wrap iw-table-wrap"><table class="iw-table"><caption class="sc-sr-only">Statement invoice balances</caption>
          <thead><tr><th>Invoice</th><th>Amount</th><th>Applied</th><th>Balance</th></tr></thead>
          <tbody>${data.lines.map(line => html`<tr>
            <th scope="row"><b>${line.number}</b><span>${line.source}${line.checkedAt ? " · " + checked(line.checkedAt) : ""}</span>
              <span>${line.dueDate ? "Due " + date(line.dueDate) : ""}</span></th>
            <td data-label="Amount" class="num">${money(line.totalPence)}</td>
            <td data-label="Applied" class="num">${line.appliedPence === null ? "—" : money(line.appliedPence)}</td>
            <td data-label="Balance" class="num">${line.voided ? "Voided" : line.balancePence === null ? "Unconfirmed" : money(line.balancePence)}</td>
          </tr>`)}</tbody></table></div>` : note("No activity for this statement.")}
        <p class="hint">Applied includes payments, credits and adjustments reflected in each balance.</p>
      </div><footer class="wi-foot"><div class="row"><button type="button" class="btn soft" data-sheet="wi-back">Back</button>
        <a class="btn" href="${statementPath(id)}/pdf${data.downloadToken ? '?review=' + query(data.downloadToken) : ''}" target="_blank" rel="noopener">Download PDF</a></div></footer>
    </div>`, () => {}, back);
  }

  async function editSchedule(id, back = done) {
    const account = await api("GET", accountEndpoint(id));
    show(html`<form id="iwBillingSchedule" class="wi-sheet wi-choice">
      ${title("Billing schedule", account.business)}
      <div class="wi-body wi-section">${field("Invoice eligible orders", html`<select name="cadence" class="wi-picker">
        ${["dispatch", "monthly"].map(value => html`<option value="${value}" ${account.schedule.cadence === value ? raw("selected") : ""}>${scheduleLabel(value)}</option>`)}
      </select>`)}<p class="hint">On-dispatch orders follow the automatic invoicing settings. Monthly orders are reviewed as a group after the billing month ends. Orders on tabs follow their tab.</p></div>
      ${footer("Save schedule", "Back")}</form>`, async (name, _element, form) => {
      if (name !== "submit") return;
      await busy(form, async () => {
        await api("PUT", accountEndpoint(id) + "/schedule", { cadence: form.elements.cadence.value, ifVersion: account.schedule.version });
        directory = null;
        toast("Billing schedule saved.");
        await back();
      });
    }, back);
  }

  const closeChecks = [
    ["dispatches", "Unbilled dispatches"], ["monthly", "Monthly billing"], ["posting", "QuickBooks posting"],
    ["verification", "Billing and balance exceptions"], ["overdue", "Overdue follow-up"],
  ];
  function monthCounts(review) {
    return {
      dispatches: countLabel(review.orders.unbilled, "order") + (review.orders.tabs ? " · " + review.orders.tabs + " on tabs" : ""),
      monthly: countLabel(review.orders.monthly, "account") + (review.closed ? " to review" : " accruing"),
      posting: review.totals.awaiting + " awaiting QuickBooks",
      verification: countLabel(review.totals.adjustments, "exception") + (review.totals.unconfirmed ? " · " + countLabel(review.totals.unconfirmed, "unconfirmed balance") : ""),
      overdue: money(review.balances.overduePence) + " across " + countLabel(review.balances.overdue, "invoice"),
    };
  }
  async function reconciliationView() {
    const data = await api("GET", root + "/reconciliation?period=" + query(reviewMonth || defaultMonth()));
    reviewData = data;
    const last = data.snapshots[0], counts = monthCounts(data);
    const diff = last ? data.orders.unbilled - last.orders.unbilled : 0;
    return html`${heading("Reconciliation", "Balances on " + date(data.asOf) + " for invoices dated through month end.", action("Save snapshot", "close-review", "", true))}
      <div class="iw-period">${field("Billing month", html`<input type="month" id="iwClosePeriod" value="${data.period}" max="${defaultMonth()}">`)}
        ${last ? html`<span class="hint">Last saved ${checked(last.at)}${diff ? " · " + countLabel(Math.abs(diff), (diff < 0 ? "fewer" : "more") + " unbilled order") : ""}</span>` : ""}</div>
      ${stats([["Issued in period", money(data.totals.issuedPence), countLabel(data.totals.issued, "invoice")], ["Posted to QuickBooks", money(data.totals.postedPence),
        countLabel(data.totals.posted, "linked invoice")], ["Overdue", money(data.balances.overduePence), countLabel(data.balances.overdue, "invoice")]])}
      ${split(html`${panel("Month-end checklist", html`<div class="iw-list">${closeChecks.map(([key, label]) => item(label, counts[key], key === "overdue" ? "clock" : "doc",
        "acc", key === "dispatches" || key === "monthly" ? action("Review batch", "batch", data.period) : key === "overdue" ? action("Collections", "view", "collections")
          : key === "verification" ? action("Review invoices", "queue", "review") : ""))}</div>`, tag(data.closed ? "Month closed" : "In progress"))}
        ${panel("Saved snapshots", last ? html`<div class="iw-list">${data.snapshots.map(entry => item(checked(entry.at), entry.by + " · " + entry.checked.length + " reviewed",
          "doc", "mut", action("View snapshot", "close-snapshot", entry.id)))}</div>` : note("Save a snapshot to compare later reviews."))}`,
        html`${panel("Ledger totals", html`<div class="iw-panel-body">${keyValues([["Applied in QuickBooks", money(data.totals.appliedPence)],
          ["Outstanding through month end", money(data.balances.outstandingPence)], ["Unconfirmed balances this month", data.totals.unconfirmed]])}</div>`)}
        ${panel("Overdue ageing", html`<div class="iw-panel-body">${keyValues([["1–30 days", money(data.balances.age30)], ["31–60 days", money(data.balances.age60)], ["61+ days", money(data.balances.ageOlder)]])}</div>`)}
        ${panel("Overdue by account", data.accounts.length ? html`<div class="iw-list">${data.accounts.map(account => item(account.business,
          money(account.amountPence) + " · " + countLabel(account.invoices, "invoice"), "clock", "warn", action("Billing account", "account-sheet", account.id)))}</div>` : note("No overdue balances for this review."))}`
      )}`;
  }

  function closeReview(data) {
    show(html`<form id="iwCloseReview" class="wi-sheet wi-workflow w-sensitive">${title("Save reconciliation snapshot", monthName(data.period))}
      <div class="wi-body wi-section"><p class="hint">Mark the items you’ve checked. The snapshot records the figures and your notes.</p>
        ${closeChecks.map(([key, label]) => html`<label class="wi-check"><input name="reviewed" type="checkbox" value="${key}"><span><strong>${label}</strong><span class="iw-check-note">${monthCounts(data)[key]}</span></span></label>`)}
        ${field("Notes (optional)", html`<textarea name="note" maxlength="500"></textarea>`)}
      </div>${footer("Save snapshot", "Back")}</form>`, async (name, _element, form) => {
      if (name !== "submit") return;
      await busy(form, async () => {
        const checked = [...form.querySelectorAll("[name=reviewed]:checked")].map(input => input.value);
        await api("POST", root + "/reconciliation?period=" + query(data.period), { revision: data.revision, checked, note: form.elements.note.value.trim() });
        toast("Reconciliation snapshot saved.");
        await done();
      });
    }, done);
  }
  function closeSnapshot(data, entry) {
    show(html`<div class="wi-sheet wi-workflow w-sensitive">${title("Reconciliation snapshot", checked(entry.at))}
      <div class="wi-body">${panel(monthName(data.period), html`<div class="iw-panel-body">
        ${keyValues([["Issued", money(entry.totals.issuedPence)], ["Unbilled dispatches", entry.orders.unbilled], ["Overdue", money(entry.balances.overduePence)],
          ["Reviewed by", entry.by], ["Reviewed items", closeChecks.filter(([key]) => entry.checked.includes(key)).map(([, label]) => label).join(" · ") || "Figures only"]])}
        ${entry.note ? html`<p class="wi-address">${entry.note}</p>` : ""}
      </div>`)}</div>${footer(null, "Back")}</div>`, () => {}, done);
  }

  async function openBatch(period = defaultMonth(), back = done) {
    picker = { period, selected: new Set(), delivery: "issue", items: [], next: null, back };
    await loadBatchCandidates(picker);
  }

  async function loadBatchCandidates(state, more = false) {
    const data = await api("GET", root + "/batches?period=" + query(state.period) + (more ? "&after=" + query(state.next) : ""));
    Object.assign(state, { ...data, items: more ? [...state.items, ...data.candidates] : data.candidates });
    batchPicker(state);
  }

  function batchPicker(state) {
    show(html`<form id="iwBatchPicker" class="wi-sheet wi-wide iw-batch w-sensitive">
      ${title("Create invoice batch", monthName(state.period))}
      <div class="wi-body">
        <div class="wi-settings-grid">${field("Dispatch month", html`<input id="iwBatchPeriod" type="month" value="${state.period}" max="${defaultMonth()}">`)}
          ${field("After issuing", html`<select name="delivery" class="wi-picker">${Object.entries(stages).map(([id, label]) => html`<option value="${id}" ${state.delivery === id ? raw("selected") : ""}>${label}</option>`)}</select>`)}</div>
        ${panel("Dispatches to invoice", state.items.length ? html`<div class="iw-list">${state.items.map(entry => {
          const accruing = entry.monthly && !state.closed;
          return html`<label class="item wi-check iw-batch-check"><input type="checkbox" name="entry" value="${entry.id}" ${state.selected.has(entry.id) ? raw("checked") : ""} ${accruing ? raw("disabled") : ""}>
            <span class="tx"><b>${entry.business}</b><span>${entry.monthly ? "Monthly · " : ""}${entry.orders} ${entry.orders === 1 ? "order" : "orders"} · ${checked(entry.dispatchedAt)}</span></span>
            ${accruing ? tag("Month in progress") : ""}</label>`;
        })}</div>` : note("No eligible dispatches in this month."), tag("Up to " + state.maxSelection + " entries"))}
        ${state.next ? inSheet("More dispatches", "batch-more") : ""}
        ${state.recent.length ? panel("Recent runs", html`<div class="iw-list">${state.recent.map(entry => item(monthName(entry.period),
          checked(entry.at) + " · " + entry.issued + " of " + entry.entries + " issued", "doc", "mut", inSheet("View run", "batch-open", entry.id)))}</div>`) : ""}
      </div>${footer(state.items.some(entry => !entry.monthly || state.closed) ? "Review selected" : null, "Back")}
    </form>`, async (name, element, form) => {
      await busy(form, async () => {
        const visible = [...form.querySelectorAll("[name=entry]")];
        for (const input of visible) {
          if (input.checked) state.selected.add(input.value);
          else state.selected.delete(input.value);
        }
        state.delivery = form.elements.delivery.value;
        if (name === "batch-more") await loadBatchCandidates(state, true);
        if (name === "batch-open") batchReview(await api("GET", batchEndpoint(element.dataset.id)), () => loadBatchCandidates(state));
        if (name !== "submit") return;
        if (!state.selected.size || state.selected.size > state.maxSelection) throw new Error("Choose up to " + state.maxSelection + " invoice entries.");
        const review = await api("POST", root + "/batches/preview", { period: state.period, selected: [...state.selected], delivery: state.delivery });
        batchReview(review, () => loadBatchCandidates(state));
      });
    }, state.back);
  }

  function batchReview(review, back) {
    const approved = review.state === "approved";
    const pending = review.items.filter(value => ["waiting", "working"].includes(value.state));
    const complete = review.items.filter(value => value.state === "issued");
    const caption = stages[review.delivery] + (review.environment ? " · QuickBooks " + (review.environment === "production" ? "Live" : "Sandbox") : "");
    const next = () => batchReview(review, back);
    show(html`<form id="iwBatchReview" class="wi-sheet wi-wide iw-batch w-sensitive">
      ${title(approved ? "Batch progress" : "Review invoice batch", monthName(review.period) + " · " + caption)}
      <div class="wi-body">
        ${stats(approved ? [["Issued", complete.length + " of " + review.items.length], ["Posted", review.items.filter(value => value.posted).length],
          ["Emailed", review.items.filter(value => value.emailed).length]]
          : [["Ready", pending.length], ["Invoice total", money(pending.reduce((sum, value) => sum + value.grossPence, 0))],
            ["Needs attention", review.items.length - pending.length]])}
        ${panel("Invoices", html`<div class="iw-list">${review.items.map(entry => {
          const status = entry.state === "failed" ? tag("Needs review", "warn") : entry.state === "issued" ? tag("Issued", "ok") : tag(approved ? "Waiting" : "Ready", "acc");
          return html`<div class="item iw-batch-entry"><div class="tx"><b>${entry.business}</b><span>${entry.number ? entry.number + " · " : ""}${entry.orders.length} ${entry.orders.length === 1 ? "order" : "orders"}${entry.due ? " · Due " + date(entry.due) : ""}</span>
            <span>${entry.email ? (review.delivery === "email" ? "Send to " : "Billing email ") + entry.email : "No email on file"}</span>
            ${entry.reason ? html`<span class="iw-batch-reason">${entry.reason}</span>` : ""}</div>
            <div class="iw-batch-entry-end">${entry.grossPence !== null ? html`<strong class="num">${money(entry.grossPence)}</strong>` : ""}
              <div class="wi-workflow-actions">${status}${entry.posted ? tag("Posted", "ok") : ""}${entry.emailed ? tag("Emailed", "ok") : ""}</div>
              ${entry.invoiceId ? inSheet("Open invoice", "batch-invoice", entry.invoiceId) : ""}
              ${entry.jobState === "held" && entry.exportState !== "review" && entry.exportState !== "paused" ? inSheet("Retry delivery", "batch-retry", entry.id) : ""}
            </div></div>`;
        })}</div>`)}
        ${approved ? html`<div class="wi-workflow-actions">${inSheet("Refresh progress", "batch-refresh")}${pending.length ? inSheet("Continue issuing", "batch-run") : ""}</div>` : ""}
      </div>${footer(!approved && pending.length ? "Approve and issue" : null, "Back")}
    </form>`, async (name, element, form) => {
      await busy(form, async () => {
        if (name === "batch-invoice") await openInvoice(element.dataset.id, next);
        if (name === "batch-refresh") batchReview(await api("GET", batchEndpoint(review.id)), back);
        if (name === "batch-retry") {
          await api("POST", "/api/admin/wholesale/auto-invoicing/batch:" + element.dataset.id + "/retry", {});
          batchReview(await api("GET", batchEndpoint(review.id)), back);
        }
        if (name === "batch-run" || (name === "submit" && !approved)) {
          let progress = approved ? review : await api("POST", batchEndpoint(review.id) + "/approve", { reviewed: true });
          for (const entry of progress.items.filter(value => ["waiting", "working"].includes(value.state))) {
            progress = await api("POST", batchEndpoint(progress.id) + "/items/" + entry.id + "/run", {});
          }
          batchReview(progress, back);
        }
      });
    }, back);
  }

  function select(id) {
    if (tabs.some(([key]) => key === id)) active = id;
  }
  function searchAccounts(value) {
    accountSearch = value; directory = null;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (document.getElementById("iwAccountSearch")) void reload(); }, 220);
  }
  async function change(target) {
    if (target.id === "iwView") { select(target.value); await reload(); return; }
    if (target.id === "iwAccount") { accountId = target.value; await reload(); return; }
    if (target.id === "iwClosePeriod" && target.value) { reviewMonth = target.value; await reload(); return; }
    if (target.id === "iwBatchPeriod" && picker && target.value) {
      const state = picker, old = state.period;
      await busy(target.form, async () => {
        state.delivery = target.form.elements.delivery.value;
        state.period = target.value; state.selected.clear();
        try { await loadBatchCandidates(state); }
        catch (error) { state.period = old; target.value = old; throw error; }
      });
    }
  }
  async function act(name, id) {
    if (name === "view") { select(id); await reload(); return true; }
    if (name === "account") { accountId = id; await reload(); return true; }
    if (name === "account-sheet") { await openAccount(id, done); return true; }
    if (name === "accounts-more" && directory?.next) {
      const page = await api("GET", root + "/accounts?q=" + query(accountSearch) + "&after=" + query(directory.next));
      directory = { accounts: [...directory.accounts, ...page.accounts], next: page.next };
      await reload(); return true;
    }
    if (name === "statement") { await openStatement(id); return true; }
    if (name === "schedule") { await editSchedule(id); return true; }
    if (name === "reminder") { await openReminder(id); return true; }
    if (name === "batch") { await openBatch(id || undefined); return true; }
    if (name === "close-review" && reviewData) { closeReview(reviewData); return true; }
    if (name === "close-snapshot" && reviewData) {
      const entry = reviewData.snapshots.find(value => String(value.id) === id);
      if (entry) closeSnapshot(reviewData, entry);
      return true;
    }
    return false;
  }

  return {
    nav, heading, todayView, accountsView, reconciliationView, openAccount, change, act, searchAccounts, select,
    current: () => active,
    state: () => ({ active, accountId, accountSearch, reviewMonth }),
    restore(saved) {
      if (!saved) return;
      select(saved.active); accountId = saved.accountId || ""; accountSearch = saved.accountSearch || "";
      reviewMonth = saved.reviewMonth || ""; directory = null;
    },
    clear() { active = "today"; accountId = accountSearch = reviewMonth = ""; directory = reviewData = picker = null; clearTimeout(searchTimer); },
  };
};
