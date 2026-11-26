// Daily Admin overview. Data and navigation use the existing authenticated shell.
window.AdminOverview = function ({ html, svg, openSheet, getData, links }) {
  const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
  const kg = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
  const time = value => new Date(value).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  const date = (value, options) => new Date(value).toLocaleDateString("en-GB", { timeZone: "Europe/London", ...options });
  const shortDay = value => date(value + "T12:00:00Z", { day: "numeric", month: "short" });
  const count = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const arrow = () => html`<span class="ov-arrow" aria-hidden="true">${svg("chev")}</span>`;
  const badge = (label, tone) => html`<span class="pill ov-pill ${tone || ""}">${label}</span>`;
  const wholesale = id => ({ act: "overview-wholesale", id });
  const diarySite = id => ({ act: "overview-site", id });

  function link(a, className, content, id) {
    const identity = id ? html`id="${id}"` : "";
    return a.href
      ? html`<a ${identity} class="${className}" href="${a.href}">${content}</a>`
      : html`<button ${identity} class="${className}" type="button" data-act="${a.act || "go"}" data-id="${a.id || a.go || ""}">${content}</button>`;
  }

  function row({ title, detail, action, icon, tone, status, value, total, dismiss, id, className = "" }) {
    const content = html`
      ${total != null ? html`<span class="ov-count num">${total}</span>` : icon ? html`<span class="ov-row-icon ${tone || ""}" aria-hidden="true">${svg(icon)}</span>` : ""}
      <span class="ov-copy"><b>${title}</b>${detail ? html`<small>${detail}</small>` : ""}</span>
      ${value != null ? html`<strong class="ov-value num">${value}</strong>` : ""}
      ${status ? badge(status, tone) : ""}
      ${arrow()}`;
    const button = link(action, "ov-row " + className, content, id);
    return dismiss ? html`<div class="ov-notice">${button}<div class="ov-dismiss"><button class="btn soft icononly" type="button" data-act="dismiss" data-id="${dismiss}" aria-label="Dismiss ${title}">${svg("x")}</button></div></div>` : button;
  }

  function metric(id, total, label, action) {
    return link(action, "ov-metric glass", html`<strong class="num">${total}</strong><span>${label}</span>`, id);
  }

  function view(d) {
    const x = d.daily, l = links();
    const overdueCount = x.invoices.overdueCount;
    const paymentChecks = x.invoices.reviewCount;
    const overdue = {
      title: count(overdueCount, "overdue invoice"),
      detail: overdueCount ? "Invoicing · Outstanding after recorded payments" : "No overdue balances recorded",
      action: wholesale("invoices"), icon: "doc", tone: overdueCount ? "bad" : "",
      value: overdueCount ? gbp.format(x.invoices.overduePence / 100) : undefined,
    };
    const paymentReview = {
      title: "Invoice balances need review", detail: count(paymentChecks, "payment check"),
      action: wholesale("invoice-review"), icon: "doc", tone: "warn",
    };
    const shiftRequests = {
      title: "Shift requests", icon: "people", value: x.shiftRequests,
      action: { href: l.rota + "#requests" },
    };
    const timedSites = x.sites.filter(site => !site.done && !site.closed && !site.overdue && site.dueAt)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const closures = d.attention.filter(notice => notice.dismiss?.startsWith("closed:")).map(notice => {
      const id = notice.dismiss.split(":")[1];
      return { ...notice, action: x.sites.some(site => site.id === id) ? diarySite(id) : notice.action };
    });
    const operationalNotices = [
      ...x.alerts,
      ...closures,
      ...d.attention.filter(notice => notice.action.href === "#wholesale/invoices"),
    ];
    // Leave deadlines and accrual reviews belong with the routine requests. Scheduled rota publication is in Next up.
    const peopleNotices = d.attention.filter(notice => notice.action.href === l.rota + "#leave-admin");
    const backgroundNotices = d.attention.filter(notice => !notice.dismiss?.startsWith("closed:") &&
      (notice.dismiss || notice.icon === "user" || notice.icon === "lock" || notice.action.go === "sites"));
    const due = [
      x.orders.prepareToday > 0 && {
        title: "Prepare orders scheduled today", detail: "Wholesale · Due to dispatch today",
        total: x.orders.prepareToday, status: "Today", tone: "acc", action: wholesale("due-prepare"),
      },
      x.orders.readyToday > 0 && {
        title: "Dispatch orders scheduled today", detail: "Wholesale · Packed and ready",
        total: x.orders.readyToday, status: "Ready", tone: "ok", action: wholesale("due-ready"), id: "ov-due-ready",
      },
      overdueCount > 0 && { ...overdue, status: "Overdue", id: "ov-due-invoices" },
      paymentChecks > 0 && { ...paymentReview, status: "Review", id: "ov-attention-payment-review" },
      x.shiftRequests > 0 && { ...shiftRequests, title: `Review ${count(x.shiftRequests, "shift request")}`, detail: "Rota · Awaiting approval", value: undefined, status: "Review", tone: "acc" },
    ].filter(Boolean);

    const oldest = x.orders.oldestAt
      ? `Oldest order ${date(x.orders.oldestAt, { day: "numeric", month: "short" })}`
      : "No outstanding customer orders";

    return html`<div class="admin-overview">
      <header class="ov-heading">
        <div><h1>Today</h1><p>${date(x.asOf, { weekday: "long", day: "numeric", month: "long" })}</p></div>
        <button class="btn" type="button" data-act="overview-wholesale" data-id="all">Open order queue</button>
      </header>
      <div class="ov-metrics" role="group" aria-label="Today’s queues">
        ${metric("ov-count-ready", x.orders.readyToday, "Ready to dispatch today", wholesale("due-ready"))}
        ${metric("ov-count-invoices", paymentChecks || overdueCount, paymentChecks ? "Balances to check" : "Overdue invoices", wholesale(paymentChecks ? "invoice-review" : "invoices"))}
        ${metric("ov-count-requests", x.shiftRequests, "Shift requests", shiftRequests.action)}
      </div>

      <div class="ov-grid">
        <section class="ov-section ov-today ov-surface glass" aria-labelledby="ov-today-title">
          <header><h2 id="ov-today-title">Needs attention</h2><span>${count(operationalNotices.length + due.length, "item")}</span></header>
          ${operationalNotices.length ? html`<div class="ov-alerts">${operationalNotices.map(notice => row({
            ...notice, detail: [notice.eyebrow, notice.detail].filter(Boolean).join(" · "),
            status: notice.tone === "bad" ? "Urgent" : notice.dismiss ? "Closed" : notice.action.act === "overview-site" ? "Overdue" : "Review",
          }))}</div>` : ""}
          ${due.map(row)}
          ${!operationalNotices.length && !due.length ? html`<p class="ov-empty"><span class="ov-row-icon ok" aria-hidden="true">${svg("ok")}</span>Nothing needs attention right now.</p>` : ""}
        </section>

        <div class="ov-side">
          <section class="ov-section ov-planning ov-surface glass" aria-labelledby="ov-coming-title">
            <header><h2 id="ov-coming-title">Next up</h2></header>
            ${timedSites.map(site => row({
              title: site.name, detail: site.status, icon: "cal", status: site.label, tone: "acc", action: diarySite(site.id), id: `ov-next-${site.id}`,
            }))}
            ${!x.thisWeekPublished ? row({ title: "Publish this week’s rota", action: { href: `${l.rota}#week/${d.week}` }, icon: "warn", tone: "warn" }) : ""}
            ${row({
              title: "Next week’s rota",
              detail: `Week of ${shortDay(x.nextWeek.week)} · ${count(x.nextWeek.shifts, "shift")}${x.nextWeek.open ? ` · ${x.nextWeek.open} unassigned` : ""}`,
              icon: "cal", status: x.nextWeek.published ? "Published" : "Draft", tone: x.nextWeek.published ? "ok" : "",
              action: { href: `${l.rota}#week/${x.nextWeek.week}` },
            })}
            ${row({
              title: "Next roast plan", detail: `Week of ${shortDay(x.nextWeek.week)}`,
              icon: "coffee", action: { act: "overview-roast" },
            })}
            ${x.annualLeaveMonday ? row({
              title: count(x.annualLeaveMonday, "person", "people") + " on annual leave Monday",
              icon: "people", action: { href: l.rota + "#leave" },
            }) : ""}
          </section>

          <section class="ov-section ov-sites ov-surface glass" aria-labelledby="ov-sites-title">
            <header><h2 id="ov-sites-title">Site diary checks</h2></header>
            ${x.sites.length ? x.sites.map(s => row({
              title: s.name, status: s.label, tone: s.done ? "ok" : s.overdue ? "warn" : "",
              action: diarySite(s.id), className: "ov-site-row", id: `ov-diary-${s.id}`,
            })) : html`<p class="ov-empty">No diary sites are set up. <button class="link" type="button" data-go="sites">Open Sites</button></p>`}
          </section>
        </div>
      </div>

      <div class="ov-grid ov-secondary">
        <section class="ov-section ov-work ov-surface glass" aria-labelledby="ov-work-title">
          <header><h2 id="ov-work-title">Wholesale queues</h2></header>
          ${row({
            title: "Orders to prepare", detail: `${kg.format(x.orders.grams / 1000)} kg · ${oldest}`,
            action: wholesale("prepare"), total: x.orders.toPrepare,
          })}
          ${row({
            title: "Ready to dispatch", detail: x.orders.ready ? "Prepared and awaiting fulfilment" : "No orders awaiting dispatch",
            action: wholesale("ready"), total: x.orders.ready,
          })}
          ${row({ ...overdue, id: "ov-wholesale-overdue" })}
          ${paymentChecks ? row({ ...paymentReview, id: "ov-wholesale-payment-review" }) : ""}
        </section>

        <section class="ov-section ov-reviews ov-surface glass" aria-labelledby="ov-review-title">
          <header><h2 id="ov-review-title">Awaiting review</h2><span>${count(x.leave.annual + x.leave.other + x.shiftRequests + x.pendingAccounts, "request")}</span></header>
          ${row({ title: "Holiday requests", icon: "cal", value: x.leave.annual, action: { href: l.rota + "#leave-admin" } })}
          ${row(shiftRequests)}
          ${x.leave.other ? row({ title: "Other absence requests", icon: "cal", value: x.leave.other, action: { href: l.rota + "#leave-admin" } }) : ""}
          ${row({ title: "Wholesale applications", icon: "people", value: x.pendingAccounts, action: { act: "wh-pending" } })}
          ${peopleNotices.map(notice => row({ ...notice, status: "Review" }))}
        </section>
      </div>

      <details class="ov-system ov-surface glass" id="overview-system" data-preserve-open="overview-system">
        <summary><span>System &amp; accounts</span><span class="ov-summary-asof">As of ${time(x.asOf)}</span>${arrow()}</summary>
        <div class="ov-system-content">
          <section><h2>Backups &amp; accounts</h2>
            <p>${d.stats.backup ? `Last backup ${date(d.stats.backup.at, { day: "numeric", month: "short" })}, ${time(d.stats.backup.at)}` : "No backups yet"}</p>
            <p>${count(d.stats.people.active, "active account")} · ${d.stats.people.notSignedIn} ${d.stats.people.notSignedIn === 1 ? "hasn't" : "haven't"} signed in.</p>
            <div class="ov-background-actions"><button class="link" type="button" data-go="data">Backups &amp; exports</button><button class="link" type="button" data-go="people">People</button><button class="link" type="button" data-go="sites">Site setup</button></div>
          </section>
          <section aria-labelledby="rem"><h2 id="rem">Rota emails</h2>
            <p>${d.emails.ready ? `${d.emails.sentToday} accepted by Resend in the last day.` : "Email delivery is not configured."}</p>
            <p>${count(d.emails.withAddress, "email address", "email addresses")} on file across ${count(d.emails.active, "active account")}.</p>
            ${d.emails.ready ? html`<div class="ov-background-actions"><button class="btn sm soft" type="button" data-act="testemail">Send me a test email</button><button class="btn sm soft" type="button" data-act="weeklytest">Send me this week’s summary</button></div>` : ""}
          </section>
          ${backgroundNotices.length ? html`<section class="ov-background-notices" aria-labelledby="ov-notices"><h2 id="ov-notices">Notices</h2>
            ${backgroundNotices.map(notice => html`<div class="item has-action">
              <span class="ov-row-icon ${notice.tone}" aria-hidden="true">${svg(notice.icon)}</span>
              <span class="tx"><b>${notice.title}</b><span>${notice.detail}</span></span>
              <span class="end">${link(notice.action, "btn sm soft", notice.action.label)}
              ${notice.dismiss ? html`<button class="btn soft icononly" type="button" data-act="dismiss" data-id="${notice.dismiss}" aria-label="Dismiss ${notice.title}">${svg("x")}</button>` : ""}</span>
            </div>`)}
          </section>` : ""}
        </div>
      </details>
    </div>`;
  }

  function site(id) {
    const s = getData()?.daily.sites.find(row => row.id === id);
    if (!s) return;
    const target = new URL(links().diary, location.origin);
    target.searchParams.set("site", s.id);
    target.hash = "day";
    const detail = s.dueAt
      ? `${s.overdue ? "Overdue since" : "Due at"} ${s.dueAt}, from this site’s saved hours.`
      : s.done ? "The daily diary has been signed off." : s.closed ? s.status : "No deadline is configured for the remaining checks.";
    openSheet(html`<div class="ov-site-sheet">
      <header><div><h2 id="sheetTitle">${s.name} diary</h2><p>${s.status}</p></div><button class="btn soft icononly" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></header>
      <p>${detail}</p>
      <a class="btn" href="${target.href}">Open diary</a>
    </div>`);
  }

  return { view, site };
};
