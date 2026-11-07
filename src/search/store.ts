// The search's reads (stage 4): the nearest catalogue photos and model texts of one embedding model, under the filters,
// and the details of the models found. The nearest-neighbour queries go through the model's HNSW index, or rank every
// candidate when the filters leave few: the index's name and cast are literals (src/search/models.ts), the query
// vector is a parameter.
import type { CategoryName } from "../categories/codes.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { IN_SCOPE, IN_SEARCH, vectorText } from "../embeddings/store.js";
import { jsonParam } from "../import/write.js";
import { isKindOf, isMaterialCode, MATERIAL_CODES, type MaterialCode } from "../suppliers/materials.js";
import { isPrintFact, type PrintTechnique } from "../suppliers/printing.js";
import { isRecord } from "../suppliers/normalize.js";
import { type CodeMatch, REF_CODE_SOURCES } from "./codes.js";
import type { ModelFacts } from "./conditions.js";
import { SearchTimedOut } from "./errors.js";
import { isSearchModelName, isTextVariantName, SEARCH_MODELS, type SearchModelName, TEXT_VARIANTS, type TextVariantName } from "./models.js";
import type { SizeRange, ValueRange } from "./query-parse-contract.js";
import type { PhotoHit, TextHit } from "./rank.js";

// The literals of a model's index: its name for the WHERE of the partial index, the cast of its expression. Raw SQL,
// so the name is checked against the list here too, not only by the callers' types.
export function indexSql(model: SearchModelName): { name: Prisma.Sql; cast: Prisma.Sql } {
  if (!isSearchModelName(model)) throw new Error(`not a search model: ${String(model)}`);
  return {
    name: Prisma.raw(`'${model}'`),
    cast: Prisma.raw(`halfvec(${SEARCH_MODELS[model].dimensions})`),
  };
}

export interface CategoryFilter {
  source: string;
  // A prefix of the supplier's English category path: ["BAGS & BACKPACKS"] or ["BAGS & BACKPACKS", "backpacks"]
  path: string[];
}

export interface SearchFilters {
  sources?: string[];
  categories?: CategoryFilter[];
  // Codes of the shared category list (src/categories): a group's code stands for all its categories
  sharedCategories?: string[];
  // At least one active variant with this much in stock
  minStock?: number;
  // Hard filters: a model the catalogue says nothing of does not pass. The search's own use of these facts is soft
  // (src/search/conditions.ts); these are for when the screen asks for only what is known to fit.
  volumeMl?: Partial<ValueRange>;
  // Codes of the shared list; the first material of a model is the one compared, or a supplier that lists a lid's
  // plastic would pass as plastic. It passes as the asked material or a kind of it, not as a broader one: the search's
  // soft use takes both ways, but a model that says only metal does not confirm stainless steel.
  materials?: MaterialCode[];
  sizeCm?: Partial<SizeRange>;
}

// The filters as the nearest queries take them: the shared category codes resolved to the ids of their categories
// (src/search/search.ts, resolveFilters); filters with codes still in them do not fit. An empty list lets no model pass.
export type StoreFilters = Omit<SearchFilters, "sharedCategories"> & {
  sharedCategories?: never;
  sharedCategoryIds?: number[];
  // Facts no screen filters by: only the second pass holds a list to them (src/search/condition-pass.ts)
  printTechniques?: PrintTechnique[];
  sheets?: Partial<ValueRange>;
};

// The last complete import of each source (source id to sync_run id), read once per search (readFreshRuns)
export type FreshRuns = Record<number, number>;

// The rows a list ranks: a model's vectors of photos in the search, or of model texts, of models that pass the filters
export interface CandidateQuery {
  model: SearchModelName;
  // The text lists read these vectors in place of the model's own (the independent test only)
  textVariant?: TextVariantName;
  filters: StoreFilters;
  freshRuns: FreshRuns;
}

// The name of the text vectors a list reads, a literal as indexSql's: a variant only beside the model that made it
export function textVectorsSql({ model, textVariant }: Pick<CandidateQuery, "model" | "textVariant">): Prisma.Sql {
  if (textVariant === undefined) return indexSql(model).name;
  if (!isTextVariantName(textVariant) || TEXT_VARIANTS[textVariant].model !== model) {
    throw new Error(`not text vectors of ${model}: ${String(textVariant)}`);
  }
  return Prisma.raw(`'${textVariant}'`);
}

