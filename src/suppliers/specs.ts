// A model's capacity, materials and size in one shape for every source (docs/integrations.md, «Об'єм, матеріали,
// розміри»). One parser: an adapter only hands over the fields it has (ModelInput.specFields), so what a search asks of a
// model means the same whatever the supplier. Pure.
import { type MaterialCode, readMaterials } from "./materials.js";
import { parseDecimal } from "./normalize.js";
import type { ModelInput } from "./types.js";

export interface ModelSpecs {
  // The capacity in millilitres; null: no text gives it
  volumeMl: number | null;
  // The first is the one a supplier lists first, which is the body of the product where it lists more
  materials: MaterialCode[];
  // The sides in centimetres, longest first (a diameter is a side): suppliers keep no order of the axes
  sizesCm: number[];
  // The sheets of a pad or a notebook; null: no text gives them
  sheets: number | null;
  // The weight of its paper or fabric in g/m2; null: no text gives it
  gsm: number | null;
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const VOLUME_UNIT = String.raw`(ml|cl|dl|l|litres?|liters?)`;
const MENTION = new RegExp(String.raw`(?<![\w.,])(${NUMBER})\s*-?\s*${VOLUME_UNIT}\b`, "gi");
// The capacity named as such outranks any other number in the text: "for 6 1,5l bottles. Capacity 12,5L"
const CAPACITY = new RegExp(String.raw`\b(?:capacity|volume|holds?)\b[^.|]{0,30}?(?<![\w.,])(${NUMBER})\s*-?\s*${VOLUME_UNIT}\b`, "i");
const SENTENCE_END = /(?<=[.!?])\s+/;
// A text may count what the product saved, not what it holds: "saves 7 litres of water", "reused 9 0.5L PET bottles"
const NOT_ITS_CAPACITY = /\b(?:saves?|saved|saving|reused?|of water|pet bottles?)\b/i;
// By the first letter of the unit
const MILLILITRES_PER: Record<string, number> = { m: 1, c: 10, d: 100, l: 1_000 };
const MAX_VOLUME_ML = 100_000;

const SIDE = String.raw`(?:ø|⌀|dia\.?\s*)?\s*\d+(?:\.\d+)?`;
const SIDES = new RegExp(String.raw`(${SIDE}(?:\s*[x*×]\s*${SIDE})*)\s*(mm|cm|m)?\b`, "g");
const SIDE_MARK = /\s*[x*×]\s*/;
const DECIMAL_COMMA = /(\d),(\d)/g;
const UNIT_BEFORE_NEXT_SIDE = /cm\s*(?=x)/g;
const CENTIMETRES_PER: Record<string, number> = { mm: 0.1, cm: 1, m: 100 };
const SIDE_PLACES = 100;
const MAX_SIDE_CM = 99_999;

// "80 lined sheets", "192 lined recycled paper (96 sheets)", "160 pages", "144 pg."; "12 colours page markers" counts no page
// The words of paper alone: "ISLAND 100 BATH SHEET" is no pad
const SHEET_WORDS = String.raw`(?:(?:lined|blank|plain|squared|dotted|ruled|grid|recycled|recyced|paper|cream|creamy|cream-colou?red|colou?red|colouring|white|sticky|note|grass|stone|bamboo|mineral|kraft)\s+){0,4}`;
const SHEETS = new RegExp(String.raw`(?<![\w.,])(\d{2,3})\s*${SHEET_WORDS}(?:sheets?|leaves)\b`, "i");
const PAGES = new RegExp(String.raw`(?<![\w.,])(\d{2,3})\s*${SHEET_WORDS}(?:pages?|pg)\b(?!\s+markers?)`, "i");
const PAGES_PER_SHEET = 2;
// "160 gr/m²", "80g/m2", "58 gm/m2", "70gsm"; a bare "190gr" may as well be the weight of the product
const GSM = /(?<![\w.,])(\d{2,3})\s*(?:(?:g|gr|gm|gram|grams)\s*\/\s*(?:m2|m²|sqm)|gsm)(?!\w)/gi;

function millilitres(amount: string, unit: string): number | null {
  const volume = Math.round(Number(parseDecimal(amount)) * (MILLILITRES_PER[unit.charAt(0).toLowerCase()] ?? 0));
  return volume > 0 && volume <= MAX_VOLUME_ML ? volume : null;
}

function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_END).filter((sentence) => !NOT_ITS_CAPACITY.test(sentence));
}

