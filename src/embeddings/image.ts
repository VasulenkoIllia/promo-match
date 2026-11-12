// Catalogue photos for the embeddings: the worker downloads each from the supplier's CDN, checks it by its header and
// sends the bytes, so both providers get the same input and a missing photo shows up as the supplier's, not as a
// provider error. Every photo of the demo catalogues is a JPEG (Axpol 1000×1000, Midocean 700×700, 2026-10-29).
// Makito answers 401 without its token, so its photos come through its own client (fetchUrl).
import { createHash } from "node:crypto";
import { HttpError, request, type UrlFetch } from "../suppliers/http.js";

export type ImageMimeType = "image/jpeg" | "image/png";

export interface ImageInfo {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

// Both providers take images up to 20 MB; Gemini takes PNG and JPEG only. The pixel bound is each provider's
// (EmbeddingProvider.maxImagePixels); MAX_IMAGE_PIXELS is Voyage's, the smaller one, for an image any provider may get
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_ATTEMPTS = 3;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Start-of-frame markers carry the size; C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) do not
const JPEG_NOT_SOF = new Set([0xc4, 0xc8, 0xcc]);
const REDIRECT_FROM = 300;
const CLIENT_ERROR_FROM = 400;
const SERVER_ERROR_FROM = 500;
// A CDN answers these for a block or a peak (a WAF, hotlink protection, throttling), not for a photo that is gone
const DEFERRED_CLIENT_STATUSES = new Set([401, 403, 408, 429]);

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes, and the markers that have no length after them
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NOT_SOF.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

// The type and size from the file itself, not from a header or the URL; a string says why the image cannot be sent.
// The pixel bound is the provider's (by default MAX_IMAGE_PIXELS, the smaller one); a photo only shown on screen has none
export function inspectImage(bytes: Buffer, maxPixels = MAX_IMAGE_PIXELS): ImageInfo | string {
  if (bytes.length > MAX_IMAGE_BYTES) return `image is ${bytes.length} bytes, over ${MAX_IMAGE_BYTES}`;
  let info: ImageInfo | undefined;
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    if (size) info = { mimeType: "image/jpeg", ...size };
  } else if (bytes.length >= 24 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    info = { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else {
    return `not a JPEG or PNG (starts with ${bytes.subarray(0, 4).toString("hex") || "nothing"})`;
  }
  if (!info || info.width === 0 || info.height === 0) return "image size not readable";
  if (info.width * info.height > maxPixels) {
    return `image is ${info.width}×${info.height}, over ${maxPixels} pixels`;
  }
  return info;
}

// Supplier feeds give https links to their CDNs (src/suppliers/normalize.ts); a link to this machine or a bare IP
// address is never fetched
export function isPublicHttpsUrl(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  // "localhost." is localhost too
  const host = url.hostname.replace(/\.$/, "");
  return url.protocol === "https:" && !url.username && !url.password && !url.port && host !== "localhost"
    && !host.endsWith(".localhost") && !host.startsWith("[") && !/^[\d.]+$/.test(host);
}

// ok: the bytes to send; failed: the photo itself is broken or gone (marked failed, retried with --retry-failed);
// deferred: the CDN did not give it now (stays pending for the next run)
export type Download =
  | { kind: "ok"; bytes: Buffer; info: ImageInfo; sha256: string }
  | { kind: "failed"; error: string }
  | { kind: "deferred"; error: string };

// A status other than 200: a redirect (the shared client never follows one) and a client error mean the photo is not
// there; a block, throttling, a server error or an odd 2xx may pass by the next run
export function statusOutcome(status: number): "failed" | "deferred" {
  if (status >= REDIRECT_FROM && status < CLIENT_ERROR_FROM) return "failed";
  if (status >= CLIENT_ERROR_FROM && status < SERVER_ERROR_FROM && !DEFERRED_CLIENT_STATUSES.has(status)) return "failed";
  return "deferred";
}

// fetchUrl is the source's own when its photos need a token (src/suppliers/registry.ts, photoFetchFor); maxPixels is
// the provider's bound, past it the photo is failed
export async function downloadImage(link: string, signal: AbortSignal, fetchUrl: UrlFetch = request,
  maxPixels = MAX_IMAGE_PIXELS): Promise<Download> {
  if (!isPublicHttpsUrl(link)) return { kind: "failed", error: "not a public https link" };
  try {
    const result = await fetchUrl(new URL(link), {
      method: "GET", timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES, maxAttempts: DOWNLOAD_ATTEMPTS, signal,
    });
    if (result.status === 200) {
      const info = inspectImage(result.body, maxPixels);
      if (typeof info === "string") return { kind: "failed", error: info };
      return { kind: "ok", bytes: result.body, info, sha256: createHash("sha256").update(result.body).digest("hex") };
    }
    const where = result.location ? ` to ${result.location}` : "";
    return { kind: statusOutcome(result.status), error: `HTTP ${result.status}${where}` };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    // A file the CDN says is over the cap is the photo's fault; a timeout or a reset, even mid-body, is not
    const length = error instanceof HttpError ? Number(error.response?.headers["content-length"]) : Number.NaN;
    return { kind: length > MAX_IMAGE_BYTES ? "failed" : "deferred", error: message };
  }
}
