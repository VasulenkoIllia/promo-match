// What the reading of a query moves on the ranking. The defaults went through the held set of 2026-10-31 together, not
// one by one (docs/decisions.md); a run of the independent test may set another, null is off. None of these knows a source.
export interface SearchTuning {
  // The factor on the fused score of a model in a category the reader suggests for a text; null is off
  textCategoryLift: number | null;
  // The factor on a model with a variant of the colour the query asks (src/search/traits.ts); null is off
  colorLift: number | null;
  // The factor on a model that is what the query rules out, under 1; null is off
  exclusionFactor: number | null;
}

export const DEFAULT_TUNING: SearchTuning = { textCategoryLift: 1.1, colorLift: 1.1, exclusionFactor: 0.5 };

export function tuningOf({ tuning }: { tuning?: Partial<SearchTuning> }): SearchTuning {
  return { ...DEFAULT_TUNING, ...tuning };
}
