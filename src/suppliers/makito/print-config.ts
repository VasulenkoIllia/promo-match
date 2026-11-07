// Makito's print areas (docs/integrations.md, «Makito API B2B»): `print-config` is { generatedAt, lang, products[] }, a
// product's id is the model's ref and each of its areas lists the techniques it can be marked with as ids of the print
// price list, "100123(4)" with the colours in brackets, "100400" without them, several after commas and now and then
// two stuck together ("100114(1)100400(1)", 2026-11-04). `print-price-list` is { generatedAt, printPriceList[] }, a row of
// it { id, code, category } with the technique's name in `category`. Pure.
import { type Checks, recordsByKey } from "../checks.js";
import { cleanText, isRecord } from "../normalize.js";

const TECHNIQUE_ID = /(\d{6})(?:\(\d+\))?/g;
const SEPARATORS = /[\s,]/g;

export interface PrintAreas {
  // ref -> the price list's names of the techniques of the model's areas, each once; an unknown id is an empty name
  namesByRef: Map<string, string[]>;
  // The records of print-config by ref, for raw_record
  raw: Map<string, Record<string, unknown>>;
  priceListNames: number;
}

function namesOf(product: Record<string, unknown>, names: Map<string, string>, checks: Checks, ref: string): string[] {
  const found = new Set<string>();
  const areas = checks.records(product.areas, "print areas", ref);
  if (!areas.length) checks.add("models in print-config without areas", ref);
  for (const area of areas) {
    // A field that is not a text (renamed, an array, null) reads as no ids at all, and that is counted too
    const text = cleanText(area.techniques) ?? "";
    const ids = [...text.matchAll(TECHNIQUE_ID)].map(([, id = ""]) => id);
    if (!ids.length) checks.add("print areas without readable techniques", ref);
    for (const id of ids) {
      const name = names.get(id);
      if (name === undefined) checks.add("print technique ids not in the print price list", id);
      found.add(name ?? "");
    }
    if (text.replace(TECHNIQUE_ID, "").replace(SEPARATORS, "")) checks.add("print area techniques that are not read", ref);
  }
  return [...found];
}

// Both files, or none: a file that is not the one it should be is no reason to stop the import, whose techniques then
// come from the categories alone, so it is a warning. undefined means the adapter did not read them and said why.
export function readPrintAreas(config: unknown, priceList: unknown, checks: Checks): { areas: PrintAreas | null; warnings: string[] } {
  if (config === undefined && priceList === undefined) return { areas: null, warnings: [] };
  const products = isRecord(config) ? checks.records(config.products, "print-config products") : [];
  const rows = isRecord(priceList) ? checks.records(priceList.printPriceList, "print-price-list records") : [];
  if (!products.length || !rows.length) {
    return {
      areas: null,
      warnings: [`print-config: ${products.length} products and ${rows.length} price list rows read, print techniques come from the categories only`],
    };
  }
  const names = new Map([...recordsByKey(rows, "id", "print-price-list", checks)].map(([id, row]) => [id, cleanText(row.category) ?? ""] as const));
  const raw = recordsByKey(products, "id", "print-config", checks);
  const namesByRef = new Map([...raw].map(([ref, product]) => [ref, namesOf(product, names, checks, ref)] as const));
  return { areas: { namesByRef, raw, priceListNames: names.size }, warnings: [] };
}
