// The records of the four Anda Present feeds the import reads, out of their XML nodes (./xml.ts) as plain data: texts as
// the feed writes them, lists as arrays, the whole record beside for raw_record. Field names are those of the live files
// of 2026-11-09, which differ from the manual's in places (docs/integrations.md). Pure.
import { isRecord } from "../normalize.js";
import { child, listOf, plainOf, textOf, type FeedShape, type XmlNode } from "./xml.js";

export const FEED_SHAPES = {
  products: { root: "products", record: "product" },
  prices: { root: "prices", record: "price" },
  inventories: { root: "inventories", record: "record" },
  labeling: { root: "labelings", record: "labeling" },
} as const satisfies Record<string, FeedShape>;

interface CategoryRef {
  level: string;
  name: string;
  externalId: string;
}

export interface Property {
  name: string;
  values: string[];
}

export interface ProductRecord {
  // The elements of text only, by name: itemNumber, rootItemNumber, designName, name, descriptions, primaryColor...
  fields: Record<string, string>;
  images: string[];
  categories: CategoryRef[];
  specification: Property[];
  flags: string[];
  topics: string[];
  collections: string[];
  relatedProducts: string[];
  geographicalRestrictions: string[];
  packaging: Record<string, string>[];
  certificate: string;
  raw: Record<string, unknown>;
}

export interface PriceRecord {
  itemNumber: string;
  currency: string;
  amount: string;
  type: string;
  raw: Record<string, unknown>;
}

export interface StockRecord {
  itemNumber: string;
  type: string;
  amount: string;
  moreThanAmount: string;
  arrivalDate: string;
  raw: Record<string, unknown>;
}

interface TechnologyRecord {
  code: string;
  name: string;
  maxColor: string;
  maxWmm: string;
  maxHmm: string;
  maxDmm: string;
  fixedSize: string;
}

interface PositionRecord {
  serial: string;
  name: string;
  image: string;
  technologies: TechnologyRecord[];
}

export interface LabelingRecord {
  itemNumber: string;
  printTemplate: string;
  positions: PositionRecord[];
  raw: Record<string, unknown>;
}

// A record node always has elements, so plainOf gives an object; the fallback only satisfies the type
function rawOf(node: XmlNode): Record<string, unknown> {
  const plain = plainOf(node);
  return isRecord(plain) ? plain : { text: plain };
}

function leafFields(node: XmlNode): Record<string, string> {
  return Object.fromEntries(node.children.filter((each) => !each.children.length).map((each) => [each.name, each.text]));
}

function texts(nodes: XmlNode[], name?: string): string[] {
  return nodes.map((each) => (name === undefined ? each.text : textOf(each, name)));
}

export function productOf(node: XmlNode): ProductRecord {
  const theme = child(node, "productTheme");
  const certificates = child(node, "productCertificate");
  return {
    fields: leafFields(node),
    images: texts(listOf(node, "images", "image")),
    categories: listOf(node, "categories", "category").map((each) => ({
      level: textOf(each, "level"), name: textOf(each, "name"), externalId: textOf(each, "externalId"),
    })),
    specification: listOf(node, "specification", "property").map((each) => ({
      name: textOf(each, "name"), values: texts(listOf(each, "values", "value")),
    })),
    flags: theme ? texts(listOf(theme, "flags", "flag"), "name") : [],
    topics: theme ? texts(listOf(theme, "topics", "topic"), "name") : [],
    // <collections><collections><collection>: the list sits one level deeper than its name says
    collections: texts(child(node, "collections")?.children.flatMap((each) => each.children) ?? [], "name"),
    relatedProducts: texts(listOf(node, "relatedProducts", "relatedProduct")),
    geographicalRestrictions: texts(listOf(node, "geographicalRestrictions", "geographicalRestriction")),
    packaging: listOf(node, "packageDatas", "packageData").map(leafFields),
    certificate: certificates ? textOf(certificates, "conformity") : "",
    raw: rawOf(node),
  };
}

export function priceOf(node: XmlNode): PriceRecord {
  return {
    itemNumber: textOf(node, "itemNumber"), currency: textOf(node, "currency"), amount: textOf(node, "amount"),
    type: textOf(node, "type"), raw: rawOf(node),
  };
}

export function stockOf(node: XmlNode): StockRecord {
  return {
    itemNumber: textOf(node, "itemNumber"), type: textOf(node, "type"), amount: textOf(node, "amount"),
    moreThanAmount: textOf(node, "moreThanAmount"), arrivalDate: textOf(node, "arrivalDate"), raw: rawOf(node),
  };
}

export function labelingOf(node: XmlNode): LabelingRecord {
  return {
    itemNumber: textOf(node, "itemNumber"),
    printTemplate: textOf(node, "printTemplate"),
    positions: listOf(node, "positions", "position").map((position) => ({
      serial: textOf(position, "serial"), name: textOf(position, "posName"), image: textOf(position, "posImage"),
      technologies: listOf(position, "technologies", "technology").map((technology) => ({
        code: textOf(technology, "Code"), name: textOf(technology, "Name"), maxColor: textOf(technology, "maxColor"),
        maxWmm: textOf(technology, "maxWmm"), maxHmm: textOf(technology, "maxHmm"), maxDmm: textOf(technology, "maxDmm"),
        fixedSize: textOf(technology, "fixedSize"),
      })),
    })),
    raw: rawOf(node),
  };
}
