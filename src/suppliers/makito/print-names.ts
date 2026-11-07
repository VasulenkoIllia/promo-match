// Makito's print techniques on the shared list. Two sources: the names of its "Marking Techniques" categories, and the
// names of the print price list that the technique ids of the print areas (`print-config`) point to. The printcode
// letters (K(4), F(1),N(8),DTF1) are explained nowhere public, so they are kept but not read. Pure.
import { printFacts, type PrintFact, type PrintRule, UNCONFIRMED_PRINT } from "../printing.js";

// The 13 names of the catalogue (2026-11-04). Transfers go before digital: "Digital Transfer" is a transfer, the order
// matters. Thermo-engraving presses the mark into the material by heat. "Catrichomy" (four-colour process) is left
// unconfirmed: the name does not say on what it prints.
const RULES: readonly PrintRule[] = [
  [/transfer/i, ["transfer"]],
  [/^digital 360/i, ["digital", "wrap"]],
  [/^digital$/i, ["digital"]],
  [/^serigraphy$/i, ["screen"]],
  [/^circular laser$/i, ["laser", "wrap"]],
  [/^laser$/i, ["laser"]],
  [/^pad printing$/i, ["pad"]],
  [/^embroidery$/i, ["embroidery"]],
  [/^sublimation$/i, ["sublimation"]],
  [/^doming$/i, ["doming"]],
  [/^thermo-engraving$/i, ["embossing"]],
];

// The 126 names of the print price list (2026-11-04): "PAD PRINTING K", "SCREEN PRINTING H SUNSHADE", "CIRCULAR SCREEN B",
// "LASER ENGRAVING 2", "TRANSFER N1", "DTF2 (FULLCOLOR)", "DIGITAL W3 (-25 cm2)", "DIGITAL 360 WR1 -5cm", "SUBLIMATION
// TECHNOLOGY FOR MUGS", "DOMING - V1". The same order of care as above: transfer before digital, 360 before digital. A name
// no rule reads ("CUATRICOMIA PRINT X", "DRY WOODBURNING", "CANVAS PRINT", an empty one) stays unconfirmed.
const AREA_RULES: readonly PrintRule[] = [
  [/transfer|^dtf/i, ["transfer"]],
  [/^digital 360/i, ["digital", "wrap"]],
  [/sublimation|sublimacion/i, ["sublimation"]],
  [/doming/i, ["doming"]],
  [/embroidery/i, ["embroidery"]],
  [/laser/i, ["laser"]],
  [/circular screen|serigrafia circular/i, ["screen", "wrap"]],
  [/screen|silk/i, ["screen"]],
  [/pad print/i, ["pad"]],
  [/^digital/i, ["digital"]],
];

export function makitoPrintTechniques(names: string[]): PrintFact[] {
  return printFacts(names, RULES);
}

export function makitoAreaTechniques(names: string[]): PrintFact[] {
  return printFacts(names, AREA_RULES);
}

// The two sources disagree on pad printing and screen printing in about a third of the models that have both (the
// report of 2026-11-06), and nothing says which is right, so a model keeps what the categories say and takes the areas'
// techniques on top. The areas' "unconfirmed" counts only when nothing else is known: it must not turn a known
// technique into "may be anything".
export function mergePrintFacts(fromCategories: PrintFact[], fromAreas: PrintFact[]): PrintFact[] {
  const merged = new Set<PrintFact>([...fromCategories, ...fromAreas.filter((fact) => fact !== UNCONFIRMED_PRINT)]);
  if (!merged.size && fromAreas.length) merged.add(UNCONFIRMED_PRINT);
  return [...merged].sort();
}
