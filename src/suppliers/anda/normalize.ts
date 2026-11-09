// The Anda Present feeds in the shared model (docs/integrations.md, «Anda Present XML»): products is one record per
// variant (itemNumber) with its model (rootItemNumber); prices, inventories and labeling join by itemNumber. The model's
// texts come from its own code when it is a variant too, else from its first variant by code: names differ in 106 of
// 3444 models (an assembled product names its part). Pure.
import { Checks, compareCodes, hasLeftoverEntity } from "../checks.js";
import { cleanText, isBlank, localized, parseDecimal, parseGrams, parseUrl, rawRecords, restOf } from "../normalize.js";
import type { ModelInput, NormalizedCatalog, PhotoInput, PrintTechniqueInput, VariantInput } from "../types.js";
import { splitItemNumber } from "./codes.js";
import { andaPrices, andaStock } from "./offer.js";
import { andaPrintTechniques } from "./print-codes.js";
import type { LabelingRecord, PriceRecord, ProductRecord, Property, StockRecord } from "./records.js";

const LANGUAGE = "en";
const FLAG_ON = "1";
const MATERIAL = /^Material \d$/;
const SIZE = "Size";
const CAPACITY = "Capacity";
// Read into columns or the model's attributes; the rest of a variant's texts go to its attributes as they are
const MAPPED_FIELDS = new Set([
  "itemNumber", "rootItemNumber", "designName", "name", "descriptions", "primaryColor", "secondaryColor", "primaryImage",
  "eanCode", "brandName", "countryOfOrigin", "individualProductWeightGram", "tariffNumber", "assemblyProduct",
  "temporarilyUnavailable",
]);

export interface AndaFeeds {
  products: ProductRecord[];
  prices: PriceRecord[];
  inventories: StockRecord[];
  labeling: LabelingRecord[];
  // The inventories feed's last-modified as an ISO time; null when it was read from a file
  stockUpdatedAt: string | null;
}

interface Joined {
  prices: Map<string, PriceRecord[]>;
  stock: Map<string, StockRecord[]>;
  labeling: Map<string, LabelingRecord>;
  stockUpdatedAt: string | null;
}

