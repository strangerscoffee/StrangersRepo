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
}
export const products: SourceCoffee[];
export const catalogueRetrievedAt: string;
