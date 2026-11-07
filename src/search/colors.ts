// A variant's colour name as the plain groups of a query: one rule over the names, the same for every source. Only one
// supplier gives a group of its own, and its groups differ from a buyer's ("burgundy" as brown); names are there for all.
// English, plus the Polish a feed leaves in, and Makito's GOLDEN and HUNTER (2026-11-06). A name the rule does not know
// is in no group: it neither helps nor hurts, as Makito's S/C ("sin color", 920 variants). Pure.
import type { ColorGroup } from "./query-parse-contract.js";

const NAMES: [ColorGroup, RegExp][] = [
  ["black", /(?<!\p{L})(black|czarn\w*|ebony)(?!\p{L})/u],
  ["white", /(?<!\p{L})(white|off-white|bia[łl]\w*|ivory|cream)(?!\p{L})/u],
  ["grey", /(?<!\p{L})(gr[ae]y|szar\w*|graphite|anthracite|antracyt\w*|charcoal|ash|melange|titanium)(?!\p{L})/u],
  ["blue", /(?<!\p{L})(blue|navy|granat\w*|niebiesk\w*|royal|cobalt|denim|aqua|turquoise|teal|cyan|azure|night)(?!\p{L})/u],
  ["green", /(?<!\p{L})(green|ziel\w*|khaki|lime|olive|army|mint|forest|hunter)(?!\p{L})/u],
  ["red", /(?<!\p{L})(red|czerwon\w*|burgundy|bordeaux|maroon|wine|cherry|crimson)(?!\p{L})/u],
  ["brown", /(?<!\p{L})(brown|br[aą]z\w*|beige|be[zż]ow\w*|wood|tan|sand|camel|natural\w*|kraft|cork|bamboo|chocolate|coffee)(?!\p{L})/u],
  ["orange", /(?<!\p{L})(orange|pomara[nń]\w*|coral|tangerine|mandarin)(?!\p{L})/u],
  ["pink", /(?<!\p{L})(pink|r[oó][zż]\w*|fuchsia|magenta|rose|salmon)(?!\p{L})/u],
  ["purple", /(?<!\p{L})(purple|fiolet\w*|violet|lilac|lavender|plum)(?!\p{L})/u],
  ["yellow", /(?<!\p{L})(yellow|[zż][oó][lł]t\w*|lemon|mustard)(?!\p{L})/u],
  ["silver", /(?<!\p{L})(silver|srebrn\w*|chrome|steel)(?!\p{L})/u],
  ["gold", /(?<!\p{L})(gold(?:en)?|z[lł]ot\w*)(?!\p{L})/u],
  ["mix", /(?<!\p{L})(multi\w*|mix\w*|rainbow|assorted)(?!\p{L})/u],
];

export function colorGroupsOf(name: string): ColorGroup[] {
  const lower = name.toLowerCase();
  return NAMES.filter(([, pattern]) => pattern.test(lower)).map(([group]) => group);
}

// A model has the colour when one of its variants does: the buyer picks the variant
export function hasColor(names: string[], asked: ColorGroup[]): boolean {
  return names.some((name) => colorGroupsOf(name).some((group) => asked.includes(group)));
}
