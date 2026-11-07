import { FeedError } from "../errors.js";
import { pause } from "../http.js";
import type { CatalogSnapshot, FetchContext, SupplierAdapter } from "../types.js";
import { AxpolClient, type AxpolCredentials, type AxpolFeed, type AxpolPage } from "./api.js";
import { normalizeAxpol } from "./normalize.js";

// Records per List page. --probe on 2026-10-28: every limit up to 1000 honoured (1000 records 2.2 MB in 5.4 s), larger
// ones not tried; 500 keeps a page near 1 MB and 3 s (docs/integrations.md)
const AXPOL_PAGE_LIMIT = 500;
// Pages read past the count before the read stops: the catalogue may grow while it is read
const EXTRA_PAGES = 2;
const BYTES_PER_MB = 1_048_576;
// --probe: limits tried in turn on the first page, stopping at the first one Axpol cuts, fails or answers slowly
const PROBE_PAGE = 5;
const PROBE_LIMITS = [25, 50, 100, 200, 500, 1_000];
const PROBE_PAUSE_MS = 1_000;
const PROBE_MAX_BYTES = 16 * BYTES_PER_MB;
const PROBE_MAX_MS = 20_000;

export interface FeedRead {
  records: Map<string, Record<string, unknown>>;
  count: number;
  pages: number;
  repeated: number;
  // The last page came short (the end) and nothing the count promised is missing
  isComplete: boolean;
}

// Pages until one comes short. A record met twice (the catalogue moved while it was read) is kept once.
export async function readFeed(client: Pick<AxpolClient, "count" | "list">, feed: AxpolFeed, limit: number):
  Promise<FeedRead> {
  const count = await client.count(feed);
  const records = new Map<string, Record<string, unknown>>();
  const maxPages = Math.ceil(count / limit) + EXTRA_PAGES;
  let pages = 0;
  let repeated = 0;
  let isEnd = false;
  for (let offset = 0; pages < maxPages && !isEnd; offset += limit) {
    const page = await client.list(feed, limit, offset);
    pages += 1;
    for (const [key, record] of page.records) {
      if (records.has(key)) repeated += 1;
      records.set(key, record);
    }
    isEnd = page.records.size < limit;
  }
  return { records, count, pages, repeated, isComplete: isEnd && records.size >= count };
}

function describeRead(feed: AxpolFeed, read: FeedRead): string {
  const repeated = read.repeated ? `, ${read.repeated} met twice` : "";
  const end = read.isComplete ? "" : ", INCOMPLETE";
  return `axpol ${feed}.List: ${read.records.size} records of ${read.count} in ${read.pages} pages${repeated}${end}`;
}

async function fetchCatalog(credentials: AxpolCredentials, context: FetchContext): Promise<CatalogSnapshot> {
  const client = new AxpolClient(credentials, context.secrets, context.signal);
  const reads = new Map<AxpolFeed, FeedRead>();
  for (const feed of ["Product", "Stock", "Printing"] as const) {
    const read = await readFeed(client, feed, AXPOL_PAGE_LIMIT);
    context.log(describeRead(feed, read));
    // An empty feed would mark the whole catalogue, its stock or printing inactive
    if (!read.records.size) throw new FeedError(`axpol ${feed}.List: no records (count ${read.count})`);
    reads.set(feed, read);
  }
  const products = reads.get("Product");
  const stock = reads.get("Stock");
  const printing = reads.get("Printing");
  if (!products || !stock || !printing) throw new Error("axpol: a feed was not read");
  const snapshot = normalizeAxpol({ products: products.records, stock: stock.records, printing: printing.records });
  for (const [feed, read] of reads) {
    snapshot.fetched[`${feed}.Count`] = read.count;
    snapshot.fetched[`${feed}.List`] = read.records.size;
    if (!read.isComplete) snapshot.warnings.push(`${feed}.List incomplete: ${read.records.size} of ${read.count}`);
  }
  return { ...snapshot, isComplete: [...reads.values()].every((read) => read.isComplete) };
}

function overlap(left: AxpolPage, right: AxpolPage): number {
  return [...left.records.keys()].filter((key) => right.records.has(key)).length;
}

function describePage(limit: number, page: AxpolPage): string {
  return `limit ${limit}: ${page.records.size} records, ${(page.bytes / BYTES_PER_MB).toFixed(2)} MB, ${page.durationMs} ms`;
}

// Whether offset counts records or pages, then the largest page Axpol gives, in small steps
async function probe(credentials: AxpolCredentials, context: FetchContext): Promise<void> {
  const client = new AxpolClient(credentials, context.secrets, context.signal);
  const count = await client.count("Product");
  context.log(`axpol Product.Count: ${count}`);
  const first = await client.list("Product", PROBE_PAGE, 0);
  const shifted = await client.list("Product", PROBE_PAGE, 1);
  const next = await client.list("Product", PROBE_PAGE, PROBE_PAGE);
  const shiftedShare = overlap(first, shifted);
  const meaning = shiftedShare === PROBE_PAGE - 1 && overlap(first, next) === 0 ? "records" : "not records, see the shares";
  context.log(`axpol offset: offset 1 shares ${shiftedShare} of ${PROBE_PAGE} records with offset 0, offset `
    + `${PROBE_PAGE} shares ${overlap(first, next)}: offset counts ${meaning}`);
  for (const limit of PROBE_LIMITS) {
    await pause(PROBE_PAUSE_MS, context.signal);
    let page: AxpolPage;
    try {
      page = await client.list("Product", limit, 0);
    } catch (error) {
      if (context.signal.aborted) throw error;
      context.log(`axpol limit ${limit}: failed, ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    context.log(`axpol ${describePage(limit, page)}`);
    if (page.records.size < Math.min(limit, count)) {
      context.log(`axpol limit ${limit}: cut to ${page.records.size}, the largest page`);
      return;
    }
    if (page.bytes > PROBE_MAX_BYTES || page.durationMs > PROBE_MAX_MS) {
      context.log(`axpol limit ${limit}: stopped, the page is over ${PROBE_MAX_BYTES / BYTES_PER_MB} MB or ${PROBE_MAX_MS} ms`);
      return;
    }
  }
  context.log(`axpol: every limit up to ${PROBE_LIMITS.at(-1)} was honoured`);
}

export function axpolAdapter(credentials: AxpolCredentials): SupplierAdapter {
  return {
    source: { code: "axpol", name: "Axpol", kind: "supplier" },
    fetchCatalog: (context) => fetchCatalog(credentials, context),
    probe: (context) => probe(credentials, context),
  };
}
