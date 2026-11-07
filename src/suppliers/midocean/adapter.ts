import { pause } from "../http.js";
import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { MidoceanClient, type MidoceanFeed } from "./api.js";
import { normalizeMidocean } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const MS_PER_HOUR = 3_600_000;
const FEEDS = {
  products: { name: "products", path: "products/2.0", query: { language: "en" } },
  stock: { name: "stock", path: "stock/2.0", query: {} },
  pricelist: { name: "pricelist", path: "pricelist/2.0/", query: {} },
  printdata: { name: "printdata", path: "printdata/1.0", query: {} },
} satisfies Record<string, MidoceanFeed>;
// A file older than this is reported: Midocean rebuilds the catalogue files daily and stock every hour or so
// (docs/integrations.md), so an older one means their export stalled
const MAX_FILE_AGE_MS: Record<keyof typeof FEEDS, number> = {
  products: 72 * MS_PER_HOUR, stock: 6 * MS_PER_HOUR, pricelist: 72 * MS_PER_HOUR, printdata: 72 * MS_PER_HOUR,
};
// --probe: catalogue languages beyond en, the 15 of printdata's technique names and Ukrainian, each by its first bytes
const PROBE_LANGUAGES = ["cs", "da", "de", "es", "fi", "fr", "hu", "it", "nl", "pl", "pt", "ro", "ru", "sv", "uk"];
const PROBE_BYTES = 64;
const PROBE_PAUSE_MS = 1_000;

function staleWarning(feed: keyof typeof FEEDS, lastModified: string | null): string | undefined {
  const modifiedMs = lastModified ? Date.parse(lastModified) : Number.NaN;
  if (Number.isNaN(modifiedMs)) return undefined;
  const ageHours = Math.floor((Date.now() - modifiedMs) / MS_PER_HOUR);
  return Date.now() - modifiedMs > MAX_FILE_AGE_MS[feed] ? `${feed} file is ${ageHours} h old` : undefined;
}

// Every feed is a full dump read in one piece, so a snapshot that normalizes is a complete one
async function fetchCatalog(apiKey: string, context: FetchContext): Promise<CatalogSnapshot> {
  const client = new MidoceanClient(apiKey, context.secrets, context.signal);
  const files: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [name, feed] of Object.entries(FEEDS) as [keyof typeof FEEDS, MidoceanFeed][]) {
    const file = await client.read(feed);
    context.log(`midocean ${name}: ${(file.bytes / BYTES_PER_MB).toFixed(1)} MB, last modified ${file.lastModified ?? "unknown"}`);
    files[name] = file.json;
    const stale = staleWarning(name, file.lastModified);
    if (stale) warnings.push(stale);
  }
  const snapshot = normalizeMidocean({
    products: files.products, stock: files.stock, pricelist: files.pricelist, printdata: files.printdata,
  });
  return { ...snapshot, warnings: [...snapshot.warnings, ...warnings], isComplete: true };
}

async function probe(apiKey: string, context: FetchContext): Promise<void> {
  const client = new MidoceanClient(apiKey, context.secrets, context.signal);
  for (const language of PROBE_LANGUAGES) {
    await pause(PROBE_PAUSE_MS, context.signal);
    const feed = { ...FEEDS.products, query: { language } };
    try {
      const { status, path, size } = await client.peek(feed, PROBE_BYTES);
      context.log(`midocean products language=${language}: HTTP ${status}${path ? ` ${path}` : ""}${size ? `, ${size}` : ""}`);
    } catch (error) {
      if (context.signal.aborted) throw error;
      context.log(`midocean products language=${language}: failed, ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function midoceanAdapter(apiKey: string): SupplierAdapter {
  return {
    source: { code: "midocean", name: "Midocean", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(apiKey, context),
    probe: (context) => probe(apiKey, context),
  };
}
