// Admin → Sickness: everyone's sickness absences and self-certified forms, and their Bradford Factor (S² × D over the
// last 52 weeks, from every approved sickness absence: forms, the rota and WhosOff; part days don't count), colour-coded
// by trigger point with the usual action at each, when it next goes down and when it clears. Admins can leave an
// absence out with a reason or join it to the spell before, and see what needs checking. Forms are sent from the
// rota's Report sickness page (public/rota/sickness.js); this page reads /api/rota/sickness (admins only) and can remove
// a form, which puts the shift hours back.
window.AdminSickness = function ({ api, html, raw, svg, put, head, openSheet, closeSheet, reload, toast, links }) {
  let data = null, filter = "sick", query = "", timer, generation = 0;
  const date = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const span = (r) => r.kind === "early" ? `${date(r.from)}, went home at ${r.leftAt}` : r.from === r.to ? date(r.from) : `${date(r.from)} – ${date(r.to)}`;
  const daysText = (n) => `${n % 1 ? n.toFixed(1) : n} ${n === 1 ? "day" : "days"}`;
  const band = (e) => html`<span class="sk-band sk-${e.band.key}"><b>${e.score}</b>${e.band.label}</span>`;
  const yes = (v) => (v ? "Yes" : "No");
  const SRC = { "Sickness form": "Sickness form", "Imported from WhosOff": "From WhosOff", "Recorded in the rota": "Recorded in the rota" };
  const absenceSpan = (a) => a.partial ? `${date(a.from)}, part day${a.fromTime ? ` (${a.fromTime}–${a.toTime || "end"})` : ""}` : a.from === a.to ? date(a.from) : `${date(a.from)} – ${date(a.to)}`;
  const status = (a) => a.partial ? html`<span class="sk-chip">Part day · not counted</span>` : a.excluded ? html`<span class="sk-chip">Left out · ${a.excluded}</span>` : html`<span class="sk-chip on">Counted${a.continues ? " · same spell" : ""}</span>`;
  const when = (e) => e.score ? `${e.nextDrop ? `Goes down to ${e.nextDrop.score} on ${date(e.nextDrop.on)}` : ""}${e.nextDrop && e.clearsOn ? "; " : ""}${e.clearsOn ? `clears on ${date(e.clearsOn)}` : ""}` : "";
  const rotaLink = (userId) => `${(links().rota || "/rota/").replace(/#.*$/, "")}#sick${userId ? "/" + userId : ""}`;

  async function view() {
    const started = ++generation;
    const result = await api("GET", "/api/rota/sickness");
    if (started !== generation) return html``;
    data = result;
    const matches = name => name.toLowerCase().includes(query.trim().toLowerCase());
    const shown = data.employees.filter(employee => matches(employee.name) &&
      (filter === "all" || (filter === "review" ? employee.band.key !== "none" : employee.score > 0 || employee.recordsThisYear)));
    const records = data.records.filter(record => matches(record.name));
    const flagged = data.employees.filter((e) => e.band.key !== "none").length;
    return html`${head("Sickness", "Review absences, self-certified forms and Bradford Factor scores.", html`<a class="btn" href="${rotaLink()}">${svg("plus")}Record sickness</a>`)}
      <div class="sk-page">
        ${data.review.length ? html`<section class="sk-review glass" aria-label="To check"><h2 class="sk-h">To check · ${data.review.length}</h2><p class="hint">Nothing here is changed automatically. Open the person to decide.</p><div class="group">${data.review.map((f) => html`<button class="item" type="button" data-act="sick-person" data-id="${f.userId}"><span class="tx"><b>${f.name}</b><span>${f.text}</span></span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)}</div></section>` : ""}
        <div class="row glass sk-filter team-toolbar"><label class="search">${svg("search")}<input id="sickSearch" type="search" aria-label="Search sickness records" placeholder="Search by name" maxlength="120" value="${query}"></label><div class="seg admin-filters" role="group" aria-label="Who to show"><button type="button" data-act="sick-filter" data-id="sick" aria-pressed="${filter === "sick"}">With sickness</button><button type="button" data-act="sick-filter" data-id="review" aria-pressed="${filter === "review"}">Needs follow-up</button><button type="button" data-act="sick-filter" data-id="all" aria-pressed="${filter === "all"}">Everyone</button></div></div>
        <div class="team-columns sk-workspace"><section class="group glass team-panel">
          <header class="team-panel-head"><div><h2>Absence records</h2><p>Bradford Factor over the last 52 weeks</p></div><span class="team-panel-count">${shown.length} ${shown.length === 1 ? "person" : "people"}</span></header>
        ${shown.length ? html`<div class="group sk-people">${shown.map((e) => html`<button class="item sk-person" type="button" data-act="sick-person" data-id="${e.userId}">
            <span class="tx"><b>${e.name}</b><span>${e.spells ? `${e.spells} ${e.spells === 1 ? "spell" : "spells"} · ${daysText(e.days)}` : "No counted sickness in the last 52 weeks"}${e.lastSick ? ` · last ${date(e.lastSick)}` : ""}${e.partDays ? ` · ${e.partDays} part ${e.partDays === 1 ? "day" : "days"} not counted` : ""}</span>${e.score ? html`<span>${when(e)}</span>` : ""}${e.toReview ? html`<span class="sk-action">${e.toReview} to check</span>` : ""}${e.band.key !== "none" ? html`<span class="sk-action">${e.band.action}</span>` : ""}</span>
            <span class="end">${band(e)}<span class="chev">${svg("chev")}</span></span></button>`)}</div>`
          : html`<div class="empty">${svg("heart")}<span>${query || filter === "review" ? "No matching people." : "No sickness recorded in the last 52 weeks."}</span></div>`}</section>
        <div class="team-stack">
          <details class="sk-scale glass" data-preserve-open="sickness-scale"><summary><span class="sk-scale-copy"><b>Bradford Factor trigger points</b><span>${flagged ? `${flagged} ${flagged === 1 ? "person is" : "people are"} at a trigger point` : "No one is at a trigger point"}</span></span>${svg("chev")}</summary>
            <p class="hint">The score multiplies the square of the number of spells by days off over the last 52 weeks. Consecutive days count as one spell. Part days are excluded. A trigger starts a review of the circumstances, including health, disability and pregnancy.</p>
            <div class="sk-bands">${data.bands.map((b) => html`<div class="sk-band-row"><span class="sk-band sk-${b.key}"><b>${b.max == null ? `${b.min}+` : `${b.min}–${b.max}`}</b>${b.label}</span><span>${b.action}</span></div>`)}</div>
          </details>
          <section class="group glass team-panel"><header class="team-panel-head"><div><h2>Recent forms</h2></div></header>
            ${records.length ? records.slice(0, 15).map((r) => html`<button class="item" type="button" data-act="sick-record" data-id="${r.id}"><span class="ic acc">${svg("doc")}</span><span class="tx"><b>${r.name}</b><span>${span(r)} · ${r.answers.category}</span>${r.answers.onBehalf ? html`<span>Recorded by ${r.createdBy}</span>` : ""}</span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)
              : html`<div class="empty">${svg("doc")}<span>No self-certified forms submitted.</span></div>`}
          </section>
        </div></div>
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
    const mine = data.records.filter((r) => r.userId === userId), absences = data.absences.filter((a) => a.userId === userId), flags = data.review.filter((f) => f.userId === userId);
    openSheet(html`<div class="w-sheet sk-sheet"><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${e.name}</h2><p class="hint">Bradford Factor, last 52 weeks (since ${date(data.since)})</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <div class="sk-score sk-${e.band.key}"><span class="sk-sum">${e.spells} × ${e.spells} × ${e.days} =</span><b>${e.score}</b><span class="sk-band sk-${e.band.key}">${e.band.label}</span></div>
      ${e.score ? html`<p class="sk-next"><b>When it falls:</b> ${when(e)}. Each day off stops counting 52 weeks after it.</p>` : ""}
      <p class="sk-next"><b>Usual action:</b> ${e.band.action}</p>
      ${e.partDays || e.leftOut ? html`<p class="hint">${e.partDays ? `${e.partDays} part ${e.partDays === 1 ? "day isn't" : "days aren't"} counted. ` : ""}${e.leftOut ? `${e.leftOut} ${e.leftOut === 1 ? "absence is" : "absences are"} left out.` : ""}</p>` : ""}
      ${flags.length ? html`<h3>To check</h3>${flags.map((f) => html`<p class="sk-flag">${f.text}</p>`)}` : ""}
      <h3>Sickness absences</h3>
      ${absences.length ? html`<div class="group">${absences.map((a) => html`<button class="item" type="button" data-sheet="sk-absence" data-id="${a.id}"><span class="tx"><b>${absenceSpan(a)}</b><span>${SRC[a.source] || a.source}${a.from < data.since ? " · before the 52 weeks" : ""}</span>${status(a)}</span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)}</div>` : html`<p class="hint">No sickness absences.</p>`}
      <h3>Forms</h3>
      ${mine.length ? html`<div class="group">${mine.map((r) => html`<button class="item" type="button" data-sheet="sk-open" data-id="${r.id}"><span class="tx"><b>${span(r)}</b><span>${r.answers.category}${r.from < data.since ? " · before the 52 weeks" : ""}</span></span><span class="end"><span class="chev">${svg("chev")}</span></span></button>`)}</div>` : html`<p class="hint">No sickness forms.</p>`}
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Close</button><a class="btn" href="${rotaLink(userId)}">${svg("plus")}Record sickness</a></div></div>`,
    (action, element) => { if (action === "sk-open") openRecord(element.dataset.id); if (action === "sk-absence") openAbsence(element.dataset.id); });
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  // One absence: where it came from, whether it counts, and the admin's decision (left out with a reason, or the same
  // spell as the one before). Saved with its version; the change is logged.
  function openAbsence(id, error = "") {
    const a = data?.absences.find((x) => x.id === id);
    if (!a) return;
    const reasons = data.excludeReasons, preset = a.excluded && reasons.includes(a.excluded) ? a.excluded : a.excluded ? "Other" : "";
    const form = data.records.find((r) => r.timeOffId === a.id);
    openSheet(html`<form class="w-sheet sk-sheet" id="skAbsenceForm" novalidate><div class="wp-sheet-head"><div><h2 id="sheetTitle" tabindex="-1">${a.name}</h2><p class="hint">${absenceSpan(a)} · ${SRC[a.source] || a.source}</p></div><button class="btn soft" type="button" data-sheet="close" aria-label="Close">${svg("x")}</button></div>
      <p>${status(a)}</p>
      ${a.partial ? html`<p class="hint">Part days don't count towards the Bradford Factor.</p>` : html`
        <label class="field"><span class="fl">In the Bradford Factor</span><select id="skExclude"><option value="">Count it</option>${reasons.map((r) => html`<option value="${r}" ${preset === r ? raw("selected") : ""}>Leave it out: ${r}</option>`)}</select></label>
        <label class="field" id="skOtherField" ${preset === "Other" ? "" : raw("hidden")}><span class="fl">Reason</span><input id="skOther" maxlength="200" value="${preset === "Other" && a.excluded !== "Other" ? a.excluded : ""}"></label>
        <label class="check"><input type="checkbox" id="skContinues" ${a.continues ? raw("checked") : ""}><span>Same spell as the absence before (the days between weren't working days)</span></label>
        <p class="hint">Acas advises leaving out absence related to pregnancy or a disability. Changes are logged.</p>`}
      ${form ? html`<button class="btn soft" type="button" data-sheet="sk-form" data-id="${form.id}">See the sickness form</button>` : ""}
      <p class="err" role="alert">${error}</p>
      <div class="row w-actions"><button class="btn soft" type="button" data-sheet="sk-back">Back</button>${a.partial ? "" : html`<button class="btn" type="submit">Save</button>`}</div></form>`,
    async (action, element) => {
      if (action === "sk-back") return openPerson(a.userId);
      if (action === "sk-form") return openRecord(element.dataset.id);
      if (action !== "submit") return;
      const choice = document.getElementById("skExclude").value, other = document.getElementById("skOther").value.trim();
      const excluded = choice === "Other" ? other : choice;
      if (choice === "Other" && !other) return openAbsence(id, "Say why it's left out.");
      try {
        await api("PUT", `/api/rota/sickness/absence/${encodeURIComponent(a.id)}`, { excluded: excluded || null, continues: document.getElementById("skContinues").checked, ifVersion: a.reviewVersion });
        toast("Saved. The Bradford Factor has been worked out again."); await reload(); openPerson(a.userId);
      } catch (err) { openAbsence(id, err.message); }
    });
    document.getElementById("skExclude")?.addEventListener("change", (ev) => { document.getElementById("skOtherField").hidden = ev.target.value !== "Other"; });
    document.querySelector("#sheetTitle")?.focus({ preventScroll: true });
  }

  return {
    view,
    clear() { generation++; clearTimeout(timer); data = null; query = ""; },
    search(value) {
      query = value; clearTimeout(timer);
      timer = setTimeout(() => { if (document.getElementById("sickSearch")) reload(); }, 200);
    },
    async act(name, id) {
      if (name === "sick-filter") { if (["all","sick","review"].includes(id)) filter = id; await reload(); }
      if (name === "sick-person") openPerson(id);
      if (name === "sick-absence") openAbsence(id);
      if (name === "sick-record") openRecord(id);
    },
  };
};
