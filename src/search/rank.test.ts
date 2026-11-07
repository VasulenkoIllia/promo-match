import { describe, expect, it } from "vitest";
import {
  addVotes, hasCloseText, fuseLists, interleave, liftModels, PHOTOS_PER_RESULT, rankPhotoHits, rankTextHits, RRF_K, tieOrder,
} from "./rank.js";

// A photo hit whose picture is its own unless said otherwise
const hit = (modelId: number, photoId: number, distance: number, imageSha256 = `sha${photoId}`) =>
  ({ modelId, photoId, imageSha256, distance });

describe("rankPhotoHits", () => {
  it("groups photos to models, ranked by their best photo, whatever order the scan gave", () => {
    const entries = rankPhotoHits([hit(2, 20, 0.3), hit(1, 10, 0.1), hit(2, 21, 0.2), hit(1, 11, 0.4)]);
    expect(entries.map(({ modelId, rank, similarity }) => ({ modelId, rank, similarity }))).toEqual([
      { modelId: 1, rank: 1, similarity: 0.9 },
      { modelId: 2, rank: 2, similarity: 0.8 },
    ]);
    expect(entries[0]?.photos.map((photo) => [photo.photoId, photo.similarity])).toEqual([[10, 0.9], [11, 0.6]]);
    expect(entries[1]?.photos.map((photo) => photo.photoId)).toEqual([21, 20]);
  });

  it("keeps the best few photos of a model, each picture once", () => {
    const hits = Array.from({ length: PHOTOS_PER_RESULT + 2 }, (_unused, index) => hit(1, index, index / 10));
    expect(rankPhotoHits(hits)[0]?.photos.map((photo) => photo.photoId)).toEqual([0, 1, 2]);
    // The same picture under three URLs of the model
    const copies = [hit(1, 1, 0.1, "same"), hit(1, 2, 0.1, "same"), hit(1, 3, 0.1, "same"), hit(1, 4, 0.3)];
    expect(rankPhotoHits(copies)[0]?.photos.map((photo) => photo.photoId)).toEqual([1, 4]);
  });
});

describe("rankTextHits", () => {
  it("ranks models by distance", () => {
    expect(rankTextHits([{ modelId: 5, distance: 0.5 }, { modelId: 4, distance: 0.25 }])).toEqual([
      { modelId: 4, rank: 1, similarity: 0.75, photos: [] },
      { modelId: 5, rank: 2, similarity: 0.5, photos: [] },
    ]);
  });
});

describe("interleave", () => {
  const ranking = (...modelIds: number[]) => modelIds.map((modelId) => ({ modelId, score: 0.01, lists: {}, photos: [] }));
  const ids = (models: { modelId: number }[]) => models.map((model) => model.modelId);

  it("takes the rankings in turn, so a product is not pushed out by another", () => {
    expect(ids(interleave([ranking(1, 2, 3), ranking(4, 5)], 24))).toEqual([1, 4, 2, 5, 3]);
  });

  it("keeps a model once, at its best place, and stays within the limit", () => {
    expect(ids(interleave([ranking(1, 2), ranking(2, 3)], 24))).toEqual([1, 2, 3]);
    expect(ids(interleave([ranking(1, 2), ranking(3, 4)], 3))).toEqual([1, 3, 2]);
  });

  it("leaves one ranking as it is", () => {
    expect(ids(interleave([ranking(3, 1, 2)], 24))).toEqual([3, 1, 2]);
    expect(interleave([[]], 24)).toEqual([]);
  });

  it("names the product that gave a model its place: its best one, the earlier of two equal ones", () => {
    const products = (rankings: ReturnType<typeof ranking>[]) => interleave(rankings, 24).map((model) => [model.modelId, model.productIndex]);
    expect(products([ranking(1), ranking(2)])).toEqual([[1, 0], [2, 1]]);
    expect(products([ranking(1, 2), ranking(2, 3)])).toEqual([[1, 0], [2, 1], [3, 1]]);
    expect(products([ranking(1), ranking(1)])).toEqual([[1, 0]]);
  });
});

