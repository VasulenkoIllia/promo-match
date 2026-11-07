import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import {
  type Feed, FEED_MAX_BYTES, FEED_TIMEOUT_MS, feedPlanLines, feedUrl, photoPlanLine, probeFirstPhoto, readFeed,
} from "./feeds.js";
import { BYTES_PER_MB, type Run } from "./run.js";

// Inspirion LEO API (https://leoapi.inspirion.eu/documentation): API key in a header, no login. v2 products is the
// whole catalogue in one answer. A v1 list without page parameters is a whole array too (2026-11-04); with page and
// perPage it is paged Laravel-style (current_page, last_page, total). Orders, offers, price calculation and shipping
// are never called.
const INSPIRION_BASE = "https://leoapi.inspirion.eu";

const INSPIRION_FEEDS: Feed[] = [
  { name: "products-v2", url: feedUrl(INSPIRION_BASE, "/api/v2/products", { language: "en" }), isRequired: true },
  { name: "stock", url: feedUrl(INSPIRION_BASE, "/api/v1/stock"), isRequired: true },
  { name: "pricelist-v2", url: feedUrl(INSPIRION_BASE, "/api/v2/pricelist"), isRequired: true },
  { name: "categories", url: feedUrl(INSPIRION_BASE, "/api/v1/products/categories", { language: "en" }), isRequired: true },
  { name: "deleted-products", url: feedUrl(INSPIRION_BASE, "/api/v1/deleted-products"), isRequired: false },
  { name: "print-prices", url: feedUrl(INSPIRION_BASE, "/api/v1/print-prices"), isRequired: false },
  // Marked work in progress in the documentation
  { name: "printdata", url: feedUrl(INSPIRION_BASE, "/api/v1/printdata"), isRequired: false },
];

export function inspirionPlan(): string[] {
  return [
    `Inspirion, header X-Gateway-API-Key, timeout ${FEED_TIMEOUT_MS / MS_PER_SECOND} s,`
      + ` body up to ${FEED_MAX_BYTES / BYTES_PER_MB} MB, each answer kept whole:`,
    ...feedPlanLines(INSPIRION_FEEDS),
    photoPlanLine(),
  ];
}

export async function runInspirion(run: Run): Promise<void> {
  const headers = { "X-Gateway-API-Key": run.env.inspirionApiKey, Accept: "application/json" };
  let catalog: unknown;
  for (const feed of INSPIRION_FEEDS) {
    const json = await readFeed(run, "inspirion", feed, headers);
    if (feed.name === "products-v2") catalog = json;
  }
  if (catalog !== undefined) await probeFirstPhoto(run, "inspirion", catalog);
}
