// The Admin invoicing workspace shares the site's grouped lists, controls and invoice sheets.
window.WholesaleInvoiceWorkspace = function ({ api, html, raw, svg, title, footer, field, show, busy, reload, closeSheet, toast,
  money, date, today, checked, openInvoice, openReminder, openBillingReview }) {
  const root = "/api/admin/wholesale/invoicing";
  const tabs = [["today", "Today"], ["accounts", "Billing accounts"], ["invoices", "Invoices"], ["collections", "Collections"], ["reconciliation", "Reconciliation"]];
  const defaultMonth = () => today().slice(0, 7);
  const monthName = (value) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(value + "-15T00:00:00Z"));
  const scheduleLabel = (value) => value === "monthly" ? "Monthly" : "On dispatch";
  const stages = { issue: "Issue invoices", export: "Issue and post to QuickBooks", email: "Issue, post and email" };
  const statementPath = (id) => root + "/accounts/" + encodeURIComponent(id) + "/statement";
  let active = "today", accountId = "", accountSearch = "", directory = null, searchTimer, accountSheetRequest = 0;
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
  const heading = (name, detail, controls = "") => html`<header class="iw-heading"><div><h2>${name}</h2>${detail ? html`<p class="hint">${detail}</p>` : ""}</div>${controls}</header>`;
  const panel = (name, body, extra = "") => html`<section class="glass group iw-panel"><header><h3>${name}</h3>${extra}</header>${body}</section>`;
  const note = (text) => html`<p class="hint iw-note">${text}</p>`;
  const split = (left, right, css = "") => html`<div class="iw-split ${css}"><div class="iw-stack">${left}</div><div class="iw-stack">${right}</div></div>`;
  const keyValues = (entries) => html`<dl class="iw-pairs">${entries.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>`;
  const item = (name, detail, icon, tone, control) => html`<div class="item has-action iw-item"><span class="ic ${tone}">${svg(icon)}</span><div class="tx"><b>${name}</b><span>${detail}</span></div><div class="iw-item-action">${control}</div></div>`;

  function nav() {
    const tool = (label, name, icon, short = label) => html`<button class="btn soft iw-tool" type="button" data-act="wh-invoice-${name}" aria-label="${label}" title="${label}">${svg(icon)}<span class="iw-tool-label">${label}</span><span class="iw-tool-compact">${short}</span></button>`;
    return html`<div class="iw-navigation">
      <nav class="seg iw-tabs" aria-label="Invoicing workspace">${tabs.map(([id, label]) => html`<button class="btn sm" type="button" aria-pressed="${String(active === id)}" data-act="wh-invoice-view" data-id="${id}">${label}</button>`)}</nav>
      <label class="iw-view-picker field"><span class="sc-sr-only">Invoicing view</span><select id="iwView" class="wi-picker">${tabs.map(([id, label]) => html`<option value="${id}" ${active === id ? raw("selected") : ""}>${label}</option>`)}</select></label>
      <div class="iw-global-actions" role="group" aria-label="Invoicing tools">${tool("QuickBooks", "quickbooks", "db")}${tool("Invoice settings", "settings", "tune", "Settings")}</div>
    </div>`;
  }

  async function todayView() {
    const { summary, issues, overdue, dispatched } = await api("GET", root + "/today");
    const { reviewCount = 0, overdueCount = 0, overduePence = 0, outstandingPence = 0 } = summary || {};
    return html`${heading("Today", "Billing and collections", action("Create batch", "batch", "", true))}
      ${stats([["Needs review", reviewCount], ["Outstanding", money(outstandingPence)], ["Overdue", money(overduePence), countLabel(overdueCount, "invoice")]])}
      ${split(
        html`${panel("Needs attention", issues.length ? html`<div class="iw-list">${issues.map(invoice => {
          const billing = /billing (?:address|postcode)/.test(invoice.reason);
          return item(invoice.business, invoice.number + " · " + invoice.reason,
            "warn", "warn", action(billing ? "Review billing" : "Review invoice", billing ? "review-billing" : "open", invoice.id));
        })}</div>`
          : note("No billing or balance exceptions."), reviewCount > issues.length ? action("View all", "queue", "review") : "")}
        ${panel("Overdue follow-up", overdue.length ? html`<div class="iw-list">${overdue.map(invoice => item(invoice.business, money(invoice.balancePence) + " · Due " + date(invoice.due),
            "clock", "warn", invoice.linked ? action("Preview reminder", "reminder", invoice.id) : action("Open invoice", "open", invoice.id)))}</div>`
            : note("No overdue invoices."), overdueCount > overdue.length ? action("Collections", "view", "collections") : "")}`,
        panel("Dispatches to invoice", item(countLabel(dispatched, "order"), dispatched ? "Ready this month" : "No eligible dispatches this month", "doc", dispatched ? "acc" : "mut", ""))
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
      ${panel("Billing details", html`<div class="iw-panel-body iw-account-details">
        ${keyValues([["Bill to", [account.address, account.postcode].filter(Boolean).join("\n") || "Add a billing address"],
          ["Recipient", account.recipient || "Add an accounts email"], ["Payment terms", account.terms.label], ["Invoice when", scheduleLabel(account.schedule.cadence)]])}
        ${account.terms.note ? note(account.terms.note) : ""}
        <div class="wi-workflow-actions">${sheet ? statement : ""}${schedule}</div>
      </div>`, account.confirmed ? tag("Address confirmed", "ok") : "")}
      ${account.exception ? panel("Billing exception", item(account.exception.number, account.exception.reason, "warn", "warn", open(account.exception.id))) : ""}
      ${stats([["Outstanding", money(account.balance?.balancePence || 0)], ["Overdue", money(account.balance?.overduePence || 0)], ["Unbilled orders", account.unbilled]])}
      ${panel("Recent invoices", ledgerRows(account.invoices, sheet))}
      ${panel("Dispatched orders to invoice", account.orders.length ? html`<div class="iw-list">${account.orders.map(order =>
        item(order.reference || order.id, (order.dispatchedAt ? checked(order.dispatchedAt) : "Dispatched") + (order.tab ? " · On tab" : ""), "coffee", "mut", ""))}</div>` : note("All dispatched orders have an invoice."),
        account.unbilled > account.orders.length ? tag("Latest " + account.orders.length) : "")}`;
  }

  async function accountsView() {
    const search = accountSearch;
    const results = directory || await api("GET", root + "/accounts?q=" + query(search));
    if (search !== accountSearch) return accountsView();
    directory = results;
    const entries = results.accounts;
    const selected = entries.find(value => value.id === accountId) || entries[0];
    accountId = selected?.id || "";
    const account = selected ? await api("GET", accountEndpoint(selected.id)) : null;
    const directoryView = html`<div class="iw-panel-body">
      <label class="search">${svg("search")}<input id="iwAccountSearch" type="search" aria-label="Search billing accounts" placeholder="Search billing accounts" value="${accountSearch}" maxlength="120"></label>
      ${entries.length ? html`<div class="iw-account-list iw-list group">${entries.map(entry => html`<button class="item" type="button" data-act="wh-invoice-account" data-id="${entry.id}" aria-pressed="${String(entry.id === accountId)}"><span class="tx"><b>${entry.business}</b><span>${scheduleLabel(entry.cadence)}</span></span><span class="chev">${svg("chev")}</span></button>`)}</div>`
        : note("No matching billing accounts.")}
      ${results.next ? action("More accounts", "accounts-more") : ""}
    </div>`;
    return html`${heading("Billing accounts", "Addresses, payment terms and account statements.")}
      ${split(panel("Accounts", directoryView, tag(countLabel(entries.length, "account") + (results.next ? " shown" : ""))), account ? html`${heading(html`<span class="num">${account.business}</span>`, "", action("Preview statement", "statement", account.id, true))}
        ${accountContent(account)}` : "", "iw-accounts")}`;
  }

  async function openAccount(id, back) {
    const opened = ++accountSheetRequest, route = location.hash, view = active;
    const account = await api("GET", accountEndpoint(id));
    if (opened !== accountSheetRequest || route !== location.hash || view !== active) return;
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
    return html`${heading("Reconciliation", "", action("Save snapshot", "close-review", "", true))}
      <div class="iw-period glass">${field("Billing month", html`<input type="month" id="iwClosePeriod" value="${data.period}" max="${defaultMonth()}">`)}
        <div><p class="hint">Balances on ${date(data.asOf)} for invoices dated through month end.</p>
        ${last ? html`<p class="hint">Last saved ${checked(last.at)}${diff ? " · " + countLabel(Math.abs(diff), (diff < 0 ? "fewer" : "more") + " unbilled order") : ""}</p>` : ""}</div></div>
      ${stats([["Issued in period", money(data.totals.issuedPence), countLabel(data.totals.issued, "invoice")], ["Posted to QuickBooks", money(data.totals.postedPence),
        countLabel(data.totals.posted, "linked invoice")], ["Overdue", money(data.balances.overduePence), countLabel(data.balances.overdue, "invoice")]])}
      ${split(html`${panel("Month-end checklist", html`<div class="iw-list">${closeChecks.map(([key, label]) => item(label, counts[key], key === "overdue" ? "clock" : "doc",
        "acc", key === "dispatches" ? action("Review batch", "batch", data.period) : key === "overdue" ? action("Collections", "view", "collections")
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
    const form = show(html`<form id="iwCloseReview" class="wi-sheet wi-workflow w-sensitive">${title("Save reconciliation snapshot", monthName(data.period))}
      <div class="wi-body wi-section"><p class="hint">Mark the items you’ve checked. The snapshot records the figures and your notes.</p>
        ${closeChecks.map(([key, label]) => html`<label class="wi-check"><input name="reviewed" type="checkbox" value="${key}"><span><strong>${label}</strong><span class="iw-check-note">${monthCounts(data)[key]}</span></span></label>`)}
        ${field("Notes (optional)", html`<textarea name="note" maxlength="500"></textarea>`)}
      </div><footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row iw-review-footer">
        <span class="iw-batch-progress" data-review-count role="status">0 of ${closeChecks.length} checked</span>
        ${inSheet("Back", "wi-back")}<button class="btn" type="submit">Save snapshot</button>
      </div></footer></form>`, async (name, _element, form) => {
      if (name !== "submit") return;
      await busy(form, async () => {
        const checked = [...form.querySelectorAll("[name=reviewed]:checked")].map(input => input.value);
        await api("POST", root + "/reconciliation?period=" + query(data.period), { revision: data.revision, checked, note: form.elements.note.value.trim() });
        toast("Reconciliation snapshot saved.");
        await done();
      });
    }, done);
    form.addEventListener("change", () => {
      const selected = form.querySelectorAll("[name=reviewed]:checked").length;
      form.querySelector("[data-review-count]").textContent = selected + " of " + closeChecks.length + " checked";
    });
  }
  function closeSnapshot(data, entry) {
    show(html`<div class="wi-sheet wi-workflow w-sensitive">${title("Reconciliation snapshot", checked(entry.at))}
      <div class="wi-body">${panel(monthName(data.period), html`<div class="iw-panel-body">
        ${keyValues([["Issued", money(entry.totals.issuedPence)], ["Unbilled dispatches", entry.orders.unbilled], ["Overdue", money(entry.balances.overduePence)],
          ["Reviewed by", entry.by]])}
        ${entry.note ? html`<p class="wi-workflow-note wi-address">${entry.note}</p>` : ""}
      </div>`)}
      ${panel("Checklist at time of review", html`<div class="iw-panel-body">${keyValues(closeChecks.map(([key, label]) => [label, entry.checked.includes(key) ? tag("Reviewed", "ok") : tag("Open")]))}</div>`)}
      </div>${footer(null, "Back")}</div>`, () => {}, done);
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
    const form = show(html`<form id="iwBatchPicker" class="wi-sheet wi-wide iw-batch w-sensitive">
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
        <div class="iw-qb-match-link"><p class="hint">Invoiced by hand in QuickBooks already?</p>${inSheet("Match with QuickBooks", "qb-matches")}</div>
        ${state.recent.length ? panel("Recent runs", html`<div class="iw-list">${state.recent.map(entry => item(monthName(entry.period),
          checked(entry.at) + " · " + entry.issued + " of " + entry.entries + " issued", "doc", "mut", inSheet("View run", "batch-open", entry.id)))}</div>`) : ""}
      </div><footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row">
        <span class="iw-batch-progress" data-selection role="status"></span>
        ${inSheet("Back", "wi-back")}
        ${state.items.some(entry => !entry.monthly || state.closed) ? html`<button type="submit" class="btn" disabled>Review selected</button>` : ""}
      </div></footer>
    </form>`, async (name, element, form) => {
      await busy(form, async () => {
        state.delivery = form.elements.delivery.value;
        if (name === "batch-more") await loadBatchCandidates(state, true);
        if (name === "qb-matches") { await quickbooksMatches(() => loadBatchCandidates(state)); return; }
        if (name === "batch-open") batchReview(await api("GET", batchEndpoint(element.dataset.id)), () => loadBatchCandidates(state));
        if (name !== "submit") return;
        if (!state.selected.size || state.selected.size > state.maxSelection) throw new Error("Choose up to " + state.maxSelection + " invoice entries.");
        const review = await api("POST", root + "/batches/preview", { period: state.period, selected: [...state.selected], delivery: state.delivery });
        batchReview(review, () => loadBatchCandidates(state));
      });
    }, state.back);
    const updateSelection = () => {
      const size = state.selected.size;
      const tooMany = size > state.maxSelection;
      form.querySelector("[data-selection]").textContent = tooMany ? size + " selected · Choose up to " + state.maxSelection : size + " selected";
      const review = form.querySelector("[type=submit]");
      if (review) review.disabled = !size || tooMany;
    };
    form.addEventListener("change", event => {
      const control = event.target;
      if (control.name !== "entry") return;
      if (control.checked) state.selected.add(control.value);
      else state.selected.delete(control.value);
      updateSelection();
    });
    updateSelection();
  }

  // Orders invoiced by hand in QuickBooks before automatic invoicing: matched to the QuickBooks invoice so they stop
  // showing as unbilled. Nothing is issued, posted or emailed, and QuickBooks isn't changed.
  async function quickbooksMatches(back, after = null, limit = null, previous = []) {
    const query = new URLSearchParams();
    if (after) query.set("after", after);
    if (limit) query.set("limit", limit);
    const data = await api("GET", root + "/quickbooks-matches" + (query.size ? "?" + query : ""));
    const shrink = data.complete === false && data.limit > 1;
    const groups = [["exact", "Found in QuickBooks", "Same customer and total."],
      ["amount", "Found with a different total", "Check these before ticking: the QuickBooks invoice's total isn't the order's."],
      ["none", "Not found in QuickBooks", "No matching QuickBooks invoice. These stay unbilled."]];
    const when = (entry) => "Ordered " + checked(entry.createdAt) + (entry.dispatchedAt ? " · dispatched " + checked(entry.dispatchedAt) : "") + (entry.onTab ? " · on a tab" : "");
    const row = (entry) => entry.invoice ? html`<label class="item wi-check iw-batch-check"><input type="checkbox" name="match" value="${entry.orderId}" ${entry.match === "exact" ? raw("checked") : ""}>
        <span class="tx"><b>${entry.business}</b><span>Order ${money(entry.totalPence)} · ${when(entry)}</span>
        <span>QuickBooks ${entry.invoice.number || "invoice"} · ${money(entry.invoice.totalPence)} · ${date(entry.invoice.date)}${entry.invoice.balancePence === 0 ? " · paid" : ""}</span></span>
        ${entry.match === "amount" ? tag("Total differs", "warn") : tag("Match", "ok")}</label>`
      : item(entry.business, "Order " + money(entry.totalPence) + " · " + when(entry), "doc", "mut", "");
    const form = show(html`<form id="iwQbMatches" class="wi-sheet wi-wide iw-batch w-sensitive">
      ${title("Match with QuickBooks", data.company ? "QuickBooks Live · " + data.company : "QuickBooks Live")}
      <div class="wi-body"><p class="hint">For orders already invoiced by hand in QuickBooks. Ticked orders are marked as invoiced, so they stop showing as unbilled. Nothing is sent to customers, and nothing changes in QuickBooks.</p>
        ${data.suggestions.length ? groups.map(([kind, name, hint]) => {
          const entries = data.suggestions.filter(entry => entry.match === kind);
          return entries.length ? panel(name, html`<div class="iw-panel-body">${note(hint)}</div><div class="iw-list">${entries.map(row)}</div>`, tag(String(entries.length))) : "";
        }) : data.complete === false
          ? note("This date range contains too many orders or QuickBooks invoices to confirm matches." + (shrink ? " Try reviewing fewer orders at once." : data.next ? " Continue to the next order to keep reviewing." : ""))
          : note("No unbilled dispatches on this page.")}
        ${shrink ? inSheet("Review fewer orders", "wi-matches-smaller") : ""}
      </div><footer class="wi-foot"><p class="err" id="wiError" role="alert"></p><div class="row">
        <span class="iw-batch-progress" data-selection role="status"></span>
        ${inSheet("Back", "wi-back")}
        ${previous.length ? inSheet("Previous orders", "wi-matches-previous") : ""}
        ${data.next ? inSheet("Next orders", "wi-matches-next") : ""}
        ${data.suggestions.some(entry => entry.invoice) ? html`<button type="submit" class="btn">Mark as already invoiced</button>` : ""}
      </div></footer></form>`, async (name, _element, form) => {
      if (name === "wi-matches-smaller") return busy(form, () => quickbooksMatches(back, after, Math.ceil(data.limit / 2), previous));
      if (name === "wi-matches-next") return busy(form, () => quickbooksMatches(back, data.next, limit, [...previous, { after, limit }]));
      if (name === "wi-matches-previous") {
        const page = previous.at(-1);
        return busy(form, () => quickbooksMatches(back, page.after, page.limit, previous.slice(0, -1)));
      }
      if (name !== "submit") return;
      await busy(form, async () => {
        const chosen = new Set([...form.querySelectorAll("[name=match]:checked")].map(input => input.value));
        const matches = data.suggestions.filter(entry => entry.invoice && chosen.has(entry.orderId))
          .map(entry => ({ orderId: entry.orderId, version: entry.version, remoteId: entry.invoice.id }));
        if (!matches.length) throw new Error("Tick the orders to mark as already invoiced.");
        const result = await api("POST", root + "/quickbooks-matches", { matches, review: data.review, after, limit });
        toast(countLabel(result.recorded, "order") + " marked as invoiced in QuickBooks. Nothing was emailed.");
        await back();
      });
    }, back);
    const update = () => {
      const size = form.querySelectorAll("[name=match]:checked").length;
      form.querySelector("[data-selection]").textContent = size + " ticked";
      const submit = form.querySelector("[type=submit]");
      if (submit) { submit.disabled = !size; submit.textContent = size ? "Mark " + countLabel(size, "order") + " as already invoiced" : "Mark as already invoiced"; }
    };
    form.addEventListener("change", update);
    update();
  }

  function batchReview(review, back) {
    const approved = review.state === "approved";
    const pending = review.items.filter(value => ["waiting", "working"].includes(value.state));
    const complete = review.items.filter(value => value.state === "issued");
    const caption = stages[review.delivery] + (review.environment ? " · QuickBooks " + (review.environment === "production" ? "Live" : "Sandbox") : "");
    const next = async () => batchReview(await api("GET", batchEndpoint(review.id)), back);
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
        <p class="wi-approval-feedback wi-workflow-note" data-batch-feedback role="status"></p>
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
          const feedback = form.querySelector("[data-batch-feedback]");
          feedback.textContent = approved ? "Continuing this batch…" : "Approving batch…";
          let progress = approved ? review : await api("POST", batchEndpoint(review.id) + "/approve", { reviewed: true });
          const waiting = progress.items.filter(value => ["waiting", "working"].includes(value.state));
          for (const [index, entry] of waiting.entries()) {
            feedback.textContent = "Processing invoice " + (index + 1) + " of " + waiting.length + "…";
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
    if (target.id === "iwClosePeriod" && target.value) { reviewMonth = target.value; await reload(); return; }
    if (target.id === "iwBatchPeriod" && picker && target.value) {
      const state = picker, old = state.period, previousSelection = state.selected;
      await busy(target.form, async () => {
        state.delivery = target.form.elements.delivery.value;
        state.period = target.value; state.selected = new Set();
        try { await loadBatchCandidates(state); }
        catch (error) { state.period = old; state.selected = previousSelection; target.value = old; throw error; }
      });
    }
  }
  async function act(name, id) {
    if (name === "view") { select(id); await reload(); return true; }
    if (name === "account") {
      accountId = id;
      if (!document.querySelector(".iw-accounts > .iw-stack:last-child")?.getClientRects().length) await openAccount(id, done);
      else await reload();
      return true;
    }
    if (name === "account-sheet") { await openAccount(id, done); return true; }
    if (name === "accounts-more" && directory?.next) {
      const previous = directory, search = accountSearch;
      const page = await api("GET", root + "/accounts?q=" + query(search) + "&after=" + query(previous.next));
      if (directory !== previous || accountSearch !== search) return true;
      directory = { accounts: [...previous.accounts, ...page.accounts], next: page.next };
      await reload(); return true;
    }
    if (name === "statement") { await openStatement(id); return true; }
    if (name === "schedule") { await editSchedule(id); return true; }
    if (name === "reminder") { await openReminder(id); return true; }
    if (name === "review-billing") { await openBillingReview(id); return true; }
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
    clear() { accountSheetRequest++; active = "today"; accountId = accountSearch = reviewMonth = ""; directory = reviewData = picker = null; clearTimeout(searchTimer); },
  };
};
