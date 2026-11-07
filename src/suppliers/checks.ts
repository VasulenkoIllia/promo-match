// Data checks an adapter counts for the import report: a name, how many times it was met and a few codes to look at.
// A record or value the import leaves out is always counted here, never dropped without a word.
import { FeedError } from "./errors.js";
import { cleanText, isBlank, isRecord, parseAmount, parseDecimal, parseGrams } from "./normalize.js";

const MAX_EXAMPLES = 5;
const GRAMS_PER_KILOGRAM_PLACES = 3;
const LEFTOVER_ENTITY = /&#?[a-z0-9]+;/i;

export class Checks {
  readonly counts: Record<string, number> = {};
  readonly examples: Record<string, string[]> = {};

  add(name: string, example?: string): void {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    if (example === undefined) return;
    const list = (this.examples[name] ??= []);
    if (list.length < MAX_EXAMPLES) list.push(example);
  }

  // A parsed value; a value the supplier sent but the parser could not read (garbage, out of a column's range) is
  // counted as "unreadable <label>", while a missing one is just null
  read<T>(label: string, raw: unknown, parse: (value: unknown) => T | null, example?: string): T | null {
    const value = parse(raw);
    if (value === null && !isBlank(raw)) this.add(`unreadable ${label}`, example);
    return value;
  }

  // A price: 0 or a blank means the supplier has none; a negative amount or one too large for the column is counted
  amount(label: string, raw: unknown, example?: string): string | null {
    const decimal = parseDecimal(raw);
    if (decimal !== null && Number(decimal) === 0) return null;
    return this.read(label, raw, parseAmount, example);
  }

  // The records of an array; anything else in it (a string, a number, null) is counted, not dropped silently
  records(value: unknown, label: string, example?: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    const records = value.filter(isRecord);
    for (let index = records.length; index < value.length; index += 1) this.add(`${label} that are not objects`, example);
    return records;
  }
}

// Byte order, not the locale's: the same input sorts the same everywhere
export function compareCodes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// An entity the cleaning did not know (normalize.ts decodes the common ones)
export function hasLeftoverEntity(texts: Record<string, string>): boolean {
  return Object.values(texts).some((text) => LEFTOVER_ENTITY.test(text));
}

// The records of a whole feed that is an array at its root (Inspirion, Blue Collection, Makito). Every such feed is
// required: an empty one would mark the whole catalogue, its prices or its stock inactive, so it stops the import.
export function requiredRecords(value: unknown, feed: string, checks: Checks): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new FeedError(`${feed}: no array of records`);
  const records = checks.records(value, `${feed} records`);
  if (!records.length) throw new FeedError(`${feed}: no records`);
  return records;
}

// Records by a key unique across the whole catalogue (a feed's id, a variant's sku across all models): the first record
// of a key is kept, one without the key or with a key already in seen is counted
export function uniqueRecords(rows: Record<string, unknown>[], field: string, seen: Set<string>, label: string,
  checks: Checks, code?: string): [string, Record<string, unknown>][] {
  const result: [string, Record<string, unknown>][] = [];
  for (const row of rows) {
    const key = cleanText(row[field]);
    if (!key) checks.add(`${label} without ${field}`, code);
    else if (seen.has(key)) checks.add(`${label} with a repeated ${field}`, key);
    else result.push([key, row]);
    if (key) seen.add(key);
  }
  return result;
}

export function recordsByKey(rows: Record<string, unknown>[], field: string, feed: string, checks: Checks):
  Map<string, Record<string, unknown>> {
  return new Map(uniqueRecords(rows, field, new Set(), `${feed} records`, checks));
}

// A weight in grams from a value in g or kg; another unit is counted, not guessed
export function weightInGrams(value: unknown, unit: unknown, checks: Checks, code: string): string | null {
  const name = cleanText(unit)?.toLowerCase();
  const places = name === "kg" ? GRAMS_PER_KILOGRAM_PLACES : name === "g" ? 0 : null;
  if (places === null) {
    if (!isBlank(value)) checks.add("weights with an unknown unit", code);
    return null;
  }
  return checks.read("weights", value, (raw) => parseGrams(raw, places), code);
}
