import { HttpError, request } from "../http.js";
import { scrub } from "../secrets.js";

// Inspirion LEO API (docs/integrations.md): whole lists as JSON arrays, API key in a header, no login. Read only.
const INSPIRION_BASE = new URL("https://leoapi.inspirion.eu/api/");
// Only these lists can be called: create-order, offers, price-calculation, shipping and orders are refused before a
// request is built
const INSPIRION_READ_PATH = /^\/api\/(v2\/products|v1\/stock|v2\/pricelist)$/;
const BYTES_PER_MB = 1_048_576;
// The catalogue is one array of 17 MB in about 5 s (2026-11-04); the same limits as Midocean's dumps
const TIMEOUT_MS = 180_000;
const MAX_BYTES = 200 * BYTES_PER_MB;
const MAX_ATTEMPTS = 3;
const HTTP_OK = 200;

export interface InspirionFeed {
  name: string;
  path: string;
  query: Record<string, string>;
}

export interface FeedFile {
  json: unknown;
  bytes: number;
}

export class InspirionError extends Error {}

export function inspirionUrl(feed: InspirionFeed): URL {
  const url = new URL(feed.path, INSPIRION_BASE);
  for (const [name, value] of Object.entries(feed.query)) url.searchParams.set(name, value);
  // Checked on the built URL, after any ".." is resolved
  if (url.origin !== INSPIRION_BASE.origin || !INSPIRION_READ_PATH.test(url.pathname)) {
    throw new InspirionError(`${feed.path} is not a read feed`);
  }
  return url;
}

export class InspirionClient {
  constructor(
    private readonly apiKey: string,
    private readonly secrets: string[],
    private readonly signal: AbortSignal,
  ) {
    secrets.push(apiKey);
  }

  async read(feed: InspirionFeed): Promise<FeedFile> {
    let answer;
    try {
      answer = await request(inspirionUrl(feed), {
        method: "GET", headers: { Accept: "application/json", "X-Gateway-API-Key": this.apiKey },
        timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, maxAttempts: MAX_ATTEMPTS, signal: this.signal,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
      throw new InspirionError(scrub(`${feed.name}: ${error.message}${retries}`, this.secrets));
    }
    if (answer.status !== HTTP_OK) throw new InspirionError(`${feed.name}: HTTP ${answer.status}`);
    try {
      return { json: JSON.parse(answer.body.toString("utf8")) as unknown, bytes: answer.body.length };
    } catch {
      throw new InspirionError(`${feed.name}: the answer is not JSON (${answer.body.length} bytes)`);
    }
  }
}
