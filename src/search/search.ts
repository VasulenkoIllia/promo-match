// The search of stage 4 (docs/integrations.md, «Пошук»): a code in the text looked up and taken out of it (src/search/
// codes.ts), the text read by Claude (translated into English, src/search/query-parse.ts), the query's vectors from the
// same provider as the catalogue's (role query), while each kind of list counts its candidates to pick an exact or an
// index scan («Точний пошук»), the nearest photos and model texts per list, the lists fused by RRF, the models a code
// named put first, then the models' details.
import { type CategoryEntry, loadTaxonomy } from "../categories/taxonomy.js";
import { ConfigError } from "../config.js";
import { Budget } from "../embeddings/batch.js";
import { type EmbeddingProvider, providerFromEnv } from "../embeddings/provider.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { categoriesNamedAlone, categoryLiftOf } from "./category-word.js";
import { type CodeHit, codeHits, codeTokens, textWithoutCodes, withCodeHits } from "./codes.js";
import { fittingEntries, passConditions, passFilters } from "./condition-pass.js";
import {
  conditionMatches, DEFAULT_DEMOTION, type Demotion, demoteByConditions, hasConditions, isDemoting, type ModelFacts, NO_CONDITIONS,
} from "./conditions.js";
import { measuredQuery } from "./confidence.js";
import {
  DEFAULT_SEARCH_MODEL, SEARCH_MODEL_NAMES, SEARCH_MODELS, type SearchModelName, TEXT_VARIANTS, type TextVariantName,
} from "./models.js";
import {
  addVotes, type FusedModel, fuseLists, hasCloseText, interleave, liftModels, type ListEntry, type ListName, rankPhotoHits, rankTextHits,
} from "./rank.js";
import { ModelNotConfigured, SearchInputError, SearchTimedOut } from "./errors.js";
import { correctHubs, type Hubness } from "./hubness.js";
import { type QueryParse, type QueryParser, readingUsd } from "./query-parse.js";
import type { ColorGroup, Conditions } from "./query-parse-contract.js";
import { listsFor, type QueryImage, type SearchInput } from "./request.js";
import { assembleResults, type SearchResult } from "./results.js";
import {
  type CandidateQuery, countCandidates, EXACT_MAX_ROWS, type FilterOptions, type FreshRuns, type ListKind, type ListScan,
  type NearestQuery, readCodeMatches, readFreshRuns, readModelColors, readModelFacts, readModels, readModelsInCategories,
  readNearestPhotos, readNearestTexts, readOptions, readPassingModels, readPhotos, readSharedCategoryIds, readSourceCodes,
  readVariants, type SearchFilters, type StoreFilters,
} from "./store.js";
import { hasExclusions, liftColored, sinkExcluded } from "./traits.js";
import { type SearchTuning, tuningOf } from "./tuning.js";

// Rows a list fetches, by its kind: a model has a few photos per colour, a text one row, and the fusion sees models
// ranked low in one list but high in another. The same for every limit: a limit only cuts the ranking, so 12 and 100
// results keep one order, and what was measured at this depth (README «Незалежний тест») holds for both.
const LIST_ROWS: Record<ListKind, number> = { photo: 288, text: 100 };
// Without a category filter, a list is exact up to this many candidates per row it asks for: with more, the index
// fills it from the nearest ones that pass, faster than checking the stock of them all (EXPLAIN 2026-10-30: Axpol with
// minStock 500, 691 texts exact in 20-24 ms against 5-10 through the index; docs «Пошук»). That holds while a model
// has up to about 100 thousand vectors (hnsw.max_scan_tuples × 5 of them): with more, such a list may stop short
// (isComplete false), and this rule is to be weighed again.
const EXACT_ROWS_PER_ROW_ASKED = 5;

// The search's own spending limits, at list prices before each call, per calendar day of the process (TZ), $1 by
// default: SEARCH_BUDGET_USD for the embedding of the query, QUERY_PARSE_BUDGET_USD for Claude's reading of its text.
// The counters live in the process: a restart starts the day again.
const DEFAULT_DAILY_BUDGET_USD = 1;

