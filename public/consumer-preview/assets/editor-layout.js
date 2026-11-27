// These storefront presets are shared by the admin controls, document validation
// and first-paint styles. No selector, CSS value or breakpoint comes from input.
export const MOBILE_QUERY = '(max-width: 760px)';
export const SECTION_STYLES = {
  width: {standard:'Standard', compact:'Compact', wide:'Wide'},
  spacing: {tight:'Tight', regular:'Regular', airy:'Airy'},
  align: {start:'Start', center:'Centre', end:'End'},
  crop: {landscape:'Landscape', square:'Square', portrait:'Portrait'},
  stack: {'image-first':'Photo above text', 'text-first':'Text above photo'},
  arrangement: {stack:'Photo above text','text-first':'Text above photo',split:'Image left',reverse:'Image right'},
};

function sharedStyle(page, id) {
  return {...page?.sectionStyles?.[id], ...(page?.sectionLayouts?.[id] ? {width:page.sectionLayouts[id]} : {})};
}
export function effectiveStyle(page, template, id, mobile = false) {
  const common = {...sharedStyle(template,id), ...sharedStyle(page,id)};
  if (common.arrangement) {
    // A product-specific arrangement replaces both axes of the template's
    // arrangement. Individual mobile stacking preferences still layer on top.
    delete common.stack;
    if (common.arrangement === 'text-first') common.stack = 'text-first';
  }
  return {...common, ...(mobile && template?.mobile?.sectionStyles?.[id]), ...(mobile && page?.mobile?.sectionStyles?.[id])};
}

function sorted(ids, order) {
  const available = new Set(ids);
  return [...new Set([...(order || []).filter(id => available.has(id)), ...ids])];
}
// Complete a partial mobile order inside each editable band. Newly inserted
// sections keep their shared side of locked account, checkout and catalogue UI.
export function orderedSections(def, page = {}, template = {}, mobile = false) {
  const ids = [...def.sections.map(section => section.id), ...(template.widgets || []).map(w => w.id), ...(page.widgets || []).map(w => w.id)];
  const base = sorted(ids,page.sections ?? template.sections);
  const mobileOrder = page.mobile?.sections ?? template.mobile?.sections;
  if (!mobile || !mobileOrder?.length) return base;
  const locked = new Set(def.sections.filter(item => item.locked).map(item => item.id));
  const result = [];
  let band = [];
  for (const id of base) {
    if (!locked.has(id)) { band.push(id); continue; }
    result.push(...sorted(band,mobileOrder), id);
    band = [];
  }
  return result.concat(sorted(band,mobileOrder));
}

// A change can insert/delete widgets, but every previously present entry
// must stay on the same side of each locked native element.
export function crossesLockedSection(before, after, def) {
  for (const section of def.sections) {
    if (!section.locked) continue;
    const oldPosition = before.indexOf(section.id), newPosition = after.indexOf(section.id);
    if (oldPosition < 0 || newPosition < 0) continue;
    const oldLeft = new Set(before.slice(0,oldPosition));
    for (const [index,id] of after.entries()) {
      if (id !== section.id && before.includes(id) && oldLeft.has(id) !== (index < newPosition)) return true;
    }
  }
  return false;
}

const pairedSections = [
  {shell:'.home-hero', frame:'', photo:'> .home-hero-image', copy:'> .home-hero-copy'},
  {shell:'.editorial-masthead', frame:'', photo:'> .editorial-masthead-image', copy:'> .editorial-masthead-copy'},
  {shell:'.home-section', frame:'> .home-roastery', photo:'> img', copy:'> .home-roastery-copy'},
  {shell:'.consumer-widget', frame:'', photo:'> img', copy:'> .consumer-widget-copy'},
];
export function sectionCapabilities(node) {
  if (!node) return [];
  const result = ['width','spacing'];
  if (node.querySelector('h1,h2,h3,p,nav,a')) result.push('align');
  const pair = pairedSections.find(item => node.matches(item.shell));
  const frame = pair?.frame ? node.querySelector(':scope '+pair.frame) : node;
  if (frame && pair && frame.querySelector(':scope '+pair.photo)) {
    result.push('crop');
    if (frame.querySelector(':scope '+pair.copy)) result.push('stack');
  }
  return result;
}

