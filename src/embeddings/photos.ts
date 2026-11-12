// The photos of one source: pages of photos with no vector of the provider's model (keyset by id), downloaded a few at
// a time, the same picture sent once, written page by page (docs/integrations.md, «Ембедінги каталогу»). A stop or a
// failed call ends the run after the vectors already paid for are written; the rest stays pending.
import type { PrismaClient } from "../generated/prisma/client.js";
import type { UrlFetch } from "../suppliers/http.js";
import { scrub } from "../suppliers/secrets.js";
import { addExample, addUsage, batchesOf, type Budget, embedSplitting, mapSettled, toError } from "./batch.js";
import { type Download, downloadImage } from "./image.js";
import type { EmbeddingProvider } from "./provider.js";
import { markPhotosFailed, nextPhotos, notePhotosDeferred, type PhotoToEmbed, reuseVectors, writePhotoVectors } from "./store.js";

const PAGE_SIZE = 96;
// The Axpol CDN answers each photo in 2-3 s whatever its size (2026-10-29), so downloads set the pace there; 24 at
// once held. Requests stay at 4: a Voyage page is 3 batches, and its 2M tokens a minute fill before more would help
const DOWNLOAD_CONCURRENCY = 24;
const REQUEST_CONCURRENCY = 4;
// Pages in a row where the CDN gave no photo: it is down, and the run stops instead of walking the catalogue
const MAX_DEFERRED_PAGES = 3;
// A full page (more photos follow it) of at least this many where every photo failed and none came is a block or a
// moved CDN, not that many missing photos: the run stops before marking them. The last, shorter page is marked: there
// the photos left are those the CDN does not have, and stopping on them failed the run every night (Makito,
// 2026-11-09..12; decision 2026-11-12)
const MIN_PAGE_FOR_FAILED_GUARD = 8;

export interface PhotoCounts {
  embedded: number;
  // Got the vector of the same picture under another photo, with no call
  reused: number;
  failed: number;
  // Not downloaded now (network, 5xx, a block): pending for the next run
  deferred: number;
  // Calls made to the provider, refused ones included
  calls: number;
  usage: Record<string, number>;
  examples: string[];
}

export function emptyPhotoCounts(): PhotoCounts {
  return { embedded: 0, reused: 0, failed: 0, deferred: 0, calls: 0, usage: {}, examples: [] };
}

export interface EmbedJob {
  db: PrismaClient;
  provider: EmbeddingProvider;
  budget: Budget;
  sourceId: number;
  // At most this many photos and texts per source (a trial run); undefined for all
  limit: number | undefined;
  isRetryFailed: boolean;
  signal: AbortSignal;
  // Keys and the database password: scrubbed from every error text stored in the database
  secrets: readonly string[];
  // Before every call and page: the stop signal, then the lease renewed
  beforeBatch: () => Promise<void>;
  // The source's own fetch when its photos need a token (Makito); undefined for a public CDN
  fetchPhoto: UrlFetch | undefined;
}

// One picture to send: the photos that share its bytes get its vector
interface Picture {
  sha256: string;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  pixels: number;
  photoIds: number[];
}

type Downloaded = { photo: PhotoToEmbed; download: Extract<Download, { kind: "ok" }> };

