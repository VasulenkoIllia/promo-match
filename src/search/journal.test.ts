import { describe, expect, it } from "vitest";
import { createSearchJournal, journalEntry, type JournalEntry, journalFailure, MAX_JOURNAL_PHOTO_BYTES } from "./journal.js";
import { searchInput } from "./request.js";
import type { SearchResult } from "./results.js";
import type { SearchResponse } from "./search.js";

const SEARCH_ID = "3f2b1c9e-7a46-4e0b-9d11-2c5a8f6e1b70";
const PRICE = "2.5000";

const result = (rank: number, modelId: number, percent: number | null, photos: number): SearchResult => ({
  rank, score: 0.03, lists: { "image-photo": { rank, similarity: 0.9 } }, matchedCode: null, matchedCodeModels: null,
  conditionMatch: null, confidence: percent === null ? null : { percent, level: "high" }, modelId,
  source: { code: "axpol", name: "Axpol" }, code: `V${modelId}`, name: `Mug ${modelId}`, category: ["DRINKWARE"],
  pageUrl: `https://supplier.test/${modelId}`,
  photos: Array.from({ length: photos }, (_, index) => ({
    id: index + 1, url: `https://cdn.test/${modelId}-${index}.jpg`, urlLarge: null, similarity: 0.9, skus: [`V${modelId}-05`],
  })),
  variants: [{
    sku: `V${modelId}-05`, color: "red", size: null, inStock: 120, nextArrival: null,
    price: { amount: PRICE, currency: "EUR", minQuantity: 1 }, offer: null,
  }],
});

const queryParse = {
  status: "unavailable", model: "claude-haiku-5-5", reason: "timed-out", message: "no answer within 10000 ms",
} as const;

const response: SearchResponse = {
  model: "gemini-embedding-2/1536", lists: ["image-photo", "text-text"], isComplete: true, hasCloseMatch: true, queryParse,
  tookMs: 812, costUsd: 0.0004, results: [result(1, 7, 90, 2), result(2, 3, null, 0)],
};

const jpeg = (bytes: number) => Buffer.alloc(bytes, 7);
const image = (bytes: number) => ({ bytes: jpeg(bytes), info: { mimeType: "image/jpeg", width: 640, height: 480 } as const });

describe("journalEntry", () => {
  it("keeps the search as it was asked, with the photo it embedded and its results by model, place and confidence", () => {
    const input = searchInput({
      text: "  червона   чашка ", image: image(2_000), filters: { sources: ["axpol"], minStock: 10 }, limit: 100, conditionPass: null,
    });
    const entry = journalEntry(SEARCH_ID, 4, input, response);
    expect(entry).toEqual({
      searchId: SEARCH_ID, userId: 4, queryText: "червона чашка", queryParse, hasPhoto: true, photo: jpeg(2_000),
      photoSizeBytes: 2_000, embeddingModel: "gemini-embedding-2/1536", filters: { sources: ["axpol"], minStock: 10 },
      resultLimit: 100, isParseQuery: true, isConditionPass: false,
      results: [{ modelId: 7, rank: 1, confidencePercent: 90, photos: 2 }, { modelId: 3, rank: 2, confidencePercent: null, photos: 0 }],
      tookMs: 812,
    } satisfies JournalEntry);
  });

  it("keeps no purchase price, variant or link of a result", () => {
    const input = searchInput({ text: "mug", filters: {} });
    const kept = JSON.stringify(journalEntry(SEARCH_ID, 4, input, response));
    expect(kept).not.toContain(PRICE);
    expect(kept).not.toContain("variants");
    expect(kept).not.toContain("https://");
  });

  it("keeps a search by photo alone without a text, and of a photo over the bound only its size", () => {
    const input = searchInput({ image: image(MAX_JOURNAL_PHOTO_BYTES + 1), filters: {} });
    const entry = journalEntry(SEARCH_ID, 4, input, { ...response, queryParse: null });
    expect(entry).toMatchObject({
      queryText: null, queryParse: null, hasPhoto: true, photo: null, photoSizeBytes: MAX_JOURNAL_PHOTO_BYTES + 1,
    });
  });

  it("keeps a photo of exactly the bound, and says a text alone had none", () => {
    const atBound = journalEntry(SEARCH_ID, 4, searchInput({ image: image(MAX_JOURNAL_PHOTO_BYTES), filters: {} }), response);
    expect(atBound.photo?.length).toBe(MAX_JOURNAL_PHOTO_BYTES);
    const textAlone = journalEntry(SEARCH_ID, 4, searchInput({ text: "mug", filters: {} }), response);
    expect(textAlone).toMatchObject({ hasPhoto: false, photo: null, photoSizeBytes: null });
  });
});

describe("createSearchJournal", () => {
  const entry = journalEntry(SEARCH_ID, 4, searchInput({ text: "mug", filters: {} }), response);

  it("writes the entry and waits for the writes still going before it settles", async () => {
    const written: JournalEntry[] = [];
    let finish = () => {};
    const journal = createSearchJournal((each) => new Promise((resolve) => {
      finish = () => {
        written.push(each);
        resolve();
      };
    }));
    const recording = journal.record(() => entry);
    let isSettled = false;
    const settling = journal.settle().then(() => {
      isSettled = true;
    });
    await Promise.resolve();
    expect(isSettled).toBe(false);
    finish();
    await Promise.all([recording, settling]);
    expect(written).toEqual([entry]);
  });

  it("gives a failed write and a fault in making the entry to the caller, never as a throw, and still settles", async () => {
    const journal = createSearchJournal(() => Promise.reject(new Error("connection lost")));
    await expect(journal.record(() => entry)).rejects.toThrow("connection lost");
    const fault = () => {
      throw new TypeError("no results");
    };
    let recording: Promise<void> | undefined;
    expect(() => {
      recording = journal.record(fault);
    }).not.toThrow();
    await expect(recording).rejects.toThrow("no results");
    await expect(journal.settle()).resolves.toBeUndefined();
  });
});

describe("journalFailure", () => {
  it("logs the search and the kind of the error, not its message, which may quote the row", () => {
    const error = Object.assign(new Error("Invalid invocation: { queryText: \"червона чашка\" }"), { code: "P2000" });
    const logged = journalFailure(SEARCH_ID, error);
    expect(logged).toEqual({ searchId: SEARCH_ID, error: { type: "Error", code: "P2000" } });
    expect(JSON.stringify(logged)).not.toContain("чашка");
  });
});
