import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { HttpResult, UrlFetch } from "../suppliers/http.js";
import { Budget } from "./batch.js";
import { geminiProvider } from "./gemini.js";
import { embedPhotos, type EmbedJob, emptyPhotoCounts } from "./photos.js";
import type { EmbeddingProvider } from "./provider.js";
import type { PhotoToEmbed } from "./store.js";
import { VOYAGE_DEFAULT_URL, voyageProvider } from "./voyage.js";

// The photos still without a vector, and what the run marked failed: the database of these tests
const db = vi.hoisted(() => ({
  photos: [] as { id: number; url: string }[],
  failed: [] as { photoId: number; error: string }[],
  written: [] as number[],
}));

vi.mock("./store.js", () => ({
  nextPhotos: (_db: unknown, _sourceId: number, _model: string, afterId: number, limit: number) =>
    Promise.resolve(db.photos.filter((photo) => photo.id > afterId).slice(0, limit)),
  markPhotosFailed: (_db: unknown, rows: { photoId: number; error: string }[]) => {
    db.failed.push(...rows);
    return Promise.resolve(rows.length);
  },
  notePhotosDeferred: () => Promise.resolve(),
  reuseVectors: () => Promise.resolve(new Set<number>()),
  writePhotoVectors: (_db: unknown, _model: string, rows: { photoId: number }[]) => {
    db.written.push(...rows.map((row) => row.photoId));
    return Promise.resolve(rows.length);
  },
}));

// The signature and the IHDR chunk with the size: all the image check reads of a PNG
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function answer(status: number, body: Buffer = Buffer.alloc(0)): HttpResult {
  return { status, headers: {}, omittedHeaders: [], body, durationMs: 1, attempts: 1, retries: [] };
}

function photos(count: number): PhotoToEmbed[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, url: `https://cdn.example/${index + 1}.jpg` }));
}

// A provider with the real pixel bound of one of ours, a vector for every image
function fakeProvider(maxImagePixels: number): EmbeddingProvider {
  return {
    name: "fake/2", dimensions: 2, maxImagesPerRequest: 6, maxTextsPerRequest: 1, maxImageBytesPerRequest: 1024 * 1024,
    maxImagePixels,
    priceUsd: () => 0,
    embedImages: (images) => Promise.resolve({ vectors: images.map(() => [1, 0]), usage: {} }),
    embedTexts: () => Promise.reject(new Error("no texts here")),
  };
}

function job(fetchPhoto: UrlFetch, maxImagePixels = geminiProvider("").maxImagePixels): EmbedJob {
  return {
    db: {} as PrismaClient, provider: fakeProvider(maxImagePixels), budget: new Budget(1), sourceId: 1,
    limit: undefined, isRetryFailed: false, signal: new AbortController().signal, secrets: [],
    beforeBatch: () => Promise.resolve(), fetchPhoto,
  };
}

const gone: UrlFetch = () => Promise.resolve(answer(404));

beforeEach(() => {
  db.photos = [];
  db.failed = [];
  db.written = [];
});

describe("embedPhotos", () => {
  it("marks the last, shorter page failed when the CDN has none of its photos", async () => {
    // Makito 2026-11-09..12: every other photo had a vector, the 34 left answered 404, and the run stopped every night
    db.photos = photos(34);
    const counts = emptyPhotoCounts();
    await embedPhotos(job(gone), counts);
    expect(counts.failed).toBe(34);
    expect(db.failed.map((row) => row.error)).toEqual(new Array<string>(34).fill("HTTP 404"));
  });

  it("stops on a full page where every photo failed and none came, marking nothing", async () => {
    db.photos = photos(100);
    await expect(embedPhotos(job(gone), emptyPhotoCounts())).rejects.toThrow(/^every one of 96 photos failed/);
    expect(db.failed).toEqual([]);
  });

  it("takes a page as long as --limit asked for as full: 8 broken photos stop the run, 7 are marked", async () => {
    db.photos = photos(8);
    await expect(embedPhotos({ ...job(gone), limit: 8 }, emptyPhotoCounts())).rejects.toThrow(/^every one of 8 photos/);
    expect(db.failed).toEqual([]);

    db.photos = photos(7);
    const counts = emptyPhotoCounts();
    await embedPhotos({ ...job(gone), limit: 7 }, counts);
    expect(counts.failed).toBe(7);
  });

  it("checks a photo's size against the provider's bound", async () => {
    // A Makito photo of 4500×4500: over Voyage's 16 million pixels, within Gemini's 16384×16384
    db.photos = photos(1);
    const large: UrlFetch = () => Promise.resolve(answer(200, png(4500, 4500)));

    const gemini = emptyPhotoCounts();
    await embedPhotos(job(large), gemini);
    expect([gemini.embedded, gemini.failed, db.written]).toEqual([1, 0, [1]]);

    const voyage = emptyPhotoCounts();
    await embedPhotos(job(large, voyageProvider("", VOYAGE_DEFAULT_URL).maxImagePixels), voyage);
    expect([voyage.embedded, voyage.failed]).toEqual([0, 1]);
    expect(db.failed).toEqual([{ photoId: 1, error: "image is 4500×4500, over 16000000 pixels" }]);
  });
});
