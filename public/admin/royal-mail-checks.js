// Admin-only checklist. Opening the page reads saved evidence. Carrier requests require an explicit submission.
window.WholesaleRoyalMailChecks = function ({ api, html, raw, svg, put, openSheet, closeSheet }) {
  const path = "/api/admin/wholesale/royal-mail/checks";
  const checks = {
    register: { title: "Service register", detail: "Match the service and its register to your contract in Click & Drop → Settings → Shipping services.", href: "https://help.parcel.royalmail.com/hc/en-gb/articles/360009283914-Service-Register-codes", link: "Service register guidance", fields: ["requirement"] },
    returnAddress: { title: "Trading name and return address", detail: "Check a printed label against the trading name and full return address for this dispatch site.", href: "https://help.parcel.royalmail.com/hc/en-gb/articles/115001501653-How-to-set-your-trading-names", link: "Trading name settings", fields: [] },
    printer: { title: "Label format and barcode", detail: "Print an existing label at actual size. Check the complete address, clear edges and a readable barcode on the printer used for dispatch.", href: "https://help.parcel.royalmail.com/hc/en-gb/articles/115004866953-Choosing-your-label-format", link: "Label format guidance", fields: ["format"] },
    parcelLimits: { title: "Contract parcel limits", detail: "Check the weight and size limits for one packed box under your booked service. Use the limits quoted on your account.", fields: ["maxWeightGrams", "maxLengthCm", "maxVolumeLitres", "maxLengthPlusGirthCm"] },
    collection: { title: "Collection or drop-off", detail: "Confirm the carrier, handover site, responsible role and latest local handover time.", fields: ["carrier", "site", "cutoff", "owner"] },
    manifest: { title: "End-of-day handover", detail: "Reconcile printed labels with the parcels that actually left. Check any boxes still on the bench, complete the carrier’s required paperwork and retain proof of handover.", href: "https://help.parcel.royalmail.com/hc/en-gb/articles/115001509134-How-to-manifest-your-orders-end-of-day", link: "Manifest and end-of-day guidance", fields: ["site", "owner", "proof"] },
  };
  const operationalIds = Object.keys(checks).filter(id => id !== "manifest");
  const providerTitles = { authentication: "Click & Drop access", shippingAccount: "Shipping account", service: "Service for the parcel", labelPdf: "Existing label PDF", tracking: "Carrier tracking" };
  const states = { passed: ["Verified", "ok"], attention: ["Needs attention", "warn"], unverified: ["Unverified", ""] };
  const fields = {
    requirement: { label: "Register on this contract", options: { configured: "Matches the configured register", notRequired: "Carrier confirmed no register is required" } },
    format: { label: "Printed label format", options: { thermal4x6: "6 × 4 inch thermal label", a4: "A4 sheet", other: "Other carrier-approved format" } },
    carrier: { label: "Handover carrier", options: { royalMail: "Royal Mail", parcelforce: "Parcelforce", both: "Both carriers" } },
    site: { label: "Handover site", options: { roastery: "Roastery · Dove Street", warehouse: "Warehouse · Ber Street", pottergate: "Pottergate Café", allSaintsGreen: "All Saints Green", agreedDropOff: "Agreed drop-off point", otherAgreedSite: "Other agreed site" } },
    owner: { label: "Responsible role", options: { dispatchLead: "Dispatch lead", shiftSupervisor: "Shift supervisor", dutyManager: "Duty manager", accountAdmin: "Account admin" } },
    proof: { label: "Evidence retained", options: { signedManifest: "Signed manifest", collectionReceipt: "Collection receipt", acceptanceScan: "Carrier acceptance scan" } },
    cutoff: { label: "Handover cut-off (UK time)", type: "time" },
    maxWeightGrams: { label: "Maximum packed weight (g)", type: "number", max: 30000 },
    maxLengthCm: { label: "Maximum length (cm)", type: "number", max: 1000 },
    maxVolumeLitres: { label: "Maximum volume (litres)", type: "number", max: 2000 },
    maxLengthPlusGirthCm: { label: "Maximum length plus girth (cm)", type: "number", max: 2000 },
  };
  let host = null, state = null, epoch = 0, pending = false, notice = "", issue = "", needsReload = false;
  let sample = null, dayTimer;
  const date = ms => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const ukDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  const ukDay = ms => ukDate.format(new Date(ms));
  const todayHandover = () => state?.manual.manifest && ukDay(state.manual.manifest.confirmedAt) === ukDay(Date.now()) ? state.manual.manifest : undefined;
  const current = id => id === "manifest" ? todayHandover() : state?.manual[id];
  const pill = (label, tone = "") => html`<span class="pill ${tone}">${label}</span>`;
  const stored = response => {
    if (!response || !Number.isSafeInteger(response.version) || response.version < 0 || typeof response.scope !== "string" || !response.scope || !response.manual || typeof response.manual !== "object" || (response.automated !== null && !Array.isArray(response.automated?.checks))) {
      throw new Error("The saved setup checks could not be read.");
    }
    return response;
  };
  function evidenceSummary(id, evidence) {
    if (!evidence) return "";
    const name = key => fields[key].options[evidence[key]];
    if (id === "collection") return [name("carrier"), name("site"), evidence.cutoff && evidence.cutoff + " UK", name("owner")].filter(Boolean).join(" · ");
    if (id === "manifest") return [name("site"), name("owner"), name("proof")].filter(Boolean).join(" · ");
    if (id === "printer") return name("format");
    if (id === "register") return name("requirement");
    if (id === "parcelLimits") return [
      evidence.maxWeightGrams && evidence.maxWeightGrams.toLocaleString("en-GB") + " g",
      evidence.maxLengthCm && evidence.maxLengthCm + " cm length",
      evidence.maxVolumeLitres && evidence.maxVolumeLitres + " L volume",
      evidence.maxLengthPlusGirthCm && evidence.maxLengthPlusGirthCm + " cm length plus girth",
    ].filter(Boolean).join(" · ");
    return "";
  }
  function operationalRow(id) {
    const definition = checks[id], saved = current(id);
    const evidence = evidenceSummary(id, saved?.evidence);
    return html`<li><div class="rm-check-description"><h3>${definition.title}</h3>${evidence ? html`<p>${evidence}</p>` : ""}
      <p>${saved ? `Confirmed by ${saved.confirmedBy} · ${date(saved.confirmedAt)}` : definition.detail}</p></div>
      <div class="rm-check-actions">${saved ? pill("Confirmed", "ok") : id === "manifest" ? pill("No handover recorded") : ""}
      <button type="button" class="btn sm soft" data-check-id="${id}" aria-label="${saved ? "Review" : "Confirm"} ${definition.title}" ${pending || needsReload ? raw("disabled") : ""}>${saved ? "Review" : "Confirm"}</button></div></li>`;
  }
  function draw() {
    if (!host?.isConnected) return;
    host.setAttribute("aria-busy", String(Boolean(pending)));
    if (!state) {
      put(host, html`<section class="group glass w-rm-card"><h2>Setup checks</h2>${issue ? html`<p class="err" role="alert">${issue}</p><button class="btn soft" type="button" data-check-action="reload">Reload checks</button>` : html`<p role="status">Loading saved checks…</p>`}</section>`);
      return;
    }
    const previousBox = host.querySelector("[data-rm-parcel-check]");
    const limits = current("parcelLimits")?.evidence;
    const boxContext = JSON.stringify([state.scope, limits]);
    const run = state.automated;
    const accountChecks = ["authentication", "shippingAccount", "service"];
    const verified = accountChecks.filter(id => run?.checks.some(check => check.id === id && check.status === "passed")).length;
    const rows = Object.entries(providerTitles).map(([id, title]) => {
      const row = run?.checks.find(item => item.id === id);
      const [label, tone] = states[row?.status] || ["Not checked", ""];
      return html`<li><div class="rm-check-description"><h3>${row?.title || title}</h3>${row?.detail ? html`<p>${row.detail}</p>` : ""}</div>${pill(label, tone)}</li>`;
    });
    put(host, html`
      <div class="rm-check-column"><section class="group glass w-rm-card rm-check-panel" aria-labelledby="rmCarrierChecks">
        <div class="rm-check-intro"><span class="ic acc" aria-hidden="true">${svg("pulse")}</span><div><h2 id="rmCarrierChecks">Carrier checks</h2><p>Test the connection, service, label access and tracking using read-only carrier requests.</p></div></div>
        <form class="rm-check-run" aria-label="Run carrier checks" novalidate>
          <label class="rm-sample-toggle"><input type="checkbox" name="useSample" ${pending || needsReload ? raw("disabled") : ""} ${sample ? raw("checked") : ""}>Use a sample parcel</label>
          <div class="rm-sample-fields" ${sample ? "" : raw("hidden")}>
            <label class="field"><span class="fl">Postcode</span><input name="postcode" autocomplete="off" maxlength="10" ${pending || needsReload ? raw("disabled") : ""} autocapitalize="characters" placeholder="e.g. NR2 1DE" value="${sample?.postcode || ""}"></label>
            <label class="field"><span class="fl">Packed weight (g)</span><input name="weightGrams" type="number" min="1" max="30000" step="1" inputmode="numeric" ${pending || needsReload ? raw("disabled") : ""} value="${sample?.weightGrams || ""}"></label>
          </div>
          <p class="hint">${sample ? "The service check uses this postcode and packed weight." : "Service and label checks use an eligible existing shipment where available."}</p>
          <button type="submit" class="btn" ${pending || needsReload ? raw("disabled") : ""}>${pending === "carrier" ? "Checking…" : "Run carrier checks"}</button>
        </form>
        <div class="rm-check-messages"><p role="status">${notice}</p><p class="err" role="alert">${issue}</p>${needsReload ? html`<button type="button" class="btn soft" data-check-action="reload">Reload checks</button>` : ""}</div>
        <p class="rm-check-stamp">${run ? `${verified} of 3 account and service checks verified · ${date(run.checkedAt)} (UK) · ${run.checkedBy}` : "No carrier checks recorded for this setup."}</p>
        ${verified === accountChecks.length ? html`<p class="hint">Admin and Staff share one postage record per order. If you bought a label directly in Click &amp; Drop, choose <strong>Link existing booking</strong> on the order.</p>` : ""}
        <ul class="rm-check-list">${rows}</ul>
      </section>
      </div>
      <div class="rm-check-column"><section class="group glass w-rm-card rm-check-panel" aria-labelledby="rmOperatorChecks">
        <div class="rm-check-intro"><span class="ic acc" aria-hidden="true">${svg("people")}</span><div><h2 id="rmOperatorChecks">Team confirmations</h2><p>${operationalIds.filter(id => current(id)).length} of ${operationalIds.length} contract and packing checks confirmed.</p></div></div>
        <ul class="rm-check-list">${operationalIds.map(operationalRow)}</ul>
      </section>
      <section class="group glass w-rm-card rm-check-panel" aria-labelledby="rmDailyChecks">
        <div class="rm-check-intro"><span class="ic acc" aria-hidden="true">${svg("cal")}</span><div><h2 id="rmDailyChecks">Today’s handover</h2><p>On dispatch days, record the evidence after the parcels leave. A new check opens each UK day.</p></div></div>
        <ul class="rm-check-list">${operationalRow("manifest")}</ul>
      </section><div class="group glass w-rm-card" data-rm-parcel-check></div></div>`);
    const parcel = host.querySelector("[data-rm-parcel-check]");
    if (previousBox?.dataset.context === boxContext && previousBox.childElementCount) {
      parcel.replaceWith(previousBox);
      return;
    }
    parcel.dataset.context = boxContext;
    import("/admin/royal-mail-parcel-check.js").then(({ mountParcelCheck }) => {
      if (parcel.isConnected) mountParcelCheck(parcel, state?.serviceCode || "", limits);
    }).catch(() => { if (parcel.isConnected) parcel.textContent = "Reload to check parcel dimensions."; });
  }
  function focus(selector) { host?.querySelector(selector)?.focus({ preventScroll: true }); }
  async function load(restoreFocus = false) {
    const revision = ++epoch;
    pending = "load"; state = null; notice = issue = ""; needsReload = false; draw();
    try {
      const result = stored(await api("GET", path));
      if (revision === epoch) state = result;
    } catch (error) {
      if (revision === epoch) issue = error.message;
    } finally {
      if (revision === epoch) {
        pending = false; draw();
        if (restoreFocus) focus(state ? ".rm-check-run button" : "[data-check-action=reload]");
      }
    }
  }
  // A connection loss may follow a successful write. Reload evidence before offering another submission.
  async function save(method, data) {
    const revision = epoch;
    if (pending || needsReload || !state) return false;
    const { version, scope } = state;
    pending = method === "POST" ? "carrier" : "confirmation"; notice = issue = ""; draw();
    try {
      const result = stored(await api(method, path, { ifVersion: version, scope, ...data }));
      if (revision !== epoch) return false;
      if (result.version <= version || result.scope !== scope) throw new Error("The latest saved checks need to be reloaded.");
      state = result;
      notice = method === "POST" ? "Carrier checks finished." : data.confirmed ? "Confirmation saved." : "Confirmation removed.";
      return true;
    } catch (error) {
      if (revision === epoch) {
        needsReload = ![400, 422].includes(error.status);
        issue = error.message;
      }
      return false;
    } finally {
      if (revision === epoch) { pending = false; draw(); }
    }
  }
  const optional = key => key === "maxLengthPlusGirthCm" || key === "maxVolumeLitres" && state?.serviceCode?.toUpperCase() !== "NDB";
  function inputField(key, values) {
    const meta = fields[key], value = values[key] ?? "", required = !optional(key);
    if (meta.options) {
      const choices = Object.entries(meta.options).filter(([id]) => key !== "requirement" || (id === "configured") === !!state?.serviceRegisterCode);
      return html`<label class="field"><span class="fl">${meta.label}</span><select name="${key}" required><option value="">Select an option</option>${choices.map(([id, label]) => html`<option value="${id}" ${value === id ? raw("selected") : ""}>${label}</option>`)}</select></label>`;
    }
    const max = meta.max;
    return html`<label class="field"><span class="fl">${meta.label}${required ? "" : " (optional)"}</span><input type="${meta.type}" name="${key}" value="${value}" ${meta.type === "number" ? raw('min="1" step="1" inputmode="numeric"') : ""} ${max ? html`max="${max}"` : ""} ${required ? raw("required") : ""}></label>`;
  }
  function edit(id, opener) {
    if (!Object.hasOwn(checks, id) || !state || needsReload || pending) return;
    const { scope, version } = state, definition = checks[id], saved = current(id);
    const { serviceCode, serviceRegisterCode } = state;
    const openedDay = ukDay(Date.now());
    openSheet(html`<form id="wRoyalMailEvidence" class="w-sheet w-editor" method="post">
      <header class="w-editor-head"><h2 id="sheetTitle">${definition.title}</h2><button class="btn soft" type="button" data-sheet="close" aria-label="Close confirmation">${svg("x")}</button></header>
      <div class="w-editor-body"><p>${definition.detail}</p>
        ${saved ? html`<p class="hint">Confirmed by ${saved.confirmedBy} · ${date(saved.confirmedAt)} (UK)</p>` : ""}
        ${id === "register" ? html`<p class="rm-check-context">Booking service <b>${serviceCode || "Not set"}</b> · Saved register <b>${serviceRegisterCode || "None"}</b></p>` : ""}
        ${id === "parcelLimits" && serviceCode?.toUpperCase() === "NDB" ? html`<p class="rm-check-context">Parcelforce express24 (NDB) accepts up to 30 kg per box. A length over 150 cm or a volume over 220 litres can incur a surcharge. Enter the limits agreed for your account.</p>` : ""}
        ${id === "manifest" ? html`<p class="hint">Check Click &amp; Drop before the working-day auto-manifest from 18:30. Confirm once you have evidence of today’s handover.</p>` : ""}
        ${definition.href ? html`<a class="rm-check-help" href="${definition.href}" target="_blank" rel="noopener noreferrer">${definition.link} ${svg("external")}</a>` : ""}
        <fieldset class="rm-evidence-fields">${definition.fields.map(key => inputField(key, saved?.evidence || {}))}
          <label class="w-shipping-confirm"><input name="verified" type="checkbox" required><span>${id === "manifest" ? "I checked today’s parcels and the handover evidence." : "I verified these details for the current shipping setup."}</span></label></fieldset>
      </div><footer class="w-editor-footer"><p class="err" role="alert"></p>${saved ? html`<button class="btn soft" type="button" data-sheet="remove">Remove confirmation</button>` : ""}
        <div class="row w-actions"><button class="btn soft" type="button" data-sheet="close">Cancel</button><button class="btn" type="submit">Save confirmation</button></div></footer></form>`,
    async (action, element) => {
      const form = element.closest("form");
      if (!form || pending || !host?.isConnected || action !== "submit" && action !== "remove") return;
      if (id === "manifest" && openedDay !== ukDay(Date.now())) {
        closeSheet(); await load();
        if (state) {
          notice = "A new UK day has started. Review today’s handover before confirming it.";
          draw(); focus('[data-check-id="manifest"]');
        }
        return;
      }
      if (needsReload || state?.scope !== scope || state?.version !== version) {
        closeSheet(); await load(true); return;
      }
      if (action === "submit" && !form.reportValidity()) return;
      const confirmed = action === "submit", evidence = {};
      if (confirmed) for (const key of definition.fields) {
        const value = form.elements.namedItem(key).value;
        if (value) evidence[key] = fields[key].type === "number" ? Number(value) : value;
      }
      const controls = form.querySelector("fieldset");
      controls.disabled = true;
      const success = await save("PUT", { id, confirmed, ...(id === "manifest" ? { manifestDay: openedDay } : {}), ...(confirmed ? { evidence } : {}) });
      if (!form.isConnected) return;
      if (success || needsReload) {
        closeSheet(); focus(needsReload ? "[data-check-action=reload]" : `[data-check-id="${id}"]`);
      } else { controls.disabled = false; form.querySelector('[role="alert"]').textContent = issue; }
    }, opener);
  }
  function click(event) {
    const button = event.target.closest("button");
    if (button?.dataset.checkId) edit(button.dataset.checkId, button);
    if (button?.dataset.checkAction === "reload" && !pending) load(true);
  }
  function change(event) {
    if (event.target.name === "useSample") {
      sample = event.target.checked ? { postcode: "", weightGrams: "" } : null;
      draw(); focus(sample ? '[name="postcode"]' : '[name="useSample"]');
    }
  }
  function input(event) {
    const { name, value } = event.target;
    if (sample && event.target.closest(".rm-check-run") && (name === "postcode" || name === "weightGrams")) sample[name] = value;
  }
  async function submit(event) {
    if (!event.target.matches(".rm-check-run")) return;
    event.preventDefault();
    if (pending || needsReload) return;
    if (sample) {
      for (const key of ["postcode", "weightGrams"]) event.target.elements.namedItem(key).required = true;
      if (!event.target.reportValidity()) return;
    }
    const active = epoch;
    await save("POST", sample ? { sample: { postcode: sample.postcode.trim().toUpperCase(), weightGrams: Number(sample.weightGrams) } } : {});
    if (epoch === active && document.activeElement === document.body) focus(needsReload ? "[data-check-action=reload]" : ".rm-check-run button");
  }
  function checkDay() {
    if (document.hidden || pending || !state?.manual.manifest || todayHandover()) return;
    const row = host?.querySelector('[data-check-id="manifest"]')?.closest("li");
    delete state.manual.manifest;
    if (row) {
      const template = document.createElement("template");
      put(template, operationalRow("manifest"));
      const replaceFocus = row.contains(document.activeElement);
      row.replaceWith(template.content);
      if (replaceFocus) focus('[data-check-id="manifest"]');
    }
  }
  function unmount() {
    if (!host) return;
    clearInterval(dayTimer); document.removeEventListener("visibilitychange", checkDay); epoch++; pending = false; state = sample = null; notice = issue = ""; needsReload = false;
    host.removeEventListener("click", click); host.removeEventListener("submit", submit); host.removeEventListener("change", change); host.removeEventListener("input", input); host = null;
  }
  function mount(target) {
    if (target === host) return;
    unmount(); host = target;
    host.addEventListener("click", click); host.addEventListener("submit", submit); host.addEventListener("change", change); host.addEventListener("input", input);
    document.addEventListener("visibilitychange", checkDay); dayTimer = setInterval(checkDay, 15000);
    load();
  }
  return { mount, unmount };
};
