import { HttpError, pause, request, type HttpResult, type RequestOptions, type UrlFetch } from "../http.js";
import { isRecord } from "../normalize.js";
import { scrub } from "../secrets.js";

// Makito API B2B (docs/integrations.md): a JSON login for a JWT of 60 minutes, then whole files of each feed and the
// photos of the catalogue, both only with the token. Read only.
const MAKITO_BASE = new URL("https://apis.makito.es/");
// Only these can be read: /orders* (orders, deliveries, invoices) and /access (clients, credentials) are refused before
// a request is built
const READ_PATH = /^\/(catalog\/files|catalog\/colors|catalog\/sizes|stock\/files|price-list\/files|print-config\/files|print-price-list\/files)$/;
// The photos of the catalogue, the only other place the token goes: /catalog/assets/15246/15246003000/principal/x.jpg
export const ASSET_PREFIX = "/catalog/assets/";
const ASSET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 9 segments is three times the deepest path of the catalogue (2026-11-04)
const MAX_ASSET_SEGMENTS = 9;
const LOGIN_PATH = "access/auth/login";
// The token lives 60 minutes (2026-11-04); a new one is taken 5 minutes before
const TOKEN_RENEW_AFTER_MS = 55 * 60_000;
// A 401 on a photo with a token younger than this is the photo's, not the token's: no new login for it
const MIN_TOKEN_AGE_FOR_RENEWAL_MS = 60_000;
// A failed login is not repeated for this long, so a wrong secret cannot lock the account
const LOGIN_PAUSE_AFTER_FAILURE_MS = 10 * 60_000;
const BYTES_PER_MB = 1_048_576;
// The catalogue is 17 MB in about 2.5 s (2026-11-04); the same limits as the other suppliers' whole files
const FEED_TIMEOUT_MS = 180_000;
const FEED_MAX_BYTES = 200 * BYTES_PER_MB;
const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_MAX_BYTES = BYTES_PER_MB;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
// The limit is about 100 requests, a photo is one, and 93 left grew back to 99 within 30 s (--probe, 2026-11-04). The
// embeddings download 24 photos at once, so the reserve is above that.
const LIMIT_RESERVE = 30;
const LIMIT_WAIT_MS = 3_000;

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export interface FeedFile {
  json: unknown;
  bytes: number;
  // What Makito says is left of its request limit after this read
  rateLimitRemaining: string | null;
}

export class MakitoError extends Error {}

export function readUrl(path: string, query: Record<string, string>): URL {
  const url = new URL(path, MAKITO_BASE);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  // Checked on the built URL, after any ".." is resolved
  if (url.origin !== MAKITO_BASE.origin || !READ_PATH.test(url.pathname)) throw new MakitoError(`${path} is not a read feed`);
  return url;
}

// A photo of the catalogue: Makito's own https origin, a path under /catalog/assets/ of plain segments, no query, no
// user. The token is sent to nothing else.
export function isAssetUrl(url: URL): boolean {
  return url.origin === MAKITO_BASE.origin && url.protocol === "https:" && !url.username && !url.password && !url.search
    && url.pathname.startsWith(ASSET_PREFIX) && isAssetPath(url.pathname.slice(ASSET_PREFIX.length));
}

// The part after /catalog/assets/, as the photo proxy takes it from a browser: segments of letters, digits, ".", "_"
// and "-", none starting with a dot, so ".." and an encoded slash never pass
export function isAssetPath(path: string): boolean {
  const segments = path.split("/");
  return segments.length >= 2 && segments.length <= MAX_ASSET_SEGMENTS && segments.every((segment) => ASSET_SEGMENT.test(segment));
}

export function assetUrl(path: string): URL {
  if (!isAssetPath(path)) throw new MakitoError("not a photo path of the catalogue");
  return new URL(`${ASSET_PREFIX}${path}`, MAKITO_BASE);
}

function parseJson(answer: HttpResult, label: string): unknown {
  if (answer.status !== HTTP_OK) throw new MakitoError(`${label}: HTTP ${answer.status}`);
  try {
    return JSON.parse(answer.body.toString("utf8")) as unknown;
  } catch {
    throw new MakitoError(`${label}: the answer is not JSON (${answer.body.length} bytes)`);
  }
}

// One token for a process (an import, an embeddings run, the server's photo proxy): a login when there is none or it
// is 55 minutes old, one at a time, never repeated right after a failure
export class MakitoSession {
  private token = "";
  private sinceMs = 0;
  private login: Promise<string> | null = null;
  private failure: { error: Error; atMs: number } | null = null;