describe("fuseLists", () => {
  const entry = (modelId: number, rank: number, similarity = 0.5, photoIds: number[] = []) =>
    ({ modelId, rank, similarity, photos: photoIds.map((photoId) => ({ photoId, imageSha256: `sha${photoId}`, similarity })) });

  it("sums 1 / (k + rank) over the lists a model is in", () => {
    const fused = fuseLists({
      "image-photo": [entry(1, 1), entry(2, 2)],
      "text-text": [entry(2, 1), entry(3, 2)],
    }, 10);
    expect(fused.map((model) => model.modelId)).toEqual([2, 1, 3]);
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 6);
    expect(fused[0]?.lists).toEqual({ "image-photo": { rank: 2, similarity: 0.5 }, "text-text": { rank: 1, similarity: 0.5 } });
  });

  it("breaks a tie by the best rank, not by similarities of different lists, then by tieOrder", () => {
    const fused = fuseLists({
      "image-photo": [entry(9, 1, 0.95)],
      "text-text": [entry(6, 1, 0.4)],
      "text-photo": [entry(5, 2, 0.9), entry(4, 2, 0.9)],
    }, 10);
    const byTie = (ids: number[]) => ids.toSorted((left, right) => tieOrder(left) - tieOrder(right));
    // 9 and 6 tie at rank 1, whatever their similarities; 4 and 5 tie at rank 2
    expect(fused.map((model) => model.modelId)).toEqual([...byTie([6, 9]), ...byTie([4, 5])]);
  });

  it("does not hand ties to the lower ids, which are the source imported first", () => {
    const ids = (from: number) => Array.from({ length: 500 }, (_, index) => from + index);
    const pairs = ids(1).flatMap((earlier) => ids(3001).map((later) => [earlier, later] as const));
    const wonByEarlier = pairs.filter(([earlier, later]) => tieOrder(earlier) < tieOrder(later)).length;
    expect(wonByEarlier / pairs.length).toBeGreaterThan(0.45);
    expect(wonByEarlier / pairs.length).toBeLessThan(0.55);
  });

  it("returns the limit, with matched photos of the reference photo first and each picture once", () => {
    const fused = fuseLists({
      "image-photo": [entry(1, 1, 0.9, [10, 11])],
      "text-photo": [entry(1, 1, 0.7, [11, 12, 13]), entry(2, 2)],
    }, 1);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.photos.map((photo) => photo.photoId)).toEqual([10, 11, 12]);
  });
});

describe("liftModels", () => {
  const fused = (modelId: number, score: number) => ({ modelId, score, lists: { "image-photo": { rank: modelId, similarity: 0.5 } }, photos: [] });

  it("multiplies the scores of the given models and sorts again", () => {
    const lifted = liftModels([fused(1, 0.03), fused(2, 0.025), fused(3, 0.02)], new Set([3]), 2);
    expect(lifted.map((model) => [model.modelId, model.score])).toEqual([[3, 0.04], [1, 0.03], [2, 0.025]]);
  });

  it("leaves the order at a factor of 1", () => {
    const lifted = liftModels([fused(1, 0.03), fused(2, 0.025)], new Set([2]), 1);
    expect(lifted.map((model) => model.modelId)).toEqual([1, 2]);
  });
});

describe("addVotes", () => {
  const fused = (modelId: number, score: number) => ({ modelId, score, lists: { "text-text": { rank: modelId, similarity: 0.5 } }, photos: [] });
  const entry = (modelId: number, rank: number) => ({ modelId, rank, similarity: 0.5, photos: [] });
  const scoreOf = (rank: number, weight = 1) => Number((weight / (RRF_K + rank)).toFixed(6));

  it("adds a vote per list a model stands in, by its rank there and the weight", () => {
    const voted = addVotes([fused(1, 0.03), fused(2, 0.02)], [[entry(2, 1)], [entry(2, 2)]], 0.5);
    expect(voted[0]?.modelId).toBe(2);
    expect(voted[0]?.score).toBeCloseTo(0.02 + scoreOf(1, 0.5) + scoreOf(2, 0.5), 5);
  });

  it("brings in a model only the votes found, after one with the same score that a list ranked", () => {
    const voted = addVotes([fused(1, scoreOf(1))], [[entry(9, 1)]], 1);
    expect(voted.map((model) => [model.modelId, model.score, model.lists])).toEqual([
      [1, scoreOf(1), { "text-text": { rank: 1, similarity: 0.5 } }], [9, scoreOf(1), {}],
    ]);
  });

  it("drops nothing and leaves the given ranking as it was", () => {
    const given = [fused(1, 0.03), fused(2, 0.02)];
    expect(addVotes(given, [[entry(2, 1)]], 1).map((model) => model.modelId)).toEqual([2, 1]);
    expect(addVotes(given, [], 1).map((model) => model.modelId)).toEqual([1, 2]);
    expect(given.map((model) => model.score)).toEqual([0.03, 0.02]);
  });

  it("takes the matched photos of a voted model, each picture once", () => {
    const photo = { photoId: 5, imageSha256: "a", similarity: 0.7 };
    const voted = addVotes([], [[{ ...entry(3, 1), photos: [photo] }], [{ ...entry(3, 1), photos: [photo] }]], 1);
    expect(voted[0]?.photos).toEqual([photo]);
  });
});

describe("hasCloseText", () => {
  const model = "gemini-embedding-2/1536";
  const near = (similarity: number) => [{ modelId: 1, score: 1, lists: { "text-text": { rank: 1, similarity } }, photos: [] }];

  it("says whether the nearest model text of any product reaches the bound", () => {
    expect(hasCloseText(model, [near(0.65)], true)).toBe(false);
    expect(hasCloseText(model, [near(0.65), near(0.7)], true)).toBe(true);
  });

  it("says nothing of a search a photo or a code stands behind, or with no text list", () => {
    expect(hasCloseText(model, [near(0.65)], false)).toBeNull();
    expect(hasCloseText(model, [[{ modelId: 1, score: 1, lists: {}, photos: [] }]], true)).toBeNull();
  });

  it("says nothing for a model whose scale was not measured", () => {
    expect(hasCloseText("voyage-multimodal-3.5/1024", [near(0.65)], true)).toBeNull();
  });
});
