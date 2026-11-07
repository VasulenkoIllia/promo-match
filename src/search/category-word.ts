// A text that only names a category beside a reference photo: "mugs" says what the photo shows already, yet on RRF's equal
// votes its lists outvote the photo, and the very product falls out of the top (README «Незалежний тест»). Such a text
// adds no lists: the photo finds the product, and the category it names lifts what is in it by a factor. The call is
// the code's, by the words: a text with any trait of its own (a colour, a material, a number) is not a category's name.
// Knows no source. Pure.
import type { CategoryEntry } from "../categories/taxonomy.js";

// The factor on the fused score of a model in the category; 1 drops the text's lists and lifts nothing, null is off. 3
// passed the frozen final set of 2026-10-31 (README «Незалежний тест», docs/decisions.md); another value needs a new one.
export const DEFAULT_CATEGORY_LIFT: number | null = 3;

const SERVICE_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);

export function categoryLiftOf({ categoryLift }: { categoryLift?: number | null }): number | null {
  return categoryLift === undefined ? DEFAULT_CATEGORY_LIFT : categoryLift;
}

function singular(word: string): string {
  return word.replace(/ies$/, "y").replace(/(s|x|ch|sh)es$/, "$1").replace(/s$/, "");
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !SERVICE_WORDS.has(word)).map(singular);
}

// The category codes a text comes down to, or none: one product, a category named, and no word outside its names
export function categoriesNamedAlone(phrases: string[], codes: string[], categories: CategoryEntry[]): string[] {
  const [phrase, ...others] = phrases;
  if (phrase === undefined || others.length || !codes.length) return [];
  const names = categories.filter((entry) => codes.includes(entry.code)).flatMap((entry) => wordsOf(entry.name.en));
  const words = wordsOf(phrase);
  return words.length && words.every((word) => names.includes(word)) ? codes : [];
}
