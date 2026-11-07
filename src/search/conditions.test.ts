import { describe, expect, it } from "vitest";
import {
  conditionFactor, conditionMatch, conditionMatches, DEFAULT_DEMOTION, demoteByConditions, type Demotion, hasConditions, isDemoting,
  type ModelFacts, NO_CONDITIONS,
} from "./conditions.js";
import type { Conditions } from "./query-parse-contract.js";
import type { FusedModel } from "./rank.js";

const demotion: Demotion = { against: 0.5, otherMaterial: "against", hasMaterials: true };
const near = Math.sqrt(0.5);
const facts = (fields: Partial<ModelFacts>): ModelFacts =>
  ({ volumeMl: null, materials: [], sizesCm: [], printTechniques: [], sheets: null, gsm: null, ...fields });
const noneAsked = { volumeMl: null, materials: null, sizeCm: null, printTechniques: null, sheets: null, gsm: null };
const fused = (modelId: number, score: number): FusedModel => ({
  modelId, score, lists: { "text-text": { rank: modelId, similarity: 0.5 } }, photos: [],
});

describe("conditionFactor", () => {
  const over800 = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
  const about500 = { ...NO_CONDITIONS, volumeMl: { min: 500, max: 500 } };

  it("leaves a model the catalogue says nothing of where it is, whatever is asked", () => {
    const asked = { volumeMl: { min: 800, max: null }, materials: ["plastic" as const], sizeCm: { min: [35, 35], max: [] } };
    expect(conditionFactor(asked, facts({}), demotion)).toBe(1);
  });

  it("takes a value within the bounds as it is, one near them a little down, one against them further", () => {
    expect(conditionFactor(over800, facts({ volumeMl: 900 }), demotion)).toBe(1);
    expect(conditionFactor(over800, facts({ volumeMl: 800 }), demotion)).toBe(1);
    expect(conditionFactor(over800, facts({ volumeMl: 750 }), demotion)).toBeCloseTo(near);
    expect(conditionFactor(over800, facts({ volumeMl: 500 }), demotion)).toBe(0.5);
  });

  it("reads one number as both bounds, with room around it", () => {
    expect(conditionFactor(about500, facts({ volumeMl: 500 }), demotion)).toBe(1);
    expect(conditionFactor(about500, facts({ volumeMl: 480 }), demotion)).toBeCloseTo(near);
    expect(conditionFactor(about500, facts({ volumeMl: 530 }), demotion)).toBeCloseTo(near);
    expect(conditionFactor(about500, facts({ volumeMl: 750 }), demotion)).toBe(0.5);
  });

  it("holds an upper bound too", () => {
    const upTo = { ...NO_CONDITIONS, volumeMl: { min: null, max: 300 } };
    expect(conditionFactor(upTo, facts({ volumeMl: 250 }), demotion)).toBe(1);
    expect(conditionFactor(upTo, facts({ volumeMl: 500 }), demotion)).toBe(0.5);
  });

  it("compares the sides asked for, longest first, and says nothing of the others", () => {
    const from35 = { ...NO_CONDITIONS, sizeCm: { min: [35, 35], max: [] } };
    expect(conditionFactor(from35, facts({ sizesCm: [42, 38, 10] }), demotion)).toBe(1);
    expect(conditionFactor(from35, facts({ sizesCm: [42, 29] }), demotion)).toBeCloseTo(near);
    expect(conditionFactor(from35, facts({ sizesCm: [42, 20] }), demotion)).toBe(0.5);
    expect(conditionFactor(from35, facts({ sizesCm: [50] }), demotion)).toBe(1);
  });

  it("holds a material against the first one a model lists", () => {
    const plastic = { ...NO_CONDITIONS, materials: ["plastic" as const] };
    expect(conditionFactor(plastic, facts({ materials: ["tritan"] }), demotion)).toBe(1);
    expect(conditionFactor(plastic, facts({ materials: ["plastic", "stainless-steel"] }), demotion)).toBe(1);
    expect(conditionFactor(plastic, facts({ materials: ["stainless-steel"] }), demotion)).toBe(0.5);
  });

  it("counts a later material by the demotion, so a longer list of parts lifts nobody by itself", () => {
    const plastic = { ...NO_CONDITIONS, materials: ["plastic" as const] };
    const mug = facts({ materials: ["stainless-steel", "plastic"] });
    expect(conditionFactor(plastic, mug, demotion)).toBe(0.5);
    expect(conditionFactor(plastic, mug, { ...demotion, otherMaterial: "near" })).toBeCloseTo(near);
  });

  it("leaves materials out when asked to, numbers still count", () => {
    const asked = { volumeMl: { min: 800, max: null }, materials: ["plastic" as const], sizeCm: null };
    const numbers = { ...demotion, hasMaterials: false };
    expect(conditionFactor(asked, facts({ materials: ["glass"] }), numbers)).toBe(1);
    expect(conditionFactor(asked, facts({ volumeMl: 500, materials: ["glass"] }), numbers)).toBe(0.5);
  });

  it("multiplies over the conditions", () => {
    const asked = { volumeMl: { min: 800, max: null }, materials: ["plastic" as const], sizeCm: null };
    expect(conditionFactor(asked, facts({ volumeMl: 500, materials: ["glass"] }), demotion)).toBe(0.25);
  });
});

