// Makito feeds in the shared model (docs/integrations.md, «Makito API B2B»): the catalogue holds models with their
// variants; stock joins by the 11-digit variant code, prices by the model's ref, colours and sizes by their codes. Each
// feed is a whole file read in one piece.
import { Checks, compareCodes, hasLeftoverEntity, recordsByKey, requiredRecords } from "../checks.js";
import { FeedError } from "../errors.js";
import {
  cleanText, isBlank, isRecord, localized, parseDate, parseDecimal, parseInteger, parseMinQuantity, parseTimestamp, parseUrl,
  rawRecords, restOf,
} from "../normalize.js";
import type { ArrivalInput, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, StockInput, VariantInput } from "../types.js";
import { isAssetUrl } from "./api.js";
import { readPrintAreas } from "./print-config.js";
import { makitoAreaTechniques, makitoPrintTechniques, mergePrintFacts } from "./print-names.js";

// The catalogue is read in English only, as the other suppliers'
const LANGUAGE = "en";
const MAKITO_ORIGIN = "https://apis.makito.es";
const CURRENCY_CODE = /^[A-Z]{3}$/;
// The variant's folder in the path of its photo, the code the stock and the orders use: /catalog/assets/15246/
// 15246003000/principal/... It is not always ref, colour and size: the variants of 12008C are 12009001000...
const VARIANT_PHOTO_FOLDER = /\/catalog\/assets\/[^/]+\/(\d{11})\//;
const REF_PART = /^\d{5}$/;
const COLOUR_OR_SIZE_PART = /^\d{3}$/;
// The size code of the variants that have no size (10 760 of 17 756 on 2026-11-04, none of them clothing)
const NO_SIZE = "000";
// Prices are per this many pieces: "baseQuantity": "1000" on every row (2026-11-04), "1000.00" for 1 EUR a piece
const BASE_QUANTITY = /^10*$/;
// price.amount is numeric(12, 4): more places are rounded by Postgres, and a price that rounds to 0 is no price
const AMOUNT_PLACES = 4;
const SMALLEST_AMOUNT = 0.0001;
// "2027-01-05T00:00:00Z": the date part
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
// As the catalogue writes its category paths, under these two levels
const PATH_SEPARATOR = " > ";
const PATH_ROOT = ["Production", "PRODUCTS"] as const;
const MARKING = "Marking Techniques";
// Branches that say something besides what the product is: a label, a range or a way to print
const NOT_A_KIND = new Set([MARKING, "Sustainable Items", "News", "Unique Offers", "Premium Line", "Spain Line"]);
// Ranges by season or by a way to print: a path that names a kind of product goes before them
const RANGES = new Set(["Sublimation", "OUTDOOR SEASON", "World Cup 2026", "Textile Outlet", "BE COMPETITIVE"]);
const RANGE_PENALTY = 100;
// Millimetres: a pen is ø8 x 129, a mug ø92 x 116 (2026-11-04)
const SIZE_SIDES = [["diameter", "ø"], ["length", ""], ["width", ""], ["height", ""]] as const;
const SIZE_UNIT = "mm";
const MODEL_FIELDS = new Set([
  "ref", "web_reference", "name", "type", "description", "material", "length", "height", "width", "diameter", "brand",
  "categories", "image", "thumbnail_image", "detail_images", "variants", "printcode", "print_observations",
]);
const VARIANT_FIELDS = new Set(["variant_image", "variant_thumbnail", "variant_colorcode", "variant_size"]);

export interface MakitoFeeds {
  catalog: unknown;
  stock: unknown;
  prices: unknown;
  colors: unknown;
  sizes: unknown;
  // The print areas and the names of their techniques: undefined when they were not read, the techniques then come from
  // the categories alone
  printConfig?: unknown;
  printNames?: unknown;
}

type Row = Record<string, unknown>;

// "1500.00" per 1000 pieces is "1.5" a piece: the point moved left on the digits, so no float rounding creeps in
export function perPiece(amount: string, places: number): string {
  if (!places) return amount;
  const [whole = "", fraction = ""] = amount.split(".");
  const padded = whole.padStart(places + 1, "0");
  const integer = padded.slice(0, padded.length - places).replace(/^0+(?=\d)/, "");
  const rest = `${padded.slice(padded.length - places)}${fraction}`.replace(/0+$/, "");
  return rest ? `${integer}.${rest}` : integer;
}

