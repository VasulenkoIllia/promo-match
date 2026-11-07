// The import's writes: batches of rows as one jsonb parameter each (jsonb_to_recordset), upserted by the supplier's
// codes with the database ids joined in SQL, so the number of statements does not grow with the batch. Each
// statement commits on its own: a failed import leaves rows it already wrote, never marks anything inactive, and the
// next run brings it in line (docs/integrations.md, «Імпорт каталогів»).
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { renewLease } from "./lock.js";
import type { ImportRows, LinkRow, ModelRow, PhotoRow, PriceRow, RawRow, StockRow, TechniqueRow, VariantRow } from "./rows.js";

export interface WriteCounts {
  written: number;
  created: number;
  changed: number;
  reactivated: number;
}

type WrittenEntity = "models" | "variants" | "photos" | "links" | "prices" | "stock" | "techniques" | "raw";
// Filled as the batches go, so a failed import still reports what it wrote
export type WrittenCounts = Partial<Record<WrittenEntity, WriteCounts>>;

// Rows per statement: a batch of raw records with long texts stays a few MB
const BATCH_SIZE: Record<WrittenEntity, number> = {
  models: 500, variants: 1_000, photos: 2_000, links: 5_000, prices: 2_000, stock: 2_000, techniques: 500, raw: 300,
};
// The deactivation is five statements over the source's rows in one transaction; a mass deactivation of a large
// catalogue takes seconds, far over Prisma's 5 s default
const DEACTIVATION_TIMEOUT_MS = 120_000;

interface CountRow {
  written: bigint;
  created: bigint;
  changed: bigint;
  reactivated: bigint;
}

// PG18 RETURNING old/new: old is null for an inserted row
const COUNTS = Prisma.sql`
  SELECT count(*) AS written,
    count(*) FILTER (WHERE is_new) AS created,
    count(*) FILTER (WHERE NOT is_new AND is_changed) AS changed,
    count(*) FILTER (WHERE is_reactivated) AS reactivated
  FROM upserted`;

// Postgres jsonb refuses \u0000 and a lone surrogate in a string; a supplier text with one would fail the batch.
// Cleaned on the values, so a text that holds the six characters \u0000 stays as it is.
export function jsonParam(rows: unknown[]): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "string" ? value.toWellFormed().replaceAll("\u0000", "") : value);
}

function emptyCounts(): WriteCounts {
  return { written: 0, created: 0, changed: 0, reactivated: 0 };
}

// Before each batch: the stop signal, then the lease renewed, so a slow write never outlives its lease
async function inBatches<T>(rows: T[], size: number, counts: WriteCounts, before: () => Promise<void>, label: string,
  write: (batch: T[]) => Promise<CountRow[]>): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    await before();
    const batch = rows.slice(start, start + size);
    const [row] = await write(batch);
    const written = Number(row?.written ?? 0);
    // A row whose model, photo or variant the join did not find would be lost without a word
    if (written !== batch.length) throw new Error(`${label}: ${batch.length - written} of ${batch.length} rows not written`);
    counts.written += written;
    counts.created += Number(row?.created ?? 0);
    counts.changed += Number(row?.changed ?? 0);
    counts.reactivated += Number(row?.reactivated ?? 0);
  }
}