// index: through the model's HNSW index, which may stop short under narrow filters (MAX_SCAN_TUPLES); exact: the
// distance of every candidate, sorted, for filters that leave few of them (src/search/search.ts, listScans)
export type ListScan = "index" | "exact";

export interface NearestQuery extends CandidateQuery {
  vector: number[];
  // Nearest rows to fetch: photos for a photo list, models for a text list
  limit: number;
  scan: ListScan;
}

// pgvector's iterative scan goes on through the index until the filters have let enough rows pass, at most this many
// rows. Relaxed order comes back nearly sorted: the ranking sorts again (src/search/rank.ts).
const MAX_SCAN_TUPLES = 20_000;
// The most candidates an exact list ranks: as many as an index list may scan, about 100 ms locally (EXPLAIN 2026-10-30)
export const EXACT_MAX_ROWS = MAX_SCAN_TUPLES;
// Prisma gives up on a transaction after 5 s with an error of its own: a nearest query fails before that, as a timeout
// (a narrow filter with no match scans up to MAX_SCAN_TUPLES in about 1 s locally, EXPLAIN 2026-10-29)
const STATEMENT_TIMEOUT = "4s";
// A count runs beside the provider's call and gives up sooner: its list then goes through the index, as before the
// count (src/search/search.ts, listScans). Locally a count takes up to 83 ms (EXPLAIN 2026-10-30).
const COUNT_TIMEOUT = "1s";
const STATEMENT_TIMEOUT_CODE = "57014";
// hnsw.ef_search at least the rows asked for, which pgvector caps at 1000
const MAX_EF_SEARCH = 1_000;
const MIN_EF_SEARCH = 100;

// The import logs its runs as kind 'catalog'; a source with none succeeded has no fresh stock
export async function readFreshRuns(db: PrismaClient): Promise<FreshRuns> {
  const rows = await db.$queryRaw<{ sourceId: number; runId: number }[]>`
    SELECT source_id AS "sourceId", max(id) AS "runId" FROM sync_run
    WHERE kind = 'catalog' AND status = 'succeeded' GROUP BY source_id`;
  return Object.fromEntries(rows.map((row) => [row.sourceId, row.runId]));
}

// Stock st of variant v that the last complete import of its source still had: a variant missing from the stock feed
// keeps its old row (docs/integrations.md, «Імпорт каталогів»). The runs come as a parameter, not as a subquery per
// row: with one the planner joined every stock row to every candidate model (600 ms against 300, EXPLAIN 2026-10-29).
export function freshStock(runs: FreshRuns): Prisma.Sql {
  return Prisma.sql`st.last_seen_run_id >= (${JSON.stringify(runs)}::jsonb ->> v.source_id::text)::integer`;
}

// Side by side with the model's sides, longest first; a side the model does not state says nothing
function sideFilters(sides: number[] | undefined, operator: Prisma.Sql): Prisma.Sql[] {
  return (sides ?? []).map((side, index) =>
    Prisma.sql`(m.sizes_cm[${index + 1}::integer] IS NULL OR m.sizes_cm[${index + 1}::integer] ${operator} ${side})`);
}

function factFilters({ volumeMl, materials, sizeCm, printTechniques, sheets }: StoreFilters): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  // numeric: the screen's bounds around an exact number are not whole (web/src/format.ts), the column is
  if (volumeMl?.min != null) parts.push(Prisma.sql`m.volume_ml >= ${volumeMl.min}::numeric`);
  if (volumeMl?.max != null) parts.push(Prisma.sql`m.volume_ml <= ${volumeMl.max}::numeric`);
  if (materials?.length) {
    const confirming = MATERIAL_CODES.filter((code) => materials.some((each) => isKindOf(code, each)));
    parts.push(Prisma.sql`m.materials[1] = ANY(${confirming}::text[])`);
  }
  if (sizeCm?.min?.length || sizeCm?.max?.length) {
    parts.push(Prisma.sql`cardinality(m.sizes_cm) > 0`, ...sideFilters(sizeCm.min, Prisma.sql`>=`),
      ...sideFilters(sizeCm.max, Prisma.sql`<=`));
  }
  if (printTechniques?.length) parts.push(Prisma.sql`m.print_techniques && ${printTechniques}::text[]`);
  if (sheets?.min != null) parts.push(Prisma.sql`m.sheets >= ${sheets.min}::numeric`);
  if (sheets?.max != null) parts.push(Prisma.sql`m.sheets <= ${sheets.max}::numeric`);
  return parts;
}

