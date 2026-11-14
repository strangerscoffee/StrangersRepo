// Wholesale Coffee Order Terms and Conditions: the one copy of the wording, shown in a pop-up from the ordering page
// (footer, checkout, My account) and the sign-in page. Any button or link marked data-terms opens it. Built with DOM
// calls, never HTML strings.
(() => {
  "use strict";
  const TITLE = "Wholesale Coffee Order Terms and Conditions";
  const TERMS = [
    ["Orders", "Orders are subject to availability and acceptance. Please check your order carefully before submitting it."],
    ["Prices and payment", "Prices are shown in the portal and may change. Payment is due according to the payment terms agreed for your account. Any applicable taxes or delivery charges will be shown at checkout."],
    ["Delivery", "We'll aim to dispatch your order as soon as possible. During peak times, there may be a slight delay unless a specific delivery date has been stated."],
    ["Changes and cancellations", "Contact us as soon as possible if you need to change or cancel an order. We may be unable to make changes once it has been prepared or dispatched."],
    ["Problems with an order", "Please tell us promptly if an order is missing, damaged, or incorrect so we can look into it."],
    ["Contact", "For questions about an order or these terms, contact us using the details provided in your account."],
  ];
  const make = (tag, props = {}, ...children) => { const n = Object.assign(document.createElement(tag), props); n.append(...children); return n; };
  let dialog = null, opener = null;
  function build() {
    const close = make("button", { className: "close-button", type: "button", textContent: "×" });
    close.setAttribute("aria-label", "Close terms and conditions");
    close.addEventListener("click", () => dialog.close());
    const list = make("ol", { className: "terms-list" }, ...TERMS.map(([head, text]) => make("li", {}, make("h3", { textContent: head }), make("p", { textContent: text }))));
    const done = make("button", { className: "button button-dark", type: "button", textContent: "Done" });
    done.addEventListener("click", () => dialog.close());
    dialog = make("dialog", { id: "terms-dialog", className: "terms-dialog" },
      make("div", { className: "dialog-inner" },
        make("div", { className: "dialog-chrome" }, close),
        make("p", { className: "eyebrow", textContent: "WHOLESALE" }),
        make("h2", { id: "terms-title", textContent: TITLE }),
        list, done));
    dialog.setAttribute("aria-labelledby", "terms-title");
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // the backdrop
    dialog.addEventListener("close", () => { opener?.focus?.({ preventScroll: true }); opener = null; });
    document.body.append(dialog);
  }
  function open(from) {
    if (!dialog) build();
    opener = from || document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(".dialog-inner").scrollTop = 0; dialog.scrollTop = 0;
  }
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest?.("[data-terms]");
    if (!trigger) return;
    e.preventDefault(); open(trigger);
  });
  window.SCWholesaleTerms = Object.freeze({ title: TITLE, terms: TERMS.map(([heading, text]) => ({ heading, text })), open });
})();
