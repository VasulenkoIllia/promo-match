// Axpol records in the shared model. One Product.List record is one variant (a colour or a size); splitCode reads
// its model from CodeERP. Stock and printing join by CodeERP.
import { Checks, compareCodes, hasLeftoverEntity } from "../checks.js";
import {
  cleanText, isBlank, localized, parseGrams, parseInteger, parseUrl, rawRecords, restOf,
} from "../normalize.js";
import type {
  Localized, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, StockInput, VariantInput,
} from "../types.js";
import { axpolPrintTechniques } from "./print-codes.js";

const LANGUAGES = { pl: "PL", en: "EN", de: "DE", fr: "FR" } as const;
const LOCALIZED_FIELDS = ["Title", "Description", "Material", "MainCategory", "SubCategory", "Color"];
const CURRENCY = "PLN";
// Fields that become columns or rows; the rest of a record goes to the variant's attributes
const MAPPED = new Set([
  "productId", "CodeERP", "EAN", "Brand", "Dimensions", "ItemWeightG", "CountryOfOrigin", "Foto",
  "NetPricePLN", "CatalogPricePLN", "FinalNetPrice", "InStock", "reserved", "onOrder", "nextDelivery", "Days",
  ...LOCALIZED_FIELDS.flatMap((field) => Object.values(LANGUAGES).map((suffix) => `${field}${suffix}`)),
]);

export interface AxpolFeeds {
  // Records by productId, as each List gives them
  products: Map<string, Record<string, unknown>>;
  stock: Map<string, Record<string, unknown>>;
  printing: Map<string, Record<string, unknown>>;
}

export interface CodeParts {
  model: string;
  color: string | null;
  size: string | null;
}

const COLOUR_DIGITS = /^\d{2,}$/;

// CodeERP as model, colour and size, checked on the full catalogue of 2026-10-28 (docs/integrations.md):
// three dot parts are model, colour and size (T9105.001.XL); a hyphen ends the colour (V6520-00, HE332-16); one dot
// ends with a colour digit (P322.081 and P322.083 are colours 1 and 3 of P322.08, P322.4901 is colour 1 of
// P322.490). Up to the last dot is not a model: P322 holds 62 different power banks. Anything else is a model alone.
export function splitCode(codeErp: string): CodeParts {
  const parts = codeErp.split(".");
  const [first, second, third] = parts;
  if (parts.length === 3 && first && second && third) return { model: first, color: second, size: third };
  const hyphen = codeErp.lastIndexOf("-");
  if (hyphen > 0) return { model: codeErp.slice(0, hyphen), color: codeErp.slice(hyphen + 1) || null, size: null };
  if (parts.length === 2 && first && second && COLOUR_DIGITS.test(second)) {
    return { model: codeErp.slice(0, -1), color: codeErp.slice(-1), size: null };
  }
  return { model: codeErp, color: null, size: null };
}

function byLanguage(record: Record<string, unknown>, field: string): Localized {
  return localized(Object.fromEntries(Object.entries(LANGUAGES).map(([language, suffix]) => [language, record[`${field}${suffix}`]])));
}

function categoryOf(record: Record<string, unknown>): Record<string, string[]> {
  const category: Record<string, string[]> = {};
  for (const [language, suffix] of Object.entries(LANGUAGES)) {
    const path = [cleanText(record[`MainCategory${suffix}`]), cleanText(record[`SubCategory${suffix}`])]
      .filter((name): name is string => name !== null);
    if (path.length) category[language] = path;
  }
  return category;
}

// NetPricePLN is the primary price (owner's decision 2026-10-28); the catalogue and the final net price are kept
// beside it. A price of 0 means none.
export function axpolPrices(record: Record<string, unknown>, checks: Checks): PriceInput[] {
  const kinds = [["net", "NetPricePLN"], ["catalog", "CatalogPricePLN"], ["final", "FinalNetPrice"]] as const;
  const sku = cleanText(record.CodeERP) ?? undefined;
  const prices: PriceInput[] = [];
  for (const [kind, field] of kinds) {
    const amount = checks.amount(`${field} prices`, record[field], sku);
    if (amount === null) continue;
    prices.push({ kind, currency: CURRENCY, minQuantity: 1, amount, isPrimary: kind === "net", validUntil: null });
  }
  return prices;
}

export function axpolStock(record: Record<string, unknown> | undefined, checks: Checks): StockInput | null {
  if (!record) return null;
  const sku = cleanText(record.CodeERP) ?? undefined;
  const inStock = checks.read("stock quantities", record.InStock, parseInteger, sku);
  if (inStock === null) return null;
  return {
    inStock,
    reserved: checks.read("stock quantities", record.reserved, parseInteger, sku),
    onOrder: checks.read("stock quantities", record.onOrder, parseInteger, sku),
    nextArrivalQuantity: checks.read("stock quantities", record.nextDelivery, parseInteger, sku),
    nextArrivalDate: null,
    leadTime: cleanText(record.Days),
    arrivals: [],
    sourceUpdatedAt: null,
  };
}

// Print positions: position names come in Polish, technique codes without a dictionary (open question 3)
function printingOf(record: Record<string, unknown> | undefined, checks: Checks): unknown {
  if (!record) return null;
  const sku = cleanText(record.CodeERP) ?? undefined;
  if (!Array.isArray(record.Print)) {
    if (!isBlank(record.Print)) checks.add("Print fields that are not lists", sku);
    return null;
  }
  return checks.records(record.Print, "print positions", sku).map((position) => ({
    positionId: position.PositionId ?? null,
    name: localized({ pl: position.Position }),
    size: cleanText(position.Size),
    techniques: Array.isArray(position.Technique)
      ? position.Technique.map(cleanText).filter((code): code is string => code !== null)
      : [],
  }));
}

