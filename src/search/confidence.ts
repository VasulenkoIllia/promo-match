// How sure the search is of one result (README «Впевненість»): the share of such results a judge called exactly what was
// asked, grade 3 of output/quality/rounds/judge.md. Fit on 4355 pairs of the 148 frozen queries: every top 10, and a blind
// sample below it, since only a pair that made some top 10 had a grade before. The grades are the agents': no person has
// checked this. It is an estimate for a group, no promise for one product. It moves nothing, and a supplier is not in it,
// so it cannot favour one.
import type { ConditionMatch, Match } from "./conditions.js";
import type { SearchModelName } from "./models.js";
import type { QueryParse } from "./query-parse.js";
import type { ListName } from "./rank.js";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  percent: number;
  level: ConfidenceLevel;
}

export interface MeasuredQuery {
  model: SearchModelName;
  // false: a text went without Claude's reading, and the texts compared were not the ones measured
  isRead: boolean;
  // false: a photo alone found it, with no text to compare
  isByText: boolean;
  isLong: boolean;
  hasCloseMatch: boolean | null;
}

export interface Found {
  rank: number;
  lists: Partial<Record<ListName, { similarity: number }>>;
  matchedCode: string | null;
  // How many models of the results the code named, this one too
  matchedCodeModels: number | null;
  conditionMatch: ConditionMatch | null;
}

// A similarity holds for its embedding model alone, and only this one was measured
const MEASURED_MODEL: SearchModelName = "gemini-embedding-2/1536";
const PERCENT_STEP = 5;
const HIGH_FROM_PERCENT = 75;
const MEDIUM_FROM_PERCENT = 45;
const FEWEST_PERCENT = 5;
const MOST_PERCENT = 95;
// Named by its code: that it is this model is a fact, not an estimate. A code N suppliers share names each of their
// models alike and the text says no more of which one was meant: one in N, by the same steps (2 is 50%, 3 is 35%).
const CODE_PERCENT = 100;
// No text near the query: not one of 260 graded pairs of 9 queries was what was asked
const NO_CLOSE_MATCH_PERCENT = 5;
// Against what the query asks: 27% of 117 pairs, however close the text
const AGAINST_PERCENT = 25;
// The ranks the odds fall below: inside the top 10 a place says little
const TOP_RANKS = 10;
// From this many words a query asks for more than one thing, and meeting it all is harder
const LONG_QUERY_WORDS = 6;
// Log-odds of exactly what was asked. A closer text says the most. Conditions compare results of one query: "fits" is
// below no conditions at all since a query with none is usually broad, where any such product will do.
const TEXT_ODDS = {
  base: 0.5, atSimilarity: 0.7, perSimilarity: 18.78, notAmongTexts: -0.82, unknown: -1.9, fits: -0.93, perDoubledRank: -0.21,
  longQuery: -1.16,
};
// On 14 photos, each with a match in the catalogue: a photo of what the catalogue lacks was never tried
const PHOTO_ODDS = { base: 0.04, perDoubledRank: -1.33 };

function isLongQuery(text: string | undefined): boolean {
  return (text?.trim().split(/\s+/).length ?? 0) >= LONG_QUERY_WORDS;
}

// A text not read means no reading at all as much as a failed one: parseQuery false asks for none
export function measuredQuery(model: SearchModelName, text: string | undefined, lists: ListName[], queryParse: QueryParse | null,
  hasCloseMatch: boolean | null): MeasuredQuery {
  return {
    model, isRead: queryParse?.status === "ok" || !lists.some((name) => name.startsWith("text-")),
    isByText: lists.includes("text-text"), isLong: isLongQuery(text), hasCloseMatch,
  };
}

function chanceOf(odds: number): number {
  return 1 / (1 + Math.exp(-odds));
}

function doublingsPastTop(rank: number): number {
  return Math.max(0, Math.log2(rank / TOP_RANKS));
}

function overallMatch(match: ConditionMatch | null): Match | null {
  const asked = match ? Object.values(match).filter((value) => value !== null) : [];
  if (asked.includes("against")) return "against";
  if (asked.includes("unknown")) return "unknown";
  return asked.length ? "fits" : null;
}

function textChance({ rank, lists }: Found, match: Match | null, isLong: boolean): number {
  const similarity = lists["text-text"]?.similarity;
  const byText = similarity === undefined ? TEXT_ODDS.notAmongTexts : (similarity - TEXT_ODDS.atSimilarity) * TEXT_ODDS.perSimilarity;
  const byConditions = match === "unknown" ? TEXT_ODDS.unknown : match === "fits" ? TEXT_ODDS.fits : 0;
  return chanceOf(TEXT_ODDS.base + byText + byConditions + doublingsPastTop(rank) * TEXT_ODDS.perDoubledRank
    + (isLong ? TEXT_ODDS.longQuery : 0));
}

function bounded(chance: number): number {
  const percent = Math.round(chance * (100 / PERCENT_STEP)) * PERCENT_STEP;
  return Math.min(MOST_PERCENT, Math.max(FEWEST_PERCENT, percent));
}

function percentOf(found: Found, query: MeasuredQuery): number {
  if (query.hasCloseMatch === false) return NO_CLOSE_MATCH_PERCENT;
  if (!query.isByText) return bounded(chanceOf(PHOTO_ODDS.base + doublingsPastTop(found.rank) * PHOTO_ODDS.perDoubledRank));
  const match = overallMatch(found.conditionMatch);
  return match === "against" ? AGAINST_PERCENT : bounded(textChance(found, match, query.isLong));
}

function codePercent(models: number | null): number {
  return models !== null && models > 1 ? Math.round(CODE_PERCENT / models / PERCENT_STEP) * PERCENT_STEP : CODE_PERCENT;
}

function levelOf(percent: number): ConfidenceLevel {
  if (percent >= HIGH_FROM_PERCENT) return "high";
  return percent >= MEDIUM_FROM_PERCENT ? "medium" : "low";
}

// null: nothing was measured for such a search, and a number there would be made up
export function confidenceOf(found: Found, query: MeasuredQuery): Confidence | null {
  if (found.matchedCode !== null) {
    const percent = codePercent(found.matchedCodeModels);
    return { percent, level: levelOf(percent) };
  }
  if (query.model !== MEASURED_MODEL || !query.isRead) return null;
  const percent = percentOf(found, query);
  return { percent, level: levelOf(percent) };
}
