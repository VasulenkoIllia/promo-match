// Inspirion feeds in the shared model (docs/integrations.md, «Inspirion LEO API»): products is an array of models with
// variants; prices and stock join by article_id. Each feed is a whole list read in one piece.
import {
  Checks, compareCodes, hasLeftoverEntity, recordsByKey, requiredRecords, uniqueRecords, weightInGrams,
} from "../checks.js";
import {
  cleanText, isRecord, localized, parseDate, parseDecimal, parseInteger, parseMinQuantity, parseUrl, rawRecords, restOf,
} from "../normalize.js";
import type { ArrivalInput, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, StockInput, VariantInput } from "../types.js";
import { inspirionPrintTechniques } from "./print-keys.js";

// The catalogue is read in English only, as the other suppliers'
const LANGUAGE = "en";
const CURRENCY_CODE = /^[A-Z]{3}$/;
// "2026-11-09 00:00:00": the date part
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
// A picture of 72 dpi (1800 px, RGB) is shown and embedded; the same file of 300 dpi (2560 px, CMYK) is the large one
const SMALL_PHOTO_PATH = "/72/";
const LARGE_PHOTO_PATH = "/300/";
const SIZE_SIDES = [["diameter", "ø"], ["length", ""], ["width", ""], ["height", ""]] as const;
const MODEL_FIELDS = new Set([
  "name", "description", "sku", "materials", "brand", "branding_methods", "origin_country", "categories", "variants",
  "details_images", "details_images_300", "type_images_default", "total_variants",
]);
const VARIANT_FIELDS = new Set(["article_id", "colour", "ean", "size", "weight", "images", "images_300", "images_default", "categories"]);

export interface InspirionFeeds {
  products: unknown;
  stock: unknown;
  pricelist: unknown;
}

type Row = Record<string, unknown>;

// Net and catalogue price per quantity step; the net price of the smallest step is primary
export function inspirionPrices(row: Row | undefined, checks: Checks): PriceInput[] {
  if (!row) return [];
  const sku = cleanText(row.article_id) ?? undefined;
  const steps = checks.records(row.pricelist, "price steps", sku).map((step) => {
    const currency = cleanText(step.currency);
    if (!currency || !CURRENCY_CODE.test(currency)) checks.add("price steps without an ISO currency", sku);
    return {
      currency: currency && CURRENCY_CODE.test(currency) ? currency : null,
      minQuantity: checks.read("price step quantities", step.bulk_volume, parseMinQuantity, sku),
      net: checks.amount("prices", step.price, sku),
      catalog: checks.amount("catalogue prices", step.catalog_price, sku),
    };
  }).filter((step) => step.currency !== null && step.minQuantity !== null)
    .sort((left, right) => (left.minQuantity ?? 0) - (right.minQuantity ?? 0));
  const prices: PriceInput[] = [];
  for (const step of steps) {
    const base = { currency: step.currency ?? "", minQuantity: step.minQuantity ?? 1, validUntil: null };
    if (step.net !== null && !prices.some((price) => price.kind === "net" && price.minQuantity === base.minQuantity)) {
      prices.push({ ...base, kind: "net", amount: step.net, isPrimary: !prices.some((price) => price.kind === "net") });
    }
    if (step.catalog !== null && !prices.some((price) => price.kind === "catalog" && price.minQuantity === base.minQuantity)) {
      prices.push({ ...base, kind: "catalog", amount: step.catalog, isPrimary: false });
    }
  }
  return prices;
}

