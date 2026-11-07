// The embeddings worker's reads and writes. Vectors go in as text ('[0.1,...]') inside one jsonb parameter per batch
// (jsonb_to_recordset, as the import writes) and are cast to vector in SQL. A photo's vector and its status 'ready'
// are one statement, so they never disagree.
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { jsonParam } from "../import/write.js";
import type { ModelTextFields } from "./text.js";

// Decision 2026-10-29: the first 3 photos of each variant go into the search (photo_variant.position 0, 1, 2)
export const PHOTOS_PER_VARIANT = 3;
const MAX_ERROR_CHARS = 500;

export interface PhotoToEmbed {
  id: number;
  url: string;
}

// In the search: an active photo p of an active model m, among the first photos of an active variant. Also used by the
// sample comparison (scripts/compare-embeddings.ts).
export const IN_SCOPE = Prisma.sql`
  p.is_active AND m.is_active AND EXISTS (
    SELECT 1 FROM photo_variant pv JOIN variant v ON v.id = pv.variant_id
    WHERE pv.photo_id = p.id AND pv.position < ${PHOTOS_PER_VARIANT} AND v.is_active)`;

// Pictures of one model the search compares a query with, the same number for every model and source (decision
// 2026-10-30). A model ranks by its best photo, so every further picture is one more chance to rank high: a model with
// many colours has up to 160 of them against a median of 3, and such models were shown up to 1.5 times their share.
// 3 is the median model's number and the smallest that kept the photo search on the dev set of the independent test.
export const PHOTOS_PER_MODEL = 3;

// Of the photos in scope, those the search reads: a photo not ranked yet counts as in, so a new one is not lost until
// the next run
export const IN_SEARCH = Prisma.sql`coalesce(p.search_rank, 0) < ${PHOTOS_PER_MODEL}`;

// The next photos of a source with no vector of this model, in id order after afterId. Failed ones only on request.
export async function nextPhotos(db: PrismaClient, sourceId: number, embeddingModel: string, afterId: number,
  limit: number, isRetryFailed: boolean): Promise<PhotoToEmbed[]> {
  return db.$queryRaw<PhotoToEmbed[]>`
    SELECT p.id, p.url FROM photo p JOIN product_model m ON m.id = p.model_id
    WHERE m.source_id = ${sourceId} AND p.id > ${afterId} AND ${IN_SCOPE}
      AND (${isRetryFailed} OR p.status <> 'failed')
      AND NOT EXISTS (SELECT 1 FROM photo_embedding e WHERE e.photo_id = p.id AND e.embedding_model = ${embeddingModel})
    ORDER BY p.id LIMIT ${limit}`;
}

export interface PhotoTotals {
  inScope: number;
  ready: number;
  failed: number;
  pending: number;
}

export async function photoTotals(db: PrismaClient, sourceId: number, embeddingModel: string): Promise<PhotoTotals> {
  const [row] = await db.$queryRaw<{ in_scope: bigint; ready: bigint; failed: bigint }[]>`
    SELECT count(*) AS in_scope, count(e.photo_id) AS ready,
      count(*) FILTER (WHERE e.photo_id IS NULL AND p.status = 'failed') AS failed
    FROM photo p JOIN product_model m ON m.id = p.model_id
    LEFT JOIN photo_embedding e ON e.photo_id = p.id AND e.embedding_model = ${embeddingModel}
    WHERE m.source_id = ${sourceId} AND ${IN_SCOPE}`;
  const inScope = Number(row?.in_scope ?? 0);
  const ready = Number(row?.ready ?? 0);
  const failed = Number(row?.failed ?? 0);
  return { inScope, ready, failed, pending: inScope - ready - failed };
}

// Postgres' deadlock code. Photo rows are locked in id order before they are updated; the import's photo upsert locks
// them in catalogue order (model, position, url), so the two can still meet in a cycle. The writes here are idempotent
// and their batch is in memory, so a deadlock victim is written again instead of losing vectors already paid for.
const DEADLOCK = "40P01";
const WRITE_ATTEMPTS = 3;

async function withDeadlockRetry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= WRITE_ATTEMPTS || !(error instanceof Error && error.message.includes(DEADLOCK))) throw error;
    }
  }
}

