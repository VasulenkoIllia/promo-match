import { describe, expect, it } from "vitest";
import type { Match } from "./conditions.js";
import { confidenceOf, type Found, type MeasuredQuery, measuredQuery } from "./confidence.js";
import type { QueryParse } from "./query-parse.js";
import type { ListName } from "./rank.js";

const QUERY: MeasuredQuery = { model: "gemini-embedding-2/1536", isRead: true, isByText: true, isLong: false, hasCloseMatch: true };

function found(similarity: number | undefined, overrides: Partial<Found> = {}): Found {
  return {
    rank: 5, matchedCode: null, matchedCodeModels: null, conditionMatch: null,
    lists: similarity === undefined ? {} : { "text-text": { similarity } }, ...overrides,
  };
}

function asked(volumeMl: Match | null, materials: Match | null = null): Found["conditionMatch"] {
  return { volumeMl, materials, sizeCm: null, printTechniques: null, sheets: null, gsm: null };
}

const percentOf = (each: Found, query: MeasuredQuery = QUERY) => confidenceOf(each, query)?.percent;

describe("confidenceOf", () => {
  it("rises with the closest text, in steps of five, between 5 and 95", () => {
    expect([0.2, 0.6, 0.67, 0.7, 0.75, 0.8, 0.95].map((similarity) => percentOf(found(similarity)))).toEqual([5, 20, 50, 60, 80, 90, 95]);
  });

  it("falls with the place below the top 10, not inside it", () => {
    const at = (rank: number) => percentOf(found(0.75, { rank }));
    expect(at(1)).toBe(at(10));
    expect([at(10), at(50), at(100)]).toEqual([80, 70, 70]);
  });

  it("falls for a long query, which asks for more", () => {
    expect(percentOf(found(0.75), { ...QUERY, isLong: true })).toBe(55);
  });

  it("puts what fits above what the catalogue does not say, and both above what goes against", () => {
    const at = (conditionMatch: Found["conditionMatch"]) => percentOf(found(0.75, { conditionMatch }));
    expect(at(asked("fits"))).toBe(60);
    expect(at(asked("unknown"))).toBe(40);
    // One unknown among fits is unknown, one against among any is against
    expect(at(asked("fits", "unknown"))).toBe(40);
    expect(at(asked("fits", "against"))).toBe(25);
    // A query's exclusions alone say nothing here
    expect(at(asked(null))).toBe(80);
  });

  it("holds a result against the query at 25 however close its text", () => {
    expect(percentOf(found(0.9, { conditionMatch: asked("against") }))).toBe(25);
    expect(percentOf(found(0.6, { conditionMatch: asked("against") }))).toBe(25);
  });

  it("gives 5 when no text is near the query, whatever the rest says", () => {
    const query = { ...QUERY, hasCloseMatch: false };
    expect(confidenceOf(found(0.69, { conditionMatch: asked("fits") }), query)).toEqual({ percent: 5, level: "low" });
  });

  it("takes a model found by a photo of a text query for a weaker one", () => {
    expect(percentOf(found(undefined))).toBe(40);
  });

  it("goes by the place alone for a photo without a text", () => {
    const query = { ...QUERY, isByText: false, hasCloseMatch: null };
    const at = (rank: number) => percentOf(found(undefined, { rank }), query);
    expect([at(1), at(24), at(100)]).toEqual([50, 15, 5]);
  });

  it("says three levels by the percent", () => {
    const levelAt = (similarity: number) => confidenceOf(found(similarity), QUERY)?.level;
    expect(levelAt(0.75)).toBe("high");
    expect(levelAt(0.7)).toBe("medium");
    expect(levelAt(0.6)).toBe("low");
  });

  it("takes a code the query named for a fact, on any model and with no reading", () => {
    const named = found(undefined, { matchedCode: "VA057", matchedCodeModels: 1 });
    expect(confidenceOf(named, QUERY)).toEqual({ percent: 100, level: "high" });
    expect(confidenceOf(named, { ...QUERY, model: "voyage-multimodal-3.5/1024", isRead: false })).toEqual({ percent: 100, level: "high" });
  });

  it("gives a code several suppliers share one chance in their number, on the same steps", () => {
    const shared = (models: number) => confidenceOf(found(0.95, { matchedCode: "5246", matchedCodeModels: models }), QUERY);
    expect(shared(2)).toEqual({ percent: 50, level: "medium" });
    expect(shared(3)).toEqual({ percent: 35, level: "low" });
    expect(shared(1)).toEqual({ percent: 100, level: "high" });
  });

  it("gives no number for what was never measured", () => {
    expect(confidenceOf(found(0.8), { ...QUERY, model: "voyage-multimodal-3.5/1024" })).toBeNull();
    expect(confidenceOf(found(0.8), { ...QUERY, isRead: false })).toBeNull();
  });
});

describe("measuredQuery", () => {
  const model = "gemini-embedding-2/1536";
  const textLists: ListName[] = ["text-photo", "text-text"];
  const read = { status: "ok" } as QueryParse;

  it("counts words from six", () => {
    expect(measuredQuery(model, "термочашка з тканинною ручкою біла", textLists, read, true).isLong).toBe(false);
    expect(measuredQuery(model, "  термочашка з тканинною ручкою біла 300  ", textLists, read, true).isLong).toBe(true);
  });

  it("takes a text Claude read for measured", () => {
    expect(measuredQuery(model, "mug", textLists, read, true)).toEqual({ model, isRead: true, isByText: true, isLong: false, hasCloseMatch: true });
  });

  it("does not take a text that went without a reading, failed or never asked for", () => {
    expect(measuredQuery(model, "mug", textLists, { status: "unavailable" } as QueryParse, null).isRead).toBe(false);
    expect(measuredQuery(model, "mug", textLists, null, null).isRead).toBe(false);
  });

  it("needs no reading for a photo alone, nor for a text that only named a category beside it", () => {
    const photoLists: ListName[] = ["image-photo", "image-text"];
    expect(measuredQuery(model, undefined, photoLists, null, null)).toEqual({ model, isRead: true, isByText: false, isLong: false, hasCloseMatch: null });
    expect(measuredQuery(model, "кружка", photoLists, read, null).isByText).toBe(false);
  });
});
