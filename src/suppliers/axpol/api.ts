import { HttpError, type HttpResult, MS_PER_SECOND, pause, request } from "../http.js";
import { isRecord, parseInteger } from "../normalize.js";
import { scrub } from "../secrets.js";

// Axpol B2B API (docs/integrations.md): Customer.Login, then GET reads with the JWT. Read only.
export const AXPOL_BASE = "https://axpol.com/api/b2b-api/";
// Only these methods can be called: Order.Add, Address.* and Api.* are refused before a request is built
export const AXPOL_READ_METHOD = /^(Product|Stock|Printing)\.(Count|List)$/;
// "Changed after this date": an old date selects the whole catalogue
export const AXPOL_SINCE = "2000-01-01 00:00:00";
// The JWT lives 10 minutes: log in again a minute before it runs out
export const JWT_TTL_FALLBACK_SECONDS = 600;
export const JWT_MARGIN_MS = 60_000;
const BYTES_PER_MB = 1_048_576;
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 64 * BYTES_PER_MB;
// Three tries of a read on a network error, 429 or 5xx: a nightly sync should outlast a short hiccup. The login is
// sent once: the live account's password does not travel again on its own.
const MAX_ATTEMPTS = 3;
const LOGIN_ATTEMPTS = 1;
// Answers of Axpol itself that may mean the JWT ran out early; a 429 or 5xx left after the retries is no login matter
const AUTH_STATUSES = new Set([200, 401, 403]);
// A pause between reads, so a full catalogue does not hit the API in a burst
const PAUSE_MS = 250;
const HTTP_OK = 200;

export type AxpolFeed = "Product" | "Stock" | "Printing";

export interface AxpolCredentials {
  login: string;
  password: string;
  apiKey: string;
}

export interface AxpolPage {
  // Records by the key Axpol gives them (productId)
  records: Map<string, Record<string, unknown>>;
  bytes: number;
  durationMs: number;
}

interface Session {
  uid: string;
  jwt: string;
  refreshAtMs: number;
}

export class AxpolError extends Error {}

// exp - iat of the JWT claims in seconds; undefined when the token does not say or says nonsense
export function readJwtTtlSeconds(jwt: string): number | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (isRecord(claims) && typeof claims.exp === "number" && typeof claims.iat === "number") {
      const ttlSeconds = claims.exp - claims.iat;
      return ttlSeconds > 0 ? ttlSeconds : undefined;
    }
  } catch {
    // Claims that are not JSON: the documented lifetime is assumed
  }
  return undefined;
}

interface Answer {
  status: number;
  // Undefined when the body is not a JSON object (a firewall's HTML page)
  envelope?: Record<string, unknown>;
  contentType: string;
  bytes: number;
  durationMs: number;
}

function answerOf(response: HttpResult): Answer {
  let envelope: Record<string, unknown> | undefined;
  try {
    const json: unknown = JSON.parse(response.body.toString("utf8"));
    if (isRecord(json)) envelope = json;
  } catch {
    // Not JSON: describe() says so with the content type and size
  }
  return {
    status: response.status, envelope, contentType: response.headers["content-type"] ?? "no content type",
    bytes: response.body.length, durationMs: response.durationMs,
  };
}

function isSuccess(answer: Answer): boolean {
  const success = answer.envelope?.success;
  return answer.status === HTTP_OK && (success === 1 || success === "1" || success === true);
}

function describe(answer: Answer): string {
  const { envelope } = answer;
  if (!envelope) return `HTTP ${answer.status}, not JSON (${answer.contentType}, ${answer.bytes} bytes)`;
  return `HTTP ${answer.status}, ${typeof envelope.message === "string" && envelope.message ? envelope.message : "no message"}`;
}

export class AxpolClient {
  #session: Session | undefined;

  constructor(
    private readonly credentials: AxpolCredentials,
    private readonly secrets: string[],
    private readonly signal: AbortSignal,
    private readonly base = AXPOL_BASE,
    private readonly pauseMs = PAUSE_MS,
  ) {
    secrets.push(credentials.login, credentials.password, credentials.apiKey);
  }

  async count(feed: AxpolFeed): Promise<number> {
    const { envelope } = await this.read(`${feed}.Count`, { date: AXPOL_SINCE });
    const data = isRecord(envelope.data) ? envelope.data : {};
    // "10 883": a whole number with a space between thousands
    const count = parseInteger(data.count);
    if (count === null || count < 0) throw new AxpolError(`${feed}.Count: no whole number in data.count`);
    return count;
  }

