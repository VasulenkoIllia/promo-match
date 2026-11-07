// The answer of a search (stage 4): the fused models, best first, each with its supplier, category, the photos that
// matched (or its cover when only its text did) and its active variants with stock and the primary price. Prices are
// purchase prices in the supplier's currency (confidential: never in logs, git or dumps).
import { supplierPageUrl } from "../suppliers/page-url.js";
import type { ConditionMatch } from "./conditions.js";
import { type Confidence, confidenceOf, type MeasuredQuery } from "./confidence.js";
import type { FusedModel, ListName } from "./rank.js";
import type { ModelRow, PhotoRow, VariantRow } from "./store.js";

export interface ResultPhoto {
  id: number | null;
  url: string;
  urlLarge: string | null;
  // null for the cover of a model found by its text only
  similarity: number | null;
  // The variants the photo shows
  skus: string[];
}

export interface ResultVariant {
  sku: string;
  color: string | null;
  size: string | null;
  // null: the supplier gave no stock for it
  inStock: number | null;
  nextArrival: { date: string | null; quantity: number | null } | null;
  price: { amount: string; currency: string } | null;
}

export interface SearchResult {
  rank: number;
  score: number;
  lists: Partial<Record<ListName, { rank: number; similarity: number }>>;
  // The code the text named it by, as written; null: found by the lists alone
  matchedCode: string | null;
  // How many models of the results that code named, this one too: over 1 for a code several suppliers share; null
  // without a code
  matchedCodeModels: number | null;
  // What the catalogue says of each condition of the query's product that found it (src/search/conditions.ts); null:
  // that product has no conditions, or only a code found it
  conditionMatch: ConditionMatch | null;
  // src/search/confidence.ts; null: nothing was measured for such a search
  confidence: Confidence | null;
  modelId: number;
  source: { code: string; name: string };
  code: string;
  name: string | null;
  category: string[];
  // The model's page on its supplier's site (src/suppliers/page-url.ts); null: none can be named
  pageUrl: string | null;
  photos: ResultPhoto[];
  variants: ResultVariant[];
}

// The variant a code named, or one in stock: Axpol takes a variant that ran out off its site
function pagedVariant(rows: VariantRow[], matchedCode: string | undefined): VariantRow | undefined {
  const sku = matchedCode?.toLowerCase();
  return rows.find((row) => row.sku.toLowerCase() === sku) ?? rows.find((row) => row.inStock) ?? rows[0];
}

function variantOf(row: VariantRow): ResultVariant {
  const hasArrival = row.nextArrivalDate !== null || row.nextArrivalQuantity !== null;
  return {
    sku: row.sku,
    color: row.color,
    size: row.size,
    inStock: row.inStock,
    nextArrival: hasArrival ? { date: row.nextArrivalDate, quantity: row.nextArrivalQuantity } : null,
    price: row.price !== null && row.currency !== null ? { amount: row.price, currency: row.currency } : null,
  };
}

export function categoryOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

// A model an import deactivated between the reads is left out (src/search/store.ts, readModels)
export function assembleResults(fused: FusedModel[], models: ModelRow[], variants: VariantRow[], photos: PhotoRow[],
  matches: Map<number, ConditionMatch>, query: MeasuredQuery): SearchResult[] {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  const variantsByModel = new Map<number, VariantRow[]>();
  for (const row of variants) {
    const list = variantsByModel.get(row.modelId) ?? [];
    list.push(row);
    variantsByModel.set(row.modelId, list);
  }
  const results: SearchResult[] = [];
  for (const entry of fused) {
    const model = modelById.get(entry.modelId);
    if (!model) continue;
    const matched = entry.photos.flatMap((match): ResultPhoto[] => {
      const photo = photoById.get(match.photoId);
      return photo ? [{ id: photo.id, url: photo.url, urlLarge: photo.urlLarge, similarity: match.similarity, skus: photo.skus }] : [];
    });
    const cover: ResultPhoto[] = model.coverPhotoUrl
      ? [{ id: null, url: model.coverPhotoUrl, urlLarge: null, similarity: null, skus: [] }] : [];
    const rows = variantsByModel.get(model.id) ?? [];
    const paged = pagedVariant(rows, entry.matchedCode);
    const found = {
      rank: results.length + 1, lists: entry.lists, matchedCode: entry.matchedCode ?? null,
      matchedCodeModels: entry.matchedCode === undefined ? null : entry.matchedCodeModels ?? 1, conditionMatch: matches.get(model.id) ?? null,
    };
    results.push({
      ...found,
      score: entry.score,
      confidence: confidenceOf(found, query),
      modelId: model.id,
      source: { code: model.sourceCode, name: model.sourceName },
      code: model.code,
      name: model.name,
      category: categoryOf(model.category),
      pageUrl: paged ? supplierPageUrl(model.sourceCode, paged) : null,
      photos: matched.length ? matched : cover,
      variants: rows.map(variantOf),
    });
  }
  return results;
}
