// What every supplier adapter gives the import: one full catalogue snapshot in the shared model
// (docs/requirements.md, «Дані й обсяги»), the raw records apart for debugging. One module per supplier.
import type { PrintFact } from "./printing.js";

// Text by language code: { en: "Bamboo pen", pl: "Bambusowy długopis" }
export type Localized = Record<string, string>;

export type SourceKind = "supplier" | "competitor";
export type PriceKind = "net" | "catalog" | "final";

export interface SourceInfo {
  code: string;
  name: string;
  kind: SourceKind;
}

// A photo of a model, shown for the variants that list it (Midocean: one picture for all sizes of a colour)
export interface PhotoInput {
  url: string;
  // A larger file of the same picture (Midocean's url_highress)
  urlLarge: string | null;
  // The supplier's name for the view (Midocean's item_picture_front, _back...)
  kind: string | null;
  // Order within the model, as the supplier lists the pictures
  position: number;
  variantLinks: { sku: string; position: number }[];
}

export interface PriceInput {
  kind: PriceKind;
  // ISO 4217
  currency: string;
  // From this quantity on (Midocean's price scale); 1 for the base price
  minQuantity: number;
  // Decimal as text, never a float
  amount: string;
  // The price for filters and the result grid: one per variant
  isPrimary: boolean;
  validUntil: string | null;
}

export interface ArrivalInput {
  date: string | null;
  quantity: number | null;
}

export interface StockInput {
  inStock: number;
  reserved: number | null;
  onOrder: number | null;
  nextArrivalQuantity: number | null;
  nextArrivalDate: string | null;
  // Delivery time as the supplier writes it (Axpol's Days "2-3")
  leadTime: string | null;
  arrivals: ArrivalInput[];
  sourceUpdatedAt: string | null;
}

export interface VariantInput {
  sku: string;
  externalId: string | null;
  ean: string | null;
  color: Localized;
  colorCode: string | null;
  colorGroup: string | null;
  size: string | null;
  status: string | null;
  printing: unknown;
  attributes: Record<string, unknown>;
  prices: PriceInput[];
  stock: StockInput | null;
}

// What only some suppliers give for the shared parser (src/suppliers/specs.ts), as they give it. An adapter reads
// nothing out of these fields: the capacity, materials and size mean the same for every source.
export interface SpecFields {
  // The capacity from a field of its own, with its unit: "1000 ml"
  volume: string | null;
  // English texts besides the name and the description, the most specific first
  texts: string[];
}

export interface ModelInput {
  code: string;
  externalId: string | null;
  name: Localized;
  description: Localized;
  // The supplier's own category path by language: { en: ["WRITINGS", "touch pens"] }
  category: Record<string, string[]>;
  categoryCode: string | null;
  material: Localized;
  brand: string | null;
  dimensions: string | null;
  specFields: SpecFields;
  weightGrams: string | null;
  countryOfOrigin: string | null;
  printing: unknown;
  // printing on the shared list: an adapter reads this one itself, a supplier's codes mean nothing to another
  printTechniques: PrintFact[];
  attributes: Record<string, unknown>;
  photos: PhotoInput[];
  variants: VariantInput[];
}

export interface PrintTechniqueInput {
  code: string;
  name: Localized;
}

export interface RawInput {
  feed: string;
  externalId: string;
  payload: unknown;
}

export interface CatalogSnapshot {
  models: ModelInput[];
  techniques: PrintTechniqueInput[];
  raw: RawInput[];
  // Every feed read to its end: only then may the import mark what is missing as inactive
  isComplete: boolean;
  // Records read per feed
  fetched: Record<string, number>;
  // Data checks for the report: name -> count, with a few codes as examples
  checks: Record<string, number>;
  examples: Record<string, string[]>;
  warnings: string[];
}

// What a normalizer builds from the feeds; whether they were read to the end is the adapter's to say
export type NormalizedCatalog = Omit<CatalogSnapshot, "isComplete">;

export interface FetchContext {
  signal: AbortSignal;
  log: (line: string) => void;
  // Grows by tokens and links met on the way, so logs and errors are scrubbed of them
  secrets: string[];
}

export interface SupplierAdapter {
  source: SourceInfo;
  fetchCatalog(context: FetchContext): Promise<CatalogSnapshot>;
  // Small read-only requests that find the API's limits; their findings go to docs/integrations.md
  probe(context: FetchContext): Promise<void>;
}
