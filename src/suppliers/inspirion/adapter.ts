import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { InspirionClient, type InspirionFeed } from "./api.js";
import { normalizeInspirion } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const FEEDS = {
  products: { name: "products", path: "v2/products", query: { language: "en" } },
  stock: { name: "stock", path: "v1/stock", query: {} },
  pricelist: { name: "pricelist", path: "v2/pricelist", query: {} },
} satisfies Record<string, InspirionFeed>;

// Every list comes whole without page parameters (2026-11-04), so a snapshot that normalizes is a complete one
async function fetchCatalog(apiKey: string, context: FetchContext): Promise<CatalogSnapshot> {
  const client = new InspirionClient(apiKey, context.secrets, context.signal);
  const files: Record<string, unknown> = {};
  for (const [name, feed] of Object.entries(FEEDS)) {
    const file = await client.read(feed);
    context.log(`inspirion ${name}: ${(file.bytes / BYTES_PER_MB).toFixed(1)} MB`);
    files[name] = file.json;
  }
  const snapshot = normalizeInspirion({ products: files.products, stock: files.stock, pricelist: files.pricelist });
  return { ...snapshot, isComplete: true };
}

export function inspirionAdapter(apiKey: string): SupplierAdapter {
  return {
    source: { code: "inspirion", name: "Inspirion", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(apiKey, context),
    // The smoke test (npm run smoke:suppliers) found what there is to find: no limits besides x-ratelimit-limit
    probe: (context) => {
      context.log("inspirion: nothing to probe, see npm run smoke:suppliers -- --only inspirion");
      return Promise.resolve();
    },
  };
}
