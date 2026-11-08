import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { BluecollectionClient, type Credentials } from "./api.js";
import { normalizeBluecollection } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const REPEATED_INDEX = "products records with a repeated index";

// The products come in pages: the snapshot is complete only when every page added up to the count the first one gave
// and no index came twice (a record that moved between pages while they were read)
async function fetchCatalog(credentials: Credentials, context: FetchContext): Promise<CatalogSnapshot> {
  const client = new BluecollectionClient(credentials, context.secrets, context.signal);
  const products = await client.readAll("client-products/");
  context.log(`bluecollection products: ${products.records.length} of ${products.count} in ${products.pages} pages, ${(products.bytes / BYTES_PER_MB).toFixed(1)} MB`);
  const categories = await client.readAll("categories/");
  const subcategories = await client.readAll("subcategories/");
  const snapshot = normalizeBluecollection({
    products: products.records, categories: categories.records, subcategories: subcategories.records,
  });
  const isComplete = products.records.length === products.count && !snapshot.checks[REPEATED_INDEX];
  const warnings = isComplete ? [] : [`products: ${products.records.length} records read, the first page said ${products.count}`];
  return { ...snapshot, warnings: [...snapshot.warnings, ...warnings], isComplete };
}

export function bluecollectionAdapter(credentials: Credentials): SupplierAdapter {
  return {
    source: { code: "bluecollection", name: "Blue Collection", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(credentials, context),
    probe: (context) => {
      context.log("bluecollection: nothing to probe, see pnpm run smoke:suppliers --only bluecollection");
      return Promise.resolve();
    },
  };
}
