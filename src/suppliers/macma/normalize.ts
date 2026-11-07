// The DataSet feeds of Macma and Easy Gifts in the shared model (docs/integrations.md, «Macma і Easy Gifts»): one flat
// record per variant (ARTIKELNR), the model is INTERNETNR. Both brands write the same 120 fields, so one normalizer
// serves both. No stock in either feed (owner's decision 2026-11-05: imported without it, the delivery time LIEFERZEIT
// stays in the variant's attributes). Photos are entries of the brand's ZIP archive (./archive.ts), kept only when the
// archive has them.
import { Checks, compareCodes, hasLeftoverEntity, uniqueRecords, weightInGrams } from "../checks.js";
import { cleanText, localized, parseMinQuantity, rawRecords, restOf } from "../normalize.js";
import type { Localized, ModelInput, NormalizedCatalog, PhotoInput, PriceInput, VariantInput } from "../types.js";
import { type ArchiveSource, archivePhotoUrl } from "./archive.js";
import type { DataSet } from "./dataset.js";
import { COUNTRIES, macmaPrintTechniques, MATERIALS_EN } from "./dictionaries.js";
import { kindOf } from "./kinds.js";

// Not in the feed: the supplier is German and its price lists are in EUR (docs/integrations.md)
const CURRENCY = "EUR";
// EKPREIS<n> (purchase) and KAPREIS<n> (catalogue, about EK × 1.5) from REMENGE<n> pieces; an unused tier is 0
const PRICE_TIERS = 9;
const LIST_MARK = "|";
const MATERIAL_MARK = ",";
const PHOTO_EXTENSION = ".jpg";
// SPARTE values that say a price or an occasion, not a section: the next value is the section
const LABEL_SECTIONS = new Set(["PRICE HITS", "SPECIALS"]);
// "0.006 kg"
const WEIGHT = /^([\d.,]+)\s*(kg|g)$/i;
// "1062006Â Â Â|1112801Â Â Â": the codes of related products, after a no-break space spoilt on the way
const RELATED_CODE = /^[\w-]+/;
const PRINT_POSITIONS = [
  { code: "DRUCK1", area: "DRUCKGROESSE", place: "DRUCKPOS1", placeCode: "DRUCKPOSCODE1" },
  { code: "DRUCK2", area: "DRUCKGROESSE2", place: "DRUCKPOS2", placeCode: "DRUCKPOSCODE2" },
] as const;
const PRINT_PRICE_FIELDS = [
  "EKPRINT1", "EKPRINT2", "EKPRINT3", "EKPRINT4", "EKPRINT5", "EKSETUP",
  "KAPRINT1", "KAPRINT2", "KAPRINT3", "KAPRINT4", "KAPRINT5", "KASETUP",
] as const;
const TEXT_LANGUAGES = ["DE", "IT", "FR", "EN", "ES", "PT", "SK", "RU", "RO", "HU", "PL", "NL", "SE", "FI", "NO"];
// Read into columns, or left out on purpose: NETTOPREIS is EK1 in Macma's feed and KA1 in Easy Gifts', so it says
// nothing on its own; the texts in 12 more languages stay in raw_record
const MAPPED_FIELDS = new Set<string>([
  "id", "INTERNETNR", "ARTIKELNR", "FARBE", "FARBE_DE", "ARTIKELBEZ", "GTIN", "MATERIAL", "GROESSE", "GEWICHT", "URSPRLAND",
  "MARKE", "SPARTE", "BILDNAME", "NETTOPREIS", "UPSELLING",
  ...TEXT_LANGUAGES.flatMap((language) => [`HEADLINE_${language}`, `DESC_${language}`]),
  ...Array.from({ length: PRICE_TIERS }, (_, index) => [`EKPREIS${index + 1}`, `KAPREIS${index + 1}`, `REMENGE${index + 1}`]).flat(),
  ...PRINT_POSITIONS.flatMap((position) => Object.values(position)), ...PRINT_PRICE_FIELDS,
]);

export interface MacmaFeed {
  source: ArchiveSource;
  // The record tag and raw_record feed: macma, easy
  feed: string;
  dataSet: DataSet;
  // The entries of the source's photo archive
  photoNames: ReadonlySet<string>;
}

