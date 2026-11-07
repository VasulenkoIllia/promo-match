// The «Постачальники» screen (docs/integrations.md, «Постачальники»): per supplier what the database holds of its
// catalogue, its last import, its stock, the vectors of the search's default model and its shared categories. Read
// only, and by the same rules as the code that acts on them: the photos and texts are counted by the embeddings
// worker's own reads (photoTotals, readTextPlan), the stock is fresh by the minStock filter's rule (freshStock), a model
// is in a shared category by the search filter's mapping (source_category on the whole English path).
import type { PrismaClient } from "../generated/prisma/client.js";
import { photoTotals, type PhotoTotals } from "../embeddings/store.js";
import { readTextPlan, type TextPlan } from "../embeddings/texts.js";
import { DEFAULT_SEARCH_MODEL } from "../search/models.js";
import { type FreshRuns, freshStock } from "../search/store.js";
import { isRecord } from "./normalize.js";

export type RunStatus = "running" | "succeeded" | "failed";

export interface RunSummary {
  status: RunStatus;
  // ISO times
  startedAt: string;
  finishedAt: string | null;
}

export interface ModelChanges {
  created: number;
  changed: number;
  // Missing from the feed: the models the import deactivated
  missing: number;
  reactivated: number;
}

export interface ImportSummary extends RunSummary {
  // What a succeeded import did to the models; null for a run that failed or has not ended, whose plan may be written
  // in part only
  models: ModelChanges | null;
}

export interface TextTotals {
  // Active models
  models: number;
  // With a vector of the model's present text
  ready: number;
  // With a vector of a text the model no longer has: the next run makes it again
  stale: number;
  missing: number;
  // No English name: nothing to embed
  withoutText: number;
}

export interface SupplierStatus {
  code: string;
  name: string;
  // Active models, their active variants, the active photos of active models
  catalog: { models: number; variants: number; photos: number };
  // The last catalogue import, whatever its end
  lastImport: ImportSummary | null;
  // The last import that succeeded: the search takes stock and the minStock filter by it
  lastSucceededAt: string | null;
  // Active variants with a fresh stock row; 0 for a feed without stock (Macma and Easy Gifts)
  stock: { variants: number };
  vectors: { photos: PhotoTotals; texts: TextTotals; lastRun: RunSummary | null };
  // Distinct English paths of active models; those no mapping covers; active models outside every shared category,
  // those without an English path included
  categories: { paths: number; pathsWithout: number; modelsWithout: number };
}

export interface SuppliersOverview {
  // The embedding model the vectors are counted for: the one the search screen uses
  model: string;
  suppliers: SupplierStatus[];
}

export interface SuppliersService {
  overview(): Promise<SuppliersOverview>;
}

export interface SourceRow {
  id: number;
  code: string;
  name: string;
}

export interface RunRow {
  sourceId: number;
  kind: "catalog" | "embed";
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  counts: unknown;
}

// The last succeeded import of a source
export interface SucceededRow {
  sourceId: number;
  id: number;
  finishedAt: Date;
}

export interface CountRow {
  sourceId: number;
  models?: number;
  variants?: number;
  withStock?: number;
  photos?: number;
  paths?: number;
  pathsWithout?: number;
  modelsWithout?: number;
}

export interface SourceVectors {
  photos: PhotoTotals;
  texts: TextPlan;
}