function capacityIn(sentences: string[]): number | null {
  for (const sentence of sentences) {
    const match = CAPACITY.exec(sentence);
    const volume = match?.[1] && match[2] ? millilitres(match[1], match[2]) : null;
    if (volume !== null) return volume;
  }
  return null;
}

function firstMentionIn(sentences: string[]): number | null {
  for (const sentence of sentences) {
    for (const [, amount, unit] of sentence.matchAll(MENTION)) {
      const volume = amount && unit ? millilitres(amount, unit) : null;
      if (volume !== null) return volume;
    }
  }
  return null;
}

// The supplier's own field first, then the text named as the capacity, then the first volume, the most specific text
// first: a set says its main item first ("Thermos 500 ml with 2 mugs 260 ml")
export function readVolumeMl(field: string | null, texts: string[]): number | null {
  const fromField = field ? firstMentionIn([field]) : null;
  if (fromField !== null) return fromField;
  const sentences = texts.flatMap(sentencesOf);
  return capacityIn(sentences) ?? firstMentionIn(sentences);
}

function sidesOf(group: string, unit: string | undefined): number[] {
  const factor = CENTIMETRES_PER[unit ?? "cm"] ?? 1;
  return group.split(SIDE_MARK).map((side) => Number(side.replaceAll(/[^\d.]/g, "")) * factor)
    .map((side) => Math.round(side * SIDE_PLACES) / SIDE_PLACES)
    .filter((side) => side > 0 && side <= MAX_SIDE_CM);
}

// The first group of sides in the text, the product's own: "28 x 35 cm (handles 60 cm)". A lone number without a unit
// is no size ("One size: 3 (10 x 20 cm)"); no unit after sides is centimetres, as everywhere else in these feeds.
export function readSizesCm(text: string | null): number[] {
  if (!text) return [];
  const cleaned = text.toLowerCase().replace(DECIMAL_COMMA, "$1.$2").replace(UNIT_BEFORE_NEXT_SIDE, "");
  for (const [, group, unit] of cleaned.matchAll(SIDES)) {
    if (!group || (!unit && !SIDE_MARK.test(group))) continue;
    const sides = sidesOf(group, unit);
    if (sides.length) return sides.sort((left, right) => right - left);
  }
  return [];
}

function firstNumber(pattern: RegExp, texts: string[]): number | null {
  for (const text of texts) {
    const match = pattern.exec(text);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

// Sheets where a text names them, as the sheet of a catalogue is less often loose than its page; a page is half a sheet
export function readSheets(texts: string[]): number | null {
  const pages = firstNumber(PAGES, texts);
  return firstNumber(SHEETS, texts) ?? (pages === null ? null : Math.round(pages / PAGES_PER_SHEET));
}

// Only a text with one value: "500 gsm hard cover, 70 blank 70 gsm pages" names two things, and nothing says which is asked
export function readGsm(texts: string[]): number | null {
  const values = new Set(texts.flatMap((text) => [...text.matchAll(GSM)].map(([, value]) => Number(value))));
  return values.size === 1 ? [...values][0] ?? null : null;
}

export function specsOf(model: ModelInput): ModelSpecs {
  const texts = [model.name.en, ...model.specFields.texts, model.description.en].filter((text) => text !== undefined);
  return {
    volumeMl: readVolumeMl(model.specFields.volume, texts),
    materials: readMaterials(model.material.en ?? ""),
    sizesCm: readSizesCm(model.dimensions),
    sheets: readSheets(texts),
    gsm: readGsm(texts),
  };
}