describe("conditionMatch of print, sheets and weight", () => {
  const laser: Conditions = { ...NO_CONDITIONS, printTechniques: ["laser", "pad"] };

  it("says a technique fits when the supplier lists any asked, and goes against when it lists others", () => {
    expect(conditionMatch(laser, facts({ printTechniques: ["pad", "screen"] })).printTechniques).toBe("fits");
    expect(conditionMatch(laser, facts({ printTechniques: ["screen"] })).printTechniques).toBe("against");
  });

  it("says unknown when no print data is there, or a code nothing explains could be the one asked", () => {
    expect(conditionMatch(laser, facts({})).printTechniques).toBe("unknown");
    expect(conditionMatch(laser, facts({ printTechniques: ["screen", "unconfirmed"] })).printTechniques).toBe("unknown");
    expect(conditionMatch(laser, facts({ printTechniques: ["laser", "unconfirmed"] })).printTechniques).toBe("fits");
  });

  it("reads sheets and g/m2 as numbers, with the same room and unknown where no text gives them", () => {
    const asked: Conditions = { ...NO_CONDITIONS, sheets: { min: 80, max: 80 }, gsm: { min: 160, max: null } };
    expect(conditionMatch(asked, facts({ sheets: 85, gsm: 180 }))).toMatchObject({ sheets: "fits", gsm: "fits" });
    expect(conditionMatch(asked, facts({ sheets: 40, gsm: 120 }))).toMatchObject({ sheets: "against", gsm: "against" });
    expect(conditionMatch(asked, facts({}))).toMatchObject({ sheets: "unknown", gsm: "unknown" });
  });

  it("counts these as conditions", () => {
    expect(hasConditions(laser)).toBe(true);
    expect(hasConditions({ ...NO_CONDITIONS, printTechniques: [] })).toBe(false);
    expect(hasConditions({ ...NO_CONDITIONS, gsm: { min: 160, max: 160 } })).toBe(true);
  });
});

