import { describe, expect, it } from "vitest";
import { type ModelFacts, NO_CONDITIONS } from "./conditions.js";
import type { Conditions } from "./query-parse-contract.js";
import type { FusedModel } from "./rank.js";
import { hasExclusions, liftColored, sinkExcluded } from "./traits.js";

const fused = (...scores: number[]): FusedModel[] =>
  scores.map((score, index) => ({ modelId: index + 1, score, lists: {}, photos: [] }));
const order = (models: FusedModel[]) => models.map(({ modelId }) => modelId);
const facts = (...materials: ModelFacts["materials"]): ModelFacts =>
  ({ volumeMl: null, materials, sizesCm: [], printTechniques: [], sheets: null, gsm: null });
const notPlastic: Conditions = { ...NO_CONDITIONS, excludedMaterials: ["plastic"] };
const notBlack: Conditions = { ...NO_CONDITIONS, excludedColors: ["black"] };

describe("hasExclusions", () => {
  it("is false for a query that rules nothing out, a reading without the fields included", () => {
    expect(hasExclusions(NO_CONDITIONS)).toBe(false);
    expect(hasExclusions({ ...NO_CONDITIONS, excludedMaterials: [], excludedColors: [] })).toBe(false);
  });

  it("is true for a material or a colour", () => {
    expect(hasExclusions(notPlastic)).toBe(true);
    expect(hasExclusions(notBlack)).toBe(true);
  });
});

describe("liftColored", () => {
  it("lifts a model with a variant of the colour and drops none", () => {
    const names = new Map([[2, ["white", "orange"]]]);
    expect(order(liftColored(fused(1, 0.95, 0.9), names, ["orange"], 1.1))).toEqual([2, 1, 3]);
  });

  it("moves nothing when no model has the colour", () => {
    expect(order(liftColored(fused(1, 0.95), new Map(), ["orange"], 1.1))).toEqual([1, 2]);
  });
});

describe("sinkExcluded", () => {
  it("sinks a model by the material the supplier lists first, and keeps it in the list", () => {
    const known = new Map([[1, facts("plastic", "metal")], [2, facts("metal", "plastic")]]);
    expect(order(sinkExcluded(fused(1, 0.9), known, new Map(), notPlastic, 0.5))).toEqual([2, 1]);
  });

  it("takes a kind of what is ruled out as ruled out", () => {
    const known = new Map([[1, facts("stainless-steel")], [2, facts("wood")]]);
    const notMetal: Conditions = { ...NO_CONDITIONS, excludedMaterials: ["metal"] };
    expect(order(sinkExcluded(fused(1, 0.9), known, new Map(), notMetal, 0.5))).toEqual([2, 1]);
  });

  it("leaves a model of unknown material where it is", () => {
    expect(order(sinkExcluded(fused(1, 0.9), new Map([[1, facts()]]), new Map(), notPlastic, 0.5))).toEqual([1, 2]);
  });

  it("sinks by colour only when no variant escapes it", () => {
    const names = new Map([[1, ["black", "red"]], [2, ["black"]]]);
    expect(order(sinkExcluded(fused(1, 0.9, 0.8), new Map(), names, notBlack, 0.5))).toEqual([1, 3, 2]);
  });

  it("leaves a model whose colour no rule knows", () => {
    const names = new Map([[1, ["Sunset"]]]);
    expect(order(sinkExcluded(fused(1, 0.9), new Map(), names, notBlack, 0.5))).toEqual([1, 2]);
  });
});
