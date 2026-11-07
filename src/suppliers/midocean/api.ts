import { HttpError, request, type HttpResult } from "../http.js";
import { linkSecrets, scrub } from "../secrets.js";

// Midocean REST API (docs/integrations.md): full dumps, API key in a header. Read only.
const MIDOCEAN_BASE = new URL("https://api.midocean.com/gateway/");
// Only these feeds can be called: order/* and proof/* are refused before a request is built
const MIDOCEAN_READ_PATH = /^\/gateway\/(products|stock|pricelist|printdata|printpricelist)\//;
// products and stock answer with a 303 to a presigned file in Midocean's S3 buckets (midocean-prd-...); a link
// anywhere else is not followed
const FILE_HOST = /^midocean-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const BYTES_PER_MB = 1_048_576;
// Each feed is a full dump of tens of MB without pagination
const TIMEOUT_MS = 180_000;
const MAX_BYTES = 200 * BYTES_PER_MB;
const MAX_ATTEMPTS = 3;
const HTTP_OK = 200;
const PARTIAL_CONTENT = 206;
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
const BOM = "\uFEFF";

export interface MidoceanFeed {
  name: string;
  path: string;
  query: Record<string, string>;
}

export interface FeedFile {
  json: unknown;
  bytes: number;
  lastModified: string | null;
}

export class MidoceanError extends Error {}

export function midoceanUrl(feed: MidoceanFeed): URL {
  const url = new URL(feed.path, MIDOCEAN_BASE);
  for (const [name, value] of Object.entries(feed.query)) url.searchParams.set(name, value);
  // Checked on the built URL, after any ".." is resolved
  if (url.origin !== MIDOCEAN_BASE.origin || !MIDOCEAN_READ_PATH.test(url.pathname)) {
    throw new MidoceanError(`${feed.path} is not a read feed`);
  }
  return url;
}

// A Midocean file on S3: https, no port, no user in the URL
export function isMidoceanFileLink(link: URL): boolean {
  return link.protocol === "https:" && !link.port && !link.username && !link.password && FILE_HOST.test(link.hostname);
}

function isRedirect(status: number): boolean {
  return status >= REDIRECT_MIN && status <= REDIRECT_MAX;
}

function parseJson(body: Buffer, label: string): unknown {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) as unknown;
  } catch {
    throw new MidoceanError(`${label}: the answer is not JSON (${body.length} bytes)`);
  }
}

export class MidoceanClient {
  constructor(
    private readonly apiKey: string,
    private readonly secrets: string[],
    private readonly signal: AbortSignal,
  ) {
    secrets.push(apiKey);
  }

  // The feed itself, or the file behind its link for products and stock, fetched without the API key, which S3
  // does not need and must not see
  async read(feed: MidoceanFeed): Promise<FeedFile> {
    const answer = await this.get(midoceanUrl(feed), { "x-Gateway-APIKey": this.apiKey }, feed.name);
    if (isRedirect(answer.status)) {
      const file = await this.get(this.fileLink(answer, feed.name), {}, `${feed.name} file`);
      return this.fileOf(file, `${feed.name} file`);
    }
    return this.fileOf(answer, feed.name);
  }

  // The link and the size of a feed's file, from its first bytes only (--probe)
  async peek(feed: MidoceanFeed, bytes: number): Promise<{ status: number; path?: string; size?: string }> {
    const answer = await this.get(midoceanUrl(feed), { "x-Gateway-APIKey": this.apiKey }, feed.name);
    if (!isRedirect(answer.status)) return { status: answer.status };
    const link = this.fileLink(answer, feed.name);
    const file = await this.get(link, { Range: `bytes=0-${bytes - 1}` }, `${feed.name} file`);
    const size = file.status === PARTIAL_CONTENT ? file.headers["content-range"] ?? file.headers["content-length"] : undefined;
    return { status: file.status, path: link.pathname, size };
  }

  private fileLink(answer: HttpResult, label: string): URL {
    const link = answer.redirectUrl;
    if (!link || !isMidoceanFileLink(link)) {
      throw new MidoceanError(`${label}: HTTP ${answer.status} not to a Midocean file on S3, not followed`);
    }
    this.secrets.push(...linkSecrets(link));
    return link;
  }

  private fileOf(answer: HttpResult, label: string): FeedFile {
    if (answer.status !== HTTP_OK) throw new MidoceanError(`${label}: HTTP ${answer.status}`);
    return { json: parseJson(answer.body, label), bytes: answer.body.length, lastModified: answer.headers["last-modified"] ?? null };
  }

  private async get(url: URL, headers: Record<string, string>, label: string): Promise<HttpResult> {
    try {
      return await request(url, {
        method: "GET", headers: { Accept: "application/json", ...headers },
        timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, maxAttempts: MAX_ATTEMPTS, signal: this.signal,
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
      throw new MidoceanError(scrub(`${label}: ${error.message}${retries}`, this.secrets));
    }
  }
}
