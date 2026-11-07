// What a query asks of a product's capacity, materials, size and print, against what the catalogue knows of a model. Vectors
// cannot do this: "over 800 ml" is near every thermo mug. It works softly, as a factor on the fused score: a model whose
// known value goes against the query falls down the list, a model the catalogue says nothing of stays where it is, so a
// gap in a feed costs no one a place. Asks nothing of the source. A hard filter is another thing: filters in
// src/search/store.ts, chosen on the screen. A card says the same in words and moves nothing (conditionMatch). Pure.
import { areRelated, isKindOf, type MaterialCode } from "../suppliers/materials.js";
import { type PrintFact, type PrintTechnique, UNCONFIRMED_PRINT } from "../suppliers/printing.js";
import type { Conditions, SizeRange, ValueRange } from "./query-parse-contract.js";
import { type FusedModel, sortFused } from "./rank.js";
import type { StoreFilters } from "./store.js";

export interface ModelFacts {
  volumeMl: number | null;
  // The first is the one the supplier lists first
  materials: MaterialCode[];
  // Longest first
  sizesCm: number[];
  // Empty: the supplier gives no print data
  printTechniques: PrintFact[];
  sheets: number | null;
  gsm: number | null;
}

// A value this share outside the bounds is near, not against: "500 ml" and 480 ml in the catalogue. A size is looser:
// catalogues round it and may give it folded or with the packaging
const NEAR_SHARE = 0.1;
const NEAR_SHARE_OF_SIZE = 0.2;

type Verdict = "fits" | "near" | "against";

export interface Demotion {
  // The factor on the score of a model whose value goes against a condition; 1 is no demotion. RRF's scores are close:
  // at k 60, 0.8 takes the first of two lists to about the 16th place, 0.6 to about the 41st (docs/integrations.md)
  against: number;
  // What a material listed after the first one counts as. A supplier that lists every part (lid, seal) says more than
  // one that lists the body alone, and that must not lift it over the other
  otherMaterial: Exclude<Verdict, "fits">;
  // Materials hold a query to what a buyer may only have guessed from a picture; numbers are said on purpose
  hasMaterials: boolean;
}

// Off: against 0.9 did not pass the frozen final set of 2026-10-30 (README «Незалежний тест», docs/decisions.md). The
// facts still serve the hard filters and the cards; a value below 1 needs a new frozen set first.
export const DEFAULT_DEMOTION: Demotion = { against: 1, otherMaterial: "against", hasMaterials: true };

export const NO_CONDITIONS: Conditions = { volumeMl: null, materials: [], sizeCm: null };

// What a result's card says of one condition. unknown: the catalogue does not say, which is never against
export type Match = "fits" | "unknown" | "against";

// One word per condition of a query; null: it does not ask that
export interface ConditionMatch {
  volumeMl: Match | null;
  materials: Match | null;
  sizeCm: Match | null;
  printTechniques: Match | null;
  sheets: Match | null;
  gsm: Match | null;
}

const NO_FACTS: ModelFacts = { volumeMl: null, materials: [], sizesCm: [], printTechniques: [], sheets: null, gsm: null };

export function hasConditions({ volumeMl, materials, sizeCm, printTechniques, sheets, gsm }: Conditions): boolean {
  return volumeMl !== null || materials.length > 0 || sizeCm !== null || Boolean(printTechniques?.length || sheets || gsm);
}

export function isDemoting(conditions: Conditions, demotion: Demotion): boolean {
  return demotion.against < 1 && hasConditions(conditions);
}

type FactFilters = Pick<StoreFilters, "volumeMl" | "materials" | "sizeCm" | "printTechniques" | "sheets">;

function aroundBy(value: number, share: number): { min: number; max: number } {
  return { min: Math.round(value * (1 - share) * 10) / 10, max: Math.round(value * (1 + share) * 10) / 10 };
}

function volumeRoom({ min, max }: ValueRange): Partial<ValueRange> {
  if (min !== null && min === max) return aroundBy(min, NEAR_SHARE);
  return { ...(min === null ? {} : { min }), ...(max === null ? {} : { max }) };
}

