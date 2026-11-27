import { resolvePageSeo } from "../public/consumer-preview/assets/editor-seo.js";

function attribute(value: string) {
  return value.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

/** Link unfurlers and crawlers consume the initial head without running storefront JavaScript. */
export function applyConsumerPageMetadata(html: HTMLRewriter, seo: ReturnType<typeof resolvePageSeo>) {
  html.on("title", {element(element) { element.setInnerContent(seo.title); }});
  html.on('meta[name="description"]', {element(element) { element.setAttribute("content",seo.description); }});
  html.on('meta[name="robots"]', {element(element) { element.setAttribute("content",seo.robots); }});

  let additions = "";
  if (seo.publicPage) {
    additions = '<link rel="canonical" href="' + attribute(seo.canonical) + '">';
    const openGraph = {type:seo.product ? "product" : "website", site_name:"Strangers Coffee", locale:"en_GB",
      title:seo.socialTitle, description:seo.socialDescription, url:seo.canonical, image:seo.socialImage, "image:alt":seo.socialImageAlt};
    const twitter = {card:seo.socialImage ? "summary_large_image" : "summary", title:seo.socialTitle,
      description:seo.socialDescription, image:seo.socialImage, "image:alt":seo.socialImageAlt};
    for (const [key,value] of Object.entries(openGraph)) {
      if (value) additions += '<meta property="og:' + key + '" content="' + attribute(value) + '">';
    }
    for (const [key,value] of Object.entries(twitter)) {
      if (value) additions += '<meta name="twitter:' + key + '" content="' + attribute(value) + '">';
    }
    if (seo.product) {
      const item = seo.product;
      const data = {"@context":"https://schema.org", "@type":"Product", "@id":seo.url + "#product", url:seo.url,
        name:item.name, description:item.description || undefined, sku:item.sku, image:item.image || undefined,
        brand:{"@type":"Brand",name:"Strangers Coffee"}};
      // The beta checkout takes demo orders. Describe the product without advertising a live offer.
      additions += '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g,"\\u003c") + '</script>';
    }
  }
  html.on("head", {element(element) {
    element.setAttribute("data-consumer-seo","");
    if (additions) element.append(additions,{html:true});
  }});
}
