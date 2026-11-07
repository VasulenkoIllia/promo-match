// What a result card and the filters compute from the API's data, apart from the words they show (text.ts)
import type {
  CategoryFilter, ConditionMatch, Conditions, FactFilters, Grade, GradeBody, Match, ModelLink, ResultVariant, SearchFilters,
  SearchResult, SharedGroupOption,
} from "./api";
import { supplierCategoriesOf } from "./supplier-categories";

// The API's bound for filters.minStock (src/search/request.ts)
export const MAX_MIN_STOCK = 10_000_000;
// A search always asks for the API's most (src/search/request.ts, MAX_LIMIT), and the screen cuts it: another count
// is no new paid search and keeps the order
export const MAX_RESULTS = 100;
const RESULT_COUNTS = [12, 24, 48];
export const DEFAULT_RESULT_COUNT = 24;
const WHOLE_NUMBER = /^\d+$/;
// numeric(12,4) as the server writes it
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface PriceSpan {
  currency: string;
  min: number;
  max: number;
}

interface VariantSummary {
  count: number;
  colors: string[];
  // The sum over the variants with a known stock; null when none has one
  stock: number | null;
  // Some variant has no stock known, so the sum is short of the model's
  hasUnknownStock: boolean;
  // One span per currency, in the order the variants give them
  prices: PriceSpan[];
}

// A price's amount as a number, or null for anything but a decimal (Number("") would be 0)
export function amountOf(text: string): number | null {
  return DECIMAL.test(text) ? Number(text) : null;
}

export function variantSummary(variants: ResultVariant[]): VariantSummary {
  const colors = [...new Set(variants.flatMap((variant) => (variant.color ? [variant.color] : [])))];
  const stocks = variants.flatMap((variant) => (variant.inStock === null ? [] : [variant.inStock]));
  const spans = new Map<string, PriceSpan>();
  for (const { price } of variants) {
    const amount = price ? amountOf(price.amount) : null;
    if (!price || amount === null) continue;
    const span = spans.get(price.currency);
    if (span) {
      span.min = Math.min(span.min, amount);
      span.max = Math.max(span.max, amount);
    } else {
      spans.set(price.currency, { currency: price.currency, min: amount, max: amount });
    }
  }
  return {
    count: variants.length,
    colors,
    stock: stocks.length ? stocks.reduce((sum, stock) => sum + stock, 0) : null,
    hasUnknownStock: stocks.length > 0 && stocks.length < variants.length,
    prices: [...spans.values()],
  };
}

export interface SharedCategoryEntry {
  name: string;
  models: number;
}

// Every shared category and group by its code: its Ukrainian name and how many active models it has
export function sharedCategoryIndex(groups: SharedGroupOption[]): Map<string, SharedCategoryEntry> {
  return new Map(groups.flatMap((group) => [group, ...group.categories])
    .map((entry) => [entry.code, { name: entry.name.uk, models: entry.models }]));
}

// The filters as the form holds them (Filters.tsx): an empty list or field is no filter
export interface FilterState {
  sources: string[];
  // Nodes of the one chosen supplier's own tree (supplier-categories.ts)
  supplierCategories: CategoryFilter[];
  sharedCategories: string[];
  minStock: string;
  model: string;
  facts: FactFilters;
  // The switch of the second pass over the catalogue's facts; off by default
  isConditionPass: boolean;
}

// The minimum stock field: empty is no filter; anything but a whole number from 1 to the API's bound is invalid
export function parseMinStock(value: string): number | undefined | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!WHOLE_NUMBER.test(trimmed)) return "invalid";
  const stock = Number(trimmed);
  return stock >= 1 && stock <= MAX_MIN_STOCK ? stock : "invalid";
}

// The API refuses an empty list (400), so a filter not set is left out
export function apiFilters(form: FilterState, minStock: number | undefined): SearchFilters {
  const categories = supplierCategoriesOf(form);
  return {
    ...(form.sources.length ? { sources: form.sources } : {}),
    ...(categories.length ? { categories } : {}),
    ...(form.sharedCategories.length ? { sharedCategories: form.sharedCategories } : {}),
    ...(minStock === undefined ? {} : { minStock }),
    ...form.facts,
  };
}

// A number said exactly is a size a catalogue rounds: the filter takes it with the room the search gives it
// (src/search/conditions.ts, NEAR_SHARE)
const VOLUME_ROOM = 0.1;
const SIZE_ROOM = 0.2;

