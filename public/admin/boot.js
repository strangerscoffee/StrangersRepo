// Download Admin dependencies in parallel, then execute them in document order.
(() => {
  "use strict";
  const definitions = [...document.querySelectorAll('script[type="application/x-sc-script"][src]')];
  function assetUrl(definition) {
    const url = new URL(definition.src, location.href);
    if (url.origin !== location.origin || !/^\/(?:_releases\/[a-f0-9]{20}\/)?(?:shared|admin)\/[\w-]+\.js$/.test(url.pathname)) throw new Error("Invalid Admin dependency.");
    return url;
  }
  function download(definition, url) {
    const link = document.createElement("link");
    link.dataset.scManaged = "1";
    link.rel = "preload";
    link.as = "script";
    link.href = url.href;
    return new Promise(resolve => {
      const finish = result => { clearTimeout(timer); resolve(result); };
      // Keep a stalled optional download from blocking the shell. A timed-out asset never executes.
      const timer = setTimeout(() => { link.remove(); finish("timeout"); }, 8000);
      link.addEventListener("load", () => finish("ready"), { once: true });
      link.addEventListener("error", () => { link.remove(); finish("failed"); }, { once: true });
      definition.after(link);
    });
  }
  function preload(group) {
    return group.map(definition => {
      const url = assetUrl(definition);
      return { definition, url, ready: download(definition, url) };
    });
  }
  async function execute(definition, url) {
    const script = document.createElement("script");
    script.dataset.scManaged = "1";
    script.async = false;
    script.src = url.href;
    let runtimeError;
    const onError = event => {
      if (event.filename === script.src) runtimeError = event.error || new Error(event.message);
    };
    window.addEventListener("error", onError);
    try {
      const loaded = await new Promise(resolve => {
        script.addEventListener("load", () => resolve(true), { once: true });
        script.addEventListener("error", () => resolve(false), { once: true });
        definition.after(script);
      });
      if (!loaded) { script.remove(); return false; }
    } finally {
      window.removeEventListener("error", onError);
      delete script.dataset.scManaged;
    }
    const exported = definition.dataset.scModule;
    if (runtimeError) {
      if (exported) delete window[exported];
      throw runtimeError;
    }
    if (exported && !window[exported]) throw new Error("Couldn't initialise " + url.pathname);
    return true;
  }
  async function load({ definition, url, ready }) {
    const result = await ready;
    if (result === "ready" && await execute(definition, url)) return;
    if (result !== "timeout" && navigator.onLine !== false) {
      await new Promise(resolve => setTimeout(resolve, 250));
      url.searchParams.set("sc-asset-retry", "1");
      if (await download(definition, url) === "ready" && await execute(definition, url)) return;
    }
    throw new Error("Couldn't load " + url.pathname);
  }
  (async () => {
    const coreIndex = definitions.findIndex(definition => definition.dataset.scModule === "SC");
    if (coreIndex < 0) throw new Error("Admin core dependency is missing.");
    for (const asset of preload(definitions.slice(0, coreIndex + 1))) await load(asset);
    // Start the section downloads once the shared runtime has passed its checks.
    for (const asset of preload(definitions.slice(coreIndex + 1))) {
      const needs = (asset.definition.dataset.scNeeds || "").split(" ").filter(Boolean);
      if (needs.some(name => !window[name])) continue;
      try {
        await load(asset);
      } catch (error) {
        if (asset.definition.hasAttribute("data-sc-required")) throw error;
        window.SCReportError?.(error.message, error.stack || "", { quiet: true });
      }
    }
  })().catch(error => {
    window.SCReportError?.(error.message, error.stack || "");
    if (window.SCAdminStartupFailed) window.SCAdminStartupFailed(error.message);
    else {
      const main = document.querySelector("#main");
      if (!main) return;
      const panel = document.createElement("section"), retry = document.createElement("button");
      panel.setAttribute("role", "alert");
      panel.textContent = "Admin couldn’t start. " + error.message;
      retry.type = "button";
      retry.className = "btn";
      retry.textContent = "Reload Admin";
      retry.addEventListener("click", () => location.reload());
      panel.append(retry);
      main.replaceChildren(panel);
    }
  });
})();
