import { describe, expect, it } from "vitest";
import { codeHits, codeTokens, preferredMatches, textWithoutCodes, withCodeHits } from "./codes.js";
import type { FusedModel } from "./rank.js";

const match = (modelId: number, isModelCode = false) => ({ modelId, label: `axpol ${modelId}`, isModelCode });

describe("codeTokens", () => {
  it("finds codes among words, signs and any case", () => {
    expect(codeTokens("Angebot für 250 x Artikelnummer:IT3787-09, in rot")).toEqual(["IT3787-09"]);
    expect(codeTokens("(V5805/A) p437.140. V2233-03")).toEqual(["V5805/A", "p437.140", "V2233-03"]);
  });

  it("leaves out plain words and numbers, and names a code once", () => {
    expect(codeTokens("термочашка 350 ml 10 штук, 12.5 cm")).toEqual([]);
    expect(codeTokens("V2233 V2233")).toEqual(["V2233"]);
  });

  it("takes a number of 6 digits and more for a code anywhere", () => {
    expect(codeTokens("Angebot 250 Stück 1261803 in rot")).toEqual(["1261803"]);
    expect(codeTokens("ручки 002402 і 56-1101117, сумка 01029-02")).toEqual(["002402", "56-1101117", "01029-02"]);
  });

  it("takes a number of 4 or 5 digits when the text is codes alone", () => {
    expect(codeTokens("12618")).toEqual(["12618"]);
    expect(codeTokens("0641, 5246; IT3787-09")).toEqual(["0641", "5246", "IT3787-09"]);
  });

  it("takes a number of 4 or 5 digits after a code word", () => {
    expect(codeTokens("Art.-Nr.: 5246, 1500 Stück")).toEqual(["5246"]);
    expect(codeTokens("ручка за артикулом 12618, синя, 2500 шт")).toEqual(["12618"]);
    expect(codeTokens("Kugelschreiber #0641 und Ref. 15246")).toEqual(["0641", "15246"]);
    expect(codeTokens("смарт-годинник код: 20607")).toEqual(["20607"]);
  });

  it("leaves out amounts, measures and standards among words", () => {
    expect(codeTokens("термокружка 1200 ml, 1500 шт")).toEqual([]);
    expect(codeTokens("powerbank 8000 mAh, 10.000 mAh, ISO 22196")).toEqual([]);
    expect(codeTokens("ручка 12618 синя, Smart 5246")).toEqual([]);
  });
});

describe("codeHits", () => {
  it("goes by the order of the text and names a model once", () => {
    const matches = new Map([["v1-01", [match(7)]], ["v2", [match(9, true)]], ["v1", [match(7, true)]]]);
    expect(codeHits(["V2", "V1-01", "V1"], matches)).toEqual([{ modelId: 9, code: "V2" }, { modelId: 7, code: "V1-01" }]);
  });

  it("takes a model's own code before a SKU equal to it, and every model of a code two suppliers share", () => {
    expect(preferredMatches([match(1), match(2, true)]).map((each) => each.modelId)).toEqual([2]);
    const shared = new Map([["x1", [match(1, true), match(2, true)]]]);
    expect(codeHits(["X1"], shared).map((hit) => hit.modelId).toSorted()).toEqual([1, 2]);
  });
});

describe("textWithoutCodes", () => {
  it("takes the found codes out and leaves the rest", () => {
    expect(textWithoutCodes("250 x IT3787-09 in rot, IT3787", ["IT3787-09", "IT3787"])).toBe("250 x in rot,");
  });

  it("keeps a code the catalogues do not have", () => {
    expect(textWithoutCodes("V2233 oder ZZ9", ["V2233"])).toBe("oder ZZ9");
  });

  it("leaves nothing when no word is left to read", () => {
    expect(textWithoutCodes("IT3787-09", ["IT3787-09"])).toBeUndefined();
    expect(textWithoutCodes("250 x IT3787-09!", ["IT3787-09"])).toBeUndefined();
  });
});

describe("withCodeHits", () => {
  const fused: FusedModel[] = [
    { modelId: 1, score: 0.03, lists: {}, photos: [] },
    { modelId: 2, score: 0.02, lists: { "text-text": { rank: 2, similarity: 0.8 } }, photos: [] },
  ];

  it("puts the named models first, keeping what the lists found of them", () => {
    const merged = withCodeHits(fused, [{ modelId: 9, code: "X9" }, { modelId: 2, code: "X2" }], 24);
    expect(merged.map((model) => [model.modelId, model.matchedCode])).toEqual([[9, "X9"], [2, "X2"], [1, undefined]]);
    expect(merged[0]).toEqual({ modelId: 9, score: 0, lists: {}, photos: [], matchedCode: "X9", matchedCodeModels: 1 });
    expect(merged[1]?.lists).toEqual(fused[1]?.lists);
  });

  it("counts the models a code shared by suppliers named, the limit aside", () => {
    const hits = [{ modelId: 9, code: "5246" }, { modelId: 2, code: "5246" }, { modelId: 4, code: "12618" }];
    expect(withCodeHits(fused, hits, 2).map((model) => [model.modelId, model.matchedCodeModels])).toEqual([[9, 2], [2, 2]]);
    expect(withCodeHits(fused, hits, 24).at(2)?.matchedCodeModels).toBe(1);
  });

  it("stays within the limit and leaves the ranking alone without a code", () => {
    expect(withCodeHits(fused, [{ modelId: 9, code: "X9" }], 2).map((model) => model.modelId)).toEqual([9, 1]);
    expect(withCodeHits(fused, [], 24)).toEqual(fused);
  });
});