function sizeRoom({ min, max }: SizeRange): Partial<SizeRange> {
  const isExact = min.length > 0 && min.join() === max.join();
  const lower = isExact ? min.map((side) => aroundBy(side, NEAR_SHARE_OF_SIZE).min) : min;
  const upper = isExact ? max.map((side) => aroundBy(side, NEAR_SHARE_OF_SIZE).max) : max;
  return { ...(lower.length ? { min: lower } : {}), ...(upper.length ? { max: upper } : {}) };
}

// A query's conditions as the hard filters take them, with the room a number said exactly gets on a card, the same as
// the buttons on the screen give it (web/src/format.ts)
export function conditionRoom({ volumeMl, materials, sizeCm, printTechniques, sheets }: Conditions): FactFilters {
  return {
    ...(volumeMl ? { volumeMl: volumeRoom(volumeMl) } : {}),
    ...(materials.length ? { materials } : {}),
    ...(sizeCm ? { sizeCm: sizeRoom(sizeCm) } : {}),
    ...(printTechniques?.length ? { printTechniques } : {}),
    ...(sheets ? { sheets: volumeRoom(sheets) } : {}),
  };
}

// How far a value lies outside its bounds, as a share of the bound it passed
function shareOutside(value: number, { min, max }: ValueRange): number {
  if (min && value < min) return (min - value) / min;
  if (max && value > max) return (value - max) / max;
  return 0;
}

function verdictOf(share: number, nearShare = NEAR_SHARE): Verdict {
  if (!share) return "fits";
  return share <= nearShare ? "near" : "against";
}

function volumeVerdict(asked: Conditions["volumeMl"], volumeMl: number | null): Verdict {
  return asked && volumeMl !== null ? verdictOf(shareOutside(volumeMl, asked)) : "fits";
}

function sideRange({ min, max }: SizeRange, index: number): ValueRange {
  return { min: min[index] ?? null, max: max[index] ?? null };
}

// Side by side, longest first: a size asked of two sides says nothing of a third
function sizeVerdict(asked: Conditions["sizeCm"], sizesCm: number[]): Verdict {
  if (!asked) return "fits";
  const shares = sizesCm.map((side, index) => shareOutside(side, sideRange(asked, index)));
  return verdictOf(Math.max(0, ...shares), NEAR_SHARE_OF_SIZE);
}

function materialVerdict(asked: MaterialCode[], materials: MaterialCode[], demotion: Demotion): Verdict {
  const [main, ...others] = materials;
  if (!demotion.hasMaterials || !asked.length || !main) return "fits";
  const isAsked = (material: MaterialCode) => asked.some((each) => areRelated(each, material));
  if (isAsked(main)) return "fits";
  return others.some(isAsked) ? demotion.otherMaterial : "against";
}

export function conditionFactor(conditions: Conditions, facts: ModelFacts, demotion: Demotion): number {
  const factors: Record<Verdict, number> = { fits: 1, near: Math.sqrt(demotion.against), against: demotion.against };
  return [
    volumeVerdict(conditions.volumeMl, facts.volumeMl),
    materialVerdict(conditions.materials, facts.materials, demotion),
    sizeVerdict(conditions.sizeCm, facts.sizesCm),
  ].reduce((factor, verdict) => factor * factors[verdict], 1);
}

// The fused ranking with the factors applied, cut to the limit. A model with no facts read stays as it is.
export function demoteByConditions(fused: FusedModel[], conditions: Conditions, facts: Map<number, ModelFacts>,
  demotion: Demotion, limit: number): FusedModel[] {
  const scored = fused.map((model) => {
    const known = facts.get(model.modelId);
    return known ? { ...model, score: model.score * conditionFactor(conditions, known, demotion) } : model;
  });
  return sortFused(scored).slice(0, limit);
}