// stock_dach is the German warehouse (warehouses.germany), the stock most regions show; the other regions stay in the
// raw record
export function inspirionStock(row: Row | undefined, checks: Checks): StockInput | null {
  if (!row) return null;
  const sku = cleanText(row.article_id) ?? undefined;
  const inStock = checks.read("stock quantities", row.stock_dach, parseInteger, sku);
  if (inStock === null) return null;
  const arrivals: ArrivalInput[] = checks.records(row.inventory_arrival, "arrivals", sku).map((arrival) => ({
    date: checks.read("arrival dates", arrival.arrival_date, (value) => parseDate(cleanText(value)?.match(DATE_PREFIX)?.[0]), sku),
    quantity: checks.read("arrival quantities", arrival.arrival_quantity, parseInteger, sku),
  })).filter((arrival) => arrival.date !== null || arrival.quantity !== null);
  return {
    inStock, reserved: null, onOrder: checks.read("production quantities", row.stock_in_production, parseInteger, sku),
    nextArrivalQuantity: arrivals[0]?.quantity ?? null, nextArrivalDate: arrivals[0]?.date ?? null,
    leadTime: null, arrivals, sourceUpdatedAt: null,
  };
}

// "ø 7 x 14.3 cm": the sides the variant has, in the unit it gives; a model with mixed units writes each
function dimensionsOf(size: unknown): string | null {
  if (!isRecord(size)) return null;
  const sides = SIZE_SIDES.flatMap(([field, mark]) => {
    const value = parseDecimal(size[field]);
    return value !== null && Number(value) > 0 ? [{ text: `${mark}${Number(value)}`, unit: cleanText(size[`${field}_unit`]) ?? "" }] : [];
  });
  if (!sides.length) return null;
  const units = new Set(sides.map((side) => side.unit));
  if (units.size === 1) return `${sides.map((side) => side.text).join(" x ")} ${sides[0]?.unit ?? ""}`.trim();
  return sides.map((side) => `${side.text} ${side.unit}`.trim()).join(" x ");
}

function linksOf(value: unknown, label: string, code: string, checks: Checks): string[] {
  return checks.records(value, label, code).flatMap((image) => {
    const url = parseUrl(image.image_url);
    if (!url) checks.add("photo links that are not https URLs", code);
    return url ? [url] : [];
  });
}

// The large file of a picture, when the 300 dpi list has one by the same name
function largeOf(url: string, large: ReadonlySet<string>): string | null {
  const candidate = url.replace(SMALL_PHOTO_PATH, LARGE_PHOTO_PATH);
  return candidate !== url && large.has(candidate) ? candidate : null;
}

function addPhotos(photos: Map<string, PhotoInput>, urls: string[], large: ReadonlySet<string>, sku?: string): void {
  urls.forEach((url, position) => {
    let photo = photos.get(url);
    if (!photo) {
      photo = { url, urlLarge: largeOf(url, large), kind: null, position: photos.size, variantLinks: [] };
      photos.set(url, photo);
    }
    if (sku) photo.variantLinks.push({ sku, position });
  });
}

function printingOf(methods: unknown, code: string, checks: Checks): unknown {
  return checks.records(methods, "branding methods", code).map((method) => ({
    position: cleanText(method.position_title),
    technique: cleanText(method.print_technique_title),
    techniqueKey: cleanText(method.print_technique_key),
    size: cleanText(method.size),
    printCodes: cleanText(method.print_codes),
    maxColours: checks.read("print colour counts", method.max_number_of_colors, parseInteger, code),
    isDefault: method.default === true,
  }));
}

interface Joined {
  prices: Map<string, Row>;
  stock: Map<string, Row>;
  seenSkus: Set<string>;
}

function variantOf(row: Row, sku: string, joined: Joined, photos: Map<string, PhotoInput>, checks: Checks): VariantInput {
  const urls = linksOf(row.images, "variant photos", sku, checks);
  addPhotos(photos, urls, new Set(linksOf(row.images_300, "variant large photos", sku, checks)), sku);
  if (!urls.length) checks.add("variants without photos", sku);
  const prices = inspirionPrices(joined.prices.get(sku), checks);
  const stock = inspirionStock(joined.stock.get(sku), checks);
  if (!prices.length) checks.add("variants without a price", sku);
  else if (!prices.some((price) => price.isPrimary)) checks.add("variants without a net price", sku);
  if (!stock) checks.add("variants without stock", sku);
  return {
    sku, externalId: null, ean: cleanText(row.ean), color: localized({ [LANGUAGE]: row.colour }), colorCode: null,
    colorGroup: null, size: null, status: null, printing: null, attributes: restOf(row, VARIANT_FIELDS), prices, stock,
  };
}

