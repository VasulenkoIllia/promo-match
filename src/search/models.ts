// The embedding models the search knows (stage 4, docs/integrations.md, «Пошук»). Each has HNSW indexes of its own,
// partial on its name and over halfvec of its dimension (migrations *_search_index_*): the search writes the same name
// and cast into its SQL as literals, from this list only, so the planner can match the index (src/search/store.ts).
import type { ProviderCode } from "../embeddings/provider.js";

// isOnScreen: the web screen offers it (GET /api/search/options). Voyage has the vectors of Axpol and Midocean alone
// (2026-11-04), so on the screen it would search 42% of the catalogue without a word; the API, the CLI and the quality
// test still take it (owner's decision 2026-11-06).
export const SEARCH_MODELS = {
  "gemini-embedding-2/1536": { provider: "gemini", dimensions: 1536, isOnScreen: true },
  "voyage-multimodal-3.5/1024": { provider: "voyage", dimensions: 1024, isOnScreen: false },
} as const satisfies Record<string, { provider: ProviderCode; dimensions: number; isOnScreen: boolean }>;

export type SearchModelName = keyof typeof SEARCH_MODELS;

// The provider chosen on the sample (docs/decisions.md, 2026-10-29); Voyage stays for the quality test of stage 8
export const DEFAULT_SEARCH_MODEL: SearchModelName = "gemini-embedding-2/1536";

export const SEARCH_MODEL_NAMES = Object.keys(SEARCH_MODELS) as SearchModelName[];

export function isSearchModelName(value: string): value is SearchModelName {
  return Object.hasOwn(SEARCH_MODELS, value);
}

// Model texts of a candidate shape, embedded by a search model and kept beside its own under a name of their own, for
// the independent test only (README «Незалежний тест»): the screen never reads them. The name ends in the dimension, as
// the database checks. No HNSW index covers them: a text list ranks every text while the catalogue has fewer than
// EXACT_MAX_ROWS (src/search/store.ts), and past it such a list is slow, not wrong. brand-free: the name without its
// brand words (src/embeddings/brand-words.ts).
export const TEXT_VARIANTS = {
  "gemini-embedding-2-brand-free/1536": { model: "gemini-embedding-2/1536" },
} as const satisfies Record<string, { model: SearchModelName }>;

export type TextVariantName = keyof typeof TEXT_VARIANTS;

export const BRAND_FREE_TEXTS: TextVariantName = "gemini-embedding-2-brand-free/1536";

export function isTextVariantName(value: string): value is TextVariantName {
  return Object.hasOwn(TEXT_VARIANTS, value);
}
