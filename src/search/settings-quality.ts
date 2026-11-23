// The report of quality by variant (stage 2a, docs/roadmap.md; README «Тест якості пошуку»): for each set of search
// settings the journal kept, where the first model a manager graded exact stood in the searches graded at all: first, in
// the top 3, in the top 10. Searches of before the settings (settings null) are not read. Not a blind test: a manager
// grades what the search showed. Pure: the reads and the printing are in scripts/settings-quality.ts.
import {
  changedSettings, CODE_DEFAULT_SETTINGS, mergeSettings, type SearchSettings, type SettingKey, SETTING_KEYS,
  storedSettings,
} from "./settings.js";

const TOP_FEW = 3;
const TOP_MANY = 10;
const PERCENT = 100;

export const SEARCH_KINDS = ["all", "photo", "photo-text", "text"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

// One journal row: its settings as the column holds them, its inputs, its grades
export interface JournalSearch {
  settings: unknown;
  hasPhoto: boolean;
  hasText: boolean;
  // Grades of any kind the search got
  grades: number;
  // The place of the first model graded exact; null: none was
  firstExactRank: number | null;
}

export interface Places {
  searches: number;
  graded: number;
  first: number;
  topFew: number;
  topMany: number;
  below: number;
  noExact: number;
}

export interface VariantQuality {
  settings: SearchSettings;
  // The settings that differ from the code's defaults: the search of before the switches has none
  changed: SettingKey[];
  places: Record<SearchKind, Places>;
}

function kindOf({ hasPhoto, hasText }: JournalSearch): Exclude<SearchKind, "all"> {
  if (hasPhoto) return hasText ? "photo-text" : "photo";
  return "text";
}

function noPlaces(): Places {
  return { searches: 0, graded: 0, first: 0, topFew: 0, topMany: 0, below: 0, noExact: 0 };
}

function addTo(places: Places, { grades, firstExactRank }: JournalSearch): void {
  places.searches += 1;
  if (!grades) return;
  places.graded += 1;
  if (firstExactRank === null) places.noExact += 1;
  else if (firstExactRank > TOP_MANY) places.below += 1;
  else {
    places.topMany += 1;
    if (firstExactRank <= TOP_FEW) places.topFew += 1;
    if (firstExactRank === 1) places.first += 1;
  }
}

// A row's settings over the code's defaults, so a key a later release added reads as its default
function fullSettings(json: unknown): SearchSettings {
  return mergeSettings(CODE_DEFAULT_SETTINGS, storedSettings(json).settings);
}

// The variants with the most graded searches first
export function qualityByVariant(searches: JournalSearch[]): VariantQuality[] {
  const variants = new Map<string, VariantQuality>();
  for (const search of searches) {
    const settings = fullSettings(search.settings);
    const key = JSON.stringify(SETTING_KEYS.map((name) => settings[name]));
    let variant = variants.get(key);
    if (!variant) {
      const places = Object.fromEntries(SEARCH_KINDS.map((kind) => [kind, noPlaces()])) as Record<SearchKind, Places>;
      variant = { settings, changed: changedSettings(settings, CODE_DEFAULT_SETTINGS), places };
      variants.set(key, variant);
    }
    addTo(variant.places.all, search);
    addTo(variant.places[kindOf(search)], search);
  }
  return [...variants.values()].sort((left, right) => right.places.all.graded - left.places.all.graded);
}

function share(count: number, of: number): string {
  return `${count} (${of ? Math.round((count / of) * PERCENT) : 0}%)`;
}

function placesLine(kind: SearchKind, places: Places): string {
  const { graded } = places;
  return `  ${kind}: ${graded} graded of ${places.searches} searches; the first exact first ${share(places.first, graded)},`
    + ` in the top ${TOP_FEW} ${share(places.topFew, graded)}, in the top ${TOP_MANY} ${share(places.topMany, graded)},`
    + ` below ${places.below}, no exact ${places.noExact}`;
}

export function qualityLines(variants: VariantQuality[]): string[] {
  return variants.flatMap((variant, index) => {
    const label = variant.changed.length
      ? variant.changed.map((key) => `${key} ${String(variant.settings[key])}`).join(", ")
      : "the code's defaults, the search of before the switches";
    const kinds = SEARCH_KINDS.filter((kind) => kind === "all" || variant.places[kind].searches > 0);
    return [`variant ${index + 1}: ${label}`, ...kinds.map((kind) => placesLine(kind, variant.places[kind]))];
  });
}