// A model passes when it is active, in the sources and categories asked for, within the facts asked for, and has an
// active variant (with fresh stock when asked). On product_model m joined with source s.
function modelFilter(filters: StoreFilters, freshRuns: FreshRuns): Prisma.Sql {
  const parts = [Prisma.sql`m.is_active`];
  if (filters.sources?.length) {
    parts.push(Prisma.sql`s.code IN (SELECT jsonb_array_elements_text(${jsonParam(filters.sources)}::jsonb))`);
  }
  if (filters.categories?.length) {
    // Every name of the filter's path equals the category's name at the same level
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${jsonParam(filters.categories)}::jsonb) AS c(source text, path jsonb)
      WHERE c.source = s.code AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(c.path) WITH ORDINALITY AS x(name, i)
        WHERE (m.category->'en')->>(x.i::integer - 1) IS DISTINCT FROM x.name))`);
  }
  if (filters.sharedCategoryIds) {
    // The model's whole English path is mapped to one of the categories. The ids go as an array, not jsonb: the
    // planner then sees how many paths they have (a set-returning function counts as 100 rows, so a category of one
    // path looked like most of the catalogue and the exact lists scanned every photo, EXPLAIN 2026-10-30).
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM source_category sc
      WHERE sc.source_id = m.source_id AND sc.path = m.category->'en'
        AND sc.category_id = ANY(${filters.sharedCategoryIds}::integer[]))`);
  }
  parts.push(...factFilters(filters));
  const stock = filters.minStock === undefined ? Prisma.empty
    : Prisma.sql`AND EXISTS (SELECT 1 FROM stock st WHERE st.variant_id = v.id AND ${freshStock(freshRuns)}
        AND st.in_stock >= ${filters.minStock})`;
  parts.push(Prisma.sql`EXISTS (SELECT 1 FROM variant v WHERE v.model_id = m.id AND v.is_active ${stock})`);
  return Prisma.join(parts, " AND ");
}

// Model codes and SKUs of every source, whatever the case a person wrote them in: neither has two spellings of one
// code (2026-10-30). A SKU of an inactive variant still names its model. The reference of REF_CODE_SOURCES counts as a
// model code (2026-11-05).
export async function readCodeMatches(db: PrismaClient, keys: string[]): Promise<Map<string, CodeMatch[]>> {
  const rows = await db.$queryRaw<(CodeMatch & { key: string })[]>`
    SELECT lower(m.code) AS key, m.id AS "modelId", s.code || ' ' || m.code AS label, true AS "isModelCode"
    FROM product_model m JOIN source s ON s.id = m.source_id
    WHERE lower(m.code) = ANY(${keys}::text[])
    UNION
    SELECT lower(m.external_id), m.id, s.code || ' ' || m.code, true
    FROM product_model m JOIN source s ON s.id = m.source_id
    WHERE s.code = ANY(${[...REF_CODE_SOURCES]}::text[]) AND lower(m.external_id) = ANY(${keys}::text[])
    UNION
    SELECT lower(v.sku), m.id, s.code || ' ' || m.code, false
    FROM variant v JOIN product_model m ON m.id = v.model_id JOIN source s ON s.id = m.source_id
    WHERE lower(v.sku) = ANY(${keys}::text[])`;
  return Map.groupBy(rows, (row) => row.key);
}

