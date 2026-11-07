// The shared list of print techniques, one for every source, the way the shared categories and materials are. Each
// supplier has codes of its own, and a code may mean another technique elsewhere: T1 is pad printing at Axpol and screen
// transfer at Midocean, so each adapter holds its own rules (docs/integrations.md, «Техніка друку»). Pure.

export const PRINT_TECHNIQUES = [
  "laser", "embroidery", "pad", "screen", "transfer", "sublimation", "digital", "embossing", "doming", "wrap",
] as const;

export type PrintTechnique = (typeof PRINT_TECHNIQUES)[number];

// A code nothing explains is not "does not offer it": on a card it leaves a technique unknown
export const UNCONFIRMED_PRINT = "unconfirmed";

export type PrintFact = PrintTechnique | typeof UNCONFIRMED_PRINT;

// What a supplier writes, and the techniques it stands for; the first rule that matches wins
export type PrintRule = readonly [RegExp, readonly PrintTechnique[]];

export function isPrintTechnique(value: string): value is PrintTechnique {
  return (PRINT_TECHNIQUES as readonly string[]).includes(value);
}

export function isPrintFact(value: string): value is PrintFact {
  return value === UNCONFIRMED_PRINT || isPrintTechnique(value);
}

export function printFacts(labels: string[], rules: readonly PrintRule[]): PrintFact[] {
  const facts = labels.flatMap((label): readonly PrintFact[] =>
    rules.find(([pattern]) => pattern.test(label))?.[1] ?? [UNCONFIRMED_PRINT]);
  return [...new Set(facts)].sort();
}
