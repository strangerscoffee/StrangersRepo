// Shared input modality: clicks/taps do not draw focus rings; keyboard navigation keeps a neutral cue.
// Only the interaction mode is held in the document. No input values, storage or requests.
(() => {
  "use strict";
  const root = document.documentElement;
  const pointer = () => root.setAttribute("data-sc-pointer", "");
  document.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  document.addEventListener("keydown", event => {
    if (["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) root.removeAttribute("data-sc-pointer");
  }, true);
})();
