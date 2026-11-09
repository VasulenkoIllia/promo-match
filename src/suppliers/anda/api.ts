// Anda Present XML feeds (docs/integrations.md, «Anda Present XML»): https://xml.andapresent.com/export/<feed>[/<lang>]/<token>,
// one token for all feeds, answered only to the IP addresses on Anda's list (the owner's server since 2026-11-09). The
// token is part of the address, so the address is a secret: it is built here for one request and never logged, and the
// adapter adds the token to the run's secrets. Read only, these four feeds alone. Away from the server (owner's decision
// 2026-11-09) the same feeds are read from files saved through the owner's tunnel: ANDA_FEED_DIR names their folder.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../../config.js";
import { HttpError, request } from "../http.js";
import { scrub } from "../secrets.js";

const ANDA_ORIGIN = "https://xml.andapresent.com";
// The address path of each feed and the file name it is saved under (as the smoke test of 2026-11-09 saved them). The
// import reads the last four; categories (22 KB) only checks the access (--probe), the models carry their own path.
const ANDA_FEEDS = {
  categories: { path: "categories/en", file: "categories-en.xml" },
  products: { path: "products/en", file: "products-en.xml" },
  prices: { path: "prices", file: "prices.xml" },
  inventories: { path: "inventories", file: "inventories.xml" },
  labeling: { path: "labeling/en", file: "labeling-en.xml" },
} as const;
export type AndaFeed = keyof typeof ANDA_FEEDS;

export type AndaSource = { kind: "network"; token: string } | { kind: "directory"; directory: string };

const TOKEN = /^[A-Za-z0-9]+$/;
const BYTES_PER_MB = 1_048_576;
// 31 and 33 MB for products and labeling on 2026-11-09; the manual says 30-40 MB
const MAX_BYTES = 100 * BYTES_PER_MB;
// 0.6-9 s each on 2026-11-09
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const HTTP_OK = 200;
// The manual: «Access denied» is an address off the list, «Not found» a feed not made yet (up to 24 h after activation)
const STATUS_HINTS: Record<number, string> = {
  403: ", this IP is not on Anda Present's list",
  404: ", the feed is not generated yet",
};

class AndaError extends Error {}

export interface FeedFile {
  xml: string;
  bytes: number;
  lastModified: string | null;
  etag: string | null;
  // When a saved file was written, ISO; null for an answer of the network
  savedAt: string | null;
}

// The token goes into a path, so only letters and digits pass: nothing in it may change the address. Saved files are for
// a machine off Anda's list: on the server they would be an old catalogue, read as complete.
export function andaSource(directory: string | undefined, token: () => string, isProduction: boolean): AndaSource {
  if (directory && isProduction) throw new ConfigError("ANDA_FEED_DIR is set in production: the server reads the live feeds");
  if (directory) return { kind: "directory", directory };
  const value = token();
  if (!TOKEN.test(value)) throw new ConfigError("ANDA_FEED_TOKEN must be letters and digits only");
  return { kind: "network", token: value };
}

// Never printed: the token is in it
export function feedUrl(feed: AndaFeed, token: string): URL {
  return new URL(`/export/${ANDA_FEEDS[feed].path}/${token}`, ANDA_ORIGIN);
}

async function readFromFile(directory: string, feed: AndaFeed, signal: AbortSignal): Promise<FeedFile> {
  const path = join(directory, ANDA_FEEDS[feed].file);
  const { size, mtime } = await stat(path);
  if (size > MAX_BYTES) throw new AndaError(`anda ${feed}: ${path} is over ${MAX_BYTES / BYTES_PER_MB} MB`);
  const body = await readFile(path, { signal });
  return { xml: body.toString("utf8"), bytes: body.length, lastModified: null, etag: null, savedAt: mtime.toISOString() };
}

async function readFromNetwork(token: string, feed: AndaFeed, signal: AbortSignal): Promise<FeedFile> {
  let answer;
  try {
    answer = await request(feedUrl(feed, token), {
      method: "GET", headers: { Accept: "application/xml" }, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
      maxAttempts: MAX_ATTEMPTS, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const retries = error instanceof HttpError && error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
    const message = error instanceof Error ? error.message : String(error);
    // A socket error may quote the address; the import scrubs its own lines too, this message leaves here clean
    throw new AndaError(scrub(`anda ${ANDA_FEEDS[feed].path}: ${message}${retries}`, [token]));
  }
  if (answer.status !== HTTP_OK) {
    throw new AndaError(`anda ${ANDA_FEEDS[feed].path}: HTTP ${answer.status}${STATUS_HINTS[answer.status] ?? ""}`);
  }
  return {
    xml: answer.body.toString("utf8"), bytes: answer.body.length, lastModified: answer.headers["last-modified"] ?? null,
    etag: answer.headers.etag ?? null, savedAt: null,
  };
}

export function readFeed(source: AndaSource, feed: AndaFeed, signal: AbortSignal): Promise<FeedFile> {
  return source.kind === "directory" ? readFromFile(source.directory, feed, signal) : readFromNetwork(source.token, feed, signal);
}

// An HTTP date as ISO; null when there is none or it cannot be read
export function isoTime(httpDate: string | null): string | null {
  if (!httpDate) return null;
  const time = Date.parse(httpDate);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function describeFeed(feed: AndaFeed, file: FeedFile): string {
  const headers = file.savedAt === null
    ? `last-modified ${file.lastModified ?? "not sent"}, etag ${file.etag ?? "not sent"}` : `a file saved ${file.savedAt}`;
  return `anda ${ANDA_FEEDS[feed].path}: ${(file.bytes / BYTES_PER_MB).toFixed(1)} MB, ${headers}`;
}
