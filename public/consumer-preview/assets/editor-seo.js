import { PAGES, cataloguePageForKey, customPageForKey, imageUrl } from './editor-model.js';
import { productDescription } from './product-content.js';
import { originalProduct } from './products.js';
import { productPath } from './product-paths.js';
export { canonicalPath } from './editor-model.js';

const previewOrigin = 'https://preview.staffstrangerscoffee.com';
const previewRobots = 'noindex, nofollow';
const publicOrigins = new Set(['https://strangerscoffee.com','https://www.strangerscoffee.com']);
const siteName = 'Strangers Coffee';
const fallbackImage = 'asset:roastery.webp';
const fallbackAlt = 'Strangers Coffee roastery in Norwich';

// The same module runs on the Worker and in the authenticated Admin editor.
// Always return public shopper URLs, even when Admin serves the asset module.
function publicImagePath(value) {
  if (typeof value !== 'string') return '';
  if (/^\/consumer-product-media\/[a-f0-9]{64}$/.test(value)) return value;
  const file = /^(?:asset:|\/(?:consumer-preview\/|api\/admin\/consumer\/editor\/)?assets\/)([-a-zA-Z0-9_.]+\.webp)$/.exec(value);
  if (file && imageUrl('asset:' + file[1])) return '/consumer-preview' + '/assets/' + file[1];
  return /^media:[a-f0-9-]{36}$/.test(value) && imageUrl(value) ? '/consumer-media/' + value.slice(6) : '';
}

function staticPhoto(def, page) {
  for (const image of def.fields || []) {
    if (image.kind !== 'image' || page.hidden?.includes(image.section)) continue;
    const ref = page.fields?.[image.id] ?? image.default;
    if (!publicImagePath(ref)) continue;
    const alt = def.fields.find(field => field.kind === 'alt' && field.selector === image.selector);
    return {ref, alt:page.fields?.[alt?.id] ?? alt?.default ?? ''};
  }
}

function customDetails(page) {
  const widgets = page.widgets || [];
  const byId = new Map(widgets.map(widget => [widget.id,widget]));
  const ordered = [...new Set([...(page.sections || []), ...byId.keys()])].map(id => byId.get(id)).filter(Boolean);
  const text = ordered.find(widget => widget.body?.trim());
  const photo = ordered.find(widget => publicImagePath(widget.image));
  return {description:text?.body, ref:photo?.image, alt:photo?.alt};
}

// Resolve in exactly the same order for search previews and initial shopper HTML.
export function resolvePageSeo(scope, {pages = {}, product, origin = previewOrigin, allowIndexing = false} = {}) {
  const specific = scope.startsWith('product:');
  const productPage = specific || scope === 'product';
  if (productPage && !product) {
    const id = specific ? scope.slice(8) : 'bom-jesus';
    product = originalProduct(id) || {id, name:PAGES['product:' + id]?.label || id};
  }
  const page = pages[scope] || {};
  const template = specific ? pages.product || {} : {};
  const meta = {...template.meta, ...page.meta};
  const fields = {...template.fields, ...page.fields};
  const def = PAGES[scope] || cataloguePageForKey(scope,product) || customPageForKey(scope,page.title);
  const publicPage = Boolean(def) && !['account','checkout','cart','finder','shared'].includes(scope);
  const path = productPage ? productPath(product) : def?.path || '/';
  // The preview cannot opt into indexing. A future consumer launch must use the
  // approved public site, enable indexing and honour each published page's preference.
  const launchRobots = publicPage ? (meta.robots === 'noindex' ? 'noindex, follow' : 'index, follow') : previewRobots;
  const robots = allowIndexing && publicOrigins.has(origin) ? launchRobots : previewRobots;
  let title = def?.seo?.title || siteName;
  let description = def?.seo?.description || '';
  let image, productName;
  if (productPage) {
    const field = id => def?.fields.find(item => item.id === id)?.default;
    productName = fields['product-title'] || product.name;
    for (const key of ['title','description','socialTitle','socialDescription','socialImageAlt']) {
      if (specific && Object.hasOwn(page.meta || {},key)) continue;
      if (typeof meta[key] === 'string') meta[key] = meta[key].replaceAll('{product}',() => productName);
    }
    title = productName + ' | ' + siteName;
    const voucher = product.id === 'online-gift-card' || product.id === 'in-store-gift-card';
    description = fields['product-description'] ?? (voucher ? field('product-description') || '' : productDescription(product));
    image = {ref:fields['product-image'] ?? (voucher ? field('product-image') : product.image),
      alt:fields['product-image-alt'] ?? (product.category === 'flight' ? fallbackAlt : productName)};
  } else if (scope.startsWith('custom:')) {
    const custom = customDetails(page);
    title = (page.title || def?.label || siteName) + ' | ' + siteName;
    description = custom.description || page.title || '';
    image = {ref:custom.ref, alt:custom.alt};
  } else if (def && publicPage) {
    image = staticPhoto(def,page);
  }
  // Leave explicitly supplied metadata intact. Keep long on-page prose usable as an automatic snippet.
  description = (typeof description === 'string' ? description : '').replace(/\s+/g,' ').trim();
  if (!def?.seo && description.length > 320) description = description.slice(0,317).trimEnd() + '…';
  const pageImage = publicImagePath(image?.ref);
  const shareImage = publicImagePath(meta.socialImage) || pageImage || publicImagePath(fallbackImage);
  // A replacement photograph should not inherit the description of a different template image.
  const socialAlt = specific && page.meta?.socialImage ? page.meta.socialImageAlt : meta.socialImageAlt;
  const alt = socialAlt ?? (meta.socialImage ? '' : pageImage ? image.alt || '' : fallbackAlt);
  const canonical = new URL(meta.canonical || path,origin).href;
  return {
    publicPage, title:meta.title || title, description:meta.description || description,
    socialTitle:meta.socialTitle || meta.title || title, socialDescription:meta.socialDescription || meta.description || description,
    url:publicPage ? new URL(path,origin).href : '', canonical:publicPage ? canonical : '', socialImage:publicPage && shareImage ? new URL(shareImage,origin).href : '',
    socialImageAlt:publicPage ? alt : '', robots, launchRobots,
    product:productPage ? {name:productName, description, image:pageImage ? new URL(pageImage,origin).href : '', sku:product.id} : undefined,
  };
}
