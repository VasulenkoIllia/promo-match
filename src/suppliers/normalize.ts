// Supplier values as the database keeps them. Suppliers send numbers as text with spaces between thousands and a
// comma or a dot ("3 030", "3,40", "0.162"), HTML entities in texts and "" where a value is missing.
import type { Localized, RawInput } from "./types.js";

// A tag starts with a letter or a slash, so "< 5 cm" stays text
const HTML_TAG = /<\/?[a-z][^<>]*>/gi;
const LINE_BREAK_TAG = /<(?:br\s*\/?|\/p|\/li|\/div)>/gi;
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi;
const NAMED_ENTITY = /&([a-z][a-z0-9]*);/gi;
// Any whitespace, the no-break spaces included; control characters (Postgres refuses \u0000 in jsonb) count as space
const WHITESPACE = /[\s\u00a0\u202f\p{Cc}]+/gu;
const DIGIT_GROUP_SPACE = /[\s\u00a0\u202f']/g;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_LENGTH = 10;
const MAX_CODE_POINT = 0x10ffff;
const HEX_RADIX = 16;
// Column limits (prisma/schema.prisma): integer, and the digits before the point of price.amount numeric(12, 4)
const MAX_INTEGER = 2_147_483_647;
const AMOUNT_INTEGER_DIGITS = 8;
// weight_grams is numeric(12, 3)
const GRAMS_INTEGER_DIGITS = 9;

// The entities of Latin-1 and the Polish, German and French letters outside it; the rest stay as they are and the
// import report counts them
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", prime: "′", Prime: "″",
  deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ", para: "¶", sect: "§", copy: "©", reg: "®",
  trade: "™", euro: "€", pound: "£", cent: "¢", yen: "¥", frac12: "½", frac14: "¼", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³", Oslash: "Ø", oslash: "ø", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ", Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Ugrave: "Ù", Uacute: "Ú",
  Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
  aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì",
  iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ",
  ouml: "ö", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ", OElig: "Œ", oelig: "œ",
  Aogon: "Ą", aogon: "ą", Cacute: "Ć", cacute: "ć", Eogon: "Ę", eogon: "ę", Lstrok: "Ł", lstrok: "ł",
  Nacute: "Ń", nacute: "ń", Sacute: "Ś", sacute: "ś", Zacute: "Ź", zacute: "ź", Zdot: "Ż", zdot: "ż",
};

function decodeEntities(text: string): string {
  return text
    .replace(NUMERIC_ENTITY, (entity, code: string) => {
      const value = code[0] === "x" || code[0] === "X" ? Number.parseInt(code.slice(1), HEX_RADIX) : Number(code);
      return value > 0 && value <= MAX_CODE_POINT ? String.fromCodePoint(value) : entity;
    })
    .replace(NAMED_ENTITY, (entity, name: string) => NAMED_ENTITIES[name] ?? entity);
}

// Text without tags and entities, on one line; nothing but whitespace is no value. Numbers come as their text.
export function cleanText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  // Tags first: an escaped "&lt;b&gt;" is text the supplier meant to show
  const text = decodeEntities(value.replace(LINE_BREAK_TAG, " ").replace(HTML_TAG, " ")).replace(WHITESPACE, " ").trim();
  return text || null;
}

// A decimal as Postgres numeric reads it: "3 030" -> "3030", "3,40" -> "3.40", "1.234,56" -> "1234.56".
// A comma and a dot together: the last one is the decimal mark.
export function parseDecimal(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  let text = value.replace(DIGIT_GROUP_SPACE, "");
  const comma = text.lastIndexOf(",");
  const dot = text.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    text = comma > dot ? text.replaceAll(".", "").replace(",", ".") : text.replaceAll(",", "");
  } else if (comma !== -1) {
    text = text.replace(",", ".");
  }
  return DECIMAL.test(text) ? text : null;
}

// A whole number that fits a Postgres integer column; anything bigger would fail the whole batch
export function parseInteger(value: unknown): number | null {
  const decimal = parseDecimal(value);
  if (decimal === null) return null;
  const number = Number(decimal);
  return Number.isInteger(number) && Math.abs(number) <= MAX_INTEGER ? number : null;
}

// Whether a decimal fits numeric(precision, scale): at most this many digits before the point
export function fitsDigits(decimal: string, maxIntegerDigits: number): boolean {
  const whole = decimal.replace(/^-/, "").split(".")[0] ?? "";
  return whole.replace(/^0+/, "").length <= maxIntegerDigits;
}

// A positive amount that fits price.amount; a price of 0 means the supplier has none
export function parseAmount(value: unknown): string | null {
  const decimal = parseDecimal(value);
  return decimal !== null && Number(decimal) > 0 && fitsDigits(decimal, AMOUNT_INTEGER_DIGITS) ? decimal : null;
}

// A weight in grams that fits weight_grams, from a value in grams (places 0) or kilograms (places 3); a negative
// weight is no weight
export function parseGrams(value: unknown, places = 0): string | null {
  const decimal = parseDecimal(value);
  if (decimal === null || decimal.startsWith("-")) return null;
  const grams = places ? shiftDecimal(decimal, places) : decimal;
  return fitsDigits(grams, GRAMS_INTEGER_DIGITS) ? grams : null;
}

// A quantity a price starts from: a whole number from 1
export function parseMinQuantity(value: unknown): number | null {
  const quantity = parseInteger(value);
  return quantity !== null && quantity >= 1 ? quantity : null;
}

// No value at all, as opposed to a value no parser could read
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && cleanText(value) === null);
}

// The decimal point of a parseDecimal result moved right by places (3: kilograms to grams), on the digits, so no
// float rounding creeps in
export function shiftDecimal(decimal: string, places: number): string {
  const [whole = "", fraction = ""] = decimal.split(".");
  const digits = `${whole}${fraction.padEnd(places, "0")}`;
  const point = whole.length + places;
  const integer = digits.slice(0, point).replace(/^(-?)0+(?=\d)/, "$1");
  const rest = digits.slice(point).replace(/0+$/, "");
  return rest ? `${integer}.${rest}` : integer;
}

// A calendar date "YYYY-MM-DD" that exists, or null
export function parseDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || !ISO_DATE.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, ISO_DATE_LENGTH) !== text ? null : text;
}

// A time with its zone as Postgres timestamptz reads it; a time without a zone is left out, its zone is unknown
export function parseTimestamp(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

// An https link, or null: photos are shown in the browser and fetched by the embeddings worker
export function parseUrl(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || !URL.canParse(text)) return null;
  return new URL(text).protocol === "https:" ? text : null;
}

// Texts by language, the empty ones left out
export function localized(texts: Record<string, unknown>): Localized {
  const result: Localized = {};
  for (const [language, value] of Object.entries(texts)) {
    const text = cleanText(value);
    if (text) result[language] = text;
  }
  return result;
}

// The fields of a supplier record not mapped to a column: texts cleaned, empty ones left out, the rest as it is.
// The raw record stays in raw_record for debugging.
export function restOf(record: Record<string, unknown>, mapped: ReadonlySet<string>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (mapped.has(key) || value === null || value === undefined) continue;
    if (typeof value === "string") {
      const text = cleanText(value);
      if (text) rest[key] = text;
    } else {
      rest[key] = value;
    }
  }
  return rest;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Raw supplier records for raw_record, by the key the feed gives them
export function rawRecords(feed: string, records: Map<string, Record<string, unknown>>): RawInput[] {
  return [...records].map(([externalId, payload]) => ({ feed, externalId, payload }));
}
