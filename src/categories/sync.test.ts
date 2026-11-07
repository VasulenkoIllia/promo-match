import { describe, expect, it, vi } from "vitest";
import { massRemoval, planLines, planSync, type SyncState } from "./sync.js";
import type { Taxonomy } from "./taxonomy.js";

// config.ts reads DATABASE_URL on import; the plan needs none of it
vi.mock("../config.js", () => ({ ConfigError: class extends Error {}, config: {}, required: () => "" }));

const taxonomy: Taxonomy = {
  entries: [
    { code: "drinkware", parent: null, name: { uk: "Посуд для напоїв", en: "Drinkware" }, position: 0 },
    { code: "drinkware.mugs", parent: "drinkware", name: { uk: "Кружки", en: "Mugs" }, position: 0 },
    { code: "drinkware.bottles", parent: "drinkware", name: { uk: "Пляшки", en: "Bottles" }, position: 1 },
  ],
  paths: {
    axpol: [
      { path: ["DRINKWARE", "ceramic mugs"], category: "drinkware.mugs" },
      { path: ["DRINKWARE", "sport bottles"], category: "drinkware.bottles" },
      { path: ["DRINKWARE", "hip flasks"], category: "drinkware.bottles" },
    ],
    newco: [{ path: ["Mugs"], category: "drinkware.mugs" }],
  },
};

const state: SyncState = {
  sources: ["axpol", "midocean"],
  categories: [
    { code: "drinkware", parent: null, name: { uk: "Посуд для напоїв", en: "Drinkware" }, position: 0, isActive: true },
    { code: "drinkware.mugs", parent: "drinkware", name: { uk: "Чашки", en: "Mugs" }, position: 0, isActive: true },
    { code: "drinkware.glasses", parent: "drinkware", name: { uk: "Склянки", en: "Glasses" }, position: 2, isActive: true },
  ],
  mappings: [
    { source: "axpol", path: ["DRINKWARE", "ceramic mugs"], category: "drinkware.mugs" },
    { source: "axpol", path: ["DRINKWARE", "sport bottles"], category: "drinkware.mugs" },
    { source: "axpol", path: ["DRINKWARE", "glasses"], category: "drinkware.glasses" },
    { source: "midocean", path: ["Drink & lunchware", "Ceramics", "Mugs"], category: "drinkware.mugs" },
  ],
  catalogPaths: [
    { source: "axpol", path: ["DRINKWARE", "ceramic mugs"], activeModels: 24 },
    { source: "axpol", path: ["DRINKWARE", "sport bottles"], activeModels: 87 },
    { source: "axpol", path: ["DRINKWARE", "drinking jars"], activeModels: 1 },
    { source: "axpol", path: ["TEXTILES", "T-shirts"], activeModels: 0 },
    { source: "axpol", path: null, activeModels: 2 },
    { source: "midocean", path: ["Drink & lunchware", "Ceramics", "Mugs"], activeModels: 34 },
  ],
};

describe("planSync", () => {
  const plan = planSync(state, taxonomy);

  it("compares the list with the database: new, changed (name), same, and what the files no longer have", () => {
    expect(plan.categories).toEqual({
      inFile: 3, activeInDb: 3, added: ["drinkware.bottles"], changed: ["drinkware.mugs"], same: 1,
      deactivated: ["drinkware.glasses"],
    });
  });

  it("compares each source's paths, and reports the active models' paths without a category and the file's stale ones", () => {
    expect(plan.sources.find((source) => source.source === "axpol")).toEqual({
      source: "axpol", hasRow: true, inFile: 3, existing: 3, added: 1, changed: 1, same: 1, removed: 1,
      unmapped: [{ path: null, models: 2 }, { path: ["DRINKWARE", "drinking jars"], models: 1 }],
      stale: [["DRINKWARE", "hip flasks"]],
    });
  });

  it("removes the paths of a source without a file, and lets a source not imported yet wait", () => {
    expect(plan.sources.map((source) => source.source)).toEqual(["axpol", "midocean", "newco"]);
    expect(plan.sources[1]).toMatchObject({ inFile: 0, removed: 1, unmapped: [{ path: ["Drink & lunchware", "Ceramics", "Mugs"], models: 34 }] });
    expect(plan.sources[2]).toMatchObject({ hasRow: false, inFile: 1, added: 1, stale: [["Mugs"]] });
  });

  it("prints the counts and the paths to map", () => {
    const lines = planLines(plan);
    expect(lines).toContain("categories: 3 in the files; new 1, changed 1, same 1, deactivated 1");
    expect(lines).toContain("axpol: 2 paths of active models without a category (3 models)");
    expect(lines).toContain("axpol:   DRINKWARE > drinking jars (1 models)");
    expect(lines).toContain("axpol:   (no English category) (2 models)");
    expect(lines).toContain("WARNING newco: no such source in the database, its 1 paths are not written");
    expect(lines.at(-1)).toBe("summary: 3 paths of active models without a category (37 models), paths not written for newco");
  });

  it("takes another key in a category's name in the database for a change", () => {
    const withExtra = { ...state, categories: state.categories.map((row) => (row.code === "drinkware"
      ? { ...row, name: { uk: "Посуд для напоїв", en: "Drinkware", de: "Trinkgefäße" } } : row)) };
    expect(planSync(withExtra, taxonomy).categories.changed).toEqual(["drinkware", "drinkware.mugs"]);
  });
});

describe("massRemoval", () => {
  it("stops a sync that deactivates or removes over a fifth of what there is", () => {
    const plan = planSync(state, taxonomy);
    expect(massRemoval(plan)).toBe("1 of 3 active categories deactivated; axpol: 1 of 3 paths removed;"
      + " midocean: 1 of 1 paths removed: stopped before any write (--allow-mass-removal if it is meant)");
  });

  it("lets a sync through that changes little", () => {
    const sameFile = { ...taxonomy, entries: [...taxonomy.entries, { ...taxonomy.entries[1]!, code: "drinkware.glasses", position: 2,
      name: { uk: "Склянки", en: "Glasses" } }] };
    const smallState = { ...state, mappings: state.mappings.filter((row) => row.source === "axpol" && row.path[1] !== "glasses") };
    expect(massRemoval(planSync(smallState, sameFile))).toBeUndefined();
  });
});
