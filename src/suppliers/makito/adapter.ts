import { MS_PER_SECOND, pause } from "../http.js";
import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { assetUrl, type Credentials, MakitoError, MakitoSession } from "./api.js";
import { normalizeMakito } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const FEEDS = {
  catalog: { path: "catalog/files", query: { format: "JSON", lang: "en" } },
  stock: { path: "stock/files", query: { format: "JSON" } },
  prices: { path: "price-list/files", query: { format: "JSON" } },
  colors: { path: "catalog/colors", query: { language: "en" } },
  sizes: { path: "catalog/sizes", query: { language: "en" } },
} as const;
// The print areas of the models and the names of their techniques (5.1 MB and 0.2 MB, 2026-11-04): the techniques of the
// models without the catalogue's "Marking Techniques" categories (docs/integrations.md, «Техніка друку»). Not required,
// unlike the feeds above: without them an import still keeps the catalogue, with the techniques of the categories alone.
const PRINT_FEEDS = {
  printConfig: { path: "print-config/files", query: { format: "JSON", lang: "en" } },
  printNames: { path: "print-price-list/files", query: { format: "JSON" } },
} as const;
// --probe: the request limit's refill. A few small photos in a row, then one after each pause; the photo is the
// example of Makito's own documentation, a thumbnail of 15246.
const PROBE_PHOTO = "15246/thumbnail/5246-W.jpg";
const PROBE_BURST = 5;
const PROBE_PAUSES_MS = [30_000, 60_000];
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_BYTES = 20 * BYTES_PER_MB;

async function readFeed(session: MakitoSession, name: string, feed: { path: string; query: Record<string, string> },
  context: FetchContext): Promise<unknown> {
  const file = await session.read(feed.path, feed.query, context.signal);
  context.log(`makito ${name}: ${(file.bytes / BYTES_PER_MB).toFixed(1)} MB, x-ratelimit-remaining ${file.rateLimitRemaining ?? "not sent"}`);
  return file.json;
}

// Both print feeds or none. A failed read (Makito's error, a limit, a file that is not JSON) is a warning in the report:
// the models then keep the techniques of the categories alone until the next import. A stop from outside, or a fault of
// our own code, is not swallowed.
async function readPrintFeeds(session: MakitoSession, context: FetchContext): Promise<{ feeds: { printConfig?: unknown; printNames?: unknown }; warnings: string[] }> {
  try {
    const printConfig = await readFeed(session, "printConfig", PRINT_FEEDS.printConfig, context);
    const printNames = await readFeed(session, "printNames", PRINT_FEEDS.printNames, context);
    return { feeds: { printConfig, printNames }, warnings: [] };
  } catch (error) {
    if (context.signal.aborted || !(error instanceof MakitoError)) throw error;
    return { feeds: {}, warnings: [`print-config not read, print techniques come from the categories only: ${error.message}`] };
  }
}

// Every feed comes whole without page parameters (2026-11-04), so a snapshot that normalizes is a complete one. One
// login for the run: the token lives 60 minutes, the reads take seconds.
async function fetchCatalog(credentials: Credentials, context: FetchContext): Promise<CatalogSnapshot> {
  const session = new MakitoSession(credentials, context.secrets);
  const files: Record<string, unknown> = {};
  for (const [name, feed] of Object.entries(FEEDS)) files[name] = await readFeed(session, name, feed, context);
  const print = await readPrintFeeds(session, context);
  const snapshot = normalizeMakito({
    catalog: files.catalog, stock: files.stock, prices: files.prices, colors: files.colors, sizes: files.sizes, ...print.feeds,
  });
  return { ...snapshot, warnings: [...print.warnings, ...snapshot.warnings], isComplete: true };
}

async function probe(credentials: Credentials, context: FetchContext): Promise<void> {
  const session = new MakitoSession(credentials, context.secrets);
  const started = Date.now();
  const photo = async (label: string): Promise<void> => {
    const answer = await session.fetchAsset(assetUrl(PROBE_PHOTO), {
      method: "GET", timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES, maxAttempts: 1, signal: context.signal,
    });
    context.log(`makito probe ${label}: at ${((Date.now() - started) / MS_PER_SECOND).toFixed(1)} s HTTP ${answer.status},`
      + ` ${answer.body.length} bytes, x-ratelimit-remaining ${answer.headers["x-ratelimit-remaining"] ?? "not sent"},`
      + ` retry-after ${answer.headers["retry-after"] ?? "not sent"}`);
  };
  for (const name of ["colors", "sizes"] as const) {
    const file = await session.read(FEEDS[name].path, FEEDS[name].query, context.signal);
    const count = Array.isArray(file.json) ? `${file.json.length} records` : `not a list: ${typeof file.json}`;
    context.log(`makito probe ${name}: ${count}, x-ratelimit-remaining ${file.rateLimitRemaining ?? "not sent"}`);
  }
  for (let index = 1; index <= PROBE_BURST; index += 1) await photo(`photo ${index} of ${PROBE_BURST}`);
  for (const pauseMs of PROBE_PAUSES_MS) {
    await pause(pauseMs, context.signal);
    await photo(`photo after ${pauseMs / MS_PER_SECOND} s`);
  }
}

export function makitoAdapter(credentials: Credentials): SupplierAdapter {
  return {
    source: { code: "makito", name: "Makito", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(credentials, context),
    probe: (context) => probe(credentials, context),
  };
}
