import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { correctHubs, type Hubness, photoScoresSql, readHubness, textScoresSql } from "./hubness.js";
import type { ListEntry, MatchedPhoto } from "./rank.js";

function entry(modelId: number, similarity: number, rank: number, photos: MatchedPhoto[] = []): ListEntry {
  return { modelId, rank, similarity, photos };
}

function photo(photoId: number, similarity: number): MatchedPhoto {
  return { photoId, similarity, imageSha256: `sha-${photoId}` };
}

// Model 1's text is a hub of texts, model 2's of photos; photo 21 is a hub of photos, photo 11 of texts
const hubness: Hubness = {
  model: "gemini-embedding-2/1536", textAlpha: 0.5, photoAlpha: 1,
  texts: { toTexts: new Map([[1, 0.9], [2, 0.8], [3, 0.8]]), toPhotos: new Map([[1, 0.7], [2, 0.9], [3, 0.7]]) },
  photos: {
    toPhotos: new Map([[11, 0.5], [12, 0.6], [21, 0.9], [31, 0.6]]),
    toTexts: new Map([[11, 0.8], [12, 0.6], [21, 0.6], [31, 0.6]]),
  },
};
const texts = [entry(1, 0.80, 1), entry(2, 0.78, 2), entry(3, 0.77, 3)];
const photos = [entry(2, 0.95, 1, [photo(21, 0.95)]), entry(1, 0.9, 2, [photo(11, 0.9), photo(12, 0.85)]), entry(3, 0.8, 3, [photo(31, 0.8)])];

describe("correctHubs", () => {
  it("ranks a text list by its similarity less alpha times the text's score on the query's side", () => {
    // text: 0.80 - 0.45 = 0.35, 0.78 - 0.40 = 0.38, 0.77 - 0.40 = 0.37
    expect(correctHubs("text-text", texts, hubness).map(({ modelId, rank }) => [modelId, rank])).toEqual([[2, 1], [3, 2], [1, 3]]);
    // photo: 0.80 - 0.35 = 0.45, 0.78 - 0.45 = 0.33, 0.77 - 0.35 = 0.42
    expect(correctHubs("image-text", texts, hubness).map(({ modelId }) => modelId)).toEqual([1, 3, 2]);
  });

  it("ranks a model in a photo list by its best photo after the correction", () => {
    // to photos: model 2 0.95 - 0.9 = 0.05; model 1 best of 0.4 and 0.25; model 3 0.2
    expect(correctHubs("image-photo", photos, hubness).map(({ modelId }) => modelId)).toEqual([1, 3, 2]);
    // to texts: model 2 0.35; model 1 best of 0.1 and 0.25; model 3 0.2
    expect(correctHubs("text-photo", photos, hubness).map(({ modelId }) => modelId)).toEqual([2, 1, 3]);
  });

  it("keeps the similarities, so the confidence and the closeness bound read them as before", () => {
    expect(correctHubs("text-text", texts, hubness).map(({ similarity }) => similarity)).toEqual([0.78, 0.77, 0.80]);
  });

  it("leaves a kind of list with alpha 0 as it is", () => {
    const textsOnly = { ...hubness, photoAlpha: 0 };
    expect(correctHubs("image-photo", photos, textsOnly)).toBe(photos);
    expect(correctHubs("text-text", texts, { ...hubness, textAlpha: 0 })).toBe(texts);
  });

  it("fails on an item with no score rather than rank it above every hub", () => {
    expect(() => correctHubs("text-text", [entry(9, 0.5, 1)], hubness)).toThrow("no hub score for the text of model 9");
    expect(() => correctHubs("image-photo", [entry(9, 0.5, 1, [photo(99, 0.5)])], hubness)).toThrow("no hub score for the photo 99");
  });
});

describe("scores SQL", () => {
  it("compares an item with the photos a search reads and the active models' texts, never its own model's", () => {
    const sql = textScoresSql("gemini-embedding-2/1536", 41);
    expect(sql.text).toContain("t.embedding_model = 'gemini-embedding-2/1536' AND t.model_id > $");
    expect(sql.text).toContain("coalesce(p.search_rank, 0) <");
    expect(sql.text).toContain("p.model_id <> b.model_id");
    expect(sql.text).toContain("m.is_active AND u.model_id <> b.model_id");
    expect(sql.text).toContain("u.embedding::halfvec(1536) <=> b.embedding::halfvec(1536)");
    expect(sql.values).toContain(41);
  });

  it("scores only the photos a search reads", () => {
    const sql = photoScoresSql("gemini-embedding-2/1536", 7);
    expect(sql.text).toContain("SELECT p.id, p.model_id, e.embedding FROM photo_embedding e");
    expect(sql.text.match(/coalesce\(p\.search_rank, 0\) </g)).toHaveLength(2);
    expect(sql.values).toContain(7);
  });
});

// The values of each batch's query, in order
function fakeDb(pages: unknown[][], calls: unknown[][] = []): PrismaClient {
  return {
    $queryRaw: (sql: { values: unknown[] }) => sql,
    $transaction: (queries: { values: unknown[] }[]) => {
      calls.push(queries[1]?.values ?? []);
      return Promise.resolve([[], pages.shift() ?? []]);
    },
  } as unknown as PrismaClient;
}

describe("readHubness", () => {
  it("reads every text, keyset by id, until a page comes back empty, and no photo with photo alpha 0", async () => {
    const calls: unknown[][] = [];
    const read = await readHubness(fakeDb([[{ id: 3, toPhotos: 0.7, toTexts: 0.8 }, { id: 8, toPhotos: 0.6, toTexts: 0.9 }], []], calls),
      "gemini-embedding-2/1536", 0.5, 0);
    expect(read.texts.toTexts).toEqual(new Map([[3, 0.8], [8, 0.9]]));
    expect(read.texts.toPhotos).toEqual(new Map([[3, 0.7], [8, 0.6]]));
    expect(read.photos.toPhotos.size).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(0);
    expect(calls[1]).toContain(8);
  });

  it("fails on an item with no neighbours instead of scoring it nothing", async () => {
    await expect(readHubness(fakeDb([[{ id: 3, toPhotos: null, toTexts: 0.8 }]]), "gemini-embedding-2/1536", 0, 1))
      .rejects.toThrow("no neighbours for the photo 3");
  });
});