// The models of the list that pass the filters: a code found by name obeys them like a model found by a list
export async function readPassingModels(db: PrismaClient, modelIds: number[], filters: StoreFilters, freshRuns: FreshRuns):
  Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM product_model m JOIN source s ON s.id = m.source_id
    WHERE m.id = ANY(${modelIds}::integer[]) AND ${modelFilter(filters, freshRuns)}`;
  return rows.map((row) => row.id);
}

// enable_sort off for an index list's transaction only: a vector is stored out of line (TOAST), so the table looks a few MB
// to the planner and a scan with an exact sort looks cheaper than the index, while reading every vector takes 200 ms
// against 12 ms through it. With no sort allowed, ORDER BY distance LIMIT n goes through the index. enable_seqscan off,
// as pgvector's guide suggests, did it too, but was up to 40% slower with filters (EXPLAIN 2026-10-29, docs «Пошук»).
function scanSettings({ scan, limit }: NearestQuery): Prisma.Sql {
  if (scan === "exact") return timeoutSettings(STATEMENT_TIMEOUT);
  const efSearch = Math.min(Math.max(limit, MIN_EF_SEARCH), MAX_EF_SEARCH);
  return Prisma.sql`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true),
    set_config('hnsw.iterative_scan', 'relaxed_order', true),
    set_config('hnsw.max_scan_tuples', ${String(MAX_SCAN_TUPLES)}, true),
    set_config('enable_sort', 'off', true),
    set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
}

function timeoutSettings(timeout: string): Prisma.Sql {
  return Prisma.sql`SELECT set_config('statement_timeout', ${timeout}, true)`;
}

function photoRows({ model, filters, freshRuns }: CandidateQuery): Prisma.Sql {
  return Prisma.sql`FROM photo_embedding e
    JOIN photo p ON p.id = e.photo_id
    JOIN product_model m ON m.id = p.model_id
    JOIN source s ON s.id = m.source_id
    WHERE e.embedding_model = ${indexSql(model).name} AND ${IN_SCOPE} AND ${IN_SEARCH}
      AND ${modelFilter(filters, freshRuns)}`;
}

function textRows(query: CandidateQuery): Prisma.Sql {
  return Prisma.sql`FROM text_embedding t
    JOIN product_model m ON m.id = t.model_id
    JOIN source s ON s.id = m.source_id
    WHERE t.embedding_model = ${textVectorsSql(query)} AND ${modelFilter(query.filters, query.freshRuns)}`;
}

// An exact list ranks its candidates in a materialized CTE: an ORDER BY over it cannot reach the HNSW index, and the
// sort is allowed (scanSettings), so every candidate's distance counts
function nearestSql({ scan, limit }: NearestQuery, columns: Prisma.Sql, rows: Prisma.Sql): Prisma.Sql {
  if (scan === "exact") {
    return Prisma.sql`
      WITH candidates AS MATERIALIZED (SELECT ${columns} ${rows})
      SELECT * FROM candidates ORDER BY distance LIMIT ${limit}`;
  }
  return Prisma.sql`
    SELECT ${columns} ${rows}
    ORDER BY distance LIMIT ${limit}`;
}

export function nearestPhotosSql(query: NearestQuery): Prisma.Sql {
  const { cast } = indexSql(query.model);
  return nearestSql(query, Prisma.sql`p.model_id AS "modelId", e.photo_id AS "photoId", e.image_sha256 AS "imageSha256",
      e.embedding::${cast} <=> ${vectorText(query.vector)}::${cast} AS distance`, photoRows(query));
}

export function nearestTextsSql(query: NearestQuery): Prisma.Sql {
  const { cast } = indexSql(query.model);
  return nearestSql(query, Prisma.sql`t.model_id AS "modelId",
      t.embedding::${cast} <=> ${vectorText(query.vector)}::${cast} AS distance`, textRows(query));
}

// A photo list ranks catalogue photos, a text list model texts
export type ListKind = "photo" | "text";

// The candidates of a list, counted up to upTo + 1: the count stops once the list would go through the index anyway
export function countCandidatesSql(kind: ListKind, query: CandidateQuery, upTo: number): Prisma.Sql {
  const rows = kind === "photo" ? photoRows(query) : textRows(query);
  return Prisma.sql`SELECT count(*)::integer AS candidates FROM (SELECT 1 ${rows} LIMIT ${upTo + 1}) c`;
}

// The driver's SQLSTATE of a failed raw query, under the error's meta
function sqlState(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const adapterError = error.meta?.driverAdapterError;
  const cause = isRecord(adapterError) ? adapterError.cause : undefined;
  return isRecord(cause) ? cause.originalCode : undefined;
}