export type BudgetName = "SEARCH_BUDGET_USD" | "QUERY_PARSE_BUDGET_USD";

function dailyLimitUsdFromEnv(name: BudgetName): number {
  const raw = process.env[name];
  if (!raw) return DEFAULT_DAILY_BUDGET_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  return value;
}

function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

export class DailyBudget {
  #day = "";
  #budget: Budget;

  constructor(readonly limitUsd: number, readonly limitName: BudgetName = "SEARCH_BUDGET_USD",
    private readonly today: () => string = localDay) {
    this.#budget = new Budget(limitUsd, limitName);
  }

  // Throws BudgetReached (src/embeddings/batch.ts) when the call would pass the day's limit
  reserve(usd: number): void {
    const day = this.today();
    if (day !== this.#day) {
      this.#day = day;
      this.#budget = new Budget(this.limitUsd, this.limitName);
    }
    this.#budget.reserve(usd);
  }
}

export function dailyBudgetFromEnv(name: BudgetName): DailyBudget {
  return new DailyBudget(dailyLimitUsdFromEnv(name), name);
}

interface QueryVectors {
  image?: number[];
  text?: number[];
}

type ProviderFor = (model: SearchModelName) => EmbeddingProvider;

const providerFromEnvFor: ProviderFor = (model) => providerFromEnv(SEARCH_MODELS[model].provider).provider;

// One provider per model, made on first use from its key in the environment
export class QueryEmbedder {
  #providers = new Map<SearchModelName, EmbeddingProvider>();

  constructor(private readonly budget: DailyBudget, private readonly providerFor: ProviderFor = providerFromEnvFor) {}

  provider(model: SearchModelName): EmbeddingProvider {
    let provider = this.#providers.get(model);
    if (!provider) {
      try {
        provider = this.providerFor(model);
      } catch (error) {
        if (error instanceof ConfigError) throw new ModelNotConfigured(`${model} is not configured: ${error.message}`);
        throw error;
      }
      // The vectors of the catalogue carry the provider's name: a query of another model would compare apples to pears
      if (provider.name !== model) throw new Error(`the provider of ${model} is ${provider.name}`);
      this.#providers.set(model, provider);
    }
    return provider;
  }

  isConfigured(model: SearchModelName): boolean {
    try {
      this.provider(model);
      return true;
    } catch (error) {
      if (error instanceof ModelNotConfigured) return false;
      throw error;
    }
  }

  // Both calls are priced together before either goes, so a budget that allows one of them makes neither; the first
  // failure stops the other call
  async embed(model: SearchModelName, input: { text?: string; image?: QueryImage }, signal: AbortSignal):
    Promise<QueryVectors & { priceUsd: number }> {
    const provider = this.provider(model);
    const { text, image } = input;
    const imagePixels = image ? [image.info.width * image.info.height] : [];
    const priceUsd = provider.priceUsd({ imagePixels, textChars: text?.length ?? 0 });
    this.budget.reserve(priceUsd);
    const firstFailure = new AbortController();
    const callSignal = AbortSignal.any([signal, firstFailure.signal]);
    const stopOthersOnFailure = (error: unknown) => {
      firstFailure.abort(error);
      throw error;
    };
    const [imageVector, textVector] = await Promise.all([
      image ? provider.embedImages([{ bytes: image.bytes, mimeType: image.info.mimeType }], "query", callSignal)
        .then((result) => result.vectors[0], stopOthersOnFailure) : undefined,
      text ? provider.embedTexts([{ title: null, text }], "query", callSignal)
        .then((result) => result.vectors[0], stopOthersOnFailure) : undefined,
    ]);
    return { image: imageVector, text: textVector, priceUsd };
  }
}

export interface SearchResponse {
  model: SearchModelName;
  lists: ListName[];
  // false: a list through the index stopped short of its rows, so models nearer than some of those found may be missing
  isComplete: boolean;
  // false: the catalogue holds nothing near the text, the results are only the nearest there is; null: nothing to say
  hasCloseMatch: boolean | null;
  // The text as Claude read it, with the filters it suggests; null when no list uses the text or the parse is off
  queryParse: QueryParse | null;
  tookMs: number;
  // What this search paid at list prices: the vectors of the query and Claude's reading. An estimate, not the bill
  costUsd: number;
  results: SearchResult[];
}