  constructor(
    private readonly credentials: Credentials,
    private readonly secrets: string[],
  ) {
    secrets.push(credentials.clientId, credentials.clientSecret);
  }

  async bearer(signal?: AbortSignal): Promise<string> {
    if (this.token && Date.now() - this.sinceMs < TOKEN_RENEW_AFTER_MS) return this.token;
    return this.newToken(signal);
  }

  // After a 401 with this token: a new one, unless another call has renewed it already or it is too young to be the
  // cause
  async renew(stale: string, signal?: AbortSignal): Promise<string | null> {
    if (stale !== this.token) return this.token || null;
    if (Date.now() - this.sinceMs < MIN_TOKEN_AGE_FOR_RENEWAL_MS) return null;
    return this.newToken(signal);
  }

  async read(path: string, query: Record<string, string>, signal: AbortSignal): Promise<FeedFile> {
    const url = readUrl(path, query);
    const token = await this.bearer(signal);
    const answer = await this.call(url, {
      method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      timeoutMs: FEED_TIMEOUT_MS, maxBytes: FEED_MAX_BYTES, signal,
    }, path);
    return {
      json: parseJson(answer, path), bytes: answer.body.length,
      rateLimitRemaining: answer.headers["x-ratelimit-remaining"] ?? null,
    };
  }

  // A photo with the token; on a 401 once more with a renewed one. Any other URL is refused before a request. A failed
  // call throws the shared client's HttpError, as for a public photo: its message has no header, so no token.
  async fetchAsset(url: URL, options: RequestOptions): Promise<HttpResult> {
    if (!isAssetUrl(url)) throw new MakitoError(`${url.origin}${url.pathname} is not a photo of the catalogue`);
    const token = await this.bearer(options.signal);
    const answer = await request(url, withToken(options, token));
    if (answer.status !== HTTP_UNAUTHORIZED) return answer;
    const renewed = await this.renew(token, options.signal);
    return renewed ? request(url, withToken(options, renewed)) : answer;
  }

  private newToken(signal?: AbortSignal): Promise<string> {
    if (this.failure && Date.now() - this.failure.atMs < LOGIN_PAUSE_AFTER_FAILURE_MS) {
      return Promise.reject(this.failure.error);
    }
    this.login ??= this.logIn(signal).finally(() => {
      this.login = null;
    });
    return this.login;
  }

  private async logIn(signal?: AbortSignal): Promise<string> {
    try {
      const answer = await this.call(new URL(LOGIN_PATH, MAKITO_BASE), {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(this.credentials), timeoutMs: LOGIN_TIMEOUT_MS, maxBytes: LOGIN_MAX_BYTES, maxAttempts: 1, signal,
      }, "login");
      const json = parseJson(answer, "login");
      const token = isRecord(json) && typeof json.token === "string" ? json.token : "";
      if (!token) throw new MakitoError("login: no token in the answer");
      this.secrets.push(token);
      this.token = token;
      this.sinceMs = Date.now();
      this.failure = null;
      return token;
    } catch (error) {
      // A stop from outside is not the login's failure
      if (!signal?.aborted) this.failure = { error: error instanceof Error ? error : new Error(String(error)), atMs: Date.now() };
      throw error;
    }
  }

  private async call(url: URL, options: RequestOptions, label: string): Promise<HttpResult> {
    try {
      return await request(url, options);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
      throw new MakitoError(scrub(`${label}: ${error.message}${retries}`, this.secrets));
    }
  }
}

// Makito's photos with the session's token, any other link as it is. A run of thousands of photos leaves a reserve of
// the request limit to the screen and to the client's own use of the account: once Makito says no more than that is
// left, photos go one at a time with a pause, until its answers show the limit refilled.
export function makitoPhotoFetch(session: MakitoSession): UrlFetch {
  let remaining = Number.POSITIVE_INFINITY;
  let gate: Promise<void> = Promise.resolve();
  return async (url, options) => {
    if (!isAssetUrl(url)) return request(url, options);
    const turn = gate.then(() => (remaining <= LIMIT_RESERVE ? pause(LIMIT_WAIT_MS, options.signal) : undefined));
    gate = turn.catch(() => undefined);
    await turn;
    const answer = await session.fetchAsset(url, options);
    const left = answer.headers["x-ratelimit-remaining"];
    if (left && Number.isFinite(Number(left))) remaining = Number(left);
    return answer;
  };
}

function withToken(options: RequestOptions, token: string): RequestOptions {
  return { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } };
}
