// Blue Collection feeds in the shared model (docs/integrations.md, «Blue Collection API (Asgard)»): client-products is
// one record per index (a model in one colour) with its prices, stock and marking; the model is the index without the
// colour after its last "-" (02003-03 is 02003 in colour 03). Categories come by id from two lists of their own.
import { Checks, compareCodes, hasLeftoverEntity, recordsByKey, requiredRecords, weightInGrams } from "../checks.js";
import { cleanText, isRecord, parseDate, parseDecimal, parseInteger, parseUrl, rawRecords, restOf } from "../normalize.js";
import type {
  ArrivalInput, Localized, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, StockInput, VariantInput,
} from "../types.js";
import { bluecollectionPrintTechniques, COLOURS_EN, COUNTRIES } from "./dictionaries.js";

// The supplier's language codes as ISO 639-1: cz is Czech
const LANGUAGES: Readonly<Record<string, string>> = { pl: "pl", en: "en", de: "de", fr: "fr", cz: "cs", it: "it", nl: "nl" };
const CURRENCY_CODE = /^[A-Z]{3}$/;
// material_en, material_pl...: the additional values that give the material in one language
const MATERIAL_ITEM = /^material_([a-z]{2})$/;
const COLOUR_SUFFIX = /^(.+)-[^-]+$/;
// "104.00 x 3.00 x 0.00": millimetres, as product_width, product_height and product_depth give them; a 0 is no side
const SIZE_UNIT = "mm";
const SIDE_MARK = /\s*x\s*/i;
// Materiały promocyjne > Katalogi: «Katalog BLUE COLLECTION 2026» in 6 languages (2026-11-06); its sibling Wzorniki
// (155, sample books) stays
const PRINTED_CATALOGUES_SUBCATEGORY = "154";
const VARIANT_FIELDS = new Set([
  "id", "index", "quantity", "names", "descriptions", "madeof", "marking", "marking_data", "category", "subcategory",
  "additional", "future_delivery", "image", "currency", "catalogue_price", "purchase_price", "sync_flags",
]);

export interface BluecollectionFeeds {
  products: unknown;
  categories: unknown;
  subcategories: unknown;
}

type Row = Record<string, unknown>;

// "02003-03" -> "02003"; an index without a colour is a model of its own
export function modelCodeOf(index: string): string {
  return COLOUR_SUFFIX.exec(index)?.[1] ?? index;
}

// [{ language: "en", title: "..." }] -> { en: "..." }
function byLanguage(value: unknown, field: string, checks: Checks, code: string): Localized {
  const texts: Localized = {};
  for (const item of checks.records(value, `${field} texts`, code)) {
    const language = LANGUAGES[cleanText(item.language) ?? ""];
    const text = cleanText(item[field]);
    if (language && text) texts[language] = text;
  }
  return texts;
}

// [{ item, value }] -> { item: value } without the empty values
function additionalOf(row: Row, checks: Checks, code: string): Record<string, unknown> {
  const pairs = checks.records(row.additional, "additional values", code).flatMap((pair) => {
    const item = cleanText(pair.item);
    const value = typeof pair.value === "string" ? cleanText(pair.value) : pair.value;
    return item && value !== null && value !== undefined ? [[item, value] as const] : [];
  });
  return Object.fromEntries(pairs);
}

// madeof first: where both are given it puts the main material first more often (an umbrella's polyester before its
// wooden handle), but only a quarter of the records have it. The additional values name the material on nearly every
// record (2026-11-06: 869 of the 877 models without a material).
function materialTexts(row: Row, additional: Record<string, unknown>, checks: Checks, code: string): Localized {
  const madeof = byLanguage(row.madeof, "text", checks, code);
  if (Object.keys(madeof).length) return madeof;
  const texts: Localized = {};
  for (const [item, value] of Object.entries(additional)) {
    const language = LANGUAGES[MATERIAL_ITEM.exec(item)?.[1] ?? ""];
    const text = cleanText(value);
    if (language && text) texts[language] = text;
  }
  return texts;
}

function dimensionsOf(value: unknown): string | null {
  const sides = (cleanText(value) ?? "").split(SIDE_MARK).map(parseDecimal)
    .filter((side): side is string => side !== null && Number(side) > 0).map(Number);
  return sides.length ? `${sides.join(" x ")} ${SIZE_UNIT}` : null;
}

