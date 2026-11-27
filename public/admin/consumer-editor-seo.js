import {canonicalPath, resolvePageSeo} from '/api/admin/consumer/editor/assets/editor-seo.js';

const publicOrigin = 'https://preview.staffstrangerscoffee.com';
const panels = {search:'Search', social:'Sharing', indexing:'Indexing'};
export const hasPageSeo = scope => !['shared','finder','cart'].includes(scope);

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function thumbnail(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value, publicOrigin); } catch { return ''; }
  if (url.origin !== publicOrigin) return '';
  const path = url.pathname;
  if (/^\/consumer-preview\/assets\/[\w.-]+\.(?:jpe?g|png|webp|svg)$/i.test(path))
    return path.replace('/consumer-preview/assets/', '/api/admin/consumer/editor/assets/');
  if (/^\/consumer-media\/[a-f0-9-]{36}$/.test(path)) return path.replace('/consumer-media/', '/api/admin/consumer/editor/media/');
  if (/^\/consumer-product-media\/[a-f0-9]{64}$/.test(path)) return path.replace('/consumer-product-media/', '/api/admin/consumer/product-photos/');
  return '';
}

// All values in the previews come from the resolver used to produce the shopper's initial HTML.
export function seoInspector({scope, pages, product, section, selectSection, change, finishField, photos}) {
  const root = node('section','ce-seo');
  root.setAttribute('aria-label','Page SEO');
  const privatePage = ['account','checkout'].includes(scope);
  const template = scope === 'product';
  const panel = privatePage ? 'search' : section;
  const settings = () => pages[scope]?.meta || {};
  const fields = [];
  const previews = [];
  function resolved(omit) {
    const meta = {...settings()};
    delete meta[omit];
    // An unfinished address can stay in a local edit while previews use the automatic URL.
    if (meta.canonical) {
      try { meta.canonical = canonicalPath(meta.canonical, pages); } catch { delete meta.canonical; }
    }
    return resolvePageSeo(scope, {pages:{...pages,[scope]:{...pages[scope],meta}}, product});
  }
  function refresh() {
    const effective = resolved();
    fields.forEach(update => update(effective));
    previews.forEach(update => update(effective));
  }
  function textField(id, label, {limit, hint, rows = 0} = {}) {
    const wrap = node('div','ce-seo-field');
    const name = node('label','ce-field');
    const el = node(rows ? 'textarea' : 'input');
    el.setAttribute('aria-label',label);
    if (rows) el.rows = rows;
    if (id === 'canonical') { el.spellcheck = false; el.autocapitalize = 'none'; el.inputMode = 'url'; }
    el.maxLength = limit;
    el.value = settings()[id] || '';
    name.append(node('span','',label),el);
    const foot = node('div','ce-seo-field-foot');
    const count = node('small');
    count.id = 'ce-seo-count-' + id;
    const reset = node('button','ce-seo-reset','Use automatic');
    reset.type = 'button';
    reset.setAttribute('aria-label','Use automatic ' + label.toLowerCase());
    foot.append(count,reset);
    const error = node('p','ce-seo-error');
    error.hidden = true;
    error.id = 'ce-seo-error-' + id;
    error.setAttribute('aria-live','polite');
    el.setAttribute('aria-describedby',hint ? count.id + ' ' + error.id : error.id);
    function commit() {
      change(id,el.value.trim(),true);
      refresh();
    }
    el.addEventListener('input',commit);
    el.addEventListener('blur',finishField);
    reset.onclick = () => { el.value = ''; commit(); el.focus(); };
    fields.push(effective => {
      const automatic = resolved(id);
      let fallback = automatic[id] || '';
      if (id === 'canonical' && fallback.startsWith(publicOrigin)) fallback = fallback.slice(publicOrigin.length) || '/';
      el.placeholder = fallback;
      const value = el.value.trim();
      count.textContent = hint ? (value || effective[id] || '').length + ' characters · ' + hint : '';
      reset.hidden = !settings()[id];
      let invalid = '';
      if (id === 'canonical' && value) {
        try { canonicalPath(value,pages); } catch (e) { invalid = e.message; }
      }
      error.hidden = !invalid;
      error.textContent = invalid;
      el.setCustomValidity(invalid);
      if (invalid) el.setAttribute('aria-invalid','true'); else el.removeAttribute('aria-invalid');
    });
    wrap.append(name,foot,error);
    return wrap;
  }
  function choiceField(id,label,options) {
    const wrap = node('label','ce-field');
    const select = node('select');
    select.setAttribute('aria-label',label);
    options.forEach(([value,caption]) => select.add(new Option(caption,value)));
    select.value = settings()[id] || '';
    select.onchange = () => { change(id,select.value); refresh(); };
    wrap.append(node('span','',label),select);
    return wrap;
  }
  function preview(social) {
    const card = node('div',social ? 'ce-seo-social-card' : 'ce-seo-search-card');
    card.setAttribute('aria-label',social ? 'Social sharing preview' : 'Search result preview');
    const image = node('img');
    image.loading = 'lazy';
    const title = node('strong'), path = node('span','ce-seo-url'), desc = node('p');
    const copy = node('div','ce-seo-snippet');
    if (social) card.append(image);
    copy.append(path,title,desc);
    card.append(copy);
    previews.push(effective => {
      title.textContent = social ? effective.socialTitle : effective.title;
      desc.textContent = social ? effective.socialDescription : effective.description;
      const url = effective.canonical ? new URL(effective.canonical,publicOrigin) : new URL(publicOrigin);
      path.textContent = social ? url.host : url.host + (url.pathname === '/' ? '' : url.pathname);
      if (social) {
        const src = thumbnail(effective.socialImage);
        if (src && image.getAttribute('src') !== src) image.src = src;
        if (!src) image.removeAttribute('src');
        image.hidden = !src;
        image.alt = effective.socialImageAlt || '';
      }
    });
    return card;
  }
  if (!privatePage) {
    const nav = node('div','seg ce-seo-tabs');
    nav.setAttribute('role','group');
    nav.setAttribute('aria-label','SEO settings');
    for (const [key,label] of Object.entries(panels)) {
      const b = node('button','',label);
      b.type = 'button';
      b.dataset.seoTab = key;
      b.setAttribute('aria-pressed',String(panel === key));
      b.onclick = () => selectSection(key);
      nav.append(b);
    }
    root.append(nav);
  }
  if (template && panel !== 'indexing') root.append(node('p','ce-help', (product ? 'Previewing ' + product.name + '. ' : '') + 'Use {product} to include each product’s name. Individual products can override this template.'));
  if (panel === 'search') {
    if (privatePage) root.append(node('p','ce-help','This private page stays out of search engines. You can edit its browser title and description.'));
    else root.append(preview(false),node('p','ce-help','This preview storefront is hidden from search engines.'));
    root.append(textField('title',privatePage ? 'Browser title' : 'Search title',{limit:150,hint:privatePage ? '' : 'aim for about 60'}),
      textField('description',privatePage ? 'Page description' : 'Search description',{limit:320,rows:3,hint:privatePage ? '' : 'aim for about 155'}));
  } else if (panel === 'social') {
    root.append(preview(true),textField('socialTitle','Sharing title',{limit:150}),textField('socialDescription','Sharing description',{limit:320,rows:3}),
      choiceField('socialImage','Sharing image',[['','Automatic image'],...photos]),textField('socialImageAlt','Image description',{limit:500}));
  } else {
    root.append(node('p','ce-seo-notice','Search engines are blocked across the preview storefront. Save the search visibility you want for launch.'),
      choiceField('robots','Search visibility at launch',[['',scope.startsWith('product:') ? 'Automatic · use product default' : 'Automatic · allow indexing'],['index','Allow indexing'],['noindex','Exclude from search']]));
    if (template) root.append(node('p','ce-help','Each product uses its own canonical address.'));
    else root.append(textField('canonical','Canonical address',{limit:2048}),node('p','ce-help','Set a different storefront page as the preferred address when pages have equivalent content.'));
  }
  refresh();
  return root;
}
