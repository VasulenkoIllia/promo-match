// Axpol records in the shared model. One Product.List record is one variant (a colour or a size); splitCode reads
// its model from CodeERP. Stock and printing join by CodeERP.
import { Checks, compareCodes, hasLeftoverEntity } from "../checks.js";
import {
  cleanText, isBlank, localized, parseGrams, parseInteger, parseUrl, rawRecords, restOf,
} from "../normalize.js";
import type {
  Localized, ModelInput, NormalizedCatalog, OfferKind, PhotoInput, PriceInput, StockInput, VariantInput,
} from "../types.js";
import { axpolPrintTechniques } from "./print-codes.js";

const LANGUAGES = { pl: "PL", en: "EN", de: "DE", fr: "FR" } as const;
const LOCALIZED_FIELDS = ["Title", "Description", "Material", "MainCategory", "SubCategory", "Color"];
// The German site gives EUR prices (owner's decision 2026-11-19, docs/decisions.md)
const CURRENCY = "EUR";
// GBP prices of the German site: 0.00 in its answer, not a price we buy at, so left out
const LEFT_OUT = ["NetPriceGBP", "CatalogPriceGBP"];
// Axpol 2026-11-18: its API prices are the agencies' base prices, ours is the net price less this, but for the
// promotion and sale prices it marks with 1 (owner's decision 2026-11-19, docs/decisions.md)
export const AXPOL_DISCOUNT_PERCENT = 25;
const FLAG_ON = 1;
const FLAG_OFF = 0;
const PERCENT = 100;
// A percent of an amount has two decimal places more than the amount
const PERCENT_PLACES = 2;
const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/;
// Fields that become columns or rows, or are left out; the rest of a record goes to the variant's attributes
const MAPPED = new Set([
  "productId", "CodeERP", "EAN", "Brand", "Dimensions", "ItemWeightG", "CountryOfOrigin", "Foto",
  "NetPriceEUR", "CatalogPriceEUR", "FinalNetPrice", "Promotion", "Sale",
  "InStock", "reserved", "onOrder", "nextDelivery", "Days", ...LEFT_OUT,
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

// amount × (100 - percent) / 100 on the digits, so no float rounding creeps in: "3.40" less 25% is "2.55"
export function lessPercent(amount: string, percent: number): string {
  const [whole = "", fraction = ""] = amount.split(".");
  const places = fraction.length + PERCENT_PLACES;
  const digits = (BigInt(`${whole}${fraction}`) * BigInt(PERCENT - percent)).toString().padStart(places + 1, "0");
  const rest = digits.slice(-places).replace(/0+$/, "");
  return rest ? `${digits.slice(0, -places)}.${rest}` : digits.slice(0, -places);
}

// FinalNetPrice is no price but Axpol's mark 1: the net price is final, already a promotion or sale price. Checked on
// the live EUR data 2026-11-19: every 1 has a net price near 0.55 of the catalogue one, every 0 near 0.77, the 28 sale
// records with 0 included. Only a 0 gets the discount: anything else is counted and keeps the higher price.
function hasNoDiscount(record: Record<string, unknown>, checks: Checks, sku: string | undefined): boolean {
  const flag = parseInteger(record.FinalNetPrice);
  if (flag === FLAG_OFF) return false;
  if (flag !== FLAG_ON) checks.add("FinalNetPrice values other than 0 or 1", sku);
  return true;
}

// Our net price is primary (owner's decisions 2026-10-28 and 2026-11-19), the catalogue price goes beside it. A price
// of 0 means none.
export function axpolPrices(record: Record<string, unknown>, checks: Checks): PriceInput[] {
  const sku = cleanText(record.CodeERP) ?? undefined;
  const base = { currency: CURRENCY, minQuantity: 1, validUntil: null };
  const prices: PriceInput[] = [];
  const net = checks.amount("NetPriceEUR prices", record.NetPriceEUR, sku);
  // A JSON number may read as "1e-7", which lessPercent cannot take; the feed gives prices as strings (2026-11-19)
  if (net !== null && !PLAIN_DECIMAL.test(net)) {
    checks.add("NetPriceEUR prices not in plain digits", sku);
  } else if (net !== null) {
    const amount = hasNoDiscount(record, checks, sku) ? net : lessPercent(net, AXPOL_DISCOUNT_PERCENT);
    prices.push({ ...base, kind: "net", amount, isPrimary: true });
  }
  const catalog = checks.amount("CatalogPriceEUR prices", record.CatalogPriceEUR, sku);
  if (catalog !== null) prices.push({ ...base, kind: "catalog", amount: catalog, isPrimary: false });
  return prices;
}

// A 0 or 1 mark; anything else is counted and read as no mark
function flagOf(record: Record<string, unknown>, field: string, checks: Checks, sku: string | undefined): boolean {
  const flag = parseInteger(record[field]);
  if (flag !== FLAG_ON && flag !== FLAG_OFF) checks.add(`${field} values other than 0 or 1`, sku);
  return flag === FLAG_ON;
}

// Axpol's promotion and sale marks; they never came together (2026-11-18), so both are counted and promotion wins
export function axpolOffer(record: Record<string, unknown>, checks: Checks): OfferKind | null {
  const sku = cleanText(record.CodeERP) ?? undefined;
  const isPromotion = flagOf(record, "Promotion", checks, sku);
  const isSale = flagOf(record, "Sale", checks, sku);
  if (isPromotion && isSale) checks.add("variants marked both promotion and sale", sku);
  if (isPromotion) return "promotion";
  return isSale ? "sale" : null;
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
    offer: axpolOffer(record, checks),
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
