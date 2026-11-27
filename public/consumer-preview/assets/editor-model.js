import { assetFiles, staticPages } from './editor-inventory.js';
import { productRoutes } from './product-paths.js';
import { productContent } from './product-content.js';
import { products } from './products.js';
import { authModes } from './account.js';
import { finderOptions } from './finder.js';

export const THEMES = Object.freeze({ heritage: 'Strangers green', espresso: 'Espresso', oat: 'Oat', sage: 'Sage' });
export const LAYOUTS = Object.freeze({ standard: 'Standard', wide: 'Wide', compact: 'Compact' });
export const WIDGET_TYPES = Object.freeze({
  text: 'Text section', hero: 'Feature banner', image: 'Photograph', cards: 'Feature card',
  callout: 'Call to action', divider: 'Divider', 'coffee-shelf': 'Shoppable coffees', 'locations-list': 'Café locations',
});
export const ASSETS = Object.freeze(assetFiles);
export const COFFEE_CHOICES = products.filter(p => !p.category).map(({id, name}) => ({id,name}));
const externalGiftCards = new Set(['online-gift-card', 'in-store-gift-card']);
const productIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEMPLATES = {
  collection: { label: 'Coffee collection', widgets: [
    { type: 'text', heading: 'Explore our coffee', body: 'Choose your next coffee from our Norwich roastery.' },
    { type: 'coffee-shelf', heading: 'On the roaster', items: ['bom-jesus','rocko','anserma'] },
  ] },
  roastery: { label: 'Roastery story', widgets: [
    { type: 'hero', heading: 'Visit our roastery', image: 'asset:roastery.webp', alt: 'Strangers Coffee Roastery', layout: 'split' },
    { type: 'text', heading: 'Roasted in Norwich', body: 'Meet the people behind the coffee.', label: 'Our story', href: '/about/' },
  ] },
  feature: { label: 'Featured coffee', widgets: [
    { type: 'cards', heading: 'Coffee of the week', image: 'asset:bom-jesus.webp', alt: 'Fazenda Bom Jesus', layout: 'split', label: 'Explore our coffee', href: '/coffee/' },
    { type: 'callout', heading: 'Brew it at home', label: 'Brew guides', href: '/brewguides/' },
  ] },
  visit: { label: 'Visit a café', widgets: [
    { type: 'hero', heading: 'Come in for a coffee', image: 'asset:pottergate.webp', alt: 'Pottergate café', layout: 'reverse' },
    { type: 'callout', heading: 'Find us in Norwich', label: 'Our locations', href: '/location/' },
  ] },
};

const field = (id, label, selector, value, kind = 'text', section) =>
  ({ id, label, selector, default: value, kind, section });
function photo(id, label, selector, reference = '', alt = '', section) {
  return [field(id, label, selector, reference, 'image', section),
    field(id + '-alt', label + ' · alternative text', selector, alt, 'alt', section)];
}
const link = (id, label, selector, href) => field(id, label, selector, href, 'link');

