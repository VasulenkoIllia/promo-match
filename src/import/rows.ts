// A catalogue snapshot as rows of the import's tables, keyed by the supplier's codes (the database ids are joined in
// SQL), each with a hash of its content, and the plan: what an import of these rows would create, change, bring back
// and mark inactive. Pure: the dry run and the import count the same way.
import { createHash } from "node:crypto";
import { specsOf } from "../suppliers/specs.js";
import type { CatalogSnapshot, ModelInput } from "../suppliers/types.js";

export interface ModelRow {
  code: string; external_id: string | null; name: unknown; description: unknown; category: unknown;
  category_code: string | null; material: unknown; brand: string | null; dimensions: string | null;
  weight_grams: string | null; country_of_origin: string | null; printing: unknown; attributes: unknown;
  volume_ml: number | null; materials: string[]; sizes_cm: number[]; print_techniques: string[]; sheets: number | null;
  gsm: number | null; content_hash: string;
}
export interface VariantRow {
  model_code: string; sku: string; external_id: string | null; ean: string | null; color: unknown;
  color_code: string | null; color_group: string | null; size: string | null; status: string | null;
  printing: unknown; attributes: unknown; content_hash: string;
}
export interface PhotoRow {
  model_code: string; url: string; url_large: string | null; kind: string | null; position: number; content_hash: string;
}
export interface LinkRow { model_code: string; url: string; sku: string; position: number }
export interface PriceRow {
  sku: string; kind: string; min_quantity: number; currency: string; amount: string; is_primary: boolean;
  valid_until: string | null; content_hash: string;
}
export interface StockRow {
  sku: string; in_stock: number; reserved: number | null; on_order: number | null; next_arrival_quantity: number | null;
  next_arrival_date: string | null; lead_time: string | null; arrivals: unknown; source_updated_at: string | null;
  content_hash: string;
}
export interface TechniqueRow { code: string; name: unknown; content_hash: string }
export interface RawRow { feed: string; external_id: string; payload: unknown; payload_hash: string }

export interface ImportRows {
  models: ModelRow[];
  variants: VariantRow[];
  photos: PhotoRow[];
  links: LinkRow[];
  prices: PriceRow[];
  stock: StockRow[];
  techniques: TechniqueRow[];
  raw: RawRow[];
}

// The entities the plan counts, each by its key
export type Entity = "models" | "variants" | "photos" | "prices" | "stock" | "techniques" | "raw";

// What the database holds for an entity: key -> hash, and whether the row is active
export type Existing = Map<string, { hash: string; isActive: boolean }>;

export interface EntityPlan {
  incoming: number;
  created: number;
  changed: number;
  unchanged: number;
  reactivated: number;
  // Active in the database, missing from the snapshot
  missing: number;
  // Active rows in the database before the import, the base of the mass deactivation check
  active: number;
}

const KEY_SEPARATOR = "\u0000";
// A complete catalogue that would mark more than this share of a source's active models, variants, photos or prices
// inactive is not trusted: the import stops before writing (--allow-mass-deactivation lets it through)
const MAX_DEACTIVATED_SHARE = 0.2;
const GUARDED: Entity[] = ["models", "variants", "photos", "prices"];
const PERCENT = 100;

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function keyOf(...parts: (string | number)[]): string {
  return parts.join(KEY_SEPARATOR);
}

// The whole row hashed, but for the fields named in exclude: the stock's source time is left out, so an hourly feed
// with the same quantities does not count as a change
function withHash<T extends object>(row: T, exclude: (keyof T)[] = []): T & { content_hash: string } {
  const content = Object.fromEntries(Object.entries(row).filter(([field]) => !exclude.includes(field as keyof T)));
  return { ...row, content_hash: hashOf(content) };
}

// A variant that lists the same picture twice keeps its first place
function addLinks(model: ModelInput, rows: ImportRows, linked: Set<string>): void {
  for (const photo of model.photos) {
    for (const link of photo.variantLinks) {
      const key = keyOf(model.code, photo.url, link.sku);
      if (linked.has(key)) continue;
      linked.add(key);
      rows.links.push({ model_code: model.code, url: photo.url, ...link });
    }
  }
}