// Near is the room a number said exactly gets, the same as the screen's filter gives it (web/src/format.ts): past an
// open bound it is against, as 750 ml is no "over 800 ml"
function matchOf(verdict: Verdict, isExact: boolean): Match {
  return verdict === "fits" || (verdict === "near" && isExact) ? "fits" : "against";
}

function amountMatch(asked: ValueRange, amount: number | null): Match {
  return amount === null ? "unknown" : matchOf(volumeVerdict(asked, amount), asked.min === asked.max);
}

// The first material confirms it, the one the hard filter compares. Named in a later place or only more widely (metal,
// asked stainless steel), it neither confirms nor goes against: a list's order is no proof of the body, a glass bottle
// with a bamboo lid comes as "bamboo, PP, glass". Stricter than the demotion's otherMaterial, which is about fair places.
function materialMatch(asked: MaterialCode[], materials: MaterialCode[]): Match {
  const [main] = materials;
  if (!main) return "unknown";
  if (asked.some((each) => isKindOf(main, each))) return "fits";
  return asked.some((each) => materials.some((material) => areRelated(each, material))) ? "unknown" : "against";
}

// Side by side when the query and the model state as many sides. Otherwise nothing says which are meant: 8 cm across is
// the second side of a mug 12 cm high. Then a size stays unknown while a side could be the one meant, and a side the
// model does not state confirms nothing; only with no such side does it go against.
function sizeMatch(asked: SizeRange, sizesCm: number[]): Match {
  const isExact = asked.min.join() === asked.max.join();
  const ranges = Array.from({ length: Math.max(asked.min.length, asked.max.length) }, (_, index) => sideRange(asked, index));
  const match = matchOf(sizeVerdict(asked, sizesCm), isExact);
  if (sizesCm.length === ranges.length || (match === "fits" && sizesCm.length > ranges.length)) return match;
  const isWithin = (side: number, range: ValueRange) =>
    matchOf(verdictOf(shareOutside(side, range), NEAR_SHARE_OF_SIZE), isExact) === "fits";
  const couldBeMeant = sizesCm.length < ranges.length
    ? sizesCm.every((side) => ranges.some((range) => isWithin(side, range)))
    : ranges.every((range) => sizesCm.some((side) => isWithin(side, range)));
  return couldBeMeant ? "unknown" : "against";
}

// A supplier lists what it offers, so a technique that is not there goes against, unless a code nothing explains may be it
function printMatch(asked: PrintTechnique[], techniques: PrintFact[]): Match {
  if (!techniques.length) return "unknown";
  if (asked.some((each) => techniques.includes(each))) return "fits";
  return techniques.includes(UNCONFIRMED_PRINT) ? "unknown" : "against";
}

export function conditionMatch({ volumeMl, materials, sizeCm, printTechniques, sheets, gsm }: Conditions, facts: ModelFacts): ConditionMatch {
  return {
    volumeMl: volumeMl && amountMatch(volumeMl, facts.volumeMl),
    materials: materials.length ? materialMatch(materials, facts.materials) : null,
    sizeCm: sizeCm && sizeMatch(sizeCm, facts.sizesCm),
    printTechniques: printTechniques?.length ? printMatch(printTechniques, facts.printTechniques) : null,
    sheets: sheets ? amountMatch(sheets, facts.sheets) : null,
    gsm: gsm ? amountMatch(gsm, facts.gsm) : null,
  };
}

// The cards of a search: each model is held to the product of the query that gave it its place (src/search/rank.ts,
// interleave). One only a code found has no product, and a product with no conditions has nothing to say: neither is
// here. A model with no facts read is unknown, as one the catalogue says nothing of.
export function conditionMatches(fused: FusedModel[], conditions: Conditions[], facts: Map<number, ModelFacts>):
  Map<number, ConditionMatch> {
  return new Map(fused.flatMap(({ modelId, productIndex }): [number, ConditionMatch][] => {
    const asked = productIndex === undefined ? undefined : conditions[productIndex];
    return asked && hasConditions(asked) ? [[modelId, conditionMatch(asked, facts.get(modelId) ?? NO_FACTS)]] : [];
  }));
}