function roomAround(value: number, room: number): { min: number; max: number } {
  return { min: Math.round(value * (1 - room) * 10) / 10, max: Math.round(value * (1 + room) * 10) / 10 };
}

function volumeFilter({ min, max }: NonNullable<Conditions["volumeMl"]>): NonNullable<FactFilters["volumeMl"]> {
  if (min !== null && min === max) return roomAround(min, VOLUME_ROOM);
  return { ...(min === null ? {} : { min }), ...(max === null ? {} : { max }) };
}

function sizeFilter({ min, max }: NonNullable<Conditions["sizeCm"]>): NonNullable<FactFilters["sizeCm"]> {
  const isExact = min.length > 0 && min.join() === max.join();
  const lower = isExact ? min.map((side) => roomAround(side, SIZE_ROOM).min) : min;
  const upper = isExact ? max.map((side) => roomAround(side, SIZE_ROOM).max) : max;
  return { ...(lower.length ? { min: lower } : {}), ...(upper.length ? { max: upper } : {}) };
}

export type FactKey = keyof FactFilters;

// One filter per condition of the query, to apply on their own
export function factChoices({ volumeMl, materials, sizeCm }: Conditions): FactFilters[] {
  return [
    ...(volumeMl ? [{ volumeMl: volumeFilter(volumeMl) }] : []),
    ...(materials.length ? [{ materials }] : []),
    ...(sizeCm ? [{ sizeCm: sizeFilter(sizeCm) }] : []),
  ];
}

export type MatchKey = keyof ConditionMatch;

const MATCH_KEYS: MatchKey[] = ["volumeMl", "materials", "sizeCm", "printTechniques", "sheets", "gsm"];

// What a card says, in one order on every card: only the conditions the query asks
export function askedMatches(match: ConditionMatch): { key: MatchKey; value: Match }[] {
  return MATCH_KEYS.flatMap((key) => {
    const value = match[key];
    return value ? [{ key, value }] : [];
  });
}

// How many results a manager may keep on screen, up to what the search found
export function countChoices(found: number): number[] {
  return [...RESULT_COUNTS.filter((count) => count < found), found];
}

export function isFactApplied(applied: FactFilters, choice: FactFilters): boolean {
  return Object.entries(choice).every(([key, value]) => JSON.stringify(applied[key as FactKey]) === JSON.stringify(value));
}

export function withoutFact(facts: FactFilters, key: FactKey): FactFilters {
  return Object.fromEntries(Object.entries(facts).filter(([each]) => each !== key));
}

// The search a grade belongs to, as it was made
export interface GradedSearch {
  text: string;
  hasPhoto: boolean;
  model: string;
  filters: SearchFilters;
}

// A grade with what the search said of the model: the server keeps no searches
export function gradeBody(grade: Grade, search: GradedSearch, result: SearchResult): GradeBody {
  return {
    grade,
    ...(search.text ? { text: search.text } : {}),
    hasPhoto: search.hasPhoto,
    model: search.model,
    filters: search.filters,
    rank: result.rank,
    confidencePercent: result.confidence?.percent ?? null,
    lists: result.lists,
    conditionMatch: result.conditionMatch,
    matchedCode: result.matchedCode,
  };
}

export function withGrade(grades: ReadonlyMap<number, Grade>, modelId: number, grade: Grade | null): ReadonlyMap<number, Grade> {
  const next = new Map(grades);
  if (grade) next.set(modelId, grade);
  else next.delete(modelId);
  return next;
}

export function linksByModel(links: ModelLink[]): Map<number, ModelLink[]> {
  const byModel = new Map<number, ModelLink[]>();
  for (const link of links) byModel.set(link.modelId, [...byModel.get(link.modelId) ?? [], link]);
  return byModel;
}

// YYYY-MM-DD as DD.MM.YYYY, read as text: a Date would shift a bare date by the time zone
export function formatDate(date: string): string {
  const match = ISO_DATE.exec(date);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : date;
}

// Makito gives its photos only with a token, which the browser never gets, and Macma and Easy Gifts only inside a ZIP
// archive: the server passes them on (src/photos/routes.ts). Every other photo is shown from its supplier's address.
const PROXIED_PHOTOS: readonly (readonly [string, string])[] = [
  ["https://apis.makito.es/catalog/assets/", "/api/photos/makito/"],
  ["https://data.promotray.de/", "/api/photos/promotray/"],
];

export function photoSrc(url: string): string {
  const proxied = PROXIED_PHOTOS.find(([origin]) => url.startsWith(origin));
  return proxied ? `${proxied[1]}${url.slice(proxied[0].length)}` : url;
}
