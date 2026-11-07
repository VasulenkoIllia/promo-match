import type { FactFilters, QueryParse } from "./api";
import { factChoices, isFactApplied, type SharedCategoryEntry } from "./format";
import { colorName, factText, materialName, suggestedPriceText, text } from "./text";

interface QueryParseNoteProps {
  parse: QueryParse;
  categories: Map<string, SharedCategoryEntry>;
  // The shared categories of the search shown
  appliedCategories: string[];
  appliedFacts: FactFilters;
  // A code named a model: words with no product beside it went into no list
  hasCodeHit: boolean;
  isPending: boolean;
  // The photo or the text changed since the search: its suggestions are no longer about the form
  isStale: boolean;
  // Adds the shared category to the filters and searches again (decision of the owner 2026-10-30)
  onApplyCategory: (code: string) => void;
  // Adds a hard filter by what the query asks of the product, and searches again
  onApplyFact: (facts: FactFilters) => void;
}

// How Claude read the text: the English that went into the search and the filters it suggests. Colours and price have no
// filter yet and are shown for information. A query of several products gets no fact filters: one would hide the others.
export function QueryParseNote({ parse, categories, appliedCategories, appliedFacts, hasCodeHit, isPending, isStale,
  onApplyCategory, onApplyFact }: QueryParseNoteProps) {
  if (parse.status === "unavailable") return <p className="note quiet">{text.parse.unavailable(parse.reason)}</p>;

  const { sharedCategories, colors, materials, price } = parse.suggestedFilters;
  const [only] = parse.conditions.length === 1 ? parse.conditions : [];
  const choices = only ? factChoices(only) : [];
  const other = [
    ...colors.map(colorName),
    ...(only ? [] : materials.map((code) => text.parse.material(materialName(code)))),
    ...(price ? [suggestedPriceText(price)] : []),
  ].filter(Boolean);
  return (
    <div className="note parse">
      {parse.englishText === null ? (
        <p>{hasCodeHit ? text.parse.codeOnly : text.parse.noProduct}</p>
      ) : (
        <p>{text.parse.english} <q lang="en">{parse.englishText}</q></p>
      )}
      {sharedCategories.length > 0 && (
        <div className="row">
          <span>{text.parse.categories}</span>
          {sharedCategories.map((code) => {
            const category = categories.get(code);
            const name = category?.name ?? code;
            const isApplied = appliedCategories.includes(code);
            // A code the list no longer has, or one without models, would only fail the search or empty it
            const canApply = !isApplied && !isPending && !isStale && Boolean(category?.models);
            return (
              <button
                key={code}
                type="button"
                className="suggestion"
                disabled={!canApply}
                title={canApply ? text.parse.applyCategory(name) : undefined}
                onClick={() => onApplyCategory(code)}
              >
                {isApplied ? `${name}, ${text.parse.applied}` : `+ ${name}`}
              </button>
            );
          })}
        </div>
      )}
      {choices.length > 0 && (
        <div className="row">
          <span>{text.parse.facts}</span>
          {choices.map((choice) => {
            const name = factText(choice);
            const isApplied = isFactApplied(appliedFacts, choice);
            return (
              <button
                key={name}
                type="button"
                className="suggestion"
                disabled={isApplied || isPending || isStale}
                title={isApplied ? undefined : text.parse.applyFact(name)}
                onClick={() => onApplyFact(choice)}
              >
                {isApplied ? `${name}, ${text.parse.applied}` : `+ ${name}`}
              </button>
            );
          })}
        </div>
      )}
      {(sharedCategories.length > 0 || choices.length > 0) && isStale && <p className="hint">{text.parse.stale}</p>}
      {other.length > 0 && <p className="hint">{text.parse.other} {other.join(", ")}.</p>}
    </div>
  );
}
