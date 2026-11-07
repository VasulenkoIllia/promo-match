// The shared list of materials, one for every source, the way the shared categories are: suppliers write them freely
// (1272 different strings in two catalogues, 2026-10-30), and a search can only compare them on one list. A material has
// parents, so a query for plastic meets a model of ABS. Words in English: every adapter gives an English material. Pure.

interface Material {
  parents: readonly string[];
  // What suppliers write for it, as a regular expression of whole words in lower case
  words: string;
}

const MATERIALS = {
  plastic: {
    parents: [],
    words: String.raw`plastics?|plastik|r?abs|r?pp|polypropylene|r?pe|[lh]dpe|epe|ps|hips|r?pc|as|san|pvc|vinyl|p?eva|r?tpu|r?tpe|tpr|pla|pctg|petg|pom|pva|melamine|foam|pu foam|polyester foam`,
  },
  tritan: { parents: ["plastic"], words: "tritan" },
  acrylic: { parents: ["plastic"], words: "acrylic" },
  "wheat-straw": { parents: ["plastic"], words: "wheat straw|wheatstraw|wheat|straw" },
  // Both a bottle and the fabric of a bag: suppliers write the same word for either
  pet: { parents: ["plastic", "polyester"], words: "r?pet" },
  metal: { parents: [], words: "metal|tin|zinc|zinc alloy|nickel|brass|copper|titanium" },
  steel: { parents: ["metal"], words: "steel|carbon steel|iron|stal" },
  "stainless-steel": { parents: ["steel"], words: "stainless steel|stainless|ss" },
  aluminium: { parents: ["metal"], words: "aluminium|aluminum|aluminium alloy|aluminium foil" },
  glass: { parents: [], words: "glass|borosilicate" },
  ceramic: { parents: [], words: "ceramics?|stoneware|earthenware|terracotta|clay" },
  porcelain: { parents: ["ceramic"], words: "porcelain" },
  wood: { parents: [], words: String.raw`\w*wood|mdf|acacia|maple|multiplex|poplar|lime tree` },
  bamboo: { parents: ["wood"], words: "bamboo" },
  textile: {
    parents: [],
    words: "textile|fabric|woven|mesh|velour|velvet|corduroy|silk|wool|linen|hemp|elastane|elasthane|spandex|plush|fibre|fiber",
  },
  cotton: { parents: ["textile"], words: "cotton|polycotton|denim" },
  polyester: { parents: ["textile"], words: "polyester|poliester|pongee|terylene|microfibre" },
  nylon: { parents: ["textile"], words: "nylon|polyamide|pa" },
  canvas: { parents: ["textile"], words: "canvas|polycanvas" },
  jute: { parents: ["textile"], words: "jute" },
  felt: { parents: ["textile"], words: "felt" },
  // A non-woven bag is polypropylene, and suppliers write either word for the same fabric
  nonwoven: { parents: ["textile", "plastic"], words: "nonwoven" },
  fleece: { parents: ["textile"], words: "fleece" },
  paper: { parents: [], words: "paper|stonepaper|kraft" },
  cardboard: { parents: ["paper"], words: "cardboard|card|cartons?" },
  leather: { parents: [], words: "leather|suede" },
  // Polyurethane in a list of materials is the imitation of leather; as foam it is under plastic. No parent: an
  // imitation does not confirm leather
  "pu-leather": { parents: [], words: "r?pu|imitation leather|bonded leather" },
  rubber: { parents: [], words: "rubber|neoprene|latex|thermoplastic rubber" },
  silicone: { parents: ["rubber"], words: "silicone|silicon|silikon" },
  cork: { parents: [], words: "cork" },
  stone: { parents: [], words: "stone|slate|marble|plaster|chalk" },
} as const satisfies Record<string, Material>;

export type MaterialCode = keyof typeof MATERIALS;
export const MATERIAL_CODES = Object.keys(MATERIALS) as MaterialCode[];

export function isMaterialCode(value: string): value is MaterialCode {
  return Object.hasOwn(MATERIALS, value);
}

const MATCHERS = MATERIAL_CODES.map((code) => ({ code, pattern: new RegExp(String.raw`\b(?:${MATERIALS[code].words})\b`, "g") }));

// Parts of a list: "stainless steel, PP", "PET-PU", "recycled cotton / organic cotton", "metal and plastic"
const LIST_MARK = /[,;/&+]|\band\b|\bwith\b|(?<=[a-z])-(?=[a-z])/;
const IN_BRACKETS = /\([^)]*\)/g;
const NON_WOVEN = /\bnon[- ]woven\b/g;

// The most specific name in a part: the longest one, so "pu foam" is not read as "pu" nor "stone paper" as stone
function materialOf(part: string): MaterialCode | undefined {
  let best: { code: MaterialCode; length: number } | undefined;
  for (const { code, pattern } of MATCHERS) {
    for (const [word] of part.matchAll(pattern)) {
      if (!best || word.length > best.length) best = { code, length: word.length };
    }
  }
  return best?.code;
}

// The materials a supplier's text names, in its order, each once; words not on the list (battery, wax) are left out
export function readMaterials(text: string): MaterialCode[] {
  const cleaned = text.toLowerCase().replace(IN_BRACKETS, " ").replace(NON_WOVEN, "nonwoven");
  const found = cleaned.split(LIST_MARK).map(materialOf).filter((code) => code !== undefined);
  return [...new Set(found)];
}

function withParents(code: MaterialCode): Set<string> {
  const seen = new Set<string>();
  const add = (each: string) => {
    if (seen.has(each)) return;
    seen.add(each);
    if (isMaterialCode(each)) MATERIALS[each].parents.forEach(add);
  };
  add(code);
  return seen;
}

const LINEAGE = new Map(MATERIAL_CODES.map((code) => [code, withParents(code)]));

// The material is the asked one or a kind of it: stainless steel confirms metal, a model that says only metal does not
// confirm stainless steel
export function isKindOf(material: MaterialCode, asked: MaterialCode): boolean {
  return Boolean(LINEAGE.get(material)?.has(asked));
}

// One is the other or a kind of it: plastic and ABS, and also stainless steel and a model that says only metal
export function areRelated(left: MaterialCode, right: MaterialCode): boolean {
  return Boolean(LINEAGE.get(left)?.has(right) || LINEAGE.get(right)?.has(left));
}
