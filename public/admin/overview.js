// Daily Admin overview. Data and navigation use the existing authenticated shell.
window.AdminOverview = function ({ html, raw, svg, openSheet, getData, links }) {
  const money = value => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value / 100);
  const weight = value => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value / 1000)} kg`;
  const time = value => new Date(value).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
  const shortDay = value => new Date(value + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  const count = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const arrow = () => html`<span class="ov-arrow" aria-hidden="true">${svg("chev")}</span>`;
  const action = a => a.href ? html`<a class="btn sm" href="${a.href}">${a.label}</a>` : html`<button class="btn sm" type="button" data-act="${a.act || "go"}" data-id="${a.id || a.go || ""}">${a.label}</button>`;
  const alert = a => html`<div class="ov-alert ${a.tone === "bad" ? "ov-critical" : ""}"><span class="ov-alert-icon" aria-hidden="true">${svg(a.icon)}</span><div class="ov-alert-copy">${a.eyebrow ? html`<p class="ov-eyebrow">${a.eyebrow}</p>` : ""}<h2>${a.title}</h2><p>${a.detail}</p></div>${action(a.action)}</div>`;
  const request = (label, n, icon, href) => html`<a class="ov-row ov-review-row" href="${href}"><span class="ov-row-icon" aria-hidden="true">${svg(icon)}</span><span class="ov-copy"><b>${label}</b></span><strong class="num">${n}</strong>${arrow()}</a>`;
  function view(d) {
    const x = d.daily, l = links(), systemOpen = document.querySelector("#overview-system")?.open, alertsOpen = document.querySelector(".ov-more")?.open;
    const alerts = [...x.alerts, ...d.attention.filter(a => a.dismiss?.startsWith("closed:"))];
    const routine = d.attention.filter(a => !a.dismiss?.startsWith("closed:") && (a.dismiss || a.icon === "user" || a.icon === "lock" || /isn't set up/.test(a.title)));
    const reviewCount = x.leave.annual + x.leave.other + x.shiftRequests + x.pendingAccounts;
    const oldest = x.orders.oldestAt ? `Oldest: ${new Date(x.orders.oldestAt).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" })}` : "No outstanding customer orders";
    const invoiceReview = x.invoices.reviewCount > 0;
    return html`<div class="admin-overview">
      <header class="ov-heading"><div><h1>Overview</h1><p>${new Date(x.asOf).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" })}</p></div><span class="ov-asof">As of ${time(x.asOf)}</span></header>
      ${alerts.length ? html`<section class="ov-alerts" aria-label="Needs your attention">${alert(alerts[0])}${alerts.length > 1 ? html`<details class="ov-more" ${alertsOpen ? raw("open") : ""}><summary>${count(alerts.length - 1, "more alert")}</summary><div>${alerts.slice(1).map(alert)}</div></details>` : ""}</section>` : ""}
      <div class="ov-grid">
        <section class="ov-section ov-work" aria-labelledby="ov-work-title"><header><h2 id="ov-work-title">Wholesale</h2><button class="link" type="button" data-act="overview-wholesale" data-id="all">Open wholesale</button></header><div class="ov-surface glass">
          <button class="ov-row" type="button" data-act="overview-wholesale" data-id="prepare"><span class="ov-count num">${x.orders.toPrepare}</span><span class="ov-copy"><b>Orders to prepare</b><small>${weight(x.orders.grams)} · ${oldest}</small></span>${arrow()}</button>
          <button class="ov-row" type="button" data-act="overview-wholesale" data-id="ready"><span class="ov-count num">${x.orders.ready}</span><span class="ov-copy"><b>Ready to dispatch</b><small>${x.orders.ready ? "Prepared and awaiting fulfilment" : "No orders awaiting dispatch"}</small></span>${arrow()}</button>
          <button class="ov-row" type="button" data-act="overview-wholesale" data-id="invoices"><span class="ov-row-icon" aria-hidden="true">${svg("doc")}</span><span class="ov-copy"><b>${invoiceReview ? "Invoice balances need review" : count(x.invoices.overdueCount, "overdue invoice")}</b><small>${invoiceReview ? `${count(x.invoices.reviewCount, "payment check")} · Review in Invoicing` : x.invoices.overdueCount ? "Outstanding after recorded payments" : "No overdue balances recorded"}</small></span>${!invoiceReview && x.invoices.overdueCount ? html`<strong class="ov-money num">${money(x.invoices.overduePence)}</strong>` : ""}${arrow()}</button>
        </div></section>
        <section class="ov-section ov-reviews" aria-labelledby="ov-review-title"><header><h2 id="ov-review-title">Awaiting review</h2><span>${count(reviewCount, "request")}</span></header><div class="ov-surface glass">
          ${request("Holiday requests", x.leave.annual, "cal", `${l.rota}#leave-admin`)}
          ${request((x.shiftRequests === 1 ? "Shift request" : "Shift requests"), x.shiftRequests, "clock", `${l.rota}#requests`)}
          ${x.leave.other ? request("Other absence requests", x.leave.other, "cal", `${l.rota}#leave-admin`) : ""}
          <button class="ov-row ov-review-row" type="button" data-act="wh-pending"><span class="ov-row-icon" aria-hidden="true">${svg("people")}</span><span class="ov-copy"><b>Wholesale applications</b></span><strong class="num">${x.pendingAccounts}</strong>${arrow()}</button>
        </div></section>
        <section class="ov-section ov-sites" aria-labelledby="ov-sites-title"><header><h2 id="ov-sites-title">Sites today</h2><span>Diary checks</span></header><div class="ov-surface glass">${x.sites.length ? x.sites.map(s => html`<button class="ov-row ov-site-row" type="button" data-act="overview-site" data-id="${s.id}"><b>${s.name}</b><span class="ov-site-status ${s.done ? "ov-done" : s.overdue ? "ov-overdue" : ""}">${s.done ? svg("ok") : ""}${s.label}</span>${arrow()}</button>`) : html`<p class="ov-empty">No diary sites are set up yet. <button class="link" type="button" data-go="sites">Open Sites</button></p>`}</div><p class="ov-note">Saved site hours set the deadlines. Overdue checks appear above.</p></section>
        <section class="ov-section ov-planning" aria-labelledby="ov-coming-title"><header><h2 id="ov-coming-title">Coming up</h2><span>Next week</span></header><div class="ov-surface glass"><div class="ov-event"><span class="ov-calendar"><small>MON</small><strong class="num">${Number(x.nextWeek.week.slice(8))}</strong></span><div><div class="ov-event-title"><h3>Next week’s rota</h3><span class="pill ${x.nextWeek.published ? "ok" : ""}">${x.nextWeek.published ? "Published" : "Draft"}</span></div><p>Week of ${shortDay(x.nextWeek.week)} · ${count(x.nextWeek.shifts, "shift")}${x.nextWeek.open ? ` · ${x.nextWeek.open} unassigned` : ""}</p><a class="link" href="${l.rota}#week/${x.nextWeek.week}">${x.nextWeek.published ? "View rota" : "Review rota"}</a></div></div>
          <a class="ov-leave-row" href="${l.rota}#leave"><span aria-hidden="true">${svg("cal")}</span><span>${count(x.annualLeaveMonday, "person", "people")} on annual leave Monday</span>${arrow()}</a>
          ${!x.thisWeekPublished ? html`<a class="ov-leave-row ov-overdue" href="${l.rota}#week/${d.week}"><span>This week’s rota is not published</span>${arrow()}</a>` : ""}
        </div></section>
      </div>
      <details class="ov-system" id="overview-system" ${systemOpen ? raw("open") : ""}><summary><span>System &amp; accounts</span><span>Background checks <span aria-hidden="true">⌄</span></span></summary><div class="ov-system-content">
        <section><h2>Backups &amp; accounts</h2><p>${d.stats.backup ? `Last backup: ${new Date(d.stats.backup.at).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "No backups yet"}</p><p>${d.stats.people.active} active accounts · ${d.stats.people.notSignedIn} have not signed in.</p><div class="ov-background-actions"><button class="link" type="button" data-go="data">Backups &amp; exports</button><button class="link" type="button" data-go="people">People</button><button class="link" type="button" data-go="sites">Site setup</button></div></section>
        <section aria-labelledby="rem"><h2 id="rem">Rota emails</h2><p>${d.emails.ready ? `${d.emails.sentToday} sent in the last day.` : "Email delivery is not configured."}</p><p>${d.emails.withAddress} of ${d.emails.active} ${d.emails.active === 1 ? "person has" : "people have"} an email address.</p>${d.emails.ready ? html`<div class="email-actions"><button class="btn sm soft" type="button" data-act="testemail">Send me a test email</button><button class="btn sm soft" type="button" data-act="weeklytest">Send me this week's summary</button></div>` : ""}</section>
        ${routine.length ? html`<section class="ov-background-notices"><h2>Notices</h2>${routine.map(a => html`<div class="item"><span class="tx"><b>${a.title}</b><span>${a.detail}</span></span><span class="end">${action(a.action)}${a.dismiss ? html`<button class="btn sm soft" type="button" data-act="dismiss" data-id="${a.dismiss}" aria-label="Dismiss ${a.title}">${svg("x")}</button>` : ""}</span></div>`)}</section>` : ""}
      </div></details>
    </div>`;
  }
  function site(id) {
    const s = getData()?.daily.sites.find(row => row.id === id);
    if (!s) return;
    openSheet(html`<div class="ov-site-sheet"><header><div><h2 id="sheetTitle">${s.name} diary</h2><p>Today · ${s.status}</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></header><p>${s.dueAt ? `${s.overdue ? "Overdue since" : "Due at"} ${s.dueAt}, from this site’s saved opening hours.` : s.done ? "The daily diary has been signed off." : s.closed ? s.status : "No deadline is configured for the remaining checks."}</p><p class="hint">Open the diary and select ${s.name} to review or complete its checks.</p><a class="btn" href="${links().diary}#day">Open diary</a></div>`);
  }
  return { view, site };
};
