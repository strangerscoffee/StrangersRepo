// Billing and collections reuse the Admin invoice sheet, focus handling and controls.
window.WholesaleInvoiceWorkflows = function ({ api, html, title, footer, field, show, busy, money, date, checked }) {
  const root = "/api/admin/wholesale";
  const billingPath = (id, environment) => root + "/quickbooks/exports/" + id + "/billing-review?environment=" + encodeURIComponent(environment);
  const reminderPath = (id) => root + "/invoices/" + id + "/reminders";
  const billingIssue = (message) => message === "The QuickBooks customer billing address differs. Review the billing address before exporting."
    || /^The QuickBooks billing (?:address|postcode) differs from the issued invoice\.$/.test(message || "");
  const address = (value) => html`<span class="wi-address">${value.address}</span><strong>${value.postcode}</strong>`;
  const stamp = (name, at) => name ? name + " · " + checked(at) : checked(at);

  async function openBilling(exportId, environment, back) {
    const path = billingPath(exportId, environment);
    const review = await api("GET", path);
    const label = { strangers: "Strangers", quickbooks: "QuickBooks" };
    const cards = (side, description) => html`<label class="wi-check wi-address-choice">
      <input type="radio" name="billingSource" value="${side}" required>
      <span><b>${label[side]}</b><span class="hint">${description}</span>${address(review[side])}</span>
    </label>`;
    const difference = review.difference === "postcode" ? "Postcode differs" : review.difference ? "Billing address differs" : "Addresses checked";
    show(html`<form id="wiBillingReview" class="wi-sheet wi-workflow w-sensitive">
      ${title("Review billing address", review.number + " · " + review.business)}
      <div class="wi-body">
        <div class="wi-section wi-review-intro">
          <div class="wi-section-heading"><h3>Billing details</h3><span class="pill ${review.difference ? "warn" : "ok"}">${difference}</span></div>
          <p>Choose the correct billing address for this account.</p>
        </div>
        <fieldset class="wi-billing-choices">
          <legend class="sc-sr-only">Billing address to use</legend>
          <div class="wi-settings-grid">${cards("strangers", "Issued invoice")}${cards("quickbooks", review.posted ? "QuickBooks invoice" : "Customer record")}</div>
        </fieldset>
        <p class="hint">${review.environment === "production" ? "Future drafts use the address you confirm." : "This review applies to the Sandbox export."} ${review.retry ? "The export will retry using invoice " + review.number + "." : ""}</p>
        ${review.history?.length ? billingActivity(review.history) : ""}
      </div>${footer(review.retry ? "Confirm and retry export" : "Confirm billing address", "Back")}
    </form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        const choice = form.querySelector("[name=billingSource]:checked")?.value;
        if (!choice) throw new Error("Choose the billing address to confirm.");
        try {
          const result = await api("POST", path, { token: review.token, choice });
          show(html`<div class="wi-sheet wi-workflow w-sensitive">
            ${title("Billing address confirmed", review.number + " · " + review.business)}
            <div class="wi-body"><section class="wi-linked-balance wi-section">
              <div class="wi-section-heading"><h3>${label[choice]} billing address</h3><span class="pill ok">Confirmed</span></div>
              <div class="wi-review-address">${address(result.confirmed)}</div><p class="hint">${stamp(result.confirmed.by, result.confirmed.at)}</p>
            </section>${result.retryQueued ? html`<p class="hint">QuickBooks export queued for invoice ${review.number}.</p>` : ""}
            ${result.followUp ? html`<p class="wi-reasons">${result.followUp}</p>` : ""}</div>
            ${footer(null, "Done")}
          </div>`, () => {}, back);
        } catch (error) {
          if (error.code !== "billing_review_changed") throw error;
          await openBilling(exportId, environment, back);
          const output = document.querySelector("#wiBillingReview #wiError");
          if (output) output.textContent = error.message;
        }
      });
    }, back);
  }

  function billingActivity(history) {
    return html`<section class="wi-section"><h3>Billing review history</h3>
      <ul class="wi-workflow-log">${history.map((entry) => html`<li><div><strong>${entry.choice === "quickbooks" ? "QuickBooks" : "Strangers"} billing address confirmed${entry.environment === "sandbox" ? " in Sandbox" : ""}</strong><p>${entry.address}${entry.postcode ? " · " + entry.postcode : ""}</p></div><span class="hint">${stamp(entry.by, entry.at)}</span></li>`)}</ul></section>`;
  }

  const reminderStatus = { accepted: "Accepted for delivery", failed: "Unsent", unknown: "Delivery unconfirmed", sending: "Sending" };
  function reminderActivity(records) {
    if (!records.length) return "";
    return html`<section class="wi-section"><h3>Reminder history</h3>
      <ul class="wi-workflow-log">${records.map((entry) => html`<li>
        <div><strong>${reminderStatus[entry.status]}</strong><p>${money(entry.amountPence)} · ${entry.to}</p></div>
        <span class="hint">${stamp(entry.by, entry.at)}</span>
        ${entry.status === "unknown" ? html`<button class="btn soft sm" type="button" data-sheet="review-reminder" data-id="${entry.id}">Confirm outcome</button>` : ""}
      </li>`)}</ul></section>`;
  }
  async function openReminders(invoice, back, check = true, notice = "") {
    const path = reminderPath(invoice.id);
    const state = await api("GET", path);
    let preview;
    if (check && !state.hold.reason && !state.history.some(entry => ["sending", "unknown"].includes(entry.status))) {
      try { preview = await api("POST", path + "/preview", {}); }
      catch (error) { notice = error.message; }
    }
    const subtitle = invoice.number + " · " + invoice.billTo.name;
    const blocked = state.history.some(entry => ["sending", "unknown"].includes(entry.status));
    show(html`<form id="wiReminder" class="wi-sheet wi-workflow w-sensitive">
      ${title(preview ? "Preview payment reminder" : "Payment reminders", subtitle)}
      <div class="wi-body">
        ${notice ? html`<p class="wi-workflow-note" role="status">${notice}</p>` : ""}
        ${state.hold.reason ? html`<section class="wi-linked-balance wi-section">
          <div class="wi-section-heading"><h3>Reminders on hold</h3><span class="pill warn">On hold</span></div>
          <p>${state.hold.reason}</p><p class="hint">${stamp(state.hold.by, state.hold.at)}</p>
          <button class="btn soft" type="button" data-sheet="resume-reminders">Resume reminders</button>
        </section>` : ""}
        ${preview ? html`<section class="wi-linked-balance wi-section">
          <div class="wi-section-heading"><h3>Balance in QuickBooks</h3><span class="pill ok">Verified</span></div>
          <strong class="wi-reminder-amount">${money(preview.amountPence)}</strong>
          <p>Due ${date(preview.dueDate)}${preview.paymentVoided ? " · Payment voided" : ""}</p>
          <p class="hint">Checked ${checked(preview.checkedAt)}. The balance is checked again when you send.</p>
        </section>
        <section class="wi-section">
          <div class="wi-section-heading"><h3>Email to customer</h3><button class="btn soft sm" type="button" data-sheet="hold-reminders">Hold reminders</button></div>
          <dl class="wi-reminder-meta">
            <div><dt>To</dt><dd>${preview.to} <span class="hint">${preview.recipientLabel}</span></dd></div>
            <div><dt>Subject</dt><dd>${preview.subject}</dd></div>
          </dl>
          <p class="wi-reminder-message wi-address">${preview.text}</p>
        </section>` : !state.hold.reason ? html`<section class="wi-section"><h3>QuickBooks balance</h3>
          <p>${blocked ? "Check the outcome of the previous attempt before preparing another reminder." : "Check the current overdue balance and billing email to prepare a reminder."}</p>
          <button class="btn soft" type="button" data-sheet="check-reminder">${blocked ? "Refresh reminder status" : "Check QuickBooks"}</button>
        </section>` : ""}
        ${!preview && !state.hold.reason && !state.history.some(entry => entry.status === "sending") ? html`<div><button class="btn soft sm" type="button" data-sheet="hold-reminders">Hold reminders</button></div>` : ""}
        ${reminderActivity(state.history)}
      </div>
      ${footer(preview ? "Send reminder" : null, "Back")}
    </form>`, async (action, element, form) => {
      await busy(form, async () => {
        if (action === "check-reminder") await openReminders(invoice, back);
        if (action === "hold-reminders") holdReason(invoice, state, back);
        if (action === "resume-reminders") {
          await api("PUT", path + "/hold", { held: false, ifVersion: state.hold.version });
          await openReminders(invoice, back, true, "Reminders resumed.");
        }
        if (action === "review-reminder") {
          const record = state.history.find(item => String(item.id) === element.dataset.id);
          if (record) reviewReminder(invoice, record, back);
        }
        if (action === "submit" && preview) {
          try {
            const { reminder } = await api("POST", path + "/send", { token: preview.token });
            const message = reminder.status === "accepted" ? "The reminder was accepted for delivery."
              : reminder.status === "failed" ? "The reminder was unsent. Check Email health before trying again."
                : reminder.status === "sending" ? "The reminder is sending." : "Delivery is unconfirmed. Review this attempt before sending again.";
            await openReminders(invoice, back, false, message);
          } catch (error) {
            await openReminders(invoice, back, false, error.message);
          }
        }
      });
    }, back);
  }
  function holdReason(invoice, state, back) {
    const parent = () => openReminders(invoice, back, false);
    show(html`<form class="wi-sheet wi-choice">
      ${title("Hold payment reminders", invoice.number + " · " + invoice.billTo.name)}
      <div class="wi-body wi-section">${field("Reason", html`<textarea name="reason" maxlength="300" required placeholder="e.g. Customer is disputing the invoice"></textarea>`)}
        <p class="hint">Any admin can review this reason and resume reminders when it’s resolved.</p>
      </div>${footer("Put on hold", "Back")}
    </form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        await api("PUT", reminderPath(invoice.id) + "/hold", { held: true, reason: form.elements.reason.value.trim(), ifVersion: state.hold.version });
        await openReminders(invoice, back, false);
      });
    }, parent);
  }
  function reviewReminder(invoice, record, back) {
    const parent = () => openReminders(invoice, back, false);
    show(html`<form class="wi-sheet wi-choice">
      ${title("Confirm reminder outcome", invoice.number)}
      <div class="wi-body wi-section">
        <p>Check the email provider for the payment reminder to ${record.to} attempted on ${checked(record.at)}.</p>
        ${field("Email provider result", html`<select name="outcome" required><option value="">Choose result</option><option value="accepted">Accepted for delivery</option><option value="failed">Unsent</option></select>`)}
      </div>${footer("Confirm outcome", "Back")}
    </form>`, async (action, element, form) => {
      if (action !== "submit") return;
      await busy(form, async () => {
        await api("POST", reminderPath(invoice.id) + "/confirm", { id: record.id, reviewed: true, accepted: form.elements.outcome.value === "accepted" });
        await parent();
      });
    }, parent);
  }
  return { openBilling, billingActivity, billingIssue, openReminders };
};
