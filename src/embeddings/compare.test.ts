import { describe, expect, it } from "vitest";
import { cosine, firstHitRank, retrievalMetrics } from "./compare.js";

describe("cosine", () => {
  it("is 1 for the same direction, 0 for a right angle and for a zero vector", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("retrievalMetrics", () => {
  const docs = [
    { id: "p1", key: "MUG", vector: [1, 0] },
    { id: "p2", key: "MUG", vector: [0.9, 0.1] },
    { id: "p3", key: "PEN", vector: [0, 1] },
  ];

  it("never counts the query's own photo", () => {
    expect(firstHitRank({ selfId: "p1", key: "MUG", vector: [1, 0] }, docs)).toBe(1);
    expect(firstHitRank({ selfId: "p1", key: "MUG", vector: [0, 1] }, docs)).toBe(2);
    expect(firstHitRank({ key: "BAG", vector: [1, 0] }, docs)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives recall at 1, 5 and 10 and the mean reciprocal rank", () => {
    const metrics = retrievalMetrics([
      { key: "MUG", vector: [1, 0] },
      { key: "PEN", vector: [1, 0] },
    ], docs);
    expect(metrics.queries).toBe(2);
    expect(metrics.recall).toEqual({ "@1": 0.5, "@5": 1, "@10": 1 });
    expect(metrics.mrr).toBeCloseTo((1 + 1 / 3) / 2, 3);
    expect(metrics.worst[0]).toEqual({ key: "PEN", rank: 3 });
  });
});