interface ModelOption {
  name: SearchModelName;
  provider: string;
  isDefault: boolean;
  isConfigured: boolean;
}

export interface SearchOptions extends FilterOptions {
  models: ModelOption[];
}

export interface SearchService {
  search(input: SearchInput, signal: AbortSignal): Promise<SearchResponse>;
  options(): Promise<SearchOptions>;
}

interface ListQuery {
  name: ListName;
  kind: ListKind;
  query: NearestQuery;
}

function kindOf(name: ListName): ListKind {
  return name.endsWith("-photo") ? "photo" : "text";
}

// The most candidates a list ranks exactly. A category follows what a photo shows, so under it the index both stops
// short (hnsw.max_scan_tuples) and passes over near candidates: clothing with a mug photo, 110-136 of the 288 nearest
// (EXPLAIN 2026-10-30). Sources and stock do not, and the index fills its list unless few candidates pass.
export function exactMaxRows(filters: StoreFilters, rows: number): number {
  const hasCategory = Boolean(filters.categories?.length || filters.sharedCategoryIds);
  return hasCategory ? EXACT_MAX_ROWS : Math.min(rows * EXACT_ROWS_PER_ROW_ASKED, EXACT_MAX_ROWS);
}

// Each kind of list goes exact when its candidates, counted up to that most, fit; through the index otherwise, so an
// index list always has more candidates than rows to fetch
async function listScans(db: PrismaClient, query: CandidateQuery, limits: Record<ListKind, number>, kinds: ListKind[],
  maxRows = exactMaxRows): Promise<Partial<Record<ListKind, ListScan>>> {
  const scans = await Promise.all(kinds.map(async (kind) => {
    const upTo = maxRows(query.filters, limits[kind]);
    const candidates = await countCandidates(db, kind, query, upTo).catch((error: unknown) => {
      // A count past its timeout leaves the list to the index, as before the count, rather than failing the search and
      // the paid call beside it: no index narrows these filters, so an exact list would be slow too, and an index list
      // that stops short says so (isComplete)
      if (error instanceof SearchTimedOut) return upTo + 1;
      throw error;
    });
    return [kind, candidates <= upTo ? "exact" : "index"] as const;
  }));
  return Object.fromEntries(scans);
}

function nearestQueries(lists: ListName[], vectors: QueryVectors, candidates: CandidateQuery,
  limits: Record<ListKind, number>, scans: Partial<Record<ListKind, ListScan>>): ListQuery[] {
  return lists.map((name) => {
    const vector = name.startsWith("image-") ? vectors.image : vectors.text;
    if (!vector) throw new Error(`no query vector for the list ${name}`);
    const kind = kindOf(name);
    const scan = scans[kind];
    if (!scan) throw new Error(`no scan for the list ${name}`);
    return { name, kind, query: { ...candidates, vector, limit: limits[kind], scan } };
  });
}

// A list short of its rows through the index stopped at the scan's limit: such a list has more candidates than rows.
// A full one is not proof of the nearest rows: past EXACT_MAX_ROWS under a category the index may pass over some.
function isListComplete(query: NearestQuery, rows: number): boolean {
  return query.scan === "exact" || rows >= query.limit;
}

interface ReadList {
  entries: ListEntry[];
  isComplete: boolean;
}

async function readScan(db: PrismaClient, kind: ListKind, query: NearestQuery): Promise<ReadList> {
  if (kind === "photo") {
    const hits = await readNearestPhotos(db, query);
    return { entries: rankPhotoHits(hits), isComplete: isListComplete(query, hits.length) };
  }
  const hits = await readNearestTexts(db, query);
  return { entries: rankTextHits(hits), isComplete: isListComplete(query, hits.length) };
}

// An exact list past its timeout (every candidate's vector is read, slow on a cold cache) goes through the index rather
// than failing the search beside the paid call; an index list that stops short says so (isComplete)
async function readList(db: PrismaClient, { kind, query }: ListQuery): Promise<ReadList> {
  try {
    return await readScan(db, kind, query);
  } catch (error) {
    if (query.scan !== "exact" || !(error instanceof SearchTimedOut)) throw error;
    return readScan(db, kind, { ...query, scan: "index" });
  }
}

