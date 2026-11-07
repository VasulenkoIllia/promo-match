// A second pass over what a query asks of a product: vectors cannot do "over 800 ml" or "laser engraving", and a soft factor
// (src/search/conditions.ts) moves only what the lists found, so the same lists run again over the models the catalogue says fit,
// and each rank there counts as a vote on top of the ranking. It only adds: nothing leaves the ranking, a model the
// catalogue says nothing of keeps its place in the first pass, and the query's own lists still stand if a reading was
// wrong. No extra paid call: the query's vector is the first pass's. It knows no source. A hard filter is another
// thing: filters in src/search/store.ts, chosen on the screen.
import { conditionMatch, conditionRoom, hasConditions, type ModelFacts } from "./conditions.js";
import type { PrintTechnique } from "../suppliers/printing.js";
import type { Conditions } from "./query-parse-contract.js";
import type { ListEntry } from "./rank.js";
import type { StoreFilters } from "./store.js";

export interface ConditionPass {
  // What a rank of the pass counts for against one of the first pass, whose vote is 1
  weight: number;
  // Materials hold a query to what a buyer may only have guessed from a picture, and a supplier that lists every part
  // of a product has its material unknown more often; numbers are said on purpose and known alike
  hasMaterials: boolean;
  // Every supplier lists its techniques alike, but for those below; a product's text does not say them, so nothing else finds them
  hasPrint: boolean;
}

// One supplier's code for it is not confirmed (src/suppliers/axpol/print-codes.ts), so a vote would lift only the other's
const UNEVEN_TECHNIQUES: PrintTechnique[] = ["embroidery"];

// What the screen's switch «Піднімати товари, де каталог підтверджує умови запиту» turns on; off by default (owner's
// decision 2026-11-06): the facts are uneven between suppliers (print was known for 75% of Makito's models against 96-99%
// of the others', sheets for 57-63% of Blue Collection's and Makito's notebooks), so the pass leans to the fuller
// catalogue, and a search without it ranks by the vectors alike for every supplier. Its settings are those on with the
// package of 2026-10-31, print voting from 2026-10-31 (docs/decisions.md).
export const CONDITION_PASS: ConditionPass = { weight: 0.5, hasMaterials: false, hasPrint: true };

// What the pass holds a product to; null: no pass. A fact the screen asked for already holds the first pass to it, and
// the room around a number would let past the filter what the screen left out.
export function passConditions(asked: Conditions, pass: ConditionPass | null, filters: StoreFilters): Conditions | null {
  if (!pass || filters.volumeMl || filters.materials || filters.sizeCm) return null;
  const isPrintHeld = pass.hasPrint && !asked.printTechniques?.some((each) => UNEVEN_TECHNIQUES.includes(each));
  const conditions: Conditions = {
    // The weight in g/m2 is in the texts of few models, and unevenly so between suppliers: a card says it, a vote does not
    ...asked, materials: pass.hasMaterials ? asked.materials : [], printTechniques: isPrintHeld ? asked.printTechniques : [], gsm: null,
  };
  return hasConditions(conditions) ? conditions : null;
}

export function passFilters(filters: StoreFilters, conditions: Conditions): StoreFilters {
  return { ...filters, ...conditionRoom(conditions) };
}

function isFitting(conditions: Conditions, facts: ModelFacts): boolean {
  return Object.values(conditionMatch(conditions, facts)).every((word) => word === null || word === "fits");
}

function isAgainst(conditions: Conditions, facts: ModelFacts): boolean {
  return Object.values(conditionMatch(conditions, facts)).includes("against");
}

// The filter is the screen's, wider than a card's word in one place: a side a model does not state passes it. A model
// votes only when its card would say it fits, so each list is ranked again among those. What the pass does not hold a
// product to still stops a vote when the catalogue says the opposite: a bag of the size but of another material.
export function fittingEntries(entries: ListEntry[], conditions: Conditions, asked: Conditions, facts: Map<number, ModelFacts>): ListEntry[] {
  return entries.filter(({ modelId }) => {
    const known = facts.get(modelId);
    return known !== undefined && isFitting(conditions, known) && !isAgainst(asked, known);
  }).map((entry, index) => ({ ...entry, rank: index + 1 }));
}