export function rowsOf(snapshot: CatalogSnapshot): ImportRows {
  const rows: ImportRows = { models: [], variants: [], photos: [], links: [], prices: [], stock: [], techniques: [], raw: [] };
  const linked = new Set<string>();
  for (const model of snapshot.models) {
    const specs = specsOf(model);
    // Read from fields already hashed: a change of the parser alone is no change of the supplier's content
    rows.models.push(withHash({
      code: model.code, external_id: model.externalId, name: model.name, description: model.description,
      category: model.category, category_code: model.categoryCode, material: model.material, brand: model.brand,
      dimensions: model.dimensions, weight_grams: model.weightGrams, country_of_origin: model.countryOfOrigin,
      printing: model.printing, attributes: model.attributes,
      volume_ml: specs.volumeMl, materials: specs.materials, sizes_cm: specs.sizesCm,
      print_techniques: model.printTechniques, sheets: specs.sheets, gsm: specs.gsm,
    }, ["volume_ml", "materials", "sizes_cm", "print_techniques", "sheets", "gsm"]));
    for (const photo of model.photos) {
      rows.photos.push(withHash({
        model_code: model.code, url: photo.url, url_large: photo.urlLarge, kind: photo.kind, position: photo.position,
      }));
    }
    addLinks(model, rows, linked);
    for (const variant of model.variants) {
      rows.variants.push(withHash({
        model_code: model.code, sku: variant.sku, external_id: variant.externalId, ean: variant.ean, color: variant.color,
        color_code: variant.colorCode, color_group: variant.colorGroup, size: variant.size, status: variant.status,
        printing: variant.printing, attributes: variant.attributes,
      }));
      for (const price of variant.prices) {
        rows.prices.push(withHash({
          sku: variant.sku, kind: price.kind, min_quantity: price.minQuantity, currency: price.currency,
          amount: price.amount, is_primary: price.isPrimary, valid_until: price.validUntil,
        }));
      }
      const { stock } = variant;
      if (stock) {
        rows.stock.push(withHash({
          sku: variant.sku, in_stock: stock.inStock, reserved: stock.reserved, on_order: stock.onOrder,
          next_arrival_quantity: stock.nextArrivalQuantity, next_arrival_date: stock.nextArrivalDate,
          lead_time: stock.leadTime, arrivals: stock.arrivals, source_updated_at: stock.sourceUpdatedAt,
        }, ["source_updated_at"]));
      }
    }
  }
  rows.techniques = snapshot.techniques.map((technique) => withHash({ code: technique.code, name: technique.name }));
  rows.raw = snapshot.raw.map((raw) => ({
    feed: raw.feed, external_id: raw.externalId, payload: raw.payload, payload_hash: hashOf(raw.payload),
  }));
  return rows;
}

// The key of each row as the database's unique index has it
export function keysOf(rows: ImportRows): Record<Entity, { key: string; hash: string }[]> {
  return {
    models: rows.models.map((row) => ({ key: row.code, hash: row.content_hash })),
    variants: rows.variants.map((row) => ({ key: row.sku, hash: row.content_hash })),
    photos: rows.photos.map((row) => ({ key: keyOf(row.model_code, row.url), hash: row.content_hash })),
    prices: rows.prices.map((row) => ({ key: keyOf(row.sku, row.kind, row.min_quantity), hash: row.content_hash })),
    stock: rows.stock.map((row) => ({ key: row.sku, hash: row.content_hash })),
    techniques: rows.techniques.map((row) => ({ key: row.code, hash: row.content_hash })),
    raw: rows.raw.map((row) => ({ key: keyOf(row.feed, row.external_id), hash: row.payload_hash })),
  };
}

// A key met twice in one statement would make Postgres refuse the whole batch ("cannot affect row a second time")
export function repeatedKeys(incoming: { key: string }[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { key } of incoming) {
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return [...repeated];
}

export function planEntity(existing: Existing, incoming: { key: string; hash: string }[]): EntityPlan {
  const plan: EntityPlan = { incoming: incoming.length, created: 0, changed: 0, unchanged: 0, reactivated: 0, missing: 0, active: 0 };
  const seen = new Set<string>();
  for (const { key, hash } of incoming) {
    seen.add(key);
    const row = existing.get(key);
    if (!row) plan.created += 1;
    else if (row.hash !== hash) plan.changed += 1;
    else plan.unchanged += 1;
    if (row && !row.isActive) plan.reactivated += 1;
  }
  for (const [key, row] of existing) {
    if (!row.isActive) continue;
    plan.active += 1;
    if (!seen.has(key)) plan.missing += 1;
  }
  return plan;
}

// Share of active rows a complete import would mark inactive
export function deactivatedShare(plan: EntityPlan): number {
  return plan.active ? plan.missing / plan.active : 0;
}

// Why a complete import may not mark this much inactive, or undefined: a feed cut short by the supplier (an empty
// price list, photos gone from every record) must not empty the catalogue
export function massDeactivation(plan: Record<Entity, EntityPlan>): string | undefined {
  for (const entity of GUARDED) {
    const share = deactivatedShare(plan[entity]);
    if (share > MAX_DEACTIVATED_SHARE) {
      return `${plan[entity].missing} of ${plan[entity].active} active ${entity} (${Math.round(share * PERCENT)}%) would be`
        + ` marked inactive, over ${MAX_DEACTIVATED_SHARE * PERCENT}%: check the feed, or run with --allow-mass-deactivation`;
    }
  }
  return undefined;
}
