import { describe, expect, it } from "vitest";
import { colorGroupsOf, hasColor } from "./colors.js";

describe("colorGroupsOf", () => {
  it("reads a name in English or in the Polish a feed leaves in", () => {
    expect(colorGroupsOf("Navy Blue")).toEqual(["blue"]);
    expect(colorGroupsOf("czerwony")).toEqual(["red"]);
    expect(colorGroupsOf("Biały")).toEqual(["white"]);
    expect(colorGroupsOf("żółty")).toEqual(["yellow"]);
    expect(colorGroupsOf("róż")).toEqual(["pink"]);
  });

  it("gives a name of two colours both groups", () => {
    expect(colorGroupsOf("black/red")).toEqual(["black", "red"]);
  });

  it("places a name no rule knows in no group", () => {
    expect(colorGroupsOf("Sunset")).toEqual([]);
  });

  it("reads Makito's golden and hunter, and leaves its S/C without a colour", () => {
    expect(colorGroupsOf("GOLDEN")).toEqual(["gold"]);
    expect(colorGroupsOf("HUNTER")).toEqual(["green"]);
    expect(colorGroupsOf("RED / GOLD")).toEqual(["red", "gold"]);
    expect(colorGroupsOf("S/C")).toEqual([]);
  });

  it("reads whole words: a burgundy is red and a credit card is no red", () => {
    expect(colorGroupsOf("burgundy")).toEqual(["red"]);
    expect(colorGroupsOf("credit")).toEqual([]);
  });
});

describe("hasColor", () => {
  it("is true when one variant has the colour", () => {
    expect(hasColor(["white", "orange"], ["orange"])).toBe(true);
  });

  it("is false for a model with no colours read", () => {
    expect(hasColor([], ["orange"])).toBe(false);
    expect(hasColor(["white"], ["orange"])).toBe(false);
  });
});
