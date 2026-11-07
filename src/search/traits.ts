// What a query says of a product that no vector holds: the colour it asks and what it rules out. A colour lifts a model
// with a variant of it, what is ruled out sinks a model that is it: both move places and drop nothing, so a reading gone
// wrong costs a place, not the model. Knows no source. Pure.
import { colorGroupsOf, hasColor } from "./colors.js";
import type { ModelFacts } from "./conditions.js";
import type { ColorGroup, Conditions } from "./query-parse-contract.js";
import { type FusedModel, liftModels } from "./rank.js";
import { isKindOf } from "../suppliers/materials.js";

export function hasExclusions({ excludedMaterials, excludedColors }: Conditions): boolean {
  return Boolean(excludedMaterials?.length || excludedColors?.length);
}

export function liftColored(fused: FusedModel[], names: Map<number, string[]>, asked: ColorGroup[], factor: number): FusedModel[] {
  const colored = fused.filter(({ modelId }) => hasColor(names.get(modelId) ?? [], asked)).map(({ modelId }) => modelId);
  return liftModels(fused, new Set(colored), factor);
}

// Ruled out by its colour only when no variant escapes it: a backpack in black and red is still a backpack "not black"
function isRuledOutColor(names: string[], excluded: ColorGroup[]): boolean {
  return names.length > 0 && names.every((name) => {
    const groups = colorGroupsOf(name);
    return groups.length > 0 && groups.every((group) => excluded.includes(group));
  });
}

export function sinkExcluded(fused: FusedModel[], facts: Map<number, ModelFacts>, names: Map<number, string[]>, conditions: Conditions,
  factor: number): FusedModel[] {
  const { excludedMaterials = [], excludedColors = [] } = conditions;
  const ruledOut = fused.filter(({ modelId }) => {
    const [main] = facts.get(modelId)?.materials ?? [];
    return (main && excludedMaterials.some((each) => isKindOf(main, each))) || isRuledOutColor(names.get(modelId) ?? [], excludedColors);
  }).map(({ modelId }) => modelId);
  return liftModels(fused, new Set(ruledOut), factor);
}