function sharedFields() {
  const fields = [
    field('announcement', 'Announcement', '.notice > a', 'Free shipping on orders over £45'),
    link('announcement-link', 'Announcement · link', '.notice > a', '/shipping/'),
    ...photo('header-logo', 'Header logo', '.site-header .brand img', 'asset:logo.svg', 'Strangers Coffee Company'),
    ...photo('footer-logo', 'Footer logo', '.footer-brand img', 'asset:logo.svg', 'Strangers Coffee Company'),
    field('footer-name', 'Footer company name', '.footer-identity-copy p', 'Strangers Coffee Company Norwich'),
    field('explore', 'Explore navigation heading', '#footer-explore', 'Explore'),
    field('care', 'Customer care heading', '#footer-care', 'Customer care'),
    field('bag-label', 'Cart button', '.site-header .bag-label', 'Cart'),
    field('find-label', 'Coffee finder button', '.site-header [data-find]', 'Find my coffee'),
  ];
  // Position selectors remain stable if an editor changes a link's destination.
  const groups = [
    ['header', '.site-header :is(.desktop-nav,.mobile-links)', [['shop','Online shop','/coffee/'],['locations','Locations','/location/'],['about','About','/about/'],['guides','Brew guides','/brewguides/']]],
    ['explore', '.site-footer nav[aria-labelledby="footer-explore"]', [['shop','Online shop','/coffee/'],['locations','Locations','/location/'],['about','About','/about/'],['guides','Brew guides','/brewguides/']]],
    ['care', '.site-footer nav[aria-labelledby="footer-care"]', [['contact','Contact','/contact/'],['shipping','Shipping & returns','/shipping/'],['privacy','Privacy policy','/privacy-policy/'],['terms','Terms & conditions','/terms-conditions/']]],
  ];
  for (const [area, parent, items] of groups) {
    items.forEach(([key, label, url], index) => {
      const selector = parent + ' > a:nth-of-type(' + (index + 1) + ')';
      fields.push(field(area + '-' + key, area + ' · ' + label, selector, label),
        link(area + '-' + key + '-link', area + ' · ' + label + ' destination', selector, url));
    });
  }
  return fields;
}

const finder = '#dialog[data-view="finder"] ';
const bag = '#dialog[data-view="bag"] ';
const finderFields = [
  field('title', 'Finder title', finder + '#dialog-title', 'Find my coffee'),
  field('match-title', 'Match heading', finder + '.finder-result-head h3', 'Your coffee match'),
  field('alternatives', 'Alternatives heading', finder + '#finder-others', 'Also worth trying'),
  field('change', 'Change answers', finder + '.finder-change', 'Change answers'),
];
for (const [step, heading, intro, next] of [
  ['brew','How do you brew?', 'We’ll suggest a grind for your setup.', 'Continue to taste'],
  ['taste','What flavours do you enjoy?', 'Pick the flavours you’d like in your cup.', 'Find my match'],
]) {
  const selector = finder + '.finder-stage[data-step="' + step + '"] ';
  finderFields.push(field(step+'-title', step+' · heading',selector+'.finder-heading',heading),
    field(step+'-intro',step+' · introduction',selector+'.finder-intro',intro),
    field(step+'-next',step+' · continue button',selector+'.finder-next',next),
    ...photo(step+'-image',step+' · photograph',selector+'.finder-visual img','asset:finder-'+step+'.webp'));
}
const cartFields = [
  field('title', 'Cart title', bag + '#dialog-title', 'Your cart'),
  field('empty-title', 'Empty cart heading', bag + '.empty-bag h3', 'Your cart is empty.'),
  field('empty-copy', 'Empty cart description', bag + '.empty-bag p', 'Start with one of the coffees on the shelf.'),
  field('empty-action', 'Browse button', bag + '.empty-bag [data-keep-shopping]', 'Browse coffee'),
  field('keep-shopping', 'Continue shopping button', bag + '.drawer-content [data-keep-shopping]', 'Keep shopping'),
];
const checkoutFields = [
  field('details-heading', 'Delivery and contact heading', '#retail-checkout-stage-title', 'Delivery and contact'),
  field('review-heading', 'Order review heading', '#retail-review-title', 'Review your order'),
  field('summary-heading', 'Order summary heading', '#retail-summary-heading, .retail-checkout-summary-mobile > span', 'Order summary'),
  field('empty-heading', 'Empty checkout heading', '#retail-checkout .retail-checkout-message:has(a[href="/coffee/"]) h2', 'Your cart is empty'),
  field('empty-intro', 'Empty checkout description', '#retail-checkout .retail-checkout-message:has(a[href="/coffee/"]) p', 'Choose a coffee to begin.'),
];
// The editable labels live alongside native controls, leaving personal values, rates, prices and order status intact.
function captions(prefix, definitions) {
  return definitions.map(([id,label,selector,copy]) => field(id,label,prefix+selector,copy));
}

