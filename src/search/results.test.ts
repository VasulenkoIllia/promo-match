import { describe, expect, it } from "vitest";
import { assembleResults } from "./results.js";
import type { ModelRow, VariantRow } from "./store.js";

const model = (id: number, coverPhotoUrl: string | null = null): ModelRow => ({
  id, sourceCode: "axpol", sourceName: "Axpol", code: `M${id}`, name: `Mug ${id}`, category: ["DRINKWARE", "mugs"],
  coverPhotoUrl,
});

const against = { volumeMl: "against", materials: null, sizeCm: null, printTechniques: null, sheets: null, gsm: null } as const;

const query = { model: "gemini-embedding-2/1536", isRead: true, isByText: true, isLong: false, hasCloseMatch: true } as const;

const variant: VariantRow = {
  modelId: 1, sku: "M1-05", externalId: null, color: "red", size: null, inStock: 120, nextArrivalDate: "2026-11-10",
  nextArrivalQuantity: 500, price: "2.5000", currency: "PLN",
};

describe("assembleResults", () => {
  it("joins the fused models with their details, in the fused order", () => {
    const results = assembleResults(
      [
        { modelId: 2, score: 0.03, lists: { "text-text": { rank: 1, similarity: 0.8 } }, photos: [] },
        { modelId: 1, score: 0.02, lists: { "image-photo": { rank: 1, similarity: 0.9 } }, photos: [{ photoId: 10, imageSha256: "sha10", similarity: 0.9 }] },
      ],
      [model(1, "https://cdn.test/m1.jpg"), model(2, "https://cdn.test/m2.jpg")],
      [variant, { ...variant, sku: "M1-02", inStock: null, nextArrivalDate: null, nextArrivalQuantity: null, price: null, currency: null }],
      [{ id: 10, url: "https://cdn.test/p10.jpg", urlLarge: null, skus: ["M1-05"] }],
      new Map([[1, against]]),
      query,
    );
    expect(results.map((result) => [result.rank, result.modelId])).toEqual([[1, 2], [2, 1]]);
    expect(results.map((result) => result.conditionMatch)).toEqual([null, against]);
    expect(results.map((result) => result.confidence)).toEqual([{ percent: 90, level: "high" }, { percent: 25, level: "low" }]);
    // Found by its text only: the cover stands in for a matched photo
    expect(results[0]?.photos).toEqual([{ id: null, url: "https://cdn.test/m2.jpg", urlLarge: null, similarity: null, skus: [] }]);
    expect(results[0]?.variants).toEqual([]);
    expect(results[1]?.photos).toEqual([{ id: 10, url: "https://cdn.test/p10.jpg", urlLarge: null, similarity: 0.9, skus: ["M1-05"] }]);
    expect(results[1]?.variants).toEqual([
      { sku: "M1-05", color: "red", size: null, inStock: 120, nextArrival: { date: "2026-11-10", quantity: 500 },
        price: { amount: "2.5000", currency: "PLN" } },
      { sku: "M1-02", color: "red", size: null, inStock: null, nextArrival: null, price: null },
    ]);
    expect(results[1]?.category).toEqual(["DRINKWARE", "mugs"]);
  });

  it("leaves out a model that is gone by the time of the details, and ranks the rest on", () => {
    const results = assembleResults(
      [{ modelId: 3, score: 0.03, lists: {}, photos: [] }, { modelId: 1, score: 0.02, lists: {}, photos: [] }],
      [model(1)], [], [], new Map(), query,
    );
    expect(results.map((result) => [result.rank, result.modelId, result.photos])).toEqual([[1, 1, []]]);
  });

  describe("the model's page on the supplier's site", () => {
    const runOut = { ...variant, sku: "M1-02", inStock: 0 };
    const pageOf = (rows: VariantRow[], matchedCode?: string) => assembleResults(
      [{ modelId: 1, score: 0.02, lists: {}, photos: [], ...(matchedCode ? { matchedCode } : {}) }],
      [model(1)], rows, [], new Map(), query,
    )[0]?.pageUrl;

    it("is the page of a variant in stock, past one that ran out", () => {
      expect(pageOf([runOut, variant])).toBe("https://axpol.com/pl/search/m1-05.html");
    });

    it("is the page of the variant a code named, in stock or not", () => {
      expect(pageOf([runOut, variant], "m1-02")).toBe("https://axpol.com/pl/search/m1-02.html");
    });

    it("is the first variant's when none is in stock, and none without variants", () => {
      expect(pageOf([runOut])).toBe("https://axpol.com/pl/search/m1-02.html");
      expect(pageOf([])).toBeNull();
    });
  });
});
