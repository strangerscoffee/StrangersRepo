import {SECTION_STYLES, effectiveStyle, sectionCapabilities} from '/api/admin/consumer/editor/assets/editor-layout.js';

const labels = {
  width:'Section width', spacing:'Spacing', align:'Text alignment', crop:'Photo crop', stack:'Photo position',
};
const arrangements = Object.entries(SECTION_STYLES.arrangement);

function layoutValue(page, path) {
  return path.reduce((record, key) => record?.[key], page);
}

// Deleting the last override must restore actual inheritance. Empty style
// objects would otherwise show up as unsaved changes after resetting a field.
function storeLayoutValue(pages, scope, path, value) {
  const keys = [scope, ...path];
  if (value === undefined) {
    const remove = (record, depth) => {
      const key = keys[depth];
      if (!record || !Object.hasOwn(record,key)) return;
      if (depth === keys.length - 1) delete record[key];
      else {
        remove(record[key], depth + 1);
        if (!Object.keys(record[key]).length) delete record[key];
      }
    };
    remove(pages,0);
    return;
  }
  let current = pages;
  for (const key of keys.slice(0,-1)) current = current[key] ||= {};
  current[keys.at(-1)] = value;
}

export function responsiveFields({pages, scope, id, node, widget, mobile}) {
  const page = pages[scope];
  const template = scope.startsWith('product:') ? pages.product : undefined;
  const keys = node ? sectionCapabilities(node) : ['width','spacing','align'];
  const shared = effectiveStyle(page || {},template || {},id,false);
  const fields = [];
  const widgetArrangement = !mobile && widget && keys.includes('stack');
  if (widgetArrangement) {
    const original = widget.layout, stackPath = ['sectionStyles',id,'stack'];
    const initialStack = layoutValue(page,stackPath);
    const shown = shared.stack === 'text-first' ? 'text-first' : shared.stack === 'image-first' ? 'stack' : original || 'stack';
    const field = {id:'layout', label:'Widget arrangement', kind:'choice', sectionStyle:true};
    if (template?.widgets?.some(item => item.id === id)) {
      const path = ['sectionStyles',id,'arrangement'];
      const own = layoutValue(page,path);
      fields.push({...field, choices:[['','Use template'],...arrangements], value:own ?? '',
        set:(value,revert) => storeLayoutValue(pages,scope,path,revert ? own : value || undefined)});
    } else {
      fields.push({...field, choices:arrangements, value:shown, set:(value,revert) => {
          const layout = revert ? original : value === 'text-first' ? 'stack' : value;
          if (layout === undefined) delete widget.layout;
          else widget.layout = layout;
          storeLayoutValue(pages,scope,stackPath,revert ? initialStack : value === 'text-first' ? 'text-first' : undefined);
        }});
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(labels,key) || (widgetArrangement && key === 'stack')) continue;
    const legacyWidth = !mobile && !widget && key === 'width';
    const stored = legacyWidth ? ['sectionLayouts',id] : ['sectionStyles',id,key];
    const path = mobile ? ['mobile',...stored] : stored;
    const original = layoutValue(page,path);
    const fromTemplate = layoutValue(template,path);
    const fallback = mobile ? fromTemplate ?? shared[key] : fromTemplate;
    const options = SECTION_STYLES[key];
    const inheritFrom = fromTemplate !== undefined ? 'Template' : mobile ? 'All sizes' : 'Site default';
    const inheritLabel = fallback && options[fallback] ? inheritFrom + ' · ' + options[fallback] : inheritFrom;
    fields.push({
      id:key, label:labels[key], kind:'choice', sectionStyle:true,
      value:original ?? (legacyWidth ? fallback || 'standard' : ''),
      choices:[['',inheritLabel], ...Object.entries(options)],
      set:(value,revert) => storeLayoutValue(pages,scope,path,revert ? original : value || undefined),
    });
  }
  return fields;
}
