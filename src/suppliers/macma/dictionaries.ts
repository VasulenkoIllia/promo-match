// What the feeds of Macma and Easy Gifts write in German or in codes, in the words the shared parsers read. Pure.
import { printFacts, type PrintFact, type PrintRule } from "../printing.js";

// MATERIAL is German only, a list of these parts (77 lists in both feeds, 2026-11-05). The English word is the one
// src/suppliers/materials.ts knows: "PE" rather than "polyethylene (PE)", whose brackets it drops. The feed cuts a long
// list in the middle of a word ("Kunststo", "Thermopl").
export const MATERIALS_EN: Readonly<Record<string, string>> = {
  acryl: "acrylic", harz: "resin", nylon: "nylon", "polyethylen (pe)": "PE", silikon: "silicone", aluminium: "aluminium",
  bambus: "bamboo", edelstahl: "stainless steel", "polypropylen (pp)": "polypropylene", karton: "cardboard", pet: "PET",
  eisen: "iron", "kunststoff (abs)": "ABS", gummi: "rubber", elektronik: "electronics", kunststoff: "plastic",
  kunststo: "plastic", polyester: "polyester", papier: "paper", kupfer: "copper", metall: "metal",
  "polycarbonat (pc)": "PC", "polystyrol (ps)": "PS", baumwolle: "cotton", glas: "glass", porzellan: "porcelain",
  "recyceltes pet": "recycled PET", schiefer: "slate", weizenstroh: "wheat straw", jute: "jute",
  "bio baumwolle": "organic cotton", holz: "wood", keramik: "ceramic", kork: "cork", messing: "brass", filz: "felt",
  fleece: "fleece", neopren: "neoprene", "kunststoff (as)": "AS", kreide: "chalk", pvc: "PVC", leder: "leather",
  mais: "corn", mikrofaser: "microfibre", "non-woven": "non-woven", elasthan: "elastane", eva: "EVA",
  "polyacrylnitril(pan)": "acrylic", tritan: "Tritan", zuckerrohrpapier: "sugarcane paper", peva: "PEVA",
  "plüsch": "plush", carbon: "carbon", "polyurethan (pu)": "PU", "pongé": "pongee", "recycelt pet filz": "recycled PET felt",
  "recycelter edelstahl": "recycled stainless steel", thermopl: "thermoplastic", "recyceltes abs": "recycled ABS",
  "recyceltes aluminium": "recycled aluminium", "recyceltes papier": "recycled paper", stroh: "straw",
  "recycelte baumwolle": "recycled cotton", "recyceltes pu": "recycled PU", "recycl. polyester": "recycled polyester",
  zink: "zinc", wachs: "wax", granit: "granite", marmor: "marble", "recycl. milchkarton": "recycled milk carton",
  magnet: "magnet", "kunststoff (hips)": "HIPS", "thermopl. elastomere": "TPE", "polylactide (pla)": "PLA", latex: "latex",
  lederfaserstoff: "bonded leather", recyceltes: "recycled", "polypropylen (": "polypropylene",
  "synthetische jute": "synthetic jute", "fairtrade baumwolle": "fairtrade cotton", polyoximethylen: "POM",
  kokosnussschale: "coconut shell", steinpapier: "stone paper", velours: "velour",
};

// URSPRLAND in English capitals (7 countries in both feeds, 2026-11-05) as ISO 3166-1
export const COUNTRIES: Readonly<Record<string, string>> = {
  CHINA: "CN", INDIA: "IN", "VIET NAM": "VN", VIETNAM: "VN", INDONESIA: "ID", MYANMAR: "MM", SWITZERLAND: "CH",
  BAHRAIN: "BH", GERMANY: "DE", POLAND: "PL", TURKEY: "TR", TAIWAN: "TW", THAILAND: "TH", BANGLADESH: "BD",
  CAMBODIA: "KH", PAKISTAN: "PK", PORTUGAL: "PT", ITALY: "IT", SPAIN: "ES",
};

// DRUCK1 and DRUCK2 codes by what the product pages of macma.de name them ("Druck (T1)", "Lasergravur (L1)"), one
// product read per code (47 codes, 2026-11-05, docs/integrations.md). Easy Gifts writes the same codes. OEM (custom
// lanyards, "Allover") and SET are left unconfirmed.
const RULES: readonly PrintRule[] = [
  // Keramiktransfer, C2 "rundum"
  [/^C2$/, ["transfer", "wrap"]],
  [/^C\d$/, ["transfer"]],
  // Digitaldruck and UV Druck, DC4 "360°"
  [/^DC4$/, ["digital", "wrap"]],
  [/^DC\d$/, ["digital"]],
  // Digitaltransfer and Siebdrucktransfer
  [/^DTF\d$/, ["transfer"]],
  [/^TT\d$/, ["transfer"]],
  [/^DO$/, ["doming"]],
  // A label printed apart and put on the product (Etikett, Label für Picknickkörbe): no technique of the list
  [/^ET[NP]\d*$/, []],
  // Stick < 20cm²
  [/^HF$/, ["embroidery"]],
  // Hot Stamping / Prägung
  [/^HS$/, ["embossing"]],
  // Laser 360 Grad
  [/^L11$/, ["laser", "wrap"]],
  [/^L\d+$/, ["laser"]],
  // Siebdruck, ST "Siebdruck Baumwolltaschen"
  [/^S\d$/, ["screen"]],
  [/^ST\d?$/, ["screen"]],
  [/^SU\d?$/, ["sublimation"]],
  // Druck, Tampondruck
  [/^T\d$/, ["pad"]],
  // "keine Veredelung möglich"
  [/^0$/, []],
];

export function macmaPrintTechniques(codes: string[]): PrintFact[] {
  return printFacts(codes, RULES);
}
