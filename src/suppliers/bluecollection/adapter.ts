import { FeedError } from "../errors.js";
import type { CatalogSnapshot, FetchContext, NormalizedCatalog, SupplierAdapter } from "../types.js";
import { BluecollectionClient, type Credentials } from "./api.js";
import { normalizeBluecollection } from "./normalize.js";

const BYTES_PER_MB = 1_048_576;
const REPEATED_INDEX = "products records with a repeated index";
const REPEATED_PROMOTION = "promotions records with a repeated index";

// Counters that mean a list changed its shape rather than a few odd records, with the share of a list past which the
// import stops: a missing discount_prices would raise every price by 82%, an empty or renamed list of promotions would
// drop each promotion to the regular price. The lists: products read, promotions read, current promotions priced.
// Live 2026-11-23 every counter is 0 but the lot one, 35 of 415 (8%).
type Sizes = Record<"products" | "read" | "current", number>;
const SHAPE_LIMITS: { check: string; list: keyof Sizes; share: number }[] = [
  { check: "promotions records that are not objects", list: "read", share: 0 },
  { check: "promotions records without index", list: "read", share: 0.05 },
  { check: "promotions without is_current or active", list: "read", share: 0.05 },
  { check: "promotions without tiers", list: "current", share: 0.05 },
  { check: "promotions without an EUR price, the regular price taken", list: "current", share: 0.05 },
  { check: "promotions only from more than one piece, the regular price taken", list: "current", share: 0.25 },
  { check: "promotions above the regular price, the promotion taken", list: "current", share: 0.05 },
  // The products read minutes before the promotions name theirs: a few may end between the two reads
  { check: "promo prices without a current promotion", list: "products", share: 0.02 },
  { check: "discount_prices values other than true or false", list: "products", share: 0.05 },
];
const SHOWN_EXAMPLES = 3;

// Why the prices of this read must not be written. A cut products list is safe to write (what was not read stays
// active), a cut promotions list is not: each index it missed would get its regular, higher price.
function priceStops(snapshot: NormalizedCatalog, sizes: Sizes, promotionsCount: number): string[] {
  const stops = SHAPE_LIMITS.flatMap(({ check, list, share }) => {
    const count = snapshot.checks[check] ?? 0;
    const examples = snapshot.examples[check]?.slice(0, SHOWN_EXAMPLES).join(", ");
    return count > share * sizes[list] ? [`${check}: ${count} of ${sizes[list]}${examples ? ` (e.g. ${examples})` : ""}`] : [];
  });
  if (sizes.read !== promotionsCount) stops.push(`promotions: ${sizes.read} records read, the first page said ${promotionsCount}`);
  const repeated = snapshot.checks[REPEATED_PROMOTION];
  if (repeated) stops.push(`promotions: ${repeated} records with a repeated index`);
  return stops;
}

// The products come in pages: the snapshot is complete only when every page added up to the count the first one gave
// and no index came twice (a record that moved between pages while they were read). The promotions price the products,
// so a cut or reshaped list of them stops the import before anything is written: yesterday's prices stay.
async function fetchCatalog(credentials: Credentials, context: FetchContext): Promise<CatalogSnapshot> {
  const client = new BluecollectionClient(credentials, context.secrets, context.signal);
  const products = await client.readAll("client-products/");
  context.log(`bluecollection products: ${products.records.length} of ${products.count} in ${products.pages} pages, ${(products.bytes / BYTES_PER_MB).toFixed(1)} MB`);
  const categories = await client.readAll("categories/");
  const subcategories = await client.readAll("subcategories/");
  const promotions = await client.readAll("promo-prices/");
  context.log(`bluecollection promotions: ${promotions.records.length} of ${promotions.count} in ${promotions.pages} pages`);
  const snapshot = normalizeBluecollection({
    products: products.records, categories: categories.records, subcategories: subcategories.records,
    promotions: promotions.records,
  });
  const sizes = { products: products.records.length, read: promotions.records.length, current: snapshot.fetched.promotions ?? 0 };
  const stops = priceStops(snapshot, sizes, promotions.count);
  if (stops.length) throw new FeedError(`bluecollection: prices not written, yesterday's stay: ${stops.join("; ")}`);
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
