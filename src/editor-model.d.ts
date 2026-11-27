declare module "*consumer-preview/assets/editor-model.js" {
  export interface ConsumerEditorWidget {
    id: string;
    type: string;
    items?: string[];
    heading?: string;
    body?: string;
    alt?: string;
    label?: string;
    image?: string;
    href?: string;
    layout?: string;
  }
  export interface ConsumerEditorPage {
    title?: string;
    inNavigation?: boolean;
    theme?: string;
    meta?: {title?: string;description?: string};
    layout?: string;
    sectionLayouts?: Record<string,string>;
    sections?: string[];
    hidden?: string[];
    fields?: Record<string,string>;
    widgets?: ConsumerEditorWidget[];
  }
  export interface ConsumerEditorDocument {
    schema: 1;
    theme: string;
    pages: Record<string,ConsumerEditorPage>;
  }
  export const PAGES: Record<string,{ label:string; path:string; root:string; fields:Array<{id:string;label:string;kind:string;selector:string;default:string}>; sections:Array<{id:string;label:string;selector:string;locked?:boolean}> }>;
  export function emptyDocument(): ConsumerEditorDocument;
  export function validateDocument(value: unknown): ConsumerEditorDocument;
  export function referencedMedia(document: ConsumerEditorDocument): string[];
  export function pageForPath(path: string): string | null;
  export function customPageForKey(key: string, title?: string): {label:string; path:string; root:string; sections:unknown[]; fields:unknown[]} | null;
}
