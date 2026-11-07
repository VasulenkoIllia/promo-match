// What the database already holds for a source, read once per import (one query per table, bounded by the source's
// catalogue), and the plan of the import against it
import type { PrismaClient } from "../generated/prisma/client.js";
import { type Entity, type EntityPlan, type Existing, type ImportRows, keyOf, keysOf, planEntity, repeatedKeys } from "./rows.js";

export type ExistingState = Record<Entity, Existing>;
export type ImportPlan = Record<Entity, EntityPlan>;

interface StateRow {
  key: string;
  hash: string;
  is_active: boolean;
}

function toExisting(rows: StateRow[]): Existing {
  return new Map(rows.map((row) => [row.key, { hash: row.hash, isActive: row.is_active }]));
}

export function emptyState(): ExistingState {
  return {
    models: new Map(), variants: new Map(), photos: new Map(), prices: new Map(), stock: new Map(), techniques: new Map(),
    raw: new Map(),
  };
}

// Composite keys are joined here, as keyOf joins them for the snapshot
export async function readState(db: PrismaClient, sourceId: number): Promise<ExistingState> {
  const models = await db.$queryRaw<StateRow[]>`
    SELECT code AS key, content_hash AS hash, is_active FROM product_model WHERE source_id = ${sourceId}`;
  const variants = await db.$queryRaw<StateRow[]>`
    SELECT sku AS key, content_hash AS hash, is_active FROM variant WHERE source_id = ${sourceId}`;
  const photos = await db.$queryRaw<(Omit<StateRow, "key"> & { code: string; url: string })[]>`
    SELECT m.code, p.url, p.content_hash AS hash, p.is_active
    FROM photo p JOIN product_model m ON m.id = p.model_id WHERE m.source_id = ${sourceId}`;
  const prices = await db.$queryRaw<(Omit<StateRow, "key"> & { sku: string; kind: string; min_quantity: number })[]>`
    SELECT v.sku, p.kind::text AS kind, p.min_quantity, p.content_hash AS hash, p.is_active
    FROM price p JOIN variant v ON v.id = p.variant_id WHERE v.source_id = ${sourceId}`;
  const stock = await db.$queryRaw<StateRow[]>`
    SELECT v.sku AS key, s.content_hash AS hash, true AS is_active
    FROM stock s JOIN variant v ON v.id = s.variant_id WHERE v.source_id = ${sourceId}`;
  const techniques = await db.$queryRaw<StateRow[]>`
    SELECT code AS key, content_hash AS hash, true AS is_active FROM print_technique WHERE source_id = ${sourceId}`;
  const raw = await db.$queryRaw<(Omit<StateRow, "key"> & { feed: string; external_id: string })[]>`
    SELECT feed, external_id, payload_hash AS hash, true AS is_active FROM raw_record WHERE source_id = ${sourceId}`;
  return {
    models: toExisting(models),
    variants: toExisting(variants),
    photos: toExisting(photos.map((row) => ({ ...row, key: keyOf(row.code, row.url) }))),
    prices: toExisting(prices.map((row) => ({ ...row, key: keyOf(row.sku, row.kind, row.min_quantity) }))),
    stock: toExisting(stock),
    techniques: toExisting(techniques),
    raw: toExisting(raw.map((row) => ({ ...row, key: keyOf(row.feed, row.external_id) }))),
  };
}

// Throws on a key met twice: Postgres would refuse the batch that holds both
export function planImport(state: ExistingState, rows: ImportRows): ImportPlan {
  const keys = keysOf(rows);
  const plan = (entity: Entity) => {
    const repeated = repeatedKeys(keys[entity]);
    if (repeated.length) {
      throw new Error(`${entity}: ${repeated.length} keys met twice, e.g. ${repeated.slice(0, 3).join(", ")}`);
    }
    return planEntity(state[entity], keys[entity]);
  };
  return {
    models: plan("models"), variants: plan("variants"), photos: plan("photos"), prices: plan("prices"), stock: plan("stock"),
    techniques: plan("techniques"), raw: plan("raw"),
  };
}

// The raw records worth writing: new ones and those whose payload changed
export function changedRaw(state: ExistingState, rows: ImportRows): ImportRows["raw"] {
  return rows.raw.filter((row) => state.raw.get(keyOf(row.feed, row.external_id))?.hash !== row.payload_hash);
}

export interface Totals {
  models: number;
  variants: number;
  photos: number;
  links: number;
  prices: number;
  stock: number;
  raw: number;
}

// Active rows of the source after the import (stock and photo links of active variants), and all its raw records,
// for the report
export async function readTotals(db: PrismaClient, sourceId: number): Promise<Totals> {
  const [row] = await db.$queryRaw<Record<keyof Totals, bigint>[]>`
    SELECT
      (SELECT count(*) FROM product_model WHERE source_id = ${sourceId} AND is_active) AS models,
      (SELECT count(*) FROM variant WHERE source_id = ${sourceId} AND is_active) AS variants,
      (SELECT count(*) FROM photo p JOIN product_model m ON m.id = p.model_id
        WHERE m.source_id = ${sourceId} AND p.is_active) AS photos,
      (SELECT count(*) FROM photo_variant pv JOIN variant v ON v.id = pv.variant_id
        WHERE v.source_id = ${sourceId} AND v.is_active) AS links,
      (SELECT count(*) FROM price p JOIN variant v ON v.id = p.variant_id
        WHERE v.source_id = ${sourceId} AND p.is_active) AS prices,
      (SELECT count(*) FROM stock s JOIN variant v ON v.id = s.variant_id
        WHERE v.source_id = ${sourceId} AND v.is_active) AS stock,
      (SELECT count(*) FROM raw_record WHERE source_id = ${sourceId}) AS raw`;
  if (!row) throw new Error("totals: no answer");
  return {
    models: Number(row.models), variants: Number(row.variants), photos: Number(row.photos), links: Number(row.links),
    prices: Number(row.prices), stock: Number(row.stock), raw: Number(row.raw),
  };
}
