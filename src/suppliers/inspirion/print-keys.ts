// Inspirion's print techniques on the shared list, by the print_technique_key of each branding method. Pure.
import { isRecord } from "../normalize.js";
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";

// The ten keys of the catalogue (2026-11-04); a 360 key prints all round. Transfer keys go before the digital one:
// digital_transfer is a transfer, the order matters.
const RULES: readonly PrintRule[] = [
  [/transfer/i, ["transfer"]],
  [/^digital_direct_print_360$/i, ["digital", "wrap"]],
  [/^digital/i, ["digital"]],
  [/^silkscreen_360$/i, ["screen", "wrap"]],
  [/^silkscreen/i, ["screen"]],
  [/^engraving/i, ["laser"]],
  [/^pad_print/i, ["pad"]],
  [/^doming/i, ["doming"]],
];

// branding_methods as the product gives them; a method without a key is unconfirmed
export function inspirionPrintTechniques(methods: unknown): PrintFact[] {
  if (!Array.isArray(methods)) return [];
  return printFacts(methods.map((method: unknown) =>
    (isRecord(method) && typeof method.print_technique_key === "string" ? method.print_technique_key : "")), RULES);
}
