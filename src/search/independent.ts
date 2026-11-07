// The independent test (README «Незалежний тест»): queries the search was never tuned on, the same number from every
// source, frozen in a file before a run. A photo case is a catalogue photo that is not in the search, a text case a
// buyer's request written from a model's facts by someone who never saw the search, a visual case one written from such a
// photo alone, a category case the name of a shared category. A text case repeats the catalogue's words and a visual case
// what the eye sees, so together they weigh the lists fairly. It answers two questions at once: does the search find
// things, and does it treat the sources alike. Pure: the cases' shape and the numbers. The sample and the runs are in
// scripts/independent-*.ts.
import { TOP_K } from "./quality.js";

export const CASE_KINDS = ["photo", "text", "visual", "category"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
const KNOWN_ITEM_KINDS = ["photo", "text", "visual"] as const;

export interface IndependentCase {
  id: string;
  kind: CaseKind;
  // The model the query was made from, and its source; null for a category case, which is about no model
  modelId: number | null;
  source: string | null;
  // The shared category the results should be in
  category: string;
  text?: string;
  // A file in the photos folder beside the cases file
  photo?: string;
}

export interface CatalogModel {
  source: string;
  // null: no mapping covers its path
  category: string | null;
  // The vectors of its photos, before any cap: what could push it up the photo lists
  photoVectors: number;
}

export type Catalog = Map<number, CatalogModel>;

export interface CaseRun {
  kase: IndependentCase;
  // The results' model ids, in their order; null: the search failed
  modelIds: number[] | null;
}

// Each source's share of a category's models: what a source would get in that category if the search knew no source
export function categoryShares(catalog: Catalog): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const { category, source } of catalog.values()) {
    if (category === null) continue;
    const sources = counts.get(category) ?? new Map<string, number>();
    sources.set(source, (sources.get(source) ?? 0) + 1);
    counts.set(category, sources);
  }
  return new Map([...counts].map(([category, sources]) => {
    const total = [...sources.values()].reduce((sum, count) => sum + count, 0);
    return [category, new Map([...sources].map(([source, count]) => [source, count / total]))];
  }));
}

function sourcesOf(catalog: Catalog): string[] {
  return [...new Set([...catalog.values()].map((model) => model.source))].sort();
}

function shareOf(modelIds: number[], isIn: (modelId: number) => boolean): number {
  return modelIds.length ? modelIds.filter(isIn).length / modelIds.length : 0;
}

export interface KnownItem {
  cases: number;
  atOne: number;
  atK: number;
  reciprocalRank: number;
  // The mean share of the top K in the case's category
  inCategory: number;
  // The mean share of the case's own source among the other results, and what the category alone would give it
  ownSource: number;
  expectedOwnSource: number;
}

function emptyKnownItem(): KnownItem {
  return { cases: 0, atOne: 0, atK: 0, reciprocalRank: 0, inCategory: 0, ownSource: 0, expectedOwnSource: 0 };
}

function addKnownItem(item: KnownItem, { kase, modelIds }: CaseRun & { modelIds: number[] }, catalog: Catalog,
  shares: Map<string, Map<string, number>>): void {
  const rank = modelIds.indexOf(kase.modelId ?? -1) + 1;
  item.cases += 1;
  if (rank === 1) item.atOne += 1;
  if (rank >= 1 && rank <= TOP_K) item.atK += 1;
  if (rank) item.reciprocalRank += 1 / rank;
  item.inCategory += shareOf(modelIds.slice(0, TOP_K), (id) => catalog.get(id)?.category === kase.category);
  const others = modelIds.filter((id) => id !== kase.modelId);
  item.ownSource += shareOf(others, (id) => catalog.get(id)?.source === kase.source);
  item.expectedOwnSource += shares.get(kase.category)?.get(kase.source ?? "") ?? 0;
}

// Sums to means, once all the cases are in
function meansOf(item: KnownItem): KnownItem {
  const { cases } = item;
  if (!cases) return item;
  return {
    ...item, reciprocalRank: item.reciprocalRank / cases, inCategory: item.inCategory / cases,
    ownSource: item.ownSource / cases, expectedOwnSource: item.expectedOwnSource / cases,
  };
}

export interface Exposure {
  shown: number;
  expected: number;
}

// Category cases: each source's mean share of the results against its mean share of those categories
function exposureOf(runs: (CaseRun & { modelIds: number[] })[], catalog: Catalog, shares: Map<string, Map<string, number>>):
  Record<string, Exposure> {
  return Object.fromEntries(sourcesOf(catalog).map((source) => {
    const sum = runs.reduce((total, { kase, modelIds }) => ({
      shown: total.shown + shareOf(modelIds, (id) => catalog.get(id)?.source === source),
      expected: total.expected + (shares.get(kase.category)?.get(source) ?? 0),
    }), { shown: 0, expected: 0 });
    return [source, { shown: sum.shown / (runs.length || 1), expected: sum.expected / (runs.length || 1) }];
  }));
}

const VECTOR_BUCKETS = [{ name: "1-3", upTo: 3 }, { name: "4-12", upTo: 12 }, { name: "13-30", upTo: 30 },
  { name: "31+", upTo: Number.POSITIVE_INFINITY }] as const;

function bucketOf(photoVectors: number): string {
  return VECTOR_BUCKETS.find(({ upTo }) => photoVectors <= upTo)?.name ?? "31+";
}