function variantsOf(row: Row, code: string, joined: Joined, photos: Map<string, PhotoInput>, checks: Checks): VariantInput[] {
  const rows = uniqueRecords(checks.records(row.variants, "variants", code), "article_id", joined.seenSkus, "variants", checks, code);
  if (!rows.length) checks.add("models without variants", code);
  return rows.map(([sku, variant]) => variantOf(variant, sku, joined, photos, checks));
}

function modelOf(row: Row, code: string, joined: Joined, checks: Checks): ModelInput {
  const photos = new Map<string, PhotoInput>();
  const variants = variantsOf(row, code, joined, photos, checks);
  addPhotos(photos, linksOf(row.details_images, "detail photos", code, checks),
    new Set(linksOf(row.details_images_300, "detail large photos", code, checks)));
  const first = Array.isArray(row.variants) && isRecord(row.variants[0]) ? row.variants[0] : {};
  const categories = isRecord(row.categories) ? row.categories : {};
  const path = [categories.parent, categories.child].map(cleanText).filter((name): name is string => name !== null);
  const materials = Array.isArray(row.materials) ? row.materials.map(cleanText).filter((name) => name !== null) : [];
  const model: ModelInput = {
    code, externalId: null,
    name: localized({ [LANGUAGE]: row.name }), description: localized({ [LANGUAGE]: row.description }),
    category: path.length ? { [LANGUAGE]: path } : {}, categoryCode: null,
    material: localized({ [LANGUAGE]: materials.join(", ") }), brand: cleanText(row.brand),
    dimensions: dimensionsOf(first.size),
    specFields: { volume: null, texts: [cleanText(row.short_description)].filter((text) => text !== null) },
    weightGrams: isRecord(first.weight) ? weightInGrams(first.weight.net, first.weight.unit, checks, code) : null, countryOfOrigin: cleanText(row.origin_country),
    printing: printingOf(row.branding_methods, code, checks), printTechniques: inspirionPrintTechniques(row.branding_methods),
    attributes: restOf(row, MODEL_FIELDS), photos: [...photos.values()], variants,
  };
  if (!path.length) checks.add("models without a category", code);
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

export function normalizeInspirion(feeds: InspirionFeeds): NormalizedCatalog {
  const checks = new Checks();
  const models = recordsByKey(requiredRecords(feeds.products, "products", checks), "sku", "products", checks);
  const joined: Joined = {
    prices: recordsByKey(requiredRecords(feeds.pricelist, "pricelist", checks), "article_id", "pricelist", checks),
    stock: recordsByKey(requiredRecords(feeds.stock, "stock", checks), "article_id", "stock", checks),
    seenSkus: new Set(),
  };
  const normalized = [...models].sort(([left], [right]) => compareCodes(left, right))
    .map(([code, row]) => modelOf(row, code, joined, checks));
  for (const sku of joined.stock.keys()) if (!joined.seenSkus.has(sku)) checks.add("stock records without a variant");
  for (const sku of joined.prices.keys()) if (!joined.seenSkus.has(sku)) checks.add("prices without a variant");
  const variants = normalized.reduce((sum, model) => sum + model.variants.length, 0);
  return {
    models: normalized,
    techniques: [],
    raw: [...rawRecords("products", models), ...rawRecords("stock", joined.stock), ...rawRecords("pricelist", joined.prices)],
    fetched: { products: models.size, "products variants": variants, stock: joined.stock.size, pricelist: joined.prices.size },
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
