// Photos a supplier gives only with its token (Makito, docs/integrations.md, «Makito API B2B»), passed on to the
// signed-in screen by the server: the browser has no token and must never get one. A cache in memory spares the
// supplier's request limit, which its photos share with its feeds (x-ratelimit-remaining, about 100).
import { type ImageMimeType, inspectImage, MAX_IMAGE_BYTES } from "../embeddings/image.js";
import { retryWaitMs, MS_PER_SECOND } from "../suppliers/http.js";
import { assetUrl, isAssetPath, type MakitoSession } from "../suppliers/makito/api.js";

// A person waits for it: one attempt, no wait for a retry
const TIMEOUT_MS = 15_000;
// About 70 photos of 0.9 MB (1080×1080, 2026-11-04), a few result pages
const CACHE_MAX_BYTES = 64 * 1_048_576;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const HTTP_OK = 200;
const MISSING_STATUSES = new Set([404, 410]);
const RATE_LIMITED = 429;

export type PhotoAnswer =
  | { kind: "ok"; bytes: Buffer; mimeType: ImageMimeType }
  // Not a photo of the catalogue, or the supplier has none at that path
  | { kind: "missing" }
  // The supplier's request limit is reached
  | { kind: "busy"; retryAfterSeconds: number }
  // Anything else; the reason is for the log and holds no token
  | { kind: "failed"; reason: string };

export interface SupplierPhotos {
  read(path: string): Promise<PhotoAnswer>;
}

type Cached = Extract<PhotoAnswer, { kind: "ok" }>;

// path is what follows /catalog/assets/ in the photo's address; the host is Makito's, fixed in its client
export function createMakitoPhotos(session: MakitoSession, cacheMaxBytes = CACHE_MAX_BYTES): SupplierPhotos {
  // Map keeps insertion order: the first entry is the one used longest ago
  const cache = new Map<string, Cached>();
  let cachedBytes = 0;
  const loading = new Map<string, Promise<PhotoAnswer>>();

  function remember(path: string, photo: Cached): void {
    if (photo.bytes.length > cacheMaxBytes) return;
    cache.set(path, photo);
    cachedBytes += photo.bytes.length;
    for (const [oldest, old] of cache) {
      if (cachedBytes <= cacheMaxBytes) break;
      cache.delete(oldest);
      cachedBytes -= old.bytes.length;
    }
  }

  async function load(path: string): Promise<PhotoAnswer> {
    let answer;
    try {
      answer = await session.fetchAsset(assetUrl(path), {
        method: "GET", timeoutMs: TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES, maxAttempts: 1,
      });
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    if (MISSING_STATUSES.has(answer.status)) return { kind: "missing" };
    if (answer.status === RATE_LIMITED) {
      const waitMs = retryWaitMs(answer.headers["retry-after"] ?? null, DEFAULT_RETRY_AFTER_MS);
      return { kind: "busy", retryAfterSeconds: Math.max(1, Math.ceil(waitMs / MS_PER_SECOND)) };
    }
    if (answer.status !== HTTP_OK) return { kind: "failed", reason: `HTTP ${answer.status}` };
    // Makito sends application/octet-stream: the type comes from the bytes, and anything but a picture is refused;
    // the browser shows a photo of any size, some are 4500×4500
    const info = inspectImage(answer.body, Number.POSITIVE_INFINITY);
    if (typeof info === "string") return { kind: "failed", reason: info };
    const photo: Cached = { kind: "ok", bytes: answer.body, mimeType: info.mimeType };
    remember(path, photo);
    return photo;
  }

  return {
    read(path) {
      if (!isAssetPath(path)) return Promise.resolve({ kind: "missing" });
      const cached = cache.get(path);
      if (cached) {
        cache.delete(path);
        cache.set(path, cached);
        return Promise.resolve(cached);
      }
      // A page asks for the same photo as a card and as a thumbnail at once: one request for both
      let pending = loading.get(path);
      if (!pending) {
        pending = load(path).finally(() => loading.delete(path));
        loading.set(path, pending);
      }
      return pending;
    },
  };
}
