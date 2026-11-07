// The two feeds the owner gave (2026-11-05, docs/integrations.md, «Macma і Easy Gifts»): DataSet XML files on the
// client's shop site, no login, behind Cloudflare, rebuilt about 02:15 every day. Read only, by these two addresses
// alone. The addresses come from .env (FEED_URL_VARIABLES): the repository is public, and they name the client.
import { ConfigError } from "../../config.js";
import { HttpError, request } from "../http.js";
import type { ArchiveSource } from "./archive.js";

export const FEEDS = {
  macma: { tag: "macma" },
  easygifts: { tag: "easy" },
} as const satisfies Record<ArchiveSource, { tag: string }>;

export const FEED_URL_VARIABLES = {
  macma: "MACMA_FEED_URL",
  easygifts: "EASYGIFTS_FEED_URL",
} as const satisfies Record<ArchiveSource, string>;

// HTTPS only, with no login in it: the address is read by this one request and logged nowhere
export function feedUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ConfigError(`${name} must be an https address without a login`);
  }
  return url;
}

const BYTES_PER_MB = 1_048_576;
// 14 and 11.5 MB on 2026-11-05
const MAX_BYTES = 100 * BYTES_PER_MB;
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const HTTP_OK = 200;

export interface FeedFile {
  xml: string;
  bytes: number;
  lastModified: string | null;
}

export class MacmaError extends Error {}

export async function readFeed(source: ArchiveSource, url: URL, signal: AbortSignal): Promise<FeedFile> {
  let answer;
  try {
    answer = await request(url, {
      method: "GET", headers: { Accept: "application/xml" }, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES,
      maxAttempts: MAX_ATTEMPTS, signal,
    });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
    throw new MacmaError(`${source} feed: ${error.message}${retries}`);
  }
  if (answer.status !== HTTP_OK) throw new MacmaError(`${source} feed: HTTP ${answer.status}`);
  return { xml: answer.body.toString("utf8"), bytes: answer.body.length, lastModified: answer.headers["last-modified"] ?? null };
}