// One query of a list in a transaction of its own, so its settings hold for it alone; the lists of a search run side
// by side, each within Prisma's 5 s for a transaction
async function readInTransaction<T>(db: PrismaClient, settings: Prisma.Sql, query: Prisma.Sql): Promise<T[]> {
  try {
    const [, rows] = await db.$transaction([db.$queryRaw(settings), db.$queryRaw<T[]>(query)]);
    return rows;
  } catch (error) {
    if (sqlState(error) === STATEMENT_TIMEOUT_CODE) throw new SearchTimedOut("a query of the search ran past its statement_timeout");
    throw error;
  }
}

export function readNearestPhotos(db: PrismaClient, query: NearestQuery): Promise<PhotoHit[]> {
  return readInTransaction<PhotoHit>(db, scanSettings(query), nearestPhotosSql(query));
}

export function readNearestTexts(db: PrismaClient, query: NearestQuery): Promise<TextHit[]> {
  return readInTransaction<TextHit>(db, scanSettings(query), nearestTextsSql(query));
}

// At most upTo + 1; SearchTimedOut past COUNT_TIMEOUT
export async function countCandidates(db: PrismaClient, kind: ListKind, query: CandidateQuery, upTo: number):
  Promise<number> {
  const [row] = await readInTransaction<{ candidates: unknown }>(db, timeoutSettings(COUNT_TIMEOUT),
    countCandidatesSql(kind, query, upTo));
  const candidates = row?.candidates;
  if (typeof candidates !== "number" || !Number.isInteger(candidates)) {
    throw new Error(`the count of ${kind} candidates returned ${JSON.stringify(row)}`);
  }
  return candidates;
}

export interface ModelRow {
  id: number;
  sourceCode: string;
  sourceName: string;
  code: string;
  name: string | null;
  category: unknown;
  coverPhotoUrl: string | null;
}

export interface VariantRow {
  modelId: number;
  sku: string;
  externalId: string | null;
  color: string | null;
  size: string | null;
  inStock: number | null;
  nextArrivalDate: string | null;
  nextArrivalQuantity: number | null;
  // The primary price as text (numeric(12,4)), never a float
  price: string | null;
  currency: string | null;
}

export interface PhotoRow {
  id: number;
  url: string;
  urlLarge: string | null;
  skus: string[];
}

// The models found, at most the search's limit, still active (an import may deactivate one between the reads); the
// cover is the first photo in the search (by variant position)
export async function readModels(db: PrismaClient, modelIds: number[]): Promise<ModelRow[]> {
  if (!modelIds.length) return [];
  return db.$queryRaw<ModelRow[]>`
    SELECT m.id, s.code AS "sourceCode", s.name AS "sourceName", m.code, m.name->>'en' AS name,
      m.category->'en' AS category,
      (SELECT p.url FROM photo p JOIN photo_variant pv ON pv.photo_id = p.id JOIN variant v ON v.id = pv.variant_id
        WHERE p.model_id = m.id AND p.is_active AND v.is_active ORDER BY pv.position, p.position, p.id LIMIT 1)
        AS "coverPhotoUrl"
    FROM product_model m JOIN source s ON s.id = m.source_id
    WHERE m.id IN (SELECT jsonb_array_elements_text(${jsonParam(modelIds)}::jsonb)::integer) AND m.is_active`;
}

// What the conditions of a query are held against (src/search/conditions.ts): the models shown, for their cards, and
// with the demotion on the rows of its lists too; bounded by those
export async function readModelFacts(db: PrismaClient, modelIds: number[]): Promise<Map<number, ModelFacts>> {
  if (!modelIds.length) return new Map();
  const rows = await db.$queryRaw<{
    id: number; volumeMl: number | null; materials: string[]; sizesCm: number[]; printTechniques: string[]; sheets: number | null; gsm: number | null;
  }[]>`
    SELECT id, volume_ml AS "volumeMl", materials, sizes_cm::float8[] AS "sizesCm", print_techniques AS "printTechniques", sheets, gsm
    FROM product_model
    WHERE id = ANY(${modelIds}::integer[])`;
  return new Map(rows.map(({ id, volumeMl, materials, sizesCm, printTechniques, sheets, gsm }) =>
    [id, { volumeMl, materials: materials.filter(isMaterialCode), sizesCm, printTechniques: printTechniques.filter(isPrintFact), sheets, gsm }]));
}