function volumeOf(additional: Record<string, unknown>): string | null {
  const millilitres = parseDecimal(additional.capacity_ml);
  if (millilitres !== null && Number(millilitres) > 0) return `${Number(millilitres)} ml`;
  const litres = parseDecimal(additional.capacity_l);
  return litres !== null && Number(litres) > 0 ? `${Number(litres)} l` : null;
}

// The purchase price of the account is primary; the catalogue price of the same currency goes beside it and never
// stands in for it: the grid would show a retail price beside the purchase prices of the other suppliers
export function bluecollectionPrices(row: Row, checks: Checks): PriceInput[] {
  const sku = cleanText(row.index) ?? undefined;
  const currency = cleanText(row.currency);
  if (!currency || !CURRENCY_CODE.test(currency)) {
    checks.add("prices without an ISO currency", sku);
    return [];
  }
  const net = checks.amount("purchase prices", row.purchase_price, sku);
  const catalog = checks.amount("catalogue prices", row.catalogue_price, sku);
  const base = { currency, minQuantity: 1, validUntil: null };
  return [
    ...(net === null ? [] : [{ ...base, kind: "net" as const, amount: net, isPrimary: true }]),
    ...(catalog === null ? [] : [{ ...base, kind: "catalog" as const, amount: catalog, isPrimary: false }]),
  ];
}

export function bluecollectionStock(row: Row, checks: Checks): StockInput | null {
  const sku = cleanText(row.index) ?? undefined;
  const inStock = checks.read("stock quantities", row.quantity, parseInteger, sku);
  if (inStock === null) return null;
  const arrivals: ArrivalInput[] = checks.records(row.future_delivery, "arrivals", sku).map((arrival) => ({
    date: checks.read("arrival dates", arrival.date, parseDate, sku),
    quantity: checks.read("arrival quantities", arrival.quantity, parseInteger, sku),
  })).filter((arrival) => arrival.date !== null || arrival.quantity !== null)
    .sort((left, right) => compareCodes(left.date ?? "", right.date ?? ""));
  return {
    inStock, reserved: null, onOrder: null,
    nextArrivalQuantity: arrivals[0]?.quantity ?? null, nextArrivalDate: arrivals[0]?.date ?? null,
    leadTime: null, arrivals, sourceUpdatedAt: null,
  };
}

interface MarkingPlace {
  code: string | null;
  name: string | null;
  options: { code: string | null; area: string | null; maxColours: number | null }[];
}

function markingPlaces(row: Row, checks: Checks, code: string): MarkingPlace[] {
  return checks.records(row.marking_data, "marking data", code).flatMap((data) =>
    checks.records(data.marking_place, "marking places", code).map((place) => ({
      code: cleanText(place.code), name: cleanText(place.name_pl),
      options: checks.records(place.marking_option, "marking options", code).map((option) => ({
        code: cleanText(option.option_code), area: cleanText(option.option_info),
        maxColours: checks.read("print colour counts", option.max_colors, parseInteger, code),
      })),
    })));
}

function markingTexts(row: Row, checks: Checks, code: string): string[] {
  return checks.records(row.marking, "marking texts", code).map((item) => cleanText(item.text)).filter((text) => text !== null);
}

function colourOf(additional: Record<string, unknown>, checks: Checks): Localized {
  const polish = cleanText(additional.color_product);
  if (!polish) return {};
  const english = COLOURS_EN[polish.toLowerCase()];
  if (!english) checks.add("colours without an English name", polish);
  return english ? { en: english, pl: polish } : { pl: polish };
}

function variantOf(sku: string, row: Row, photos: Map<string, PhotoInput>, checks: Checks): VariantInput {
  const urls = checks.records(row.image, "photos", sku).flatMap((image) => {
    const url = parseUrl(image.url);
    if (!url) checks.add("photo links that are not https URLs", sku);
    return url ? [url] : [];
  });
  urls.forEach((url, position) => {
    let photo = photos.get(url);
    if (!photo) {
      photo = { url, urlLarge: null, kind: null, position: photos.size, variantLinks: [] };
      photos.set(url, photo);
    }
    photo.variantLinks.push({ sku, position });
  });
  if (!urls.length) checks.add("variants without photos", sku);
  const additional = additionalOf(row, checks, sku);
  const prices = bluecollectionPrices(row, checks);
  if (!prices.length) checks.add("variants without a price", sku);
  else if (!prices.some((price) => price.isPrimary)) checks.add("variants without a net price", sku);
  return {
    sku, externalId: cleanText(row.id), ean: cleanText(additional.ean_code), color: colourOf(additional, checks),
    colorCode: cleanText(additional.color_code), colorGroup: null, size: null, status: null, printing: null,
    attributes: { ...restOf(row, VARIANT_FIELDS), additional }, prices, stock: bluecollectionStock(row, checks),
  };
}