// Photos whose bytes already have a vector of this model under another photo get a copy of it, with no call to the
// provider. Returns the ids that got one.
export async function reuseVectors(db: PrismaClient, embeddingModel: string,
  photos: { photoId: number; sha256: string }[]): Promise<Set<number>> {
  if (!photos.length) return new Set();
  const batch = jsonParam(photos.map(({ photoId, sha256 }) => ({ photo_id: photoId, sha256 })));
  const rows = await withDeadlockRetry(() => db.$queryRaw<{ photo_id: number }[]>`
    WITH reused AS (
      INSERT INTO photo_embedding (photo_id, embedding_model, embedding, image_sha256)
      SELECT x.photo_id, ${embeddingModel}, e.embedding, x.sha256
      FROM jsonb_to_recordset(${batch}::jsonb) AS x(photo_id integer, sha256 text)
      CROSS JOIN LATERAL (
        SELECT embedding FROM photo_embedding
        WHERE embedding_model = ${embeddingModel} AND image_sha256 = x.sha256 LIMIT 1) e
      ON CONFLICT (photo_id, embedding_model) DO NOTHING
      RETURNING photo_id
    ), locked AS (
      SELECT p.id FROM photo p JOIN reused r ON r.photo_id = p.id ORDER BY p.id FOR UPDATE OF p
    )
    UPDATE photo p SET status = 'ready', error = NULL, status_changed_at = now() FROM locked l
    WHERE p.id = l.id RETURNING p.id AS photo_id`);
  return new Set(rows.map((row) => row.photo_id));
}

// Ranks the photos of a source's models for the search, one rule for every source: the first view of each colour, then
// the second of each, and so on, the same picture once (a copy goes behind all the others). Only photos with a vector
// take a place: one the CDN never gave would push the model's real photos past the cap. Vectors stay for all of them, so
// a larger PHOTOS_PER_MODEL needs no new call. Runs after an import too: a colour gone must not leave a model with
// photos past the cap alone. Returns the photos whose place changed.
export async function refreshSearchRanks(db: PrismaClient, sourceId: number): Promise<number> {
  return withDeadlockRetry(() => db.$executeRaw`
    WITH shown AS (
      SELECT p.id, p.model_id, min(pv.position) AS view_index, min(v.sku) AS first_sku,
        (SELECT e.image_sha256 FROM photo_embedding e WHERE e.photo_id = p.id LIMIT 1) AS sha256
      FROM photo p JOIN product_model m ON m.id = p.model_id
      JOIN photo_variant pv ON pv.photo_id = p.id AND pv.position < ${PHOTOS_PER_VARIANT}
      JOIN variant v ON v.id = pv.variant_id AND v.is_active
      WHERE m.source_id = ${sourceId} AND ${IN_SCOPE}
        AND EXISTS (SELECT 1 FROM photo_embedding e WHERE e.photo_id = p.id)
      GROUP BY p.id, p.model_id
    ), copies AS (
      SELECT *, row_number() OVER (
        PARTITION BY model_id, coalesce(sha256, id::text) ORDER BY view_index, first_sku, id) AS copy
      FROM shown
    ), ranked AS (
      SELECT id, row_number() OVER (PARTITION BY model_id ORDER BY copy > 1, view_index, first_sku, id) - 1 AS search_rank
      FROM copies
    )
    UPDATE photo p SET search_rank = r.search_rank FROM ranked r
    WHERE p.id = r.id AND p.search_rank IS DISTINCT FROM r.search_rank`);
}

// pgvector keeps 4-byte floats: 9 significant digits are enough to keep each value, at about half the text
const VECTOR_DIGITS = 9;

export function vectorText(vector: number[]): string {
  return `[${vector.map((value) => Number(value.toPrecision(VECTOR_DIGITS))).join(",")}]`;
}