  async list(feed: AxpolFeed, limit: number, offset: number): Promise<AxpolPage> {
    const params = { date: AXPOL_SINCE, limit: String(limit), offset: String(offset) };
    const { envelope, bytes, durationMs } = await this.read(`${feed}.List`, params);
    const records = new Map<string, Record<string, unknown>>();
    // An empty page comes as [] or {}, a full one as an object keyed by productId; records in an array would be a
    // format this client does not know
    const isEmptyArray = Array.isArray(envelope.data) && envelope.data.length === 0;
    if (!isRecord(envelope.data) && !isEmptyArray) {
      throw new AxpolError(`${feed}.List offset ${offset}: data is neither an object nor an empty array`);
    }
    const data = isRecord(envelope.data) ? envelope.data : {};
    for (const [key, record] of Object.entries(data)) {
      if (!isRecord(record)) throw new AxpolError(`${feed}.List offset ${offset}: record ${key} is not an object`);
      records.set(key, record);
    }
    return { records, bytes, durationMs };
  }

  // A read that Axpol itself answers without success is tried once more after a new login: the JWT may have run out
  // early. Both answers go into the error.
  private async read(method: string, params: Record<string, string>) {
    if (!AXPOL_READ_METHOD.test(method)) throw new AxpolError(`${method} is not a read method`);
    await pause(this.pauseMs, this.signal);
    let answer = await this.get(method, params, await this.session());
    let before = "";
    if (!isSuccess(answer) && AUTH_STATUSES.has(answer.status)) {
      before = ` (before a new login: ${describe(answer)})`;
      this.#session = undefined;
      answer = await this.get(method, params, await this.session());
    }
    if (!isSuccess(answer) || !answer.envelope) {
      throw new AxpolError(scrub(`${method}: ${describe(answer)}${before}`, this.secrets));
    }
    return { envelope: answer.envelope, bytes: answer.bytes, durationMs: answer.durationMs };
  }

  private async get(method: string, params: Record<string, string>, session: Session): Promise<Answer> {
    const url = new URL(this.base);
    url.searchParams.set("key", this.credentials.apiKey);
    url.searchParams.set("uid", session.uid);
    url.searchParams.set("method", method);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(`params[${name}]`, value);
    const options = { method: "GET", headers: { Authorization: `Bearer ${session.jwt}` } } as const;
    return answerOf(await this.call(url, options, MAX_ATTEMPTS, method));
  }

  private async session(): Promise<Session> {
    if (this.#session && Date.now() < this.#session.refreshAtMs) return this.#session;
    this.#session = await this.login();
    return this.#session;
  }

  // A rejected login is never repeated: the same password again could lock the account
  private async login(): Promise<Session> {
    const form = new FormData();
    form.set("method", "Customer.Login");
    form.set("key", this.credentials.apiKey);
    form.set("params[username]", this.credentials.login);
    form.set("params[password]", this.credentials.password);
    const answer = answerOf(await this.call(new URL(this.base), { method: "POST", body: form }, LOGIN_ATTEMPTS,
      "Customer.Login"));
    const data = isRecord(answer.envelope?.data) ? answer.envelope.data : {};
    const { jwt, uid } = data;
    if (!isSuccess(answer) || typeof jwt !== "string" || !jwt || (typeof uid !== "string" && typeof uid !== "number")) {
      throw new AxpolError(scrub(`Customer.Login rejected: ${describe(answer)}`, this.secrets));
    }
    this.secrets.push(jwt);
    const ttlMs = (readJwtTtlSeconds(jwt) ?? JWT_TTL_FALLBACK_SECONDS) * MS_PER_SECOND;
    // Half the lifetime at least, so a short-lived token does not mean a login before every read
    return { uid: String(uid), jwt, refreshAtMs: Date.now() + Math.max(ttlMs - JWT_MARGIN_MS, ttlMs / 2) };
  }

  private async call(url: URL, options: { method: "GET" | "POST"; headers?: Record<string, string>; body?: FormData },
    maxAttempts: number, label: string): Promise<HttpResult> {
    try {
      return await request(url, { ...options, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, maxAttempts, signal: this.signal });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const retries = error.retries.length ? ` (after ${error.retries.join(", ")})` : "";
      throw new AxpolError(scrub(`${label}: ${error.message}${retries}`, this.secrets));
    }
  }
}