for (const [group, options] of Object.entries(finderOptions)) {
  for (const {value, label, detail} of options) {
    const id = group+'-'+value.toLowerCase().replace(/[^a-z0-9]+/g,'-');
    const option = finder+'input[name="'+group+'"][value="'+value+'"] + .finder-option-copy';
    const answer = finder+'[data-finder-answer="'+group+'"][data-value="'+value+'"]';
    finderFields.push(field(id+'-label',group+' choice · '+label,option+' > strong, '+answer,label));
    if (detail) finderFields.push(field(id+'-detail',group+' description · '+label,option+' > small',detail));
  }
}
finderFields.push(...captions(finder,[
  ['caffeine-legend','Caffeine question','.finder-caffeine legend','Caffeine preference'],
  ['taste-back','Taste step · back button','[data-step="taste"] .finder-back','Back'],
  ['details-link','Coffee details link','.finder-best-actions a','Coffee details'],
  ['add-label','Add button · label before the bag size and price','[data-finder-add-label]','Add'],
  ['add-flight','Tasting flight · label before the price','[data-finder-flight-label]','Add flight'],
  ['flight-copy','Tasting flight · description','.finder-flight h5 + p','Try Bom Jesus, Rocko Mountain and Anserma side by side.'],
  ...['Brew','Taste','Match'].map((name,i)=>['progress-'+name.toLowerCase(),'Progress · '+name,'.finder-progress > span:nth-child('+(i+1)+')',name]),
]));

cartFields.push(...captions(bag,[
  ['checkout','Checkout link','.drawer-actions a[data-checkout]','Checkout'],
  ['resume-checkout','Resume checkout button','.drawer-actions [data-return-checkout]','Resume checkout'],
  ['remove','Remove item button','[data-cart-remove-label]','Remove'],
  ['subtotal','Subtotal label','.totals > div:first-child dt','Subtotal'],
  ['shipping','Delivery charge label','.totals > div:nth-child(2) dt','Royal Mail Tracked 48'],
  ['total','Grand total label','.grand-total dt','Total'],
]));