// A source code the database does not know would only narrow the search to nothing: refused before the paid call
async function checkSources(db: PrismaClient, filters: SearchFilters): Promise<void> {
  const asked = [...filters.sources ?? [], ...(filters.categories ?? []).map((category) => category.source)];
  if (!asked.length) return;
  const known = new Set(await readSourceCodes(db));
  const unknown = [...new Set(asked.filter((code) => !known.has(code)))];
  if (unknown.length) throw new SearchInputError(`unknown source: ${unknown.join(", ")}`);
}

// The shared category codes as the ids of their categories; a code the list does not have, or codes with no category
// (a group emptied in the database), would only narrow the search to nothing, so they are refused before the paid call
async function resolveSharedCategories(db: PrismaClient, codes: string[]): Promise<number[]> {
  const rows = await readSharedCategoryIds(db, codes);
  const unknown = codes.filter((code) => !rows.some((row) => row.code === code));
  if (unknown.length) throw new SearchInputError(`unknown shared category: ${unknown.join(", ")}`);
  const ids = [...new Set(rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId])))];
  if (!ids.length) throw new SearchInputError(`no categories in the shared category ${codes.join(", ")}`);
  return ids;
}

interface QueryReading {
  // One set per product of the text, the reference photo on the first; one set when the text names no products
  vectorSets: QueryVectors[];
  embeddingUsd: number;
  // What is asked of each of those products
  conditions: Conditions[];
  queryParse: QueryParse | null;
  lists: ListName[];
  // The categories a text beside a photo only named: it adds no lists, they lift what is in them
  namedCategories: string[];
}

type TextParser = Pick<QueryParser, "parse">;

function categoriesOfText(input: SearchInput, text: string | undefined, queryParse: QueryParse | null, categories: CategoryEntry[]):
  string[] {
  if (categoryLiftOf(input) === null || !input.image || text === undefined || queryParse?.status !== "ok") return [];
  const { products, suggestedFilters } = queryParse;
  return categoriesNamedAlone(products.length ? products : [text], suggestedFilters.sharedCategories, categories);
}

// Only the inputs the lists use are read and embedded (and paid for); the text is embedded in English when Claude read
// it, as it is otherwise. A model without its key is refused before Claude is paid for. Beside a code, words Claude finds
// no product in ("Artikelnummer:") are not embedded: their nearest models would only follow the right one as noise.
async function readQuery(embedder: QueryEmbedder, parser: TextParser | undefined, input: SearchInput, lists: ListName[],
  hasCodeHits: boolean, categories: CategoryEntry[], signal: AbortSignal): Promise<QueryReading> {
  embedder.provider(input.model);
  const text = lists.some((name) => name.startsWith("text-")) ? input.text : undefined;
  const queryParse = text !== undefined && input.parseQuery && parser ? await parser.parse(text, signal) : null;
  const products = queryParse?.status === "ok" ? queryParse.products : [];
  const namedCategories = categoriesOfText(input, text, queryParse, categories);
  const isTextEmpty = namedCategories.length > 0 || (hasCodeHits && queryParse?.status === "ok" && !products.length);
  const [firstProduct, ...otherProducts] = isTextEmpty ? [undefined] : products.length ? products : [text];
  const vectorSets = await Promise.all([
    embedder.embed(input.model, {
      image: lists.some((name) => name.startsWith("image-")) ? input.image : undefined, text: firstProduct,
    }, signal),
    ...otherProducts.map((product) => embedder.embed(input.model, { text: product }, signal)),
  ]);
  const conditions = queryParse?.status === "ok" && queryParse.conditions.length ? queryParse.conditions : [NO_CONDITIONS];
  return {
    vectorSets, embeddingUsd: vectorSets.reduce((sum, { priceUsd }) => sum + priceUsd, 0), conditions, queryParse, namedCategories,
    lists: isTextEmpty ? lists.filter((name) => !name.startsWith("text-")) : lists,
  };
}