describe("conditionMatch", () => {
  const over800 = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
  const upTo300 = { ...NO_CONDITIONS, volumeMl: { min: null, max: 300 } };
  const about500 = { ...NO_CONDITIONS, volumeMl: { min: 500, max: 500 } };
  const materials = (...codes: Conditions["materials"]) => ({ ...NO_CONDITIONS, materials: codes });
  const sized = (min: number[], max: number[] = []) => ({ ...NO_CONDITIONS, sizeCm: { min, max } });

  it("says unknown of a value the catalogue does not have, never against, whatever is asked", () => {
    const asked = { volumeMl: { min: 800, max: null }, materials: ["plastic" as const], sizeCm: { min: [35, 35], max: [] } };
    expect(conditionMatch(asked, facts({}))).toEqual({ ...noneAsked, volumeMl: "unknown", materials: "unknown", sizeCm: "unknown" });
  });

  it("says nothing of what the query does not ask", () => {
    expect(conditionMatch(over800, facts({ volumeMl: 900, materials: ["glass"], sizesCm: [20] })))
      .toEqual({ ...noneAsked, volumeMl: "fits" });
    expect(conditionMatch(NO_CONDITIONS, facts({ volumeMl: 900 }))).toEqual(noneAsked);
  });

  it("holds a value to its bounds", () => {
    expect(conditionMatch(over800, facts({ volumeMl: 800 })).volumeMl).toBe("fits");
    expect(conditionMatch(over800, facts({ volumeMl: 500 })).volumeMl).toBe("against");
    expect(conditionMatch(upTo300, facts({ volumeMl: 250 })).volumeMl).toBe("fits");
    expect(conditionMatch(upTo300, facts({ volumeMl: 500 })).volumeMl).toBe("against");
  });

  it("gives a number said exactly the screen filter's room, and an open bound none", () => {
    expect(conditionMatch(about500, facts({ volumeMl: 480 })).volumeMl).toBe("fits");
    expect(conditionMatch(about500, facts({ volumeMl: 600 })).volumeMl).toBe("against");
    expect(conditionMatch(over800, facts({ volumeMl: 750 })).volumeMl).toBe("against");
    expect(conditionMatch(upTo300, facts({ volumeMl: 320 })).volumeMl).toBe("against");
    expect(conditionMatch(sized([40, 30], [40, 30]), facts({ sizesCm: [44, 25] })).sizeCm).toBe("fits");
    expect(conditionMatch(sized([40, 30]), facts({ sizesCm: [44, 25] })).sizeCm).toBe("against");
  });

  it("confirms a size only by the sides asked, and a stated side can still go against it", () => {
    expect(conditionMatch(sized([35, 35]), facts({ sizesCm: [42, 38, 10] })).sizeCm).toBe("fits");
    expect(conditionMatch(sized([35, 35]), facts({ sizesCm: [50] })).sizeCm).toBe("unknown");
    expect(conditionMatch(sized([35, 35]), facts({ sizesCm: [10] })).sizeCm).toBe("against");
    expect(conditionMatch(sized([35]), facts({ sizesCm: [42, 20] })).sizeCm).toBe("fits");
  });

  it("does not deny a size when the sides differ in number and another side could be the one meant", () => {
    // Asked 8 cm across, a mug 12 high and 8 across
    expect(conditionMatch(sized([8], [8]), facts({ sizesCm: [12, 8] })).sizeCm).toBe("unknown");
    expect(conditionMatch(sized([], [15]), facts({ sizesCm: [20, 10] })).sizeCm).toBe("unknown");
    // A4 asked, one side known
    expect(conditionMatch(sized([29.7, 21], [29.7, 21]), facts({ sizesCm: [21] })).sizeCm).toBe("unknown");
    expect(conditionMatch(sized([40, 30], [40, 30]), facts({ sizesCm: [42, 38, 30] })).sizeCm).toBe("unknown");
  });

  it("denies such a size when no side could be the one meant", () => {
    expect(conditionMatch(sized([8], [8]), facts({ sizesCm: [12, 11] })).sizeCm).toBe("against");
    expect(conditionMatch(sized([], [15]), facts({ sizesCm: [20, 18] })).sizeCm).toBe("against");
    expect(conditionMatch(sized([29.7, 21], [29.7, 21]), facts({ sizesCm: [5] })).sizeCm).toBe("against");
  });

  it("holds a material against the first one a model lists, like the hard filter", () => {
    expect(conditionMatch(materials("plastic"), facts({ materials: ["tritan", "stainless-steel"] })).materials).toBe("fits");
    expect(conditionMatch(materials("glass", "plastic"), facts({ materials: ["plastic"] })).materials).toBe("fits");
    expect(conditionMatch(materials("plastic"), facts({ materials: ["stainless-steel"] })).materials).toBe("against");
    expect(conditionMatch(materials("plastic"), facts({ materials: ["stainless-steel", "bamboo"] })).materials).toBe("against");
  });

  it("does not confirm a material by a later place or a wider name, nor deny it", () => {
    expect(conditionMatch(materials("glass"), facts({ materials: ["bamboo", "plastic", "glass"] })).materials).toBe("unknown");
    expect(conditionMatch(materials("stainless-steel"), facts({ materials: ["metal"] })).materials).toBe("unknown");
    expect(conditionMatch(materials("metal"), facts({ materials: ["stainless-steel"] })).materials).toBe("fits");
  });
});