const gaps = {tight:'.5rem',regular:'1.25rem',airy:'2.5rem'};
const ratios = {landscape:'3 / 2',square:'1 / 1',portrait:'4 / 5'};
function rulesFor(id, style, mobileWidth = false) {
  // The store validates IDs, and this also protects stylesheet creation while
  // an unsaved draft is open in the admin. Values below are fixed presets.
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return '';
  const node = '[data-consumer-layout-id="' + id + '"]';
  const rules = [];
  const rule = (selector,body) => rules.push(selector+'{'+body+'}');
  if (style.width === 'compact') rule(node,(mobileWidth ? 'width:calc(100% - 2 * var(--gap) - 1rem)!important;' : '')+'max-width:62rem!important;margin-inline:auto');
  if (style.width === 'wide') rule(node,'width:calc(100% - '+(mobileWidth ? '' : '2 * ')+'var(--gap))!important;max-width:110rem!important;margin-inline:auto');
  if (Object.hasOwn(gaps,style.spacing)) {
    const gap = gaps[style.spacing];
    rule(node,'margin-block-end:'+gap+'!important');
    rule(node+':is(.home-section,.consumer-widget)','margin-block-start:'+gap+'!important');
    rule(node+'.home-section','padding-block-start:0');
    rule(node+' > .consumer-widget-copy, '+node+' > .home-section-head','row-gap:'+gap+';margin-block-end:'+gap);
    rule(node+' > img + .consumer-widget-copy','margin-block-start:'+gap);
  }
  if (Object.hasOwn(SECTION_STYLES.align,style.align)) {
    const align = style.align;
    rule(node,'text-align:'+align);
    rule(node+' :is(.consumer-widget-copy,.home-hero-copy,.editorial-masthead-copy,.home-roastery-copy)','justify-items:'+align+';text-align:'+align);
    rule(node+' :is(.home-hero-actions,.home-roastery-actions)','justify-content:'+align);
    if (align !== 'start') rule(node+' :is(.consumer-widget-copy,.home-hero-copy,.editorial-masthead-copy,.home-roastery-copy) > :is(p,h1,h2,h3)',
      align === 'center' ? 'margin-inline:auto' : 'margin-inline-start:auto;margin-inline-end:0');
  }
  const crop = Object.hasOwn(ratios,style.crop) && ratios[style.crop];
  const stack = Object.hasOwn(SECTION_STYLES.stack,style.stack);
  if (crop || stack) for (const pair of pairedSections) {
    const frame = node + pair.shell + (pair.frame ? ' '+pair.frame : '');
    const photo = frame + ' ' + pair.photo;
    if (crop) {
      rule(photo,'width:100%;height:auto!important;min-height:0!important;max-height:none!important;aspect-ratio:'+crop+'!important;object-fit:cover;align-self:center;overflow:hidden');
      rule(photo+' > img','width:100%;height:100%;object-fit:cover');
    }
    if (stack) {
      rule(frame,'display:grid;grid-template-columns:minmax(0,1fr)!important');
      rule(photo,'order:'+(style.stack === 'image-first' ? '-1' : '1')+'!important');
      rule(frame+' '+pair.copy,'order:0');
      // The wide home hero normally takes its height from its adjacent copy.
      if (!crop && pair.shell === '.home-hero') rule(photo,'width:100%;aspect-ratio:3 / 2');
    }
  }
  return rules.join('\n');
}

export function sectionStylesheet(page = {}, template = {}) {
  const styleIds = new Set([template,page].flatMap(entry =>
    [...Object.keys(entry.sectionStyles || {}), ...Object.keys(entry.mobile?.sectionStyles || {}), ...Object.keys(entry.sectionLayouts || {})]));
  const rules = [];
  for (const id of styleIds) {
    const common = effectiveStyle(page,template,id);
    const mobile = effectiveStyle(page,template,id,true);
    const desktopRules = rulesFor(id,common);
    const mobileWidth = page.mobile?.sectionStyles?.[id]?.width ?? template.mobile?.sectionStyles?.[id]?.width;
    const mobileRules = rulesFor(id,mobile,Boolean(mobileWidth));
    if (desktopRules === mobileRules) rules.push(desktopRules);
    else {
      if (desktopRules) rules.push('@media not all and (max-width: 760px){'+desktopRules+'}');
      if (mobileRules) rules.push('@media '+MOBILE_QUERY+'{'+mobileRules+'}');
    }
  }
  return rules.filter(Boolean).join('\n');
}
