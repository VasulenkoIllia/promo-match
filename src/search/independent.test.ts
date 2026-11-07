import { describe, expect, it, vi } from "vitest";
import { byHash, type Catalog, categoryShares, type IndependentCase, splitEvenly, summarizeIndependent } from "./independent.js";

// config.ts reads DATABASE_URL on import; the numbers need none of it
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, required: () => "" }));

const catalog: Catalog = new Map([
  [1, { source: "a", category: "mugs", photoVectors: 2 }],
  [2, { source: "a", category: "mugs", photoVectors: 40 }],
  [3, { source: "a", category: "mugs", photoVectors: 2 }],
  [4, { source: "b", category: "mugs", photoVectors: 2 }],
  [5, { source: "b", category: "bags", photoVectors: 5 }],
]);

function textCase(modelId: number, source: string): IndependentCase {
  return { id: `text-${modelId}`, kind: "text", modelId, source, category: "mugs", text: "a mug" };
}

const categoryCase: IndependentCase = {
  id: "category-mugs", kind: "category", modelId: null, source: null, category: "mugs", text: "Mugs",
};

describe("categoryShares", () => {
  it("gives each source its share of a category's models", () => {
    expect(categoryShares(catalog).get("mugs")).toEqual(new Map([["a", 0.75], ["b", 0.25]]));
  });

  it("leaves out a model with no category", () => {
    const shares = categoryShares(new Map([[1, { source: "a", category: null, photoVectors: 1 }]]));
    expect(shares.size).toBe(0);
  });
});

describe("summarizeIndependent", () => {
  it("counts a known item per source, at one and in the top ten", () => {
    const { knownItem } = summarizeIndependent([
      { kase: textCase(1, "a"), modelIds: [1, 2, 4] },
      { kase: textCase(2, "a"), modelIds: [1, 2, 4] },
      { kase: textCase(4, "b"), modelIds: [1, 2, 3] },
    ], catalog);
    expect(knownItem.text?.a).toMatchObject({ cases: 2, atOne: 1, atK: 2, reciprocalRank: 0.75 });
    expect(knownItem.text?.b).toMatchObject({ cases: 1, atOne: 0, atK: 0, reciprocalRank: 0 });
  });

  it("counts a visual case apart from a text case", () => {
    const { knownItem } = summarizeIndependent([
      { kase: textCase(1, "a"), modelIds: [1] }, { kase: { ...textCase(4, "b"), kind: "visual" }, modelIds: [4] },
    ], catalog);
    expect(knownItem.visual?.b).toMatchObject({ cases: 1, atOne: 1 });
    expect(knownItem.text?.b).toMatchObject({ cases: 0 });
  });

  it("measures the own source among the other results against the category's share", () => {
    const { knownItem } = summarizeIndependent([{ kase: textCase(1, "a"), modelIds: [1, 2, 4] }], catalog);
    expect(knownItem.text?.a).toMatchObject({ ownSource: 0.5, expectedOwnSource: 0.75 });
  });

  it("compares a source's share of the results with its share of the category", () => {
    const { exposure, categoryPrecision } = summarizeIndependent([{ kase: categoryCase, modelIds: [1, 4, 5, 2] }], catalog);
    expect(exposure.a).toEqual({ shown: 0.5, expected: 0.75 });
    expect(exposure.b).toEqual({ shown: 0.5, expected: 0.25 });
    expect(categoryPrecision).toBe(0.75);
  });

  it("shows whether models with more vectors are shown more", () => {
    const { vectorBuckets } = summarizeIndependent([{ kase: categoryCase, modelIds: [2, 2, 1, 5] }], catalog);
    expect(vectorBuckets["31+"]).toEqual({ shown: 0.5, expected: 0.2 });
    expect(vectorBuckets["1-3"]).toEqual({ shown: 0.25, expected: 0.6 });
  });

  it("keeps a failed search out of every number", () => {
    const summary = summarizeIndependent([
      { kase: textCase(1, "a"), modelIds: null }, { kase: textCase(2, "a"), modelIds: [2] },
    ], catalog);
    expect(summary.failed).toBe(1);
    expect(summary.knownItem.text?.a?.cases).toBe(1);
  });
});

describe("splitEvenly", () => {
  it("cuts every source to the shortest one's number, the first to dev, the rest to final", () => {
    const sets = splitEvenly(new Map([["a", [1, 2, 3, 4]], ["b", [5, 6, 7]], ["c", [8, 9, 10, 11, 12]]]), 2);
    expect(sets).toEqual({ dev: [1, 2, 5, 6, 8, 9], final: [3, 7, 10] });
  });

  it("leaves final empty when the shortest source fills only dev", () => {
    expect(splitEvenly(new Map([["a", [1, 2, 3]], ["b", [4]]]), 2)).toEqual({ dev: [1, 4], final: [] });
  });

  it("gives every set nothing when a source drew nothing", () => {
    expect(splitEvenly(new Map([["a", [1, 2]], ["b", []]]), 1)).toEqual({ dev: [], final: [] });
  });
});

describe("byHash", () => {
  it("orders by the hash, not by the items", () => {
    expect(byHash([1, 2, 3], (item) => ({ 1: "b", 2: "c", 3: "a" })[item] ?? "")).toEqual([3, 1, 2]);
  });
});
