// Pure presentation of immutable wholesale line snapshots; no identities, storage or network calls.
(()=>{
"use strict";
  const grindStyles = {
    beans: { hue: 212, icon: "grind-beans", hint: "Your own grinder" },
    espresso: { hue: 276, icon: "grind-fine", hint: "Espresso" },
    filter: { hue: 170, icon: "grind-medium", hint: "Filter" },
    cafetiere: { hue: 32, icon: "grind-coarse", hint: "Cafetiere / batch brew" },
    moka: { hue: 276, icon: "grind-fine", hint: "Moka pot" },
  };
  function grindFor(line) {
    const savedLabel = line.grindLabel || "Unspecified grind", normal = savedLabel.trim().toLowerCase();
    const aliases = { "whole bean": "beans", "whole beans": "beans", beans: "beans", fine: "espresso", medium: "filter", coarse: "cafetiere" };
    const alias = Object.hasOwn(aliases, normal) ? aliases[normal] : null;
    const known = Object.hasOwn(grindStyles, line.grind) ? grindStyles[line.grind] : alias ? grindStyles[alias] : null;
    let hash = 0; for (const char of String(line.grind || savedLabel)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    return { key: JSON.stringify([line.grind || "", savedLabel]), label: line.grind === "beans" && normal === "beans" ? "Whole bean" : savedLabel,
      hue: known?.hue ?? [212, 276, 170, 32, 340, 230][hash % 6], icon: known?.icon || "coffee",
      hint: typeof line.grindHint === "string" ? line.grindHint : known?.hint || "" };
  }
  const decafLine = line => typeof line.decaf === "boolean" ? line.decaf : line.productId === "decaf" || /\bdecaf(?:feinated)?\b/i.test(line.title);

window.SCWholesalePreparation=Object.freeze({grindFor,decafLine,iconPaths:Object.freeze({"grind-beans": "<path d=\"M18 4c-4-3-11 1-13 6s0 10 4 11 10-3 12-8 1-7-3-9Z\"/><path d=\"M17 5c-6 3-2 8-10 14\"/>", "grind-fine": "<path d=\"M5 4h14v5H5zM7 9v4h10V9M9 13v3h6v-3M5 21h14M10 18v3M14 18v3\"/>", "grind-medium": "<path d=\"m3 4 9 12 9-12H3ZM12 16v4M8 21h8M7 4l5 8 5-8\"/>", "grind-coarse": "<path d=\"M6 8h11v11H6zM4 21h15M4 4h15M11 2v6M17 10h2a3 3 0 0 1 0 6h-2\"/>"})});
})();
