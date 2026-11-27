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
    meta?: {
      title?: string;
      description?: string;
      canonical?: string;
      socialTitle?: string;
      socialDescription?: string;
      socialImage?: string;
      socialImageAlt?: string;
      robots?: "index" | "noindex";
    };
    layout?: string;
    sectionLayouts?: Record<string,string>;
    sectionStyles?: Record<string,Record<string,string>>;
    mobile?: { sections?: string[]; sectionStyles?: Record<string,Record<string,string>> };
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
  export interface ConsumerEditorField {
    id: string;
    label: string;
    kind: string;
    selector: string;
    default: string;
    inline?: import("../public/consumer-preview/assets/editor-text.js").InlinePart[];
  }
  export const PAGES: Record<string,{ label:string; path:string; root:string; fields: ConsumerEditorField[]; sections:Array<{id:string;label:string;selector:string;locked?:boolean}> }>;
  export function emptyDocument(): ConsumerEditorDocument;
  export function validateDocument(value: unknown): ConsumerEditorDocument;
  export function validateLayoutChanges(previous: ConsumerEditorDocument, next: ConsumerEditorDocument): void;
  export function referencedMedia(document: ConsumerEditorDocument): string[];
  export function pageForPath(path: string): string | null;
  export function cataloguePageForKey(key: string, product?: {id: string; name: string} | null): (typeof PAGES)[string] | null;
  export function customPageForKey(key: string, title?: string): {label:string; path:string; root:string; sections:unknown[]; fields:unknown[]} | null;
}

declare module "*consumer-preview/assets/editor-text.js" {
  export type InlinePart = string | ["em" | "strong" | "b" | "i" | "br", ...InlinePart[]];
  export function formattedText(template: InlinePart[], value: string): InlinePart[];
}

declare module "*consumer-preview/assets/editor-layout.js" {
  type Page = import("../public/consumer-preview/assets/editor-model.js").ConsumerEditorPage;
  export function sectionStylesheet(page?:Page,template?:Page): string;
}

declare module "*consumer-preview/assets/editor-seo.js" {
  interface PageSeo {
    publicPage: boolean;
    title: string;
    description: string;
    url: string;
    canonical: string;
    socialTitle: string;
    socialDescription: string;
    socialImage: string;
    socialImageAlt: string;
    robots: string;
    launchRobots: string;
    product?: {name: string; sku: string; description: string; image: string};
  }
  export function resolvePageSeo(scope: string, options: {
    pages: Record<string, import("../public/consumer-preview/assets/editor-model.js").ConsumerEditorPage>;
    product?: {id:string; name:string};
    origin?: string;
    allowIndexing?: boolean;
  }): PageSeo;
}