checkoutFields.push(...captions('#retail-checkout ',[
  ['fulfilment-legend','Fulfilment question','#retail-checkout-form > fieldset:first-child legend','How would you like your coffee?'],
  ['details-legend','Contact section heading','#retail-checkout-form > fieldset:nth-child(2) legend','Contact details'],
  ['address-legend','Delivery address section heading','#retail-checkout-delivery legend','Delivery address'],
  ['collection-legend','Collection section heading','#retail-checkout-collection legend','Collection location'],
  ['guest-intro','Guest checkout introduction','.retail-checkout-guest p','Continue as a guest.'],
  ['guest-signin','Guest sign-in link','.retail-checkout-guest [data-checkout-signin]','Sign in'],
  ['name-label','Contact name label','label[for="retail-checkout-name"]','Full name'],
  ['email-label','Contact email label','label[for="retail-checkout-email"]','Email address'],
  ['phone-label','Telephone number label','label[for="retail-checkout-phone"] > span','Phone'],
  ['phone-optional','Telephone optional label','label[for="retail-checkout-phone"] > small','Optional'],
  ['street-label','Street address label','label[for="retail-checkout-address"]','Street address'],
  ['town-label','Town or city label','label[for="retail-checkout-town"]','Town or city'],
  ['postcode-label','Postcode label','label[for="retail-checkout-postcode"]','UK postcode'],
  ['cafe-label','Café selection label','label[for="retail-checkout-cafe"]','Choose a café'],
  ['sample-action','Sample details button','[data-checkout-sample]','Fill sample details'],
  ['back-to-cart','Back to cart button','.retail-checkout-cart[data-bag]','Back to cart'],
  ['review-action','Review order button','button[form="retail-checkout-form"]','Review order'],
  ['edit-action','Edit details button','[data-checkout-edit]','Edit details'],
  ['place-action','Place test order button','[data-place-retail-order]','Place test order'],
  ['review-instruction','Review stage instruction','#retail-review-title + p','Check your details before placing the test order.'],
  ['review-delivery','Review · UK delivery heading','[data-review-method="delivery"]','UK delivery'],
  ['review-collection','Review · collection heading','[data-review-method="collection"]','Norwich collection'],
  ['contact-summary','Review and receipt · contact details heading','[data-contact-heading]','Contact details'],
  ['processing-heading','Processing screen heading','.retail-checkout-processing h2','Preparing your receipt'],
  ['confirmed-heading','Confirmation screen heading','[data-order-confirmed]','Your test order is confirmed.'],
  ['updates-heading','Receipt · timeline heading','[data-updates-heading]','Order updates'],
  ['receipt-delivery','Receipt · delivery heading','[data-receipt-method="delivery"]','Delivery service'],
  ['receipt-collection','Receipt · collection heading','[data-receipt-method="collection"]','Collection location'],
  ['refresh-action','Receipt · refresh button','[data-checkout-refresh]','Refresh order status'],
  ['tracking-copy','Receipt · copy link button','[data-copy-tracking]','Copy tracking link'],
  ['account-action','Receipt · view account link','.retail-checkout-receipt-actions a[href="/account/#orders"]','View My account'],
  ['continue-shopping','Receipt · continue shopping link','.retail-checkout-receipt-actions a[href="/coffee/"]','Continue shopping'],
  ['empty-action','Empty checkout · shop link','.retail-checkout-message > a[href="/coffee/"]','Shop coffee'],
  ['subtotal','Order summary subtotal label','.totals > div:first-child dt','Subtotal'],
  ...['Details','Review','Confirmation'].map((name,i)=>['step-'+name.toLowerCase(),'Checkout progress · '+name,'.retail-checkout-progress li:nth-child('+(i+1)+') [data-step-caption]',name]),
]));
checkoutFields.push(field('total','Order total label','#retail-checkout .grand-total dt, #retail-checkout .retail-checkout-action-total > small','Total'));
for (const [method, label, help, estimate] of [
  ['delivery','UK delivery','Royal Mail Tracked 48','Estimated delivery 2–3 working days from dispatch'],
  ['collection','Collect in Norwich','Free café collection','Collect from your chosen location once it’s ready'],
]) {
  const option = '#retail-checkout-form input[name="method"][value="'+method+'"] + span';
  checkoutFields.push(field(method+'-option',method+' · fulfilment option',option+' > strong',label),
    field(method+'-help',method+' · fulfilment help',option+' > small',help),
    field(method+'-estimate',method+' · order summary help','#retail-checkout .retail-checkout-delivery-note[data-method="'+method+'"]',estimate));
}

const productSections = [
  { id: 'crumb', label: 'Breadcrumbs', selector: '.retail-product-crumb' },
  { id: 'intro', label: 'Photographs and purchase options', selector: '.retail-product-intro', locked: true },
  { id: 'producer', label: 'Producer and brew guide', selector: '#producer' },
  { id: 'related', label: 'Related coffees', selector: '.retail-product-section:not(:has(~ .retail-product-section))' },
];
const defaultProductFields = [
  field('related-title', 'Related coffees heading', '.retail-product-section:not(:has(~ .retail-product-section)) h2', 'You might also like'),
  field('producer-label', 'Producer label', '.retail-product-origin .eyebrow', 'From the producer'),
  field('producer-title', 'Producer title', '.retail-product-origin h2', 'Meet the coffee'),
  field('brew-label', 'Brew guide label', '.retail-product-brew .eyebrow', 'Brew at home'),
  field('brew-guide', 'Brew guide link label', '.retail-product-brew a', 'Read our brew guides'),
  link('brew-link','Brew guide destination','.retail-product-brew a','/brewguides/'),
  field('delivery-label','Delivery information label','.retail-product-delivery a:first-child','UK delivery and returns'),
  field('collection-label','Collection information label','.retail-product-delivery a:last-child','Norwich collection'),
];
function productFieldSection(f) {
  if (f.id === 'related-title') return 'related';
  if (f.id === 'flight-heading') return 'contents';
  if (/^(producer-|brew-|provenance-)/.test(f.id)) return 'producer';
  return 'intro';
}
for (const f of defaultProductFields) f.section=productFieldSection(f);
const firstProductSlug = Object.keys(productRoutes).find(slug => productRoutes[slug].id === 'bom-jesus');

