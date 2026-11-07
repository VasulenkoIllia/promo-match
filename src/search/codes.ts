// An exact match by a code (docs/integrations.md, «Точний збіг за кодом»): a request often names the product by a
// supplier's model code or SKU, and a vector knows nothing of a code: "IT3787-09" found T-shirts and notebooks, because
// Claude kept the code and dropped the product (2026-10-30). So a code the catalogues have goes first as it is, and out
// of the text before Claude and the embedding read it. Pure: the reads are in src/search/store.ts.
import { type FusedModel, tieOrder } from "./rank.js";

// Letters and digits with - . / between them and no space, as in every code of the catalogues (2026-10-30)
const CODE_TOKEN = /[A-Za-z0-9](?:[A-Za-z0-9./-]*[A-Za-z0-9])?/g;
// Digits alone or with - / between: the codes of Macma, Easy Gifts, Makito, Blue Collection and Inspirion (2026-11-05).
// A dot stays out: no such code has one, and "10.000" or "12.5" are amounts.
const NUMBER_CODE = /^\d+(?:[-/]\d+)*$/;
// A number this long is a code anywhere: the quality sets have none, and it hits a code by chance rarely (2026-11-05)
const ANYWHERE_DIGITS = 6;
// A shorter number only when the text is codes alone or a code word stands before it: a third of all 4-digit numbers
// are codes, and "1200 ml", "8000 mAh", "ISO 22196" of the quality sets and amounts as 1500 and 2500 are Makito models
const NAMED_DIGITS = 4;
// A word that says a code follows, at the end of the text before a number: "Art.-Nr.: ", "артикул ", "#", "№ "
const CODE_WORD_BEFORE = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])(?:art(?:ikel)?(?:nummer|nr)?|article|item|ref(?:erence|erencia)?|sku|codes?|c[oó]digo|kod|symbol|index|indeks|modell?|nr|no|артикул\p{L}*|арт|код\p{L}*|модел\p{L}*)|[#№])[\s.:#№-]*$`, "iu");

// Sources whose own reference, kept as external_id, names a model as its code does: Makito's ref (15246) is in its
// price list, photos and SKUs, while its code is the one of its site (5246) (2026-11-05). Midocean's external_id is an
// inner number, which no one writes.
export const REF_CODE_SOURCES: readonly string[] = ["makito"];

export interface CodeMatch {
  modelId: number;
  // source and model code, for the messages
  label: string;
  isModelCode: boolean;
}

// A model's own code goes before a SKU equal to it: 8 SKUs equal the code of another model (2026-10-30), and that model
// is still reachable by another of its codes
export function preferredMatches(matches: CodeMatch[]): CodeMatch[] {
  const byModelCode = matches.filter((match) => match.isModelCode);
  return byModelCode.length ? byModelCode : matches;
}

// Words that may be a code: a letter and a digit, or a number (NUMBER_CODE) as the rules above allow, so a plain word,
// an amount or a measure costs no lookup and can never match
export function codeTokens(text: string): string[] {
  const isCodesAlone = !/\p{L}{2}/u.test(text.replace(CODE_TOKEN, (token) => (/\d/.test(token) ? "" : token)));
  const tokens = [...text.matchAll(CODE_TOKEN)].filter(({ 0: token, index }) => (/[A-Za-z]/.test(token)
    ? /\d/.test(token) : isNumberCode(token, isCodesAlone || CODE_WORD_BEFORE.test(text.slice(0, index)))));
  return [...new Set(tokens.map(([token]) => token))];
}

function isNumberCode(token: string, isNamed: boolean): boolean {
  if (!NUMBER_CODE.test(token)) return false;
  const digits = token.replaceAll(/\D/g, "").length;
  return digits >= ANYWHERE_DIGITS || (isNamed && digits >= NAMED_DIGITS);
}

export interface CodeHit {
  modelId: number;
  // As the text has it
  code: string;
}

// The models the tokens stand for, in the order of the text, each once; a code two sources share by tieOrder
export function codeHits(tokens: string[], matches: Map<string, CodeMatch[]>): CodeHit[] {
  const hits = new Map<number, CodeHit>();
  for (const code of tokens) {
    const found = preferredMatches(matches.get(code.toLowerCase()) ?? []);
    for (const { modelId } of found.toSorted((left, right) => tieOrder(left.modelId) - tieOrder(right.modelId))) {
      if (!hits.has(modelId)) hits.set(modelId, { modelId, code });
    }
  }
  return [...hits.values()];
}

// The text without the codes found; undefined when no word is left to read
export function textWithoutCodes(text: string, codes: string[]): string | undefined {
  const found = new Set(codes);
  const left = text.replace(CODE_TOKEN, (token) => (found.has(token) ? "" : token)).replaceAll(/\s+/g, " ").trim();
  return /\p{L}{2}/u.test(left) ? left : undefined;
}

// The models a code named first, in the order of the text, then the rest of the ranking. One the vectors found too keeps
// its photos and lists; another has no list, and shows its cover. Each counts the models its code named among the hits
// (those past the filters, before the limit): 553 codes of 4-5 digits name a model of two or three suppliers, one model
// each (1099 models, 2026-11-06), and the card says so.
export function withCodeHits(fused: FusedModel[], hits: CodeHit[], limit: number): FusedModel[] {
  const byId = new Map(fused.map((model) => [model.modelId, model]));
  const first = hits.map(({ modelId, code }): FusedModel => ({
    ...byId.get(modelId) ?? { modelId, score: 0, lists: {}, photos: [] }, matchedCode: code,
    matchedCodeModels: hits.filter((hit) => hit.code === code).length,
  }));
  const rest = fused.filter(({ modelId }) => !hits.some((hit) => hit.modelId === modelId));
  return [...first, ...rest].slice(0, limit);
}