// The colour names of the given models' active variants; one read per search, bounded by the rows of its lists
export async function readModelColors(db: PrismaClient, modelIds: number[]): Promise<Map<number, string[]>> {
  if (!modelIds.length) return new Map();
  const rows = await db.$queryRaw<{ modelId: number; colors: string[] }[]>`
    SELECT v.model_id AS "modelId", array_agg(DISTINCT v.color->>'en') FILTER (WHERE v.color->>'en' IS NOT NULL) AS colors
    FROM variant v WHERE v.model_id = ANY(${modelIds}::integer[]) AND v.is_active GROUP BY v.model_id`;
  return new Map(rows.map(({ modelId, colors }) => [modelId, colors ?? []]));
}

// The given models that the categories cover, by the same mapping as the filter; one read per search, bounded by the
// rows of its lists
export async function readModelsInCategories(db: PrismaClient, modelIds: number[], categoryIds: number[]): Promise<Set<number>> {
  if (!modelIds.length) return new Set();
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT m.id FROM product_model m
    WHERE m.id = ANY(${modelIds}::integer[]) AND EXISTS (SELECT 1 FROM source_category sc
      WHERE sc.source_id = m.source_id AND sc.path = m.category->'en'
        AND sc.category_id = ANY(${categoryIds}::integer[]))`;
  return new Set(rows.map((row) => row.id));
}

export async function readSourceCodes(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ code: string }[]>`SELECT code FROM source`;
  return rows.map((row) => row.code);
}

export interface SharedCategoryCode {
  code: string;
  // One row per category the code stands for: its own id, or each of a group's; null for a group without categories
  categoryId: number | null;
}

// The active codes among those asked for, with their categories (a code the list does not have has no row)
export async function readSharedCategoryIds(db: PrismaClient, codes: string[]): Promise<SharedCategoryCode[]> {
  return db.$queryRaw<SharedCategoryCode[]>`
    SELECT g.code, c.id AS "categoryId" FROM category g
    LEFT JOIN category c ON c.is_active AND c.parent_id IS NOT NULL AND (c.id = g.id OR c.parent_id = g.id)
    WHERE g.is_active AND g.code IN (SELECT jsonb_array_elements_text(${jsonParam(codes)}::jsonb))`;
}

// Active variants of the models found, with fresh stock (none: inStock null) and the primary price: bounded by the
// models (tens of variants each)
export async function readVariants(db: PrismaClient, modelIds: number[], freshRuns: FreshRuns): Promise<VariantRow[]> {
  if (!modelIds.length) return [];
  return db.$queryRaw<VariantRow[]>`
    SELECT v.model_id AS "modelId", v.sku, v.external_id AS "externalId", v.color->>'en' AS color, v.size,
      st.in_stock AS "inStock",
      st.next_arrival_date::text AS "nextArrivalDate", st.next_arrival_quantity AS "nextArrivalQuantity",
      pr.amount::text AS price, pr.currency
    FROM variant v
    LEFT JOIN stock st ON st.variant_id = v.id AND ${freshStock(freshRuns)}
    LEFT JOIN price pr ON pr.variant_id = v.id AND pr.is_primary AND pr.is_active
    WHERE v.model_id IN (SELECT jsonb_array_elements_text(${jsonParam(modelIds)}::jsonb)::integer) AND v.is_active
    ORDER BY v.model_id, v.sku`;
}

// The matched photos with the variants (SKUs) that show them
export async function readPhotos(db: PrismaClient, photoIds: number[]): Promise<PhotoRow[]> {
  if (!photoIds.length) return [];
  return db.$queryRaw<PhotoRow[]>`
    SELECT p.id, p.url, p.url_large AS "urlLarge",
      array(SELECT v.sku FROM photo_variant pv JOIN variant v ON v.id = pv.variant_id
        WHERE pv.photo_id = p.id AND v.is_active ORDER BY v.sku) AS skus
    FROM photo p WHERE p.id IN (SELECT jsonb_array_elements_text(${jsonParam(photoIds)}::jsonb)::integer)`;
}

export interface SourceOption {
  code: string;
  name: string;
  // false: no active variant has fresh stock, so minStock leaves out every model of the source (Macma and Easy Gifts,
  // whose feeds have none, 2026-11-05)
  hasStock: boolean;
}

export interface CategoryOption {
  source: string;
  path: string[];
  models: number;
}

export interface SharedCategoryOption {
  code: string;
  name: CategoryName;
  models: number;
}

export interface SharedGroupOption extends SharedCategoryOption {
  categories: SharedCategoryOption[];
}

interface SharedCategoryRow extends SharedCategoryOption {
  // null for a group
  groupCode: string | null;
}

// The rows come groups first, then categories in their groups' order; a group counts its categories' models (a model
// is in one category at most)
export function sharedCategoryTree(rows: SharedCategoryRow[]): SharedGroupOption[] {
  const groups = new Map<string, SharedGroupOption>();
  for (const { groupCode, ...option } of rows) {
    if (groupCode === null) {
      groups.set(option.code, { ...option, models: 0, categories: [] });
      continue;
    }
    const group = groups.get(groupCode);
    if (!group) continue;
    group.categories.push(option);
    group.models += option.models;
  }
  return [...groups.values()];
}

function pathOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

export interface FilterOptions {
  sources: SourceOption[];
  categories: CategoryOption[];
  sharedCategories: SharedGroupOption[];
  // The paths of active models that no mapping covers (WORKER=categories reports them too); [] for no English category
  unmappedCategories: CategoryOption[];
}

interface PathCountRow {
  source: string;
  path: unknown;
  // null: no mapping covers the path
  categoryId: number | null;
  models: number;
}

type CategoryListRow = Omit<SharedCategoryRow, "models"> & { id: number };

// One count of active models per source path serves the three lists, so product_model is read once
export function filterOptions(sources: SourceOption[], categoryRows: CategoryListRow[], paths: PathCountRow[]):
  FilterOptions {
  const modelsByCategory = new Map<number, number>();
  for (const row of paths) {
    if (row.categoryId !== null) modelsByCategory.set(row.categoryId, (modelsByCategory.get(row.categoryId) ?? 0) + row.models);
  }
  const option = ({ source, path, models }: PathCountRow) => ({ source, path: pathOf(path), models });
  return {
    sources,
    categories: paths.filter((row) => Array.isArray(row.path)).map(option),
    sharedCategories: sharedCategoryTree(categoryRows.map(({ id, ...row }) => ({ ...row, models: modelsByCategory.get(id) ?? 0 }))),
    unmappedCategories: paths.filter((row) => row.categoryId === null).map(option),
  };
}

// For the filters: sources, the English category paths of active models and the shared categories, with counts of
// active models (hundreds of rows). A source has stock by the same fresh rows as the minStock filter (45 ms, 2026-11-06).
export async function readOptions(db: PrismaClient): Promise<FilterOptions> {
  const freshRuns = await readFreshRuns(db);
  const [sources, categoryRows, paths] = await Promise.all([
    db.$queryRaw<SourceOption[]>`
      SELECT s.code, s.name, EXISTS (SELECT 1 FROM variant v JOIN stock st ON st.variant_id = v.id
        WHERE v.source_id = s.id AND v.is_active AND ${freshStock(freshRuns)}) AS "hasStock"
      FROM source s ORDER BY s.code`,
    db.$queryRaw<CategoryListRow[]>`
      SELECT c.id, c.code, p.code AS "groupCode", c.name
      FROM category c LEFT JOIN category p ON p.id = c.parent_id
      WHERE c.is_active ORDER BY p.position NULLS FIRST, c.position`,
    db.$queryRaw<PathCountRow[]>`
      SELECT s.code AS source, m.category->'en' AS path, sc.category_id AS "categoryId", count(*)::integer AS models
      FROM product_model m JOIN source s ON s.id = m.source_id
      LEFT JOIN source_category sc ON sc.source_id = m.source_id AND sc.path = m.category->'en'
      WHERE m.is_active GROUP BY s.code, m.category->'en', sc.category_id ORDER BY s.code, m.category->'en'`,
  ]);
  return filterOptions(sources, categoryRows, paths);
}