// The scales of a model, a piece each; the smallest quantity is primary. The price list is the account's own, the
// price it buys at.
export function makitoPrices(row: Row | undefined, checks: Checks): PriceInput[] {
  if (!row) return [];
  const ref = cleanText(row.material) ?? undefined;
  const currency = cleanText(row.currency);
  if (!currency || !CURRENCY_CODE.test(currency)) {
    checks.add("prices without an ISO currency", ref);
    return [];
  }
  const base = cleanText(row.baseQuantity);
  if (!base || !BASE_QUANTITY.test(base)) {
    checks.add("prices per a quantity that is not a power of ten", ref);
    return [];
  }
  const steps = checks.records(row.scales, "price scales", ref).map((scale) => ({
    minQuantity: checks.read("price scale quantities", scale.quantity, parseMinQuantity, ref),
    amount: checks.amount("prices", scale.amount, ref),
  })).flatMap((step) => (step.minQuantity !== null && step.amount !== null ? [{ minQuantity: step.minQuantity, amount: step.amount }] : []))
    .sort((left, right) => left.minQuantity - right.minQuantity);
  const prices: PriceInput[] = [];
  for (const step of steps) {
    if (prices.some((price) => price.minQuantity === step.minQuantity)) {
      checks.add("price scales with a repeated quantity", ref);
      continue;
    }
    const amount = perPiece(step.amount, base.length - 1);
    if (Number(amount) < SMALLEST_AMOUNT) {
      checks.add("prices below 0.0001 a piece", ref);
      continue;
    }
    if ((amount.split(".")[1]?.length ?? 0) > AMOUNT_PLACES) checks.add("prices rounded to 4 places", ref);
    prices.push({ kind: "net", currency, minQuantity: step.minQuantity, amount, isPrimary: !prices.length, validUntil: null });
  }
  return prices;
}

// The rows of one variant: the one without a date is the stock now, the dated ones are arrivals
export function makitoStock(rows: Row[] | undefined, generatedAt: string | null, checks: Checks, sku: string): StockInput | null {
  if (!rows?.length) return null;
  const now = rows.filter((row) => isBlank(row.availableDate));
  if (now.length > 1) checks.add("variants with more than one stock row without a date", sku);
  if (!now.length) checks.add("variants with arrivals only", sku);
  const inStock = now.reduce((sum, row) => sum + (checks.read("stock quantities", row.quantity, parseInteger, sku) ?? 0), 0);
  const arrivals: ArrivalInput[] = rows.filter((row) => !isBlank(row.availableDate)).map((row) => ({
    date: checks.read("arrival dates", row.availableDate, (value) => parseDate(cleanText(value)?.match(DATE_PREFIX)?.[0]), sku),
    quantity: checks.read("arrival quantities", row.quantity, parseInteger, sku),
  })).sort((left, right) => compareCodes(left.date ?? "", right.date ?? ""));
  return {
    inStock, reserved: null, onOrder: null,
    nextArrivalQuantity: arrivals[0]?.quantity ?? null, nextArrivalDate: arrivals[0]?.date ?? null,
    leadTime: null, arrivals, sourceUpdatedAt: generatedAt,
  };
}

// The model's kind from its category paths, the deepest that names a kind of product (a range only when nothing else
// does), and the names of its print techniques, which the catalogue lists as categories too
export function categoryOf(values: unknown): { path: string[] | null; techniques: string[] } {
  const techniques: string[] = [];
  let best: { path: string[]; score: number } | null = null;
  for (const value of Array.isArray(values) ? values : []) {
    const levels = (cleanText(value) ?? "").split(PATH_SEPARATOR).map((name) => name.trim());
    if (levels[0] !== PATH_ROOT[0] || levels[1] !== PATH_ROOT[1]) continue;
    const path = levels.slice(PATH_ROOT.length);
    const [first] = path;
    if (first === undefined || path.some((name) => !name)) continue;
    if (first === MARKING) {
      if (path.length > 1) techniques.push(path.at(-1) ?? "");
      continue;
    }
    if (NOT_A_KIND.has(first)) continue;
    const score = path.length - (path.some((name) => RANGES.has(name)) ? RANGE_PENALTY : 0);
    if (!best || score > best.score) best = { path, score };
  }
  return { path: best?.path ?? null, techniques };
}

// The variant's code from the folder of its photo; without a photo, ref, colour and size when they make one
export function variantCodeOf(ref: string, row: Row): string | null {
  const folder = cleanText(row.variant_image)?.match(VARIANT_PHOTO_FOLDER)?.[1];
  if (folder) return folder;
  const colour = cleanText(row.variant_colorcode) ?? "";
  const size = cleanText(row.variant_size) ?? "";
  return REF_PART.test(ref) && COLOUR_OR_SIZE_PART.test(colour) && COLOUR_OR_SIZE_PART.test(size) ? `${ref}${colour}${size}` : null;
}