function picturesOf(downloaded: Downloaded[]): Picture[] {
  const pictures = new Map<string, Picture>();
  for (const { photo, download } of downloaded) {
    const known = pictures.get(download.sha256);
    if (known) {
      known.photoIds.push(photo.id);
      continue;
    }
    pictures.set(download.sha256, {
      sha256: download.sha256, bytes: download.bytes, mimeType: download.info.mimeType,
      pixels: download.info.width * download.info.height, photoIds: [photo.id],
    });
  }
  return [...pictures.values()];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Sends the pictures, writes what came back and marks what the provider refused; then throws the first failure
async function embedPictures(job: EmbedJob, pictures: Picture[], counts: PhotoCounts): Promise<void> {
  const { provider } = job;
  const batches = batchesOf(pictures, provider.maxImagesPerRequest, provider.maxImageBytesPerRequest,
    (picture) => picture.bytes.length);
  const results = await mapSettled(batches, REQUEST_CONCURRENCY, (batch) => embedSplitting(batch, async (items) => {
    await job.beforeBatch();
    job.budget.reserve(provider.priceUsd({ imagePixels: items.map((item) => item.pixels), textChars: 0 }));
    counts.calls += 1;
    const result = await provider.embedImages(items, "document", job.signal);
    addUsage(counts.usage, result.usage);
    return result.vectors;
  }));
  const rows: { photoId: number; vector: number[]; sha256: string }[] = [];
  const rejected: { photoId: number; error: string }[] = [];
  const failures: Error[] = [];
  for (const result of results) {
    if (result?.status === "rejected") failures.push(toError(result.reason));
    if (result?.status !== "fulfilled") continue;
    if (result.value.failure !== undefined) failures.push(result.value.failure);
    for (const [picture, vector] of result.value.vectors) {
      for (const photoId of picture.photoIds) rows.push({ photoId, vector, sha256: picture.sha256 });
    }
    for (const [picture, error] of result.value.rejected) {
      const text = scrub(`refused: ${error}`, job.secrets);
      for (const photoId of picture.photoIds) rejected.push({ photoId, error: text });
      addExample(counts.examples, `photo ${picture.photoIds.join(", ")}: ${text}`);
    }
  }
  try {
    counts.embedded += await writePhotoVectors(job.db, provider.name, rows);
    counts.failed += await markPhotosFailed(job.db, rejected);
  } catch (error) {
    // The provider's failure, if any, is the cause worth reading first
    const [first] = failures;
    if (first) throw new Error(`${first.message}; then the write failed: ${messageOf(error)}`, { cause: error });
    throw error;
  }
  // Any further failure of the same page goes to the report, so a 401 is not hidden behind a reached budget
  for (const failure of failures.slice(1)) addExample(counts.examples, `also: ${scrub(failure.message, job.secrets)}`);
  const [first] = failures;
  if (first) throw first;
}

async function downloadPage(job: EmbedJob, page: PhotoToEmbed[]) {
  const downloads = await mapSettled(page, DOWNLOAD_CONCURRENCY,
    (photo) => downloadImage(photo.url, job.signal, job.fetchPhoto, job.provider.maxImagePixels));
  const downloaded: Downloaded[] = [];
  const failed: { photoId: number; error: string }[] = [];
  const deferred: { photoId: number; error: string }[] = [];
  page.forEach((photo, index) => {
    const result = downloads[index];
    if (result?.status !== "fulfilled") {
      // downloadImage throws only on a stop; anything else is a bug worth its message
      job.signal.throwIfAborted();
      throw new Error(`photo ${photo.id}: ${result?.status === "rejected" ? String(result.reason) : "download not started"}`);
    }
    const download = result.value;
    if (download.kind === "ok") downloaded.push({ photo, download });
    else (download.kind === "failed" ? failed : deferred).push({ photoId: photo.id, error: scrub(download.error, job.secrets) });
  });
  return { downloaded, failed, deferred };
}

// False when the CDN gave no photo of the page. isFullPage: the page is as long as asked, so more photos may follow
async function embedPage(job: EmbedJob, page: PhotoToEmbed[], isFullPage: boolean, counts: PhotoCounts): Promise<boolean> {
  const { downloaded, failed, deferred } = await downloadPage(job, page);
  if (isFullPage && !downloaded.length && failed.length === page.length && page.length >= MIN_PAGE_FOR_FAILED_GUARD) {
    throw new Error(`every one of ${page.length} photos failed to download and none came, nothing marked: `
      + `${failed.slice(0, 3).map((item) => `photo ${item.photoId}: ${item.error}`).join("; ")}`);
  }
  for (const item of [...failed, ...deferred]) {
    addExample(counts.examples, `photo ${item.photoId}${failed.includes(item) ? "" : " deferred"}: ${item.error}`);
  }
  counts.failed += await markPhotosFailed(job.db, failed);
  counts.deferred += deferred.length;
  await notePhotosDeferred(job.db, deferred);
  const reused = await reuseVectors(job.db, job.provider.name,
    downloaded.map(({ photo, download }) => ({ photoId: photo.id, sha256: download.sha256 })));
  counts.reused += reused.size;
  await embedPictures(job, picturesOf(downloaded.filter(({ photo }) => !reused.has(photo.id))), counts);
  return downloaded.length > 0;
}

export async function embedPhotos(job: EmbedJob, counts: PhotoCounts): Promise<void> {
  let afterId = 0;
  let left = job.limit ?? Number.POSITIVE_INFINITY;
  let deferredPages = 0;
  while (left > 0) {
    await job.beforeBatch();
    const size = Math.min(PAGE_SIZE, left);
    const page = await nextPhotos(job.db, job.sourceId, job.provider.name, afterId, size, job.isRetryFailed);
    const last = page.at(-1);
    if (!last) return;
    afterId = last.id;
    left -= page.length;
    deferredPages = (await embedPage(job, page, page.length === size, counts)) ? 0 : deferredPages + 1;
    if (deferredPages >= MAX_DEFERRED_PAGES) {
      throw new Error(`no photo of ${MAX_DEFERRED_PAGES} pages in a row could be downloaded, the CDN looks down`
        + ` (${counts.examples.join("; ")})`);
    }
  }
}