type Row = Record<string, unknown>;

// The purchase price of the lowest quantity is primary; the catalogue prices go beside, never in its place
export function macmaPrices(row: Row, checks: Checks): PriceInput[] {
  const sku = cleanText(row.ARTIKELNR) ?? undefined;
  const prices: PriceInput[] = [];
  const seen = new Set<string>();
  for (let tier = 1; tier <= PRICE_TIERS; tier += 1) {
    const net = checks.amount("purchase prices", row[`EKPREIS${tier}`], sku);
    const catalog = checks.amount("catalogue prices", row[`KAPREIS${tier}`], sku);
    if (net === null && catalog === null) continue;
    const minQuantity = parseMinQuantity(row[`REMENGE${tier}`]);
    if (minQuantity === null) {
      checks.add("price tiers without a quantity", sku);
      continue;
    }
    const base = { currency: CURRENCY, minQuantity, validUntil: null };
    for (const [kind, amount] of [["net", net], ["catalog", catalog]] as const) {
      if (amount === null) continue;
      if (seen.has(`${kind} ${minQuantity}`)) {
        checks.add("price tiers with a repeated quantity", sku);
        continue;
      }
      seen.add(`${kind} ${minQuantity}`);
      prices.push({ ...base, kind, amount, isPrimary: false });
    }
  }
  const primary = prices.filter((price) => price.kind === "net").sort((left, right) => left.minQuantity - right.minQuantity)[0];
  if (primary) primary.isPrimary = true;
  return prices;
}

// "Edelstahl,Bambus" -> "stainless steel, bamboo"; a part the dictionary lacks stays German and is counted
export function materialOf(value: unknown, checks: Checks): Localized {
  const german = cleanText(value);
  if (!german) return {};
  const english = german.split(MATERIAL_MARK).map((part) => part.trim()).filter(Boolean).map((part) => {
    const word = MATERIALS_EN[part.toLowerCase()];
    if (!word) checks.add("materials without an English name", part);
    return word ?? part;
  });
  return { en: english.join(", "), de: german };
}

// The first SPARTE value that names a section, and the kind of the product by its name (./kinds.ts)
export function categoryPath(row: Row, nameEn: string | undefined, checks: Checks, code: string): string[] {
  const sections = (cleanText(row.SPARTE) ?? "").split(LIST_MARK).map((value) => value.trim()).filter(Boolean);
  const section = sections.find((value) => !LABEL_SECTIONS.has(value)) ?? sections[0];
  const kind = nameEn ? kindOf(nameEn) : null;
  if (!section) checks.add("models without a section", code);
  if (!kind) checks.add("models without a kind", nameEn ?? code);
  return [section, kind].filter((level) => level !== undefined && level !== null);
}

function weightOf(value: unknown, checks: Checks, code: string): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = WEIGHT.exec(text);
  if (!match) checks.add("weights with an unknown unit", code);
  return match ? weightInGrams(match[1], match[2], checks, code) : null;
}

function printingOf(row: Row): Record<string, unknown> {
  const positions = PRINT_POSITIONS.map((fields) => ({
    code: cleanText(row[fields.code]), area: cleanText(row[fields.area]), place: cleanText(row[fields.place]),
    placeCode: cleanText(row[fields.placeCode]),
  })).filter((position) => position.code);
  const prices = Object.fromEntries(PRINT_PRICE_FIELDS.flatMap((field) => {
    const value = cleanText(row[field]);
    return value ? [[field, value]] : [];
  }));
  return { positions, prices };
}

function attributesOf(row: Row): Record<string, unknown> {
  const related = (cleanText(row.UPSELLING) ?? "").split(LIST_MARK).flatMap((part) => RELATED_CODE.exec(part.trim()) ?? []);
  return { ...restOf(row, MAPPED_FIELDS), ...(related.length ? { UPSELLING: related } : {}) };
}

