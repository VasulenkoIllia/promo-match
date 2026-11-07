// Axpol's technique codes on the shared list. Its API gives codes alone (docs/requirements.md, open question 3); the
// families are those its own marking pages name (axpol.com/pl/27-Znakowanie.html, read 2026-10-31). A letter after a
// code's number (L2A, S1A) is not explained there and counts as the family. H and PL are on no page, so they stay
// unconfirmed, as any code that comes later. Pure.
import { isRecord } from "../normalize.js";
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";

const RULES: readonly PrintRule[] = [
  [/^TF\d/, ["transfer"]],
  [/^DTF\d/, ["transfer"]],
  [/^DDC\d/, ["digital"]],
  [/^FC\d/, ["digital"]],
  [/^UV360-/, ["digital", "wrap"]],
  [/^TC\d/, ["embossing"]],
  [/^T\d/, ["pad"]],
  // Its table: L4 is "na okrągło"
  [/^L4/, ["laser", "wrap"]],
  [/^L\d/, ["laser"]],
  [/^SL$/, ["sublimation"]],
  [/^S\d/, ["screen"]],
  [/^D\d?$/, ["doming"]],
];

function codesOf(printing: unknown): string[] {
  if (!Array.isArray(printing)) return [];
  return printing.flatMap((position: unknown) => {
    const techniques = isRecord(position) ? position.techniques : null;
    return Array.isArray(techniques) ? techniques.filter((code): code is string => typeof code === "string") : [];
  });
}

// Each colour's printing, as printingOf in ./normalize.ts keeps it: a few models offer another technique on one colour
export function axpolPrintTechniques(printings: unknown[]): PrintFact[] {
  return printFacts(printings.flatMap(codesOf), RULES);
}