// "Komir" of type "Action Camera" is "Action Camera Komir", as Makito's own Spanish variant names put it
function nameOf(row: Row): string | null {
  const name = cleanText(row.name);
  const type = cleanText(row.type);
  if (!name || !type) return name ?? type;
  return name.toLowerCase().includes(type.toLowerCase()) ? name : `${type} ${name}`;
}

function dimensionsOf(row: Row): string | null {
  const sides = SIZE_SIDES.flatMap(([field, mark]) => {
    const value = parseDecimal(row[field]);
    return value !== null && Number(value) > 0 ? [`${mark}${Number(value)}`] : [];
  });
  return sides.length ? `${sides.join(" x ")} ${SIZE_UNIT}` : null;
}

// A link of Makito's own must be a photo file its token opens: 40 models give a folder (".../14509/principal/") and one
// variant two names in one string (2026-11-04), which would stay pending in every embeddings run and show broken
function linkOf(value: unknown, code: string, checks: Checks): string[] {
  if (isBlank(value)) return [];
  const url = parseUrl(value);
  if (!url) {
    checks.add("photo links that are not https URLs", code);
    return [];
  }
  const parsed = new URL(url);
  if (parsed.origin === MAKITO_ORIGIN && !isAssetUrl(parsed)) {
    checks.add("photo links that are not a photo file", code);
    return [];
  }
  return [url];
}

function addPhotos(photos: Map<string, PhotoInput>, urls: string[], sku?: string): void {
  [...new Set(urls)].forEach((url, position) => {
    let photo = photos.get(url);
    if (!photo) {
      photo = { url, urlLarge: null, kind: null, position: photos.size, variantLinks: [] };
      photos.set(url, photo);
    }
    if (sku) photo.variantLinks.push({ sku, position });
  });
}

interface Joined {
  prices: Map<string, Row>;
  stock: Map<string, Row[]>;
  stockTime: string | null;
  colours: Map<string, string>;
  sizes: Map<string, string>;
  // ref -> the names of the techniques of the model's print areas; null when print-config was not read
  areas: Map<string, string[]> | null;
  seenSkus: Set<string>;
}

function sizeOf(code: string | null, joined: Joined, checks: Checks): string | null {
  if (!code || code === NO_SIZE) return null;
  const title = joined.sizes.get(code);
  if (!title) checks.add("size codes not in the size list", code);
  return title ?? null;
}

// The variant's own photo first, then the model's photo and its details, the same for every variant
function variantOf(row: Row, sku: string, model: { prices: PriceInput[]; photos: string[] }, joined: Joined,
  photos: Map<string, PhotoInput>, checks: Checks): VariantInput {
  const own = linkOf(row.variant_image, sku, checks);
  if (!own.length) checks.add("variants without a photo of their own", sku);
  addPhotos(photos, [...own, ...model.photos], sku);
  const colorCode = cleanText(row.variant_colorcode);
  const colour = colorCode ? joined.colours.get(colorCode) : undefined;
  if (colorCode && !colour) checks.add("colour codes not in the colour list", colorCode);
  const stock = makitoStock(joined.stock.get(sku), joined.stockTime, checks, sku);
  if (!stock) checks.add("variants without stock", sku);
  return {
    sku, externalId: null, ean: null, color: localized({ [LANGUAGE]: colour }), colorCode, colorGroup: null,
    size: sizeOf(cleanText(row.variant_size), joined, checks), status: null, printing: null,
    attributes: restOf(row, VARIANT_FIELDS), prices: model.prices, stock,
  };
}

function variantsOf(row: Row, ref: string, code: string, model: { prices: PriceInput[]; photos: string[] }, joined: Joined,
  photos: Map<string, PhotoInput>, checks: Checks): VariantInput[] {
  const variants: VariantInput[] = [];
  for (const variant of checks.records(row.variants, "variants", code)) {
    const sku = variantCodeOf(ref, variant);
    if (!sku) checks.add("variants without a variant code", code);
    else if (joined.seenSkus.has(sku)) checks.add("variants with a repeated variant code", sku);
    else variants.push(variantOf(variant, sku, model, joined, photos, checks));
    if (sku) joined.seenSkus.add(sku);
  }
  if (!variants.length) checks.add("models without variants", code);
  return variants;
}