async function resolveFilters(db: PrismaClient, filters: SearchFilters): Promise<StoreFilters> {
  const { sharedCategories, ...rest } = filters;
  const [sharedCategoryIds] = await Promise.all([
    sharedCategories ? resolveSharedCategories(db, sharedCategories) : undefined, checkSources(db, filters),
  ]);
  return sharedCategoryIds ? { ...rest, sharedCategoryIds } : rest;
}

interface ProductRanking {
  fused: FusedModel[];
  isComplete: boolean;
}

// The lists side by side, so the search waits for the slowest of them rather than for their sum. Deep: the ranking keeps
// every model the lists found, so whatever falls for a condition leaves its place to one from below the limit.
async function readRanking(db: PrismaClient, queries: ListQuery[], limit: number, isDeep: boolean,
  hubness: Hubness | undefined): Promise<ProductRanking> {
  const read = await Promise.all(queries.map(async (each) => ({ name: each.name, ...await readList(db, each) })));
  const ranked: Partial<Record<ListName, ListEntry[]>> = Object.fromEntries(read.map((list) =>
    [list.name, hubness ? correctHubs(list.name, list.entries, hubness) : list.entries]));
  const isComplete = read.every((list) => list.isComplete);
  return { fused: fuseLists(ranked, isDeep ? Number.POSITIVE_INFINITY : limit), isComplete };
}

// One read for the models of every product; each ranking ends cut to the limit
async function applyConditions(db: PrismaClient, rankings: ProductRanking[], conditions: Conditions[], demotion: Demotion,
  limit: number): Promise<FusedModel[][]> {
  const asked = rankings.flatMap((ranking, index) => (isDemoting(conditions[index] ?? NO_CONDITIONS, demotion) ? ranking.fused : []));
  const facts = await readModelFacts(db, [...new Set(asked.map((model) => model.modelId))]);
  return rankings.map((ranking, index) => {
    const each = conditions[index] ?? NO_CONDITIONS;
    return isDemoting(each, demotion) ? demoteByConditions(ranking.fused, each, facts, demotion, limit) : ranking.fused;
  });
}

// The ranking with the models of the categories lifted; deep, as for a condition, so a lift has models to pass
async function liftNamedCategories(db: PrismaClient, ranking: ProductRanking, codes: string[], lift: number): Promise<ProductRanking> {
  // A code the reader named and the database lacks lifts nothing: a suggestion never fails a search
  const ids = (await readSharedCategoryIds(db, codes)).flatMap(({ categoryId }) => (categoryId === null ? [] : [categoryId]));
  const inCategories = await readModelsInCategories(db, ranking.fused.map((model) => model.modelId), ids);
  return { ...ranking, fused: liftModels(ranking.fused, inCategories, lift) };
}

// The product's text lists again over the models that fit (src/search/condition-pass.ts). The facts follow what a photo
// shows, as a category does, so these lists go exact while they can. A list that stops short only votes less, and says
// nothing of the first pass's isComplete.
async function voteByConditions(db: PrismaClient, ranking: ProductRanking, lists: ListName[], vectors: QueryVectors,
  { candidates, limits, conditions, asked, weight }: { candidates: CandidateQuery; limits: Record<ListKind, number>; conditions: Conditions; asked: Conditions; weight: number }):
  Promise<ProductRanking> {
  const textLists = lists.filter((name) => name.startsWith("text-"));
  const fitting = { ...candidates, filters: passFilters(candidates.filters, conditions) };
  const scans = await listScans(db, fitting, limits, [...new Set(textLists.map(kindOf))], () => EXACT_MAX_ROWS);
  const read = await Promise.all(nearestQueries(textLists, vectors, fitting, limits, scans).map((each) => readList(db, each)));
  const facts = await readModelFacts(db, [...new Set(read.flatMap(({ entries }) => entries.map(({ modelId }) => modelId)))]);
  return { ...ranking, fused: addVotes(ranking.fused, read.map(({ entries }) => fittingEntries(entries, conditions, asked, facts)), weight) };
}

function hasAnyFilter(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined));
}