function upsertModels(db: PrismaClient, sourceId: number, runId: number, batch: ModelRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO product_model AS t (source_id, code, external_id, name, description, category, category_code, material,
        brand, dimensions, weight_grams, country_of_origin, printing, attributes, volume_ml, materials, sizes_cm,
        print_techniques, sheets, gsm, content_hash, last_seen_run_id)
      SELECT ${sourceId}, x.code, x.external_id, x.name, x.description, x.category, x.category_code, x.material,
        x.brand, x.dimensions, x.weight_grams, x.country_of_origin, x.printing, x.attributes, x.volume_ml, x.materials,
        x.sizes_cm, x.print_techniques, x.sheets, x.gsm, x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(code text, external_id text, name jsonb, description jsonb,
        category jsonb, category_code text, material jsonb, brand text, dimensions text, weight_grams numeric,
        country_of_origin text, printing jsonb, attributes jsonb, volume_ml integer, materials text[], sizes_cm numeric[],
        print_techniques text[], sheets integer, gsm integer, content_hash text)
      ON CONFLICT (source_id, code) DO UPDATE SET
        external_id = excluded.external_id, name = excluded.name, description = excluded.description,
        category = excluded.category, category_code = excluded.category_code, material = excluded.material,
        brand = excluded.brand, dimensions = excluded.dimensions, weight_grams = excluded.weight_grams,
        country_of_origin = excluded.country_of_origin, printing = excluded.printing, attributes = excluded.attributes,
        volume_ml = excluded.volume_ml, materials = excluded.materials, sizes_cm = excluded.sizes_cm,
        print_techniques = excluded.print_techniques, sheets = excluded.sheets, gsm = excluded.gsm,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, is_active = true, deactivated_at = NULL,
        last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.id IS NULL AS is_new, old.content_hash IS DISTINCT FROM new.content_hash AS is_changed,
        old.is_active IS FALSE AS is_reactivated
    ) ${COUNTS}`;
}

function upsertVariants(db: PrismaClient, sourceId: number, runId: number, batch: VariantRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO variant AS t (source_id, model_id, sku, external_id, ean, color, color_code, color_group, size, status,
        printing, attributes, content_hash, last_seen_run_id)
      SELECT ${sourceId}, m.id, x.sku, x.external_id, x.ean, x.color, x.color_code, x.color_group, x.size, x.status,
        x.printing, x.attributes, x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(model_code text, sku text, external_id text, ean text,
        color jsonb, color_code text, color_group text, size text, status text, printing jsonb, attributes jsonb,
        content_hash text)
      JOIN product_model m ON m.source_id = ${sourceId} AND m.code = x.model_code
      ON CONFLICT (source_id, sku) DO UPDATE SET
        model_id = excluded.model_id, external_id = excluded.external_id, ean = excluded.ean, color = excluded.color,
        color_code = excluded.color_code, color_group = excluded.color_group, size = excluded.size,
        status = excluded.status, printing = excluded.printing, attributes = excluded.attributes,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash
          OR t.model_id IS DISTINCT FROM excluded.model_id THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, is_active = true, deactivated_at = NULL,
        last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.id IS NULL AS is_new,
        old.content_hash IS DISTINCT FROM new.content_hash OR old.model_id IS DISTINCT FROM new.model_id AS is_changed,
        old.is_active IS FALSE AS is_reactivated
    ) ${COUNTS}`;
}

// The embedding status of a known photo is left as it is
function upsertPhotos(db: PrismaClient, sourceId: number, runId: number, batch: PhotoRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO photo AS t (model_id, url, url_large, kind, position, content_hash, last_seen_run_id)
      SELECT m.id, x.url, x.url_large, x.kind, x.position, x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(model_code text, url text, url_large text, kind text,
        position integer, content_hash text)
      JOIN product_model m ON m.source_id = ${sourceId} AND m.code = x.model_code
      -- New photos get their ids in the catalogue's order, the same on every database
      ORDER BY m.id, x.position, x.url
      ON CONFLICT (model_id, url) DO UPDATE SET
        url_large = excluded.url_large, kind = excluded.kind, position = excluded.position,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, is_active = true, deactivated_at = NULL,
        last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.id IS NULL AS is_new, old.content_hash IS DISTINCT FROM new.content_hash AS is_changed,
        old.is_active IS FALSE AS is_reactivated
    ) ${COUNTS}`;
}

function upsertLinks(db: PrismaClient, sourceId: number, runId: number, batch: LinkRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO photo_variant AS t (photo_id, variant_id, position, last_seen_run_id)
      SELECT p.id, v.id, x.position, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(model_code text, url text, sku text, position integer)
      JOIN product_model m ON m.source_id = ${sourceId} AND m.code = x.model_code
      JOIN photo p ON p.model_id = m.id AND p.url = x.url
      JOIN variant v ON v.source_id = ${sourceId} AND v.sku = x.sku AND v.model_id = m.id
      ON CONFLICT (photo_id, variant_id) DO UPDATE SET
        position = excluded.position, last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.photo_id IS NULL AS is_new, old.position IS DISTINCT FROM new.position AS is_changed,
        false AS is_reactivated
    ) ${COUNTS}`;
}