// Every result of every case: does a model get shown for having more vectors?
function vectorBuckets(runs: (CaseRun & { modelIds: number[] })[], catalog: Catalog): Record<string, Exposure> {
  const shown = new Map<string, number>();
  const models = new Map<string, number>();
  for (const { photoVectors } of catalog.values()) {
    const bucket = bucketOf(photoVectors);
    models.set(bucket, (models.get(bucket) ?? 0) + 1);
  }
  let results = 0;
  for (const { modelIds } of runs) {
    for (const id of modelIds) {
      const model = catalog.get(id);
      if (!model) continue;
      const bucket = bucketOf(model.photoVectors);
      shown.set(bucket, (shown.get(bucket) ?? 0) + 1);
      results += 1;
    }
  }
  return Object.fromEntries(VECTOR_BUCKETS.map(({ name }) => [name, {
    shown: (shown.get(name) ?? 0) / (results || 1), expected: (models.get(name) ?? 0) / (catalog.size || 1),
  }]));
}

export interface IndependentSummary {
  failed: number;
  // Kind to source to its numbers
  knownItem: Partial<Record<CaseKind, Record<string, KnownItem>>>;
  categoryPrecision: number;
  exposure: Record<string, Exposure>;
  vectorBuckets: Record<string, Exposure>;
}

export function summarizeIndependent(runs: CaseRun[], catalog: Catalog): IndependentSummary {
  const answered = runs.filter((run): run is CaseRun & { modelIds: number[] } => run.modelIds !== null);
  const shares = categoryShares(catalog);
  const knownItem: IndependentSummary["knownItem"] = {};
  for (const kind of KNOWN_ITEM_KINDS) {
    const ofKind = answered.filter(({ kase }) => kase.kind === kind);
    if (!ofKind.length) continue;
    const sums = Object.fromEntries(sourcesOf(catalog).map((source) => [source, emptyKnownItem()]));
    for (const run of ofKind) {
      const item = sums[run.kase.source ?? ""];
      if (item) addKnownItem(item, run, catalog, shares);
    }
    knownItem[kind] = Object.fromEntries(Object.entries(sums).map(([source, item]) => [source, meansOf(item)]));
  }
  const categoryRuns = answered.filter(({ kase }) => kase.kind === "category");
  const precision = categoryRuns.reduce((sum, { kase, modelIds }) =>
    sum + shareOf(modelIds.slice(0, TOP_K), (id) => catalog.get(id)?.category === kase.category), 0);
  return {
    failed: runs.length - answered.length, knownItem,
    categoryPrecision: categoryRuns.length ? precision / categoryRuns.length : 0,
    exposure: exposureOf(categoryRuns, catalog, shares), vectorBuckets: vectorBuckets(answered, catalog),
  };
}

const PERCENT = 100;
const RATIO_DIGITS = 2;

function percent(value: number): string {
  return `${Math.round(value * PERCENT)}%`;
}

function ratio({ shown, expected }: Exposure): string {
  return expected ? (shown / expected).toFixed(RATIO_DIGITS) : "n/a";
}

export function summaryLines(summary: IndependentSummary): string[] {
  const lines: string[] = [];
  for (const [kind, sources] of Object.entries(summary.knownItem)) {
    for (const [source, item] of Object.entries(sources)) {
      lines.push(`${kind} ${source}: top 1 ${item.atOne}/${item.cases}, top ${TOP_K} ${item.atK}/${item.cases}`
        + ` (${percent(item.cases ? item.atK / item.cases : 0)}), MRR ${item.reciprocalRank.toFixed(RATIO_DIGITS)},`
        + ` in its category ${percent(item.inCategory)}, own source ${percent(item.ownSource)}`
        + ` of ${percent(item.expectedOwnSource)} expected`);
    }
  }
  lines.push(`category queries: top ${TOP_K} in the category ${percent(summary.categoryPrecision)}`);
  for (const [source, exposure] of Object.entries(summary.exposure)) {
    lines.push(`exposure ${source}: shown ${percent(exposure.shown)}, category share ${percent(exposure.expected)},`
      + ` ratio ${ratio(exposure)}`);
  }
  const buckets = Object.entries(summary.vectorBuckets).map(([name, exposure]) => `${name}: ${ratio(exposure)}`);
  lines.push(`shown against catalogue share, by photo vectors of a model: ${buckets.join(", ")}`);
  if (summary.failed) lines.push(`${summary.failed} searches failed and count in no number`);
  return lines;
}

// The drawn cases of one kind into the two sets, the same number from every source: each keeps as many, in the draw's
// order, as the shortest one has, so a source short of usable photos or answers narrows them all instead of weighing
// less in every number. The first devSize of each go to dev, the rest to final, so the sets never share a model.
export function splitEvenly<T>(bySource: Map<string, T[]>, devSize: number): { dev: T[]; final: T[] } {
  const fewest = Math.min(...[...bySource.values()].map((drawn) => drawn.length));
  const sets: { dev: T[]; final: T[] } = { dev: [], final: [] };
  for (const drawn of bySource.values()) {
    sets.dev.push(...drawn.slice(0, Math.min(devSize, fewest)));
    sets.final.push(...drawn.slice(devSize, fewest));
  }
  return sets;
}

// A stable random order: the seed decides it, not ids, which follow the order of the imports
export function byHash<T>(items: T[], hashOf: (item: T) => string): T[] {
  return items.map((item) => ({ item, hash: hashOf(item) }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .map(({ item }) => item);
}
