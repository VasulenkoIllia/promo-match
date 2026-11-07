// Midocean feeds in the shared model: products is an array of models with variants; prices and stock join by sku,
// printing by master_code. Each feed is a full dump.
import { Checks, compareCodes, hasLeftoverEntity } from "../checks.js";
import { FeedError } from "../errors.js";
import {
  cleanText, isBlank, isRecord, localized, parseDate, parseDecimal, parseGrams, parseInteger, parseMinQuantity, parseTimestamp,
  parseUrl, rawRecords, restOf,
} from "../normalize.js";
import type {
  ArrivalInput, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, PrintTechniqueInput, StockInput, VariantInput,
} from "../types.js";
import { midoceanPrintTechniques } from "./print-names.js";

// The catalogue is read in English only (docs/integrations.md)
const LANGUAGE = "en";
const GRAMS_PER_KILOGRAM_PLACES = 3;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MODEL_FIELDS = new Set([
  "master_code", "master_id", "product_name", "long_description", "material", "brand", "country_of_origin",
  "dimensions", "net_weight", "net_weight_unit", "category_code", "digital_assets", "variants",
]);
const VARIANT_FIELDS = new Set([
  "variant_id", "sku", "gtin", "color_description", "color_code", "color_group", "size_textile",
  "plc_status_description", "category_level1", "category_level2", "category_level3", "digital_assets",
]);

export interface MidoceanFeeds {
  products: unknown;
  stock: unknown;
  pricelist: unknown;
  printdata: unknown;
}

type Rows = Record<string, unknown>[];

// The records a feed carries, at its root or in one of its fields. Every feed is required: an empty one would mark
// the whole catalogue, its prices or its stock inactive, so it stops the import instead.
function feedRecords(value: unknown, field: string | null, feed: string, checks: Checks): Rows {
  const rows = field === null ? value : isRecord(value) ? value[field] : undefined;
  if (!Array.isArray(rows)) throw new FeedError(`${feed}: no array of records${field ? ` in ${field}` : ""}`);
  const records = checks.records(rows, `${feed} records`);
  if (!records.length) throw new FeedError(`${feed}: no records`);
  return records;
}

// The first record per key; a repeated key is counted, not kept
function byKey(rows: Rows, field: string, checks: Checks, feed: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = cleanText(row[field]);
    if (!key) checks.add(`${feed} records without ${field}`);
    else if (result.has(key)) checks.add(`${feed} records with a repeated ${field}`, key);
    else result.set(key, row);
  }
  return result;
}

function weightGrams(model: Record<string, unknown>, code: string, checks: Checks): string | null {
  const unit = cleanText(model.net_weight_unit)?.toLowerCase();
  const places = unit === "kg" ? GRAMS_PER_KILOGRAM_PLACES : unit === "g" ? 0 : null;
  if (places === null) {
    if (!isBlank(model.net_weight)) checks.add("weights with an unknown unit", code);
    return null;
  }
  return checks.read("weights", model.net_weight, (value) => parseGrams(value, places), code);
}

// The base price from quantity 1 is primary; a scale adds a price from a larger quantity on
export function midoceanPrices(row: Record<string, unknown> | undefined, currency: string, checks: Checks): PriceInput[] {
  if (!row) return [];
  const sku = cleanText(row.sku) ?? undefined;
  const validUntil = checks.read("price dates", row.valid_until, parseDate, sku);
  const prices: PriceInput[] = [];
  const base = checks.amount("prices", row.price, sku);
  if (base !== null) prices.push({ kind: "net", currency, minQuantity: 1, amount: base, isPrimary: true, validUntil });
  for (const step of checks.records(row.scale, "price scale steps", sku)) {
    const minQuantity = checks.read("scale quantities", step.minimum_quantity, parseMinQuantity, sku);
    const amount = checks.amount("scale prices", step.price, sku);
    if (minQuantity === null || amount === null || prices.some((price) => price.minQuantity === minQuantity)) continue;
    prices.push({ kind: "net", currency, minQuantity, amount, isPrimary: false, validUntil });
  }
  return prices;
}