function upsertPrices(db: PrismaClient, sourceId: number, runId: number, batch: PriceRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO price AS t (variant_id, kind, min_quantity, currency, amount, is_primary, valid_until, content_hash,
        last_seen_run_id)
      SELECT v.id, x.kind::price_kind, x.min_quantity, x.currency, x.amount, x.is_primary, x.valid_until,
        x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(sku text, kind text, min_quantity integer, currency text,
        amount numeric, is_primary boolean, valid_until date, content_hash text)
      JOIN variant v ON v.source_id = ${sourceId} AND v.sku = x.sku
      ON CONFLICT (variant_id, kind, min_quantity) DO UPDATE SET
        currency = excluded.currency, amount = excluded.amount, is_primary = excluded.is_primary,
        valid_until = excluded.valid_until,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, is_active = true, deactivated_at = NULL,
        last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.id IS NULL AS is_new, old.content_hash IS DISTINCT FROM new.content_hash AS is_changed,
        old.is_active IS FALSE AS is_reactivated
    ) ${COUNTS}`;
}

function upsertStock(db: PrismaClient, sourceId: number, runId: number, batch: StockRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO stock AS t (variant_id, in_stock, reserved, on_order, next_arrival_quantity, next_arrival_date,
        lead_time, arrivals, source_updated_at, content_hash, last_seen_run_id)
      SELECT v.id, x.in_stock, x.reserved, x.on_order, x.next_arrival_quantity, x.next_arrival_date, x.lead_time,
        x.arrivals, x.source_updated_at, x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(sku text, in_stock integer, reserved integer,
        on_order integer, next_arrival_quantity integer, next_arrival_date date, lead_time text, arrivals jsonb,
        source_updated_at timestamptz, content_hash text)
      JOIN variant v ON v.source_id = ${sourceId} AND v.sku = x.sku
      ON CONFLICT (variant_id) DO UPDATE SET
        in_stock = excluded.in_stock, reserved = excluded.reserved, on_order = excluded.on_order,
        next_arrival_quantity = excluded.next_arrival_quantity, next_arrival_date = excluded.next_arrival_date,
        lead_time = excluded.lead_time, arrivals = excluded.arrivals, source_updated_at = excluded.source_updated_at,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.variant_id IS NULL AS is_new, old.content_hash IS DISTINCT FROM new.content_hash AS is_changed,
        false AS is_reactivated
    ) ${COUNTS}`;
}