export const PAGES = {
  shared: { label: 'Header and footer', path: '/', root: 'body', fields: sharedFields(), sections: [], widgets: false },
  ...staticPages,
  product: { label: 'Product page template', path: '/coffee/p/'+firstProductSlug+'/', root: 'main', sections: productSections, fields: defaultProductFields },
  finder: { label: 'Coffee finder', path: '/', root: '#dialog[data-view="finder"]', sections: [], fields: finderFields, widgets: false },
  cart: { label: 'Cart drawer', path: '/', root: '#dialog[data-view="bag"]', sections: [], fields: cartFields, widgets: false },
};
PAGES.checkout.fields.push(...checkoutFields.map(f=>({...f,section:'checkout'})));
for (const [mode, settings] of Object.entries(authModes)) {
  const scope = '#account-access:has(#account-auth-form[data-auth-mode="'+mode+'"]:not([hidden])) ';
  PAGES.account.fields.push(field(mode+'-heading',mode+' · heading',scope+'#account-access-title',settings.heading,'text','access'),
    field(mode+'-copy',mode+' · description',scope+'#account-access-copy',settings.copy,'text','access'),
    field(mode+'-submit',mode+' · submit label',scope+'#account-auth-submit',settings.submit,'text','access'));
}
for (const [slug, {id, name}] of Object.entries(productRoutes)) {
  const product = products.find(item => item.id === id);
  const details = productContent[id] || {};
  const fallback = id === 'online-gift-card' ? 'Give someone a digital voucher to spend on coffee, gifts or accessories. The recipient can redeem their unique code at checkout.' :
    'This physical gift card can be used at our Norwich shops and is posted to the address provided at checkout.';
  const intro = product ? details.description || (product.notes.length ? 'Tasting notes of ' + product.notes.join(', ') + '.' : product.shortCopy) : fallback;
  const image = product?.image?.split('/').pop() || id + '.webp';
  const isCoffee = Boolean(product && !product.category);
  const provenance = details.provenance?.length ? details.provenance
    : [['Region',product?.region],['Process',product?.process]].filter(([,value])=>value);
  const producer = details.story?.[0] || product?.story;
  const fields = [
    ...defaultProductFields.filter(f=>{
      if (f.id.startsWith('producer-')) return isCoffee && (producer || provenance.length);
      if (f.id.startsWith('brew-')) return isCoffee;
      return Boolean(product);
    }),
    field('product-title', 'Product title', '.retail-product-copy h1', name),
    field('product-description', 'Product description', '.retail-product-copy h1 + .retail-product-lede', intro),
  ];
  const photos = [
    {file:image,alt:product?.category==='flight'?'Strangers Coffee Roastery':name},
    ...(details.photos || []).map((p,i) => ({ file:p.src.split('/').pop(), alt:name+' · '+p.label+' '+(i+1) })),
    ...products.filter(item => product?.contents?.includes(item.id)).map(p => ({ file:p.image.split('/').pop(), alt:p.name })),
  ];
  photos.forEach((p,i) => {
    const selector='[data-gallery-main][data-gallery-current="'+i+'"], [data-gallery-index="'+i+'"] img';
    fields.push(...photo(i?'gallery-'+i:'product-image',i?'Gallery photograph '+(i+1):'Primary product photograph',selector,'asset:'+p.file,p.alt,'intro'));
  });
  if (isCoffee) {
    if (producer) fields.push(field('producer-intro','Producer introduction','.retail-product-origin > h2 + p',producer));
    for (const [index, [title, value]] of provenance.entries()) {
      const row='.retail-product-origin dl > div:nth-of-type('+(index+1)+') ';
      fields.push(field('provenance-label-'+(index+1),'Provenance · '+title+' label',row+'dt',title),
        field('provenance-value-'+(index+1),'Provenance · '+title,row+'dd',value));
    }
    for (const [index, note] of product.notes.entries()) {
      fields.push(field('note-'+(index+1),'Tasting note '+(index+1),'.retail-product-notes li:nth-child('+(index+1)+')',note));
    }
    for (const [index, paragraph] of (details.story || []).slice(1).entries()) {
      fields.push(field('producer-paragraph-'+(index+1),'Producer story · paragraph '+(index+1),'.retail-product-origin details p:nth-of-type('+(index+1)+')',paragraph));
    }
  }
  const sections = productSections.filter(section =>
    section.id === 'producer' ? isCoffee : section.id === 'related' ? Boolean(product) : true);
  if (product?.category === 'flight') {
    const selector = '.retail-product-section:has(~ .retail-product-section)';
    sections.splice(2,0,{id:'contents',label:'In the flight',selector});
    fields.push(field('flight-heading','Flight contents heading',selector+' h2','In the flight'));
  }
  if (!product) {
    fields.push(field('voucher-note','Gift card redemption note','.retail-product-copy p.retail-product-lede + p',id==='online-gift-card'?'Online gift cards have no expiry date and can be redeemed in our online shop.':'It can be redeemed in our shops.'));
  }
  for (const f of fields) f.section ||= productFieldSection(f);
  PAGES['product:'+id] = { label:name, path:'/coffee/p/'+slug+'/',root:'main',sections,fields };
}
const slugs = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function customPageForKey(key, title) {
  const slug = typeof key === 'string' && key.startsWith('custom:') ? key.slice(7) : '';
  if (!slug || slug.length > 60 || !slugs.test(slug)) return null;
  return { label: title || slug, path: '/pages/'+slug+'/', root: 'main', sections: [], fields: [] };
}
const pageByPath = new Map(Object.entries(PAGES)
  .filter(([key]) => !['shared','finder','cart','product'].includes(key)).map(([key,page])=>[page.path,key]));