export interface OverviewRows {
  sources: SourceRow[];
  // The last run of each kind per source
  lastRuns: RunRow[];
  lastSucceeded: SucceededRow[];
  counts: CountRow[];
  vectors: Map<number, SourceVectors>;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Of a succeeded import (src/import/run.ts): it wrote every row of its plan (counts.plan.models) and deactivated the
// models missing from a complete feed (counts.deactivated.models). An incomplete feed ends the run as failed.
export function modelChanges(counts: unknown): ModelChanges | null {
  const models = isRecord(counts) && isRecord(counts.plan) ? counts.plan.models : undefined;
  const deactivated = isRecord(counts) ? counts.deactivated : undefined;
  if (!isRecord(models) || !isRecord(deactivated)) return null;
  return { created: count(models.created), changed: count(models.changed), missing: count(deactivated.models),
    reactivated: count(models.reactivated) };
}

function runSummary(run: RunRow): RunSummary {
  return { status: run.status, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null };
}

export function textTotals(plan: TextPlan): TextTotals {
  return { models: plan.total, ready: plan.unchanged, stale: plan.changed.length, missing: plan.created.length,
    withoutText: plan.withoutText.length };
}

const NO_PHOTOS: PhotoTotals = { inScope: 0, ready: 0, failed: 0, pending: 0 };

export function supplierOverview(rows: OverviewRows): SuppliersOverview {
  const sum = (sourceId: number, key: Exclude<keyof CountRow, "sourceId">) =>
    rows.counts.filter((row) => row.sourceId === sourceId).reduce((total, row) => total + count(row[key]), 0);
  const lastOf = (list: RunRow[], sourceId: number, kind: RunRow["kind"]) =>
    list.find((run) => run.sourceId === sourceId && run.kind === kind);

  const suppliers = rows.sources.map(({ id, code, name }): SupplierStatus => {
    const lastImport = lastOf(rows.lastRuns, id, "catalog");
    const lastEmbed = lastOf(rows.lastRuns, id, "embed");
    const succeeded = rows.lastSucceeded.find((run) => run.sourceId === id);
    const vectors = rows.vectors.get(id);
    return {
      code,
      name,
      catalog: { models: sum(id, "models"), variants: sum(id, "variants"), photos: sum(id, "photos") },
      lastImport: lastImport ? {
        ...runSummary(lastImport), models: lastImport.status === "succeeded" ? modelChanges(lastImport.counts) : null,
      } : null,
      lastSucceededAt: succeeded?.finishedAt.toISOString() ?? null,
      stock: { variants: sum(id, "withStock") },
      vectors: {
        photos: vectors?.photos ?? NO_PHOTOS,
        texts: vectors ? textTotals(vectors.texts) : { models: 0, ready: 0, stale: 0, missing: 0, withoutText: 0 },
        lastRun: lastEmbed ? runSummary(lastEmbed) : null,
      },
      categories: { paths: sum(id, "paths"), pathsWithout: sum(id, "pathsWithout"), modelsWithout: sum(id, "modelsWithout") },
    };
  });
  return { model: DEFAULT_SEARCH_MODEL, suppliers };
}

// Bounded by the number of sources: a few grouped counts, then the worker's two reads per source (about 15 thousand
// models and 100 thousand photos in all, 2026-11-07)
async function readOverviewRows(db: PrismaClient): Promise<OverviewRows> {
  const model = DEFAULT_SEARCH_MODEL;
  const [sources, lastRuns, lastSucceeded] = await Promise.all([
    db.$queryRaw<SourceRow[]>`SELECT id, code, name FROM source WHERE kind = 'supplier' ORDER BY code`,
    // An embedding run names its provider when it ends: the last one of the default model, or the last import
    db.$queryRaw<RunRow[]>`
      SELECT DISTINCT ON (source_id, kind) source_id AS "sourceId", kind, status, started_at AS "startedAt",
        finished_at AS "finishedAt", counts
      FROM sync_run WHERE kind = 'catalog' OR (kind = 'embed' AND counts->>'provider' = ${model})
      ORDER BY source_id, kind, id DESC`,
    // The same run as readFreshRuns: the highest id of a succeeded import (finishRun sets its end)
    db.$queryRaw<SucceededRow[]>`
      SELECT DISTINCT ON (source_id) source_id AS "sourceId", id, finished_at AS "finishedAt"
      FROM sync_run WHERE kind = 'catalog' AND status = 'succeeded' AND finished_at IS NOT NULL
      ORDER BY source_id, id DESC`,
  ]);
  const freshRuns: FreshRuns = Object.fromEntries(lastSucceeded.map((run) => [run.sourceId, run.id]));
  const [models, variants, photos, categories, vectors] = await Promise.all([
    db.$queryRaw<CountRow[]>`
      SELECT source_id AS "sourceId", count(*)::integer AS models FROM product_model WHERE is_active GROUP BY source_id`,
    db.$queryRaw<CountRow[]>`
      SELECT v.source_id AS "sourceId", count(*)::integer AS variants,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock st WHERE st.variant_id = v.id AND ${freshStock(freshRuns)}))::integer
          AS "withStock"
      FROM variant v JOIN product_model m ON m.id = v.model_id
      WHERE v.is_active AND m.is_active GROUP BY v.source_id`,
    db.$queryRaw<CountRow[]>`
      SELECT m.source_id AS "sourceId", count(*)::integer AS photos
      FROM photo p JOIN product_model m ON m.id = p.model_id
      WHERE p.is_active AND m.is_active GROUP BY m.source_id`,
    db.$queryRaw<CountRow[]>`
      SELECT m.source_id AS "sourceId",
        count(DISTINCT m.category->'en') FILTER (WHERE jsonb_typeof(m.category->'en') = 'array')::integer AS paths,
        count(DISTINCT m.category->'en')
          FILTER (WHERE jsonb_typeof(m.category->'en') = 'array' AND sc.category_id IS NULL)::integer AS "pathsWithout",
        count(*) FILTER (WHERE sc.category_id IS NULL)::integer AS "modelsWithout"
      FROM product_model m
      LEFT JOIN source_category sc ON sc.source_id = m.source_id AND sc.path = m.category->'en'
      WHERE m.is_active GROUP BY m.source_id`,
    Promise.all(sources.map(async ({ id }) => {
      const [photoCounts, texts] = await Promise.all([
        photoTotals(db, id, model), readTextPlan({ db, sourceId: id }, model),
      ]);
      return [id, { photos: photoCounts, texts }] as const;
    })),
  ]);
  return { sources, lastRuns, lastSucceeded, counts: [...models, ...variants, ...photos, ...categories],
    vectors: new Map(vectors) };
}

export function createSuppliersService(db: PrismaClient): SuppliersService {
  return {
    async overview() {
      return supplierOverview(await readOverviewRows(db));
    },
  };
}
