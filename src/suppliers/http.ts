import { setTimeout as delay } from "node:timers/promises";

// One HTTP call to a supplier API: a timeout over the whole call (body included), a cap on the body size,
// one retry on a network error, a timeout, 429 or 5xx. Redirects are not followed: Axpol keeps its API key in the
// query string, which must not travel to another host. Shared by the smoke test (scripts/smoke), the import and the
// embeddings (src/embeddings).
export interface RequestOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  // A form (Axpol's login) or JSON text (the embedding APIs)
  body?: FormData | string;
  timeoutMs: number;
  maxBytes: number;
  maxAttempts?: number;
  backoffMs?: number;
  // Stops the call and its retries from outside (a worker on SIGTERM); never retried
  signal?: AbortSignal;
}

export interface ResponseHeaders {
  status: number;
  // Only the headers in KEPT_HEADERS and rate limits; the names of the others in omittedHeaders
  headers: Record<string, string>;
  omittedHeaders: string[];
  // Redirect target as origin and path: no query (it may carry the API key back), no user
  location?: string;
}

export interface HttpResult extends ResponseHeaders {
  // The full redirect target, query included, for a caller that follows it on purpose; never saved or printed
  redirectUrl?: URL;
  body: Buffer;
  // From the first attempt to the end of the last one, waits included
  durationMs: number;
  attempts: number;
  // Why each earlier attempt was retried
  retries: string[];
}

// One call to a URL: request below, or a supplier's own that adds its token to its own photos (Makito)
export type UrlFetch = (url: URL, options: RequestOptions) => Promise<HttpResult>;

export const MAX_ATTEMPTS = 2;
export const MAX_RETRY_WAIT_MS = 30_000;
export const MS_PER_SECOND = 1_000;
const DEFAULT_BACKOFF_MS = 2_000;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
// Format, size, caching and retry headers. The others (location, link, refresh, anything custom) may echo a URL with
// the API key, so only their names are kept.
const KEPT_HEADERS = new Set([
  "cache-control", "content-encoding", "content-language", "content-length", "content-range", "content-type", "date", "etag",
  "expires", "last-modified", "retry-after", "server", "transfer-encoding", "vary",
]);
const RATE_LIMIT_HEADER = /rate-?limit|quota/i;

// A wait that a stop from outside ends at once, with the stop's own reason (not a bare AbortError)
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    throw signal?.aborted ? signal.reason : error;
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly retries: string[],
    // Set when the answer came but could not be read (a body over the cap)
    readonly response?: ResponseHeaders,
  ) {
    super(message);
  }
}

// The same request would bring the same body again, so this one is not retried
class BodyTooLargeError extends Error {}

function isRetryableStatus(status: number): boolean {
  return status === TOO_MANY_REQUESTS || status >= SERVER_ERROR;
}

// A timeout, or undici's "fetch failed" / "terminated" with the socket error as cause. A TypeError without a cause
// is a bad request (a header value that is not Latin-1) and would fail the same way again.
function isNetworkError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "TimeoutError" || (error instanceof TypeError && error.cause !== undefined));
}

// Retry-After in seconds or as an HTTP date, capped so a supplier cannot stall the run
export function retryWaitMs(retryAfter: string | null, fallbackMs: number): number {
  if (!retryAfter) return fallbackMs;
  const seconds = Number(retryAfter);
  const waitMs = Number.isFinite(seconds) ? seconds * MS_PER_SECOND : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(waitMs)) return fallbackMs;
  return Math.min(Math.max(waitMs, 0), MAX_RETRY_WAIT_MS);
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  // fetch bodies are byte streams; Node's types leave the chunk type as any
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      // The rest of a huge dump is never downloaded. A stream that has just failed (timeout) rejects the cancel:
      // the cap is still the reason to report.
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`response is over ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

function redirectUrlOf(response: Response, url: URL): URL | undefined {
  const location = response.headers.get("location");
  return location && URL.canParse(location, url.href) ? new URL(location, url) : undefined;
}

function headersOf(response: Response, url: URL): ResponseHeaders {
  const headers: Record<string, string> = {};
  const omittedHeaders: string[] = [];
  response.headers.forEach((value, name) => {
    if (KEPT_HEADERS.has(name) || RATE_LIMIT_HEADER.test(name)) headers[name] = value;
    else omittedHeaders.push(name);
  });
  // Host and path only: the query and a user in the URL may carry credentials
  const target = redirectUrlOf(response, url);
  return { status: response.status, headers, omittedHeaders, location: target && `${target.origin}${target.pathname}` };
}

function reason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error instanceof Error ? error.message : String(error)}${cause}`;
}

export async function request(url: URL, options: RequestOptions): Promise<HttpResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const started = Date.now();
  const retries: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | undefined;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      });
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const retryAfter = response.headers.get("retry-after");
        retries.push(`HTTP ${response.status}${retryAfter ? ` retry-after=${retryAfter}` : ""}`);
        await response.body?.cancel();
        await pause(retryWaitMs(retryAfter, backoffMs), options.signal);
        continue;
      }
      const body = await readCapped(response, options.maxBytes);
      return {
        ...headersOf(response, url),
        redirectUrl: redirectUrlOf(response, url),
        body,
        durationMs: Date.now() - started,
        attempts: attempt,
        retries,
      };
    } catch (error) {
      // A stop from outside ends the call as it is, without a retry
      if (options.signal?.aborted) throw options.signal.reason;
      const message = reason(error, options.timeoutMs);
      if (!isNetworkError(error) || attempt >= maxAttempts) {
        throw new HttpError(message, attempt, retries, response ? headersOf(response, url) : undefined);
      }
      retries.push(message);
      await pause(backoffMs, options.signal);
    }
  }
}