function groupBy<T>(records: T[], keyOf: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

// "green/white" for a two-coloured variant: the colour groups of a search read both names
export function colorOf(fields: Record<string, string>): Record<string, string> {
  const names = [cleanText(fields.primaryColor), cleanText(fields.secondaryColor)].filter((name) => name !== null);
  return names.length ? { [LANGUAGE]: [...new Set(names)].join("/") } : {};
}

// "CreaCup customisable thermo cup": the product line's name and the kind of product, which alone says little
export function nameOf(fields: Record<string, string>): string | null {
  const parts = [cleanText(fields.designName), cleanText(fields.name)].filter((part) => part !== null);
  return parts.length ? parts.join(" ") : null;
}

function valuesOf(property: Property): string | null {
  return cleanText(property.values.map((value) => cleanText(value)).filter(Boolean).join(", "));
}

function propertyValue(specification: Property[], name: string): string | null {
  const property = specification.find((each) => each.name === name);
  return property ? valuesOf(property) : null;
}

// Material 1 to 5 in their order; the first is the body
export function materialOf(specification: Property[]): string | null {
  const materials = specification.filter((each) => MATERIAL.test(each.name)).sort((left, right) => compareCodes(left.name, right.name))
    .map(valuesOf).filter((value) => value !== null);
  return materials.length ? materials.join(", ") : null;
}

// The levels 1 to 3 by their level, the deepest one's id as the code. A level without a number or a name is counted:
// the path would come out shorter.
export function categoryOf(product: ProductRecord, checks: Checks): { path: string[]; code: string | null } {
  const levels = product.categories.map((category) => ({ ...category, rank: Number(category.level), title: cleanText(category.name) }))
    .filter((category) => {
      const isRead = Number.isInteger(category.rank) && category.title !== null;
      if (!isRead) checks.add("category levels without a level number or a name", product.fields.itemNumber);
      return isRead;
    })
    .sort((left, right) => left.rank - right.rank);
  return { path: levels.map((category) => category.title ?? ""), code: cleanText(levels.at(-1)?.externalId) };
}

function printingOf(record: LabelingRecord | undefined, checks: Checks): unknown {
  if (!record) return null;
  const sku = record.itemNumber;
  const size = (value: string) => checks.read("print sizes", value, parseDecimal, sku);
  return {
    template: parseUrl(record.printTemplate),
    positions: record.positions.map((position) => ({
      serial: cleanText(position.serial), name: cleanText(position.name), image: parseUrl(position.image),
      techniques: position.technologies.map((technology) => ({
        code: cleanText(technology.code), maxColors: cleanText(technology.maxColor), maxWidthMm: size(technology.maxWmm),
        maxHeightMm: size(technology.maxHmm), maxDepthMm: size(technology.maxDmm), isFixedSize: technology.fixedSize === FLAG_ON,
      })),
    })),
  };
}

// The primary image first (it is the first of images for all but 2 of 10 057 variants); the same link once
function addPhotos(product: ProductRecord, sku: string, photos: Map<string, PhotoInput>, checks: Checks): void {
  const values = [product.fields.primaryImage ?? "", ...product.images].filter((value) => !isBlank(value));
  const urls = [...new Set(values.map((value) => {
    const url = parseUrl(value);
    if (!url) checks.add("photo links that are not https URLs", sku);
    return url;
  }).filter((url) => url !== null))];
  if (!urls.length) checks.add("variants without photos", sku);
  urls.forEach((url, position) => {
    let photo = photos.get(url);
    if (!photo) {
      photo = { url, urlLarge: null, kind: null, position: photos.size, variantLinks: [] };
      photos.set(url, photo);
    }
    photo.variantLinks.push({ sku, position });
  });
}

function variantOf(product: ProductRecord, sku: string, code: string, joined: Joined, checks: Checks): VariantInput {
  const { fields } = product;
  const tail = splitItemNumber(sku, code, fields.assemblyProduct === FLAG_ON);
  if (!tail) checks.add("item numbers with a tail the rule does not read", sku);
  const prices = andaPrices(joined.prices.get(sku) ?? [], checks);
  if (!prices.length) checks.add("variants without a price", sku);
  else if (!prices.some((price) => price.isPrimary)) checks.add("variants without a net price", sku);
  const { stock, external } = andaStock(joined.stock.get(sku) ?? [], joined.stockUpdatedAt, checks);
  const isMadeToOrder = fields.customProduction === FLAG_ON;
  if (!stock) checks.add(isMadeToOrder ? "made-to-order variants without stock" : "variants without stock", sku);
  const printing = printingOf(joined.labeling.get(sku), checks);
  if (!printing) checks.add("variants without print positions", sku);
  return {
    sku, externalId: null, ean: cleanText(fields.eanCode), color: colorOf(fields), colorCode: tail?.colorCode ?? null,
    colorGroup: null, size: tail?.size ?? null,
    status: fields.temporarilyUnavailable === FLAG_ON ? "temporarily unavailable" : null,
    printing,
    attributes: {
      ...restOf(fields, MAPPED_FIELDS),
      ...(tail?.version ? { version: tail.version } : {}),
      ...(tail?.part ? { part: tail.part } : {}),
      ...(Object.keys(external).length ? { externalStock: external } : {}),
    },
    prices, stock,
  };
}

function modelAttributes(head: ProductRecord, checks: Checks): Record<string, unknown> {
  const lists = {
    flags: head.flags, topics: head.topics, collections: head.collections, relatedProducts: head.relatedProducts,
    geographicalRestrictions: head.geographicalRestrictions, packaging: head.packaging,
  };
  // The properties not read into columns: "Dishwasher safe", "Pen type", "Textile size"...
  const specification: Record<string, string> = {};
  for (const property of head.specification) {
    const value = valuesOf(property);
    const isMapped = MATERIAL.test(property.name) || property.name === SIZE || property.name === CAPACITY;
    if (!property.name || value === null) checks.add("specification properties without a name or a value", head.fields.itemNumber);
    else if (Object.hasOwn(specification, property.name)) checks.add("specification properties with a repeated name", head.fields.itemNumber);
    else if (!isMapped) specification[property.name] = value;
  }
  const certificate = parseUrl(head.certificate);
  const tariffNumber = cleanText(head.fields.tariffNumber);
  return {
    ...Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length)),
    ...(Object.keys(specification).length ? { specification } : {}),
    ...(certificate ? { certificate } : {}),
    ...(tariffNumber ? { tariffNumber } : {}),
    ...(head.fields.assemblyProduct === FLAG_ON ? { isAssembly: true } : {}),
  };
}

function modelOf(code: string, group: ProductRecord[], joined: Joined, checks: Checks): ModelInput {
  const head = group.find((product) => product.fields.itemNumber === code) ?? group[0];
  if (!head) throw new Error(`anda model ${code} has no variants`);
  if (new Set(group.map((product) => cleanText(product.fields.name))).size > 1) checks.add("models whose variants have different names", code);
  const photos = new Map<string, PhotoInput>();
  const variants = group.map((product) => {
    const sku = product.fields.itemNumber ?? "";
    addPhotos(product, sku, photos, checks);
    return variantOf(product, sku, code, joined, checks);
  });
  const category = categoryOf(head, checks);
  if (!category.path.length) checks.add("models without a category", code);
  const name = nameOf(head.fields);
  const labelCodes = group.flatMap((product) => joined.labeling.get(product.fields.itemNumber ?? "")?.positions ?? [])
    .flatMap((position) => position.technologies.map((technology) => cleanText(technology.code)))
    .filter((value) => value !== null);
  const model: ModelInput = {
    code, externalId: null, name: localized({ [LANGUAGE]: name }),
    description: localized({ [LANGUAGE]: head.fields.descriptions }),
    category: category.path.length ? { [LANGUAGE]: category.path } : {}, categoryCode: category.code,
    material: localized({ [LANGUAGE]: materialOf(head.specification) }), brand: cleanText(head.fields.brandName),
    dimensions: propertyValue(head.specification, SIZE),
    specFields: { volume: propertyValue(head.specification, CAPACITY), texts: [] },
    weightGrams: checks.read("weights", head.fields.individualProductWeightGram, parseGrams, code),
    countryOfOrigin: cleanText(head.fields.countryOfOrigin),
    printing: variants.find((variant) => variant.sku === head.fields.itemNumber)?.printing ?? null,
    printTechniques: andaPrintTechniques([...new Set(labelCodes)]),
    attributes: modelAttributes(head, checks), photos: [...photos.values()], variants,
  };
  if (!name) checks.add("models without an English name", code);
  if ([model.name, model.description, model.material].some(hasLeftoverEntity)) checks.add("models with an HTML entity left in a text", code);
  return model;
}