// The bound on the nearest text holds for a product a query names, over the whole catalogue: a filter narrows what is
// near, and a query of a fact alone ("FSC", "корк") stands far from each product that has it
export function canTellCloseness({ image, filters }: Pick<SearchInput, "image" | "filters">, queryParse: QueryParse | null): boolean {
  return image === undefined && queryParse?.status === "ok" && queryParse.products.length > 0 && !hasAnyFilter(filters);
}

// What only moves places gives way to a timeout: the search has its lists and has paid for them
function keepRankingOnTimeout(ranking: ProductRanking): (error: unknown) => ProductRanking {
  return (error) => {
    if (error instanceof SearchTimedOut) return ranking;
    throw error;
  };
}

// The colour asked and what is ruled out, on the ranking of a product (src/search/traits.ts)
async function applyTraits(db: PrismaClient, ranking: ProductRanking, colors: ColorGroup[], conditions: Conditions, tuning: SearchTuning):
  Promise<ProductRanking> {
  const modelIds = ranking.fused.map(({ modelId }) => modelId);
  const [names, facts] = await Promise.all([readModelColors(db, modelIds), hasExclusions(conditions) ? readModelFacts(db, modelIds) : new Map<number, ModelFacts>()]);
  const lifted = tuning.colorLift !== null && colors.length ? liftColored(ranking.fused, names, colors, tuning.colorLift) : ranking.fused;
  const fused = tuning.exclusionFactor !== null && hasExclusions(conditions) ? sinkExcluded(lifted, facts, names, conditions, tuning.exclusionFactor) : lifted;
  return { ...ranking, fused };
}

interface NamedCodes {
  // The text without the codes the catalogues have; undefined when they were all it said
  text: string | undefined;
  hits: CodeHit[];
}

// Looked up before anything is paid for: a text of codes alone costs nothing. A code that fails the filters still leaves
// the text, which it would only confuse.
async function readNamedCodes(db: PrismaClient, { text, matchCodes }: SearchInput, filters: StoreFilters,
  freshRuns: FreshRuns): Promise<NamedCodes> {
  const tokens = text !== undefined && matchCodes ? codeTokens(text) : [];
  if (text === undefined || !tokens.length) return { text, hits: [] };
  const matches = await readCodeMatches(db, [...new Set(tokens.map((token) => token.toLowerCase()))]);
  const named = tokens.filter((token) => matches.has(token.toLowerCase()));
  if (!named.length) return { text, hits: [] };
  const hits = codeHits(named, matches);
  const passing = new Set(await readPassingModels(db, hits.map((hit) => hit.modelId), filters, freshRuns));
  return { text: textWithoutCodes(text, named), hits: hits.filter((hit) => passing.has(hit.modelId)) };
}

// What the independent test tries beside the screen's search, each for its own model only: hubness, the correction of
// the lists (src/search/hubness.ts); textVariant, other vectors of the model texts (src/search/models.ts)
export interface SearchCandidate {
  hubness?: Hubness;
  textVariant?: TextVariantName;
}

