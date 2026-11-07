import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadTaxonomy, readTaxonomy } from "./taxonomy.js";

// config.ts reads DATABASE_URL on import; the files need none of it
vi.mock("../config.js", () => ({ ConfigError: class extends Error {} }));

const groups = [{
  code: "drinkware",
  name: { uk: "Посуд для напоїв", en: "Drinkware" },
  categories: [
    { code: "drinkware.mugs", name: { uk: "Кружки й чашки", en: "Mugs & cups" } },
    { code: "drinkware.bottles", name: { uk: "Пляшки для води", en: "Water & sports bottles" } },
  ],
}];

describe("readTaxonomy", () => {
  it("reads groups, their categories in order and each source's paths", () => {
    const taxonomy = readTaxonomy(groups, {
      axpol: { "drinkware.mugs": ["DRINKWARE > ceramic mugs", "DRINKWARE > other mugs"], "drinkware.bottles": ["DRINKWARE"] },
    });
    expect(taxonomy.entries).toEqual([
      { code: "drinkware", parent: null, name: { uk: "Посуд для напоїв", en: "Drinkware" }, position: 0 },
      { code: "drinkware.mugs", parent: "drinkware", name: { uk: "Кружки й чашки", en: "Mugs & cups" }, position: 0 },
      { code: "drinkware.bottles", parent: "drinkware", name: { uk: "Пляшки для води", en: "Water & sports bottles" }, position: 1 },
    ]);
    expect(taxonomy.paths).toEqual({ axpol: [
      { path: ["DRINKWARE", "ceramic mugs"], category: "drinkware.mugs" },
      { path: ["DRINKWARE", "other mugs"], category: "drinkware.mugs" },
      { path: ["DRINKWARE"], category: "drinkware.bottles" },
    ] });
  });

  it.each([
    ["a group code of another shape", [{ ...groups[0], code: "Drinkware" }], {}, /group 1 has the code "Drinkware"/],
    ["a category outside its group's code", [{ ...groups[0], categories: [{ code: "bags.mugs", name: { uk: "К", en: "M" } }] }], {},
      /category 1 has the code "bags.mugs"/],
    ["a name missing a language", [{ ...groups[0], name: { en: "Drinkware" } }], {}, /drinkware: no uk name/],
    ["a group without categories", [{ ...groups[0], categories: [] }], {}, /drinkware: no categories/],
    ["an empty list", [], {}, /an empty one/],
    ["a source file without paths", groups, { axpol: {} }, /axpol: no paths/],
    ["a code twice", [{ ...groups[0], categories: [groups[0]?.categories[0], groups[0]?.categories[0]] }], {},
      /the code "drinkware.mugs" twice/],
    ["a path under a group", groups, { axpol: { drinkware: ["DRINKWARE"] } }, /axpol: "drinkware" is not a category/],
    ["a path under an unknown category", groups, { axpol: { "drinkware.cups": ["DRINKWARE"] } }, /"drinkware.cups" is not a category/],
    ["a path twice", groups, { axpol: { "drinkware.mugs": ["DRINKWARE > mugs"], "drinkware.bottles": ["DRINKWARE > mugs"] } },
      /axpol: the path "DRINKWARE > mugs" twice/],
    ["a path with an empty level", groups, { axpol: { "drinkware.mugs": ["DRINKWARE >  > mugs"] } }, /has the path/],
    ["a path that is not text", groups, { axpol: { "drinkware.mugs": [["DRINKWARE"]] } }, /has the path/],
  ])("refuses %s", (_title, groupsValue, sourceFiles, message) => {
    expect(() => readTaxonomy(groupsValue, sourceFiles)).toThrow(message);
  });

  it("lists every problem at once", () => {
    expect(() => readTaxonomy(groups, { axpol: { drinkware: ["A"], "drinkware.cups": ["B"] } }))
      .toThrow(/"drinkware" is not a category.*"drinkware.cups" is not a category/);
  });
});

describe("the files in git", () => {
  it("are valid, with paths of every source", () => {
    const taxonomy = loadTaxonomy();
    expect(taxonomy.entries.some((entry) => entry.parent === null)).toBe(true);
    expect(taxonomy.paths.axpol?.length).toBeGreaterThan(0);
    expect(taxonomy.paths.midocean?.length).toBeGreaterThan(0);
  });

  // JSON.parse keeps the last of two equal keys, so a category written twice would lose its first paths unseen
  it.each(["axpol", "midocean"])("have each category once in %s.json", (source) => {
    const text = readFileSync(new URL(`./${source}.json`, import.meta.url), "utf8");
    const keys = [...text.matchAll(/^ {2}"([^"]+)": \[/gm)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(Object.keys(JSON.parse(text) as object).length);
  });
});
