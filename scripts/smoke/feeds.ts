import { readJwtTtlSeconds } from "../../src/suppliers/axpol/api.js";
import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import { isRecord } from "../../src/suppliers/normalize.js";
import { judgeFeed } from "./midocean.js";
import {
  addNote, BYTES_PER_MB, exchange, HTTP_OK, probePhoto, report, type Run, type SmokeSupplier, type StepResult,
} from "./run.js";
import { firstImageUrl } from "./shape.js";

// What Makito, Inspirion and Blue Collection share: a JSON login (Makito, Blue Collection), feeds read once with the
// answer kept as it came for counting, and one picture opened to see whether the CDN is public
export const FEED_TIMEOUT_MS = 180_000;
export const FEED_MAX_BYTES = 200 * BYTES_PER_MB;
const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_MAX_BYTES = 1 * BYTES_PER_MB;
const PHOTO_TIMEOUT_MS = 30_000;
const PHOTO_MAX_BYTES = 20 * BYTES_PER_MB;
const SECONDS_PER_MINUTE = 60;
// The hard list of these suppliers' smoke test: a POST only to a login or token path, and never an order, offer,
// price calculation or shipping path, whatever the method; checked before any request
const LOGIN_PATH = /\/(?:auth\/login|token\/(?:refresh\/)?)$/;
const WRITE_PATH = /\/(?:orders?|create-order|offers|price-calculation|shipping)(?:[/-]|$)/i;

export function assertReadOnly(url: URL, method: "GET" | "POST"): void {
  if (WRITE_PATH.test(url.pathname)) throw new Error(`not on the read-only list: ${method} ${url.pathname}`);
  if (method === "POST" && !LOGIN_PATH.test(url.pathname)) {
    throw new Error(`a POST only logs in: ${url.pathname}`);
  }
}

export interface Feed {
  name: string;
  url: URL;
  // A required feed failing fails the run; the others are findings (a second catalogue, a feed marked WIP)
  isRequired: boolean;
}

export function feedUrl(base: string, path: string, query: Record<string, string> = {}): URL {
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

export function feedPlanLines(feeds: Feed[]): string[] {
  return feeds.map((feed) => `  GET ${feed.url.href}${feed.isRequired ? "" : " (finding only)"}`);
}

// One POST with a JSON body, never repeated: a supplier that answers a wrong password with 429 or 5xx must not see
// it twice. A token in the answer counts, its lifetime goes to the note.
export async function jsonLogin(
  run: Run, supplier: SmokeSupplier, step: string, url: URL, body: Record<string, string>,
  readToken: (json: unknown) => unknown,
): Promise<string | undefined> {
  assertReadOnly(url, "POST");
  const { row, json } = await exchange(run, {
    supplier, step, isRequired: true, url,
    options: {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body), timeoutMs: LOGIN_TIMEOUT_MS, maxBytes: LOGIN_MAX_BYTES, maxAttempts: 1,
    },
    prefix: `${supplier}/${step.replace(/\s+/g, "-")}`,
  });
  const token = readToken(json);
  const hasToken = typeof token === "string" && token.length > 0;
  if (row.status !== undefined && row.status !== HTTP_OK) addNote(row, `login failed, HTTP ${row.status}`);
  else if (row.status === HTTP_OK && !hasToken) addNote(row, "no token in the answer");
  if (hasToken) {
    run.secrets.push(token);
    const ttlSeconds = readJwtTtlSeconds(token);
    addNote(row, ttlSeconds ? `token lifetime ${Math.round(ttlSeconds / SECONDS_PER_MINUTE)} min` : "token lifetime unknown");
  }
  row.isOk = row.status === HTTP_OK && hasToken;
  report(run, row);
  return hasToken ? token : undefined;
}

// A feed's answer, kept as it came next to its shape and sample; returns the parsed answer when it brought records.
// A paged answer (count and next, as Blue Collection's) says it is the first page only.
export async function readFeed(
  run: Run, supplier: SmokeSupplier, feed: Feed, headers: Record<string, string>,
): Promise<unknown> {
  assertReadOnly(feed.url, "GET");
  const { row, json } = await exchange(run, {
    supplier, step: feed.name, isRequired: feed.isRequired, url: feed.url,
    options: { method: "GET", headers, timeoutMs: FEED_TIMEOUT_MS, maxBytes: FEED_MAX_BYTES },
    prefix: `${supplier}/${feed.name}`, saveRaw: true,
  });
  judgeFeed(row, json);
  if (isRecord(json) && typeof json.count === "number" && typeof json.next === "string" && json.next) {
    addNote(row, `first page only: ${row.records ?? "?"} of ${json.count} records`);
  }
  report(run, row);
  return row.isOk ? json : undefined;
}

export function skipFeeds(run: Run, supplier: SmokeSupplier, feeds: Feed[], reason: string): void {
  for (const feed of feeds) {
    const row: StepResult = {
      supplier, host: feed.url.host, step: feed.name, isRequired: feed.isRequired, isOk: false, note: `skipped: ${reason}`,
    };
    report(run, row);
  }
}

// The first picture of the catalogue, opened as a viewer's browser would: without the supplier's credentials.
// Returns whether it opened, so a supplier may try again with its token on its own host.
export async function probeFirstPhoto(
  run: Run, supplier: SmokeSupplier, catalog: unknown, headers: Record<string, string> = {}, label = "photo",
): Promise<{ url?: URL; isOk: boolean }> {
  const link = firstImageUrl(catalog);
  if (!link) {
    report(run, {
      supplier, host: "-", step: label, isRequired: false, isOk: false, note: "no picture link found in the catalogue",
    });
    return { isOk: false };
  }
  const url = new URL(link);
  if (WRITE_PATH.test(url.pathname)) {
    report(run, { supplier, host: url.host, step: label, isRequired: false, isOk: false, note: "skipped: not on the read-only list" });
    return { url, isOk: false };
  }
  const row = await probePhoto(run, {
    supplier, step: label, url,
    options: { method: "GET", headers, timeoutMs: PHOTO_TIMEOUT_MS, maxBytes: PHOTO_MAX_BYTES },
    prefix: `${supplier}/${label}`,
  });
  return { url, isOk: row.isOk };
}

export function photoPlanLine(): string {
  return `  GET the first picture link of the catalogue without credentials (timeout ${PHOTO_TIMEOUT_MS / MS_PER_SECOND} s)`;
}