// Every code with the English name the labeling feed gives it, packaging included
export function andaTechniques(labeling: LabelingRecord[], checks: Checks): PrintTechniqueInput[] {
  const names = new Map<string, string>();
  for (const technology of labeling.flatMap((record) => record.positions.flatMap((position) => position.technologies))) {
    const code = cleanText(technology.code);
    const name = cleanText(technology.name);
    if (!code || !name) checks.add("print techniques without a code or a name", code ?? undefined);
    else if (!names.has(code)) names.set(code, name);
  }
  return [...names].sort(([left], [right]) => compareCodes(left, right)).map(([code, name]) => ({ code, name: { [LANGUAGE]: name } }));
}

function uniqueProducts(products: ProductRecord[], checks: Checks): Map<string, ProductRecord> {
  const result = new Map<string, ProductRecord>();
  for (const product of products) {
    const sku = cleanText(product.fields.itemNumber);
    if (!sku) checks.add("products without itemNumber");
    else if (result.has(sku)) checks.add("products with a repeated itemNumber", sku);
    else result.set(sku, { ...product, fields: { ...product.fields, itemNumber: sku } });
  }
  return result;
}

function unjoined(keys: Iterable<string>, products: Map<string, ProductRecord>, label: string, checks: Checks): void {
  for (const key of keys) if (!products.has(key)) checks.add(label, key);
}

// The records that name their item number; the others are counted, they join nothing
function withItemNumber<T extends { itemNumber: string }>(records: T[], feed: string, checks: Checks): T[] {
  return records.filter((record) => {
    const hasCode = !isBlank(record.itemNumber);
    if (!hasCode) checks.add(`${feed} records without itemNumber`);
    return hasCode;
  });
}

export function normalizeAnda(feeds: AndaFeeds): NormalizedCatalog {
  const checks = new Checks();
  const products = uniqueProducts(feeds.products, checks);
  const labeling = new Map<string, LabelingRecord>();
  for (const record of withItemNumber(feeds.labeling, "labeling", checks)) {
    if (labeling.has(record.itemNumber)) checks.add("labeling records with a repeated itemNumber", record.itemNumber);
    else labeling.set(record.itemNumber, record);
  }
  const joined: Joined = {
    prices: groupBy(withItemNumber(feeds.prices, "prices", checks), (record) => record.itemNumber),
    stock: groupBy(withItemNumber(feeds.inventories, "inventories", checks), (record) => record.itemNumber),
    labeling,
    stockUpdatedAt: feeds.stockUpdatedAt,
  };
  const sorted = [...products.values()].sort((left, right) => compareCodes(left.fields.itemNumber ?? "", right.fields.itemNumber ?? ""));
  const groups = groupBy(sorted.filter((product) => {
    const hasRoot = cleanText(product.fields.rootItemNumber) !== null;
    if (!hasRoot) checks.add("products without rootItemNumber", product.fields.itemNumber);
    return hasRoot;
  }), (product) => cleanText(product.fields.rootItemNumber) ?? "");
  const models = [...groups].sort(([left], [right]) => compareCodes(left, right))
    .map(([code, group]) => modelOf(code, group, joined, checks));
  unjoined(joined.prices.keys(), products, "price codes without a product", checks);
  unjoined(joined.stock.keys(), products, "stock codes without a product", checks);
  unjoined(labeling.keys(), products, "labeling codes without a product", checks);
  // Prices and stock have several records per item number: one raw record holds them all
  const rawOfGroups = <T extends { raw: Record<string, unknown> }>(byCode: Map<string, T[]>) =>
    new Map([...byCode].map(([key, records]) => [key, { records: records.map((record) => record.raw) }]));
  return {
    models,
    techniques: andaTechniques(feeds.labeling, checks),
    raw: [
      ...rawRecords("products", new Map([...products].map(([sku, product]) => [sku, product.raw]))),
      ...rawRecords("prices", rawOfGroups(joined.prices)),
      ...rawRecords("inventories", rawOfGroups(joined.stock)),
      ...rawRecords("labeling", new Map([...labeling].map(([sku, record]) => [sku, record.raw]))),
    ],
    fetched: {
      products: feeds.products.length, prices: feeds.prices.length, inventories: feeds.inventories.length,
      labeling: feeds.labeling.length, models: models.length,
    },
    checks: checks.counts,
    examples: checks.examples,
    warnings: [],
  };
}
