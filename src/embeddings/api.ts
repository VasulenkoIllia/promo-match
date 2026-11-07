// One JSON call to an embedding API, shared by the providers: the shared HTTP client (timeout over the whole call,
// a cap on the body, retries on a network error, 429 and 5xx with Retry-After), then the answer sorted into what the
// worker does next. An embedding is a pure function of its input, so a retried call is safe.
import { HttpError, request } from "../suppliers/http.js";
import { isRecord } from "../suppliers/normalize.js";

// The provider refused the input (HTTP 400, 413, 422): a broken image, too many tokens, but also a key Google answers
// with 400. The batch is split to find the item; when every item is refused alone, the request is at fault and the run
// stops (src/embeddings/batch.ts, embedSplitting).
export class InputRejected extends Error {
  override name = "InputRejected";
}

// The provider cannot be used now: a wrong key, a used-up quota, an outage that outlasted the retries, an answer of an
// unexpected shape. The run stops; what is left stays pending for the next one.
export class ProviderError extends Error {
  override name = "ProviderError";
}

// Tokens of a text, counted generously for the budget: English runs about 4 characters a token
const CHARS_PER_TOKEN = 3;

export function estimatedTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// A batch of 32 images of 1000×1000 pixels takes Voyage about 10 s; the rest is room for a slow day
const TIMEOUT_MS = 120_000;
// 128 vectors of 1536 numbers as JSON are about 4 MB
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Voyage's guide retries a 429 with backoff; four attempts with Retry-After (capped at 30 s) ride out a short peak
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 5_000;
const INPUT_REJECTED_STATUSES = new Set([400, 413, 422]);
const MAX_DETAIL_CHARS = 300;

function detail(body: Buffer): string {
  return body.toString("utf8").replaceAll(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
}

export async function postJson(url: URL, headers: Record<string, string>, body: unknown, signal: AbortSignal):
  Promise<unknown> {
  let result;
  try {
    result = await request(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES, maxAttempts: MAX_ATTEMPTS, backoffMs: BACKOFF_MS, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const attempts = error instanceof HttpError ? ` after ${error.attempts} attempts` : "";
    throw new ProviderError(`${url.host}: ${error instanceof Error ? error.message : String(error)}${attempts}`);
  }
  const retried = result.retries.length ? ` (retried: ${result.retries.join("; ")})` : "";
  if (INPUT_REJECTED_STATUSES.has(result.status)) {
    throw new InputRejected(`${url.host}: HTTP ${result.status}: ${detail(result.body)}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ProviderError(`${url.host}: HTTP ${result.status}: ${detail(result.body)}${retried}`);
  }
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch {
    throw new ProviderError(`${url.host}: the answer is not JSON: ${detail(result.body)}`);
  }
}

// Every vector of the answer: as many as were sent, each of the model's dimension and of finite numbers only, so a
// silent change on the provider's side never reaches the database. Read by index, so a hole in a sparse array (a
// missing or repeated index) is caught too.
export function checkVectors(vectors: unknown[], count: number, dimensions: number, provider: string): number[][] {
  if (vectors.length !== count) throw new ProviderError(`${provider}: ${vectors.length} vectors for ${count} inputs`);
  return Array.from({ length: count }, (_unused, index) => {
    const vector: unknown = vectors[index];
    if (!Array.isArray(vector) || vector.length !== dimensions
      || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      const shape = Array.isArray(vector) ? `${vector.length} values` : typeof vector;
      throw new ProviderError(`${provider}: vector ${index} is not ${dimensions} finite numbers (${shape})`);
    }
    return vector as number[];
  });
}

// The provider's own usage numbers, for the report: only the numeric fields
export function numericFields(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1])));
}
