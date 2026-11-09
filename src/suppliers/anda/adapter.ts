import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { type AndaSource, describeFeed, type FeedFile, isoTime, readFeed } from "./api.js";
import { normalizeAnda } from "./normalize.js";
import { FEED_SHAPES, labelingOf, priceOf, productOf, stockOf } from "./records.js";
import { parseRecords, type XmlNode } from "./xml.js";

// One feed read and parsed at a time, so only one XML text is held: each file is complete when it ends with its root's
// closing tag (./xml.ts), so a catalogue read without an error is a complete one
async function readRecords<T>(source: AndaSource, feed: keyof typeof FEED_SHAPES, map: (node: XmlNode) => T,
  context: FetchContext): Promise<{ records: T[]; file: Omit<FeedFile, "xml"> }> {
  context.signal.throwIfAborted();
  const { xml, ...file } = await readFeed(source, feed, context.signal);
  context.log(describeFeed(feed, { xml, ...file }));
  return { records: parseRecords(xml, feed, FEED_SHAPES[feed], map), file };
}

async function fetchCatalog(source: AndaSource, context: FetchContext): Promise<CatalogSnapshot> {
  if (source.kind === "network") context.secrets.push(source.token);
  else context.log("anda: reading the saved feeds in ANDA_FEED_DIR, not the network");
  const products = await readRecords(source, "products", productOf, context);
  const prices = await readRecords(source, "prices", priceOf, context);
  const inventories = await readRecords(source, "inventories", stockOf, context);
  const labeling = await readRecords(source, "labeling", labelingOf, context);
  const snapshot = normalizeAnda({
    products: products.records, prices: prices.records, inventories: inventories.records, labeling: labeling.records,
    stockUpdatedAt: isoTime(inventories.file.lastModified),
  });
  // Saved files are as old as they are: the report says so beside the counts
  const saved = [products, prices, inventories, labeling].map(({ file }) => file.savedAt).filter((time) => time !== null).sort();
  if (saved[0]) snapshot.warnings.push(`read from saved feeds, the oldest saved ${saved[0]}, not the live ones`);
  return { ...snapshot, isComplete: true };
}

// Whether this machine may read the feeds at all: one GET of the smallest one (22 KB)
async function probe(source: AndaSource, context: FetchContext): Promise<void> {
  if (source.kind === "directory") {
    context.log("anda: ANDA_FEED_DIR is set, the feeds are files, nothing to probe");
    return;
  }
  context.secrets.push(source.token);
  const file = await readFeed(source, "categories", context.signal);
  context.log(`${describeFeed("categories", file)}: the feeds answer this IP`);
}

export function andaAdapter(source: AndaSource): SupplierAdapter {
  return {
    source: { code: "anda", name: "Anda Present", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(source, context),
    probe: (context) => probe(source, context),
  };
}
