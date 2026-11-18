// Load Admin dependencies in order. A failed core must never execute its dependants.
(() => {
  "use strict";
  const definitions = [...document.querySelectorAll('script[type="application/x-sc-script"][src]')];
  const delay = () => new Promise(resolve => setTimeout(resolve, 250));
  async function load(definition) {
    const url = new URL(definition.src, location.href);
    if (url.origin !== location.origin || !/^\/(?:_releases\/[a-f0-9]{20}\/)?(?:shared|admin)\/[\w-]+\.js$/.test(url.pathname)) throw new Error("Invalid Admin dependency.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const script = document.createElement("script");
      script.dataset.scManaged = "1";
      script.async = false;
      if (attempt) url.searchParams.set("sc-asset-retry", "1");
      script.src = url.href;
      try {
        await new Promise((resolve, reject) => {
          script.addEventListener("load", resolve, { once: true });
          script.addEventListener("error", () => reject(new Error("Couldn't load " + url.pathname)), { once: true });
          definition.after(script);
        });
      } catch (error) {
        script.remove();
        if (attempt || navigator.onLine === false) throw error;
        await delay();
        continue;
      }
      const exported = definition.dataset.scModule;
      if (exported && !window[exported]) throw new Error("Couldn't initialise " + url.pathname);
      return;
    }
  }
  (async () => {
    for (const definition of definitions) await load(definition);
  })().catch(error => {
    // Keep the original real failure visible; no dependent scripts run after it.
    if (window.SCReportError) SCReportError(error.message, error.stack || "");
    else {
      const panel = document.createElement("section"), message = document.createElement("p"), retry = document.createElement("button");
      panel.setAttribute("role", "alert");
      message.textContent = "Admin couldn't start. " + error.message;
      retry.type = "button"; retry.className = "btn"; retry.textContent = "Reload";
      retry.addEventListener("click", () => location.reload());
      panel.append(message, retry); document.querySelector("#main")?.replaceChildren(panel);
    }
  });
})();
