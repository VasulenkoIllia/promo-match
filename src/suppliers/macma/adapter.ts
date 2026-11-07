import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { FEEDS, readFeed } from "./api.js";
import { type ArchiveSource, ARCHIVES, ArchiveReader } from "./archive.js";
import { parseDataSet } from "./dataset.js";
import { normalizeMacmaFeed } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const NAMES: Record<ArchiveSource, string> = { macma: "Macma", easygifts: "Easy Gifts" };

// The feed is one file, complete when it ends with its closing tag (./dataset.ts). The directory of the photo archive
// says which BILDNAME photos exist; without it the import stops rather than drop every photo.
async function fetchCatalog(source: ArchiveSource, feedUrl: URL, context: FetchContext): Promise<CatalogSnapshot> {
  const feed = await readFeed(source, feedUrl, context.signal);
  context.log(`${source} feed: ${(feed.bytes / BYTES_PER_MB).toFixed(1)} MB, last-modified ${feed.lastModified ?? "not sent"}`);
  const dataSet = parseDataSet(feed.xml, FEEDS[source].tag);
  const index = await new ArchiveReader().index(ARCHIVES[source], context.signal);
  context.log(`${source} photo archive: ${index.entries.size} entries, directory ${(index.directoryBytes / BYTES_PER_MB).toFixed(1)} MB`);
  const snapshot = normalizeMacmaFeed({ source, feed: FEEDS[source].tag, dataSet, photoNames: new Set(index.entries.keys()) });
  return { ...snapshot, isComplete: true };
}

function adapterOf(source: ArchiveSource, feedUrl: URL): SupplierAdapter {
  return {
    source: { code: source, name: NAMES[source], kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(source, feedUrl, context),
    probe: (context) => {
      context.log(`${source}: nothing to probe, one public file and one public archive`);
      return Promise.resolve();
    },
  };
}

export const macmaAdapter = (feedUrl: URL): SupplierAdapter => adapterOf("macma", feedUrl);
export const easygiftsAdapter = (feedUrl: URL): SupplierAdapter => adapterOf("easygifts", feedUrl);
