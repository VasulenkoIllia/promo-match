import { describe, expect, it } from "vitest";
import { CONDITION_PASS, fittingEntries, passConditions, passFilters } from "./condition-pass.js";
import { conditionRoom, type ModelFacts, NO_CONDITIONS } from "./conditions.js";
import type { Conditions } from "./query-parse-contract.js";
import type { ListEntry } from "./rank.js";

const over800: Conditions = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
const steel: Conditions = { ...NO_CONDITIONS, materials: ["stainless-steel"] };
const numbersOnly = { weight: 0.5, hasMaterials: false, hasPrint: false };
const withPrint = { ...numbersOnly, hasPrint: true };
const facts = (volumeMl: number | null, materials: ModelFacts["materials"] = [], sizesCm: number[] = []): ModelFacts =>
  ({ volumeMl, materials, sizesCm, printTechniques: [], sheets: null, gsm: null });
const entry = (modelId: number, rank: number): ListEntry => ({ modelId, rank, similarity: 0.5, photos: [] });

describe("CONDITION_PASS", () => {
  it("holds numbers and print, not materials, when the screen's switch turns it on", () => {
    expect(CONDITION_PASS).toEqual(withPrint);
  });
});

describe("passConditions", () => {
  it("runs no pass when it is off, or the query asks nothing", () => {
    expect(passConditions(over800, null, {})).toBeNull();
    expect(passConditions(NO_CONDITIONS, numbersOnly, {})).toBeNull();
  });

  it("leaves materials out unless told to hold them", () => {
    expect(passConditions(steel, numbersOnly, {})).toBeNull();
    expect(passConditions({ ...over800, materials: ["glass"] }, numbersOnly, {})).toMatchObject(over800);
    expect(passConditions(steel, { ...numbersOnly, hasMaterials: true }, {})).toMatchObject(steel);
  });

  it("holds a technique only when told to, and not one a supplier's code leaves unconfirmed", () => {
    const laser: Conditions = { ...NO_CONDITIONS, printTechniques: ["laser"] };
    expect(passConditions(laser, numbersOnly, {})).toBeNull();
    expect(passConditions(laser, withPrint, {})?.printTechniques).toEqual(["laser"]);
    expect(passConditions({ ...NO_CONDITIONS, printTechniques: ["embroidery"] }, withPrint, {})).toBeNull();
    expect(passConditions({ ...over800, printTechniques: ["embroidery", "laser"] }, withPrint, {})?.printTechniques).toEqual([]);
  });

  it("holds sheets, and never the weight in g/m2, which few texts give", () => {
    const sheets = { min: 80, max: 80 };
    expect(passConditions({ ...NO_CONDITIONS, sheets }, numbersOnly, {})?.sheets).toEqual(sheets);
    expect(passConditions({ ...NO_CONDITIONS, gsm: { min: 160, max: 160 } }, numbersOnly, {})).toBeNull();
  });

  it("runs no pass beside a fact the screen asks for: the room would let past its filter what it left out", () => {
    expect(passConditions(over800, numbersOnly, { volumeMl: { min: 900 } })).toBeNull();
    expect(passConditions(over800, numbersOnly, { materials: ["glass"] })).toBeNull();
    expect(passConditions(over800, numbersOnly, { sizeCm: { min: [20] } })).toBeNull();
  });
});

describe("passFilters", () => {
  it("keeps the screen's other filters", () => {
    expect(passFilters({ sources: ["axpol"], minStock: 500, sharedCategoryIds: [4] }, over800)).toEqual({
      sources: ["axpol"], minStock: 500, sharedCategoryIds: [4], volumeMl: { min: 800 },
    });
  });
});

describe("conditionRoom", () => {
  it("gives a number said exactly the card's room, and an open bound none", () => {
    expect(conditionRoom({ ...NO_CONDITIONS, volumeMl: { min: 500, max: 500 } }).volumeMl).toEqual({ min: 450, max: 550 });
    expect(conditionRoom({ ...NO_CONDITIONS, volumeMl: { min: 300, max: 300 } }).volumeMl).toEqual({ min: 270, max: 330 });
    expect(conditionRoom(over800).volumeMl).toEqual({ min: 800 });
    expect(conditionRoom({ ...NO_CONDITIONS, volumeMl: { min: null, max: 500 } }).volumeMl).toEqual({ max: 500 });
  });

  it("gives a size said exactly its own room, side by side", () => {
    expect(conditionRoom({ ...NO_CONDITIONS, sizeCm: { min: [21, 14.8], max: [21, 14.8] } }).sizeCm)
      .toEqual({ min: [16.8, 11.8], max: [25.2, 17.8] });
    expect(conditionRoom({ ...NO_CONDITIONS, sizeCm: { min: [35, 35], max: [] } }).sizeCm).toEqual({ min: [35, 35] });
  });

  it("asks nothing a query does not", () => {
    expect(conditionRoom(NO_CONDITIONS)).toEqual({});
    expect(conditionRoom(steel)).toEqual({ materials: ["stainless-steel"] });
  });
});

describe("fittingEntries", () => {
  it("ranks again among the models a card would say fit", () => {
    const known = new Map([[1, facts(300)], [2, facts(900)], [3, facts(null)], [4, facts(1000)]]);
    expect(fittingEntries([entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4)], over800, over800, known)).toEqual([entry(2, 1), entry(4, 2)]);
  });

  it("gives no vote to a side the filter lets past, which a card calls unknown", () => {
    const asked = { ...NO_CONDITIONS, sizeCm: { min: [35, 35], max: [] } };
    const known = new Map([[1, facts(null, [], [40])], [2, facts(null, [], [40, 38])]]);
    expect(fittingEntries([entry(1, 1), entry(2, 2)], asked, asked, known)).toEqual([entry(2, 1)]);
  });

  it("gives no vote when the catalogue says the opposite of what the pass does not hold it to", () => {
    const asked: Conditions = { ...over800, materials: ["stainless-steel"] };
    const known = new Map([[1, facts(900, ["plastic"])], [2, facts(900, ["stainless-steel"])], [3, facts(900)]]);
    expect(fittingEntries([entry(1, 1), entry(2, 2), entry(3, 3)], over800, asked, known)).toEqual([entry(2, 1), entry(3, 2)]);
  });

  it("gives no vote to a model with no facts read", () => {
    expect(fittingEntries([entry(1, 1)], over800, over800, new Map())).toEqual([]);
  });
});
