export interface SourceCoffee {
  id: string;
  origin: string;
  name: string;
  title: string;
  process: string;
  notes: string;
  badge: string;
  categories: string[];
  price: number;
  prices: { quarter: number; kilo: number };
  image: string;
  sourceUrl: string;
  sourceImage: string;
  sourceUpdatedAt: number;
  /** Packaging colours set in Admin (1–2 #RRGGBB); none means the built-in packaging or automatic colour. */
  colours?: string[];
  colourStyle?: "solid" | "striped";
}
export const products: SourceCoffee[];
export const catalogueRetrievedAt: string;
