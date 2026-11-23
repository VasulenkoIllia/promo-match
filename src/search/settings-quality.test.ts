import { describe, expect, it } from "vitest";
import { CODE_DEFAULT_SETTINGS } from "./settings.js";
import { type JournalSearch, qualityByVariant, qualityLines } from "./settings-quality.js";

const decides = { ...CODE_DEFAULT_SETTINGS, photoOrder: "photo-decides" };
const row = (settings: unknown, firstExactRank: number | null, grades = 3, hasText = false): JournalSearch =>
  ({ settings, hasPhoto: true, hasText, grades, firstExactRank });

describe("qualityByVariant", () => {
  const variants = qualityByVariant([
    row(CODE_DEFAULT_SETTINGS, 1), row(CODE_DEFAULT_SETTINGS, 4, 3, true), row(CODE_DEFAULT_SETTINGS, null, 0),
    row(decides, 1), row(decides, 2), row(decides, 12), row({ ...decides, removedSwitch: true }, null),
  ]);

  it("groups the searches by their settings, a key a release does not know aside, the most graded first", () => {
    expect(variants.map((variant) => variant.changed)).toEqual([["photoOrder"], []]);
  });

  it("counts where the first exact model stood in the graded searches", () => {
    expect(variants[0]?.places.all).toEqual({ searches: 4, graded: 4, first: 1, topFew: 2, topMany: 2, below: 1, noExact: 1 });
    expect(variants[1]?.places.all).toEqual({ searches: 3, graded: 2, first: 1, topFew: 1, topMany: 2, below: 0, noExact: 0 });
    expect(variants[1]?.places["photo-text"]).toMatchObject({ graded: 1, topMany: 1, first: 0 });
  });

  it("prints a variant by its changed settings and each kind of search it had", () => {
    const lines = qualityLines(variants);
    expect(lines[0]).toBe("variant 1: photoOrder photo-decides");
    expect(lines[1]).toBe("  all: 4 graded of 4 searches; the first exact first 1 (25%), in the top 3 2 (50%), in the top 10 2 (50%), below 1, no exact 1");
    expect(lines).toContain("variant 2: the code's defaults, the search of before the switches");
    expect(lines.filter((line) => line.startsWith("  text:"))).toEqual([]);
  });
});
