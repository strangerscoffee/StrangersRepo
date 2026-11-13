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
  /** The bag sizes it's sold in, when only one ("quarter" 250 g or "kilo" 1 kg). Absent: both. */
  packs?: ("quarter" | "kilo")[];
  /** White label: the businesses (customer ids) this coffee is private to (src/wholesaleWhiteLabel.ts). */
  whiteLabel?: string[];
  /** What it's made from, for staff: coffees or named components with whole percentages adding to 100. */
  recipe?: { coffee?: string; name: string; percent: number }[];
}
export const products: SourceCoffee[];
export const catalogueRetrievedAt: string;
