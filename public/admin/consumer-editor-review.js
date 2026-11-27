const widgetProperties = {
  heading: 'Heading', body: 'Text', image: 'Photo', alt: 'Photo description',
  label: 'Button text', href: 'Button destination', layout: 'Arrangement', items: 'Coffees in display order',
};
const arrangements = {stack: 'Stacked', split: 'Image left', reverse: 'Image right'};
const keys = (a, b) => new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
const numbered = labels => labels.map((label, index) => (index + 1) + '. ' + label).join('\n');
const equal = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b;

function effectiveWidgets(page, template) {
  return new Map([...(template.widgets || []), ...(page.widgets || [])].map(widget => [widget.id, widget]));
}
function sectionOrder(order, definition, widgets) {
  const available = new Set([...definition.sections.map(section => section.id), ...widgets.keys()]);
  return [...new Set([...(order || []), ...available])].filter(id => available.has(id));
}

// Compare the stored settings independently of object insertion order. Only visited fields and
// pages are involved, so one template change is reviewed once, under its template.
export function buildPublishReview(live, draft, {pages, themes, layouts, widgetTypes, coffees, media}) {
  const groups = [];
  const uploadNames = new Map(media.map(item => [item.id, item.name]));
  const coffeeNames = new Map(coffees.map(item => [item.id, item.name]));
  const photoName = reference => {
    if (!reference) return 'No photo';
    if (reference.startsWith('media:')) return uploadNames.get(reference.slice(6)) || 'Uploaded photo';
    return reference.replace(/^asset:/, '');
  };
  if (live.theme !== draft.theme) groups.push({scope: 'site', label: 'Storefront', changes: [
    {label: 'Storefront theme', before: themes[live.theme], after: themes[draft.theme]},
  ]});
  for (const scope of keys(live.pages, draft.pages)) {
    const old = live.pages[scope] || {}, next = draft.pages[scope] || {};
    const definition = pages[scope], changes = [];
    const product = scope.startsWith('product:');
    const priorTemplate = product ? live.pages.product || {} : {};
    const nextTemplate = product ? draft.pages.product || {} : {};
    const add = (label, before, after, more = {}) => changes.push({label, before, after, ...more});
    const setting = (label, a, b, format = value => value, fallbackA = 'Original', fallbackB = fallbackA) => {
      if (equal(a, b)) return;
      let before = a == null ? fallbackA : format(a), after = b == null ? fallbackB : format(b);
      if (before === after) {
        if (a == null) before = 'Inherited · ' + before;
        if (b == null) after = 'Inherited · ' + after;
      }
      add(label, before, after);
    };
    const photo = (label, a, b, inheritedA, inheritedB) => {
      if (a === b) return;
      const beforeImage = a ?? inheritedA ?? '', afterImage = b ?? inheritedB ?? '';
      add(label, photoName(beforeImage), photoName(afterImage), {beforeImage, afterImage});
    };
    if (scope.startsWith('custom:')) {
      if (!live.pages[scope] || !draft.pages[scope]) {
        add('Page', live.pages[scope] ? definition.path : 'No page', draft.pages[scope] ? definition.path : 'No page');
      }
      setting('Page name', old.title, next.title, undefined, 'No page');
      setting('Explore footer link', Boolean(old.inNavigation), Boolean(next.inNavigation), value => value ? 'Shown' : 'Hidden');
    }
    setting('Page theme', old.theme, next.theme, value => themes[value],
      'Inherited · ' + themes[priorTemplate.theme || live.theme], 'Inherited · ' + themes[nextTemplate.theme || draft.theme]);
    setting('Page width', old.layout, next.layout, value => layouts[value], layouts[priorTemplate.layout || 'standard'], layouts[nextTemplate.layout || 'standard']);
    for (const [key, label] of [['title', 'Browser title'], ['description', 'Search description']]) {
      setting(label, old.meta?.[key], next.meta?.[key], undefined, priorTemplate.meta?.[key] || 'Original page ' + key, nextTemplate.meta?.[key] || 'Original page ' + key);
    }
    for (const field of definition.fields) {
      const a = old.fields?.[field.id], b = next.fields?.[field.id];
      const defaultA = priorTemplate.fields?.[field.id] ?? field.default ?? '', defaultB = nextTemplate.fields?.[field.id] ?? field.default ?? '';
      if (field.kind === 'image') photo(field.label, a, b, defaultA, defaultB);
      else setting(field.label, a, b, undefined, defaultA, defaultB);
    }
    const oldWidgets = effectiveWidgets(old, priorTemplate);
    const newWidgets = effectiveWidgets(next, nextTemplate);
    const ownWidgetIds = new Set([...(old.widgets || []), ...(next.widgets || [])].map(widget => widget.id));
    const sectionNames = new Map(definition.sections.map(section => [section.id, section.label]));
    const widgetName = widget => widgetTypes[widget.type] + (widget.heading ? ' · ' + widget.heading : '');
    const namedIds = new Map();
    for (const widget of [...oldWidgets.values(), ...newWidgets.values()]) {
      const name = widgetName(widget);
      if (!namedIds.has(name)) namedIds.set(name, new Set());
      namedIds.get(name).add(widget.id);
    }
    const identifyWidget = widget => {
      const name = widgetName(widget), ids = namedIds.get(name);
      return ids.size > 1 ? name + ' (' + ([...ids].indexOf(widget.id) + 1) + ')' : name;
    };
    const sectionName = (id, widgets) => sectionNames.get(id) || identifyWidget(widgets.get(id));
    for (const {id, label} of definition.sections) {
      if (!equal(old.hidden, next.hidden)) {
        const hiddenA = (old.hidden ?? priorTemplate.hidden ?? []).includes(id);
        const hiddenB = (next.hidden ?? nextTemplate.hidden ?? []).includes(id);
        setting(label + ' · Visibility', hiddenA, hiddenB, value => value ? 'Hidden' : 'Shown');
      }
      setting(label + ' · Width', old.sectionLayouts?.[id], next.sectionLayouts?.[id], value => layouts[value],
        layouts[priorTemplate.sectionLayouts?.[id] || 'standard'], layouts[nextTemplate.sectionLayouts?.[id] || 'standard']);
    }
    const oldOrder = sectionOrder(old.sections ?? priorTemplate.sections, definition, oldWidgets);
    const newOrder = sectionOrder(next.sections ?? nextTemplate.sections, definition, newWidgets);
    if ((!equal(old.sections, next.sections) || ownWidgetIds.size) && !equal(oldOrder, newOrder)) {
      add('Section order', numbered(oldOrder.map(id => sectionName(id, oldWidgets))) || 'No sections',
        numbered(newOrder.map(id => sectionName(id, newWidgets))) || 'No sections');
    }
    for (const id of ownWidgetIds) {
      const a = oldWidgets.get(id), b = newWidgets.get(id);
      const name = identifyWidget(b || a);
      if (a?.type !== b?.type) add(name, a ? widgetTypes[a.type] : 'No widget', b ? widgetTypes[b.type] : 'No widget');
      for (const [key, label] of Object.entries(widgetProperties)) {
        const fieldLabel = name + ' · ' + label;
        if (key === 'image') photo(fieldLabel, a?.image, b?.image);
        else if (key === 'items') {
          const shelfItems = widget => widget?.type === 'coffee-shelf' ? widget.items || ['bom-jesus', 'rocko', 'anserma'] : [];
          setting(fieldLabel, shelfItems(a), shelfItems(b), items => numbered(items.map(coffee => coffeeNames.get(coffee) || coffee)) || 'None');
        } else if (key === 'layout') {
          setting(fieldLabel, a?.layout || 'stack', b?.layout || 'stack', value => arrangements[value]);
        } else setting(fieldLabel, a?.[key], b?.[key], undefined, '');
      }
    }
    if (changes.length) groups.push({scope, label: definition.label, changes});
  }
  return groups;
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function comparisonValue(value, photo, imageUrl) {
  const cell = node('dd');
  if (photo) {
    const src = imageUrl(photo);
    if (src) {
      const img = node('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = src;
      cell.append(img);
    }
  }
  if (value.length > 220 || value.split('\n').length > 5) {
    const details = node('details', 'ce-review-long');
    details.append(node('summary', '', 'Read full value'), node('span', '', value));
    cell.append(node('span', '', value.slice(0, 160).split('\n').slice(0, 3).join('\n') + '…'), details);
  } else cell.append(node('span', '', value || 'Empty'));
  return cell;
}

export function renderPublishReview(groups, imageUrl) {
  const root = node('section', 'ce-review');
  root.setAttribute('aria-label', 'Publication changes');
  if (!groups.length) {
    root.append(node('p', '', 'The draft and published storefront have the same visible settings.'));
    return root;
  }
  const total = groups.reduce((sum, group) => sum + group.changes.length, 0);
  root.append(node('p', 'ce-review-count', total + (total === 1 ? ' change' : ' changes') + ' across ' + groups.length + (groups.length === 1 ? ' area' : ' areas')));
  for (const {label, changes} of groups) {
    const panel = node('details', 'ce-review-group');
    const summary = node('summary');
    summary.append(node('span', '', label), node('span', 'ce-review-badge', String(changes.length)));
    panel.append(summary);
    function populate() {
      if (!panel.open || panel.children.length > 1) return;
      const list = node('ul', 'ce-review-list'), more = node('button', 'btn soft sm');
      more.type = 'button';
      let shown = 0;
      function showBatch(focus) {
        const batch = changes.slice(shown, shown + 6);
        let first;
        for (const {label, before, after, beforeImage, afterImage} of batch) {
          const item = node('li'), heading = node('strong', 'ce-review-label', label), values = node('dl');
          first ||= heading;
          for (const [caption, value, photo] of [['Published', before, beforeImage], ['Draft', after, afterImage]]) {
            const pair = node('div');
            pair.append(node('dt', '', caption), comparisonValue(value, photo, imageUrl));
            values.append(pair);
          }
          item.append(heading, values);
          list.append(item);
        }
        shown += batch.length;
        const left = changes.length - shown;
        if (left) more.textContent = 'Show ' + Math.min(left, 6) + ' more ' + (Math.min(left, 6) === 1 ? 'change' : 'changes');
        else more.remove();
        if (focus && first) { first.tabIndex = -1; first.focus(); }
      }
      more.addEventListener('click', () => showBatch(true));
      panel.append(list, more);
      showBatch(false);
    }
    panel.addEventListener('toggle', populate);
    panel.open = groups.length === 1;
    populate();
    root.append(panel);
  }
  return root;
}
