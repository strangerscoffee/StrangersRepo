/** Set editorial metadata in the initial document so the browser and link previews agree. */
export function applyConsumerPageMetadata(html: HTMLRewriter, meta?: {title?: string; description?: string}) {
  if (meta?.title) {
    const title = meta.title;
    html.on("title", {element(element) { element.setInnerContent(title); }});
    html.on('meta[property="og:title"], meta[name="twitter:title"]', {element(element) { element.setAttribute("content", title); }});
  }
  if (meta?.description) {
    const description = meta.description;
    html.on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', {
      element(element) { element.setAttribute("content", description); },
    });
  }
  return html;
}
