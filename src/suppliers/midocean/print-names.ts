// Midocean's print techniques on the shared list, by the English name its printdata gives a code, so a new code with a
// known name needs no change here. Pure.
import { isRecord } from "../normalize.js";
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";
import type { PrintTechniqueInput } from "../types.js";

// "Screen transfer" and "Digital transfer" are transfers: the order matters
const RULES: readonly PrintRule[] = [
  [/transfer/i, ["transfer"]],
  [/^round laser/i, ["laser", "wrap"]],
  [/^round screen/i, ["screen", "wrap"]],
  [/^round digital/i, ["digital", "wrap"]],
  [/laser/i, ["laser"]],
  [/screen/i, ["screen"]],
  [/embroider/i, ["embroidery"]],
  [/^pad/i, ["pad"]],
  [/sublimation/i, ["sublimation"]],
  [/emboss|deboss/i, ["embossing"]],
  [/doming/i, ["doming"]],
  // Printed apart and put on the product: no print on it, and no technique of the list, though the name is known
  [/label|inlay|button/i, []],
  [/digital|direct to garment/i, ["digital"]],
];

function codesOf(printing: unknown): string[] {
  const positions = isRecord(printing) ? printing.positions : null;
  if (!Array.isArray(positions)) return [];
  return positions.flatMap((position: unknown) => {
    const techniques = isRecord(position) ? position.techniques : null;
    if (!Array.isArray(techniques)) return [];
    return techniques.flatMap((technique: unknown) =>
      (isRecord(technique) && typeof technique.code === "string" ? [technique.code] : []));
  });
}

// The printing as printingOf in ./normalize.ts keeps it; a code the dictionary lacks is unconfirmed
export function midoceanPrintTechniques(printing: unknown, techniques: PrintTechniqueInput[]): PrintFact[] {
  const names = new Map(techniques.map(({ code, name }) => [code, name.en ?? ""]));
  return printFacts(codesOf(printing).map((code) => names.get(code) ?? ""), RULES);
}