export function pageForPath(path) {
  const pathname = typeof path === 'string' ? path.split(/[?#]/,1)[0].replace(/\/?$/, '/') : '';
  const slug = /^\/pages\/([a-z0-9-]+)\/$/.exec(pathname)?.[1];
  return pageByPath.get(pathname) ?? (slug && customPageForKey('custom:'+slug) ? 'custom:'+slug : null);
}
export const EMPTY_DOCUMENT = Object.freeze({schema:1,theme:'heritage',pages:Object.freeze({})});
export function emptyDocument() { return {schema:1,theme:'heritage',pages:{}}; }

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const files = new Set(ASSETS);
export function imageUrl(value, admin = false) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('asset:') && files.has(value.slice(6))) return '/consumer-preview/assets/'+value.slice(6);
  if (value.startsWith('media:') && uuid.test(value.slice(6))) return (admin ? '/api/admin/consumer/editor/media/' : '/consumer-media/')+value.slice(6);
  return '';
}
function invalid(message) { throw new TypeError(message); }
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(Object.getPrototypeOf(value)) !== null)) invalid('Check '+label+'.');
  return value;
}
function allowedKeys(object, keys, label) {
  if (Object.keys(object).some(key => !keys.includes(key))) invalid('Unsupported setting in '+label+'.');
}
function choice(value, options, label) {
  if (typeof value !== 'string' || !Object.hasOwn(options,value)) invalid('Choose a valid '+label+'.');
  return value;
}
function textValue(value, max, label) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid('Check '+label+' (up to '+max+' characters).');
  return value;
}
function safeLink(value, pages) {
  textValue(value,2048,'link');
  if (!value) return '';
  if (/\s|\\|[\u0000-\u001f\u007f]/.test(value) || /%(?:[01][0-9a-f]|7f|2f|5c|2e)/i.test(value)) invalid('Choose a valid link.');
  if (/^#[A-Za-z][\w.:-]*$/.test(value) || /^mailto:[^?@\s]+@[^/@\s]+\.[^/?@\s]+$/.test(value) || /^tel:\+?[\d()-]+$/.test(value)) return value;
  const base = 'https://preview.staffstrangerscoffee.com';
  let url;
  try { url = new URL(value,base); } catch { invalid('Choose a valid link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || value.startsWith('//')) invalid('Choose an HTTPS or storefront link.');
  if (value.startsWith('/') || url.origin === base) {
    const productSlug = /^\/coffee\/p\/([a-z0-9-]{1,100})\/?$/.exec(url.pathname)?.[1];
    if (productSlug && productIdPattern.test(productSlug)) return url.pathname+url.search+url.hash;
    const key = pageForPath(url.pathname);
    if (!key || (key.startsWith('custom:') && !Object.hasOwn(pages,key))) invalid('Choose an existing storefront page.');
    return url.pathname+url.search+url.hash;
  }
  if (!value.startsWith('https://')) invalid('Choose an HTTPS or storefront link.');
  return value;
}
function imageValue(value) {
  if (value === '' || imageUrl(value)) return value;
  invalid('Choose a photograph from the media library.');
}
function uniqueList(value, allowed, label) {
  if (!Array.isArray(value) || value.length>allowed.size || value.some(id=>typeof id !== 'string' || !allowed.has(id)) ||
      new Set(value).size !== value.length) invalid('Check the '+label+'.');
  return [...value];
}
function normalizeWidget(raw, pages) {
  const w=record(raw,'widget');
  allowedKeys(w,['id','type','heading','body','alt','image','label','href','layout','items'],'widget');
  if (typeof w.id !== 'string' || !/^w-[a-z0-9][a-z0-9-]{0,58}$/.test(w.id)) invalid('Check the widget identifier.');
  const out={id:w.id,type:choice(w.type,WIDGET_TYPES,'widget')};
  for (const [key,cap] of Object.entries({heading:240,body:8000,alt:500,label:160})) {
    if (Object.hasOwn(w,key)) out[key]=textValue(w[key],cap,key);
  }
  if (Object.hasOwn(w,'items')) {
    if (w.type !== 'coffee-shelf' || !Array.isArray(w.items) || !w.items.length || w.items.length > 6) invalid('Choose up to six coffees for a coffee shelf.');
    // A saved shelf remains editable after a coffee is archived. The renderer
    // resolves each stable ID against the current catalogue and skips missing items.
    if (w.items.some(id => typeof id !== 'string' || id.length > 100 || !productIdPattern.test(id) || externalGiftCards.has(id))
        || new Set(w.items).size !== w.items.length) invalid('Check the coffee selection.');
    out.items = [...w.items];
  }
  if (Object.hasOwn(w,'layout')) out.layout=choice(w.layout,{stack:true,split:true,reverse:true},'widget layout');
  if (Object.hasOwn(w,'image')) out.image=imageValue(w.image);
  if (Object.hasOwn(w,'href')) out.href=safeLink(w.href,pages);
  return out;
}
export function validateDocument(raw) {
  const doc=record(raw,'storefront document');
  allowedKeys(doc,['schema','theme','pages'],'document');
  if (doc.schema !== 1) invalid('Unsupported storefront document version.');
  const pages=record(doc.pages,'pages');
  if (Object.keys(pages).filter(k=>k.startsWith('custom:')).length>24) invalid('A storefront can have up to 24 custom pages.');
  const result={schema:1,theme:choice(doc.theme,THEMES,'storefront theme'),pages:{}};
  for (const [key,rawPage] of Object.entries(pages)) {
    const custom=customPageForKey(key);
    const def=Object.hasOwn(PAGES,key)?PAGES[key]:custom;
    if (!def) invalid('Unknown storefront page.');
    const page=record(rawPage,'page settings');
    const pageKeys=['theme','layout','sectionLayouts','fields','sections','hidden','widgets'];
    if (custom) pageKeys.push('title','inNavigation');
    if (!['finder','cart','shared'].includes(key)) pageKeys.push('meta');
    allowedKeys(page,pageKeys,def.label);
    const out={};
    if (custom) {
      out.title=textValue(page.title,80,'page title').trim();
      if (!out.title) invalid('Give the page a title.');
      if (Object.hasOwn(page,'inNavigation')) {
        if (typeof page.inNavigation !== 'boolean') invalid('Choose a navigation setting.');
        out.inNavigation=page.inNavigation;
      }
    }
    if (Object.hasOwn(page,'meta')) {
      const meta=record(page.meta,'page metadata');
      allowedKeys(meta,['title','description'],'page metadata');
      out.meta={};
      for (const [property,cap] of [['title',150],['description',320]]) {
        if (!Object.hasOwn(meta,property)) continue;
        const value=textValue(meta[property],cap,'page '+property).trim();
        if (!value) invalid('Enter a '+property+' or clear its override.');
        out.meta[property]=value;
      }
    }
    if (Object.hasOwn(page,'theme')) out.theme=choice(page.theme,THEMES,'page theme');
    if (Object.hasOwn(page,'layout')) out.layout=choice(page.layout,LAYOUTS,'page layout');
    const nativeIds=new Set(def.sections.map(section=>section.id));
    if (Object.hasOwn(page,'sectionLayouts')) {
      const layouts=record(page.sectionLayouts,'section layouts');
      out.sectionLayouts={};
      for (const [id,value] of Object.entries(layouts)) {
        if (!nativeIds.has(id)) invalid('Unknown section layout.');
        out.sectionLayouts[id]=choice(value,LAYOUTS,'section layout');
      }
    }
    const ids=new Set(nativeIds);
    if (Object.hasOwn(page,'widgets')) {
      if (!Array.isArray(page.widgets) || page.widgets.length>40 || (def.widgets===false && page.widgets.length)) invalid('Choose a supported number of widgets for '+def.label+'.');
      out.widgets=page.widgets.map(rawWidget=>{
        const w=normalizeWidget(rawWidget,pages);
        if (ids.has(w.id)) invalid('Use a distinct identifier for each widget.');
        ids.add(w.id); return w;
      });
    }
    if (Object.hasOwn(page,'sections')) out.sections=uniqueList(page.sections,ids,'section order');
    if (Object.hasOwn(page,'hidden')) out.hidden=uniqueList(page.hidden,new Set(def.sections.filter(s=>!s.locked).map(s=>s.id)),'hidden sections');
    if (Object.hasOwn(page,'fields')) {
      const fields=record(page.fields,'content fields');
      const definitions=new Map(def.fields.map(f=>[f.id,f]));
      out.fields={};
      for (const [id,value] of Object.entries(fields)) {
        const f=definitions.get(id);
        if (!f) invalid('Unknown content field on '+def.label+'.');
        out.fields[id]=f.kind==='image'?imageValue(value):f.kind==='link'?safeLink(value,pages):textValue(value,f.kind==='alt'?500:16000,f.label);
      }
    }
    result.pages[key]=out;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 384*1024) invalid('The storefront document exceeds 384 KiB.');
  return result;
}

export function referencedMedia(doc) {
  const ids=new Set();
  function collect(value) {
    if (typeof value==='string' && value.startsWith('media:') && uuid.test(value.slice(6))) ids.add(value.slice(6));
  }
  for (const [key,page] of Object.entries(doc.pages)) {
    const def=PAGES[key];
    for (const field of def?.fields || []) if (field.kind==='image') collect(page.fields?.[field.id]);
    for (const widget of page.widgets || []) collect(widget.image);
  }
  return [...ids];
}