// The first record per CodeERP; one without a code or with a repeated one is counted, not kept
function byCode(records: Map<string, Record<string, unknown>>, feed: string, checks: Checks):
  Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const [productId, record] of records) {
    const code = cleanText(record.CodeERP);
    if (!code) checks.add(`${feed} records without CodeERP`, productId);
    else if (result.has(code)) checks.add(`${feed} records with a repeated CodeERP`, code);
    else result.set(code, record);
  }
  return result;
}

function photosOf(group: [string, Record<string, unknown>][], checks: Checks): PhotoInput[] {
  const photos = new Map<string, PhotoInput>();
  for (const [sku, record] of group) {
    if (!Array.isArray(record.Foto) && !isBlank(record.Foto)) checks.add("Foto fields that are not lists", sku);
    const urls: unknown[] = Array.isArray(record.Foto) ? record.Foto : [];
    if (!urls.length) checks.add("variants without photos", sku);
    urls.forEach((value, index) => {
      const url = parseUrl(value);
      if (!url) return checks.add("photo links that are not https URLs", sku);
      let photo = photos.get(url);
      if (!photo) {
        photo = { url, urlLarge: null, kind: null, position: photos.size, variantLinks: [] };
        photos.set(url, photo);
      }
      photo.variantLinks.push({ sku, position: index });
    });
  }
  return [...photos.values()];
}

function variantOf(sku: string, record: Record<string, unknown>, feeds: JoinedFeeds, checks: Checks): VariantInput {
  const { color, size } = splitCode(sku);
  const stock = axpolStock(feeds.stock.get(sku), checks);
  const prices = axpolPrices(record, checks);
  if (!stock) checks.add("variants without stock", sku);
  if (!prices.some((price) => price.isPrimary)) checks.add("variants without a net price", sku);
  return {
    sku,
    externalId: cleanText(record.productId),
    ean: cleanText(record.EAN),
    color: byLanguage(record, "Color"),
    colorCode: color,
    colorGroup: null,
    size,
    status: null,
    printing: printingOf(feeds.printing.get(sku), checks),
    attributes: restOf(record, MAPPED),
    prices,
    stock,
  };
}

interface JoinedFeeds {
  stock: Map<string, Record<string, unknown>>;
  printing: Map<string, Record<string, unknown>>;
}

function modelOf(code: string, group: [string, Record<string, unknown>][], feeds: JoinedFeeds, checks: Checks): ModelInput {
  // The first colour by code speaks for the model; the check below counts models whose colours disagree
  const head = group[0];
  if (!head) throw new Error(`axpol model ${code} has no variants`);
  const [firstSku, first] = head;
  const titles = new Set(group.map(([, record]) => cleanText(record.TitleEN)));
  if (titles.size > 1) checks.add("models whose colours have different English titles", code);
  if (code === firstSku) checks.add("codes that are a model of their own (no colour or size)", code);
  const variants = group.map(([sku, record]) => variantOf(sku, record, feeds, checks));
  const model: ModelInput = {
    code,
    externalId: null,
    name: byLanguage(first, "Title"),
    description: byLanguage(first, "Description"),
    category: categoryOf(first),
    categoryCode: null,
    material: byLanguage(first, "Material"),
    brand: cleanText(first.Brand),
    dimensions: cleanText(first.Dimensions),
    specFields: { volume: null, texts: [] },
    weightGrams: checks.read("weights", first.ItemWeightG, parseGrams, code),
    countryOfOrigin: cleanText(first.CountryOfOrigin),
    printing: printingOf(feeds.printing.get(firstSku), checks),
    printTechniques: axpolPrintTechniques(variants.map((variant) => variant.printing)),
    attributes: {},
    photos: photosOf(group, checks),
    variants,
  };
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) {
    checks.add("models with an HTML entity left in a text", code);
  }
  return model;
}

// Variants grouped into models, sorted by code so a repeated import builds the same rows
export function normalizeAxpol(feeds: AxpolFeeds): NormalizedCatalog {
  const checks = new Checks();
  const joined = { stock: byCode(feeds.stock, "Stock.List", checks), printing: byCode(feeds.printing, "Printing.List", checks) };
  const variants = new Map<string, Record<string, unknown>>();
  for (const [productId, record] of feeds.products) {
    const sku = cleanText(record.CodeERP);
    if (!sku) checks.add("products without CodeERP", productId);
    else if (variants.has(sku)) checks.add("products with a repeated CodeERP", sku);
    else variants.set(sku, record);
  }
  const groups = new Map<string, [string, Record<string, unknown>][]>();
  for (const entry of [...variants].sort(([left], [right]) => compareCodes(left, right))) {
    const code = splitCode(entry[0]).model;
    const group = groups.get(code);
    if (group) group.push(entry);
    else groups.set(code, [entry]);
  }
  for (const sku of joined.stock.keys()) if (!variants.has(sku)) checks.add("stock records without a product", sku);
  for (const sku of joined.printing.keys()) if (!variants.has(sku)) checks.add("printing records without a product", sku);
  return {
    models: [...groups].map(([code, group]) => modelOf(code, group, joined, checks)),
    techniques: [],
    raw: [...rawRecords("Product.List", feeds.products), ...rawRecords("Stock.List", feeds.stock), ...rawRecords("Printing.List", feeds.printing)],
    fetched: {},
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
