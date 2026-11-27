import { PAGES, type ConsumerEditorPage, type ConsumerEditorWidget } from "../public/consumer-preview/assets/editor-model.js";

// These routes are built from editorial HTML. Pages whose content comes from a transaction or a
// private account continue through their native renderer and its published field overrides.
const editorialScopes = new Set(["shared", "home", "shop", "locations", "about", "guides", "contact", "shipping", "privacy", "terms"]);

function escape(value: string | undefined) {
  return (value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Asset references have already passed the editor model. Keeping this conversion here also
// avoids ever treating an editorial value as an arbitrary source URL.
function publicPhoto(value?: string) {
  if (value?.startsWith("media:")) return "/consumer-media/" + value.slice(6);
  if (value?.startsWith("asset:")) return "/consumer-preview/assets/" + value.slice(6);
  return "";
}

export function applyStaticConsumerFields(html: HTMLRewriter, scope: string, page?: ConsumerEditorPage) {
  if (!page || !editorialScopes.has(scope)) return;
  for (const field of PAGES[scope].fields) {
    if (!Object.hasOwn(page.fields ?? {}, field.id)) continue;
    const value = page.fields![field.id];
    // The shared desktop/mobile inventory uses :is. Expand that known selector for streaming
    // HTMLRewriter, which understands the inventory's other simple child and position selectors.
    const parents = ":is(.desktop-nav,.mobile-links)";
    const selector = field.selector.includes(parents)
      ? [".desktop-nav",".mobile-links"].map(parent => field.selector.replace(parents,parent)).join(", ")
      : field.selector;
    html.on(selector, { element(e) {
      if (field.kind === "text") e.setInnerContent(value);
      else if (field.kind === "link") e.setAttribute("href", value);
      else if (field.kind === "alt") e.setAttribute("alt", value);
      else if (field.kind === "image") {
        e.removeAttribute("srcset");
        const src = publicPhoto(value);
        if (src) e.setAttribute("src", src);
        else {
          e.removeAttribute("src");
          e.setAttribute("data-consumer-image-hidden", "");
        }
      }
    } });
  }
  for (const section of PAGES[scope].sections) {
    const hidden = !section.locked && page.hidden?.includes(section.id);
    const layout = page.sectionLayouts?.[section.id];
    if (!hidden && !layout) continue;
    html.on(section.selector, { element(e) {
      if (hidden) e.setAttribute("data-consumer-section-hidden", "");
      if (layout) e.setAttribute("data-consumer-section-layout", layout);
    } });
  }
}
function editorialWidget(widget: ConsumerEditorWidget) {
  const opening = '<article class="consumer-widget consumer-widget-' + escape(widget.type) +
    '" data-consumer-rendered-widget="' + escape(widget.id) + '" data-consumer-widget="' + escape(widget.id) +
    '" data-widget-layout="' + escape(widget.layout || "stack") + '">';
  if (widget.type === "divider") return opening + "<hr></article>";
  const src = publicPhoto(widget.image);
  const photo = src ? '<img loading="lazy" src="' + escape(src) + '" alt="' + escape(widget.alt) + '">' : "";
  const copy = (widget.heading ? "<h2>" + escape(widget.heading) + "</h2>" : "") +
    (widget.body ? "<p>" + escape(widget.body) + "</p>" : "") +
    (widget.href && widget.label ? '<a class="button" href="' + escape(widget.href) + '">' + escape(widget.label) + "</a>" : "");
  return opening + photo + (copy ? '<div class="consumer-widget-copy">' + copy + "</div>" : "") + "</article>";
}

export function customConsumerContent(page: ConsumerEditorPage) {
  const widgets = new Map((page.widgets || []).map(w => [w.id, w]));
  const ids = new Set([...(page.sections || []), ...widgets.keys()]);
  const content = [...ids].map(id => widgets.get(id)).filter((w): w is ConsumerEditorWidget => Boolean(w)).map(editorialWidget);
  return '<h1 class="consumer-page-title">' + escape(page.title) + '</h1>' + content.join("");
}

export function applyConsumerFooterLinks(html: HTMLRewriter, navigation: {href:string;title?:string}[]) {
  if (!navigation.length) return;
  const links = navigation.map(({href,title}) => '<a data-consumer-page-link href="' + escape(href) + '">' + escape(title) + '</a>').join("");
  html.on('.site-footer nav[aria-labelledby="footer-explore"]', {element(e){e.append(links, {html:true});}});
}