function modelOf(row: Row, code: string, joined: Joined, checks: Checks): ModelInput {
  const ref = cleanText(row.ref) ?? "";
  if (!ref) checks.add("models without a ref", code);
  const prices = makitoPrices(joined.prices.get(ref), checks);
  if (!prices.length) checks.add("models without a price", code);
  const details: unknown[] = Array.isArray(row.detail_images) ? row.detail_images : [];
  const modelPhotos = [row.image, ...details].flatMap((url) => linkOf(url, code, checks));
  const photos = new Map<string, PhotoInput>();
  const variants = variantsOf(row, ref, code, { prices, photos: modelPhotos }, joined, photos, checks);
  addPhotos(photos, modelPhotos);
  const { path, techniques } = categoryOf(row.categories);
  if (!path) checks.add("models without a category", code);
  const areaNames = joined.areas?.get(ref);
  if (joined.areas && !areaNames) checks.add("models not in print-config", code);
  const model: ModelInput = {
    code, externalId: ref || null,
    name: localized({ [LANGUAGE]: nameOf(row) }), description: localized({ [LANGUAGE]: row.description }),
    category: path ? { [LANGUAGE]: path } : {}, categoryCode: null,
    material: localized({ [LANGUAGE]: row.material }), brand: cleanText(row.brand), dimensions: dimensionsOf(row),
    specFields: { volume: null, texts: [cleanText(row.type)].filter((text) => text !== null) },
    weightGrams: null, countryOfOrigin: null,
    printing: { printcode: cleanText(row.printcode), techniques, observations: cleanText(row.print_observations) },
    printTechniques: mergePrintFacts(makitoPrintTechniques(techniques), makitoAreaTechniques(areaNames ?? [])), attributes: restOf(row, MODEL_FIELDS), photos: [...photos.values()],
    variants,
  };
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

// The records of a file that is an object with its list in one field
function fileRecords(file: unknown, field: string, feed: string, checks: Checks): Row[] {
  if (!isRecord(file)) throw new FeedError(`${feed}: not an object`);
  return requiredRecords(file[field], feed, checks);
}

// A code list ({ colorCode, colorTitle }): the code to its English title
function titles(value: unknown, codeField: string, titleField: string, feed: string, checks: Checks): Map<string, string> {
  const result = new Map<string, string>();
  for (const [code, row] of recordsByKey(requiredRecords(value, feed, checks), codeField, feed, checks)) {
    const title = cleanText(row[titleField]);
    if (title) result.set(code, title);
    else checks.add(`${feed} without a title`, code);
  }
  return result;
}

function stockByVariant(rows: Row[], checks: Checks): Map<string, Row[]> {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const material = cleanText(row.material);
    if (!material) {
      checks.add("stock records without material");
      continue;
    }
    result.set(material, [...(result.get(material) ?? []), row]);
  }
  return result;
}

export function normalizeMakito(feeds: MakitoFeeds): NormalizedCatalog {
  const checks = new Checks();
  const models = recordsByKey(fileRecords(feeds.catalog, "products", "catalog", checks), "web_reference", "catalog", checks);
  const stockRows = fileRecords(feeds.stock, "stocks", "stock", checks);
  const { areas, warnings } = readPrintAreas(feeds.printConfig, feeds.printNames, checks);
  const joined: Joined = {
    areas: areas?.namesByRef ?? null,
    prices: recordsByKey(fileRecords(feeds.prices, "priceList", "price-list", checks), "material", "price-list", checks),
    stock: stockByVariant(stockRows, checks),
    stockTime: isRecord(feeds.stock) ? parseTimestamp(feeds.stock.generatedAt) : null,
    colours: titles(feeds.colors, "colorCode", "colorTitle", "colors", checks),
    sizes: titles(feeds.sizes, "sizeCode", "sizeTitle", "sizes", checks),
    seenSkus: new Set(),
  };
  const normalized = [...models].sort(([left], [right]) => compareCodes(left, right))
    .map(([code, row]) => modelOf(row, code, joined, checks));
  for (const sku of joined.stock.keys()) if (!joined.seenSkus.has(sku)) checks.add("stock records without a variant");
  const refs = new Set(normalized.map((model) => model.externalId));
  for (const ref of joined.prices.keys()) if (!refs.has(ref)) checks.add("prices without a model");
  const variants = normalized.reduce((sum, model) => sum + model.variants.length, 0);
  return {
    models: normalized,
    techniques: [],
    raw: [
      ...rawRecords("catalog", models), ...rawRecords("price-list", joined.prices),
      ...[...joined.stock].map(([externalId, rows]) => ({ feed: "stock", externalId, payload: rows })),
      ...(areas ? rawRecords("print-config", areas.raw) : []),
    ],
    fetched: {
      catalog: models.size, "catalog variants": variants, stock: stockRows.length, "price-list": joined.prices.size,
      colors: joined.colours.size, sizes: joined.sizes.size,
      ...(areas ? { "print-config": areas.raw.size, "print-price-list": areas.priceListNames } : {}),
    },
    checks: checks.counts,
    examples: checks.examples,
    warnings,
  };
}