// Returns the photos marked ready; a row per photo, so a picture shared by two photos is written twice
export async function writePhotoVectors(db: PrismaClient, embeddingModel: string,
  rows: { photoId: number; vector: number[]; sha256: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const batch = jsonParam(rows.map((row) =>
    ({ photo_id: row.photoId, embedding: vectorText(row.vector), sha256: row.sha256 })));
  return withDeadlockRetry(() => db.$executeRaw`
    WITH written AS (
      INSERT INTO photo_embedding AS t (photo_id, embedding_model, embedding, image_sha256)
      SELECT x.photo_id, ${embeddingModel}, x.embedding::vector, x.sha256
      FROM jsonb_to_recordset(${batch}::jsonb) AS x(photo_id integer, embedding text, sha256 text)
      ON CONFLICT (photo_id, embedding_model) DO UPDATE SET
        embedding = excluded.embedding, image_sha256 = excluded.image_sha256, created_at = now()
      RETURNING t.photo_id
    ), locked AS (
      SELECT p.id FROM photo p JOIN written w ON w.photo_id = p.id ORDER BY p.id FOR UPDATE OF p
    )
    UPDATE photo p SET status = 'ready', error = NULL, status_changed_at = now() FROM locked l
    WHERE p.id = l.id`);
}

// The status describes the configured model: a photo another model refused is skipped until --retry-failed
export async function markPhotosFailed(db: PrismaClient, rows: { photoId: number; error: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const batch = jsonParam(rows.map((row) => ({ photo_id: row.photoId, error: row.error.slice(0, MAX_ERROR_CHARS) })));
  return withDeadlockRetry(() => db.$executeRaw`
    WITH x AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x(photo_id integer, error text)),
    locked AS (SELECT p.id FROM photo p JOIN x ON x.photo_id = p.id ORDER BY p.id FOR UPDATE OF p)
    UPDATE photo p SET status = 'failed', error = x.error, status_changed_at = now()
    FROM x JOIN locked l ON l.id = x.photo_id WHERE p.id = x.photo_id`);
}

// A photo the CDN did not give this time stays pending; its error says why, for whoever looks at a photo still pending
export async function notePhotosDeferred(db: PrismaClient, rows: { photoId: number; error: string }[]): Promise<void> {
  if (!rows.length) return;
  const batch = jsonParam(rows.map((row) =>
    ({ photo_id: row.photoId, error: `deferred: ${row.error}`.slice(0, MAX_ERROR_CHARS) })));
  await withDeadlockRetry(() => db.$executeRaw`
    WITH x AS (SELECT * FROM jsonb_to_recordset(${batch}::jsonb) AS x(photo_id integer, error text)),
    locked AS (SELECT p.id FROM photo p JOIN x ON x.photo_id = p.id ORDER BY p.id FOR UPDATE OF p)
    UPDATE photo p SET error = x.error FROM x JOIN locked l ON l.id = x.photo_id WHERE p.id = x.photo_id`);
}


export interface ModelTextRow extends ModelTextFields {
  id: number;
  code: string;
  // The hash of the text this model's vector was made from; null without a vector of this model
  textHash: string | null;
}

// Every active model of a source with its English fields; bounded by the source's catalogue (thousands of rows)
export async function readModelTexts(db: PrismaClient, sourceId: number, embeddingModel: string): Promise<ModelTextRow[]> {
  const rows = await db.$queryRaw<(Omit<ModelTextRow, "textHash"> & { text_hash: string | null })[]>`
    SELECT m.id, m.code, m.name->>'en' AS name, m.description->>'en' AS description, m.material->>'en' AS material,
      (g.name->>'en') || ' > ' || (c.name->>'en') AS "sharedCategory", t.text_hash,
      array(SELECT DISTINCT v.color->>'en' FROM variant v
        WHERE v.model_id = m.id AND v.is_active AND v.color->>'en' IS NOT NULL) AS colors
    FROM product_model m
    LEFT JOIN source_category sc ON sc.source_id = m.source_id AND sc.path = m.category->'en'
    LEFT JOIN category c ON c.id = sc.category_id
    LEFT JOIN category g ON g.id = c.parent_id
    LEFT JOIN text_embedding t ON t.model_id = m.id AND t.embedding_model = ${embeddingModel}
    WHERE m.source_id = ${sourceId} AND m.is_active ORDER BY m.id`;
  return rows.map(({ text_hash: textHash, ...row }) => ({ ...row, textHash }));
}

export async function writeTextVectors(db: PrismaClient, embeddingModel: string,
  rows: { modelId: number; vector: number[]; textHash: string }[]): Promise<number> {
  if (!rows.length) return 0;
  const batch = rows.map((row) => ({ model_id: row.modelId, embedding: vectorText(row.vector), text_hash: row.textHash }));
  return db.$executeRaw`
    INSERT INTO text_embedding AS t (model_id, embedding_model, embedding, text_hash)
    SELECT x.model_id, ${embeddingModel}, x.embedding::vector, x.text_hash
    FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(model_id integer, embedding text, text_hash text)
    ON CONFLICT (model_id, embedding_model) DO UPDATE SET
      embedding = excluded.embedding, text_hash = excluded.text_hash, updated_at = now()`;
}
