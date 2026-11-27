import { PAGES, cataloguePageForKey, customPageForKey } from "/api/admin/consumer/editor/assets/editor-model.js";

import { products } from "/api/admin/consumer/editor/assets/products.js";

export function editorPages(doc) {
  const pages = { ...PAGES };
  for (const product of products) {
    const key = 'product:' + product.id;
    if (!pages[key]) {
      const page = cataloguePageForKey(key, product);
      if (page) pages[key] = page;
    }
  }
  for (const [key, settings] of Object.entries(doc.pages || {})) {
    if (pages[key]) continue;
    const page = customPageForKey(key, settings.title) || cataloguePageForKey(key);
    if (page) pages[key] = page;
  }
  return pages;
}

function button(label, className = "btn soft") {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  return el;
}

function slugFrom(text) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
}

function linksTo(doc, key) {
  const path = "/pages/" + key.slice(7) + "/";
  return Object.entries(doc.pages).filter(([other, page]) => {
    if (other === key) return false;
    const fields = Object.values(page.fields || {});
    const targets = (page.widgets || []).map(widget => widget.href);
    return [...fields, ...targets].some(value => typeof value === "string" && value.split(/[?#]/, 1)[0].replace(/\/?$/, "/") === path);
  }).map(([other]) => editorPages(doc)[other]?.label || other);
}

export function mountEditorPages(host, {getDocument, getPage, onChange, confirmSheet}) {
  const key = getPage();
  const custom = key.startsWith("custom:");
  const controls = document.createElement("div");
  controls.className = "consumer-page-actions";
  const output = document.createElement("div");
  output.className = "consumer-page-popover";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.hidden = true;
  function message(text) {
    status.textContent = text;
    status.hidden = !text;
  }
  const add = button("Add page");
  controls.append(add);
  function close(opener) {
    output.replaceChildren();
    message("");
    opener.focus();
  }
  function editPage(creating, opener) {
    const current = getDocument();
    if (creating && Object.keys(current.pages).filter(id => id.startsWith("custom:")).length >= 24) {
      message("The storefront has 24 custom pages. Remove a page before adding another.");
      return;
    }
    message("");
    const existing = creating ? {} : current.pages[key];
    if (!existing) return;
    const form = document.createElement("form");
    form.className = "consumer-page-form";
    form.setAttribute("aria-label", creating ? "Add storefront page" : "Page settings");
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Page name";
    const title = document.createElement("input");
    title.required = true;
    title.maxLength = 80;
    title.value = existing.title || "";
    titleLabel.append(title);
    const slugLabel = document.createElement("label");
    slugLabel.textContent = "Page address";
    const slug = document.createElement("input");
    slug.autocapitalize = "none";
    slug.spellcheck = false;
    slug.maxLength = 60;
    slug.required = true;
    slug.pattern = "[a-z0-9]+(-[a-z0-9]+)*";
    slug.readOnly = !creating;
    slug.value = creating ? "" : key.slice(7);
    const address = document.createElement("small");
    function showAddress() { address.textContent = "/pages/" + (slug.value || "your-page") + "/"; }
    showAddress();
    slugLabel.append(slug, address);
    let manualAddress = false;
    slug.addEventListener("input", () => { manualAddress = !!slug.value; slug.setCustomValidity(""); showAddress(); });
    title.addEventListener("input", () => {
      title.setCustomValidity("");
      if (creating && !manualAddress) { slug.value = slugFrom(title.value); slug.setCustomValidity(""); showAddress(); }
    });
    const navigation = document.createElement("label");
    navigation.className = "consumer-page-check";
    const linked = document.createElement("input");
    linked.type = "checkbox";
    linked.checked = !!existing.inNavigation;
    navigation.append(linked, "Include in the storefront footer");
    const actions = document.createElement("div");
    actions.className = "consumer-page-actions";
    const cancel = button("Cancel");
    cancel.addEventListener("click", () => close(opener));
    const save = button(creating ? "Create page" : "Apply settings", "btn");
    save.type = "submit";
    actions.append(save, cancel);
    form.append(titleLabel, slugLabel, navigation, actions);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = title.value.trim();
      const target = creating ? "custom:" + slug.value : key;
      const next = structuredClone(getDocument());
      if (!name) { title.setCustomValidity("Enter a page name."); title.reportValidity(); return; }
      if (!customPageForKey(target, name) || (creating && Object.hasOwn(next.pages, target))) {
        slug.setCustomValidity("Choose a unique address using lowercase letters, numbers and hyphens.");
        slug.reportValidity();
        return;
      }
      const settings = creating ? {} : next.pages[target];
      if (!settings) { message("This page has been removed. Choose another page."); return; }
      next.pages[target] = { ...settings, title: name, inNavigation: linked.checked };
      onChange(next, target);
    });
    output.replaceChildren(form);
    title.focus();
  }
  add.addEventListener("click", () => editPage(true, add));
  if (custom) {
    const settings = button("Page settings");
    settings.addEventListener("click", () => editPage(false, settings));
    const remove = button("Remove page");
    remove.addEventListener("click", async () => {
      const doc = getDocument();
      const sources = linksTo(doc, key);
      if (sources.length) { message("Remove the link to this page from " + sources.join(", ") + " first."); return; }
      if (!await confirmSheet({ title: "Remove this page?", text: "The page and its footer link will come off the storefront when you publish the draft.", confirm: "Remove page", danger: true })) return;
      if (!host.isConnected || getPage() !== key) return;
      const next = structuredClone(getDocument());
      delete next.pages[key];
      onChange(next, "home");
    });
    controls.append(settings, remove);
  }
  host.replaceChildren(controls, output, status);
}
