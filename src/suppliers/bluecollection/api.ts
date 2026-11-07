import { HttpError, request, type HttpResult } from "../http.js";
import { isRecord } from "../normalize.js";
import { scrub } from "../secrets.js";

// Blue Collection API of Asgard (docs/integrations.md): JWT pair from a login, lists in pages of 100. Read only.
const BLUECOLLECTION_BASE = new URL("https://developers.bluecollection.eu/api/");
// Only these lists can be read; orders are refused before a request is built
const READ_PATH = /^\/api\/(client-products|categories|subcategories)\/$/;
const TOKEN_PATH = "token/";
const REFRESH_PATH = "token/refresh/";
// The access token lives 5 minutes (2026-11-04); a new one is taken a minute before
const ACCESS_RENEW_AFTER_MS = 4 * 60_000;
const BYTES_PER_MB = 1_048_576;
const READ_TIMEOUT_MS = 120_000;
const READ_MAX_BYTES = 50 * BYTES_PER_MB;
const READ_ATTEMPTS = 3;
const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_MAX_BYTES = BYTES_PER_MB;
// 1911 records in 20 pages (2026-11-04): a list ten times larger is a loop, not a catalogue
const MAX_PAGES = 200;
const HTTP_OK = 200;

export interface Credentials {
  username: string;
  password: string;
}

export interface PagedList {
  records: unknown[];
  // What the first page said the list holds
  count: number;
  pages: number;
  bytes: number;
}

export class BluecollectionError extends Error {}

export function readUrl(path: string): URL {
  const url = new URL(path, BLUECOLLECTION_BASE);
  // Checked on the built URL, after any ".." is resolved
  if (url.origin !== BLUECOLLECTION_BASE.origin || !READ_PATH.test(url.pathname)) {
    throw new BluecollectionError(`${path} is not a read list`);
  }
  return url;
}

// The next page as the answer gives it: the same list on the same host, only another page
export function nextPageUrl(next: unknown, current: URL): URL | null {
  if (next === null || next === undefined) return null;
  const url = typeof next === "string" && URL.canParse(next, current.href) ? new URL(next, current) : null;
  if (!url || url.origin !== current.origin || url.pathname !== current.pathname || url.username || url.password) {
    throw new BluecollectionError(`${current.pathname}: the next page is not a page of the same list`);
  }
  return url;
}

function parseJson(answer: HttpResult, label: string): unknown {
  if (answer.status !== HTTP_OK) throw new BluecollectionError(`${label}: HTTP ${answer.status}`);
  try {
    return JSON.parse(answer.body.toString("utf8")) as unknown;
  } catch {
    throw new BluecollectionError(`${label}: the answer is not JSON (${answer.body.length} bytes)`);
  }
}

export class BluecollectionClient {
  private access = "";
  private refresh = "";
  private accessSinceMs = 0;

  constructor(
    private readonly credentials: Credentials,
    private readonly secrets: string[],
    private readonly signal: AbortSignal,
  ) {
    secrets.push(credentials.username, credentials.password);
  }

  // Every page of a list, one after another
  async readAll(path: string): Promise<PagedList> {
    const records: unknown[] = [];
    let url: URL | null = readUrl(path);
    let count: number | null = null;
    let pages = 0;
    let bytes = 0;
    while (url) {
      if (pages >= MAX_PAGES) throw new BluecollectionError(`${path}: more than ${MAX_PAGES} pages`);
      const answer = await this.get(url, `${path} page ${pages + 1}`);
      const page = parseJson(answer, `${path} page ${pages + 1}`);
      if (!isRecord(page) || !Array.isArray(page.results)) throw new BluecollectionError(`${path}: a page without results`);
      // Without the count a cut list would look complete, and the import would mark the rest inactive
      if (count === null && !(Number.isInteger(page.count) && Number(page.count) >= 0)) {
        throw new BluecollectionError(`${path}: the first page gives no count`);
      }
      count ??= Number(page.count);
      records.push(...(page.results as unknown[]));
      pages += 1;
      bytes += answer.body.length;
      url = nextPageUrl(page.next, url);
    }
    return { records, count: count ?? 0, pages, bytes };
  }

  private async get(url: URL, label: string): Promise<HttpResult> {
    readUrl(url.pathname);
    const token = await this.accessToken();
    return this.call(url, {
      method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_MAX_BYTES, maxAttempts: READ_ATTEMPTS,
    }, label);
  }

  // A login once and a renewal by the refresh token after 4 minutes; neither is repeated on a failure, so a wrong
  // password cannot lock the account
  private async accessToken(): Promise<string> {
    if (this.access && Date.now() - this.accessSinceMs < ACCESS_RENEW_AFTER_MS) return this.access;
    const isRenewal = Boolean(this.refresh);
    const body = isRenewal ? { refresh: this.refresh } : { username: this.credentials.username, password: this.credentials.password };
    const answer = await this.call(new URL(isRenewal ? REFRESH_PATH : TOKEN_PATH, BLUECOLLECTION_BASE), {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body),
      timeoutMs: LOGIN_TIMEOUT_MS, maxBytes: LOGIN_MAX_BYTES, maxAttempts: 1,
    }, isRenewal ? "token refresh" : "login");
    const tokens = parseJson(answer, isRenewal ? "token refresh" : "login");
    const access = isRecord(tokens) && typeof tokens.access === "string" ? tokens.access : "";
    if (!access) throw new BluecollectionError(`${isRenewal ? "token refresh" : "login"}: no access token in the answer`);
    this.secrets.push(access);
    this.access = access;
    this.accessSinceMs = Date.now();
    // A refresh answer may rotate the refresh token too
    if (isRecord(tokens) && typeof tokens.refresh === "string" && tokens.refresh) {
      this.secrets.push(tokens.refresh);
      this.refresh = tokens.refresh;
    }
    return access;
  }

  private async call(url: URL, options: Parameters<typeof request>[1], label: string): Promise<HttpResult> {
    try {
      return await request(url, { ...options, signal: this.signal });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
      throw new BluecollectionError(scrub(`${label}: ${error.message}${retries}`, this.secrets));
    }
  }
}