interface Names {
  categories: Map<string, Row>;
  subcategories: Map<string, Row>;
}

// [category, subcategory] in English, in Polish where the English name is missing
function categoryPath(row: Row, names: Names, checks: Checks): string[] {
  return [names.categories.get(cleanText(row.category) ?? ""), names.subcategories.get(cleanText(row.subcategory) ?? "")]
    .flatMap((entry) => {
      if (!entry) return [];
      const name = cleanText(entry.en) ?? cleanText(entry.pl);
      if (name && !cleanText(entry.en)) checks.add("categories without an English name", name);
      return name ? [name] : [];
    });
}

// The supplier's own printed catalogues are no products: an active variant with photos would show them in a search by
// photo. Makito's 74 come without variants and so never reach the search; these are left out of the snapshot, and the
// import deactivates them (owner's decision 2026-11-06).
function isPrintedCatalogue(group: [string, Row][]): boolean {
  return cleanText(group[0]?.[1].subcategory) === PRINTED_CATALOGUES_SUBCATEGORY;
}

function modelOf(code: string, group: [string, Row][], names: Names, checks: Checks): ModelInput {
  const [, first] = group[0] ?? ["", {}];
  const photos = new Map<string, PhotoInput>();
  const variants = group.map(([sku, row]) => variantOf(sku, row, photos, checks));
  const firstAdditional = variants[0]?.attributes.additional;
  const additional = isRecord(firstAdditional) ? firstAdditional : {};
  const path = categoryPath(first, names, checks);
  const placesByVariant = group.map(([, row]) => markingPlaces(row, checks, code));
  const texts = group.map(([, row]) => markingTexts(row, checks, code));
  if (!path.length) checks.add("models without a category", code);
  const country = cleanText(additional.country_origin);
  const countryOfOrigin = country ? COUNTRIES[country.toLowerCase()] ?? null : null;
  if (country && !countryOfOrigin) checks.add("countries without an ISO code", country);
  const model: ModelInput = {
    code, externalId: null,
    name: byLanguage(first.names, "title", checks, code), description: byLanguage(first.descriptions, "text", checks, code),
    category: path.length ? { en: path } : {}, categoryCode: cleanText(first.subcategory),
    material: materialTexts(first, additional, checks, code), brand: null, dimensions: dimensionsOf(additional.dimensions),
    specFields: { volume: volumeOf(additional), texts: [] },
    weightGrams: weightInGrams(additional.unit_weight, "kg", checks, code), countryOfOrigin,
    // The Polish marking text and the places with their options, as the supplier groups them
    printing: { text: (texts[0] ?? []).join(","), places: placesByVariant[0] ?? [] },
    printTechniques: bluecollectionPrintTechniques(texts.flat(),
      placesByVariant.flat().flatMap((place) => place.options).flatMap((option) => (option.code ? [option.code] : []))),
    attributes: {}, photos: [...photos.values()], variants,
  };
  if (!model.name.en) checks.add("models without an English name", code);
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

export function normalizeBluecollection(feeds: BluecollectionFeeds): NormalizedCatalog {
  const checks = new Checks();
  const products = recordsByKey(requiredRecords(feeds.products, "products", checks), "index", "products", checks);
  const names: Names = {
    categories: recordsByKey(requiredRecords(feeds.categories, "categories", checks), "id", "categories", checks),
    subcategories: recordsByKey(requiredRecords(feeds.subcategories, "subcategories", checks), "id", "subcategories", checks),
  };
  const groups = new Map<string, [string, Row][]>();
  for (const [index, row] of [...products].sort(([left], [right]) => compareCodes(left, right))) {
    const code = modelCodeOf(index);
    groups.set(code, [...(groups.get(code) ?? []), [index, row]]);
  }
  const models = [...groups].sort(([left], [right]) => compareCodes(left, right)).flatMap(([code, group]) => {
    if (!isPrintedCatalogue(group)) return [modelOf(code, group, names, checks)];
    checks.add("printed catalogues left out", code);
    return [];
  });
  return {
    models,
    techniques: [],
    raw: rawRecords("client-products", products),
    fetched: { products: products.size, models: models.length, categories: names.categories.size, subcategories: names.subcategories.size },
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
