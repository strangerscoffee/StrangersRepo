// Admin → Sickness: everyone's self-certified sickness forms and their Bradford Factor (S² × D over the last 52 weeks),
// colour-coded by trigger point with the usual action at each. Forms are sent from the rota's Report sickness page
// (public/rota/sickness.js); this page reads /api/rota/sickness (admins only) and can remove a record, which puts the
// shift hours back.
window.AdminSickness = function ({ api, html, raw, svg, put, head, openSheet, closeSheet, reload, toast, links }) {
  let data = null, filter = "sick";
  const date = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const span = (r) => r.kind === "early" ? `${date(r.from)}, went home at ${r.leftAt}` : r.from === r.to ? date(r.from) : `${date(r.from)} – ${date(r.to)}`;
  const daysText = (n) => `${n % 1 ? n.toFixed(1) : n} ${n === 1 ? "day" : "days"}`;
  const band = (e) => html`<span class="sk-band sk-${e.band.key}"><b>${e.score}</b>${e.band.label}</span>`;
  const yes = (v) => (v ? "Yes" : "No");
  const rotaLink = (userId) => `${(links().rota || "/rota/").replace(/#.*$/, "")}#sick${userId ? "/" + userId : ""}`;

  async function view() {
    data = await api("GET", "/api/rota/sickness");
    const shown = filter === "sick" ? data.employees.filter((e) => e.score > 0 || e.recordsThisYear) : data.employees;
    const flagged = data.employees.filter((e) => e.band.key !== "none").length;
    return html`${head("Sickness", "Self-certified sickness forms and each person's Bradford Factor over the last 52 weeks. Only admins can see this page.", html`<a class="btn" href="${rotaLink()}">${svg("plus")}Record sickness</a>`)}
      <div class="sk-page">
        <details class="sk-scale glass"><summary><b>Bradford Factor trigger points</b><span>${flagged ? `${flagged} ${flagged === 1 ? "person is" : "people are"} at a trigger point` : "No one is at a trigger point"}</span></summary>
          <p class="hint">Score = spells × spells × days off, over the last 52 weeks. Separate spells count most, so frequent short absences score higher than one long one. Going home early counts as half a day. Use the action as a guide alongside your absence policy, and check for health or disability reasons first.</p>
          <div class="sk-bands">${data.bands.map((b) => html`<div class="sk-band-row"><span class="sk-band sk-${b.key}"><b>${b.max == null ? `${b.min}+` : `${b.min}–${b.max}`}</b>${b.label}</span><span>${b.action}</span></div>`)}</div>
        </details>
        <div class="row sk-filter"><div class="seg" role="group" aria-label="Who to show"><button type="button" data-act="sick-filter" data-id="sick" aria-pressed="${filter === "sick"}">With sickness</button><button type="button" data-act="sick-filter" data-id="all" aria-pressed="${filter === "all"}">Everyone</button></div></div>
        ${shown.length ? html`<div class="group glass sk-people">${shown.map((e) => html`<button class="item sk-person" type="button" data-act="sick-person" data-id="${e.userId}">
            <span class="tx"><b>${e.name}</b><span>${e.spells ? `${e.spells} ${e.spells === 1 ? "spell" : "spells"} · ${daysText(e.days)}` : "No sickness in the last 52 weeks"}${e.lastSick ? ` · last ${date(e.lastSick)}` : ""}</span>${e.band.key !== "none" ? html`<span class="sk-action">${e.band.action}</span>` : ""}</span>
            <span class="end">${band(e)}<span class="chev">${svg("chev")}</span></span></button>`)}</div>`
          : html`<div class="group glass"><div class="empty">${svg("heart")}<span>No sickness recorded in the last 52 weeks.</span></div></div>`}
        <h2 class="sk-h">Recent forms</h2>
        ${data.records.length ? html`<div class="group glass">${data.records.slice(0, 15).map((r) => html`<button class="item" type="button" data-act="sick-record" data-id="${r.id}"><span class="tx"><b>${r.name}</b><span>${span(r)} · ${r.answers.category}</span>${r.answers.onBehalf ? html`<span>Recorded by ${r.createdBy}</span>` : ""}</span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)}</div>`
          : html`<p class="hint">No forms yet. Staff send them from the rota: My shifts → Off sick or went home early?</p>`}
      </div>`;
  }

  function answers(r) {
    const a = r.answers;
    return html`<div class="sk-answers">
      <div class="kv"><span>${r.kind === "early" ? "Went home early" : "Off sick"}</span><span>${span(r)}</span></div>
      <div class="kv"><span>What was wrong</span><span>${a.category}</span></div>
      <p class="sk-details">${a.details}</p>
      <div class="kv"><span>Sickness (vomiting) or diarrhoea</span><span>${yes(a.vomiting)}</span></div>
      <div class="kv"><span>Saw a doctor, nurse or pharmacist</span><span>${yes(a.doctor)}</span></div>
      <div class="kv"><span>Accident or injury at work</span><span>${yes(a.workAccident)}</span></div>
      ${a.fitNote ? html`<p class="sk-flag">Over 7 days: a fit note from a doctor is needed.</p>` : ""}
      ${a.vomiting ? html`<p class="sk-flag">Food handler: 48 hours clear of symptoms before returning to work.</p>` : ""}
      ${a.workAccident ? html`<p class="sk-flag">Check it's in the Accident book.</p>` : ""}
      ${r.changes.length ? html`<div class="kv"><span>Hours on the rota</span><span>${r.changes.map((c) => `${date(c.day)} ${c.start}–${c.end}: ${c.hoursBefore} h → ${c.hoursAfter} h`).join("; ")}</span></div>` : html`<div class="kv"><span>Hours on the rota</span><span>No shifts changed</span></div>`}
      <p class="hint">Declared by ${a.declaredBy}${a.onBehalf ? " on their behalf" : ""} on ${new Date(a.declaredAt).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}.</p>
    </div>`;
  }

  function openRecord(id, confirm = false, error = "") {
    const r = data?.records.find((x) => x.id === id);
    if (!r) return;
    openSheet(html`<div class="w-sheet sk-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${r.name}</h2><p class="hint">Self-certified sickness form</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      ${answers(r)}
      <p class="err" role="alert">${error}</p>
      <div class="row w-actions">${confirm ? html`<span class="sk-confirm">Remove this record? The absence is cancelled and the shift hours go back to how they were.</span><button class="btn soft" type="button" data-sheet="sk-keep">Keep it</button><button class="btn danger-fill" type="button" data-sheet="sk-remove-now">Remove</button>`
        : html`<button class="btn soft" type="button" data-sheet="sk-person" data-id="${r.userId}">All of ${r.name.split(" ")[0]}'s sickness</button><button class="btn soft danger" type="button" data-sheet="sk-remove">Remove record</button>`}</div></div>`,
    async (action, element) => {
      if (action === "sk-remove") return openRecord(id, true);
      if (action === "sk-keep") return openRecord(id);
      if (action === "sk-person") return openPerson(r.userId);
      if (action !== "sk-remove-now") return;
      element.disabled = true;
      try { await api("DELETE", `/api/rota/sickness/${encodeURIComponent(id)}`); closeSheet(); toast("Sickness record removed."); await reload(); }
      catch (err) { openRecord(id, false, err.message); }
    });
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  function openPerson(userId) {
    const e = data?.employees.find((x) => x.userId === userId);
    if (!e) return;
    const mine = data.records.filter((r) => r.userId === userId);
    openSheet(html`<div class="w-sheet sk-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${e.name}</h2><p class="hint">Bradford Factor, last 52 weeks (since ${date(data.since)})</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="sk-score sk-${e.band.key}"><span class="sk-sum">${e.spells} × ${e.spells} × ${e.days % 1 ? e.days.toFixed(1) : e.days} =</span><b>${e.score}</b><span class="sk-band sk-${e.band.key}">${e.band.label}</span></div>
      <p class="sk-next"><b>Usual action:</b> ${e.band.action}</p>
      <h3>Forms</h3>
      ${mine.length ? html`<div class="group">${mine.map((r) => html`<button class="item" type="button" data-sheet="sk-open" data-id="${r.id}"><span class="tx"><b>${span(r)}</b><span>${r.answers.category}${r.from < data.since ? " · before the 52 weeks" : ""}</span></span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)}</div>` : html`<p class="hint">No sickness forms.</p>`}
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Close</button><a class="btn" href="${rotaLink(userId)}">${svg("plus")}Record sickness</a></div></div>`,
    (action, element) => { if (action === "sk-open") openRecord(element.dataset.id); });
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  return {
    view,
    async act(name, id) {
      if (name === "sick-filter") { filter = id === "all" ? "all" : "sick"; await reload(); }
      if (name === "sick-person") openPerson(id);
      if (name === "sick-record") openRecord(id);
    },
  };
};