describe("conditionMatches", () => {
  const glass = { ...NO_CONDITIONS, materials: ["glass" as const] };
  const over800 = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
  const of = (modelId: number, productIndex?: number): FusedModel => ({ ...fused(modelId, 0.01), productIndex });

  it("holds each model to the product that gave it its place", () => {
    const known = new Map([[1, facts({ materials: ["glass"], volumeMl: 300 })], [2, facts({ materials: ["glass"], volumeMl: 300 })]]);
    const matches = conditionMatches([of(1, 0), of(2, 1)], [glass, over800], known);
    expect(matches.get(1)).toEqual({ ...noneAsked, materials: "fits" });
    expect(matches.get(2)).toEqual({ ...noneAsked, volumeMl: "against" });
  });

  it("has nothing for a product with no conditions, nor for a model only a code found", () => {
    const matches = conditionMatches([of(1, 1), of(2)], [glass, NO_CONDITIONS], new Map([[1, facts({})], [2, facts({})]]));
    expect(matches.size).toBe(0);
  });

  it("reads a model with no facts read as unknown", () => {
    expect(conditionMatches([of(1, 0)], [glass], new Map()).get(1)?.materials).toBe("unknown");
  });
});

describe("hasConditions", () => {
  it("says whether anything is asked", () => {
    expect(hasConditions(NO_CONDITIONS)).toBe(false);
    expect(hasConditions({ ...NO_CONDITIONS, materials: ["glass"] })).toBe(true);
    expect(hasConditions({ ...NO_CONDITIONS, volumeMl: { min: 1, max: null } })).toBe(true);
    expect(hasConditions({ ...NO_CONDITIONS, sizeCm: { min: [], max: [10] } })).toBe(true);
  });
});

describe("isDemoting", () => {
  const asked = { ...NO_CONDITIONS, materials: ["glass" as const] };

  it("needs something asked and a factor below 1", () => {
    expect(isDemoting(asked, demotion)).toBe(true);
    expect(isDemoting(NO_CONDITIONS, demotion)).toBe(false);
    expect(isDemoting(asked, { ...demotion, against: 1 })).toBe(false);
  });

  it("is off by default, until a frozen set takes it", () => {
    expect(isDemoting(asked, DEFAULT_DEMOTION)).toBe(false);
  });
});

describe("demoteByConditions", () => {
  const over800 = { ...NO_CONDITIONS, volumeMl: { min: 800, max: null } };
  const known = new Map([[1, facts({ volumeMl: 300 })], [2, facts({ volumeMl: 900 })]]);

  it("lets a model from below the limit take the place of one that fell", () => {
    const ranked = demoteByConditions([fused(1, 0.03), fused(2, 0.02), fused(3, 0.01)], over800, known, demotion, 2);
    expect(ranked.map((model) => model.modelId)).toEqual([2, 1]);
    expect(demoteByConditions([fused(1, 0.03), fused(2, 0.028), fused(3, 0.02)], over800, known, { ...demotion, against: 0.1 }, 2)
      .map((model) => model.modelId)).toEqual([2, 3]);
  });

  it("keeps the order when no known value goes against the query", () => {
    const ranked = demoteByConditions([fused(4, 0.03), fused(2, 0.02), fused(3, 0.01)], over800, known, demotion, 3);
    expect(ranked.map((model) => model.modelId)).toEqual([4, 2, 3]);
  });

  it("does nothing at a factor of 1", () => {
    const ranked = demoteByConditions([fused(1, 0.03), fused(2, 0.02)], over800, known, { ...demotion, against: 1 }, 2);
    expect(ranked.map((model) => [model.modelId, model.score])).toEqual([[1, 0.03], [2, 0.02]]);
  });
});
