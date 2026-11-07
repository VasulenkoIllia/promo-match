import { describe, expect, it } from "vitest";
import { InputRejected, ProviderError } from "./api.js";
import { addUsage, batchesOf, Budget, BudgetReached, embedSplitting, mapSettled } from "./batch.js";

describe("Budget", () => {
  it("counts each call before it is made and refuses the one that would pass the limit", () => {
    const budget = new Budget(1);
    budget.reserve(0.6);
    budget.reserve(0.4);
    expect(() => budget.reserve(0.01)).toThrow(BudgetReached);
    expect(budget.spentUsd).toBeCloseTo(1, 10);
  });

  it("never takes a broken price, which would switch the limit off", () => {
    const budget = new Budget(1);
    expect(() => budget.reserve(Number.NaN)).toThrow("priced at NaN");
    expect(() => budget.reserve(-1)).toThrow();
    expect(budget.spentUsd).toBe(0);
  });
});

describe("batchesOf", () => {
  it("cuts by count and by bytes, an item over the byte limit goes alone", () => {
    const sizes = [4, 4, 4, 4, 4, 20, 1];
    expect(batchesOf(sizes, 3, 10, (size) => size)).toEqual([[4, 4], [4, 4], [4], [20], [1]]);
    expect(batchesOf(sizes, 2, 100, (size) => size)).toEqual([[4, 4], [4, 4], [4, 20], [1]]);
    expect(batchesOf([], 2, 100, (size: number) => size)).toEqual([]);
  });
});

describe("mapSettled", () => {
  it("keeps the order, runs at most the limit at once and starts nothing after a failure", async () => {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const results = await mapSettled([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, item === 3 ? 1 : 5));
      running -= 1;
      if (item === 3) throw new Error("third");
      return item * 10;
    });
    expect(most).toBe(2);
    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[2]?.status).toBe("rejected");
    // 4 was under way when 3 failed and still finished; nothing later started
    expect(started).toEqual([1, 2, 3, 4]);
    expect(results.slice(4)).toEqual([undefined, undefined]);
  });
});

describe("embedSplitting", () => {
  const embed = (bad: Set<string>, calls: string[][]) => (batch: string[]) => {
    calls.push(batch);
    if (batch.some((item) => bad.has(item))) return Promise.reject(new InputRejected(`HTTP 400: ${[...bad].join()}`));
    return Promise.resolve(batch.map((item) => [item.length]));
  };

  it("sends a refused batch again item by item and marks only the refused item", async () => {
    const calls: string[][] = [];
    const result = await embedSplitting(["a", "bb", "ccc"], embed(new Set(["bb"]), calls));
    expect(calls).toEqual([["a", "bb", "ccc"], ["a"], ["bb"], ["ccc"]]);
    expect([...result.vectors]).toEqual([["a", [1]], ["ccc", [3]]]);
    expect([...result.rejected.keys()]).toEqual(["bb"]);
    expect(result.failure).toBeUndefined();
  });

  it("takes a batch whose every item is refused alone for a request at fault and marks none", async () => {
    // Google answers a bad key with 400, as it answers a broken image
    const result = await embedSplitting(["a", "b"], () => Promise.reject(new InputRejected("HTTP 400: API key not valid")));
    expect(result.rejected.size).toBe(0);
    expect(result.failure).toBeInstanceOf(ProviderError);
    expect(result.failure?.message).toContain("API key not valid");
  });

  it("returns any other error with the vectors already paid for", async () => {
    const calls: string[][] = [];
    const result = await embedSplitting(["a", "bb", "ccc"], (batch) => {
      calls.push(batch);
      if (batch.length > 1) return Promise.reject(new InputRejected("HTTP 400"));
      if (batch[0] === "bb") return Promise.reject(new BudgetReached("budget reached"));
      return Promise.resolve([[batch[0]?.length ?? 0]]);
    });
    expect(calls).toEqual([["a", "bb", "ccc"], ["a"], ["bb"]]);
    expect([...result.vectors]).toEqual([["a", [1]]]);
    expect(result.failure).toBeInstanceOf(BudgetReached);
  });

  it("returns a failure of the first call as it is, and catches a provider giving fewer vectors", async () => {
    const denied = await embedSplitting(["a", "b"], () => Promise.reject(new ProviderError("HTTP 401")));
    expect(denied.failure).toBeInstanceOf(ProviderError);
    expect(denied.vectors.size).toBe(0);
    const short = await embedSplitting(["a", "b"], () => Promise.resolve([[1]]));
    expect(short.failure?.message).toBe("1 vectors for 2 inputs");
  });
});

describe("addUsage", () => {
  it("sums the provider's numbers by name", () => {
    const total: Record<string, number> = { text_tokens: 5 };
    addUsage(total, { text_tokens: 2, image_pixels: 100 });
    expect(total).toEqual({ text_tokens: 7, image_pixels: 100 });
  });
});
