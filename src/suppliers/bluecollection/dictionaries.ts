// What Blue Collection writes in Polish only: colours, countries and print techniques. Pure.
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";

// The 27 colours of color_product in the whole catalogue (public XML, 2026-11-04), in the words of the supplier's own
// English colour list where it has one
export const COLOURS_EN: Readonly<Record<string, string>> = {
  "barwny": "colourful",
  "beżowy": "beige",
  "biały": "white",
  "błękitny": "light blue",
  "bordowy": "burgundy",
  "brązowy": "brown",
  "czarny": "black",
  "czerwony": "red",
  "fioletowy": "violet",
  "grafitowy": "graphite",
  "granatowy": "navy blue",
  "naturalny": "natural",
  "niebieski": "blue",
  "oliwkowy": "olive",
  "pomarańczowy": "orange",
  "przezroczysty": "transparent",
  "różowy": "pink",
  "seledynowy": "celadon",
  "srebrny": "silver",
  "szampański": "champagne",
  "szary": "grey",
  "turkusowy": "turquoise",
  "zielony": "green",
  "zielony butelkowy": "bottle green",
  "zielony jasny": "light green",
  "złoty": "gold",
  "żółty": "yellow",
};

// country_origin of the whole catalogue (2026-11-04) as ISO 3166 codes, as the other suppliers give it
export const COUNTRIES: Readonly<Record<string, string>> = { chiny: "CN", polska: "PL", indie: "IN" };

// The technique names of the marking text: "Tampodruk(60.00x50.00)(Przód),Sitodruk(...)(...)". Transfers go first:
// "Sitodruk Transfer" is a transfer, the order matters.
const NAME_RULES: readonly PrintRule[] = [
  [/transfer|^dtf$/i, ["transfer"]],
  [/^tampodruk/i, ["pad"]],
  [/^sitodruk/i, ["screen"]],
  [/^grawer/i, ["laser"]],
  [/^tłocz/i, ["embossing"]],
  [/^uv|cyfrow/i, ["digital"]],
  [/^doming/i, ["doming"]],
  [/^haft/i, ["embroidery"]],
  [/^sublimac/i, ["sublimation"]],
];

// The first letter of a marking option's code, by the names the public marking file gives the same codes ("Tampondruck
// N2", "Prägung T1", "Siebdruck Transfer F1", new_marking_data_de.xml, 2026-11-04). The text above is empty in 900 of
// 1129 models, the options are not.
const CODE_RULES: readonly PrintRule[] = [
  [/^N/, ["pad"]],
  [/^G/, ["laser"]],
  [/^U/, ["digital"]],
  [/^C/, ["transfer"]],
  [/^F/, ["transfer"]],
  [/^S/, ["screen"]],
  [/^T/, ["embossing"]],
  [/^D/, ["doming"]],
  [/^B/, ["sublimation"]],
];

// A comma between the brackets is part of a size or a place, not a new technique
const TECHNIQUE_SEPARATOR = /,(?![^(]*\))/;

export function markingNames(text: string): string[] {
  return text.split(TECHNIQUE_SEPARATOR).map((part) => part.replace(/\(.*$/, "").trim()).filter(Boolean);
}

// From the marking texts and the option codes together
export function bluecollectionPrintTechniques(texts: string[], optionCodes: string[]): PrintFact[] {
  return [...new Set([...printFacts(texts.flatMap(markingNames), NAME_RULES), ...printFacts(optionCodes, CODE_RULES)])].sort();
}
