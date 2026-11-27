import {PAGES, customPageForKey} from './editor-model.js';
import * as commerce from './editor-shop-widgets.js';
import {presentation} from './editor-presentation.js';

/** The admin keeps the complete editable field inventory. Shoppers receive only published fields. */
export function mountEditorCanvas(doc, {scope, document:design, onSelect = () => {}}) {
  return presentation(doc, scope, design, (key, current) =>
    Object.hasOwn(PAGES, key) ? PAGES[key] : customPageForKey(key, current.pages[key]?.title), onSelect, commerce);
}
