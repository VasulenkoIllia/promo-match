import { describe, expect, it } from "vitest";
import type { CategoryEntry } from "../categories/taxonomy.js";
import { categoriesNamedAlone } from "./category-word.js";

const entry = (code: string, en: string, parent: string | null = null): CategoryEntry =>
  ({ code, parent, name: { uk: en, en }, position: 0 });
const categories = [entry("drinkware", "Drinkware"), entry("drinkware.mugs", "Mugs & cups", "drinkware"),
  entry("bags.drawstring", "Drawstring bags", "bags")];

describe("categoriesNamedAlone", () => {
  it("takes a phrase of the category's own words, in the singular or the plural", () => {
    expect(categoriesNamedAlone(["mug"], ["drinkware.mugs"], categories)).toEqual(["drinkware.mugs"]);
    expect(categoriesNamedAlone(["mugs and cups"], ["drinkware.mugs"], categories)).toEqual(["drinkware.mugs"]);
    expect(categoriesNamedAlone(["drawstring bag"], ["bags.drawstring"], categories)).toEqual(["bags.drawstring"]);
    expect(categoriesNamedAlone(["drinkware"], ["drinkware"], categories)).toEqual(["drinkware"]);
  });

  it("leaves a text with a trait of its own to the lists", () => {
    expect(categoriesNamedAlone(["black mug"], ["drinkware.mugs"], categories)).toEqual([]);
    expect(categoriesNamedAlone(["ceramic mug"], ["drinkware.mugs"], categories)).toEqual([]);
    expect(categoriesNamedAlone(["mug 300 ml"], ["drinkware.mugs"], categories)).toEqual([]);
  });

  it("needs one product and a category the reading named", () => {
    expect(categoriesNamedAlone(["mug", "cup"], ["drinkware.mugs"], categories)).toEqual([]);
    expect(categoriesNamedAlone([], ["drinkware.mugs"], categories)).toEqual([]);
    expect(categoriesNamedAlone(["mug"], [], categories)).toEqual([]);
    expect(categoriesNamedAlone(["the and of"], ["drinkware.mugs"], categories)).toEqual([]);
    expect(categoriesNamedAlone(["mug"], ["bags.drawstring"], categories)).toEqual([]);
  });
});