// parser undefined: the text is embedded as it is. The screen has no candidate.
export function createSearchService(db: PrismaClient, embedder: QueryEmbedder, parser?: TextParser,
  { hubness, textVariant }: SearchCandidate = {}): SearchService {
  const categories = loadTaxonomy().entries;
  return {
    async search(input, signal) {
      const started = performance.now();
      const [freshRuns, filters] = await Promise.all([readFreshRuns(db), resolveFilters(db, input.filters)]);
      const { text, hits } = await readNamedCodes(db, input, filters, freshRuns);
      const searched: SearchInput = { ...input, text };
      const inputLists = listsFor(searched);
      const isVariant = textVariant !== undefined && TEXT_VARIANTS[textVariant].model === input.model;
      const candidates: CandidateQuery = { model: input.model, ...(isVariant ? { textVariant } : {}), filters, freshRuns };
      // The candidates are counted while the query is read and embedded; codes alone leave nothing to read
      const [{ vectorSets, embeddingUsd, conditions, queryParse, lists, namedCategories }, scans] = await Promise.all([
        inputLists.length ? readQuery(embedder, parser, searched, inputLists, hits.length > 0, categories, signal)
          : { vectorSets: [{}], embeddingUsd: 0, conditions: [NO_CONDITIONS], queryParse: null, lists: inputLists, namedCategories: [] },
        listScans(db, candidates, LIST_ROWS, [...new Set(inputLists.map(kindOf))]),
      ]);
      // The reference photo's lists go with the first product alone
      const demotion = input.demotion ?? DEFAULT_DEMOTION;
      const tuning = tuningOf(input);
      const suggested = queryParse?.status === "ok" ? queryParse.suggestedFilters.sharedCategories : [];
      const liftCodes = namedCategories.length ? namedCategories : suggested;
      const lift = namedCategories.length ? categoryLiftOf(input) ?? 1 : suggested.length ? tuning.textCategoryLift ?? 1 : 1;
      const colors = queryParse?.status === "ok" ? queryParse.suggestedFilters.colors : [];
      const hasTraits = (tuning.colorLift !== null && colors.length > 0) || (tuning.exclusionFactor !== null && conditions.some(hasExclusions));
      const pass = input.conditionPass ?? null;
      const passAsked = vectorSets.map(({ text: vector }: QueryVectors, index) => (vector
        ? passConditions(conditions[index] ?? NO_CONDITIONS, pass, filters) : null));
      const rankings = await Promise.all(vectorSets.map((vectors, index) => readRanking(db,
        nearestQueries(index ? lists.filter((name) => name.startsWith("text-")) : lists, vectors, candidates, LIST_ROWS, scans),
        input.limit, lift > 1 || isDemoting(conditions[index] ?? NO_CONDITIONS, demotion) || Boolean(passAsked[index]) || hasTraits,
        hubness?.model === input.model ? hubness : undefined)));
      const lifted = lift > 1 ? await Promise.all(rankings.map((ranking) => liftNamedCategories(db, ranking, liftCodes, lift))) : rankings;
      const voted = await Promise.all(lifted.map(async (ranking, index) => {
        const held = passAsked[index];
        return held && pass ? voteByConditions(db, ranking, lists, vectorSets[index] ?? {},
          { candidates, limits: LIST_ROWS, conditions: held, asked: conditions[index] ?? NO_CONDITIONS, weight: pass.weight }).catch(keepRankingOnTimeout(ranking)) : ranking;
      }));
      const traited = hasTraits ? await Promise.all(voted.map((ranking, index) =>
        applyTraits(db, ranking, colors, conditions[index] ?? NO_CONDITIONS, tuning).catch(keepRankingOnTimeout(ranking)))) : voted;
      const demoted = await applyConditions(db, traited, conditions, demotion, input.limit);
      const fused = withCodeHits(interleave(demoted, input.limit), hits, input.limit);
      const modelIds = fused.map((model) => model.modelId);
      // The facts come after the order is settled: they fill the cards and move nothing
      const [models, variants, photos, facts] = await Promise.all([
        readModels(db, modelIds), readVariants(db, modelIds, freshRuns),
        readPhotos(db, fused.flatMap((model) => model.photos.map((photo) => photo.photoId))),
        readModelFacts(db, conditions.some(hasConditions) ? modelIds : []),
      ]);
      const hasCloseMatch = hasCloseText(input.model, rankings.map(({ fused: each }) => each), !hits.length && canTellCloseness(input, queryParse));
      return {
        model: input.model, lists, isComplete: rankings.every((ranking) => ranking.isComplete),
        hasCloseMatch,
        queryParse,
        tookMs: Math.round(performance.now() - started),
        costUsd: embeddingUsd + readingUsd(queryParse),
        results: assembleResults(fused, models, variants, photos, conditionMatches(fused, conditions, facts),
          measuredQuery(input.model, input.text, lists, queryParse, hasCloseMatch)),
      };
    },

    async options() {
      const options = await readOptions(db);
      const models = SEARCH_MODEL_NAMES.filter((name) => SEARCH_MODELS[name].isOnScreen).map((name) => ({
        name, provider: SEARCH_MODELS[name].provider, isDefault: name === DEFAULT_SEARCH_MODEL,
        isConfigured: embedder.isConfigured(name),
      }));
      return { models, ...options };
    },
  };
}