export function midoceanStock(row: Record<string, unknown> | undefined, updatedAt: string | null, checks: Checks):
  StockInput | null {
  if (!row) return null;
  const sku = cleanText(row.sku) ?? undefined;
  const inStock = checks.read("stock quantities", row.qty, parseInteger, sku);
  if (inStock === null) return null;
  const arrivals: ArrivalInput[] = [
    { date: row.first_arrival_date, quantity: row.first_arrival_qty },
    { date: row.next_arrival_date, quantity: row.next_arrival_qty },
  ].map((arrival) => ({
    date: checks.read("arrival dates", arrival.date, parseDate, sku),
    quantity: checks.read("arrival quantities", arrival.quantity, parseInteger, sku),
  })).filter((arrival) => arrival.date !== null || arrival.quantity !== null);
  return {
    inStock, reserved: null, onOrder: null,
    nextArrivalQuantity: arrivals[0]?.quantity ?? null, nextArrivalDate: arrivals[0]?.date ?? null,
    leadTime: null, arrivals, sourceUpdatedAt: updatedAt,
  };
}

function printingOf(row: Record<string, unknown> | undefined, code: string, checks: Checks): unknown {
  if (!row) return null;
  return {
    manipulation: cleanText(row.print_manipulation),
    template: parseUrl(row.print_template),
    colorCodes: Array.isArray(row.item_color_numbers) ? row.item_color_numbers.map(cleanText).filter(Boolean) : [],
    positions: checks.records(row.printing_positions, "print positions", code).map((position) => ({
      id: cleanText(position.position_id),
      type: cleanText(position.print_position_type),
      category: cleanText(position.category),
      unit: cleanText(position.print_size_unit),
      maxWidth: checks.read("print sizes", position.max_print_size_width, parseDecimal, code),
      maxHeight: checks.read("print sizes", position.max_print_size_height, parseDecimal, code),
      techniques: checks.records(position.printing_techniques, "print position techniques", code).map((technique) => ({
        code: cleanText(technique.id), isDefault: technique.default === true,
        maxColours: checks.read("print colour counts", technique.max_colours, parseInteger, code),
      })),
    })),
  };
}

// A repeated technique id is counted and its first record kept, like any other repeated key
export function midoceanTechniques(printdata: unknown, checks: Checks): PrintTechniqueInput[] {
  const rows = checks.records(isRecord(printdata) ? printdata.printing_technique_descriptions : undefined, "print techniques");
  return [...byKey(rows, "id", checks, "print techniques")].map(([code, row]) => {
    const names = checks.records(row.name, "print technique names", code);
    return { code, name: localized(Object.fromEntries(names.flatMap((name) => Object.entries(name)))) };
  });
}

function assetsOf(record: Record<string, unknown>, code: string, checks: Checks): Rows {
  return checks.records(record.digital_assets, "digital assets", code);
}

interface Joined {
  prices: Map<string, Record<string, unknown>>;
  stock: Map<string, Record<string, unknown>>;
  printing: Map<string, Record<string, unknown>>;
  techniques: PrintTechniqueInput[];
  currency: string;
  stockUpdatedAt: string | null;
  seenSkus: Set<string>;
}

function addPhoto(photos: Map<string, PhotoInput>, asset: Record<string, unknown>, link?: { sku: string; position: number }) {
  const url = parseUrl(asset.url);
  if (!url) return false;
  let photo = photos.get(url);
  if (!photo) {
    photo = { url, urlLarge: parseUrl(asset.url_highress), kind: cleanText(asset.subtype), position: photos.size, variantLinks: [] };
    photos.set(url, photo);
  }
  if (link) photo.variantLinks.push(link);
  return true;
}

function variantOf(row: Record<string, unknown>, sku: string, joined: Joined, photos: Map<string, PhotoInput>,
  checks: Checks): VariantInput {
  const images = assetsOf(row, sku, checks).filter((asset) => asset.type === "image");
  images.forEach((asset, position) => {
    if (!addPhoto(photos, asset, { sku, position })) checks.add("photo links that are not https URLs", sku);
  });
  if (!images.length) checks.add("variants without photos", sku);
  const prices = midoceanPrices(joined.prices.get(sku), joined.currency, checks);
  const stock = midoceanStock(joined.stock.get(sku), joined.stockUpdatedAt, checks);
  if (!prices.length) checks.add("variants without a price", sku);
  if (!stock) checks.add("variants without stock", sku);
  return {
    sku, externalId: cleanText(row.variant_id), ean: cleanText(row.gtin),
    color: localized({ [LANGUAGE]: row.color_description }), colorCode: cleanText(row.color_code),
    colorGroup: cleanText(row.color_group), size: cleanText(row.size_textile), status: cleanText(row.plc_status_description),
    printing: null, attributes: restOf(row, VARIANT_FIELDS), prices, stock,
  };
}