function upsertTechniques(db: PrismaClient, sourceId: number, runId: number, batch: TechniqueRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO print_technique AS t (source_id, code, name, content_hash, last_seen_run_id)
      SELECT ${sourceId}, x.code, x.name, x.content_hash, ${runId}
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(code text, name jsonb, content_hash text)
      ON CONFLICT (source_id, code) DO UPDATE SET
        name = excluded.name,
        updated_at = CASE WHEN t.content_hash IS DISTINCT FROM excluded.content_hash THEN now() ELSE t.updated_at END,
        content_hash = excluded.content_hash, last_seen_run_id = excluded.last_seen_run_id
      RETURNING old.id IS NULL AS is_new, old.content_hash IS DISTINCT FROM new.content_hash AS is_changed,
        false AS is_reactivated
    ) ${COUNTS}`;
}

// Only new and changed payloads reach this: an unchanged raw record is not rewritten
function upsertRaw(db: PrismaClient, sourceId: number, runId: number, batch: RawRow[]) {
  return db.$queryRaw<CountRow[]>`
    WITH upserted AS (
      INSERT INTO raw_record AS t (source_id, feed, external_id, payload, payload_hash, sync_run_id, fetched_at)
      SELECT ${sourceId}, x.feed, x.external_id, x.payload, x.payload_hash, ${runId}, now()
      FROM jsonb_to_recordset(${jsonParam(batch)}::jsonb) AS x(feed text, external_id text, payload jsonb,
        payload_hash text)
      ON CONFLICT (source_id, feed, external_id) DO UPDATE SET
        payload = excluded.payload, payload_hash = excluded.payload_hash, sync_run_id = excluded.sync_run_id,
        fetched_at = excluded.fetched_at
      RETURNING old.id IS NULL AS is_new, true AS is_changed, false AS is_reactivated
    ) ${COUNTS}`;
}

// In the order of their joins: models before the variants and photos that join them, photos and variants before
// their links. The counts go into written as each batch lands.
export async function writeRows(db: PrismaClient, sourceId: number, runId: number, rows: ImportRows, signal: AbortSignal,
  written: WrittenCounts): Promise<void> {
  const before = async () => {
    signal.throwIfAborted();
    await renewLease(db, sourceId, runId);
  };
  const batches = <T>(entity: WrittenEntity, items: T[],
    upsert: (db: PrismaClient, sourceId: number, runId: number, batch: T[]) => Promise<CountRow[]>) =>
    inBatches(items, BATCH_SIZE[entity], (written[entity] = emptyCounts()), before, entity,
      (batch) => upsert(db, sourceId, runId, batch));
  await batches("models", rows.models, upsertModels);
  await batches("variants", rows.variants, upsertVariants);
  await batches("photos", rows.photos, upsertPhotos);
  await batches("links", rows.links, upsertLinks);
  await batches("prices", rows.prices, upsertPrices);
  await batches("stock", rows.stock, upsertStock);
  await batches("techniques", rows.techniques, upsertTechniques);
  await batches("raw", rows.raw, upsertRaw);
}

export interface Deactivated {
  models: number;
  variants: number;
  photos: number;
  prices: number;
  links: number;
}

// After a complete import only: what it did not see is marked inactive, never deleted; photo links are derived from
// the feed and go. All or nothing, and only while the lease is still this run's. Rows a later run saw (a larger
// run id) are never touched.
export async function deactivateMissing(db: PrismaClient, sourceId: number, runId: number): Promise<Deactivated> {
  return db.$transaction(async (tx) => {
    await renewLease(tx, sourceId, runId);
    const models = await tx.$executeRaw`
      UPDATE product_model SET is_active = false, deactivated_at = now()
      WHERE source_id = ${sourceId} AND is_active AND last_seen_run_id < ${runId}`;
    const variants = await tx.$executeRaw`
      UPDATE variant SET is_active = false, deactivated_at = now()
      WHERE source_id = ${sourceId} AND is_active AND last_seen_run_id < ${runId}`;
    const photos = await tx.$executeRaw`
      UPDATE photo p SET is_active = false, deactivated_at = now() FROM product_model m
      WHERE p.model_id = m.id AND m.source_id = ${sourceId} AND p.is_active AND p.last_seen_run_id < ${runId}`;
    const prices = await tx.$executeRaw`
      UPDATE price p SET is_active = false, deactivated_at = now() FROM variant v
      WHERE p.variant_id = v.id AND v.source_id = ${sourceId} AND p.is_active AND p.last_seen_run_id < ${runId}`;
    const links = await tx.$executeRaw`
      DELETE FROM photo_variant pv USING variant v
      WHERE pv.variant_id = v.id AND v.source_id = ${sourceId} AND pv.last_seen_run_id < ${runId}`;
    return { models, variants, photos, prices, links };
  }, { timeout: DEACTIVATION_TIMEOUT_MS });
}
