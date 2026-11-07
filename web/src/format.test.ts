import { describe, expect, it } from "vitest";
import type { Grade, ResultVariant, SearchResult } from "./api";
import {
  amountOf, apiFilters, askedMatches, countChoices, factChoices, formatDate, gradeBody, isFactApplied, linksByModel,
  parseMinStock, photoSrc, sharedCategoryIndex, variantSummary, withGrade, withoutFact,
} from "./format";

function variant(overrides: Partial<ResultVariant>): ResultVariant {
  return { sku: "S1", color: null, size: null, inStock: null, nextArrival: null, price: null, ...overrides };
}

describe("countChoices", () => {
  it("offers the counts below what was found, and all of it", () => {
    expect(countChoices(100)).toEqual([12, 24, 48, 100]);
    expect(countChoices(30)).toEqual([12, 24, 30]);
    expect(countChoices(24)).toEqual([12, 24]);
  });

  it("leaves one choice when the fewest would show it all", () => {
    expect(countChoices(12)).toEqual([12]);
    expect(countChoices(0)).toEqual([0]);
  });
});

describe("variantSummary", () => {
  it("sums the known stock, keeps each colour once and spans the prices per currency", () => {
    const summary = variantSummary([
      variant({ sku: "A", color: "red", inStock: 10, price: { amount: "1.2000", currency: "PLN" } }),
      variant({ sku: "B", color: "blue", inStock: null, price: { amount: "0.9500", currency: "PLN" } }),
      variant({ sku: "C", color: "red", inStock: 5, price: { amount: "2.0000", currency: "EUR" } }),
    ]);
    expect(summary).toEqual({
      count: 3,
      colors: ["red", "blue"],
      stock: 15,
      hasUnknownStock: true,
      prices: [{ currency: "PLN", min: 0.95, max: 1.2 }, { currency: "EUR", min: 2, max: 2 }],
    });
  });

  it("gives no stock rather than 0 when no variant has one, and skips a price that is not a number", () => {
    const summary = variantSummary([
      variant({ price: { amount: "n/a", currency: "PLN" } }), variant({ sku: "S2", price: { amount: "", currency: "PLN" } }),
    ]);
    expect(summary.stock).toBeNull();
    expect(summary.hasUnknownStock).toBe(false);
    expect(summary.prices).toEqual([]);
  });

  it("counts a stock of 0 as known", () => {
    expect(variantSummary([variant({ inStock: 0 })])).toMatchObject({ stock: 0, hasUnknownStock: false });
  });
});

describe("amountOf", () => {
  it("reads the server's decimals and nothing else", () => {
    expect(amountOf("12.3400")).toBe(12.34);
    expect(amountOf("7")).toBe(7);
    for (const text of ["", " ", "1e3", "12,5", "n/a"]) expect(amountOf(text)).toBeNull();
  });
});

describe("parseMinStock", () => {
  it("reads empty as no filter and a whole number in the API's bounds as the filter", () => {
    expect(parseMinStock("  ")).toBeUndefined();
    expect(parseMinStock(" 500 ")).toBe(500);
    expect(parseMinStock("10000000")).toBe(10_000_000);
  });

  it("refuses what the API would refuse", () => {
    for (const value of ["0", "-5", "1.5", "1e3", "abc", "10000001"]) expect(parseMinStock(value)).toBe("invalid");
  });
});

describe("factChoices", () => {
  const none = { volumeMl: null, materials: [], sizeCm: null };

  it("gives one filter per condition, without a bound not asked for", () => {
    expect(factChoices({ volumeMl: { min: 800, max: null }, materials: ["plastic"], sizeCm: { min: [35, 35], max: [] } })).toEqual([
      { volumeMl: { min: 800 } }, { materials: ["plastic"] }, { sizeCm: { min: [35, 35] } },
    ]);
    expect(factChoices(none)).toEqual([]);
  });

  it("gives a number said exactly the room catalogues need", () => {
    expect(factChoices({ ...none, volumeMl: { min: 500, max: 500 } })).toEqual([{ volumeMl: { min: 450, max: 550 } }]);
    expect(factChoices({ ...none, sizeCm: { min: [20], max: [20] } })).toEqual([{ sizeCm: { min: [16], max: [24] } }]);
  });

  it("keeps a range as it is", () => {
    expect(factChoices({ ...none, volumeMl: { min: 300, max: 350 } })).toEqual([{ volumeMl: { min: 300, max: 350 } }]);
  });
});

describe("askedMatches", () => {
  it("keeps the conditions the query asks, in one order on every card", () => {
    const none = { volumeMl: null, materials: null, sizeCm: null, printTechniques: null, sheets: null, gsm: null };
    expect(askedMatches({ ...none, sizeCm: "unknown", volumeMl: "fits", materials: "against" })).toEqual([
      { key: "volumeMl", value: "fits" }, { key: "materials", value: "against" }, { key: "sizeCm", value: "unknown" },
    ]);
    expect(askedMatches({ ...none, materials: "fits" })).toEqual([{ key: "materials", value: "fits" }]);
    expect(askedMatches({ ...none, gsm: "unknown", printTechniques: "fits", sheets: "against" })).toEqual([
      { key: "printTechniques", value: "fits" }, { key: "sheets", value: "against" }, { key: "gsm", value: "unknown" },
    ]);
  });
});