function variantsOf(row: Record<string, unknown>, code: string, joined: Joined, photos: Map<string, PhotoInput>,
  checks: Checks): VariantInput[] {
  const variants: VariantInput[] = [];
  for (const variant of checks.records(row.variants, "variants", code)) {
    const sku = cleanText(variant.sku);
    if (!sku) checks.add("variants without sku", code);
    else if (joined.seenSkus.has(sku)) checks.add("variants with a repeated sku", sku);
    else variants.push(variantOf(variant, sku, joined, photos, checks));
    if (sku) joined.seenSkus.add(sku);
  }
  if (!variants.length) checks.add("models without variants", code);
  return variants;
}

function modelOf(row: Record<string, unknown>, code: string, joined: Joined, checks: Checks): ModelInput {
  const photos = new Map<string, PhotoInput>();
  const assets = assetsOf(row, code, checks);
  for (const asset of assets.filter((item) => item.type === "image")) {
    if (!addPhoto(photos, asset)) checks.add("model photo links that are not https URLs", code);
  }
  const variants = variantsOf(row, code, joined, photos, checks);
  const first = Array.isArray(row.variants) && isRecord(row.variants[0]) ? row.variants[0] : {};
  const path = [first.category_level1, first.category_level2, first.category_level3].map(cleanText)
    .filter((name): name is string => name !== null);
  const documents = assets.filter((item) => item.type !== "image").map((item) => ({ subtype: cleanText(item.subtype), url: parseUrl(item.url) }));
  const printing = printingOf(joined.printing.get(code), code, checks);
  const model: ModelInput = {
    code, externalId: cleanText(row.master_id),
    name: localized({ [LANGUAGE]: row.product_name ?? row.short_description }),
    description: localized({ [LANGUAGE]: row.long_description }),
    category: path.length ? { [LANGUAGE]: path } : {}, categoryCode: cleanText(row.category_code),
    material: localized({ [LANGUAGE]: row.material }), brand: cleanText(row.brand), dimensions: cleanText(row.dimensions),
    specFields: {
      volume: [cleanText(row.liquid_volume), cleanText(row.liquid_volume_unit)].join(" ").trim() || null,
      texts: [cleanText(row.short_description)].filter((text) => text !== null),
    },
    weightGrams: weightGrams(row, code, checks), countryOfOrigin: cleanText(row.country_of_origin),
    printing, printTechniques: midoceanPrintTechniques(printing, joined.techniques),
    attributes: { ...restOf(row, MODEL_FIELDS), ...(documents.length ? { documents } : {}) },
    photos: [...photos.values()], variants,
  };
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

function currencyOf(pricelist: unknown): string {
  const currency = isRecord(pricelist) ? cleanText(pricelist.currency) : null;
  if (!currency || !CURRENCY_CODE.test(currency)) throw new FeedError("pricelist: no ISO currency code");
  return currency;
}

export function normalizeMidocean(feeds: MidoceanFeeds): NormalizedCatalog {
  const checks = new Checks();
  const models = byKey(feedRecords(feeds.products, null, "products", checks), "master_code", checks, "products");
  const techniques = midoceanTechniques(feeds.printdata, checks);
  if (!techniques.length) throw new FeedError("printdata: no print techniques");
  const joined: Joined = {
    prices: byKey(feedRecords(feeds.pricelist, "price", "pricelist", checks), "sku", checks, "pricelist"),
    stock: byKey(feedRecords(feeds.stock, "stock", "stock", checks), "sku", checks, "stock"),
    printing: byKey(feedRecords(feeds.printdata, "products", "printdata", checks), "master_code", checks, "printdata"),
    techniques,
    currency: currencyOf(feeds.pricelist),
    stockUpdatedAt: isRecord(feeds.stock) ? checks.read("stock timestamps", feeds.stock.modified_at, parseTimestamp) : null,
    seenSkus: new Set(),
  };
  const normalized = [...models].sort(([left], [right]) => compareCodes(left, right))
    .map(([code, row]) => modelOf(row, code, joined, checks));
  for (const sku of joined.stock.keys()) if (!joined.seenSkus.has(sku)) checks.add("stock records without a variant");
  for (const sku of joined.prices.keys()) if (!joined.seenSkus.has(sku)) checks.add("prices without a variant");
  for (const code of joined.printing.keys()) if (!models.has(code)) checks.add("printdata records without a model", code);
  const variants = normalized.reduce((sum, model) => sum + model.variants.length, 0);
  return {
    models: normalized,
    techniques,
    raw: [...rawRecords("products", models), ...rawRecords("stock", joined.stock), ...rawRecords("pricelist", joined.prices),
      ...rawRecords("printdata", joined.printing)],
    fetched: {
      products: models.size, "products variants": variants, stock: joined.stock.size, pricelist: joined.prices.size,
      printdata: joined.printing.size,
    },
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
