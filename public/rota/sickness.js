// Report sickness (rota #sick): the self-certified sickness form. Anyone fills it in for themselves (an admin can choose
// someone else): off sick for a day or more, or went home early; what was wrong; three yes/no questions; the declaration.
// A preview shows how the shifts on those days will change. The answers go to the office only (src/rota/sickness.ts);
// nothing is kept in the browser.
window.SCSickness = function createSicknessUI(c) {
  const { el, svgi, btn, api, get, setHead, go, toast, fmt, addDays, monday, londonToday, londonNow, isAdmin, me } = c;
  const ICONS = {
    off: '<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
    early: '<path d="M4 20V10l8-6 8 6v10"/><path d="M10 20v-6h4v6"/>',
    done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  };
  const CATEGORIES = ["Cold or flu", "Stomach upset", "Headache or migraine", "Back or muscle pain", "Injury", "Covid", "Mental health or stress", "Other"];
  const QUESTIONS = [
    ["vomiting", "Did you have sickness (vomiting) or diarrhoea?"],
    ["doctor", "Did you see a doctor, nurse or pharmacist?"],
    ["workAccident", "Was it caused by an accident or injury at work?"],
  ];
  let f = null, key = null, people = null;
  const fresh = (userId) => ({ userId, kind: "", from: londonToday(), to: londonToday(), leftAt: londonNow(), category: "", details: "", vomiting: null, doctor: null, workAccident: null, declared: false, changes: null, error: "", sent: null });
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
  const dayText = (d) => d === londonToday() ? "Today" : d === addDays(londonToday(), -1) ? "Yesterday" : d === addDays(londonToday(), 1) ? "Tomorrow" : fmt(d, { weekday: "short", day: "numeric", month: "short" });
  const hours = (n) => `${Math.round(n * 100) / 100} h`;
  function clear() { f = null; key = null; people = null; asked = ""; }

  function choice(name, value, title, sub, icon) {
    const on = f[name] === value;
    return el("button", { type: "button", class: "sick-choice" + (on ? " on" : ""), "aria-pressed": String(on), onclick: () => { f[name] = value; paint(); preview(); } },
      el("span", { class: "sick-choice-ic", "aria-hidden": "true" }, svgi(ICONS[icon])), el("span", {}, el("b", { text: title }), el("span", { text: sub })));
  }
  const chip = (text, on, onclick) => el("button", { type: "button", class: "sick-chip" + (on ? " on" : ""), "aria-pressed": String(on), onclick }, text);
  function yesNo(name, question) {
    return el("div", { class: "sick-q" }, el("span", { class: "sick-q-text", id: "q-" + name, text: question }),
      el("div", { class: "seg sick-yn", role: "group", "aria-labelledby": "q-" + name },
        ...[[true, "Yes"], [false, "No"]].map(([v, t]) => el("button", { type: "button", "aria-pressed": String(f[name] === v), onclick: () => { f[name] = v; paint(); } }, t))));
  }
  const dateInput = (name, label, extra = {}) => el("label", { class: "sick-field" }, el("span", { text: label }),
    el("input", { type: "date", value: f[name], min: addDays(londonToday(), isAdmin() ? -365 : -28), max: addDays(londonToday(), 14), ...extra, onchange: (e) => { f[name] = e.target.value; if (name === "from" && f.to < f.from) f.to = f.from; paint(); preview(); } }));

  // The shifts the form would change. Only an answer for the dates and time still on the form is used.
  const previewQuery = () => new URLSearchParams({ userId: f.userId, kind: f.kind, from: f.from, to: f.kind === "early" ? f.from : f.to, ...(f.kind === "early" ? { leftAt: f.leftAt } : {}) }).toString();
  let asked = "";
  async function preview() {
    if (!f?.kind) return;
    const query = previewQuery();
    if (query === asked) return; // already on its way, or answered
    asked = query; f.changes = null;
    try {
      const r = await get("/api/rota/sickness/preview?" + query);
      if (!f || previewQuery() !== query) return;
      f.changes = r.changes; f.error = "";
    } catch (e) { if (!f || previewQuery() !== query) return; asked = ""; f.changes = null; f.error = e.message; }
    paint();
  }

  function shiftsCard() {
    if (!f.kind) return null;
    if (f.changes === null) return el("p", { class: "sick-muted", text: f.error ? "" : "Checking your shifts…" });
    if (!f.changes.length) return el("p", { class: "sick-muted", text: "No shifts on the rota to change. Your sickness is still recorded." });
    return el("div", { class: "sick-shifts" }, el("span", { class: "sick-shifts-h", text: "Your hours on the rota will change to:" }),
      ...f.changes.map((s) => el("div", { class: "sick-shift" }, el("span", {}, el("b", { text: `${dayText(s.day)} · ${s.start}–${s.end}` }), el("span", { text: s.site[0].toUpperCase() + s.site.slice(1) })),
        el("span", { class: "sick-hours" }, el("s", { text: hours(s.hoursBefore) }), " → ", el("b", { text: hours(s.hoursAfter) })))));
  }

  const ready = () => f.kind && f.category && f.details.trim() && QUESTIONS.every(([k]) => typeof f[k] === "boolean") && f.declared;
  async function send(e) {
    e?.preventDefault?.();
    if (!ready()) { f.error = !f.kind ? "Choose whether you were off sick or went home early." : !f.category ? "Choose what was wrong." : !f.details.trim() ? "Tell us a little about what was wrong." : !f.declared ? "Tick the declaration to send the form." : "Answer the three quick questions."; paint(); return; }
    key = key || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    const body = { requestKey: key, userId: f.userId, kind: f.kind, from: f.from, to: f.kind === "early" ? f.from : f.to, leftAt: f.kind === "early" ? f.leftAt : undefined, category: f.category, details: f.details.trim(), vomiting: f.vomiting, doctor: f.doctor, workAccident: f.workAccident, declared: true };
    try {
      const r = await api("POST", "/api/rota/sickness", body);
      f.sent = r; f.error = ""; key = null;
      toast("Sickness form sent");
    } catch (err) { f.error = err.message; }
    paint();
  }

  let box = null;
  // Any tap or change on the form clears the last "please answer…" message; sending checks again.
  const touched = () => { if (f && !f.sent && f.error && !f.error.startsWith("Couldn")) f.error = ""; };
  function paint() {
    if (!box || !f) return;
    const who = f.userId === me().id ? me().name : (people?.find((p) => p.id === f.userId)?.name || "");
    if (f.sent) {
      box.replaceChildren(el("div", { class: "sick-done glass" }, el("div", { class: "sick-tick", "aria-hidden": "true" }, svgi(ICONS.done)),
        el("h2", { text: f.userId === me().id ? `Thanks, ${who.split(" ")[0]}. Get well soon.` : `Saved for ${who}.` }),
        el("p", { text: "Your form has gone to the office. Only admins can read it." }),
        f.sent.changes?.length ? el("p", { class: "sick-muted", text: `${f.sent.changes.length === 1 ? "1 shift" : f.sent.changes.length + " shifts"} on the rota now ${f.sent.changes.length === 1 ? "shows" : "show"} the hours you worked.` }) : null,
        f.vomiting ? el("p", { class: "sick-warn", text: "Food safety: please don't come back to work until you've had no sickness or diarrhoea for 48 hours." }) : null,
        el("div", { class: "sick-actions" }, btn("Back to my shifts", () => { clear(); go("mine"); }), btn("Send another form", () => { f = fresh(f.userId); asked = ""; paint(); }, "btn ghost"))));
      return;
    }
    const span = f.kind === "off" ? days(f.from, f.to) : 0;
    const form = el("form", { class: "sick-form", novalidate: true, onsubmit: send },
      el("p", { class: "sick-lead", text: "Off sick or had to go home? Fill this in as soon as you can. It takes a minute, and only the office (admins) can see what you write." }),
      isAdmin() && people ? el("label", { class: "sick-field sick-who" }, el("span", { text: "Who is this for?" }),
        el("select", { onchange: (e) => { f.userId = e.target.value; paint(); preview(); } }, ...people.map((p) => el("option", { value: p.id, selected: p.id === f.userId, text: p.id === me().id ? `${p.name} (me)` : p.name })))) : null,

      el("section", { class: "sick-step glass" }, el("h2", {}, el("span", { class: "sick-n", text: "1" }), "What happened?"),
        el("div", { class: "sick-choices" }, choice("kind", "off", "I'm off sick", "A whole day or more", "off"), choice("kind", "early", "I went home early", "Part-way through a shift", "early"))),

      f.kind ? el("section", { class: "sick-step glass" }, el("h2", {}, el("span", { class: "sick-n", text: "2" }), "When?"),
        f.kind === "off"
          ? [el("div", { class: "sick-chips" },
              chip("Just today", f.from === londonToday() && f.to === londonToday(), () => { f.from = f.to = londonToday(); paint(); preview(); }),
              chip("Yesterday", f.from === addDays(londonToday(), -1) && f.to === f.from, () => { f.from = f.to = addDays(londonToday(), -1); paint(); preview(); }),
              chip("Today and tomorrow", f.from === londonToday() && f.to === addDays(londonToday(), 1), () => { f.from = londonToday(); f.to = addDays(londonToday(), 1); paint(); preview(); })),
            el("div", { class: "sick-row" }, dateInput("from", "First day off"), dateInput("to", "Last day off", { min: f.from })),
            span > 7 ? el("p", { class: "sick-warn", text: `That's ${span} days. For more than 7 days in a row you'll need a fit note from your doctor: send it to the office.` }) : null]
          : [el("div", { class: "sick-chips" },
              chip("Today", f.from === londonToday(), () => { f.from = londonToday(); paint(); preview(); }),
              chip("Yesterday", f.from === addDays(londonToday(), -1), () => { f.from = addDays(londonToday(), -1); paint(); preview(); })),
            el("div", { class: "sick-row" }, dateInput("from", "Day", { max: londonToday() }),
              el("label", { class: "sick-field" }, el("span", { text: "Time you left" }), el("input", { type: "time", value: f.leftAt, step: 300, onchange: (e) => { f.leftAt = e.target.value; preview(); } })))],
        shiftsCard()) : null,

      f.kind ? el("section", { class: "sick-step glass" }, el("h2", {}, el("span", { class: "sick-n", text: "3" }), "What was wrong?"),
        el("div", { class: "sick-chips", role: "group", "aria-label": "What was wrong" }, ...CATEGORIES.map((cat) => chip(cat, f.category === cat, () => { f.category = cat; paint(); }))),
        el("label", { class: "sick-field" }, el("span", { text: "Tell us a little more" }),
          el("textarea", { rows: 3, maxlength: 1000, placeholder: "For example: temperature and a bad cough", oninput: (e) => { f.details = e.target.value; } }, f.details))) : null,

      f.kind ? el("section", { class: "sick-step glass" }, el("h2", {}, el("span", { class: "sick-n", text: "4" }), "Three quick questions"),
        ...QUESTIONS.map(([k, q]) => yesNo(k, q)),
        f.vomiting ? el("p", { class: "sick-warn", text: "Food safety: don't come back to work until you've had no sickness or diarrhoea for 48 hours." }) : null,
        f.workAccident ? el("p", { class: "sick-note", text: "Please also record what happened in the Accident book in the diary." }) : null) : null,

      f.kind ? el("section", { class: "sick-step glass" }, el("h2", {}, el("span", { class: "sick-n", text: "5" }), "Declaration"),
        el("label", { class: "sick-declare" }, el("input", { type: "checkbox", checked: f.declared, onchange: (e) => { f.declared = e.target.checked; paint(); } }),
          el("span", { text: `I confirm I was unfit for work because of the sickness above, and what I've said is true. Signed: ${me().name}, ${fmt(londonToday(), { day: "numeric", month: "long", year: "numeric" })}.` }))) : null,

      el("p", { class: "smsg sick-err", role: "alert", text: f.error }),
      f.kind ? el("div", { class: "sick-send" }, el("button", { type: "submit", class: "btn sick-submit" }, "Send to the office")) : null,
    );
    form.addEventListener("click", touched, true); form.addEventListener("change", touched, true);
    box.replaceChildren(form);
  }

  async function page(args) {
    setHead("sick", "Report sickness", "Self-certified sickness form", { back: ["My shifts", "mine"] });
    const want = isAdmin() && args?.[0] ? args[0] : me().id;
    if (!f || f.sent || f.userId !== want) { f = fresh(want); asked = ""; }
    if (isAdmin() && !people) {
      try { const w = await get("/api/rota/week?start=" + monday(londonToday())); people = [...w.people].filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name)); }
      catch { people = null; }
      if (people && !people.some((p) => p.id === me().id)) people.unshift({ id: me().id, name: me().name });
    }
    box = el("div", { class: "sick-page" });
    paint();
    if (f.kind) preview();
    return box;
  }
  /** The card on My shifts and Holidays that opens the form. */
  const link = () => el("a", { href: "#sick", class: "sick-link glass" }, el("span", { class: "sick-link-ic", "aria-hidden": "true" }, svgi(ICONS.off)),
    el("span", {}, el("b", { text: "Off sick or went home early?" }), el("span", { text: "Fill in the sickness form" })), el("span", { class: "sick-link-go", "aria-hidden": "true", text: "›" }));
  return { page, link, clear };
};