describe("fact filters on the form", () => {
  it("knows an applied choice and takes one off", () => {
    const facts = { volumeMl: { min: 800 }, materials: ["plastic"] };
    expect(isFactApplied(facts, { materials: ["plastic"] })).toBe(true);
    expect(isFactApplied(facts, { materials: ["glass"] })).toBe(false);
    expect(isFactApplied({}, { materials: ["plastic"] })).toBe(false);
    expect(withoutFact(facts, "materials")).toEqual({ volumeMl: { min: 800 } });
  });

  it("sends them with the other filters", () => {
    expect(apiFilters({ sources: [], supplierCategories: [], sharedCategories: [], minStock: "", model: "m", facts: { materials: ["glass"] }, isConditionPass: false }, undefined))
      .toEqual({ materials: ["glass"] });
  });
});

describe("apiFilters", () => {
  it("leaves out the filters not set, since the API refuses an empty list", () => {
    expect(apiFilters({ sources: [], supplierCategories: [], sharedCategories: [], minStock: "", model: "m", facts: {}, isConditionPass: false }, undefined)).toEqual({});
  });

  it("passes the filters that are set", () => {
    expect(apiFilters({ sources: ["axpol"], supplierCategories: [], sharedCategories: ["drinkware.mugs"], minStock: "5", model: "m", facts: {}, isConditionPass: false }, 5))
      .toEqual({ sources: ["axpol"], sharedCategories: ["drinkware.mugs"], minStock: 5 });
  });
});

describe("sharedCategoryIndex", () => {
  it("gives groups and their categories by code, with their names and models", () => {
    const index = sharedCategoryIndex([{
      code: "drinkware", name: { uk: "Посуд", en: "Drinkware" }, models: 3,
      categories: [{ code: "drinkware.mugs", name: { uk: "Кухлі", en: "Mugs" }, models: 3 }],
    }]);
    expect(index.get("drinkware")).toEqual({ name: "Посуд", models: 3 });
    expect(index.get("drinkware.mugs")).toEqual({ name: "Кухлі", models: 3 });
  });
});

describe("gradeBody", () => {
  const result = {
    rank: 3, confidence: { percent: 70, level: "medium" }, lists: { "text-text": { rank: 2, similarity: 0.7 } },
    conditionMatch: null, matchedCode: null,
  } as unknown as SearchResult;
  const search = { text: "пляшка", hasPhoto: false, model: "m", filters: { minStock: 10 } };

  it("carries what the search said of the model", () => {
    expect(gradeBody("exact", search, result)).toEqual({
      grade: "exact", text: "пляшка", hasPhoto: false, model: "m", filters: { minStock: 10 }, rank: 3, confidencePercent: 70,
      lists: { "text-text": { rank: 2, similarity: 0.7 } }, conditionMatch: null, matchedCode: null,
    });
  });

  it("leaves the text out of a search by photo alone", () => {
    expect(gradeBody("wrong", { ...search, text: "", hasPhoto: true }, result)).not.toHaveProperty("text");
  });

  it("sends no percent when none was measured", () => {
    expect(gradeBody("wrong", search, { ...result, confidence: null }).confidencePercent).toBeNull();
  });
});

describe("withGrade", () => {
  it("sets, replaces and takes back a grade without touching the map it got", () => {
    const first: ReadonlyMap<number, Grade> = new Map([[1, "exact"]]);
    expect(withGrade(first, 2, "wrong")).toEqual(new Map([[1, "exact"], [2, "wrong"]]));
    expect(withGrade(first, 1, "suitable")).toEqual(new Map([[1, "suitable"]]));
    expect(withGrade(first, 1, null)).toEqual(new Map());
    expect(first).toEqual(new Map([[1, "exact"]]));
  });
});

describe("linksByModel", () => {
  it("keeps the links of a model together, in the order they came", () => {
    const first = { modelId: 7, ownProductId: 1, ownProductName: "A", type: "same" } as const;
    const second = { modelId: 7, ownProductId: 2, ownProductName: "B", type: "analog" } as const;
    const other = { modelId: 9, ownProductId: 1, ownProductName: "A", type: "same" } as const;
    const byModel = linksByModel([first, other, second]);
    expect(byModel.get(7)).toEqual([first, second]);
    expect(byModel.get(9)).toEqual([other]);
    expect(byModel.get(1)).toBeUndefined();
  });
});

describe("formatDate", () => {
  it("turns a bare ISO date around without a time zone and leaves anything else as it is", () => {
    expect(formatDate("2026-11-05")).toBe("05.11.2026");
    expect(formatDate("soon")).toBe("soon");
  });
});

describe("photoSrc", () => {
  it("passes Makito's photos and the archive photos of Macma through the server and leaves the others as they are", () => {
    expect(photoSrc("https://data.promotray.de/database_macma/jpg_database_macma.zip/1261803.jpg"))
      .toBe("/api/photos/promotray/database_macma/jpg_database_macma.zip/1261803.jpg");
    expect(photoSrc("https://apis.makito.es/catalog/assets/15246/15246003000/principal/5246-003-P.jpg"))
      .toBe("/api/photos/makito/15246/15246003000/principal/5246-003-P.jpg");
    expect(photoSrc("https://cdn.axpol.test/p1.jpg")).toBe("https://cdn.axpol.test/p1.jpg");
    expect(photoSrc("https://apis.makito.es/orders/x")).toBe("https://apis.makito.es/orders/x");
  });
});
