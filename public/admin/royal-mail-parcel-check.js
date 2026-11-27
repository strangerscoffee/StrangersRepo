// Measurements are local to this screen. The size check never creates or modifies a shipment.
export function assessParcelBox(serviceCode, contract, { weightGrams, lengthCm, widthCm, heightCm }) {
  const dimensions = [lengthCm, widthCm, heightCm];
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0 ||
      !dimensions.every(cm => Number.isFinite(cm) && cm > 0 && Number.isSafeInteger(cm * 10))) {
    return { status: "incomplete", messages: ["Enter the sealed weight in whole grams and all three outside measurements to the nearest millimetre."] };
  }

  const [longest, middle, shortest] = dimensions.map(cm => cm * 10).sort((a, b) => b - a);
  const volumeLitres = longest * middle * shortest / 1_000_000;
  const lengthPlusGirthCm = (longest + 2 * (middle + shortest)) / 10;
  const ndb = String(serviceCode || "").trim().toUpperCase() === "NDB";
  const limits = contract || {};
  const messages = [];
  const weightLimit = Math.min(30000, limits.maxWeightGrams ?? 30000);
  if (weightGrams > weightLimit) messages.push(`The parcel exceeds the ${weightLimit.toLocaleString("en-GB")} g weight limit. Split or change the parcel before booking.`);

  const lengthLimit = limits.maxLengthCm ?? (ndb ? 150 : null);
  const volumeLimit = limits.maxVolumeLitres ?? (ndb ? 220 : null);
  if (lengthLimit && longest > lengthLimit * 10) messages.push(`The longest side exceeds ${lengthLimit} cm.`);
  if (volumeLimit && volumeLitres > volumeLimit) messages.push(`The box volume exceeds ${volumeLimit} litres.`);
  if (limits.maxLengthPlusGirthCm && lengthPlusGirthCm > limits.maxLengthPlusGirthCm) {
    messages.push(`Length plus girth exceeds ${limits.maxLengthPlusGirthCm} cm.`);
  }
  if (ndb && (longest > 1500 || volumeLitres > 220)) messages.push("Parcelforce quotes a surcharge for express24 parcels over 150 cm in length or 220 litres. Check the service before booking.");
  if (messages.length) return { status: "attention", volumeLitres, lengthPlusGirthCm, messages };
  if (!contract && !ndb) return { status: "unverified", volumeLitres, lengthPlusGirthCm, messages: ["Confirm your contract’s parcel limits to check this box against the selected service."] };
  return { status: "within", volumeLitres, lengthPlusGirthCm, messages: [
    contract ? "Within the parcel limits recorded for this service." : "Within the published express24 weight and box sizes. Your contract limits still need confirmation.",
  ] };
}

export function mountParcelCheck(host, serviceCode, contract) {
  const { el } = window.SC;
  const result = el("p", { class: "hint", role: "status" });
  const fields = [
    ["weightGrams", "Sealed weight (g)"],
    ["lengthCm", "Length (cm)"],
    ["widthCm", "Width (cm)"],
    ["heightCm", "Height (cm)"],
  ];
  const form = el("form", { class: "w-rm-box-form" },
    el("p", { class: "hint" }, "Use the outside measurements of one packed box."),
    el("div", { class: "w-rm-box-fields" }, fields.map(([name, label]) =>
      el("label", {}, label, el("input", { name, type: "number", inputmode: name === "weightGrams" ? "numeric" : "decimal",
        min: name === "weightGrams" ? "1" : "0.1", step: name === "weightGrams" ? "1" : "0.1", required: true })))),
    el("button", { class: "btn soft", type: "submit" }, "Check dimensions"), result);
  form.addEventListener("input", () => { result.textContent = ""; });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const box = Object.fromEntries(fields.map(([name]) => [name, form.elements.namedItem(name).valueAsNumber]));
    const check = assessParcelBox(serviceCode, contract, box);
    const volume = check.volumeLitres === undefined ? "" : `Box volume ${check.volumeLitres.toLocaleString("en-GB", { maximumFractionDigits: 3 })} L. `;
    result.textContent = volume + check.messages.join(" ");
  });
  host.replaceChildren(el("details", { class: "w-rm-box-check" }, el("summary", {}, "Check a packed box"), form));
}