function variantOf(sku: string, code: string, row: Row, feed: MacmaFeed, photos: Map<string, PhotoInput>, checks: Checks): VariantInput {
  const names = (cleanText(row.BILDNAME) ?? "").split(LIST_MARK).map((name) => name.trim()).filter(Boolean);
  let position = 0;
  for (const name of names) {
    const file = `${name}${PHOTO_EXTENSION}`;
    if (!feed.photoNames.has(file)) {
      checks.add("photos not in the archive", file);
      continue;
    }
    const url = archivePhotoUrl(feed.source, file);
    let photo = photos.get(url);
    if (!photo) {
      photo = { url, urlLarge: null, kind: null, position: photos.size, variantLinks: [] };
      photos.set(url, photo);
    }
    photo.variantLinks.push({ sku, position });
    position += 1;
  }
  if (!position) checks.add("variants without photos", sku);
  const prices = macmaPrices(row, checks);
  if (!prices.length) checks.add("variants without a price", sku);
  else if (!prices.some((price) => price.isPrimary)) checks.add("variants without a net price", sku);
  const english = cleanText(row.FARBE);
  const german = cleanText(row.FARBE_DE);
  return {
    sku, externalId: null, ean: cleanText(row.GTIN),
    color: { ...(english ? { en: english } : {}), ...(german ? { de: german } : {}) },
    colorCode: sku.startsWith(code) && sku.length > code.length ? sku.slice(code.length) : null,
    colorGroup: null, size: null, status: null, printing: null, attributes: attributesOf(row), prices, stock: null,
  };
}

function modelOf(code: string, group: [string, Row][], feed: MacmaFeed, checks: Checks): ModelInput {
  const [, first] = group[0] ?? ["", {}];
  const photos = new Map<string, PhotoInput>();
  const variants = group.map(([sku, row]) => variantOf(sku, code, row, feed, photos, checks));
  const name = localized({ en: first.HEADLINE_EN, de: first.HEADLINE_DE, pl: first.HEADLINE_PL });
  const path = categoryPath(first, name.en, checks, code);
  const country = cleanText(first.URSPRLAND);
  const countryOfOrigin = country ? COUNTRIES[country.toUpperCase()] ?? null : null;
  if (country && !countryOfOrigin) checks.add("countries without an ISO code", country);
  const printCodes = group.flatMap(([, row]) => PRINT_POSITIONS.map((fields) => cleanText(row[fields.code])))
    .filter((value) => value !== null);
  const model: ModelInput = {
    code, externalId: null, name,
    description: localized({ en: first.DESC_EN, de: first.ARTIKELBEZ, pl: first.DESC_PL }),
    category: path.length ? { en: path } : {}, categoryCode: null, material: materialOf(first.MATERIAL, checks),
    brand: cleanText(first.MARKE), dimensions: cleanText(first.GROESSE), specFields: { volume: null, texts: [] },
    weightGrams: weightOf(first.GEWICHT, checks, code), countryOfOrigin,
    printing: printingOf(first), printTechniques: macmaPrintTechniques([...new Set(printCodes)]),
    attributes: {}, photos: [...photos.values()], variants,
  };
  if (!name.en) checks.add("models without an English name", code);
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

export function normalizeMacmaFeed(feed: MacmaFeed): NormalizedCatalog {
  const checks = new Checks();
  for (let index = 0; index < feed.dataSet.unreadRecords; index += 1) checks.add(`${feed.feed} records with content not read`);
  for (let index = 0; index < feed.dataSet.repairedValues; index += 1) checks.add("values with double-encoded UTF-8, repaired");
  const variants = uniqueRecords(feed.dataSet.records, "ARTIKELNR", new Set(), `${feed.feed} records`, checks);
  const groups = new Map<string, [string, Row][]>();
  for (const [sku, row] of variants.sort(([left], [right]) => compareCodes(left, right))) {
    const code = cleanText(row.INTERNETNR);
    if (!code) {
      checks.add("variants without INTERNETNR", sku);
      continue;
    }
    groups.set(code, [...(groups.get(code) ?? []), [sku, row]]);
  }
  const models = [...groups].sort(([left], [right]) => compareCodes(left, right))
    .map(([code, group]) => modelOf(code, group, feed, checks));
  return {
    models,
    techniques: [],
    raw: rawRecords(feed.feed, new Map(variants)),
    fetched: { [feed.feed]: feed.dataSet.records.length, models: models.length, "archive entries": feed.photoNames.size },
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
