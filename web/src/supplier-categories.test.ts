import { describe, expect, it } from "vitest";
import type { CategoryOption } from "./api";
import { apiFilters, type FilterState } from "./format";
import { pathKey, supplierCategoriesOf, supplierCategoryTree, withSources } from "./supplier-categories";

function form(overrides: Partial<FilterState> = {}): FilterState {
  return {
    sources: [], supplierCategories: [], sharedCategories: [], minStock: "", model: "m", facts: {}, isConditionPass: false,
    ...overrides,
  };
}

const OPTIONS: CategoryOption[] = [
  { source: "makito", path: ["Writing", "Pens", "Metal pens"], models: 40 },
  { source: "makito", path: ["Writing", "Pens", "Ballpens"], models: 60 },
  { source: "makito", path: ["Writing"], models: 2 },
  { source: "makito", path: ["Bags", "Backpacks"], models: 30 },
  { source: "axpol", path: ["WRITING", "pens"], models: 500 },
];

describe("supplierCategoryTree", () => {
  it("nests one supplier's paths, each node counting the models under it", () => {
    expect(supplierCategoryTree(OPTIONS, "makito")).toEqual([
      { path: ["Bags"], depth: 0, models: 30 },
      { path: ["Bags", "Backpacks"], depth: 1, models: 30 },
      { path: ["Writing"], depth: 0, models: 102 },
      { path: ["Writing", "Pens"], depth: 1, models: 100 },
      { path: ["Writing", "Pens", "Ballpens"], depth: 2, models: 60 },
      { path: ["Writing", "Pens", "Metal pens"], depth: 2, models: 40 },
    ]);
  });

  it("orders names as a person reads them, not by code point", () => {
    const nodes = supplierCategoryTree([
      { source: "x", path: ["bags"], models: 1 }, { source: "x", path: ["Umbrellas"], models: 1 },
      { source: "x", path: ["Item 10"], models: 1 }, { source: "x", path: ["Item 9"], models: 1 },
    ], "x");
    expect(nodes.map((node) => node.path[0])).toEqual(["bags", "Item 9", "Item 10", "Umbrellas"]);
  });

  it("has no node past the API's depth and none for a supplier without paths", () => {
    const deep = supplierCategoryTree([{ source: "x", path: ["a", "b", "c", "d", "e", "f"], models: 1 }], "x");
    expect(deep.at(-1)?.path).toEqual(["a", "b", "c", "d", "e"]);
    expect(supplierCategoryTree(OPTIONS, "macma")).toEqual([]);
  });
});

describe("supplierCategoriesOf", () => {
  const chosen = [{ source: "makito", path: ["Bags"] }];

  it("filters by the nodes of the one supplier chosen", () => {
    expect(supplierCategoriesOf(form({ sources: ["makito"], supplierCategories: chosen }))).toEqual(chosen);
  });

  it("sends none beside another supplier, or for a supplier no longer chosen", () => {
    expect(supplierCategoriesOf(form({ sources: ["makito", "axpol"], supplierCategories: chosen }))).toEqual([]);
    expect(supplierCategoriesOf(form({ sources: ["axpol"], supplierCategories: chosen }))).toEqual([]);
    expect(supplierCategoriesOf(form({ sources: [], supplierCategories: chosen }))).toEqual([]);
  });
});

describe("withSources", () => {
  const chosen = [{ source: "makito", path: ["Bags"] }];

  it("keeps the nodes while their supplier stays the one chosen", () => {
    expect(withSources(form({ sources: ["makito"], supplierCategories: chosen }), ["makito"]).supplierCategories).toEqual(chosen);
  });

  it("drops them once another supplier is added or theirs is taken off", () => {
    const current = form({ sources: ["makito"], supplierCategories: chosen });
    expect(withSources(current, ["makito", "axpol"])).toEqual(form({ sources: ["makito", "axpol"] }));
    expect(withSources(current, [])).toEqual(form());
  });
});

describe("apiFilters with a supplier's categories", () => {
  it("sends them beside the shared ones", () => {
    const filters = apiFilters(form({
      sources: ["makito"], supplierCategories: [{ source: "makito", path: ["Writing", "Pens"] }], sharedCategories: ["writing"],
    }), undefined);
    expect(filters).toEqual({
      sources: ["makito"], categories: [{ source: "makito", path: ["Writing", "Pens"] }], sharedCategories: ["writing"],
    });
  });
});

describe("pathKey", () => {
  it("tells apart paths whose names hold the separator", () => {
    expect(pathKey(["A > B"])).not.toBe(pathKey(["A", "B"]));
  });
});
