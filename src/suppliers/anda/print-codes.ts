// Anda Present's technique codes on the shared list (docs/integrations.md, «Техніка друку»). The labeling feed names every
// code (2026-11-09, 129 codes): a number or letter after the family is a size or colour class of it, "N" in front is the
// same technique for a printed name ("NE1 Engraving - Name printing"), "FP-" a free print already in the product's price,
// "-HS" hatband sewing beside it. Ceramic printing (C, WPC), the vinyl sticker (VS) and the Vison film (VF) have no
// family on the list, so they stay unconfirmed, as any code that comes later. The boxes and sleeves (CB, PB, PS and their
// kraft K) are packaging, not a print on the product: they are no fact at all. Pure.
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";

const PACKAGING = /^(?:CB|PB|PS)K?\d$/;

const RULES: readonly PrintRule[] = [
  // Rotary engraving, also for pens: round the body
  [/^N?ER\d|^EP\d/, ["laser", "wrap"]],
  [/^N?E[X\d]|^RE\d|^FP-E$/, ["laser"]],
  [/^N?RUV$/, ["digital", "wrap"]],
  [/^N?UV[A-Z]$|^FP-UV$/, ["digital"]],
  [/^RS\d/, ["screen", "wrap"]],
  [/^S\d/, ["screen"]],
  [/^P\d/, ["pad"]],
  [/^N?DT[A-Z]|^T[A-Z](?:\d-HS)?$/, ["transfer"]],
  [/^N?SU|^FP-N?SU/, ["sublimation"]],
  [/^N?DG\d|^FP-N?DG$|^DC\d|^OP$/, ["digital"]],
  [/^DO|^FP-DO$/, ["doming"]],
  [/^BR$/, ["embroidery"]],
  [/^O\d$/, ["embossing"]],
];

export function andaPrintTechniques(codes: string[]): PrintFact[] {
  return printFacts(codes.filter((code) => !PACKAGING.test(code)), RULES);
}
