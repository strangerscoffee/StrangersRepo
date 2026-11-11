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

  // Each coffee's colour, from its packaging, so it can be told apart at a glance in a packing list. Two-colour bags
  // show as diagonal stripes; a colour too close to another coffee's (House/Roasters greys, Anserma/Rosalina purples)
  // shows as stripes of itself and a lighter shade. Admin can set the colours of any coffee (saved on the coffee as
  // colours/colourStyle); a coffee nobody has given colours to gets a steady automatic one, unlike any packaging colour.
  const packaging = [
    { ids: ["christmas"], match: /christmas/i, colours: ["#E35D4E", "#2A7162"] },
    { ids: ["brazil"], match: /bom jesus/i, colours: ["#4B8E68"] },
    { ids: ["campo"], match: /campo santo/i, colours: ["#FBAE42"] },
    { ids: ["house"], match: /wuchii|house blend/i, colours: ["#78797B"] },
    { ids: ["colombia"], match: /anserma/i, colours: ["#9F86C0"] },
    { ids: ["rosalina"], match: /rosalina/i, colours: ["#856388"], striped: true },
    { ids: ["rocko"], match: /rocko/i, colours: ["#ED1F24"] },
    { ids: ["ethiopia"], match: /idido/i, colours: ["#E29578"] },
    { ids: ["decaf"], match: /san lorenzo/i, colours: ["#7AB0A3"] },
    { ids: ["half-caff"], match: /half[ -]?caff/i, colours: ["#5D5DAB"] },
    { ids: [], match: /twin peaks/i, colours: ["#810A40"] },
    { ids: [], match: /fine city/i, colours: ["#EA4320", "#4A697B"] },
    { ids: [], match: /roasters'? blend/i, colours: ["#4A697B"], striped: true },
  ];
  const HEX = /^#[0-9a-f]{6}$/i;
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const distance = (a, b) => { const [x, y] = [rgb(a), rgb(b)]; return Math.hypot(...x.map((v, i) => v - y[i])); };
  const used = packaging.flatMap(entry => entry.colours);
  function hslHex(h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return "#" + [0, 8, 4].map(n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  // Steady for a coffee (from its id), and kept clear of every packaging colour.
  const candidates = [];
  for (let h = 0; h < 360; h += 12) for (const [s, l] of [[.62, .45], [.55, .62]]) { const hex = hslHex(h, s, l); if (used.every(c => distance(c, hex) > 70)) candidates.push(hex); }
  function automatic(key) {
    let hash = 2166136261; for (const char of String(key || "coffee")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return candidates[hash % candidates.length];
  }
  function coffeeColour(item, products = []) {
    const id = item?.productId ?? item?.id ?? "", text = `${item?.title || ""} ${item?.name || ""}`;
    const product = (products || []).find(p => p.id === id) || (Array.isArray(item?.colours) ? item : null);
    if (Array.isArray(product?.colours) && product.colours.length && product.colours.every(c => HEX.test(c))) return { colours: product.colours.slice(0, 2), striped: product.colourStyle === "striped" || product.colours.length > 1, source: "saved" };
    const known = packaging.find(entry => entry.ids.includes(id)) || packaging.find(entry => entry.match.test(text));
    if (known) return { colours: [...known.colours], striped: !!known.striped || known.colours.length > 1, source: "packaging" };
    return { colours: [automatic(id || text)], striped: false, source: "automatic" };
  }
  // The colour as a CSS image (stripes, or a solid fill as an image so it can be sized like stripes).
  function coffeeFill({ colours, striped }) {
    const [a, b = striped ? `color-mix(in srgb, ${colours[0]} 45%, #fff)` : colours[0]] = colours;
    return a === b ? `linear-gradient(${a}, ${a})` : `repeating-linear-gradient(135deg, ${a} 0 5px, ${b} 5px 10px)`;
  }
  const coffeeStyle = (item, products) => `--w-coffee:${coffeeFill(coffeeColour(item, products))}`;

window.SCWholesalePreparation=Object.freeze({grindFor,decafLine,coffeeColour,coffeeFill,coffeeStyle,packagingColours:Object.freeze(packaging.map(e=>Object.freeze({...e}))),iconPaths:Object.freeze({"grind-beans": "<path d=\"M18 4c-4-3-11 1-13 6s0 10 4 11 10-3 12-8 1-7-3-9Z\"/><path d=\"M17 5c-6 3-2 8-10 14\"/>", "grind-fine": "<path d=\"M5 4h14v5H5zM7 9v4h10V9M9 13v3h6v-3M5 21h14M10 18v3M14 18v3\"/>", "grind-medium": "<path d=\"m3 4 9 12 9-12H3ZM12 16v4M8 21h8M7 4l5 8 5-8\"/>", "grind-coarse": "<path d=\"M6 8h11v11H6zM4 21h15M4 4h15M11 2v6M17 10h2a3 3 0 0 1 0 6h-2\"/>"})});
})();
