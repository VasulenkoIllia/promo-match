// A candidate shape of the model text for the independent test (README «Незалежний тест», owner's decision 2026-11-06):
// the name without its brand words. One source names a pen "Ball pen", another "Pen Blavix", "PENEVER" or "MANZONI - Pen
// set", and the invented word dilutes the vector, so texts that only say the kind stood near every query of that kind
// (report «Критичний аналіз пошуку 2026-11-06», section 1, outside git). A brand word here is a word of the name that the
// catalogue's prose does not use: fewer than BRAND_WORD_MIN_MODELS descriptions of other models have it. That takes
// invented and place names and a third party's brand few descriptions name, and keeps the kind, materials, sizes,
// "USB", "RPET". No source is named: every name goes through the same count over the whole catalogue. Only the name
// changes: a rare word of the description may be the only one that says what the product is ("ski pass").
import { textUnderName, type ModelTextFields } from "./text.js";
import type { TextInput } from "./provider.js";

// Five of 15.6 thousand descriptions (2026-11-06): a product line that repeats its name in its own descriptions stays
// under it, a word of the trade passes it
export const BRAND_WORD_MIN_MODELS = 5;

// Letters and digits, with an apostrophe inside ("waiter's")
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// What is left of "(Hama)" or "\"keya\"" once the word is out
const EMPTY_PAIR = /^(?:\(\)|\[\]|""|''|“”|„“|«»|‘’)$/;
// What joined a word to the one taken out
const JOINER_AT_EDGE = /^[-–/+&]+|[-–/+&]+$/g;
// Punctuation that sticks to the word before it
const SPACE_BEFORE_MARK = /\s+([,.:;!?])/g;

function lowerWords(text: string | null): string[] {
  return (text?.match(WORD) ?? []).map((word) => word.toLowerCase());
}

// How many models' descriptions use each word, in lower case
export type DescriptionWords = ReadonlyMap<string, number>;

export function descriptionWords(descriptions: readonly (string | null)[]): DescriptionWords {
  const counts = new Map<string, number>();
  for (const description of descriptions) {
    for (const word of new Set(lowerWords(description))) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

// The words of the name that fewer than BRAND_WORD_MIN_MODELS other descriptions use: its own description does not
// count, or a source that repeats the name there ("Backpack ABERDEEN : ...") would vouch for it itself
export function brandWords(fields: Pick<ModelTextFields, "name" | "description">, counts: DescriptionWords): Set<string> {
  const own = new Set(lowerWords(fields.description));
  return new Set(lowerWords(fields.name).filter((word) =>
    (counts.get(word) ?? 0) - (own.has(word) ? 1 : 0) < BRAND_WORD_MIN_MODELS));
}

// The text without these words, and without the marks they leave alone: "ABERDEEN - Backpack" gives "Backpack",
// "Steel Bidon PATRO 600 ml" "Steel Bidon 600 ml" when only PATRO goes
export function withoutWords(text: string, words: ReadonlySet<string>): string {
  const tokens = text.split(/\s+/).map((token) => {
    const kept = token.replace(WORD, (word) => (words.has(word.toLowerCase()) ? "" : word));
    // "Metal-Touchpen" without its second word is "Metal", not "Metal-"
    return kept !== token && LETTER_OR_DIGIT.test(kept) ? kept.replace(JOINER_AT_EDGE, "") : kept;
  }).filter((token) => token && !EMPTY_PAIR.test(token));
  const isMark = (token: string | undefined) => token !== undefined && !LETTER_OR_DIGIT.test(token);
  const kept = tokens.filter((token, index) => !isMark(token) || !isMark(tokens[index - 1]));
  while (isMark(kept[0])) kept.shift();
  while (isMark(kept.at(-1))) kept.pop();
  return kept.join(" ").replace(SPACE_BEFORE_MARK, "$1");
}

// Undefined for a model without an English name, as its own text. A name of brand words alone leaves the description
// to speak; with no description either, the whole name stays, or the model would have no text.
export function brandFreeText(fields: ModelTextFields, counts: DescriptionWords): TextInput | undefined {
  const name = fields.name?.trim();
  if (!name) return undefined;
  const kept = withoutWords(name, brandWords(fields, counts));
  return textUnderName(kept || (fields.description?.trim() ? "" : name), fields);
}
